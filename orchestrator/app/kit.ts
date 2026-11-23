// The Projects tab's components, as data (2026-11-17, the approved grading: thread orchestrator:40's mockups, picked as
// "All five + pinned documents"). No JSX, so node --test checks what the components draw:
// - the state chip's one vocabulary: an icon, a word and a tone for a project's state, a PR's state, CI when it isn't
//   green, and an age with its source; never colour alone;
// - the list row: one state chip, the one number that matters, the status's age;
// - the thread card's order: what waits on the owner, then what works, then the rest receding; five shown;
// - the detail layout: Needs | Blocked first, then Now | PRs + Record; each PR once, its wait folded into its row;
// - a pin's "updated" words.
import type { Deliverables, ProjectBook, Projects, Scope, SummaryWait } from "../contract.ts";
import { blockersOf, stateOf, statusStale, type RowState } from "./command-center.ts";
import { age, type Lane } from "./lanes.ts";
import { fold, otherWaits, prsInFlight } from "./source.ts";

type Project = Projects[number];
type ProjectPr = NonNullable<Project["prs"]>[number];

export type Tone = "need" | "blocked" | "warn" | "good" | "info" | "quiet";
export type IconName =
  | "you" | "blocked" | "wait" | "moving" | "quiet" | "held" | "nolead" | "pr" | "check" | "x" | "draft" | "eye" | "merged"
  | "doc" | "page" | "link" | "box" | "report" | "pin" | "unpin" | "more" | "said" | "live" | "plus" | "chev" | "copy" | "open" | "scope";

/** One chip: never a colour alone, always an icon and a word. */
export interface ChipSpec {
  tone: Tone;
  icon: IconName;
  word: string;
}

/**
 * A project's own state, without "needs you": what waits on the owner is a number beside it, not a state. "scoping"
 * (1.11.0): the owner and its lead are still settling what it is, in the Scope tab.
 */
export type ProjectState = Exclude<RowState, "you"> | "scoping";
export const STATE_CHIP: Record<ProjectState, ChipSpec> = {
  blocked: { tone: "blocked", icon: "blocked", word: "Blocked" },
  moving: { tone: "good", icon: "moving", word: "Moving" },
  waiting: { tone: "warn", icon: "wait", word: "Waiting" },
  quiet: { tone: "quiet", icon: "quiet", word: "Quiet" },
  held: { tone: "quiet", icon: "held", word: "On hold" },
  nolead: { tone: "quiet", icon: "nolead", word: "No lead" },
  scoping: { tone: "info", icon: "scope", word: "Scoping" },
};

/** The project's state as motion: blocked when the lead says so, else moving while a lane works, else waiting. */
export function projectState(p: Project, lanes: Lane[] | undefined): ProjectState {
  // scoping says what the project is for now, over its motion; a hold still wins (nothing moves while held)
  if (p.mode === "scoping" && p.heldAt === null) return "scoping";
  const st = stateOf(p, lanes);
  if (st !== "you") return st;
  if (blockersOf(p).length) return "blocked";
  if (p.heldAt !== null) return "held";
  return (lanes ?? []).some((l) => l.state === "working") ? "moving" : "waiting";
}

/** What waits on the owner in a project: its open cards and its agents' own prompts. */
export const needCount = (p: Project, lanes: Lane[] | undefined) => (p.summary?.needsYou.count ?? 0) + (lanes ?? []).filter((l) => l.state === "waiting" && l.wait?.on === "owner" && !l.wait.cardId).length;

type PrLike = { state: string | null; attention: string | null; checks: string | null; review?: string | null };

/** A PR's state as one chip, then CI as a second only when it isn't green ("CI passing" is the normal case: unsaid). */
export function prChips(pr: PrLike): ChipSpec[] {
  const out: ChipSpec[] = [];
  const a = pr.attention ?? "";
  const r = pr.review ?? "";
  if (pr.state === "merged") out.push({ tone: "quiet", icon: "merged", word: "merged" });
  else if (pr.state === "closed") out.push({ tone: "quiet", icon: "x", word: "closed" });
  else if (a === "ready_to_merge") out.push({ tone: "good", icon: "check", word: "ready to merge" });
  else if (a === "conflicts") out.push({ tone: "blocked", icon: "x", word: "conflicts" });
  // blocked outranks a review's approval: a PR that can't merge must never read green. An open PR still missing its
  // approval reads "in review" on either of GitHub's words for it, as its notice does, for the owner (2026-11-17)
  else if (a === "blocked" && !(pr.state === "open" && (r === "review_required" || r === "review_requested"))) out.push({ tone: "blocked", icon: "blocked", word: "blocked" });
  else if (r === "changes_requested") out.push({ tone: "warn", icon: "eye", word: "changes asked" });
  else if (pr.state === "draft") out.push({ tone: "quiet", icon: "draft", word: "draft" });
  else if (r === "approved") out.push({ tone: "good", icon: "check", word: "approved" });
  else if (r === "review_required" || r === "review_requested" || a === "review_requested") out.push({ tone: "info", icon: "eye", word: "in review" });
  else out.push({ tone: "quiet", icon: "pr", word: "open" });
  const live = pr.state === "open" || pr.state === "draft";
  if (live && (pr.checks === "failing" || a === "checks_failed")) out.push({ tone: "blocked", icon: "x", word: "CI failing" });
  else if (live && pr.checks === "pending") out.push({ tone: "warn", icon: "wait", word: "CI running" });
  return out;
}

/** An age with its source: "6h" and a mark for live, the lead's word or a thread's report. Old turns it amber. */
export interface AgeSpec {
  text: string;
  source: "live" | "lead" | "thread" | null;
  old: boolean;
  title: string;
}
const SOURCE_WORD = { live: "live", lead: "lead said", thread: "thread said" } as const;
export const OLD_MS = 4 * 3_600_000;
export function ageSpec(since: number | null, now: number, source: AgeSpec["source"], oldAfter = OLD_MS): AgeSpec | null {
  const a = age(since, now);
  if (!a && !source) return null;
  const old = since !== null && now - since > oldAfter;
  return { text: a ?? "now", source, old, title: [a ? (old ? `unchanged ${a}` : a) : null, source ? SOURCE_WORD[source] : null].filter(Boolean).join(" · ") };
}

// ---------------------------------------------------------------- the list row

export interface ListRowSpec {
  state: ProjectState;
  chip: ChipSpec;
  /** the one number that matters, as a chip: for you, else blocked (when the state doesn't already say it), waits, PRs */
  number: ChipSpec | null;
  working: string | null;
  age: { text: string; old: boolean; title: string };
  quiet: boolean;
}

/** `scoping`: what waits in the project's scoping children beyond needCount (scopeExtra), counted in its "N for you" too. */
export function listRow(p: Project, lanes: Lane[] | undefined, now: number, quiet: boolean, scoping = 0): ListRowSpec {
  const state = projectState(p, lanes);
  const needs = needCount(p, lanes) + scoping;
  const blocked = blockersOf(p).length;
  const waits = p.summary?.waits.length ?? 0;
  const prs = prsInFlight(p).length;
  const number: ChipSpec | null = needs
    ? { tone: "need", icon: "you", word: `${needs} for you` }
    : blocked && state !== "blocked"
      ? { tone: "blocked", icon: "blocked", word: `${blocked} blocked` }
      : waits
        ? { tone: "quiet", icon: "wait", word: `${waits} ${waits === 1 ? "wait" : "waits"}` }
        : prs
          ? { tone: "quiet", icon: "pr", word: `${prs} ${prs === 1 ? "PR" : "PRs"}` }
          : null;
  const t = p.summary?.threads;
  const s = p.status;
  const out = !!p.summary?.statusOutOfDate;
  const stale = statusStale(p, now) && p.heldAt === null;
  const a = s ? age(s.updatedAt, now) : null;
  const ageOut = s
    ? { text: a ?? "now", old: out || stale, title: `lead said ${a ?? "now"}${a ? " ago" : ""}${out ? " · status out of date" : stale ? " · status old" : ""}` }
    : { text: p.lead ? "no status" : "no lead", old: false, title: p.lead ? "no status from the lead yet" : "no lead" };
  return { state, chip: STATE_CHIP[state], number, working: t && t.total ? `${t.working} of ${t.total} working` : null, age: ageOut, quiet };
}

// ---------------------------------------------------------------- the detail layout

/**
 * Where each section sits. What needs the owner and what blocks come first, side by side, so the answer is in the first
 * row; then what is happening (Now, the waits) beside the PRs and the record (Done | Decided). One column below 1200 px
 * keeps the same order.
 */
export const DETAIL_LAYOUT = {
  attention: ["needs", "blocked"],
  left: ["now", "waits"],
  right: ["prs", "record"],
} as const;
export type DetailSection = (typeof DETAIL_LAYOUT)[keyof typeof DETAIL_LAYOUT][number];
export type RecordRow = { t: "done"; at: number; row: ProjectBook["done"][number] } | { t: "decided"; at: number; row: ProjectBook["decided"][number] };
/** The book's record: what got done and what the owner decided, one list, newest first, each row tagged (no Done | Decided switch). */
export function recordRows(done: ProjectBook["done"], decided: ProjectBook["decided"]): RecordRow[] {
  return [...done.map((row) => ({ t: "done" as const, at: row.at, row })), ...decided.map((row) => ({ t: "decided" as const, at: row.at, row }))].sort((a, b) => b.at - a.at);
}

/** Reading order (one column, and screen readers on the wide one). */
export const detailOrder = (): DetailSection[] => [...DETAIL_LAYOUT.attention, ...DETAIL_LAYOUT.left, ...DETAIL_LAYOUT.right];

/** One PR row: the PR, its title from its thread, its chips, and every wait the lead or a live read names on it (oldest first). */
export interface PrRow {
  pr: ProjectPr;
  title: string | null;
  chips: ChipSpec[];
  waits: SummaryWait[];
}

const TICKET = /^t-\d+\s·\s/;
/** A lane's activity as a title: the ticket prefix goes (it is said on the card's second line). */
export const titleOf = (activity: string | null) => (activity ?? "").replace(TICKET, "") || null;
export const ticketOf = (activity: string | null) => TICKET.exec(activity ?? "")?.[0].replace(/\s·\s$/, "") ?? null;

/**
 * The PRs in flight, each once: every wait that names a shown PR (by its URL) folds into that PR's row, so a PR is never
 * also a "waiting on" line; the row keeps what the waits say (project-book.tsx draws it). Ready to merge first, drafts last. `loose`: the waits outside the owner that name no shown PR.
 */
export function prRows(p: Project, lanes: Lane[] | undefined): { rows: PrRow[]; loose: SummaryWait[] } {
  const prs = prsInFlight(p);
  const urls = new Set(prs.map((x) => x.url));
  const waits = otherWaits(p);
  const byUrl = new Map<string, SummaryWait[]>();
  for (const w of waits) if (w.ref && urls.has(w.ref)) byUrl.set(w.ref, [...(byUrl.get(w.ref) ?? []), w]);
  const oldest = (ws: SummaryWait[]) => [...ws].sort((x, y) => (x.since ?? Infinity) - (y.since ?? Infinity));
  const titles = new Map((lanes ?? []).filter((l) => l.agent.pr?.url).map((l) => [l.agent.pr!.url!, titleOf(l.activity)] as const));
  const order = (x: ProjectPr) => (x.attention === "ready_to_merge" ? 0 : x.state === "draft" ? 2 : 1);
  const rows = [...prs].sort((a, b) => order(a) - order(b) || b.number - a.number).map((pr) => ({ pr, title: titles.get(pr.url) ?? null, chips: prChips(pr), waits: oldest(byUrl.get(pr.url) ?? []) }));
  const folded = new Set([...byUrl.values()].flat());
  return { rows, loose: waits.filter((w) => !folded.has(w)) };
}

// ---------------------------------------------------------------- the thread card

export const THREADS_SHOWN = 5;
export const ROWS_SHOWN = 5;
const IDLE_LONG_MS = 24 * 3_600_000;

export interface ThreadSpec {
  lane: Lane;
  /** idle, nothing for the owner, no PR to merge: drawn lighter */
  rest: boolean;
  chip: ChipSpec;
}

const readyToMerge = (l: Lane) => l.agent.pr?.attention === "ready_to_merge" && (l.agent.pr.state === "open" || l.agent.pr.state === "draft");

/** The lane's state as a chip (a lane waiting on the owner gets the owner's chip, drawn by the card as a button). */
export function laneChip(l: Lane, now: number, owner: string): ChipSpec {
  const a = age(l.since, now);
  if (l.state === "waiting") return { tone: "need", icon: "you", word: a ? `${owner} · ${a}` : owner };
  if (l.state === "working") return { tone: "good", icon: "moving", word: "working" };
  if (l.state === "blocked") return { tone: "blocked", icon: "blocked", word: "blocked" };
  if (l.state === "released") return { tone: "quiet", icon: "quiet", word: "released" };
  const long = l.since !== null && now - l.since > IDLE_LONG_MS;
  return { tone: long ? "warn" : "quiet", icon: long ? "wait" : "quiet", word: a ? `idle ${a}` : "idle" };
}

/** Waiting on the owner, then blocked, then working, then the lead, then a PR to merge, then the rest, longest idle last. */
export function threadCards(lanes: Lane[] | undefined, now: number, owner: string): ThreadSpec[] {
  const live = (lanes ?? []).filter((l) => l.state !== "released");
  const rank = (l: Lane) =>
    l.state === "waiting" ? 0 : l.state === "blocked" ? 1 : l.state === "working" ? 2 : l.agent.role === "lead" ? 3 : readyToMerge(l) ? 4 : 5 + (l.since === null ? 0 : (now - l.since) / 1e12);
  return [...live]
    .sort((a, b) => rank(a) - rank(b))
    .map((lane) => ({ lane, rest: lane.state === "idle" && !readyToMerge(lane) && lane.agent.role !== "lead", chip: laneChip(lane, now, owner) }));
}

// ---------------------------------------------------------------- pins

export const PINS_SHOWN = 4;
/** A pin's second line: "updated 3d ago", a deliverable's "rev 2 · 6h ago", or that the file is gone. */
export function pinWhen(p: { kind: string; updatedAt: number | null; rev: number | null; missing: boolean }, now: number): string {
  if (p.missing) return p.kind === "file" ? "file not found" : "not found";
  const a = age(p.updatedAt, now);
  const when = a ? `${a} ago` : "just now";
  if (p.kind === "deliverable") return `rev ${p.rev ?? 1} · ${when}`;
  if (p.kind === "link") return `pinned ${when}`;
  return `updated ${when}`;
}

// ---------------------------------------------------------------- the Scope tab's list (1.12.0)
// One entry per project scoping as a whole and one per open scoping task, grouped project > task. Each card belongs to
// exactly one entry, so no card shows twice and none goes missing.

type ScopeProject = Scope["projects"][number];
type Planner = NonNullable<NonNullable<ScopeProject["tasks"]>[number]["planner"]>;
export interface ScopeEntry {
  key: string;
  slug: string;
  task: { id: string; name: string } | null;
  /** The task's live scoping thread (1.13.0); none for the whole project, or while the lead plans the task itself. */
  planner?: Planner | null;
}
export const scopeKey = (slug: string, task: string | null) => (task ? `${slug}/${task}` : slug);

/** Per project, its whole-project entry first (an older plugin process sends no whole: every project then scopes as a whole), then its open tasks, oldest first. */
export function scopeEntries(projects: ScopeProject[]): ScopeEntry[] {
  return projects.flatMap((p) => [
    ...(p.whole !== false ? [{ key: p.slug, slug: p.slug, task: null }] : []),
    ...(p.tasks ?? []).map((t) => ({ key: scopeKey(p.slug, t.id), slug: p.slug, task: { id: t.id, name: t.name }, planner: t.planner ?? null })),
  ]);
}

/** An agent's state in the planner line: what the owner reads, not the engine's word. */
const PLANNER_STATE: Record<string, string> = { active: "working", idle: "idle", error: "stuck on an error", unknown: "starting" };

/**
 * Who plans a Scope entry (1.13.0), as its list row and its header say it: the lead (the whole project, or a task with
 * no live scoping thread), or the task's scoping thread, by its title and address, and whether it is working. The
 * owner reads this to know whose chat to watch; the lead's inbox names the same planner (engine taskPlanner).
 */
export function plannerOf(e: ScopeEntry): { kind: "lead"; text: string } | { kind: "thread"; text: string; name: string; address: string; threadId: string; state: string } {
  const p = e.planner;
  if (!p) return { kind: "lead", text: "Planned by the lead" };
  const name = p.title ?? p.address;
  const state = PLANNER_STATE[p.status] ?? p.status;
  return { kind: "thread", text: `Planned by ${name}${p.title ? ` (${p.address})` : ""} · ${state}`, name, address: p.address, threadId: p.threadId, state };
}

/** Whether something filed under `scopeTask` shows in the entry for `task`: the task's own, or the whole project's (under no open task). */
export function inScopeEntry(p: ScopeProject, task: string | null, scopeTask: string | null | undefined): boolean {
  if (task) return scopeTask === task;
  return !scopeTask || !(p.tasks ?? []).some((t) => t.id === scopeTask);
}

/** The entry a card of `p` shows in: where a link to it opens the Scope tab. */
export function scopeEntryOf(p: ScopeProject, scopeTask: string | null | undefined): string {
  return scopeKey(p.slug, scopeTask && (p.tasks ?? []).some((t) => t.id === scopeTask) ? scopeTask : null);
}

/**
 * The entry header's one line on what happens next (1.13.0), so the owner never has to work out the flow: answer the
 * "Scoping done?" card when it is there, else the open cards, else nothing waits and the lead brings questions here.
 * 2026-11-17: while nothing waits, the line is the status card's Next, not the header's.
 */
export function scopeNext(e: ScopeEntry, o: { cards: readonly { title: string; scopingDone?: unknown }[]; delivered: number; hasLead: boolean }): string {
  if (!o.hasLead) return `No lead is running for ${e.slug}: start it from Projects, and its chat opens here.`;
  const done = o.cards.find((c) => !!c.scopingDone);
  if (done) return e.task ? `Next: answer ${JSON.stringify(done.title)}. Yes closes this task; anything still open under it goes the normal way.` : `Next: answer ${JSON.stringify(done.title)}. Yes makes ${e.slug} active; its cards go the normal way from then on.`;
  const filesDone = e.task ? `the lead files "Scoping done?" when the findings and plan are written` : `the lead files "Scoping done?" when the goal, constraints and first plan are in PROJECT.md`;
  if (o.cards.length || o.delivered) return `Next: ${o.cards.length ? "answer the cards" : "review what was handed over"}; ${filesDone}.`;
  // nothing waits (2026-11-17): the entry's status card says who is on it, so this line only says what comes next
  return `Questions appear here; the lead proposes "Scoping done?" when it's ready.`;
}

// ---------------------------------------------------------------- the Scope entry's status card (2026-11-17)
// The owner asked for a better Scope entry while nothing waits on them: an empty cards column left most of a wide pane
// blank. Then one small card takes its place (who is scoping and whether they are working, what they are on now, what
// is done so far, what comes next) and the chat takes the rest of the width. With anything waiting the entry is as before.

/** Nothing in the entry waits on the owner (no open card, no scoping deliverable to review): it shows its status card, not its cards. */
export const scopeQuiet = (o: { cards: number; delivered: number }): boolean => o.cards === 0 && o.delivered === 0;

type ProjectRow = Projects[number];
export interface ScopeStatus {
  /** Who scopes the entry: its scoping thread, else the lead. idleSince: when it went idle, while it is. */
  who: { kind: "lead" | "thread"; name: string; address: string | null; working: boolean; state: string; idleSince: number | null };
  /**
   * What it is on now, in its own words: a scoping thread's last report; the lead's status update (its first bullet) or
   * its current step, whichever it published last. Never the lead's line for a thread's task: the lead's status covers
   * the whole project, and under the task it would read as the thread's. None before its first.
   */
  now: { text: string; from: "report" | "update" | "step"; at: number } | null;
}

export function scopeStatus(e: ScopeEntry, p: Pick<ProjectRow, "slug" | "lead" | "status" | "summary"> | undefined): ScopeStatus {
  const t = e.planner;
  if (t) {
    const working = t.status === "active";
    return {
      who: { kind: "thread", name: t.title ?? t.address, address: t.address, working, state: PLANNER_STATE[t.status] ?? t.status, idleSince: t.status === "idle" ? (t.idleAt ?? null) : null },
      now: t.report ? { text: t.report.text, from: "report", at: t.report.at } : null,
    };
  }
  const lead = p?.lead ?? null;
  const st = p?.status ?? null;
  const u = st?.update?.workingOn[0] ? { text: st.update.workingOn[0], from: "update" as const, at: st.update.updateAt } : null;
  const i = st ? st.steps.findIndex((s) => s.state === "current") : -1;
  const step = st && i >= 0 ? { text: `Step ${i + 1} of ${st.steps.length}: ${st.steps[i]!.title}`, from: "step" as const, at: st.updatedAt } : null;
  return {
    who: {
      kind: "lead",
      name: "The lead",
      address: lead?.address ?? null,
      working: lead?.status === "active",
      state: lead ? (PLANNER_STATE[lead.status] ?? lead.status) : "not running",
      idleSince: lead?.status === "idle" ? (p?.summary?.leadIdleSince ?? null) : null,
    },
    // the one it wrote last; on a tie (one orch_status with both) the update, which is written for the owner
    now: u && step ? (step.at > u.at ? step : u) : (u ?? step),
  };
}

/** What the entry's planning has handed over and the owner has already looked at: its scoping deliverables approved or sent back for changes, newest first. */
export function scopeDone<D extends { project: string | null; state: string; scope?: boolean; scopeTask?: string; updatedAt: number }>(all: readonly D[], p: ScopeProject, task: string | null): D[] {
  return all.filter((d) => d.project === p.slug && !!d.scope && (d.state === "approved" || d.state === "changes") && inScopeEntry(p, task, d.scopeTask)).sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------------------------------------------------------------- the owner's scoping switches (1.13.0)
// Direct owner actions in the Projects view, with no card and no model step: the lead's row (and the project's ⋯ menu)
// switches the whole project, as orch_project_mode does; a thread's row makes it a task's scoping thread, or stops it.

/** A scoping task's name, as the engine caps it (SCOPING_TASK_NAME_MAX). */
export const TASK_NAME_MAX = 60;

export type ScopeAction =
  | { kind: "project"; mode: "scoping" | "active"; label: "Start scoping" | "End scoping" }
  | { kind: "pick"; label: "Scope this thread…" }
  | { kind: "stop"; label: "Stop scoping"; task: { id: string; name: string } };

/** The whole project's switch: Start scoping while it is active, End scoping while it scopes as a whole. */
export const projectScopeAction = (mode: "scoping" | "active" | undefined): ScopeAction =>
  mode === "scoping" ? { kind: "project", mode: "active", label: "End scoping" } : { kind: "project", mode: "scoping", label: "Start scoping" };

/**
 * What a row's menu offers: a lead's row switches its whole project; a live thread's row scopes it (a new task or an open
 * one; also to move it to another task) and, while it scopes one, stops it. A stopped or archived thread offers nothing:
 * the engine would refuse it.
 */
export function scopeActions(a: { role: string; engineStatus?: string; scopeTask?: { id: string; name: string } | null }, mode: "scoping" | "active" | undefined): ScopeAction[] {
  if (a.role === "lead") return [projectScopeAction(mode)];
  if (a.role !== "thread" || a.engineStatus === "stopped" || a.engineStatus === "archived") return [];
  return [{ kind: "pick", label: "Scope this thread…" }, ...(a.scopeTask ? [{ kind: "stop" as const, label: "Stop scoping" as const, task: a.scopeTask }] : [])];
}

/** The picker's "New task" name, from the thread's title: one line, cut to the engine's cap at a word where it can be. */
export function taskNameFor(title: string | null): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= TASK_NAME_MAX) return t;
  const cut = t.slice(0, TASK_NAME_MAX);
  const sp = cut.lastIndexOf(" ");
  return (sp > TASK_NAME_MAX / 2 ? cut.slice(0, sp) : cut).trim();
}

/** The open tasks the picker lists: the project's, less the one the thread already scopes. */
export const pickableTasks = <T extends { id: string }>(tasks: readonly T[] | undefined, current: { id: string } | null | undefined): T[] => (tasks ?? []).filter((t) => t.id !== current?.id);

/** The project row's Scoping chip for an active project with open scoping tasks (a project scoping as a whole says it in its state chip). */
export function tasksScoping(p: { mode?: "scoping" | "active"; tasks?: readonly unknown[] }): string | null {
  const n = p.tasks?.length ?? 0;
  return p.mode !== "scoping" && n ? `${n} ${n === 1 ? "task" : "tasks"} scoping` : null;
}

type Deliverable = Deliverables[number];
/** In review, newest first: what the Deliverables tab and the badges count. A scoping project's wait in the Scope tab, a board's on the Multiplayer tab. */
export const inReview = (all: Deliverables | undefined): Deliverable[] => (all ?? []).filter((d) => d.state === "review" && !d.scope && !d.board).sort((a, b) => b.updatedAt - a.updatedAt);

/** In review in a scoping project's Scope pane (1.11.0): not on Deliverables until the project is active. */
export const inScope = (d: Deliverable) => d.state === "review" && !!d.scope;

/**
 * What waits on the owner, by where it lives (2026-11-21, the owner: "mine says 6 on the plugin on the side but when i
 * click into the app, 'needs you' 'delivered' or anything doesn't say anything"). The rail badge is `total`, and every
 * count the page draws is one of the parts, so they always add up to it: Needs you (cards and prompts), Delivered (in
 * review), and Scope in Projects (its cards and its scoping deliverables in review). Each item is in exactly one part.
 */
export function ownerCounts(needs: { badge: number } | undefined, all: Deliverables | undefined, scope: Scope | undefined): { needs: number; delivered: number; scope: number; total: number } {
  const n = needs?.badge ?? 0;
  const delivered = inReview(all).length;
  const scoping = (scope?.badge ?? 0) + (all ?? []).filter((d) => inScope(d) && !!scope?.projects.some((p) => p.slug === d.project)).length;
  return { needs: n, delivered, scope: scoping, total: n + delivered + scoping };
}

/** The rail badge's words: where its number lives, so the owner can see which tab it comes from. */
export function ownerCountsLabel(c: { needs: number; delivered: number; scope: number }): string {
  const parts = [c.needs ? `${c.needs} in Needs you` : "", c.delivered ? `${c.delivered} in Delivered` : "", c.scope ? `${c.scope} in Projects (Scope)` : ""].filter(Boolean);
  return parts.join(", ");
}
/** What the Deliverables tab lists: a board's reviews never (they live on the Multiplayer tab), a scoping one once decided. */
export const onDeliverablesTab = (d: Deliverable) => !d.board && !inScope(d);

// ---------------------------------------------------------------- scoping under its project (2026-11-22)
// Projects' list draws a project's scope entries (scopeEntries) as its children, not as a group of their own: "Whole
// project" while it scopes, then one row per open scoping task. What waits in them (scope.tsx scopeWaitingIn) only shows
// there, never in Needs you, so the parent row counts it too.

/** A project's scope entry as a child row, and what waits on the owner in it: its cards and its deliverables in review. */
export interface ScopeChild {
  entry: ScopeEntry;
  /** cards + deliverables (scope.tsx scopeWaitingIn): what the child row says */
  waiting: number;
  /** of those, the deliverables in review */
  deliverables: number;
}

/** What waits in all of a project's children. */
export const childWaiting = (kids: readonly ScopeChild[]): number => kids.reduce((n, k) => n + k.waiting, 0);

/**
 * What the children add to the project's own count (needCount), so each waiting item counts once. needCount's cards
 * (summary.needsYou, core/history.ts) are every person-level card the project asked, scope cards included: only the
 * scope deliverables in review are new. (2026-11-22: adding the cards too counted each scope card twice.)
 */
export const scopeExtra = (kids: readonly ScopeChild[]): number => kids.reduce((n, k) => n + k.deliverables, 0);

/** The "Quiet" group: a project quiet by its own rule (command-center isQuiet), and nothing waits in its children. */
export const quietWithScope = (quiet: boolean, kids: readonly ScopeChild[]): boolean => quiet && childWaiting(kids) === 0;

/** The "Needs me" filter (and the others, unchanged): a project matches by its own rule, or "you" while a child waits. */
export const matchesWithScope = (f: string, own: boolean, kids: readonly ScopeChild[]): boolean => own || (f === "you" && childWaiting(kids) > 0);

/** A scoping task the search matched by name (childHits), for the search box's lines: its project, entry and name. */
export type TaskHit = { project: string; key: string; name: string };

/**
 * The search box's head (search.tsx SearchHits). The matched lines and the matched scoping tasks count together: the list
 * under the box shows a project opened on a task it matched, so the head saying "0 matches" contradicted it (2026-11-22).
 */
export function matchesHead(lines: number, tasks: number): string {
  const n = lines + tasks;
  return `${n} ${n === 1 ? "match" : "matches"} on the projects`;
}

/** The children whose task name has every word searched for (as the search compares: source.ts fold). */
export function childHits(kids: readonly ScopeChild[], q: string): ScopeChild[] {
  const words = fold(q).split(" ").filter(Boolean);
  if (!words.length) return [];
  return kids.filter((k) => !!k.entry.task && words.every((w) => fold(k.entry.task!.name).includes(w)));
}

/** A press of a project's chevron, with what was in sight then: the searched words, and which of its entries was open. */
export type FoldPress = { open: boolean; q: string; held: string | null };

/**
 * Whether a project's children show: the viewer's last press of the chevron wins, unless a search or a selection came
 * after it (a search for other words that matches a child, or another of its children opened since); a press made
 * during a search lasts as long as that search. Else open while a child waits, holds the open entry or matches the
 * search; else the viewer's last choice for the project (stored); else closed. A collapse used to win over everything,
 * so a search for a task could leave its matching child hidden (review of public PR #22).
 */
export function childrenOpen(o: { kids: readonly ScopeChild[]; toggled: FoldPress | undefined; q: string; stored: boolean | null; held: string | null; searchHit: boolean }): boolean {
  const t = o.toggled;
  const ended = !!t && !!t.q.trim() && !o.q.trim();
  const newer = !!t && ((o.searchHit && fold(o.q) !== fold(t.q)) || (o.held !== null && o.held !== t.held));
  if (t && !ended && !newer) return t.open;
  if (childWaiting(o.kids) > 0 || o.held !== null || o.searchHit) return true;
  return o.stored === true;
}

/**
 * The presses after the open entry changed to `open` (projects.tsx, on each change of the open entry): a press made while
 * one of its project's entries was open forgets that entry once it is no longer the open one. Else, after open child A,
 * collapse, select the parent, open A again, the press still named A and A stayed hidden (review of public PR #22's
 * landing). Unchanged presses return the same object, so nothing re-renders.
 */
export function leftEntry(toggled: Record<string, FoldPress>, open: string | null): Record<string, FoldPress> {
  const stale = Object.entries(toggled).filter(([, t]) => t.held !== null && t.held !== open);
  if (!stale.length) return toggled;
  return { ...toggled, ...Object.fromEntries(stale.map(([slug, t]) => [slug, { ...t, held: null }])) };
}

/** What a scoping child row says of its planner (2026-11-22): only that a task's scoping thread is stuck; else nothing. */
export const plannerStuck = (e: ScopeEntry): string | null => (e.planner?.status === "error" ? plannerOf(e).text.split(" · ").pop()! : null);
