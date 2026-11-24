// Dragging a card on the work board (SCOPE piece 5; mockup interact), desktop only: a phone moves a card
// with "Move to" in its panel. Until the drop only the dragged card changes: its own transform and the column name
// inside it. No React state per move, no other element touched (no drop-zone highlight), so a drag restyles nothing
// else on bb's page. A press that moves less than THRESHOLD is a click, and opens the card.
import type { PointerEvent as ReactPointerEvent } from "react";
import { BOARD_COLUMNS, COLUMN_LABEL, type BoardColumn } from "../contract.ts";

const THRESHOLD = 6;

/** The column under a point, from the board's own sections. */
function columnAt(x: number, y: number): BoardColumn | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-work-board] section[data-column]");
  const c = el?.dataset.column as BoardColumn | undefined;
  return c && (BOARD_COLUMNS as readonly string[]).includes(c) ? c : null;
}

/** The board's pointerdown: starts watching a press on a card; a drag past the threshold moves the card, a drop moves the task. */
export function startCardDrag(e: ReactPointerEvent<HTMLElement>, onDrop: (task: string, to: BoardColumn) => void): void {
  if (e.button !== 0 || e.pointerType === "touch" || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const card = (e.target as HTMLElement).closest<HTMLElement>("[data-task]");
  if (!card || !e.currentTarget.contains(card)) return;
  const task = card.dataset.task!;
  const from = card.dataset.column as BoardColumn;
  const label = card.querySelector<HTMLElement>("[data-drop-label]");
  const x0 = e.clientX;
  const y0 = e.clientY;
  let dragging = false;
  let over: BoardColumn | null = from;
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (!dragging) {
      if (Math.hypot(dx, dy) < THRESHOLD) return;
      dragging = true;
      // one write to the card's own style: lifted, above the others, and transparent to the hit test under it
      card.style.cssText += ";position:relative;z-index:5;pointer-events:none;cursor:grabbing;box-shadow:0 8px 24px color-mix(in srgb, var(--foreground) 18%, transparent);";
    }
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(1deg)`;
    const col = columnAt(ev.clientX, ev.clientY);
    if (col !== over) {
      over = col;
      if (label) label.textContent = col && col !== from ? `→ ${COLUMN_LABEL[col]}` : "";
    }
  };
  const end = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
    if (!dragging) return;
    // read while the card is still transparent to the hit test, or it would find its own column
    const to = ev.type === "pointerup" ? columnAt(ev.clientX, ev.clientY) : null;
    card.style.transform = "";
    card.style.position = "";
    card.style.zIndex = "";
    card.style.pointerEvents = "";
    card.style.cursor = "";
    card.style.boxShadow = "";
    if (label) label.textContent = "";
    // the click that ends a drag (if the browser sends one) doesn't open the card; a later real click is never eaten
    const swallow = (c: MouseEvent) => {
      c.stopPropagation();
      c.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    if (to && to !== from) onDrop(task, to);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
}
