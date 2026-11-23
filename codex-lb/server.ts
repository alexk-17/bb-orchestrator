// bb-plugin-codex-lb: run bb's Codex threads through a codex-lb load balancer, configured in plugin settings.
//
// Three parts:
// 1. A `codex` launcher in the plugin's data folder (lib/launcher.ts), rewritten from the settings on every load and
//    settings change. Put its folder first on bb's PATH once; bb's Codex provider then starts it as `codex app-server`.
// 2. `bb codex-lb status`: the launcher, the codex binary it runs, codex-lb's readiness, the pool's usage limits and
//    its reset credits. `bb codex-lb path` prints the folder to put on PATH.
// 3. A provider-usage source, so bb's built-in Provider usage card shows the pool's limits next to the other
//    providers.
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DEFAULTS, executable, isLauncher, renderLauncher, resolveCodex, settingsProblems, type LauncherSettings } from "./lib/launcher.ts";
import { readPool, toProviderUsage, type PoolSnapshot } from "./lib/pool.ts";

/** A cached pool read is served this long to the usage card when it does not ask for a refresh. */
const USAGE_TTL_MS = 60_000;
const RESOURCE_ID = "pool";

// The provider-usage v1 source contract, as bb's Provider usage plugin discovers and calls it. Outputs are validated
// by that consumer; they are typed loosely here, but as JSON objects: bb publishes a discoverable contract's schemas as
// JSON Schema, and a schema it cannot convert keeps the source out of discovery.
const usageOutput = z.record(z.string(), z.unknown());
export const rpcContract = defineRpcContract({
  "provider-usage.v1.listResources": { input: z.object({}), output: usageOutput },
  "provider-usage.v1.getResource": {
    input: z.object({ resourceId: z.string().min(1), refresh: z.boolean() }),
    output: usageOutput,
  },
});
/** Without these, bb's Provider usage plugin never finds the source: it lists only discoverable registrations. */
export const rpcOptions = {
  experimental_discoverable: true,
  experimental_description: "The codex-lb pool's usage limits and reset credits, read from the configured codex-lb.",
};

/**
 * The first executable `codex` on PATH, the one bb's Codex provider starts; null when there is none. An empty or
 * relative entry ahead of it is reported instead: it is resolved against each thread's working folder, so a `codex`
 * there would run before the launcher, and no check made from here can rule that out.
 */
export function firstCodexOnPath(pathEnv: string): { codex: string | null; relativeEntry: string | null } {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) return { codex: null, relativeEntry: dir };
    const candidate = join(dir, "codex");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return { codex: candidate, relativeEntry: null };
    } catch {
      // not here
    }
  }
  return { codex: null, relativeEntry: null };
}

function writeAtomically(path: string, text: string, mode: number): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    baseUrl: { type: "string", label: "codex-lb base URL", description: "Where codex-lb listens. Codex is pointed at <base URL>/backend-api/codex.", default: DEFAULTS.baseUrl },
    apiKeyEnv: { type: "string", label: "API key environment variable", description: "Name of the variable in bb's environment that holds the codex-lb client API key. The key itself is never stored by this plugin or written into the launcher.", default: DEFAULTS.apiKeyEnv },
    codexHome: { type: "string", label: "CODEX_HOME for Codex threads (empty: Codex's default, or whatever bb's environment sets)", default: DEFAULTS.codexHome },
    model: { type: "string", label: "Default Codex model (empty: Codex's default). bb's per-thread model still wins", default: DEFAULTS.model },
    codexPath: { type: "string", label: "codex binary (empty: the first codex on bb's PATH after this plugin's launcher)", default: DEFAULTS.codexPath },
    extraArgs: { type: "string", label: "Extra codex arguments, space-separated, placed before the subcommand (no quoting)", default: DEFAULTS.extraArgs },
    trustedRoots: { type: "string", label: "Trusted folders, comma-separated absolute paths: a thread whose folder is one of them or inside one runs as a trusted Codex project", default: DEFAULTS.trustedRoots },
  });

  const launcherDir = join(dirname(bb.storage.database().name), "bin");
  const launcherPath = join(launcherDir, "codex");
  let current: LauncherSettings = { ...DEFAULTS, ...(await settings.get()) };
  let codexBinary: string | null = null;
  let problems: string[] = [];

  function writeLauncher(next: LauncherSettings): void {
    problems = settingsProblems(next);
    if (next.codexPath && isLauncher(next.codexPath, launcherDir)) {
      problems.push(`codexPath is this plugin's own launcher (${next.codexPath}); point it at the real codex binary`);
    }
    if (problems.length > 0) {
      // Keep the last good launcher rather than writing one from settings that cannot work.
      bb.log.warn(`codex-lb settings not applied: ${problems.join("; ")}`);
      return;
    }
    current = next;
    codexBinary = resolveCodex(next, process.env.PATH ?? "", launcherDir);
    mkdirSync(launcherDir, { recursive: true, mode: 0o755 });
    writeAtomically(launcherPath, renderLauncher(next, codexBinary, launcherDir), 0o755);
    if (codexBinary === null) bb.log.warn("codex-lb: no codex binary found; the launcher will refuse to start");
  }

  writeLauncher(current);
  settings.onChange((next) => writeLauncher({ ...DEFAULTS, ...next }));

  const apiKey = () => process.env[current.apiKeyEnv] || null;

  let cached: { at: number; snap: PoolSnapshot } | null = null;
  let inFlight: Promise<PoolSnapshot> | null = null;
  async function pool(refresh: boolean): Promise<PoolSnapshot> {
    if (!refresh && cached && Date.now() - cached.at < USAGE_TTL_MS) return cached.snap;
    inFlight ??= readPool(current.baseUrl, apiKey())
      .then((snap) => {
        cached = { at: Date.now(), snap };
        return snap;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  bb.rpc.register(rpcContract, {
    "provider-usage.v1.listResources": () => ({
      label: "codex-lb",
      resources: [{ accountKey: null, id: RESOURCE_ID, providerId: "codex", label: "codex-lb pool", scope: { kind: "shared" } }],
    }),
    "provider-usage.v1.getResource": async ({ resourceId, refresh }) => {
      if (resourceId !== RESOURCE_ID) throw new Error(`unknown resource ${resourceId}`);
      const snap = await pool(refresh);
      return { accountKey: null, observedAt: cached?.at ?? null, usage: toProviderUsage(snap, apiKey() !== null) };
    },
  }, rpcOptions);

  async function status() {
    const snap = await pool(true);
    let launcherState: "current" | "outdated" | "missing" = "missing";
    try {
      launcherState = readFileSync(launcherPath, "utf8") === renderLauncher(current, codexBinary, launcherDir) ? "current" : "outdated";
    } catch {
      // missing launcher
    }
    // What bb's Codex provider runs is the first codex on its PATH, so that one must be the launcher.
    const { codex: firstCodex, relativeEntry } = firstCodexOnPath(process.env.PATH ?? "");
    const onPath = firstCodex !== null && isLauncher(firstCodex, launcherDir);
    const apiKeySet = apiKey() !== null;
    const failing: string[] = [...problems];
    if (launcherState === "missing") failing.push(`the launcher is missing at ${launcherPath}; reload the plugin to rewrite it`);
    if (launcherState === "outdated") failing.push(`the launcher at ${launcherPath} is outdated; reload the plugin to rewrite it`);
    if (!onPath) {
      failing.push(
        relativeEntry !== null
          ? `bb's PATH has ${relativeEntry === "" ? "an empty entry" : `the relative entry "${relativeEntry}"`} before the launcher, so a codex in a thread's folder would run instead; put ${launcherDir} ahead of it and restart bb`
          : firstCodex === null
            ? `the launcher is not on bb's PATH; put ${launcherDir} first on bb's PATH and restart bb`
            : `bb's PATH runs ${firstCodex}, not the launcher; put ${launcherDir} first on bb's PATH and restart bb`,
      );
    }
    if (codexBinary === null) failing.push("no codex binary found for the launcher to run; install Codex or set codexPath");
    // The launcher execs the binary chosen at load; check it is still there, and still not the launcher itself.
    else if (!executable(codexBinary)) failing.push(`the codex the launcher runs (${codexBinary}) is gone or not executable; reinstall it, or reload the plugin to pick another`);
    else if (isLauncher(codexBinary, launcherDir)) failing.push(`the codex the launcher runs (${codexBinary}) is now the launcher itself; point it at the real codex and reload the plugin`);
    // The launcher refuses app-server (exit 64) when the Account Pooler routes Codex too: its overrides would win.
    if (process.env.CODEX_POOL_AUTH_TOKEN) failing.push("bb's Account Pooler is also routing Codex (CODEX_POOL_AUTH_TOKEN is set), so the launcher refuses to start Codex threads; disable one of the two");
    if (!apiKeySet) failing.push(`${current.apiKeyEnv} is not set in bb's environment`);
    else if (snap.keyRejected) failing.push(`codex-lb rejected the API key in ${current.apiKeyEnv} (${snap.usageError ?? snap.creditsError})`);
    // A key that cannot even be sent (a newline in it, say) fails the request before codex-lb sees it.
    else if (snap.ready && snap.windows === null) failing.push(`the API key in ${current.apiKeyEnv} could not be checked against codex-lb (${snap.usageError})`);
    if (!snap.ready) failing.push(`codex-lb at ${current.baseUrl} is not ready (${snap.readyDetail})`);
    return {
      ok: failing.length === 0,
      problems: failing,
      launcher: { path: launcherPath, state: launcherState, current: launcherState === "current", onPath, firstCodexOnPath: firstCodex },
      codex: codexBinary,
      baseUrl: current.baseUrl,
      apiKeyEnv: current.apiKeyEnv,
      apiKeySet,
      codexHome: current.codexHome || null,
      settingsProblems: problems,
      pool: snap,
    };
  }

  function formatStatus(s: Awaited<ReturnType<typeof status>>): string {
    const p = s.pool;
    const lines = [
      `launcher   ${s.launcher.path}${s.launcher.state === "current" ? "" : ` (${s.launcher.state})`}`,
      `on PATH    ${s.launcher.onPath ? "yes, first" : `no: put ${dirname(s.launcher.path)} first on bb's PATH`}`,
      `codex      ${s.codex ?? "not found"}`,
      `codex-lb   ${s.baseUrl}: ${p.ready ? "ready" : `not ready (${p.readyDetail})`}`,
      `API key    ${s.apiKeyEnv} ${!s.apiKeySet ? "is NOT set in bb's environment" : p.keyRejected ? "is set, but codex-lb REJECTED it" : "is set"}`,
      `CODEX_HOME ${s.codexHome ?? "(Codex default)"}`,
    ];
    if (p.windows) {
      for (const w of p.windows) lines.push(`usage      ${w.label}: ${Math.round(w.usedPercent)}% used${w.resetsAt ? `, resets ${w.resetsAt}` : ""}`);
      if (p.windows.length === 0) lines.push("usage      no limits reported");
    } else lines.push(`usage      unavailable: ${p.usageError}`);
    if (p.credits) {
      lines.push(`credits    ${p.credits.total} unredeemed reset credit${p.credits.total === 1 ? "" : "s"}`);
      for (const a of p.credits.byAccount) lines.push(`           ${a.account}: ${a.count}${a.nextExpiry ? `, next expires ${a.nextExpiry}` : ""}`);
    } else lines.push(`credits    unavailable: ${p.creditsError}`);
    lines.push(s.ok ? "status     ok: Codex threads route through codex-lb" : "status     FAILING: Codex threads will not route through codex-lb");
    for (const problem of s.problems) lines.push(`  - ${problem}`);
    return `${lines.join("\n")}\n`;
  }

  const usage = ["bb codex-lb status [--json]", "bb codex-lb path"];
  bb.cli.register({
    name: "codex-lb",
    summary: "Route bb's Codex threads through codex-lb, and read the pool's health and usage",
    commands: usage.map((u) => ({ name: u.split(" ")[2]!, summary: u, usage: u })),
    async run(argv) {
      const [cmd, ...rest] = argv;
      if (cmd === "path") return { exitCode: 0, stdout: `${launcherDir}\n` };
      if (cmd === "status") {
        const s = await status();
        return { exitCode: s.ok ? 0 : 1, stdout: rest.includes("--json") ? `${JSON.stringify(s, null, 2)}\n` : formatStatus(s) };
      }
      return { exitCode: 2, stdout: `usage:\n  ${usage.join("\n  ")}\n` };
    },
  });
}
