// A batched wake carries its digest (2026-11-19, tokens; the lead's go). Every wake used to
// begin with an orch_inbox call that only fetched the mail: 4.6% of a host's spend over five days. The conditions it
// was approved on: the wake says it is the digest; its cursor covers only what it shows; a cap that says "more",
// never a silent cut; a wake bb queues behind a running turn carries no copy; ACTION still wakes at once.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../server.ts";
import { Engine, type DeliverResult } from "../core/engine.ts";
import { WAKE_DIGEST_CAP } from "../core/batch-inbox.ts";
import type { Item } from "../core/model.ts";

function setup() {
  const clock = { t: Date.parse("2026-11-19T10:00:00Z") };
  const sent: { threadId: string; text: string; item: Item }[] = [];
  const e = new Engine(
    new DatabaseSync(":memory:") as never,
    {
      now: () => clock.t,
      deliver: async (threadId: string, text: string, item: Item): Promise<DeliverResult> => {
        sent.push({ threadId, text, item });
        return { delivery: "sent" };
      },
      mirror: () => {},
      changed: () => {},
      log: () => {},
    },
    // gap 0: these tests are about the digest and its cursor; the lead wake gap has its own (test/wake-gap.test.ts)
    { batchInbox: true, inboxDebounceMs: 2000, resendMs: 600_000, inboxGapMs: 0 },
  );
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-la", "lead", "kite");
  const worker = e.register("T-w1", "thread", "kite", "T-la");
  for (const a of [cos, lead, worker]) e.setStatus(a.threadId, "idle");
  // a flush records the wake (due after the debounce); a flush once it is due sends it
  const step = async (ms = 2000) => {
    await e.flush();
    clock.t += ms;
    await e.flush();
  };
  const wakes = () => sent.filter((x) => x.item.id.startsWith("wake:"));
  const cursorOf = (text: string) => text.match(/through="([0-9a-f]+)"/)![1]!;
  return { e, clock, sent, cos, lead, worker, step, wakes, cursorOf };
}

test("the wake is the digest: it says so, and carries every body with the cursor that acks them", async () => {
  const s = setup();
  const a = s.e.send(s.worker, s.lead.address, "parser done, 14 tests pass", null);
  const b = s.e.send(s.worker, s.lead.address, "writer done; PR next", null);
  await s.step();
  const [w] = s.wakes();
  assert.ok(w, "one wake");
  assert.match(w!.text, /This is your digest: handle it, then orch_ack with its cursor; no orch_inbox call needed\./);
  for (const it of [a, b]) assert.ok(w!.text.includes(it.id) && w!.text.includes(it.body), "each item, in full");
  assert.equal(s.e.batch.ack(s.lead, s.cursorOf(w!.text)), 2, "its cursor acks exactly those two");
  assert.equal(s.e.batch.read(s.lead).count, 0);
});

test("the wake's cursor covers only what it showed: later mail stays unread and gets its own wake", async () => {
  const s = setup();
  s.e.send(s.worker, s.lead.address, "first", null);
  await s.step();
  const first = s.wakes()[0]!;
  const late = s.e.send(s.worker, s.lead.address, "came after the wake", null);
  assert.equal(s.e.batch.ack(s.lead, s.cursorOf(first.text)), 1, "the late item is not in the first cursor");
  assert.equal(s.e.batch.read(s.lead).count, 1, "it is still unread");
  await s.step();
  const second = s.wakes()[1];
  assert.ok(second, "and it wakes the lead again");
  assert.ok(second!.text.includes(late.id) && !second!.text.includes(first.text.match(/\[(i-[0-9a-f]+)\]/)![1]!), "with only the new item");
});

test("past the cap the wake shows the first items and says how many more, and its cursor leaves those unread", async () => {
  const s = setup();
  const big = "x".repeat(3800); // a message is at most 4000 characters
  const items = [1, 2, 3, 4, 5, 6].map((n) => s.e.send(s.worker, s.lead.address, `${n} ${big}`, null));
  await s.step();
  const w = s.wakes()[0]!;
  const shown = items.filter((it) => w.text.includes(it.id)).length;
  assert.ok(shown >= 1 && shown < 6, `the wake shows ${shown} of 6`);
  assert.match(w.text, new RegExp(`${shown} of 6 unread`));
  assert.match(w.text, new RegExp(`${6 - shown} more unread, not shown here and not covered by this cursor: read them with orch_inbox\\.`));
  assert.ok(w.text.length < WAKE_DIGEST_CAP + 1000, "the wake stays near the cap");
  assert.equal(s.e.batch.ack(s.lead, s.cursorOf(w.text)), shown);
  assert.equal(s.e.batch.read(s.lead).count, 6 - shown, "the rest is still unread, never cut silently");
  const one = s.e.batch.read(s.lead, 10);
  assert.equal(one.count, 1, "an item past the cap on its own still goes, whole");
  assert.ok(one.text.includes(big));
});

test("ACTION mail wakes once its debounce ends; INFO alone does not wake", async () => {
  const s = setup();
  s.e.send(s.worker, s.lead.address, "fyi", null, null, { severity: "INFO" });
  await s.step(10_000);
  assert.equal(s.wakes().length, 0, "INFO is quiet");
  s.e.send(s.worker, s.lead.address, "please look", null);
  await s.step(1999);
  assert.equal(s.wakes().length, 0, "not before the debounce");
  s.clock.t += 1;
  await s.e.flush();
  assert.equal(s.wakes().length, 1, "then at once");
  assert.match(s.wakes()[0]!.text, /fyi/, "and the quiet INFO rides along in its digest");
});

test("one wake at a time: more mail before the ack adds no second copy of the digest", async () => {
  const s = setup();
  s.e.send(s.worker, s.lead.address, "one", null);
  await s.step();
  s.e.send(s.worker, s.lead.address, "two", null);
  await s.step();
  await s.step();
  assert.equal(s.wakes().length, 1);
});

// ------------------------------------------------------------- through the real server entry
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function host(status: string) {
  const root = mkdtempSync(join(tmpdir(), "orch-wakedigest-"));
  roots.push(root);
  mkdirSync(join(root, "projects"));
  const db = Object.assign(new DatabaseSync(join(root, "data.db")), { name: join(root, "data.db") });
  const sends: { threadId: string; text: string; mode: string }[] = [];
  const tools: Record<string, { execute: (p: unknown, ctx: { threadId: string }) => Promise<unknown> }> = {};
  const sdk = (path: string[]): any =>
    new Proxy(function () {}, {
      get: (_t, k) => (k === "then" ? undefined : sdk([...path, String(k)])),
      apply: (_t, _this, args: any[]) => {
        const p = path.join(".");
        if (p === "threads.send") {
          sends.push({ threadId: args[0].threadId, text: args[0].input.map((x: { text?: string }) => x.text ?? "").join(""), mode: args[0].mode });
          return Promise.resolve(status === "idle" ? { delivery: "sent" } : { delivery: "queued", queuedMessage: { id: "q-1" } });
        }
        if (p === "threads.get") return Promise.resolve({ status, archivedAt: null });
        if (/\.list$/.test(p)) return Promise.resolve([]);
        return Promise.resolve({});
      },
    });
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : noop), apply: () => noop });
  const bb: any = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "pluginId") return "orchestrator";
        if (k === "settings")
          return {
            define: (schema: Record<string, { default: unknown }>) => {
              const v: any = Object.fromEntries(Object.entries(schema).map(([key, d]) => [key, d.default]));
              Object.assign(v, { stateDir: join(root, "state"), projectsDir: join(root, "projects"), memoryConfig: "", diskPath: root, batchInbox: true, inboxDebounceMs: 1, prPollMinutes: 0 });
              return { get: async () => v, onChange: () => {} };
            },
          };
        if (k === "storage") return { database: () => db, kv: { get: async () => null, set: async () => {}, delete: async () => {} } };
        if (k === "sdk") return sdk([]);
        if (k === "agents") return new Proxy({ registerTool: (t: any) => (tools[t.name] = t) } as any, { get: (o, kk) => o[kk] ?? (() => {}) });
        if (k === "background") return { service: () => {} };
        if (k === "log") return { info: () => {}, warn: () => {}, error: () => {} };
        return noop;
      },
    },
  );
  return { bb, db, sends, tools };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const [status, digest] of [["idle", true], ["active", false], ["starting", false], ["error", true]] as const)
  test(`a wake to a thread bb reports ${status} goes ${digest ? "with its digest" : "bare, since bb queues it behind the turn"}`, async () => {
    const h = host(status);
    const e = new Engine(h.db as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
    const cos = e.register("T-cos", "cos", null);
    const lead = e.register("T-lead", "lead", "demo");
    e.setStatus(lead.threadId, "idle");
    await plugin(h.bb);
    await h.tools.orch_send!.execute({ to: lead.address, text: "the plan is ready" }, { threadId: cos.threadId });
    await sleep(20);
    await h.tools.orch_inbox!.execute({}, { threadId: cos.threadId }); // a later tool call's flush sends the due wake
    await sleep(20);
    const w = h.sends.find((x) => x.threadId === lead.threadId && x.text.includes("Inbox wake"));
    assert.ok(w, "the lead was woken");
    assert.equal(w!.mode, "queue-if-active");
    assert.equal(/This is your digest/.test(w!.text), digest);
    assert.equal(w!.text.includes("the plan is ready"), digest);
    if (!digest) assert.match(w!.text, /Read ALL unread with orch_inbox/, "the bare wake still says where the mail is");
  });
