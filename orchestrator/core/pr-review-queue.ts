// Human review state is independent of branch protection, CI, and bot approvals.
import type { CopyChange } from "./pr-copy-history.ts";
import { LOGIN_RE, extractSummary, prRef } from "./open-prs.ts";

export interface HumanReview { login: string; state: string; sha: string }
export interface ReviewData { author: string; reviews: HumanReview[]; requested: string[]; complete: boolean }
export type ReviewBucket = "needs-review" | "needs-rereview" | "approved";
export const REVIEW_SECTIONS: { id: ReviewBucket; title: string }[] = [
  { id: "needs-review", title: "Needs a review" },
  { id: "needs-rereview", title: "Needs a re-review" },
  { id: "approved", title: "Has a human approval" },
];

export function humanLogin(login: string): boolean {
  return LOGIN_RE.test(login) && !["coderabbitai", "copilot", "dependabot", "renovate", "github-actions"].includes(login.toLowerCase());
}
const unique = (logins: string[]) => [...new Map(logins.map((login) => [login.toLowerCase(), login])).values()];

/** Latest submitted review per non-author human; a comment doesn't revoke their opinionated approval. */
export function reviewQueue(pr: { draft: boolean; sha: string; reviewData?: ReviewData }, suggested: string[] = []): { bucket: ReviewBucket | null; reviewers: string[] } {
  const d = pr.reviewData;
  const none = { bucket: null, reviewers: [] };
  if (pr.draft || !pr.sha || !d?.complete || !d.author) return none;
  const eligible = (login: string) => humanLogin(login) && login.toLowerCase() !== d.author.toLowerCase();
  const reviews = d.reviews.filter((r) => eligible(r.login) && ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"].includes(r.state));
  const latest = new Map<string, HumanReview>();
  const opinions = new Map<string, HumanReview>();
  for (const r of reviews) {
    latest.set(r.login.toLowerCase(), r);
    if (r.state !== "COMMENTED") opinions.set(r.login.toLowerCase(), r);
  }
  const approved = [...opinions.values()].filter((r) => r.state === "APPROVED" && r.sha === pr.sha);
  if (approved.length) return { bucket: "approved", reviewers: approved.map((r) => r.login) };
  if (!reviews.length) {
    const requested = d.requested.filter(eligible);
    return { bucket: "needs-review", reviewers: unique(requested.length ? requested : suggested.filter(eligible).slice(0, 3)) };
  }
  const stale = [...latest.values()].filter((r) => r.sha && r.sha !== pr.sha);
  return stale.length ? { bucket: "needs-rereview", reviewers: stale.map((r) => r.login) } : none;
}

/** Unmapped logins stay unmentioned, including names that also exist on Object.prototype. */
export function mentionsFor(logins: string[], directory: Record<string, string>): string[] {
  return [...new Set(logins.flatMap((login) => {
    const key = login.toLowerCase();
    return Object.hasOwn(directory, key) ? [directory[key]!] : [];
  }))];
}

export interface ReviewRow {
  url: string; repo: string; number: number; title: string; author: string;
  copySummary?: string;
  bucket: ReviewBucket | null; reviewers: string[]; mentions: string[];
}
export const reviewTitle = (title: string) => extractSummary("", title);
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Structured HTML for rich paste; plain text has bare URLs. Neither flavor uses Slack mrkdwn. */
export function formatReviewQueue(prs: ReviewRow[], section?: ReviewBucket, changes?: CopyChange[]): { html: string; text: string } {
  const sections = REVIEW_SECTIONS.filter((s) => !section || s.id === section);
  const blocks = sections.map((s) => {
    const rows = prs.filter((p) => p.bucket === s.id);
    const lines = rows.map((p) => {
      const context = `${reviewTitle(p.title)} — ${prRef(p)} — by ${p.author}`;
      const mentions = p.mentions.length ? ` — ${p.mentions.join(" ")}` : "";
      // Only https PR-shaped URLs become links (including GitHub Enterprise); unexpected URLs stay inert.
      const safeUrl = /^https:\/\/[^\s<>"|]+\/[^\s<>"|]+\/[^\s<>"|]+\/pull\/\d+$/.test(p.url);
      const link = safeUrl ? `<a href="${escape(p.url)}">${escape(prRef(p))}</a>` : escape(p.url);
      const summary = p.copySummary ? `\n  ${p.copySummary}` : "";
      return { text: `${context}${mentions}${summary}\n${p.url}`, html: `<li>${escape(reviewTitle(p.title))} — ${link} — by ${escape(p.author)}${escape(mentions)}${p.copySummary ? `<br>${escape(p.copySummary)}` : ""}</li>` };
    });
    return {
      text: `${s.title}\n${lines.length ? lines.map((l) => `• ${l.text}`).join("\n") : "None."}`,
      html: `<p><strong>${escape(s.title)}</strong></p>${lines.length ? `<ul>${lines.map((l) => l.html).join("")}</ul>` : "<p>None.</p>"}`,
    };
  });
  if (changes) {
    const selected = changes.filter((c) => !section || c.sections.includes(section));
    const lines = selected.slice(0, 6).map((c) => `${prRef(c)}: ${c.reasons.join("; ")}`);
    if (selected.length > 6) lines.push(`${selected.length - 6} more changed PRs — see the PRs tab.`);
    blocks.unshift({
      text: `Changes since last copy\n${lines.length ? lines.map((l) => `• ${l}`).join("\n") : "No changes."}`,
      html: `<p><strong>Changes since last copy</strong></p>${lines.length ? `<ul>${lines.map((l) => `<li>${escape(l)}</li>`).join("")}</ul>` : "<p>No changes.</p>"}`,
    });
  }
  return { text: blocks.map((b) => b.text).join("\n\n"), html: blocks.map((b) => b.html).join("") };
}
