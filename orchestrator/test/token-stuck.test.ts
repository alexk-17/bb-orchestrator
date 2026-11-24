// New threads are spawned with parentNotifications "stuck" (2026-11-20, tokens; the lead's go). Under "auto", bb woke
// the lead at every turn a thread ended: 1,823 lead turns in five days, 3.8% of a host's spend. Under "stuck" bb wakes
// it only on a failure, so the plugin must still wake the lead for every thread event a lead acts on: a report, a
// question, a failure, a prompt the thread is blocked on. A plain turn end waits in the next digest as INFO.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../server.ts";
import { Engine } from "../core/engine.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function world() {
  const root = mkdtempSync(join(tmpdir(), "orch-stuck-"));
  roots.push(root);
  mkdirSync(join(root, "projects"));
  const db = Object.assign(new DatabaseSync(join(root, "data.db")), { name: join(root, "data.db") });
  const sends: { threadId: string; text: string }[] = [];
  const tools: Record<string, { execute: (p: unknown, ctx: { threadId: string }) => Promise<any> }> = {};
  const on: Record<string, ((ev: any) => unknown)[]> = {};
  const sdk = (path: string[]): any =>
    new Proxy(function () {}, {
      get: (_t, k) => (k === "then" ? undefined : sdk([...path, String(k)])),
      apply: (_t, _this, args: any[]) => {
        const p = path.join(".");
        if (p === "threads.send") {
          sends.push({ threadId: args[0].threadId, text: args[0].input.map((x: { text?: string }) => x.text ?? "").join("") });
          return Promise.resolve({ delivery: "sent" });
        }
        if (p === "threads.get") return Promise.resolve({ status: "idle", archivedAt: null });
        if (/\.list$/.test(p)) return Promise.resolve([]);
        return Promise.resolve({});
      },
    });
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : noop), apply: () => noop });
  const bb: any = new Proxy({}, {
    get(_t, k) {
      if (k === "pluginId") return "orchestrator";
      if (k === "settings")
        return { define: (schema: Record<string, { default: unknown }>) => {
          const v: any = Object.fromEntries(Object.entries(schema).map(([key, d]) => [key, d.default]));
          Object.assign(v, { stateDir: join(root, "state"), projectsDir: join(root, "projects"), memoryConfig: "", diskPath: root, inboxDebounceMs: 1, prPollMinutes: 0 });
          return { get: async () => v, onChange: () => {} };
        } };
      if (k === "storage") return { database: () => db, kv: { get: async () => null, set: async () => {}, delete: async () => {} } };
      if (k === "sdk") return sdk([]);
      if (k === "events") return { on: (name: string, fn: any) => (on[name] ??= []).push(fn) };
      if (k === "agents") return new Proxy({ registerTool: (t: any) => (tools[t.name] = t) } as any, { get: (o, kk) => o[kk] ?? (() => {}) });
      if (k === "background") return { service: () => {} };
      if (k === "log") return { info: () => {}, warn: () => {}, error: () => {} };
      return noop;
    },
  });
  const e = new Engine(db as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "kite");
  const worker = e.register("T-w", "thread", "kite", "T-lead");
  for (const a of [cos, lead, worker]) e.setStatus(a.threadId, "idle");
  await plugin(bb);
  const emit = async (name: string, ev: unknown) => {
    for (const h of on[name] ?? []) await h(ev);
  };
  const stuck = { id: worker.threadId, parentThreadId: lead.threadId, parentNotifications: "stuck" };
  // let the debounced wake come due, then a tool call's flush sends it
  const settle = async () => {
    await sleep(15);
    await tools.orch_inbox!.execute({}, { threadId: cos.threadId });
    await sleep(15);
  };
  const leadWakes = () => sends.filter((s) => s.threadId === lead.threadId && s.text.includes("Inbox wake"));
  const unread = () => e.batch.read(lead).text;
  return { tools, emit, stuck, settle, leadWakes, unread, lead, worker, cos, e };
}

test("a thread's report wakes its lead at once, with the report line", async () => {
  const w = await world();
  await w.tools.orch_report!.execute({ title: "importer done", body: "tests green", pr: "https://example.com/pr/1" }, { threadId: w.worker.threadId });
  await w.settle();
  assert.equal(w.leadWakes().length, 1);
  assert.match(w.leadWakes()[0]!.text, /report: "importer done" \(https:\/\/example\.com\/pr\/1\)/);
});

test("a thread's question still wakes its lead", async () => {
  const w = await world();
  await w.tools.orch_ask!.execute({ title: "Schema?", question: "Use the v2 schema?", options: [{ label: "Yes" }, { label: "No" }] }, { threadId: w.worker.threadId });
  await w.settle();
  assert.equal(w.leadWakes().length, 1);
  assert.match(w.leadWakes()[0]!.text, /decision\.new/);
});

test("a failed thread reaches its lead once: bb tells it under stuck, so the plugin's own notice adds no second wake", async () => {
  // seen in an isolated bb (iso/stuck): a child's failed turn gets "[bb system] … failed" to its parent under stuck as under auto
  const w = await world();
  assert.equal(w.e.bbTellsSupervisor(w.worker, w.lead.threadId, "stuck", "failure"), true, "bb's stuck covers a failure");
  assert.equal(w.e.bbTellsSupervisor(w.worker, w.lead.threadId, "stuck", "turn"), false, "but not a turn end");
  await w.emit("turn.failed", { threadId: w.worker.threadId, errorInfo: { kind: "rate_limit" } });
  await w.emit("thread.failed", { thread: w.stuck, error: "401" });
  await w.settle();
  assert.equal(w.leadWakes().length, 0, "no plugin wake on top of bb's");
  assert.match(w.unread(), /notice from orchestrator; INFO\n[^\n]*a turn failed/, "the detail waits in the digest");
});

test("a failed thread bb doesn't tell its lead about (no bb parent) wakes the lead through the plugin", async () => {
  const w = await world();
  await w.emit("thread.failed", { thread: { id: w.worker.threadId, parentThreadId: null }, error: "401" });
  await w.settle();
  assert.equal(w.leadWakes().length, 1);
  assert.match(w.leadWakes()[0]!.text, /thread:kite:1: failed: 401/);
});

test("a thread blocked on a prompt wakes its lead once per prompt", async () => {
  const w = await world();
  await w.emit("interaction.pending", { thread: w.stuck, interaction: { id: "int-1" } });
  await w.emit("interaction.pending", { thread: w.stuck, interaction: { id: "int-1" } });
  await w.settle();
  assert.equal(w.leadWakes().length, 1);
  assert.match(w.leadWakes()[0]!.text, /is waiting on a prompt in its bb thread/);
  assert.equal(w.leadWakes()[0]!.text.match(/is waiting on a prompt/g)!.length, 1, "the same prompt is said once");
});

test("a plain turn end goes into the lead's next digest as INFO and wakes no one", async () => {
  const w = await world();
  await w.emit("thread.idle", { thread: w.stuck, lastAssistantText: "parser done" });
  await w.settle();
  assert.equal(w.leadWakes().length, 0);
  assert.match(w.unread(), /notice from orchestrator; INFO\n[^\n]*finished a turn\. Last words: "parser done"/);
});

test("a thread spawned under auto is left as it was: bb tells its lead, the plugin adds nothing", async () => {
  const w = await world();
  const auto = { ...w.stuck, parentNotifications: "auto" };
  await w.emit("thread.idle", { thread: auto, lastAssistantText: "x" });
  await w.emit("interaction.pending", { thread: auto, interaction: { id: "int-2" } });
  await w.settle();
  assert.equal(w.e.batch.read(w.lead).count, 0);
});

// 2026-11-24, the lead's call: handed-off successors and adopted threads kept "auto", and
// bb woke the lead with "… completed" at every turn end of them, outside the plugin's inbox and its wake gap. They now
// get the spawn path's "stuck" (resolve.test.ts, adopt.test.ts and cos-start-lead.test.ts pin the calls). At that
// level a turn end must wake no one, and a prompt or a failure must still reach the lead.
for (const kind of ["handed-off successor", "adopted thread"] as const)
  test(`a ${kind} at the spawn path's level: a turn end wakes no one, a prompt wakes the lead, a failure is told by bb`, async () => {
    const w = await world();
    const a =
      kind === "handed-off successor"
        ? w.e.takeOver(w.worker.threadId, "T-succ", "codex; handoff.md", { from: "claude-code", to: "codex" })
        : w.e.adopt({ threadId: "T-adopted", role: "thread", project: "kite", parentThreadId: w.lead.threadId, approval: "owner-approved" }, "env-a", "bbp-1");
    w.e.setStatus(a.threadId, "idle");
    const t = { id: a.threadId, parentThreadId: w.lead.threadId, parentNotifications: "stuck" };
    assert.equal(w.e.bbTellsSupervisor(a, w.lead.threadId, "stuck", "turn"), false, "bb says nothing at a turn end under stuck");
    await w.emit("thread.idle", { thread: t, lastAssistantText: "done for now" });
    await w.settle();
    assert.equal(w.leadWakes().length, 0, "a turn end wakes no one");
    assert.match(w.unread(), /INFO\n[^\n]*finished a turn\. Last words: "done for now"/, "it rides in the next digest");
    await w.emit("interaction.pending", { thread: t, interaction: { id: "int-s" } });
    await w.settle();
    assert.equal(w.leadWakes().length, 1, "a thread blocked on a prompt still wakes its lead");
    assert.match(w.leadWakes()[0]!.text, /is waiting on a prompt in its bb thread/);
    assert.equal(w.e.bbTellsSupervisor(a, w.lead.threadId, "stuck", "failure"), true, "a failure is told by bb under stuck");
  });

test("nothing in the server sets auto any more: spawn, handoff and the startup reconcile set stuck, adopt takes its level from the role", () => {
  const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  const spawn = src.slice(src.indexOf('name: "orch_spawn_thread"'), src.indexOf('name: "orch_resolve"'));
  assert.match(spawn, /parentNotifications: "stuck"/);
  assert.equal(src.match(/parentNotifications: "auto"/g), null);
  assert.equal(src.match(/parentNotifications: "stuck"/g)?.length, 3, "spawn, handoff and the startup reconcile (notify-level.test.ts)");
  assert.match(src, /parent: async \(id, parentThreadId, notify\) => \{ await bb\.sdk\.threads\.update\(\{ threadId: id, parentThreadId, parentNotifications: notify \}\)/);
});
