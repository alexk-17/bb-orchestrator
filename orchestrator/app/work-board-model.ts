import { BOARD_COLUMNS, COLUMN_LABEL, type BoardColumn, type BoardTask, type NeedsYou, type Scope, type WorkBoard } from "../contract.ts";
import { prKind, type KindKey } from "./palette.ts";

export { COLUMN_LABEL };

export interface LensMove {
  from: BoardColumn | "dropped" | null;
  to: BoardColumn | "dropped";
  at: number;
  isNew: boolean;
}
export interface BoardLens {
  since: number | null;
  moved: Record<string, LensMove>;
  onlyMoved: boolean;
  pick?: { key: string; ids: string[] } | null;
}

export function columnsOf(board: WorkBoard, project: string | null, lens: BoardLens | null = null): { column: BoardColumn; tasks: BoardTask[] }[] {
  const all = board.projects.filter((p) => !project || p.slug === project).flatMap((p) => p.tasks);
  const picked = lens?.pick ? new Set(lens.pick.ids) : null;
  const tasks = picked ? all.filter((t) => picked.has(t.id)) : lens?.onlyMoved ? all.filter((t) => Object.hasOwn(lens.moved, t.id)) : all;
  return BOARD_COLUMNS.map((column) => {
    const mine = tasks.filter((t) => t.column === column);
    if (column === "shipped") mine.sort((a, b) => (b.since ?? 0) - (a.since ?? 0));
    else if (column === "waiting" || column === "blocked") mine.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity));
    return { column, tasks: mine };
  });
}

export function firstColumn(cols: { column: BoardColumn; tasks: BoardTask[] }[]): BoardColumn {
  if (cols.find((c) => c.column === "waiting")?.tasks.length) return "waiting";
  return cols.find((c) => c.tasks.length > 0)?.column ?? "planned";
}

export function columnAfterPick(picked: BoardColumn | null, cols: { column: BoardColumn; tasks: BoardTask[] }[]): BoardColumn | null {
  return picked && cols.find((c) => c.column === picked)?.tasks.length ? picked : null;
}

export function findCard(id: string, needs: NeedsYou | undefined, scope: Scope | undefined): { card: NeedsYou["cards"][number]; list: "cards" | "deferred"; scoping: boolean } | null {
  const open = needs?.cards.find((x) => x.id === id);
  if (open) return { card: open, list: "cards", scoping: false };
  const later = needs?.deferred.find((x) => x.id === id);
  if (later) return { card: later, list: "deferred", scoping: false };
  for (const p of scope?.projects ?? []) {
    const card = p.cards.find((x) => x.id === id);
    if (card) return { card, list: "cards", scoping: true };
  }
  return null;
}

export type Chip = { key: string; text: string; group: KindKey | null };

const prWord = (p: BoardTask["prs"][number]): string => {
  if (p.state === null) return "unknown";
  if (p.state === "merged") return "merged";
  if (p.state === "closed") return "closed";
  if (p.state === "draft") return "draft";
  if (p.wait === "ci") return "CI";
  if (p.wait === "review") return "review";
  if (p.wait === "merge") return "merge";
  if (p.wait === "blocked") return "fix";
  return "open";
};

export function chipsOf(t: BoardTask, max = 2): Chip[] {
  const chips: Chip[] = [];
  const live = t.threads.filter((x) => x.live);
  const failed = live.filter((x) => x.state === "blocked");
  if (failed.length) chips.push({ key: "thread-failed", text: failed.length === 1 ? "thread failed" : `${failed.length} threads failed`, group: "alarm" });
  const ok = live.length - failed.length;
  if (ok > 0) chips.push({ key: "threads", text: ok === 1 ? "1 thread" : `${ok} threads`, group: null });
  const prs = t.prs.filter((p) => p.state !== "closed" || t.prs.length === 1);
  for (const p of prs.slice(0, max)) chips.push({ key: `pr:${p.url}`, text: `${p.number ? `#${p.number}` : "PR"} ${prWord(p)}`, group: p.state === "merged" ? "merge" : prKind(p) });
  if (prs.length > max) chips.push({ key: "prs-more", text: `+${prs.length - max} PRs`, group: null });
  for (const d of t.deliverables.filter((x) => x.state !== "withdrawn"))
    chips.push({ key: `d:${d.id}`, text: d.state === "review" ? "deliverable" : d.state === "changes" ? "sent back" : d.state === "approved" ? "approved" : d.state, group: d.state === "review" ? "deliverable" : d.state === "changes" ? "changes" : d.state === "approved" ? "approved" : null });
  for (const c of t.cards) chips.push({ key: `c:${c.id}`, text: c.deferred ? "card deferred" : c.held ? "card held" : c.ownerWaits ? "card" : `card · ${c.level}`, group: c.deferred ? "deferred" : c.ownerWaits ? "asked" : "triaging" });
  return chips;
}

export const whyText = (why: string): string => why.replace(/\s(?:d-\d{8}T\d{6}Z-[0-9a-f]+|v-[0-9a-f]{6,})(?=\s|$)/g, "");

export const movedByYou = (t: BoardTask): boolean => !!t.hand?.holds;

export function unfiledCount(u: WorkBoard["projects"][number]["unfiled"]): number {
  return u.threads.length + u.prs.length + u.deliverables.length + u.cards.length;
}

