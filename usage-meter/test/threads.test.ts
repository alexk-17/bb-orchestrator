// Each events read costs the bb server real time, so the reader must stay correct
// while reading as little as it can: incrementally, persisted, and stoppable.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createUsageScanner, type BbThreadsApi } from "../usage-scan.ts";

const T0 = Date.parse("2026-11-20T00:00:00Z");
const S1 = "aaaaaaaa-0000-0000-0000-000000000001";
const S2 = "aaaaaaaa-0000-0000-0000-000000000002";

function transcripts(root: string): string {
  const dir = path.join(root, "projects");
  const project = path.join(dir, "-scratch");
  fs.mkdirSync(project, { recursive: true });
  for (const [index, session] of [S1, S2].entries()) {
    const line = {
      type: "assistant",
      timestamp: new Date(T0 + index * 1000).toISOString(),
      sessionId: session,
      cwd: "/scratch",
      message: { id: `msg_${index}`, model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 5 } },
    };
    fs.writeFileSync(path.join(project, `${session}.jsonl`), `${JSON.stringify(line)}\n`);
  }
  return dir;
}

function fakeBb() {
  const thread = (id: string, title: string, createdAt: number, providerId = "claude-code") => ({
    id,
    providerId,
    title,
    titleFallback: null,
    projectId: "p",
    environmentId: null,
    createdAt,
    updatedAt: T0 - 86_400_000,
  });
  const events: Record<string, Array<{ seq: number; type: string; data: { providerThreadId: string } }>> = {
    thr_a: [{ seq: 3, type: "thread/identity", data: { providerThreadId: S1 } }],
    thr_fork: [{ seq: 1, type: "turn/started", data: { providerThreadId: S1 } }],
    thr_codex: [{ seq: 1, type: "turn/started", data: { providerThreadId: S1 } }],
    thr_b: Array.from({ length: 150 }, (_, index) => ({
      seq: index + 1,
      type: "turn/started",
      data: { providerThreadId: index === 149 ? S2 : "other-session" },
    })),
  };
  const calls = { list: 0, events: 0, codex: 0 };
  let failNext = false;
  const api: BbThreadsApi = {
    async list() {
      calls.list += 1;
      if (failNext) {
        failNext = false;
        throw new Error("bb is restarting");
      }
      return [
        thread("thr_fork", "Fork", 20),
        thread("thr_a", "Original", 10),
        thread("thr_b", "Long", 15),
        thread("thr_codex", "Codex", 5, "codex"),
      ];
    },
    events: {
      async list(args) {
        calls.events += 1;
        if (args.threadId === "thr_codex") calls.codex += 1;
        const after = Number(args.afterSeq ?? 0);
        return (events[args.threadId] ?? []).filter((row) => row.seq > after).slice(0, Number(args.limit));
      },
    },
  };
  return { api, calls, failOnce: () => (failNext = true) };
}

function labels(scanner: ReturnType<typeof createUsageScanner>): string[] {
  return scanner
    .summary({ from: T0 - 1000, to: T0 + 10_000, topN: 0 })
    .byThread.map((bucket) => bucket.label)
    .sort();
}

test("sessions resolve to the thread that ran them, across event pages, restarts and a bb outage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-meter-threads-"));
  try {
    const transcriptsDir = transcripts(root);
    const cacheDir = path.join(root, "cache");
    const bb = fakeBb();
    let now = T0 + 86_400_000;
    const options = { transcriptsDir, goRunsDir: path.join(root, "go"), cacheDir, now: () => now };

    bb.failOnce();
    const first = createUsageScanner({ ...options, threads: bb.api });
    await first.scan();
    assert.deepEqual(labels(first), ["Without a bb thread"]);

    now += 61_000;
    await first.scan();
    assert.deepEqual(labels(first), ["Long", "Original"]);
    assert.equal(bb.calls.codex, 0, "a Codex thread's events were read");
    first.close();

    const eventsBefore = bb.calls.events;
    const second = createUsageScanner({ ...options, threads: bb.api });
    await second.scan();
    assert.deepEqual(labels(second), ["Long", "Original"]);
    assert.equal(bb.calls.events, eventsBefore, "unchanged threads were read again after a restart");
    second.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a stop during the first fill ends the reads at once and keeps what was read", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-meter-threads-"));
  try {
    const options = {
      transcriptsDir: transcripts(root),
      goRunsDir: path.join(root, "go"),
      cacheDir: path.join(root, "cache"),
      now: () => T0 + 86_400_000,
    };
    const ids = ["thr_1", "thr_2", "thr_3", "thr_4", "thr_5"];
    const read: string[] = [];
    const controller = new AbortController();
    const api: BbThreadsApi = {
      list: async () =>
        ids.map((id, index) => ({ id, providerId: "claude-code", title: id, createdAt: index, updatedAt: index })),
      events: {
        async list(args) {
          read.push(args.threadId);
          if (read.length === 2) controller.abort();
          return [];
        },
      },
    };
    const first = createUsageScanner({ ...options, threads: api });
    await first.scan({ signal: controller.signal });
    assert.equal(read.length, 2, "reads went on after the stop");
    first.close();

    const second = createUsageScanner({ ...options, threads: api });
    await second.scan();
    assert.deepEqual(read.slice(2).sort(), ids.filter((id) => !read.slice(0, 2).includes(id)).sort());
    second.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
