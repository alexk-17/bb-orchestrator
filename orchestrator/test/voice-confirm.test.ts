import { test } from "node:test";
import assert from "node:assert/strict";
import { CARD_TTL_MS, ProposalBook, highStakes } from "../voice/confirm.ts";

const card = { route: "answer" as const, body: { id: "D1", rev: 1, option: "1", text: null, via: "voice" }, readback: 'Answer "Merge the release?" with option 1, Merge.', cardId: "D1" };

test("merge, production, money and secrets need a tap; everyday actions don't", () => {
  for (const text of ["Merge the release branch", "Deploy to production", "Raise the budget to $400", "Rotate the API key", "Paste the login password"]) {
    assert.ok(highStakes(text), text);
  }
  for (const text of ["Pick a cache size", "Tell the lead to push the fix", "Hold the project", "Start the lead"]) {
    assert.ok(!highStakes(text), text);
  }
});

test("a card is sent only by a tap, once", () => {
  const b = new ProposalBook(() => 1000);
  const { proposal } = b.propose(card);
  assert.equal(proposal.tapOnly, true);
  assert.equal(b.tap(proposal.id).ok, true);
  assert.equal(b.tap(proposal.id).ok, false, "not twice");
});

test("a card lapses after a minute untouched", () => {
  let t = 1000;
  const b = new ProposalBook(() => t);
  const { proposal } = b.propose(card);
  t += CARD_TTL_MS + 1;
  assert.equal(b.tap(proposal.id).ok, false);
  assert.equal(b.expire(), proposal.id);
  assert.equal(b.pending(), null);
});

test("a new card replaces the last one, and a dismissed card is gone", () => {
  const b = new ProposalBook(() => 5);
  const first = b.propose(card).proposal;
  const second = b.propose({ ...card, cardId: "D2" });
  assert.equal(second.replaced, first.id);
  assert.equal(b.tap(first.id).ok, false);
  assert.equal(b.cancel(second.proposal.id), true);
  assert.equal(b.pending(), null);
});
