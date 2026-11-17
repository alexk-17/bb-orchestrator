// The Open PRs tab's logic (2026-11-16): the owner's open PRs across repos, which of them need review, a plain-words
// summary per PR read from its body, suggested reviewers, and the one block of text the owner pastes in the code-review
// channel. Pure: the host entry (gh), the server and the page all import it, so the prompt block, the Post preview, what
// Confirm copies and the dry-run are one function's output.
//
// No model call anywhere: the summary is the body's TL;DR section (else its first paragraph), cut to about 200
// characters, and recomputed only when the PR's head commit changes.

import type { ReviewData } from "./pr-review-queue.ts";

// ---------------------------------------------------------------- what the host reads from GitHub (read-only GraphQL)

/** The search for one login's open PRs, a page at a time. Read-only: a query, never a mutation. */
export const OPEN_PRS_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        id number title url body isDraft updatedAt
        author { login }
        reviews(first: 100) { pageInfo { hasNextPage } nodes { state author { login __typename } commit { oid } } }
        reviewRequests(first: 100) { pageInfo { hasNextPage } nodes { requestedReviewer { __typename ... on User { login } } } }
        headRefName headRefOid reviewDecision mergeable mergeStateStatus
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        latestOpinionatedReviews(first: 30) { nodes { state author { login __typename } } }
        baseRef { rules(first: 30) { nodes { type parameters { ... on PullRequestParameters { requiredApprovingReviewCount } } } } }
      }
    }
  }
}`;

/** One PR's changed files at its head (fetched only for PRs that need review, once per head sha). */
export const PR_FILES_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { headRefOid files(first: 100) { nodes { path } } }
  }
}`;

/** A repo's CODEOWNERS (any of GitHub's three places) and its recently merged PRs with their files and reviewers. */
export const REPO_AREA_QUERY = `query($owner: String!, $name: String!, $q: String!) {
  repository(owner: $owner, name: $name) {
    a: object(expression: "HEAD:.github/CODEOWNERS") { ... on Blob { text } }
    b: object(expression: "HEAD:CODEOWNERS") { ... on Blob { text } }
    c: object(expression: "HEAD:docs/CODEOWNERS") { ... on Blob { text } }
  }
  search(query: $q, type: ISSUE, first: 40) {
    nodes {
      ... on PullRequest {
        files(first: 60) { nodes { path } }
        reviews(first: 20) { nodes { author { login __typename } } }
      }
    }
  }
}`;

export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** The search for a login's open PRs. */
export const openPrsSearch = (login: string) => `is:pr is:open author:${login} archived:false sort:updated-desc`;
/** The search for a repo's recently merged PRs (who reviewed which area). */
export const recentMergedSearch = (repo: string) => `repo:${repo} is:pr is:merged sort:updated-desc`;

/** One open PR as the host hands it to the server: GitHub's fields, flattened. */
export interface RawPr {
  nodeId?: string;
  reviewData?: ReviewData;
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
  checks: string | null; // the head commit's statusCheckRollup state; null: no checks
  approvedBy: string[]; // people (not bots) whose latest review approves
  required: number | null; // approvals the base branch's rules require, when GitHub says
}

export interface RepoArea {
  codeowners: string | null;
  recent: { files: string[]; reviewers: string[] }[];
}

type Json = Record<string, unknown> | null | undefined;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const people = (nodes: unknown[]): { login: string; state: string | null }[] =>
  nodes
    .map((n) => ({ a: obj(obj(n).author), state: str(obj(n).state) }))
    .filter(({ a }) => typeof a.login === "string" && a.__typename !== "Bot" && !String(a.login).endsWith("[bot]"))
    .map(({ a, state }) => ({ login: String(a.login), state }));

/** One page of OPEN_PRS_QUERY's answer, flattened. */
export function parseOpenPrsPage(data: Json): { prs: RawPr[]; next: string | null } {
  const s = obj(obj(data).search);
  const prs = arr(s.nodes)
    .map(obj)
    .filter((n) => typeof n.url === "string" && typeof n.number === "number")
    .map((n): RawPr => {
      const rule = arr(obj(obj(obj(n.baseRef).rules)).nodes)
        .map(obj)
        .find((r) => r.type === "PULL_REQUEST");
      const req = obj(rule?.parameters).requiredApprovingReviewCount;
      const rollup = obj(obj(obj(arr(obj(n.commits).nodes)[0]).commit).statusCheckRollup);
      return {
        nodeId: str(n.id) ?? "",
        reviewData: {
          author: str(obj(n.author).login) ?? "",
          complete: Array.isArray(obj(n.reviews).nodes) && obj(obj(n.reviews).pageInfo).hasNextPage === false && obj(obj(n.reviewRequests).pageInfo).hasNextPage === false,
          reviews: arr(obj(n.reviews).nodes).map(obj).filter((r) => obj(r.author).__typename === "User").map((r) => ({ login: str(obj(r.author).login) ?? "", state: str(r.state) ?? "", sha: str(obj(r.commit).oid) ?? "" })),
          requested: arr(obj(n.reviewRequests).nodes).map((r) => obj(obj(r).requestedReviewer)).filter((r) => r.__typename === "User").map((r) => str(r.login) ?? "").filter((login) => !!login),
        },
        url: String(n.url),
        number: n.number as number,
        title: str(n.title) ?? "",
        body: str(n.body) ?? "",
        repo: str(obj(n.repository).nameWithOwner) ?? "",
        draft: n.isDraft === true,
        updatedAt: str(n.updatedAt) ?? "",
        branch: str(n.headRefName) ?? "",
        sha: str(n.headRefOid) ?? "",
        reviewDecision: str(n.reviewDecision),
        mergeable: str(n.mergeable),
        mergeState: str(n.mergeStateStatus),
        checks: str(rollup.state),
        approvedBy: people(arr(obj(n.latestOpinionatedReviews).nodes))
          .filter((p) => p.state === "APPROVED")
          .map((p) => p.login),
        required: typeof req === "number" ? req : null,
      };
    });
  const info = obj(s.pageInfo);
  return { prs, next: info.hasNextPage === true && typeof info.endCursor === "string" ? info.endCursor : null };
}

export function parsePrFiles(data: Json): { sha: string; files: string[] } {
  const pr = obj(obj(obj(data).repository).pullRequest);
  return { sha: str(pr.headRefOid) ?? "", files: arr(obj(pr.files).nodes).map((f) => str(obj(f).path)).filter((p): p is string => !!p) };
}

export function parseRepoArea(data: Json): RepoArea {
  const r = obj(obj(data).repository);
  const codeowners = ["a", "b", "c"].map((k) => str(obj(r[k]).text)).find((t) => t !== null) ?? null;
  const recent = arr(obj(obj(data).search).nodes)
    .map(obj)
    .map((n) => ({
      files: arr(obj(n.files).nodes).map((f) => str(obj(f).path)).filter((p): p is string => !!p),
      reviewers: [...new Set(people(arr(obj(n.reviews).nodes)).map((p) => p.login))],
    }))
    .filter((n) => n.files.length > 0 && n.reviewers.length > 0);
  return { codeowners, recent };
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
  key: "draft" | "review" | "ci" | "merge";
  text: string;
  tone: ChipTone;
}

/**
 * A row's state chips. Colour only where it carries meaning: approved and CI passing green, changes requested and
 * conflicts amber, CI failing red, CI running grey, a draft muted; waiting for review and "blocked by rules" (the
 * normal state of an unapproved PR) neutral, never alarming.
 */
export function prChips(pr: { draft: boolean; review: string; approved: boolean; approvals: string; ci: Ci; merge: string }): Chip[] {
  const review: ChipTone = pr.approved ? "ok" : pr.review === "changes requested" ? "warn" : "neutral";
  const ci: ChipTone = pr.ci === "pass" ? "ok" : pr.ci === "fail" ? "fail" : pr.ci === "pending" ? "pending" : "neutral";
  const merge: ChipTone = pr.merge === "has conflicts" ? "warn" : pr.merge === "mergeable" ? "ok" : "neutral";
  const ciWords: Record<Ci, string> = { pass: "CI passing", pending: "CI running", fail: "CI failing", none: "no CI checks" };
  return [
    ...(pr.draft ? [{ key: "draft", text: "Draft", tone: "muted" } as Chip] : []),
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
export function buildPrompt(prs: PromptPr[], max = 5): string {
  if (prs.length === 0) return "";
  const blocks = prs.map((p) => `*${promptTitle(p.title, p.repo) || p.url}*\n${p.url}\n• ${noBareRefs(p.summary, p.repo).replace(/\s+/g, " ").trim()}`);
  const who = suggestReviewers(prs, max).map((c) => c.say);
  const head = prs.length === 1 ? "This PR is ready for review:" : `These ${prs.length} PRs are ready for review:`;
  return [head, ...blocks, ...(who.length ? [`${REVIEWERS_LEAD}${who.join(", ")}`] : [])].join("\n\n");
}

export const REVIEWERS_LEAD = "Suggested reviewers: ";

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
    if (line.startsWith(REVIEWERS_LEAD)) toks = textOnly(toks, (s) => splitBy(s, MENTION_RE, (m) => [m[1]!, { kind: "mention", raw: `@${m[2]}`, show: `@${m[2]}` }]));
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
