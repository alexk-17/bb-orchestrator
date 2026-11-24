// The refresh fan-out fix, against the real server entry on a fake bb host (lag fix, 2026-11-23). The owner's page
// lagged by seconds: every change made every mounted screen refetch every read, and the agents and needsYou reads asked
// bb about each of ~32 live agents each time (a 14.7 s project page: 36 reads, 384+ bb calls). Now the change notice
// names the tables written and each screen refetches only the reads that read one, and bb's thread reads are kept 5 s
// and shared. Either may never leave a screen stale:
// - every read reads only tables its change-notice.ts READS entry declares, and a read that shows a status declares it;
// - bb's news of a thread, and the owner's answer, re-read that thread at once;
// - the notice after a status flip, an answer, an approval or a prompt touches the reads that show it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../server.ts";
import { Engine } from "../core/engine.ts";
import { BB, KNOWN_TABLES, LIVE, READS, STATUS, touches, type ChangeRead } from "../change-notice.ts";
import { WRITES } from "../contract.ts";
import { ChangeTables, recordWrites } from "../core/write-log.ts";
import { pr, seedBusy } from "./fixtures/busy-seed.ts";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const tick = () => new Promise<void>((r) => setTimeout(r, 2));
const settle = (ms = 200) => new Promise<void>((r) => setTimeout(r, ms));

/** The tables a SELECT reads (FROM and JOIN), for the read map's check. */
const readTables = (sql: string) => [...sql.replace(/\s+/g, " ").matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi)].map((m) => m[1]!.toLowerCase());

type Handler = (input: unknown, ctx?: unknown) => unknown;

/** The real server on a fake bb, its database seeded busy (34 agents), every bb SDK call counted. */
async function host(opts: { batchInbox?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orch-reads-"));
  roots.push(root);
  const projects = join(root, "projects");
  mkdirSync(join(projects, "kite-app"), { recursive: true });
  writeFileSync(join(projects, "kite-app", "PROJECT.md"), "# kite-app\n");
  writeFileSync(join(projects, "kite-app", "project.json"), "{}");
  const proof = join(root, "proof.png");
  writeFileSync(proof, Buffer.from(PNG, "base64"));
  const raw = new DatabaseSync(join(root, "data.db"));
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF"); // a scratch file: no fsync per write
  const reads = new Set<string>();
  const db: any = {
    name: join(root, "data.db"),
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => {
      const st = raw.prepare(sql);
      const t = readTables(sql);
      const mark = () => t.forEach((x) => reads.add(x));
      return { run: (...a: any[]) => st.run(...a), get: (...a: any[]) => (mark(), st.get(...a)), all: (...a: any[]) => (mark(), st.all(...a)), iterate: (...a: any[]) => (mark(), st.iterate(...a)) };
    },
    close: () => raw.close(),
  };
  // seeded before the plugin loads, as the land-prs harnesses do (made-up data)
  const clock = { t: Date.now() - 3 * 3_600_000 };
  // its writes are named as the server names its own (core/write-log.ts): a change made here, which the fake bb can't
  // cause (a PR reading), still has the notice the server would send for it (seedNotice)
  const seedTables = new ChangeTables(KNOWN_TABLES);
  const seedEngine = new Engine(recordWrites(raw as never, (t) => seedTables.wrote(t)) as never, { now: () => clock.t, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: (t?: readonly string[]) => seedTables.call(t), log: () => {}, files: () => ({ dir: join(root, "state", "deliverables"), kept: join(root, "state", "threads") }) } as never, { batchInbox: opts.batchInbox ?? false, owner: "Robin" });
  const seeded = seedBusy(seedEngine, (ms) => (clock.t += ms), proof);
  const sdkCalls: string[] = [];
  const warnings: string[] = [];
  const prompts = new Map<string, unknown[]>();
  const slowThreads = new Set<string>(); // bb takes 600 ms to answer for these
  const threads = {
    get: async ({ threadId }: { threadId: string }) => (sdkCalls.push(`get:${threadId}`), await (slowThreads.has(threadId) ? new Promise((r) => setTimeout(r, 600)) : tick()), { id: threadId, title: `Made-up ${threadId}`, status: "idle", providerId: "claude", environment: { branchName: "main" } }),
    context: async ({ threadId }: { threadId: string }) => (sdkCalls.push(`context:${threadId}`), await tick(), { usage: { usedTokens: 1_000, modelContextWindow: 200_000, snapshot: { model: "made-up" } } }),
    interactions: {
      list: async ({ threadId }: { threadId: string }) => (sdkCalls.push(`interactions:${threadId}`), await tick(), [...(prompts.get(threadId) ?? [])]),
      get: async ({ threadId, interactionId }: { threadId: string; interactionId: string }) => {
        const r = (prompts.get(threadId) ?? []).find((x: any) => x.id === interactionId);
        if (!r) throw new Error("gone");
        return r;
      },
      resolve: async ({ threadId, interactionId }: { threadId: string; interactionId: string }) => void prompts.set(threadId, (prompts.get(threadId) ?? []).filter((x: any) => x.id !== interactionId)),
    },
    send: async () => ({ delivery: "sent" }),
    updatePluginMetadata: async () => ({}),
    list: async () => ({ threads: [] }),
  };
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : noop), apply: () => noop });
  // bb's other SDK areas are absent: a startup job that reaches for one fails and logs, as with a bb that lacks it
  const sdk: any = { threads };
  let handlers: Record<string, Handler> = {};
  const events = new Map<string, (p: any) => unknown>();
  const routes = new Map<string, (c: any) => Promise<any>>();
  const services = new Map<string, { start: (s: AbortSignal) => Promise<void> }>();
  const notices: unknown[] = [];
  const settingsChange: ((v: any) => void)[] = [];
  let settingsValues: any = {};
  const bb: any = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "pluginId") return "orchestrator";
        if (k === "settings")
          return {
            define: (schema: Record<string, { default: unknown }>) => {
              const v: any = Object.fromEntries(Object.entries(schema).map(([key, d]) => [key, d.default]));
              Object.assign(v, { stateDir: join(root, "state"), projectsDir: projects, memoryConfig: "", diskPath: root, ownerName: "Robin", batchInbox: opts.batchInbox ?? false });
              if ("ownerName" in schema) settingsValues = v;
              return { get: async () => v, onChange: (f: (v: any) => void) => settingsChange.push(f), values: v };
            },
          };
        if (k === "storage") return { database: () => db, kv: noop };
        if (k === "rpc") return { register: (_c: unknown, h: Record<string, Handler>) => void (handlers = { ...handlers, ...h }), experimental_invalidate: () => {}, experimental_invalidateAll: () => {}, experimental_whileWatched: () => {} };
        if (k === "events") return { on: (n: string, f: (p: any) => unknown) => events.set(n, f) };
        if (k === "http") return { route: (m: string, p: string, f: (c: any) => Promise<any>) => routes.set(`${m} ${p}`, f), experimental_websocket: () => {} };
        if (k === "realtime") return { publish: (ch: string, p: unknown) => ch === "changed" && notices.push(p), subscribe: noop };
        if (k === "background") return { service: (n: string, s: { start: (s: AbortSignal) => Promise<void> }) => services.set(n, s) };
        if (k === "sdk") return sdk;
        if (k === "log") return { info: () => {}, warn: (m: string) => void warnings.push(m), error: () => {}, debug: () => {} };
        return noop;
      },
    },
  );
  await plugin(bb);
  const stop = new AbortController();
  const announce = async () => {
    void services.get("memory")!.start(stop.signal);
    await settle();
    // the first flush delivers the seeded mail still waiting: let it finish, so each change below is measured alone
    events.get("thread.active")!({ thread: { id: "thr_busy_cos" } });
    await calm(); // a flush announces only when it is done
    await quiet();
    notices.length = 0;
  };
  /** Until bb was asked nothing for 300 ms. */
  const calm = async () => {
    let n = -1;
    while (n !== sdkCalls.length) {
      n = sdkCalls.length;
      await settle(300);
    }
  };
  /** Until no notice came for 400 ms: the change's flush and its mail are done. */
  const quiet = async () => {
    let n = -1;
    while (n !== notices.length) {
      n = notices.length;
      await settle(400);
    }
  };
  const read = (m: string, input: unknown = null) => Promise.resolve((handlers[m] as Handler)(input, { experimental_caller: { kind: "client" }, experimental_signal: new AbortController().signal }));
  /** A POST to one of the screens' write routes, from the app's own origin. */
  const post = async (path: string, body: unknown) => {
    const c = {
      req: { url: "http://127.0.0.1:1/x", header: (h: string) => (h === "origin" ? "http://127.0.0.1:1" : h === "sec-fetch-site" ? "same-origin" : undefined), json: async () => body },
      json: (o: unknown, status = 200) => ({ o, status }),
    };
    const r = await routes.get(`POST ${path}`)!(c);
    assert.equal(r.status, 200, JSON.stringify(r.o));
    return r.o;
  };
  const seedNotice = () => ({ tables: seedTables.take() });
  seedNotice();
  return { raw, reads, seeded, seedEngine, seedNotice, sdkCalls, warnings, slowThreads, prompts, read, events, post, notices, announce, quiet, calm, stop, settingsChange, settingsValues: () => settingsValues };
}

const INPUTS: Record<ChangeRead, unknown> = {
  config: null,
  needsYou: { zone: "UTC" },
  board: null,
  projects: null,
  agents: null,
  scope: null,
  deliverables: null,
  deliverable: null, // its id is the seed's (inputOf)
  deliverableIndex: null,
  outputs: null,
  projectOrder: null,
  deliverableFolders: null,
  directHistory: { slug: "kite-app" },
  projectBook: { slug: "kite-app" },
  projectHistory: { slug: "kite-app" },
  feed: { cursor: null, filter: "all" },
  workBoard: { since: 0, project: null }, // a fixed T: the default (now less 7 days) moves with the clock
  boardSince: { since: 0, project: null },
};

/** A read's input: the one card read whole is the seed's deliverable with a PR and a next move (its PR's state shows). */
const inputOf = (h: { raw: unknown }, m: ChangeRead) =>
  m === "deliverable" ? { id: ((h.raw as { prepare: (q: string) => { get: (t: string) => unknown } }).prepare("SELECT id FROM deliverables WHERE title = ?").get("Made-up deliverable with a next move") as { id: string }).id } : INPUTS[m];

for (const batchInbox of [false, true])
test(`every read reads only the tables its READS entry declares${batchInbox ? " (batched inbox on)" : ""}`, async () => {
  const h = await host({ batchInbox });
  const missing: string[] = [];
  for (const m of Object.keys(READS) as ChangeRead[]) {
    const declared = READS[m];
    if (!declared) continue; // refetched on every change
    h.reads.clear();
    await h.read(m, inputOf(h, m));
    // sqlite_master is the schema (the board checks task_prs is there): no write names it, a schema change refetches all
    for (const t of h.reads) if (t !== "sqlite_master" && !(declared as readonly string[]).includes(t)) missing.push(`${m} reads ${t}`);
  }
  h.stop.abort();
  assert.deepEqual(missing, [], "add each to change-notice.ts READS, or the screen misses that change");
});

/** What the screen shows: the read's answer, without the clock it was read at (and Needs you's presets, from the clock). */
const shownOf = (h: Awaited<ReturnType<typeof host>>, m: ChangeRead) => h.read(m, inputOf(h, m)).then((o) => JSON.stringify(o, (k, v) => (k === "now" || k === "presets" ? undefined : v)));

test("a read whose answer shows a thread's status declares STATUS, or LIVE when it shows only archived or not", async () => {
  const h = await host();
  const { cos, leads, threads } = h.seeded;
  // every status a thread can have, on the CoS, a lead and its threads; "stopped" is left only by "active" or "archived".
  // Archived last, and not on the threads: archiving a thread retires its role (a change of "agents", which these declare).
  const who = [cos, leads[0]!, ...threads.filter((t) => t.project === "kite-app")];
  const steps: [string, boolean][] = [["active", false], ["error", false], ["idle", false], ["active", false], ["stopped", false], ["active", false], ["idle", false]];
  const undeclared: string[] = [];
  for (const m of Object.keys(READS) as ChangeRead[]) {
    const declared = READS[m] as readonly string[] | null;
    if (!declared || declared.includes(STATUS)) continue;
    for (const a of who) h.seedEngine.setStatus(a.threadId, "idle");
    let before = await shownOf(h, m);
    assert.equal(await shownOf(h, m), before, `${m} reads the same twice with no change`);
    for (const [to] of steps) {
      for (const a of who) h.seedEngine.setStatus(a.threadId, to);
      const now = await shownOf(h, m);
      if (now !== before) undeclared.push(`${m} shows ${to}`);
      before = now;
    }
    // into archived and out again: only a read that declares LIVE may show it
    for (const to of ["archived", "active"]) {
      for (const a of [cos, leads[0]!]) h.seedEngine.setStatus(a.threadId, to);
      const now = await shownOf(h, m);
      if (now !== before && !declared.includes(LIVE)) undeclared.push(`${m} shows ${to}`);
      before = now;
    }
  }
  h.stop.abort();
  assert.deepEqual(undeclared, [], "these show a status: declare STATUS (or LIVE) in change-notice.ts READS");
});

test("a second agents read asks bb nothing; bb's news of one thread re-reads only that thread", async () => {
  const h = await host();
  await h.announce();
  await h.calm();
  h.sdkCalls.length = 0;
  const live = (await h.read("agents")) as unknown[];
  assert.ok(live.length >= 30, `${live.length} agents`);
  assert.equal(h.sdkCalls.length, 2 * live.length, "the first read: each thread and its context");
  h.sdkCalls.length = 0;
  await h.read("agents");
  assert.deepEqual(h.sdkCalls, [], "kept: no bb call");
  const t = h.seeded.threads[3]!.threadId;
  for (const ev of ["thread.active", "thread.idle", "thread.failed", "thread.unarchived", "thread.deleted", "experimental_thread.read"]) {
    await h.events.get(ev)!({ thread: { id: t }, lastAssistantText: "", error: null });
    await h.calm(); // the event's own flush (mail to the lead) asks bb itself, uncached: not the read's
    h.sdkCalls.length = 0;
    await h.read("agents");
    assert.deepEqual(h.sdkCalls.sort(), [`context:${t}`, `get:${t}`], `after ${ev}`);
  }
  // archived in bb: its role retires, so the read no longer lists it (and asks bb nothing of it)
  await h.events.get("thread.archived")!({ thread: { id: t } });
  await h.calm();
  h.sdkCalls.length = 0;
  const left = (await h.read("agents")) as { threadId: string }[];
  assert.ok(!left.some((a) => a.threadId === t));
  assert.deepEqual(h.sdkCalls, []);
  h.stop.abort();
});

test("a new prompt shows on Needs you at once, and the owner's answer takes it off at once", async () => {
  const h = await host();
  const t = h.seeded.threads[5]!.threadId;
  await h.read("needsYou", { zone: "UTC" });
  h.sdkCalls.length = 0;
  assert.deepEqual(((await h.read("needsYou", { zone: "UTC" })) as { interactions: unknown[] }).interactions, []);
  assert.deepEqual(h.sdkCalls, [], "a second read within the TTL asks bb nothing");
  const ask = { id: "ix-1", status: "pending", kind: "user_question", createdAt: Date.now(), payload: { kind: "user_question", questions: [{ id: "q1", prompt: "Made-up: which one?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] }] } };
  h.prompts.set(t, [ask]);
  await h.events.get("interaction.pending")!({ thread: { id: t }, interaction: ask });
  const shown = ((await h.read("needsYou", { zone: "UTC" })) as { interactions: { id: string }[] }).interactions;
  assert.deepEqual(shown.map((i) => i.id), ["ix-1"]);
  await h.post(WRITES.interactionAnswer, { threadId: t, interactionId: "ix-1", answers: { q1: { selected: ["a"] } } });
  // the app refetches right after its write: a kept "pending" here would bring the card back
  assert.deepEqual(((await h.read("needsYou", { zone: "UTC" })) as { interactions: unknown[] }).interactions, []);
  h.stop.abort();
});

test("a lead's prompt answered in bb itself leaves the feed: Needs you's read tells the feed", async () => {
  const h = await host();
  await h.announce();
  const lead = h.seeded.leads[1]!.threadId;
  const ask = { id: "ix-feed", status: "pending", kind: "prompt", createdAt: Date.now(), payload: { kind: "prompt" } };
  h.prompts.set(lead, [ask]);
  await h.events.get("interaction.pending")!({ thread: { id: lead }, interaction: ask });
  await h.read("needsYou", { zone: "UTC" });
  await h.quiet();
  assert.ok(JSON.stringify(await h.read("feed", INPUTS.feed)).includes("ix-feed"), "the lead's prompt is on the feed");
  h.notices.length = 0;
  // answered in bb's own thread view: bb sends no event for that, only the thread's turn going on (a status flip)
  h.prompts.set(lead, []);
  await h.events.get("thread.active")!({ thread: { id: lead } });
  await h.calm();
  await h.quiet();
  const flip = h.notices.at(-1) as { tables: string[] };
  assert.ok(touches(flip, "needsYou") && !touches(flip, "feed"), JSON.stringify(flip));
  h.notices.length = 0;
  await h.read("needsYou", { zone: "UTC" }); // the page's refetch on that notice
  await h.quiet();
  assert.ok(h.notices.some((n) => touches(n, "feed")), `a notice the feed refetches on: ${JSON.stringify(h.notices)}`);
  assert.ok(!JSON.stringify(await h.read("feed", INPUTS.feed)).includes("ix-feed"), "gone from the feed");
  h.notices.length = 0;
  await h.read("needsYou", { zone: "UTC" }); // the refetch that notice causes: the same prompts, no further notice
  await h.quiet();
  assert.deepEqual(h.notices, []);
  h.stop.abort();
});

test("concurrent reads of the same RPC wait on one computation: one bb call per thread", async () => {
  const h = await host();
  const [a, b, c] = await Promise.all([h.read("agents"), h.read("agents"), h.read("agents")]);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.equal(h.sdkCalls.length, 2 * (a as unknown[]).length);
  h.sdkCalls.length = 0;
  await Promise.all([h.read("needsYou", { zone: "UTC" }), h.read("needsYou", { zone: "UTC" })]);
  assert.equal(h.sdkCalls.filter((x) => x.startsWith("interactions:")).length, (a as unknown[]).length);
  h.stop.abort();
});

/** The reads a notice refetches, by name. */
const touched = (n: unknown) => (Object.keys(READS) as ChangeRead[]).filter((m) => touches(n, m));

test("the notice after each change refetches the reads that show it, and not the others", async () => {
  const h = await host();
  await h.announce();
  const last = () => h.notices.at(-1) as { tables: string[] | null };
  const t = h.seeded.threads[7]!;

  // a status flip: the screens with a status, not the deliverables, the feed or the config
  await h.events.get("thread.active")!({ thread: { id: t.threadId } });
  await h.calm();
  await h.quiet();
  assert.deepEqual(last().tables, [STATUS]);
  for (const m of ["board", "projects", "agents", "scope", "projectHistory", "needsYou"] as ChangeRead[]) assert.ok(touches(last(), m), `${m} shows a status`);
  for (const m of ["deliverables", "config", "projectOrder", "feed", "directHistory"] as ChangeRead[]) assert.ok(!touches(last(), m), `${m} shows no status`);

  // its turn ends: its lead is told (mail), so the feed refetches too
  await h.events.get("thread.idle")!({ thread: { id: t.threadId }, lastAssistantText: "Made-up: done" });
  await h.quiet();
  assert.ok(touches(last(), "feed"));
  assert.ok(touches(last(), "deliverables"), "mail can be a next move's outcome, which Delivered shows");
  assert.ok(!touches(last(), "config"));

  // the owner answers a card: it leaves Needs you, and the screens that list cards refetch
  const card = h.seeded.open[0]!;
  h.notices.length = 0;
  await h.post(WRITES.answer, { id: card.id, rev: card.rev, option: card.ask!.options[0]!.id, text: null, via: "desktop" });
  await h.quiet();
  assert.ok(touches(last(), "needsYou") && touches(last(), "feed") && touches(last(), "board"), JSON.stringify(last()));
  // the write's notice, then its flush's: neither may say "everything" (that refetched every read twice per answer)
  assert.ok(h.notices.every((n: any) => Array.isArray(n.tables)), JSON.stringify(h.notices));
  assert.ok(!touches(last(), "config") && !touches(last(), "projectOrder"), JSON.stringify(h.notices));
  const open = ((await h.read("needsYou", { zone: "UTC" })) as { cards: { id: string }[] }).cards.map((c) => c.id);
  assert.ok(!open.includes(card.id), "answered: off Needs you");

  // the owner approves a deliverable: Delivered refetches
  const d = h.seeded.delivered[0]!;
  h.notices.length = 0;
  await h.post(WRITES.approve, { id: d.id, rev: d.rev, note: null });
  await h.quiet();
  assert.ok(touches(last(), "deliverables"), JSON.stringify(last()));
  assert.ok(h.notices.every((n: any) => Array.isArray(n.tables) && !n.tables.includes("*")), JSON.stringify(h.notices));

  // a prompt in bb: Needs you, and the feed that shows the leads' prompts
  h.notices.length = 0;
  await h.events.get("interaction.pending")!({ thread: { id: t.threadId }, interaction: { id: "ix-2" } });
  await h.quiet();
  assert.ok(last().tables!.includes(BB));
  assert.ok(touches(last(), "needsYou") && touches(last(), "feed") && !touches(last(), "config"));

  // a settings save can't be named: everything
  h.notices.length = 0;
  for (const f of h.settingsChange) f({ ...h.settingsValues(), cosTitle: "Made-up title" });
  await settle();
  assert.equal(last().tables, null);
  assert.deepEqual(touched(last()), Object.keys(READS));
  h.stop.abort();
});

test("the since lens refetches on a move and on a PR linked to a task, and not on a thread's status or a rule", async (tc) => {
  // the strip counts moves and tasked merges: a card moved must show in its counts from the move's own notice, and the
  // thousands of status flips a weekend brings must not refetch it
  const h = await host();
  tc.after(() => h.stop.abort());
  await h.announce();
  const board = (await h.read("workBoard", INPUTS.workBoard)) as { projects: { tasks: { id: string; column: string; state: string }[] }[] };
  const t = board.projects.flatMap((p) => p.tasks).find((x) => x.state === "open" && x.column !== "blocked")!;
  h.notices.length = 0;
  await h.post(WRITES.boardMove, { task: t.id, to: "blocked" });
  await h.quiet();
  assert.ok(h.notices.some((n) => touches(n, "boardSince")), JSON.stringify(h.notices));
  const st = (await h.read("boardSince", INPUTS.boardSince)) as { moved: Record<string, { to: string }> };
  assert.equal(st.moved[t.id]?.to, "blocked", "the refetched strip shows the move");
  // a PR linked to a task: its notice names task_prs, which the lens reads (its tasked merges)
  assert.ok(touches({ tables: ["task_prs"] }, "boardSince"));
  // a rule added, and a thread's status flips: neither is in the strip
  h.notices.length = 0;
  await h.post(WRITES.ruleAdd, { text: "Made-up rule", project: null, kinds: ["question"], expiresInDays: null, source: "test" });
  await h.quiet();
  assert.ok(h.notices.length > 0 && !h.notices.some((n) => touches(n, "boardSince")), JSON.stringify(h.notices));
  assert.ok(!touches({ tables: [STATUS] }, "boardSince") && !touches({ tables: [STATUS, LIVE] }, "boardSince"));
});

test("a card moved on the work board refetches the board; a write it doesn't show leaves the board alone", async (tc) => {
  // the owner moves a card: the board must show it where it was put, at once, from the move's own notice
  const h = await host();
  tc.after(() => h.stop.abort()); // a failed check must not leave the services running
  await h.announce();
  const last = () => h.notices.at(-1) as { tables: string[] | null };
  const board = (await h.read("workBoard", INPUTS.workBoard)) as { projects: { tasks: { id: string; column: string; state: string }[] }[] };
  const t = board.projects.flatMap((p) => p.tasks).find((x) => x.state === "open" && x.column !== "blocked")!;
  h.notices.length = 0;
  await h.post(WRITES.boardMove, { task: t.id, to: "blocked" });
  await h.quiet();
  assert.ok(h.notices.some((n: any) => Array.isArray(n.tables) && n.tables.includes("tasks")), JSON.stringify(h.notices));
  assert.ok(touches(last(), "workBoard"), JSON.stringify(last()));
  const moved = ((await h.read("workBoard", INPUTS.workBoard)) as typeof board).projects.flatMap((p) => p.tasks).find((x) => x.id === t.id)!;
  assert.equal(moved.column, "blocked", "the refetched board shows the move");
  // a rule added: the main board shows rules, the work board doesn't, so it stays put
  h.notices.length = 0;
  await h.post(WRITES.ruleAdd, { text: "Made-up rule", project: null, kinds: ["question"], expiresInDays: null, source: "test" });
  await h.quiet();
  assert.ok(h.notices.length > 0 && h.notices.every((n: any) => Array.isArray(n.tables)), JSON.stringify(h.notices));
  assert.ok(h.notices.some((n) => touches(n, "board")), "the rule shows on the main board");
  assert.ok(!h.notices.some((n) => touches(n, "workBoard")), JSON.stringify(h.notices));
});

test("each change's notice touches every read whose answer it changed", async (tc) => {
  const h = await host();
  tc.after(() => h.stop.abort()); // a failed check must not leave the services running
  await h.announce();
  const reads = (Object.keys(READS) as ChangeRead[]).filter((m) => READS[m]);
  // one after another, in READS order: the feed shows the prompts the last needsYou read found. A time from this run (an
  // open segment ends now) is only the clock: the seed's own times are hours older.
  const since = Date.now() - 1_000;
  const clockFree = (k: string, v: unknown) => (k === "now" || k === "presets" ? undefined : typeof v === "number" && v >= since && v < since + 3_600_000 ? "t" : v);
  const snap = async () => {
    const out = {} as Record<ChangeRead, string>;
    for (const m of reads) out[m] = JSON.stringify(await h.read(m, inputOf(h, m)), clockFree);
    return out;
  };
  const first = await snap();
  await h.quiet();
  const again = await snap();
  for (const m of reads) assert.equal(again[m], first[m], `${m} reads the same twice with no change`);
  const missed: string[] = [];
  /** Makes a change; every read whose answer it changed must be touched by a notice it caused. Returns those reads. */
  const change = async (what: string, run: () => unknown) => {
    const before = await snap();
    await h.quiet();
    h.notices.length = 0;
    h.seedNotice();
    await run();
    await h.calm();
    await h.quiet();
    const notices = [...h.notices, h.seedNotice()];
    const after = await snap();
    const moved = reads.filter((m) => after[m] !== before[m]);
    for (const m of moved) if (!notices.some((n) => touches(n, m))) missed.push(`${what}: ${m} changed, but no notice touched it (${JSON.stringify(notices)})`);
    return moved;
  };
  const { cos, leads, threads } = h.seeded;
  type Post = { line?: string | null; lineLive: boolean };
  const lineLive = async (address: string) => {
    const page = (await h.read("feed", INPUTS.feed)) as { posts: Post[] };
    const p = page.posts.find((x) => x.line === address);
    assert.ok(p, `a feed post on ${address}'s line`);
    return p.lineLive;
  };
  type CardPr = { checks: string | null };
  const cardChecks = async () => ((await h.read("needsYou", INPUTS.needsYou)) as { cards: { prs: CardPr[] }[] }).cards.flatMap((c) => c.prs).map((p) => p.checks);

  // a lead archived in bb: the feed stops offering a reply on its line; back when its thread runs again
  const lead = leads[2]!;
  assert.equal(await lineLive(lead.address), true);
  assert.ok((await change("lead archived", () => h.events.get("thread.archived")!({ thread: { id: lead.threadId } }))).includes("feed"));
  assert.equal(await lineLive(lead.address), false, "no reply to an archived lead");
  assert.ok((await change("lead back", () => h.events.get("thread.active")!({ thread: { id: lead.threadId } }))).includes("feed"));
  assert.equal(await lineLive(lead.address), true);
  await change("CoS archived", () => h.events.get("thread.archived")!({ thread: { id: cos.threadId } }));
  await change("CoS back", () => h.events.get("thread.active")!({ thread: { id: cos.threadId } }));

  // the checks of a PR a card is about fail: the card shows it (bb's reading comes from the open-PRs pass, which the fake
  // bb has none of: the seed engine records it, and its notice is the server's)
  assert.deepEqual(await cardChecks(), ["passing"]);
  assert.ok((await change("a card's PR fails its checks", () => h.seedEngine.prSeen(threads[10]!, "env-busy-10", pr(110, "open", "failing")))).includes("needsYou"));
  assert.deepEqual(await cardChecks(), ["failing"], "Needs you shows the PR's new checks");
  await change("a waited PR fails its checks in bb", () => h.seedEngine.prSeen(threads[5]!, "env-busy-5", pr(105, "open", "failing")));

  // a thread's other states
  const t = threads[8]!;
  await change("thread failed", () => h.events.get("thread.failed")!({ thread: { id: t.threadId }, error: { message: "Made-up failure" } }));
  await change("thread active", () => h.events.get("thread.active")!({ thread: { id: t.threadId } }));
  await change("thread idle", () => h.events.get("thread.idle")!({ thread: { id: t.threadId }, lastAssistantText: "Made-up: done" }));
  await change("thread archived", () => h.events.get("thread.archived")!({ thread: { id: threads[9]!.threadId } }));
  await change("XP", () => h.seedEngine.gainXp(threads[3]!.threadId, 50_000_000, 1));
  h.stop.abort();
  assert.deepEqual(missed, [], "add the table each names to that read's change-notice.ts READS entry");
});

test("a read slower than 500 ms logs one line, with the event loop's delay", async () => {
  const h = await host();
  await h.announce(); // the services run: the loop's delay is sampled
  await h.read("agents");
  assert.deepEqual(h.warnings.filter((w) => w.startsWith("slow read")), [], "a fast read logs nothing");
  const t = h.seeded.threads[4]!.threadId;
  h.slowThreads.add(t);
  await h.events.get("thread.active")!({ thread: { id: t } }); // bb's news: the next read asks bb again
  await h.read("agents");
  const slow = h.warnings.filter((w) => w.startsWith("slow read"));
  h.stop.abort();
  assert.equal(slow.length, 1, JSON.stringify(slow));
  assert.match(slow[0]!, /^slow read agents: \d+ ms \(event loop delay since the last slow read: p99 \d+ ms, max \d+ ms\)$/);
});

test("which change refetches which read", () => {
  // what each listener refetches for a notice naming one table (an older server's notice, {}, refetches all)
  const reads = (...names: string[]) => Object.keys(READS).filter((m) => names.includes(m) || READS[m as ChangeRead] === null);
  assert.deepEqual(touched({}), Object.keys(READS));
  assert.deepEqual(touched({ tables: null }), Object.keys(READS));
  // outputs, deliverableFolders and projectBook read the disk too: every notice
  assert.deepEqual(touched({ tables: [] }), ["outputs", "deliverableFolders", "projectBook"]);
  assert.deepEqual(touched({ tables: [STATUS] }), reads("needsYou", "board", "projects", "agents", "scope", "projectHistory", "workBoard"));
  assert.deepEqual(touched({ tables: ["deliverables"] }), reads("projects", "scope", "deliverables", "deliverable", "deliverableIndex", "feed", "workBoard", "boardSince"));
  // only a deliverable written changes the index of every card's revisions (Delivered's search and Files)
  assert.deepEqual(touched({ tables: ["decisions"] }), reads("needsYou", "board", "projects", "scope", "projectHistory", "feed", "workBoard"));
  assert.deepEqual(touched({ tables: [BB] }), reads("needsYou", "agents", "scope", "feed"));
  // mail: a lead's ack of a next move shows on Delivered; Needs you shows no mail
  assert.deepEqual(touched({ tables: ["items"] }), reads("board", "projects", "deliverables", "deliverable", "directHistory", "projectHistory", "feed"));
  // a PR's reading: the cards about it, a wait's PR, the sidebar's and a project's PRs, PR proof
  assert.deepEqual(touched({ tables: ["prs"] }), reads("needsYou", "board", "projects", "agents", "scope", "deliverables", "deliverable", "projectHistory", "workBoard"));
  // the work board's own tables: a hand move (tasks, with its task_moves log) or a PR linked to a task refetches only
  // the board and its since lens (which counts the move log and the tasked merges); the log alone, only the lens
  assert.deepEqual(touched({ tables: ["tasks", "task_moves"] }), reads("workBoard", "boardSince"));
  assert.deepEqual(touched({ tables: ["task_prs"] }), reads("workBoard", "boardSince"));
  assert.deepEqual(touched({ tables: ["task_moves"] }), reads("boardSince"));
  // an agent archived or back: besides the status flip's reads, the feed's reply line and Delivered's lead persona
  assert.deepEqual(touched({ tables: [STATUS, LIVE] }), reads("needsYou", "board", "projects", "agents", "scope", "deliverables", "deliverable", "projectHistory", "feed", "workBoard"));
});
