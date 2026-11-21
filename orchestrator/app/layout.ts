// The Orchestrator page's own layout (2026-11-13: "we need to be able to split tabs ... I want it to be a
// dynamic layout for the plugin"; panes inside the page, since bb opens only threads as its own panes). A tree: a pane
// shows one view; a split lays its children side by side (row) or stacked (col) at their shares. Pure functions, so
// every change is a new tree and the tests cover the rules. Saved per viewer in the browser, never shared.

import { RENAMED_VIEWS, fromPath, rootOf, samePlace, type Route, type ViewPath } from "./route.ts";

export { RENAMED_VIEWS };
export type Pane = { kind: "pane"; id: string; route: Route };
export type Split = { kind: "split"; id: string; dir: "row" | "col"; sizes: number[]; children: Node[] };
export type Node = Pane | Split;
/** v2 (split panes, 2026-11-20): each pane holds its route, not only its view. */
export type Layout = { v: 2; root: Node; focus: string };

/** Never more panes than this, however many fit (spec §5). */
export const MAX_PANES = 6;
/** The smallest pane, in px: every view is clean at 320 wide. */
export const MIN_W = 320;
export const MIN_H = 240;
/** The gutter a divider takes between two panes, counted by the fit rule. */
export const GUTTER = 8;

let seq = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export const single = (route: Route, id = "p0"): Layout => ({ v: 2, root: { kind: "pane", id, route }, focus: id });

export function panes(n: Node): Pane[] {
  return n.kind === "pane" ? [n] : n.children.flatMap(panes);
}

export function findPane(l: Layout, id: string): Pane | null {
  return panes(l.root).find((p) => p.id === id) ?? null;
}

function map(n: Node, f: (n: Node) => Node): Node {
  const m = f(n);
  return m.kind === "split" ? { ...m, children: m.children.map((c) => map(c, f)) } : m;
}

/** Pane `paneId` goes to `route` and takes the focus. */
export function setRoute(l: Layout, paneId: string, route: Route): Layout {
  return { v: 2, root: map(l.root, (n) => (n.kind === "pane" && n.id === paneId ? { ...n, route } : n)), focus: paneId };
}

/** A link lands in the pane showing exactly that place, else the focused pane on that page, else another on it, else the focused one. */
export function land(l: Layout, route: Route, views: readonly ViewPath[]): { layout: Layout; pane: string } {
  const all = panes(l.root);
  const focused = all.find((p) => p.id === l.focus) ?? all[0]!;
  const exact = samePlace(focused.route, route, views) ? focused : all.find((p) => samePlace(p.route, route, views));
  if (exact) return { layout: exact.id === l.focus ? l : { ...l, focus: exact.id }, pane: exact.id };
  const on = focused.route.view === route.view ? focused : (all.find((p) => p.route.view === route.view) ?? focused);
  return { layout: setRoute(l, on.id, route), pane: on.id };
}

/**
 * A new pane beside `paneId` (row: to its right; col: below it) showing `view`. Inside a split of the same direction it
 * becomes a sibling and the two share the old pane's room; otherwise the pane becomes a two-way split. At MAX_PANES
 * nothing changes. The new pane takes the focus.
 */
export function split(l: Layout, paneId: string, dir: "row" | "col", route: Route): Layout {
  if (panes(l.root).length >= MAX_PANES || !findPane(l, paneId)) return l;
  const fresh: Pane = { kind: "pane", id: newId("p"), route };
  const walk = (n: Node): Node => {
    if (n.kind === "pane") return n.id === paneId ? { kind: "split", id: newId("s"), dir, sizes: [0.5, 0.5], children: [n, fresh] } : n;
    const i = n.children.findIndex((c) => c.kind === "pane" && c.id === paneId);
    if (i >= 0 && n.dir === dir) {
      const half = n.sizes[i]! / 2;
      const sizes = [...n.sizes.slice(0, i), half, half, ...n.sizes.slice(i + 1)];
      const children = [...n.children.slice(0, i + 1), fresh, ...n.children.slice(i + 1)];
      return { ...n, sizes, children };
    }
    return { ...n, children: n.children.map(walk) };
  };
  return { v: 2, root: walk(l.root), focus: fresh.id };
}

/** "Open beside": a new pane to the right of the focused pane, on `route`, with the focus. */
export const beside = (l: Layout, route: Route): Layout => split(l, l.focus, "row", route);

/** Close a pane: its neighbours take its room and, if it had the focus, the one beside it takes that. The last pane stays. */
export function close(l: Layout, paneId: string): Layout {
  const all = panes(l.root);
  if (all.length <= 1 || !all.some((p) => p.id === paneId)) return l;
  let heir: string | null = null;
  const walk = (n: Node): Node | null => {
    if (n.kind === "pane") return n.id === paneId ? null : n;
    const kept: { c: Node; s: number }[] = [];
    n.children.forEach((c, i) => {
      const w = walk(c);
      if (w) kept.push({ c: w, s: n.sizes[i]! });
      else if (heir === null) {
        const prev = n.children[i - 1];
        const next = n.children[i + 1];
        heir = prev ? panes(prev).at(-1)!.id : next ? panes(next)[0]!.id : null;
      }
    });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0]!.c;
    const total = kept.reduce((a, k) => a + k.s, 0);
    return { ...n, children: kept.map((k) => k.c), sizes: kept.map((k) => k.s / total) };
  };
  const root = walk(l.root)!;
  const left = panes(root);
  const focus = left.some((p) => p.id === l.focus) ? l.focus : (heir ?? left[0]!.id);
  return { v: 2, root, focus };
}

/** A split's shares, as its dividers left them. */
export function setSizes(l: Layout, splitId: string, sizes: number[]): Layout {
  const total = sizes.reduce((x, y) => x + y, 0);
  if (!(total > 0) || sizes.some((x) => !(x > 0))) return l;
  let hit = false;
  const root = map(l.root, (n) => {
    if (n.kind !== "split" || n.id !== splitId || n.sizes.length !== sizes.length) return n;
    hit = true;
    return { ...n, sizes: sizes.map((x) => x / total) };
  });
  return hit ? { ...l, root } : l;
}

/** The least room a subtree needs: side by side the widths add up, stacked the heights do. */
export function minSize(n: Node): { w: number; h: number } {
  if (n.kind === "pane") return { w: MIN_W, h: MIN_H };
  const kids = n.children.map(minSize);
  const sum = (k: "w" | "h") => kids.reduce((a, c) => a + c[k], 0);
  const max = (k: "w" | "h") => Math.max(...kids.map((c) => c[k]));
  const gutters = GUTTER * (kids.length - 1);
  return n.dir === "row" ? { w: sum("w") + gutters, h: max("h") } : { w: max("w"), h: sum("h") + gutters };
}

/**
 * Each split's shares raised so every pane gets its minimum in a w × h area (the rest keep their proportions), so the
 * panels never clamp after the first frame. A tree that doesn't fit is returned as it is.
 */
export function fitSizes(l: Layout, w: number, h: number): Layout {
  if (!fits(l, w, h)) return l;
  const walk = (n: Node, w: number, h: number): Node => {
    if (n.kind === "pane") return n;
    const row = n.dir === "row";
    const room = (row ? w : h) - GUTTER * (n.children.length - 1);
    const mins = n.children.map((c) => (row ? minSize(c).w : minSize(c).h));
    const at = new Set<number>();
    let px = n.sizes.map((x) => x * room);
    // the panes under their minimum take it; the others share what is left in their old proportions, until none is under
    while (px.some((v, i) => !at.has(i) && v < mins[i]!)) {
      px.forEach((v, i) => v < mins[i]! && at.add(i));
      const rest = room - [...at].reduce((a, i) => a + mins[i]!, 0);
      const free = n.sizes.reduce((a, x, i) => (at.has(i) ? a : a + x), 0);
      px = n.sizes.map((x, i) => (at.has(i) ? mins[i]! : free > 0 ? (x / free) * rest : 0));
    }
    const sizes = at.size ? px.map((v) => v / room) : n.sizes;
    return { ...n, sizes, children: n.children.map((c, i) => walk(c, row ? px[i]! : w, row ? h : px[i]!)) };
  };
  return { ...l, root: walk(l.root, w, h) };
}

/** Where the gutters inside `n` meet its `side` edge, as shares of that edge's length; `dir` is the split the edge's gutter belongs to. */
function touching(n: Node, side: "start" | "end", dir: "row" | "col"): number[] {
  if (n.kind === "pane") return [];
  if (n.dir === dir) return touching(side === "end" ? n.children.at(-1)! : n.children[0]!, side, dir);
  const out: number[] = [];
  let at = 0;
  n.children.forEach((c, i) => {
    const s = n.sizes[i]!;
    out.push(...touching(c, side, dir).map((x) => at + x * s));
    at += s;
    if (i < n.children.length - 1) out.push(at);
  });
  return out;
}

/**
 * For each gutter of a split, where its grip goes along it (0..1): the middle of its longest stretch clear of the gutters
 * that meet it from either side, so a grip never sits on a junction. With none, the middle.
 */
export function gripsAt(n: Split): number[] {
  return n.children.slice(1).map((c, i) => {
    const meet = [...touching(n.children[i]!, "end", n.dir), ...touching(c, "start", n.dir)].filter((x) => x > 0 && x < 1).sort((a, b) => a - b);
    const stops = [0, ...meet, 1];
    let best = { len: -1, mid: 0.5 };
    for (let k = 1; k < stops.length; k++) {
      const len = stops[k]! - stops[k - 1]!;
      if (len > best.len + 1e-9) best = { len, mid: (stops[k]! + stops[k - 1]!) / 2 };
    }
    return best.mid;
  });
}

/** Does the whole tree fit in w × h with every pane at its minimum or more? */
export function fits(l: Layout, w: number, h: number): boolean {
  const m = minSize(l.root);
  return panes(l.root).length <= MAX_PANES && m.w <= w && m.h <= h;
}

export type Edge = "left" | "right" | "top" | "bottom" | "center";

/** Dock pane `paneId` at `edge` of pane `targetId`: it leaves its place and takes half the target's room; the centre swaps them. Ids are kept, so nothing remounts. */
export function dock(l: Layout, paneId: string, targetId: string, edge: Edge): Layout {
  const src = findPane(l, paneId);
  const tgt = findPane(l, targetId);
  if (!src || !tgt || paneId === targetId) return l;
  if (edge === "center") return { v: 2, root: map(l.root, (n) => (n.kind === "pane" ? (n.id === paneId ? tgt : n.id === targetId ? src : n) : n)), focus: paneId };
  const dir = edge === "left" || edge === "right" ? "row" : "col";
  const before = edge === "left" || edge === "top";
  const walk = (n: Node): Node => {
    if (n.kind === "pane") return n.id === targetId ? { kind: "split", id: newId("s"), dir, sizes: [0.5, 0.5], children: before ? [src, n] : [n, src] } : n;
    const i = n.children.findIndex((c) => c.kind === "pane" && c.id === targetId);
    if (i >= 0 && n.dir === dir) {
      const half = n.sizes[i]! / 2;
      const sizes = [...n.sizes.slice(0, i), half, half, ...n.sizes.slice(i + 1)];
      const children = [...n.children];
      children.splice(before ? i : i + 1, 0, src);
      return { ...n, sizes, children };
    }
    return { ...n, children: n.children.map(walk) };
  };
  return { v: 2, root: walk(close(l, paneId).root), focus: paneId };
}

/** A new pane on `route` at `edge` of pane `targetId` (a Sidebar item dropped there); the centre sends that pane to `route`. */
export function dropAt(l: Layout, route: Route, targetId: string, edge: Edge): Layout {
  if (!findPane(l, targetId)) return l;
  if (edge === "center") return setRoute(l, targetId, route);
  const added = split(l, targetId, edge === "left" || edge === "right" ? "row" : "col", route);
  return added === l || edge === "right" || edge === "bottom" ? added : dock(added, added.focus, targetId, edge);
}

/** The pane beside `paneId`, to its right in the nearest side-by-side split; null when there is none (Ctrl/Cmd+click then makes one). */
export function besideOf(l: Layout, paneId: string): string | null {
  const find = (n: Node): string | null | undefined => {
    if (n.kind === "pane") return n.id === paneId ? null : undefined;
    for (let i = 0; i < n.children.length; i++) {
      const r = find(n.children[i]!);
      if (r === undefined) continue;
      if (r !== null) return r;
      const next = n.children[i + 1];
      return n.dir === "row" && next ? panes(next)[0]!.id : null;
    }
    return undefined;
  };
  return find(l.root) ?? null;
}

/** A saved layout read back (v2, or v1 as each view's root): a stale pane is dropped and the rest kept; malformed or empty is null. */
export function parse(raw: unknown, views: readonly ViewPath[]): Layout | null {
  const ids = new Set<string>();
  const known = (v: string) => views.some((x) => x.id === v);
  const routeOf = (o: Record<string, unknown>): Route | null => {
    // v1: the view alone, read as that page's sub-path (an old needs-you pane opens Home on Needs you)
    if (typeof o.view === "string") {
      const r = known(o.view) ? rootOf(o.view) : fromPath(o.view, views);
      return known(r.view) && (known(o.view) || Object.hasOwn(RENAMED_VIEWS, o.view)) ? r : null;
    }
    const r = o.route as Record<string, unknown> | undefined;
    if (!r || typeof r.view !== "string" || !Array.isArray(r.path) || !r.path.every((s) => typeof s === "string")) return null;
    if (!r.params || typeof r.params !== "object" || !Object.values(r.params).every((s) => typeof s === "string")) return null;
    const view = Object.hasOwn(RENAMED_VIEWS, r.view) ? RENAMED_VIEWS[r.view]! : r.view;
    if (!known(view)) return null;
    return view === r.view ? { view, path: [...(r.path as string[])], params: { ...(r.params as Record<string, string>) } } : rootOf(view);
  };
  let bad = false;
  // null: dropped (a stale pane); `bad` marks a malformed tree, which drops the whole layout
  const node = (n: unknown, depth: number): Node | null => {
    if (!n || typeof n !== "object" || depth > 6) return ((bad = true), null);
    const o = n as Record<string, unknown>;
    if (typeof o.id !== "string" || ids.has(o.id)) return ((bad = true), null);
    ids.add(o.id);
    if (o.kind === "pane") {
      const route = routeOf(o);
      return route ? { kind: "pane", id: o.id, route } : null;
    }
    if (o.kind !== "split" || (o.dir !== "row" && o.dir !== "col") || !Array.isArray(o.children) || !Array.isArray(o.sizes)) return ((bad = true), null);
    if (o.children.length < 2 || o.children.length !== o.sizes.length) return ((bad = true), null);
    if (!o.sizes.every((s) => typeof s === "number" && s > 0 && Number.isFinite(s))) return ((bad = true), null);
    const kept: { c: Node; s: number }[] = [];
    o.children.forEach((c, i) => {
      const k = node(c, depth + 1);
      if (k) kept.push({ c: k, s: (o.sizes as number[])[i]! });
    });
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0]!.c;
    const total = kept.reduce((a, k) => a + k.s, 0);
    return { kind: "split", id: o.id, dir: o.dir, sizes: kept.map((k) => k.s / total), children: kept.map((k) => k.c) };
  };
  const r = raw as { root?: unknown; focus?: unknown } | null;
  const root = r ? node(r.root, 0) : null;
  if (bad || !root || panes(root).length > MAX_PANES) return null;
  const focus = typeof r!.focus === "string" && panes(root).some((p) => p.id === r!.focus) ? r!.focus : panes(root)[0]!.id;
  return { v: 2, root, focus };
}
