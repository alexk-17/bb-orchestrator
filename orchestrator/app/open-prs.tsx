// The Open PRs tab (2026-11-16): every open PR the owner authored, with its project and lead, state and a plain summary;
// a Needs review filter; the running review ask (one block of text, one click copies it); and Post, which shows the
// exact text with a tick per PR, then copies it and opens the code-review channel. It never sends anything itself.
// The text in all three places is core/open-prs.ts buildPrompt's, so what you see is what is copied.
// Rev 2 (2026-11-16): a repo#n link on every row, coloured state chips (prChips, PR_CHIP_TONES), the summary as a
// bullet, and the review ask drawn as the Slack message it becomes: SlackMessage takes only the copied string and
// draws it through core's slackLines, the same tokens the clipboard's HTML flavour is written from.
//
// Readability (PLAN.md "Readability changes"): sizes 16/14/12, weights 400/600, colour only for meaning (CI failing
// red, approved green), no boxes or uppercase labels, one column on a phone.
import { styleHref } from "./style-href.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { experimental_useRpcQuery, useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import { CHANGED_CHANNEL } from "../contract.ts";
import { OPEN_PRS_CHANNEL, openPrsContract, type OpenPr, type OpenPrsView } from "../open-prs/contract.ts";
import { buildPrompt, initialTicks, prChips, prRef, slackHtml, slackLines, sortPrs, type PrSort } from "../core/open-prs.ts";
import { PR_CHIP_TONES, SLACK_TONES, TINT } from "./palette.ts";
import { EmptyState } from "./affect/empty-state-clean.tsx";
import { openInBb } from "./open-proof.ts";
import { useIdentity } from "./identity.ts";
import { ProofLink } from "./proof-link.tsx";
import { Btn, Muted, ReadState, when } from "./ui.tsx";
import { useElementWidth } from "./panes.tsx";
import { isWide } from "./source.ts";
import { age } from "./lanes.ts";

type Filter = "needs" | "all";

const CSS = `
[data-orch] .orch-prs { display: grid; gap: 24px; }
[data-orch] .orch-prs h3 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
[data-orch] .orch-prs__bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
[data-orch] .orch-prs__filters { display: flex; flex-wrap: wrap; gap: 4px; }
[data-orch] .orch-prs__filters button { border: 0; border-radius: 6px; padding: 6px 10px; min-height: 32px; background: none; font: inherit; font-size: 14px; color: var(--orch-muted); cursor: pointer; }
[data-orch] .orch-prs__filters button:hover { color: var(--orch-ink); }
[data-orch] .orch-prs__filters button[aria-pressed="true"] { background: light-dark(rgba(0, 0, 0, 0.07), rgba(255, 255, 255, 0.1)); color: var(--orch-ink); font-weight: 600; }
[data-orch] .orch-prs__note { margin: 0; font-size: 12px; line-height: 16px; color: var(--orch-muted); }
[data-orch] .orch-prs__list { display: grid; gap: 16px; margin: 0; padding: 0; list-style: none; min-width: 0; }
[data-orch] .orch-prs__row { display: grid; gap: 4px; min-width: 0; }
[data-orch] .orch-prs__title { font-size: 14px; line-height: 20px; font-weight: 600; color: var(--orch-ink); text-decoration: none; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
[data-orch] .orch-prs__title:hover { text-decoration: underline; text-underline-offset: 2px; }
[data-orch] .orch-prs__meta { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 12px; line-height: 16px; color: var(--orch-muted); min-width: 0; }
[data-orch] .orch-prs__meta > span { overflow-wrap: anywhere; }
[data-orch] .orch-prs__state { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 12px; line-height: 16px; color: var(--orch-ink); }
[data-orch] .orch-prs__state { gap: 4px 6px; }
[data-orch] .orch-prs__chip { --c: currentColor; display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; align-items: center; border-radius: 999px; padding: 2px 8px; font-size: 12px; line-height: 16px; color: var(--c); background: color-mix(in srgb, var(--c) ${TINT * 100}%, transparent); }
${Object.entries(PR_CHIP_TONES)
  .map(([k, t]) => `[data-orch] .orch-prs__chip[data-tone="${k}"] { --c: light-dark(${t.light}, ${t.dark}); }`)
  .join("\n")}
[data-orch] .orch-prs__chip[data-tone="ok"], [data-orch] .orch-prs__chip[data-tone="warn"], [data-orch] .orch-prs__chip[data-tone="fail"] { font-weight: 600; }
[data-orch] .orch-prs__link { font-size: 12px; line-height: 16px; font-weight: 600; color: light-dark(${SLACK_TONES.link.light}, ${SLACK_TONES.link.dark}); text-decoration: underline; text-underline-offset: 2px; }
[data-orch] .orch-prs__bullets { margin: 0; padding-left: 20px; list-style: disc; font-size: 14px; line-height: 20px; color: var(--orch-ink); overflow-wrap: anywhere; }
[data-orch] .orch-prs__bullets li::marker { color: var(--orch-muted); }
/* the ask and the Post preview keep a reading width beside the wide table */
[data-orch] [data-layout="table"] [data-ask], [data-orch] [data-layout="table"] [data-post] { max-width: 768px; }
/* wide: one table, a row per PR (the payload is flat per PR, so there is no more to show in a detail beside it) */
[data-orch] .orch-prs__table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 14px; line-height: 20px; }
[data-orch] .orch-prs__table th { padding: 8px; text-align: start; font-size: 12px; line-height: 16px; font-weight: 600; color: var(--orch-muted); border-bottom: 1px solid var(--orch-line); }
[data-orch] .orch-prs__table th button { border: 0; padding: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
[data-orch] .orch-prs__table th button:hover, [data-orch] .orch-prs__table th[aria-sort] button { color: var(--orch-ink); }
[data-orch] .orch-prs__table td { padding: 10px 8px; vertical-align: top; border-bottom: 1px solid var(--orch-line); min-width: 0; overflow-wrap: anywhere; }
[data-orch] .orch-prs__table tr:hover td { background: var(--orch-wash); }
[data-orch] .orch-prs__table .orch-prs__sum { margin-top: 2px; font-size: 12px; line-height: 16px; color: var(--orch-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-orch] .orch-prs__table .orch-prs__cell { display: flex; flex-wrap: wrap; gap: 4px; }
[data-orch] .orch-prs__table .orch-prs__sub { font-size: 12px; line-height: 16px; color: var(--orch-muted); }
/* the Slack message card: avatar, name, then the text as Slack draws it */
[data-orch] .orch-slack { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 0 8px; padding: 12px; border: 1px solid var(--orch-line); border-radius: 8px; background: light-dark(#ffffff, #1a1d21); }
[data-orch] .orch-slack__avatar { width: 36px; height: 36px; border-radius: 6px; display: grid; place-items: center; font-size: 16px; font-weight: 600; color: #ffffff; background: light-dark(#4a154b, #7c3a7e); }
[data-orch] .orch-slack__who { display: flex; gap: 8px; align-items: baseline; font-size: 14px; line-height: 20px; }
[data-orch] .orch-slack__who b { font-weight: 600; color: var(--orch-ink); }
[data-orch] .orch-slack__who span { font-size: 12px; color: var(--orch-muted); }
[data-orch] .orch-slack__body { min-width: 0; font-size: 14px; line-height: 22px; color: var(--orch-ink); overflow-wrap: anywhere; }
[data-orch] .orch-slack__line { margin: 0; min-height: 22px; }
[data-orch] .orch-slack__line[data-bullet] { padding-left: 12px; }
[data-orch] .orch-slack b { font-weight: 600; }
[data-orch] .orch-slack a { color: light-dark(${SLACK_TONES.link.light}, ${SLACK_TONES.link.dark}); text-decoration: none; }
[data-orch] .orch-slack a:hover { text-decoration: underline; }
[data-orch] .orch-slack__mention { border-radius: 3px; padding: 0 2px; color: light-dark(${SLACK_TONES.mention.light}, ${SLACK_TONES.mention.dark}); background: color-mix(in srgb, light-dark(${SLACK_TONES.mention.light}, ${SLACK_TONES.mention.dark}) ${TINT * 100}%, transparent); }
[data-orch] .orch-prs__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
[data-orch] .orch-prs__ticks { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
[data-orch] .orch-prs__ticks label { display: flex; gap: 8px; align-items: flex-start; font-size: 14px; line-height: 20px; cursor: pointer; min-height: 32px; }
[data-orch] .orch-prs__ticks input { margin-top: 3px; width: 16px; height: 16px; flex: none; }
[data-orch] .orch-prs__said { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; }
/* affectUI's button labels on the tab's scale too (14 px, 600) */
[data-orch] .orch-prs .ui-buttonc__label { font-size: 14px; font-weight: 600; }
`;

/** The read, refetched when a GitHub read lands, on any orchestrator change, and each minute while the tab is shown. */
export function useOpenPrs() {
  const q = experimental_useRpcQuery({ contract: openPrsContract, method: "openPrs", input: null });
  const refetch = useRef(q.refetch);
  refetch.current = q.refetch;
  const again = useCallback(() => void refetch.current(), []);
  useRealtime(OPEN_PRS_CHANNEL, again);
  useRealtime(CHANGED_CHANNEL, again);
  useEffect(() => {
    const t = setInterval(again, 60_000);
    return () => clearInterval(t);
  }, [again]);
  return q;
}

function Row({ pr }: { pr: OpenPr }) {
  return (
    <li className="orch-prs__row" data-pr={pr.url} data-needs={pr.needsReview ? "true" : "false"}>
      <ProofLink open={{ url: pr.url }} className="orch-prs__title" title={pr.title}>
        {pr.title}
      </ProofLink>
      <div className="orch-prs__meta">
        <ProofLink open={{ url: pr.url }} className="orch-prs__link" data-pr-link={pr.url} title={pr.url}>
          {prRef(pr)}
        </ProofLink>
        <span>{pr.project ? `${pr.project}${pr.lead ? `, ${pr.lead}` : ", no lead"}` : "No project"}</span>
        <span title={pr.updatedAt}>Updated {when(pr.updatedAt)}</span>
      </div>
      <div className="orch-prs__state">
        {prChips(pr).map((c) => (
          <span key={c.key} className="orch-prs__chip" data-chip={c.key} data-tone={c.tone}>
            {c.text}
          </span>
        ))}
      </div>
      <ul className="orch-prs__bullets">
        <li>{pr.summary}</li>
      </ul>
    </li>
  );
}

/**
 * Copy to the clipboard as text/plain (the string itself) and text/html (slackHtml of the same tokens), so a paste
 * into Slack keeps links and bold; plain text alone where the browser has no ClipboardItem. False when the browser
 * refuses (the message stays on screen to copy by hand).
 */
async function copy(text: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
      const html = slackHtml(slackLines(text));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]);
    } else await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}

/** The copied string drawn as Slack draws it in the channel. It takes only that string: nothing else can reach it. */
function SlackMessage({ text, name, ...p }: { text: string; name: string; [data: `data-${string}`]: string | undefined }) {
  return (
    <div className="orch-slack" data-copy-text={text} {...p}>
      <div className="orch-slack__avatar" aria-hidden="true">
        {(name.trim()[0] ?? "?").toUpperCase()}
      </div>
      <div className="orch-slack__body">
        <div className="orch-slack__who">
          <b>{name}</b>
          <span>now</span>
        </div>
        {slackLines(text).map((l, i) => (
          <p key={i} className="orch-slack__line" data-bullet={l.bullet ? "" : undefined}>
            {l.toks.map((t, j) =>
              t.kind === "link" ? (
                <ProofLink key={j} open={{ url: t.raw }}>
                  {t.show}
                </ProofLink>
              ) : t.kind === "bold" ? (
                <b key={j}>{t.show}</b>
              ) : t.kind === "mention" ? (
                <span key={j} className="orch-slack__mention" data-mention="">
                  {t.show}
                </span>
              ) : (
                <span key={j}>{t.show}</span>
              ),
            )}
          </p>
        ))}
      </div>
    </div>
  );
}

const MENTION_NOTE = "@names may need a tap to become mentions.";

/** The running review ask: every PR that needs review, kept current, one click copies it. */
function Ask({ prs, name }: { prs: OpenPr[]; name: string }) {
  const text = useMemo(() => buildPrompt(prs), [prs]);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => setSaid(null), [text]);
  return (
    <section className="grid gap-2" data-ask="">
      <h3>Review ask</h3>
      <p className="orch-prs__note">How it shows in Slack once pasted.</p>
      <SlackMessage text={text} name={name} data-ask-text="" />
      <div className="orch-prs__actions">
        <Btn data-copy-ask="" onClick={() => void copy(text).then((ok) => setSaid(ok ? "Copied." : "Couldn't copy: select the text and copy it."))}>
          Copy
        </Btn>
        {said ? <span className="orch-prs__note">{said}</span> : null}
      </div>
      <p className="orch-prs__note">{MENTION_NOTE}</p>
    </section>
  );
}

/** Post: the exact text with a tick per PR (excluded projects start unticked), then one Confirm that copies and opens. */
function Post({ prs, view, name, onClose }: { prs: OpenPr[]; view: OpenPrsView; name: string; onClose: () => void }) {
  const nav = useBbNavigate();
  const [ticks, setTicks] = useState<Record<string, boolean>>(() => initialTicks(prs, view.excluded));
  const [done, setDone] = useState<string | null>(null);
  // a PR that appears while the preview is open starts as its project says
  const ticked = (p: OpenPr) => ticks[p.url] ?? initialTicks([p], view.excluded)[p.url]!;
  const chosen = prs.filter(ticked);
  const text = buildPrompt(chosen);
  const confirm = async () => {
    const ok = await copy(text);
    if (!ok) return setDone("Couldn't copy: select the text above and copy it.");
    if (view.channel) {
      if (!openInBb(nav, { url: view.channel.url })) window.open(view.channel.url, "_blank", "noopener,noreferrer");
      setDone(`Copied. Paste it in ${view.channel.name}`);
    } else setDone("Copied. Set reviewChannel to open the channel too.");
  };
  return (
    <section className="grid gap-3" data-post="">
      <h3>Post to code reviews</h3>
      <p className="orch-prs__note">Untick a PR to leave it out. Confirm copies this text and opens {view.channel?.name ?? "nothing (no reviewChannel set)"}; it never posts by itself.</p>
      <ul className="orch-prs__ticks">
        {prs.map((p) => (
          <li key={p.url}>
            <label>
              <input type="checkbox" data-tick={p.url} checked={ticked(p)} onChange={(e) => setTicks((t) => ({ ...t, [p.url]: e.target.checked }))} />
              <span>
                {p.title}
                {p.excluded ? <span className="orch-prs__note"> (project {p.project} is left out by default)</span> : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {text ? <SlackMessage text={text} name={name} data-post-text="" /> : <p className="orch-prs__note">No PR ticked.</p>}
      <div className="orch-prs__actions">
        <Btn tone="primary" data-post-confirm="" disabled={!text} onClick={() => void confirm()}>
          {view.channel ? `Copy and open ${view.channel.name}` : "Copy"}
        </Btn>
        <Btn tone="ghost" onClick={onClose}>
          Cancel
        </Btn>
        {done ? (
          <p className="orch-prs__said" role="status">
            {done}
          </p>
        ) : null}
      </div>
      <p className="orch-prs__note">{MENTION_NOTE}</p>
    </section>
  );
}

const COLS: { key: PrSort | null; label: string; width: string }[] = [
  { key: null, label: "Pull request", width: "auto" },
  { key: "project", label: "Project", width: "13%" },
  { key: "review", label: "Review", width: "17%" },
  { key: "ci", label: "CI", width: "10%" },
  { key: null, label: "Merge", width: "12%" },
  { key: "updated", label: "Updated", width: "8%" },
];

/** The wide tab: one row per PR with its state, checks, review, age and project in columns; a header click sorts. */
function Table({ prs }: { prs: OpenPr[] }) {
  const [sort, setSort] = useState<{ key: PrSort; desc: boolean }>({ key: "updated", desc: true });
  const rows = useMemo(() => sortPrs(prs, sort.key, sort.desc), [prs, sort]);
  const chip = (pr: OpenPr, ...keys: string[]) =>
    prChips(pr)
      .filter((c) => keys.includes(c.key))
      .map((c) => (
        <span key={c.key} className="orch-prs__chip" data-chip={c.key} data-tone={c.tone} title={c.text}>
          {c.text}
        </span>
      ));
  return (
    <table className="orch-prs__table" data-prs-table="">
      <colgroup>
        {COLS.map((c) => (
          <col key={c.label} style={{ width: c.width }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {COLS.map((c) => (
            <th key={c.label} scope="col" aria-sort={c.key && sort.key === c.key ? (sort.desc ? "descending" : "ascending") : undefined}>
              {c.key ? (
                <button type="button" data-sort={c.key} onClick={() => setSort((s) => ({ key: c.key!, desc: s.key === c.key ? !s.desc : c.key === "updated" }))}>
                  {c.label}
                  {sort.key === c.key ? (sort.desc ? " ↓" : " ↑") : ""}
                </button>
              ) : (
                c.label
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((pr) => (
          <tr key={pr.url} data-pr={pr.url} data-needs={pr.needsReview ? "true" : "false"}>
            <td>
              <ProofLink open={{ url: pr.url }} className="orch-prs__title" title={pr.title}>
                {pr.title}
              </ProofLink>
              <div className="orch-prs__sum" title={pr.summary}>
                <ProofLink open={{ url: pr.url }} className="orch-prs__link" data-pr-link={pr.url} title={pr.url}>
                  {prRef(pr)}
                </ProofLink>{" "}
                {pr.summary}
              </div>
            </td>
            <td>
              <div>{pr.project ?? "No project"}</div>
              <div className="orch-prs__sub">{pr.project ? (pr.lead ?? "no lead") : ""}</div>
            </td>
            <td>
              <div className="orch-prs__cell">{chip(pr, "review")}</div>
            </td>
            <td>
              <div className="orch-prs__cell">{chip(pr, "ci")}</div>
            </td>
            <td>
              <div className="orch-prs__cell">{chip(pr, "draft", "merge")}</div>
            </td>
            <td className="orch-prs__sub" title={pr.updatedAt}>
              {age(Date.parse(pr.updatedAt), Date.now())} ago
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The tab, laid out on the pane's own width (a ResizeObserver, as Projects and Deliverables do, so it follows a split
 * pane live): a sortable table when wide, the compact column of rows when narrow.
 */
export function OpenPrsView() {
  const [width, measure] = useElementWidth();
  const wide = isWide(width);
  return (
    <div ref={measure} data-prs-width={width}>
      <div data-layout={wide ? "table" : "column"} style={wide ? undefined : { maxWidth: 768, marginInline: "auto" }}>
        <OpenPrsBody wide={wide} />
      </div>
    </div>
  );
}

function OpenPrsBody({ wide }: { wide: boolean }) {
  const q = useOpenPrs();
  // the Slack preview's sender: the ownerName setting, else a neutral "You"
  const name = useIdentity().ownerName.trim() || "You";
  const [filter, setFilter] = useState<Filter>("needs");
  const [posting, setPosting] = useState(false);
  const v = q.data;
  if (!v) return <ReadState q={q} what="your open PRs" />;
  if (v.state === "unset")
    return (
      <EmptyState
        title="Set your GitHub login"
        text="Open PRs lists the PRs you authored. Set githubLogin in the orchestrator's plugin settings (bb plugin config orchestrator set githubLogin <login>)."
        icon={null}
      />
    );
  if (v.state === "loading") return <Muted>Reading your open PRs from GitHub…</Muted>;
  if (v.state === "error") return <EmptyState title="Can't read your open PRs" text={v.error ?? "GitHub didn't answer."} icon={null} action={<Btn onClick={() => void q.refetch()}>Try again</Btn>} />;
  const needs = v.prs.filter((p) => p.needsReview);
  const shown = filter === "needs" ? needs : v.prs;
  return (
    <div className="orch-prs" data-open-prs="">
      <style href={styleHref("orch-prs", CSS)} precedence="default">
        {CSS}
      </style>
      <div className="grid gap-2">
        <div className="orch-prs__bar">
          <div className="orch-prs__filters" role="group" aria-label="Filter">
            <button type="button" data-filter="needs" aria-pressed={filter === "needs"} onClick={() => setFilter("needs")}>
              Needs review {needs.length}
            </button>
            <button type="button" data-filter="all" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              All {v.prs.length}
            </button>
          </div>
          {needs.length > 0 && !posting ? (
            <Btn data-post-open="" onClick={() => setPosting(true)}>
              Post to code reviews
            </Btn>
          ) : null}
        </div>
        <p className="orch-prs__note">
          {v.login}'s open PRs, checked {when(v.fetchedAt)}
          {v.pollMinutes > 0 ? `, again after ${v.pollMinutes} min` : ""}. Needs review: ready, not fully approved, CI not failing.
          {v.more ? " More open PRs than one read lists; the oldest are left out." : ""}
        </p>
        {v.error ? <p className="orch-prs__note">Last check failed, showing the one before: {v.error}</p> : null}
        {v.notes.map((n) => (
          <p key={n} className="orch-prs__note">
            {n}
          </p>
        ))}
      </div>
      {posting && needs.length > 0 ? <Post prs={needs} view={v} name={name} onClose={() => setPosting(false)} /> : null}
      {shown.length === 0 ? (
        <Muted>{filter === "needs" ? "Nothing needs review." : "No open PRs."}</Muted>
      ) : wide ? (
        <Table prs={shown} />
      ) : (
        <ul className="orch-prs__list">
          {shown.map((p) => (
            <Row key={p.url} pr={p} />
          ))}
        </ul>
      )}
      {needs.length > 0 ? <Ask prs={needs} name={name} /> : null}
    </div>
  );
}
