// Scoping mode (1.11.0). A new project can start in scoping, where the owner works out its scope with its lead
// directly in the Scope tab. Why each rule matters:
// - its lead's cards go only to the Scope pane: if one also reached the CoS's triage or Needs you, the owner would get
//   the same question twice, or the CoS would answer for them in a conversation that is theirs;
// - no standing rule settles one: a rule written for active work would close a scoping question the owner never saw;
// - the CoS gets exactly one read-only copy, so it knows the project is scoping and stays out of it;
// - the lead's "Scoping done?" yes is the only way out besides the CoS's tool, and leaving releases what still waits,
//   so a card is never stranded in neither place;
// - an active project's cards route exactly as before.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, SCOPING_DONE_OPTIONS, type AskInput, type DeliverResult } from "../core/engine.ts";
import { MIGRATIONS, migrate } from "../core/db.ts";
import type { Decision, Deliverable, Item } from "../core/model.ts";

function setup() {
  let clock = Date.parse("2026-11-17T10:00:00Z");
  const sent: Item[] = [];
  const up: string[] = [];
  const pushed: string[] = [];
  const db = new DatabaseSync(":memory:");
  const e = new Engine(
    db as never,
    {
      now: () => clock,
      async deliver(_t, _x, item): Promise<DeliverResult> {
        sent.push(item);
        return { delivery: "sent" };
      },
      mirror: () => {},
      changed: () => {},
      cardUp: (d) => up.push(d.id),
      delivered: (d) => pushed.push(d.id),
      log: () => {},
    },
    { escalateMs: 5 * 60_000 },
  );
  const cos = e.register("T-cos", "cos", null);
  e.createProject("kite", "normal", "cos", "cos created project kite", "", "scoping");
  const lead = e.register("T-lk", "lead", "kite");
  const active = e.register("T-lo", "lead", "otter");
  return { e, db, cos, lead, active, sent, up, pushed, advance: (ms: number) => (clock += ms) };
}
type S = ReturnType<typeof setup>;

const q: AskInput = { title: "Which format for the nightly report?", question: "Write the nightly report as Markdown or as HTML?", options: [{ label: "Markdown" }, { label: "HTML" }] };
const items = (s: S, recipient: string, kind?: string) =>
  (s.db.prepare(`SELECT * FROM items WHERE recipient = ? ${kind ? "AND kind = ?" : ""} ORDER BY created_at`).all(...(kind ? [recipient, kind] : [recipient])) as { kind: string; ref: string | null; body: string; needs_ack: number }[]);
const done = { summary: "Goal: export invoices nightly. Constraints: no prod writes. First plan: 2 threads (adapter, QA).", projectMd: "/projects/kite/PROJECT.md" };
const answer = (s: S, d: Decision, option: string | null, text: string | null = null) => s.e.personAnswer(d.id, s.e.decision(d.id)!.rev, option, text, "desktop");

test("a scoping project's question never reaches CoS triage or Needs you: it waits in the Scope pane, and the CoS gets one read-only copy", () => {
  const s = setup();
  const d = s.e.ask(s.lead, q);
  assert.equal(d.state, "asked", "straight to the owner, not open for triage");
  assert.equal(d.orchestrator.scope, true);
  assert.equal(items(s, "cos", "decision.new").length, 0, "nothing for the CoS to triage");
  const copies = items(s, "cos", "copy");
  assert.equal(copies.length, 1, "exactly one copy");
  assert.equal(copies[0]!.ref, d.id);
  assert.equal(copies[0]!.needs_ack, 0, "read-only: no ack");
  assert.match(copies[0]!.body, /scoping.*Scope pane.*Read-only: don't triage, settle, merge or moot it/);
  assert.deepEqual(s.e.needsYou().cards.map((c) => c.id), [], "not on Needs you");
  assert.deepEqual(s.up, [], "no Needs you push");
  // the triage clock never takes it to Needs you either
  s.advance(60 * 60_000);
  s.e.tick();
  assert.deepEqual(s.e.needsYou().cards.map((c) => c.id), []);
  assert.equal(s.e.decision(d.id)!.orchestrator.triage.escalated_at, null);
  const pane = s.e.scopeView();
  assert.deepEqual(pane.map((p) => p.slug), ["kite"]);
  assert.deepEqual(pane[0]!.cards.map((c) => c.id), [d.id], "it is in the Scope pane, answerable there");
  // the CoS's copy is read-only: it can't triage, moot or merge into it
  assert.throws(() => s.e.triageSettle(s.cos, d.id, "r-x", "1", null), /isn't waiting for triage/);
  assert.throws(() => s.e.moot(s.cos, d.id, "done"), /Scope pane/);
  const other = s.e.ask(s.active, { ...q, title: "Which format, otter?" });
  assert.throws(() => s.e.triageMerge(s.cos, other.id, d.id), /Scope pane/);
  // the owner answers it in the pane; the answer goes to the lead and the CoS gets the usual copy
  answer(s, d, "1");
  assert.equal(items(s, "lead:kite", "decision.answer").length, 1);
  assert.equal(items(s, "cos", "copy").filter((c) => c.ref === d.id).length, 2, "its card copy, then the answer copy");
  assert.deepEqual(s.e.scopeView()[0]!.cards, []);
});

test("the same question from an active project routes exactly as before: to the CoS's triage, then Needs you", () => {
  const s = setup();
  const d = s.e.ask(s.active, q);
  assert.equal(d.state, "open");
  assert.equal(d.orchestrator.at_level, "cos");
  assert.ok(!d.orchestrator.scope);
  assert.equal(items(s, "cos", "decision.new").length, 1, "filed for triage");
  assert.equal(items(s, "cos", "copy").length, 0, "no scoping copy");
  s.e.triageAskPerson(s.cos, d.id, { question: q.question, options: q.options, allowText: true });
  assert.deepEqual(s.e.needsYou().cards.map((c) => c.id), [d.id]);
  assert.deepEqual(s.up, [d.id]);
  assert.equal(s.e.scopeView().find((p) => p.slug === "otter"), undefined, "an active project has no Scope pane");
});

test("a standing rule that settles a card does not settle it while the project is scoping", () => {
  const s = setup();
  const match = { from: ["lead:*"], words: ["format", "report"], without: [], key_prefix: null, option: ["markdown"] };
  const r = s.e.addRule({ text: "reports are written as Markdown", project: null, kinds: ["question"], expiresAt: null, source: "test", match });
  const settled = s.e.ask(s.active, q);
  assert.equal(settled.state, "answered", "the rule settles the active project's card");
  assert.equal(settled.answer!.source, `rule ${r.id}`);
  const d = s.e.ask(s.lead, q);
  assert.equal(d.state, "asked", "the scoping card waits for the owner");
  assert.equal(d.answer, null);
  assert.equal(items(s, "lead:kite", "decision.answer").length, 0, "no answer reached the lead");
  assert.equal(items(s, "cos", "notice").filter((n) => n.ref === d.id).length, 0, "no rule-settled notice");
  // a plan from the scoping lead is the owner's too, even with a rule covering plans
  s.e.addRule({ text: "plans go", project: "kite", kinds: ["plan"], expiresAt: null, source: "test" });
  const plan = s.e.ask(s.lead, { title: "Plan: one research thread", question: "Start one read-only research thread?", options: [{ label: "Go" }, { label: "Not now" }], kind: "plan", threads: 1 });
  assert.equal(plan.state, "asked");
  assert.equal(plan.orchestrator.scope, true);
  assert.equal(plan.ask!.allow_text, true, "the owner may answer a plan in their own words; only its go option starts threads");
  assert.throws(() => s.e.triageSettle(s.cos, plan.id, "r-any", "1", null), /isn't waiting for triage/);
});

test("the owner's yes on \"Scoping done?\" makes the project active, releases what waits, and the next card goes the normal route", () => {
  const s = setup();
  const open = s.e.ask(s.lead, q);
  const v = s.e.deliver(s.lead, { title: "Export spike", summary: "What the export needs.", proof: [{ kind: "link", caption: "the notes", url: "https://example.com/notes" }] }, { roots: [] });
  assert.equal(v.scope, true);
  assert.deepEqual(s.pushed, [], "no Deliverables push while scoping");
  assert.equal(items(s, "cos", "copy").filter((c) => c.ref === v.id).length, 1, "the CoS gets a copy of the deliverable");
  const card = s.e.ask(s.lead, { ...q, title: "Scoping done?", question: "Is kite scoped?", scopingDone: done });
  assert.deepEqual(card.request.options.map((o) => o.label), SCOPING_DONE_OPTIONS.map((o) => o.label), "fixed options: option 1 is the yes");
  assert.deepEqual(card.orchestrator.scoping_done, { summary: done.summary, project_md: done.projectMd });
  assert.match(items(s, "cos", "copy").find((c) => c.ref === card.id)!.body, /proposes ending scoping/);
  assert.throws(() => s.e.ask(s.lead, { ...q, title: "Done now?", scopingDone: done }), /already asks/, "one at a time");
  const pane = s.e.scopeView()[0]!;
  assert.deepEqual(pane.cards.map((c) => c.id).sort(), [open.id, card.id].sort());
  assert.deepEqual(pane.deliverables.map((d) => d.id), [v.id]);

  answer(s, card, "1");
  assert.equal(s.e.project("kite")!.mode, "active");
  const ev = s.db.prepare(`SELECT value, ref, note FROM events WHERE kind = 'mode' AND project = 'kite' ORDER BY seq DESC LIMIT 1`).get() as { value: string; ref: string; note: string };
  assert.deepEqual({ ...ev }, { value: "active", ref: card.id, note: "person" }, "a timeline event names the card");
  assert.ok(items(s, "cos", "copy").some((c) => /set kite to active/.test(c.body)), "the CoS gets a copy of the switch");
  assert.ok(items(s, "lead:kite", "notice").some((n) => /ended scoping/.test(n.body)), "the lead is told");
  assert.deepEqual(s.e.scopeView(), [], "nothing is scoping now");
  // what still waited moves to the normal places: nothing stranded
  assert.deepEqual(s.e.needsYou().cards.map((c) => c.id), [open.id]);
  assert.ok(s.up.includes(open.id));
  assert.equal((s.e.deliverable(v.id) as Deliverable).scope, undefined);
  assert.deepEqual(s.pushed, [v.id]);

  const next = s.e.ask(s.lead, { ...q, title: "Which region first?" });
  assert.equal(next.state, "open", "the next card goes to triage");
  assert.equal(next.orchestrator.at_level, "cos");
  assert.ok(!next.orchestrator.scope);
  assert.ok(items(s, "cos", "decision.new").some((i) => i.ref === next.id));
});

test("a no on \"Scoping done?\" keeps the project scoping, and the owner's note goes back to the lead", () => {
  const s = setup();
  const card = s.e.ask(s.lead, { ...q, title: "Scoping done?", scopingDone: done });
  answer(s, card, "2", "Not yet: add the rollback plan");
  assert.equal(s.e.project("kite")!.mode, "scoping");
  assert.match(items(s, "lead:kite", "decision.answer")[0]!.body, /Not yet.*add the rollback plan/);
  // a note alone is not a yes either
  const again = s.e.ask(s.lead, { ...q, title: "Scoping done now?", scopingDone: done });
  answer(s, again, null, "looks good but wait");
  assert.equal(s.e.project("kite")!.mode, "scoping");
  assert.equal(s.e.ask(s.lead, q).orchestrator.scope, true, "the next card still goes to the pane");
});

test("\"Scoping done?\" from an active project is refused, and so is one from a thread", () => {
  const s = setup();
  assert.throws(() => s.e.ask(s.active, { ...q, scopingDone: done }), /otter isn't scoping/);
  const t = s.e.register("T-k1", "thread", "kite", "T-lk");
  assert.throws(() => s.e.ask(t, { ...q, scopingDone: done }), /only a lead/);
  assert.throws(() => s.e.ask(s.lead, { ...q, scopingDone: { summary: "", projectMd: done.projectMd } }), /needs summary/);
  assert.throws(() => s.e.ask(s.lead, { ...q, scopingDone: { summary: "x", projectMd: "notes.md" } }), /project_md/);
  assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE json_extract(json, '$.orchestrator.scoping_done') IS NOT NULL`).get()!.n, 0, "nothing filed");
});

test("a scoping project's threads still ask their lead; a card the lead forwards goes to the Scope pane", () => {
  const s = setup();
  const t = s.e.register("T-k1", "thread", "kite", "T-lk");
  const d = s.e.ask(t, q);
  assert.equal(d.orchestrator.at_level, "lead");
  assert.equal(items(s, "lead:kite", "decision.new").length, 1, "to the lead, as today");
  const f = s.e.forward(s.lead, d.id, "the owner should pick");
  assert.equal(f.state, "asked");
  assert.equal(f.orchestrator.scope, true);
  assert.equal(items(s, "cos", "decision.new").length, 0);
});

test("the CoS's inbox and Needs you view list the scoping projects with their open cards; the CoS's switch releases the pane", () => {
  const s = setup();
  s.e.ask(s.lead, q);
  s.e.ask(s.lead, { ...q, title: "Second?" });
  assert.match(s.e.inbox(s.cos).text, /Scoping with the owner directly \(1\)[^\n]*\n- kite: 2 open cards/);
  assert.match(s.e.needsYouView().text, /- kite: 2 open cards/);
  assert.match(s.e.inbox(s.lead).text, /SCOPING with the owner/, "the lead's live view says it is scoping");
  s.e.setMode("kite", "active", "cos");
  assert.doesNotMatch(s.e.inbox(s.cos).text, /Scoping with/);
  const ny = s.e.needsYou();
  assert.equal(ny.cards.length + ny.held.length, 2, "both moved to Needs you (the second held behind the first, as any lead's are)");
  assert.equal(items(s, "cos", "copy").filter((c) => /set kite/.test(c.body)).length, 0, "no copy of its own change");
  s.e.setMode("otter", "scoping", "cos");
  assert.equal(s.e.ask(s.active, { ...q, title: "Otter scoping?" }).orchestrator.scope, true, "an existing project can be put in scoping");
});

test("the project mode is appended after 1.10.0's table: an older database's projects come out active", () => {
  const mode = MIGRATIONS.findIndex((m) => /^ALTER TABLE projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'active'$/.test(m));
  assert.match(MIGRATIONS[mode - 1]!, /^CREATE TABLE handed_off_prs \(/, "appended after 1.10.0's table, never before it");
  // later releases append after it (1.12.0's scoping tasks: test/scoping-tasks.test.ts)
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE _migrations (id INTEGER PRIMARY KEY)`);
  MIGRATIONS.slice(0, mode).forEach((sql, i) => {
    db.exec(sql);
    db.prepare(`INSERT INTO _migrations (id) VALUES (?)`).run(i);
  });
  db.prepare(`INSERT INTO projects (slug, priority, created_at) VALUES ('kept', 'normal', 1)`).run();
  migrate(db);
  const e = new Engine(db as never, { now: () => 1, deliver: async () => ({ delivery: "sent" as const }), mirror: () => {}, changed: () => {}, log: () => {} });
  assert.equal(e.project("kept")!.mode, "active");
});
