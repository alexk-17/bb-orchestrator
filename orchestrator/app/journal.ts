// Back and Forward across panes (2026-11-20): the URL names a place, not a pane, so each history entry records which pane moved.
import type { Route } from "./route.ts";

export type Step = { pane: string; from: Route; to: Route };
export type Entry = { url: string; step: Step | null };
export type Journal = { entries: Entry[]; index: number };
/** The oldest entries go first past this many. */
export const MAX_ENTRIES = 200;

export const fresh = (url: string): Journal => ({ entries: [{ url, step: null }], index: 0 });

/** Our push: drop what was ahead, append, step forward. A link that moved no pane has no step (Back then reads as a link). */
export function push(j: Journal, url: string, step: Step | null): Journal {
  const entries = [...j.entries.slice(0, j.index + 1), { url, step }];
  const cut = Math.max(0, entries.length - MAX_ENTRIES);
  return { entries: entries.slice(cut), index: entries.length - 1 - cut };
}

/** Our replace: the current entry's URL changes, its step stays. */
export function replace(j: Journal, url: string): Journal {
  return { entries: j.entries.map((e, i) => (i === j.index ? { ...e, url } : e)), index: j.index };
}

export type Arrival = { kind: "same" } | { kind: "back"; step: Step; journal: Journal } | { kind: "forward"; step: Step; journal: Journal } | { kind: "link" };

/** A URL the page did not make. Entries before and after with the same URL read as Back. */
export function arrive(j: Journal, url: string): Arrival {
  const here = j.entries[j.index];
  if (here?.url === url) return { kind: "same" };
  const prev = j.entries[j.index - 1];
  if (prev?.url === url && here?.step) return { kind: "back", step: here.step, journal: { ...j, index: j.index - 1 } };
  const next = j.entries[j.index + 1];
  if (next?.url === url && next.step) return { kind: "forward", step: next.step, journal: { ...j, index: j.index + 1 } };
  return { kind: "link" };
}

/** A journal read back from storage: anything malformed gives null. */
export function readJournal(raw: unknown): Journal | null {
  const j = raw as Journal | null;
  if (!j || !Array.isArray(j.entries) || !Number.isInteger(j.index) || j.index < 0 || j.index >= j.entries.length) return null;
  return j.entries.every((e) => e && typeof e.url === "string") ? j : null;
}
