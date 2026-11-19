import test from "node:test";
import assert from "node:assert/strict";
import { collectPathwaysProofRecords, extractPrLinks, reducePathwaysPr, reducePathwaysProof, reducePathwaysWaitLane } from "../core/pathways-pr.ts";
import type { BbPrReading } from "../core/open-prs.ts";

const url = "https://github.com/acme/app/pull/101";
const reading = (change: Partial<Extract<BbPrReading, { outcome: "available" }>["pullRequest"]> = {}): BbPrReading => ({ outcome: "available", pullRequest: { url, number: 101, title: "Test PR", state: "open", draft: false, sha: "0123456789abcdef0123456789abcdef01234567", checks: { state: "passing" }, review: { state: "approved" }, mergeability: { state: "ready_to_merge" }, ...change } });

test("only explicit PR URLs link a Linear ticket", () => {
  assert.deepEqual(extractPrLinks("This resembles PR #101", []), { state: "missing", urls: [], source: null });
  assert.deepEqual(extractPrLinks(`See [PR](${url})`, [{ url }]), { state: "linked", urls: [url], source: "both" });
  assert.deepEqual(extractPrLinks(url, [{ url: "https://github.com/acme/app/pull/102" }]), { state: "ambiguous", urls: [url, "https://github.com/acme/app/pull/102"], source: null });
});

test("green checks cannot override draft, missing review, or unknown mergeability", () => {
  assert.deepEqual(reducePathwaysPr(url, reading({ state: "draft", draft: true }), 1000), { url, state: "blocked", number: 101, title: "Test PR", draft: true, head: "0123456789abcdef0123456789abcdef01234567", createdAt: null, headCommittedAt: null, checksPendingSince: null, reviews: [], staleReviewDismissal: null, requiredApprovals: null, review: "approved", checks: "passing", mergeability: "ready_to_merge", reason: "Draft PR", retrievedAt: 1000 });
  assert.equal(reducePathwaysPr(url, reading({ review: { state: "none" } }), 1000).reason, "Review not recorded");
  assert.equal(reducePathwaysPr(url, reading({ mergeability: { state: "unknown" } }), 1000).reason, "Mergeability not confirmed");
  assert.equal(reducePathwaysPr(url, reading({ url: "https://github.com/AcMe/app/pull/101" }), 1000).state, "ready");
  assert.equal(reducePathwaysPr(url, reading(), 1000).state, "ready");
});

test("a new PR head makes exact-head proof stale and missing QA stays partial", () => {
  const current = reducePathwaysPr(url, reading({ sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }), 1000);
  const record = { prUrl: url, verifiedSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", status: "verified" as const, liveInterface: "staging UI", qaPacketUrl: "https://example.test/qa", sourceUrl: "https://example.test/proof", sourceLabel: "Fixture proof", observedAt: 900 };
  assert.deepEqual(reducePathwaysProof(current, [record]), { state: "stale", verifiedSha: record.verifiedSha, liveInterface: "staging UI", qaPacketUrl: record.qaPacketUrl, missing: ["Proof is on another head"], sourceUrl: record.sourceUrl, sourceLabel: "Fixture proof", observedAt: 900 });
  assert.deepEqual(reducePathwaysProof(current, [{ ...record, verifiedSha: current.head!, liveInterface: null, qaPacketUrl: null }]), { state: "partial", verifiedSha: current.head, liveInterface: null, qaPacketUrl: null, missing: ["Live interface not recorded", "QA packet not recorded"], sourceUrl: record.sourceUrl, sourceLabel: "Fixture proof", observedAt: 900 });
  assert.deepEqual(reducePathwaysProof(current, []), { state: "unrecorded", verifiedSha: null, liveInterface: null, qaPacketUrl: null, missing: ["Proof not recorded", "Live interface not recorded", "QA packet not recorded"], sourceUrl: null, sourceLabel: null, observedAt: null });
  assert.deepEqual(reducePathwaysProof(current, [{ ...record, verifiedSha: null, status: "partial", liveInterface: null, qaPacketUrl: null, observedAt: 1000 }]).missing, ["Verified SHA not recorded", "Live interface not recorded", "QA packet not recorded"]);
  const newer = { ...current, headCommittedAt: 950 };
  assert.deepEqual(reducePathwaysProof(newer, [{ ...record, verifiedSha: null, liveInterface: null, qaPacketUrl: null }]).missing, ["Proof predates current head", "Verified SHA not recorded", "Live interface not recorded", "QA packet not recorded"]);
});

test("only deliverable proof with an explicit PR URL supplies a partial record", () => {
  const at = "2026-11-18T20:00:00Z";
  const records = collectPathwaysProofRecords(url, [
    { id: "d-1", revisions: [{ rev: 1, at, proof: [{ kind: "image", url: null }, { kind: "pr", url }] }] },
    { id: "d-2", revisions: [{ rev: 1, at, proof: [{ kind: "image", url: null }] }] },
  ]);
  assert.deepEqual(records, [{ prUrl: url, verifiedSha: null, status: "partial", liveInterface: null, qaPacketUrl: null, sourceUrl: null, sourceLabel: "Deliverable d-1 rev 1", observedAt: Date.parse(at) }]);
});

test("an approval on an older head reopens review when the branch dismisses stale reviews", () => {
  const current = reducePathwaysPr(url, reading({ sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", headCommittedAt: 2000, createdAt: 1000, checksPendingSince: 1800, staleReviewDismissal: true, reviews: [{ login: "reviewer", state: "APPROVED", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", submittedAt: 1500 }] }), 2500);
  const lane = reducePathwaysWaitLane(current, reducePathwaysProof(current, []), [{ when: "approved", owner: "thread:seed:1", createdAt: 2100 }]);
  assert.deepEqual(lane.steps.map((step) => step.kind), ["check run", "human review", "QA", "draft decision", "merge go"]);
  assert.equal(lane.reviewFreshness, "stale");
  assert.equal(lane.steps[1]?.state, "pending");
  assert.equal(lane.steps[1]?.since, 2000);
  assert.equal(lane.steps[1]?.owner, "thread:seed:1");
  assert.equal(lane.steps[2]?.state, "unknown");
  const unknownRule = reducePathwaysPr(url, reading({ sha: current.head!, headCommittedAt: 2000, staleReviewDismissal: null, reviews: [{ login: "reviewer", state: "APPROVED", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", submittedAt: 1500 }] }), 2500);
  assert.equal(reducePathwaysWaitLane(unknownRule, reducePathwaysProof(unknownRule, []), []).reviewFreshness, "unknown");
  const keptReview = reducePathwaysPr(url, reading({ sha: current.head!, staleReviewDismissal: false, reviews: [{ login: "reviewer", state: "APPROVED", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", submittedAt: 1500 }] }), 2500);
  assert.equal(reducePathwaysWaitLane(keptReview, reducePathwaysProof(keptReview, []), []).steps[1]?.state, "done");
  const required = reducePathwaysPr(url, reading({ review: { state: "none" }, requiredApprovals: 2 }), 2500);
  assert.equal(reducePathwaysWaitLane(required, reducePathwaysProof(required, []), []).steps[1]?.state, "pending");
});
