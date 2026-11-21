import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runGroup } from "../core/run-group.ts";

const TMP = join(import.meta.dirname, "..", "..", ".scratch", "test-tmp");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A memory search that timed out left its `qmd query` grandchild (which ignores SIGTERM) running for hours at full CPU.
test("a timeout kills the grandchild too, even one that ignores SIGTERM", async () => {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, "run-group-"));
  try {
    const pidFile = join(dir, "grandchild.pid");
    const script = join(dir, "search.sh");
    writeFileSync(script, `#!/bin/sh\nsh -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 1; done' &\nwait\n`);
    chmodSync(script, 0o755);
    const r = await runGroup(script, [], { timeoutMs: 800 });
    assert.equal(r.timedOut, true);
    assert.notEqual(r.exitCode, 0);
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(alive(grandchild), false, "the grandchild must not outlive the timeout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a normal run returns its output and exit code", async () => {
  const ok = await runGroup("sh", ["-c", "echo hi; echo oops >&2; exit 3"], { timeoutMs: 5000 });
  assert.equal(ok.exitCode, 3);
  assert.equal(ok.stdout.trim(), "hi");
  assert.equal(ok.stderr.trim(), "oops");
  assert.equal(ok.timedOut, false);
});

test("a missing command fails without throwing", async () => {
  const r = await runGroup("/nonexistent/memory-search", [], { timeoutMs: 1000 });
  assert.notEqual(r.exitCode, 0);
});
