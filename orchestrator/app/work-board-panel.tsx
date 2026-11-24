// A work-board card, opened (SCOPE piece 4; mockup interact): beside the board on desktop, a sheet under
// the column on a phone. It acts through the app's own parts and routes, never copies of them:
// - the card waiting on the owner is Needs you's CardView (/answer, /defer), armed as everywhere else; a scoping card
//   is the Scope tab's (answered, never deferred);
// - a deliverable in review is the Deliverables tab's DeliverableCard (/deliverables/approve, /deliverables/changes);
// - "Message the lead" is the projects' Composer (the shared CompactBar, /projects/message) with the task named;
// - threads and PRs only open (navigation).
// Moving the task is the board's own (`move`, piece 5). Nothing here answers a card or merges a PR by moving it.
import { useRef, type ReactNode } from "react";
import type { z } from "zod";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { WRITES, type BoardTask, type Deliverables, type NeedsYou, type Projects, type Scope, type answerBody, type deferBody, type returnBody, type secretBody } from "../contract.ts";
import { CardView, ZONE, useArming, via, type Act, type List } from "./needs-you.tsx";
import { DeliverableCard } from "./deliverables.tsx";
import { Composer } from "./direct-line.tsx";
import { gate, useGate, write } from "./store.ts";
import { COLUMN_LABEL, findCard, whyText } from "./work-board-model.ts";
import { prKind } from "./palette.ts";
import { Btn, Kind, PageError, Tag, ago } from "./ui.tsx";
import { useIdentity } from "./identity.ts";
import { X } from "lucide-react";

type Card = NeedsYou["cards"][number];

const H = "m-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase";

export function TaskPanel({ t, now, needs, scope, deliverables, projects, after, onClose, move = null }: {
  t: BoardTask;
  now: number;
  needs: NeedsYou | undefined;
  scope: Scope | undefined;
  deliverables: Deliverables | undefined;
  projects: Projects | undefined;
  /** After a write: the page's reads and the board's. */
  after: () => void;
  onClose: () => void;
  move?: ReactNode;
}) {
  useGate();
  const navigate = useBbNavigate();
  const { cosTitle } = useIdentity();
  const root = useRef<HTMLDivElement>(null);
  const arming = useArming(root);
  // the owner's card, as Needs you lists it (open, or deferred) or the Scope tab (a scoping card); one no read lists
  // shows as its chip only
  const found = t.cards.map((c) => {
    const at = findCard(c.id, needs, scope);
    return at ? { c, card: at.card, list: at.list as List, scoping: at.scoping } : { c, card: null, list: null, scoping: false };
  });
  const send = (card: Card, kind: "answer" | "defer" | "return", hide: "both" | "cards" | "deferred", path: string, body: unknown) => {
    if (gate.lock) return; // one write at a time, page-wide
    if (kind !== "return" && !arming.check(card.id, card.rev)) return; // not sat still yet: dropped, as on Needs you
    void write(path, body, { card: { id: card.id, rev: card.rev, hide }, kind, after });
  };
  const act: Act = {
    answer: (c, _l, option, note) => send(c, "answer", "both", WRITES.answer, { id: c.id, rev: c.rev, option, text: note.trim() ? note : null, via: via() } satisfies z.input<typeof answerBody>),
    defer: (c, preset) => send(c, "defer", "cards", WRITES.defer, { id: c.id, rev: c.rev, preset, zone: ZONE, via: via() } satisfies z.input<typeof deferBody>),
    secret: (c, _l, value) => send(c, "answer", "both", WRITES.secret, { id: c.id, rev: c.rev, value, via: via() } satisfies z.input<typeof secretBody>),
    bringBack: (c) => send(c, "return", "deferred", WRITES.return, { id: c.id, rev: c.rev } satisfies z.input<typeof returnBody>),
  };
  const review = t.deliverables.map((d) => ({ d, full: deliverables?.find((x) => x.id === d.id) ?? null }));
  const project = projects?.find((p) => p.slug === t.project) ?? null;
  const live = t.threads.filter((x) => x.live);
  return (
    <div ref={root} className="wb-panel flex min-w-0 flex-col gap-4" role="region" aria-label={`Task: ${t.title}`} data-task-panel={t.id}>
      <header className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className={H}>{t.project}</p>
          <h2 className="m-0 text-base leading-6 font-semibold [overflow-wrap:anywhere]">{t.title}</h2>
          <p className="m-0 text-xs text-muted-foreground" data-panel-meta="">
            {COLUMN_LABEL[t.column]}
            {t.since ? ` · ${ago(t.since, now)}` : ""} · {whyText(t.why)} · task {t.id}
          </p>
        </div>
        <Btn tone="ghost" size="sm" aria-label="Close the task" data-panel-close="" onClick={onClose} icon={<X />} />
      </header>
      {move}
      {found.length ? (
        <section className="flex flex-col gap-2" aria-label="Cards" data-panel-cards="">
          <h3 className={H}>{found.some((f) => f.c.ownerWaits) ? "Card waiting on you" : "Cards"}</h3>
          {found.map(({ c, card, list, scoping }) =>
            card && list ? (
              <CardView key={c.id} card={card} list={list} presets={scoping ? [] : (needs?.presets ?? [])} isArmed={arming.isArmed(card.id, card.rev)} act={act} mon={null} />
            ) : (
              <p key={c.id} className="m-0 text-sm" data-panel-card-chip={c.id}>
                <Kind of={c.deferred ? "deferred" : "asked"}>{c.state === "open" ? `with the ${cosTitle} or the lead` : "card"}</Kind> {c.title}
              </p>
            ),
          )}
          <p className="m-0 text-xs text-muted-foreground">Moving the task never answers its card.</p>
        </section>
      ) : null}
      {review.length ? (
        <section className="flex flex-col gap-2" aria-label="Deliverables" data-panel-deliverables="">
          <h3 className={H}>Deliverables</h3>
          {review.map(({ d, full }) =>
            full && d.state === "review" ? (
              <DeliverableCard key={d.id} d={full} refetchAll={after} outputs={[]} outputsAfter={() => {}} closed />
            ) : (
              <p key={d.id} className="m-0 text-sm" data-panel-deliverable={d.id}>
                <Kind of={d.state}>{d.state === "changes" ? "sent back" : d.state}</Kind> {d.title} · rev {d.rev}
              </p>
            ),
          )}
        </section>
      ) : null}
      {live.length || t.prs.length ? (
        <section className="flex flex-col gap-2" aria-label="Attached" data-panel-attached="">
          <h3 className={H}>Attached</h3>
          {live.map((x) => (
            <div key={x.address} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
              <Tag data-panel-thread={x.address}>
                {x.address.replace(/^thread:[^:]+:/, "thread ")} · {x.state === "blocked" ? "failed" : x.state}
              </Tag>
              <Btn tone="ghost" size="sm" className="h-7 px-2" data-open-thread={x.threadId} onClick={() => navigate.toThread(x.threadId)}>
                Open thread
              </Btn>
            </div>
          ))}
          {t.prs.map((p) => (
            <div key={p.url} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
              <Kind of={p.state ?? "pr"} group={p.state === "merged" ? "merge" : prKind(p)} data-panel-pr={p.url}>
                {p.number ? `#${p.number}` : "PR"} {p.state ?? "unknown"}
                {p.checks ? ` · checks ${p.checks}` : ""}
              </Kind>
              <a className="text-sm underline underline-offset-2" href={p.url} target="_blank" rel="noreferrer" data-open-pr={p.url}>
                Open PR
              </a>
            </div>
          ))}
        </section>
      ) : null}
      <section className="flex flex-col gap-2" aria-label="Message the lead" data-panel-message="">
        <h3 className={H}>Message the lead</h3>
        {project?.lead ? (
          <Composer project={project} now={now} cos={cosTitle} busy={gate.lock !== null} refetchAll={after} onFocus={() => {}} compact task={{ id: t.id, title: t.title }} />
        ) : (
          <p className="m-0 text-sm text-muted-foreground">{project ? `${t.project} has no live lead.` : "Loading…"}</p>
        )}
        {/* a message (or an image) the server refused says so here, as under the projects' box to a lead */}
        <PageError where={`lead:${t.project}`} />
      </section>
    </div>
  );
}
