// The Orchestrator page as panes (layout.ts holds the rules). Each pane has its own tabs (shadcn's Tabs since 2026-11-17,
// scrolling sideways when they don't fit), split right, split down and close. Dividers drag to resize. Each pane scrolls on
// its own. A phone-width page shows only the focused pane.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Columns2, Rows2, X } from "lucide-react";
import { MAX_PANES, panes, type Layout, type Node, type Pane } from "./layout.ts";
import { Badge } from "./ui/badge.tsx";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import { Btn, cx } from "./ui.tsx";

/** `counted`: the tab can carry a count, so its slot stays while there is none and a count coming or going moves no tab */
export type ViewDef = { id: string; label: string; count?: number | string; counted?: boolean };

/**
 * A counted tab's label: its count is a badge in a slot that is always there, hidden while empty, at least two digits wide.
 * While the slot is empty the label is centred across the whole box, not left of a blank gap (2026-11-17, the owner).
 */
function CountedLabel({ label, count }: { label: string; count?: number | string }) {
  const text = typeof count === "number" ? count.toLocaleString("en-US") : (count ?? "");
  return (
    <span className="orch-tab-label" data-label={label} data-empty={text === "" || undefined}>
      <span className="orch-tab-name">{label}</span>
      <Badge variant="secondary" className="orch-tab-count h-4 min-w-[calc(2ch+8px)] px-1 tabular-nums" style={{ color: "var(--foreground)" }} data-empty={text === "" || undefined} aria-hidden={text === "" || undefined}>
        {text}
      </Badge>
    </span>
  );
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
  views: ViewDef[];
  /** A phone-width page: only the focused pane, no splitting */
  compact: boolean;
  render: (view: string, pane: { id: string; width: number }) => ReactNode;
  /** Views that fill the pane themselves (the chat): no padding, no page scroll */
  fill: (view: string) => boolean;
  /** Views that use the pane's whole width (Projects, layout B: the list beside the project), not the reading column */
  wide?: (view: string) => boolean;
  onView: (paneId: string, view: string) => void;
  onFocus: (paneId: string) => void;
  onSplit: (paneId: string, dir: "row" | "col") => void;
  onClose: (paneId: string) => void;
  onResize: (splitId: string, index: number, delta: number) => void;
};

export function PaneLayout(p: Props) {
  const all = panes(p.layout.root);
  if (p.compact) {
    const f = all.find((x) => x.id === p.layout.focus) ?? all[0]!;
    return <PaneView pane={f} {...p} many={false} canSplit={false} />;
  }
  return <NodeView node={p.layout.root} {...p} many={all.length > 1} canSplit={all.length < MAX_PANES} />;
}

type Inner = Props & { many: boolean; canSplit: boolean };

function NodeView({ node, ...p }: Inner & { node: Node }) {
  const box = useRef<HTMLDivElement>(null);
  if (node.kind === "pane") return <PaneView pane={node} {...p} />;
  const row = node.dir === "row";
  return (
    <div ref={box} data-split={node.id} className={cx("flex h-full min-h-0 w-full min-w-0", row ? "flex-row" : "flex-col")}>
      {node.children.map((c, i) => (
        <div key={c.id} className="contents">
          <div className="flex min-h-0 min-w-0" style={{ flex: `${node.sizes[i]} 1 0` }}>
            <NodeView node={c} {...p} />
          </div>
          {i < node.children.length - 1 ? <Divider row={row} box={box} onMove={(d) => p.onResize(node.id, i, d)} /> : null}
        </div>
      ))}
    </div>
  );
}

/** A divider: drag to move the room between its two neighbours (the move is a share of the whole split). */
function Divider({ row, box, onMove }: { row: boolean; box: RefObject<HTMLDivElement | null>; onMove: (delta: number) => void }) {
  return (
    <div
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      data-divider=""
      className={cx(
        "relative flex-none touch-none after:absolute after:rounded-xs after:bg-transparent after:transition-colors hover:after:bg-foreground/15 active:after:bg-foreground/15",
        row ? "w-1.5 cursor-col-resize after:inset-x-0.5 after:inset-y-2" : "h-1.5 cursor-row-resize after:inset-x-2 after:inset-y-0.5",
      )}
      onPointerDown={(e) => {
        const el = box.current;
        if (!el) return;
        e.preventDefault();
        const size = row ? el.getBoundingClientRect().width : el.getBoundingClientRect().height;
        let last = row ? e.clientX : e.clientY;
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => {
          const now = row ? ev.clientX : ev.clientY;
          if (size > 0 && now !== last) onMove((now - last) / size);
          last = now;
        };
        const up = () => {
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", up);
          target.removeEventListener("pointercancel", up);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
        target.addEventListener("pointercancel", up);
      }}
    />
  );
}

/** A pane's icon button: its name is its tooltip (and its accessible name) */
function PaneAction({ label, icon, ...p }: { label: string; icon: ReactNode; onClick: () => void; [data: `data-${string}`]: string | undefined }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Btn tone="ghost" icon={icon} aria-label={label} {...p} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function PaneView({ pane, views, render, fill, wide, onView, onFocus, onSplit, onClose, layout, many, canSplit }: Inner & { pane: Pane }) {
  const ref = useRef<HTMLElement>(null);
  const width = useWidth(ref);
  const strip = useRef<HTMLDivElement>(null);
  const focused = layout.focus === pane.id;
  // The active tab stays in view when the strip scrolls. And a tab a shortcut or a link switched away from gives up the
  // focus to the active one: Radix selects a tab when it gets the focus, so a stale focused tab would switch the pane
  // back the next time the window or a closed dialog hands the focus back to it.
  useLayoutEffect(() => {
    const s = strip.current;
    const t = s?.querySelector<HTMLElement>("[role=tab][data-state=active]");
    if (!s || !t) return;
    const a = document.activeElement;
    if (a instanceof HTMLElement && a !== t && a.getAttribute("role") === "tab" && s.contains(a)) t.focus({ preventScroll: true });
    if (s.scrollWidth <= s.clientWidth) return;
    const sr = s.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    if (tr.left < sr.left) s.scrollLeft -= sr.left - tr.left + 8;
    else if (tr.right > sr.right) s.scrollLeft += tr.right - sr.right + 8;
  }, [pane.view, width]);
  // 2026-11-18: the strip's scrollbar is hidden, so a quiet fade at an edge says more tabs sit past it (none when all fit)
  const [fade, setFade] = useState("");
  useLayoutEffect(() => {
    const s = strip.current;
    if (!s) return;
    const read = () => {
      const more = s.scrollWidth - s.clientWidth;
      setFade(more <= 1 ? "" : [s.scrollLeft > 1 && "start", s.scrollLeft < more - 1 && "end"].filter(Boolean).join(" "));
    };
    read();
    s.addEventListener("scroll", read, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(s);
    if (s.firstElementChild) ro.observe(s.firstElementChild);
    return () => {
      s.removeEventListener("scroll", read);
      ro.disconnect();
    };
  }, [views.length]);
  const fills = fill(pane.view);
  const column = wide?.(pane.view) ? "w-full" : "mx-auto w-full max-w-3xl";
  return (
    <section
      ref={ref}
      data-pane={pane.id}
      data-pane-view={pane.view}
      data-focused={focused || undefined}
      className={cx("orch-pane flex min-h-0 min-w-0 flex-1 flex-col", many && "m-1 rounded-lg border data-[focused]:border-foreground/25")}
      onPointerDownCapture={() => {
        if (!focused) onFocus(pane.id);
      }}
    >
      {/* the strip's row spans the pane on every tab (tabs left, split buttons right), whatever width the tab's content
          takes, so it never moves with the tab (2026-11-17: only the wide tabs drew it so) and fits more tabs before it
          scrolls; the tab's content scrolls under it, in its own column */}
      {/* the strip keeps the content's inset, px-3 in a split pane as its cards (2026-11-18, the owner: at px-2 it ran
          closer to the pane's edge than the cards) */}
      <header className={cx("flex shrink-0 items-center gap-1", many ? "px-3 pt-2" : "px-4 pt-4")}>
        {/* every tab one width, the widest tab's (2026-11-17, the owner: "make all the tab widths the same"): a grid of
            equal columns at its natural width, labels centred; too narrow for them all, the strip scrolls sideways with the
            tabs still equal, none cut short (a strip stretched across the row would make each a tenth of a wide pane).
            A tab not shown is bb's muted text, as in dark: shadcn's 60% ink on the light tray is 3.4:1, under 4.5:1 */}
        <Tabs ref={strip} data-tab-strip="" data-fade={fade || undefined} value={pane.view} onValueChange={(id) => onView(pane.id, id)} className="min-w-0 flex-1 gap-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none]">
          <TabsList className="grid w-max auto-cols-fr grid-flow-col">
            {views.map((v) => (
              <TabsTrigger key={v.id} value={v.id} className="text-muted-foreground">
                {v.counted || v.count !== undefined ? <CountedLabel label={v.label} count={v.count} /> : v.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {canSplit ? (
          <>
            <PaneAction label="Split right" icon={<Columns2 />} data-split-right="" onClick={() => onSplit(pane.id, "row")} />
            <PaneAction label="Split down" icon={<Rows2 />} data-split-down="" onClick={() => onSplit(pane.id, "col")} />
          </>
        ) : null}
        {many ? <PaneAction label="Close pane" icon={<X />} data-close-pane="" onClick={() => onClose(pane.id)} /> : null}
      </header>
      {fills ? (
        <div className="flex min-h-0 flex-1 flex-col pt-2">{render(pane.view, { id: pane.id, width })}</div>
      ) : (
        <div className="orch-pane__scroll min-h-0 flex-1 overflow-y-auto">
          <div className={cx(column, "pb-8", many ? "px-3 pt-3" : "px-4 pt-4")}>{render(pane.view, { id: pane.id, width })}</div>
        </div>
      )}
    </section>
  );
}

export const paneCss = /* css */ `
/* A scrollbar coming or going moves no content: its room is always kept */
[data-orch] .orch-pane__scroll { scrollbar-gutter: stable; }
/* 2026-11-17, the owner: on Projects the list and the project's header stay put and only the cards scroll. A tab that
   lays out its own scroll regions marks its root [data-fits-pane]: the pane hands it its whole height and scrolls nothing
   itself, so there is one scrollbar per region and none for the page */
[data-orch] .orch-pane__scroll:has([data-fits-pane]) { display: flex; flex-direction: column; overflow: hidden; scrollbar-gutter: auto; }
[data-orch] .orch-pane__scroll:has([data-fits-pane]) > div { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; padding-bottom: 0; }
[data-orch] [data-fits-pane] { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
/* 2026-11-18: the tab strip fades at a side (a mask reads only alpha, so black is no colour here) that has more tabs past it (data-fade: start, end, or both) */
[data-orch] [data-tab-strip][data-fade] { --fade-l: 0px; --fade-r: 0px; -webkit-mask-image: linear-gradient(to right, transparent, black var(--fade-l), black calc(100% - var(--fade-r)), transparent); mask-image: linear-gradient(to right, transparent, black var(--fade-l), black calc(100% - var(--fade-r)), transparent); }
[data-orch] [data-tab-strip][data-fade~="start"] { --fade-l: 24px; }
[data-orch] [data-tab-strip][data-fade~="end"] { --fade-r: 24px; }
/* A counted tab's box is its label, the gap and the slot, count or none. A hidden copy of the label holds column one, so
   with the slot empty the label itself spans both columns, centred, and the box keeps its width */
[data-orch] .orch-tab-label { display: inline-grid; grid-template-columns: auto auto; align-items: center; column-gap: 4px; }
[data-orch] .orch-tab-label::before { content: attr(data-label); grid-area: 1 / 1; visibility: hidden; }
[data-orch] .orch-tab-name { grid-area: 1 / 1; }
[data-orch] .orch-tab-count { grid-area: 1 / 2; }
[data-orch] .orch-tab-label[data-empty] .orch-tab-name { grid-column: 1 / -1; justify-self: center; }
[data-orch] .orch-tab-count[data-empty] { visibility: hidden; }
/* 2026-11-17: in a plugin pane bb-app 0.49.0's ThreadChat caps only the transcript at its 760px column, not the composer (bb's own thread page caps both), so the composer's wrapper (bb's [data-scroll-footer] and [data-app-composer] hooks) gets the same cap; a no-op once bb centres it itself */
[data-orch] [data-pane-view="chat"] [data-scroll-footer] :has(> [data-app-composer]) { max-width: 760px; margin-inline: auto; }
`;
