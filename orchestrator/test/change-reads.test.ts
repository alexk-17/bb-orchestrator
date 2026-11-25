import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../server.ts";
import { Engine } from "../core/engine.ts";
import { BB, KNOWN_TABLES, LIVE, READS, STATUS, touches, type ChangeRead } from "../change-notice.ts";
import { statusParams } from "../core/status.ts";
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

const readTables = (sql: string) => [...sql.replace(/\s+/g, " ").matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi)].map((m) => m[1]!.toLowerCase());

type Handler = (input: unknown, ctx?: unknown) => unknown;

async function host(opts: { batchInbox?: boolean; kv?: unknown } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orch-reads-"));
  roots.push(root);
  const projects = join(root, "projects");
  mkdirSync(join(projects, "kite-app"), { recursive: true });
  writeFileSync(join(projects, "kite-app", "PROJECT.md"), "# kite-app\n");
  writeFileSync(join(projects, "kite-app", "project.json"), "{}");
  const proof = join(root, "proof.png");
  writeFileSync(proof, Buffer.from(PNG, "base64"));
  const raw = new DatabaseSync(join(root, "data.db"));
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF");
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
  const clock = { t: Date.now() - 3 * 3_600_000 };
  const seedTables = new ChangeTables(KNOWN_TABLES);
  const seedEngine = new Engine(recordWrites(raw as never, (t) => seedTables.wrote(t)) as never, { now: () => clock.t, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: (t?: readonly string[]) => seedTables.call(t), log: () => {}, files: () => ({ dir: join(root, "state", "deliverables"), kept: join(root, "state", "threads") }) } as never, { batchInbox: opts.batchInbox ?? false, owner: "Robin" });
  const seeded = seedBusy(seedEngine, (ms) => (clock.t += ms), proof);
  const sdkCalls: string[] = [];
  const warnings: string[] = [];
  const prompts = new Map<string, unknown[]>();
  const slowThreads = new Set<string>();
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
  const sdk: any = { threads };
  let handlers: Record<string, Handler> = {};
  const events = new Map<string, (p: any) => unknown>();
  const routes = new Map<string, (c: any) => Promise<any>>();
  const services = new Map<string, { start: (s: AbortSignal) => Promise<void> }>();
  const notices: unknown[] = [];
  const tools = new Map<string, any>();
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
        if (k === "storage") return { database: () => db, kv: opts.kv ?? noop };
        if (k === "rpc") return { register: (_c: unknown, h: Record<string, Handler>) => void (handlers = { ...handlers, ...h }), experimental_invalidate: () => {}, experimental_invalidateAll: () => {}, experimental_whileWatched: () => {} };
        if (k === "events") return { on: (n: string, f: (p: any) => unknown) => events.set(n, f) };
        if (k === "http") return { route: (m: string, p: string, f: (c: any) => Promise<any>) => routes.set(`${m} ${p}`, f), experimental_websocket: () => {} };
        if (k === "realtime") return { publish: (ch: string, p: unknown) => ch === "changed" && notices.push(p), subscribe: noop };
        if (k === "background") return { service: (n: string, s: { start: (s: AbortSignal) => Promise<void> }) => services.set(n, s) };
        if (k === "sdk") return sdk;
        if (k === "agents") return new Proxy({ registerTool: (t: { name: string }) => void tools.set(t.name, t) }, { get: (a: any, n) => a[n] ?? noop });
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
    events.get("thread.active")!({ thread: { id: "thr_busy_cos" } });
    await calm();
    await quiet();
    notices.length = 0;
  };
  const calm = async () => {
    let n = -1;
    while (n !== sdkCalls.length) {
      n = sdkCalls.length;
      await settle(300);
    }
  };
  const quiet = async () => {
    let n = -1;
    while (n !== notices.length) {
      n = notices.length;
      await settle(400);
    }
  };
  const read = (m: string, input: unknown = null) => Promise.resolve((handlers[m] as Handler)(input, { experimental_caller: { kind: "client" }, experimental_signal: new AbortController().signal }));
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
  const tool = async (name: string, raw: unknown, threadId: string) => {
    const t = tools.get(name)!;
    const r = await t.execute(t.parameters.parse(raw), { threadId });
    return { ok: !r.isError, text: r.content[0]!.text as string };
  };
  return { raw, reads, seeded, seedEngine, seedNotice, sdkCalls, warnings, slowThreads, prompts, read, events, post, tool, notices, announce, quiet, calm, stop, settingsChange, settingsValues: () => settingsValues };
}

const INPUTS: Record<ChangeRead, unknown> = {
  config: null,
  needsYou: { zone: "UTC" },
  board: null,
  projects: null,
  agents: null,
  scope: null,
  deliverables: null,
  deliverable: null,
  deliverableIndex: null,
  outputs: null,
  projectOrder: null,
  deliverableFolders: null,
  directHistory: { slug: "kite-app" },
  projectBook: { slug: "kite-app" },
  projectHistory: { slug: "kite-app" },
  feed: { cursor: null, filter: "all" },
  workBoard: { since: 0, project: null },
  boardSince: { since: 0, project: null },
  viewPrefs: null,
};

const inputOf = (h: { raw: unknown }, m: ChangeRead) =>
  m === "deliverable" ? { id: ((h.raw as { prepare: (q: string) => { get: (t: string) => unknown } }).prepare("SELECT id FROM deliverables WHERE title = ?").get("Made-up deliverable with a next move") as { id: string }).id } : INPUTS[m];

for (const batchInbox of [false, true])
test(`every read reads only the tables its READS entry declares${batchInbox ? " (batched inbox on)" : ""}`, async () => {
  const h = await host({ batchInbox });
  const missing: string[] = [];
  for (const m of Object.keys(READS) as ChangeRead[]) {
    const declared = READS[m];
    if (!declared) continue;
    h.reads.clear();
    await h.read(m, inputOf(h, m));
    // sqlite_master is the schema: no write names it, a schema change refetches all
    for (const t of h.reads) if (t !== "sqlite_master" && !(declared as readonly string[]).includes(t)) missing.push(`${m} reads ${t}`);
  }
  h.stop.abort();
  assert.deepEqual(missing, [], "add each to change-notice.ts READS, or the screen misses that change");
});

const shownOf = (h: Awaited<ReturnType<typeof host>>, m: ChangeRead) => h.read(m, inputOf(h, m)).then((o) => JSON.stringify(o, (k, v) => (k === "now" || k === "presets" ? undefined : v)));

test("a read whose answer shows a thread's status declares STATUS, or LIVE when it shows only archived or not", async () => {
  const h = await host();
  const { cos, leads, threads } = h.seeded;
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
    await h.calm();
    h.sdkCalls.length = 0;
    await h.read("agents");
    assert.deepEqual(h.sdkCalls.sort(), [`context:${t}`, `get:${t}`], `after ${ev}`);
  }
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
  h.prompts.set(lead, []);
  await h.events.get("thread.active")!({ thread: { id: lead } });
  await h.calm();
  await h.quiet();
  const flip = h.notices.at(-1) as { tables: string[] };
  assert.ok(touches(flip, "needsYou") && !touches(flip, "feed"), JSON.stringify(flip));
  h.notices.length = 0;
  await h.read("needsYou", { zone: "UTC" });
  await h.quiet();
  assert.ok(h.notices.some((n) => touches(n, "feed")), `a notice the feed refetches on: ${JSON.stringify(h.notices)}`);
  assert.ok(!JSON.stringify(await h.read("feed", INPUTS.feed)).includes("ix-feed"), "gone from the feed");
  h.notices.length = 0;
  await h.read("needsYou", { zone: "UTC" });
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

const touched = (n: unknown) => (Object.keys(READS) as ChangeRead[]).filter((m) => touches(n, m));

test("the notice after each change refetches the reads that show it, and not the others", async () => {
  const h = await host();
  await h.announce();
  const last = () => h.notices.at(-1) as { tables: string[] | null };
  const t = h.seeded.threads[7]!;

  await h.events.get("thread.active")!({ thread: { id: t.threadId } });
  await h.calm();
  await h.quiet();
  assert.deepEqual(last().tables, [STATUS]);
  for (const m of ["board", "projects", "agents", "scope", "projectHistory", "needsYou"] as ChangeRead[]) assert.ok(touches(last(), m), `${m} shows a status`);
  for (const m of ["deliverables", "config", "projectOrder", "feed", "directHistory"] as ChangeRead[]) assert.ok(!touches(last(), m), `${m} shows no status`);

  await h.events.get("thread.idle")!({ thread: { id: t.threadId }, lastAssistantText: "Made-up: done" });
  await h.quiet();
  assert.ok(touches(last(), "feed"));
  assert.ok(touches(last(), "deliverables"), "mail can be a next move's outcome, which Delivered shows");
  assert.ok(!touches(last(), "config"));

  const card = h.seeded.open[0]!;
  h.notices.length = 0;
  await h.post(WRITES.answer, { id: card.id, rev: card.rev, option: card.ask!.options[0]!.id, text: null, via: "desktop" });
  await h.quiet();
  assert.ok(touches(last(), "needsYou") && touches(last(), "feed") && touches(last(), "board"), JSON.stringify(last()));
  assert.ok(h.notices.every((n: any) => Array.isArray(n.tables)), JSON.stringify(h.notices));
  assert.ok(!touches(last(), "config") && !touches(last(), "projectOrder"), JSON.stringify(h.notices));
  const open = ((await h.read("needsYou", { zone: "UTC" })) as { cards: { id: string }[] }).cards.map((c) => c.id);
  assert.ok(!open.includes(card.id), "answered: off Needs you");

  const d = h.seeded.delivered[0]!;
  h.notices.length = 0;
  await h.post(WRITES.approve, { id: d.id, rev: d.rev, note: null });
  await h.quiet();
  assert.ok(touches(last(), "deliverables"), JSON.stringify(last()));
  assert.ok(h.notices.every((n: any) => Array.isArray(n.tables) && !n.tables.includes("*")), JSON.stringify(h.notices));

  h.notices.length = 0;
  await h.events.get("interaction.pending")!({ thread: { id: t.threadId }, interaction: { id: "ix-2" } });
  await h.quiet();
  assert.ok(last().tables!.includes(BB));
  assert.ok(touches(last(), "needsYou") && touches(last(), "feed") && !touches(last(), "config"));

  h.notices.length = 0;
  for (const f of h.settingsChange) f({ ...h.settingsValues(), cosTitle: "Made-up title" });
  await settle();
  assert.equal(last().tables, null);
  assert.deepEqual(touched(last()), Object.keys(READS));
  h.stop.abort();
});

test("the since lens refetches on a move and on a PR linked to a task, and not on a thread's status or a rule", async (tc) => {
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
  assert.ok(touches({ tables: ["task_prs"] }, "boardSince"));
  h.notices.length = 0;
  await h.post(WRITES.ruleAdd, { text: "Made-up rule", project: null, kinds: ["question"], expiresInDays: null, source: "test" });
  await h.quiet();
  assert.ok(h.notices.length > 0 && !h.notices.some((n) => touches(n, "boardSince")), JSON.stringify(h.notices));
  assert.ok(!touches({ tables: [STATUS] }, "boardSince") && !touches({ tables: [STATUS, LIVE] }, "boardSince"));
});

test("a card moved on the work board refetches the board; a write it doesn't show leaves the board alone", async (tc) => {
  const h = await host();
  tc.after(() => h.stop.abort());
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
  h.notices.length = 0;
  await h.post(WRITES.ruleAdd, { text: "Made-up rule", project: null, kinds: ["question"], expiresInDays: null, source: "test" });
  await h.quiet();
  assert.ok(h.notices.length > 0 && h.notices.every((n: any) => Array.isArray(n.tables)), JSON.stringify(h.notices));
  assert.ok(h.notices.some((n) => touches(n, "board")), "the rule shows on the main board");
  assert.ok(!h.notices.some((n) => touches(n, "workBoard")), JSON.stringify(h.notices));
});

test("each CoS tidy refetches the work board and its since lens; a write neither shows leaves both alone", async (tc) => {
  const h = await host();
  tc.after(() => h.stop.abort());
  await h.announce();
  const th = h.seeded.threads[0]!;
  const project = th.project!;
  const lead = h.seeded.leads.find((l) => l.project === project)!;
  const publish = (titles: string[]) => h.seedEngine.publishStatus(lead, statusParams.parse({ goal: "Made-up goal", steps: titles.map((title, i) => ({ title, state: i === 0 ? "current" : "next" })) }));
  const [a, b, c] = publish(["Made-up keep", "Made-up twin", "Made-up spare"]).steps.map((x) => x.id!);
  await h.quiet();
  const both = async (what: string, args: Record<string, unknown>) => {
    h.notices.length = 0;
    const r = await h.tool("orch_board_tidy", args, "thr_busy_cos");
    assert.ok(r.ok, `${what}: ${r.text}`);
    await h.quiet();
    assert.ok(h.notices.some((n) => touches(n, "workBoard")), `${what} refetches the board: ${JSON.stringify(h.notices)}`);
    assert.ok(h.notices.some((n) => touches(n, "boardSince")), `${what} refetches the lens: ${JSON.stringify(h.notices)}`);
  };
  await both("file a PR no thread holds", { action: "file", kind: "pr", ref: "https://github.com/made-up/repo/pull/5", task: a });
  await both("merge", { action: "merge", task: b, into: a });
  await both("file a thread", { action: "file", kind: "thread", ref: th.address, task: c });
  publish(["Made-up keep"]);
  await h.quiet();
  await both("confirm", { action: "confirm", task: c });
  await both("restore", { action: "restore", task: c });
  h.notices.length = 0;
  await h.tool("orch_board_tidy", { action: "list" }, "thr_busy_cos");
  await h.quiet();
  assert.ok(!h.notices.some((n) => touches(n, "workBoard") || touches(n, "boardSince")), JSON.stringify(h.notices));
  h.notices.length = 0;
  await h.post(WRITES.ruleAdd, { text: "Made-up rule", project: null, kinds: ["question"], expiresInDays: null, source: "test" });
  await h.quiet();
  assert.ok(h.notices.length > 0 && !h.notices.some((n) => touches(n, "workBoard") || touches(n, "boardSince")), JSON.stringify(h.notices));
});

test("each change's notice touches every read whose answer it changed", async (tc) => {
  const h = await host();
  tc.after(() => h.stop.abort());
  await h.announce();
  const reads = (Object.keys(READS) as ChangeRead[]).filter((m) => READS[m]);
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

  const lead = leads[2]!;
  assert.equal(await lineLive(lead.address), true);
  assert.ok((await change("lead archived", () => h.events.get("thread.archived")!({ thread: { id: lead.threadId } }))).includes("feed"));
  assert.equal(await lineLive(lead.address), false, "no reply to an archived lead");
  assert.ok((await change("lead back", () => h.events.get("thread.active")!({ thread: { id: lead.threadId } }))).includes("feed"));
  assert.equal(await lineLive(lead.address), true);
  await change("CoS archived", () => h.events.get("thread.archived")!({ thread: { id: cos.threadId } }));
  await change("CoS back", () => h.events.get("thread.active")!({ thread: { id: cos.threadId } }));

  assert.deepEqual(await cardChecks(), ["passing"]);
  assert.ok((await change("a card's PR fails its checks", () => h.seedEngine.prSeen(threads[10]!, "env-busy-10", pr(110, "open", "failing")))).includes("needsYou"));
  assert.deepEqual(await cardChecks(), ["failing"], "Needs you shows the PR's new checks");
  await change("a waited PR fails its checks in bb", () => h.seedEngine.prSeen(threads[5]!, "env-busy-5", pr(105, "open", "failing")));

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
  await h.announce();
  await h.read("agents");
  assert.deepEqual(h.warnings.filter((w) => w.startsWith("slow read")), [], "a fast read logs nothing");
  const t = h.seeded.threads[4]!.threadId;
  h.slowThreads.add(t);
  await h.events.get("thread.active")!({ thread: { id: t } });
  await h.read("agents");
  const slow = h.warnings.filter((w) => w.startsWith("slow read"));
  h.stop.abort();
  assert.equal(slow.length, 1, JSON.stringify(slow));
  assert.match(slow[0]!, /^slow read agents: \d+ ms \(event loop delay since the last slow read: p99 \d+ ms, max \d+ ms\)$/);
});

test("which change refetches which read", () => {
  const reads = (...names: string[]) => Object.keys(READS).filter((m) => names.includes(m) || READS[m as ChangeRead] === null);
  assert.deepEqual(touched({}), Object.keys(READS));
  assert.deepEqual(touched({ tables: null }), Object.keys(READS));
  assert.deepEqual(touched({ tables: [] }), ["outputs", "deliverableFolders", "projectBook"]);
  assert.deepEqual(touched({ tables: [STATUS] }), reads("needsYou", "board", "projects", "agents", "scope", "projectHistory", "workBoard"));
  assert.deepEqual(touched({ tables: ["deliverables"] }), reads("projects", "scope", "deliverables", "deliverable", "deliverableIndex", "feed", "workBoard", "boardSince"));
  assert.deepEqual(touched({ tables: ["decisions"] }), reads("needsYou", "board", "projects", "scope", "projectHistory", "feed", "workBoard", "boardSince"));
  assert.deepEqual(touched({ tables: [BB] }), reads("needsYou", "agents", "scope", "feed"));
  assert.deepEqual(touched({ tables: ["items"] }), reads("board", "projects", "deliverables", "deliverable", "directHistory", "projectHistory", "feed"));
  assert.deepEqual(touched({ tables: ["prs"] }), reads("needsYou", "board", "projects", "agents", "scope", "deliverables", "deliverable", "projectHistory", "workBoard", "boardSince"));
  assert.deepEqual(touched({ tables: ["pr_readings"] }), reads("board", "workBoard", "boardSince"), "a PR read merged can ship a card off the board, and its count with it");
  assert.deepEqual(touched({ tables: ["tasks", "task_moves"] }), reads("workBoard", "boardSince"));
  assert.deepEqual(touched({ tables: ["task_prs"] }), reads("workBoard", "boardSince"));
  assert.deepEqual(touched({ tables: ["task_moves"] }), reads("boardSince"));
  assert.deepEqual(touched({ tables: [STATUS, LIVE] }), reads("needsYou", "board", "projects", "agents", "scope", "deliverables", "deliverable", "projectHistory", "feed", "workBoard"));
});

test("the viewer's pick of Board and a board's folds are kept by the plugin and read back after a restart, each save with the next revision", async () => {
  const kept = new Map<string, unknown>();
  const kv = { get: async (k: string) => kept.get(k) ?? null, set: async (k: string, v: unknown) => void kept.set(k, structuredClone(v)), delete: async (k: string) => void kept.delete(k) };
  const first = await host({ kv });
  try {
    assert.deepEqual(await first.read("viewPrefs"), { projectsView: null, boardFolds: {}, rev: 0 }, "a fresh install holds nothing: List, and Shipped folded");
    assert.deepEqual(await first.post(WRITES.viewPref, { projectsView: "board" }), { ok: true, result: { rev: 1 } }, "a save answers with its revision, so the page can tell a read holding it from one before it");
    await first.post(WRITES.viewPref, { board: "-", folded: [] });
    assert.deepEqual(await first.post(WRITES.viewPref, { board: "kite-app", folded: ["planned", "shipped"] }), { ok: true, result: { rev: 3 } });
    assert.deepEqual(await first.read("viewPrefs"), { projectsView: "board", boardFolds: { "-": [], "kite-app": ["planned", "shipped"] }, rev: 3 });
  } finally {
    first.stop.abort();
  }
  const again = await host({ kv });
  try {
    assert.deepEqual(await again.read("viewPrefs"), { projectsView: "board", boardFolds: { "-": [], "kite-app": ["planned", "shipped"] }, rev: 3 }, "the plugin started again (a reload, a new window): Board, Shipped open on all projects, kite-app's folds");
    assert.deepEqual(await again.post(WRITES.viewPref, { projectsView: "list" }), { ok: true, result: { rev: 4 } }, "the revision goes on across a restart");
    assert.deepEqual(await again.read("viewPrefs"), { projectsView: "list", boardFolds: { "-": [], "kite-app": ["planned", "shipped"] }, rev: 4 }, "a new pick changes the pick alone");
    kept.set("viewPrefs", { projectsView: "grid", boardFolds: { "-": ["blocked"] } });
    assert.deepEqual(await again.read("viewPrefs"), { projectsView: null, boardFolds: { "-": ["blocked"] }, rev: 0 }, "an unreadable field is no choice, the rest stands");
    kept.set("viewPrefs", "junk");
    assert.deepEqual(await again.read("viewPrefs"), { projectsView: null, boardFolds: {}, rev: 0 }, "something unreadable is no choice, never an error");
  } finally {
    again.stop.abort();
  }
});

test("saves of different choices at once all survive: the pick, and two boards' folds", async () => {
  const kept = new Map<string, unknown>();
  let failNext = false;
  const kv = {
    get: async (k: string) => {
      const v = structuredClone(kept.get(k) ?? null);
      await settle(20);
      return v;
    },
    set: async (k: string, v: unknown) => {
      if (failNext) {
        failNext = false;
        throw new Error("disk full");
      }
      kept.set(k, structuredClone(v));
    },
    delete: async (k: string) => void kept.delete(k),
  };
  const h = await host({ kv });
  try {
    await Promise.all([
      h.post(WRITES.viewPref, { projectsView: "board" }),
      h.post(WRITES.viewPref, { board: "-", folded: ["planned", "shipped"] }),
      h.post(WRITES.viewPref, { board: "kite-app", folded: ["blocked"] }),
    ]);
    assert.deepEqual(await h.read("viewPrefs"), { projectsView: "board", boardFolds: { "-": ["planned", "shipped"], "kite-app": ["blocked"] }, rev: 3 });
    failNext = true;
    const [failed, next] = await Promise.allSettled([h.post(WRITES.viewPref, { projectsView: "list" }), h.post(WRITES.viewPref, { board: "-", folded: [] })]);
    assert.equal(failed.status, "rejected", "the save that failed says so");
    assert.equal(next.status, "fulfilled", "the save after it still runs");
    assert.deepEqual(next.status === "fulfilled" && next.value, { ok: true, result: { rev: 4 } }, "a failed save takes no revision");
    assert.deepEqual(await h.read("viewPrefs"), { projectsView: "board", boardFolds: { "-": [], "kite-app": ["blocked"] }, rev: 4 });
  } finally {
    h.stop.abort();
  }
});
