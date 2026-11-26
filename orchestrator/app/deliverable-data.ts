// The Deliverables list's rows, put back together for the screens (2026-11-23, lag). The list read is slim
// (contract.ts deliverableRowSchema): a row in review carries its revisions, the rest only their shown revision's
// summary and first screenshot. Search and Files read every revision from the index read once it is in; a whole card
// reads its deliverable whole (useWhole in deliverables.tsx). Until then a row's revisions are what the row holds.
import type { DeliverableIndex, DeliverableRows, Deliverables } from "../contract.ts";

type Deliverable = Deliverables[number];
type Row = DeliverableRows[number];

/** Rows whose revisions were rebuilt here (no blocks, no PR state): a whole card reads the deliverable itself. */
const partial = new WeakSet<Deliverable>();
export const isPartial = (d: Deliverable) => partial.has(d);

/** One row as the screens read a deliverable: its own revisions, else the index's, else its shown revision's look. */
function expandRow(row: Row, index: Map<string, DeliverableIndex[number]> | null): Deliverable {
  const { latest, revisions, ...rest } = row;
  if (revisions) return { ...rest, revisions };
  const idx = index?.get(row.id);
  const rebuilt = idx
    ? idx.revisions.map((r) => ({ rev: r.rev, summary: r.summary, at: r.at, points: r.points, proof: r.proof.map((p) => ({ ...p, pr: null })), blocks: [], prs: [] }))
    : latest
      ? [{ rev: latest.rev, summary: latest.summary, at: latest.at, points: [], proof: latest.shot ? [latest.shot] : [], blocks: [], prs: [] }]
      : [];
  const d: Deliverable = { ...rest, revisions: rebuilt };
  partial.add(d);
  return d;
}

// the same row and index give the same object, so the screens' memos and React keys hold across renders
const memo = new WeakMap<Row, { index: DeliverableIndex | undefined; d: Deliverable }>();

/** The list's rows as Deliverables, with the index's revisions once it is loaded. */
export function expand(rows: DeliverableRows | undefined, index?: DeliverableIndex): Deliverables | undefined {
  if (!rows) return undefined;
  const byId = index ? new Map(index.map((x) => [x.id, x])) : null;
  return rows.map((row) => {
    const hit = memo.get(row);
    if (hit && hit.index === index) return hit.d;
    const d = expandRow(row, byId);
    memo.set(row, { index, d });
    return d;
  });
}
