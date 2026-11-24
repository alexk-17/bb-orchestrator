// A lead's structured status (2026-11-16): the owner reads "what step is it on, what is it waiting for" from the project
// page at a glance, so the status must be structured (one current step at most, a typed wait), must survive agents on
// older tool schemas (JSON-string forms, missing fields), must say when it went stale, and the stale reminder must
// reach the lead once per stale period, never as a card and never as a flood from a tick that runs every few seconds.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine } from "../core/engine.ts";
import { ignoredTopLevelUpdate, isStale, normalizeStatus, STATUS_CAPS, STATUS_STALE_MS, statusLine, statusParams, stepHeadline, waitTarget } from "../core/status.ts";

const T0 = Date.parse("2026-11-16T10:00:00Z");
const PR = "https://github.com/o/r/pull/1301";

function setup() {
  const clock = { t: T0 };
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, { now: () => clock.t, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { owner: "Robin" });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "demo");
  // what the tool does: the registered schema parses the raw arguments, then the engine stores them
  const publish = (raw: unknown) => e.publishStatus(lead, statusParams.parse(raw));
  const nudges = () => e.items(500).filter((i) => i.recipient === lead.address && i.body.startsWith("Your status on the project page"));
  // A real turn: mail that needs the lead wakes it, and it reads its digest (2026-11-24: a lead nobody woke since its
  // publish gets no status nudge, since it can't have moved on).
  const realTurn = async (mail = true) => {
    e.setStatus(lead.threadId, "idle");
    if (mail) e.send(cos, lead.address, "next step", null);
    await e.flush();
    clock.t += 2000;
    await e.flush();
    const r = e.batch.read(lead);
    if (r.cursor) e.batch.ack(lead, r.cursor);
  };
  return { e, db, lead, clock, publish, nudges, realTurn, advance: (ms: number) => (clock.t += ms) };
}

const FIVE = [
  { title: "Schema", state: "done" },
  { title: "Engine", state: "done" },
  { title: "Step bar", state: "current" },
  { title: "Proof", state: "next" },
  { title: "Merge", state: "next" },
];

test("arguments sent as JSON strings (an agent on an older schema) are read as the structures they encode", () => {
  const s = setup();
  const st = s.publish({ goal: "Lead status on the project page", steps: JSON.stringify(FIVE), waiting_on: JSON.stringify({ kind: "pr", ref: PR }), blockers: JSON.stringify(["CI is red on main"]) });
  assert.equal(st.steps.length, 5);
  assert.deepEqual(st.waitingOn, { kind: "pr", ref: PR, label: null });
  assert.deepEqual(st.blockers, ["CI is red on main"]);
  assert.equal(statusLine(st, "Robin"), "step 3/5 · waiting on PR 1301", "the Projects line the owner asked for");
  assert.equal(stepHeadline(st), "Step 3 of 5: Step bar");
});

test("plain-string forms work too: a step as its title, a wait as its kind, one blocker as a string, the owner by name", () => {
  const s = setup();
  const st = s.publish({ steps: ["Plan", "Build"], waiting_on: "Robin", blockers: "needs a go" });
  assert.deepEqual(st.steps.map((x) => x.state), ["next", "next"]);
  assert.equal(st.waitingOn.kind, "owner", "the owner's name is the owner kind, so an agent can write it as it says it");
  assert.deepEqual(st.blockers, ["needs a go"]);
  assert.equal(statusLine(st, "Robin"), "next 1/2 · waiting on Robin");
  assert.equal(s.publish({ waiting_on: "ci" }).waitingOn.kind, "ci");
});

test("missing fields keep the last status, so a lead can change only what it waits on; unknown fields are ignored", () => {
  const s = setup();
  s.publish({ goal: "Ship it", steps: FIVE, waiting_on: { kind: "pr", ref: PR }, blockers: ["one"] });
  s.advance(60_000);
  const st = s.publish({ waiting_on: { kind: "thread", ref: "thread:demo:4" }, some_future_field: 1 });
  assert.equal(st.goal, "Ship it");
  assert.equal(stepHeadline(st), "Step 3 of 5: Step bar");
  assert.deepEqual(st.blockers, ["one"]);
  assert.equal(waitTarget(st.waitingOn, "Robin"), "thread 4");
  assert.equal(st.updatedAt, T0 + 60_000, "the server stamps the time");
  // null and [] clear; an empty call re-publishes the same status with a fresh time
  assert.deepEqual(s.publish({ blockers: [], waiting_on: null }).waitingOn, { kind: "none", ref: null, label: null });
  s.advance(60_000);
  const again = s.publish({});
  assert.equal(again.updatedAt, T0 + 120_000);
  assert.equal(again.steps.length, 5);
});

test("the first publish must say something: no goal and no steps is refused", () => {
  const s = setup();
  assert.throws(() => s.publish({}), /nothing to publish/);
  assert.equal(s.e.leadStatus("demo"), null);
});

test("at most one step is current; a refused publish leaves the stored status as it was", () => {
  const s = setup();
  s.publish({ steps: FIVE });
  const two = FIVE.map((x, i) => (i === 3 ? { ...x, state: "current" } : x));
  assert.throws(() => s.publish({ steps: two }), /2 steps are current; at most one is/);
  assert.equal(stepHeadline(s.e.leadStatus("demo")!), "Step 3 of 5: Step bar");
  assert.throws(() => s.publish({ steps: [{ title: "A", state: "maybe" }] }), /not one of done, current, next, skipped/);
});

test("short caps: the refusal names the field, its length and the cap", () => {
  const s = setup();
  assert.throws(() => s.publish({ goal: "x".repeat(STATUS_CAPS.goal + 1), steps: ["A"] }), new RegExp(`goal is ${STATUS_CAPS.goal + 1} characters; the cap is ${STATUS_CAPS.goal}`));
  assert.throws(() => s.publish({ steps: Array.from({ length: STATUS_CAPS.steps + 1 }, (_, i) => `S${i}`) }), /the cap is 8/);
  assert.throws(() => s.publish({ steps: ["x".repeat(STATUS_CAPS.step + 1)] }), /step 1's title is/);
  assert.throws(() => s.publish({ steps: ["A"], blockers: ["a", "b", "c", "d"] }), /4 blockers; the cap is 3/);
  assert.throws(() => s.publish({ steps: ["A"], waiting_on: { kind: "pr", label: "y".repeat(STATUS_CAPS.label + 1) } }), /waiting_on.label is/);
});

test("only a lead publishes, and each publish is a row in the project's event log the timeline still reads", () => {
  const s = setup();
  const thread = s.e.register("T-1", "thread", "demo", "T-lead");
  assert.throws(() => s.e.publishStatus(thread, statusParams.parse({ steps: ["A"] })), /only a lead/);
  s.publish({ steps: FIVE });
  s.publish({ waiting_on: { kind: "ci" } });
  const rows = s.db.prepare(`SELECT value FROM events WHERE kind = 'lead-status' AND project = 'demo' ORDER BY seq`).all() as { value: string }[];
  assert.equal(rows.length, 2);
  assert.equal(JSON.parse(rows[1]!.value).waitingOn.kind, "ci");
  assert.ok(s.e.projectHistory("demo").rows.length >= 1, "the history builder skips the new kind");
});

test("stale means over 2 h since the last publish", () => {
  assert.equal(isStale({ updatedAt: T0 }, T0 + STATUS_STALE_MS), false);
  assert.equal(isStale({ updatedAt: T0 }, T0 + STATUS_STALE_MS + 1), true);
});

test("a lead waiting a day on a PR that doesn't change gets no nudge: nothing happened that its status could miss", () => {
  const s = setup();
  s.e.register("T-1", "thread", "demo", "T-lead");
  s.publish({ steps: FIVE, waiting_on: { kind: "pr", ref: PR } });
  for (let m = 0; m < 24 * 60; m += 10) {
    s.advance(10 * 60_000);
    s.e.tick();
  }
  assert.equal(s.nudges().length, 0, "every nudge wakes the lead and costs tokens");
});

test("a change in the project after the publish nudges a stale status once per change, as an info item", async () => {
  const s = setup();
  const thread = s.e.register("T-1", "thread", "demo", "T-lead");
  s.publish({ steps: FIVE, waiting_on: { kind: "pr", ref: PR } });
  await s.realTurn();
  s.advance(30 * 60_000);
  s.e.setStatus(thread.threadId, "active"); // a thread's state changed
  s.advance(STATUS_STALE_MS - 31 * 60_000);
  s.e.tick();
  assert.equal(s.nudges().length, 0, "not before the status is 2 h old");
  s.advance(2 * 60_000);
  for (let i = 0; i < 5; i++) s.e.tick();
  s.advance(5 * STATUS_STALE_MS);
  s.e.tick();
  const n = s.nudges();
  assert.equal(n.length, 1, "one change, one nudge, however many ticks or hours");
  assert.equal(n[0]!.needsAck, false, "info, never something to ack");
  assert.equal(n[0]!.kind, "notice");
  assert.match(n[0]!.body, /\(step 3\/5 · waiting on PR 1301\), and your project changed/);
  assert.equal(s.e.needsYou().cards.length, 0, "never a card for the owner");
  // a second change, still unpublished: one more nudge
  s.e.register("T-2", "thread", "demo", "T-lead"); // a thread spawned
  s.e.tick();
  assert.equal(s.nudges().length, 2);
  s.e.tick();
  assert.equal(s.nudges().length, 2);
});

test("an answered card counts as a change; the lead's own state changes don't", async () => {
  const s = setup();
  s.publish({ steps: FIVE, waiting_on: "Robin" });
  s.advance(10 * 60_000);
  s.e.setStatus(s.lead.threadId, "idle");
  s.e.setStatus(s.lead.threadId, "active");
  s.advance(STATUS_STALE_MS);
  s.e.tick();
  assert.equal(s.nudges().length, 0, "the lead knows what it did itself");
  const card = s.e.ask(s.lead, { title: "Go?", question: "Go ahead?", options: [{ label: "Yes" }, { label: "No" }] });
  s.e.triageAskPerson(s.e.agentByAddress("cos")!, card.id, { question: "Go ahead?", options: [{ label: "Yes" }, { label: "No" }], allowText: true });
  s.advance(60_000);
  s.e.personAnswer(card.id, s.e.decision(card.id)!.rev, "1", null, "desktop");
  await s.realTurn(false); // the answer itself wakes the lead
  s.e.tick();
  assert.equal(s.nudges().length, 1, "the owner answered: what it waits on likely moved");
});

test("no nudge for a held project or for a lead that never published, whatever changes", () => {
  const held = setup();
  const t = held.e.register("T-1", "thread", "demo", "T-lead");
  held.publish({ steps: FIVE, waiting_on: "ci" });
  held.e.setHold("demo", true);
  held.e.setStatus(t.threadId, "active");
  held.advance(STATUS_STALE_MS + 60_000);
  held.e.tick();
  assert.equal(held.nudges().length, 0);

  const never = setup();
  const t2 = never.e.register("T-1", "thread", "demo", "T-lead");
  never.advance(60_000);
  never.e.setStatus(t2.threadId, "active");
  never.advance(STATUS_STALE_MS * 3);
  never.e.tick();
  assert.equal(never.nudges().length, 0, "it may not have the tool yet (leads see it after a restart)");
});

test("the words for a plan with no current step never say step 0", () => {
  const base = { goal: "", waitingOn: { kind: "none" as const, ref: null, label: null }, blockers: [], updatedAt: T0, by: "lead:demo" };
  const done = normalizeStatus({ steps: [{ title: "A", state: "done" }, { title: "B", state: "skipped" }] }, null, { now: T0, by: "lead:demo", ownerName: "" });
  assert.ok("status" in done);
  assert.equal(stepHeadline(done.status), "All 2 steps done");
  assert.equal(statusLine(done.status, "you"), "done 2/2");
  assert.equal(stepHeadline({ ...base, steps: [{ title: "A", state: "done" }, { title: "B", state: "next" }] }), "Next: step 2 of 2: B");
});

// The Lead status card (2026-11-17): the owner reads the lead's last word on the project, so a new update must replace
// the old one (never pile up), a publish that only moves a step must not wipe it or its time, and null clears it.
test("an update replaces the last one, a publish without one keeps it and its time, null clears it", () => {
  const s = setup();
  s.publish({ goal: "Ship it", steps: FIVE, update: { working_on: ["Engine field", "Card"], at: "tests pass", needs: "a screenshot" } });
  s.advance(60_000);
  const next = s.publish({ update: { working_on: ["Screenshot"], at: "shot taken", needs: "nothing" } });
  assert.deepEqual(next.update, { workingOn: ["Screenshot"], at: "shot taken", needs: "nothing", updateAt: T0 + 60_000 }, "replaced, stamped by the server");
  s.advance(60_000);
  const kept = s.publish({ steps: FIVE.map((x) => ({ ...x, state: "done" })) });
  assert.deepEqual(kept.update, next.update, "a step change keeps the card and when it was said");
  assert.equal(kept.updatedAt, T0 + 120_000);
  assert.equal(s.publish({ update: null }).update, null);
  assert.throws(() => s.publish({ update: { working_on: ["a", "b", "c", "d"], at: "x" } }), /cap is 3/);
});

test("an update sent as a JSON string (an agent on the old schema) is read as the object it encodes", () => {
  const s = setup();
  const st = s.publish({ goal: "g", steps: ["Plan"], update: JSON.stringify({ working_on: JSON.stringify(["One", "Two"]), at: "halfway", needs: "Robin's go" }) });
  assert.deepEqual(st.update?.workingOn, ["One", "Two"]);
  assert.equal(st.update?.needs, "Robin's go");
});

// A lead whose session loaded orch_status before `update` sends working_on, at and needs at the top level; zod used to
// strip them, so the call "succeeded" and the owner's card silently kept the old word. They must land as the update,
// be refused (not dropped) when malformed, and lose to `update` when both are given, with the result saying so.
test("top-level working_on, at and needs (a lead on the schema before update) are the update; malformed ones are refused", () => {
  const s = setup();
  const st = s.publish({ goal: "g", steps: ["Plan"], working_on: JSON.stringify(["Alias", "Fix"]), at: "tests pass", needs: "a review" });
  assert.deepEqual(st.update, { workingOn: ["Alias", "Fix"], at: "tests pass", needs: "a review", updateAt: T0 }, "stored as the card, not stripped");
  assert.throws(() => s.publish({ working_on: ["a", "b", "c", "d"] }), /working_on has 4 bullets; the cap is 3/);
  assert.throws(() => s.publish({ at: "x".repeat(STATUS_CAPS.updateLine + 1) }), /working_on is empty/, "an at without working_on is refused, not dropped");
  assert.throws(() => s.publish({ working_on: "ok", needs: "x".repeat(STATUS_CAPS.updateLine + 1) }), /needs is 141 characters; the cap is 140\. .*shorter, plain words/);
  assert.deepEqual(s.e.leadStatus("demo")?.update?.workingOn, ["Alias", "Fix"], "a refused call keeps the last card");
  const both = statusParams.parse({ update: { working_on: "Inside" }, working_on: "Outside", needs: "n" });
  assert.deepEqual(s.publish(both).update?.workingOn, ["Inside"], "update wins");
  assert.deepEqual(ignoredTopLevelUpdate(both), ["working_on", "needs"], "the result text names what was ignored");
  assert.deepEqual(ignoredTopLevelUpdate(statusParams.parse({ working_on: "x" })), [], "nothing is ignored without update");
});
