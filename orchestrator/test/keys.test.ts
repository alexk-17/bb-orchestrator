// The keyboard shortcuts' rules (app/keys.ts). Why they matter: a macropad sends bare keys, so a "1" typed in a text box
// must never pick an answer, and one stray A must never close a deliverable (approving is not undoable).
import assert from "node:assert/strict";
import { test } from "node:test";
import { APPROVE_MS, KEYMAP, decide, pressApprove, resolveSelection, step, where, type KeyLike, type TargetLike } from "../app/keys.ts";

const key = (k: string, o: Partial<KeyLike> = {}): KeyLike => ({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...o });
const page: TargetLike = { tagName: "BODY" };
const box: TargetLike = { tagName: "TEXTAREA" };

test("a typed 1 in a text box does not pick an option; on the page it does", () => {
  assert.equal(decide(key("1"), box), null);
  assert.equal(decide(key("1"), { tagName: "INPUT", type: "text" }), null);
  assert.equal(decide(key("1"), { tagName: "DIV", isContentEditable: true }), null);
  assert.deepEqual(decide(key("1"), page), { t: "pick", n: 1 });
});

test("single keys of every kind are ignored in a text box, but not Cmd/Ctrl+Enter's own handling (not ours either way)", () => {
  for (const k of ["j", "k", "a", "o", "c", "Enter", "?", "2", "3", "4"]) assert.equal(decide(key(k), box), null, k);
  assert.equal(decide(key("Enter", { metaKey: true }), box), null);
  assert.equal(decide(key("Enter", { ctrlKey: true }), page), null);
});

test("a single A never approves: it only arms; a second A on the same card within 2 s fires", () => {
  const first = pressApprove(null, "v1", 1000);
  assert.equal(first.fire, false);
  assert.deepEqual(first.arm, { id: "v1", at: 1000 });
  assert.equal(pressApprove(first.arm, "v1", 1000 + APPROVE_MS).fire, true);
  assert.equal(pressApprove(first.arm, "v1", 1000 + APPROVE_MS + 1).fire, false); // too late: arms afresh
  assert.equal(pressApprove(first.arm, "v2", 1500).fire, false); // another card: arms that one
  assert.deepEqual(pressApprove(first.arm, "v2", 1500).arm, { id: "v2", at: 1500 });
  assert.equal(pressApprove(pressApprove(first.arm, "v1", 1500).arm, "v1", 1600).fire, false); // fired once, then it is spent
});

test("a held A (key repeat) is not an action at all", () => {
  assert.deepEqual(decide(key("a"), page), { t: "approve" });
  assert.equal(decide(key("a", { repeat: true }), page), null);
  assert.equal(decide(key("Enter", { repeat: true }), page), null);
});

test("keys with Cmd, Ctrl or Alt held are never ours (bb's own bindings, Cmd+J, Cmd+K ...)", () => {
  for (const m of ["metaKey", "ctrlKey", "altKey"] as const) for (const k of ["j", "k", "a", "c", "1", "o"]) assert.equal(decide(key(k, { [m]: true }), page), null, `${m}+${k}`);
});

test("tab keys are Shift+N/P/D/H by physical key; plain n/p/d/h do nothing", () => {
  const tab = (code: string, k: string) => decide(key(k, { shiftKey: true, code }), page);
  assert.deepEqual(tab("KeyN", "N"), { t: "tab", view: "needs-you" });
  assert.deepEqual(tab("KeyP", "P"), { t: "tab", view: "projects" });
  assert.deepEqual(tab("KeyD", "D"), { t: "tab", view: "deliverables" });
  assert.deepEqual(tab("KeyH", "H"), { t: "tab", view: "chat" });
  assert.equal(tab("KeyX", "X"), null);
  for (const k of ["n", "p", "d", "h"]) assert.equal(decide(key(k), page), null);
  assert.equal(decide(key("J", { shiftKey: true, code: "KeyJ" }), page), null); // Shift+J is not J
});

test("? opens the cheat sheet; with it open only Esc and ? work, and Esc is ours only then", () => {
  assert.deepEqual(decide(key("?", { shiftKey: true }), page), { t: "help" });
  assert.equal(decide(key("Escape"), page), null); // leaves bb's own Esc alone
  assert.deepEqual(decide(key("Escape"), page, true), { t: "close" });
  assert.equal(decide(key("j"), page, true), null);
  assert.equal(decide(key("a"), page, true), null);
});

test("Enter on a focused button or link is left to the browser (no double send); on the page it sends", () => {
  assert.equal(decide(key("Enter"), { tagName: "BUTTON" }), null);
  assert.equal(decide(key("Enter"), { tagName: "A" }), null);
  assert.deepEqual(decide(key("Enter"), page), { t: "send" });
  assert.deepEqual(decide(key("j"), { tagName: "BUTTON" }), { t: "move", dir: 1 });
});

test("Esc in a text box (the CoS box, bb's chat box the Chat tab focuses) leaves it, so the pad is not stuck; not on the page", () => {
  assert.deepEqual(decide(key("Escape"), { tagName: "TEXTAREA", leave: true }), { t: "blur" });
  assert.deepEqual(decide(key("Escape"), { tagName: "DIV", isContentEditable: true, leave: true }), { t: "blur" });
  assert.equal(decide(key("Escape"), { tagName: "TEXTAREA" }), null); // not flagged (outside the page): bb's own Esc
  assert.equal(decide(key("Escape"), page), null);
  assert.deepEqual(decide(key("j"), page), { t: "move", dir: 1 }); // after the blur, focus is on the page again
  assert.equal(decide(key("j"), { tagName: "TEXTAREA", leave: true }), null); // while typing in it, still not ours
});

test("an open menu (Defer) keeps its own keys", () => {
  assert.equal(where({ tagName: "DIV", role: "menuitem", insideRole: "menu" }), "menu");
  assert.equal(decide(key("a"), { tagName: "DIV", insideRole: "menu" }), null);
});

test("J/K walk the cards without wrapping; an answered card's slot goes to the next card", () => {
  const ids = ["a", "b", "c"];
  assert.equal(step(ids, null, 1), "a");
  assert.equal(step(ids, null, -1), "c");
  assert.equal(step(ids, "c", 1), "c");
  assert.equal(step(ids, "a", -1), "a");
  assert.equal(step([], null, 1), null);
  assert.deepEqual(resolveSelection(["a", "c"], "b", 1), { id: "c", index: 1 });
  assert.deepEqual(resolveSelection(["a"], "c", 2), { id: "a", index: 0 });
  assert.deepEqual(resolveSelection([], "a", 0), { id: null, index: 0 });
  assert.deepEqual(resolveSelection(ids, null, 0), { id: null, index: 0 });
});

test("every key the cheat sheet lists is one decide() acts on", () => {
  assert.equal(KEYMAP.length, 11);
  for (const [k, shift, code] of [["j", false, ""], ["k", false, ""], ["1", false, ""], ["4", false, ""], ["o", false, ""], ["a", false, ""], ["c", false, ""], ["N", true, "KeyN"], ["?", true, ""], ["[", false, ""], ["]", false, ""], ["\\", false, ""], ["-", false, ""]] as const) {
    assert.ok(decide(key(k, { shiftKey: shift, code: code || undefined }), page), k);
  }
  assert.equal(decide(key("5"), page), null);
});

test("the pane keys (split panes): [ and ] walk the panes, \\ and - split; never while typing or with a modifier, where bb's own pane keys live", () => {
  assert.deepEqual(decide(key("["), page), { t: "pane", dir: -1 });
  assert.deepEqual(decide(key("]"), page), { t: "pane", dir: 1 });
  assert.deepEqual(decide(key("\\"), page), { t: "split", dir: "row" });
  assert.deepEqual(decide(key("-"), page), { t: "split", dir: "col" });
  assert.equal(decide(key("-"), { tagName: "INPUT", type: "text" }), null, "a minus typed in a box is text");
  assert.equal(decide(key("]", { metaKey: true }), page), null);
  assert.equal(decide(key("[", { ctrlKey: true }), page), null);
});
