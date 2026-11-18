import { test } from "node:test";
import assert from "node:assert/strict";
import { ProposalBook, PROPOSAL_TTL_MS, highStakes, isYes } from "../voice/confirm.ts";

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, add: (ms: number) => (t += ms) };
};
const answer = { route: "answer" as const, body: { id: "D1", rev: 1, option: "1", text: null, via: "voice" }, readback: 'Answering "Pick a size" with option 1, Small. Say yes to send.', cardId: "D1", stakes: ["Pick a size"] };

test("a spoken yes is refused before the read-back has been spoken", () => {
  const c = clock();
  const b = new ProposalBook(c.now);
  const { proposal } = b.propose(answer);
  const g = b.confirmSpoken(proposal.id, { text: "yes", startedAt: c.now() + 1 });
  assert.equal(g.ok, false);
  assert.match((g as { reason: string }).reason, /Read the proposal back first/);
});

test("a yes spoken before the read-back ended does not count", () => {
  const c = clock();
  const b = new ProposalBook(c.now);
  const { proposal } = b.propose(answer);
  const early = { text: "yes", startedAt: c.now() };
  c.add(2000);
  b.readbackDone();
  assert.equal(b.confirmSpoken(proposal.id, early).ok, false);
});

test("a yes after the read-back is accepted once", () => {
  const c = clock();
  const b = new ProposalBook(c.now);
  const { proposal } = b.propose(answer);
  c.add(2000);
  b.readbackDone();
  c.add(800);
  const g = b.confirmSpoken(proposal.id, { text: "Yes, send it", startedAt: c.now() });
  assert.equal(g.ok, true);
  assert.equal(b.confirmSpoken(proposal.id, { text: "yes", startedAt: c.now() + 1 }).ok, false, "not twice");
});

test("anything short of a clear yes is refused", () => {
  const c = clock();
  const b = new ProposalBook(c.now);
  const { proposal } = b.propose(answer);
  b.readbackDone();
  c.add(500);
  for (const text of ["no", "yes, but wait", "hmm", "not yet", "yes no", "cancel that"]) {
    assert.equal(b.confirmSpoken(proposal.id, { text, startedAt: c.now() }).ok, false, text);
  }
});

test("a proposal expires twenty seconds after its read-back", () => {
  const c = clock();
  const b = new ProposalBook(c.now);
  const { proposal } = b.propose(answer);
  b.readbackDone();
  c.add(PROPOSAL_TTL_MS + 1);
  assert.equal(b.confirmSpoken(proposal.id, { text: "yes", startedAt: c.now() }).ok, false);
  assert.equal(b.expire(), proposal.id);
  assert.equal(b.pending(), null);
});

test("merge, production, money and secrets are tap-only: voice can't send them, a tap can", () => {
  for (const text of ["Merge the release branch", "Deploy to production", "Raise the budget to $400", "Rotate the API key", "Paste the login password"]) {
    assert.ok(highStakes(text), text);
  }
  assert.ok(!highStakes("Pick a cache size"));
  const c = clock();
  const b = new ProposalBook(c.now);
  const { proposal } = b.propose({ ...answer, readback: "Answering \"Merge it?\" with option 1, Merge. Say yes to send.", stakes: ["Merge it?"] });
  assert.equal(proposal.tapOnly, true);
  b.readbackDone();
  c.add(500);
  const g = b.confirmSpoken(proposal.id, { text: "yes", startedAt: c.now() });
  assert.equal(g.ok, false);
  assert.match((g as { reason: string }).reason, /needs a tap/);
  assert.equal(b.tap(proposal.id).ok, true);
});

test("a new proposal replaces the last one", () => {
  const b = new ProposalBook(() => 5);
  const first = b.propose(answer).proposal;
  const second = b.propose({ ...answer, cardId: "D2" });
  assert.equal(second.replaced, first.id);
  assert.equal(b.tap(first.id).ok, false);
});

test("isYes", () => {
  assert.ok(isYes("yes"));
  assert.ok(isYes("Yeah go ahead"));
  assert.ok(!isYes("no"));
  assert.ok(!isYes("wait, yes"));
});
