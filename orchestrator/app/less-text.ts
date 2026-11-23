// Less text (2026-11-14: "the visuals and the key decisions and key findings at the top in the simplest terms
// possible"). A deliverable's card draws these parts in this order, with everything wordy under a closed Details; a
// revision without points (every deliverable sent before this) gets null and keeps the old layout. A Needs you card
// shows no prose: its PR, its question, at most one decision line and the options; the context opens from "More".
import type { Block, Point } from "../blocks.ts";

/** Blocks that are pictures: drawn with the screenshots at the top. Every other block, facts and checks included (tables of
 *  text, as the approved mock has them), goes under Details. */
export const VISUAL_KINDS: ReadonlySet<Block["kind"]> = new Set(["verdicts", "diagram", "rca"]);

export type Part = "context" | "media" | "visuals" | "points" | "review" | "details" | "history";

export interface LessText {
  /** In drawing order. Review sits above Details, so opening Details never moves Approve. */
  parts: Part[];
  /** Indices into the revision's blocks. */
  visual: number[];
  rest: number[];
  detailsLabel: string;
}

const WORD: Record<Block["kind"], string> = {
  login: "sign-in",
  steps: "steps",
  pr: "PRs",
  list: "lists",
  facts: "facts",
  checks: "checks",
  command: "commands",
  diagram: "diagram",
  decisions: "more decisions",
  changes: "changes",
  rca: "root cause",
  verdicts: "verdicts",
};

export function lessText(rev: { blocks: readonly Block[]; points?: readonly Point[]; proof: readonly { kind: string }[] }): LessText | null {
  if (!rev.points?.length) return null;
  const visual: number[] = [];
  const rest: number[] = [];
  rev.blocks.forEach((b, i) => (VISUAL_KINDS.has(b.kind) ? visual : rest).push(i));
  const files = rev.proof.filter((p) => p.kind !== "image" && p.kind !== "video").length;
  const inside = [...new Set(rest.map((i) => { const b = rev.blocks[i]!; return ("title" in b && b.title) || WORD[b.kind]; }))];
  if (files > 0) inside.push(`${files} file${files === 1 ? "" : "s"}`);
  const parts: Part[] = ["context", "media", "visuals", "points", "review"];
  if (inside.length > 0) parts.push("details");
  parts.push("history");
  return { parts, visual, rest, detailsLabel: `Details: ${inside.join(", ")}` };
}

/**
 * A card's blocks split for drawing (2026-11-14: no clipped prose on cards): its PRs first (chip, live state, a one-line
 * verdict); decisions behind "More" with the context, one of them shown as the card's single line; the rest (sign-ins,
 * steps, lists, commands: what the owner acts on) after. Indices stay those of `blocks`, so a list's unticking holds.
 */
export function cardBlockOrder(blocks: readonly Block[]): { lead: number[]; more: number[]; after: number[]; line: string | null } {
  const lead: number[] = [];
  const more: number[] = [];
  const after: number[] = [];
  blocks.forEach((b, i) => (b.kind === "pr" ? lead : b.kind === "decisions" ? more : after).push(i));
  const items = more.flatMap((i) => (blocks[i] as Extract<Block, { kind: "decisions" }>).items);
  const pick = items.find((d) => d.status === "needs_you") ?? items[0];
  return { lead, more, after, line: pick?.text ?? null };
}

/**
 * Whether two lines say the same thing (case, spaces and a closing ? or . aside). A phone's Needs you card says its
 * question once: not again under a title that already is it (2026-11-21, the owner: "very cluttered").
 */
export function sameText(a: string, b: string): boolean {
  const n = (x: string) => x.trim().replace(/\s+/g, " ").replace(/[?.!]+$/, "").toLowerCase();
  return n(a) === n(b);
}

/** Markdown's marks off, for a phone's closed deliverable, whose summary is clamped to two lines (the opened card draws the Markdown). */
export function plainSummary(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
