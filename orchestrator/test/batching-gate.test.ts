// Batching and the quality gate (2026-11-16). On 11-13/11-14 one lead put four cards on the owner's Needs you in
// fifteen minutes, and 25 of the 115 cards went up while the same lead's previous card still waited. Six chains took
// 18 cards because a card lacked where or how, or restated something stale. What matters to the owner: one card per
// lead and project at a time (the next waits, and never for long), and a card that isn't ready goes back to its asker
// with the reason, never on to them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, HOLD_MS, type AskInput, type DeliverResult } from "../core/engine.ts";
import type { Agent, Item } from "../core/model.ts";

function setup() {
  let clock = Date.parse("2026-11-14T17:57:00Z");
  const sent: Item[] = [];
  const up: string[] = [];
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, {
    now: () => clock,
    async deliver(_t, _x, item): Promise<DeliverResult> {
      sent.push(item);
      return { delivery: "sent" };
    },
    mirror: () => {},
    changed: () => {},
    cardUp: (d) => up.push(d.id),
    log: () => {},
  }, { batchInbox: false });
  const cos = e.register("T-cos", "cos", null);
  const qa = e.register("T-lq", "lead", "qa");
  const other = e.register("T-lo", "lead", "other");
  const thread = e.register("T-q1", "thread", "qa", "T-lq");
  return { e, db, cos, qa, other, thread, sent, up, advance: (ms: number) => (clock += ms) };
}
type S = ReturnType<typeof setup>;
const two = [{ label: "Fix and rerun", detail: "Repair the setup, then rerun" }, { label: "Report it blocked" }];
const card = (n: number, extra: Partial<AskInput> = {}): AskInput => ({ title: `R${n} setup?`, question: `QA run R${n} is blocked by its setup. Fix and rerun?`, options: two, ...extra });
/** Filed by `by` and put to the owner by the CoS. */
function up(s: S, by: Agent, input: AskInput) {
  s.advance(1000); // ids sort by time first: one second apart keeps the order they were filed in
  const d = s.e.ask(by, input);
  return s.e.triageAskPerson(s.cos, d.id, { question: input.question, options: input.options, allowText: true });
}
const shown = (s: S) => s.e.needsYou().cards.map((c) => c.id);

test("a lead's cards within 10 minutes come one at a time: the next waits behind the first, with no push", () => {
  const s = setup();
  const a = up(s, s.qa, card(1));
  s.advance(60_000);
  const b = up(s, s.qa, card(3));
  s.advance(60_000);
  const c = up(s, s.qa, card(6));
  assert.deepEqual(shown(s), [a.id], "one card on Needs you");
  assert.deepEqual(s.up, [a.id], "one push");
  assert.deepEqual(s.e.needsYou().held.map((d) => d.orchestrator.held!.behind), [a.id, a.id]);
  // the owner answers the first: the next comes up at once, and the third now waits behind it
  s.e.personAnswer(a.id, s.e.decision(a.id)!.rev, "1", null, "phone");
  assert.deepEqual(shown(s), [b.id]);
  assert.deepEqual(s.up, [a.id, b.id]);
  assert.equal(s.e.decision(c.id)!.orchestrator.held!.behind, b.id);
});

test("a hold is brief: the next card comes up after 10 minutes even if the first is still unanswered", () => {
  const s = setup();
  const a = up(s, s.qa, card(1));
  const b = up(s, s.qa, card(3));
  s.advance(HOLD_MS - 1000);
  s.e.tick();
  assert.deepEqual(shown(s), [a.id]);
  s.advance(1000);
  s.e.tick();
  assert.deepEqual(shown(s), [a.id, b.id], "never held longer than the hold");
  assert.deepEqual(s.up, [a.id, b.id]);
});

test("whatever takes the first card off Needs you lets the next one up: moot, defer, archive", () => {
  for (const exit of ["moot", "defer", "archive"] as const) {
    const s = setup();
    const a = up(s, s.qa, card(1));
    const b = up(s, s.qa, card(3));
    if (exit === "moot") s.e.moot(s.cos, a.id, "the run passed");
    if (exit === "defer") s.e.personDefer(a.id, s.e.decision(a.id)!.rev, "1h", null, "desktop");
    if (exit === "archive") {
      s.e.archiveProject("qa");
      assert.equal(s.e.decision(b.id)!.state, "withdrawn", "archiving withdraws the held card too");
      continue;
    }
    s.e.tick();
    assert.deepEqual(shown(s), [b.id], exit);
  }
});

test("only the same lead and project batch, and only behind a card asked under 10 minutes ago", () => {
  const s = setup();
  const a = up(s, s.qa, card(1));
  const b = up(s, s.other, card(2));
  assert.deepEqual(shown(s), [a.id, b.id], "another lead's card isn't held");
  s.advance(HOLD_MS);
  const c = up(s, s.qa, card(3));
  assert.deepEqual(shown(s), [a.id, b.id, c.id], "the first card has waited 10 minutes already: the owner sees both");
});

test("the Steward's cards are never held: a second host alarm can't wait behind the first", () => {
  const s = setup();
  const steward = s.e.register("T-st", "steward", null);
  const a = up(s, steward, { title: "Disk 91%?", question: "The runner disk is at 91%. Clean the caches?", options: two });
  const b = up(s, steward, { title: "Memory 92%?", question: "Memory is at 92%. Stop the 9 GB tsc?", options: two });
  assert.deepEqual(shown(s), [a.id, b.id]);
  assert.deepEqual(s.up, [a.id, b.id], "both pushed");
});

test("a card the CoS didn't triage in time is batched too", () => {
  const s = setup();
  const a = up(s, s.qa, card(1));
  const b = s.e.ask(s.qa, card(3));
  s.advance(5 * 60_000);
  s.e.tick();
  assert.equal(s.e.decision(b.id)!.state, "asked");
  assert.deepEqual(shown(s), [a.id], "escalated, then held behind the lead's first card");
});

test("a bounced card goes back to its asker with the reason and never reaches the owner", async () => {
  const s = setup();
  const d = s.e.ask(s.qa, card(1));
  s.e.triageBounce(s.cos, d.id, "Say where these commands run: the runner or the Mac?");
  assert.equal(s.e.decision(d.id)!.state, "withdrawn");
  assert.equal(s.e.decision(d.id)!.withdrawn!.bounced, true);
  s.advance(10 * 60_000);
  s.e.tick();
  assert.equal(s.e.needsYou().cards.length + s.e.needsYou().triaging.length, 0, "not escalated, not on Needs you");
  assert.deepEqual(s.up, []);
  await s.e.flush();
  const note = s.sent.find((i) => i.recipient === "lead:qa" && i.ref === d.id)!;
  assert.match(note.body, /sent d-\S+ "R1 setup\?" back instead of on to the owner: "Say where these commands run: the runner or the Mac\?"\. Fix that and ask again/);
  assert.throws(() => s.e.personAnswer(d.id, s.e.decision(d.id)!.rev, "1", null, "desktop"), /is withdrawn/);
});

test("bounce is the CoS's, needs a reason, and takes the duplicates merged into the card back too", () => {
  const s = setup();
  const a = s.e.ask(s.qa, card(1));
  const b = s.e.ask(s.other, card(1));
  s.e.triageMerge(s.cos, b.id, a.id);
  assert.throws(() => s.e.triageBounce(s.qa, a.id, "x"), /only the CoS triages/);
  assert.throws(() => s.e.triageBounce(s.cos, a.id, ""), /reason \(note\) is empty/);
  s.e.triageBounce(s.cos, a.id, "Stale: that preview was recreated an hour ago");
  assert.equal(s.e.decision(b.id)!.state, "withdrawn", "its duplicate's asker isn't left waiting");
});

test("the gate refuses at once a card that can't be good: a command with no where, look-alike options, a re-asked key", () => {
  const s = setup();
  assert.throws(() => s.e.ask(s.qa, card(1, { blocks: [{ kind: "command", text: "git merge --ff-only x" }] })), /command block needs where/);
  assert.throws(() => s.e.ask(s.qa, card(1, { options: [{ label: "Go" }, { label: "go " }] })), /same label/);
  const first = up(s, s.qa, card(1, { key: "qa:r1-setup" }));
  s.e.personAnswer(first.id, first.rev, null, "use the cached deps", "desktop");
  s.advance(60 * 60_000);
  assert.throws(() => s.e.ask(s.qa, card(1, { key: "qa:r1-setup" })), /answered d-\S+ with key qa:r1-setup 1h ago: +"use the cached deps"\. Act on that answer/);
  assert.equal(s.e.needsYou().triaging.length, 0, "nothing went to the CoS");
  s.advance(24 * 3_600_000);
  assert.equal(s.e.ask(s.qa, card(1, { key: "qa:r1-setup" })).state, "open", "a day later the key is free again");
});

test("the gate runs where a card goes up to the CoS: a thread's card is the lead's to fix, and it hears so on forward", () => {
  const s = setup();
  const d = s.e.ask(s.thread, card(1, { blocks: [{ kind: "command", text: "yarn install" }] }));
  assert.equal(d.orchestrator.at_level, "lead", "a thread's card to its lead isn't gated");
  assert.throws(() => s.e.forward(s.qa, d.id, null), /command block needs where/);
  assert.equal(s.e.decision(d.id)!.orchestrator.at_level, "lead", "still the lead's");
});
