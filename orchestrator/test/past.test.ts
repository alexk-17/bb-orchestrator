// The Deliverables tab's promises (2026-11-16: Deliverables and Outputs in one, "so people can go look back and see past
// deliverables easily"; 2026-11-17: the tree was "really hard to navigate", so a flat list, and every file of every
// deliverable "within that folder structure as well as alongside the deliverables as full items"):
// - what waits for the owner is always first, and never in the list below;
// - past deliverables are newest first; the project filter follows the sidebar's order;
// - 2026-11-18, the owner ("we should still solve folders for the different projects"): under All projects, past
//   deliverables and files sit in one folder per project, one level only, in the sidebar's order, with their counts
//   after the filters; one project picked shows its rows with no folder;
// - a deliverable's files are its folder's, sorted into artifacts, images and videos, with the proof that shows them;
//   proof that couldn't be copied (missing, over the cap) is still listed, and says so;
// - an output naming a deliverable's file (its copy or the original) is that file's, never listed again; any other
//   output is loose, in Files, never lost;
// - a filter, kind or search drops nothing that matches it;
// - the arrow keys walk the list as a file explorer does, folders included.
// Made-up projects, leads and files only.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeliverableFolders, Deliverables, Outputs } from "../contract.ts";
import { ALL_PROJECTS, FILTERS, KINDS, OPEN_MAX, START, allOpen, deliverablesTab, fileItems, folderKey, folderOpen, fold, mergeOpen, rowOpen, rowsOf, servedBy, shownDeliverable, treeKey, trimOpen, type OpenStores, type Row, type View } from "../app/past.ts";
import { RENAMED_VIEWS, panes, parse } from "../app/layout.ts";
import { manualSectionOrder, sidebarOrder } from "../core/project-order.ts";

type D = Deliverables[number];
type O = Outputs[number];
type P = D["revisions"][number]["proof"][number];

let n = 0;
function del(p: Partial<D> & { proof?: (Partial<P> & { path?: string; url?: string })[]; points?: string[] } = {}): D {
  const id = p.id ?? `v-${++n}`;
  const rev = p.rev ?? 1;
  const proof = (p.proof ?? [{ path: `/work/${id}/shot.png` }]).map((x, i) => ({ id: `${id}-p${i}`, kind: x.url ? ("link" as const) : ("image" as const), caption: "c", pr: null, ...x, path: x.path ?? null, url: x.url ?? null, hostId: x.path ? "h1" : null }));
  const points = (p.points ?? []).map((headline) => ({ kind: "finding" as const, headline, why: "because" }));
  return {
    id,
    project: p.project === undefined ? "alpha" : p.project,
    lead: p.lead ?? "lead:alpha",
    leadMon: null,
    title: p.title ?? `Deliverable ${id}`,
    summary: p.summary ?? "A summary",
    state: p.state ?? "approved",
    rev,
    createdAt: p.createdAt ?? 1,
    updatedAt: p.updatedAt ?? 1,
    revisions: p.revisions ?? [{ rev, summary: p.summary ?? "A summary", at: "2026-11-16T10:00:00Z", proof, blocks: [], points, prs: [] }],
    feedback: [],
    withdrawn: null,
    next: null,
  };
}
function out(p: Partial<O> = {}): O {
  const id = p.id ?? `o-${++n}`;
  return { id, title: p.title ?? `Output ${id}`, kind: p.kind ?? "image", path: p.path === undefined ? `/work/files/${id}.png` : p.path, url: p.url ?? null, hostId: "h1", note: p.note ?? null, project: p.project === undefined ? "alpha" : p.project, author: "thread:alpha:1", at: p.at ?? 1, gone: p.gone ?? false };
}
/** A deliverable's folder as the server lists it. */
function folder(id: string, names: string[], at = 5): DeliverableFolders["folders"][string] {
  const root = `/state/deliverables/alpha/2026-11-17-x-${id}`;
  return {
    folder: root,
    readme: `${root}/README.md`,
    files: names.map((name) => {
      const kind = /\.(png|jpe?g|gif|webp|avif|svg)$/.test(name) ? ("images" as const) : /\.(mp4|webm|mov|m4v)$/.test(name) ? ("videos" as const) : ("artifacts" as const);
      return { path: `${root}/${kind}/${name}`, name, kind, bytes: 10, at, dir: false };
    }),
  };
}

const order = (...slugs: string[]) => slugs.map((slug) => ({ slug, monType: null }));
const pastIds = (ds: D[], os: O[] = [], v: View = START) => deliverablesTab(ds, os, v).past.map((d) => d.id);

test("what waits for the owner comes first, newest first, and is never repeated in the list, under every filter and search", () => {
  const old = del({ id: "v-old-review", state: "review", updatedAt: 10 });
  const newer = del({ id: "v-new-review", state: "review", updatedAt: 20, project: "beta" });
  const past = del({ id: "v-past", state: "approved", updatedAt: 99 });
  for (const f of FILTERS) {
    for (const v of [{ ...START, filter: f.id }, { ...START, filter: f.id, project: "gamma", query: "nothing-matches-this" }] as View[]) {
      const tab = deliverablesTab([past, old, newer], [out({ at: 500 })], v);
      assert.deepEqual(tab.review.map((r) => r.d.id), ["v-new-review", "v-old-review"], `in review leads under ${JSON.stringify(v)}`);
      assert.ok(!tab.past.some((d) => d.id.endsWith("-review")), "and is not drawn again below");
    }
  }
});

/** The rows as the owner reads them: a folder as `[project count]`, a deliverable or file by its id, indented under it. */
const shape = (rows: Row[]) =>
  rows.map((r) => {
    const n = r.node;
    const name = n.t === "project" ? `[${n.project ?? "none"} ${n.count}]` : n.t === "deliverable" ? n.d.id : (n.f.output?.id ?? n.f.d!.id);
    return `${"  ".repeat(r.level)}${name}`;
  });

test("under All projects, past deliverables are one folder per project, one level only, in the sidebar's order, newest first inside", () => {
  const ds = [
    del({ id: "v-mid", updatedAt: 5, project: "beta" }),
    del({ id: "v-new", updatedAt: 9 }),
    del({ id: "v-old", updatedAt: 1, project: null }),
    del({ id: "v-alpha-old", updatedAt: 2 }),
    del({ id: "v-gone", updatedAt: 3, project: "deleted" }),
  ];
  assert.deepEqual(pastIds(ds), ["v-new", "v-mid", "v-gone", "v-alpha-old", "v-old"], "the tab's own list stays newest first");
  const tab = deliverablesTab(ds, [], START, order("beta", "alpha"));
  assert.deepEqual(shape(rowsOf(tab, START, () => false)), ["[beta 1]", "  v-mid", "[alpha 2]", "  v-new", "  v-alpha-old", "[deleted 1]", "  v-gone", "[none 1]", "  v-old"]);
  for (const r of rowsOf(tab, START, () => true))
    if (r.node.t === "project") assert.ok(r.level === 0 && r.parent === null, "a folder is at the top");
    else assert.ok(r.level === 1 && r.parent === folderKey(r.node.t === "deliverable" ? r.node.d.project : null), "a deliverable sits in its project's folder, never deeper");
});

test("one project picked shows its deliverables with no folder", () => {
  const ds = [del({ id: "v-a", project: "beta" }), del({ id: "v-b" }), del({ id: "v-c", project: null })];
  for (const [project, ids] of [["beta", ["v-a"]], ["", ["v-c"]]] as const) {
    const v = { ...START, project };
    assert.deepEqual(shape(rowsOf(deliverablesTab(ds, [], v), v, () => false)), [...ids], `${project || "No project"} alone, at the top`);
  }
});

test("a closed folder keeps its header and count but hides its rows; folders start open", () => {
  const ds = [del({ id: "v-a", project: "beta", updatedAt: 2 }), del({ id: "v-b", updatedAt: 1 })];
  const tab = deliverablesTab(ds, [], START);
  assert.deepEqual(shape(rowsOf(tab, START, () => false)), ["[alpha 1]", "  v-b", "[beta 1]", "  v-a"], "open by default");
  const closed = (key: string) => key !== folderKey("beta");
  assert.deepEqual(shape(rowsOf(tab, START, () => false, closed)), ["[alpha 1]", "  v-b", "[beta 1]"]);
});

test("a search opens every folder with a match for as long as it is typed, and leaves the viewer's saved folders alone", () => {
  const ds = [del({ id: "v-a", project: "beta", title: "Login fix" }), del({ id: "v-b", title: "Login redo" })];
  const saved = { [folderKey("beta")]: false, [folderKey("alpha")]: false }; // the viewer closed both
  const login = { ...START, query: "login" };
  const tab = deliverablesTab(ds, [], login);
  assert.deepEqual(shape(rowsOf(tab, login, () => false, folderOpen(login, saved, {}))), ["[alpha 1]", "  v-b", "[beta 1]", "  v-a"], "both open while searching");
  const closedNow = { [folderKey("beta")]: false };
  assert.deepEqual(shape(rowsOf(tab, login, () => false, folderOpen(login, saved, closedNow))), ["[alpha 1]", "  v-b", "[beta 1]"], "one closed during the search");
  assert.deepEqual(saved, { [folderKey("beta")]: false, [folderKey("alpha")]: false }, "the saved state is untouched");
  const cleared = deliverablesTab(ds, [], START);
  assert.deepEqual(shape(rowsOf(cleared, START, () => false, folderOpen(START, saved, closedNow))), ["[alpha 1]", "[beta 1]"], "clearing the search brings the saved state back");
  assert.deepEqual(shape(rowsOf(cleared, START, () => false, folderOpen({ ...START, query: "   " }, saved, {}))), ["[alpha 1]", "[beta 1]"], "spaces are no search");
});

test("filters and search reach into folders: a folder with no match is gone, and its count is what matches", () => {
  const ds = [
    del({ id: "v-a1", project: "beta", state: "approved", title: "Login fix", updatedAt: 3 }),
    del({ id: "v-a2", project: "beta", state: "withdrawn", title: "Login redo", updatedAt: 2 }),
    del({ id: "v-b", state: "approved", title: "Billing" }),
  ];
  const withdrawn = { ...START, filter: "withdrawn" as const };
  assert.deepEqual(shape(rowsOf(deliverablesTab(ds, [], withdrawn), withdrawn, () => false)), ["[beta 1]", "  v-a2"]);
  const login = { ...START, query: "login" };
  assert.deepEqual(shape(rowsOf(deliverablesTab(ds, [], login), login, () => false)), ["[beta 2]", "  v-a1", "  v-a2"]);
});

// 2026-11-18, the owner: "Collapse all" and "Expand all" didn't work. They changed the rows only, so Collapse all left
// every project folder open (from a fresh load it did nothing) and Expand all left a closed folder's rows hidden.
const NONE: OpenStores = { rows: {}, folders: {}, search: {} };
/** What the list draws from the stores, as past-view.tsx reads them; the rows store as it is saved. */
const drawn = (tab: ReturnType<typeof deliverablesTab>, v: View, s: OpenStores) => rowsOf(tab, v, rowOpen(trimOpen(s.rows)), folderOpen(v, s.folders, s.search));
const openShape = (rows: Row[]) => rows.map((r) => `${shape([r])[0]}${r.open ? " +" : ""}`);

test("Collapse all closes every project folder and every row, even from a fresh load", () => {
  const ds = [del({ id: "v-a", project: "beta", updatedAt: 2 }), del({ id: "v-b", updatedAt: 1 })];
  const tab = deliverablesTab(ds, [], START, order("alpha", "beta"));
  assert.deepEqual(openShape(drawn(tab, START, NONE)), ["[alpha 1] +", "  v-b", "[beta 1] +", "  v-a"], "folders start open");
  assert.deepEqual(openShape(drawn(tab, START, allOpen(NONE, tab, START, false))), ["[alpha 1]", "[beta 1]"], "from a fresh load, it closes them");
  const opened = allOpen({ ...NONE, rows: { "d:v-a": true } }, tab, START, false); // a row the viewer opened by hand
  const reopened = { ...opened, folders: mergeOpen(opened.folders, { [folderKey("beta")]: true }) };
  assert.deepEqual(openShape(drawn(tab, START, reopened)), ["[alpha 1]", "[beta 1] +", "  v-a"], "its rows are closed too: reopening the folder shows them closed");
  const after = allOpen(allOpen(NONE, tab, START, true), tab, START, false);
  assert.deepEqual(openShape(drawn(tab, START, after)), ["[alpha 1]", "[beta 1]"], "no folder is left open");
  assert.deepEqual(openShape(drawn(tab, START, allOpen(after, tab, START, true))), ["[alpha 1] +", "  v-b +", "[beta 1] +", "  v-a +"], "and Expand all undoes it");
});

test("Expand all opens every folder, a closed one too, and every row in it", () => {
  const ds = [del({ id: "v-a", project: "beta", updatedAt: 2 }), del({ id: "v-b", updatedAt: 1 }), del({ id: "v-c", updatedAt: 0 })];
  const tab = deliverablesTab(ds, [], START, order("alpha", "beta"));
  const closedOne: OpenStores = { ...NONE, folders: { [folderKey("beta")]: false } }; // the viewer closed beta by hand
  assert.deepEqual(openShape(drawn(tab, START, closedOne)), ["[alpha 2] +", "  v-b", "  v-c", "[beta 1]"]);
  const all = ["[alpha 2] +", "  v-b +", "  v-c +", "[beta 1] +", "  v-a +"];
  const expanded = allOpen(closedOne, tab, START, true);
  assert.deepEqual(openShape(drawn(tab, START, expanded)), all, "the closed folder reopens and shows its rows");
  const shutAgain = { ...expanded, folders: mergeOpen(expanded.folders, { [folderKey("alpha")]: false }) };
  assert.deepEqual(openShape(drawn(tab, START, allOpen(shutAgain, tab, START, true))), all, "a folder closed after Expand all reopens on the next one");
});

test("during a search the buttons change that search's folders; the saved folders wait for the search to clear", () => {
  const ds = [del({ id: "v-a", project: "beta", title: "Login fix" }), del({ id: "v-b", title: "Login redo" }), del({ id: "v-c", project: "gamma", title: "Billing" })];
  const saved = { [folderKey("beta")]: false }; // the viewer closed beta before searching
  const login = { ...START, query: "login" };
  const tab = deliverablesTab(ds, [], login, order("alpha", "beta", "gamma"));
  const collapsed = allOpen({ ...NONE, folders: saved }, tab, login, false);
  assert.deepEqual(openShape(drawn(tab, login, collapsed)), ["[alpha 1]", "[beta 1]"], "Collapse all closes the search's folders");
  assert.deepEqual(collapsed.folders, saved, "the saved folders are untouched");
  const expanded = allOpen(collapsed, tab, login, true);
  assert.deepEqual(openShape(drawn(tab, login, expanded)), ["[alpha 1] +", "  v-b +", "[beta 1] +", "  v-a +"], "Expand all opens them, rows too");
  assert.deepEqual(expanded.folders, saved, "still untouched");
  const cleared = deliverablesTab(ds, [], START, order("alpha", "beta", "gamma"));
  assert.deepEqual(openShape(drawn(cleared, START, { ...expanded, search: {} })), ["[alpha 1] +", "  v-b +", "[beta 1]", "[gamma 1] +", "  v-c +"], "clearing the search brings the saved folders back");
});

test("with one project picked there are no folders: the buttons change the rows only", () => {
  const ds = [del({ id: "v-a", project: "beta", updatedAt: 2 }), del({ id: "v-b", updatedAt: 1 })];
  const beta = { ...START, project: "beta" };
  const tab = deliverablesTab(ds, [], beta);
  const s: OpenStores = { ...NONE, folders: { [folderKey("beta")]: false } };
  const expanded = allOpen(s, tab, beta, true);
  assert.deepEqual(openShape(drawn(tab, beta, expanded)), ["v-a +"]);
  assert.deepEqual(expanded.folders, s.folders, "the folders are left as the viewer had them");
  assert.deepEqual(openShape(drawn(tab, beta, allOpen(expanded, tab, beta, false))), ["v-a"]);
});

test("Expand all holds on a list past the store's 500 entries, and a row closed after it stays closed", () => {
  const ds = Array.from({ length: OPEN_MAX + 100 }, (_, i) => del({ id: `v-${i}`, updatedAt: i }));
  const tab = deliverablesTab(ds, [], START);
  let s = allOpen(NONE, tab, START, true);
  s = { ...s, rows: trimOpen(s.rows) }; // as saved
  assert.equal(drawn(tab, START, s).filter((r) => r.node.t === "deliverable" && r.open).length, ds.length, "every row open, none trimmed back");
  // then the viewer toggles 500 rows: the oldest entries are trimmed, never Expand all's choice
  for (let i = 0; i < OPEN_MAX; i++) s = { ...s, rows: trimOpen(mergeOpen(s.rows, { [`d:v-${i}`]: true })) };
  assert.equal(drawn(tab, START, s).find((r) => r.node.key === `d:v-${OPEN_MAX + 50}`)?.open, true, "a row never touched since Expand all is still open");
  assert.equal(drawn(tab, START, { ...s, rows: trimOpen(mergeOpen(s.rows, { "d:v-7": false })) }).find((r) => r.node.key === "d:v-7")?.open, false, "a row closed after Expand all stays closed");
});

test("Files are grouped the same way: each project's files and loose outputs in its folder, No project last", () => {
  const ds = [del({ id: "v-a", project: "beta", updatedAt: 3 }), del({ id: "v-b", updatedAt: 1 })];
  const os = [out({ id: "o-loose", project: "beta", at: 2 }), out({ id: "o-none", project: null, at: 5 })];
  const fv = { ...START, filter: "files" as const };
  const tab = deliverablesTab(ds, os, fv, order("alpha", "beta"));
  assert.deepEqual(shape(rowsOf(tab, fv, () => false)), ["[alpha 1]", "  v-b", "[beta 2]", "  v-a", "  o-loose", "[none 1]", "  o-none"]);
  const images = { ...fv, kind: "videos" as const };
  assert.deepEqual(rowsOf(deliverablesTab(ds, os, images), images, () => false), [], "a kind with no files: no empty folders");
  const one = { ...fv, project: "beta" };
  assert.deepEqual(shape(rowsOf(deliverablesTab(ds, os, one), one, () => false)), ["v-a", "o-loose"], "one project: its files, no folder");
});

test("the project filter lists projects in the sidebar's order; one it doesn't name comes after, by name, and No project last", () => {
  const ds = [del({ project: "zeta" }), del({ project: null }), del({ project: "alpha" }), del({ project: "omega" }), del({ project: "beta" })];
  assert.deepEqual(deliverablesTab(ds, [], START, order("omega", "alpha", "zeta")).projects, ["omega", "alpha", "zeta", "beta", null]);
});

test("a deliverable's files are its folder's, sorted into artifacts, images and videos, each with the proof that shows it", () => {
  const d = del({ id: "v-f" });
  const f = folder("v-f", ["after.png", "demo.webm", "report.md", "notes.txt"]);
  // the proof now shows the copy; its original stays as source
  d.revisions[0]!.proof[0] = { ...d.revisions[0]!.proof[0]!, path: f.files[0]!.path, source: "/work/thread/after.png", stored: "copied" };
  const tab = deliverablesTab([d], [], START, [], { "v-f": f });
  const files = tab.filesBy.get("v-f")!;
  assert.deepEqual(files.map((x) => [x.name, x.kind]), [["after.png", "images"], ["demo.webm", "videos"], ["report.md", "artifacts"], ["notes.txt", "artifacts"]]);
  assert.equal(files[0]!.proof?.id, "v-f-p0", "the screenshot is served by its proof id");
  assert.equal(files[2]!.proof, null, "a thread's note in the folder is a file too, without proof");
  for (const k of KINDS) {
    const v = { ...START, filter: "files" as const, kind: k.id };
    assert.deepEqual(deliverablesTab([d], [], v, [], { "v-f": f }).files.map((x) => x.name).sort(), files.filter((x) => k.id === "all" || x.kind === k.id).map((x) => x.name).sort(), k.id);
  }
  assert.deepEqual(tab.kinds, { all: 4, artifacts: 2, images: 1, videos: 1 });
});

test("proof that never reached the folder is still listed: missing says so, over the cap and pre-folder ones keep their path", () => {
  const d = del({
    id: "v-m",
    proof: [
      { path: "/gone/worktree/lost.png", stored: "missing" },
      { path: "/work/big.mp4", kind: "video", stored: "too_big", bytes: 300 },
      { path: "/work/old.txt", kind: "text" },
      { url: "https://example.test/pr" },
    ],
  });
  const files = deliverablesTab([d], [], START, [], { "v-m": folder("v-m", []) }).filesBy.get("v-m")!;
  assert.deepEqual(files.map((f) => [f.name, f.kind, f.missing]), [["lost.png", "images", true], ["big.mp4", "videos", false], ["old.txt", "artifacts", false]]);
  assert.equal(files[1]!.proof?.id, "v-m-p1", "over the cap: still served, from the original");
  assert.ok(!files.some((f) => f.url), "a link isn't a file");
});

test("an output naming a deliverable's file, by its copy or its original, is that file's and never listed again", () => {
  const d = del({ id: "v-o" });
  const f = folder("v-o", ["shot.png", "report.md"]);
  d.revisions[0]!.proof[0] = { ...d.revisions[0]!.proof[0]!, path: f.files[0]!.path, source: "/work/thread/shot.png", stored: "copied" };
  const byOriginal = out({ id: "o-orig", path: "/work/thread/shot.png" });
  const byCopy = out({ id: "o-copy", kind: "doc", path: f.files[1]!.path }); // a thread's output the archive routed in
  const loose = out({ id: "o-loose" });
  const otherProject = out({ id: "o-beta", path: "/work/thread/shot.png", project: "beta" }); // same path, another project
  const { items, loose: rest } = fileItems([d], [byOriginal, byCopy, loose, otherProject], { "v-o": f });
  assert.equal(items.find((x) => x.name === "shot.png")!.output?.id, "o-orig");
  assert.equal(items.find((x) => x.name === "report.md")!.output?.id, "o-copy");
  assert.deepEqual(rest.map((x) => x.output!.id).sort(), ["o-beta", "o-loose"]);
});

test("no output is lost: each lands exactly once, on a file or loose, withdrawn deliverables and older revisions included", () => {
  const ds = [
    del({ id: "v-a", proof: [{ path: "/work/a.png" }] }),
    del({
      id: "v-b",
      rev: 2,
      revisions: [
        { rev: 1, summary: "s", at: "x", proof: [{ id: "b1", kind: "image", caption: "", path: "/work/b-old.png", url: null, hostId: "h1", pr: null }], blocks: [], points: [], prs: [] },
        { rev: 2, summary: "s", at: "y", proof: [{ id: "b2", kind: "image", caption: "", path: "/work/b-new.png", url: null, hostId: "h1", pr: null }], blocks: [], points: [], prs: [] },
      ],
    }),
    del({ id: "v-w", state: "withdrawn", proof: [{ path: "/work/w.png" }] }),
  ];
  const os = [
    out({ id: "o-a", path: "/work/a.png" }),
    out({ id: "o-b-old", path: "/work/b-old.png" }),
    out({ id: "o-b-new", path: "/work/b-new.png" }),
    out({ id: "o-w", path: "/work/w.png" }),
    out({ id: "o-other-project", path: "/work/a.png", project: "beta" }),
    out({ id: "o-no-project", project: null }),
    out({ id: "o-deleted-project", project: "retired" }),
  ];
  const files = deliverablesTab(ds, os, { ...START, filter: "files" }).files;
  const drawn = files.flatMap((f) => (f.output ? [f.output.id] : []));
  assert.deepEqual(drawn.sort(), os.map((o) => o.id).sort(), "every output exactly once in Files");
  assert.equal(files.find((f) => f.output?.id === "o-b-old")?.d?.id, "v-b", "an older revision's file is still its deliverable's");
});

test("a loose output is in Files with its own project, and the project filter finds it", () => {
  const tab = deliverablesTab([del({ project: "alpha" })], [out({ id: "o-beta", project: "beta" }), out({ id: "o-none", project: null })], { ...START, filter: "files", project: "beta" }, order("alpha", "beta"));
  assert.deepEqual(tab.files.map((f) => f.output?.id), ["o-beta"]);
  assert.deepEqual(deliverablesTab([], [out({ id: "o-none", project: null })], { ...START, filter: "files", project: "" }).files.map((f) => f.output?.id), ["o-none"]);
});

test("a loose output whose file is gone is Missing, so the grid tile and the list row say so; a kept one is not", () => {
  const { loose } = fileItems([], [out({ id: "o-gone", gone: true }), out({ id: "o-here" }), out({ id: "o-link", kind: "link", path: null, url: "https://example.test/x" })]);
  const by = Object.fromEntries(loose.map((f) => [f.output!.id, f]));
  assert.equal(by["o-gone"]!.missing, true, "the owner is told the file is gone, not shown a blank picture");
  assert.equal(servedBy(by["o-gone"]!), null, "nothing is asked of the proof route for it");
  assert.equal(by["o-here"]!.missing, false);
  assert.equal(by["o-link"]!.missing, false, "a link is never a missing file");
});

test("no filter, kind or search drops an item that matches it", () => {
  const ds = [
    del({ id: "v-1", project: "alpha", state: "approved", title: "Harbour lights rollout" }),
    del({ id: "v-2", project: "beta", state: "changes", summary: "The Lantern route needs a second pass" }),
    del({ id: "v-3", project: null, state: "withdrawn", points: ["Kite festival cache was cold"] }),
    del({ id: "v-4", project: "beta", state: "approved", title: "Kite festival map", updatedAt: 3 }),
  ];
  const os = [out({ id: "o-1", title: "Harbour photo", project: "alpha" }), out({ id: "o-2", title: "Map export", note: "kite festival draft", project: "beta", kind: "doc", path: "/work/map.md" }), out({ id: "o-3", title: "Loose sketch", project: "gamma" })];
  const text = (d: D) => [d.title, d.summary, ...d.revisions.flatMap((r) => [r.summary, ...r.points.flatMap((p) => [p.headline, p.why])])].join(" ").toLowerCase();
  const otext = (o: O) => [o.title, o.note ?? "", o.path ?? ""].join(" ").toLowerCase();
  const hit = (t: string, q: string) => q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => t.includes(w));
  for (const f of FILTERS) {
    for (const project of [ALL_PROJECTS, "alpha", "beta", "gamma", ""]) {
      for (const query of ["", "kite", "FESTIVAL kite", "lantern", "harbour", "second pass", "sketch", "zzz"]) {
        const v = { ...START, filter: f.id, project, query };
        const tab = deliverablesTab(ds, os, v, order("alpha", "beta", "gamma"));
        const inP = (p: string | null) => project === ALL_PROJECTS || (p ?? "") === project;
        const wantDs = f.id === "files" ? [] : ds.filter((d) => (f.id === "all" || d.state === f.id || (f.id === "decided" && (d.state === "approved" || d.state === "changes"))) && inP(d.project) && hit(text(d), query));
        const why = JSON.stringify(v);
        assert.deepEqual(tab.past.map((d) => d.id).sort(), wantDs.map((d) => d.id).sort(), why);
        const wantOs = os.filter((o) => inP(o.project) && hit(otext(o), query));
        assert.deepEqual(tab.files.flatMap((x) => (x.d ? [] : [x.output!.id])).sort(), wantOs.map((o) => o.id).sort(), why);
      }
    }
  }
  // search reaches a file by its deliverable's title too
  const files = deliverablesTab(ds, os, { ...START, filter: "files", query: "harbour lights" }).files;
  assert.ok(files.some((x) => x.d?.id === "v-1"), "a deliverable's screenshot is found by the deliverable's title");
});

test("search reads the points a lead wrote, not only the title", () => {
  const d = del({ id: "v-pt", title: "Weekly sweep", points: ["Tidepool index rebuilt"] });
  assert.deepEqual(pastIds([d], [], { ...START, query: "tidepool" }), ["v-pt"]);
});

test("files are newest first, across deliverables and loose outputs", () => {
  const a = del({ id: "v-a", updatedAt: 1, proof: [{ url: "https://example.test/a" }] });
  const b = del({ id: "v-b", updatedAt: 2, proof: [{ url: "https://example.test/b" }] });
  const tab = deliverablesTab([a, b], [out({ id: "o-late", at: 50 })], { ...START, filter: "files" }, [], { "v-a": folder("v-a", ["a.png"], 10), "v-b": folder("v-b", ["b.png"], 30) });
  assert.deepEqual(tab.files.map((f) => f.output?.id ?? f.name), ["o-late", "b.png", "a.png"]);
});

test("a file is dated when it was delivered, not when the backfill copied it", () => {
  // every file copied in one backfill run shares a time; dating by it would make newest first say nothing
  const copied = Date.parse("2026-11-18T00:47:00Z");
  const img = (id: string) => `/state/deliverables/alpha/2026-11-17-x-${id}/images/${id}.png`;
  const rev = (id: string, at: string) => [{ rev: 1, summary: "s", at, proof: [{ id: `${id}-p0`, kind: "image" as const, caption: "c", pr: null, path: img(id), url: null, hostId: "h1" }], blocks: [], points: [], prs: [] }];
  const a = del({ id: "a", updatedAt: Date.parse("2026-11-16T11:00:00Z"), revisions: rev("a", "2026-11-16T10:00:00Z") });
  const b = del({ id: "b", updatedAt: Date.parse("2026-11-17T11:00:00Z"), revisions: rev("b", "2026-11-17T10:00:00Z") });
  const tab = deliverablesTab([a, b], [], { ...START, filter: "files" }, [], { a: folder("a", ["a.png", "notes.md"], copied), b: folder("b", ["b.png"], copied) });
  const at = Object.fromEntries(tab.files.map((f) => [f.name, f.at]));
  assert.equal(at["b.png"], Date.parse("2026-11-17T10:00:00Z"), "proof takes its revision's time");
  assert.equal(at["notes.md"], a.updatedAt, "a file no proof shows takes its deliverable's time");
  assert.deepEqual(tab.files.map((f) => f.name), ["b.png", "notes.md", "a.png"]);
});

test("every image in the Files grid has a picture: a loose output's image is served by its output id", () => {
  // 2026-11-17: 123 of 400 image tiles showed the placeholder; all were outputs, and only proof was served
  const shot = out({ id: "o-shot", path: "/work/files/shot.png" });
  const gone = del({ id: "v-g", proof: [{ path: "/work/v-g/gone.png", stored: "missing" }] });
  const tab = deliverablesTab([del({ id: "v-p" }), gone], [shot, out({ id: "o-svg", path: "/work/files/logo.svg" }), out({ id: "o-md", kind: "doc", path: "/work/files/notes.md" })], { ...START, filter: "files", kind: "all" });
  const by = Object.fromEntries(tab.files.map((f) => [f.name, servedBy(f)]));
  assert.deepEqual(by[shot.title], { output: "o-shot" }, "a loose output's image is served");
  assert.deepEqual(by["shot.png"], { proof: "v-p-p0" }, "a proof image still by its proof id");
  assert.equal(by["gone.png"], null, "only a truly missing file has no picture");
  assert.equal(by["Output o-svg"], null, "never SVG");
  assert.equal(by["Output o-md"], null, "a doc opens in bb's preview");
});

test("the arrow keys walk the folders and their rows as a file explorer does; Enter opens a file or a row", () => {
  const ds = [del({ id: "v-x", updatedAt: 2 }), del({ id: "v-y", updatedAt: 1 }), del({ id: "v-z", project: "beta", updatedAt: 3 })];
  const tab = deliverablesTab(ds, [], START, order("alpha", "beta"));
  const closed = rowsOf(tab, START, () => false);
  assert.deepEqual(shape(closed), ["[alpha 2]", "  v-x", "  v-y", "[beta 1]", "  v-z"]);
  const A = folderKey("alpha");
  const B = folderKey("beta");
  assert.deepEqual(treeKey(closed, A, "ArrowDown"), { focus: "d:v-x" }, "Down from a folder goes into it");
  assert.deepEqual(treeKey(closed, "d:v-y", "ArrowDown"), { focus: B }, "and out of it to the next folder");
  assert.deepEqual(treeKey(closed, B, "ArrowUp"), { focus: "d:v-y" });
  assert.deepEqual(treeKey(closed, A, "ArrowRight"), { focus: "d:v-x" }, "Right on an open folder goes to its first row");
  assert.deepEqual(treeKey(closed, A, "ArrowLeft"), { toggle: A }, "Left closes an open folder");
  assert.deepEqual(treeKey(closed, A, "Enter"), { toggle: A }, "Enter opens or closes a folder");
  assert.deepEqual(treeKey(closed, "d:v-y", "ArrowLeft"), { focus: A }, "Left on a closed row goes to its folder");
  assert.deepEqual(treeKey(closed, "d:v-x", "ArrowRight"), { toggle: "d:v-x" }, "Right opens a closed row");
  assert.deepEqual(treeKey(closed, "d:v-x", "Home"), { focus: A });
  assert.deepEqual(treeKey(closed, "d:v-x", "End"), { focus: "d:v-z" });
  assert.deepEqual(treeKey(closed, "d:v-z", "ArrowDown"), { focus: "d:v-z" }, "the end holds");
  const shut = rowsOf(tab, START, () => false, (k) => k !== A);
  assert.deepEqual(treeKey(shut, A, "ArrowDown"), { focus: B }, "a closed folder's rows are skipped");
  assert.deepEqual(treeKey(shut, A, "ArrowRight"), { toggle: A }, "Right opens a closed folder");
  assert.deepEqual(treeKey(shut, A, "ArrowLeft"), {}, "Left on a closed folder stays: there is no level above");
  const open = rowsOf(tab, START, () => true);
  assert.deepEqual(treeKey(open, "d:v-x", "ArrowLeft"), { toggle: "d:v-x" }, "Left closes an open row first");
  assert.deepEqual(treeKey(open, "d:v-x", "Enter"), { toggle: "d:v-x" });
  const fv = { ...START, filter: "files" as const };
  const files = rowsOf(deliverablesTab(ds, [], fv, order("alpha", "beta")), fv, () => false);
  const file = files.find((r) => r.node.t === "file")!;
  assert.ok(file.open === null && file.parent === A, "Files rows are files, in their folder");
  assert.deepEqual(treeKey(files, file.node.key, "Enter"), { activate: file.node.key }, "Enter opens a file");
  assert.deepEqual(treeKey(files, file.node.key, "ArrowLeft"), { focus: A }, "Left on a file goes to its folder");
  assert.equal(treeKey(open, "d:v-x", "j"), null, "J and K stay the page's keys");
});

test("the sidebar order is bb's section order, mapped to projects; unsectioned projects follow in placing order", () => {
  const sections = [
    { id: "s1", name: "Orchestrator" },
    { id: "s2", name: "Harbour Lights" },
    { id: "s3", name: "Kite Festival" },
  ];
  const place = ["kite-festival", "harbour-lights", "tidepool"]; // priority, then slug
  assert.deepEqual(sidebarOrder(place, sections, ["pinned", "section:s2", "section:s1", "section:s3", "threads"]), ["harbour-lights", "kite-festival", "tidepool"]);
  assert.deepEqual(sidebarOrder(place, sections, []), ["harbour-lights", "kite-festival", "tidepool"], "no preference: bb's listing order");
  // The Thread list plugin's answer is what the sidebar draws; bb's sidebar.* copy is a stale seed (live, 2026-11-16, it
  // still said "pinned, sections, threads" while the sidebar showed the owner's dragged order), so it must not be read.
  assert.deepEqual(manualSectionOrder({ preferences: { manualSectionOrder: ["pinned", "section:a", 3, "threads"] } }), ["pinned", "section:a", "threads"]);
  assert.deepEqual(manualSectionOrder({ preferences: { "sidebar.manualSectionOrder": ["section:b"] } }), [], "the stale bb copy is ignored");
  assert.deepEqual(manualSectionOrder(null), []);
});

test("a saved pane on the old Outputs tab opens Home (Delivered, step 3) instead of throwing the owner's layout away", () => {
  const saved = { root: { kind: "split", id: "s", dir: "row", sizes: [0.5, 0.5], children: [{ kind: "pane", id: "a", view: "outputs" }, { kind: "pane", id: "b", view: "board" }] }, focus: "a" };
  const views = [{ id: "home", subPath: "" }, { id: "projects", subPath: "projects" }, { id: "board", subPath: "board" }];
  assert.deepEqual(panes(parse(saved, views)!.root).map((p) => p.route), [{ view: "home", path: [], params: { filter: "delivered", files: "1" } }, { view: "board", path: [], params: {} }], "on its Files filter, as an Outputs link opens");
  assert.equal(RENAMED_VIEWS.agents, "projects", "the earlier rename still holds");
});

test("wide Deliverables: what waits for the owner shows first; a pick stays while it exists; nothing to show is null", () => {
  const old = del({ id: "v-old", state: "approved", updatedAt: 100 });
  const newer = del({ id: "v-new", state: "changes", updatedAt: 300 });
  const waiting = del({ id: "v-wait", state: "review", updatedAt: 200 });
  // in review beats a newer past one: the owner's next action is what the detail opens on
  assert.equal(shownDeliverable([old, newer, waiting], null)?.id, "v-wait");
  // nothing in review: the newest
  assert.equal(shownDeliverable([old, newer], null)?.id, "v-new");
  // the owner's pick holds, even after it leaves review (approving it doesn't jump the detail away)
  assert.equal(shownDeliverable([old, newer, waiting], "v-old")?.id, "v-old");
  // a pick that's gone falls back instead of showing nothing
  assert.equal(shownDeliverable([old, waiting], "v-gone")?.id, "v-wait");
  assert.equal(shownDeliverable([], null), null);
});

test("an in-review card's output whose file its deliverable copied (2026-11-17) still folds into that card by the original path", () => {
  const d = del({ id: "v-copied", state: "review" });
  const p = d.revisions[0]!.proof[0]!;
  Object.assign(p, { source: "/work/thread/shot.png", path: "/state/deliverables/alpha/2026-11-17-x-v-copied/images/shot.png", stored: "copied" as const });
  const o = out({ id: "o-shot", path: "/work/thread/shot.png" });
  const { byProof, loose } = fold([d], [o]);
  assert.equal(byProof.get(p.id)?.id, "o-shot", "not dropped to loose once the proof shows its copy");
  assert.deepEqual(loose, []);
  assert.deepEqual(deliverablesTab([d], [o], START).review[0]!.outputs.map((x) => x.id), ["o-shot"]);
});

test("a deliverable's files lead with its shown revision's proof, in the lead's order; the folder's other files follow", () => {
  const f = folder("v-r", ["a-note.md", "before.png", "dashboard.png"]);
  const d = del({ id: "v-r", proof: [{ path: f.files[2]!.path, stored: "copied" }, { path: f.files[1]!.path, stored: "copied" }] });
  const files = deliverablesTab([d], [], START, [], { "v-r": f }).filesBy.get("v-r")!;
  assert.deepEqual(files.map((x) => x.name), ["dashboard.png", "before.png", "a-note.md"]);
});

test("Delivered's Decided (step 3) holds the approved and the sent back, not the withdrawn; its count says the same", () => {
  const ds = [del({ id: "v-a", state: "approved" }), del({ id: "v-c", state: "changes" }), del({ id: "v-w", state: "withdrawn" }), del({ id: "v-r", state: "review" })];
  const tab = deliverablesTab(ds, [], { ...START, filter: "decided" });
  assert.deepEqual(tab.past.map((d) => d.id).sort(), ["v-a", "v-c"]);
  assert.equal(tab.counts.decided, 2);
  assert.equal(tab.counts.withdrawn, 1, "the withdrawn one waits on the Files and withdrawn page");
});
