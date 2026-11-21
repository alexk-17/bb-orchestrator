// The owner's scoping switches in the Projects view (1.13.0): direct actions with no card and no model step. Why each
// rule matters:
// - Start/End scoping from the UI must be orch_project_mode's own path: if it were a second copy, the lead could miss its
//   notice, the CoS its copy, the timeline its event, or open cards could stay stranded in the Scope pane when it ends;
// - a thread the owner switches to scoping must route like one orch_spawn_thread started with scope_task: the cards its
//   lead forwards from it go to the Scope tab under the task, or the owner gets its questions on Needs you as build work;
// - "Stop scoping" must give the normal route back and keep the task open (the lead plans it), or the owner loses a task
//   they never dropped, or keeps getting a thread's questions in the Scope tab;
// - the thread must hear it at the switch: it is told to investigate read-only, and that it no longer scopes once stopped,
//   or it goes on building (or stays read-only) against what the owner just set; the lead must hear which thread plans
//   which task, and the CoS gets a copy;
// - the owner's latest pick plans the task, even when another thread was started for it later, or the planner line would
//   name a thread the owner did not pick.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import plugin from "../server.ts";
import { Engine, SCOPING_TASK_NAME_MAX, type AskInput } from "../core/engine.ts";
import type { Agent } from "../core/model.ts";
import { MIGRATIONS } from "../core/db.ts";
import { WRITES, projectModeBody, scopeThreadBody, unscopeThreadBody, type Agents, type Projects, type Scope } from "../contract.ts";
import { pickableTasks, projectScopeAction, scopeActions, taskNameFor, tasksScoping, TASK_NAME_MAX } from "../app/kit.ts";

const q: AskInput = { title: "Which ranking signals?", question: "Use click-through as a ranking signal, or keep to the text match?", options: [{ label: "Click-through" }, { label: "Text match" }] };

// ---------------------------------------------------------------- the real plugin on a fake bb, the app's writes to its routes
// No /tmp: a scratch folder beside the tests (.scratch/ is git-ignored), removed afterwards.
const scratchRoot = join(import.meta.dirname, ".scratch");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "scoping-switches-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

type Tool = { name: string; execute: (p: unknown, ctx: { threadId: string }) => Promise<{ content: { text: string }[]; isError?: boolean }> };
type Route = (c: unknown) => Promise<Response>;
type Row = { recipient: string; sender: string; kind: string; ref: string | null; body: string };

/** A plan card the owner said go to: the lead files it, the CoS puts it to the owner, the owner picks its go option. */
function approvedPlan(e: Engine, cos: Agent, lead: Agent, threads: number): string {
  const d = e.ask(lead, { title: "Plan: scouts", question: "Start read-only scouts?", options: [{ label: "Go" }, { label: "Not now" }], kind: "plan", threads });
  e.triageAskPerson(cos, d.id, { question: "Start the scouts?", options: [{ label: "x" }, { label: "y" }], allowText: true });
  e.personAnswer(d.id, e.decision(d.id)!.rev, "1", null, "desktop");
  return d.id;
}

/** The CoS, two active projects (otter, kite) with live leads, and two otter threads: one a plan started, one no plan did. */
async function host() {
  const root = mkdtempSync(join(scratch, "h-"));
  const file = join(root, "data.db");
  const raw = new DatabaseSync(file);
  const pre = new Engine(raw as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { batchInbox: false });
  const cos = pre.register("T-cos", "cos", null);
  const lead = pre.register("T-lo", "lead", "otter");
  pre.register("T-lk", "lead", "kite");
  for (const t of ["T-lo", "T-lk"]) pre.setStatus(t, "idle");
  const plan = approvedPlan(pre, cos, lead, 1);
  pre.confirmSpawn(pre.reserveSpawn(lead, plan), "T-scout");
  const scout = pre.register("T-scout", "thread", "otter", "T-lo");
  const stray = pre.register("T-stray", "thread", "otter", "T-lo"); // no spawn row: no plan started it
  const sends: { threadId: string; text: string }[] = [];
  const titles: Record<string, string> = { "T-scout": "Scout · ranking signals" };
  const rpc: Record<string, (input: unknown) => Promise<unknown>> = {};
  const tools = new Map<string, Tool>();
  const routes = new Map<string, Route>();
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : noop), apply: () => noop });
  const sdk = {
    threads: {
      get: async ({ threadId }: { threadId: string }) => ({ id: threadId, title: titles[threadId] ?? null, archivedAt: null, status: "idle" }),
      context: async () => null,
      send: async ({ threadId, input }: { threadId: string; input: { text: string }[] }) => (sends.push({ threadId, text: input[0]!.text }), { delivery: "sent" }),
      interactions: { list: async () => [] },
    },
  };
  const bb: any = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "pluginId") return "orchestrator";
        if (k === "settings")
          return {
            define: (schema: Record<string, { default: unknown }>) => {
              const v: any = Object.fromEntries(Object.entries(schema).map(([key, d]) => [key, d.default]));
              Object.assign(v, { batchInbox: false, stateDir: join(root, "state"), projectsDir: join(root, "projects"), memoryConfig: "", prPollMinutes: 0, dreamsEnabled: false, cloudConfigPath: join(root, "no-cloud.json") });
              return { get: async () => v, onChange: () => {} };
            },
          };
        if (k === "storage") return { database: () => Object.assign(raw, { name: file }), kv: noop };
        if (k === "agents") return { registerTool: (t: Tool) => tools.set(t.name, t), configure: () => {}, contributeInstructions: () => {} };
        if (k === "rpc") return { register: (_c: unknown, handlers: typeof rpc) => Object.assign(rpc, handlers) };
        if (k === "http") return { route: (method: string, path: string, h: Route) => routes.set(`${method} ${path}`, h) };
        if (k === "server") return { loopbackBaseUrl: "http://127.0.0.1:9", experimental_appUrl: null };
        if (k === "sdk") return new Proxy(sdk, { get: (t: any, key) => (key in t ? t[key] : noop) });
        return noop;
      },
    },
  );
  await plugin(bb);
  /** What the app's write() posts: the path and body, from the app's own origin, as a click on the page sends it. */
  const post = async (path: string, body: unknown) => {
    const origin = "http://127.0.0.1:9";
    const headers: Record<string, string> = { origin, "sec-fetch-site": "same-origin" };
    const c = {
      req: { url: `${origin}/api/v1/plugins/orchestrator/http${path}`, header: (n: string) => headers[n.toLowerCase()], json: async () => body },
      json: (b: unknown, status = 200) => new Response(JSON.stringify(b), { status }),
    };
    const route = routes.get(`POST ${path}`);
    assert.ok(route, `the plugin serves ${path}`);
    return (await (await route(c)).json()) as { ok: boolean; result?: unknown; error?: { kind: string; message: string } };
  };
  const tool = async (name: string, p: unknown, threadId: string) => (await tools.get(name)!.execute(p, { threadId })).content[0]!.text;
  const items = (recipient: string, kind?: string) => (raw.prepare(`SELECT recipient, sender, kind, ref, body FROM items WHERE recipient = ? ORDER BY created_at, rowid`).all(recipient) as Row[]).filter((i) => !kind || i.kind === kind);
  const events = (project: string, kind: string) => raw.prepare(`SELECT address, thread_id, value, note, ref FROM events WHERE project = ? AND kind = ? ORDER BY at, seq`).all(project, kind) as { address: string; thread_id: string | null; value: string; note: string; ref: string }[];
  const board = (project: string) => raw.prepare(`SELECT kind, title, body FROM board WHERE project = ? AND kind = 'notice' ORDER BY at, rowid`).all(project) as { kind: string; title: string; body: string }[];
  const projects = async () => (await rpc.projects!(null)) as Projects;
  const agents = async () => (await rpc.agents!(null)) as Agents;
  const scope = async () => (await rpc.scope!(null)) as Scope;
  return { raw, pre, post, tool, sends, items, events, board, projects, agents, scope, lead, scout, stray };
}

test("Start and End scoping from the Projects view do what orch_project_mode does: the owner's route for otter, the CoS's tool for kite", async () => {
  const h = await host();
  const body = projectModeBody.parse({ slug: "otter", mode: "scoping" });
  const out = await h.post(WRITES.projectMode, body);
  assert.equal(out.ok, true, out.error?.message);
  assert.equal(out.result, "scoping");
  assert.match(await h.tool("orch_project_mode", { slug: "kite", mode: "scoping" }, "T-cos"), /kite is scoping now/);

  for (const slug of ["otter", "kite"]) {
    assert.equal((await h.projects()).find((p) => p.slug === slug)!.mode, "scoping", `${slug} scopes as a whole`);
    assert.deepEqual(h.events(slug, "mode").map((e) => [e.address, e.value]), [[`lead:${slug}`, "scoping"]], `${slug}: one timeline event`);
    assert.deepEqual(h.board(slug).map((b) => b.title), [`${slug}: scoping`], `${slug}: the board's notice`);
    const notice = h.items(`lead:${slug}`, "notice");
    assert.equal(notice.length, 1, `${slug}'s lead is told`);
    assert.match(notice[0]!.body, new RegExp(`put ${slug} in scoping mode\\. Work its scope out with .+ directly: your cards and deliverables go only to .+'s Scope pane`));
  }
  assert.equal(h.items("lead:otter", "notice")[0]!.sender, "person", "the owner made otter's change");
  assert.equal(h.items("lead:kite", "notice")[0]!.sender, "cos");
  const copies = h.items("cos", "copy").filter((c) => / to scoping\. /.test(c.body));
  assert.deepEqual(copies.map((c) => c.body.match(/set (\w+) to scoping/)?.[1]), ["otter"], "the CoS gets a copy of the owner's change, not of its own");

  // a card each lead files now waits in the Scope pane; ending scoping moves both to the normal route alike
  const co = h.pre.ask(h.lead, q);
  const ck = h.pre.ask(h.pre.agentByAddress("lead:kite")!, q);
  for (const d of [co, ck]) assert.equal(h.pre.decision(d.id)!.orchestrator.scope, true, "in the Scope pane while scoping");
  assert.equal((await h.post(WRITES.projectMode, { slug: "otter", mode: "active" })).ok, true);
  assert.match(await h.tool("orch_project_mode", { slug: "kite", mode: "active" }, "T-cos"), /kite is active now/);
  const [o, k] = [h.pre.decision(co.id)!, h.pre.decision(ck.id)!];
  assert.equal(o.orchestrator.scope, false, "otter's card left the Scope pane");
  assert.deepEqual([o.state, o.orchestrator.at_level, o.orchestrator.scope], [k.state, k.orchestrator.at_level, k.orchestrator.scope], "the owner's End scoping moved its card exactly as the tool did");
  for (const slug of ["otter", "kite"]) {
    assert.deepEqual(h.events(slug, "mode").map((e) => e.value), ["scoping", "active"]);
    assert.match(h.items(`lead:${slug}`, "notice").at(-1)!.body, new RegExp(`ended scoping: ${slug} is active`));
  }
  // the same mode again: nothing changes, and no one is told twice
  const before = h.items("lead:otter").length;
  assert.equal((await h.post(WRITES.projectMode, { slug: "otter", mode: "active" })).result, "active");
  assert.equal(h.items("lead:otter").length, before);
});

test("Scope this thread… with a new task: the thread is told to investigate read-only, the lead hears who plans it, and its forwarded card goes to the Scope tab under the task", async () => {
  const h = await host();
  const out = await h.post(WRITES.scopeThread, scopeThreadBody.parse({ threadId: "T-scout", name: "Ranking signals" }));
  assert.equal(out.ok, true, out.error?.message);
  const id = out.result as string;
  assert.match(id, /^st-/, "a task opened through orch_scope_task's own path");
  const task = (await h.projects()).find((p) => p.slug === "otter")!.tasks!;
  assert.deepEqual(task, [{ id, name: "Ranking signals", planner: h.scout.address }], "open, and planned by the thread");

  const told = h.items(h.scout.address, "notice");
  assert.equal(told.length, 1);
  assert.equal(told[0]!.body, `You are now the scoping thread for task "Ranking signals" (${id}) in otter. Investigate read-only and make no changes. Your questions and findings go to your lead.`);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(h.sends.some((s) => s.threadId === "T-scout" && s.text.includes("You are now the scoping thread")), "delivered to the thread's session");
  const toLead = h.items("lead:otter", "notice").at(-1)!;
  assert.match(toLead.body, new RegExp(`made ${h.scout.address} the scoping thread for otter's task "Ranking signals" \\(${id}\\), a task they opened for it: it plans that task now`));
  assert.ok(h.items("cos", "copy").some((c) => c.ref === id && c.body === toLead.body), "the CoS gets the same copy");
  assert.deepEqual(h.events("otter", "scope-thread").map((e) => [e.address, e.thread_id, e.value, e.note, e.ref]), [[h.scout.address, "T-scout", "scoping", "Ranking signals", id]], "one timeline event, on the thread's row");
  const row = ((await h.pre.projectHistory("otter", new Map())) as { rows: { address: string; marks: { label: string }[] }[] }).rows.find((r) => r.address === h.scout.address)!;
  assert.ok(row.marks.some((m) => m.label === "scoping thread: Ranking signals"), "drawn on the thread's timeline row");

  // the reads the page draws: the card's chip and the Scope tab's planner line
  assert.deepEqual((await h.agents()).find((a) => a.threadId === "T-scout")!.scopeTask, { id, name: "Ranking signals" });
  assert.equal((await h.agents()).find((a) => a.threadId === "T-stray")!.scopeTask, null);
  assert.equal((await h.scope()).projects.find((p) => p.slug === "otter")!.tasks![0]!.planner?.address, h.scout.address);

  // its question, forwarded by the lead, lands under the task: not with the CoS
  const d = h.pre.ask(h.scout, q);
  assert.match(h.items("lead:otter", "decision.new").find((i) => i.ref === d.id)!.body, /scoping thread for task "Ranking signals"/);
  assert.match(await h.tool("orch_forward", { id: d.id }, "T-lo"), /Scope pane/);
  const f = h.pre.decision(d.id)!;
  assert.deepEqual([f.orchestrator.scope, f.orchestrator.scope_task], [true, id]);
  assert.ok(!h.items("cos", "decision.new").some((i) => i.ref === d.id), "not triaged");
  assert.ok((await h.scope()).projects.find((p) => p.slug === "otter")!.cards.some((c) => c.id === d.id && c.scopeTask === id), "in the Scope tab, under the task");
});

test("Stop scoping gives the normal route back: the task stays open, the lead plans it, and the thread hears it no longer scopes", async () => {
  const h = await host();
  const id = (await h.post(WRITES.scopeThread, { threadId: "T-scout", name: "Ranking signals" })).result as string;
  const out = await h.post(WRITES.unscopeThread, unscopeThreadBody.parse({ threadId: "T-scout" }));
  assert.equal(out.ok, true, out.error?.message);
  assert.equal(out.result, id);

  assert.match(h.items(h.scout.address, "notice").at(-1)!.body, new RegExp(`you are no longer the scoping thread for task "Ranking signals" \\(${id}\\)\\. Your questions go to your lead the normal way`));
  const toLead = h.items("lead:otter", "notice").at(-1)!.body;
  assert.match(toLead, new RegExp(`stopped ${h.scout.address} scoping otter's task "Ranking signals" \\(${id}\\): the lead plans it now\\. The task stays open`));
  assert.ok(h.items("cos", "copy").some((c) => c.body === toLead));
  assert.deepEqual(h.events("otter", "scope-thread").map((e) => e.value), ["scoping", "stopped"]);

  assert.deepEqual((await h.projects()).find((p) => p.slug === "otter")!.tasks, [{ id, name: "Ranking signals", planner: null }], "still open; the lead plans it");
  assert.equal((await h.scope()).projects.find((p) => p.slug === "otter")!.tasks![0]!.planner, null);
  assert.equal((await h.agents()).find((a) => a.threadId === "T-scout")!.scopeTask, null);
  const spawn = h.raw.prepare(`SELECT plan_id, scope_task FROM spawns WHERE thread_id = 'T-scout'`).get() as { plan_id: string | null; scope_task: string | null };
  assert.ok(spawn.plan_id, "the plan's row stays, holding its slot");
  assert.equal(spawn.scope_task, null);

  const d = h.pre.ask(h.scout, q);
  await h.tool("orch_forward", { id: d.id }, "T-lo");
  const f = h.pre.decision(d.id)!;
  assert.equal(f.orchestrator.at_level, "cos", "the normal route: the CoS's triage");
  assert.ok(!f.orchestrator.scope);
  // stopping again: nothing to stop, no one told
  const n = h.items(h.scout.address).length;
  assert.equal((await h.post(WRITES.unscopeThread, { threadId: "T-scout" })).result, null);
  assert.equal(h.items(h.scout.address).length, n);
});

test("the owner can scope a thread no plan started, onto an open task by id or name; its forwarded cards route under it", async () => {
  const h = await host();
  const t = h.pre.openTask(h.lead, "Synonyms");
  assert.equal((await h.post(WRITES.scopeThread, { threadId: "T-stray", task: "synonyms" })).result, t.id, "an open task by its name, any case");
  const row = h.raw.prepare(`SELECT via, plan_id, scope_task FROM spawns WHERE thread_id = 'T-stray'`).get() as { via: string; plan_id: string | null; scope_task: string };
  assert.deepEqual({ ...row }, { via: "scope", plan_id: null, scope_task: t.id }, "the owner's pick is its record");
  const d = h.pre.ask(h.stray, q);
  await h.tool("orch_forward", { id: d.id }, "T-lo");
  assert.equal(h.pre.decision(d.id)!.orchestrator.scope_task, t.id);
  assert.match(h.items("lead:otter", "notice").at(-1)!.body, /the scoping thread for otter's task "Synonyms" \(st-[0-9a-f]+\): it plans/, "an open task: no \"opened for it\"");
});

test("the owner's switches refuse what the engine can't do, with the reason, and change nothing", async () => {
  const h = await host();
  const refused = async (path: string, body: unknown, re: RegExp) => {
    const out = await h.post(path, body);
    assert.equal(out.ok, false, `${JSON.stringify(body)} is refused`);
    assert.match(out.error!.message, re);
  };
  await refused(WRITES.scopeThread, { threadId: "T-lo", name: "x" }, /isn't a project's thread.*Start scoping/);
  await refused(WRITES.scopeThread, { threadId: "T-scout" }, /give task .* or name/);
  await refused(WRITES.scopeThread, { threadId: "T-scout", task: "st-0000", name: "x" }, /not both/);
  await refused(WRITES.scopeThread, { threadId: "T-scout", task: "Nothing open" }, /otter has no scoping task "Nothing open"/);
  const other = h.pre.openTask(h.pre.agentByAddress("lead:kite")!, "Export");
  await refused(WRITES.scopeThread, { threadId: "T-scout", task: other.id }, /otter has no scoping task/);
  h.pre.openTask(h.lead, "Synonyms");
  await refused(WRITES.scopeThread, { threadId: "T-scout", name: "SYNONYMS" }, /already has an open scoping task "SYNONYMS"/);
  await refused(WRITES.scopeThread, { threadId: "T-scout", name: "x".repeat(SCOPING_TASK_NAME_MAX + 1) }, /over 60 characters/);
  h.pre.setStatus("T-stray", "stopped");
  await refused(WRITES.scopeThread, { threadId: "T-stray", name: "x" }, /is stopped/);
  await refused(WRITES.projectMode, { slug: "nope", mode: "scoping" }, /no project nope/);
  assert.equal(h.pre.openTasks("otter").length, 1, "only the task the lead opened: no half-opened task from a refused write");
  assert.equal(h.items(h.scout.address, "notice").length, 0, "no thread was told anything");
});

// ---------------------------------------------------------------- the engine: the planner, the cycle, moving between tasks
function setup() {
  let clock = Date.parse("2026-11-17T10:00:00Z");
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, { now: () => clock, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { batchInbox: false });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lo", "lead", "otter");
  const notices = (address: string) => (db.prepare(`SELECT body FROM items WHERE recipient = ? AND kind = 'notice' ORDER BY created_at, rowid`).all(address) as { body: string }[]).map((r) => r.body);
  return { e, db, cos, lead, notices, advance: (ms: number) => (clock += ms) };
}

test("the owner's pick plans the task, even over a thread started for it later; stopping it hands the task back to that thread", () => {
  const s = setup();
  const t = s.e.openTask(s.lead, "Export format");
  const plan = { id: approvedPlan(s.e, s.cos, s.lead, 2) };
  s.e.confirmSpawn(s.e.reserveSpawn(s.lead, plan.id), "T-old"); // started first, with no task
  const old = s.e.register("T-old", "thread", "otter", "T-lo");
  s.advance(60_000);
  s.e.confirmSpawn(s.e.reserveSpawn(s.lead, plan.id, t.id), "T-new"); // started later, for the task
  const fresh = s.e.register("T-new", "thread", "otter", "T-lo");
  assert.equal(s.e.taskPlanner(t.id)?.address, fresh.address);
  s.advance(60_000);
  s.e.ownerScopeThread("T-old", { task: t.id });
  assert.equal(s.e.taskPlanner(t.id)?.address, old.address, "the owner's pick, though its thread started earlier");
  s.advance(60_000);
  s.e.ownerUnscopeThread("T-old");
  assert.equal(s.e.taskPlanner(t.id)?.address, fresh.address, "the task's other scoping thread plans it again");
  assert.match(s.notices("lead:otter").at(-1)!, new RegExp(`: its scoping thread ${fresh.address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} plans it now`));
  assert.equal((s.db.prepare(`SELECT COUNT(*) AS n FROM spawns WHERE plan_id = ?`).get(plan.id) as { n: number }).n, 2, "both rows keep the plan's slots");
});

test("scope, stop, scope again: the thread hears each switch; the same task twice is a no-op; moving tasks tells the lead what it left", () => {
  const s = setup();
  const th = s.e.register("T-t", "thread", "otter", "T-lo");
  const a = s.e.openTask(s.lead, "Ranking");
  const b = s.e.openTask(s.lead, "Synonyms");
  s.e.ownerScopeThread("T-t", { task: a.id });
  assert.deepEqual(s.e.ownerScopeThread("T-t", { task: "Ranking" }), { task: s.e.task(a.id), opened: false, changed: false });
  assert.equal(s.notices(th.address).length, 1, "the same task again tells no one");
  s.advance(1000);
  s.e.ownerUnscopeThread("T-t");
  s.advance(1000);
  s.e.ownerScopeThread("T-t", { task: a.id });
  const n = s.notices(th.address);
  assert.equal(n.length, 3, "three switches, three notices: none dropped as a repeat");
  assert.match(n[0]!, new RegExp(`^You are now the scoping thread for task "Ranking" \\(${a.id}\\)`));
  assert.match(n[1]!, /stopped your scoping: you are no longer the scoping thread for task "Ranking"/);
  assert.equal(n[2], n[0]);
  s.advance(1000);
  s.e.ownerScopeThread("T-t", { task: b.id });
  assert.equal(s.e.taskPlanner(b.id)?.address, th.address);
  assert.equal(s.e.taskPlanner(a.id), null, "one task at a time: the lead plans the one it left");
  assert.match(s.notices("lead:otter").at(-1)!, new RegExp(`It no longer scopes task "Ranking" \\(${a.id}\\): the lead plans that one now\\.`));
});

test("the owner's pick time is its own migration, appended after the scoping tasks'", () => {
  const i = MIGRATIONS.findIndex((m) => /^CREATE TABLE scoping_tasks \(/.test(m));
  assert.ok(i > 0);
  assert.equal(MIGRATIONS[i + 1], "ALTER TABLE spawns ADD COLUMN scoped_at INTEGER", "appended, never folded into 1.12.0's");
});

// ---------------------------------------------------------------- what each row's menu offers (kit.ts)
test("the lead's row switches its whole project; a live thread's row scopes it, and stops it while it scopes", () => {
  assert.deepEqual(scopeActions({ role: "lead" }, "active").map((x) => x.label), ["Start scoping"]);
  assert.deepEqual(scopeActions({ role: "lead" }, "scoping").map((x) => x.label), ["End scoping"]);
  assert.deepEqual(projectScopeAction(undefined), { kind: "project", mode: "scoping", label: "Start scoping" }, "an older plugin process sends no mode: active");
  assert.deepEqual(scopeActions({ role: "thread", engineStatus: "idle", scopeTask: null }, "active").map((x) => x.label), ["Scope this thread…"]);
  assert.deepEqual(scopeActions({ role: "thread", engineStatus: "active", scopeTask: { id: "st-1", name: "Ranking" } }, "active").map((x) => x.label), ["Scope this thread…", "Stop scoping"]);
  assert.deepEqual(scopeActions({ role: "thread", engineStatus: "stopped" }, "active"), [], "the engine refuses a stopped thread: no item that fails");
  assert.deepEqual(scopeActions({ role: "cos" }, "active"), []);
});

test("the picker names a new task after the thread, within the engine's cap, and lists the other open tasks", () => {
  assert.equal(TASK_NAME_MAX, SCOPING_TASK_NAME_MAX, "the picker's cap is the engine's, or a prefilled name is refused");
  assert.equal(taskNameFor("Scout · ranking signals"), "Scout · ranking signals");
  assert.equal(taskNameFor("  two\nlines  "), "two lines", "one line");
  const long = taskNameFor("Investigate why the nightly export to the finance team's ledger drops refunded invoices");
  assert.ok(long.length <= SCOPING_TASK_NAME_MAX && !long.endsWith(" "), long);
  assert.equal(long, "Investigate why the nightly export to the finance team's");
  const tasks = [{ id: "st-1", name: "Ranking" }, { id: "st-2", name: "Synonyms" }];
  assert.deepEqual(pickableTasks(tasks, { id: "st-1" }).map((t) => t.id), ["st-2"], "not the task it already scopes");
  assert.deepEqual(pickableTasks(undefined, null), []);
  assert.equal(tasksScoping({ mode: "active", tasks }), "2 tasks scoping", "the project row's Scoping chip");
  assert.equal(tasksScoping({ mode: "scoping", tasks }), null, "scoping as a whole says it in its state chip");
  assert.equal(tasksScoping({ mode: "active" }), null);
});
