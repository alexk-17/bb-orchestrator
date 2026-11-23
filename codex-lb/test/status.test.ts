// `bb codex-lb status` is the setup check the README tells people to trust: exit 0 must mean Codex threads really
// route through codex-lb. These tests load the plugin against a stub bb and a stub codex-lb, run the registered CLI
// command, and assert on its exit code and reasons, because the original bug was a 0 exit while routing was broken.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../server.ts";

const GOOD_KEY = "status-test-key";

// codex-lb's answers: readiness without a key, usage and reset credits only with the Bearer key.
const server = createServer((req, res) => {
  const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (req.url === "/health/ready") return send(200, { status: "ok" });
  if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) return send(401, { detail: "Invalid API key" });
  if (req.url === "/v1/usage") return send(200, { limits: [{ limit_type: "credits", limit_window: "7d", max_value: 100, current_value: 10 }] });
  if (req.url === "/v1/reset-credit") return send(200, []);
  return send(404, {});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const savedPath = process.env.PATH;
let envCounter = 0;

type Cli = { run(argv: string[]): Promise<{ exitCode: number; stdout?: string }> };

/** Load the plugin as bb would, with the `path` folders before the system PATH and the given key (null: unset). */
async function load(opts: { key: string | null; path: (box: Box) => string[]; settings?: (box: Box) => Record<string, string> }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-lb-status-")));
  const box = { root, launcherDir: join(root, "data", "bin"), binDir: join(root, "bin"), launcher: join(root, "data", "bin", "codex") };
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(box.binDir);
  writeFileSync(join(box.binDir, "codex"), "#!/bin/sh\necho real-codex\n");
  chmodSync(join(box.binDir, "codex"), 0o755);
  const apiKeyEnv = `CODEX_LB_STATUS_TEST_${++envCounter}`;
  if (opts.key !== null) process.env[apiKeyEnv] = opts.key;
  process.env.PATH = [...opts.path(box), "/usr/bin", "/bin"].join(":");
  let cli: Cli | null = null;
  let rpc: Record<string, (input: unknown) => Promise<unknown>> = {};
  const warnings: string[] = [];
  const bb = {
    settings: {
      define: () => ({ get: async () => ({ baseUrl, apiKeyEnv, ...(opts.settings?.(box) ?? {}) }), onChange: () => {} }),
    },
    storage: { database: () => ({ name: join(root, "data", "plugin.db") }) },
    log: { warn: (m: string) => warnings.push(m), info: () => {} },
    rpc: { register: (_c: unknown, handlers: typeof rpc) => (rpc = handlers) },
    cli: { register: (c: Cli) => (cli = c) },
  };
  await plugin(bb as unknown as BbPluginApi);
  assert.ok(cli);
  const status = async (...args: string[]) => {
    const r = await cli!.run(["status", ...args]);
    return { exitCode: r.exitCode, text: r.stdout ?? "" };
  };
  const json = async () => {
    const r = await status("--json");
    return { exitCode: r.exitCode, report: JSON.parse(r.text) as { ok: boolean; problems: string[] } };
  };
  return { box, status, json, warnings, rpc: () => rpc, done: () => rmSync(root, { recursive: true, force: true }) };
}

type Box = { root: string; launcherDir: string; binDir: string; launcher: string };

test("status: exits 0 only when the launcher is current and first, codex exists, the key is accepted and codex-lb is ready", async (t) => {
  t.after(() => (process.env.PATH = savedPath));
  const p = await load({ key: GOOD_KEY, path: (b) => [b.launcherDir, b.binDir] });
  try {
    const { exitCode, report } = await p.json();
    assert.deepEqual(report.problems, []);
    assert.equal(exitCode, 0);
    const text = await p.status();
    assert.equal(text.exitCode, 0);
    assert.match(text.text, /status {5}ok/);
  } finally {
    p.done();
  }
});

test("status: a folder without codex ahead of the launcher is fine; first means the first codex bb would run", async (t) => {
  t.after(() => (process.env.PATH = savedPath));
  const p = await load({ key: GOOD_KEY, path: (b) => [join(b.root, "empty"), b.launcherDir, b.binDir] });
  try {
    assert.equal((await p.json()).exitCode, 0);
  } finally {
    p.done();
  }
});

test("status: fails when codex-lb rejects the key with HTTP 401", async (t) => {
  t.after(() => (process.env.PATH = savedPath));
  const p = await load({ key: "wrong-key", path: (b) => [b.launcherDir, b.binDir] });
  try {
    const { exitCode, report } = await p.json();
    assert.equal(exitCode, 1);
    assert.equal(report.ok, false);
    assert.equal(report.problems.length, 1);
    assert.match(report.problems[0]!, /codex-lb rejected the API key in CODEX_LB_STATUS_TEST_\d+ \(\/v1\/usage answered HTTP 401\)/);
    const text = await p.status();
    assert.equal(text.exitCode, 1);
    assert.match(text.text, /REJECTED/);
    assert.match(text.text, /status {5}FAILING/);
    assert.ok(!text.text.includes("wrong-key"), "the key's value is never printed");
  } finally {
    p.done();
  }
});

test("status: fails when the key variable is not set", async (t) => {
  t.after(() => (process.env.PATH = savedPath));
  const p = await load({ key: null, path: (b) => [b.launcherDir, b.binDir] });
  try {
    const { exitCode, report } = await p.json();
    assert.equal(exitCode, 1);
    assert.match(report.problems.join("\n"), /is not set in bb's environment/);
  } finally {
    p.done();
  }
});

test("status: fails when the launcher is missing or outdated", async (t) => {
  t.after(() => (process.env.PATH = savedPath));
  const p = await load({ key: GOOD_KEY, path: (b) => [b.launcherDir, b.binDir] });
  try {
    writeFileSync(p.box.launcher, "#!/bin/sh\n# an older launcher\nexec codex \"$@\"\n");
    let r = await p.json();
    assert.equal(r.exitCode, 1);
    assert.match(r.report.problems.join("\n"), /launcher at .* is outdated/);
    rmSync(p.box.launcher);
    r = await p.json();
    assert.equal(r.exitCode, 1);
    assert.match(r.report.problems.join("\n"), /launcher is missing/);
  } finally {
    p.done();
  }
});

test("status: fails when another codex comes before the launcher, or the launcher is not on PATH", async (t) => {
  t.after(() => (process.env.PATH = savedPath));
  const behind = await load({ key: GOOD_KEY, path: (b) => [b.binDir, b.launcherDir] });
  try {
    const { exitCode, report } = await behind.json();
    assert.equal(exitCode, 1);
    assert.deepEqual(report.problems, [
      `bb's PATH runs ${join(behind.box.binDir, "codex")}, not the launcher; put ${behind.box.launcherDir} first on bb's PATH and restart bb`,
    ]);
  } finally {
    behind.done();
  }
  const absent = await load({ key: GOOD_KEY, path: (b) => [b.binDir] });
  try {
    const { exitCode, report } = await absent.json();
    assert.equal(exitCode, 1);
    assert.match(report.problems.join("\n"), /runs .*\/bin\/codex, not the launcher/);
  } finally {
    absent.done();
  }
});

test("status: fails when codexPath is the launcher itself, and the plugin refuses to write that launcher", async (t) => {
  t.after(() => (process.env.PATH = savedPath));
  const p = await load({ key: GOOD_KEY, path: (b) => [b.launcherDir, b.binDir], settings: (b) => ({ codexPath: b.launcher }) });
  try {
    const { exitCode, report } = await p.json();
    assert.equal(exitCode, 1);
    assert.match(report.problems.join("\n"), /codexPath is this plugin's own launcher/);
    assert.match(p.warnings.join("\n"), /codexPath is this plugin's own launcher/);
  } finally {
    p.done();
  }
});

// A relative or empty PATH entry is resolved against each thread's own folder, so a `codex` sitting there runs before
// the launcher. Status cannot see every thread's folder, so such an entry ahead of the launcher must fail it.
test("status: fails when a relative or empty PATH entry comes before the launcher", async (t) => {
  const cwd = process.cwd();
  t.after(() => {
    process.env.PATH = savedPath;
    process.chdir(cwd);
  });
  const rel = await load({ key: GOOD_KEY, path: (b) => ["rel-bin", b.launcherDir, b.binDir] });
  try {
    // a real `codex` in the relative folder, as a repository checkout could carry one
    mkdirSync(join(rel.box.root, "rel-bin"));
    writeFileSync(join(rel.box.root, "rel-bin", "codex"), "#!/bin/sh\necho shadow\n");
    chmodSync(join(rel.box.root, "rel-bin", "codex"), 0o755);
    process.chdir(rel.box.root);
    const { exitCode, report } = await rel.json();
    assert.equal(exitCode, 1);
    assert.match(report.problems.join("\n"), /the relative entry "rel-bin" before the launcher/);
  } finally {
    process.chdir(cwd);
    rel.done();
  }
  const empty = await load({ key: GOOD_KEY, path: (b) => ["", b.launcherDir, b.binDir] });
  try {
    const { exitCode, report } = await empty.json();
    assert.equal(exitCode, 1);
    assert.match(report.problems.join("\n"), /an empty entry before the launcher/);
  } finally {
    empty.done();
  }
  // after the launcher, a relative entry is harmless: the launcher already ran
  const after_ = await load({ key: GOOD_KEY, path: (b) => [b.launcherDir, "rel-bin", b.binDir] });
  try {
    assert.equal((await after_.json()).exitCode, 0);
  } finally {
    after_.done();
  }
});

test("status and the usage card never show a key, even one whose newline makes the request itself fail", async (t) => {
  t.after(() => (process.env.PATH = savedPath));
  const p = await load({ key: "canary-key-7f3a\nsecond-line", path: (b) => [b.launcherDir, b.binDir] });
  try {
    const text = await p.status();
    const json = await p.status("--json");
    const card = await p.rpc()["provider-usage.v1.getResource"]!({ resourceId: "pool", refresh: true });
    assert.equal(text.exitCode, 1);
    for (const out of [text.text, json.text, JSON.stringify(card)]) assert.ok(!out.includes("canary-key-7f3a"), out);
  } finally {
    p.done();
  }
});

// The launcher execs the binary chosen when the plugin loaded. If it disappears or changes later, threads fail (exit
// 127, or a loop if it became the launcher), so status must look again every time rather than trust the cached path.
test("status: fails when the chosen codex is removed, loses its execute bit, or becomes the launcher after load", async (t) => {
  t.after(() => (process.env.PATH = savedPath));
  const p = await load({ key: GOOD_KEY, path: (b) => [b.launcherDir, b.binDir] });
  const real = join(p.box.binDir, "codex");
  try {
    assert.equal((await p.json()).exitCode, 0);
    chmodSync(real, 0o644);
    let r = await p.json();
    assert.equal(r.exitCode, 1);
    assert.match(r.report.problems.join("\n"), /is gone or not executable/);
    rmSync(real);
    r = await p.json();
    assert.equal(r.exitCode, 1);
    assert.match(r.report.problems.join("\n"), /is gone or not executable/);
    symlinkSync(p.box.launcher, real);
    r = await p.json();
    assert.equal(r.exitCode, 1);
    assert.match(r.report.problems.join("\n"), /is now the launcher itself/);
  } finally {
    p.done();
  }
});

// The launcher exits 64 on app-server while the Account Pooler's token is set, so a passing status would promise
// threads that never start.
test("status: fails while the Account Pooler also routes Codex", async (t) => {
  const saved = process.env.CODEX_POOL_AUTH_TOKEN;
  t.after(() => {
    process.env.PATH = savedPath;
    if (saved === undefined) delete process.env.CODEX_POOL_AUTH_TOKEN;
    else process.env.CODEX_POOL_AUTH_TOKEN = saved;
  });
  const p = await load({ key: GOOD_KEY, path: (b) => [b.launcherDir, b.binDir] });
  try {
    assert.equal((await p.json()).exitCode, 0);
    process.env.CODEX_POOL_AUTH_TOKEN = "pool-canary";
    const { exitCode, report } = await p.json();
    assert.equal(exitCode, 1);
    assert.match(report.problems.join("\n"), /Account Pooler is also routing Codex/);
    assert.ok(!JSON.stringify(report).includes("pool-canary"), "the pooler's token is never printed");
    // and the launcher really does refuse, as status now says
    const r = spawnSync(p.box.launcher, ["app-server"], { env: { PATH: process.env.PATH!, CODEX_POOL_AUTH_TOKEN: "x" }, encoding: "utf8" });
    assert.equal(r.status, 64, r.stderr);
  } finally {
    p.done();
  }
});
