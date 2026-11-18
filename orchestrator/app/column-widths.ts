// Resizable table columns (2026-11-18, the owner: "on the open prs tab … the columns aren't individually adjustable in
// width"). Each column gets a handle on its header's right edge: drag it (mouse, pen or touch: pointer events only) to
// size that column alone, double-click it to reset that column, or focus it and use the arrow keys. Widths are kept per
// viewer in localStorage, so they survive a reload; every read and write is wrapped, and blocked storage means the
// defaults, for this visit only. The rules (parse, clamp, layout) know nothing of the DOM, so node --test checks them;
// useColumnWidths wires them to a table without JSX.
//
// The layout: a column whose width is null fills what the others leave (the Open PRs Title column until it is dragged),
// so the table looks as before until someone resizes. Once every column has a width, the table is exactly their sum,
// at least the box's width, and a trailing filler column takes any space left, so no column ever stretches away from
// the pointer. Wider than its box, the table scrolls inside the box (ui/table.tsx's container), never the page.
// A drag's right edge follows the pointer (2026-11-18, the owner: "if i drag, it opens up in the opposite direction
// versus following the direction that i'm dragging"): widening a column right of a filling one took the width from
// the filler on its left, so its left edge moved and its handle stayed put. The first drag now freezes each filling
// column at its drawn width (resizeFrom), so only the dragged column and the filler at the end change. And a drag that
// starts with the box scrolled holds the table at least as wide as the scrolled view (`hold`): narrowing a column would
// otherwise shrink the table, the browser would pull the scroll back, and the whole table would slide under the pointer.
import { useCallback, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

/** One column: its key, its header text (for the handle's label), its default width in px (null: fills), its minimum. */
export type ColumnSpec = { id: string; label: string; width: number | null; min: number };
/** The widths someone set, by column id; a missing column has its default. */
export type Widths = Record<string, number>;

/** No column is dragged wider than this (a mistaken fling across a wide screen stays recoverable). */
export const MAX_WIDTH = 1600;
/** One arrow-key press on a focused handle. */
export const KEY_STEP = 16;

export const clampWidth = (c: ColumnSpec, w: number) => Math.round(Math.min(MAX_WIDTH, Math.max(c.min, w)));

/** Stored widths for these columns: unknown ids, non-numbers and junk are dropped, the rest clamped. {} for anything malformed. */
export function parseWidths(raw: string | null, cols: ColumnSpec[]): Widths {
  try {
    const v = JSON.parse(raw ?? "{}") as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Widths = {};
    for (const c of cols) {
      const w = (v as Record<string, unknown>)[c.id];
      if (typeof w === "number" && Number.isFinite(w)) out[c.id] = clampWidth(c, w);
    }
    return out;
  } catch {
    return {};
  }
}

/** The viewer's widths; {} when storage is blocked or unreadable. */
export function loadWidths(key: string, cols: ColumnSpec[], store: Pick<Storage, "getItem"> | null = storage()): Widths {
  try {
    return parseWidths(store?.getItem(key) ?? null, cols);
  } catch {
    return {};
  }
}

/** Keep the widths; none set removes the key. A private window or blocked storage: this visit only. */
export function saveWidths(key: string, w: Widths, store: Pick<Storage, "setItem" | "removeItem"> | null = storage()) {
  try {
    if (Object.keys(w).length) store?.setItem(key, JSON.stringify(w));
    else store?.removeItem(key);
  } catch {
    // blocked storage: this visit only
  }
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * How the table is drawn from the widths. `cols`: each <col>'s width (null: fills). `filler`: a trailing empty column
 * takes the space left (every column has a width). `span`: the column count, for a full-width row's colSpan. `hold`: the
 * least width the table keeps (a drag that started scrolled), or null.
 */
export function tableLayout(cols: ColumnSpec[], widths: Widths, hold: number | null = null): { cols: (number | null)[]; filler: boolean; span: number; style: CSSProperties } {
  const ws = cols.map((c) => widths[c.id] ?? c.width);
  const fixed = ws.reduce<number>((s, w) => s + (w ?? 0), 0);
  const fills = cols.filter((_, i) => ws[i] === null);
  if (fills.length) return { cols: ws, filler: false, span: cols.length, style: { width: "100%", minWidth: fixed + fills.reduce((s, c) => s + c.min, 0) } };
  return { cols: ws, filler: true, span: cols.length + 1, style: { width: Math.max(fixed, hold ?? 0), minWidth: "100%" } };
}

/**
 * The widths with every filling column (no width set, no default) frozen at its drawn width, so no column moves when
 * another one is resized. `drawn`: each column's width as drawn now, by id.
 */
export function freeze(cols: ColumnSpec[], widths: Widths, drawn: Record<string, number>): Widths {
  const out = { ...widths };
  for (const c of cols) if (out[c.id] === undefined && c.width === null && drawn[c.id] !== undefined) out[c.id] = clampWidth(c, drawn[c.id]!);
  return out;
}

/** A drag (or arrow key) of `dx` on column `id`, which was `from` px wide when it started: its right edge follows `dx`. */
export function resizeFrom(cols: ColumnSpec[], widths: Widths, drawn: Record<string, number>, id: string, from: number, dx: number): Widths {
  const c = cols.find((x) => x.id === id);
  if (!c) return widths;
  return { ...freeze(cols, widths, drawn), [id]: clampWidth(c, from + dx) };
}

/** The props a column's resize handle spreads: role, label, cursor and the pointer, double-click and key handlers. */
export type HandleProps = {
  role: "separator";
  tabIndex: 0;
  "aria-orientation": "vertical";
  "aria-label": string;
  "aria-valuenow": number | undefined;
  "aria-valuemin": number;
  "aria-valuemax": number;
  title: string;
  "data-col-resize": string;
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
  onDoubleClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
};

/**
 * A table's column widths for one viewer, kept under `key`. A drag starts from the drawn widths (the header row the
 * handle sits in) and freezes any filling column there, so the dragged column's right edge follows the pointer; it
 * saves when the pointer lets go.
 */
export function useColumnWidths(key: string, cols: ColumnSpec[]) {
  const [widths, setWidths] = useState<Widths>(() => loadWidths(key, cols));
  const latest = useRef(widths);
  latest.current = widths;
  // the scrolled view's right edge when a drag started scrolled: the table keeps this width so the scroll never pulls back
  const [hold, setHold] = useState<number | null>(null);
  const drag = useRef<{ id: string; pointer: number; x: number; from: number; drawn: Record<string, number>; base: Widths } | null>(null);

  const set = useCallback(
    (next: Widths, save: boolean) => {
      latest.current = next;
      setWidths(next);
      if (save) saveWidths(key, next);
    },
    [key],
  );
  const reset = (c: ColumnSpec) => {
    const next = { ...latest.current };
    delete next[c.id];
    set(next, true);
  };

  const cell = (el: HTMLElement) => el.closest("th") ?? el.parentElement ?? el;
  /** Every column's drawn width, from the header row the handle sits in. */
  const drawnRow = (el: HTMLElement) => {
    const out: Record<string, number> = {};
    (el.closest("tr") ?? cell(el)).querySelectorAll<HTMLElement>("[data-col-resize]").forEach((h) => {
      out[h.dataset.colResize!] = cell(h).getBoundingClientRect().width;
    });
    return out;
  };

  const handle = (c: ColumnSpec): HandleProps => {
    const end = (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.pointer !== e.pointerId) return;
      drag.current = null;
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      saveWidths(key, latest.current);
    };
    return {
      role: "separator",
      tabIndex: 0,
      "aria-orientation": "vertical",
      "aria-label": `Resize ${c.label} column`,
      "aria-valuenow": widths[c.id] ?? c.width ?? undefined,
      "aria-valuemin": c.min,
      "aria-valuemax": MAX_WIDTH,
      title: "Drag to resize, double-click to reset",
      "data-col-resize": c.id,
      onPointerDown: (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const drawn = drawnRow(e.currentTarget);
        const box = e.currentTarget.closest("table")?.parentElement;
        setHold(box && box.scrollLeft > 0 ? Math.ceil(box.scrollLeft + box.clientWidth) : null);
        drag.current = { id: c.id, pointer: e.pointerId, x: e.clientX, from: drawn[c.id] ?? cell(e.currentTarget).getBoundingClientRect().width, drawn, base: latest.current };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      },
      onPointerMove: (e) => {
        const d = drag.current;
        if (!d || d.pointer !== e.pointerId || d.id !== c.id) return;
        set(resizeFrom(cols, d.base, d.drawn, c.id, d.from, e.clientX - d.x), false);
      },
      onPointerUp: end,
      onPointerCancel: end,
      onDoubleClick: () => reset(c),
      onKeyDown: (e) => {
        const step = e.key === "ArrowLeft" ? -KEY_STEP : e.key === "ArrowRight" ? KEY_STEP : 0;
        if (!step) return;
        e.preventDefault();
        const drawn = drawnRow(e.currentTarget);
        set(resizeFrom(cols, latest.current, drawn, c.id, drawn[c.id] ?? cell(e.currentTarget).getBoundingClientRect().width, step), true);
      },
    };
  };

  return { widths, layout: tableLayout(cols, widths, hold), handle };
}
