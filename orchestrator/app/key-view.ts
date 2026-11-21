// A list view's keyboard hookup: J/K select a card, the selection is drawn (data-selected, an outline: nothing moves, so
// the double-tap arming is not restarted), and the view's own keys run on the drawn DOM, by clicking the buttons the mouse
// would click, so the write gate, the arming, notes and ticked lists all stay in force.
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { resolveSelection, step, type Action } from "./keys.ts";
import { emitKeys, keyState, registerKeys, say, selKey, selOf, useKeys, usePaneId } from "./key-state.ts";

export type Item = { el: HTMLElement; id: string };

/** `list`: which cards J/K walk (the drawn order). `idOf`: a card's id. `more`: the view's own keys; it gets the selected card. */
export function useViewKeys(view: string, root: RefObject<HTMLElement | null>, list: string, idOf: (el: HTMLElement) => string, more: (a: Action, sel: Item | null) => boolean) {
  useKeys(); // draw again when the selection or a pick changes
  const pane = usePaneId();
  const items = (): Item[] => Array.from(root.current?.querySelectorAll<HTMLElement>(list) ?? []).map((el) => ({ el, id: idOf(el) }));
  const selected = (): Item | null => {
    const all = items();
    const s = selOf(pane, view);
    const r = resolveSelection(all.map((i) => i.id), s.id, s.index);
    return all.find((i) => i.id === r.id) ?? null;
  };

  // draw the selection, and the numbers on its answers
  useLayoutEffect(() => {
    const all = items();
    const s = selOf(pane, view);
    const r = resolveSelection(all.map((i) => i.id), s.id, s.index);
    keyState.sel[selKey(pane, view)] = r;
    for (const i of all) {
      const on = i.id === r.id;
      if (on) i.el.setAttribute("data-selected", "");
      else i.el.removeAttribute("data-selected");
      i.el.querySelectorAll<HTMLElement>("[data-option]").forEach((b, n) => (on && n < 4 ? b.setAttribute("data-key", String(n + 1)) : b.removeAttribute("data-key")));
    }
  });

  const ref = useRef(more);
  ref.current = more;
  useEffect(
    () =>
      registerKeys(pane, (a) => {
        if (a.t === "move") {
          const all = items();
          const s = selOf(pane, view);
          const cur = resolveSelection(all.map((i) => i.id), s.id, s.index).id;
          const id = step(all.map((i) => i.id), cur, a.dir);
          if (id === null) return false;
          keyState.sel[selKey(pane, view)] = { id, index: all.findIndex((i) => i.id === id) };
          keyState.arm = null;
          keyState.note = null;
          emitKeys();
          all.find((i) => i.id === id)?.el.scrollIntoView({ block: "nearest", behavior: "smooth" });
          return true;
        }
        const sel = selected();
        if (!sel) {
          if (a.t === "send") return false;
          say("Select a card first: J / K");
          return true;
        }
        return ref.current(a, sel);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pane, view],
  );
}
