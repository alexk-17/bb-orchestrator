import type { BoardView, PrView, RecordView } from "../contract.ts";
import { isLate } from "./watch.ts";

export type Filter = "all" | "approved" | "changes" | "commented" | "waits";
export const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "approved", label: "Approved" },
  { value: "changes", label: "Changes requested" },
  { value: "commented", label: "Commented" },
  { value: "waits", label: "Waits on you" },
];
const STATE_OF: Record<string, Filter> = { APPROVED: "approved", CHANGES_REQUESTED: "changes", COMMENTED: "commented" };

/** Nothing left to do: the lead said done, or the owner decided its deliverable. */
export const settled = (r: RecordView) => r.state === "done" || (!!r.deliverable && r.deliverable.state !== "review");
export const open = (r: RecordView) => r.waitsOnYou || !settled(r);
/** A board's health at the page's own clock: a watcher that stopped reading also stopped the refetches that would show it. */
export function healthAt(b: BoardView, now: number): BoardView {
  const h = b.watch?.health;
  if (!h || h.nextAt === null || h.everyMs === null || (h.state !== "healthy" && h.state !== "late")) return b;
  return { ...b, watch: { ...b.watch!, health: { ...h, state: isLate(h.nextAt, h.everyMs, now) ? "late" : "healthy" } } };
}
export const startOfDay = (t: number) => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime();

export function counts(records: RecordView[], now: number): { reviewing: number; waits: number; prsToday: number } {
  const today = startOfDay(now);
  return {
    reviewing: records.filter((r) => r.state === "reviewing" || r.state === "replying").length,
    waits: records.filter((r) => r.waitsOnYou).length,
    prsToday: records.flatMap((r) => r.prs.filter((p) => p.review && (p.review.submittedAt ?? r.times.review ?? 0) >= today)).length,
  };
}

export const reviewed = (r: RecordView) => r.prs.filter((p) => p.review).length;

/** From the request to its deliverable (or done); null while it runs. */
export function took(r: RecordView): number | null {
  const end = r.times.deliverable ?? r.times.done ?? null;
  const start = r.askedAt ?? r.createdAt;
  return end !== null && end >= start ? end - start : null;
}

const prIn = (r: RecordView, p: PrView, f: Filter) => f === "all" || (f === "waits" ? r.waitsOnYou : !!p.review?.state && STATE_OF[p.review.state] === f);

const hay = (r: RecordView) => [r.asker?.name, r.asker?.id, r.thread?.ref, r.thread?.address, r.note, ...r.prs.flatMap((p) => [p.name, p.url, p.title])].filter(Boolean).join(" ").toLowerCase();

export function shown(records: RecordView[], f: Filter, q: string): RecordView[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return records
    .filter((r) => words.every((w) => hay(r).includes(w)))
    .filter((r) => f === "all" || (f === "waits" && r.waitsOnYou) || r.prs.some((p) => prIn(r, p, f)))
    .map((r) => (f === "all" || f === "waits" ? r : { ...r, prs: r.prs.filter((p) => prIn(r, p, f)) }));
}

/** Each filter's count, in PRs. */
export const filterCounts = (records: RecordView[]): Record<Filter, number> =>
  Object.fromEntries(FILTERS.map(({ value }) => [value, records.reduce((n, r) => n + r.prs.filter((p) => prIn(r, p, value)).length, 0)])) as Record<Filter, number>;

export function byDay(records: RecordView[], now: number): { label: string; records: RecordView[] }[] {
  const days = new Map<number, RecordView[]>();
  for (const r of [...records].sort((a, b) => (b.askedAt ?? b.createdAt) - (a.askedAt ?? a.createdAt))) {
    const d = startOfDay(r.askedAt ?? r.createdAt);
    days.set(d, [...(days.get(d) ?? []), r]);
  }
  const today = startOfDay(now);
  const yesterday = startOfDay(today - 12 * 3600_000);
  return [...days].map(([d, rs]) => ({ label: d === today ? "Today" : d === yesterday ? "Yesterday" : new Date(d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }), records: rs }));
}

export function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d`;
}
export const ago = (t: number, now: number) => (now - t < 60_000 ? "just now" : `${span(now - t)} ago`);
export const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
