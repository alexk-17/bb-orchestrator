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
  const s = openStep("copy:board", { server: "list", copy: "board" }, "other");
  assert.deepEqual(s, { next: "done", move: null });
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

function posts() {
  const sent: { body: ViewPrefBody; answer: (o: Outcome) => void }[] = [];
  const post = (body: ViewPrefBody) => new Promise<Outcome>((answer) => void sent.push({ body, answer }));
  return { sent, post };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test("the page's saves go one after another, in the order made, so the server keeps the latest", async () => {
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

const listKept: ViewPrefs = { projectsView: "list", boardFolds: { "-": ["shipped"] }, rev: 3 };
const none = new Map<string, ViewPrefBody>();

test("Projects left and opened again opens on the pick just made, not on the read from before it", () => {
  const w = new PrefWrites(() => new Promise<Outcome>(() => undefined));
  void w.keep({ projectsView: "board" });
  assert.equal(viewWord(listKept, w.own(), false), "board", "the page's own pick wins over the read from before it");
  assert.deepEqual(open([{ server: viewWord(listKept, w.own(), true), copy: "board" }]), { at: "board", moves: ["board"], phase: "done" });
  assert.equal(viewWord(listKept, none, true), undefined);
  assert.deepEqual(open([{ server: viewWord(listKept, none, true), copy: "board" }, { server: viewWord({ ...listKept, projectsView: "board" }, none, false), copy: "board" }]), { at: "board", moves: ["board"], phase: "done" });
  assert.equal(viewWord(listKept, none, false), "list", "a read not being refreshed is the plugin's word");
  assert.equal(viewWord(undefined, none, false), undefined, "no read yet: no word");
  void w.keep({ board: "-", folded: [] });
  assert.deepEqual(foldWord(listKept, w.own(), "-"), []);
  assert.deepEqual(foldWord(listKept, none, "-"), ["shipped"]);
  assert.equal(foldWord(listKept, none, "kite-app"), null, "a board never folded");
  assert.equal(foldWord(undefined, none, "-"), undefined);
  const src = readFileSync(new URL("../app/view-pref.ts", import.meta.url), "utf8");
  assert.match(src, /const server = viewWord\(prefs, own, fetching\);/, "Projects opens on that word");
  assert.match(readFileSync(new URL("../app/board-fold.ts", import.meta.url), "utf8"), /const server = foldWord\(prefs, own, board\);/, "the board folds on that word");
});

const kept = (rev: number): Outcome => ({ ok: true, result: { rev } });

test("once the server kept a save, the shared read is refreshed, and the pick leaves the page's own when a read holds it; with no read mounted, the next one to mount is refreshed", async () => {
  const { sent, post } = posts();
  const w = new PrefWrites(post);
  let reads = 0;
  const leave = w.mount(async () => void reads++);
  void w.keep({ projectsView: "board" });
  await tick();
  assert.ok(w.own().has("view"), "sent, not answered: still the page's own word");
  sent[0]!.answer(kept(4));
  await tick();
  assert.equal(reads, 1, "the read is refreshed after the server kept it");
  assert.ok(w.own().has("view"), "kept, not read back yet: still the page's own");
  w.read(4);
  assert.equal(w.own().size, 0, "the read holds the save: the plugin's word is the pick");
  leave();
  void w.keep({ projectsView: "list" });
  await tick();
  sent[1]!.answer(kept(5));
  await tick();
  assert.equal(reads, 1);
  assert.deepEqual(w.own().get("view"), { projectsView: "list" });
  w.mount(async () => void reads++);
  await tick();
  assert.equal(reads, 2, "the next read to mount is refreshed");
  w.read(5);
  assert.equal(w.own().size, 0);
});

test("a refresh that failed, was cancelled or read from before the save leaves the pick and the folds the page's own", async () => {
  const { sent, post } = posts();
  const w = new PrefWrites(post);
  let reads = 0;
  w.mount(async () => void reads++);
  void w.keep({ projectsView: "board" });
  void w.keep({ board: "-", folded: [] });
  await tick();
  sent[0]!.answer(kept(4));
  await tick();
  sent[1]!.answer(kept(5));
  await tick();
  assert.equal(reads, 2, "each kept save refreshes the read, and the SDK's refresh resolves however its read ended");
  assert.equal(viewWord(listKept, w.own(), false), "board", "Projects left and opened again still opens the board");
  assert.deepEqual(foldWord(listKept, w.own(), "-"), [], "and Shipped stays open");
  w.read(3);
  assert.equal(w.own().size, 2, "a read from before both saves hands nothing over");
  w.read(4);
  assert.deepEqual([...w.own().keys()], ["folds:-"], "a read holding the pick's save, not the folds'");
  w.read(5);
  assert.equal(w.own().size, 0);

  const c = new PrefWrites(post);
  c.mount(() => Promise.reject(new DOMException("cancelled", "AbortError")));
  void c.keep({ projectsView: "board" });
  await tick();
  sent[2]!.answer(kept(6));
  await tick();
  assert.equal(viewWord(listKept, c.own(), false), "board", "a refresh whose read was cancelled hands nothing over");
});

test("a save from another window, read after this page's, is the pick", async () => {
  const { sent, post } = posts();
  const w = new PrefWrites(post);
  w.mount(async () => undefined);
  void w.keep({ projectsView: "board" });
  await tick();
  sent[0]!.answer(kept(4));
  await tick();
  w.read(6);
  assert.equal(viewWord({ ...listKept, rev: 6 }, w.own(), false), "list", "List saved elsewhere after Board: the read holding it wins");
});

test("a save answered with no revision is the page's own until a read newer than the page's last; one from before it, a failed or a cancelled one keeps it", async () => {
  const { sent, post } = posts();
  const w = new PrefWrites(post);
  let reads = 0;
  w.mount(() => (++reads === 1 ? Promise.reject(new Error("offline")) : Promise.reject(new DOMException("cancelled", "AbortError"))));
  w.read(4);
  void w.keep({ projectsView: "board" });
  void w.keep({ board: "-", folded: [] });
  await tick();
  sent[0]!.answer({ ok: true, result: null });
  await tick();
  sent[1]!.answer({ ok: true, result: null });
  await tick();
  assert.equal(reads, 2, "each kept save refreshes the read; one failed, one was cancelled");
  w.read(4);
  w.read(3);
  w.read(undefined);
  assert.equal(viewWord({ ...listKept, rev: 4 }, w.own(), false), "board", "a read no newer than the page's last, or with no revision, may predate the save: Board holds");
  assert.deepEqual(foldWord(listKept, w.own(), "-"), [], "and Shipped stays open");
  w.read(99);
  assert.equal(w.own().size, 0, "a newer read holds both saves");
  assert.equal(viewWord({ ...listKept, rev: 99 }, w.own(), false), "list", "List saved elsewhere since: the plugin's word is the pick");
  assert.deepEqual(foldWord({ ...listKept, rev: 99 }, w.own(), "-"), ["shipped"]);
});

test("a save answered with no revision lands past the newest read the page has had, though a read since went back or carried none", async () => {
  for (const back of [3, undefined]) {
    const { sent, post } = posts();
    const w = new PrefWrites(post);
    w.mount(async () => undefined);
    w.read(4);
    w.read(back);
    void w.keep({ projectsView: "board" });
    await tick();
    sent[0]!.answer({ ok: true, result: null });
    await tick();
    w.read(4);
    assert.equal(viewWord({ ...listKept, rev: 4 }, w.own(), false), "board", `revision 4 was read before the save (then ${back}): Board holds`);
    w.read(5);
    assert.equal(w.own().size, 0, "a revision past any the page had read holds the save");
  }
});

test("a read with no revision, from a server that stamps none, is revision 0: it hands back no save", async () => {
  const { sent, post } = posts();
  const w = new PrefWrites(post);
  w.mount(async () => undefined);
  w.read(undefined);
  void w.keep({ projectsView: "board" });
  await tick();
  sent[0]!.answer({ ok: true, result: null });
  await tick();
  w.read(undefined);
  assert.equal(viewWord(listKept, w.own(), false), "board", "no answer and no read says which came first: Board holds");
  void w.keep({ projectsView: "list" });
  await tick();
  sent[1]!.answer(kept(2));
  await tick();
  w.read(undefined);
  assert.deepEqual(w.own().get("view"), { projectsView: "list" }, "a read with no revision is older than revision 2");
});

test("a save answered with no revision never frees a later pick of the same choice", async () => {
  const { sent, post } = posts();
  const w = new PrefWrites(post);
  w.mount(async () => undefined);
  void w.keep({ projectsView: "board" });
  void w.keep({ projectsView: "list" });
  await tick();
  sent[0]!.answer({ ok: true, result: null });
  await tick();
  w.read(99);
  assert.deepEqual(w.own().get("view"), { projectsView: "list" }, "List is still being sent: the page's own");
  assert.equal(viewWord({ ...listKept, projectsView: "board", rev: 99 }, w.own(), false), "list");
});

test("a change made while a save is sent stays the page's own; a save that failed leaves it", async () => {
  const { sent, post } = posts();
  const w = new PrefWrites(post);
  w.mount(async () => undefined);
  void w.keep({ projectsView: "board" });
  await tick();
  sent[0]!.answer(kept(4));
  await tick();
  void w.keep({ projectsView: "list" });
  w.read(4);
  assert.deepEqual(w.own().get("view"), { projectsView: "list" }, "the read holds Board, not List: List stays the page's own");
  await tick();
  sent[1]!.answer({ ok: false, kind: "error", message: "offline" });
  await tick();
  assert.equal(w.own().has("view"), false, "a failed save is not the page's word: the plugin's read is");
});

test("a click on the view already kept writes nothing; a pick that differs from the pending or kept one is written", () => {
  const boardKept: ViewPrefs = { projectsView: "board", boardFolds: {}, rev: 3 };
  assert.equal(pickSave("board", viewWord(boardKept, none, false)), null, "Board kept, Board clicked: no write");
  const w = new PrefWrites(() => new Promise<Outcome>(() => undefined));
  void w.keep({ projectsView: "list" });
  assert.equal(pickSave("list", viewWord(boardKept, w.own(), false)), null, "List pending, List clicked again: no second write");
  assert.deepEqual(pickSave("board", viewWord(boardKept, w.own(), false)), { projectsView: "board" }, "Board kept, List pending, Board clicked: written, or List would land last");
  assert.deepEqual(pickSave("board", viewWord(boardKept, none, true)), { projectsView: "board" }, "the read is being refreshed: no word to trust, so written");
  assert.deepEqual(pickSave("list", viewWord(undefined, none, false)), { projectsView: "list" }, "no read yet: written");
  assert.deepEqual(pickSave("list", viewWord({ projectsView: null, boardFolds: {}, rev: 0 }, none, false)), { projectsView: "list" }, "none kept: written");
  const src = readFileSync(new URL("../app/view-pref.ts", import.meta.url), "utf8");
  assert.match(src, /saveViewCopy\(v\);\n\s+const save = pickSave\(v, server\);\n\s+if \(save\) keep\(save\);/, "the toggle keeps this browser's copy always, and writes the plugin only for a change");
});
