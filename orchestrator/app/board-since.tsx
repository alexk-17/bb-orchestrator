// The work board's since-T lens (2026-11-23, SCOPE piece 6; mockup since-1-picker): a since picker, one
// short strip of counts, an "only cards that moved" toggle, the "What counts" rules behind a small info toggle, and the
// merges no task holds with "file them". No banner. The board (its header slot) renders <BoardSince> and gets the lens
// back through onLens: T, each moved task's from and to, and the toggle. Cards render <MovedChip>. The picker's choice
// and the toggle are saved per viewer (localStorage).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_useRpcQuery, useRealtime } from "@get-bb/plugin-sdk/app";
import { ChevronDown, Info } from "lucide-react";
import { WRITES, rpcContract, type BoardColumn, type BoardSince as Strip } from "../contract.ts";
import { fileThemText, parseChoice, sinceOf, SINCE_MAX_MS, typedSince, WEEKDAY, type SinceChoice, type SinceMove } from "../core/since.ts";
import { touches } from "../change-notice.ts";
import { useChangeNotice } from "./change-listener.ts";
import { storage } from "./column-widths.ts";
import { write } from "./store.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Input } from "./ui/input.tsx";
import { Button } from "./ui/button.tsx";
import { cx } from "./ui.tsx";

/** What the board takes from the lens. `since` is null until the first read resolves "since I last looked". */
export interface Lens {
  since: number | null;
  moved: Record<string, SinceMove>;
  onlyMoved: boolean;
}

const SINCE_CHANNEL = "board-since"; // board-since.ts publishes it when a GitHub read changes the cache
const CHOICE_KEY = "orch.boardSince.choice";
const ONLY_KEY = "orch.boardSince.onlyMoved";
const REFETCH_MS = 1_500;
/** A typed time is taken once the typing pauses this long, so each keystroke in the date field doesn't re-read the board. */
const TYPED_MS = 700;

const COLUMN_NAMES: Record<BoardColumn | "dropped", string> = { planned: "Planned", in_progress: "In progress", in_review: "In review", waiting: "Waiting on you", blocked: "Blocked", shipped: "Shipped", dropped: "Dropped" };
const COUNTED = "A task changing column, a new task, a task dropped with something attached, a merge, release or approval, a card now waiting on you.";
const NOT_COUNTED =
  "Plan edits (a task dropped with nothing attached, or added and dropped again), the CoS's tidy records, thread status flips (about 5,000 in a weekend), leads' answers to their own threads, notices (imports, mon evolutions, handovers), acks, dream runs.";
/** Whose merges counted (core/since.ts whoseMerges), in the words of What counts. */
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
/** "Sat 11:30" within the week, else "20 Nov 11:30". */
export function shortWhen(at: number, now: number): string {
  const d = new Date(at);
  return now - at < 6 * 86_400_000 ? `${DAYS[d.getDay()]} ${hm(d)}` : `${d.getDate()} ${d.toLocaleString("en", { month: "short" })} ${hm(d)}`;
}
const shortDay = (at: number, now: number) => shortWhen(at, now).replace(/ \d\d:\d\d$/, "");
const hours = (ms: number) => (ms < 48 * 3_600_000 ? `${Math.max(1, Math.round(ms / 3_600_000))} h` : `${Math.round(ms / 86_400_000)} d`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A datetime-local value for `at`, local time. */
const localInput = (at: number) => {
  const d = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

/** The chip on a card that moved since T: "new", "shipped Sat" or "moved Sat", with from → to in its title. */
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

/** The picker, the strip and the toggle. `project`: the board's filter (null: all projects). */
export function BoardSince({ project, onLens }: { project: string | null; onLens?: (lens: Lens) => void }) {
  const [choice, setChoice] = useState<SinceChoice>(() => load(CHOICE_KEY, parseChoice, { kind: "weekday" }));
  const [onlyMoved, setOnlyMoved] = useState<boolean>(() => load(ONLY_KEY, (v) => v === true, false));
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  // the clock the presets read, a minute at a time (sinceOf steps "Last 24 h" in 15 minutes, so the input holds still)
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
  // only a change to what the lens reads (change-notice.ts READS.boardSince): a move, a PR link, a merge, an approval
  useChangeNotice(useCallback((n: unknown) => void (touches(n, "boardSince") && soon()), [soon]));
  useRealtime(SINCE_CHANNEL, soon);

  useEffect(() => {
    onLens?.({ since: data?.since ?? since, moved: data?.moved ?? {}, onlyMoved });
  }, [data, since, onlyMoved, onLens]);

  const pick = (c: SinceChoice) => {
    clearTimeout(typed.current); // a preset chosen while a typed time waits wins
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
  const c = data?.counts;
  const relCount = data?.releases.length ?? 0;
  const gh = data?.github;

  return (
    <div data-board-since className="flex min-w-0 flex-col gap-1 rounded-lg border bg-card p-3 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" data-since-picker className="h-7 gap-1 px-2 font-semibold" aria-haspopup="menu">
              {label}
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
        {T !== null && <span className="text-muted-foreground">{hours(now - T)}</span>}
      </div>
      <div data-since-counts className="min-w-0">
        {c ? (
          <>
            <b className="font-semibold">{c.shipped}</b> {c.shipped === 1 ? "task" : "tasks"} shipped · <b className="font-semibold">{c.new}</b> new · <b className="font-semibold">{c.waiting}</b> now {c.waiting === 1 ? "waits" : "wait"} on you · <b className="font-semibold">{c.blocked}</b> became blocked · <b className="font-semibold">{c.dropped}</b> dropped
          </>
        ) : (
          <span className="text-muted-foreground">{q.error ? "Couldn't read what moved." : "Reading…"}</span>
        )}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <Button variant="ghost" size="sm" role="switch" aria-checked={onlyMoved} data-only-moved onClick={toggleOnly} className="h-7 gap-2 px-0 font-normal hover:bg-transparent">
          <span className={cx("relative inline-block h-4 w-7 rounded-full transition-colors", onlyMoved ? "bg-primary" : "bg-muted-foreground/30")}>
            <span className={cx("absolute top-0.5 left-0 size-3 rounded-full bg-background transition-transform", onlyMoved ? "translate-x-3.5" : "translate-x-0.5")} />
          </span>
          Only cards that moved
        </Button>
        <Button variant="ghost" size="xs" aria-expanded={rules} data-what-counts onClick={() => setRules((v) => !v)} className="font-normal text-muted-foreground">
          <Info className="size-3" aria-hidden />
          What counts
        </Button>
      </div>
      {rules && (
        <div data-rules className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/50 p-2 text-xs">
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
        </div>
      )}
      {data && (
        <div data-since-merges className="min-w-0 text-xs [overflow-wrap:anywhere]">
          {plural(data.merged, "PR")} merged · {plural(relCount, "release")} · {data.approved} approved
          {data.noTask.length > 0 && (
            <>
              {" · on no task: "}
              {data.noTask.map((m) => (
                <a key={m.url} href={m.url} target="_blank" rel="noreferrer" className="mr-1 inline-flex h-5 items-center rounded-sm bg-muted px-1 font-semibold text-foreground" title={m.title || m.url}>
                  {m.number ? `#${m.number}` : "PR"}
                </a>
              ))}
              {"· "}
              {sent ? (
                <span className="text-muted-foreground">{sent}</span>
              ) : (
                <Button variant="link" size="xs" data-file-them className="h-auto p-0 text-xs font-normal" onClick={() => void fileThem()}>
                  file them
                </Button>
              )}
            </>
          )}
          {gh && (gh.at === null || gh.errors.length > 0) && (
            <span className="ml-1 text-muted-foreground" title={gh.errors.join("\n")}>
              {gh.at === null ? "· GitHub not read yet" : `· GitHub read failed for ${plural(gh.errors.length, "repo")}`}
            </span>
          )}
          {gh && gh.at !== null && gh.pending > 0 && (
            <span data-since-pending className="ml-1 text-muted-foreground" title={`${plural(gh.pending, "repo")} of ${gh.repos} wait their turn: GitHub is read for at most 50 repos every 10 minutes`}>
              · some repos not refreshed yet
            </span>
          )}
        </div>
      )}
    </div>
  );
}

