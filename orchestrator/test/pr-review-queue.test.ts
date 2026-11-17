import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewQueue, formatReviewQueue, mentionsFor, type ReviewData } from "../core/pr-review-queue.ts";
import { parsePeopleDirectory } from "../open-prs/people.ts";

const review = (login: string, state = "APPROVED", sha = "head") => ({ login, state, sha });
const data = (reviews = [] as ReturnType<typeof review>[]): ReviewData => ({ author: "author", reviews, requested: ["requested"], complete: true });
const pr = (reviews = [] as ReturnType<typeof review>[]) => ({ draft: false, sha: "head", reviewData: data(reviews) });

test("only non-author humans count, and drafts never enter the queue", () => {
  assert.equal(reviewQueue(pr()).bucket, "needs-review");
  for (const who of ["author", "AUTHOR", "coderabbitai", "coderabbitai[bot]", "helper[bot]"]) {
    assert.equal(reviewQueue(pr([review(who)])).bucket, "needs-review");
  }
  assert.equal(reviewQueue({ ...pr(), draft: true }).bucket, null);
  assert.equal(reviewQueue({ ...pr(), reviewData: undefined }).bucket, null);
  assert.equal(reviewQueue({ ...pr(), reviewData: { ...data(), complete: false } }).bucket, null);
});

test("current approvals win; outdated reviews need another look; current comments and change requests wait", () => {
  assert.equal(reviewQueue(pr([review("alice")])).bucket, "approved");
  for (const state of ["APPROVED", "COMMENTED", "CHANGES_REQUESTED", "DISMISSED"]) {
    assert.equal(reviewQueue(pr([review("alice", state, "old")])).bucket, "needs-rereview");
  }
  for (const state of ["COMMENTED", "CHANGES_REQUESTED", "DISMISSED"]) {
    assert.equal(reviewQueue(pr([review("alice", state)])).bucket, null);
  }
  assert.equal(reviewQueue(pr([review("alice", "APPROVED", "old"), review("alice", "CHANGES_REQUESTED")])).bucket, null);
  assert.equal(reviewQueue(pr([review("alice", "APPROVED"), review("alice", "CHANGES_REQUESTED")])).bucket, null);
  assert.equal(reviewQueue(pr([review("alice"), review("alice", "COMMENTED")])).bucket, "approved");
  assert.equal(reviewQueue(pr([review("alice"), review("bob", "CHANGES_REQUESTED", "old")])).bucket, "approved");
  assert.equal(reviewQueue(pr([review("alice", "PENDING")])).bucket, "needs-review");
  assert.equal(reviewQueue(pr([review("alice", "COMMENTED", "")])).bucket, null);
});

test("asks previous reviewers again, requested reviewers first, suggested reviewers only as fallback", () => {
  assert.deepEqual(reviewQueue(pr([review("alice", "COMMENTED", "old"), review("ALICE", "APPROVED", "old")])).reviewers, ["ALICE"]);
  assert.deepEqual(reviewQueue(pr(), ["suggested"]).reviewers, ["requested"]);
  assert.deepEqual(reviewQueue({ ...pr(), reviewData: { ...data(), requested: [] } }, ["suggested", "author", "coderabbitai", "org/team"]).reviewers, ["suggested"]);
});

test("people YAML reads only active GitHub-to-mention mappings, including spaces", () => {
  const source = `version: 1\nusers:\n  - github: {login: Alice}\n    slack: {mention: '@Alice Example'}\n  - github: {login: bob}\n    active: false\n    slack: {mention: '@Bob'}\n  - github: {login: unmapped}\n  - github: {login: coderabbitai}\n    slack: {mention: '@Bot'}\n`;
  assert.deepEqual(parsePeopleDirectory(source), { alice: "@Alice Example" });
  assert.throws(() => parsePeopleDirectory("users: not-a-list"));
  assert.throws(() => parsePeopleDirectory("users: ["));
});

test("clipboard has escaped HTML anchors and bare URLs, never Slack link markup or guessed mentions", () => {
  const rows = [{ url: "https://github.com/acme/widgets/pull/7", repo: "acme/widgets", number: 7, title: "Fix **links** & `copy` <script>bad</script>", author: "author", bucket: "needs-review" as const, reviewers: ["alice", "unmapped"], mentions: ["@Alice Example"] }];
  const { html, text } = formatReviewQueue(rows);
  assert.match(html, /<ul><li>/);
  assert.match(html, /<a href="https:\/\/github.com\/acme\/widgets\/pull\/7">widgets#7<\/a>/);
  assert.match(html, /Fix links &amp; copy/);
  assert.ok(!html.includes("<script>"));
  assert.match(text, /https:\/\/github.com\/acme\/widgets\/pull\/7/);
  assert.match(text, /by author/);
  assert.match(text, /@Alice Example/);
  for (const output of [html, text]) {
    assert.ok(!output.includes("@unmapped"));
    assert.ok(!output.includes("|widgets#7"));
    assert.ok(!output.includes("**"));
  }
  assert.ok(!formatReviewQueue(rows, "approved").text.includes("pull/7"));
});

test("GitHub parser carries commit SHAs and individual requests, rejects Bot actors and flags truncation", async () => {
  const { parseOpenPrsPage } = await import("../core/open-prs.ts");
  const raw = {
    number: 1, url: "https://github.com/acme/widgets/pull/1", author: { login: "author" }, headRefOid: "head",
    reviews: { pageInfo: { hasNextPage: false }, nodes: [
      { author: { login: "alice", __typename: "User" }, state: "APPROVED", commit: { oid: "head" } },
      { author: { login: "machine", __typename: "Bot" }, state: "APPROVED", commit: { oid: "head" } },
    ] },
    reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [
      { requestedReviewer: { login: "bob", __typename: "User" } },
      { requestedReviewer: { __typename: "Team" } },
    ] },
  };
  const parsed = parseOpenPrsPage({ search: { nodes: [raw] } }).prs[0]!;
  assert.deepEqual(parsed.reviewData, { author: "author", complete: true, reviews: [review("alice")], requested: ["bob"] });
  assert.equal(reviewQueue(parsed).bucket, "approved");
  raw.reviews.pageInfo.hasNextPage = true;
  assert.equal(reviewQueue(parseOpenPrsPage({ search: { nodes: [raw] } }).prs[0]!).bucket, null);
  raw.reviews.pageInfo.hasNextPage = false;
  raw.reviewRequests.pageInfo.hasNextPage = true;
  assert.equal(reviewQueue(parseOpenPrsPage({ search: { nodes: [raw] } }).prs[0]!).bucket, null);
});

test("an unavailable directory returns an actionable note without revealing its contents", async () => {
  const { readPeopleDirectory } = await import("../open-prs/people.ts");
  assert.deepEqual(await readPeopleDirectory(""), { mentions: {}, error: null });
  const result = await readPeopleDirectory("/no-such-pr-review-directory/people.yaml");
  assert.deepEqual(result.mentions, {});
  assert.match(result.error!, /peopleFilePath/);
});

test("mention lookup is case-insensitive, deduplicated and never guesses inherited map properties", () => {
  assert.deepEqual(mentionsFor(["ALICE", "alice", "constructor", "unmapped"], { alice: "@Alice" }), ["@Alice"]);
});
