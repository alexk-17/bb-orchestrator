// A project's head fits its room (2026-11-20, 1.36.1, the lead: "the message box must be whole without scrolling").
// The head is the name row, the lead's profile card and the chat card: the chat's row, an open transcript and the
// message box. Only the transcript gives way, so its height is measured, never guessed. The rest of the head is
// measured (the head's height less the transcript's), the room is measured, and the transcript gets what is left.
// - Wide (the detail beside the list), the room is two thirds of the detail, so the cards below keep at least a third.
// - On its own page (a narrow pane, a phone), the room is the pane's visible height below the head's top.
// The transcript is never under 48 px or over 480 px. When the room is shorter than the rest plus 48 px, the head
// scrolls, and projects.tsx keeps the message box stuck to the bottom of the visible part.
import { useEffect, useRef } from "react";

export const TRANSCRIPT_MIN = 48;
export const TRANSCRIPT_MAX = 480;
/** The share of the detail's height the head may take, wide: the cards keep the rest (at least a third). */
export const HEAD_SHARE = 2 / 3;

/** The transcript's height: the room less the rest of the head, between 48 and 480 px. */
export const transcriptFit = (rest: number, room: number): number => Math.round(Math.max(TRANSCRIPT_MIN, Math.min(TRANSCRIPT_MAX, room - rest)));

/** The open chat's transcript in a head: the lead's thread, else the direct-message log. */
const TRANSCRIPT = ".k-chat > :is(.k-leadthread, .k-chat__log)";

/**
 * The head's ref. It sets `--k-transcript-h` on the head whenever the head, its parts or its room change size; the
 * CSS gives that height to the open transcript. Writing the same height again changes nothing, so it settles in one pass.
 */
export function useHeadFit<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const head = ref.current;
    if (!head || typeof ResizeObserver !== "function") return;
    // wide is the layout that fits the pane (projects.tsx [data-fits-pane]); read each time, as a resize can switch it
    const fit = () => {
      const wide = !!head.closest("[data-fits-pane]");
      const t = head.querySelector<HTMLElement>(TRANSCRIPT);
      const rest = head.scrollHeight - (t ? t.offsetHeight : 0);
      let room: number;
      if (wide) {
        // two thirds of the detail, less the gap between the head and the cards: the cards keep a whole third
        const detail = head.parentElement;
        room = detail ? detail.clientHeight * HEAD_SHARE - (parseFloat(getComputedStyle(detail).rowGap) || 0) : 0;
      } else {
        const pane = head.closest<HTMLElement>(".orch-pane__scroll");
        const top = pane ? head.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop : head.getBoundingClientRect().top + scrollY;
        room = (pane ? pane.clientHeight : innerHeight) - top;
      }
      const h = `${transcriptFit(rest, room)}px`;
      if (head.style.getPropertyValue("--k-transcript-h") !== h) head.style.setProperty("--k-transcript-h", h);
    };
    const ro = new ResizeObserver(fit);
    const watch = () => {
      ro.disconnect();
      ro.observe(head);
      for (const c of Array.from(head.children)) ro.observe(c);
      for (const room of [head.parentElement, head.closest(".orch-pane__scroll")]) if (room) ro.observe(room);
    };
    // a part coming or going (the chat opening mounts its transcript inside a part, which resizes it)
    const mo = new MutationObserver(() => {
      watch();
      fit();
    });
    mo.observe(head, { childList: true });
    watch();
    fit();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);
  return ref;
}
