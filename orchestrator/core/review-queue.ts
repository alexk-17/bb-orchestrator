// The CodeRabbit review queue's policy (2026-11-18, ported from a contributor's public PR): which queued PR may get
// "@coderabbitai review" next, the holds and spacing that keep it from asking twice, and the reading of CodeRabbit's
// replies. Pure: no clock, no GitHub, no model. The runner (review-queue/runner.ts) and the host's last recheck
// (review-queue/host.ts) both decide with assess(), so neither can relax it.
//
// The only GitHub write is TRIGGER, posted by queueArgs.trigger in review-queue/host.ts. Every other gh call here is a
// fixed, read-only argument list built from checked values.
import { z } from "zod";
import { LOGIN_RE, REPO_RE } from "./open-prs.ts";

/** At least this long between two requests, anywhere in the queue. */
export const MIN_GAP = 60 * 60_000;
/** A request with no definite answer holds its PR this long, so a lost reply never becomes a second request. */
export const HOLD = 3 * MIN_GAP;
/** The one comment the queue ever writes. */
export const TRIGGER = "@coderabbitai review";
/** The queue holds at most this many PRs; Auto looks at most at this many of the owner's. */
export const QUEUE_MAX = 50;
/** The interval choices the page offers (minutes). 65 by default, so a run doesn't land on the hour with others. */
export const INTERVALS = [65, 90, 120, 180, 360, 720, 1440] as const;
export const CODERABBIT = "coderabbitai[bot]";

export const factsSchema = z.object({
  url: z.string(),
  title: z.string(),
  head: z.string().min(1),
  author: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  conflict: z.boolean(),
  ci: z.enum(["pass", "pending", "fail", "unknown"]), // required checks only
  approvals: z.number().int().nonnegative(), // people's approvals on the current head
  threads: z.number().int().nonnegative(), // unresolved review threads
  reviewedHead: z.boolean(), // CodeRabbit already reviewed this head
  lastReview: z.object({ head: z.string(), at: z.number(), state: z.string() }).nullable(),
  inProgressAt: z.number().nullable(),
  recentRequestAt: z.number().nullable(),
});
export type Facts = z.infer<typeof factsSchema>;

export const entrySchema = z.object({
  url: z.string(),
  auto: z.boolean(), // found by Auto, not added by the owner
  pinned: z.boolean(),
  addedAt: z.number(),
  facts: factsSchema.nullable(),
  error: z.string().nullable(),
  fetchedAt: z.number().nullable(),
});
export type Entry = z.infer<typeof entrySchema>;

export const outcomeSchema = z.enum(["posting", "posted", "accepted", "not_completed", "no_reply", "unknown", "post_failed", "rate_limited", "dry_run"]);
export type Outcome = z.infer<typeof outcomeSchema>;

export const attemptSchema = z.object({
  url: z.string(),
  head: z.string(),
  at: z.number(),
  outcome: outcomeSchema,
  attempts: z.number().int().nonnegative(),
  commentUrl: z.string().nullable(),
});
export type Attempt = z.infer<typeof attemptSchema>;

const name = z.string().max(200);
const configShape = {
  enabled: z.boolean(), // Schedule
  auto: z.boolean(),
  intervalMinutes: z.number().int().min(60).max(10080),
  hostId: name, // "" = the only connected machine
  // The optional model picker, off while pickerProvider is "" (the default): the deterministic pick is used.
  pickerProvider: name,
  pickerModel: name,
  pickerProjectId: name,
};
export const configSchema = z
  .object({ ...configShape, pickerProvider: name.default(""), pickerModel: name.default(""), pickerProjectId: name.default("") })
  .strict();
/** A settings change from the page: only the fields it names, so a Schedule toggle can't touch the picker, nor the reverse. */
export const configPatchSchema = z.object(configShape).partial().strict();
export type QueueConfig = z.infer<typeof configSchema>;

export const stateSchema = z.object({
  config: configSchema,
  entries: z.array(entrySchema).max(QUEUE_MAX),
  history: z.record(z.string(), attemptSchema), // the live requests, by PR; never cleared by Remove
  nextAt: z.number().nullable(),
  cooldownUntil: z.number().nullable(),
  lastAt: z.number().nullable(),
  lastMessage: z.string(),
  /** The last dry run's pick: what a live run would have posted, and where. */
  wouldPost: z.object({ url: z.string(), head: z.string(), at: z.number(), comment: z.string() }).nullable(),
  /** Who chose the last run's PR: the deterministic order, the model, or a fallback and why. */
  lastPicker: z.string().default("Deterministic"),
  login: z.string(),
  error: z.string().nullable(),
  fetchedAt: z.number().nullable(),
});
export type QueueState = z.infer<typeof stateSchema>;

/** Set up (Home first, 2026-11-20): the schedule on, anything queued, a run, or dry-run turned off. A fresh install is none of these. */
export const queueSetUp = (s: QueueState, dryRun: boolean): boolean => s.config.enabled || s.entries.length > 0 || s.lastAt !== null || Object.keys(s.history).length > 0 || !dryRun;

/** The defaults: Schedule off, Auto off. Dry-run is the reviewQueueDryRun setting (on by default), not state. */
export const initialState = (): QueueState => ({
  config: { enabled: false, auto: false, intervalMinutes: 65, hostId: "", pickerProvider: "", pickerModel: "", pickerProjectId: "" },
  entries: [],
  history: {},
  nextAt: null,
  cooldownUntil: null,
  lastAt: null,
  lastMessage: "No runs yet",
  wouldPost: null,
  lastPicker: "Deterministic",
  login: "",
  error: null,
  fetchedAt: null,
});

/** A github.com PR URL (a /files, /commits or /checks tail, a query or a hash is dropped), else a throw. */
export function parsePrUrl(value: string): { repo: string; number: number; url: string } {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d{0,8})(?:\/(?:files|commits|checks))?\/?(?:[?#].*)?$/.exec(value.trim());
  const repo = m ? `${m[1]}/${m[2]}` : "";
  if (!m || !REPO_RE.test(repo)) throw new Error("Enter a GitHub pull request URL (https://github.com/owner/repo/pull/123).");
  const number = Number(m[3]);
  return { repo, number, url: `https://github.com/${repo}/pull/${number}` };
}

/** Whether a queued PR may be asked for now, why, and its priority tier (lower first). */
export function assess(entry: Entry, attempt: Attempt | null, login: string, now: number): { eligible: boolean; reason: string; tier: number } {
  const no = (reason: string) => ({ eligible: false, reason, tier: 9 });
  const f = entry.facts;
  if (entry.error || !f) return no(entry.error || "Not checked yet");
  if (f.state !== "open") return no(f.state === "merged" ? "Merged" : "Closed");
  if (f.reviewedHead) return no("CodeRabbit already reviewed this head");
  if (f.draft) return no("Draft");
  // Auto's own finds: only the signed-in user's, conflict-free, with passing required checks. Manual entries may be anyone's.
  if (entry.auto && (!login || f.author.toLowerCase() !== login.toLowerCase())) return no("Not authored by the signed-in user");
  if (entry.auto && f.conflict) return no("Merge conflict");
  if (entry.auto && f.ci !== "pass") return no("Auto waits for passing required checks");
  if (f.inProgressAt !== null && (f.inProgressAt === 0 || now - f.inProgressAt < 2 * MIN_GAP)) return no("CodeRabbit review in progress");
  if (f.recentRequestAt !== null && now - f.recentRequestAt < HOLD) return no("Review requested in the last 3 hours");
  if (attempt && attempt.outcome !== "post_failed" && attempt.outcome !== "dry_run") {
    if (now - attempt.at < HOLD && (entry.auto || attempt.outcome !== "rate_limited")) return no("Waiting up to 3 hours for the previous request");
    if (attempt.head === f.head && attempt.attempts >= 3) return no("3 attempts on this head; waiting for new commits");
  }
  const tier = entry.pinned ? 0 : f.approvals === 1 ? 1 : f.approvals === 0 && !f.conflict && f.ci === "pass" ? 2 : 3;
  const reason = ["Pinned next", "1 human approval on head", "Ready for human review", "Manual queue candidate"][tier]!;
  return { eligible: true, tier, reason };
}

/** The next PR: pinned, then exactly one approval on head, then ready and unapproved, then the rest; queue order breaks ties. */
export function pick(entries: readonly Entry[], history: Readonly<Record<string, Attempt>>, login: string, now: number): Entry | null {
  return (
    entries
      .map((e, i) => ({ e, i, a: assess(e, history[e.url] ?? null, login, now) }))
      .filter((x) => x.a.eligible)
      .sort((a, b) => a.a.tier - b.a.tier || a.i - b.i)[0]?.e ?? null
  );
}

export type Comment = { author: string; body: string; at: number; updatedAt?: number; url?: string };

/** CodeRabbit's marked automatic reply to a request made at `since`: accepted, not completed or rate limited. */
export function replyOutcome(comments: readonly Comment[], since: number): Outcome | null {
  const c = comments.filter((c) => c.author === CODERABBIT && c.at >= since && /auto-generated reply by CodeRabbit/i.test(c.body)).sort((a, b) => b.at - a.at)[0];
  if (!c) return null;
  return /rate limit/i.test(c.body) ? "rate_limited" : /Action not completed/i.test(c.body) ? "not_completed" : /Action performed/i.test(c.body) ? "accepted" : null;
}

/** A rate limit's end, from the bot's "Next included review available in …": an hour if it says none, at most six. */
export function cooldownUntil(body: string, updatedAt: number, now: number): number {
  const text = /Next included review available in ([^.\n*]+)/i.exec(body)?.[1] ?? "";
  let ms = 0;
  for (const m of text.matchAll(/(\d{1,6})\s*(hour|minute|second)/gi)) ms += Number(m[1]) * ({ hour: 3600_000, minute: 60_000, second: 1000 }[m[2]!.toLowerCase()] ?? 0);
  const until = updatedAt + Math.min(ms, 6 * MIN_GAP);
  return ms > 0 && until > now ? Math.min(until, now + 6 * MIN_GAP) : now + MIN_GAP;
}

/** No request before this: the rate limit's cooldown, and MIN_GAP after every live request. */
export function spacingUntil(state: Pick<QueueState, "cooldownUntil" | "history">): number {
  return Math.max(state.cooldownUntil ?? 0, ...Object.values(state.history).filter((a) => a.outcome !== "post_failed" && a.outcome !== "dry_run").map((a) => a.at + MIN_GAP));
}

/** Requests still waiting on CodeRabbit's answer, within the hold. */
export function outstanding(history: Readonly<Record<string, Attempt>>, now: number): Attempt[] {
  return Object.values(history).filter((a) => ["posting", "posted", "unknown", "no_reply"].includes(a.outcome) && now - a.at <= HOLD);
}

// ---------------------------------------------------------------- gh's argument lists

/** The review threads read: GraphQL is the only API that says whether a thread is resolved. A query, never a mutation. */
export const THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}";
const CURSOR_RE = /^[A-Za-z0-9+/=_:-]{1,200}$/;

function repoOf(repo: string): string {
  if (!REPO_RE.test(repo)) throw new Error(`not a repo: ${repo}`);
  return repo;
}
function numberOf(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`not a PR number: ${n}`);
  return n;
}
function pageOf(page: number): number {
  if (!Number.isSafeInteger(page) || page < 1 || page > 20) throw new Error(`not a page: ${page}`);
  return page;
}

/** Every gh call the queue makes. All are reads but `trigger`, the one write. */
export const queueArgs = {
  user: (): string[] => ["api", "--method", "GET", "user"],
  pull: (repo: string, n: number): string[] => ["api", "--method", "GET", `repos/${repoOf(repo)}/pulls/${numberOf(n)}`],
  reviews: (repo: string, n: number, page: number): string[] => ["api", "--method", "GET", `repos/${repoOf(repo)}/pulls/${numberOf(n)}/reviews?per_page=100&page=${pageOf(page)}`],
  comments: (repo: string, n: number, page: number): string[] => ["api", "--method", "GET", `repos/${repoOf(repo)}/issues/${numberOf(n)}/comments?per_page=100&page=${pageOf(page)}`],
  checks: (repo: string, n: number): string[] => ["pr", "checks", String(numberOf(n)), "--repo", repoOf(repo), "--required", "--json", "bucket"],
  threads: (repo: string, n: number, after: string | null): string[] => {
    const [owner, name] = repoOf(repo).split("/");
    if (after !== null && !CURSOR_RE.test(after)) throw new Error("not a cursor");
    return ["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${numberOf(n)}`, ...(after ? ["-f", `after=${after}`] : [])];
  },
  discover: (login: string): string[] => {
    if (!LOGIN_RE.test(login)) throw new Error(`not a GitHub login: ${login}`);
    return ["search", "prs", "--author", login, "--state", "open", "--archived=false", "--sort", "updated", "--order", "desc", "--limit", String(QUEUE_MAX), "--json", "url"];
  },
  /** THE WRITE: one "@coderabbitai review" comment. Called only from review-queue/host.ts's post, after its dry-run return. */
  trigger: (repo: string, n: number): string[] => ["api", "--method", "POST", `repos/${repoOf(repo)}/issues/${numberOf(n)}/comments`, "-f", `body=${TRIGGER}`],
};
