// The Projects tab as a command center (2026-11-16, the v2 row): what each project's row says, in one place and without
// JSX, so node --test checks it. One state word, the most pressing first; wait lines in plain words, ending with their
// source; at most two of them, the lead's own first, then the longest live one; the rest folded into "+N more waits".
// Rows are ordered by attention: needs you, blocked, the longest wait, moving, the rest.
import type { AgentPersona, Projects, SummaryWait } from "../contract.ts";
import { isStale, position } from "../core/status.ts";
import { age, waitsOnOwner, type Lane } from "./lanes.ts";
import { typeFamily } from "../mons.ts";

type Project = Projects[number];
export type RowState = "you" | "blocked" | "moving" | "waiting" | "quiet" | "held" | "nolead";
export const STATE_WORD: Record<Exclude<RowState, "you">, string> = { blocked: "Blocked", moving: "Moving", waiting: "Waiting", quiet: "Quiet", held: "On hold", nolead: "No lead" };
/** Wait lines drawn on a row; the status still holds three, and the project page shows every one. */
export const WAITS_SHOWN = 2;
/** A wait older than this gets the amber dot. */
export const OLD_WAIT_MS = 4 * 3_600_000;
export const FILTERS = ["all", "you", "blocked", "waits"] as const;
export type Filter = (typeof FILTERS)[number];
export const FILTER_WORD: Record<Filter, string> = { all: "All", you: "Needs me", blocked: "Blocked", waits: "With waits" };

/** Whether the owner is waited on: an open card from the project, or one of its agents' own prompts. */
export const needsYou = (p: Project, lanes: Lane[] | undefined) => (p.summary?.needsYou.count ?? 0) > 0 || waitsOnOwner(lanes);

/** The lead's blockers that still stand: the summary's (an answer may have covered some), else the status's. */
export const blockersOf = (p: Project): string[] => p.summary?.blockers ?? p.status?.blockers ?? [];

export function stateOf(p: Project, lanes: Lane[] | undefined): RowState {
  if (needsYou(p, lanes)) return "you";
  if (blockersOf(p).length) return "blocked";
  if (p.heldAt !== null) return "held";
  if (!p.lead) return "nolead";
  const m = p.summary?.motion;
  if (m === "moving" || m === "waiting" || m === "quiet") return m;
  return lanes?.some((l) => l.state === "working") ? "moving" : "quiet";
}

const PR_NO = /\/pull\/(\d+)/;
const prName = (w: { ref: string | null; who?: string | null }) => {
  const n = w.ref ? PR_NO.exec(w.ref)?.[1] : null;
  return n ? `PR #${n}` : "a PR";
};
const threadName = (ref: string | null) => {
  const m = ref ? /^thread:[^:]+:(\d+)$/.exec(ref) : null;
  return m ? `thread ${m[1]}` : (ref ?? "a thread");
};
const host = (ref: string | null) => {
  if (!ref) return null;
  try {
    return new URL(ref).host || ref;
  } catch {
    return ref;
  }
};

/** A wait in plain words: who or what, then the detail. `cos`: the CoS's title on this page. */
export function waitWords(w: SummaryWait, cos: string): [string, string] {
  const l = w.label ?? "";
  switch (w.kind) {
    // the lead's own words
    case "owner":
      return ["you", l];
    case "pr":
      return [prName(w), [l, w.who ? `from ${w.who}` : ""].filter(Boolean).join(" ")];
    case "thread":
      return [threadName(w.ref), l];
    case "ci":
      return [w.source === "live" ? `CI on ${w.who ?? prName(w)}` : `CI on ${prName(w)}`, w.source === "live" ? "" : l];
    case "colleague":
      return [w.who ?? "a colleague", w.who ? l : ""];
    case "lead":
      return [w.who ? `the ${w.who} lead` : "another lead", l];
    case "deploy":
      return ["", l || "a deploy"];
    case "quota":
      return ["", l || "a quota"];
    case "external":
      return [w.who ?? "", l || host(w.ref) || "something outside"];
    // live facts
    case "card":
      return ["your answer", l];
    case "held":
      return ["your answer", `${l} (queued behind an earlier card)`];
    case "deferred":
      return ["your answer", `${l} (you deferred it)`];
    case "cos-card":
      return [`the ${cos}`, l];
    case "reply":
      return [`a reply from ${w.who === "cos" ? `the ${cos}` : (w.who ?? "?")}`, l];
    case "dead":
      return [`an undelivered message to ${w.who === "cos" ? `the ${cos}` : (w.who ?? "?")}`, ""];
    case "pr-bound":
      return [prName(w), `an answer waits until it is ${l.replace(/^#\S+\s*/, "") || "ready"}`];
    case "review":
      return [`a review of ${w.who ?? prName(w)}`, ""];
    case "merge":
      return [`a merge of ${w.who ?? prName(w)}`, ""];
    case "pr-blocked":
      return [w.who ?? prName(w), l];
    case "deliverable":
      return ["your review", l];
    default:
      return [w.who ?? w.kind, l];
  }
}

export interface WaitLine {
  text: string; // "who: what"
  tail: string; // "for 2d · lead said", "unchanged 18h · live"
  old: boolean; // the amber dot
  note: string | null; // what a live fact adds ("the thread failed")
  source: "lead" | "live";
  wait: SummaryWait;
}

export function waitAge(w: SummaryWait, now: number): string {
  const a = age(w.since, now);
  return a ? (w.unchanged ? `unchanged ${a}` : `for ${a}`) : "";
}

export function waitLine(w: SummaryWait, now: number, cos: string): WaitLine {
  const [who, what] = waitWords(w, cos);
  return {
    text: [who, what].filter(Boolean).join(": "),
    tail: [waitAge(w, now), w.source === "live" ? "live" : "lead said"].filter(Boolean).join(" · "),
    old: w.since !== null && now - w.since >= OLD_WAIT_MS,
    note: w.note,
    source: w.source,
    wait: w,
  };
}

/** The lead's own waits first, then the live ones longest first; the rest fold, naming the oldest. */
export function pickWaits(waits: SummaryWait[], now: number): { shown: SummaryWait[]; more: number; oldest: SummaryWait | null } {
  const ageOf = (w: SummaryWait) => (w.since === null ? 0 : now - w.since);
  const sorted = [...waits.filter((w) => w.source !== "live"), ...waits.filter((w) => w.source === "live").sort((a, b) => ageOf(b) - ageOf(a))];
  const hidden = sorted.slice(WAITS_SHOWN).sort((a, b) => ageOf(b) - ageOf(a));
  return { shown: sorted.slice(0, WAITS_SHOWN), more: hidden.length, oldest: hidden[0] ?? null };
}

/** The longest any wait has been waited on, in ms (0 with none): the third key of the attention order. */
export const longestWait = (p: Project, now: number) => Math.max(0, ...(p.summary?.waits ?? []).filter((w) => w.since !== null).map((w) => now - w.since!));

const ATTENTION: Record<RowState, number> = { you: 0, blocked: 1, waiting: 2, moving: 3, held: 4, nolead: 5, quiet: 6 };
const RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

/**
 * By attention: needs you, blocked, the longest wait, moving, then the rest; then priority, then name. `forYou`: a
 * project with more for the owner than its own state says (its scoping children, Projects 2026-11-22) sorts as "you".
 */
export function attentionOrder(lanes: Map<string, Lane[]>, now: number, forYou: (p: Project) => number = () => 0) {
  return (a: Project, b: Project) => {
    const sa = forYou(a) > 0 ? "you" : stateOf(a, lanes.get(a.slug));
    const sb = forYou(b) > 0 ? "you" : stateOf(b, lanes.get(b.slug));
    const wa = longestWait(a, now);
    const wb = longestWait(b, now);
    // a moving project that also waits on something outside sorts with the waiting ones, by how long
    const ra = sa === "moving" && wa > 0 ? ATTENTION.waiting : ATTENTION[sa];
    const rb = sb === "moving" && wb > 0 ? ATTENTION.waiting : ATTENTION[sb];
    return ra - rb || (ra === ATTENTION.waiting ? wb - wa : 0) || RANK[a.priority] - RANK[b.priority] || a.slug.localeCompare(b.slug);
  };
}

/** Quiet projects fold to one line: nothing running, nothing waiting, nothing for the owner. */
export function isQuiet(p: Project, lanes: Lane[] | undefined, now = Date.now()): boolean {
  const s = stateOf(p, lanes);
  return (s === "quiet" || s === "nolead") && !(p.summary?.waits.length ?? 0) && !blockersOf(p).length && !directShown(p.direct, now).length;
}

// ---------------------------------------------------------------- the direct line (PLAN 3.4)

type Direct = NonNullable<Project["direct"]>;
type DirectMessage = Direct["messages"][number];
/** The row shows the owner's latest two messages: while in force (48 h), or while not yet acked, or with a new note. */
export const DIRECT_ROW = 2;
const IN_FORCE_MS = 48 * 3_600_000;
/** Ask for status (PLAN 1.6): a direct message with fixed text. */
export const ASK_STATUS_TEXT = "What's your status? Please publish it with orch_status (goal, steps, what you wait on), then ack this with a one-line summary.";

/** Every message with an answer the owner hasn't seen, then the latest unanswered or in-force ones, up to two in all. */
export function directShown(d: Project["direct"], now: number): DirectMessage[] {
  if (!d) return [];
  const fresh = d.messages.filter((m) => m.unread);
  const rest = d.messages.filter((m) => !m.unread && (m.state !== "closed" || now - m.at < IN_FORCE_MS));
  return [...fresh, ...rest.slice(0, Math.max(0, DIRECT_ROW - fresh.length))].sort((a, b) => b.at - a.at);
}

/** The chat log (1.10.0): every message once, oldest first, so the newest sits by the input. */
export function chatOrder(ms: readonly DirectMessage[]): DirectMessage[] {
  const byId = new Map<string, DirectMessage>();
  for (const m of ms) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

/** The collapsed chat's one line: the last exchange (the owner's latest message and the lead's note on it), and the dot. */
export function chatPreview(d: Project["direct"]): { you: string; lead: string | null; unread: boolean } | null {
  const last = d?.messages.reduce<DirectMessage | null>((x, m) => (!x || m.at > x.at ? m : x), null);
  if (!d || !last) return null;
  const line = (s: string) => s.replace(/\s+/g, " ").trim();
  // a message's screenshots (2026-11-17) count in the line; one that is only images says how many
  const n = last.images?.length ?? 0;
  const imgs = n ? `[${n === 1 ? "1 image" : `${n} images`}]` : "";
  return { you: [line(last.text), imgs].filter(Boolean).join(" "), lead: last.note ? line(last.note) : null, unread: d.unread };
}

/** The newest answer the row shows unread: opening the thread marks answers up to it seen, and no further. */
export function seenUpTo(d: Project["direct"]): number | null {
  const at = (d?.messages ?? []).filter((m) => m.unread && m.answeredAt !== null).map((m) => m.answeredAt!);
  return at.length ? Math.max(...at) : null;
}

/** A message's state in plain words: queued, delivered, acked (taken, not finished), or how it ended. */
export function directState(m: DirectMessage, cos: string): { word: string; dead: boolean } {
  if (m.state === "dead") return { word: `no ack · with the ${cos}`, dead: true };
  if (m.state === "closed") return { word: m.outcome === "done" || m.outcome === "replied" ? "acked" : (m.outcome ?? "closed"), dead: false };
  return { word: m.state === "delivered" ? "delivered" : "queued", dead: false };
}

/** The message a new one follows up by default: the latest, while it is in force. */
export function followUpOf(d: Project["direct"], now: number): DirectMessage | null {
  const last = d?.messages[0];
  return last && now - last.at < IN_FORCE_MS ? last : null;
}

export function matches(f: Filter, p: Project, lanes: Lane[] | undefined): boolean {
  if (f === "all") return true;
  if (f === "you") return stateOf(p, lanes) === "you";
  if (f === "blocked") return blockersOf(p).length > 0;
  return (p.summary?.waits.length ?? 0) > 0;
}

/** What the title says the project is doing now: the current step, else the working thread's title. */
export function nowText(p: Project, lanes: Lane[] | undefined): string {
  const s = p.status;
  if (s) {
    const pos = position(s);
    if (pos.kind === "current" || pos.kind === "next") return pos.title;
    if (pos.kind === "done") return pos.total === 1 ? "the step is done" : `all ${pos.total} steps done`;
    return s.goal;
  }
  const w = lanes?.find((l) => l.state === "working" && l.activity) ?? lanes?.find((l) => l.activity);
  return w?.activity ?? "";
}

/** "4 of 6 threads working"; null without threads. */
export function threadCount(p: Project): string | null {
  const t = p.summary?.threads;
  if (!t || t.total === 0) return null;
  return `${t.working} of ${t.total} ${t.total === 1 ? "thread" : "threads"} working`;
}

export const statusStale = (p: Project, now: number) => !!p.status && isStale(p.status, now);

/** The one quiet line for a contradicted status: the lead was asked to republish, unless nobody can be asked. */
export function outOfDateLine(p: Project): string | null {
  if (!p.summary?.statusOutOfDate) return null;
  return p.lead && p.heldAt === null ? "Status out of date: asked the lead to refresh" : "Status out of date";
}

/**
 * A quiet row's few words (2026-11-16, the owner: never "no status from the lead"): where its steps stand, then the
 * latest finished thing and its age, or since when the lead idles; a contradicted status says so, as on a full row.
 */
export function quietLine(p: Project, now: number): string {
  if (p.archivedAt !== null) return `archived ${new Date(p.archivedAt).toLocaleDateString([], { day: "numeric", month: "short" })}`;
  if (!p.lead) return "no lead";
  const s = p.status;
  const pos = s ? position(s) : null;
  const step = !s || !pos ? null : pos.kind === "done" ? (pos.total === 1 ? "the step is done" : `all ${pos.total} steps done`) : pos.kind === "none" ? s.goal : `step ${pos.at} of ${pos.total}: ${pos.title}`;
  const parts = [step, quietWords(p, now), outOfDateLine(p)?.replace(/^Status/, "status")].filter((x): x is string => !!x && x !== "idle");
  return parts.join(" · ") || "idle";
}

/** A quiet row's words without a status: the latest finished thing and its age, else since when the lead idles. */
export function quietWords(p: Project, now: number): string {
  const last = p.summary?.last;
  if (last) return `${last.text} · ${age(last.at, now)} ago`;
  const idle = p.summary?.leadIdleSince;
  if (idle) return `idle since ${new Date(idle).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
  return p.lead ? "idle" : "no lead";
}

/**
 * The row head: the lead's Pokémon (null with the setting off: a neutral avatar), its name, the project's type. With a
 * personas pack (2026-11-18) the lead is a person: no Pokémon, its title and name ("Pilot Vesna"). `shown`: whether the
 * head names the lead and its type at all (never with the setting off). `type` is the label's words: the person's own
 * specialty type when the pack gives one (the owner, 2026-11-18), else the project's. `accent` is the type every colour
 * follows (the label's, the accents): always the project's, so a project keeps its colour whoever leads it.
 */
export function leadHead(p: Project): { mon: string | null; name: string; type: string | null; accent: string | null; persona: AgentPersona | null; shown: boolean } {
  const mon = p.lead?.mon ?? null;
  const persona = p.lead?.persona ?? null;
  const name = persona ? `${persona.title} ${persona.name}` : (mon ?? (p.lead ? "lead" : "no lead"));
  const type = (persona?.type ? typeFamily(persona.type) : null) ?? typeFamily(p.monType);
  return { mon, name, type: type?.label ?? null, accent: p.monType, persona, shown: !!(mon || persona) };
}
