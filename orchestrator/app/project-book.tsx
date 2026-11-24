// One project as a source of truth (2026-11-16, layout B; the detail layout of 2026-11-17, proposal 5). Under the message
// box: the Pinned strip, then the goal with its step meter, then what needs the owner and what blocks, side by side, so
// the answer is in the first row; then Now (thread cards) and what else it waits on, beside the PRs in flight and the
// record (Done and Decided in one list, each row tagged). Each section is one card (BookCard, shadcn's Card); empty ones collapse to their head. A PR
// shows once: a wait on it folds into its row (kit.ts prRows). Every line keeps its age and its source.
// Decided, Done, the merges, the blockers' start and the pins are read for this project only (core/book.ts, pins.ts),
// refreshed on the same change signal as the list, so the two sides never disagree.
import { Fragment, useCallback, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import type { z } from "zod";
import { experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { WRITES, rpcContract, type NeedsYou, type ProjectBook as Book, type Projects, type pinBody } from "../contract.ts";
import { touches } from "../change-notice.ts";
import { position } from "../core/status.ts";
import { outOfDateLine, statusStale, waitLine } from "./command-center.ts";
import { INLINE_LINK, RefText, RefsContext } from "./ref-text.tsx";
import { openInBb, plainClick, type Openable } from "./open-proof.ts";
import { panel } from "./refs.ts";
import { age, type Lane } from "./lanes.ts";
import { write } from "./store.ts";
import { blockerLines, dayStart, mergedTodayCount, needLines, type NeedLine } from "./source.ts";
import { DETAIL_LAYOUT, ROWS_SHOWN, THREADS_SHOWN, ageSpec, prRows, recordRows, type DetailSection, type IconName } from "./kit.ts";
import { Age, Chip, Icon, Steps } from "./kit-ui.tsx";
import { ChevronRight } from "lucide-react";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";
import { Item } from "./ui/item.tsx";
import { cn } from "./ui/utils.ts";
import { Btn } from "./ui.tsx";
import { ThreadCards } from "./thread-card.tsx";
import { PinStrip } from "./pins.tsx";
import type { OpenCard } from "./projects.tsx";
import { useChangeNotice } from "./change-listener.ts";

type Project = Projects[number];

export const bookCss = /* css */ `
[data-orch] .orch-cc .k-detail { display: flex; flex-direction: column; gap: 16px; min-width: 0; cursor: default; }
[data-orch] .orch-cc .k-attn { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
[data-orch] .orch-cc .k-attn[data-one="true"] { grid-template-columns: minmax(0, 1fr); }
[data-orch] .orch-cc .k-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px 24px; align-items: start; }
[data-orch] .orch-cc .k-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
[data-orch] .orch-cc .k-goal { display: flex; align-items: flex-start; gap: 16px; min-width: 0; }
[data-orch] .orch-cc .k-goal .k-g { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
[data-orch] .orch-cc .k-goal .k-step { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 16px; color: var(--orch-muted); }
[data-orch] .orch-cc .k-goal .k-side { display: flex; align-items: center; gap: 8px; flex: none; }
[data-orch] .orch-cc .k-row a.k-ref, [data-orch] .orch-cc .k-row button.k-ref { flex: none; }
[data-orch] .orch-cc .k-t > a.ref, [data-orch] .orch-cc .k-t > button.ref { font-weight: inherit; }
[data-orch] .orch-cc .k-update { display: flex; flex-direction: column; gap: 8px; padding: 4px 0; font-size: 13px; line-height: 20px; min-width: 0; }
[data-orch] .orch-cc .k-update ul { margin: 0; padding-left: 20px; list-style: disc outside; display: flex; flex-direction: column; gap: 4px; }
[data-orch] .orch-cc .k-update li { display: list-item; margin: 0; list-style: disc outside; }
[data-orch] .orch-cc .k-update li::marker { color: var(--orch-muted); }
[data-orch] .orch-cc .k-update .k-clamp { overflow-wrap: anywhere; min-width: 0; }
[data-orch] .orch-cc .k-update .k-clamp[data-clamped="true"] .k-txt { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: var(--k-lines, 2); overflow: hidden; }
[data-orch] .orch-cc .k-update code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; padding: 0 4px; border-radius: 4px; background: var(--muted); }
@container orchcc (max-width: 760px) {
  [data-orch] .orch-cc .k-attn, [data-orch] .orch-cc .k-cols { grid-template-columns: minmax(0, 1fr); }
  [data-orch] .orch-cc .k-goal { flex-direction: column; gap: 8px; }
}
@container orchcc (max-width: 640px) {
  [data-orch] .orch-cc .k-row { flex-wrap: wrap; }
  /* the text wraps in its own column, so its icon and age stay on its first line (2026-11-20: the icon sat alone above it) */
  [data-orch] .orch-cc .k-row .k-t { flex: 1 1 0; min-width: 0; white-space: normal; }
}
`;

/** A link to something the page knows, opened in bb (openInBb): a card, a deliverable, a PR. */
export function OpenRef({ open, children, title, data, className = "ref" }: { open: Openable; children: ReactNode; title: string; data: string; className?: string }) {
  const nav = useBbNavigate();
  const click = (e: MouseEvent) => {
    if (plainClick(e) && openInBb(nav, open)) e.preventDefault();
  };
  return open.url ? (
    <a className={className} href={open.url} target="_blank" rel="noopener noreferrer" data-ref={data} data-open-in-bb="" title={title} onClick={click}>
      {children}
    </a>
  ) : (
    // in a row beside a pill it gives way and ends in an ellipsis (2026-11-18: shadcn's Button never shrinks, so a long
    // deliverable title pushed the pill out of the Scope tab's status card; the ellipsis needs a block, not the flex button)
    <Button variant="link" className={cn(className, INLINE_LINK, "min-w-0 shrink justify-start")} data-ref={data} data-open-in-bb="" title={title} onClick={click}>
      <span className="min-w-0 truncate">{children}</span>
    </Button>
  );
}

/**
 * A section card (2026-11-17, the shadcn pass, in place of kit-ui's SectionCard): shadcn's Card, a head (icon, title,
 * count, a quiet note, things on the right) over its rows. Needs and Blocked carry their count as a solid or
 * destructive badge; nothing else takes a colour. An empty card is its head alone.
 */
function BookCard({ name, title, count, sub, tone, icon, right, empty, children }: { name: string; title: ReactNode; count?: number | null; sub?: string | null; tone?: "need" | "blocked"; icon?: IconName; right?: ReactNode; empty?: boolean; children?: ReactNode }) {
  const n = count !== undefined && count !== null;
  return (
    <Card className="k-card min-w-0 gap-0 overflow-hidden py-0" data-card-section={name} data-book-section={name} data-tone={tone} data-empty={empty ? "true" : "false"}>
      <CardHeader className={cn("flex min-h-10 items-center gap-2 px-4 py-1.5 [.border-b]:pb-1.5", !empty && "border-b")}>
        <CardTitle role="heading" aria-level={4} className={cn("flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-4", empty && "font-normal text-muted-foreground")}>
          {icon ? <Icon name={icon} /> : null}
          <span>{title}</span>
          {n && tone ? (
            <Badge variant={tone === "blocked" ? "destructive" : "default"} className="h-5 min-w-5 rounded-full px-1.5 tabular-nums">
              {count}
            </Badge>
          ) : n ? (
            <span className="font-normal text-muted-foreground tabular-nums">{count}</span>
          ) : null}
          {sub ? <span className="font-normal text-muted-foreground">{sub}</span> : null}
        </CardTitle>
        {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
      </CardHeader>
      {empty ? null : <CardContent className="flex min-w-0 flex-col px-2 pt-1 pb-2">{children}</CardContent>}
    </Card>
  );
}

/** "all 8 ›": the rest of a capped list. */
function AllButton({ n, open, onClick, ...data }: { n: number; open: boolean; onClick: () => void; [d: `data-${string}`]: string | undefined }) {
  return (
    <Btn tone="ghost" size="sm" className="h-7 gap-1 px-2 text-xs font-normal text-muted-foreground" aria-expanded={open} onClick={onClick} {...data}>
      {open ? "fewer" : `all ${n}`}
      <ChevronRight aria-hidden className={cn("size-3", open && "rotate-90")} />
    </Btn>
  );
}

const shortDay = (t: number) => new Date(t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
const stamp = (t: number) => new Date(t).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The goal, a step meter with "7 of 7 · the step", and on the right the status's age (amber when old) and Ask for status. */
function Goal({ p, now, askStatus }: { p: Project; now: number; askStatus: (() => void) | null }) {
  const s = p.status;
  const out = outOfDateLine(p);
  const stale = statusStale(p, now) && p.heldAt === null;
  const ask = askStatus ? (
    <Btn size="sm" data-ask-status={p.slug} onClick={askStatus}>
      Ask for status
    </Btn>
  ) : null;
  if (!s)
    return (
      <div className="k-goal" data-goal-row="">
        <div className="k-g muted" data-no-status="">
          {p.lead ? "No status from the lead yet" : "No lead"}
        </div>
        <div className="k-side">{ask}</div>
      </div>
    );
  const pos = position(s);
  return (
    <div className="k-goal" data-goal-row="">
      <div className="k-g">
        <div data-goal="">
          <RefText text={s.goal} />
        </div>
        {pos.total ? (
          <div className="k-step">
            <Steps at={pos.kind === "done" ? pos.total : pos.at} total={pos.total} />
            <span>
              {pos.at} of {pos.total}
              {pos.title && pos.kind !== "done" ? ` · ${pos.title}` : ""}
            </span>
          </div>
        ) : null}
      </div>
      <div className="k-side">
        {/* a stale or contradicted status is flagged, never drawn as current */}
        {out ? (
          <span data-status-outdated="" title={`${out}: a line it names is over, so that line is hidden`}>
            <Chip spec={{ tone: "warn", icon: "wait", word: "status out of date" }} />
          </span>
        ) : stale ? (
          <span data-status-stale="true" title="the lead hasn't said since">
            <Chip spec={{ tone: "warn", icon: "wait", word: `status ${age(s.updatedAt, now)} old` }} />
          </span>
        ) : (
          <span data-status-stale="false">
            <Age spec={ageSpec(s.updatedAt, now, "lead", Infinity)} />
          </span>
        )}
        {ask}
      </div>
    </div>
  );
}

// Light markdown in a lead's update (2026-11-17, "horribly formatted"): **bold**, `code` and [label](https://…); the rest
// of each run goes through RefText, so PR numbers and refs become the usual links and chips. Unmatched marks stay text.
const MD = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
function MdText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(MD)) {
    const [whole, code, bold, label, url] = m;
    if (m.index! > at) out.push(<RefText key={`t${at}`} text={text.slice(at, m.index)} />);
    if (code) out.push(<code key={m.index}>{code}</code>);
    else if (bold)
      out.push(
        <strong key={m.index}>
          <RefText text={bold} />
        </strong>,
      );
    else
      out.push(
        <OpenRef key={m.index} open={{ url: url! }} title={url!} data="url">
          {label}
        </OpenRef>,
      );
    at = m.index! + whole.length;
  }
  if (at < text.length) out.push(<RefText key={`t${at}`} text={text.slice(at)} />);
  return <>{out}</>;
}

/** A field at most `lines` lines tall (two by default), with "more" when the words run past them. */
function Clamped({ text, lines = 2, ...data }: { text: string; lines?: number; [d: `data-${string}`]: string | undefined }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOver(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <div className="k-clamp" data-clamped={open ? "false" : "true"} style={{ "--k-lines": lines } as CSSProperties} {...data}>
      <span className="k-txt" ref={ref}>
        <MdText text={text} />
      </span>
      {over || open ? (
        <Button variant="link" size="xs" className="h-6 px-0 text-xs text-muted-foreground" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "less" : "more"}
        </Button>
      ) : null}
    </div>
  );
}

/** Needs that says nothing: empty, "nothing", "none" or "n/a", drawn muted. */
const saysNothing = (s: string) => /^\s*(?:nothing|none|n\/a|-)?\s*[.!]?\s*$/i.test(s);

/** The Lead status card: the lead's last update (what it worked on, where it is, what it needs). None until the first.
 *  2026-11-17 (the shadcn pass): one Card, each part an Item under a muted label: a bulleted "Working on", one line for
 *  "Where it's at", and Needs as a muted Item led by a solid "Needs" badge, or a quiet "Needs nothing" badge. */
function LeadUpdate({ p, now }: { p: Project; now: number }) {
  const u = p.status?.update;
  if (!u) return null;
  const label = "m-0 text-xs font-semibold text-muted-foreground";
  return (
    <BookCard name="lead-update" title="Lead status" sub={`updated ${age(u.updateAt, now)} ago`}>
      <div className="k-update" data-lead-update="">
        <Item size="sm" className="flex-col items-stretch gap-1 px-2 py-1" data-update-sec="working">
          <h4 className={label}>Working on</h4>
          <ul>
            {u.workingOn.map((b, i) => (
              <li key={i}>
                <Clamped text={b} data-update-bullet="" />
              </li>
            ))}
          </ul>
        </Item>
        {u.at ? (
          <Item size="sm" className="flex-col items-stretch gap-1 px-2 py-1" data-update-sec="at">
            <h4 className={label}>Where it's at</h4>
            <Clamped text={u.at} lines={1} data-update-at="" />
          </Item>
        ) : null}
        {saysNothing(u.needs) ? (
          <div className="px-2" data-update-needs="" data-empty-needs="">
            <Badge variant="outline" className="font-normal text-muted-foreground">
              Needs nothing
            </Badge>
          </div>
        ) : (
          <Item variant="muted" size="sm" className="flex-col items-stretch gap-1.5 px-3 py-2" data-update-sec="needs" role="note">
            <Badge>Needs</Badge>
            <Clamped text={u.needs} data-update-needs="" />
          </Item>
        )}
      </div>
    </BookCard>
  );
}

function NeedRow({ l, now, cos, openCard }: { l: NeedLine; now: number; cos: string; openCard: OpenCard }) {
  if (l.kind === "wait") {
    const w = waitLine(l.wait, now, cos);
    return (
      <Item size="sm" className="k-row flex-nowrap" data-need="wait" data-wait-source={l.wait.source}>
        <span className="k-t" title={w.text}>
          {/* the card's head already says whom it needs: "you: " would say it twice */}
          <RefText text={w.text.replace(/^you: /, "")} exact={l.wait.ref} />
        </span>
        {l.noCard ? <Chip spec={{ tone: "quiet", icon: "quiet", word: "no card" }} /> : null}
        <Age spec={ageSpec(l.wait.since, now, l.wait.source, Infinity)} />
      </Item>
    );
  }
  const sel = l.kind === "card" ? `[data-card="${l.id}"]` : `[data-interaction="${l.threadId}"]`;
  return (
    <Item size="sm" className="k-row flex-nowrap" data-need={l.kind}>
      <span className="k-t" title={l.text}>
        {l.text}
      </span>
      <Btn tone="primary" size="sm" className="h-7" data-open-card={l.kind === "card" ? l.id : ""} onClick={() => openCard(sel)}>
        {l.kind === "card" ? "Answer" : "Open"}
      </Btn>
      <Age spec={ageSpec(l.since, now, "live", Infinity)} />
    </Item>
  );
}

/** The sections of one project. `top`: the direct line's notes, drawn between the Pinned strip and the goal. */
export function ProjectBook({
  project: p,
  lanes,
  now,
  cards,
  cos,
  ownerName,
  openCard,
  askStatus,
  top,
  pinning,
  setPinning,
  busy,
  refetchAll,
}: {
  project: Project;
  lanes: Lane[] | undefined;
  now: number;
  cards: NeedsYou["cards"];
  cos: string;
  ownerName: string;
  openCard: OpenCard;
  askStatus: (() => void) | null;
  top?: ReactNode;
  pinning: boolean;
  setPinning: (x: boolean) => void;
  busy: boolean;
  /** The page's reads, refetched after the thread cards' scoping switches (1.13.0); without it the cards draw no menu. */
  refetchAll?: () => void;
}) {
  const q = experimental_useRpcQuery({ contract: rpcContract, method: "projectBook", input: { slug: p.slug, dayStart: dayStart(now) } });
  const refetch = useRef(q.refetch);
  refetch.current = q.refetch;
  useChangeNotice(
    useCallback((n: unknown) => void (touches(n, "projectBook") && refetch.current()), []),
  );
  const reload = () => void refetch.current();
  const shared = useContext(RefsContext);
  const [allThreads, setAllThreads] = useState(false);
  const [allPrs, setAllPrs] = useState(false);
  const [allRecord, setAllRecord] = useState(false);
  const book: Book | undefined = q.data;
  const pins = book?.pins ?? [];
  const needs = needLines(p, lanes, cards);
  const blockers = blockerLines(p, book);
  const { rows: prs, loose } = prRows(p, lanes);
  const todayCount = mergedTodayCount(book, now);
  const live = (lanes ?? []).filter((l) => l.state !== "released");
  const working = live.filter((l) => l.state === "working").length;
  const loading = !book ? <div className="px-2 py-1 text-sm text-muted-foreground">{q.error ? `Couldn't read it: ${q.error.message}` : "Reading…"}</div> : null;
  const pinned = new Set(pins.map((x) => x.deliverable).filter(Boolean));
  const pinDeliverable = (id: string) => {
    const body: z.input<typeof pinBody> = { slug: p.slug, target: id };
    void write(WRITES.pin, body, { kind: "other", where: `pins:${p.slug}`, after: reload });
  };

  const needCard = needs.length ? (
    <BookCard name="needs" title={`Needs ${ownerName}`} count={needs.length} tone="need" icon="you">
      {needs.map((l, i) => (
        <NeedRow key={`${l.kind}|${i}`} l={l} now={now} cos={cos} openCard={openCard} />
      ))}
    </BookCard>
  ) : null;
  const blockedCard = blockers.length ? (
    <BookCard name="blocked" title="Blocked by" count={blockers.length} tone="blocked" icon="blocked">
      {blockers.map((b, i) => (
        <Item size="sm" key={`b${i}`} className="k-row flex-nowrap" data-blocker="">
          <span className="k-t" title={`Blocked by ${b.text}`}>
            <RefText text={b.text} />
          </span>
          {b.since ? (
            <span data-blocker-since={b.bound ? "at-least" : b.first ? "first-said" : "status"}>
              <Age spec={{ ...ageSpec(b.since, now, "lead", Infinity)!, text: `${b.bound ? ">" : ""}${age(b.since, now)}`, title: b.bound ? `for over ${age(b.since, now)} · lead said` : b.first ? `since ${age(b.since, now)} · lead said` : `lead said ${age(b.since, now)} ago` }} />
            </span>
          ) : null}
        </Item>
      ))}
    </BookCard>
  ) : null;
  // nothing for the owner and nothing blocking: one quiet head says both
  const clear = !needCard && !blockedCard ? <BookCard name="clear" title={`Nothing needs ${ownerName}`} sub="nothing blocks it" empty /> : null;

  const nowCard = (
    <BookCard
      name="now"
      title="Now"
      sub={live.length ? `${working} of ${live.length} working` : "no live lead or threads"}
      empty={!live.length}
      right={live.length > THREADS_SHOWN ? <AllButton n={live.length} open={allThreads} onClick={() => setAllThreads((x) => !x)} data-now-all={String(live.length)} /> : null}
    >
      <ThreadCards lanes={lanes} now={now} owner={ownerName} openCard={openCard} all={allThreads} ctl={refetchAll && p.archivedAt === null ? { slug: p.slug, mode: p.mode, tasks: p.tasks ?? [], busy, refetchAll } : undefined} />
    </BookCard>
  );
  const waitsCard = loose.length ? (
    <BookCard name="waits" title="Waiting on" count={loose.length}>
      {loose.map((w, i) => {
        const l = waitLine(w, now, cos);
        return (
          <Item size="sm" key={`${w.kind}|${w.ref ?? i}`} className="k-row flex-nowrap" data-wait-line={w.kind} data-wait-source={w.source}>
            <span className="k-lead">
              <Icon name="wait" />
            </span>
            <span className="k-t" title={`${l.text}${l.note ? ` (${l.note})` : ""}`}>
              <RefText text={l.text} exact={w.ref} />
              {l.note ? <b className="warn"> ({l.note})</b> : null}
            </span>
            <Age spec={ageSpec(w.since, now, w.source)} />
          </Item>
        );
      })}
    </BookCard>
  ) : null;
  const prsShown = allPrs ? prs : prs.slice(0, ROWS_SHOWN);
  const prCard = (
    <BookCard
      name="prs"
      title="PRs in flight"
      count={prs.length || null}
      sub={[prs.length ? "" : "none open", todayCount ? `${todayCount} merged today` : ""].filter(Boolean).join(" · ") || null}
      empty={!prs.length}
      right={prs.length > ROWS_SHOWN ? <AllButton n={prs.length} open={allPrs} onClick={() => setAllPrs((x) => !x)} data-prs-all={String(prs.length)} /> : null}
    >
      {prsShown.map((r) => (
        <Item size="sm" key={r.pr.url} className="k-row flex-nowrap" data-pr-line={r.pr.number} data-pr-wait={r.waits.map((w) => w.kind).join(" ")}>
          {/* what its waits say: the row's text when no thread names the PR, else on hover (the Blocked card often says it too) */}
          <span className="k-t" title={[`#${r.pr.number}${r.title ? ` ${r.title}` : ""}`, ...r.waits.map((w) => waitLine(w, now, cos).text)].join("\n")}>
            <OpenRef open={{ url: r.pr.url }} title={r.pr.url} data="pr" className="k-ref">
              #{r.pr.number}
            </OpenRef>
            {r.title ? <span className="q"> {r.title}</span> : r.waits.length ? <span className="q"> {waitLine(r.waits[0]!, now, cos).text}</span> : null}
          </span>
          {r.chips.map((c) => (
            <Chip key={c.word} spec={c} />
          ))}
          <Age spec={r.waits[0] ? ageSpec(r.waits[0].since, now, r.waits[0].source) : null} />
        </Item>
      ))}
    </BookCard>
  );
  // open PRs whose threads were resolved because someone else owns them now (orch_resolve handed_off); hidden when none
  const handed = p.handedOff ?? [];
  const handedCard = handed.length ? (
    <BookCard name="handed-off" title="Handed off" count={handed.length}>
      {handed.map((h) => (
        <Item size="sm" key={`${h.pr}|${h.at}`} className="k-row flex-nowrap" data-handed-off={h.pr}>
          <span className="k-t" title={[h.pr, `${h.owner} has it`, h.note ?? "", `from ${h.thread}`].filter(Boolean).join("\n")}>
            <OpenRef open={{ url: h.pr }} title={h.pr} data="pr" className="k-ref">
              #{h.pr.match(/\/pull\/(\d+)/)?.[1] ?? "PR"}
            </OpenRef>
            <span> {h.owner}</span>
            {h.note ? <span className="q"> · {h.note}</span> : null}
          </span>
          <Age spec={ageSpec(h.at, now, "live", Infinity)} />
        </Item>
      ))}
    </BookCard>
  ) : null;
  const recordAll = recordRows(book?.done ?? [], book?.decided ?? []);
  const recordShown = allRecord ? recordAll : recordAll.slice(0, ROWS_SHOWN);
  const recordCard = (
    <BookCard name="record" title="Record" count={book ? recordAll.length : null} right={recordAll.length > ROWS_SHOWN ? <AllButton n={recordAll.length} open={allRecord} onClick={() => setAllRecord((x) => !x)} /> : null}>
      {loading ??
        (recordShown.length
          ? recordShown.map((x, i) => {
              if (x.t === "decided") {
                const row = x.row;
                return (
                  <Item size="sm" key={`decided|${row.id}`} className="k-row flex-nowrap" data-decided={row.id} data-record-row="decided">
                    <span className="k-lead">
                      <Icon name="you" label="Decided" />
                    </span>
                    <span className="k-t" title={`${row.title} → ${row.answer}`}>
                      {shared?.cards.has(row.id) ? (
                        <OpenRef open={panel("board", `[data-decision="${row.id}"]`)} title="Open the answered card in Activity" data="card">
                          {row.title}
                        </OpenRef>
                      ) : (
                        row.title
                      )}
                    </span>
                    <Chip spec={{ tone: "quiet", icon: "you", word: row.answer }} />
                    <span className="k-when" title={stamp(row.at)}>
                      {shortDay(row.at)}
                    </span>
                  </Item>
                );
              }
              const row = x.row;
              return (
                <Item size="sm" key={`${row.kind}|${row.ref ?? i}`} className="k-row flex-nowrap" data-done-line={row.kind} data-record-row="done">
                  <span className="k-lead">
                    <Icon name={row.kind === "merged" ? "merged" : row.kind === "deliverable" ? "box" : "report"} label="Done" />
                  </span>
                  <span className="k-t" title={row.text}>
                    {row.kind === "deliverable" && row.ref && shared?.deliverables.has(row.ref) ? (
                      <OpenRef open={panel("deliverables", `[data-deliverable="${row.ref}"], [data-tree-key="d:${row.ref}"]`, row.ref)} title="Open in Deliverables" data="deliverable">
                        {row.text}
                      </OpenRef>
                    ) : row.kind === "merged" && row.ref ? (
                      <OpenRef open={{ url: row.ref }} title={row.ref} data="pr">
                        {row.text}
                      </OpenRef>
                    ) : (
                      <RefText text={row.text} />
                    )}
                  </span>
                  {row.kind === "deliverable" && row.state === "review" ? <Chip spec={{ tone: "info", icon: "eye", word: "your review" }} /> : null}
                  {row.kind === "deliverable" && row.ref && !pinned.has(row.ref) ? (
                    <Btn size="sm" className="h-7" data-pin-deliverable={row.ref} disabled={busy} title="Pin it under the message box" onClick={() => pinDeliverable(row.ref!)}>
                      <Icon name="pin" />
                      Pin
                    </Btn>
                  ) : null}
                  <Age spec={ageSpec(row.at, now, row.kind === "report" ? "thread" : "live", Infinity)} />
                </Item>
              );
            })
          : <div className="px-2 py-1 text-sm text-muted-foreground">Nothing done or decided yet</div>)}
    </BookCard>
  );

  const sections: Record<DetailSection, ReactNode> = { needs: needCard ?? clear, blocked: blockedCard, now: nowCard, waits: waitsCard, prs: (
      <>
        {prCard}
        {handedCard}
      </>
    ), record: recordCard };
  const place = (keys: readonly DetailSection[]) => keys.map((k) => <Fragment key={k}>{sections[k]}</Fragment>);
  return (
    <div className="k-detail" data-book={p.slug}>
      <PinStrip slug={p.slug} pins={pins} now={now} refetch={reload} busy={busy} adding={pinning} setAdding={setPinning} />
      {top}
      <Goal p={p} now={now} askStatus={askStatus} />
      <LeadUpdate p={p} now={now} />
      <div className="k-attn" data-attention="" data-one={needCard && blockedCard ? "false" : "true"}>
        {place(DETAIL_LAYOUT.attention)}
      </div>
      <div className="k-cols">
        <div className="k-col">{place(DETAIL_LAYOUT.left)}</div>
        <div className="k-col">{place(DETAIL_LAYOUT.right)}</div>
      </div>
    </div>
  );
}
