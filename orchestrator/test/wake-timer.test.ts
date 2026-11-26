// A batched wake goes when it comes due (2026-11-18, speed). It used to wait for the next flush: another tool call, a
// turn ending, or the clock's pass, which runs 5 s after the last one finished and waits behind pr-watch, xp and
// layout. Live that put the plugin's own share of a wake's delay at p90 10 s and up to 112 s. These tests load the real
// server entry against a fake bb host and run its clock service, as bb does.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../server.ts";
import { Engine } from "../core/engine.ts";

type Service = { start: (signal: AbortSignal) => Promise<void> };
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake bb host whose threads are all idle; it records each wake bb is asked to send, and when. A wake for
 *  queuedThread is queued behind its turn (bb keeps the queued row), as for a busy thread. */
function host(debounceMs: number, slowThread: string | null = null, slowMs = 0, queuedThread: string | null = null, settings: Record<string, unknown> = {}, o: { blockClock?: boolean; gated?: Set<string> } = {}) {
  // gated: a wake to one of these threads is delivered only when the test opens it (held[] lists those waiting)
  const held: { threadId: string; at: number; open: () => void }[] = [];
  // blockClock: the clock's pass hangs in its xp step (threads.events.list) until release(), as behind a slow SDK job
  let release = () => {};
  const blocked = new Promise<void>((r) => (release = r));
  const root = mkdtempSync(join(tmpdir(), "orch-wake-"));
  roots.push(root);
  mkdirSync(join(root, "projects"));
  const db = Object.assign(new DatabaseSync(join(root, "data.db")), { name: join(root, "data.db") });
  const wakes: { threadId: string; at: number }[] = [];
  const services = new Map<string, Service>();
  const tools: Record<string, { execute: (p: unknown, ctx: { threadId: string }) => Promise<unknown> }> = {};
  // the settings as bb holds them, and the plugin's onChange listeners: set() changes them as the owner's form does
  let values: any = null;
  const listeners: ((next: any) => void)[] = [];
  const set = (patch: Record<string, unknown>) => {
    Object.assign(values, patch);
    for (const fn of listeners) fn({ ...values });
  };
  const sdk = (path: string[]): any =>
    new Proxy(function () {}, {
      get: (_t, k) => (k === "then" ? undefined : sdk([...path, String(k)])),
      apply: (_t, _this, args: any[]) => {
        const p = path.join(".");
        if (p === "threads.send") {
          if (JSON.stringify(args[0]?.input).includes("Inbox wake")) wakes.push({ threadId: args[0].threadId, at: Date.now() });
          if (args[0]?.threadId === queuedThread) return Promise.resolve({ delivery: "queued", queuedMessage: { id: "queued-1" } });
          if (o.gated?.has(args[0]?.threadId)) return new Promise((r) => held.push({ threadId: args[0].threadId, at: Date.now(), open: () => r({ delivery: "sent" }) }));
          return args[0]?.threadId === slowThread ? sleep(slowMs).then(() => ({ delivery: "sent" })) : Promise.resolve({ delivery: "sent" });
        }
        if (p === "threads.get") return Promise.resolve({ status: "idle", archivedAt: null });
        if (p === "threads.events.list" && o.blockClock) return blocked.then(() => []);
        if (p === "threads.queuedMessages.list") return Promise.resolve(args[0]?.threadId === queuedThread ? [{ id: "queued-1" }] : []);
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
              Object.assign(v, { stateDir: join(root, "state"), projectsDir: join(root, "projects"), memoryConfig: "", diskPath: root, batchInbox: true, inboxDebounceMs: debounceMs, prPollMinutes: 0 }, settings);
              // the plugin defines two groups; set() drives the main one (the one with the inbox settings)
              if (!("inboxGapMs" in schema)) return { get: async () => v, onChange: () => {} };
              values = v;
              return { get: async () => v, onChange: (fn: (next: any) => void) => listeners.push(fn) };
            },
          };
        if (k === "storage") return { database: () => db, kv: { get: async () => null, set: async () => {}, delete: async () => {} } };
        if (k === "sdk") return sdk([]);
        if (k === "agents") return new Proxy({ registerTool: (t: any) => (tools[t.name] = t) } as any, { get: (o, kk) => o[kk] ?? (() => {}) });
        if (k === "background") return { service: (name: string, s: Service) => services.set(name, s) };
        if (k === "log") return { info: () => {}, warn: () => {}, error: () => {} };
        return noop;
      },
    },
  );
  return { bb, db, wakes, services, tools, set, release, held };
}

test("a lead's message wakes an idle CoS when its debounce ends, not at the next clock pass", async () => {
  const h = host(300);
  const e = new Engine(h.db as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "demo");
  await plugin(h.bb);
  const stop = new AbortController();
  const clock = h.services.get("clock")!.start(stop.signal);
  try {
    await sleep(300); // the clock's first pass: reconcile, flush, then it sleeps 5 s
    const t0 = Date.now();
    await h.tools.orch_send!.execute({ to: "cos", text: "the plan is ready", severity: "ACTION" }, { threadId: lead.threadId });
    await sleep(1500);
    const wake = h.wakes.find((w) => w.threadId === cos.threadId);
    assert.ok(wake, "the wake went within 1.5 s, with no tool call or clock pass to carry it");
    assert.ok(wake!.at - t0 >= 300, "and not before its debounce");
  } finally {
    stop.abort();
    await clock;
  }
});

test("the wake timer stops with the clock service", async () => {
  const h = host(500);
  const e = new Engine(h.db as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "demo");
  await plugin(h.bb);
  const stop = new AbortController();
  const clock = h.services.get("clock")!.start(stop.signal);
  await sleep(300);
  await h.tools.orch_send!.execute({ to: "cos", text: "the plan is ready", severity: "ACTION" }, { threadId: lead.threadId });
  await sleep(50);
  // bb stops the services before it closes the database: an armed timer must not flush after that
  stop.abort();
  await clock;
  await sleep(800);
  assert.equal(h.wakes.filter((w) => w.threadId === cos.threadId).length, 0);
});

test("mail that arrives while a flush waits on a slow delivery is woken when that flush ends, not at the next clock pass", async () => {
  // a tool call's flush that finds one in flight was dropped; that flush had read its recipients before the mail came
  const h = host(300, "T-a", 2000);
  const e = new Engine(h.db as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  const cos = e.register("T-cos", "cos", null);
  e.register("T-a", "lead", "alpha");
  const b = e.register("T-b", "lead", "beta");
  await plugin(h.bb);
  const stop = new AbortController();
  const clock = h.services.get("clock")!.start(stop.signal);
  try {
    await sleep(300);
    await h.tools.orch_send!.execute({ to: "lead:alpha", text: "for a", severity: "ACTION" }, { threadId: cos.threadId });
    await sleep(500); // a's wake is on its way (2 s)
    const t0 = Date.now();
    await h.tools.orch_send!.execute({ to: b.address, text: "for b", severity: "ACTION" }, { threadId: cos.threadId });
    for (let i = 0; i < 100 && !h.wakes.some((w) => w.threadId === b.threadId); i++) await sleep(100);
    const wake = h.wakes.find((w) => w.threadId === b.threadId);
    assert.ok(wake, "b is woken");
    // a's delivery ends about 1.5 s after b's mail; b's debounce is 0.3 s more. The next clock pass was 5 s on.
    assert.ok(wake!.at - t0 < 2800, `b's wake went ${wake!.at - t0} ms after its mail`);
  } finally {
    stop.abort();
    await clock;
  }
});

test("the wake timer, tool-call flushes and re-runs together wake each recipient once", async () => {
  // the lead's guardrail for the timer and the re-run: no lost wake, and no double delivery when they overlap
  const h = host(300, "T-a", 1000);
  const e = new Engine(h.db as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  const cos = e.register("T-cos", "cos", null);
  const a = e.register("T-a", "lead", "alpha");
  const b = e.register("T-b", "lead", "beta");
  await plugin(h.bb);
  const stop = new AbortController();
  const clock = h.services.get("clock")!.start(stop.signal);
  try {
    await sleep(300);
    await h.tools.orch_send!.execute({ to: "lead:alpha", text: "for a", severity: "ACTION" }, { threadId: cos.threadId });
    await h.tools.orch_send!.execute({ to: b.address, text: "for b", severity: "ACTION" }, { threadId: cos.threadId });
    // a tool call every 50 ms for 2.5 s: flushes before, at and after the debounce, and during a's 1 s delivery
    for (let i = 0; i < 50; i++) {
      void h.tools.orch_inbox!.execute({}, { threadId: cos.threadId });
      await sleep(50);
    }
    const woken = (x: { threadId: string }) => h.wakes.filter((w) => w.threadId === x.threadId).length;
    for (let i = 0; i < 100 && !(woken(a) && woken(b)); i++) await sleep(100); // a loaded host can be slow to fire
    await sleep(1000);
    assert.equal(h.wakes.filter((w) => w.threadId === a.threadId).length, 1, "a is woken once");
    assert.equal(h.wakes.filter((w) => w.threadId === b.threadId).length, 1, "b is woken once");
  } finally {
    stop.abort();
    await clock;
  }
});

test("a recipient whose wake is sent or queued gets no second wake when the timer fires for other mail", async () => {
  // the lead's case: new mail for a recipient already woken (sent, or queued behind a busy turn) rides on that wake
  const h = host(300, null, 0, "T-q");
  const e = new Engine(h.db as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  const cos = e.register("T-cos", "cos", null);
  const a = e.register("T-a", "lead", "alpha");
  const q = e.register("T-q", "lead", "queued");
  const b = e.register("T-b", "lead", "beta");
  await plugin(h.bb);
  const stop = new AbortController();
  const clock = h.services.get("clock")!.start(stop.signal);
  try {
    await sleep(300);
    for (const to of [a, q]) await h.tools.orch_send!.execute({ to: to.address, text: "first", severity: "ACTION" }, { threadId: cos.threadId });
    const woken = (x: { threadId: string }) => h.wakes.filter((w) => w.threadId === x.threadId).length;
    for (let i = 0; i < 100 && !(woken(a) && woken(q)); i++) await sleep(100); // a loaded host can be slow to fire
    await sleep(300);
    assert.deepEqual([a, q].map((x) => h.wakes.filter((w) => w.threadId === x.threadId).length), [1, 1], "a (sent) and q (queued) are woken once");
    const states = Object.fromEntries((h.db.prepare(`SELECT recipient, state FROM inbox_wakes`).all() as { recipient: string; state: string }[]).map((r) => [r.recipient, r.state]));
    assert.equal(states[a.address], "sent");
    assert.equal(states[q.address], "queued");
    // more mail for a and q, unread, and mail for b, whose wake arms the timer; tool calls flush throughout
    for (const to of [a, q, b]) await h.tools.orch_send!.execute({ to: to.address, text: "second", severity: "ACTION" }, { threadId: cos.threadId });
    for (let i = 0; i < 30; i++) {
      void h.tools.orch_inbox!.execute({}, { threadId: cos.threadId });
      await sleep(50);
    }
    for (let i = 0; i < 100 && !woken(b); i++) await sleep(100);
    await sleep(500);
    assert.equal(h.wakes.filter((w) => w.threadId === b.threadId).length, 1, "the timer fired: b is woken");
    assert.equal(h.wakes.filter((w) => w.threadId === a.threadId).length, 1, "a's sent wake is not sent again");
    assert.equal(h.wakes.filter((w) => w.threadId === q.threadId).length, 1, "q's queued wake is not sent again");
  } finally {
    stop.abort();
    await clock;
  }
});

// The lead wake gap (2026-11-24) is the inboxGapMs setting: the owner's settings are pinned, so the lead sets it after
// install, and the server must pass the value it reads (not only the default) to the engine; 0 must switch it off.
/** dueInMs: the second message has a deadline that far ahead. afterSecond: runs once the second message is sent. */
async function twoLeadWakes(gapMs: number, o: { dueInMs?: number; afterSecond?: (h: ReturnType<typeof host>, leadWakes: () => unknown[]) => Promise<void> } = {}) {
  const h = host(100, null, 0, null, { inboxGapMs: gapMs });
  const e = new Engine(h.db as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "demo");
  await plugin(h.bb);
  const stop = new AbortController();
  const clock = h.services.get("clock")!.start(stop.signal);
  try {
    // polled, not slept: on a loaded host the plugin's first pass can take seconds
    const leadWakes = () => h.wakes.filter((x) => x.threadId === lead.threadId);
    const until = async (n: number, ms: number) => {
      for (const end = Date.now() + ms; leadWakes().length < n && Date.now() < end; ) await sleep(50);
    };
    await sleep(300);
    await h.tools.orch_send!.execute({ to: lead.address, text: "first", severity: "ACTION" }, { threadId: cos.threadId });
    await until(1, 10_000);
    const r = e.batch.read(lead);
    e.batch.ack(lead, r.cursor!); // the lead handled its first wake
    const sentAt = Date.now();
    await h.tools.orch_send!.execute({ to: lead.address, text: "second", severity: "ACTION", ...(o.dueInMs !== undefined ? { due_at: sentAt + o.dueInMs } : {}) }, { threadId: cos.threadId });
    await o.afterSecond?.(h, leadWakes);
    await until(2, gapMs + 10_000);
    return { w: leadWakes(), sentAt };
  } finally {
    stop.abort();
    await clock;
  }
}

test("the inboxGapMs setting reaches the engine: a lead's second wake waits for the gap the setting names", async () => {
  const { w } = await twoLeadWakes(1500);
  assert.equal(w.length, 2, "the held wake still goes: the timer fires at the gap's end");
  assert.ok(w[1]!.at - w[0]!.at >= 1500, `the second wake came ${w[1]!.at - w[0]!.at} ms after the first`);
});

test("inboxGapMs 0 switches the gap off: the second wake goes after the debounce", async () => {
  const { w, sentAt } = await twoLeadWakes(0);
  assert.equal(w.length, 2);
  // well under the 120 s default: 0 is off, not "unset, use the default"
  assert.ok(w[1]!.at - sentAt < 10_000, `the second wake came ${w[1]!.at - sentAt} ms after its mail`);
});

// Codex review of f7127eb, P1 (2026-11-24): an item due inside a lead's wake gap waited for the gap's end (119 s in its
// replay), because the wake timer armed only for the held wake. A deadline is a promise to the sender: the timer must
// fire for it, with no tool call or clock pass to carry it (the clock's next pass here is 5 s away).
test("an item due inside the gap wakes the lead at its deadline, through the wake timer, not at the gap's end", async () => {
  const { w, sentAt } = await twoLeadWakes(4000, { dueInMs: 1000 });
  assert.equal(w.length, 2);
  const after = w[1]!.at - sentAt;
  assert.ok(after >= 900, `not before its deadline: it came ${after} ms after its mail`);
  assert.ok(after < 2500, `at its deadline (1000 ms) plus the debounce, not at the gap's end (~4000 ms): it came ${after} ms after its mail`);
});

// Codex review of f7127eb, P1: turning the gap off kept a wake it had already held (116 s in its replay). The owner
// turns the gap off to get mail through now, so the held wake must go after the debounce, without waiting for a tool
// call or the clock.
test("lowering inboxGapMs to 0 releases a wake the gap already held, at once", async () => {
  let changedAt = 0;
  const { w } = await twoLeadWakes(60_000, {
    afterSecond: async (h, leadWakes) => {
      await sleep(400);
      assert.equal(leadWakes().length, 1, "held by the 60 s gap");
      changedAt = Date.now();
      h.set({ inboxGapMs: 0 });
    },
  });
  assert.equal(w.length, 2);
  const after = w[1]!.at - changedAt;
  assert.ok(after < 2500, `the held wake went ${after} ms after the gap was turned off`);
});

// Codex second pass on fb75e74, P1 (2026-11-24): the timer fired for another recipient whose delivery took 2 s, and the
// lead's deadline passed during it. The flush judged the lead with its time from before the deadline (not urgent),
// and nextDue then left out the deadline, now past: the overdue wake sat ~57 s ahead with the clock stuck on another
// SDK job. A deadline crossed during a flush must be acted on at once, not at the gap's end.
test("a deadline that passes while a flush waits on a slow delivery still wakes the lead at once, with the clock stuck", async () => {
  const h = host(200, "T-cos", 2000, null, { inboxGapMs: 60_000 }, { blockClock: true });
  const e = new Engine(h.db as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "demo");
  await plugin(h.bb);
  const stop = new AbortController();
  const clock = h.services.get("clock")!.start(stop.signal);
  try {
    const leadWakes = () => h.wakes.filter((x) => x.threadId === lead.threadId);
    const until = async (f: () => boolean, ms: number) => {
      for (const end = Date.now() + ms; !f() && Date.now() < end; ) await sleep(50);
    };
    await sleep(300); // the clock's first pass flushes, then hangs in its xp step: no clock pass rescues anything below
    await h.tools.orch_send!.execute({ to: lead.address, text: "first", severity: "ACTION" }, { threadId: cos.threadId });
    await until(() => leadWakes().length === 1, 10_000);
    e.batch.ack(lead, e.batch.read(lead).cursor!); // the lead handled it: its 60 s gap starts
    const t = Date.now();
    // the lead's item is due 800 ms from now, inside its gap; the CoS's wake comes due first, at 200 ms, and its
    // delivery takes 2 s, so the deadline passes while that flush waits
    await h.tools.orch_send!.execute({ to: lead.address, text: "due soon", severity: "ACTION", due_at: t + 800 }, { threadId: cos.threadId });
    await h.tools.orch_send!.execute({ to: cos.address, text: "for the CoS", severity: "ACTION" }, { threadId: lead.threadId });
    await until(() => leadWakes().length === 2, 8000);
    assert.equal(leadWakes().length, 2, "the overdue lead wake went, not ~60 s later at the gap's end");
    const after = leadWakes()[1]!.at - t;
    assert.ok(after < 4000, `it went ${after} ms after its mail: the 800 ms deadline, the 2 s delivery it waited behind, the debounce`);
  } finally {
    h.release();
    stop.abort();
    await clock;
  }
});

// Codex second pass on fb75e74, P1: a deadline more than 2^31-1 ms ahead (about 24.8 days) overflowed setTimeout,
// which Node turns into 1 ms: each callback flushed and set the same timer again (70 timers in 300 ms for an item due in
// 30 days), with database work and a warning each time. The timer must wait at most Node's maximum and look again then.
test("a deadline 30 days ahead sets one bounded timer, not a 1 ms loop", async () => {
  const h = host(100);
  const e = new Engine(h.db as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "demo");
  await plugin(h.bb);
  const stop = new AbortController();
  const clock = h.services.get("clock")!.start(stop.signal);
  const real = globalThis.setTimeout;
  const long: number[] = [];
  const warnings: string[] = [];
  const onWarning = (w: Error) => warnings.push(w.name);
  process.on("warning", onWarning);
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    if ((ms ?? 0) > 86_400_000) long.push(ms!);
    return real(fn, ms, ...rest);
  }) as typeof setTimeout;
  try {
    await sleep(300);
    await h.tools.orch_send!.execute({ to: lead.address, text: "renew the certificate", severity: "INFO", due_at: Date.now() + 30 * 86_400_000 }, { threadId: cos.threadId });
    await sleep(500);
    assert.ok(long.length >= 1, "the wake timer is set for the deadline");
    assert.ok(long.length <= 2, `${long.length} timers over a day were set in 500 ms: a loop`);
    assert.ok(long.every((ms) => ms <= 2_147_483_647), `no delay past Node's maximum: ${long.join(", ")}`);
    assert.ok(!warnings.includes("TimeoutOverflowWarning"), "and Node warned of no overflow");
  } finally {
    globalThis.setTimeout = real;
    process.off("warning", onWarning);
    stop.abort();
    await clock;
  }
});

// Codex third pass on 3bc7815, P1 (2026-11-24): the flush passes again while a deadline crossed during its last pass,
// but at most five times. Five staggered slow deliveries, each crossing the next one's deadline, used them all; the
// lead's deadline crossed during the fifth, the loop stopped, and the wake timer leaves past deadlines out: the overdue
// lead wake sat behind its gap (118 s in Codex's replay). At the limit the plugin must yield and flush again at once.
test("a deadline crossed during the fifth pass in a row still wakes the lead at once, with the clock stuck", async () => {
  const X = ["T-x1", "T-x2", "T-x3", "T-x4", "T-x5"];
  const DB = 1000; // debounce: a wake made in one pass is due in the next
  const h = host(DB, null, 0, null, { inboxGapMs: 60_000 }, { blockClock: true, gated: new Set(X) });
  const e = new Engine(h.db as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "demo");
  // five other leads, never woken (no gap): each delivery to them hangs until the test opens it, like a slow SDK call
  const xs = X.map((id, n) => e.register(id, "lead", `p${n + 1}`));
  await plugin(h.bb);
  const stop = new AbortController();
  const clock = h.services.get("clock")!.start(stop.signal);
  const until = async (f: () => boolean, ms: number, what: string) => {
    for (const end = Date.now() + ms; !f() && Date.now() < end; ) await sleep(20);
    assert.ok(f(), `${what}, after ${ms} ms (passes delivering: ${h.held.length}, lead wakes: ${leadWakes().length})`);
  };
  const leadWakes = () => h.wakes.filter((x) => x.threadId === lead.threadId);
  // every 0 ms timer set: the re-flush must be one timer per flush at its limit, never a loop
  const real = globalThis.setTimeout;
  const zero: number[] = [];
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    if (!ms) zero.push(Date.now());
    return real(fn, ms, ...rest);
  }) as typeof setTimeout;
  try {
    await sleep(300); // the clock's first pass flushes, then hangs in its xp step
    await h.tools.orch_send!.execute({ to: lead.address, text: "first", severity: "ACTION" }, { threadId: cos.threadId });
    await until(() => leadWakes().length === 1, 10_000, "the lead's first wake");
    e.batch.ack(lead, e.batch.read(lead).cursor!); // its 60 s gap starts
    // Pass k delivers x_k and holds until opened. Mail for x_{k+1} was written (with no flush) before pass k began, so
    // pass k makes its wake, due by pass k+1; its deadline falls inside pass k, so the flush passes again. The lead's
    // item is written during pass 4 with a deadline that falls inside pass 5, the last the limit allows.
    await h.tools.orch_send!.execute({ to: xs[0]!.address, text: "x1", severity: "ACTION" }, { threadId: cos.threadId });
    const firstDue = Date.now() + DB;
    e.send(cos, xs[1]!.address, "x2", null, null, { severity: "ACTION", dueAt: firstDue + 300 });
    let releasedAt = 0;
    for (let k = 0; k < 5; k++) {
      await until(() => h.held.length === k + 1, 15_000, `pass ${k + 1} delivering ${X[k]}`);
      const pass = h.held[k]!;
      assert.equal(pass.threadId, X[k], `pass ${k + 1} delivers ${X[k]}`);
      await sleep(DB + 100); // x_{k+2}'s wake comes due, and the deadline written for this pass is crossed
      releasedAt = Date.now();
      if (k < 3) e.send(cos, xs[k + 2]!.address, `x${k + 3}`, null, null, { severity: "ACTION", dueAt: releasedAt + 300 });
      if (k === 3) e.send(cos, lead.address, "due inside pass 5", null, null, { severity: "ACTION", dueAt: releasedAt + 300 });
      pass.open();
    }
    assert.equal(h.held.length, 5, "the five passes ran in one flush, each delivering one");
    await until(() => leadWakes().length === 2, 8000, "the overdue lead wake (its gap ends ~60 s on)");
    const after = leadWakes()[1]!.at - releasedAt;
    assert.ok(after < DB + 2500, `the overdue lead wake went ${after} ms after the fifth pass, not at its gap's end`);
    const settled = zero.length;
    await sleep(300);
    assert.ok(settled >= 1, "the fifth pass's re-flush went on a 0 ms timer");
    assert.ok(settled <= 3, `${settled} zero-delay timers in the whole run: one per flush at its limit, not a loop`);
    assert.equal(zero.length, settled, "and none once the lead is woken: nothing is left to re-flush for");
  } finally {
    globalThis.setTimeout = real;
    for (const p of h.held) p.open();
    h.release();
    stop.abort();
    await clock;
  }
});
