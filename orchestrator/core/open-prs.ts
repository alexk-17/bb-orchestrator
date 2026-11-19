// The Open PRs tab's logic (2026-11-16): the owner's open PRs across repos, which of them need review, a plain-words
// summary per PR read from its body, suggested reviewers, and the one block of text the owner pastes in the code-review
// channel. Pure: the host entry (gh), the server and the page all import it, so the prompt block, the Post preview, what
// Confirm copies and the dry-run are one function's output.
//
// No model call anywhere: the summary is the body's TL;DR section (else its first paragraph), cut to about 200
// characters, and recomputed only when the PR's head commit changes.

// ---------------------------------------------------------------- what the host reads from GitHub (plain gh commands)
//
// Every read is one fixed gh argument list built here from validated values, run without a shell (open-prs/host.ts).
// Only read commands: `gh search prs`, `gh pr view`, `gh pr list`, and two `gh api` REST GETs the CLI has no command
// for (CODEOWNERS and the base branch's required approvals). Nothing here can comment, review, merge, edit or label.

export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
/** A pull request's URL on a GitHub host: https://<host>/<owner>/<repo>/pull/<n>. */
export const PR_URL_RE = /^https:\/\/[A-Za-z0-9.-]{1,253}\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/\d{1,9}$/;
/** A branch name as git allows it (no spaces, no "..", no leading "-" that gh could read as a flag). */
export const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,200}$/;

/** At most this many open PRs per read; one more is asked for, to know whether there are more. */
export const OPEN_PRS_MAX = 250;
/** How many recently merged PRs a repo's area reads (who reviewed what). */
export const AREA_MERGED = 40;
/** The three places GitHub looks for CODEOWNERS, in its order. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

/** One PR's state fields a wait reads (approved, green, ready, merged). */
const WAIT_FIELDS = "url,number,state,isDraft,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus";
const PATHWAYS_FIELDS = "url,number,title,state,isDraft,createdAt,baseRefName,headRefOid,commits,reviews,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus";
/** What the search can't return about an open PR: review, checks, merge state, branches, body. */
// author and reviewRequests (2026-11-18): the review states read who wrote it and who was asked; gh pages reviews in full
const VIEW_FIELDS = "url,body,isDraft,headRefName,headRefOid,baseRefName,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,reviews,author,reviewRequests";

const must = (ok: boolean, what: string, v: unknown) => {
  if (!ok) throw new Error(`not a valid ${what}: ${JSON.stringify(v)}`);
};
/** A branch in a REST path: each segment encoded, the slashes kept (GitHub reads them as part of the name). */
const branchPath = (b: string) => b.split("/").map(encodeURIComponent).join("/");

/** The gh argument lists, each with fixed flags; a value that fails its pattern throws before gh runs. */
export const ghArgs = {
  /** The login's open PRs across repos, archived repos left out, newest update first. */
  openPrs(login: string): string[] {
    must(LOGIN_RE.test(login), "GitHub login", login);
    return ["search", "prs", "--author", login, "--state", "open", "--archived=false", "--sort", "updated", "--order", "desc", "--limit", String(OPEN_PRS_MAX + 1), "--json", "url,number,title,repository,updatedAt,isDraft"];
  },
  /** One open PR's review, checks, merge state, branches and body. */
  view(url: string): string[] {
    must(PR_URL_RE.test(url), "pull request URL", url);
    return ["pr", "view", url, "--json", VIEW_FIELDS];
  },
  /** One PR's changed files at its head. */
  files(url: string): string[] {
    must(PR_URL_RE.test(url), "pull request URL", url);
    return ["pr", "view", url, "--json", "headRefOid,files"];
  },
  /** A repo's recently merged PRs, with their files and reviews. */
  merged(repo: string): string[] {
    must(REPO_RE.test(repo), "repo", repo);
    return ["pr", "list", "--repo", repo, "--state", "merged", "--search", "sort:updated-desc", "--limit", String(AREA_MERGED), "--json", "files,reviews"];
  },
  /** The fields a PR wait reads. */
  wait(url: string): string[] {
    must(PR_URL_RE.test(url), "pull request URL", url);
    return ["pr", "view", url, "--json", WAIT_FIELDS];
  },
  pathwaysWait(url: string): string[] {
    must(PR_URL_RE.test(url), "pull request URL", url);
    return ["pr", "view", url, "--json", PATHWAYS_FIELDS];
  },
  // The two `gh api` calls stay (agreed with the CoS): gh has no command that prints a file of a repo or a branch's
  // rules. Both are REST GETs with --method GET and no -f/-F fields (fields would switch gh to a POST).
  /** CODEOWNERS at one of its places, as raw text (a 404 means: not there). */
  codeowners(repo: string, path: (typeof CODEOWNERS_PATHS)[number]): string[] {
    must(REPO_RE.test(repo), "repo", repo);
    must(CODEOWNERS_PATHS.includes(path), "CODEOWNERS place", path);
    return ["api", "--method", "GET", "-H", "Accept: application/vnd.github.raw+json", `repos/${repo}/contents/${path}`];
  },
  /** The rules on a base branch (its required approving review count is in the pull_request rule). */
  rules(repo: string, branch: string): string[] {
    must(REPO_RE.test(repo), "repo", repo);
    must(BRANCH_RE.test(branch), "branch", branch);
    return ["api", "--method", "GET", `repos/${repo}/rules/branches/${branchPath(branch)}`];
  },
};

/** One open PR as the host hands it to the server: GitHub's fields, flattened. */
export interface RawPr {
  url: string;
  number: number;
  title: string;
  body: string;
  repo: string; // owner/name
  draft: boolean;
  updatedAt: string;
  branch: string;
  sha: string;
  reviewDecision: string | null; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null (no review rule on the base)
  mergeable: string | null; // MERGEABLE | CONFLICTING | UNKNOWN
  mergeState: string | null; // CLEAN | BLOCKED | BEHIND | DIRTY | UNSTABLE | HAS_HOOKS | DRAFT | UNKNOWN
  checks: string | null; // the head commit's checks rolled up: SUCCESS | FAILURE | PENDING; null: no checks
  approvedBy: string[]; // people (not bots) whose latest review approves
  required: number | null; // approvals the base branch's rules require, when GitHub says
  author: string; // the PR's author login ("" when gh gave none)
  reviews: HumanReview[]; // submitted reviews by people (bots left out), oldest first, each with the commit it was on
  requested: string[]; // people asked to review (teams left out)
}

/** One submitted review by a person: who, its state, and the head commit it was on ("" when GitHub gave none). */
export interface HumanReview {
  login: string;
  state: string;
  sha: string;
}

export interface RepoArea {
  codeowners: string | null;
  recent: { files: string[]; reviewers: string[] }[];
}

type Json = unknown;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
/** gh prints "" for an empty enum (reviewDecision with no review rule): that is no value. */
const enumOf = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/**
 * Bots among review authors. gh gives a review's author only as a login (GraphQL's Bot type is gone), so a bot is a
 * login ending in [bot], or one of GitHub's own reviewer apps that don't.
 */
// coderabbitai (2026-11-18): gh prints CodeRabbit's reviews under the bare login, so its approval counted as a person's
const BOT_LOGINS = new Set(["copilot-pull-request-reviewer", "copilot", "github-actions", "coderabbitai", "dependabot", "renovate"]);
export const isBot = (login: string): boolean => login.toLowerCase().endsWith("[bot]") || BOT_LOGINS.has(login.toLowerCase());

/** Reviews by people (bots left out), in the order gh gives them (oldest first). */
const people = (nodes: unknown[]): { login: string; state: string | null }[] =>
  nodes
    .map((n) => ({ login: str(obj(obj(n).author).login), state: str(obj(n).state) }))
    .filter((r): r is { login: string; state: string | null } => !!r.login && !isBot(r.login));

/**
 * Who approves: each person's latest opinionated review (approved, changes requested or dismissed; a comment after
 * an approval doesn't take it back) is an approval. gh's latestReviews counts the comment, so all reviews are read.
 */
export function approversOf(reviews: unknown): string[] {
  const last = new Map<string, string>();
  for (const r of people(arr(reviews))) if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED") last.set(r.login, r.state);
  return [...last].filter(([, s]) => s === "APPROVED").map(([l]) => l);
}

/**
 * gh's statusCheckRollup is the head commit's checks one by one (CheckRun: status and conclusion; StatusContext:
 * state), not GitHub's rolled-up state: this rolls them up. Failing if any fails, else pending if any is anything but
 * passed, else SUCCESS; null when there are none. An unknown value is pending, never passing.
 */
export function rollupOf(contexts: unknown): "SUCCESS" | "FAILURE" | "PENDING" | null {
  const cs = arr(contexts).map(obj);
  if (cs.length === 0) return null;
  let pending = false;
  for (const c of cs) {
    const s = checkOf(c);
    if (s === "fail") return "FAILURE";
    if (s !== "pass") pending = true;
  }
  return pending ? "PENDING" : "SUCCESS";
}

function checkOf(c: Record<string, unknown>): "pass" | "fail" | "pending" {
  if (c.__typename === "StatusContext" || (c.state !== undefined && c.conclusion === undefined)) {
    const st = str(c.state);
    return st === "SUCCESS" ? "pass" : st === "FAILURE" || st === "ERROR" ? "fail" : "pending";
  }
  if (str(c.status) !== "COMPLETED") return "pending";
  const k = str(c.conclusion);
  if (k === "SUCCESS" || k === "NEUTRAL" || k === "SKIPPED") return "pass";
  if (k === "FAILURE" || k === "TIMED_OUT" || k === "CANCELLED" || k === "ACTION_REQUIRED" || k === "STARTUP_FAILURE") return "fail";
  return "pending";
}

/** One hit of `gh search prs`: what the list knows before each PR is viewed. */
export interface SearchHit {
  url: string;
  number: number;
  title: string;
  repo: string;
  updatedAt: string;
}

/** `gh search prs --json …`: the hits that are PRs with a URL, a number and a repo. */
export function parseSearch(data: Json): SearchHit[] {
  return arr(data)
    .map(obj)
    .filter((n) => typeof n.url === "string" && PR_URL_RE.test(n.url) && typeof n.number === "number" && !!str(obj(n.repository).nameWithOwner))
    .map((n) => ({ url: String(n.url), number: n.number as number, title: str(n.title) ?? "", repo: str(obj(n.repository).nameWithOwner)!, updatedAt: str(n.updatedAt) ?? "" }));
}

/** What `gh pr view <url> --json VIEW_FIELDS` adds to a hit; `base` is where the required-approvals rule is read. */
export type PrView = Omit<RawPr, "url" | "number" | "title" | "repo" | "updatedAt" | "required"> & { base: string | null };

export function parsePrView(data: Json): PrView {
  const n = obj(data);
  return {
    body: str(n.body) ?? "",
    draft: n.isDraft === true,
    branch: str(n.headRefName) ?? "",
    sha: str(n.headRefOid) ?? "",
    base: enumOf(n.baseRefName),
    reviewDecision: enumOf(n.reviewDecision),
    mergeable: enumOf(n.mergeable),
    mergeState: enumOf(n.mergeStateStatus),
    checks: rollupOf(n.statusCheckRollup),
    approvedBy: approversOf(n.reviews),
    author: str(obj(n.author).login) ?? "",
    reviews: arr(n.reviews)
      .map(obj)
      .map((r) => ({ login: str(obj(r.author).login) ?? "", state: str(r.state) ?? "", sha: str(obj(r.commit).oid) ?? "" }))
      .filter((r) => !!r.login && !isBot(r.login)),
    requested: arr(n.reviewRequests)
      .map(obj)
      .filter((r) => r.__typename === "User")
      .map((r) => str(r.login) ?? "")
      .filter((l) => !!l && !isBot(l)),
  };
}

/** A search hit, its view and its base's required approvals: the RawPr the page has always read. */
export function rawPr(hit: SearchHit, view: PrView, required: number | null): RawPr {
  const { base: _base, ...v } = view;
  return { url: hit.url, number: hit.number, title: hit.title, repo: hit.repo, updatedAt: hit.updatedAt, ...v, required };
}

/** `gh api repos/{o}/{r}/rules/branches/{b}`: the pull_request rule's required approving review count, if any. */
export function parseRequired(data: Json): number | null {
  const counts = arr(data)
    .map(obj)
    .filter((r) => r.type === "pull_request")
    .map((r) => obj(r.parameters).required_approving_review_count)
    .filter((c): c is number => typeof c === "number");
  return counts.length ? Math.max(...counts) : null;
}

export function parseDismissStaleReviews(data: Json): boolean | null {
  if (!Array.isArray(data)) return null;
  const policies = data.map(obj).filter((rule) => rule.type === "pull_request").map((rule) => obj(rule.parameters).dismiss_stale_reviews_on_push).filter((value): value is boolean => typeof value === "boolean");
  return policies.length ? policies.some(Boolean) : null;
}

/** `gh pr view <url> --json headRefOid,files`. */
export function parsePrFiles(data: Json): { sha: string; files: string[] } {
  const pr = obj(data);
  return { sha: str(pr.headRefOid) ?? "", files: arr(pr.files).map((f) => str(obj(f).path)).filter((p): p is string => !!p) };
}

/** CODEOWNERS (the first place that has one, else null) and `gh pr list --state merged --json files,reviews`. */
export function parseRepoArea(codeowners: string | null, merged: Json): RepoArea {
  const recent = arr(merged)
    .map(obj)
    .map((n) => ({
      files: arr(n.files).map((f) => str(obj(f).path)).filter((p): p is string => !!p),
      reviewers: [...new Set(people(arr(n.reviews)).map((p) => p.login))],
    }))
    .filter((n) => n.files.length > 0 && n.reviewers.length > 0);
  return { codeowners, recent };
}

// ---------------------------------------------------------------- PR waits read through gh (2026-11-17)
//
// A PR wait whose PR no live environment's bb reading covered in a pass reads its own PR by URL, so a wait on anyone's
// PR can fire. The reading is put in bb's PR-status shape, so the engine's one rule for each condition decides.

/** A bb PR-status reading (bb--github-pr-status pullRequests), as the engine reads it. */
export type BbPrReading =
  | { outcome: "available"; pullRequest: { url: string; number?: number; title?: string; state: string; draft?: boolean; sha?: string; createdAt?: number; headCommittedAt?: number; checksPendingSince?: number; reviews?: { login: string; state: string; sha: string; submittedAt: number | null }[]; staleReviewDismissal?: boolean | null; requiredApprovals?: number | null; attention?: string; checks?: { state?: string }; review?: { state?: string }; mergeability?: { state?: string; mergeable?: string | null; mergeStateStatus?: string | null }; inMergeQueue?: boolean | null } }
  | { outcome: "absent" }
  | { outcome: "unavailable"; message?: string };

const BB_CHECKS: Record<string, string> = { SUCCESS: "passing", FAILURE: "failing", PENDING: "pending" };
const BB_REVIEW: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", REVIEW_REQUIRED: "review_required" };
/**
 * GitHub's merge state in bb's words. CLEAN and HAS_HOOKS are GitHub's own "can merge now" (required checks and
 * reviews satisfied): ready to merge. A conflict wins over everything else.
 */
function bbMerge(mergeable: string | null, mergeState: string | null): string {
  if (mergeable === "CONFLICTING" || mergeState === "DIRTY") return "conflicts";
  switch (mergeState) {
    case "CLEAN":
    case "HAS_HOOKS":
      return "ready_to_merge";
    case "BLOCKED":
      return "blocked";
    case "BEHIND":
      return "behind";
    case "UNSTABLE":
      return "unstable";
    case "DRAFT":
      return "draft";
    default:
      return "unknown";
  }
}

/** `gh pr view <url> --json WAIT_FIELDS` as a bb reading; anything that isn't a PR reading is unavailable. */
export function parseWaitReading(data: Json, branchRules: Json = null): BbPrReading {
  const n = obj(data);
  const url = str(n.url)?.replace(/\/+$/, "") ?? "";
  const state = str(n.state);
  if (!PR_URL_RE.test(url) || !state) return { outcome: "unavailable", message: "gh gave no PR state" };
  const draft = n.isDraft === true;
  const bbState = state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : draft ? "draft" : "open";
  const rollup = rollupOf(n.statusCheckRollup);
  const review = enumOf(n.reviewDecision);
  const mergeable = enumOf(n.mergeable);
  const mergeState = enumOf(n.mergeStateStatus);
  const merge = draft ? "draft" : bbMerge(mergeable, mergeState); // a draft is never ready to merge
  const headCommit = arr(n.commits).map(obj).find((commit) => str(commit.oid) === str(n.headRefOid));
  const committedAt = headCommit && str(headCommit.committedDate) ? Date.parse(str(headCommit.committedDate)!) : NaN;
  const createdAt = str(n.createdAt) ? Date.parse(str(n.createdAt)!) : NaN;
  const pendingStarts = arr(n.statusCheckRollup).map(obj).filter((check) => checkOf(check) === "pending").map((check) => str(check.startedAt) ?? str(check.createdAt)).map((date) => date ? Date.parse(date) : NaN).filter(Number.isFinite);
  const reviews = arr(n.reviews).map(obj).map((item) => ({ login: str(obj(item.author).login), state: str(item.state), sha: str(obj(item.commit).oid), submittedAt: str(item.submittedAt) ? Date.parse(str(item.submittedAt)!) : NaN })).filter((item): item is { login: string; state: string; sha: string | null; submittedAt: number } => !!item.login && !!item.state && !isBot(item.login) && Number.isFinite(item.submittedAt)).map((item) => ({ login: item.login, state: item.state, sha: item.sha ?? "", submittedAt: item.submittedAt }));
  return {
    outcome: "available",
    pullRequest: {
      url,
      ...(str(n.headRefOid) ? { sha: str(n.headRefOid)! } : {}),
      ...(Number.isFinite(committedAt) ? { headCommittedAt: committedAt } : {}),
      ...(Number.isFinite(createdAt) ? { createdAt } : {}),
      ...(pendingStarts.length ? { checksPendingSince: Math.min(...pendingStarts) } : {}),
      reviews,
      staleReviewDismissal: parseDismissStaleReviews(branchRules),
      requiredApprovals: parseRequired(branchRules),
      ...(typeof n.number === "number" ? { number: n.number } : {}),
      ...(str(n.title) ? { title: str(n.title)! } : {}),
      ...(typeof n.isDraft === "boolean" ? { draft: n.isDraft } : {}),
      state: bbState,
      attention: merge,
      checks: rollup ? { state: BB_CHECKS[rollup]! } : {},
      review: { state: review ? (BB_REVIEW[review] ?? review.toLowerCase()) : "none" },
      mergeability: { state: merge, mergeable: mergeable ?? "UNKNOWN", mergeStateStatus: mergeState },
    },
  };
}

const bare = (u: string) => u.trim().replace(/\/+$/, "");

/**
 * The open waits' PRs to read with gh this pass: those no available bb reading covered (bb's reading is kept when it
 * has one). Each URL once; a URL that isn't a PR URL is never handed to gh.
 */
export function uncoveredWaitUrls(waitUrls: readonly string[], bbReadings: readonly BbPrReading[]): string[] {
  const covered = new Set(bbReadings.flatMap((r) => (r.outcome === "available" ? [bare(r.pullRequest.url)] : [])));
  return [...new Set(waitUrls.map(bare))].filter((u) => !covered.has(u) && PR_URL_RE.test(u));
}

// ---------------------------------------------------------------- state in plain words

export type Ci = "pass" | "pending" | "fail" | "none";

export function ciOf(rollup: string | null): Ci {
  switch (rollup) {
    case "SUCCESS":
      return "pass";
    case "FAILURE":
    case "ERROR":
      return "fail";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

/**
 * Fully approved. GitHub's reviewDecision decides whenever it has one. It is null only when the base branch has no
 * review rule: then one approval is enough (or the rules' count, if GitHub gave one).
 */
export function fullyApproved(pr: Pick<RawPr, "reviewDecision" | "approvedBy" | "required">): boolean {
  if (pr.reviewDecision) return pr.reviewDecision === "APPROVED";
  return pr.approvedBy.length >= Math.max(1, pr.required ?? 1);
}

/** Needs review: ready (not a draft), not yet fully approved, and CI not failing. */
export function needsReview(pr: Pick<RawPr, "draft" | "reviewDecision" | "approvedBy" | "required" | "checks">): boolean {
  return !pr.draft && !fullyApproved(pr) && ciOf(pr.checks) !== "fail";
}

// ---------------------------------------------------------------- the review states (2026-11-18)
//
// Three states beside Needs review, from a contributor's review queue (folded in from public PR #4): a first review (no
// person has reviewed it yet), a re-review (someone's latest review is on an older head commit), and approved on this
// head. Only people count: bots (isBot) and the PR's author never do. A comment after an approval doesn't take it back.

export type ReviewState = "first" | "rereview" | "approved";
export interface Queue {
  state: ReviewState | null;
  who: string[]; // first: requested people, else suggested; re-review: those whose review is on an older head; approved: the approvers
}

const uniq = (logins: string[]) => [...new Map(logins.map((l) => [l.toLowerCase(), l])).values()];

/** A PR's review state and its people. A draft, or a PR with no head commit or no author, has none. */
export function reviewState(pr: Pick<RawPr, "draft" | "sha" | "author" | "reviews" | "requested">, suggested: string[] = []): Queue {
  const none: Queue = { state: null, who: [] };
  if (pr.draft || !pr.sha || !pr.author) return none;
  const me = pr.author.toLowerCase();
  const person = (l: string) => !!l && !isBot(l) && l.toLowerCase() !== me && !l.includes("/");
  const reviews = pr.reviews.filter((r) => person(r.login) && ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"].includes(r.state));
  const latest = new Map<string, HumanReview>();
  const opinion = new Map<string, HumanReview>();
  for (const r of reviews) {
    latest.set(r.login.toLowerCase(), r);
    if (r.state !== "COMMENTED") opinion.set(r.login.toLowerCase(), r);
  }
  const approved = [...opinion.values()].filter((r) => r.state === "APPROVED" && r.sha === pr.sha);
  if (approved.length) return { state: "approved", who: approved.map((r) => r.login) };
  if (!reviews.length) {
    const asked = pr.requested.filter(person);
    return { state: "first", who: uniq(asked.length ? asked : suggested.filter(person).slice(0, 3)) };
  }
  // a review with no commit can't show the head moved
  const stale = [...latest.values()].filter((r) => r.sha && r.sha !== pr.sha);
  return stale.length ? { state: "rereview", who: stale.map((r) => r.login) } : none;
}

/** The state chip's words. A re-review GitHub calls approved says so, so it never contradicts the review chip. */
export function stateWords(state: ReviewState, approved: boolean): string {
  if (state === "first") return "First review";
  if (state === "approved") return "Approved on this head";
  return approved ? "Re-review: approved on an older head" : "Re-review: reviewed on an older head";
}

/** The review state in words: "changes requested", "approved", "review required" or "no review yet". */
export function reviewWords(pr: Pick<RawPr, "reviewDecision" | "approvedBy" | "required">): string {
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes requested";
  if (fullyApproved(pr)) return "approved";
  return pr.reviewDecision === "REVIEW_REQUIRED" ? "review required" : "no review yet";
}

/** Approvals so far against what's required: "1 of 2 approvals"; "1 approval" when GitHub gives no count. */
export function approvalWords(pr: Pick<RawPr, "approvedBy" | "required">): string {
  const n = pr.approvedBy.length;
  if (pr.required && pr.required > 0) return `${n} of ${pr.required} approvals`;
  return `${n} ${n === 1 ? "approval" : "approvals"}`;
}

/** Mergeability in words. */
export function mergeWords(pr: Pick<RawPr, "mergeable" | "mergeState">): string {
  if (pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY") return "has conflicts";
  if (pr.mergeState === "BEHIND") return "behind its base";
  if (pr.mergeable === "UNKNOWN" || pr.mergeState === "UNKNOWN" || !pr.mergeable) return "mergeability unknown";
  if (pr.mergeState === "BLOCKED") return "blocked by rules";
  return "mergeable";
}

/** What a state chip's colour says: green good, amber act on it, red broken, grey waiting, neutral facts, muted draft. */
export type ChipTone = "ok" | "warn" | "fail" | "pending" | "neutral" | "muted";
export interface Chip {
  key: "draft" | "state" | "review" | "ci" | "merge";
  text: string;
  tone: ChipTone;
}

/**
 * A row's state chips. Colour only where it carries meaning: approved and CI passing green, changes requested and
 * conflicts amber, CI failing red, CI running grey, a draft muted; waiting for review and "blocked by rules" (the
 * normal state of an unapproved PR) neutral, never alarming.
 */
export function prChips(pr: { draft: boolean; review: string; approved: boolean; approvals: string; ci: Ci; merge: string; state?: ReviewState | null }): Chip[] {
  const review: ChipTone = pr.approved ? "ok" : pr.review === "changes requested" ? "warn" : "neutral";
  const ci: ChipTone = pr.ci === "pass" ? "ok" : pr.ci === "fail" ? "fail" : pr.ci === "pending" ? "pending" : "neutral";
  const merge: ChipTone = pr.merge === "has conflicts" ? "warn" : pr.merge === "mergeable" ? "ok" : "neutral";
  const ciWords: Record<Ci, string> = { pass: "CI passing", pending: "CI running", fail: "CI failing", none: "no CI checks" };
  return [
    ...(pr.draft ? [{ key: "draft", text: "Draft", tone: "muted" } as Chip] : []),
    ...(pr.state ? [{ key: "state", text: stateWords(pr.state, pr.approved), tone: pr.state === "approved" ? "ok" : pr.state === "rereview" ? "warn" : "neutral" } as Chip] : []),
    { key: "review", text: `${pr.review}, ${pr.approvals}`, tone: review },
    { key: "ci", text: ciWords[pr.ci], tone: ci },
    { key: "merge", text: pr.merge, tone: merge },
  ];
}

/** The wide Open PRs table's sortable columns. Ascending puts what needs a hand first: changes requested, CI failing. */
export type PrSort = "updated" | "project" | "review" | "ci";
const REVIEW_RANK = (pr: { approved: boolean; review: string }) => (pr.review === "changes requested" ? 0 : pr.approved ? 2 : 1);
const CI_RANK: Record<Ci, number> = { fail: 0, pending: 1, none: 2, pass: 3 };
export function sortPrs<T extends { approved: boolean; review: string; ci: Ci; project: string | null; updatedAt: string; url: string }>(prs: readonly T[], key: PrSort, desc: boolean): T[] {
  const by = (a: T, b: T): number =>
    key === "updated"
      ? Date.parse(a.updatedAt) - Date.parse(b.updatedAt)
      : key === "project"
        ? (a.project === null ? 1 : 0) - (b.project === null ? 1 : 0) || (a.project ?? "").localeCompare(b.project ?? "")
        : key === "review"
          ? REVIEW_RANK(a) - REVIEW_RANK(b)
          : CI_RANK[a.ci] - CI_RANK[b.ci];
  // ties keep the newest first, whatever the direction
  return [...prs].sort((a, b) => (desc ? -by(a, b) : by(a, b)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.url.localeCompare(b.url));
}

/** The row's PR link words: "repo#123" (repo without its owner), never a bare #number. */
export const prRef = (pr: { repo: string; number: number }): string => `${pr.repo.split("/").pop() || pr.repo}#${pr.number}`;

// ---------------------------------------------------------------- the summary (no model)

export const SUMMARY_MAX = 200;

/** Markdown down to plain words: links to their text, no emphasis, code ticks, images, HTML or comments. */
function plain(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/(\*\*|\*|~~)(?=\S)(.+?)\1/g, "$2")
    // underscores only as emphasis at word edges, so snake_case names stay whole
    .replace(/(^|[^\w])(__|_)(?=\S)(.+?)\2(?=[^\w]|$)/g, "$1$3")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut at a word near `max`, with an ellipsis. */
export function cut(s: string, max = SUMMARY_MAX): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max - 1);
  const at = head.lastIndexOf(" ");
  return `${(at > max * 0.6 ? head.slice(0, at) : head).replace(/[\s,;:.–—-]+$/, "")}…`;
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const TLDR = /^\W*tl\s*;?\s*dr\b\W*/i;

/**
 * The PR's summary: its TL;DR (a "TL;DR" heading's section, or a "TL;DR:" line and what follows it in that paragraph),
 * else the first paragraph of prose (no headings, code blocks, tables or rules), else its title; cut to about 200.
 */
export function extractSummary(body: string, title: string): string {
  const lines = body.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const paragraphs: { text: string; heading: string | null }[] = [];
  let heading: string | null = null;
  let buf: string[] = [];
  let fence = false;
  const flush = () => {
    if (buf.length) paragraphs.push({ text: buf.join("\n"), heading });
    buf = [];
  };
  for (const line of lines) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      flush();
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const h = HEADING.exec(line);
    if (h) {
      flush();
      heading = plain(h[1] ?? "");
      continue;
    }
    if (!line.trim() || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*\|/.test(line)) {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  // a TL;DR heading: its section's first paragraph (or two short ones)
  const underTldr = paragraphs.filter((p) => p.heading !== null && TLDR.test(p.heading));
  if (underTldr.length) {
    const text = plain(underTldr.slice(0, 2).map((p) => p.text).join(" "));
    if (text) return cut(text);
  }
  // a "TL;DR:" line (bold or not) inside a paragraph
  for (const p of paragraphs) {
    const t = plain(p.text);
    const m = /\btl\s*;?\s*dr\b\W*/i.exec(t);
    if (m) {
      const rest = t.slice(m.index + m[0].length).trim();
      if (rest) return cut(rest);
    }
  }
  const first = paragraphs.map((p) => plain(p.text)).find((t) => t.length > 0);
  return cut(first ?? plain(title));
}

export type SummaryCache = Record<string, { sha: string; summary: string }>;

/** The cached summary when the head is unchanged; else computed (and the cache entry replaced). */
export function summaryFor(cache: SummaryCache, pr: Pick<RawPr, "url" | "sha" | "body" | "title">, compute: (body: string, title: string) => string = extractSummary): { summary: string; computed: boolean } {
  const hit = cache[pr.url];
  if (hit && hit.sha === pr.sha && pr.sha) return { summary: hit.summary, computed: false };
  const summary = compute(pr.body, pr.title);
  cache[pr.url] = { sha: pr.sha, summary };
  return { summary, computed: true };
}

/** The cache kept to the PRs still open, so it doesn't grow with every PR ever seen. */
export function pruneCache<T>(cache: Record<string, T>, keep: Iterable<string>): Record<string, T> {
  const k = new Set(keep);
  return Object.fromEntries(Object.entries(cache).filter(([url]) => k.has(url)));
}

// ---------------------------------------------------------------- reviewers

/** CODEOWNERS rules, in file order (the last matching rule wins). */
export function parseCodeowners(text: string | null): { re: RegExp; owners: string[] }[] {
  if (!text) return [];
  const rules: { re: RegExp; owners: string[] }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern) continue;
    rules.push({ re: patternRe(pattern), owners });
  }
  return rules;
}

/** A CODEOWNERS (gitignore-style) pattern as a regex over a repo path. */
function patternRe(p: string): RegExp {
  const anchored = p.startsWith("/") || p.replace(/\/$/, "").includes("/");
  const dir = p.endsWith("/");
  const core = p.replace(/^\//, "").replace(/\/$/, "");
  const body = core
    .split(/(\*\*\/|\/\*\*|\*\*|\*|\?)/)
    .map((t) => (t === "**/" ? "(?:.*/)?" : t === "/**" ? "(?:/.*)?" : t === "**" ? ".*" : t === "*" ? "[^/]*" : t === "?" ? "[^/]" : t.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}${dir ? "/.*" : "(?:/.*)?"}$`);
}

/** The owners of one path: the last matching rule's. */
export function ownersOf(rules: { re: RegExp; owners: string[] }[], path: string): string[] {
  for (let i = rules.length - 1; i >= 0; i--) if (rules[i]!.re.test(path)) return rules[i]!.owners;
  return [];
}

/** An area: a path's first two folders ("apps/api"), or its folder when it has one, else the file. */
export function areaOf(path: string): string {
  const parts = path.split("/");
  return parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length === 2 ? parts[0]! : path;
}

/** One suggested reviewer for a PR, as the page gets it: `say` is what the prompt prints. */
export interface Candidate {
  name: string; // a GitHub login, an org/team, or an email, without "@"
  say: string; // "@slackhandle" only through the map; else the plain name
  owner: boolean; // a CODEOWNER of a changed file
  recent: number; // recent merged PRs in the same areas this person reviewed
}

/**
 * A PR's candidates: CODEOWNERS of its changed files, then who reviewed the same areas in recent merged PRs. The author
 * and bots never; a team or an email is shown as it is, untagged.
 */
export function candidatesFor(files: string[], area: RepoArea | null, author: string, handles: Record<string, string>): Candidate[] {
  const me = author.toLowerCase();
  const by = new Map<string, Candidate>();
  const add = (name: string, f: (c: Candidate) => void) => {
    const n = name.replace(/^@/, "");
    if (!n || n.toLowerCase() === me || n.toLowerCase().endsWith("[bot]")) return;
    const key = n.toLowerCase();
    const c = by.get(key) ?? { name: n, say: tag(n, handles), owner: false, recent: 0 };
    f(c);
    by.set(key, c);
  };
  if (area) {
    const rules = parseCodeowners(area.codeowners);
    for (const f of files) for (const o of ownersOf(rules, f)) add(o, (c) => (c.owner = true));
    const areas = new Set(files.map(areaOf));
    for (const r of area.recent) {
      if (!r.files.some((f) => areas.has(areaOf(f)))) continue;
      for (const who of r.reviewers) add(who, (c) => (c.recent += 1));
    }
  }
  return rank([...by.values()]);
}

const rank = (cs: Candidate[]) => cs.sort((a, b) => Number(b.owner) - Number(a.owner) || b.recent - a.recent || a.name.localeCompare(b.name));

/**
 * A name as the prompt prints it: "@handle" only when the login is in the owner's login-to-Slack map (any case);
 * otherwise the plain name, never a guessed handle. Teams and emails are never logins, so never tagged.
 */
export function tag(name: string, handles: Record<string, string>): string {
  const n = name.replace(/^@/, "");
  if (n.includes("/") || n.includes("@")) return n;
  const hit = Object.entries(handles).find(([login]) => login.toLowerCase() === n.toLowerCase());
  const h = hit?.[1]?.trim().replace(/^@/, "");
  return h ? `@${h}` : n;
}

/** The suggested reviewers over a set of PRs: CODEOWNERS first, then by recent reviews in the area; at most `max`. */
export function suggestReviewers(prs: { candidates: Candidate[] }[], max = 5): Candidate[] {
  const by = new Map<string, Candidate>();
  for (const p of prs)
    for (const c of p.candidates) {
      const key = c.name.toLowerCase();
      const had = by.get(key);
      by.set(key, had ? { ...had, owner: had.owner || c.owner, recent: had.recent + c.recent } : { ...c });
    }
  return rank([...by.values()]).slice(0, max);
}

// ---------------------------------------------------------------- the prompt

/** A bare "#123" (not "owner/repo#123", not "&#123;") becomes the full URL in its repo; GitHub sends /issues/ on to a PR. */
export function noBareRefs(text: string, repo: string): string {
  return text.replace(/(^|[^\w/&#])#(\d+)\b/g, (_m, pre: string, n: string) => `${pre}https://github.com/${repo}/issues/${n}`);
}

/** Matches a bare "#123" the prompt must never hold. */
export const BARE_REF = /(^|[^\w/&#])#\d+\b/;

export interface PromptPr {
  url: string;
  title: string;
  repo: string;
  summary: string;
  candidates: Candidate[];
}

/** A PR title as the prompt prints it: one line, no bare #number, no "*" that would break its bold. */
export const promptTitle = (title: string, repo: string): string => noBareRefs(title, repo).replace(/\*/g, "").replace(/\s+/g, " ").trim();

/**
 * The text the owner pastes, written as Slack shows it: each PR as its title in bold, its full URL on its own line
 * (Slack links a bare URL, and the URL stays readable) and a one-bullet summary; then the suggested reviewers (from
 * these PRs only, mapped ones as @handle). Empty when no PR is given. The preview, the HTML flavour and the copy are
 * all this string, through slackLines (2026-11-16 rev 2).
 */
export function buildPrompt(prs: PromptPr[], max = 5, again = false): string {
  if (prs.length === 0) return "";
  const blocks = prs.map((p) => `*${promptTitle(p.title, p.repo) || p.url}*\n${p.url}\n• ${noBareRefs(p.summary, p.repo).replace(/\s+/g, " ").trim()}`);
  const who = suggestReviewers(prs, max).map((c) => c.say);
  // again (2026-11-18): the Re-review filter's ask, to the people whose review is on an older head
  const head = again
    ? prs.length === 1 ? "This PR changed since it was reviewed:" : `These ${prs.length} PRs changed since they were reviewed:`
    : prs.length === 1 ? "This PR is ready for review:" : `These ${prs.length} PRs are ready for review:`;
  return [head, ...blocks, ...(who.length ? [`${again ? REASK_LEAD : REVIEWERS_LEAD}${who.join(", ")}`] : [])].join("\n\n");
}

export const REVIEWERS_LEAD = "Suggested reviewers: ";
/** Re-review's people line (2026-11-18, the owner's layout feedback): they reviewed before, so they are asked again. */
export const REASK_LEAD = "Reviewers to re-ask: ";
/** The lines whose @handles are mentions: the people lines, and no other (a title's "@" stays text). */
const isPeopleLine = (line: string) => line.startsWith(REVIEWERS_LEAD) || line.startsWith(REASK_LEAD);

// ---------------------------------------------------------------- the Slack formatter (preview, HTML, copy)

/** One run of a line: `raw` is its exact characters in the copied text, `show` what Slack draws. */
export interface SlackTok {
  kind: "text" | "bold" | "link" | "mention";
  raw: string;
  show: string;
}
export interface SlackLine {
  bullet: boolean;
  toks: SlackTok[];
}

const URL_RE = /https?:\/\/[^\s<>]+?(?=[.,:;!?)\]…]*(?:\s|$))/g;
const BOLD_RE = /(^|\s)\*(\S(?:[^*\n]*\S)?)\*(?=\s|$|[.,:;!?])/g;
const MENTION_RE = /(^|[\s,(])@([A-Za-z0-9._-]+)/g;

/** Split `s` on `re`: each match's `pick(m)` = [prefix kept as text, token]; the rest stays text. */
function splitBy(s: string, re: RegExp, pick: (m: RegExpExecArray) => [string, SlackTok]): SlackTok[] {
  const out: SlackTok[] = [];
  let at = 0;
  for (const m of s.matchAll(new RegExp(re.source, re.flags))) {
    const [pre, tok] = pick(m as RegExpExecArray);
    const start = m.index! + pre.length;
    if (start > at) out.push({ kind: "text", raw: s.slice(at, start), show: s.slice(at, start) });
    out.push(tok);
    at = m.index! + m[0].length;
  }
  if (at < s.length) out.push({ kind: "text", raw: s.slice(at), show: s.slice(at) });
  return out;
}

const textOnly = (toks: SlackTok[], f: (s: string) => SlackTok[]): SlackTok[] => toks.flatMap((t) => (t.kind === "text" ? f(t.raw) : [t]));

/**
 * The copied text as Slack draws it, line by line: a URL is a link, *words* bold, and on the reviewers line an
 * @handle a mention (an unmapped name has no "@", so it stays plain). Joining every token's raw gives the text back
 * exactly (slackText), so the preview can't show anything the copy doesn't hold.
 */
export function slackLines(text: string): SlackLine[] {
  return text.split("\n").map((line) => {
    let toks: SlackTok[] = line ? [{ kind: "text", raw: line, show: line }] : [];
    toks = textOnly(toks, (s) => splitBy(s, URL_RE, (m) => ["", { kind: "link", raw: m[0], show: m[0] }]));
    toks = textOnly(toks, (s) => splitBy(s, BOLD_RE, (m) => [m[1]!, { kind: "bold", raw: `*${m[2]}*`, show: m[2]! }]));
    if (isPeopleLine(line)) toks = textOnly(toks, (s) => splitBy(s, MENTION_RE, (m) => [m[1]!, { kind: "mention", raw: `@${m[2]}`, show: `@${m[2]}` }]));
    return { bullet: line.startsWith("• "), toks };
  });
}

export const slackText = (lines: SlackLine[]): string => lines.map((l) => l.toks.map((t) => t.raw).join("")).join("\n");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The clipboard's text/html flavour, from the same tokens: bold as <b>, a URL as a link whose words are the URL
 * itself (so it stays visible), mentions as their plain @handle. Slack's composer keeps links and bold from a rich
 * paste; anything that ignores HTML takes the text/plain flavour, buildPrompt's string.
 */
export function slackHtml(lines: SlackLine[]): string {
  const tok = (t: SlackTok) => (t.kind === "bold" ? `<b>${esc(t.show)}</b>` : t.kind === "link" ? `<a href="${esc(t.raw)}">${esc(t.show)}</a>` : esc(t.show));
  return lines.map((l) => l.toks.map(tok).join("")).join("<br>");
}

// ---------------------------------------------------------------- the posted message (2026-11-17)

/** The @handles a Post would mention: the reviewers line's mention tokens, without "@". */
export const mentionHandles = (text: string): string[] => [...new Set(slackLines(text).flatMap((l) => l.toks.filter((t) => t.kind === "mention").map((t) => t.raw.slice(1))))];

/** Slack's three control characters, escaped as its API wants them in text (it shows them back as typed). */
const slackEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * What Post shows and what it sends, from the one copied string and the handles' user IDs. `shown` is the text the
 * confirm draws: the copied string, except that a handle no one in Slack has loses its "@" (it would never be a mention).
 * `posted` is `shown` as Slack's API takes it: a resolved handle becomes <@ID> (a real mention, which a typed @handle
 * sent through the API is not) and &, < and > are escaped. Slack draws `posted` as `shown`, so the message is the preview.
 */
export function slackPost(text: string, ids: Record<string, string | null>): { shown: string; posted: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const shown: string[] = [];
  const posted: string[] = [];
  for (const l of slackLines(text)) {
    let s = "";
    let p = "";
    for (const t of l.toks) {
      if (t.kind !== "mention") {
        s += t.raw;
        p += slackEsc(t.raw);
        continue;
      }
      const h = t.raw.slice(1);
      const id = ids[h.toLowerCase()] ?? null;
      if (id && /^[UW][A-Z0-9]{2,}$/.test(id)) {
        s += t.raw;
        p += `<@${id}>`;
      } else {
        unresolved.push(h);
        s += h;
        p += slackEsc(h);
      }
    }
    shown.push(s);
    posted.push(p);
  }
  return { shown: shown.join("\n"), posted: posted.join("\n"), unresolved };
}

// ---------------------------------------------------------------- when to read GitHub again

/**
 * Whether the tab may start a GitHub read now. Gated on the last attempt, not the last success, so a failing gh never
 * retries in a loop (each finished read makes the page read again). With polling off (0), a first read still runs, and
 * a failed first read is retried after five minutes.
 */
export function dueToFetch(s: { hasSnapshot: boolean; lastAttempt: number | null; now: number; pollMs: number }): boolean {
  if (s.lastAttempt === null) return true;
  const gap = s.pollMs > 0 ? s.pollMs : s.hasSnapshot ? Number.POSITIVE_INFINITY : 5 * 60_000;
  return s.now - s.lastAttempt >= gap;
}

// ---------------------------------------------------------------- the kept snapshot (2026-11-17)
//
// The last good read is kept in plugin storage, so a restart (an install, a reload) shows the PRs at once, marked with
// when they were checked, while a new read runs: the owner measured 18-21 s of an empty tab after each install. Only
// what the page shows is kept (no PR bodies, no changed files): each PR's suggested reviewers are kept as computed,
// without their @handle, which the read adds from the current slackHandleMap.

export const KEPT_VERSION = 1;
/** One PR as kept: the fields the read shows and needsReview judges, its summary, its agent and its candidates. */
export interface KeptPr extends Omit<RawPr, "body" | "branch" | "sha" | "author" | "reviews" | "requested"> {
  summary: string;
  // the review states (2026-11-18): optional, so a snapshot kept before them still loads (no state until the next read)
  sha?: string;
  queue?: Queue;
  agent: { address: string; role: string; project: string | null } | null;
  cands: Omit<Candidate, "say">[];
}
export interface KeptSnapshot {
  v: typeof KEPT_VERSION;
  login: string;
  at: number;
  more: boolean;
  prs: KeptPr[];
}

const isStr = (v: unknown): v is string => typeof v === "string";
const keptPrOk = (v: unknown): boolean => {
  const p = obj(v);
  const a = p.agent === null ? true : isStr(obj(p.agent).address) && isStr(obj(p.agent).role);
  return (
    isStr(p.url) && PR_URL_RE.test(p.url) && typeof p.number === "number" && isStr(p.title) && isStr(p.repo) && isStr(p.updatedAt) && typeof p.draft === "boolean" &&
    Array.isArray(p.approvedBy) && p.approvedBy.every(isStr) && isStr(p.summary) && Array.isArray(p.cands) && p.cands.every((c) => isStr(obj(c).name)) && a
  );
};

/** What storage gave back, if it is a kept snapshot of this login in this version; anything else is no snapshot. */
export function parseKept(v: unknown, login: string): KeptSnapshot | null {
  const s = obj(v);
  if (s.v !== KEPT_VERSION || s.login !== login || typeof s.at !== "number" || !Number.isFinite(s.at) || typeof s.more !== "boolean" || !Array.isArray(s.prs)) return null;
  return s.prs.every(keptPrOk) ? (s as unknown as KeptSnapshot) : null;
}

/** A PR's candidates as kept: the name, CODEOWNER and recent counts, in rank order; the @handle comes at read time. */
export const keptCands = (cs: Candidate[]): Omit<Candidate, "say">[] => cs.map(({ say: _say, ...c }) => c);
/** The kept candidates with their @handle from the current map (tag), so a map edited after the read still applies. */
export const sayCands = (cs: Omit<Candidate, "say">[], handles: Record<string, string>): Candidate[] => cs.map((c) => ({ ...c, say: tag(c.name, handles) }));

// ---------------------------------------------------------------- settings

/** reviewExcludedProjects: project slugs separated by commas, spaces or new lines. */
export const parseExcluded = (s: string): string[] => [...new Set(s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean))];

/** slackHandleMap: a JSON object of GitHub login → Slack handle. Anything else is no map, with the reason. */
export function parseHandleMap(s: string): { map: Record<string, string>; error: string | null } {
  if (!s.trim()) return { map: {}, error: null };
  try {
    const v = JSON.parse(s) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { map: {}, error: "slackHandleMap is not a JSON object" };
    const map: Record<string, string> = {};
    for (const [k, h] of Object.entries(v)) if (typeof h === "string" && h.trim()) map[k] = h.trim();
    return { map, error: null };
  } catch {
    return { map: {}, error: "slackHandleMap is not valid JSON" };
  }
}

/** Which PRs start ticked in the Post preview: all but the excluded projects'. */
export function initialTicks(prs: { url: string; project: string | null }[], excluded: string[]): Record<string, boolean> {
  const ex = new Set(excluded);
  return Object.fromEntries(prs.map((p) => [p.url, !(p.project && ex.has(p.project))]));
}

/**
 * reviewChannel as a link bb can open and the name the page says. A link is kept as it is; a name (with or without "#")
 * opens through Slack's app_redirect, which takes a channel name or ID.
 */
export function channelOf(setting: string): { url: string; name: string } | null {
  const s = setting.trim();
  if (!s) return null;
  if (/^https:\/\//i.test(s)) {
    let name = "the review channel";
    try {
      const u = new URL(s);
      const ch = u.searchParams.get("channel");
      if (ch && !/^[CG][A-Z0-9]{6,}$/.test(ch)) name = `#${ch.replace(/^#/, "")}`;
    } catch {
      return null;
    }
    return { url: s, name };
  }
  const n = s.replace(/^#/, "");
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(n)) return null;
  return { url: `https://slack.com/app_redirect?channel=${encodeURIComponent(n)}`, name: /^[CG][A-Z0-9]{6,}$/.test(n) ? "the review channel" : `#${n}` };
}
