// Drag to dock (feel spec part 3): a pane by its header, or a Sidebar item, dropped on a pane's edge or centre. Pointer events, no library.
import type { Edge } from "./layout.ts";
import { PORTAL } from "./ui/utils.ts";

/** Within this share of a pane's nearest edge the drop is that edge; deeper in, the centre. */
export const EDGE_SHARE = 0.3;
/** A press moves this far before it is a drag, so a click stays a click. */
export const DRAG_PX = 6;
/** A zone changes only once the pointer is this far into the next one, so the preview never flickers at a boundary. */
export const DEAD_BAND = 8;
/** On touch, a Sidebar row drags after a press this long that moves less than LONG_PRESS_PX. */
export const LONG_PRESS_MS = 400;
export const LONG_PRESS_PX = 8;
/** The ghost's top-left sits this far right of and below the pointer. */
export const GHOST_OFFSET = 12;

/** The ghost's top-left for a pointer at (x, y): right of and below it, or left of and above it where the window ends. */
export function ghostAt(x: number, y: number, w: number, h: number, vw: number, vh: number): { left: number; top: number } {
  const left = x + GHOST_OFFSET + w <= vw ? x + GHOST_OFFSET : x - GHOST_OFFSET - w;
  const top = y + GHOST_OFFSET + h <= vh ? y + GHOST_OFFSET : y - GHOST_OFFSET - h;
  return { left: Math.max(0, left), top: Math.max(0, top) };
}

/** The drop zone at (fx, fy), each a 0..1 share of the pane's width and height. */
export function edgeAt(fx: number, fy: number): Edge {
  const d: Record<Exclude<Edge, "center">, number> = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  const near = (Object.keys(d) as (keyof typeof d)[]).reduce((a, b) => (d[a] <= d[b] ? a : b));
  return d[near] > EDGE_SHARE ? "center" : near;
}

/**
 * The zone at (x, y) in a w × h pane, given the zone it was in: an edge that `can` refuses is the centre, and a change
 * needs the pointer DEAD_BAND px clear of the boundary.
 */
export function zoneAt(x: number, y: number, w: number, h: number, prev: Edge | null, can: (e: Edge) => boolean): Edge {
  const raw = (px: number, py: number) => {
    const e = edgeAt(Math.min(Math.max(px, 0), w) / w, Math.min(Math.max(py, 0), h) / h);
    return e !== "center" && !can(e) ? "center" : e;
  };
  const now = raw(x, y);
  if (prev === null || now === prev) return now;
  const d = DEAD_BAND;
  const around: [number, number][] = [[x - d, y], [x + d, y], [x, y - d], [x, y + d]];
  return around.every(([px, py]) => raw(px, py) === now) ? now : prev;
}

type Box = { left: number; top: number; width: number; height: number };
/** The part of a pane the preview covers, inset 4 px: the half for an edge, the whole for the centre. */
export function zoneRect(r: Box, edge: Edge): Box {
  const { left, top, width, height } = r;
  const z =
    edge === "left" ? { left, top, width: width / 2, height }
    : edge === "right" ? { left: left + width / 2, top, width: width / 2, height }
    : edge === "top" ? { left, top, width, height: height / 2 }
    : edge === "bottom" ? { left, top: top + height / 2, width, height: height / 2 }
    : r;
  return { left: z.left + 4, top: z.top + 4, width: z.width - 8, height: z.height - 8 };
}

export type DragSource = {
  /** The ghost's words and icon: the page's title and its Sidebar icon */
  label: string;
  icon?: Element | null;
  /** Dimmed to 50% while dragging: the pane, or the Sidebar row */
  dim?: HTMLElement | null;
  /** The dragged pane: not a target */
  self?: string | null;
  /** May this edge be offered? An edge whose result would not fit is not: that part of the pane is then the centre. */
  can: (target: string, edge: Edge) => boolean;
  /** What a drop there does, in a few words: the preview's label */
  says: (target: string, edge: Edge) => string;
  /** A pane that is one zone (the picker's waiting pane) */
  whole?: (target: string) => boolean;
  onStart?: () => void;
  /** The pointer came over this pane; true when that changed the layout, so the panes are measured again */
  onEnter?: (target: string) => boolean;
  onDrop: (target: string, edge: Edge) => void;
  /** On touch, start after a long press (Sidebar rows), not after a move */
  longPress?: boolean;
  /** The element whose cursor is grabbing from the press, before the drag starts (a pane header) */
  grab?: HTMLElement | null;
};

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A press on a source: past DRAG_PX (or a long press on touch) it drags a ghost and a preview over the panes in `box`. */
export function dragFrom(e: { clientX: number; clientY: number; pointerId: number; button: number; pointerType: string }, box: HTMLElement | null, src: DragSource) {
  if (!box || (e.pointerType === "mouse" && e.button !== 0)) return;
  const html = document.documentElement;
  const x0 = e.clientX;
  const y0 = e.clientY;
  let x = x0;
  let y = y0;
  let on = false;
  let cancelled = false;
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // one fixed layer over the whole window while dragging: its cursor is the page's, nothing under it hovers or selects,
  // and the ghost and preview inside it move without laying out or restyling the page
  let cover: HTMLDivElement | null = null;
  let ghost: HTMLDivElement | null = null;
  let preview: HTMLDivElement | null = null;
  let label: HTMLSpanElement | null = null;
  let size: { w: number; h: number } | null = null;
  let hints: HTMLElement[] = [];
  let shown = false;
  let hit: { target: string; edge: Edge } | null = null;
  let entered: string | null = null;
  // pane frames are read once, and again only when the layout moves them
  let rects: { id: string; r: DOMRect }[] = [];
  let stale = true;
  const mo = new MutationObserver(() => (stale = true));
  const measure = () => {
    rects = Array.from(box.querySelectorAll<HTMLElement>("[data-pane]"))
      .map((f) => ({ id: f.dataset.pane ?? "", r: f.getBoundingClientRect() }))
      .filter((f) => f.r.width > 0);
    stale = false;
  };

  /** "grab" over a target, "no" elsewhere: the cover's cursor, and the page's state for its checks */
  const over = (v: "grab" | "no") => {
    html.setAttribute("data-orch-drag", v);
    if (cover) cover.style.cursor = v === "grab" ? "grabbing" : "not-allowed";
  };
  const begin = () => {
    on = true;
    src.onStart?.();
    window.getSelection()?.removeAllRanges();
    if (src.grab) src.grab.style.cursor = "";
    if (src.dim) src.dim.style.opacity = "0.5";
    cover = document.createElement("div");
    cover.dataset.dragCover = "";
    // bb scopes the plugin's styles to these marks, so outside the plugin's root the preview would have no fill
    for (const [k, v] of Object.entries(PORTAL)) cover.setAttribute(k, v);
    Object.assign(cover.style, { position: "fixed", inset: "0", zIndex: "2147483647", contain: "strict", userSelect: "none", touchAction: "none" });
    ghost = document.createElement("div");
    ghost.dataset.dockGhost = "";
    ghost.className = "pointer-events-none absolute top-0 left-0 flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground shadow-md [&_svg]:size-4 [&_svg]:shrink-0";
    if (src.icon) ghost.append(src.icon.cloneNode(true));
    ghost.append(document.createTextNode(src.label));
    preview = document.createElement("div");
    preview.dataset.dockPreview = "";
    preview.className = "pointer-events-none absolute rounded-md border-2 border-primary bg-primary/10";
    Object.assign(preview.style, { display: "none", contain: "layout paint" });
    label = document.createElement("span");
    label.className = "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md border bg-background px-2 py-1 text-xs font-medium whitespace-nowrap text-foreground shadow-sm";
    preview.append(label);
    cover.append(preview, ghost);
    document.body.append(cover);
    // the one-time hint would sit over the panes it explains; it comes back when the drag ends
    hints = Array.from(document.querySelectorAll<HTMLElement>("[data-drag-hint]"));
    for (const h of hints) h.style.visibility = "hidden";
    over("no");
    // the panes' own frames and the set of panes, not what changes inside a pane
    mo.observe(box, { childList: true });
    box.querySelectorAll("[data-pane]").forEach((p) => mo.observe(p, { attributes: true, attributeFilter: ["style"] }));
    draw();
  };

  // once per animation frame: the ghost follows by transform; the zone and the preview change in the same frame
  const draw = () => {
    frame = 0;
    if (!on || !ghost || !preview || !label) return;
    ghost.style.transform = place(x, y);
    if (cancelled) return;
    if (stale) measure();
    const f = rects.find((p) => x >= p.r.left && x <= p.r.right && y >= p.r.top && y <= p.r.bottom);
    if (!f || f.id === src.self) {
      hit = null;
      preview.style.display = "none";
      over("no");
      return;
    }
    if (f.id !== entered) {
      entered = f.id;
      hit = null;
      if (src.onEnter?.(f.id)) {
        stale = true;
        preview.style.display = "none";
        return void (frame = requestAnimationFrame(draw));
      }
    }
    const edge = src.whole?.(f.id) ? "center" : zoneAt(x - f.r.left, y - f.r.top, f.r.width, f.r.height, hit?.target === f.id ? hit.edge : null, (g) => src.can(f.id, g));
    hit = { target: f.id, edge };
    over("grab");
    const z = zoneRect(f.r, edge);
    preview.dataset.dockPreview = `${f.id}:${edge}`;
    label.textContent = src.says(f.id, edge);
    Object.assign(preview.style, { display: "", left: `${z.left}px`, top: `${z.top}px`, width: `${z.width}px`, height: `${z.height}px` });
    if (!shown) {
      shown = true;
      if (!reduced()) preview.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 80, easing: "ease-out" });
    }
  };
  const place = (px: number, py: number) => {
    if (ghost && !size) size = { w: ghost.offsetWidth, h: ghost.offsetHeight };
    const g = ghostAt(px, py, size?.w ?? 0, size?.h ?? 0, window.innerWidth, window.innerHeight);
    return `translate(${g.left}px, ${g.top}px)`;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };

  const swallow = (ev: Event) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  // a text selection left by an earlier drag would start the browser's own drag, which cancels the pointer
  const noNative = (ev: Event) => ev.preventDefault();
  const noScroll = (ev: TouchEvent) => {
    if (on && ev.cancelable) ev.preventDefault();
  };
  const noMenu = (ev: Event) => {
    if (on || src.longPress) ev.preventDefault();
    if (on && e.pointerType === "mouse") cancel();
  };

  // the cover stops taking the pointer at once, and goes when its last animation ends
  let fading = 0;
  const release = () => {
    const c = cover;
    if (!c) return;
    Object.assign(c.style, { pointerEvents: "none", cursor: "" });
    if (!fading) {
      c.remove();
      if (cover === c) cover = null;
    }
  };
  const fade = (el: HTMLElement, frames: Keyframe[], ms: number, easing: string) => {
    fading++;
    el.animate(frames, { duration: ms, easing, fill: "forwards" }).onfinish = () => {
      el.remove();
      if (--fading === 0 && cover?.style.pointerEvents === "none") release();
    };
  };
  /** Back where the drag began, fading, then gone; at once with reduced motion. */
  const sendBack = () => {
    const g = ghost;
    ghost = null;
    if (!g) return;
    if (reduced()) return g.remove();
    fade(g, [{ transform: g.style.transform, opacity: 1 }, { transform: place(x0, y0), opacity: 0 }], 150, "ease-in");
  };
  const hidePreview = (out: boolean) => {
    const p = preview;
    preview = null;
    if (!p) return;
    if (!out || reduced() || p.style.display === "none") return p.remove();
    fade(p, [{ opacity: 1 }, { opacity: 0 }], 100, "ease-out");
  };
  /** Esc, a right click, the window losing focus: nothing changes; the drag still ends at the release. */
  const cancel = () => {
    if (!on || cancelled) return;
    cancelled = true;
    hit = null;
    sendBack();
    hidePreview(false);
    if (src.dim) src.dim.style.opacity = "";
    html.removeAttribute("data-orch-drag");
    release();
  };
  const end = () => {
    clearTimeout(timer);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    mo.disconnect();
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", lost, true);
    window.removeEventListener("pointerdown", other, true);
    window.removeEventListener("keydown", esc, true);
    window.removeEventListener("dragstart", noNative, true);
    window.removeEventListener("blur", lost);
    window.removeEventListener("contextmenu", noMenu, true);
    window.removeEventListener("touchmove", noScroll);
    if (src.dim) src.dim.style.opacity = "";
    if (src.grab) src.grab.style.cursor = "";
    html.removeAttribute("data-orch-drag");
    release();
    // after the drop's own render, so a hint the first drop retires never shows again for a frame
    const back = hints;
    hints = [];
    if (back.length) requestAnimationFrame(() => back.forEach((h) => (h.style.visibility = "")));
    if (on) {
      // the release makes a click on whatever is under it; it is the drag's, not a press
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    }
  };

  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    // a right button pressed during the drag comes as a move with that button down
    if (on && ev.buttons & 2) return cancel();
    x = ev.clientX;
    y = ev.clientY;
    if (!on) {
      const d = Math.hypot(x - x0, y - y0);
      // on touch a press that moves before the long press is a scroll
      if (src.longPress && e.pointerType !== "mouse") return void (d > LONG_PRESS_PX && end());
      if (d < DRAG_PX) return;
      begin();
    }
    ev.preventDefault();
    schedule();
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    const drop = on && !cancelled ? hit : null;
    if (on && !cancelled) {
      if (drop) {
        ghost?.remove();
        ghost = null;
        hidePreview(true);
      } else {
        sendBack();
        hidePreview(false);
      }
    }
    end();
    if (drop) src.onDrop(drop.target, drop.edge);
  };
  const lost = () => {
    cancel();
    end();
  };
  const other = (ev: PointerEvent) => {
    if (on && ev.button === 2) cancel();
  };
  const esc = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !on) return;
    ev.preventDefault();
    ev.stopPropagation();
    cancel();
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", lost, true);
  window.addEventListener("pointerdown", other, true);
  window.addEventListener("keydown", esc, true);
  window.addEventListener("dragstart", noNative, true);
  window.addEventListener("blur", lost);
  window.addEventListener("contextmenu", noMenu, true);
  if (e.pointerType !== "mouse") window.addEventListener("touchmove", noScroll, { passive: false });
  if (src.grab && e.pointerType === "mouse") src.grab.style.cursor = "grabbing";
  if (src.longPress && e.pointerType !== "mouse")
    timer = setTimeout(() => {
      begin();
      schedule();
    }, LONG_PRESS_MS);
}
