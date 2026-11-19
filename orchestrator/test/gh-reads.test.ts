// GitHub reads through plain gh commands (2026-11-17). The Open PRs tab and the PR waits read GitHub only with fixed,
// read-only gh argument lists run without a shell, so nothing the server, the page or an agent passes can make gh write
// or run something else. A PR wait reads its own PR by URL, so a wait on a PR no environment shows still fires.
// Everything here is made up (logins, orgs, repos); the fixtures are the shapes gh 2.100 prints.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CODEOWNERS_PATHS,
  approversOf,
  ghArgs,
  needsReview,
  parsePrFiles,
  parsePrView,
  parseRepoArea,
  parseRequired,
  parseDismissStaleReviews,
  parseSearch,
  parseWaitReading,
  rawPr,
  rollupOf,
  uncoveredWaitUrls,
  type BbPrReading,
} from "../core/open-prs.ts";
import { Engine, type DeliverResult } from "../core/engine.ts";
import type { Item } from "../core/model.ts";

const PR = "https://github.com/acme-co/widgets/pull/7";
const ELSEWHERE = "https://github.com/other-org/gadgets/pull/42"; // a PR no thread's environment shows

// ---------------------------------------------------------------- fixtures (gh's JSON shapes)

const SEARCH = [
  { url: PR, number: 7, title: "Make the widget spin", repository: { name: "widgets", nameWithOwner: "acme-co/widgets" }, updatedAt: "2026-01-02T03:04:05Z", isDraft: false },
  { url: "https://github.com/acme-co/widgets/issues/8", number: 8, title: "an issue", repository: { name: "widgets", nameWithOwner: "acme-co/widgets" } },
  { number: 9, title: "no url" },
];
const run = (conclusion: string, status = "COMPLETED") => ({ __typename: "CheckRun", name: "ci", status, conclusion, workflowName: "CI" });
const ctx = (state: string) => ({ __typename: "StatusContext", context: "deploy", state, targetUrl: "https://ci.example/1" });
const review = (login: string, state: string, oid = "aaaa") => ({ id: "", author: { login }, authorAssociation: "MEMBER", body: "", state, submittedAt: "2026-01-01T00:00:00Z", commit: { oid } });
const VIEW = {
  url: PR,
  body: "## TL;DR\nSpins the widget.",
  isDraft: false,
  headRefName: "dev-one/spin",
  headRefOid: "aaaa",
  baseRefName: "main",
  reviewDecision: "REVIEW_REQUIRED",
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  statusCheckRollup: [run("SUCCESS"), run("SKIPPED"), ctx("SUCCESS")],
  reviews: [
    review("rev-a", "APPROVED"),
    review("rev-a", "COMMENTED"), // a comment after an approval doesn't take it back
    review("rev-b", "APPROVED"),
    review("rev-b", "CHANGES_REQUESTED"), // a later change request does
    review("lint-helper[bot]", "APPROVED"),
    review("copilot-pull-request-reviewer", "APPROVED"),
    review("coderabbitai", "APPROVED"), // gh prints CodeRabbit under its bare login
  ],
  author: { id: "U_1", is_bot: false, login: "dev-one", name: "" },
  reviewRequests: [{ __typename: "User", login: "rev-c" }, { __typename: "Team", name: "Reviewers", slug: "reviewers" }],
};
const RULES = [{ type: "deletion" }, { type: "pull_request", parameters: { required_approving_review_count: 2, dismiss_stale_reviews_on_push: true } }];
const wait = (p: Partial<{ state: string; isDraft: boolean; reviewDecision: string; checks: unknown[]; mergeable: string; mergeStateStatus: string }>, url = ELSEWHERE) => ({
  url,
  number: Number(url.split("/").pop()),
  state: p.state ?? "OPEN",
  isDraft: p.isDraft ?? false,
  reviewDecision: p.reviewDecision ?? "REVIEW_REQUIRED",
  statusCheckRollup: p.checks ?? [run("SUCCESS")],
  mergeable: p.mergeable ?? "MERGEABLE",
  mergeStateStatus: p.mergeStateStatus ?? "BLOCKED",
});

// ---------------------------------------------------------------- the argument lists

test("every gh call is a fixed, read-only argument list: only search, pr view, pr list and two REST GETs", () => {
  assert.deepEqual(ghArgs.openPrs("dev-one"), ["search", "prs", "--author", "dev-one", "--state", "open", "--archived=false", "--sort", "updated", "--order", "desc", "--limit", "251", "--json", "url,number,title,repository,updatedAt,isDraft"]);
  assert.deepEqual(ghArgs.view(PR), ["pr", "view", PR, "--json", "url,body,isDraft,headRefName,headRefOid,baseRefName,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,reviews,author,reviewRequests"]);
  assert.deepEqual(ghArgs.files(PR), ["pr", "view", PR, "--json", "headRefOid,files"]);
  assert.deepEqual(ghArgs.merged("acme-co/widgets"), ["pr", "list", "--repo", "acme-co/widgets", "--state", "merged", "--search", "sort:updated-desc", "--limit", "40", "--json", "files,reviews"]);
  assert.deepEqual(ghArgs.wait(ELSEWHERE), ["pr", "view", ELSEWHERE, "--json", "url,number,state,isDraft,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus"]);
  assert.deepEqual(ghArgs.pathwaysWait(ELSEWHERE), ["pr", "view", ELSEWHERE, "--json", "url,number,title,state,isDraft,createdAt,baseRefName,headRefOid,commits,reviews,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus"]);
  assert.deepEqual(ghArgs.codeowners("acme-co/widgets", ".github/CODEOWNERS"), ["api", "--method", "GET", "-H", "Accept: application/vnd.github.raw+json", "repos/acme-co/widgets/contents/.github/CODEOWNERS"]);
  assert.deepEqual(ghArgs.rules("acme-co/widgets", "release/2026"), ["api", "--method", "GET", "repos/acme-co/widgets/rules/branches/release/2026"]);
  const all = [ghArgs.openPrs("dev-one"), ghArgs.view(PR), ghArgs.files(PR), ghArgs.merged("acme-co/widgets"), ghArgs.wait(PR), ...CODEOWNERS_PATHS.map((p) => ghArgs.codeowners("acme-co/widgets", p)), ghArgs.rules("acme-co/widgets", "main")];
  for (const a of all) {
    const verb = a.slice(0, 2).join(" ");
    assert.ok(["search prs", "pr view", "pr list"].includes(verb) || a[0] === "api", `${verb}: a read command`);
    if (a[0] === "api") {
      // a field (-f/-F/--field/--raw-field/--input) makes gh api POST; --method GET pins the verb
      assert.deepEqual(a.slice(1, 3), ["--method", "GET"]);
      assert.ok(!a.some((x) => ["-f", "-F", "--field", "--raw-field", "--input", "-X"].includes(x)), "no field, no other method");
      assert.ok(!a.some((x) => x.startsWith("graphql")), "no GraphQL");
    }
    assert.ok(!a.some((x) => /^(comment|review|merge|edit|close|reopen|ready|label|create|delete)$/.test(x)), "no write subcommand anywhere");
  }
});

test("a value that isn't a login, PR URL, repo or branch never reaches gh: it throws first", () => {
  assert.throws(() => ghArgs.openPrs("--web"), /GitHub login/);
  assert.throws(() => ghArgs.openPrs("dev one"), /GitHub login/);
  assert.throws(() => ghArgs.view(`${PR}; rm -rf /`), /pull request URL/);
  assert.throws(() => ghArgs.wait("https://github.com/acme-co/widgets/issues/7"), /pull request URL/, "an issue is not a PR");
  assert.throws(() => ghArgs.files("--json=x"), /pull request URL/);
  assert.throws(() => ghArgs.merged("acme-co/widgets --web"), /repo/);
  assert.throws(() => ghArgs.rules("acme-co/widgets", "-X POST"), /branch/);
  assert.throws(() => ghArgs.rules("acme-co/widgets", "../../orgs"), /branch/, "no climbing out of the rules path");
  assert.throws(() => ghArgs.codeowners("acme-co/widgets", "secrets.txt" as never), /CODEOWNERS place/);
});

test("the host runs gh with execFile and fixed ghArgs only: no shell, no exec, no command text from outside", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "open-prs", "host.ts"), "utf8");
  assert.match(src, /import \{ execFile \} from "node:child_process"/);
  assert.doesNotMatch(src, /\bexec\(|execSync|spawn|shell:\s*true|graphql/i);
  const calls = [...src.matchAll(/(?<!function )\bgh\(([^)]*\))/g)].map((m) => m[1]);
  assert.ok(calls.length >= 5);
  for (const c of calls) assert.match(c!, /^ghArgs\.\w+\(/, `every gh() call takes a ghArgs list: ${c}`);
  assert.match(src, /GH_PROMPT_DISABLED: "1"/);
  assert.match(src, /timeout: 60_000/);
});

// ---------------------------------------------------------------- the parsers

test("gh's checks are rolled up fail-closed: any failure fails, anything unfinished or unknown is pending, none is null", () => {
  assert.equal(rollupOf([]), null, "no checks: not passing, not failing");
  assert.equal(rollupOf(undefined), null);
  assert.equal(rollupOf([run("SUCCESS"), run("SKIPPED"), run("NEUTRAL"), ctx("SUCCESS")]), "SUCCESS");
  assert.equal(rollupOf([run("SUCCESS"), run("", "IN_PROGRESS")]), "PENDING", "a running check isn't green yet");
  assert.equal(rollupOf([run("SUCCESS"), ctx("PENDING")]), "PENDING");
  assert.equal(rollupOf([run("SUCCESS"), ctx("EXPECTED")]), "PENDING");
  assert.equal(rollupOf([run("SUCCESS"), run("SOMETHING_NEW")]), "PENDING", "an unknown conclusion is never passing");
  assert.equal(rollupOf([run("SUCCESS"), { __typename: "Mystery" }]), "PENDING", "an unknown kind is never passing");
  for (const bad of ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]) assert.equal(rollupOf([run("", "IN_PROGRESS"), run(bad)]), "FAILURE", bad);
  assert.equal(rollupOf([run("SUCCESS"), ctx("ERROR")]), "FAILURE");
});

test("a search hit and its view make the RawPr the page has always read; bots' approvals don't count", () => {
  const hits = parseSearch(SEARCH);
  assert.equal(hits.length, 1, "issues and hits without a PR URL are left out");
  const view = parsePrView(VIEW);
  assert.deepEqual(view.approvedBy, ["rev-a"], "rev-a's later comment keeps the approval; rev-b's change request takes it back; bots never count");
  const pr = rawPr(hits[0]!, view, parseRequired(RULES));
  assert.deepEqual(pr, {
    url: PR, number: 7, title: "Make the widget spin", repo: "acme-co/widgets", updatedAt: "2026-01-02T03:04:05Z",
    body: "## TL;DR\nSpins the widget.", draft: false, branch: "dev-one/spin", sha: "aaaa",
    reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeState: "BLOCKED", checks: "SUCCESS", approvedBy: ["rev-a"], required: 2,
    author: "dev-one",
    // people's reviews with the commit each was on: bots (CodeRabbit's bare login too) left out; teams never asked
    reviews: [
      { login: "rev-a", state: "APPROVED", sha: "aaaa" },
      { login: "rev-a", state: "COMMENTED", sha: "aaaa" },
      { login: "rev-b", state: "APPROVED", sha: "aaaa" },
      { login: "rev-b", state: "CHANGES_REQUESTED", sha: "aaaa" },
    ],
    requested: ["rev-c"],
  });
  assert.equal(needsReview(pr), true, "1 of 2 approvals, CI passing: still needs review");
  assert.equal(needsReview(rawPr(hits[0]!, parsePrView({ ...VIEW, statusCheckRollup: [run("FAILURE")] }), 2)), false, "failing CI leaves Needs review");
});

test("gh's empty reviewDecision (no review rule) is no decision, so the approvals count decides", () => {
  const v = parsePrView({ ...VIEW, reviewDecision: "", reviews: [review("rev-a", "APPROVED")] });
  assert.equal(v.reviewDecision, null);
  assert.equal(needsReview(rawPr(parseSearch(SEARCH)[0]!, v, null)), false, "no rule: one approval is enough");
  assert.equal(needsReview(rawPr(parseSearch(SEARCH)[0]!, { ...v, approvedBy: [] }, null)), true);
});

test("approvals: each person's latest opinionated review decides, never a later comment, never a bot", () => {
  assert.deepEqual(approversOf([review("a", "APPROVED"), review("a", "COMMENTED"), review("a", "COMMENTED")]), ["a"]);
  assert.deepEqual(approversOf([review("a", "APPROVED"), review("a", "DISMISSED")]), [], "a dismissed approval is gone");
  assert.deepEqual(approversOf([review("a", "CHANGES_REQUESTED"), review("a", "APPROVED")]), ["a"]);
  assert.deepEqual(approversOf([review("ci-helper[bot]", "APPROVED"), review("Copilot-Pull-Request-Reviewer", "APPROVED")]), []);
});

test("the required approvals come from the base branch's pull_request rule; no such rule is no count", () => {
  assert.equal(parseRequired(RULES), 2);
  assert.equal(parseRequired([{ type: "pull_request", parameters: { required_approving_review_count: 1 } }, { type: "pull_request", parameters: { required_approving_review_count: 3 } }]), 3, "two rulesets: the strictest");
  assert.equal(parseRequired([{ type: "deletion" }]), null);
  assert.equal(parseRequired([]), null);
  assert.equal(parseRequired({ message: "Not Found" }), null);
});

test("files, CODEOWNERS and merged PRs keep their shapes; bots aren't reviewers", () => {
  assert.deepEqual(parsePrFiles({ headRefOid: "bbbb", files: [{ path: "apps/api/x.ts", additions: 1, deletions: 0, changeType: "MODIFIED" }, { additions: 1 }] }), { sha: "bbbb", files: ["apps/api/x.ts"] });
  const area = parseRepoArea("apps/api/ @api-team\n", [
    { files: [{ path: "apps/api/y.ts" }], reviews: [review("copilot-pull-request-reviewer", "COMMENTED"), review("rev-c", "COMMENTED"), review("rev-c", "APPROVED")] },
    { files: [{ path: "docs/z.md" }], reviews: [review("docs-bot[bot]", "APPROVED")] },
  ]);
  assert.deepEqual(area, { codeowners: "apps/api/ @api-team\n", recent: [{ files: ["apps/api/y.ts"], reviewers: ["rev-c"] }] }, "a PR only bots reviewed says nothing about who reviews the area");
});

// ---------------------------------------------------------------- PR waits read through gh

test("a gh wait reading maps to bb's words: merged, closed, draft, checks, review, and ready only when GitHub can merge", () => {
  const pr = (d: unknown, rules: unknown = null) => (parseWaitReading(d, rules) as Extract<BbPrReading, { outcome: "available" }>).pullRequest;
  assert(ghArgs.pathwaysWait(PR).at(-1)?.includes("headRefOid"));
  assert.equal(pr({ ...wait({}), headRefOid: "abcdef0123456789" }).sha, "abcdef0123456789");
  assert.equal(pr({ ...wait({}), headRefOid: "abcdef0123456789", commits: [{ oid: "abcdef0123456789", committedDate: "2026-11-18T19:25:29Z" }] }).headCommittedAt, Date.parse("2026-11-18T19:25:29Z"));
  assert.equal(pr({ ...wait({}), title: "A PR" }).title, "A PR");
  assert.deepEqual(pr({ ...wait({}), headRefOid: "bbbb", createdAt: "2026-11-18T00:00:00Z", reviews: [review("rev-a", "APPROVED", "aaaa")], statusCheckRollup: [{ ...run("", "IN_PROGRESS"), startedAt: "2026-11-18T01:00:00Z" }] }).reviews, [{ login: "rev-a", state: "APPROVED", sha: "aaaa", submittedAt: Date.parse("2026-01-01T00:00:00Z") }]);
  assert.equal(pr({ ...wait({}), statusCheckRollup: [{ ...run("", "IN_PROGRESS"), startedAt: "2026-11-18T01:00:00Z" }] }).checksPendingSince, Date.parse("2026-11-18T01:00:00Z"));
  assert.equal(pr({ ...wait({}), baseRefName: "main" }, RULES).staleReviewDismissal, true);
  assert.equal(pr({ ...wait({}), baseRefName: "main" }, RULES).requiredApprovals, 2);
  assert.equal(parseDismissStaleReviews([{ type: "pull_request", parameters: { dismiss_stale_reviews_on_push: false } }]), false);
  assert.equal(parseDismissStaleReviews(null), null);
  assert.equal(pr(wait({ isDraft: true })).draft, true);
  assert.equal(pr(wait({ state: "MERGED" })).state, "merged");
  assert.equal(pr(wait({ state: "CLOSED" })).state, "closed");
  assert.equal(pr(wait({ isDraft: true })).state, "draft");
  assert.deepEqual(pr(wait({ checks: [] })).checks, {}, "no checks is no check state, never passing");
  assert.deepEqual(pr(wait({ checks: [run("", "QUEUED")] })).checks, { state: "pending" });
  assert.deepEqual(pr(wait({ reviewDecision: "APPROVED" })).review, { state: "approved" });
  assert.deepEqual(pr(wait({ reviewDecision: "" })).review, { state: "none" });
  assert.equal(pr(wait({ mergeStateStatus: "CLEAN" })).mergeability!.state, "ready_to_merge");
  assert.equal(pr(wait({ mergeStateStatus: "BLOCKED" })).mergeability!.state, "blocked");
  assert.equal(pr(wait({ mergeable: "CONFLICTING", mergeStateStatus: "CLEAN" })).mergeability!.state, "conflicts", "a conflict wins");
  assert.deepEqual(parseWaitReading({ message: "Could not resolve" }), { outcome: "unavailable", message: "gh gave no PR state" });
});

test("only waits no available bb reading covered are read with gh; an unavailable bb reading covers nothing", () => {
  const bbRead: BbPrReading[] = [
    { outcome: "available", pullRequest: { url: `${PR}/`, state: "open" } },
    { outcome: "unavailable", message: "suspended" },
    { outcome: "absent" },
  ];
  assert.deepEqual(uncoveredWaitUrls([PR, ELSEWHERE, ELSEWHERE, "https://github.com/acme-co/widgets/issues/3"], bbRead), [ELSEWHERE], "bb's reading is kept for PR; each URL once; never a non-PR URL");
  assert.deepEqual(uncoveredWaitUrls([PR], [{ outcome: "unavailable" }]), [PR], "bb couldn't read it this pass: gh does");
});

function engine() {
  let clock = Date.parse("2026-11-17T10:00:00Z");
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, { now: () => clock, deliver: async (): Promise<DeliverResult> => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "cd");
  const w1 = e.register("T-w1", "thread", "cd", "T-lead");
  e.setEnvironment("T-w1", "env-1");
  const d = e.ask(lead, { title: "Merge 42 once approved?", question: "Merge it?", options: [{ label: "Merge when approved" }, { label: "Hold" }], action: "merge" });
  e.triageAskPerson(cos, d.id, { question: "Merge it?", options: [{ label: "Merge when approved" }, { label: "Hold" }], allowText: true });
  e.personAnswer(d.id, e.decision(d.id)!.rev, "1", null, "phone");
  const wakes = (): Item[] => e.items(500).filter((i) => i.recipient === lead.address && i.sender === "orchestrator" && i.kind === "message");
  return { e, db, lead, w1, d, wakes, advance: (ms: number) => (clock += ms) };
}

test("a wait on a PR no environment shows closes from a gh pr view reading, once, when its condition holds", () => {
  const s = engine();
  const out = s.e.ack(s.lead, s.d.id, "done", null, { pr: ELSEWHERE, when: "approved" });
  assert.match(out, /reads it by its URL on each PR check/, "the bind no longer says nothing can wake it");
  assert.deepEqual(s.e.waitPrSeen(parseWaitReading(wait({ reviewDecision: "REVIEW_REQUIRED" }))), [], "not approved yet");
  assert.equal(s.wakes().length, 0);
  const [closed] = s.e.waitPrSeen(parseWaitReading(wait({ reviewDecision: "APPROVED" })));
  assert.ok(closed, "approved: the wait closes");
  assert.equal(s.wakes().length, 1);
  assert.match(s.wakes()[0]!.body, /PR #42 is approved/);
  assert.match(s.wakes()[0]!.body, /option 1 "Merge when approved"/);
  s.e.waitPrSeen(parseWaitReading(wait({ reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" })));
  assert.equal(s.wakes().length, 1, "once");
  assert.equal(s.e.pruneWaitReadings(), 1, "no open wait names it now: its reading goes");
});

test("green and ready from gh readings follow the engine's one rule for each condition", () => {
  const green = engine();
  green.e.ack(green.lead, green.d.id, "done", null, { pr: ELSEWHERE, when: "green" });
  green.e.waitPrSeen(parseWaitReading(wait({ checks: [run("SUCCESS"), run("", "IN_PROGRESS")] })));
  green.e.waitPrSeen(parseWaitReading(wait({ checks: [] })));
  assert.equal(green.wakes().length, 0, "running or no checks is not green");
  green.e.waitPrSeen(parseWaitReading(wait({ checks: [run("SUCCESS"), ctx("SUCCESS")] })));
  assert.equal(green.wakes().length, 1);

  const ready = engine();
  ready.e.ack(ready.lead, ready.d.id, "done", null, { pr: ELSEWHERE, when: "ready" });
  ready.e.waitPrSeen(parseWaitReading(wait({ reviewDecision: "APPROVED", mergeStateStatus: "BLOCKED" })));
  ready.e.waitPrSeen(parseWaitReading(wait({ isDraft: true, mergeStateStatus: "CLEAN" })));
  assert.equal(ready.wakes().length, 0, "blocked, or a draft, is not ready to merge");
  ready.e.waitPrSeen(parseWaitReading(wait({ reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" })));
  assert.equal(ready.wakes().length, 1);
  assert.match(ready.wakes()[0]!.body, /is ready to merge/);
});

test("a failed gh read writes nothing and closes nothing; closed unmerged ends the wait unmet", () => {
  const s = engine();
  s.e.ack(s.lead, s.d.id, "done", null, { pr: ELSEWHERE, when: "approved" });
  assert.deepEqual(s.e.waitPrSeen({ outcome: "unavailable", message: "gh: HTTP 502" }), []);
  assert.equal((s.db.prepare(`SELECT COUNT(*) AS n FROM pr_readings`).get() as { n: number }).n, 0);
  assert.equal(s.e.openWaits().length, 1);
  s.e.waitPrSeen(parseWaitReading(wait({ state: "CLOSED" })));
  assert.match(s.wakes()[0]!.body, /closed without merging, so it will never be approved/);
});

test("bb's reading wins: once a live environment reads the PR, the wait's gh reading is dropped and bb's decides", () => {
  const s = engine();
  s.e.ack(s.lead, s.d.id, "done", null, { pr: ELSEWHERE, when: "approved" });
  s.e.waitPrSeen(parseWaitReading(wait({ reviewDecision: "REVIEW_REQUIRED" })));
  assert.equal(s.e.waitPr(ELSEWHERE)?.environmentId, "", "the gh reading");
  s.e.prSeen(s.w1, "env-1", { outcome: "available", pullRequest: { url: ELSEWHERE, number: 42, state: "open", checks: { state: "passing" }, review: { state: "approved" }, mergeability: { mergeable: "MERGEABLE", state: "blocked" } } });
  assert.equal(s.e.waitPr(ELSEWHERE)?.environmentId, "env-1", "bb's reading now");
  assert.equal(s.wakes().length, 1, "bb's approved reading closed the wait");
});

test("a daily reminder for a PR read through gh says what gh last saw, not that the plugin can't see it", () => {
  const s = engine();
  s.e.ack(s.lead, s.d.id, "done", null, { pr: ELSEWHERE, when: "approved" });
  s.e.waitPrSeen(parseWaitReading(wait({ checks: [run("", "IN_PROGRESS")] })));
  s.advance(24 * 3_600_000);
  s.e.tick();
  const nudge = s.e.items(500).find((i) => i.recipient === s.lead.address && i.body.startsWith("Still waiting"));
  assert.match(nudge!.body, /unchanged for 1d: open, checks pending, review review required/);
});

// ---------------------------------------------------------------- the host handlers, against a stand-in gh on PATH

/** A stand-in `gh` that logs its argv and environment and answers from a table keyed by its arguments. */
function fakeGh(table: { args: string; stdout?: string; stderr?: string; code?: number }[]) {
  const root = join(import.meta.dirname, ".scratch");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "gh-"));
  const log = join(dir, "calls.jsonl");
  writeFileSync(join(dir, "table.json"), JSON.stringify(table));
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env node
import * as fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, prompt: process.env.GH_PROMPT_DISABLED ?? null }) + "\\n");
const hit = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, "table.json"))}, "utf8")).find((r) => r.args === args.join(" "));
if (!hit) { process.stderr.write("unexpected: " + args.join(" ")); process.exit(9); }
if (hit.stdout) process.stdout.write(hit.stdout);
if (hit.stderr) process.stderr.write(hit.stderr);
process.exit(hit.code ?? 0);
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; prompt: string | null });
  return { dir, calls };
}

async function withGh<T>(dir: string, f: () => Promise<T>): Promise<T> {
  const was = process.env.PATH;
  process.env.PATH = `${dir}:${was}`;
  try {
    return await f();
  } finally {
    process.env.PATH = was;
  }
}

test("prs.wait runs exactly ghArgs.wait without a prompt, and its reading closes the wait", async () => {
  const { prHandlers } = await import("../open-prs/host.ts");
  const gh = fakeGh([{ args: ghArgs.wait(ELSEWHERE).join(" "), stdout: JSON.stringify(wait({ reviewDecision: "APPROVED" })) }]);
  const s = engine();
  s.e.ack(s.lead, s.d.id, "done", null, { pr: ELSEWHERE, when: "approved" });
  const r = await withGh(gh.dir, () => prHandlers["prs.wait"]({ url: ELSEWHERE }));
  assert.deepEqual(gh.calls(), [{ args: ghArgs.wait(ELSEWHERE), prompt: "1" }]);
  assert.equal(s.e.waitPrSeen(r).length, 1);
  assert.equal(s.wakes().length, 1);
});

test("prs.open: one search, a view per PR, one rules read per base; the page's RawPr comes out", async () => {
  const { prHandlers } = await import("../open-prs/host.ts");
  const second = "https://github.com/acme-co/widgets/pull/11";
  const gh = fakeGh([
    { args: ghArgs.openPrs("dev-one").join(" "), stdout: JSON.stringify([SEARCH[0], { ...SEARCH[0], url: second, number: 11 }]) },
    { args: ghArgs.view(PR).join(" "), stdout: JSON.stringify(VIEW) },
    { args: ghArgs.view(second).join(" "), stdout: JSON.stringify({ ...VIEW, url: second }) },
    { args: ghArgs.rules("acme-co/widgets", "main").join(" "), stdout: JSON.stringify(RULES) },
  ]);
  const out = await withGh(gh.dir, () => prHandlers["prs.open"]({ login: "dev-one" }));
  assert.equal(out.more, false);
  assert.deepEqual(out.prs.map((p) => [p.url, p.required, p.checks]), [[PR, 2, "SUCCESS"], [second, 2, "SUCCESS"]]);
  assert.equal(gh.calls().filter((c) => c.args[0] === "api").length, 1, "the rules of acme-co/widgets@main are read once");
  assert.ok(gh.calls().every((c) => c.prompt === "1"));
});

test("prs.area: a 404 moves on to CODEOWNERS' next place; any other failure fails the read, token redacted", async () => {
  const { prHandlers } = await import("../open-prs/host.ts");
  const repo = "acme-co/widgets";
  const merged = { args: ghArgs.merged(repo).join(" "), stdout: JSON.stringify([{ files: [{ path: "apps/api/y.ts" }], reviews: [review("rev-c", "APPROVED")] }]) };
  const found = fakeGh([
    { args: ghArgs.codeowners(repo, ".github/CODEOWNERS").join(" "), stderr: "gh: Not Found (HTTP 404)", code: 1 },
    { args: ghArgs.codeowners(repo, "CODEOWNERS").join(" "), stdout: "apps/api/ @api-team\n" },
    merged,
  ]);
  assert.deepEqual(await withGh(found.dir, () => prHandlers["prs.area"]({ repo })), { codeowners: "apps/api/ @api-team\n", recent: [{ files: ["apps/api/y.ts"], reviewers: ["rev-c"] }] });
  assert.equal(found.calls().length, 3, "docs/CODEOWNERS isn't read once one is found");
  const limited = fakeGh([{ args: ghArgs.codeowners(repo, ".github/CODEOWNERS").join(" "), stderr: "gh: API rate limit exceeded for ghp_abcdef123456 (HTTP 403)", code: 1 }, merged]);
  await assert.rejects(
    () => withGh(limited.dir, () => prHandlers["prs.area"]({ repo })),
    (e: Error) => /rate limit/.test(e.message) && !/ghp_/.test(e.message) && /\[redacted\]/.test(e.message),
    "a rate limit is an error (else six hours of 'no CODEOWNERS'), and the token never leaves",
  );
});
