// Deliverables (docs/deliverables-plan.md): what leads hand the owner, each with its proof shown inline, newest first. The owner
// approves one, or requests changes in their own words and the lead re-delivers. Decided and withdrawn ones move to the
// past list below (past.ts, past-view.tsx), with the outputs that aren't any deliverable's proof under its Files filter. Writes go through the page's one write gate (store.ts): one at a time, every button off while one is in
// flight, and each write carries the revision the owner is looking at (a newer one is refused, never approved blind).
// On shadcn/ui since 2026-11-17: Card, Textarea, Collapsible folds and the picker rows as ghost buttons.
// 2026-11-17, every deliverable keeps its own files: a past one shows as PastDeliverable, its files as full items (images
// and videos inline at full width, the rest as rows) with Open folder; the Files filter lists every file (past-view.tsx).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown, experimental_useRpcQuery, useBbNavigate, useRealtime, useSdk } from "@get-bb/plugin-sdk/app";
import { manualSectionOrder, sidebarOrder } from "../core/project-order.ts";
import { z } from "zod";
import { CHANGED_CHANNEL, PROOF_ROUTE, WRITE_BASE, WRITES, rpcContract, type Deliverables, type Outputs, type ProjectOrder, type approveBody, type requestChangesBody } from "../contract.ts";
import { ItemGroup } from "./ui/item.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.tsx";
import { ReplyAction, ReplyButton, ReplyComposer, ReplyField } from "./reply-composer.tsx";
import { cn } from "./ui/utils.ts";
import { Fold } from "./answer-ui.tsx";
import { AgentFace } from "./face.tsx";
import { personaName } from "./faces.ts";
import { Blocks } from "./blocks.tsx";
import { lessText } from "./less-text.ts";
import { GALLERY, Points, SHOT } from "./visual-blocks.tsx";
import { prKind } from "./palette.ts";
import { openInBb } from "./open-proof.ts";
import { ProofLink } from "./proof-link.tsx";
import { gate, useGate, write } from "./store.ts";
import { APPROVE_MS, pressApprove } from "./keys.ts";
import { keyState, say, emitKeys } from "./key-state.ts";
import { useViewKeys } from "./key-view.ts";
import { age } from "./lanes.ts";
import { Btn, EmptyState, Kind, PageError, ReadState, Who, when } from "./ui.tsx";
import { FileFull, FoldedOutputs, OpenFolder } from "./files.tsx";
import { START, deliverablesTab, fold, offBoards, shownDeliverable, shownRevision, type FileItem, type View } from "./past.ts";
import { FilesAndWithdrawn, OFF_PAGE, PastControls, PastRows, STATE_WORD, type FoldersState } from "./past-view.tsx";
import { useElementWidth } from "./panes.tsx";
import { requestDeliverable } from "./reveal.ts";
import { isWide } from "./source.ts";

type Deliverable = Deliverables[number];
type Proof = Deliverable["revisions"][number]["proof"][number];
type Output = Outputs[number];
type Query = { data: Deliverables | undefined; error: { message: string } | null; refetch: () => Promise<void> };

const TEXT_LINES = 200;
export const proofSrc = (id: string) => `${WRITE_BASE}${PROOF_ROUTE}?id=${encodeURIComponent(id)}`;
/** A recorded output's file, through the same route and rules (2026-11-17). */
export const outputSrc = (id: string) => `${WRITE_BASE}${PROOF_ROUTE}?output=${encodeURIComponent(id)}`;

export { inReview, inScope, onDeliverablesTab } from "./kit.ts";
import { onDeliverablesTab } from "./kit.ts";

/** A Markdown proof (a .md or .markdown file) is rendered the way bb renders a chat message, not shown as its source. */
const isMarkdown = (p: { path?: string | null; caption: string }) => /\.(md|markdown)$/i.test(p.path ?? "");

/**
 * A text proof: the first TEXT_LINES lines of the (already capped) file. A fixed-height box, so Approve never moves;
 * long lines wrap inside the card (2026-11-13: a wide report ran past the card's edge).
 */
function TextProof({ id, markdown }: { id: string; markdown: boolean }) {
  const [text, setText] = useState<{ lines: string[]; more: number } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    fetch(proofSrc(id))
      .then(async (r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => {
        const all = t.split("\n");
        if (live) setText({ lines: all.slice(0, TEXT_LINES), more: Math.max(0, all.length - TEXT_LINES) });
      })
      .catch((e: unknown) => live && setText({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [id]);
  if (text && "error" in text) return <p className="orch-danger m-0 text-xs">Can't show this file: {text.error}</p>;
  return (
    <>
      {markdown && text ? (
        <div className="max-h-96 min-w-0 max-w-full overflow-x-hidden overflow-y-auto rounded-md bg-muted/50 p-3 text-sm [overflow-wrap:anywhere]">
          <Markdown content={text.lines.join("\n")} />
        </div>
      ) : (
        <pre className="orch-mono m-0 max-h-64 min-w-0 max-w-full overflow-auto rounded-md bg-muted/50 p-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{text ? text.lines.join("\n") : "Loading…"}</pre>
      )}
      {text && text.more > 0 ? <p className="m-0 text-xs text-muted-foreground">{text.more} more lines not shown.</p> : null}
    </>
  );
}

/** A PR's number from its URL, for a PR pr-watch doesn't follow (it shows no live state then, but still says which). */
const prNumber = (url: string | null | undefined) => url?.match(/\/pull\/(\d+)/)?.[1] ?? null;

export function ProofView({ p }: { p: Proof }) {
  const navigate = useBbNavigate();
  const [unopened, setUnopened] = useState(false);
  const caption = <figcaption className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{p.caption}</figcaption>;
  // every kind opens as a bb pane (open-proof.ts); a file's fallback is the proof route in a new tab
  const file = p.kind === "image" || p.kind === "video" || p.kind === "text" ? proofSrc(p.id) : undefined;
  const openLink = (
    <ProofLink open={p} fallback={file} className="text-xs font-medium text-inherit underline-offset-2 hover:underline">
      Open ↗
    </ProofLink>
  );
  if (p.kind === "image")
    return (
      <figure className="m-0" data-proof={p.id}>
        {/* full size in a bb pane */}
        <ProofLink open={p} fallback={file} className={cn(SHOT, "inline-block max-w-full")}>
          <img src={proofSrc(p.id)} alt={p.caption} loading="lazy" decoding="async" className="block h-auto max-h-80 w-auto max-w-full cursor-zoom-in" />
        </ProofLink>
        {caption}
      </figure>
    );
  if (p.kind === "video")
    return (
      <figure className="m-0" data-proof={p.id}>
        <video src={proofSrc(p.id)} controls preload="metadata" className={cn(SHOT, "block h-64 w-full")} />
        <div className="flex items-baseline gap-2">
          {openLink}
          {caption}
        </div>
      </figure>
    );
  if (p.kind === "text")
    return (
      <figure className="m-0 min-w-0 max-w-full" data-proof={p.id}>
        <TextProof id={p.id} markdown={isMarkdown(p)} />
        <div className="flex items-baseline gap-2">
          {openLink}
          {caption}
        </div>
      </figure>
    );
  if (p.kind === "pr")
    return (
      <div className="flex flex-wrap items-center gap-2" data-proof={p.id}>
        <ProofLink open={p} className="no-underline">
          <Kind of="pr" group={p.pr ? prKind(p.pr) : undefined}>
            {p.pr ? `PR${p.pr.number ? ` #${p.pr.number}` : ""} · ${p.pr.state ?? "?"}${p.pr.attention && p.pr.attention !== "none" && p.pr.attention !== p.pr.state ? ` · ${p.pr.attention.replace(/_/g, " ")}` : ""}${p.pr.checks ? ` · checks ${p.pr.checks}` : ""}` : `PR${prNumber(p.url) ? ` #${prNumber(p.url)}` : ""}`}
          </Kind>
        </ProofLink>
        <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{p.caption}</span>
      </div>
    );
  // a doc or a link: a file in bb's preview pane on its host, a URL in bb's browser pane
  return (
    <div className="flex flex-wrap items-center gap-2" data-proof={p.id}>
      {p.url ? (
        <ProofLink open={p} className="font-medium text-inherit underline-offset-2 hover:underline [overflow-wrap:anywhere]">
          {p.kind === "doc" ? "Open doc" : "Open link"} ↗
        </ProofLink>
      ) : (
        <Btn onClick={() => setUnopened(!openInBb(navigate, p))}>Open doc</Btn>
      )}
      <Kind of={p.kind} />
      <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{p.caption}</span>
      {unopened ? (
        <span role="alert" className="orch-danger text-xs">
          bb couldn't open this file here.
        </span>
      ) : null}
    </div>
  );
}

/**
 * The next-action box, then Request changes and the primary button (2026-11-16: "what I usually have to do is say
 * next move: send this to someone"). Empty box: "Done, nothing more" approves and the lead does nothing further. Words
 * in it: "Send to lead" approves and hands the lead those words as an item they must act on and report back on.
 * Request changes opens its own field; the next box's words are never sent as a change request. Off while any write runs.
 */
function Review({ d, refetchAll }: { d: Deliverable; refetchAll: () => void }) {
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState("");
  const [next, setNext] = useState("");
  const busy = gate.lock !== null;
  const action = next.trim();
  const approve = async () => {
    const body: z.input<typeof approveBody> = { id: d.id, rev: d.rev, note: null, next: action || null };
    const out = await write(WRITES.approve, body, { kind: "other", where: d.id, after: refetchAll });
    if (out?.ok) setNext("");
  };
  const sendBack = async () => {
    const body: z.input<typeof requestChangesBody> = { id: d.id, rev: d.rev, text: text.trim() };
    const out = await write(WRITES.requestChanges, body, { kind: "other", where: d.id, after: refetchAll });
    if (out?.ok) {
      setAsking(false);
      setText("");
    }
  };
  return (
    <div className="mt-3 grid gap-2">
      {asking ? (
        <ReplyComposer
          field={
            <ReplyField
              id={`changes-${d.id}`}
              aria-label="What to change"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={4000}
              placeholder="What to change? The lead gets these words and re-delivers"
              data-changes-text={d.id}
            />
          }
          actions={
            <>
              <ReplyAction disabled={busy} onClick={() => setAsking(false)}>
                Cancel
              </ReplyAction>
              <ReplyButton data-changes-send={d.id} disabled={busy || !text.trim()} onClick={() => void sendBack()}>
                Send back
              </ReplyButton>
            </>
          }
        />
      ) : (
        <ReplyComposer
          field={
            <ReplyField
              aria-label="Next move"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (!busy && action) void approve();
                }
              }}
              maxLength={4000}
              // one line to start, growing as it fills
              placeholder="Next move? e.g. forward this to the team"
              data-next-text={d.id}
            />
          }
          // said in the row, not only in the button's tooltip: a phone has no hover
          hint={
            <span data-approve-hint="" className="text-xs text-muted-foreground">
              {action ? "Approves it; the lead does this and reports back" : "Closes it; the lead does nothing further"}
            </span>
          }
          actions={
            <>
              <ReplyAction variant="outline" data-changes={d.id} disabled={busy} onClick={() => setAsking(true)}>
                Request changes
              </ReplyAction>
              {/* enabled while empty: "Done, nothing more" closes it with no next move */}
              <ReplyButton data-approve={d.id} data-next-send={action ? d.id : undefined} title={action ? "Approve, and the lead does this next" : "Closes it; the lead does nothing further"} disabled={busy} onClick={() => void approve()}>
                {action ? "Send to lead" : "Done, nothing more"}
              </ReplyButton>
            </>
          }
        />
      )}
      <PageError where={d.id} />
    </div>
  );
}

// Green is for "done" only. "replied" (the lead answered the item with a reply that names it) says they answered, not
// that the next action was carried out, so it stays amber: an ack must not read as done when it isn't.
const NEXT_TONE: Record<string, "done" | "deferred" | "alarm" | "inactive"> = { done: "done", replied: "deferred", refused: "alarm", failed: "alarm", superseded: "inactive" };

/** "Next: forward to the team → done · "posted in #channel" · 12m": the owner's next action and how the lead closed it. */
export function NextLine({ n }: { n: NonNullable<Deliverable["next"]> }) {
  return (
    <p data-next={n.state} className="m-0 mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs [overflow-wrap:anywhere]">
      <span className="text-muted-foreground">Next:</span>
      <span className="font-medium">{n.text}</span>
      <span className="text-muted-foreground">→</span>
      {n.state === "closed" ? (
        <>
          <Kind of={n.outcome ?? "closed"} group={NEXT_TONE[n.outcome ?? ""] ?? "inactive"} data-next-outcome={n.outcome ?? ""}>
            {n.outcome ?? "closed"}
          </Kind>
          <span>
            {n.note ? <span data-next-note="">· “{n.note}” </span> : null}
            {n.closedAt ? <span className="text-muted-foreground">· {age(n.closedAt, Date.now())}</span> : null}
          </span>
        </>
      ) : n.state === "dead" ? (
        <Kind of="dead">not delivered</Kind>
      ) : (
        <Kind of="deferred" data-next-outcome="">with the lead</Kind>
      )}
    </p>
  );
}

/** Earlier revisions and the owner's feedback on each, folded under the card. */
export function History({ d }: { d: Deliverable }) {
  const earlier = d.revisions.filter((r) => r.rev < d.rev);
  if (earlier.length === 0 && d.feedback.length === 0) return null;
  return (
    <Fold label={`History (${d.revisions.length} revision${d.revisions.length === 1 ? "" : "s"})`} className="mt-3 text-xs" data-history="">
      <ol className="m-0 mt-2 grid list-none gap-2 p-0">
        {d.revisions.map((r) => (
          <li key={r.rev} className="rounded-md bg-muted/50 p-2">
            <div className="text-muted-foreground">
              rev {r.rev} · {when(r.at)} · {r.proof.length} proof
            </div>
            <div className="mt-1 min-w-0 [overflow-wrap:anywhere]"><Markdown content={r.summary} /></div>
            {d.feedback
              .filter((f) => f.rev === r.rev)
              .map((f) => (
                <p key={f.at} className="m-0 mt-1 flex flex-wrap items-center gap-1.5 [overflow-wrap:anywhere]">
                  <Kind of={f.outcome}>{f.outcome === "changes" ? "changes requested" : "approved"}</Kind>
                  <span className="text-muted-foreground">{when(f.at)}</span>
                  {f.text ? <span className="whitespace-pre-wrap">{f.text}</span> : null}
                </p>
              ))}
            {d.next?.rev === r.rev ? <NextLine n={d.next} /> : null}
          </li>
        ))}
      </ol>
    </Fold>
  );
}

/** A deliverable's title, its project and its state, as a shadcn card header. */
function Head({ d }: { d: Deliverable }) {
  return (
    <CardHeader className="px-5">
      <CardTitle role="heading" aria-level={3} className="text-base leading-6 [overflow-wrap:anywhere]">
        {d.title}
      </CardTitle>
      <CardDescription>{d.project ?? "No project"}</CardDescription>
      <CardAction>
        <StateChip d={d} />
      </CardAction>
    </CardHeader>
  );
}

/** "in review · rev 2" while it waits for the owner; afterwards its state (the wide tab's detail shows past ones too). */
function StateChip({ d }: { d: Deliverable }) {
  if (d.state !== "review") return <Kind of={d.state}>{STATE_WORD[d.state]}</Kind>;
  return <Kind of="review">{d.rev > 1 ? `in review · rev ${d.rev}` : "in review"}</Kind>;
}

/** Where a past deliverable's review controls were: why it was withdrawn, and the owner's next action and its outcome. */
function Settled({ d }: { d: Deliverable }) {
  if (!d.withdrawn && !d.next) return null;
  return (
    <div className="mt-3" data-settled={d.id}>
      {d.withdrawn ? (
        <p className="m-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          Withdrawn {when(d.withdrawn.at)}
          {d.withdrawn.reason ? `: ${d.withdrawn.reason}` : ""}
        </p>
      ) : null}
      {d.next ? <NextLine n={d.next} /> : null}
    </div>
  );
}

export function DeliverableCard({ d, refetchAll, outputs, outputsAfter }: { d: Deliverable; refetchAll: () => void; outputs: Output[]; outputsAfter: () => void }) {
  const latest = d.revisions.find((r) => r.rev === d.rev) ?? d.revisions[d.revisions.length - 1];
  const proof = latest?.proof ?? [];
  const media = proof.filter((p) => p.kind === "image" || p.kind === "video");
  const rest = proof.filter((p) => p.kind !== "image" && p.kind !== "video");
  const short = latest ? lessText(latest) : null;
  if (short && latest) return <ShortCard d={d} rev={latest} layout={short} media={media} rest={rest} refetchAll={refetchAll} outputs={outputs} outputsAfter={outputsAfter} />;
  return (
    <Card role="article" data-deliverable={d.state === "review" ? d.id : undefined} data-shown={d.id} className="gap-4 py-5">
      <Head d={d} />
      <CardContent className="px-5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <AgentFace face={{ mon: d.leadMon, persona: d.leadPersona }} address={d.lead} size={28} />
          <Who address={d.lead} nowrap />
          {d.leadPersona ? <span data-lead-persona="">{personaName(d.leadPersona)}</span> : null}
          <span>{when(d.updatedAt)}</span>
        </div>
        <div className="mt-2 min-w-0 [overflow-wrap:anywhere]"><Markdown content={d.summary} /></div>
        {/* Requested 2026-11-13: "a lot more visual". What it looks like first (screenshots, video), then the typed
            parts (decisions, diagram, root cause, what to change, checks), then the rest of the proof. */}
        {media.length > 0 ? (
          <div data-gallery="" className={cn("mt-3 grid gap-3", media.length > 1 && GALLERY)}>
            {media.map((p) => (
              <ProofView key={p.id} p={p} />
            ))}
          </div>
        ) : null}
        <Blocks blocks={latest?.blocks ?? []} prs={latest?.prs ?? []} />
        {rest.length > 0 ? (
          <div className="mt-3 grid gap-3">
            {rest.map((p) => (
              <ProofView key={p.id} p={p} />
            ))}
          </div>
        ) : null}
        {d.state === "review" ? <Review d={d} refetchAll={refetchAll} /> : <Settled d={d} />}
        <History d={d} />
        <FoldedOutputs outputs={outputs} after={outputsAfter} />
      </CardContent>
    </Card>
  );
}

/**
 * A past deliverable as the owner looks back at it (2026-11-17): what its card said (summary, points, typed parts, how
 * it was settled), then its files as full items: images and videos inline at full width, the rest as rows with name,
 * kind and size, and Open folder; then its links and PRs, and its history.
 */
export function PastDeliverable({ d, files, folders, refetchAll, outputsAfter }: { d: Deliverable; files: FileItem[]; folders: FoldersState; refetchAll: () => void; outputsAfter: () => void }) {
  if (d.state === "review") return <DeliverableCard d={d} refetchAll={refetchAll} outputs={[]} outputsAfter={outputsAfter} />;
  const rev = shownRevision(d);
  const host = folders.data?.hostId ?? null;
  const folder = folders.data?.folders[d.id];
  const media = files.filter((f) => !f.missing && ((f.kind === "images" && f.proof?.kind === "image") || (f.kind === "videos" && f.proof?.kind === "video")));
  const rest = files.filter((f) => !media.includes(f));
  const links = (rev?.proof ?? []).filter((p) => p.url);
  return (
    <Card role="article" data-shown={d.id} data-past-detail={d.id} className="gap-4 py-5">
      <Head d={d} />
      <CardContent className="grid gap-3 px-5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <AgentFace face={{ mon: d.leadMon, persona: d.leadPersona }} address={d.lead} size={28} />
          <Who address={d.lead} nowrap />
          {d.leadPersona ? <span data-lead-persona="">{personaName(d.leadPersona)}</span> : null}
          <span>{when(d.updatedAt)}</span>
        </div>
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <Markdown content={rev?.summary ?? d.summary} />
        </div>
        {rev && rev.points.length > 0 ? <Points points={rev.points} /> : null}
        <Blocks blocks={rev?.blocks ?? []} prs={rev?.prs ?? []} />
        <Settled d={d} />
        <section aria-label="Files" data-past-files={d.id} className="grid gap-3 border-t pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="m-0 text-sm font-semibold">
              Files <span className="font-normal text-muted-foreground tabular-nums">{files.length}</span>
            </h4>
            <OpenFolder folder={folder} host={host} />
          </div>
          {!folders.data && !folders.error ? (
            <div role="status" className="grid gap-2">
              <span className="sr-only">Loading…</span>
              <Skeleton className="aspect-video w-full" />
              <Skeleton className="h-4 w-56" />
            </div>
          ) : files.length === 0 ? (
            <p className="m-0 text-sm text-muted-foreground">No files: its proof is links only.</p>
          ) : (
            <>
              {media.map((f) => (
                <FileFull key={f.key} f={f} host={host} after={outputsAfter} />
              ))}
              {rest.length > 0 ? (
                <ItemGroup>
                  {rest.map((f) => (
                    <FileFull key={f.key} f={f} host={host} after={outputsAfter} />
                  ))}
                </ItemGroup>
              ) : null}
            </>
          )}
        </section>
        {links.length > 0 ? (
          <div className="grid gap-2" data-past-links="">
            {links.map((p) => (
              <ProofView key={p.id} p={p} />
            ))}
          </div>
        ) : null}
        <History d={d} />
      </CardContent>
    </Card>
  );
}

/** A deliverable with points (2026-11-14, "way less text"): pictures, then each decision and finding in a line; the rest closed. */
function ShortCard({ d, rev, layout, media, rest, refetchAll, outputs, outputsAfter }: { d: Deliverable; rev: Deliverable["revisions"][number]; layout: NonNullable<ReturnType<typeof lessText>>; media: Proof[]; rest: Proof[]; refetchAll: () => void; outputs: Output[]; outputsAfter: () => void }) {
  const part = (p: (typeof layout.parts)[number]) => {
    switch (p) {
      case "context":
        return (
          <p key={p} data-context-line="" className="m-0 mt-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {rev.summary}
          </p>
        );
      case "media":
        return media.length > 0 ? (
          <div key={p} data-gallery="" className={cn("mt-3 grid gap-3", media.length > 1 && GALLERY)}>
            {media.map((m) => (
              <ProofView key={m.id} p={m} />
            ))}
          </div>
        ) : null;
      case "visuals":
        return <Blocks key={p} blocks={rev.blocks} prs={rev.prs} only={layout.visual} />;
      case "points":
        return (
          <div key={p} className="mt-3">
            <Points points={rev.points} />
          </div>
        );
      case "review":
        return d.state === "review" ? <Review key={p} d={d} refetchAll={refetchAll} /> : <Settled key={p} d={d} />;
      case "details":
        // Details starts closed; its content stays in the page, hidden, so the order holds open or closed
        return (
          <Fold key={p} label={layout.detailsLabel} data-details="" className="mt-3">
            <Blocks blocks={rev.blocks} prs={rev.prs} only={layout.rest} />
            {rest.length > 0 ? (
              <div className="mt-3 grid gap-3">
                {rest.map((r) => (
                  <ProofView key={r.id} p={r} />
                ))}
              </div>
            ) : null}
          </Fold>
        );
      case "history":
        return <History key={p} d={d} />;
    }
  };
  return (
    <Card role="article" data-deliverable={d.state === "review" ? d.id : undefined} data-shown={d.id} data-layout="short" className="gap-4 py-5">
      <Head d={d} />
      <CardContent className="px-5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <AgentFace face={{ mon: d.leadMon, persona: d.leadPersona }} address={d.lead} size={28} />
          <Who address={d.lead} nowrap />
          {d.leadPersona ? <span data-lead-persona="">{personaName(d.leadPersona)}</span> : null}
          <span>{when(d.updatedAt)}</span>
        </div>
        {layout.parts.map(part)}
        <FoldedOutputs outputs={outputs} after={outputsAfter} />
      </CardContent>
    </Card>
  );
}

/**
 * The projects in the viewer's sidebar order (2026-11-16: the tree's folders "in the same order as the sidebar's project
 * sections"): bb's section list and the Thread list plugin's manualSectionOrder (the sidebar's own preference), read as
 * the viewer through the page's bb client, applied to the server's placing order. Read once per visit; the placing order if bb can't say.
 */
const anything = z.unknown();
function useSidebarOrder(place: ProjectOrder | undefined): ProjectOrder {
  const sdk = useSdk();
  const [bbOrder, setBbOrder] = useState<{ sections: { id: string; name: string }[]; manual: string[] } | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([sdk.threadSections.list(), sdk.plugins.callRpc({ pluginId: "thread-list", method: "listPreferences", input: null, outputSchema: anything })])
      .then(([sections, prefs]) => live && setBbOrder({ sections: sections.map((s) => ({ id: s.id, name: s.name })), manual: manualSectionOrder(prefs) }))
      .catch(() => {}); // the placing order stands
    return () => {
      live = false;
    };
  }, [sdk]);
  return useMemo(() => {
    if (!place) return [];
    if (!bbOrder) return place;
    const type = new Map(place.map((p) => [p.slug, p.monType] as const));
    return sidebarOrder(place.map((p) => p.slug), bbOrder.sections, bbOrder.manual).map((slug) => ({ slug, monType: type.get(slug) ?? null }));
  }, [place, bbOrder]);
}

/**
 * The Deliverables tab (2026-11-16, Deliverables and Outputs in one): what waits for the owner on top, exactly as before;
 * below it every past deliverable and, under Files, the outputs that never became proof. `files`: opened from an old
 * Outputs link, so the list starts on Files.
 */
export function DeliverablesView({ q, refetchAll, files = false }: { q: Query; refetchAll: () => void; files?: boolean }) {
  useGate();
  const root = useRef<HTMLDivElement | null>(null);
  // the pane's own width, not the window's: the board can sit in a split pane (Projects measures the same way)
  const [width, measure] = useElementWidth();
  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      root.current = el;
      measure(el);
    },
    [measure],
  );
  const wide = isWide(width);
  const [picked, setPicked] = useState<string | null>(null);
  const outputs = experimental_useRpcQuery({ contract: rpcContract, method: "outputs", input: null });
  // the sidebar's project order, for the project filter
  const order = experimental_useRpcQuery({ contract: rpcContract, method: "projectOrder", input: null });
  // every deliverable's own folder, listed (2026-11-17): its files beside its proof, and a thread's notes
  const folders = experimental_useRpcQuery({ contract: rpcContract, method: "deliverableFolders", input: null });
  const latestOutputs = useRef({ outputs: outputs.refetch, order: order.refetch, folders: folders.refetch });
  latestOutputs.current = { outputs: outputs.refetch, order: order.refetch, folders: folders.refetch };
  const refetchOutputs = useCallback(() => {
    void latestOutputs.current.outputs();
    void latestOutputs.current.order();
    void latestOutputs.current.folders();
  }, []);
  useRealtime(CHANGED_CHANNEL, refetchOutputs);
  const sorted = useSidebarOrder(order.data);
  const [view, setView] = useState<View>({ ...START, filter: files ? "files" : "decided" });
  useEffect(() => {
    if (files) setView((v) => ({ ...v, filter: "files" }));
  }, [files]);
  // Keys (2026-11-16): J/K select a deliverable; A, twice within APPROVE_MS, is "Done, nothing more". It clicks the card's own
  // button, so the page lock applies; with words in the next-move box the button is "Send to lead", which A never presses.
  // Only in-review cards carry data-deliverable, so J/K never select a past row.
  useViewKeys("deliverables", root, "[data-deliverable]", (el) => el.dataset.deliverable ?? "", (a, sel) => {
    if (a.t !== "approve" || !sel) return false;
    const btn = sel.el.querySelector<HTMLButtonElement>(`[data-approve="${CSS.escape(sel.id)}"]`);
    if (!btn || btn.disabled) {
      say("Can't close this one now");
      return true;
    }
    if (btn.hasAttribute("data-next-send")) {
      say("The next-move box has words: use Send to lead");
      return true;
    }
    const r = pressApprove(keyState.arm, sel.id, performance.now());
    keyState.arm = r.arm;
    if (r.fire) {
      say("Closed", 1200);
      btn.click();
    } else {
      say("Press A again to close", APPROVE_MS);
      emitKeys();
    }
    return true;
  });
  if (!q.data) return <ReadState q={q} what="the deliverables" />;
  // a scoping project's deliverables in review are reviewed in the Scope tab; once decided they file here as usual
  const all = q.data.filter(onDeliverablesTab);
  const tab = deliverablesTab(all, offBoards(q.data, outputs.data ?? []), view, sorted, folders.data?.folders ?? {});
  const review = tab.review;
  const filesState = { loaded: outputs.data !== undefined, error: outputs.error?.message ?? null };
  const foldersState: FoldersState = { data: folders.data, error: folders.error?.message ?? null };
  const empty = <EmptyState title="Nothing to review" text="Leads deliver finished work here with proof (orch_deliver). You approve it or send it back." />;
  const off = OFF_PAGE.includes(view.filter);
  const heading = off ? "Files and withdrawn" : view.filter === "decided" ? "Decided" : "Past deliverables";
  // a file's deliverable link: back to the list, with that deliverable picked (wide) or opened (narrow)
  const showDeliverable = (id: string) => {
    setView(() => START);
    setPicked(id);
    requestDeliverable(id); // pending too, so the list that mounts in the nav opens its folder (reveal.ts)
  };
  const rows = (pick?: { id: string | null; on: (id: string) => void }) => (
    <PastRows tab={tab} view={view} setView={setView} outputs={filesState} folders={foldersState} outputsAfter={refetchOutputs} refetchAll={refetchAll} pick={pick} onDeliverable={showDeliverable} />
  );
  if (!wide)
    return (
      <div ref={setRoot} data-deliverables-width={width}>
        <div className="flex flex-col gap-4 pb-8" data-layout="column" style={{ maxWidth: 768, marginInline: "auto" }}>
          <ReadState q={q} what="the deliverables" />
          {off ? null : review.length === 0 ? empty : review.map((r) => <DeliverableCard key={r.d.id} d={r.d} refetchAll={refetchAll} outputs={r.outputs} outputsAfter={refetchOutputs} />)}
          <h2 className="m-0 text-base leading-6 font-semibold">{heading}</h2>
          <PastControls tab={tab} view={view} setView={setView} />
          {rows()}
          {off ? null : <FilesAndWithdrawn tab={tab} setView={setView} />}
        </div>
      </div>
    );
  // wide: the list (in review on top, then the past deliverables) beside the picked deliverable; under Files, the files
  // take the detail's place
  const shown = shownDeliverable(all, picked);
  const shownOutputs = shown ? (fold(all, outputs.data ?? []).byDeliverable.get(shown.id) ?? []) : [];
  const filesView = view.filter === "files";
  return (
    <div ref={setRoot} data-deliverables-width={width}>
      <div className="pb-8" data-layout="list-detail">
        <ReadState q={q} what="the deliverables" />
        <div className="grid grid-cols-[minmax(340px,420px)_minmax(0,1fr)] items-start gap-6">
          <nav className="flex min-w-0 flex-col gap-6" aria-label="Deliverables">
            <section aria-label="In review" hidden={off}>
              <h2 className="m-0 mb-2 text-base leading-6 font-semibold">In review · {review.length}</h2>
              {review.length === 0 ? (
                <p className="m-0 text-sm text-muted-foreground">Nothing to review.</p>
              ) : (
                <ul className="m-0 grid list-none gap-0.5 p-0" role="list">
                  {review.map(({ d }) => (
                    <li key={d.id}>
                      <Btn
                        tone="ghost"
                        className="h-auto w-full flex-col items-start gap-0.5 p-2 text-start font-normal whitespace-normal aria-[current=true]:bg-accent"
                        data-review-row={d.id}
                        aria-current={shown?.id === d.id || undefined}
                        onClick={() => setPicked(d.id)}
                      >
                        <span className="text-sm leading-5 font-semibold [overflow-wrap:anywhere]">{d.title}</span>
                        <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                          {d.project ?? "No project"} · {d.lead} · {age(d.updatedAt, Date.now())} ago{d.rev > 1 ? ` · rev ${d.rev}` : ""}
                        </span>
                      </Btn>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="grid grid-cols-[minmax(0,1fr)] gap-3" aria-label={heading}>
              <h2 className="m-0 text-base leading-6 font-semibold">{heading}</h2>
              <PastControls tab={tab} view={view} setView={setView} />
              {filesView ? null : rows({ id: shown?.id ?? null, on: setPicked })}
              {off ? null : <FilesAndWithdrawn tab={tab} setView={setView} />}
            </section>
          </nav>
          {filesView ? (
            <div className="min-w-0" data-detail="files">
              {rows()}
            </div>
          ) : (
            <div className="min-w-0" data-detail={shown?.id ?? ""}>
              {shown ? (
                shown.state === "review" ? (
                  <DeliverableCard key={shown.id} d={shown} refetchAll={refetchAll} outputs={shownOutputs} outputsAfter={refetchOutputs} />
                ) : (
                  <PastDeliverable key={shown.id} d={shown} files={tab.filesBy.get(shown.id) ?? []} folders={foldersState} refetchAll={refetchAll} outputsAfter={refetchOutputs} />
                )
              ) : (
                empty
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
