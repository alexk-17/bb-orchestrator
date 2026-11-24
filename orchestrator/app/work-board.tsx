// The work board in Projects (SCOPE piece 2; mockups where-1-projects, board-1-task, cols-6): every
// project's tasks in six columns, with a project filter. A card is a task the lead declares; its chips say what is
// attached. State is a column tint, a card tint and chips, never a coloured left edge or bar. A phone, or a pane too
// narrow for six columns, shows one column at a time under a picker with counts, and never scrolls sideways. Each
// project's Unfiled tray sits under the board, collapsed.
// The read (workBoard) is a database read; it refetches only on a change notice that touches what it reads
// (change-notice.ts READS.workBoard), after a pause, and not while the page is hidden.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_useRpcQuery, useRealtime } from "@get-bb/plugin-sdk/app";
import { BOARD_COLUMNS, CHANGED_CHANNEL, WRITES, rpcContract, type boardMoveBody, type BoardColumn, type BoardTask, type Deliverables, type NeedsYou, type Projects, type Scope, type WorkBoard } from "../contract.ts";
import { COLUMN_LABEL, whyText, chipsOf, columnsOf, firstColumn, movedByYou, unfiledCount, type BoardLens, type LensMove } from "./work-board-model.ts";
import { touches } from "../change-notice.ts";
import { KIND_TONES, css } from "./palette.ts";
import { useElementWidth } from "./panes.tsx";
import { useTouchPhone } from "./phone.ts";
import { styleHref } from "./style-href.ts";
import { useMinute } from "./status-bar.tsx";
import { Btn, Kind, PageError, ReadState, Tag, ago, cx } from "./ui.tsx";
import { gate, useGate, write } from "./store.ts";
import { startCardDrag } from "./work-board-drag.ts";
import type { z } from "zod";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card } from "./ui/card.tsx";
import { TaskPanel } from "./work-board-panel.tsx";

/** A change notice's refetch waits this long, so a burst of notices is one read. */
const BOARD_DEBOUNCE_MS = 800;
/** Six columns side by side need this much room; three by two need less; below that the board shows one at a time. */
export const SIX_COLUMNS_MIN = 6 * 140 + 5 * 8;
export const THREE_COLUMNS_MIN = 3 * 160 + 2 * 8;

// column tints (the mockups' cols-6): Waiting on you warm, Blocked red, Shipped green, the rest the page's wash. A
// card moved by hand is tinted blue; the selected card has a ring. No left edges anywhere.
const boardCss = /* css */ `
.wb { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.wb-top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.wb-chips { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.wb-cols { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; align-items: start; min-width: 0; }
.wb-col { border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 8px; min-width: 0; background: var(--orch-wash); }
.wb[data-layout="three"] .wb-cols { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.wb-col[data-column="waiting"] { background: color-mix(in srgb, var(--warning, ${css(KIND_TONES.deferred)}) 14%, transparent); }
.wb-col[data-column="blocked"] { background: color-mix(in srgb, var(--destructive, ${css(KIND_TONES.alarm)}) 10%, transparent); }
.wb-col[data-column="shipped"] { background: color-mix(in srgb, var(--success, ${css(KIND_TONES.approved)}) 12%, transparent); }
.wb-col-h { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 0 4px; font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted-foreground); }
.wb-card { cursor: pointer; min-width: 0; overflow-wrap: anywhere; touch-action: manipulation; user-select: none; }
.wb-card:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.wb-card.moved { background: color-mix(in srgb, ${css(KIND_TONES.link)} 8%, var(--card)); }
.wb-card.selected { box-shadow: 0 0 0 2px var(--ring); }
.wb-card .t { font-size: 14px; font-weight: 600; line-height: 20px; }
.wb-card .why { font-size: 12px; line-height: 16px; color: var(--muted-foreground); display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.wb-card .flag { align-self: flex-start; }
.wb-body { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; }
.wb-body > * { grid-area: 1 / 1; }
/* the open card's panel scrolls itself when it is long; otherwise a wheel over it scrolls the board (overscroll-behavior:
   contain kept the board still under a panel with nothing to scroll, half of a pane's width) */
.wb-side { justify-self: end; align-self: start; position: sticky; top: 8px; z-index: 2; width: min(400px, 100%); max-height: calc(100dvh - 140px); overflow-y: auto; padding: 16px; border-radius: 12px; background: var(--popover, var(--card)); color: var(--popover-foreground, var(--card-foreground)); border: 1px solid var(--border); box-shadow: 0 8px 24px color-mix(in srgb, var(--foreground) 14%, transparent); }
.wb-sheet { padding: 16px; border-radius: 12px; background: var(--card); border: 1px solid var(--border); box-shadow: 0 4px 16px color-mix(in srgb, var(--foreground) 10%, transparent); min-width: 0; }
.wb-card .drop { font-size: 12px; font-weight: 600; line-height: 16px; }
.wb-card .drop:empty { display: none; }
.wb-empty { font-size: 12px; color: var(--muted-foreground); padding: 4px; }
.wb-unfiled { display: flex; flex-direction: column; gap: 4px; }
.wb-unfiled ul { margin: 0; padding: 0 0 0 8px; list-style: none; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted-foreground); }
`;

/** The board's read at T (`since`; null: the read's 7-day default), with its own refetch: on a notice that touches it
 *  (after a pause, never while hidden), and on return to the page. A new T keeps the last board up until its read lands. */
export function useWorkBoard(since: number | null = null) {
  const q = experimental_useRpcQuery({ contract: rpcContract, method: "workBoard", input: { since, project: null } });
  const last = useRef<WorkBoard | undefined>(undefined);
  if (q.data) last.current = q.data;
  const refetch = useRef(q.refetch);
  refetch.current = q.refetch;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // a notice that came while the page was hidden: read once it is back
  const missed = useRef(false);
  const onNotice = useCallback((n: unknown) => {
    if (!touches(n, "workBoard")) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") missed.current = true;
      else void refetch.current();
    }, BOARD_DEBOUNCE_MS);
  }, []);
  useRealtime(CHANGED_CHANNEL, onNotice);
  useEffect(() => {
    const back = () => {
      if (document.visibilityState !== "visible" || !missed.current) return;
      missed.current = false;
      void refetch.current();
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      clearTimeout(timer.current);
    };
  }, []);
  return { ...q, data: q.data ?? last.current };
}

/** One card: its title, its project, what is attached, and the one line of why. */
function TaskCard({ t, now, selected, showProject, onOpen, lensChip }: { t: BoardTask; now: number; selected: boolean; showProject: boolean; onOpen: (id: string) => void; lensChip: ReactNode }) {
  const moved = movedByYou(t);
  return (
    // shadcn's Card as the button (the ui ratchet: no raw <button>); Enter or Space opens it, as a click does
    <Card
      role="button"
      tabIndex={0}
      className={cx("wb-card gap-1 rounded-md p-2 shadow-none", moved && "moved", selected && "selected")}
      data-task={t.id}
      data-column={t.column}
      data-moved={moved || undefined}
      aria-pressed={selected}
      onClick={() => onOpen(t.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onOpen(t.id);
      }}
    >
      {moved || lensChip ? (
        <span className="flag">
          {moved ? (
            <Kind of="link" group="link" data-hand-chip="">
              moved by you
            </Kind>
          ) : null}
          {lensChip}
        </span>
      ) : null}
      <span className="t">{t.title}</span>
      <span className="wb-chips" data-task-chips="">
        {showProject ? <Tag data-chip="project">{t.project}</Tag> : null}
        {chipsOf(t).map((c) =>
          c.group ? (
            <Kind key={c.key} of={c.group} group={c.group} data-chip={c.key}>
              {c.text}
            </Kind>
          ) : (
            <Tag key={c.key} data-chip={c.key}>
              {c.text}
            </Tag>
          ),
        )}
      </span>
      {/* the column a drag is over, written by the drag into this card only (work-board-drag.ts) */}
      <span className="drop" data-drop-label="" aria-hidden="true" />
      <span className="why" data-why="">
        {whyText(t.why)}
        {t.since && t.column !== "planned" ? ` · ${ago(t.since, now)}` : ""}
      </span>
    </Card>
  );
}

function Column({ column, tasks, now, selected, showProject, onOpen, chip, solo = false }: { column: BoardColumn; tasks: BoardTask[]; now: number; selected: string | null; showProject: boolean; onOpen: (id: string) => void; chip: (id: string) => ReactNode; solo?: boolean }) {
  return (
    <section className="wb-col" data-column={column} aria-label={COLUMN_LABEL[column]} data-solo={solo || undefined}>
      <h3 className="wb-col-h m-0">
        <span>{COLUMN_LABEL[column]}</span>
        <span className="tabular-nums">{tasks.length}</span>
      </h3>
      {tasks.map((t) => (
        <TaskCard key={t.id} t={t} now={now} selected={t.id === selected} showProject={showProject} onOpen={onOpen} lensChip={chip(t.id)} />
      ))}
      {tasks.length === 0 ? <p className="wb-empty m-0">Nothing here</p> : null}
    </section>
  );
}

/** A project's Unfiled tray: what no task holds yet, quiet and collapsed. */
function UnfiledTray({ p }: { p: WorkBoard["projects"][number] }) {
  const [open, setOpen] = useState(false);
  const n = unfiledCount(p.unfiled);
  if (!n) return null;
  const u = p.unfiled;
  return (
    <div className="wb-unfiled" data-unfiled={p.slug}>
      <Btn tone="ghost" size="sm" className="-ml-2 h-7 self-start px-2 text-xs font-normal text-muted-foreground" aria-expanded={open} data-unfiled-toggle={p.slug} onClick={() => setOpen((o) => !o)}>
        {p.slug} · Unfiled · {n}
        {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
      </Btn>
      {open ? (
        <ul>
          {u.threads.map((t) => (
            <li key={t.address}>
              {t.address} · {t.state}
            </li>
          ))}
          {u.prs.map((p) => (
            <li key={p.url}>
              {p.number ? `PR #${p.number}` : "a PR"} · {p.state ?? "unknown"}
            </li>
          ))}
          {u.deliverables.map((d) => (
            <li key={d.id}>
              deliverable {d.title} · {d.state}
            </li>
          ))}
          {u.cards.map((c) => (
            <li key={c.id}>
              card {c.title}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The panel's Move to: the six columns, the one it is in pressed; the phone's way to move a card. */
function MoveTo({ t, onMove }: { t: BoardTask; onMove: (to: BoardColumn) => void }) {
  useGate();
  return (
    <section className="flex flex-col gap-2" aria-label="Move to" data-move-to={t.id}>
      <h3 className="m-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Move to</h3>
      <div className="wb-chips" role="group" aria-label="Column">
        {BOARD_COLUMNS.map((c) => (
          <Btn key={c} size="sm" tone="outline" className={cx(c === t.column && "bg-accent font-semibold")} aria-pressed={c === t.column} disabled={c === t.column || gate.lock !== null} data-move={c} onClick={() => onMove(c)}>
            {COLUMN_LABEL[c]}
          </Btn>
        ))}
      </div>
      <p className="m-0 text-xs text-muted-foreground">Holds until something attached changes; the lead is told. A move merges and answers nothing.</p>
    </section>
  );
}

export type BoardPlace = { project: string | null; task: string | null };

/** The board, with its own read: mounted only while a pane shows it. */
/** What the card panel acts with: the page's reads (Needs you's cards, the deliverables, the projects' leads) and its refetch. */
export type PanelReads = { needs: NeedsYou | undefined; scope: Scope | undefined; deliverables: Deliverables | undefined; projects: Projects | undefined; refetchAll: () => void };

/** The since lens's seam (work board thread 3 mounts it): `since` draws the header in the board's top row and hands the
 *  lens back; `movedChip` draws a card's chip for its move since T. Without them the board reads with the 7-day default. */
export type SinceSlot = (project: string | null, onLens: (lens: BoardLens) => void) => ReactNode;
export type MovedChipSlot = (move: LensMove, now: number) => ReactNode;

export function BoardView({ place, onPlace, switcher, since, movedChip, reads }: { place: BoardPlace; onPlace: (p: BoardPlace, how?: "push" | "replace") => void; switcher: ReactNode; since?: SinceSlot; movedChip?: MovedChipSlot; reads: PanelReads }) {
  const [lens, setLens] = useState<BoardLens | null>(null);
  const q = useWorkBoard(lens?.since ?? null);
  const [width, root] = useElementWidth();
  const phone = useTouchPhone();
  const now = useMinute();
  const [picked, setPicked] = useState<BoardColumn | null>(null);
  // a phone's sheet opens under the column: bring it into sight once per task, when it is first drawn
  const sheetFor = useRef<string | null>(null);
  const sheet = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || sheetFor.current === place.task) return;
      sheetFor.current = place.task;
      el.scrollIntoView({ block: "start", behavior: "smooth" });
    },
    [place.task],
  );
  const board = q.data;
  const styles = (
    <style href={styleHref("orch-work-board", boardCss)} precedence="default">
      {boardCss}
    </style>
  );
  // the top row, at the same place while the board loads and after, so the since header keeps its state
  const top = (project: string | null) => (
    <div className="wb-top">
      {switcher}
      <div className="contents" data-board-since="">
        {since ? since(project, setLens) : null}
      </div>
      {/* a read that failed while a board is up (a new T, a refetch): the last board stays, with one quiet line */}
      {board && q.error ? (
        <span className="flex items-center gap-1 text-xs text-muted-foreground" role="status" data-board-stale="">
          Couldn't load
          <Btn tone="ghost" size="sm" className="h-6 px-2 text-xs" data-board-retry="" onClick={() => void q.refetch()}>
            Retry
          </Btn>
        </span>
      ) : null}
    </div>
  );
  if (!board)
    return (
      <div ref={root} className="wb" data-work-board="">
        {styles}
        {top(place.project)}
        <ReadState q={q} what="the board" />
      </div>
    );
  const slugs = board.projects.map((p) => p.slug);
  const project = place.project && slugs.includes(place.project) ? place.project : null;
  const cols = columnsOf(board, project, lens);
  const chip = (id: string): ReactNode => {
    const move = lens?.moved[id];
    return move && movedChip ? movedChip(move, now) : null;
  };
  const layout = phone || (width > 0 && width < THREE_COLUMNS_MIN) ? "one" : width > 0 && width < SIX_COLUMNS_MIN ? "three" : "six";
  const one = layout === "one";
  const shown = picked ?? firstColumn(cols);
  const open = (id: string) => onPlace({ project, task: place.task === id ? null : id });
  const showProject = project === null;
  const openTask = place.task ? board.projects.flatMap((p) => p.tasks).find((t) => t.id === place.task) ?? null : null;
  const after = () => {
    reads.refetchAll();
    void q.refetch();
  };
  // a hand move (piece 5): by drag on desktop, by Move to in the panel; the server writes only the task's hand move
  const moveTask = (task: string, to: BoardColumn) => {
    if (gate.lock) return;
    void write(WRITES.boardMove, { task, to } satisfies z.input<typeof boardMoveBody>, { kind: "other", where: "work-board", after });
  };
  const panel = openTask ? (
    <TaskPanel
      key={openTask.id}
      t={openTask}
      now={now}
      needs={reads.needs}
      scope={reads.scope}
      deliverables={reads.deliverables}
      projects={reads.projects}
      after={after}
      onClose={() => onPlace({ project, task: null })}
      move={<MoveTo t={openTask} onMove={(to) => moveTask(openTask.id, to)} />}
    />
  ) : null;
  const trays = board.projects.filter((p) => (!project || p.slug === project) && unfiledCount(p.unfiled) > 0);
  return (
    <div ref={root} className="wb" data-work-board="" data-layout={layout} data-board-project={project ?? "all"}>
      {styles}
      {top(project)}
      <PageError where="work-board" />
      <div className="wb-chips" role="group" aria-label="Project" data-board-filter="">
        <Btn tone={project === null ? "primary" : "outline"} size="sm" aria-pressed={project === null} data-board-project-pick="all" onClick={() => onPlace({ project: null, task: null }, "replace")}>
          All projects
        </Btn>
        {slugs.map((s) => (
          <Btn key={s} tone={project === s ? "primary" : "outline"} size="sm" aria-pressed={project === s} data-board-project-pick={s} onClick={() => onPlace({ project: s, task: null }, "replace")}>
            {s}
          </Btn>
        ))}
      </div>
      {one ? (
        <>
          <div className="wb-chips" role="group" aria-label="Column" data-board-columns="">
            {cols.map((c) => (
              <Btn key={c.column} tone={c.column === shown ? "primary" : "outline"} size="sm" aria-pressed={c.column === shown} data-board-column-pick={c.column} onClick={() => setPicked(c.column)}>
                {COLUMN_LABEL[c.column]} <span className="tabular-nums opacity-70">{c.tasks.length}</span>
              </Btn>
            ))}
          </div>
          <Column solo column={shown} tasks={cols.find((c) => c.column === shown)!.tasks} now={now} selected={place.task} showProject={showProject} onOpen={open} chip={chip} />
          {/* a phone's sheet: under the column it was opened from */}
          {panel ? (
            <div ref={sheet} className="wb-sheet" data-panel-sheet="">
              {panel}
            </div>
          ) : null}
        </>
      ) : (
        <div className="wb-body">
          <div className="wb-cols" data-board-cols="" onPointerDown={(e) => startCardDrag(e, moveTask)}>
            {cols.map((c) => (
              <Column key={c.column} column={c.column} tasks={c.tasks} now={now} selected={place.task} showProject={showProject} onOpen={open} chip={chip} />
            ))}
          </div>
          {/* beside the board, over its right-hand columns, and in sight while the board scrolls */}
          {panel ? (
            <aside className="wb-side" data-panel-side="">
              {panel}
            </aside>
          ) : null}
        </div>
      )}
      {trays.length ? (
        <div className="flex flex-col gap-1" data-unfiled-trays="">
          {trays.map((p) => (
            <UnfiledTray key={p.slug} p={p} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

