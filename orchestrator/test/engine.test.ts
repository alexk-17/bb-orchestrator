// The engine's rules, each test named for the promise it keeps (docs/orchestrator-spec.md, "Phase 1: done when").
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, type DeliverResult } from "../core/engine.ts";
import type { Decision, Item } from "../core/model.ts";

function setup(opts: { hold?: Set<string> } = {}) {
  let clock = Date.parse("2026-11-13T10:00:00Z");
  const sent: { threadId: string; text: string; item: Item }[] = [];
  const mirrored = new Map<string, Decision>();
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, {
    now: () => clock,
    async deliver(threadId, text, item): Promise<DeliverResult> {
      if (opts.hold?.has(threadId)) return { delivery: "held", why: "stopped" };
      sent.push({ threadId, text, item });
      return { delivery: "sent" };
    },
    mirror: (d) => mirrored.set(d.id, structuredClone(d)),
    changed: () => {},
    log: () => {},
  }, { batchInbox: false });
  const cos = e.register("T-cos", "cos", null);
  const steward = e.register("T-st", "steward", null);
  const leadA = e.register("T-la", "lead", "alpha");
  const leadB = e.register("T-lb", "lead", "beta");
  const worker = e.register("T-w1", "thread", "alpha", "T-la");
  return { e, cos, steward, leadA, leadB, worker, sent, mirrored, advance: (ms: number) => (clock += ms), now: () => clock };
}

const three = [{ label: "Ship it" }, { label: "Wait" }, { label: "Drop it" }];

test("a thread's question goes to its lead, never straight to the CoS or the owner", async () => {
  const s = setup();
  const d = s.e.ask(s.worker, { title: "Ship?", question: "Ship the thing?", options: three });
  await s.e.flush();
  assert.deepEqual(s.sent.map((x) => x.threadId), ["T-la"]);
  assert.equal(s.e.needsYou().cards.length, 0);
  assert.equal(s.mirrored.has(d.id), false, "lead-level questions are not mirrored as decisions for the owner");
});

test("check 1+2: thread asks, lead files up, CoS asks the owner, one answer reaches only the lead, thread acks with outcome", async () => {
  const s = setup();
  const d = s.e.ask(s.worker, { title: "Ship?", question: "Ship the thing?", options: three });
  s.e.forward(s.leadA, d.id, null);
  await s.e.flush();
  assert.equal(s.sent.at(-1)!.threadId, "T-cos");
  assert.equal(s.e.needsYou().triaging.length, 1, "shows as being triaged at once");
  s.e.triageAskPerson(s.cos, d.id, { question: "alpha: ship the thing now?", options: three, allowText: true });
  const card = s.e.needsYou().cards[0]!;
  assert.equal(card.ask!.options[0]!.recommended, true);
  assert.equal(card.ask!.options[0]!.label, "Ship it");
  s.sent.length = 0;
  s.e.personAnswer(d.id, card.rev, "1", null, "desktop");
  await s.e.flush();
  assert.deepEqual(s.sent.filter((x) => x.item.kind === "decision.answer").map((x) => x.threadId), ["T-la"], "the answer goes to the asker (the lead) only");
  assert.deepEqual(s.sent.filter((x) => x.item.kind !== "decision.answer").map((x) => [x.threadId, x.item.kind]), [["T-cos", "copy"]], "the CoS gets only a read-only copy (2026-11-15)");
  assert.equal(s.e.needsYou().cards.length, 0, "the badge drops");
  // the lead relays it; the thread acks the relay it got, the lead (the asker) acks the decision
  const relay = s.e.send(s.leadA, s.worker.address, "The owner says ship it.", null, d.id);
  s.e.ack(s.worker, relay.id, "done", "shipped");
  assert.equal(s.e.inbox(s.worker).count, 0, "acking the relay closes it");
  s.e.ack(s.leadA, d.id, "done", "relayed");
  const after = s.e.decision(d.id)!;
  assert.equal(after.state, "acked");
  assert.equal(after.ack!.outcome, "done");
  assert.equal(after.ack!.by, s.leadA.address);
  assert.equal(s.mirrored.get(d.id)!.state, "acked", "the mirror follows");
  await s.e.flush(); // the thread's ack note ("shipped") reaches the lead as info and closes on delivery
  assert.equal(s.e.inbox(s.leadA).count, 0, "the lead's answer item closes with its ack");
});

test("a lead settles from a project rule; a rule for another project is refused", async () => {
  const s = setup();
  const d = s.e.ask(s.worker, { title: "Ship?", question: "Ship the thing?", options: three });
  const other = s.e.addRule({ text: "beta ships", project: "beta", kinds: ["question"], expiresAt: null, source: "test" });
  assert.throws(() => s.e.leadAnswer(s.leadA, d.id, other.id, "1", null), /covers beta/);
  const r = s.e.addRule({ text: "alpha ships when green", project: "alpha", kinds: ["question"], expiresAt: null, source: "test" });
  s.e.leadAnswer(s.leadA, d.id, r.id, "1", null);
  assert.equal(s.e.decision(d.id)!.answer!.source, `rule ${r.id}`);
});

test("check 10: the CoS can't settle a merge card, even citing a rule", () => {
  const s = setup();
  const r = s.e.addRule({ text: "anything", project: null, kinds: ["question", "plan"], expiresAt: null, source: "test" });
  const d = s.e.ask(s.leadA, { title: "Merge PR 12?", question: "Merge PR 12 now?", options: [{ label: "Merge" }, { label: "Wait" }], action: "merge" });
  assert.throws(() => s.e.triageSettle(s.cos, d.id, r.id, "1", null), /merge card/);
  assert.equal(s.e.decision(d.id)!.state, "open");
});

test("an expired rule can't settle", () => {
  const s = setup();
  const r = s.e.addRule({ text: "x", project: null, kinds: ["question"], expiresAt: s.now() + 1000, source: "test" });
  const d = s.e.ask(s.leadA, { title: "Q?", question: "Q?", options: three });
  s.advance(2000);
  assert.throws(() => s.e.triageSettle(s.cos, d.id, r.id, "1", null), /expired/);
});

test("check 5: a decision the CoS ignores reaches the owner within 5 minutes, as the lead wrote it", () => {
  const s = setup();
  const d = s.e.ask(s.leadA, { title: "Q?", question: "The lead's words?", options: three });
  s.advance(4 * 60_000);
  s.e.tick();
  assert.equal(s.e.needsYou().cards.length, 0);
  s.advance(60_000);
  s.e.tick();
  const c = s.e.needsYou().cards[0]!;
  assert.equal(c.id, d.id);
  assert.equal(c.ask!.question, "The lead's words?");
  assert.match(c.ask!.context, /CoS didn't triage/);
  assert.equal(c.ask!.options[0]!.recommended, true);
});

test("check 6: lead A to lead B arrives once, and the CoS gets one read-only copy", async () => {
  const s = setup();
  s.e.send(s.leadA, "lead:beta", "Can you rebase on mine?", "k1");
  s.e.send(s.leadA, "lead:beta", "Can you rebase on mine?", "k1"); // a retry with the same key
  await s.e.flush();
  assert.deepEqual(s.sent.map((x) => [x.threadId, x.item.kind]), [["T-lb", "message"], ["T-cos", "copy"]]);
  assert.match(s.sent[1]!.text, /Read-only copy/);
});

test("the route table: a thread messages only its lead", () => {
  const s = setup();
  assert.throws(() => s.e.send(s.worker, "cos", "hi", null), /only its lead/);
  assert.throws(() => s.e.send(s.worker, "lead:beta", "hi", null), /only its lead/);
  s.e.send(s.worker, "lead:alpha", "hi", null);
});

test("check 7: a message to a stopped thread waits for its start, then goes once; unacked it is resent once, then dead", async () => {
  const hold = new Set(["T-w1"]);
  const s = setup({ hold });
  const it = s.e.send(s.leadA, s.worker.address, "Do X", null);
  await s.e.flush();
  assert.equal(s.sent.length, 0, "held while stopped");
  hold.delete("T-w1");
  await s.e.flush();
  await s.e.flush();
  assert.equal(s.sent.length, 1, "delivered once when it started");
  s.e.setStatus("T-w1", "idle");
  s.advance(10 * 60_000);
  s.e.tick();
  await s.e.flush();
  assert.equal(s.sent.length, 2);
  assert.match(s.sent[1]!.text, /\(again\)/);
  s.e.setStatus("T-w1", "idle");
  s.advance(10 * 60_000);
  s.e.tick();
  assert.equal(s.e.deadLetters()[0]!.id, it.id);
  await s.e.flush();
  assert.match(s.sent.at(-1)!.text, /dead letter/, "its supervisor (the lead) is told");
  assert.equal(s.sent.at(-1)!.threadId, "T-la");
  s.e.resend(it.id);
  await s.e.flush();
  assert.equal(s.sent.at(-1)!.threadId, "T-w1");
});

test("an unacked message is not resent once its sender's newer mail went out: a late resend would undo the newer word", async () => {
  // 2026-11-13: thread:agent-v2:9 got its lead's "squash then QA" again 63 min late, after five newer messages from
  // the lead had been acked, and closed it as superseded 5 s later.
  const s = setup();
  const old = s.e.send(s.leadA, s.worker.address, "Squash, then QA", null);
  await s.e.flush();
  s.advance(60_000);
  const newer = s.e.send(s.leadA, s.worker.address, "Change of plan: QA first", null);
  await s.e.flush();
  s.e.ack(s.worker, newer.id, "done", null);
  s.e.setStatus("T-w1", "idle");
  s.advance(10 * 60_000);
  s.sent.length = 0;
  s.e.tick();
  await s.e.flush();
  assert.equal(s.sent.length, 0, "the old message is not delivered again");
  const it = s.e.items().find((x) => x.id === old.id)!;
  assert.equal(it.state, "closed");
  assert.equal(it.outcome, "superseded");
  assert.match(it.note ?? "", new RegExp(newer.id));
  assert.equal(s.e.deadLetters().length, 0, "superseded is not a dead letter: nobody needs to resend it");
});

test("other senders' mail doesn't supersede: an unacked message is still resent when only someone else wrote since", async () => {
  const s = setup();
  s.e.send(s.leadA, s.worker.address, "Do X", null);
  await s.e.flush();
  s.advance(60_000);
  const notice = s.e.send(s.worker, "lead:alpha", "unrelated", null); // the other direction, a different sender
  await s.e.flush();
  s.e.ack(s.leadA, notice.id, "done", null);
  s.e.setStatus("T-w1", "idle");
  s.advance(10 * 60_000);
  s.sent.length = 0;
  s.e.tick();
  await s.e.flush();
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0]!.text, /\(again\): Do X/);
});

test("defer takes a card out of the queue and tells the asker once; it comes back at its time, at the top", async () => {
  const s = setup();
  const a = s.e.ask(s.leadA, { title: "A?", question: "A?", options: three });
  const b = s.e.ask(s.leadA, { title: "B?", question: "B?", options: three });
  for (const d of [a, b]) s.e.triageAskPerson(s.cos, d.id, { question: "q", options: three, allowText: true });
  const rev = s.e.decision(a.id)!.rev;
  s.e.personDefer(a.id, rev, "1h", s.now() + 3600_000, "desktop");
  assert.deepEqual(s.e.needsYou().cards.map((c) => c.id), [b.id]);
  assert.throws(() => s.e.personDefer(a.id, rev, "1h", s.now() + 3600_000, "desktop"), /changed/);
  s.advance(3600_000);
  s.e.tick();
  assert.deepEqual(s.e.needsYou().cards.map((c) => c.id), [a.id, b.id], "back on top");
});

test("a note-only answer works when allowed; the first answer wins", () => {
  const s = setup();
  const d = s.e.ask(s.leadA, { title: "A?", question: "A?", options: three });
  s.e.triageAskPerson(s.cos, d.id, { question: "q", options: three, allowText: true });
  const rev = s.e.decision(d.id)!.rev;
  s.e.personAnswer(d.id, rev, null, "Do neither; ping me tomorrow", "desktop");
  assert.equal(s.e.decision(d.id)!.answer!.text, "Do neither; ping me tomorrow");
  assert.throws(() => s.e.personAnswer(d.id, rev, "1", null, "desktop"), /changed/);
});

test("merged duplicates each get the answer, each at its own asker", async () => {
  const s = setup();
  const a = s.e.ask(s.leadA, { title: "Rebase?", question: "Rebase?", options: three });
  const b = s.e.ask(s.leadB, { title: "Rebase?", question: "Rebase too?", options: three });
  s.e.triageAskPerson(s.cos, a.id, { question: "q", options: three, allowText: true });
  s.e.triageMerge(s.cos, b.id, a.id);
  s.e.personAnswer(a.id, s.e.decision(a.id)!.rev, "2", null, "desktop");
  assert.equal(s.e.decision(b.id)!.state, "answered");
  await s.e.flush();
  const answers = s.sent.filter((x) => x.item.kind === "decision.answer").map((x) => x.threadId).sort();
  assert.deepEqual(answers, ["T-la", "T-lb"]);
});

test("only the asker or the original thread acks a decision", () => {
  const s = setup();
  const d = s.e.ask(s.leadA, { title: "A?", question: "A?", options: three });
  s.e.triageAskPerson(s.cos, d.id, { question: "q", options: three, allowText: true });
  s.e.personAnswer(d.id, s.e.decision(d.id)!.rev, "1", null, "desktop");
  assert.throws(() => s.e.ack(s.cos, d.id, "done", null), /only lead:alpha/);
});

test("the CoS's inbox lists what waits for its triage (its recovery view)", () => {
  const s = setup();
  s.e.ask(s.leadA, { title: "Needs triage?", question: "Q?", options: three });
  const v = s.e.inbox(s.cos);
  assert.match(v.text, /Waiting for your triage \(1\)/);
  assert.match(v.text, /Needs triage\?/);
});

test("a retired CoS doesn't block the next one, and two live agents still can't share an address", () => {
  const s = setup();
  s.e.retire("T-cos");
  const next = s.e.register("T-cos2", "cos", null);
  assert.equal(next.address, "cos", "The owner's real CoS takes the address the test CoS left");
  assert.throws(() => s.e.register("T-cos3", "cos", null), /already taken/);
});

test("archiving a stopped agent records it as archived: stopped sticks through idle, not through an archive", () => {
  const s = setup();
  s.e.setStatus("T-w1", "stopped");
  s.e.setStatus("T-w1", "idle");
  assert.equal(s.e.agentByThread("T-w1")!.status, "stopped", "stopped sticks through idle");
  s.e.setStatus("T-w1", "archived");
  // an archived worker thread is retired at once (2026-11-15): its row keeps the archived status
  assert.equal(s.e.agentByThread("T-w1"), null);
  assert.equal(s.e.agents().some((a) => a.threadId === "T-w1"), false);
});

test("a lead that is the worker's bb parent hears each finished turn once: from bb, not again from us", () => {
  const s = setup();
  const w = s.e.agentByThread("T-w1")!;
  assert.equal(s.e.bbTellsSupervisor(w, "T-la", "auto", "turn"), true, "bb's own child report already wakes the lead");
  assert.equal(s.e.bbTellsSupervisor(w, "T-la", "stuck", "turn"), false, "bb stays quiet on a normal turn: we tell the lead");
  assert.equal(s.e.bbTellsSupervisor(w, "T-la", "stuck", "failure"), true);
  assert.equal(s.e.bbTellsSupervisor(w, "T-la", "off", "failure"), false);
  assert.equal(s.e.bbTellsSupervisor(w, null, "auto", "turn"), false, "no bb parent: only we can tell the lead");
  assert.equal(s.e.bbTellsSupervisor(w, "T-other", "auto", "turn"), false, "bb tells someone else: the lead still needs our notice");
});

/** A thread's question, forwarded by its lead, put to the owner and answered: the answer item sits with the lead. */
async function forwardedAndAnswered(s: ReturnType<typeof setup>) {
  const d = s.e.ask(s.worker, { title: "Ship?", question: "Ship the thing?", options: three });
  s.e.forward(s.leadA, d.id, null);
  s.e.triageAskPerson(s.cos, d.id, { question: "ship?", options: three, allowText: true });
  s.e.personAnswer(d.id, s.e.decision(d.id)!.rev, "1", null, "desktop");
  await s.e.flush();
  return d;
}

test("a lead acking a decision never closes its relay to the thread: the thread must still receive and handle it", async () => {
  const s = setup();
  const d = await forwardedAndAnswered(s);
  // ROLE_BRIEF order: relay, then ack
  const relay = s.e.send(s.leadA, s.worker.address, "The owner says ship it.", null, d.id);
  s.e.ack(s.leadA, d.id, "done", null);
  await s.e.flush();
  assert.ok(s.sent.some((x) => x.threadId === "T-w1" && x.item.id === relay.id), "the relay is delivered, not closed undelivered");
  assert.match(s.sent.find((x) => x.item.id === relay.id)!.text, new RegExp(`ack id=${relay.id}`), "the relay tells the thread to ack the relay itself");
  assert.equal(s.e.ack(s.worker, relay.id, "done", null), `${relay.id} closed: done`, "so the thread's ack closes it, and it is never re-sent or dead-lettered");
});

test("after a forward, only the lead acks the decision: the thread can't close the lead's pending answer", async () => {
  const s = setup();
  const d = await forwardedAndAnswered(s);
  assert.throws(() => s.e.ack(s.worker, d.id, "done", null), /only lead:alpha acks/);
  assert.equal(s.e.decision(d.id)!.state, "answered", "still the lead's to act on");
  assert.ok(s.e.inbox(s.leadA).text.includes("decision.answer"), "the lead's answer item stays open");
  assert.doesNotMatch(s.e.inbox(s.worker).text, /ack it/, "the thread isn't told to ack what it can't");
});

test("a plan or merge card can't be merged into a question: the CoS must never approve threads or merges by settling a duplicate", () => {
  const s = setup();
  const rule = s.e.addRule({ text: "alpha questions: option 1", project: "alpha", kinds: ["question"], expiresAt: null, source: "test" });
  const q = s.e.ask(s.leadA, { title: "Q?", question: "Rebase?", options: three });
  const plan = s.e.ask(s.leadA, { title: "Plan?", question: "Start 5 threads?", options: three, kind: "plan", threads: 5 });
  assert.throws(() => s.e.triageMerge(s.cos, plan.id, q.id), /plan card is never merged/);
  s.e.triageSettle(s.cos, q.id, rule.id, "1", null);
  assert.equal(s.e.decision(plan.id)!.state, "open", "the plan still waits for the owner");
  assert.throws(() => s.e.reserveSpawn(s.leadA, plan.id), /no go yet/, "no threads start without the owner's go");
  const q2 = s.e.ask(s.leadA, { title: "Q2?", question: "Rebase again?", options: three });
  const mergeCard = s.e.ask(s.leadB, { title: "Merge?", question: "Merge PR 7?", options: three, action: "merge" });
  assert.throws(() => s.e.triageMerge(s.cos, mergeCard.id, q2.id), /merge card is never merged/);
  const mergeCard2 = s.e.ask(s.leadA, { title: "Merge?", question: "Merge PR 8?", options: three, action: "merge" });
  s.e.triageAskPerson(s.cos, mergeCard2.id, { question: "merge PR 8?", options: three, allowText: false });
  assert.throws(() => s.e.triageMerge(s.cos, mergeCard.id, mergeCard2.id), /merge card is never merged/, "The owner's yes to PR 8 must not merge PR 7");
  const plan2 = s.e.ask(s.leadB, { title: "Plan B?", question: "Start?", options: three, kind: "plan" });
  assert.throws(() => s.e.triageMerge(s.cos, plan2.id, plan.id), /plan card is never merged/, "not even into another plan");
  const q3 = s.e.ask(s.leadB, { title: "Q3?", question: "Rebase too?", options: three });
  assert.equal(s.e.triageMerge(s.cos, q3.id, q2.id).state, "merged", "a true duplicate question still merges");
});

test("an answer to a lead that retired becomes a dead letter, never mail for the next lead:alpha", async () => {
  const s = setup();
  const d = s.e.ask(s.leadA, { title: "A?", question: "A?", options: three });
  s.e.triageAskPerson(s.cos, d.id, { question: "q", options: three, allowText: true });
  s.e.retire("T-la");
  s.e.personAnswer(d.id, s.e.decision(d.id)!.rev, "1", null, "desktop");
  s.e.tick();
  const answer = s.e.items().find((i) => i.kind === "decision.answer" && i.ref === d.id)!;
  assert.equal(answer.state, "dead", "a dead letter (the CoS's to handle) instead of waiting forever");
  assert.throws(() => s.e.resend(answer.id), /no live agent/, "a resend to nobody would only die again");
  s.e.register("T-la2", "lead", "alpha");
  await s.e.flush();
  assert.ok(!s.sent.some((x) => x.threadId === "T-la2"), "the new lead never gets the old lead's answer");
  s.e.resend(answer.id);
  await s.e.flush();
  assert.ok(s.sent.some((x) => x.threadId === "T-la2" && x.item.id === answer.id), "unless the owner resends it");
});

test("retiring a role turns its waiting mail into dead letters at once, so a quick re-register can't inherit it", async () => {
  const s = setup();
  const pending = s.e.send(s.leadA, "cos", "status?", null);
  s.e.retire("T-cos");
  assert.equal(s.e.items().find((i) => i.id === pending.id)!.state, "dead");
  s.e.register("T-cos2", "cos", null);
  await s.e.flush();
  assert.ok(!s.sent.some((x) => x.threadId === "T-cos2"));
});

// Requested 2026-11-13: "release projects to the wild from their leads" = archive a finished project. What matters: the
// project's agents stop being addressable at once, nothing they were sent turns into dead letters the owner is asked to
// resend, its unanswered cards leave his queue, and nothing of another project is touched.
test("archiving a project retires its lead and threads, closes their mail as superseded and withdraws only their open cards", () => {
  const s = setup();
  const alphaQ = s.e.ask(s.worker, { title: "Ship?", question: "Ship the thing?", options: three });
  const betaQ = s.e.ask(s.leadB, { title: "Beta?", question: "Go on with beta?", options: three });
  s.e.send(s.leadB, s.leadA.address, "beta has a question for you", null, null);
  s.e.send(s.leadA, s.worker.address, "keep going", null, null);
  s.e.send(s.leadA, s.leadB.address, "alpha says hi", null, null);

  const { threadIds } = s.e.archiveProject("alpha");
  assert.deepEqual([...threadIds].sort(), ["T-la", "T-w1"]);
  assert.deepEqual(s.e.agents().map((a) => a.address).sort(), ["cos", "lead:beta", "steward"]);
  const toAlpha = s.e.items().filter((i) => i.recipient === "lead:alpha" || i.recipient === s.worker.address);
  assert.ok(toAlpha.length >= 2);
  for (const i of toAlpha) assert.equal(i.state, "closed", `${i.id} to ${i.recipient} is closed`);
  assert.ok(toAlpha.every((i) => i.outcome === "superseded"), "closed as superseded, not dead letters to resend");
  assert.equal(s.e.items().filter((i) => i.state === "dead").length, 0);
  assert.notEqual(s.e.items().find((i) => i.recipient === "lead:beta" && i.sender === "lead:alpha")!.state, "closed", "mail to another project still goes");
  assert.equal(s.e.decision(alphaQ.id)!.state, "withdrawn");
  assert.equal(s.e.decision(alphaQ.id)!.withdrawn!.reason, "project archived");
  assert.notEqual(s.e.decision(betaQ.id)!.state, "withdrawn", "another project's card stays");
  assert.ok(s.e.project("alpha")!.archivedAt);
  assert.throws(() => s.e.archiveProject("alpha"), /already archived/);
  assert.throws(() => s.e.archiveProject("nope"), /no project/);
});

test("starting an archived project's lead brings the project back", () => {
  const s = setup();
  s.e.setHold("alpha", true);
  s.e.archiveProject("alpha");
  assert.equal(s.e.project("alpha")!.heldAt, null, "archiving clears the hold, so Start lead isn't refused");
  assert.equal(s.e.checkStart("lead", "alpha"), "lead:alpha");
  s.e.registerStarted("T-la2", "lead", "alpha");
  assert.equal(s.e.project("alpha")!.archivedAt, null);
  assert.equal(s.e.liveAt("lead:alpha")!.threadId, "T-la2");
  s.e.archiveProject("alpha");
  s.e.register("T-la3", "lead", "alpha");
  assert.equal(s.e.project("alpha")!.archivedAt, null, "a lead given its role by hand brings it back too");
});

test("archiving withdraws its cards that already went up: nothing more reaches the CoS or Needs you", async () => {
  const s = setup();
  const upQ = s.e.ask(s.worker, { title: "Up?", question: "Forwarded to the CoS", options: three });
  s.e.forward(s.leadA, upQ.id, null);
  const askedQ = s.e.ask(s.leadA, { title: "Asked?", question: "Put to the owner", options: three });
  await s.e.flush();
  s.e.triageAskPerson(s.cos, askedQ.id, { question: "alpha: go?", options: three, allowText: true });
  const deferredQ = s.e.ask(s.leadA, { title: "Later?", question: "Deferred", options: three });
  await s.e.flush();
  s.e.triageAskPerson(s.cos, deferredQ.id, { question: "alpha: later?", options: three, allowText: false });
  s.e.personDefer(deferredQ.id, s.e.decision(deferredQ.id)!.rev, "1h", s.now() + 3_600_000, "desktop");
  assert.equal(s.e.needsYou().cards.length, 1, "before: one card shown (the other deferred)");

  s.e.archiveProject("alpha");
  for (const id of [upQ.id, askedQ.id, deferredQ.id]) assert.equal(s.e.decision(id)!.state, "withdrawn", id);
  assert.equal(s.e.needsYou().cards.length, 0);
  assert.equal(s.e.needsYou().triaging.length, 0);
  assert.ok(s.e.items().filter((i) => [upQ.id, askedQ.id, deferredQ.id].includes(i.ref ?? "")).every((i) => i.state === "closed"), "the CoS's copies are closed too");
  s.sent.length = 0;
  s.advance(4 * 3_600_000);
  await s.e.tick();
  await s.e.flush();
  assert.deepEqual(s.sent.filter((x) => x.threadId === "T-cos").map((x) => x.text.slice(0, 80)), [], "nothing about alpha reaches the CoS later");
  assert.equal(s.e.needsYou().cards.length, 0, "the deferred card never comes back");
});
