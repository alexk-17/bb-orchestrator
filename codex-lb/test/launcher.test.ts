// The launcher is the whole integration with bb's Codex provider, so these tests run the script it writes: a fake
// codex records the arguments and environment it was started with, and the assertions read that record.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS, codexArgs, isLauncher, providerBaseUrl, renderLauncher, resolveCodex, settingsProblems, shellQuote, type LauncherSettings } from "../lib/launcher.ts";

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-lb-test-")));
  const launcherDir = join(root, "launcher");
  const binDir = join(root, "bin");
  const work = join(root, "work", "repo");
  for (const d of [launcherDir, binDir, work]) mkdirSync(d, { recursive: true });
  const record = join(root, "record.json");
  // The fake codex writes argv, CODEX_HOME and PATH as JSON.
  const fake = join(binDir, "codex");
  writeFileSync(
    fake,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME ?? null, path: process.env.PATH, cwd: process.cwd() }));\n`,
  );
  chmodSync(fake, 0o755);
  return { root, launcherDir, binDir, work, record, fake };
}

function write(s: LauncherSettings, box: ReturnType<typeof sandbox>, codex: string | null) {
  const path = join(box.launcherDir, "codex");
  writeFileSync(path, renderLauncher(s, codex, box.launcherDir));
  chmodSync(path, 0o755);
  return path;
}

function run(launcher: string, args: string[], env: Record<string, string>, cwd: string) {
  return spawnSync(launcher, args, { cwd, env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
}

test("settings: defaults are valid; bad URL, variable name and relative paths are reported", () => {
  assert.deepEqual(settingsProblems(DEFAULTS), []);
  const bad = settingsProblems({ ...DEFAULTS, baseUrl: "ftp://x", apiKeyEnv: "lower-case", codexHome: "rel", codexPath: "bin/codex", trustedRoots: "/ok, nope" });
  assert.equal(bad.length, 5);
  assert.match(settingsProblems({ ...DEFAULTS, baseUrl: "not a url" })[0]!, /not a URL/);
});

test("args: codex-lb's Codex endpoint, an API key from the named variable, no OpenAI login, optional model", () => {
  assert.equal(providerBaseUrl("http://127.0.0.1:2455/"), "http://127.0.0.1:2455/backend-api/codex");
  const args = codexArgs({ ...DEFAULTS, model: "gpt-x", extraArgs: " --enable  hooks " });
  assert.deepEqual(args.slice(0, 2), ["--enable", "hooks"]);
  const overrides = args.filter((_, i) => args[i - 1] === "-c");
  assert.deepEqual(overrides, [
    'model_provider="codex-lb"',
    'model_providers.codex-lb.name="openai"',
    'model_providers.codex-lb.base_url="http://127.0.0.1:2455/backend-api/codex"',
    'model_providers.codex-lb.wire_api="responses"',
    'model_providers.codex-lb.env_key="CODEX_LB_API_KEY"',
    "model_providers.codex-lb.supports_websockets=true",
    "model_providers.codex-lb.requires_openai_auth=false",
    'model="gpt-x"',
  ]);
  assert.ok(!codexArgs(DEFAULTS).some((a) => a.startsWith("model=")));
});

test("resolve: codexPath wins; otherwise the first codex on PATH that is not the launcher", () => {
  const box = sandbox();
  write(DEFAULTS, box, box.fake); // a `codex` in the launcher folder, first on PATH
  assert.equal(resolveCodex(DEFAULTS, `${box.launcherDir}:${box.binDir}`, box.launcherDir), box.fake);
  assert.equal(resolveCodex(DEFAULTS, box.launcherDir, box.launcherDir), null);
  assert.equal(resolveCodex({ ...DEFAULTS, codexPath: box.fake }, "", box.launcherDir), box.fake);
  assert.equal(resolveCodex({ ...DEFAULTS, codexPath: join(box.root, "missing") }, `${box.binDir}`, box.launcherDir), null);
});

// A launcher that resolves to itself execs itself forever and no Codex thread ever starts. Every alias of it must be
// refused, through codexPath and through PATH alike.
test("resolve: codexPath naming the launcher, directly or through a symlink, is refused", () => {
  const box = sandbox();
  const launcher = write(DEFAULTS, box, box.fake);
  const link = join(box.root, "codex-link");
  symlinkSync(launcher, link);
  const dirLink = join(box.root, "launcher-alias");
  symlinkSync(box.launcherDir, dirLink);
  for (const codexPath of [launcher, link, join(dirLink, "codex")]) {
    assert.equal(isLauncher(codexPath, box.launcherDir), true, codexPath);
    assert.equal(resolveCodex({ ...DEFAULTS, codexPath }, box.binDir, box.launcherDir), null, codexPath);
  }
  assert.equal(isLauncher(box.fake, box.launcherDir), false);
});

test("resolve: on PATH, a symlink to the launcher and a symlinked launcher folder are skipped for the real codex", () => {
  const box = sandbox();
  const launcher = write(DEFAULTS, box, box.fake);
  const aliasBin = join(box.root, "alias-bin");
  mkdirSync(aliasBin);
  symlinkSync(launcher, join(aliasBin, "codex"));
  const dirLink = join(box.root, "launcher-alias");
  symlinkSync(box.launcherDir, dirLink);
  const pathEnv = [dirLink, aliasBin, box.launcherDir, box.binDir].join(":");
  assert.equal(resolveCodex(DEFAULTS, pathEnv, box.launcherDir), box.fake);
  assert.equal(resolveCodex(DEFAULTS, [dirLink, aliasBin].join(":"), box.launcherDir), null);
  // The launcher written from that resolution runs the real codex and returns, even with the aliases first on PATH.
  const rewritten = write(DEFAULTS, box, resolveCodex(DEFAULTS, pathEnv, box.launcherDir));
  const r = spawnSync(rewritten, ["--version"], { cwd: box.work, env: { PATH: `${pathEnv}:/usr/bin:/bin` }, encoding: "utf8", timeout: 5_000 });
  assert.equal(r.signal, null, "the launcher did not return: it is calling itself");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(box.record, "utf8")).argv.slice(-1), ["--version"]);
});

test("resolve: on first load, before the launcher folder exists, its PATH entry and aliases are still not codex", () => {
  const box = sandbox();
  mkdirSync(join(box.root, "data")); // the plugin's data folder exists (its database is there); bin/ does not yet
  const fresh = join(box.root, "data", "bin");
  const parentLink = join(box.root, "data-alias");
  symlinkSync(join(box.root, "data"), parentLink);
  assert.equal(existsSync(fresh), false);
  assert.equal(isLauncher(join(fresh, "codex"), fresh), true);
  assert.equal(isLauncher(join(parentLink, "bin", "codex"), fresh), true);
  assert.equal(resolveCodex(DEFAULTS, `${fresh}:${join(parentLink, "bin")}:${box.binDir}`, fresh), box.fake);
});

test("launcher: runs the resolved codex with the overrides, sets CODEX_HOME and drops itself from PATH", () => {
  const box = sandbox();
  const s = { ...DEFAULTS, codexHome: join(box.root, "home with space"), model: "m" };
  const launcher = write(s, box, box.fake);
  const r = run(launcher, ["app-server", "--listen", "stdio://"], { PATH: `${box.launcherDir}:${box.binDir}:/usr/bin:/bin`, CODEX_LB_API_KEY: "k" }, box.work);
  assert.equal(r.status, 0, r.stderr);
  const rec = JSON.parse(readFileSync(box.record, "utf8"));
  assert.deepEqual(rec.argv, [...codexArgs(s), "app-server", "--listen", "stdio://"]);
  assert.equal(rec.codexHome, s.codexHome);
  assert.equal(rec.path, `${box.binDir}:/usr/bin:/bin`);
  // the key's value is never part of the script
  assert.ok(!readFileSync(launcher, "utf8").includes("CODEX_LB_API_KEY=k"));
});

test("launcher: app-server refuses without the key variable, or when the Account Pooler also routes Codex", () => {
  const box = sandbox();
  const launcher = write({ ...DEFAULTS, apiKeyEnv: "MY_LB_KEY" }, box, box.fake);
  const env = { PATH: `${box.binDir}:/usr/bin:/bin` };
  const missing = run(launcher, ["app-server"], env, box.work);
  assert.equal(missing.status, 64);
  assert.match(missing.stderr, /MY_LB_KEY is not set/);
  const pooled = run(launcher, ["app-server"], { ...env, MY_LB_KEY: "k", CODEX_POOL_AUTH_TOKEN: "t" }, box.work);
  assert.equal(pooled.status, 64);
  assert.match(pooled.stderr, /Account Pooler/);
  // other subcommands (bb's version and login checks) need no key
  assert.equal(run(launcher, ["--version"], env, box.work).status, 0);
});

test("launcher: trusts a folder under a trusted root, and nothing else", () => {
  const box = sandbox();
  const launcher = write({ ...DEFAULTS, trustedRoots: `${join(box.root, "work")}/, /elsewhere` }, box, box.fake);
  const env = { PATH: `${box.binDir}:/usr/bin:/bin`, CODEX_LB_API_KEY: "k" };
  assert.equal(run(launcher, ["app-server"], env, box.work).status, 0);
  let rec = JSON.parse(readFileSync(box.record, "utf8"));
  assert.deepEqual(rec.argv.slice(-3), ["-c", `projects={"${box.work}"={trust_level="trusted"}}`, "app-server"]);
  assert.equal(run(launcher, ["app-server"], env, box.root).status, 0);
  rec = JSON.parse(readFileSync(box.record, "utf8"));
  assert.ok(!rec.argv.some((a: string) => a.startsWith("projects=")));
});

test("launcher: with no codex binary it explains and exits 127", () => {
  const box = sandbox();
  const launcher = write({ ...DEFAULTS, codexPath: "/nowhere/codex" }, box, null);
  const r = run(launcher, ["app-server"], { CODEX_LB_API_KEY: "k" }, box.work);
  assert.equal(r.status, 127);
  assert.match(r.stderr, /no codex binary found at \/nowhere\/codex/);
});

test("shell quoting survives single quotes and is valid sh", () => {
  const value = "it's a $HOME `x`";
  assert.equal(execFileSync("sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" }), value);
});
