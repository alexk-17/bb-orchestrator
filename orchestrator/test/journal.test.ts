// Back and Forward across panes (app/journal.ts): root-cause 10, Back rewrote the focused pane; now it undoes one step in its own pane.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ENTRIES, arrive, fresh, push, readJournal, replace } from "../app/journal.ts";
import { rootOf } from "../app/route.ts";

const home = rootOf("home");
const chat = rootOf("chat");
const kite = { view: "projects", path: ["kite"], params: {} };

test("P10: pane A Home → Chat, then a click in pane B; Back sets A back to Home, not B", () => {
  let j = fresh(""); // [A: home* | B: projects], the URL says home
  j = push(j, "chat", { pane: "A", from: home, to: chat }); // the Sidebar sends A to Chat
  j = replace(j, "projects"); // a click in B: the focus moves, no new entry
  const back = arrive(j, ""); // the browser's Back lands on the entry before
  assert.equal(back.kind, "back");
  assert.deepEqual(back.kind === "back" && back.step, { pane: "A", from: home, to: chat });
  const fwd = back.kind === "back" ? arrive(back.journal, "projects") : null; // Forward: the entry after, as it was replaced
  assert.equal(fwd?.kind, "forward");
  assert.deepEqual(fwd?.kind === "forward" && fwd.step.to, chat);
});

test("our own URL coming back is nothing; one we never wrote is a link", () => {
  const j = push(fresh(""), "projects/kite", { pane: "B", from: rootOf("projects"), to: kite });
  assert.deepEqual(arrive(j, "projects/kite"), { kind: "same" });
  assert.deepEqual(arrive(j, "board"), { kind: "link" });
});

test("entries before and after with the same URL read as Back", () => {
  let j = fresh("chat");
  j = push(j, "home", { pane: "A", from: chat, to: home });
  j = push(j, "chat", { pane: "A", from: home, to: chat });
  const mid = { ...j, index: 1 };
  assert.equal(arrive(mid, "chat").kind, "back");
});

test("a push after going back drops what was ahead, as the browser does", () => {
  let j = fresh("");
  j = push(j, "chat", { pane: "A", from: home, to: chat });
  j = push(j, "board", { pane: "A", from: chat, to: rootOf("board") });
  j = { ...j, index: 1 };
  j = push(j, "projects", { pane: "B", from: rootOf("projects"), to: rootOf("projects") });
  assert.deepEqual(j.entries.map((e) => e.url), ["", "chat", "projects"]);
  assert.equal(j.index, 2);
});

test("a link that moved no pane has no step: Back from it is read as a link, never as undoing a pane", () => {
  const j = push(fresh("chat"), "", null);
  assert.equal(arrive(j, "chat").kind, "link");
});

test("the journal stays bounded and a stored one is read back only when sound", () => {
  let j = fresh("");
  for (let i = 0; i < MAX_ENTRIES + 20; i++) j = push(j, `p${i}`, { pane: "A", from: home, to: chat });
  assert.equal(j.entries.length, MAX_ENTRIES);
  assert.equal(j.index, MAX_ENTRIES - 1);
  assert.deepEqual(readJournal(JSON.parse(JSON.stringify(j))), j);
  assert.equal(readJournal({ entries: [], index: 0 }), null);
  assert.equal(readJournal({ entries: [{ url: "" }], index: 3 }), null);
  assert.equal(readJournal("x"), null);
});
