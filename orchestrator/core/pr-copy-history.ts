import type { Ci } from "./open-prs.ts";
import { REVIEW_SECTIONS, type ReviewBucket } from "./pr-review-queue.ts";

export interface SnapshotPr {
  url: string; nodeId: string; repo: string; number: number; title: string;
  bucket: ReviewBucket | null; sha: string; review: string; approvers: string[]; ci: Ci;
}
export type CopyHistory = Partial<Record<ReviewBucket, { at: number; prs: SnapshotPr[] }>>;
export type PrStates = Record<string, "OPEN" | "CLOSED" | "MERGED">;
export interface CopyChange { url: string; repo: string; number: number; title: string; reasons: string[]; sections: ReviewBucket[] }

const normalized = (names: string[]) => [...new Set(names.map((n) => n.toLowerCase()))].sort();
export const snapshotRow = (p: SnapshotPr): SnapshotPr => ({ url: p.url, nodeId: p.nodeId, repo: p.repo, number: p.number, title: p.title, bucket: p.bucket, sha: p.sha, review: p.review, approvers: normalized(p.approvers), ci: p.ci });
export const sectionTitle = (id: ReviewBucket | null) => REVIEW_SECTIONS.find((s) => s.id === id)?.title ?? "Outside review sections";

/** Replace only what was copied, including an empty section; never mutate another section's baseline. */
export function saveCopy(history: CopyHistory, prs: SnapshotPr[], section: ReviewBucket | null, at: number): CopyHistory {
  const next = { ...history };
  for (const { id } of REVIEW_SECTIONS) {
    if (section && id !== section) continue;
    next[id] = { at, prs: prs.filter((p) => p.bucket === id).map(snapshotRow) };
  }
  return next;
}

/** Independent section baselines; coalesce a moved PR into one line when it appears in two comparisons. */
export function changesSinceCopy(history: CopyHistory, prs: SnapshotPr[], states: PrStates): CopyChange[] {
  const current = new Map(prs.map((p) => [p.url, p]));
  const known = new Map<string, SnapshotPr>();
  for (const baseline of Object.values(history).sort((a, b) => a.at - b.at)) for (const p of baseline.prs) known.set(p.url, p);
  const changes = new Map<string, CopyChange>();
  const add = (p: SnapshotPr, reasons: string[], section: ReviewBucket) => {
    if (!reasons.length) return;
    const change = changes.get(p.url) ?? { url: p.url, repo: p.repo, number: p.number, title: p.title, reasons: [], sections: [] };
    change.reasons = [...new Set([...change.reasons, ...reasons])];
    change.sections = [...new Set([...change.sections, section])];
    changes.set(p.url, change);
  };
  const compare = (old: SnapshotPr, now: SnapshotPr): string[] => [
    ...(old.bucket !== now.bucket ? [`${sectionTitle(old.bucket)} → ${sectionTitle(now.bucket)}`] : []),
    ...(old.sha !== now.sha ? ["New commits"] : []),
    ...(old.review !== now.review || JSON.stringify(normalized(old.approvers)) !== JSON.stringify(normalized(now.approvers)) ? ["Reviews changed"] : []),
    ...(old.ci !== now.ci ? [`CI: ${old.ci} → ${now.ci}`] : []),
    ...(old.title !== now.title ? ["Title changed"] : []),
  ];
  for (const { id } of REVIEW_SECTIONS) {
    const baseline = history[id];
    if (!baseline) continue; // first copy establishes a baseline, not a wall of "new" notices
    const oldUrls = new Set(baseline.prs.map((p) => p.url));
    for (const old of baseline.prs) {
      const now = current.get(old.url);
      const state = Object.hasOwn(states, old.url) ? states[old.url] : undefined;
      add(now ?? old, now ? compare(old, now) : [state === "MERGED" ? "Merged" : state === "CLOSED" ? "Closed" : state === "OPEN" ? "No longer listed (still open)" : "No longer listed (status unconfirmed)"], id);
    }
    for (const now of prs.filter((p) => p.bucket === id && !oldUrls.has(p.url))) {
      const old = known.get(now.url);
      add(now, old ? compare(old, now) : [`New PR in ${sectionTitle(id)}`], id);
    }
  }
  return [...changes.values()];
}
