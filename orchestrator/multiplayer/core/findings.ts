import { z } from "zod";
import { REVIEW_URL_RE } from "./records.ts";

export const findingSchema = z.object({ path: z.string(), line: z.number().nullable(), first: z.string(), url: z.string() });
export const reviewReadSchema = z.object({
  title: z.string(),
  state: z.string(),
  submittedAt: z.number().nullable(),
  commit: z.string(),
  author: z.string(),
  findings: z.array(findingSchema),
});
export type ReviewRead = z.infer<typeof reviewReadSchema>;
export type Finding = z.infer<typeof findingSchema>;

export const VERDICT: Record<string, string> = { APPROVED: "Approved", CHANGES_REQUESTED: "Changes requested", COMMENTED: "Commented", DISMISSED: "Dismissed", PENDING: "Pending" };

export function reviewParts(url: string): { host: string; owner: string; repo: string; pr: number; id: string } {
  if (!REVIEW_URL_RE.test(url)) throw new Error("not a GitHub review URL");
  const u = new URL(url);
  const [owner, repo, , pr] = u.pathname.split("/").filter(Boolean);
  return { host: u.hostname, owner: owner!, repo: repo!, pr: Number(pr), id: u.hash.replace("#pullrequestreview-", "") };
}

/** The fixed, read-only gh argument lists of one review read. */
export function reviewArgs(url: string): { pull: string[]; review: string[]; comments: string[] } {
  const p = reviewParts(url);
  const host = p.host === "github.com" ? [] : ["--hostname", p.host];
  const base = `repos/${p.owner}/${p.repo}/pulls/${p.pr}`;
  return {
    pull: ["api", ...host, base],
    review: ["api", ...host, `${base}/reviews/${p.id}`],
    // the review's own comments endpoint has no line numbers; the PR's carries them and each comment's review id
    comments: ["api", ...host, "--paginate", "--slurp", `${base}/comments?per_page=100`],
  };
}

/** A comment's first sentence: code and quotes left out, at most 200 characters. */
export function firstSentence(body: string): string {
  const prose = (part: string) =>
    part
      .split("\n")
      .map((l) => l.trim().replace(/^#+\s+/, "").replace(/^[-•*]\s+/, ""))
      .filter((l) => l && !l.startsWith(">") && !l.startsWith("<!--"))
      .join(" ")
      .replace(/[*`]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  // a sentence never runs across a code block: "like:" before one is where it ends
  const text = body.split(/```[\s\S]*?(?:```|$)/).map(prose).find(Boolean) ?? "";
  if (!text) return /```suggestion\b/.test(body) ? "Suggested change" : "";
  const m = /^(.+?[.!?])(\s|$)/.exec(text);
  const first = (m ? m[1]! : text).trim();
  return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}

const pull = z.object({ title: z.string() });
const review = z.object({ id: z.number(), state: z.string(), submitted_at: z.string().nullable().optional(), commit_id: z.string().nullable().optional(), user: z.object({ login: z.string() }).nullable().optional() });
const comment = z.object({ pull_request_review_id: z.number().nullable().optional(), path: z.string(), line: z.number().nullable().optional(), original_line: z.number().nullable().optional(), body: z.string(), html_url: z.string() });

/** gh's three answers as one review read: the PR's comments (paged, or not) cut to the review's, each to its first sentence. */
export function parseReview(rawPull: unknown, rawReview: unknown, rawComments: unknown): ReviewRead {
  const p = pull.parse(rawPull);
  const r = review.parse(rawReview);
  const pages = Array.isArray(rawComments) && rawComments.every(Array.isArray) ? rawComments.flat() : rawComments;
  const cs = z.array(comment).parse(pages).filter((c) => c.pull_request_review_id === r.id);
  return {
    title: p.title,
    state: r.state,
    submittedAt: r.submitted_at ? Date.parse(r.submitted_at) || null : null,
    commit: r.commit_id ?? "",
    author: r.user?.login ?? "",
    findings: cs.map((c) => ({ path: c.path, line: c.line ?? c.original_line ?? null, first: firstSentence(c.body), url: c.html_url })),
  };
}
