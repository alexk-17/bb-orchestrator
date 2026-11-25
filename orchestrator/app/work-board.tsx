import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { experimental_useRpcQuery, useRealtime } from "@get-bb/plugin-sdk/app";
import { BOARD_COLUMNS, CHANGED_CHANNEL, WRITES, rpcContract, type boardMoveBody, type BoardColumn, type BoardTask, type Deliverables, type NeedsYou, type Projects, type Scope, type WorkBoard } from "../contract.ts";
import { COLUMN_LABEL, whyText, chipsOf, columnAfterPick, columnsOf, firstColumn, movedByYou, unfiledCount, type BoardLens, type LensMove } from "./work-board-model.ts";
import { touches } from "../change-notice.ts";
import { KIND_TONES, css, type Tone } from "./palette.ts";
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
import { Badge } from "./ui/badge.tsx";
import { boardTones, toneVars } from "./project-colour.ts";
import { boardRows, drawnFolds, useFolded } from "./board-fold.ts";

const BOARD_DEBOUNCE_MS = 800;
export const SIX_COLUMNS_MIN = 6 * 140 + 5 * 8;
export const THREE_COLUMNS_MIN = 3 * 160 + 2 * 8;

const boardCss = /* css */ `
.wb { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.wb-top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.wb-chips { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.wb-cols { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.wb-col { border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 8px; min-width: 0; background: var(--orch-wash); }
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
.wb-side { justify-self: end; align-self: start; position: sticky; top: 8px; z-index: 2; width: min(400px, 100%); max-height: calc(100dvh - 140px); overflow-y: auto; padding: 16px; border-radius: 12px; background: var(--popover, var(--card)); color: var(--popover-foreground, var(--card-foreground)); border: 1px solid var(--border); box-shadow: 0 8px 24px color-mix(in srgb, var(--foreground) 14%, transparent); }
.wb-sheet { padding: 16px; border-radius: 12px; background: var(--card); border: 1px solid var(--border); box-shadow: 0 4px 16px color-mix(in srgb, var(--foreground) 10%, transparent); min-width: 0; }
.wb-card .drop { font-size: 12px; font-weight: 600; line-height: 16px; }
.wb-card .drop:empty { display: none; }
.wb-empty { font-size: 12px; color: var(--muted-foreground); padding: 4px; }
.wb-unfiled { display: flex; flex-direction: column; gap: 4px; }
.wb-unfiled ul { margin: 0; padding: 0 0 0 8px; list-style: none; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted-foreground); }
`;

const toneCss = /* css */ `
.wb-proj[data-tone] { background: var(--wb-tone); color: var(--background); font-weight: 600; }
.wb-card:where([data-tone]) { background: color-mix(in srgb, var(--wb-tone) 5%, var(--card)); }
.wb-pick[data-tone]::before { content: ""; width: 8px; height: 8px; border-radius: 9999px; background: var(--wb-tone); flex-shrink: 0; }
.wb-pick[data-tone][aria-pressed="true"] { background: var(--wb-tone); color: var(--background); border-color: var(--wb-tone); }
.wb-pick[data-tone][aria-pressed="true"]::before { background: var(--background); }
`;

const headCss = /* css */ `
.wb-head { position: sticky; top: 0; z-index: 3; display: flex; flex-direction: column; gap: 8px; min-width: 0; margin-top: -8px; padding: 8px 0; background: var(--background); }
.wb[data-layout="one"] .wb-head { display: contents; }
.wb[data-layout="one"] .wb-top { position: sticky; top: 0; z-index: 3; margin-top: -8px; padding: 8px 0; background: var(--background); }
.wb .wb-side { top: calc(var(--wb-head-h, 0px) + 8px); max-height: calc(100dvh - 140px - var(--wb-head-h, 0px)); }
`;

const foldCss = /* css */ `
.wb-row { display: flex; gap: 8px; align-items: flex-start; min-width: 0; }
.wb-row > .wb-col { flex: 1 1 0; }
.wb-col[data-folded] { flex: 0 0 auto; }
.wb-col-h.fold { padding: 0; }
.wb-col-h .wb-fold { width: 100%; height: auto; min-height: 24px; justify-content: space-between; gap: 6px; padding: 2px 4px; font: inherit; letter-spacing: inherit; text-transform: inherit; color: inherit; }
.wb-col-h .wb-fold > span { display: inline-flex; align-items: center; gap: 4px; }
.wb-col-h .wb-fold svg { width: 14px; height: 14px; }
`;

function useHeadHeight() {
  const ro = useRef<ResizeObserver | null>(null);
  return useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    ro.current = null;
    const board = el?.parentElement;
    if (!el || !board) return;
    ro.current = new ResizeObserver(([e]) => board.style.setProperty("--wb-head-h", `${Math.round(e!.borderBoxSize[0]?.blockSize ?? el.offsetHeight)}px`));
    ro.current.observe(el);
  }, []);
}

export function useWorkBoard(since: number | null = null) {
  const q = experimental_useRpcQuery({ contract: rpcContract, method: "workBoard", input: { since, project: null } });
  const last = useRef<WorkBoard | undefined>(undefined);
  if (q.data) last.current = q.data;
  const refetch = useRef(q.refetch);
  refetch.current = q.refetch;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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

function TaskCard({ t, now, selected, tone, onOpen, lensChip }: { t: BoardTask; now: number; selected: boolean; tone: Tone | undefined; onOpen: (id: string) => void; lensChip: ReactNode }) {
  const moved = movedByYou(t);
  return (
    <Card
      role="button"
      tabIndex={0}
      className={cx("wb-card gap-1 rounded-md p-2 shadow-none", moved && "moved", selected && "selected")}
      data-task={t.id}
      data-column={t.column}
      data-moved={moved || undefined}
      data-tone={tone ? "" : undefined}
      style={toneVars(tone)}
      aria-pressed={selected}
      onClick={() => onOpen(t.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onOpen(t.id);
      }}
    >
      <span className="wb-chips flag" data-card-top="">
        <Badge variant="secondary" className="wb-proj" data-chip="project" data-tone={tone ? "" : undefined}>
          {t.project}
        </Badge>
        {moved ? (
          <Kind of="link" group="link" data-hand-chip="">
            moved by you
          </Kind>
        ) : null}
        {lensChip}
      </span>
      <span className="t">{t.title}</span>
      <span className="wb-chips" data-task-chips="">
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
      <span className="drop" data-drop-label="" aria-hidden="true" />
      <span className="why" data-why="">
        {whyText(t.why)}
        {t.since && t.column !== "planned" ? ` · ${ago(t.since, now)}` : ""}
      </span>
    </Card>
  );
}

function Column({ column, tasks, now, selected, tones, onOpen, chip, solo = false, folded = false, onFold }: { column: BoardColumn; tasks: BoardTask[]; now: number; selected: string | null; tones: Map<string, Tone> | null; onOpen: (id: string) => void; chip: (id: string) => ReactNode; solo?: boolean; folded?: boolean; onFold?: (c: BoardColumn) => void }) {
  const label = COLUMN_LABEL[column];
  return (
    <section className="wb-col" data-column={column} aria-label={label} data-solo={solo || undefined} data-folded={folded || undefined}>
      {onFold ? (
        <h3 className="wb-col-h fold m-0">
          <Btn tone="ghost" size="sm" className="wb-fold" aria-expanded={!folded} title={folded ? `Show ${label}` : `Fold ${label}`} data-column-fold={column} onClick={() => onFold(column)}>
            <span>
              {folded ? <ChevronRight aria-hidden /> : <ChevronDown aria-hidden />}
              {label}
            </span>
            <span className="tabular-nums">{tasks.length}</span>
          </Btn>
        </h3>
      ) : (
        <h3 className="wb-col-h m-0">
          <span>{label}</span>
          <span className="tabular-nums">{tasks.length}</span>
        </h3>
      )}
      {folded ? null : tasks.map((t) => (
        <TaskCard key={t.id} t={t} now={now} selected={t.id === selected} tone={tones?.get(t.project)} onOpen={onOpen} lensChip={chip(t.id)} />
      ))}
      {!folded && tasks.length === 0 ? <p className="wb-empty m-0">Nothing here</p> : null}
    </section>
  );
}

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

export type PanelReads = { needs: NeedsYou | undefined; scope: Scope | undefined; deliverables: Deliverables | undefined; projects: Projects | undefined; refetchAll: () => void };

export type BoardShown = { since: number; ids: ReadonlySet<string> };
export type SinceSlot = (project: string | null, onLens: (lens: BoardLens) => void, shown: BoardShown | null) => ReactNode;
export type MovedChipSlot = (move: LensMove, now: number) => ReactNode;

export function BoardView({ place, onPlace, switcher, since, movedChip, reads }: { place: BoardPlace; onPlace: (p: BoardPlace, how?: "push" | "replace") => void; switcher: ReactNode; since?: SinceSlot; movedChip?: MovedChipSlot; reads: PanelReads }) {
  const [lens, setLens] = useState<BoardLens | null>(null);
  const q = useWorkBoard(lens?.since ?? null);
  const [width, root] = useElementWidth();
  const head = useHeadHeight();
  const { folded, toggle } = useFolded(place.project);
  const phone = useTouchPhone();
  const now = useMinute();
  const [picked, setPicked] = useState<BoardColumn | null>(null);
  const [pickWas, setPickWas] = useState<string | null>(null);
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
  const onBoard = useMemo(() => (board ? { since: board.since, ids: new Set(board.projects.flatMap((p) => p.tasks.map((t) => t.id))) } : null), [board]);
  const styles = (
    <>
      <style href={styleHref("orch-work-board", boardCss)} precedence="default">
        {boardCss}
      </style>
      <style href={styleHref("orch-work-board-tone", toneCss)} precedence="default">
        {toneCss}
      </style>
      <style href={styleHref("orch-work-board-head", headCss)} precedence="default">
        {headCss}
      </style>
      <style href={styleHref("orch-work-board-fold", foldCss)} precedence="default">
        {foldCss}
      </style>
    </>
  );
  const top = (project: string | null) => (
    <div className="wb-top">
      {switcher}
      <div className="contents" data-board-since="">
        {since ? since(project, setLens, onBoard) : null}
      </div>
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
        <div ref={head} className="wb-head" data-board-head="">
          {top(place.project)}
        </div>
        <ReadState q={q} what="the board" />
      </div>
    );
  const slugs = board.projects.map((p) => p.slug);
  const project = place.project && slugs.includes(place.project) ? place.project : null;
  const cols = columnsOf(board, project, lens);
  const pickNow = lens?.pick ? `${lens.pick.key}:${lens.pick.ids.join(",")}` : null;
  if (pickNow !== pickWas) {
    setPickWas(pickNow);
    setPicked(columnAfterPick(picked, cols));
  }
  const drawn = drawnFolds(folded, cols, !!lens?.pick);
  const chip = (id: string): ReactNode => {
    const move = lens?.moved[id];
    return move && movedChip ? movedChip(move, now) : null;
  };
  const layout = phone || (width > 0 && width < THREE_COLUMNS_MIN) ? "one" : width > 0 && width < SIX_COLUMNS_MIN ? "three" : "six";
  const one = layout === "one";
  const shown = picked ?? firstColumn(cols);
  const open = (id: string) => onPlace({ project, task: place.task === id ? null : id });
  const tones = reads.projects ? boardTones([...reads.projects, ...board.projects]) : null;
  const openTask = place.task ? board.projects.flatMap((p) => p.tasks).find((t) => t.id === place.task) ?? null : null;
  const after = () => {
    reads.refetchAll();
    void q.refetch();
  };
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
      <div ref={head} className="wb-head" data-board-head="">
        {top(project)}
        <div className="wb-chips" role="group" aria-label="Project" data-board-filter="">
          <Btn tone={project === null ? "primary" : "outline"} size="sm" aria-pressed={project === null} data-board-project-pick="all" onClick={() => onPlace({ project: null, task: null }, "replace")}>
            All projects
          </Btn>
          {slugs.map((s) => {
            const tone = tones?.get(s);
            return (
              <Btn key={s} tone={project === s ? "primary" : "outline"} size="sm" className="wb-pick" style={toneVars(tone)} data-tone={tone ? "" : undefined} aria-pressed={project === s} data-board-project-pick={s} onClick={() => onPlace({ project: s, task: null }, "replace")}>
                {s}
              </Btn>
            );
          })}
        </div>
      </div>
      <PageError where="work-board" />
      {one ? (
        <>
          <div className="wb-chips" role="group" aria-label="Column" data-board-columns="">
            {cols.map((c) => (
              <Btn key={c.column} tone={c.column === shown ? "primary" : "outline"} size="sm" aria-pressed={c.column === shown} data-board-column-pick={c.column} onClick={() => setPicked(c.column)}>
                {COLUMN_LABEL[c.column]} <span className="tabular-nums opacity-70">{c.tasks.length}</span>
              </Btn>
            ))}
          </div>
          <Column solo column={shown} tasks={cols.find((c) => c.column === shown)!.tasks} now={now} selected={place.task} tones={tones} onOpen={open} chip={chip} />
          {panel ? (
            <div ref={sheet} className="wb-sheet" data-panel-sheet="">
              {panel}
            </div>
          ) : null}
        </>
      ) : (
        <div className="wb-body">
          <div className="wb-cols" data-board-cols="" onPointerDown={(e) => startCardDrag(e, moveTask)}>
            {boardRows(cols, layout === "six" ? "six" : "three").map((row) => (
              <div key={row[0]!.column} className="wb-row" data-board-row="">
                {row.map((c) => (
                  <Column key={c.column} column={c.column} tasks={c.tasks} now={now} selected={place.task} tones={tones} onOpen={open} chip={chip} folded={drawn.has(c.column)} onFold={lens?.pick && c.tasks.length ? undefined : toggle} />
                ))}
              </div>
            ))}
          </div>
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

