// The chat with a project's lead (1.13.0): the Scope tab and the Projects detail draw the lead's own thread (the host's
// ThreadChat, transcript only), with the orchestrator's composer under it. Why each rule matters:
// - the composer must still file the owner's tracked direct message (owner.message) while the transcript shows: a plain
//   message into the thread would skip the lead's ack, the CoS's copy and the 48 h rule, and the owner could not tell
//   whether the lead took it;
// - with no live lead thread (none started, or stopped, or archived) there is no transcript to draw: the direct-message
//   log must show, or the owner would see an empty box and lose the replies and the Resend they had;
// - under the transcript, the line by the composer keeps what the log said on each message: where the latest one is,
//   and Resend for one that died unacked.
// And who plans each Scope entry (1.13.0): the owner must see whether the lead or a scoping thread is working a task out
// (whose chat to watch), and the lead must be told the same thing, or the two disagree about who owns the planning.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import plugin from "../server.ts";
import { Engine } from "../core/engine.ts";
import { WRITES, directMessageBody, type Projects } from "../contract.ts";
import { directWrite, leadChatView, messageStates } from "../app/lead-chat.ts";
import { plannerOf, scopeEntries } from "../app/kit.ts";

type Lead = NonNullable<Projects[number]["lead"]>;
const lead = (status: string): Lead => ({ address: "lead:otter", threadId: "T-lead", status, mon: null });

test("the chat draws the lead's own thread while it is live, and the direct-message log when there is no live lead thread", () => {
  assert.deepEqual(leadChatView(lead("idle")), { kind: "thread", threadId: "T-lead" });
  assert.deepEqual(leadChatView(lead("active")), { kind: "thread", threadId: "T-lead" }, "a working lead shows its transcript too");
  assert.deepEqual(leadChatView(null), { kind: "log", why: "no-lead" }, "no lead started: the log, with its replies so far");
  assert.deepEqual(leadChatView(lead("stopped")), { kind: "log", why: "not-live" }, "stopped: its mail is held, so the log's states are what tells the owner");
  assert.deepEqual(leadChatView(lead("archived")), { kind: "log", why: "not-live" });
});

test("under the transcript, the composer's line says where the latest message is and lists each dead one for Resend", () => {
  const m = (id: string, at: number, state: string, outcome: string | null = null) => ({ id, text: id, at, followUp: null, state, outcome, note: null, answeredAt: null });
  assert.deepEqual(messageStates(null, "CoS"), { last: null, dead: [] });
  assert.equal(messageStates({ unread: false, messages: [m("i-1", 1, "closed", "done"), m("i-2", 2, "delivered")] }, "CoS").last?.word, "delivered, not acked yet");
  assert.equal(messageStates({ unread: false, messages: [m("i-2", 2, "closed", "done")] }, "CoS").last?.word, "acked");
  assert.equal(messageStates({ unread: false, messages: [m("i-2", 2, "pending")] }, "CoS").last?.word, "queued for the lead");
  const dead = messageStates({ unread: false, messages: [m("i-1", 1, "dead"), m("i-2", 2, "delivered")] }, "CoS");
  assert.deepEqual(dead.dead.map((x) => x.id), ["i-1"], "a dead message stays offered for Resend while a newer one is delivered");
});

// ---------------------------------------------------------------- the composer's write, through the plugin's real route
// No /tmp: a scratch folder beside the tests (.scratch/ is git-ignored), removed afterwards.
const scratchRoot = join(import.meta.dirname, ".scratch");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "lead-chat-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

type Tool = { name: string; execute: (p: unknown, ctx: { threadId: string }) => Promise<{ content: { text: string }[]; isError?: boolean }> };
type Route = (c: unknown) => Promise<Response>;

/** The real plugin on a fake bb: the CoS and otter's live lead, every send recorded; the app's writes reach its routes. */
async function host() {
  const root = mkdtempSync(join(scratch, "h-"));
  const file = join(root, "data.db");
  const raw = new DatabaseSync(file);
  const pre = new Engine(raw as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { batchInbox: false });
  pre.register("T-cos", "cos", null);
  pre.register("T-lead", "lead", "otter");
  pre.setStatus("T-lead", "idle");
  const sends: { threadId: string; text: string }[] = [];
  const titles: Record<string, string> = { "T-scout": "Scout · ranking signals" };
  const rpc: Record<string, (input: unknown) => Promise<unknown>> = {};
  const tools = new Map<string, Tool>();
  const routes = new Map<string, Route>();
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : noop), apply: () => noop });
  const sdk = {
    threads: {
      get: async ({ threadId }: { threadId: string }) => ({ id: threadId, title: titles[threadId] ?? null, archivedAt: null, status: "idle" }),
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
    return (await (await routes.get(`POST ${path}`)!(c)).json()) as { ok: boolean; result?: unknown; error?: { message: string } };
  };
  const tool = async (name: string, p: unknown, threadId: string) => (await tools.get(name)!.execute(p, { threadId })).content[0]!.text;
  return { raw, pre, post, tool, sends, rpc };
}

test("with the lead's thread shown, the composer still files a tracked direct message: the lead must ack it, the CoS gets a copy, and the ack note comes back to the owner", async () => {
  const h = await host();
  const view = leadChatView(lead("idle"));
  assert.equal(view.kind, "thread", "the case under test: the transcript is what shows above the composer");
  const w = directWrite("otter", "Keep the reindex off production until I say.", null);
  assert.equal(w.path, WRITES.directMessage, "the owner's direct message, never a plain message into the thread");
  directMessageBody.parse(w.body);
  const out = await h.post(w.path, w.body);
  assert.equal(out.ok, true, out.error?.message);
  const id = out.result as string;
  const items = h.raw.prepare(`SELECT recipient, kind, needs_ack, ref FROM items ORDER BY created_at, rowid`).all() as { recipient: string; kind: string; needs_ack: number; ref: string | null }[];
  assert.deepEqual(
    items.map((i) => [i.recipient, i.kind, i.needs_ack]),
    [
      ["lead:otter", "owner.message", 1],
      ["cos", "copy", 0],
    ],
    "the lead gets the message to ack; the CoS a read-only copy of it",
  );
  assert.equal(items[1]!.ref, id);
  // the lead's session reads it as a direct message with its rules: what shows in the transcript above the composer
  await new Promise((r) => setTimeout(r, 50));
  const toLead = h.sends.find((s) => s.threadId === "T-lead");
  assert.match(toLead?.text ?? "", new RegExp(`^\\[orchestrator\\] direct message ${id} from .+: Keep the reindex off production until I say\\.`));
  assert.match(await h.tool("orch_ack", { id, outcome: "done", note: "Taken: no production runs until you say." }, "T-lead"), /./);
  const state = h.raw.prepare(`SELECT state, note FROM items WHERE id = ?`).get(id) as { state: string; note: string };
  assert.deepEqual([state.state, state.note], ["closed", "Taken: no production runs until you say."], "the ack path still closes it with the note the owner reads");
});

test("each Scope entry names its planner: the lead, until a live scoping thread plans the task; the lead's inbox and tools say the same", async () => {
  const h = await host();
  const opened = await h.tool("orch_scope_task", { action: "open", name: "Ranking signals" }, "T-lead");
  assert.match(opened, /You are planning it until you start a scoping thread with scope_task/, "the lead knows it plans the task itself for now");
  const t = h.pre.openTasks("otter")[0]!;
  const read = async () => scopeEntries(((await h.rpc.scope!(null)) as { projects: Parameters<typeof scopeEntries>[0] }).projects).find((e) => e.task?.id === t.id)!;
  assert.equal(plannerOf(await read()).text, "Planned by the lead");
  assert.match(await h.tool("orch_inbox", {}, "T-lead"), new RegExp(`${t.id} "Ranking signals" \\(planned by you\\)`));

  // the task's scoping thread starts (orch_spawn_thread with scope_task records the task on its spawn row)
  h.raw.prepare(`INSERT INTO spawns (thread_id, plan_id, via, lead, created_at, scope_task) VALUES ('T-scout', NULL, 'plan', 'lead:otter', ?, ?)`).run(Date.now(), t.id);
  h.pre.register("T-scout", "thread", "otter", "T-lead");
  h.pre.setStatus("T-scout", "active");
  const entry = await read();
  assert.deepEqual(plannerOf(entry), { kind: "thread", text: "Planned by Scout · ranking signals (thread:otter:1) · working", name: "Scout · ranking signals", address: "thread:otter:1", threadId: "T-scout", state: "working" });
  assert.match(await h.tool("orch_inbox", {}, "T-lead"), /\(planned by its scoping thread thread:otter:1\)/);
  h.pre.setStatus("T-scout", "idle");
  assert.equal(plannerOf(await read()).text, "Planned by Scout · ranking signals (thread:otter:1) · idle");

  // stopped, it plans nothing: back to the lead, in both places
  h.pre.setStatus("T-scout", "stopped");
  assert.equal(plannerOf(await read()).text, "Planned by the lead");
  assert.match(await h.tool("orch_inbox", {}, "T-lead"), /\(planned by you\)/);
  // a whole-project entry is always the lead's
  assert.equal(plannerOf({ key: "kite", slug: "kite", task: null }).text, "Planned by the lead");
});

// The entry header's next step: the owner should never have to work out the flow. The "Scoping done?" card, when it is
// there, is the one thing to do; otherwise the cards; otherwise nothing waits, and the line says what comes next (since
// 2026-11-17 on the entry's status card, which names who is working beside it, so the line no longer repeats that).
test("each Scope entry says what happens next: the Scoping done? card first, then the cards, then where questions will come", async () => {
  const { scopeNext } = await import("../app/kit.ts");
  const task = { key: "otter/st-1", slug: "otter", task: { id: "st-1", name: "Ranking signals" }, planner: null };
  const whole = { key: "kite", slug: "kite", task: null };
  const done = { title: "Ranking scoped?", scopingDone: { summary: "x" } };
  const q = { title: "Use click-through?" };
  assert.match(scopeNext(task, { cards: [q, done], delivered: 0, hasLead: true }), /^Next: answer "Ranking scoped\?"\. Yes closes this task/);
  assert.match(scopeNext(whole, { cards: [{ title: "Scoping done?", scopingDone: {} }], delivered: 0, hasLead: true }), /Yes makes kite active/);
  assert.match(scopeNext(task, { cards: [q], delivered: 0, hasLead: true }), /^Next: answer the cards; the lead files "Scoping done\?"/);
  assert.equal(scopeNext(task, { cards: [], delivered: 0, hasLead: true }), `Questions appear here; the lead proposes "Scoping done?" when it's ready.`);
  const planned = { ...task, planner: { address: "thread:otter:1", threadId: "T-s", title: "Scout", status: "active" } };
  assert.equal(scopeNext(planned, { cards: [], delivered: 0, hasLead: true }), scopeNext(task, { cards: [], delivered: 0, hasLead: true }), "who is investigating is on the status card, not in this line");
  assert.match(scopeNext(task, { cards: [q], delivered: 0, hasLead: false }), /^No lead is running for otter/);
});

// The Scope entry's status card (2026-11-17) says what a scoping thread is on from its own last report. The scope read must
// carry it, and since when the thread is idle, or the card could only say "working" or "idle" with nothing behind it.
test("the scope read carries each scoping thread's last report and since when it is idle, for the entry's status card", async () => {
  const { scopeStatus } = await import("../app/kit.ts");
  const h = await host();
  await h.tool("orch_scope_task", { action: "open", name: "Ranking signals" }, "T-lead");
  const t = h.pre.openTasks("otter")[0]!;
  h.raw.prepare(`INSERT INTO spawns (thread_id, plan_id, via, lead, created_at, scope_task) VALUES ('T-scout', NULL, 'plan', 'lead:otter', ?, ?)`).run(Date.now(), t.id);
  h.pre.register("T-scout", "thread", "otter", "T-lead");
  h.pre.setStatus("T-scout", "active");
  const read = async () => scopeEntries(((await h.rpc.scope!(null)) as { projects: Parameters<typeof scopeEntries>[0] }).projects).find((e) => e.task?.id === t.id)!;
  const working = await read();
  assert.deepEqual([working.planner?.report, working.planner?.idleAt], [null, null], "working, and no report yet");
  assert.equal(scopeStatus(working, undefined).now, null, "the card says it has no report yet, not something else's line");

  assert.match(await h.tool("orch_report", { title: "Five ranking signals logged; two usable", body: "Click-through and dwell time." }, "T-scout"), /On the board/);
  h.pre.setStatus("T-scout", "idle");
  const idle = await read();
  assert.equal(idle.planner?.report?.text, "Five ranking signals logged; two usable");
  assert.equal(typeof idle.planner?.report?.at, "number");
  assert.equal(typeof idle.planner?.idleAt, "number", "since when it is idle: the card's last activity");
  const s = scopeStatus(idle, undefined);
  assert.deepEqual(s.now, { text: "Five ranking signals logged; two usable", from: "report", at: idle.planner!.report!.at });
  assert.deepEqual([s.who.kind, s.who.working, s.who.state, s.who.idleSince], ["thread", false, "idle", idle.planner!.idleAt]);
});
