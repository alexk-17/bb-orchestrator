import { useState } from "react";
import { useOpenPrs } from "./open-prs.tsx";
import { REVIEW_SECTIONS, formatReviewQueue, reviewTitle, type ReviewBucket, type ReviewRow } from "../core/pr-review-queue.ts";
import { prRef } from "../core/open-prs.ts";
import { ProofLink } from "./proof-link.tsx";
import { Btn, ReadState, when } from "./ui.tsx";
import { styleHref } from "./style-href.ts";

const CSS = `
[data-orch] .orch-review-queue { display: grid; gap: 24px; padding: 16px; }
[data-orch] .orch-review-queue h3 { margin: 0; font-size: 16px; font-weight: 600; }
[data-orch] .orch-review-queue p { margin: 0; }
[data-orch] .orch-review-queue__bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
[data-orch] .orch-review-queue__note { color: var(--orch-muted); font-size: 12px; line-height: 18px; }
[data-orch] .orch-review-queue section { display: grid; gap: 12px; }
[data-orch] .orch-review-queue ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
[data-orch] .orch-review-queue li { display: grid; gap: 4px; border-bottom: 1px solid var(--orch-line); padding-bottom: 12px; overflow-wrap: anywhere; }
[data-orch] .orch-review-queue a { color: var(--orch-ink); font-size: 14px; line-height: 20px; font-weight: 600; }
[data-orch] .orch-review-queue a:hover { text-decoration: underline; }
[data-orch] .orch-review-queue__meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--orch-muted); }
`;

/** Both MIME types in one clipboard item. Failure is visible; never claim a plain-only copy was rich paste. */
export async function copyReviewQueue(prs: ReviewRow[], section?: ReviewBucket): Promise<void> {
  const { html, text } = formatReviewQueue(prs, section);
  await navigator.clipboard.write([new ClipboardItem({
    "text/html": new Blob([html], { type: "text/html" }),
    "text/plain": new Blob([text], { type: "text/plain" }),
  })]);
}

export function PrReviewQueueView() {
  const q = useOpenPrs();
  const [said, setSaid] = useState("");
  const d = q.data;
  if (!d) return <ReadState q={q} what="pull requests" />;
  const copy = (section?: ReviewBucket) => {
    setSaid("");
    void copyReviewQueue(d.prs, section).then(
      () => setSaid("Copied. Paste into Slack; @names may need a tap to become mentions."),
      () => setSaid("Could not copy both formats. Allow clipboard access and try again."),
    );
  };
  const queued = d.prs.filter((p) => p.bucket);
  return (
    <div className="orch-review-queue" data-pr-review-queue="">
      <style href={styleHref("orch-review-queue", CSS)} precedence="default">{CSS}</style>
      <div className="orch-review-queue__bar">
        <div>
          <h3>PRs</h3>
          <p className="orch-review-queue__note">{d.login ? `Open PRs authored by ${d.login}. Human reviews against the current head.` : "Set githubLogin in the Orchestrator settings to load your PRs."}</p>
        </div>
        <Btn disabled={!queued.length} onClick={() => copy()} data-copy-all="">Copy all</Btn>
      </div>
      {d.state === "loading" ? <p>Reading GitHub…</p> : null}
      {d.error ? <p role="alert">{d.fetchedAt ? "Showing the last successful read. " : ""}{d.error}</p> : null}
      {d.notes.map((n) => <p className="orch-review-queue__note" key={n}>{n}</p>)}
      {d.more ? <p className="orch-review-queue__note">Showing the first 250 open PRs. There are more on GitHub.</p> : null}
      {d.fetchedAt ? <p className="orch-review-queue__note">Checked {when(new Date(d.fetchedAt).toISOString())}. Checks at most every {d.pollMinutes} minutes while open.</p> : null}
      {REVIEW_SECTIONS.map((s) => {
        const rows = queued.filter((p) => p.bucket === s.id);
        return (
          <section key={s.id} data-review-section={s.id} aria-label={s.title}>
            <div className="orch-review-queue__bar">
              <h3>{s.title} <span className="orch-review-queue__note">{rows.length}</span></h3>
              <Btn disabled={!rows.length} onClick={() => copy(s.id)} aria-label={`Copy ${s.title.toLowerCase()}`}>Copy section</Btn>
            </div>
            {rows.length ? <ul>{rows.map((p) => (
              <li key={p.url} data-review-pr={p.url}>
                <ProofLink open={{ url: p.url }}>{reviewTitle(p.title)}</ProofLink>
                <div className="orch-review-queue__meta">
                  <span>{prRef(p)}</span><span>by {p.author}</span><span>Updated {when(p.updatedAt)}</span>
                  <span>{p.ci === "fail" ? "CI failing" : p.ci === "pending" ? "CI running" : p.ci === "pass" ? "CI passing" : "No CI checks"}</span>
                </div>
                {p.reviewers.length ? <p className="orch-review-queue__note">{s.id === "approved" ? "Approved by" : "Reviewers"}: {p.reviewers.join(", ")}{p.mentions.length ? ` · ${p.mentions.join(" ")}` : ""}</p> : null}
              </li>
            ))}</ul> : <p className="orch-review-queue__note">{d.state === "ok" ? "None." : "No PRs loaded yet."}</p>}
          </section>
        );
      })}
      {d.state === "ok" && d.prs.length > queued.length ? <p className="orch-review-queue__note">{d.prs.length - queued.length} other PR(s): drafts, incomplete history, or reviewed on this head without an approval. See Open PRs for the full list.</p> : null}
      <p className="orch-review-queue__note">A human approval is not merge readiness; branch rules, other reviews and CI still apply.</p>
      <p role="status" aria-live="polite">{said}</p>
    </div>
  );
}
