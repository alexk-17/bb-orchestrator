import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_useRpcQuery, useRealtime } from "@get-bb/plugin-sdk/app";
import { ChevronDown, Info } from "lucide-react";
import { WRITES, rpcContract, type BoardColumn, type BoardSince as Strip } from "../contract.ts";
import { fileThemText, parseChoice, sinceOf, SINCE_MAX_MS, typedSince, WEEKDAY, type SinceChoice, type SinceMove, type SincePick } from "../core/since.ts";
import { KIND_TONES, css } from "./palette.ts";
import { styleHref } from "./style-href.ts";
import { pillsOf, type Pill } from "./since-pills.ts";
import type { BoardShown } from "./work-board.tsx";
import { touches } from "../change-notice.ts";
import { useChangeNotice } from "./change-listener.ts";
import { storage } from "./column-widths.ts";
import { write } from "./store.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Input } from "./ui/input.tsx";
import { Button } from "./ui/button.tsx";
import { cx } from "./ui.tsx";

export interface Lens {
  since: number | null;
  moved: Record<string, SinceMove>;
  onlyMoved: boolean;
  pick: { key: SincePick; ids: string[] } | null;
}

const SINCE_CHANNEL = "board-since";
const CHOICE_KEY = "orch.boardSince.choice";
const ONLY_KEY = "orch.boardSince.onlyMoved";
const REFETCH_MS = 1_500;
const TYPED_MS = 700;

const COLUMN_NAMES: Record<BoardColumn | "dropped", string> = { planned: "Planned", in_progress: "In progress", in_review: "In review", waiting: "Waiting on you", blocked: "Blocked", shipped: "Shipped", dropped: "Dropped" };
const COUNTED = "A task changing column, a new task, a task dropped with something attached (under dropped only: it has no card), a merge, release or approval, a card now waiting on you.";
const NOT_COUNTED =
  "Plan edits (quiet drops: a task dropped with nothing attached, even one added since), the CoS's tidy records, thread status flips (about 5,000 in a weekend), leads' answers to their own threads, notices (imports, mon evolutions, handovers), acks, dream runs.";
const whoseText = (w: Strip["whose"]) =>
  w.by === "tasked" ? "Only PRs a task holds: no GitHub login is set (githubLogin) or known to gh." : `PRs @${w.login} merged${w.by === "gh" ? " (gh's signed-in login)" : ""}, and PRs a task holds.`;

function load<T>(key: string, parse: (raw: unknown) => T, fallback: T): T {
  try {
    const raw = storage()?.getItem(key);
    return raw ? parse(JSON.parse(raw)) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(v));
  } catch {
    // blocked storage: this visit only
  }
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
export function shortWhen(at: number, now: number): string {
  const d = new Date(at);
  return now - at < 6 * 86_400_000 ? `${DAYS[d.getDay()]} ${hm(d)}` : `${d.getDate()} ${d.toLocaleString("en", { month: "short" })} ${hm(d)}`;
}
const shortDay = (at: number, now: number) => shortWhen(at, now).replace(/ \d\d:\d\d$/, "");
const hours = (ms: number) => (ms < 48 * 3_600_000 ? `${Math.max(1, Math.round(ms / 3_600_000))} h` : `${Math.round(ms / 86_400_000)} d`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const localInput = (at: number) => {
  const d = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

const pillCss = /* css */ `
.wb-pill[data-pill="waiting"] { background: color-mix(in srgb, var(--warning, ${css(KIND_TONES.deferred)}) 14%, transparent); }
.wb-pill[data-pill="blocked"] { background: color-mix(in srgb, var(--destructive, ${css(KIND_TONES.alarm)}) 10%, transparent); }
.wb-pill[data-pill="shipped"] { background: color-mix(in srgb, var(--success, ${css(KIND_TONES.approved)}) 12%, transparent); }
.wb-pill[aria-pressed="true"] { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); }
.wb-pill[data-zero] { opacity: 0.5; }
`;

const pillButton = (p: Pill, on = false) => ({
  variant: "outline" as const,
  size: "xs" as const,
  className: "wb-pill rounded-full font-normal",
  "data-pill": p.key,
  "data-zero": p.n === 0 || undefined,
  "aria-pressed": p.does === "filter" ? on : undefined,
  disabled: p.n === 0 && !on,
  title: p.title,
  children: (
    <>
      <b className="font-semibold tabular-nums">{p.n}</b>
      {p.text}
    </>
  ),
});

export function MovedChip({ move, now }: { move: SinceMove | undefined; now: number }) {
  if (!move) return null;
  const day = shortDay(move.at, now);
  const text = move.isNew ? "new" : move.to === "shipped" ? `shipped ${day}` : `moved ${day}`;
  const path = `${move.from ? COLUMN_NAMES[move.from] : "New"} → ${COLUMN_NAMES[move.to]}, ${shortWhen(move.at, now)}`;
  return (
    <span data-moved-chip className="inline-flex h-5 items-center rounded-sm bg-primary/10 px-1.5 text-xs font-semibold text-primary" title={path} aria-label={path}>
      {text}
    </span>
  );
}

function Choice({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="ghost" size="sm" role="menuitemradio" aria-checked={on} onClick={onClick} className={cx("w-full justify-start rounded-sm px-2 text-left", on ? "bg-accent font-semibold" : "font-normal")}>
      {children}
    </Button>
  );
}

export function BoardSince({ project, onLens, shown }: { project: string | null; onLens?: (lens: Lens) => void; shown?: BoardShown | null }) {
  const [choice, setChoice] = useState<SinceChoice>(() => load(CHOICE_KEY, parseChoice, { kind: "weekday" }));
  const [onlyMoved, setOnlyMoved] = useState<boolean>(() => load(ONLY_KEY, (v) => v === true, false));
  const [open, setOpen] = useState(false);
  const [pill, setPill] = useState<SincePick | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  const since = choice.kind === "looked" ? null : sinceOf(choice, now, null);
  const q = experimental_useRpcQuery({ contract: rpcContract, method: "boardSince", input: { since, project } });
  const data: Strip | undefined = q.data;
  const refetch = useRef(q.refetch);
  refetch.current = q.refetch;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const soon = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void refetch.current();
    }, REFETCH_MS);
  }, []);
  const typed = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      clearTimeout(typed.current);
    },
    [],
  );
  useChangeNotice(useCallback((n: unknown) => void (touches(n, "boardSince") && soon()), [soon]));
  useRealtime(SINCE_CHANNEL, soon);

  useEffect(() => {
    onLens?.({ since: data?.since ?? since, moved: data?.moved ?? {}, onlyMoved, pick: pill && data ? { key: pill, ids: data.picks[pill] } : null });
  }, [data, since, onlyMoved, pill, onLens]);

  const pick = (c: SinceChoice) => {
    clearTimeout(typed.current);
    setChoice(c);
    save(CHOICE_KEY, c);
    setSent(null);
    if (c.kind !== "at") setOpen(false);
  };
  const toggleOnly = () => {
    setOnlyMoved((v) => {
      save(ONLY_KEY, !v);
      return !v;
    });
  };
  const fileThem = async () => {
    if (!data?.noTask.length) return;
    const out = await write(WRITES.cosMessage, { text: fileThemText(data.noTask, data.since) }, { kind: "other", where: "board-since", after: () => {} });
    if (out) setSent(out.ok ? "sent to the CoS" : out.message);
  };

  const T = data?.since ?? since;
  const label =
    choice.kind === "24h" ? "Last 24 h" : choice.kind === "weekday" ? `Since ${WEEKDAY.label}` : choice.kind === "looked" ? `Since I last looked${T ? ` (${shortWhen(T, now)})` : ""}` : `Since ${shortWhen(T ?? now, now)}`;
  const gh = data?.github;
  const when = T !== null ? shortWhen(T, now) : "T";
  // status flips refetch the board, never the strip: the pills follow the board read at the same T
  const pills = data ? pillsOf(data, when, shown && shown.since === data.since ? shown.ids : null) : [];
  const toggle = (k: SincePick) => setPill((v) => (v === k ? null : k));
  const ago = (at: number) => shortWhen(at, now);

  return (
    <>
      <style href={styleHref("orch-board-since-pills", pillCss)} precedence="default">
        {pillCss}
      </style>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" data-since-picker className="h-8 gap-1 px-2 font-semibold" aria-haspopup="menu">
            {label}
            {T !== null && <span className="font-normal text-muted-foreground">· {hours(now - T)}</span>}
            <ChevronDown className="size-3 text-muted-foreground" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1" role="menu">
          <Choice on={choice.kind === "24h"} onClick={() => pick({ kind: "24h" })}>Last 24 h</Choice>
          <Choice on={choice.kind === "weekday"} onClick={() => pick({ kind: "weekday" })}>Since {WEEKDAY.label}</Choice>
          <Choice on={choice.kind === "looked"} onClick={() => pick({ kind: "looked" })}>
            Since I last looked{data?.looked ? ` (${shortWhen(data.looked, now)})` : ""}
          </Choice>
          <Choice on={choice.kind === "at"} onClick={() => pick({ kind: "at", at: choice.kind === "at" ? choice.at : (T ?? now - 86_400_000) })}>Pick a time…</Choice>
          {choice.kind === "at" && (
            <div className="px-2 py-1">
              <Input
                type="datetime-local"
                aria-label="Since"
                className="h-8 text-sm"
                defaultValue={localInput(choice.at)}
                min={localInput(now - SINCE_MAX_MS)}
                max={localInput(now)}
                onChange={(e) => {
                  clearTimeout(typed.current);
                  const at = typedSince((e.target as HTMLInputElement).value, Date.now());
                  if (at !== null) typed.current = setTimeout(() => pick({ kind: "at", at }), TYPED_MS);
                }}
              />
            </div>
          )}
          <div className="my-1 border-t" />
          <div className="px-2 pb-1 text-xs text-muted-foreground">Saved per viewer</div>
        </PopoverContent>
      </Popover>
      <Button variant="ghost" size="sm" role="switch" aria-checked={onlyMoved} data-only-moved onClick={toggleOnly} className="h-8 gap-2 px-1 font-normal hover:bg-transparent">
        <span className={cx("relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors", onlyMoved ? "bg-primary" : "bg-muted-foreground/30")}>
          <span className={cx("absolute top-0.5 left-0 size-3 rounded-full bg-background transition-transform", onlyMoved ? "translate-x-3.5" : "translate-x-0.5")} />
        </span>
        Only cards that moved
      </Button>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="What counts" data-what-counts className="text-muted-foreground">
            <Info aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="flex w-80 max-w-[calc(100vw-32px)] flex-col gap-1 p-3 text-xs" data-rules>
          <div>
            <span className="font-semibold">Counted.</span> {COUNTED}
          </div>
          <div>
            <span className="font-semibold">Not counted.</span> {NOT_COUNTED}
          </div>
          {data && (
            <div data-whose>
              <span className="font-semibold">Merges.</span> {whoseText(data.whose)}
            </div>
          )}
        </PopoverContent>
      </Popover>
      <div data-since-counts className="flex min-w-0 basis-full flex-wrap items-center gap-1.5" role="group" aria-label={`What changed since ${when}`}>
        {data ? (
          pills.map((p) =>
            p.does === "filter" ? (
              <Button key={p.key} {...pillButton(p, pill === p.key)} onClick={() => toggle(p.key as SincePick)} />
            ) : (
              <Popover key={p.key}>
                <PopoverTrigger asChild>
                  <Button {...pillButton(p)} aria-haspopup="dialog" />
                </PopoverTrigger>
                <PopoverContent align="start" className="flex w-80 max-w-[calc(100vw-32px)] flex-col gap-1 p-2 text-sm" data-pill-list={p.key}>
                  {p.key === "dropped" &&
                    data.dropped.map((t) => (
                      <div key={t.id} className="flex min-w-0 items-baseline gap-2 px-1 py-0.5">
                        <span className="min-w-0 [overflow-wrap:anywhere]">{t.title}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{t.project}</span>
                      </div>
                    ))}
                  {p.key === "releases" &&
                    data.releases.map((r) => (
                      <a key={r.url + r.tag} href={r.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-baseline gap-2 rounded-sm px-1 py-0.5 hover:bg-accent">
                        <span className="font-semibold">{r.name || r.tag}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{ago(r.at)}</span>
                      </a>
                    ))}
                  {(p.key === "noTask" || p.key === "merged") && (
                    <>
                      <div className="px-1 text-xs text-muted-foreground">Merged since {when}, on no task</div>
                      {data.noTask.map((m) => (
                        <a key={m.url} href={m.url} target="_blank" rel="noreferrer" data-no-task-pr={m.number ?? ""} className="flex min-w-0 items-baseline gap-2 rounded-sm px-1 py-0.5 hover:bg-accent">
                          <span className="shrink-0 font-semibold tabular-nums">{m.number ? `#${m.number}` : "PR"}</span>
                          <span className="min-w-0 [overflow-wrap:anywhere]">{m.title || m.url}</span>
                          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{ago(m.mergedAt)}</span>
                        </a>
                      ))}
                      <div className="mt-1 flex items-center gap-2 border-t px-1 pt-2 text-xs">
                        {sent ? (
                          <span className="text-muted-foreground">{sent}</span>
                        ) : (
                          <Button variant="outline" size="xs" data-file-them onClick={() => void fileThem()}>
                            Ask the CoS to file them
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </PopoverContent>
              </Popover>
            ),
          )
        ) : (
          <span className="text-xs text-muted-foreground">{q.error ? "Couldn't read what moved." : "Reading…"}</span>
        )}
        {gh && (gh.at === null || gh.errors.length > 0) && (
          <span className="text-xs text-muted-foreground" title={gh.errors.join("\n")}>
            {gh.at === null ? "GitHub not read yet" : `GitHub read failed for ${plural(gh.errors.length, "repo")}`}
          </span>
        )}
        {gh && gh.at !== null && gh.pending > 0 && (
          <span data-since-pending className="text-xs text-muted-foreground" title={`${plural(gh.pending, "repo")} of ${gh.repos} wait their turn: GitHub is read for at most 50 repos every 10 minutes`}>
            some repos not refreshed yet
          </span>
        )}
      </div>
    </>
  );
}
