// A past card opened by a click drew loading for one `deliverable` read (2026-11-24, lag 2: 39-309 ms; main drew it at
// once). The read now starts when the owner presses the opener (app/deliverable-prefetch.tsx). It must start on a
// press only: a hover, or a phone's touch that turns into a scroll, would read cards the owner never opens.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PREFETCH_ATTR, isPress } from "../app/deliverable-press.ts";

test("only a press starts the read: never a hover, a right click, or a touch that scrolls", () => {
  // a mouse or pen's main button going down: the read starts before the click lands
  assert.equal(isPress({ type: "pointerdown", pointerType: "mouse", button: 0 }), true);
  assert.equal(isPress({ type: "pointerdown", pointerType: "pen", button: 0 }), true);
  assert.equal(isPress({ type: "pointerdown", pointerType: "mouse", button: 2 }), false, "a context menu opens nothing");
  // a phone: a finger going down may be the start of a scroll, so only a tap's lift reads (a scroll ends in pointercancel)
  assert.equal(isPress({ type: "pointerdown", pointerType: "touch", button: 0 }), false);
  assert.equal(isPress({ type: "pointerup", pointerType: "touch" }), true);
  assert.equal(isPress({ type: "pointercancel", pointerType: "touch" }), false);
  assert.equal(isPress({ type: "pointerup", pointerType: "mouse" }), false, "a mouse already read on its press");
  // hovering costs nothing
  for (const type of ["pointerover", "pointerenter", "pointermove", "mouseover", "focus"]) assert.equal(isPress({ type, pointerType: "mouse", button: 0 }), false, type);
  // the keyboard: Enter or Space on a focused opener; moving focus does not read
  assert.equal(isPress({ type: "keydown", key: "Enter", onOpener: true }), true);
  assert.equal(isPress({ type: "keydown", key: " ", onOpener: true }), true);
  assert.equal(isPress({ type: "keydown", key: "Tab", onOpener: true }), false);
  assert.equal(isPress({ type: "keydown", key: "ArrowDown", onOpener: true }), false);
});

test("typing in a reply inside a post that opens a card starts no read (Codex review P1: an RPC on the typing path)", () => {
  // a Feed post's marker holds its reply box: Space and Enter there are typing, not opening
  for (const key of [" ", "Enter"]) assert.equal(isPress({ type: "keydown", key, editable: true, onOpener: false }), false, JSON.stringify(key));
  // a key on another control in the post (send, approve) opens nothing either: only the opener's own key reads
  assert.equal(isPress({ type: "keydown", key: "Enter", editable: false, onOpener: false }), false);
  // clicking or tapping into the reply box is not opening the card
  assert.equal(isPress({ type: "pointerdown", pointerType: "mouse", button: 0, editable: true }), false);
  assert.equal(isPress({ type: "pointerup", pointerType: "touch", editable: true }), false);
});

test("each control that opens a past card names it, and the prefetcher is mounted", () => {
  const src = (f: string) => readFileSync(join(import.meta.dirname, "..", f), "utf8");
  // without the name, a press reads nothing and the card draws loading again
  const openers: [string, RegExp][] = [
    ["app/past-view.tsx", new RegExp(`data-past=\\{n\\.d\\.id\\}\\s+${PREFETCH_ATTR}=\\{n\\.d\\.id\\}`)],
    ["app/feed.tsx", new RegExp(`${PREFETCH_ATTR}=\\{p\\.kind === "deliverable" \\? p\\.deliverable\\?\\.id`)],
    ["app/project-book.tsx", new RegExp(`${PREFETCH_ATTR}=\\{open\\.panel\\?\\.deliverable\\}`, "g")],
    ["app/ref-text.tsx", new RegExp(`${PREFETCH_ATTR}=\\{t\\.kind === "deliverable" \\? t\\.open\\.panel\\?\\.deliverable`)],
    ["multiplayer/app.tsx", new RegExp(`data-record=\\{r\\.id\\}\\s+${PREFETCH_ATTR}=\\{r\\.deliverable\\?\\.id\\}`, "g")],
  ];
  for (const [f, re] of openers) assert.ok(re.test(src(f)), f);
  assert.equal(src("app/project-book.tsx").match(new RegExp(`${PREFETCH_ATTR}=`, "g"))?.length, 2, "OpenRef's link and its button");
  assert.equal(src("multiplayer/app.tsx").match(new RegExp(`${PREFETCH_ATTR}=`, "g"))?.length, 4, "Multiplayer's working and done records, and the buttons that open them (a key reads only on its opener)");
  assert.equal(src("app/feed.tsx").match(new RegExp(`${PREFETCH_ATTR}=`, "g"))?.length, 2, "a Feed post, and its title button");
  assert.match(src("app.tsx"), /<DeliverablePrefetch \/>/);
  // the index Delivered first draws with, read at idle so a first visit finds it (and again only when a deliverable changes)
  assert.match(src("app.tsx"), /<DeliverableIndexProvider>/);
  // Delivered uses that one read: its own observer would read the 473 KB index again on each visit
  assert.doesNotMatch(src("app/deliverables.tsx"), /method: "deliverableIndex"/);
});
