// Why: the owner's card (2026-11-20) hides the four unused tabs until used; a link or a saved pane still opens each, so none is unreachable.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { UNTIL_USED, shownTabs, shownUntilUsed } from "../app/hidden-tabs.ts";
import { initialState, queueSetUp } from "../core/review-queue.ts";

const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
const VIEWS = [
  { id: "feed", label: "Home" },
  { id: "projects", label: "Projects" },
  { id: "multiplayer", label: "Multiplayer" },
  { id: "coderabbit", label: "CodeRabbit" },
  { id: "cloud", label: "Cloud" },
  { id: "gameboy", label: "Game Boy" },
  { id: "board", label: "Activity" },
];
const FRESH = { boards: 0, queueSetUp: queueSetUp(initialState(), true), gameboy: false, cloud: false };
const ids = (on: string[], onPanes: string[] = ["feed"], hidden: string[] = []) => shownTabs(VIEWS, new Set(hidden), 0, new Set(onPanes), new Set(on)).map((v) => v.id);

test("a default install shows none of the four", () => {
  assert.deepEqual(shownUntilUsed(FRESH), [], "a fresh queue in dry-run, no board, both settings off");
  assert.deepEqual(ids(shownUntilUsed(FRESH)), ["feed", "projects", "board"]);
  assert.match(server, /showGameBoy: \{ type: "boolean", label: "Tools: Game Boy", default: false \}/);
  assert.match(server, /showCloud: \{ type: "boolean", label: "Tools: Cloud", default: false \}/);
  assert.match(server, /shown: shownUntilUsed\(\{ boards: multiplayer\.store\.boards\(\)\.length, queueSetUp: queueSetUp\(reviewQueue\.store\.get\(\), cfg\.reviewQueueDryRun !== false\), gameboy: cfg\.showGameBoy === true, cloud: cfg\.showCloud === true \}\)/);
});

test("each shows once used, in its place", () => {
  assert.deepEqual(shownUntilUsed({ ...FRESH, boards: 1 }), ["multiplayer"]);
  assert.deepEqual(shownUntilUsed({ ...FRESH, gameboy: true }), ["gameboy"]);
  assert.deepEqual(shownUntilUsed({ ...FRESH, cloud: true }), ["cloud"]);
  assert.deepEqual(ids(["cloud", "multiplayer"]), ["feed", "projects", "multiplayer", "cloud", "board"]);
});

test("CodeRabbit counts as set up by any trace of use: schedule on, a queued PR, a run, or dry-run off", () => {
  const s = initialState();
  assert.equal(queueSetUp(s, true), false);
  assert.equal(queueSetUp({ ...s, config: { ...s.config, enabled: true } }, true), true, "schedule on");
  assert.equal(queueSetUp({ ...s, lastAt: 1 }, true), true, "a run happened");
  assert.equal(queueSetUp(s, false), true, "dry-run turned off in settings");
});

test("a link or saved pane on a hidden-until-used tab still opens it, unless the owner also hid it by name", () => {
  for (const id of UNTIL_USED) {
    assert.ok(ids([], ["feed", id]).includes(id), `${id}: a deep link lands`);
    assert.ok(!ids([], ["feed", id], [id]).includes(id), `${id}: hiddenTabs still wins`);
  }
});

test("hiddenTabs naming every other tab still shows them, and never brings an unused one back", () => {
  const rest = ["feed", "projects", "board"];
  assert.deepEqual(ids([], ["feed"], ["home", "projects", "activity"]), rest);
});

test("until Tools lands, the ? sheet is the way in to a hidden Multiplayer or CodeRabbit", () => {
  const sheet = readFileSync(new URL("../app/shortcut-help.tsx", import.meta.url), "utf8");
  assert.match(sheet, /\{ sub: "multiplayer", label: "Set up Multiplayer", show: !inUse\.has\("multiplayer"\) \}/);
  assert.match(sheet, /\{ sub: "coderabbit", label: "Set up CodeRabbit", show: !inUse\.has\("coderabbit"\) \}/);
  assert.match(sheet, /const inUse = new Set\(config\.data\?\.shown \?\? \[\]\)/);
});
