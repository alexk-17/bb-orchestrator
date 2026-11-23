// The Orchestrator page's content: a split tree of panes (split panes, 2026-11-20); the Sidebar acts on the focused pane.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Columns2, GripVertical, Rows2, X } from "lucide-react";
import { gripsAt, minSize, panes, type Edge, type Layout, type Node, type Pane } from "./layout.ts";
import { dragFrom } from "./drag.ts";
import { Card } from "./ui/card.tsx";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./ui/resizable.tsx";
import { cn } from "./ui/utils.ts";
import type { Route } from "./route.ts";
import { PaneContext } from "./key-state.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import { Button } from "./ui/button.tsx";
import { Btn, cx } from "./ui.tsx";

/**
 * A view that lays out its own scroll regions tells its pane so (2026-11-20). This replaces a has-selector rule on the
 * pane's scroller: any element added or removed inside the pane (each keystroke in a reply box) made the browser re-check
 * that rule and restyle the whole pane, a few hundred ms per key on a big Projects page.
 */
const PaneFits = createContext<(delta: 1 | -1) => void>(() => {});
/** Each view that asks counts once (2026-11-22): Projects and the Scope page open inside it both ask, and the Scope
 * page closing must not switch it off for Projects, which left the list a strip one row tall. */
export function usePaneFits(on: boolean) {
  const add = useContext(PaneFits);
  useLayoutEffect(() => {
    if (!on) return;
    add(1);
    return () => add(-1);
  }, [on, add]);
}

export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

export function useSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e!.contentRect.width), h: Math.round(e!.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/**
 * The tab's own width. Observed through a callback ref: the tab first renders its loading state without this element,
 * so an effect keyed on a ref object would never see it, and narrow-panel items (Ask for status, Start lead in ⋯) never showed.
 */
export function useElementWidth(): [number, (el: HTMLElement | null) => void] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [w, setEl];
}

type Props = {
  layout: Layout;
  /** Only the focused pane is drawn (a phone, or a tree that doesn't fit), with a switcher to the others */
  solo: boolean;
  /** A pane header's title: where the pane is */
  title: (route: Route) => string;
  render: (pane: { id: string; route: Route; width: number }) => ReactNode;
  /** Views that fill the pane themselves (the chat): no padding, no page scroll */
  fill: (view: string) => boolean;
  /** Views that use the pane's whole width (Projects, layout B: the list beside the project), not the reading column */
  wide?: (view: string) => boolean;
  onFocus: (paneId: string) => void;
  onClose: (paneId: string) => void;
  /** Split right or down: `from` is the button pressed, where the focus goes back on a cancel */
  onSplit: (paneId: string, dir: "row" | "col", from: HTMLElement) => void;
  /** The page's icon, for the header's view control */
  icon: (route: Route) => ReactNode;
  /** The header's view control was pressed: open (or close) the picker over that pane */
  onView: (paneId: string, from: HTMLElement) => void;
  /** A split's new pane, waiting for a pick: no body, a "New pane" header with a cancel */
  pending?: string | null;
  /** The view picker, drawn over one pane's body */
  overlay?: { paneId: string; node: ReactNode } | null;
  onCancelPending?: () => void;
  onSizes: (splitId: string, sizes: number[]) => void;
  /** A pane dragged by its header onto an edge or the centre of another */
  onDock: (paneId: string, targetId: string, edge: Edge) => void;
  /** Would that dock fit? An edge that wouldn't is not offered */
  canDock: (paneId: string, targetId: string, edge: Edge) => boolean;
  /** A pane drag began: a split waiting for a pick is cancelled */
  onDragStart?: () => void;
  /** Set just before a drop's commit: the panes that slide from where they were, or the new pane that fades in */
  settle?: RefObject<Settle | null>;
  /** The one-time drag hint, while two panes are drawn */
  hint?: boolean;
  onHintDone?: () => void;
};

export type Settle = { ids: string[]; kind: "move" | "new" };

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The tree draws empty slots and each pane is a keyed sibling laid over its slot, so no layout change remounts or moves it. */
export function PaneLayout(p: Props) {
  const all = panes(p.layout.root);
  const box = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const ro = useRef<ResizeObserver | null>(null);
  const place = useCallback(() => {
    const b = box.current;
    if (!b) return;
    const o = b.getBoundingClientRect();
    for (const [id, el] of els.current) {
      const slot = b.querySelector<HTMLElement>(`[data-pane-slot="${CSS.escape(id)}"]`);
      if (!slot) {
        el.style.display = "none";
        continue;
      }
      const r = slot.getBoundingClientRect();
      Object.assign(el.style, { display: "", left: `${r.left - o.left}px`, top: `${r.top - o.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    }
  }, []);
  // when the tree changes it may move a slot without resizing it; sizes alone come through the ResizeObserver, so a commit
  // that changes no tree (the picker opening) forces no layout here
  useLayoutEffect(() => {
    const s = p.settle?.current;
    const from = new Map((s?.kind === "move" ? s.ids : []).map((id) => [id, els.current.get(id)?.style] as const).map(([id, st]) => [id, { l: parseFloat(st?.left ?? ""), t: parseFloat(st?.top ?? "") }]));
    place();
    if (s && p.settle) {
      p.settle.current = null;
      if (!reducedMotion())
        for (const id of s.ids) {
          const el = els.current.get(id);
          const a = from.get(id);
          if (!el) continue;
          // timed from this commit, so a slow first frame (a page mounting) shortens the settle instead of delaying it
          const now = document.timeline.currentTime;
          let anim: Animation | null = null;
          if (s.kind === "new") anim = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "ease-out" });
          else if (a && Number.isFinite(a.l) && Number.isFinite(a.t)) {
            const dx = a.l - parseFloat(el.style.left);
            const dy = a.t - parseFloat(el.style.top);
            if (dx || dy) anim = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" });
          }
          if (anim && now !== null) anim.startTime = now;
        }
    }
    const b = box.current;
    if (!b) return;
    ro.current ??= new ResizeObserver(place);
    ro.current.disconnect();
    ro.current.observe(b);
    b.querySelectorAll("[data-pane-slot]").forEach((s) => ro.current!.observe(s));
    // the panels settle their sizes in a render of their own after this effect; follow them before the frame, not a frame late
    queueMicrotask(place);
  }, [p.layout.root, p.solo, p.solo ? p.layout.focus : null, place]);
  useEffect(() => () => ro.current?.disconnect(), []);
  // the library's own cursor is a page-wide rule that restyles every element on each change (S10); this layer holds it instead
  useEffect(() => {
    const b = box.current;
    if (!b) return;
    let cover: HTMLDivElement | null = null;
    const active = () => Array.from(b.querySelectorAll<HTMLElement>('[data-separator="active"]'));
    const off = () => {
      window.removeEventListener("pointermove", show, true);
      cover?.remove();
      cover = null;
    };
    // from the first move, so a press or a double-click keeps the divider as its target
    const show = () => {
      if (cover) return;
      const on = active();
      if (!on.length) return off();
      const dirs = new Set(on.map((s) => s.getAttribute("aria-orientation")));
      cover = document.createElement("div");
      cover.dataset.resizeCover = "";
      Object.assign(cover.style, { position: "fixed", inset: "0", zIndex: "2147483647", contain: "strict", cursor: dirs.size > 1 ? "move" : dirs.has("horizontal") ? "row-resize" : "col-resize" });
      document.body.append(cover);
    };
    const mo = new MutationObserver(() => (active().length ? window.addEventListener("pointermove", show, true) : off()));
    mo.observe(b, { subtree: true, attributes: true, attributeFilter: ["data-separator"] });
    window.addEventListener("pointerup", off, true);
    window.addEventListener("pointercancel", off, true);
    window.addEventListener("blur", off);
    return () => {
      mo.disconnect();
      off();
      window.removeEventListener("pointerup", off, true);
      window.removeEventListener("pointercancel", off, true);
      window.removeEventListener("blur", off);
    };
  }, []);
  const hold = useCallback((id: string, el: HTMLElement | null) => {
    if (el) els.current.set(id, el);
    else els.current.delete(id);
  }, []);
  // one pane drawn (a phone, or the switcher): no header; the switcher row names it and closes it
  const many = all.length > 1 && !p.solo;
  const at = Math.max(0, all.findIndex((x) => x.id === p.layout.focus));
  const step = (d: number) => p.onFocus(all[(at + d + all.length) % all.length]!.id);
  const drag = (e: ReactPointerEvent, pane: Pane) => {
    const el = els.current.get(pane.id) ?? null;
    const name = (id: string) => p.title(all.find((x) => x.id === id)?.route ?? pane.route);
    dragFrom(e, box.current, {
      label: p.title(pane.route),
      icon: el?.querySelector("[data-view-icon] svg"),
      dim: el,
      self: pane.id,
      grab: e.currentTarget as HTMLElement,
      can: (t, edge) => p.canDock(pane.id, t, edge),
      says: (t, edge) => (edge === "center" ? `Swap with ${name(t)}` : "Move here"),
      onStart: p.onDragStart,
      onDrop: (t, edge) => p.onDock(pane.id, t, edge),
    });
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* panes that don't fit: one at a time, the tree kept as it is */}
      {p.solo && all.length > 1 ? (
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1" data-pane-switcher="">
          <Btn tone="ghost" size="sm" icon={<ChevronLeft />} aria-label="Previous pane" data-switch="prev" onClick={() => step(-1)} />
          <span className="text-sm tabular-nums">
            {at + 1} of {all.length}
          </span>
          <Btn tone="ghost" size="sm" icon={<ChevronRight />} aria-label="Next pane" data-switch="next" onClick={() => step(1)} />
          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{p.title(all[at]!.route)}</span>
          <PaneAction label="Close" icon={<X />} data-close-pane="" onClick={() => p.onClose(all[at]!.id)} />
        </div>
      ) : null}
      <div ref={box} className="relative flex min-h-0 min-w-0 flex-1" data-panes="">
        {p.solo ? <div data-pane-slot={p.layout.focus} className="min-h-0 min-w-0 flex-1" /> : <NodeView node={p.layout.root} onSizes={p.onSizes} />}
        {all.map((pane) => (
          <PaneView key={pane.id} pane={pane} {...p} focused={p.layout.focus === pane.id} many={many} hold={hold} grip={(e) => drag(e, pane)} />
        ))}
        {p.hint && many ? (
          <Card className="absolute bottom-4 left-1/2 z-30 w-[min(560px,calc(100%-32px))] -translate-x-1/2 flex-row items-center gap-3 px-4 py-3 shadow-md" data-drag-hint="">
            <GripVertical className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 text-sm">
              <p>Drag a pane by its header to move it.</p>
              <p>Drag a page from the sidebar into a pane.</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={p.onHintDone} data-hint-done="">
              Got it
            </Button>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

// the gutter between panes: muted, a line on each side, shadcn's grip; hover, focus and drag light its centre line
const GUTTER_CLASS = cn(
  "z-10 bg-muted transition-colors duration-100 before:absolute before:bg-transparent before:transition-colors before:duration-100",
  "data-[separator=hover]:bg-accent data-[separator=focus]:bg-accent data-[separator=active]:bg-accent",
  "data-[separator=hover]:before:bg-primary/40 data-[separator=focus]:before:bg-primary/40 data-[separator=active]:before:bg-primary",
  "[&>div]:transition-colors [&>div]:duration-100 data-[separator=hover]:[&>div]:bg-background data-[separator=hover]:[&>div]:text-foreground data-[separator=focus]:[&>div]:bg-background data-[separator=focus]:[&>div]:text-foreground",
  "data-[separator=active]:[&>div]:border-primary data-[separator=active]:[&>div]:bg-primary data-[separator=active]:[&>div]:text-primary-foreground",
);
// the grip sits at --grip-at along the gutter, off any junction with a crossing gutter
const GUTTER_ROW = "cursor-col-resize [&>div]:absolute [&>div]:top-(--grip-at) [&>div]:left-1/2 [&>div]:-translate-x-1/2 [&>div]:-translate-y-1/2 w-2 border-x border-border before:inset-y-0 before:left-1/2 before:w-0.5 before:-translate-x-1/2 after:w-3 [@media(pointer:coarse)]:after:w-6";
const GUTTER_COL =
  "cursor-row-resize [&>div]:absolute [&>div]:top-1/2 [&>div]:left-(--grip-at) [&>div]:-translate-x-1/2 [&>div]:-translate-y-1/2 border-y border-border aria-[orientation=horizontal]:h-2 before:inset-x-0 before:top-1/2 before:h-0.5 before:-translate-y-1/2 aria-[orientation=horizontal]:after:h-3 [@media(pointer:coarse)]:aria-[orientation=horizontal]:after:h-6";

function NodeView({ node, onSizes }: { node: Node; onSizes: Props["onSizes"] }) {
  if (node.kind === "pane") return <div data-pane-slot={node.id} className="h-full min-h-0 w-full min-w-0" />;
  const row = node.dir === "row";
  const along = (c: Node) => (row ? minSize(c).w : minSize(c).h);
  const grips = gripsAt(node);
  return (
    <ResizablePanelGroup
      // a new set of children starts from the tree's sizes; a drag only reports back
      key={node.children.map((c) => c.id).join(",")}
      id={node.id}
      orientation={row ? "horizontal" : "vertical"}
      disableCursor
      defaultLayout={Object.fromEntries(node.children.map((c, i) => [c.id, node.sizes[i]! * 100]))}
      onLayoutChanged={(layout, meta) => {
        if (meta.isUserInteraction) onSizes(node.id, node.children.map((c) => layout[c.id] ?? 0));
      }}
    >
      {node.children.flatMap((c, i) => [
        // above the panes laid over the slots: a 12 px hit area, 24 px on touch (feel spec, part 2)
        i > 0 ? <ResizableHandle key={`d-${c.id}`} withHandle data-divider="" className={cn(GUTTER_CLASS, row ? GUTTER_ROW : GUTTER_COL)} style={{ "--grip-at": `${grips[i - 1]! * 100}%` } as CSSProperties} /> : null,
        <ResizablePanel key={c.id} id={c.id} minSize={along(c)} defaultSize={`${100 / node.children.length}%`} className="flex min-h-0 min-w-0">
          <NodeView node={c} onSizes={onSizes} />
        </ResizablePanel>,
      ])}
    </ResizablePanelGroup>
  );
}

/**
 * Its children one frame later, in a render of their own: the picker's DOM then lands after the split's (or the press's)
 * layout and its pages' own measuring, not in the same task.
 */
function NextFrame({ children }: { children: ReactNode }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const f = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(f);
  }, []);
  return on ? children : null;
}

// focus the picker gives back (Esc) opens no tooltip: it would only close again in the next press's task
let quiet = false;
export function focusQuietly(el: HTMLElement | null) {
  quiet = true;
  try {
    el?.focus({ preventScroll: true });
  } finally {
    quiet = false;
  }
}
function useTip() {
  const [open, setOpen] = useState(false);
  return { open, onOpenChange: (o: boolean) => setOpen(o && !quiet) };
}

/** A pane's icon button: its name is its tooltip (and its accessible name) */
function PaneAction({ label, icon, ...p }: { label: string; icon: ReactNode; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; [data: `data-${string}`]: string | undefined }) {
  return (
    <Tooltip {...useTip()}>
      <TooltipTrigger asChild>
        <Btn tone="ghost" icon={icon} aria-label={label} {...p} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function PaneView({ pane, render, fill, wide, title, icon, onFocus, onClose, onSplit, onView, pending, overlay, onCancelPending, focused, many, hold, grip }: Props & { pane: Pane; focused: boolean; many: boolean; hold: (id: string, el: HTMLElement | null) => void; grip: (e: ReactPointerEvent) => void }) {
  const ref = useRef<HTMLElement | null>(null);
  const viewTip = useTip();
  const measured = useWidth(ref);
  // a hidden pane (a phone draws only the focused one) keeps the width it had, so its layout stays as it was
  const last = useRef(0);
  if (measured > 0) last.current = measured;
  const width = last.current;
  const setRef = useCallback((el: HTMLElement | null) => {
    ref.current = el;
    hold(pane.id, el);
  }, [hold, pane.id]);
  const view = pane.route.view;
  const fills = fill(view);
  const column = wide?.(view) ? "w-full" : "mx-auto w-full max-w-3xl";
  const take = () => {
    if (!focused) onFocus(pane.id);
  };
  const waiting = pending === pane.id;
  const [asks, setAsks] = useState(0);
  const addFits = useCallback((d: 1 | -1) => setAsks((n) => n + d), []);
  const fits = asks > 0;
  const over = overlay?.paneId === pane.id ? overlay.node : null;
  const body = waiting ? null : render({ id: pane.id, route: pane.route, width });
  return (
    <section
      ref={setRef}
      data-pane={pane.id}
      data-pane-view={view}
      data-focused={focused || undefined}
      tabIndex={-1}
      className="orch-pane absolute flex min-h-0 min-w-0 flex-col outline-none"
      // a press on the header focuses nothing until it is a click, so a drag or an Esc leaves the focus where it was
      onPointerDownCapture={(e) => {
        if (!(e.target as Element).closest("[data-pane-header]")) take();
      }}
      onFocusCapture={take}
    >
      {/* two panes: each names where it is and can close; the focused one has the cue the Sidebar acts on. One pane draws no header */}
      {many ? (
        <header
          className={cx("flex shrink-0 cursor-grab items-center gap-1 border-t-2 border-b py-1 pr-3 pl-1 select-none [&_button]:cursor-default", focused ? "border-t-primary" : "border-t-transparent")}
          data-pane-header=""
          // the whole header drags but Split and Close; on touch only the grip, so a finger elsewhere scrolls and taps
          onPointerDown={(e) => {
            const t = e.target as Element;
            if (waiting || t.closest("[data-no-drag]") || (e.pointerType !== "mouse" && !t.closest("[data-pane-grip]"))) return;
            grip(e);
          }}
          onMouseDown={(e) => {
            if (!(e.target as Element).closest("[data-no-drag]")) e.preventDefault();
          }}
          onClick={(e) => {
            if ((e.target as Element).closest("button")) return;
            take();
            ref.current?.focus({ preventScroll: true });
          }}
        >
          {waiting ? (
            <>
              <span className="min-w-0 flex-1 truncate pl-2 text-sm text-muted-foreground" data-pane-title="">New pane</span>
              <PaneAction label="Cancel" icon={<X />} data-cancel-pane="" data-no-drag="" onClick={() => onCancelPending?.()} />
            </>
          ) : (
            <>
          {/* the grip alone takes touch-action: none, so a finger elsewhere still scrolls; 44 × 36 to a finger */}
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>
              <span aria-hidden className="flex size-6 shrink-0 touch-none items-center justify-center rounded-md text-muted-foreground [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-11 [&_svg]:size-4" data-pane-grip="">
                <GripVertical />
              </span>
            </TooltipTrigger>
            <TooltipContent>Drag to move</TooltipContent>
          </Tooltip>
          {/* the view control: a button on every pane, focused or not; it opens the picker over this pane */}
          <Tooltip {...viewTip}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cx("h-7 min-w-[72px] shrink justify-start gap-1.5 px-2 font-normal", focused ? "text-foreground" : "text-muted-foreground")}
                aria-label={`Change view, now ${title(pane.route)}`}
                aria-haspopup="dialog"
                aria-expanded={!!over}
                data-view-control=""
                onClick={(e) => onView(pane.id, e.currentTarget)}
              >
                <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4" data-view-icon="">{icon(pane.route)}</span>
                <span className="min-w-0 truncate" data-pane-title="">{title(pane.route)}</span>
                <ChevronDown className="size-3.5 shrink-0 opacity-50" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Change view</TooltipContent>
          </Tooltip>
          <span className="min-w-0 flex-1" />
          <PaneAction label="Split right" icon={<Columns2 />} data-split-right="" data-no-drag="" onClick={(e) => onSplit(pane.id, "row", e.currentTarget)} />
          <PaneAction label="Split down" icon={<Rows2 />} data-split-down="" data-no-drag="" onClick={(e) => onSplit(pane.id, "col", e.currentTarget)} />
          <PaneAction label="Close" icon={<X />} data-close-pane="" data-no-drag="" onClick={() => onClose(pane.id)} />
            </>
          )}
        </header>
      ) : null}
      <div className={cx("relative flex min-h-0 flex-1 flex-col", waiting && "bg-muted")} data-pane-body="">
        {waiting ? null : (
          <PaneContext.Provider value={pane.id}>
          <PaneFits.Provider value={addFits}>
            {fills ? (
              <div className="flex min-h-0 flex-1 flex-col pt-2">{body}</div>
            ) : (
              <div className="orch-pane__scroll min-h-0 flex-1 overflow-y-auto" data-fits={fits || undefined}>
                <div className={cx(column, "pb-8", many ? "px-3 pt-3" : "px-4 pt-4")}>{body}</div>
              </div>
            )}
          </PaneFits.Provider>
          </PaneContext.Provider>
        )}
        {/* the picker over this pane: in a split's empty pane, or over a pane's own content, which stays mounted */}
        {over ? (
          <div className={cx("absolute inset-0 z-20", !waiting && "bg-background/70")}>
            <NextFrame>{over}</NextFrame>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export const paneCss = /* css */ `
/* A scrollbar coming or going moves no content: its room is always kept */
[data-orch] .orch-pane__scroll { scrollbar-gutter: stable; }
/* 2026-11-17, the owner: on Projects the list and the project's header stay put and only the cards scroll. A tab that
   lays out its own scroll regions marks its root [data-fits-pane]: the pane hands it its whole height and scrolls nothing
   itself, so there is one scrollbar per region and none for the page */
[data-orch] .orch-pane__scroll[data-fits] { display: flex; flex-direction: column; overflow: hidden; scrollbar-gutter: auto; }
[data-orch] .orch-pane__scroll[data-fits] > div { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; padding-bottom: 0; }
[data-orch] [data-fits-pane] { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
/* 2026-11-17: in a plugin pane bb-app 0.49.0's ThreadChat caps only the transcript at its 760px column, not the composer (bb's own thread page caps both), so the composer's wrapper (bb's [data-scroll-footer] and [data-app-composer] hooks) gets the same cap; a no-op once bb centres it itself */
[data-orch] [data-pane-view="chat"] [data-scroll-footer] :has(> [data-app-composer]) { max-width: 760px; margin-inline: auto; }
/* the view picker fades in over 120 ms, begun one frame in so its first drawn frame already shows it; nothing moves */
@keyframes orch-picker-in { from { opacity: 0; } }
[data-orch] :is([data-view-picker], [data-picker-drag-line]) { animation: orch-picker-in 120ms ease-out -17ms backwards; }
@media (prefers-reduced-motion: reduce) { [data-orch] :is([data-view-picker], [data-picker-drag-line]) { animation: none; } }
/* the picker's list shows its scrollbar whenever it overflows (a small pane cuts it after a few rows), overlay scrollbars too */
[data-orch] [data-view-picker] [cmdk-list] { scrollbar-width: auto; scrollbar-color: auto; }
[data-orch] [data-view-picker] [cmdk-list]::-webkit-scrollbar { width: 10px; }
[data-orch] [data-view-picker] [cmdk-list]::-webkit-scrollbar-thumb { background: var(--border); background-clip: padding-box; border: 2px solid transparent; border-radius: 9999px; }
/* a forced layout inside one pane (the picker opening, a page's own measuring) does not walk the others */
[data-orch] .orch-pane { contain: layout paint; }
/* a pane header lit as a handle: the grip, when the pointer is on the header but not on one of its buttons */
[data-orch] [data-pane-header]:hover:not(:has(button:hover)) [data-pane-grip] { background: var(--accent); color: var(--foreground); }
/* the Sidebar opens to the rail and back at once: a width that animated would move every pane beside it for 200 ms */
[data-orch] [data-page-sidebar], [data-orch] [data-page-sidebar] * { transition-property: color, background-color, border-color, text-decoration-color, fill, stroke, opacity !important; }
`;
