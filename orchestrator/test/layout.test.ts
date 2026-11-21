// The pane layout (app/layout.ts): no lost view, no orphaned room, focus to the sibling, each pane its own place, stale saves keep what they can.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GUTTER, MAX_PANES, MIN_H, MIN_W, beside, close, fits, land, minSize, panes, parse, setRoute, setSizes, single, split, type Layout, type Node, type Split } from "../app/layout.ts";
import { rootOf, type Route } from "../app/route.ts";

const VIEWS = [
  { id: "home", subPath: "" },
  { id: "projects", subPath: "projects" },
  { id: "chat", subPath: "chat" },
  { id: "board", subPath: "board" },
];
const views = (l: Layout) => panes(l.root).map((p) => p.route.view);
const home = (filter?: string, item?: string): Route => ({ view: "home", path: [], params: { ...(filter ? { filter } : {}), ...(item ? { item } : {}) } });
const project = (slug: string): Route => ({ view: "projects", path: [slug], params: {} });

test("split right puts the new pane beside the old one and focuses it; the old pane keeps its route", () => {
  const l = split(single(home("needs")), "p0", "row", rootOf("projects"));
  const root = l.root as Split;
  assert.equal(root.dir, "row");
  assert.deepEqual(views(l), ["home", "projects"]);
  assert.deepEqual(panes(l.root)[0]!.route, home("needs"), "the filter stays with its pane");
  assert.equal(l.focus, panes(l.root)[1]!.id);
  assert.deepEqual(root.sizes, [0.5, 0.5]);
});

test("Open beside: a new pane to the right of the focused pane, with the focus; a third and more (the split tree)", () => {
  const two = beside(single(rootOf("home")), rootOf("projects"));
  assert.deepEqual(views(two), ["home", "projects"]);
  assert.equal(two.focus, panes(two.root)[1]!.id, "the new pane has the focus");
  const three = beside({ ...two, focus: "p0" }, rootOf("chat"));
  assert.deepEqual(views(three), ["home", "chat", "projects"], "beside the focused pane, the others untouched");
});

test("never more than MAX_PANES (6) panes, however much room there is", () => {
  assert.equal(MAX_PANES, 6);
  let l = single(rootOf("home"));
  for (let i = 0; i < 10; i++) l = split(l, l.focus, i % 2 ? "row" : "col", rootOf("chat"));
  assert.equal(panes(l.root).length, MAX_PANES);
  assert.equal(fits(l, 10_000, 10_000), true);
});

test("fits: every pane keeps 320 × 240 plus an 8 px gutter per divider; side by side the widths add up, stacked the heights do", () => {
  assert.deepEqual([MIN_W, MIN_H, GUTTER], [320, 240, 8]);
  const two = beside(single(rootOf("home")), rootOf("projects"));
  assert.equal(fits(two, 648, 240), true);
  // without the gutter, two panes at "exactly 640" would each end up under 320
  assert.equal(fits(two, 647, 900), false, "two 320 px panes and a gutter need 648");
  // home | (projects / projects): 648 wide, 488 high
  const nested = split(two, panes(two.root)[1]!.id, "col", rootOf("projects"));
  assert.deepEqual(minSize(nested.root), { w: 648, h: 488 });
  assert.equal(fits(nested, 648, 487), false);
  // at 1440 beside bb's thread list: 864 px with the open Sidebar, 1072 with the rail; three columns need 976
  const three = beside(two, rootOf("chat"));
  assert.equal(fits(three, 864, 852), false, "not beside the open Sidebar");
  assert.equal(fits(three, 1072, 852), true, "beside the rail");
  assert.equal(fits(three, 812, 770), false, "1180: one pane at a time, with the switcher");
});

test("a divider's sizes are written back as shares; nonsense sizes change nothing", () => {
  const l = split(single(rootOf("home")), "p0", "row", rootOf("projects"));
  const id = (l.root as Split).id;
  assert.deepEqual((setSizes(l, id, [30, 70]).root as Split).sizes, [0.3, 0.7]);
  assert.equal(setSizes(l, id, [0, 100]), l);
  assert.equal(setSizes(l, id, [50]), l, "the wrong count");
  assert.equal(setSizes(l, "nope", [30, 70]), l, "no such split");
});

test("the same page twice is two places: each Home pane keeps its filter, each Projects pane its project", () => {
  let l = beside(single(rootOf("home")), rootOf("home"));
  const [a, b] = panes(l.root);
  l = setRoute(l, b!.id, home("delivered"));
  l = setRoute(l, a!.id, home("needs", "card:1"));
  assert.deepEqual(panes(l.root).map((p) => p.route), [home("needs", "card:1"), home("delivered")]);
  let p = beside(single(rootOf("projects")), rootOf("projects"));
  p = setRoute(p, panes(p.root)[1]!.id, project("kite"));
  p = setRoute(p, panes(p.root)[0]!.id, project("ledger"));
  assert.deepEqual(panes(p.root).map((x) => x.route.path[0]), ["ledger", "kite"]);
});

test("closing gives the room back, collapses a one-child split, and never closes the last pane", () => {
  let l = split(single(rootOf("home")), "p0", "row", rootOf("projects"));
  l = close(l, panes(l.root)[1]!.id);
  assert.equal(l.root.kind, "pane", "no split around a single pane");
  assert.equal(l.focus, "p0");
  assert.deepEqual(close(l, "p0"), l, "the last pane stays");
});

test("closing the focused pane hands the focus to the pane beside it, not to the first pane", () => {
  // a | (b / c), focus on c: closing c leaves b, which took its room
  const l: Layout = { v: 2, focus: "c", root: { kind: "split", id: "s", dir: "row", sizes: [0.5, 0.5], children: [{ kind: "pane", id: "a", route: rootOf("home") }, { kind: "split", id: "t", dir: "col", sizes: [0.5, 0.5], children: [{ kind: "pane", id: "b", route: rootOf("chat") }, { kind: "pane", id: "c", route: rootOf("board") }] }] } };
  assert.equal(close(l, "c").focus, "b");
  assert.equal(close({ ...l, focus: "b" }, "b").focus, "c", "the first child hands it to the one after it");
  assert.equal(close({ ...l, focus: "a" }, "b").focus, "a", "closing another pane leaves the focus where it was");
});

test("setRoute changes one pane and focuses it", () => {
  const l = split(single(rootOf("home")), "p0", "row", rootOf("projects"));
  const v = setRoute(l, "p0", rootOf("chat"));
  assert.deepEqual(views(v), ["chat", "projects"]);
  assert.equal(v.focus, "p0");
});

test("a v2 layout round-trips with each pane's route; broken ones are refused", () => {
  const l = split(single(home("alerts", "post:9")), "p0", "row", project("kite"));
  assert.deepEqual(parse(JSON.parse(JSON.stringify(l)), VIEWS), l);
  assert.equal(parse({ root: { kind: "split", id: "s", dir: "row", sizes: [1], children: [{ kind: "pane", id: "a", view: "chat" }] } }, VIEWS), null);
  assert.equal(parse({ root: { kind: "split", id: "s", dir: "row", sizes: [0.5, 0.5], children: [{ kind: "pane", id: "a", view: "chat" }, { kind: "pane", id: "a", view: "chat" }] } }, VIEWS), null, "duplicate ids");
  assert.equal(parse("garbage", VIEWS), null);
  assert.equal(parse({ v: 2, root: { kind: "pane", id: "a", route: { view: "chat", path: "x", params: {} } }, focus: "a" }, VIEWS), null, "a malformed route");
  assert.equal(parse({ root: { kind: "pane", id: "a", view: "chat" }, focus: "nope" }, VIEWS)!.focus, "a", "an unknown focus falls to the first pane");
});

test("a v1 layout (each pane only a view) reads as v2, each pane at its page's root; old ids land where their links do", () => {
  const v1 = { root: { kind: "split", id: "s1", dir: "row", sizes: [0.3, 0.7], children: [{ kind: "pane", id: "a", view: "needs-you" }, { kind: "pane", id: "b", view: "projects" }] }, focus: "b" };
  const l = parse(v1, VIEWS)!;
  assert.equal(l.v, 2);
  assert.deepEqual(panes(l.root).map((p) => p.route), [home("needs"), rootOf("projects")], "an old Needs you pane opens Home on Needs you");
  assert.deepEqual((l.root as Split).sizes, [0.3, 0.7]);
  assert.equal(l.focus, "b");
  const agents = parse({ root: { kind: "pane", id: "a", view: "agents" }, focus: "a" }, VIEWS)!;
  assert.deepEqual(panes(agents.root)[0]!.route, rootOf("projects"), "the Agents tab (2026-11-16) is Projects");
});

test("a stale pane is dropped and the rest kept, with the focus moving off it", () => {
  const saved = { v: 2, root: { kind: "split", id: "s", dir: "row", sizes: [0.5, 0.5], children: [{ kind: "pane", id: "a", route: project("kite") }, { kind: "pane", id: "b", route: rootOf("gone-view") }] }, focus: "b" };
  const l = parse(saved, VIEWS)!;
  assert.deepEqual(l.root, { kind: "pane", id: "a", route: project("kite") }, "the project pane survives on its own");
  assert.equal(l.focus, "a");
  assert.equal(parse({ root: { kind: "pane", id: "x", view: "gone-view" }, focus: "x" }, VIEWS), null, "nothing valid left: the page starts on Home");
});

test("two Home panes from before (Needs you beside Home) now stay two panes, each on its own filter", () => {
  const two = { root: { kind: "split", id: "s", dir: "row", sizes: [1, 1], children: [{ kind: "pane", id: "a", view: "home" }, { kind: "pane", id: "b", view: "needs-you" }] }, focus: "b" };
  assert.deepEqual(panes(parse(two, VIEWS)!.root).map((p) => p.route), [rootOf("home"), home("needs")]);
});

test("a link lands: a pane showing exactly that place takes the focus; else the focused pane if on that page; else a pane on it", () => {
  const l: Layout = { v: 2, focus: "b", root: { kind: "split", id: "s", dir: "row", sizes: [0.5, 0.5], children: [{ kind: "pane", id: "a", route: home("needs") }, { kind: "pane", id: "b", route: rootOf("home") }] } };
  // the reload trap: the URL is the focused pane's own route; nothing may move (the other Home keeps Needs you)
  assert.equal(land(l, rootOf("home"), VIEWS).layout, l);
  const exact = land(l, home("needs"), VIEWS);
  assert.deepEqual([exact.pane, exact.layout.root], ["a", l.root], "the pane already there takes the focus, unchanged");
  const onPage = land(l, home("alerts"), VIEWS);
  assert.equal(onPage.pane, "b", "the focused Home pane, not the first Home pane");
  assert.deepEqual(panes(onPage.layout.root).map((p) => p.route), [home("needs"), home("alerts")]);
  const other = land({ ...l, root: { ...(l.root as Split), children: [{ kind: "pane", id: "a", route: rootOf("projects") }, { kind: "pane", id: "b", route: rootOf("chat") }] } }, project("kite"), VIEWS);
  assert.equal(other.pane, "a", "a pane already on Projects takes the project");
  const none = land(single(rootOf("chat")), rootOf("board"), VIEWS);
  assert.deepEqual(views(none.layout), ["board"], "else the focused pane");
});

test("fitSizes: a drop that would leave a pane under its minimum is laid out at the minimum in the first frame, not clamped a frame later", async () => {
  const { fitSizes, MIN_W, GUTTER } = await import("../app/layout.ts");
  const p = (id: string): Node => ({ kind: "pane", id, route: rootOf("home") });
  // the rail-flip case measured live: 0.5 / 0.25 / 0.25 of 1072 px left the last two at 264 px
  const l: Layout = { v: 2, focus: "a", root: { kind: "split", id: "s", dir: "row", sizes: [0.5, 0.25, 0.25], children: [p("a"), p("b"), p("c")] } };
  const room = 1072 - 2 * GUTTER;
  const out = fitSizes(l, 1072, 800).root as Split;
  const px = out.sizes.map((x) => x * room);
  assert.ok(px.every((v) => v >= MIN_W - 1e-6), `every pane at ${MIN_W} or more: ${px.join(", ")}`);
  assert.ok(Math.abs(out.sizes.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(Math.abs(px[1]! - MIN_W) < 1e-6 && Math.abs(px[2]! - MIN_W) < 1e-6, "the two under it get exactly the minimum; the first gives up the rest");
  assert.equal(out.children[0], l.root.kind === "split" ? l.root.children[0] : null, "panes are the same objects: nothing remounts");
  const roomy = fitSizes(l, 2000, 800).root as Split;
  assert.deepEqual(roomy.sizes, [0.5, 0.25, 0.25], "with room for all, the shares are the owner's");
  assert.equal(fitSizes(l, 600, 800), l, "a tree that can't fit is left alone (the switcher draws it)");
});

test("fitSizes reaches nested splits with the room they will have", async () => {
  const { fitSizes, MIN_H, GUTTER } = await import("../app/layout.ts");
  const p = (id: string): Node => ({ kind: "pane", id, route: rootOf("home") });
  const l: Layout = { v: 2, focus: "a", root: { kind: "split", id: "s", dir: "row", sizes: [0.5, 0.5], children: [p("a"), { kind: "split", id: "t", dir: "col", sizes: [0.9, 0.1], children: [p("b"), p("c")] }] } };
  const col = (fitSizes(l, 1000, 600).root as Split).children[1] as Split;
  assert.ok(Math.abs(col.sizes[1]! * (600 - GUTTER) - MIN_H) < 1e-6, "the short pane of the stack gets its 240 px");
});

test("gripsAt: a divider's grip stays off the point where a crossing gutter meets it", async () => {
  const { gripsAt } = await import("../app/layout.ts");
  const p = (id: string): Node => ({ kind: "pane", id, route: rootOf("home") });
  const plain: Split = { kind: "split", id: "s", dir: "row", sizes: [0.5, 0.5], children: [p("a"), p("b")] };
  assert.deepEqual(gripsAt(plain), [0.5], "no junction: centred, as shadcn draws it");
  // a | (b over c), split evenly: the stacked gutter meets the side-by-side one at its centre, where the grip was
  const even: Split = { kind: "split", id: "s", dir: "row", sizes: [0.5, 0.5], children: [p("a"), { kind: "split", id: "t", dir: "col", sizes: [0.5, 0.5], children: [p("b"), p("c")] }] };
  const [g] = gripsAt(even);
  assert.equal(g, 0.25, "the middle of the first of the two equal stretches");
  const uneven: Split = { ...even, children: [p("a"), { kind: "split", id: "t", dir: "col", sizes: [0.3, 0.7], children: [p("b"), p("c")] }] };
  assert.equal(gripsAt(uneven)[0], 0.65, "the middle of the longer stretch, below the junction at 0.3");
  // junctions from both sides count
  const both: Split = { kind: "split", id: "s", dir: "row", sizes: [0.5, 0.5], children: [{ kind: "split", id: "u", dir: "col", sizes: [0.6, 0.4], children: [p("a"), p("d")] }, { kind: "split", id: "t", dir: "col", sizes: [0.2, 0.8], children: [p("b"), p("c")] }] };
  assert.equal(gripsAt(both)[0], 0.4, "stops at 0.2 and 0.6: the longest stretch is 0.2 to 0.6");
  const stacked: Split = { kind: "split", id: "s", dir: "col", sizes: [0.5, 0.5], children: [{ kind: "split", id: "t", dir: "row", sizes: [0.5, 0.5], children: [p("a"), p("b")] }, p("c")] };
  assert.equal(gripsAt(stacked)[0], 0.25, "a stacked split's gutter, met by a side-by-side one from above");
});
