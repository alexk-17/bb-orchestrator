import { useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { openPrsContract } from "../open-prs/contract.ts";
import { changesSinceCopy, snapshotRow, type CopyChange } from "../core/pr-copy-history.ts";
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
export async function copyReviewQueue(prs: ReviewRow[], section?: ReviewBucket, changes?: CopyChange[]): Promise<void> {
  const { html, text } = formatReviewQueue(prs, section, changes);
  await navigator.clipboard.write([new ClipboardItem({
    "text/html": new Blob([html], { type: "text/html" }),
    "text/plain": new Blob([text], { type: "text/plain" }),
  })]);
}

export function PrReviewQueueView() {
  const q = useOpenPrs();
  const rpc = useRpc<typeof openPrsContract>();
  const [includeChanges, setIncludeChanges] = useState(true);
  const [saving, setSaving] = useState(false);
  const copying = useRef(false);
  const [said, setSaid] = useState("");
  const d = q.data;
  if (!d) return <ReadState q={q} what="pull requests" />;
  const history = d.copyHistory ?? {};
  const changes = d.state === "ok" ? changesSinceCopy(history, d.prs, d.departed ?? {}) : [];
  const timestamps = Object.values(history).map((b) => b.at);
  const lastCopy = timestamps.length ? Math.max(...timestamps) : null;
  const copy = async (section?: ReviewBucket) => {
    if (copying.current) return;
    copying.current = true;
    setSaving(true);
    setSaid("");
    const hasBaseline = section ? !!history[section] : !!lastCopy;
    try {
      await copyReviewQueue(d.prs, section, includeChanges && hasBaseline ? changes : undefined);
    } catch {
      setSaid("Could not copy both formats. Allow clipboard access and try again.");
      copying.current = false;
      setSaving(false);
      return;
    }
    try {
      // Persist exactly the rows copied, even if a GitHub refresh lands while the clipboard is writing.
      await rpc.call("rememberPrCopy", { login: d.login, section: section ?? null, prs: d.prs.map(snapshotRow) });
      setSaid("Copied and saved the baseline. Paste into Slack; @names may need a tap to become mentions.");
      void q.refetch().catch(() => {});
    } catch {
      setSaid("Copied, but could not confirm the baseline was saved. Refresh before copying again.");
    } finally {
      copying.current = false;
      setSaving(false);
    }
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
        <Btn disabled={saving || d.state !== "ok" || (!queued.length && !lastCopy)} onClick={() => copy()} data-copy-all="">Copy all</Btn>
      </div>
      {d.state === "loading" ? <p>Reading GitHub…</p> : null}
      {d.error ? <p role="alert">{d.fetchedAt ? "Showing the last successful read. " : ""}{d.error}</p> : null}
      {d.notes.map((n) => <p className="orch-review-queue__note" key={n}>{n}</p>)}
      {d.more ? <p className="orch-review-queue__note">Showing the first 250 open PRs. There are more on GitHub.</p> : null}
      {d.fetchedAt ? <p className="orch-review-queue__note">Checked {when(new Date(d.fetchedAt).toISOString())}. Checks at most every {d.pollMinutes} minutes while open.</p> : null}
      <label className="orch-review-queue__note"><input type="checkbox" checked={includeChanges} onChange={(e) => setIncludeChanges(e.target.checked)} data-include-changes="" /> Include changes since last copy in copied text</label>
      <section data-copy-changes="" aria-label="Changes since last copy">
        <h3>{lastCopy ? `Since your last copy (${when(new Date(lastCopy).toISOString())})` : "Since your last copy"}</h3>
        {lastCopy ? <>
          <p className="orch-review-queue__note">{REVIEW_SECTIONS.map((s) => `${s.title}: ${history[s.id] ? when(new Date(history[s.id]!.at).toISOString()) : "not copied yet"}`).join(" · ")}</p>
          {d.state !== "ok" ? <p className="orch-review-queue__note">Waiting for GitHub before comparing with your saved copies.</p> : changes.length ? <ul>{changes.map((c) => <li key={c.url}><ProofLink open={{ url: c.url }}>{prRef(c)} — {reviewTitle(c.title)}</ProofLink><p className="orch-review-queue__note">{c.reasons.join(" · ")}</p></li>)}</ul> : <p className="orch-review-queue__note">No changes since the saved section copies.</p>}
        </> : <p className="orch-review-queue__note">Your first successful copy will save a baseline for that section.</p>}
      </section>
      {REVIEW_SECTIONS.map((s) => {
        const rows = queued.filter((p) => p.bucket === s.id);
        return (
          <section key={s.id} data-review-section={s.id} aria-label={s.title}>
            <div className="orch-review-queue__bar">
              <h3>{s.title} <span className="orch-review-queue__note">{rows.length}</span></h3>
              <Btn disabled={saving || d.state !== "ok" || (!rows.length && !history[s.id])} onClick={() => copy(s.id)} aria-label={`Copy ${s.title.toLowerCase()}`}>Copy section</Btn>
            </div>
            {rows.length ? <ul>{rows.map((p) => (
              <li key={p.url} data-review-pr={p.url}>
                <ProofLink open={{ url: p.url }}>{reviewTitle(p.title)}</ProofLink>
                <p data-pr-summary="" className="orch-review-queue__note">{p.copySummary}</p>
                {changes.some((c) => c.url === p.url) ? <p data-pr-changed="" className="orch-review-queue__note">Changed: {changes.find((c) => c.url === p.url)!.reasons.join(" · ")}</p> : null}
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
