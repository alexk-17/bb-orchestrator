// The Projects tab as a source of truth (2026-11-16, layout B; the owner: "I'm trying not to get lost in all the work
// that is being done, so I need a source of truth to refer to"). What the search and the seven sections say,
// without JSX, so node --test checks it. Every line carries its age and its source (the lead's word or a live read);
// a stale or contradicted status is flagged, never drawn as current.
import type { NeedsYou, ProjectBook, Projects, SummaryWait } from "../contract.ts";
import { blockersOf, nowText } from "./command-center.ts";
import type { Lane } from "./lanes.ts";

type Project = Projects[number];
type Card = NeedsYou["cards"][number];

/** At this pane width and wider the list sits beside the selected item; narrower, the item opens as its own page with Back (the owner, 2026-11-20). */
export const WIDE_MIN = 720;
export const isWide = (width: number) => width >= WIDE_MIN;

/** Waits that are the owner's to settle: they go under Needs you, the rest under Blocked by. */
export const ON_OWNER = new Set(["owner", "card", "held", "deferred", "deliverable"]);
export const onOwner = (w: SummaryWait) => ON_OWNER.has(w.kind);

/** One line that waits on the owner: an open card, an agent's own prompt, or a wait the lead or a live read names. */
export type NeedLine =
  | { kind: "card"; project: string; id: string; text: string; since: number | null }
  | { kind: "prompt"; project: string; threadId: string; address: string; text: string; since: number | null }
  | { kind: "wait"; project: string; wait: SummaryWait; noCard: boolean };

/** What waits on the owner in one project: its open cards, its agents' prompts, then waits no card already shows. */
export function needLines(p: Project, lanes: Lane[] | undefined, cards: Card[]): NeedLine[] {
  const mine = cards.filter((c) => c.project === p.slug);
  const ids = new Set(mine.map((c) => c.id));
  const out: NeedLine[] = mine.map((c) => ({ kind: "card", project: p.slug, id: c.id, text: c.question || c.title, since: Date.parse(c.askedAt) || null }));
  for (const l of lanes ?? [])
    if (l.state === "waiting" && l.wait?.on === "owner" && !l.wait.cardId) out.push({ kind: "prompt", project: p.slug, threadId: l.agent.threadId, address: l.agent.address, text: l.activity ?? "a prompt in its thread", since: l.since });
  for (const w of p.summary?.waits ?? []) {
    if (!onOwner(w) || (w.ref && ids.has(w.ref))) continue;
    out.push({ kind: "wait", project: p.slug, wait: w, noCard: w.source === "lead" && !(w.ref && w.ref.startsWith("d-")) });
  }
  return out;
}

/** The waits outside the owner: who or what else the project waits on. */
export const otherWaits = (p: Project) => (p.summary?.waits ?? []).filter((w) => !onOwner(w));

/**
 * A blocker with when it started: the lead's first saying of it (book.since; bound when the history read ends before the
 * run does, so it is at least that old), else the status's time, which is only when the lead last said it.
 */
export function blockerLines(p: Project, book: ProjectBook | undefined): { text: string; since: number | null; first: boolean; bound: boolean }[] {
  const at = new Map((book?.since ?? []).map((b) => [b.text, b] as const));
  return blockersOf(p).map((text) => {
    const b = at.get(text);
    return b ? { text, since: b.since, first: true, bound: b.bound } : { text, since: p.status?.updatedAt ?? null, first: false, bound: false };
  });
}

/** The project's PRs still open or in draft, newest number first. */
export const prsInFlight = (p: Project) => (p.prs ?? []).filter((x) => x.state === "open" || x.state === "draft").sort((a, b) => b.number - a.number);

/** The start of the viewer's own day: "merged today" is the page's today, which the plugin can't know. */
export const dayStart = (now: number) => new Date(now).setHours(0, 0, 0, 0);
export const mergedToday = (book: ProjectBook | undefined, now: number) => (book?.merged ?? []).filter((m) => m.at >= dayStart(now));
/** How many merged today: the plugin's count when it listed only the first MERGED_TODAY_MAX of them. */
export const mergedTodayCount = (book: ProjectBook | undefined, now: number) => {
  const today = mergedToday(book, now);
  return book && today.length === book.merged.length ? Math.max(today.length, book.mergedTotal) : today.length;
};

// ---------------------------------------------------------------- the search over what the page has loaded

export type HitKind = "project" | "goal" | "now" | "thread" | "pr" | "card" | "wait" | "blocker";
export interface Hit {
  project: string;
  kind: HitKind;
  text: string;
  /** A PR's URL, a card's id or a thread's id: what the hit opens besides its project. */
  ref: string | null;
}
const HIT_WORD: Record<HitKind, string> = { project: "project", goal: "goal", now: "now", thread: "thread", pr: "PR", card: "card", wait: "waits on", blocker: "blocked by" };
export const hitWord = (k: HitKind) => HIT_WORD[k];

/** Lower case, accents off, spaces folded: what both sides of a match are compared as. */
export const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Every loaded line that has the words: a project's name, goal and now, its threads' titles, its PRs (by number or
 * title), its open cards, its waits and blockers. "#4475" and "4475" both find PR 4475. Each word must appear (in any
 * order); the project's own line comes first.
 */
export function searchLoaded(projects: Project[], lanes: Map<string, Lane[]>, cards: Card[], q: string, waitText: (w: SummaryWait) => string): Hit[] {
  const words = fold(q.replace(/#(\d)/g, "$1")).split(" ").filter(Boolean);
  if (!words.length) return [];
  const has = (s: string | null | undefined) => {
    if (!s) return false;
    const f = fold(s);
    return words.every((w) => f.includes(w));
  };
  const out: Hit[] = [];
  for (const p of projects) {
    const push = (kind: HitKind, text: string | null | undefined, ref: string | null = null, also = "") => {
      if (text && (has(text) || (also && has(`${also} ${text}`)))) out.push({ project: p.slug, kind, text, ref });
    };
    push("project", p.slug);
    push("goal", p.status?.goal);
    const now = nowText(p, lanes.get(p.slug));
    if (now !== p.status?.goal) push("now", now);
    for (const l of lanes.get(p.slug) ?? []) push("thread", l.activity, l.agent.threadId, l.agent.address);
    for (const x of p.prs ?? []) if (has(String(x.number)) || has(x.url)) out.push({ project: p.slug, kind: "pr", text: `PR #${x.number}`, ref: x.url });
    for (const c of cards) if (c.project === p.slug) push("card", c.question || c.title, c.id, `${c.title} ${c.id}`);
    for (const w of p.summary?.waits ?? []) push("wait", waitText(w), w.ref, w.ref ?? "");
    for (const b of blockersOf(p)) push("blocker", b);
  }
  return out;
}

/** The projects the search keeps in the list: those with a hit. Without a query, all of them. */
export function searchedProjects(projects: Project[], hits: Hit[], q: string): Project[] {
  if (!fold(q)) return projects;
  const keep = new Set(hits.map((h) => h.project));
  return projects.filter((p) => keep.has(p.slug));
}

/**
 * A click on a project's name in the search's hits must land on that project: the hits cover every live project, so a
 * filter can hide the one clicked; then the filter clears (the search stays: a hit's project always matches it), so the
 * selection or the row opened in place is the one the owner clicked.
 */
export const filterHides = (slug: string, filtered: Project[]) => !filtered.some((p) => p.slug === slug);
