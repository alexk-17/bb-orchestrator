// Pure queue policy. A model may rank eligible facts, never relax these checks or construct a GitHub write.
import { z } from "zod";
export const MIN_GAP = 60 * 60_000;
export const HOLD = 3 * MIN_GAP;
export const TRIGGER = "@coderabbitai review";
export const factsSchema = z.object({
  url: z.string(),
  title: z.string(),
  head: z.string().min(1),
  author: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  conflict: z.boolean(),
  ci: z.enum(["pass", "pending", "fail", "unknown"]),
  approvals: z.number().int().nonnegative(),
  threads: z.number().int().nonnegative(),
  reviewedHead: z.boolean(),
  lastReview: z
    .object({ head: z.string(), at: z.number(), state: z.string() })
    .nullable(),
  inProgressAt: z.number().nullable(),
  recentRequestAt: z.number().nullable(),
});
export type Facts = z.infer<typeof factsSchema>;
export const entrySchema = z.object({
  url: z.string(),
  auto: z.boolean(),
  pinned: z.boolean(),
  addedAt: z.number(),
  facts: factsSchema.nullable(),
  error: z.string().nullable(),
  fetchedAt: z.number().nullable(),
});
export type Entry = z.infer<typeof entrySchema>;
export const outcomeSchema = z.enum([
  "posting",
  "posted",
  "accepted",
  "not_completed",
  "no_reply",
  "unknown",
  "post_failed",
  "rate_limited",
  "dry_run",
]);
export const attemptSchema = z.object({
  url: z.string(),
  head: z.string(),
  at: z.number(),
  outcome: outcomeSchema,
  attempts: z.number().int().nonnegative(),
  commentUrl: z.string().nullable(),
});
export type Attempt = z.infer<typeof attemptSchema>;
export const configSchema = z
  .object({
    enabled: z.boolean(),
    auto: z.boolean(),
    intervalMinutes: z.number().int().min(60).max(10080),
    hostId: z.string().max(200),
    provider: z.string().max(200),
    model: z.string().max(200),
    projectId: z.string().max(200),
    environmentId: z.string().max(200),
  })
  .strict();
export const stateSchema = z.object({
  config: configSchema,
  entries: z.array(entrySchema).max(50),
  history: z.record(z.string(), attemptSchema),
  nextAt: z.number().nullable(),
  cooldownUntil: z.number().nullable(),
  lastAt: z.number().nullable(),
  lastMessage: z.string(),
  lastPicker: z.string(),
  login: z.string(),
  error: z.string().nullable(),
  fetchedAt: z.number().nullable(),
});
export type QueueState = z.infer<typeof stateSchema>;
export const initialState = (): QueueState => ({
  config: {
    enabled: false,
    auto: false,
    intervalMinutes: 65,
    hostId: "",
    provider: "",
    model: "",
    projectId: "",
    environmentId: "",
  },
  entries: [],
  history: {},
  nextAt: null,
  cooldownUntil: null,
  lastAt: null,
  lastMessage: "No runs yet",
  lastPicker: "Deterministic",
  login: "",
  error: null,
  fetchedAt: null,
});
export function parsePrUrl(value: string) {
  const match =
    /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?(?:[?#].*)?$/.exec(
      value.trim(),
    );
  if (!match || !Number.isSafeInteger(Number(match[3])))
    throw new Error(
      "Enter a GitHub pull request URL (https://github.com/owner/repo/pull/123).",
    );
  const repo = `${match[1]}/${match[2]}`;
  const number = Number(match[3]);
  return { repo, number, url: `https://github.com/${repo}/pull/${number}` };
}
export function assess(
  entry: Entry,
  attempt: Attempt | null,
  login: string,
  now: number,
): { eligible: boolean; reason: string; tier: number } {
  const no = (reason: string) => ({ eligible: false, reason, tier: 9 });
  const f = entry.facts;
  if (entry.error || !f) return no(entry.error || "Not checked yet");
  if (f.state !== "open") return no(f.state === "merged" ? "Merged" : "Closed");
  if (f.reviewedHead) return no("CodeRabbit already reviewed this head");
  if (f.draft) return no("Draft");
  if (entry.auto && (!login || f.author.toLowerCase() !== login.toLowerCase()))
    return no("Not authored by the signed-in user");
  if (entry.auto && f.conflict) return no("Merge conflict");
  if (entry.auto && f.ci !== "pass")
    return no("Auto waits for passing required checks");
  if (
    f.inProgressAt !== null &&
    (f.inProgressAt === 0 || now - f.inProgressAt < 2 * MIN_GAP)
  )
    return no("CodeRabbit review in progress");
  if (f.recentRequestAt !== null && now - f.recentRequestAt < HOLD)
    return no("Review requested in the last 3 hours");
  if (
    attempt &&
    attempt.outcome !== "post_failed" &&
    attempt.outcome !== "dry_run"
  ) {
    if (
      now - attempt.at < HOLD &&
      (entry.auto || attempt.outcome !== "rate_limited")
    )
      return no("Waiting up to 3 hours for the previous request");
    if (attempt.head === f.head && attempt.attempts >= 3)
      return no("3 attempts on this head; waiting for new commits");
  }
  const tier = entry.pinned
    ? 0
    : f.approvals === 1
      ? 1
      : f.approvals === 0 && !f.conflict && f.ci === "pass"
        ? 2
        : 3;
  return {
    eligible: true,
    tier,
    reason: entry.pinned
      ? "Pinned next"
      : tier === 1
        ? "1 human approval on head"
        : tier === 2
          ? "Ready for human review"
          : "Manual queue candidate",
  };
}
export function pick(
  entries: Entry[],
  history: Record<string, Attempt>,
  login: string,
  now: number,
): Entry | null {
  return (
    entries
      .map((e, i) => ({
        e,
        i,
        a: assess(e, history[e.url] ?? null, login, now),
      }))
      .filter((x) => x.a.eligible)
      .sort((a, b) => a.a.tier - b.a.tier || a.i - b.i)[0]?.e ?? null
  );
}
export type Comment = {
  author: string;
  body: string;
  at: number;
  updatedAt?: number;
  url?: string;
};
export function replyOutcome(
  comments: Comment[],
  since: number,
): Attempt["outcome"] | null {
  const c = comments
    .filter(
      (c) =>
        c.author === "coderabbitai[bot]" &&
        c.at >= since &&
        /auto-generated reply by CodeRabbit/i.test(c.body),
    )
    .sort((a, b) => b.at - a.at)[0];
  if (!c) return null;
  return /rate limit/i.test(c.body)
    ? "rate_limited"
    : /Action not completed/i.test(c.body)
      ? "not_completed"
      : /Action performed/i.test(c.body)
        ? "accepted"
        : null;
}
export function cooldownUntil(body: string, updatedAt: number, now: number) {
  const text =
    /Next included review available in ([^.\n*]+)/i.exec(body)?.[1] ?? "";
  let ms = 0;
  for (const m of text.matchAll(/(\d{1,6})\s*(hour|minute|second)/gi))
    ms +=
      Number(m[1]) *
      ({ hour: 3600_000, minute: 60_000, second: 1000 }[m[2]!.toLowerCase()] ??
        0);
  const until = updatedAt + Math.min(ms, 6 * MIN_GAP);
  return ms > 0 && until > now
    ? Math.min(until, now + 6 * MIN_GAP)
    : now + MIN_GAP;
}
export function spacingUntil(state: QueueState): number {
  return Math.max(
    state.cooldownUntil ?? 0,
    ...Object.values(state.history)
      .filter((a) => a.outcome !== "post_failed" && a.outcome !== "dry_run")
      .map((a) => a.at + MIN_GAP),
  );
}
