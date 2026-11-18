import { test } from "node:test";
import assert from "node:assert/strict";
import { micLive, onClick, onKey, type MicState } from "../voice/app/keys.ts";

const off: MicState = { call: "off", mode: null, spaceDown: false };
const body = { tagName: "BODY" } as unknown as EventTarget;
const box = { tagName: "TEXTAREA" } as unknown as EventTarget;

test("the mic is never live until a click or a held Space", () => {
  assert.equal(micLive(off), false);
  assert.equal(onKey(off, { type: "keydown", key: "a", target: body }), null);
  assert.equal(onKey(off, { type: "keydown", key: "Escape", target: body }), null);
});

test("a click opens the call with the mic live, a second click hangs up", () => {
  assert.equal(onClick(off), "start-open");
  const open: MicState = { call: "on", mode: "open", spaceDown: false };
  assert.equal(micLive(open), true);
  assert.equal(onClick(open), "hangup");
});

test("Space held: live while down, muted on release; Esc hangs up", () => {
  assert.equal(onKey(off, { type: "keydown", key: " ", target: body }), "start-hold");
  const held: MicState = { call: "on", mode: "hold", spaceDown: true };
  assert.equal(micLive(held), true);
  assert.equal(onKey(held, { type: "keyup", key: " ", target: body }), "mic-off");
  const muted: MicState = { ...held, spaceDown: false };
  assert.equal(micLive(muted), false);
  assert.equal(onKey(muted, { type: "keydown", key: " ", target: body }), "mic-on");
  assert.equal(onKey(muted, { type: "keydown", key: "Escape", target: body }), "hangup");
});

test("Space in a text box types a space", () => {
  assert.equal(onKey(off, { type: "keydown", key: " ", target: box }), null);
});

test("a key repeat doesn't restart anything", () => {
  const held: MicState = { call: "on", mode: "hold", spaceDown: true };
  assert.equal(onKey(held, { type: "keydown", key: " ", repeat: true, target: body }), null);
});
