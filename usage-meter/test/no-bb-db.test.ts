// A second SQLite library opening bb.db inside the bb server drops the server's
// POSIX locks on it, and the next opener truncates -shm under the server: SIGBUS.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const child = fileURLToPath(new URL("./fixtures/scan-child.ts", import.meta.url));
const session = "11111111-2222-3333-4444-555555555555";

function scratch(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-meter-nodb-"));
  const home = path.join(root, "home");
  const project = path.join(home, ".claude", "projects", "-scratch-project");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(root, "data", "plugins", "usage-meter"), { recursive: true });
  const line = {
    type: "assistant",
    timestamp: new Date().toISOString(),
    sessionId: session,
    cwd: "/scratch/project",
    message: { id: "msg_1", model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 5 } },
  };
  fs.writeFileSync(path.join(project, `${session}.jsonl`), `${JSON.stringify(line)}\n`);

  // A bait database where the old reader looked for it, naming the thread differently.
  for (const dir of [path.join(root, "data"), path.join(home, ".bb")]) {
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, "bb.db"));
    db.exec("pragma journal_mode = wal");
    db.exec(
      "create table threads (id text, title text, title_fallback text, project_id text, environment_id text, deleted_at integer)",
    );
    db.exec("create table events (provider_thread_id text, thread_id text)");
    db.exec("insert into threads values ('thr_api', 'DB title', null, 'proj_1', null, null)");
    db.exec(`insert into events values ('${session}', 'thr_api')`);
    db.close();
  }
  return root;
}

test("the scanner never opens bb.db, -wal or -shm, and names threads from bb's API", () => {
  const strace = spawnSync("strace", ["-V"], { encoding: "utf8" });
  assert.equal(strace.status, 0, "strace is required for this test");

  const root = scratch();
  try {
    const trace = path.join(root, "trace.txt");
    const run = spawnSync(
      "strace",
      [
        "-f",
        "-qq",
        "-e",
        "trace=openat,open",
        "-o",
        trace,
        process.execPath,
        "--disable-warning=ExperimentalWarning",
        child,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: path.join(root, "home"), USAGE_SCRATCH: root, USAGE_SESSION: session },
      },
    );
    assert.equal(run.status, 0, run.stderr);

    const opens = fs
      .readFileSync(trace, "utf8")
      .split("\n")
      .filter((entry) => /bb\.db(-wal|-shm)?"/.test(entry));
    assert.deepEqual(opens, [], "Usage Meter opened bb's database");

    const { threads } = JSON.parse(run.stdout) as { threads: string[] };
    assert.deepEqual(threads, ["API title"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
