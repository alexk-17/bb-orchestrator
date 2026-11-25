// Projects remembers List or Board (2026-11-24, the owner: "The Projects view should remember whether you last picked
// Board or List"). The owner who works from the board shouldn't pick it again on every visit, so:
// - Board kept opens Projects on the board after a reload or in a new window, from the plugin's word or, for the first
//   paint, this browser's copy; nothing kept anywhere is List;
// - the plugin's word wins once it lands, while the page is still where the copy put it;
// - only the bare list moves, and only as the page opens: a link stays where it put the page, and Back never bounces;
// - the copy in this browser never breaks the page when storage is blocked or holds junk.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PrefWrites, VIEW_COPY_KEY, foldWord, loadViewCopy, openStep, pickSave, saveViewCopy, viewWord, type OpenAt, type Opening } from "../app/view-pref.ts";
import type { ProjectsViewPick, ViewPrefBody, ViewPrefs } from "../contract.ts";
import type { Outcome } from "../app/store.ts";

const memory = (seed: Record<string, string> = {}) => {
  const m = new Map(Object.entries(seed));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
type Kept = { server: ProjectsViewPick | null | undefined; copy: ProjectsViewPick | null };
/** Projects opening: each word as it arrives, the page following each move, until it settles. */
function open(words: Kept[], at: OpenAt = "list"): { at: OpenAt; moves: string[]; phase: Opening } {
  let phase: Opening = "waiting";
  const moves: string[] = [];
  for (const k of words) {
    const s = openStep(phase, k, at);
    phase = s.next;
    if (s.move) {
      moves.push(s.move);
      at = s.move;
    }
  }
  return { at, moves, phase };
}

test("Board kept is restored after a reload: the plugin's word opens the board, replacing the list once", () => {
  assert.deepEqual(open([{ server: undefined, copy: null }, { server: "board", copy: null }]), { at: "board", moves: ["board"], phase: "done" }, "a new window: no copy, the plugin's word");
  assert.deepEqual(open([{ server: undefined, copy: "board" }, { server: "board", copy: "board" }]), { at: "board", moves: ["board"], phase: "done" }, "this browser's copy paints the board first, and the plugin agrees");
});

test("nothing kept is List; until a word arrives the list stays and nothing moves", () => {
  assert.deepEqual(open([{ server: undefined, copy: null }]), { at: "list", moves: [], phase: "waiting" });
  assert.deepEqual(open([{ server: undefined, copy: null }, { server: null, copy: null }]), { at: "list", moves: [], phase: "done" });
});

test("the plugin's word wins over this browser's copy once it lands", () => {
  assert.deepEqual(open([{ server: undefined, copy: "board" }, { server: "list", copy: "board" }]).moves, ["board", "list"], "List picked on another device since");
  assert.deepEqual(open([{ server: undefined, copy: "list" }, { server: "board", copy: "list" }]).moves, ["board"], "Board picked on another device since");
  assert.deepEqual(open([{ server: undefined, copy: "board" }, { server: null, copy: "board" }]).moves, ["board"], "the plugin's write never landed: the copy stands");
});

test("only the bare list moves, and only as the page opens", () => {
  for (const at of ["board", "other"] as const) assert.deepEqual(open([{ server: "list", copy: "list" }], at), { at, moves: [], phase: "done" }, `a link that opened ${at} stays`);
  assert.deepEqual(open([{ server: "board", copy: null }], "other"), { at: "other", moves: [], phase: "done" }, "an open project is never swapped for the board");
  // opened on the copy, then the viewer went elsewhere before the plugin's word: no correction yanks them back
  const s = openStep("copy:board", { server: "list", copy: "board" }, "other");
  assert.deepEqual(s, { next: "done", move: null });
  // settled for good: Back to the list later never bounces to the board
  assert.deepEqual(openStep("done", { server: "board", copy: "board" }, "list"), { next: "done", move: null });
});

test("this browser's copy: kept and read back, and blocked or junk storage is no copy", () => {
  const store = memory();
  saveViewCopy("board", store);
  assert.equal(loadViewCopy(store), "board");
  assert.equal(loadViewCopy(memory({ [VIEW_COPY_KEY]: "grid" })), null);
  const blocked = {
    getItem: (): string | null => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.equal(loadViewCopy(blocked), null);
  assert.doesNotThrow(() => saveViewCopy("list", blocked));
  assert.equal(loadViewCopy(null), null);
});

test("Projects keeps the toggle's pick, settles for good on it, and moves by replacing the list's entry", () => {
  const src = readFileSync(new URL("../app/projects.tsx", import.meta.url), "utf8");
  assert.match(src, /setOpening\("done"\);\n\s+kept\.pick\(to\);/, "the List | Board toggle keeps its pick, a click on the view shown included, and ends the opening");
  assert.match(src, /onBoard\(step\.move === "board" \? \{ project: null, task: null \} : null, "replace"\)/, "a move replaces the list, so Back doesn't bounce");
  assert.match(src, /: !detail && !picked && !scopeOpen && !pathwaysOpen \? "list" : "other";/, "only the bare list is the list");
});

/** A post the test answers by hand, in any order: what was sent, and a way to answer each. */
function posts() {
  const sent: { body: ViewPrefBody; answer: (o: Outcome) => void }[] = [];
  const post = (body: ViewPrefBody) => new Promise<Outcome>((answer) => void sent.push({ body, answer }));
  return { sent, post };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test("the page's saves go one after another, in the order made, so the server keeps the latest (Codex's review)", async () => {
  const { sent, post } = posts();
  const w = new PrefWrites(post);
  void w.keep({ board: "-", folded: ["shipped"] });
  void w.keep({ projectsView: "board" });
  await tick();
  assert.deepEqual(sent.map((s) => s.body), [{ board: "-", folded: ["shipped"] }], "the second waits for the first");
  sent[0]!.answer({ ok: false, kind: "error", message: "offline" });
  await tick();
  assert.deepEqual(sent.map((s) => s.body), [{ board: "-", folded: ["shipped"] }, { projectsView: "board" }], "then goes, even after a failed save");
});

const listKept: ViewPrefs = { projectsView: "list", boardFolds: { "-": ["shipped"] } };
const none = new Map<string, ViewPrefBody>();

test("Projects left and opened again opens on the pick just made, not on the read from before it (Codex's review)", () => {
  // List kept; the viewer picks Board, goes Home and comes back while the shared read still says List
  const w = new PrefWrites(() => new Promise<Outcome>(() => undefined));
  void w.keep({ projectsView: "board" });
  assert.equal(viewWord(listKept, w.own(), false), "board", "the page's own pick wins over the read from before it");
  assert.deepEqual(open([{ server: viewWord(listKept, w.own(), true), copy: "board" }]), { at: "board", moves: ["board"], phase: "done" });
  // a read being refreshed never settles the opening: it may be from before a pick made since; its fresh word does
  assert.equal(viewWord(listKept, none, true), undefined);
  assert.deepEqual(open([{ server: viewWord(listKept, none, true), copy: "board" }, { server: viewWord({ ...listKept, projectsView: "board" }, none, false), copy: "board" }]), { at: "board", moves: ["board"], phase: "done" });
  assert.equal(viewWord(listKept, none, false), "list", "a read not being refreshed is the plugin's word");
  assert.equal(viewWord(undefined, none, false), undefined, "no read yet: no word");
  // the board's folds the same way: Shipped opened, then the board left and opened again, stays open
  void w.keep({ board: "-", folded: [] });
  assert.deepEqual(foldWord(listKept, w.own(), "-"), []);
  assert.deepEqual(foldWord(listKept, none, "-"), ["shipped"]);
  assert.equal(foldWord(listKept, none, "kite-app"), null, "a board never folded");
  assert.equal(foldWord(undefined, none, "-"), undefined);
  const src = readFileSync(new URL("../app/view-pref.ts", import.meta.url), "utf8");
  assert.match(src, /const server = viewWord\(prefs, own, fetching\);/, "Projects opens on that word");
  assert.match(readFileSync(new URL("../app/board-fold.ts", import.meta.url), "utf8"), /const server = foldWord\(prefs, own, board\);/, "the board folds on that word");
});

test("once the server kept a save, the shared read is refreshed and holds it; with no read mounted, the next one to mount is", async () => {
  const { sent, post } = posts();
  const w = new PrefWrites(post);
  let reads = 0;
  const leave = w.mount(async () => void reads++);
  void w.keep({ projectsView: "board" });
  await tick();
  assert.ok(w.own().has("view"), "sent, not answered: still the page's own word");
  sent[0]!.answer({ ok: true });
  await tick();
  assert.equal(reads, 1, "the read is refreshed after the server kept it");
  assert.equal(w.own().size, 0, "and the save leaves the page's own words: the read holds it");
  // the viewer went elsewhere before the server answered: no read to refresh, so the page keeps its own word
  leave();
  void w.keep({ projectsView: "list" });
  await tick();
  sent[1]!.answer({ ok: true });
  await tick();
  assert.equal(reads, 1);
  assert.deepEqual(w.own().get("view"), { projectsView: "list" }, "kept by the server, not read back yet: still the page's own");
  w.mount(async () => void reads++);
  await tick();
  assert.equal(reads, 2, "the next read to mount is refreshed");
  assert.equal(w.own().size, 0);
});

test("a change made while the read is refreshed stays the page's own; a save that failed leaves it", async () => {
  const { sent, post } = posts();
  const w = new PrefWrites(post);
  let done = () => {};
  w.mount(() => new Promise<void>((r) => (done = r)));
  void w.keep({ projectsView: "board" });
  await tick();
  sent[0]!.answer({ ok: true });
  await tick();
  void w.keep({ projectsView: "list" });
  done();
  await tick();
  assert.deepEqual(w.own().get("view"), { projectsView: "list" }, "the read began before List was sent: List stays the page's own");
  sent[1]!.answer({ ok: false, kind: "error", message: "offline" });
  await tick();
  assert.equal(w.own().has("view"), false, "a failed save is not the page's word: the plugin's read is");
});

test("two refreshes at once: only the latest hands the page's saves to the read, as the earlier one's fetch was cancelled", async () => {
  const { sent, post } = posts();
  const w = new PrefWrites(post);
  const ends: (() => void)[] = [];
  w.mount(() => new Promise<void>((r) => void ends.push(r)));
  void w.keep({ projectsView: "board" });
  void w.keep({ board: "-", folded: [] });
  await tick();
  sent[0]!.answer({ ok: true });
  await tick();
  sent[1]!.answer({ ok: true });
  await tick();
  assert.equal(ends.length, 2, "each kept save refreshes the read");
  ends[0]!();
  await tick();
  assert.equal(w.own().size, 2, "the first refresh ended (cancelled by the second) before the read held anything new: both saves stay the page's own");
  ends[1]!();
  await tick();
  assert.equal(w.own().size, 0, "the latest refresh landed: the read holds both");
});

test("a click on the view already kept writes nothing; a pick that differs from the pending or kept one is written (Codex's review)", () => {
  const boardKept: ViewPrefs = { projectsView: "board", boardFolds: {} };
  assert.equal(pickSave("board", viewWord(boardKept, none, false)), null, "Board kept, Board clicked: no write");
  const w = new PrefWrites(() => new Promise<Outcome>(() => undefined));
  void w.keep({ projectsView: "list" });
  assert.equal(pickSave("list", viewWord(boardKept, w.own(), false)), null, "List pending, List clicked again: no second write");
  assert.deepEqual(pickSave("board", viewWord(boardKept, w.own(), false)), { projectsView: "board" }, "Board kept, List pending, Board clicked: written, or List would land last");
  assert.deepEqual(pickSave("board", viewWord(boardKept, none, true)), { projectsView: "board" }, "the read is being refreshed: no word to trust, so written");
  assert.deepEqual(pickSave("list", viewWord(undefined, none, false)), { projectsView: "list" }, "no read yet: written");
  assert.deepEqual(pickSave("list", viewWord({ projectsView: null, boardFolds: {} }, none, false)), { projectsView: "list" }, "none kept: written");
  const src = readFileSync(new URL("../app/view-pref.ts", import.meta.url), "utf8");
  assert.match(src, /saveViewCopy\(v\);\n\s+const save = pickSave\(v, server\);\n\s+if \(save\) keep\(save\);/, "the toggle keeps this browser's copy always, and writes the plugin only for a change");
});
