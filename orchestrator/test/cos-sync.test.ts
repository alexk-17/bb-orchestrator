// Keeping the CoS in sync (2026-11-15, the owner via the CoS): ack notes reach the sender, the CoS hears the owner's answers,
// sees the owner's Needs you and deliverables, can mark a card moot, and manages the dead letters.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DLQ_WAKE_MS, Engine, type DeliverResult } from "../core/engine.ts";
import { MIGRATIONS } from "../core/db.ts";
import type { Item } from "../core/model.ts";

function setup() {
  let clock = Date.parse("2026-11-15T10:00:00Z");
  const sent: { threadId: string; text: string; item: Item }[] = [];
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, {
    now: () => clock,
    async deliver(threadId, text, item): Promise<DeliverResult> {
      sent.push({ threadId, text, item });
      return { delivery: "sent" };
    },
    mirror: () => {},
    changed: () => {},
    log: () => {},
  }, { batchInbox: false, owner: "Robin" });
  const cos = e.register("T-cos", "cos", null);
  const steward = e.register("T-st", "steward", null);
  const leadA = e.register("T-la", "lead", "alpha");
  const leadB = e.register("T-lb", "lead", "beta");
  const worker = e.register("T-w1", "thread", "alpha", "T-la");
  return { e, db, cos, steward, leadA, leadB, worker, sent, advance: (ms: number) => (clock += ms), now: () => clock };
}
type S = ReturnType<typeof setup>;
const to = (s: S, threadId: string) => s.sent.filter((x) => x.threadId === threadId);
const three = [{ label: "Ship it" }, { label: "Wait" }, { label: "Drop it" }];

// ---------------------------------------------------------------- part 4: ack notes

test("an ack's note reaches the agent that sent the item, so the CoS learns how its request went", async () => {
  const s = setup();
  const m = s.e.send(s.cos, s.leadA.address, "Please rebase the release branch.", null);
  await s.e.flush();
  s.sent.length = 0;
  assert.equal(s.e.ack(s.leadA, m.id, "done", "rebased, CI green"), `${m.id} closed: done`);
  await s.e.flush();
  const back = to(s, "T-cos");
  assert.equal(back.length, 1, "the sender hears the note");
  assert.equal(back[0]!.item.kind, "notice");
  assert.equal(back[0]!.item.needsAck, false, "it is info: the CoS owes nothing back");
  assert.match(back[0]!.text, /lead:alpha acked your message .*done, note: "rebased, CI green"/);
});

test("an ack without a note, or acking your own sender's mail twice, sends nothing more", async () => {
  const s = setup();
  const m = s.e.send(s.cos, s.leadA.address, "Check the disk.", null);
  await s.e.flush();
  s.sent.length = 0;
  s.e.ack(s.leadA, m.id, "done", null);
  await s.e.flush();
  assert.equal(s.sent.length, 0, "no note: no news to carry");
  assert.equal(s.e.ack(s.leadA, m.id, "done", "late note"), `${m.id} was already closed`, "a needs-ack item stays closed once");
  await s.e.flush();
  assert.equal(s.sent.length, 0, "a second ack on a closed needs-ack item doesn't send a note");
});

test("acking an info item that already closed is a plain ok, and its note still reaches the sender", async () => {
  const s = setup();
  s.e.send(s.leadA, s.leadB.address, "FYI: alpha ships today.", null); // copied to the CoS as info
  await s.e.flush();
  const copy = s.e.items().find((i) => i.recipient === "cos" && i.kind === "copy")!;
  assert.equal(copy.state, "closed", "a copy closes itself on delivery");
  s.sent.length = 0;
  assert.equal(s.e.ack(s.cos, copy.id, "done", "noted for the weekly"), "ok");
  await s.e.flush();
  assert.equal(to(s, "T-la").length, 1, "the lead hears the CoS's note on its copy");
});

test("a note item acked with a note doesn't bounce back: two agents can't ping-pong notes", async () => {
  const s = setup();
  const m = s.e.send(s.cos, s.leadA.address, "Ship it.", null);
  s.e.ack(s.leadA, m.id, "done", "shipped");
  await s.e.flush();
  const note = s.e.items().find((i) => i.recipient === "cos" && i.kind === "notice")!;
  s.sent.length = 0;
  assert.equal(s.e.ack(s.cos, note.id, "done", "thanks"), "ok");
  await s.e.flush();
  assert.equal(s.sent.length, 0, "no note on a note");
});

test("acking a decision (d-…) that the CoS settled by rule sends the note to the CoS, like an item ack", async () => {
  const s = setup();
  const d = s.e.ask(s.leadA, { title: "Ship?", question: "Ship alpha?", options: three });
  const r = s.e.addRule({ text: "ship when green", project: null, kinds: ["question"], expiresAt: null, source: "test" });
  s.e.triageSettle(s.cos, d.id, r.id, "1", null);
  await s.e.flush();
  s.sent.length = 0;
  s.e.ack(s.leadA, d.id, "done", "shipped at 14:00"); // agents see and ack the decision id, not the answer item's
  await s.e.flush();
  const back = to(s, "T-cos");
  assert.equal(back.length, 1, "the CoS hears how its rule answer went");
  assert.match(back[0]!.text, /lead:alpha acked your decision.answer .*done, note: "shipped at 14:00"/);
});

test("a note to the owner or the orchestrator itself goes nowhere (no agent at that address)", async () => {
  const s = setup();
  const d = s.e.ask(s.leadA, { title: "Ship?", question: "Ship alpha?", options: three });
  s.e.triageAskPerson(s.cos, d.id, { question: "Ship alpha?", options: three, allowText: true });
  s.e.personAnswer(d.id, s.e.decision(d.id)!.rev, "1", null, "desktop");
  const ans = s.e.items().find((i) => i.recipient === "lead:alpha" && i.kind === "decision.answer")!;
  const before = s.e.items().length;
  s.e.ack(s.leadA, ans.id, "done", "shipped");
  assert.equal(s.e.items().length, before, "the owner's answer has no agent sender to note");
});

// ---------------------------------------------------------------- part 1: the CoS hears the owner's answers

/** A lead's card the CoS put to the owner, and its rev. */
function cardUp(s: S, lead = s.leadA, title = "Ship?") {
  const d = s.e.ask(lead, { title, question: "Ship it now?", options: three });
  s.e.triageAskPerson(s.cos, d.id, { question: "Ship it now?", options: three, allowText: true });
  return s.e.decision(d.id)!;
}

test("when the owner answers, the CoS gets an info copy with the project, the title and the chosen option", async () => {
  const s = setup();
  const d = cardUp(s);
  await s.e.flush();
  s.sent.length = 0;
  s.e.personAnswer(d.id, d.rev, "2", "after the demo", "desktop");
  await s.e.flush();
  const copy = to(s, "T-cos");
  assert.equal(copy.length, 1);
  assert.equal(copy[0]!.item.kind, "copy");
  assert.equal(copy[0]!.item.needsAck, false, "info: the CoS owes no ack");
  assert.equal(copy[0]!.item.ref, d.id);
  const text = copy[0]!.text;
  assert.match(text, /project alpha/);
  assert.match(text, /"Ship\?"/, "the card's title");
  assert.match(text, /option 2 "Wait"/, "what was chosen, so the CoS needn't ask the lead");
  assert.match(text, /note: "after the demo"/);
  assert.match(text, /went to lead:alpha/);
  assert.equal(to(s, "T-la").filter((x) => x.item.kind === "decision.answer").length, 1, "the asker still gets the answer itself");
});

test("a forwarded thread question's copy names both the lead that asked and the thread it came from", async () => {
  const s = setup();
  const q = s.e.ask(s.worker, { title: "Port?", question: "Which port?", options: three });
  s.e.forward(s.leadA, q.id, null);
  s.e.triageAskPerson(s.cos, q.id, { question: "Which port?", options: three, allowText: true });
  s.e.personAnswer(q.id, s.e.decision(q.id)!.rev, "1", null, "phone");
  const copy = s.e.items().find((i) => i.recipient === "cos" && i.kind === "copy")!;
  assert.match(copy.body, /asked by lead:alpha, first asked by thread:alpha:1/);
});

test("a merged duplicate doesn't send the CoS a second copy: one answer, one copy", async () => {
  const s = setup();
  const a = cardUp(s, s.leadA, "Ship?");
  const b = s.e.ask(s.leadB, { title: "Ship too?", question: "Ship it now?", options: three });
  s.e.triageMerge(s.cos, b.id, a.id);
  s.e.personAnswer(a.id, s.e.decision(a.id)!.rev, "1", null, "desktop");
  const copies = s.e.items().filter((i) => i.recipient === "cos" && i.kind === "copy");
  assert.equal(copies.length, 1);
  assert.match(copies[0]!.body, new RegExp(`also settles ${b.id}`));
  assert.equal(s.e.decision(b.id)!.state, "answered", "the duplicate is still answered for its own asker");
});

test("a pasted sign-in code reaches the CoS only as the fact that it was sent, never the file's path", () => {
  const s = setup();
  const d = s.e.ask(s.leadA, { title: "Sign in?", question: "Paste the code", options: three, blocks: [{ kind: "login", service: "Test SSO", url: "https://example.com/device", paste: true }] });
  s.e.triageAskPerson(s.cos, d.id, { question: "Paste the code", options: three, allowText: true });
  s.e.personSecret(d.id, s.e.decision(d.id)!.rev, "/state/secrets/x.txt", "desktop");
  const copy = s.e.items().find((i) => i.recipient === "cos" && i.kind === "copy")!;
  assert.match(copy.body, /pasted a sign-in code/);
  assert.doesNotMatch(copy.body, /secrets/, "the secret file's path stays with the asker");
});

test("a rule answer (no owner involved) sends the CoS no copy", () => {
  const s = setup();
  const d = s.e.ask(s.leadA, { title: "Ship?", question: "Ship it now?", options: three });
  const r = s.e.addRule({ text: "ship when green", project: null, kinds: ["question"], expiresAt: null, source: "test" });
  s.e.triageSettle(s.cos, d.id, r.id, "1", null);
  assert.equal(s.e.items().filter((i) => i.recipient === "cos" && i.kind === "copy").length, 0, "the CoS settled it itself");
});

// ---------------------------------------------------------------- part 2: the CoS's view of Needs you, and moot cards

test("the CoS's Needs-you view lists each waiting card with id, project, asker, title and age, and what the owner chose", () => {
  const s = setup();
  const a = cardUp(s, s.leadA, "Ship?");
  s.advance(2 * 3_600_000);
  const b = cardUp(s, s.leadB, "Rename?");
  s.e.personAnswer(b.id, b.rev, "3", null, "desktop");
  s.advance(5 * 60_000);
  const v = s.e.needsYouView({ since: s.now() - 86_400_000 });
  assert.equal(v.count, 1, "one card still waits on the owner");
  assert.match(v.text, new RegExp(`- ${a.id} \\[alpha\\] "Ship\\?" asked by lead:alpha: waiting 2h 5m`));
  assert.match(v.text, new RegExp(`- ${b.id} \\[beta\\] "Rename\\?" asked by lead:beta: answered 5m ago: option 3 "Drop it"; not acked yet`));
  const alpha = s.e.needsYouView({ since: s.now() - 86_400_000, project: "alpha" });
  assert.doesNotMatch(alpha.text, /Rename/, "the project filter keeps to one project");
});

test("by default the view lists only the last day's answers, newest 20, and limit and since widen it", () => {
  const s = setup();
  const old = cardUp(s, s.leadB, "Last week?");
  s.e.personAnswer(old.id, old.rev, "1", null, "desktop");
  s.advance(2 * 86_400_000);
  for (let n = 0; n < 23; n++) {
    const d = cardUp(s, s.leadA, `Q${n}?`);
    s.advance(1000);
    s.e.personAnswer(d.id, d.rev, "1", null, "desktop");
  }
  // the CoS's default read stays short: a week of answers once ran to 121 cards
  const v = s.e.needsYouView().text;
  assert.match(v, /Answered by Robin since .* \(23\):/, "only the last 24h counts by default");
  assert.doesNotMatch(v, /Last week\?/);
  assert.match(v, /"Q22\?"/, "the newest is in");
  assert.equal((v.match(/: answered /g) ?? []).length, 20, "20 listed");
  assert.doesNotMatch(v, /"Q2\?"/, "older ones are left out");
  assert.match(v, /…and 3 older \(widen with since and limit/);
  const wide = s.e.needsYouView({ since: s.now() - 7 * 86_400_000, limit: 50 }).text;
  assert.equal((wide.match(/: answered /g) ?? []).length, 24, "since and limit widen it, last week's included");
});

test("an answer older than `since` drops out of the view; a still-waiting card never does", () => {
  const s = setup();
  const a = cardUp(s);
  const b = cardUp(s, s.leadB, "Rename?");
  s.e.personAnswer(b.id, b.rev, "1", null, "desktop");
  s.advance(2 * 86_400_000);
  const v = s.e.needsYouView({ since: s.now() - 86_400_000 });
  assert.match(v.text, new RegExp(a.id));
  assert.doesNotMatch(v.text, new RegExp(b.id));
});

test("a moot card leaves Needs you, its asker hears the reason, and the owner's later answer is refused, not sent", async () => {
  const s = setup();
  const d = cardUp(s);
  const seen = d.rev; // the rev the owner's open screen still holds
  await s.e.flush();
  s.sent.length = 0;
  s.e.moot(s.cos, d.id, "PR #12 merged already");
  assert.equal(s.e.needsYou().cards.length, 0, "it is off the owner's board");
  await s.e.flush();
  const notice = to(s, "T-la");
  assert.equal(notice.length, 1);
  assert.match(notice[0]!.text, /cos marked .* moot: "PR #12 merged already"/);
  assert.match(notice[0]!.text, /no answer will come/);
  // the moot bumped the rev, so check both the stale and the fresh one: each must name the moot, not "changed since"
  for (const rev of [seen, s.e.decision(d.id)!.rev]) {
    assert.throws(() => s.e.personAnswer(d.id, rev, "1", null, "desktop"), /marked moot by cos \(PR #12 merged already\)/);
    assert.throws(() => s.e.personDefer(d.id, rev, "1h", s.now() + 3_600_000, "desktop"), /marked moot/);
  }
  const after = s.e.decision(d.id)!;
  assert.equal(after.state, "withdrawn");
  assert.equal(after.answer, null, "nothing was answered");
  assert.equal(s.e.items().filter((i) => i.kind === "decision.answer").length, 0, "no answer ever went out");
  assert.match(s.e.needsYouView({ since: s.now() - 3_600_000 }).text, /moot 0s ago by cos: "PR #12 merged already"/);
});

test("a moot plan card can't start threads: moot is never its go", () => {
  const s = setup();
  const p = s.e.ask(s.leadA, { title: "Plan", question: "Start two threads?", options: [{ label: "Go" }, { label: "No" }], kind: "plan", threads: 2 });
  s.e.triageAskPerson(s.cos, p.id, { question: "Start two threads?", options: [], allowText: false });
  s.e.moot(s.cos, p.id, "superseded by a smaller plan");
  assert.throws(() => s.e.reserveSpawn(s.leadA, p.id), /withdrawn: no go yet/);
});

test("mooting a card also moots the duplicates merged into it, so their askers don't wait forever", async () => {
  const s = setup();
  const a = cardUp(s);
  const b = s.e.ask(s.leadB, { title: "Ship too?", question: "Ship it now?", options: three });
  s.e.triageMerge(s.cos, b.id, a.id);
  s.e.moot(s.cos, a.id, "release cancelled");
  assert.equal(s.e.decision(b.id)!.state, "withdrawn");
  assert.equal(s.e.decision(b.id)!.withdrawn!.moot, true);
  await s.e.flush();
  assert.match(to(s, "T-lb").at(-1)!.text, /moot: .*release cancelled/);
});

test("a card withdrawn while still with its lead (never on Needs you) isn't listed as moot or withdrawn", () => {
  const s = setup();
  s.e.ask(s.worker, { title: "Port?", question: "Which port?", options: three });
  s.e.archiveProject("alpha");
  assert.doesNotMatch(s.e.needsYouView({ since: s.now() - 3_600_000 }).text, /Port\?/);
});

test("only the CoS marks cards moot, only open cards above a lead, and not twice", () => {
  const s = setup();
  const d = cardUp(s);
  assert.throws(() => s.e.moot(s.leadA, d.id, "x"), /only the CoS/);
  assert.throws(() => s.e.moot(s.steward, d.id, "x"), /only the CoS/);
  const q = s.e.ask(s.worker, { title: "Port?", question: "Which port?", options: three });
  assert.throws(() => s.e.moot(s.cos, q.id, "x"), /not on Robin's Needs you/, "a thread's question still with its lead is the lead's");
  s.e.moot(s.cos, d.id, "done");
  assert.throws(() => s.e.moot(s.cos, d.id, "again"), /already moot/);
  const t = cardUp(s, s.leadB, "Answered?");
  s.e.personAnswer(t.id, t.rev, "1", null, "desktop");
  assert.throws(() => s.e.moot(s.cos, t.id, "late"), /answered/, "an answered card can't be un-answered");
});

test("a card still with the CoS for triage can be moot too (it then never escalates)", () => {
  const s = setup();
  const d = s.e.ask(s.leadA, { title: "Ship?", question: "Ship it now?", options: three });
  s.e.moot(s.cos, d.id, "asker withdrew it in chat");
  s.advance(60 * 60_000);
  s.e.tick();
  assert.equal(s.e.decision(d.id)!.state, "withdrawn", "the escalation clock doesn't resurrect it");
  assert.equal(s.e.needsYou().cards.length, 0);
});

// ---------------------------------------------------------------- part 3: the CoS's view of the deliverables

const noFiles = { roots: [] };
const prProof = (n: number) => [{ kind: "pr" as const, caption: `PR ${n}`, url: `https://github.com/acme/app/pull/${n}` }];

test("the deliverables view is the Deliverables tab's own rows: state, the owner's note and proof URLs, per project", () => {
  const s = setup();
  const a = s.e.deliver(s.leadA, { title: "Checkout", summary: "New flow.", proof: prProof(1) }, noFiles);
  s.advance(60_000);
  const b = s.e.deliver(s.leadB, { title: "Search", summary: "Faster.", proof: [{ kind: "link", caption: "Demo", url: "https://example.com/demo" }] }, noFiles);
  s.e.personRequestChanges(a.id, 1, "Add the error state");
  s.e.personApprove(b.id, 1, "lovely");
  const v = s.e.deliverablesView({});
  assert.equal(v.count, 2);
  assert.match(v.text, /alpha \(1\):\n- v-\w+ "Checkout" by lead:alpha, rev 1, changes requested; .*Robin asked for changes to rev 1 .*: "Add the error state"/);
  assert.match(v.text, /  - pr "PR 1": https:\/\/github.com\/acme\/app\/pull\/1/);
  assert.match(v.text, /beta \(1\):\n- v-\w+ "Search" by lead:beta, rev 1, approved; .*Robin approved rev 1 .*: "lovely"/);
  // the owner's write is the only source: re-delivery shows at once, with the new revision's proof only
  s.e.deliver(s.leadA, { title: "Checkout", summary: "With the error state.", proof: prProof(2), revises: a.id }, noFiles);
  const after = s.e.deliverablesView({ project: "alpha" }).text;
  assert.match(after, /rev 2, in review/);
  assert.match(after, /pull\/2/);
  assert.doesNotMatch(after, /pull\/1\b/, "the proof shown is the latest revision's");
});

test("the deliverables view filters by state and by since", () => {
  const s = setup();
  const old = s.e.deliver(s.leadA, { title: "Old", summary: "x", proof: prProof(1) }, noFiles);
  s.e.personApprove(old.id, 1, null);
  s.advance(3 * 86_400_000);
  s.e.deliver(s.leadB, { title: "New", summary: "y", proof: prProof(2) }, noFiles);
  assert.equal(s.e.deliverablesView({ state: "approved" }).count, 1);
  assert.equal(s.e.deliverablesView({ state: "review" }).count, 1);
  const recent = s.e.deliverablesView({ since: s.now() - 86_400_000 });
  assert.equal(recent.count, 1);
  assert.match(recent.text, /"New"/);
});

// ---------------------------------------------------------------- part 5: the CoS manages the dead letters

/** Mail from `from` to a lead that then retires with nobody taking its address: a dead letter at once. */
function deadTo(s: S, text: string) {
  const extra = s.e.register(`T-x${s.e.items().length}`, "lead", `gone${s.e.items().length}`);
  const m = s.e.send(s.cos, extra.address, text, null);
  s.e.retire(extra.threadId);
  return s.e.items().find((i) => i.id === m.id)!;
}
const wakes = (s: S) => s.e.items().filter((i) => i.recipient === "cos" && i.sender === "orchestrator" && i.body.includes("new dead letter")).reverse(); // oldest first

test("a new dead letter goes to the CoS's list, not the owner's board", () => {
  const s = setup();
  const it = deadTo(s, "Rotate the key.");
  assert.equal(it.state, "dead");
  assert.equal(s.e.deadLetters({ board: true }).length, 0, "the owner's board shows no new dead letter");
  assert.equal(s.e.board().filter((r) => r.kind === "dead").length, 0, "nor an Activity row");
  const list = s.e.deadLettersText(s.cos).text;
  assert.match(list, new RegExp(`${it.id} message cos → lead:gone\\d+, died 0s ago: .*no live agent`));
  assert.throws(() => s.e.deadLettersText(s.leadA), /only the CoS/);
});

test("the hourly wake carries only the dead letters new since the last one, and a check with nothing new sends nothing", async () => {
  const s = setup();
  s.e.tick(); // the first check after install: nothing has died, nothing is sent
  assert.equal(wakes(s).length, 0);
  const a = deadTo(s, "first");
  const b = deadTo(s, "second"); // the same millisecond: a time cursor would lose one of them
  s.e.tick();
  assert.equal(wakes(s).length, 0, "not before an hour has passed since the last check");
  s.advance(DLQ_WAKE_MS);
  s.e.tick();
  assert.equal(wakes(s).length, 1, "one item for the batch");
  const w1 = wakes(s)[0]!;
  assert.equal(w1.needsAck, false);
  assert.match(w1.body, /^2 new dead letters/);
  assert.ok(w1.body.includes(a.id) && w1.body.includes(b.id), "both same-ms deaths are in it");
  await s.e.flush();
  assert.ok(s.sent.some((x) => x.threadId === "T-cos" && x.item.id === w1.id), "it wakes the CoS");
  s.advance(DLQ_WAKE_MS);
  s.e.tick();
  assert.equal(wakes(s).length, 1, "nothing new: nothing sent, though both are still dead");
  const c = deadTo(s, "third");
  s.advance(DLQ_WAKE_MS);
  s.e.tick();
  const w2 = wakes(s)[1]!;
  assert.match(w2.body, /^1 new dead letter since/);
  assert.ok(w2.body.includes(c.id) && !w2.body.includes(a.id) && !w2.body.includes(b.id), "only the new one");
});

test("with no live CoS the wake sends nothing and keeps its cursor, so the next CoS hears them", () => {
  const s = setup();
  const it = deadTo(s, "orphan");
  s.e.retire("T-cos");
  s.advance(DLQ_WAKE_MS);
  s.e.tick();
  assert.equal(s.e.items().filter((i) => i.recipient === "cos" && i.body.includes("new dead letter")).length, 0);
  const cos2 = s.e.register("T-cos2", "cos", null);
  s.advance(DLQ_WAKE_MS);
  s.e.tick();
  const w = wakes(s);
  assert.equal(w.length, 1);
  assert.ok(w[0]!.body.includes(it.id));
  assert.equal(cos2.address, "cos");
});

test("escalating puts the dead letter on the owner's board with the CoS's note; only escalated ones reach it", () => {
  const s = setup();
  const keep = deadTo(s, "Rotate the key.");
  const other = deadTo(s, "Unimportant.");
  s.e.escalateDead(s.cos, keep.id, "Only Robin can rotate the prod key");
  const board = s.e.deadLetters({ board: true });
  assert.deepEqual(board.map((i) => i.id), [keep.id], "only the escalated one");
  assert.match(board[0]!.note!, /^CoS: Only Robin can rotate the prod key \(it died: .*no live agent/);
  const row = s.e.board().find((r) => r.kind === "dead")!;
  assert.equal(row.ref, keep.id);
  assert.equal(row.from, "cos");
  assert.match(row.body, /Only Robin can rotate the prod key/);
  assert.throws(() => s.e.escalateDead(s.cos, keep.id, "again"), /already on Robin's board/);
  assert.throws(() => s.e.escalateDead(s.leadA, other.id, "x"), /only the CoS/);
  // the owner's resend from the board still works as before
  assert.throws(() => s.e.resend(keep.id), /no live agent/, "its recipient is gone; the board says so");
});

test("the CoS re-routes a dead letter; the new recipient's ack and note still reach the original sender", async () => {
  const s = setup();
  const it = deadTo(s, "Please rebase.");
  s.e.reroute(s.cos, it.id, "lead:alpha", "gone's work moved to alpha");
  await s.e.flush();
  const got = to(s, "T-la").find((x) => x.item.id === it.id)!;
  assert.match(got.text, /\(re-routed by the CoS from lead:gone\d+: gone's work moved to alpha\) Please rebase\./);
  s.e.ack(s.leadA, it.id, "done", "rebased");
  assert.ok(s.e.items().some((i) => i.recipient === "cos" && i.kind === "notice" && /acked your message .*rebased/.test(i.body)));
  assert.throws(() => s.e.reroute(s.cos, it.id, "lead:beta", null), /not a dead letter/);
  // a dead answer names its decision, which only its asker can ack: re-routed it would only die again
  const d = s.e.ask(s.leadB, { title: "B?", question: "B?", options: three });
  s.e.triageAskPerson(s.cos, d.id, { question: "B?", options: three, allowText: true });
  s.e.retire("T-lb");
  s.e.personAnswer(d.id, s.e.decision(d.id)!.rev, "1", null, "desktop");
  s.e.tick();
  const ans = s.e.items().find((i) => i.kind === "decision.answer" && i.ref === d.id)!;
  assert.equal(ans.state, "dead");
  assert.throws(() => s.e.reroute(s.cos, ans.id, "lead:alpha", null), /decision.answer: only lead:beta can act on it/);
  assert.throws(() => s.e.reroute(s.cos, deadTo(s, "x").id, "lead:nobody", null), /no live agent/);
});

test("the CoS closes a dead letter for its recipient, and the sender hears the outcome", async () => {
  const s = setup();
  const m = s.e.send(s.leadA, s.leadB.address, "Pair on the migration?", null);
  s.e.retire("T-lb");
  assert.equal(s.e.items().find((i) => i.id === m.id)!.state, "dead");
  s.e.closeDead(s.cos, m.id, "superseded", "beta was archived");
  const closed = s.e.items().find((i) => i.id === m.id)!;
  assert.equal(closed.state, "closed");
  assert.equal(closed.outcome, "superseded");
  await s.e.flush();
  assert.match(to(s, "T-la").at(-1)!.text, /lead:beta never took your message .*cos closed it for them: superseded, note: "beta was archived"/);
});

test("the CoS's resend works like the board's but adds no row to the owner's board", async () => {
  const s = setup();
  s.e.send(s.cos, s.leadA.address, "Check CI.", null);
  await s.e.flush();
  for (let n = 0; n < 2; n++) {
    s.e.setStatus("T-la", "idle");
    s.advance(10 * 60_000);
    s.e.tick();
    await s.e.flush();
  }
  s.e.setStatus("T-la", "idle");
  s.advance(10 * 60_000);
  s.e.tick();
  const dead = s.e.deadLetters()[0]!;
  assert.equal(dead.state, "dead");
  const rows = s.e.board().length;
  s.e.resend(dead.id, "cos");
  assert.equal(s.e.board().length, rows, "no board row for the CoS's own resend");
  assert.equal(s.e.items().find((i) => i.id === dead.id)!.state, "pending");
});

test("dead letters already on the owner's board when this ships stay there", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE _migrations (id INTEGER PRIMARY KEY)`);
  MIGRATIONS.slice(0, 15).forEach((sql, i) => {
    db.exec(sql);
    db.prepare(`INSERT INTO _migrations (id) VALUES (?)`).run(i);
  });
  db.prepare(`INSERT INTO items (id, recipient, sender, kind, body, needs_ack, state, attempts, created_at, note) VALUES ('i-old', 'lead:x', 'cos', 'message', 'old', 1, 'dead', 2, 1, 'unacked after 2 deliveries')`).run();
  db.prepare(`INSERT INTO items (id, recipient, sender, kind, body, needs_ack, state, attempts, created_at) VALUES ('i-live', 'lead:x', 'cos', 'message', 'live', 1, 'delivered', 1, 1)`).run();
  const e = new Engine(db as never, { now: () => 2, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { batchInbox: false });
  assert.deepEqual(e.deadLetters({ board: true }).map((i) => i.id), ["i-old"], "the old one stays on the board");
  assert.equal(e.items().find((i) => i.id === "i-live")!.onBoard, false);
});
