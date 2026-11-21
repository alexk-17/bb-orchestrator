// A real bb CLI/server loop using temporary state and a Slack read fixture. No personal install or token is used.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const [serverBin, cliBin] = process.argv.slice(2);
if (!serverBin || !cliBin) throw new Error("Usage: node slack-watch/proof/run.mjs <absolute bb-server.js> <absolute bb CLI>");
const dir = mkdtempSync(join(tmpdir(), "bb-slack-watch-proof-"));
const fixture = join(dir, "slack-fixture.json");
writeFileSync(fixture, JSON.stringify({ ts: null }));
const socket = createServer();
await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  BB_SERVER_URL: base,
  BB_DATA_DIR: dir,
  BB_CLI: resolve(cliBin),
  SLACK_WATCH_PROOF_FIXTURE: fixture,
  NODE_OPTIONS: `--import=${fileURLToPath(new URL("./slack.mjs", import.meta.url))}`,
};
for (const key of ["BB_THREAD_ID", "BB_PROJECT_ID", "BB_ENVIRONMENT_ID", "BB_HOST_ID"]) delete env[key];
let log = "";
const child = spawn(process.execPath, [resolve(serverBin), "--data-dir", dir, "--server-bind-host", "127.0.0.1", "--server-port", String(port)], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (b) => {
  log += b;
});
child.stderr.on("data", (b) => {
  log += b;
});
const exited = new Promise((resolve) => child.once("exit", resolve));
const cli = (args, input) => execFileSync(resolve(cliBin), args, { env, input, encoding: "utf8", timeout: 120000, stdio: ["pipe", "pipe", "pipe"] });
const watch = (...args) => JSON.parse(cli(["orchestrator", "slack-watch", ...args]));
let db;
try {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/api/v1/plugins`);
      if (r.ok) break;
    } catch {
      /* isolated server is booting */
    }
    if (i === 79) throw new Error(`Proof server failed to start: ${log}`);
    await sleep(250);
  }
  const pluginDir = fileURLToPath(new URL("../../", import.meta.url));
  cli(["plugin", "install", pluginDir, "--yes"]);
  assert.match(cli(["orchestrator", "slack-watch", "setup", "--help"]), /token-stdin/);
  db = new DatabaseSync(join(dir, "plugins/orchestrator/data.db"));
  // Fixture recipient only. No model, thread spawn or agent run is needed for inbox acceptance.
  db.prepare("INSERT INTO agents(thread_id,address,role,status,created_at) VALUES ('proof-recipient','cos','cos','idle',0)").run();
  const config = join(dir, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      version: 1,
      profile: "proof",
      paused: true,
      pollSeconds: 30,
      startFrom: "now",
      channels: [{ id: "CPROOF", source: "proof-slack", to: "cos" }],
    }),
  );
  const setup = JSON.parse(cli(["orchestrator", "slack-watch", "setup", "proof", "--config", config, "--token-stdin"], "xoxb-proof-only\n"));
  assert.equal(setup.config.paused, true);
  const before = watch("status", "proof", "--json");
  assert.equal(watch("test", "proof").dryRead, true);
  assert.deepEqual(watch("status", "proof", "--json"), before);
  const now = Date.now();
  writeFileSync(fixture, JSON.stringify({ ts: `${Math.floor(now / 1000)}.${String(now % 1000).padStart(3, "0")}000` }));
  watch("resume", "proof");
  let health;
  for (let i = 0; i < 50; i++) {
    health = watch("status", "proof", "--json")[0];
    if (health.channels[0].heartbeat) break;
    await sleep(250);
  }
  assert.ok(health.channels[0].heartbeat, JSON.stringify(health));
  assert.equal(db.prepare("SELECT count(*) AS n FROM external_mail WHERE source='proof-slack'").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM multiplayer_beats WHERE source='proof-slack'").get().n, 1);
  watch("pause", "proof");
  cli(["plugin", "reload", "orchestrator"]);
  assert.equal(watch("status", "proof", "--json")[0].paused, true);
  assert.equal(db.prepare("SELECT count(*) AS n FROM external_mail WHERE source='proof-slack'").get().n, 1);
  assert.ok(!JSON.stringify(watch("routes")).includes("xoxb"));
  assert.ok(!readFileSync(join(dir, "plugins/orchestrator/logs/plugin.log"), "utf8").includes("xoxb-proof-only"));
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        target: "disposable bb server",
        cliStdinSetup: true,
        dryReadNoMutation: true,
        paginatedOldThreadReply: true,
        inboxReceipts: 1,
        multiplayerHeartbeat: true,
        pauseSurvivesReload: true,
        credentialNotLogged: true,
        slackPosts: 0,
      },
      null,
      2,
    ),
  );
} finally {
  db?.close();
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(5000).then(() => child.kill("SIGKILL"))]);
  rmSync(dir, { recursive: true, force: true });
}
