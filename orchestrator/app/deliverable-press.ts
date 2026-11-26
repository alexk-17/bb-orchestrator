// Which presses start the read of a past card before it opens (2026-11-24, lag 2; deliverable-prefetch.tsx holds the
// read). A press, never a hover: a pointer passing over rows, or a phone scrolling past them, must cost nothing.
export const PREFETCH_ATTR = "data-prefetch-deliverable";

/**
 * An event, as the press rules read it. `editable`: its target is a text field or other editable element (a reply box
 * inside a Feed post that opens a card). `onOpener`: its target is the control that opens the card itself, not
 * something inside a post or row that holds one (a reply's send button, an approve button).
 */
export type Press = { type: string; pointerType?: string; button?: number; key?: string; editable?: boolean; onOpener?: boolean };

/** True when this event is the owner pressing an opener: a mouse or pen's main button going down, a touch lifting
 *  (a touch the browser turns into a scroll ends in pointercancel, never pointerup), or Enter or Space on a focused
 *  opener. Never in an editable element: typing a reply in a post must start no read (2026-11-24, Codex review P1;
 *  test/typing-lag.test.ts: a keystroke does nothing but type). */
export function isPress(e: Press): boolean {
  if (e.editable) return false;
  if (e.type === "pointerdown") return e.button === 0 && e.pointerType !== "touch";
  if (e.type === "pointerup") return e.pointerType === "touch";
  if (e.type === "keydown") return e.onOpener === true && (e.key === "Enter" || e.key === " ");
  return false;
}
