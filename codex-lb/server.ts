// bb-plugin-codex-lb: run bb's Codex threads through a codex-lb load balancer, configured in plugin settings.
//
// Three parts:
// 1. A `codex` launcher in the plugin's data folder (lib/launcher.ts), rewritten from the settings on every load and
//    settings change. Put its folder first on bb's PATH once; bb's Codex provider then starts it as `codex app-server`.
// 2. `bb codex-lb status`: the launcher, the codex binary it runs, codex-lb's readiness, the pool's usage limits and
//    its reset credits. `bb codex-lb path` prints the folder to put on PATH.
// 3. A provider-usage source, so bb's built-in Provider usage card shows the pool's limits next to the other
//    providers.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DEFAULTS, renderLauncher, resolveCodex, settingsProblems, type LauncherSettings } from "./lib/launcher.ts";
import { readPool, toProviderUsage, type PoolSnapshot } from "./lib/pool.ts";

/** A cached pool read is served this long to the usage card when it does not ask for a refresh. */
const USAGE_TTL_MS = 60_000;
const RESOURCE_ID = "pool";

// The provider-usage v1 source contract, as bb's Provider usage plugin discovers and calls it. Outputs are validated
// by that consumer; they are typed loosely here.
export const rpcContract = defineRpcContract({
  "provider-usage.v1.listResources": { input: z.object({}), output: z.custom<unknown>(() => true) },
  "provider-usage.v1.getResource": {
    input: z.object({ resourceId: z.string().min(1), refresh: z.boolean() }),
    output: z.custom<unknown>(() => true),
  },
});

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
  });

  async function status() {
    const snap = await pool(true);
    let launcherCurrent = false;
    try {
      launcherCurrent = readFileSync(launcherPath, "utf8") === renderLauncher(current, codexBinary, launcherDir);
    } catch {
      // missing launcher: reported as not current
    }
    return {
      launcher: { path: launcherPath, current: launcherCurrent, onPath: (process.env.PATH ?? "").split(":")[0] === launcherDir },
      codex: codexBinary,
      baseUrl: current.baseUrl,
      apiKeyEnv: current.apiKeyEnv,
      apiKeySet: apiKey() !== null,
      codexHome: current.codexHome || null,
      settingsProblems: problems,
      pool: snap,
    };
  }

  function formatStatus(s: Awaited<ReturnType<typeof status>>): string {
    const p = s.pool;
    const lines = [
      `launcher   ${s.launcher.path}${s.launcher.current ? "" : " (not current)"}`,
      `on PATH    ${s.launcher.onPath ? "yes, first" : `no: put ${dirname(s.launcher.path)} first on bb's PATH`}`,
      `codex      ${s.codex ?? "not found"}`,
      `codex-lb   ${s.baseUrl}: ${p.ready ? "ready" : `not ready (${p.readyDetail})`}`,
      `API key    ${s.apiKeyEnv} ${s.apiKeySet ? "is set" : "is NOT set in bb's environment"}`,
      `CODEX_HOME ${s.codexHome ?? "(Codex default)"}`,
    ];
    for (const problem of s.settingsProblems) lines.push(`setting    ${problem}`);
    if (p.windows) {
      for (const w of p.windows) lines.push(`usage      ${w.label}: ${Math.round(w.usedPercent)}% used${w.resetsAt ? `, resets ${w.resetsAt}` : ""}`);
      if (p.windows.length === 0) lines.push("usage      no limits reported");
    } else lines.push(`usage      unavailable: ${p.usageError}`);
    if (p.credits) {
      lines.push(`credits    ${p.credits.total} unredeemed reset credit${p.credits.total === 1 ? "" : "s"}`);
      for (const a of p.credits.byAccount) lines.push(`           ${a.account}: ${a.count}${a.nextExpiry ? `, next expires ${a.nextExpiry}` : ""}`);
    } else lines.push(`credits    unavailable: ${p.creditsError}`);
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
        const healthy = s.pool.ready && s.apiKeySet && s.codex !== null && s.settingsProblems.length === 0;
        return { exitCode: healthy ? 0 : 1, stdout: rest.includes("--json") ? `${JSON.stringify(s, null, 2)}\n` : formatStatus(s) };
      }
      return { exitCode: 2, stdout: `usage:\n  ${usage.join("\n  ")}\n` };
    },
  });
}
