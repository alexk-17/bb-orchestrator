// Where a diagram block's boxes and arrows go (app/diagram.tsx draws them). Pure, so the tests cover it. Layers: a box
// sits one layer after the furthest box that points at it (cycles are cut at the first arrow back), so every arrow
// runs forward, except one that closes a cycle. Within a layer, boxes keep the order the agent listed them in.

export type DNode = { id: string; label: string; note?: string; change: "added" | "changed" | "removed" | "same" };
export type DEdge = { from: string; to: string; label?: string; change: "added" | "changed" | "removed" | "same" };
export type Box = DNode & { x: number; y: number; w: number; h: number; layer: number };
export type Line = DEdge & { path: string; lx: number; ly: number; back: boolean };

export const BOX_W = 160; // the narrowest box; boxes widen to fit the longest label, up to BOX_W_MAX
export const BOX_W_MAX = 224;
export const BOX_H = 52;
const GAP_LAYER = 48; // between layers (room for an arrow and its short label)
const GAP_ROW = 18; // between boxes in one layer
const PAD = 8;

/** Each box's layer: the longest path to it from a box nothing points at. */
export function layers(nodes: readonly DNode[], edges: readonly DEdge[]): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) if (ids.has(e.from) && ids.has(e.to) && e.from !== e.to) out.get(e.from)!.push(e.to);
  // depth-first, cutting arrows that point back into the current path (the cycle's closing arrow)
  const state = new Map<string, 0 | 1 | 2>();
  const forward: [string, string][] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    for (const to of out.get(id)!) {
      if (state.get(to) === 1) continue;
      forward.push([id, to]);
      if (!state.get(to)) visit(to);
    }
    state.set(id, 2);
  };
  for (const n of nodes) if (!state.get(n.id)) visit(n.id);
  const layer = new Map(nodes.map((n) => [n.id, 0]));
  // longest path over the acyclic arrows: relax until nothing moves (at most nodes.length rounds)
  for (let round = 0; round < nodes.length; round++) {
    let moved = false;
    for (const [a, b] of forward) {
      if (layer.get(b)! < layer.get(a)! + 1) {
        layer.set(b, layer.get(a)! + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return layer;
}

/** The whole picture: boxes, arrows (an SVG path each, with where its label goes) and the canvas size. */
export function layout(nodes: readonly DNode[], edges: readonly DEdge[], direction: "right" | "down", boxW = BOX_W, boxH = BOX_H, route: "curve" | "orthogonal" = "curve", layerGap = GAP_LAYER): { boxes: Box[]; lines: Line[]; width: number; height: number } {
  const BOX_W = boxW;
  const layer = layers(nodes, edges);
  const byLayer: DNode[][] = [];
  for (const n of nodes) (byLayer[layer.get(n.id)!] ??= []).push(n);
  const across = Math.max(...byLayer.map((l) => l?.length ?? 0));
  const right = direction === "right";
  const boxes: Box[] = [];
  byLayer.forEach((col, li) => {
    col.forEach((n, i) => {
      // centre each layer on the widest one
      const offset = ((across - col.length) * ((right ? boxH : BOX_W) + GAP_ROW)) / 2;
      const along = PAD + li * ((right ? BOX_W : boxH) + layerGap);
      const side = PAD + offset + i * ((right ? boxH : BOX_W) + GAP_ROW);
      boxes.push({ ...n, layer: li, w: BOX_W, h: boxH, x: right ? along : side, y: right ? side : along });
    });
  });
  const at = new Map(boxes.map((b) => [b.id, b]));
  const lines: Line[] = [];
  let skipLane = 0;
  let corridorBottom = 0;
  for (const e of edges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!a || !b || a === b) continue;
    const back = b.layer <= a.layer;
    let path: string;
    let lx: number;
    let ly: number;
    if (right && route === "orthogonal" && !back) {
      const incoming = edges.filter((edge) => edge.to === e.to && at.has(edge.from)).sort((left, right) => at.get(left.from)!.y - at.get(right.from)!.y);
      const outgoing = edges.filter((edge) => edge.from === e.from && at.has(edge.to)).sort((left, right) => at.get(left.to)!.y - at.get(right.to)!.y);
      const x1 = a.x + a.w;
      const y1 = a.y + ((outgoing.findIndex((edge) => edge.to === e.to) + 1) * a.h) / (outgoing.length + 1);
      const x2 = b.x;
      const y2 = b.y + ((incoming.findIndex((edge) => edge.from === e.from) + 1) * b.h) / (incoming.length + 1);
      const midBoxes = b.layer > a.layer + 1 ? boxes.filter((box) => box.layer > a.layer && box.layer < b.layer) : [];
      const hitsMid = midBoxes.some((box) => (y1 >= box.y - 4 && y1 <= box.y + box.h + 4) || (y2 >= box.y - 4 && y2 <= box.y + box.h + 4));
      if (hitsMid) {
        const stub = Math.max(10, Math.min(20, layerGap / 3));
        const exitX = x1 + stub;
        const enterX = x2 - stub;
        const maxBottom = Math.max(...midBoxes.map((box) => box.y + box.h), a.y + a.h, b.y + b.h);
        const corridorY = maxBottom + 16 + skipLane++ * 10;
        corridorBottom = Math.max(corridorBottom, corridorY + PAD);
        path = `M${x1},${y1} H${exitX} V${corridorY} H${enterX} V${y2} H${x2}`;
        lx = (exitX + enterX) / 2;
        ly = corridorY;
      } else {
        const lanes = edges.filter((edge) => at.get(edge.from)?.layer === a.layer && at.get(edge.to)?.layer === b.layer).sort((left, right) => at.get(left.from)!.y - at.get(right.from)!.y || at.get(left.to)!.y - at.get(right.to)!.y);
        const bend = x1 + ((lanes.length - lanes.findIndex((edge) => edge.from === e.from && edge.to === e.to)) * (x2 - x1)) / (lanes.length + 1);
        path = `M${x1},${y1} H${bend} V${y2} H${x2}`;
        lx = bend;
        ly = (y1 + y2) / 2;
      }
    } else if (right) {
      const [x1, y1] = back ? [a.x + a.w / 2, a.y + a.h] : [a.x + a.w, a.y + a.h / 2];
      const [x2, y2] = back ? [b.x + b.w / 2, b.y + b.h] : [b.x, b.y + b.h / 2];
      const bend = back ? Math.max(a.y + a.h, b.y + b.h) + 28 : 0;
      path = back ? `M${x1},${y1} C${x1},${bend} ${x2},${bend} ${x2},${y2}` : `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
      lx = (x1 + x2) / 2;
      ly = back ? bend - 6 : (y1 + y2) / 2;
    } else {
      const [x1, y1] = back ? [a.x + a.w, a.y + a.h / 2] : [a.x + a.w / 2, a.y + a.h];
      const [x2, y2] = back ? [b.x + b.w, b.y + b.h / 2] : [b.x + b.w / 2, b.y];
      const bend = back ? Math.max(a.x + a.w, b.x + b.w) + 36 : 0;
      path = back ? `M${x1},${y1} C${bend},${y1} ${bend},${y2} ${x2},${y2}` : `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`;
      lx = back ? bend : (x1 + x2) / 2;
      ly = (y1 + y2) / 2;
    }
    lines.push({ ...e, path, lx, ly, back });
  }
  const width = Math.max(...boxes.map((b) => b.x + b.w)) + PAD + (right ? 0 : lines.some((l) => l.back) ? 40 : 0);
  const height = Math.max(Math.max(...boxes.map((b) => b.y + b.h)) + PAD + (right && lines.some((l) => l.back) ? 32 : 0), corridorBottom);
  return { boxes, lines, width, height };
}
