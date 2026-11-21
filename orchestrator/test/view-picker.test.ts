// The view picker's rows (feel spec part 1): what it lists must be what the Sidebar lists, or the owner can't tell what they are choosing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { navOf } from "../app/nav.ts";
import { matching, pickerRowsOf } from "../app/picker-rows.ts";

const ALL = ["home", "deliverables", "needs-you", "chat", "projects", "open-prs", "multiplayer", "coderabbit", "cloud", "gameboy", "rules", "board"].map((id) => ({ id, label: id === "board" ? "Activity" : id === "rules" ? "Rules" : id }));
const ICONS = { home: "H", chat: "C", projects: "P", "open-prs": "R" };
const FILTERS = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs you" },
  { id: "delivered", label: "Delivered" },
  { id: "alerts", label: "Alerts" },
];
const rows = pickerRowsOf(navOf(ALL, new Set()), ICONS, FILTERS);
const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);

test("every Sidebar item is a row, in its order: Home and its filters, the places, a section in use, then all of Tools", () => {
  // the owner, 2026-11-20: "the tabs need to show up in the tab view dropdown"
  assert.deepEqual(rows.main.map((r) => r.label), ["Home", "Needs you", "Delivered", "Alerts", "Chat", "Projects", "Reviews"], "the Sidebar's words, not VIEWS' (Open PRs)");
  assert.deepEqual(rows.main.map((r) => r.icon), ["H", "H", "H", "H", "C", "P", "R"], "Home's filters carry Home's icon");
  assert.deepEqual(ids(rows.tools), ["rules", "board", "how-it-works", "multiplayer", "coderabbit"], "Tools as the Sidebar shows it, Set up items included");
  assert.ok(rows.tools.every((r) => r.icon === undefined), "Tools rows have no icon, as in the Sidebar's Tools group");
  const used = pickerRowsOf(navOf(ALL, new Set(["multiplayer"])), ICONS, FILTERS);
  assert.deepEqual(ids(used.main).slice(-2), ["open-prs", "multiplayer"], "a section in use sits under Reviews");
  assert.ok(!ids(used.tools).includes("multiplayer"), "and leaves Tools' Set up");
  const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
  assert.match(app, /pickerRowsOf\(nav, ICONS, HOME_FILTERS\)/, "the page builds them from the nav it draws");
});

test("Home's filters are rows from the start, and match on their own label", () => {
  assert.deepEqual(ids(matching(rows, "").main).slice(0, 4), ["home", "home/needs", "home/delivered", "home/alerts"]);
  const need = matching(rows, "need");
  assert.deepEqual([ids(need.main), ids(need.tools)], [["home/needs"], []]);
  assert.equal(need.main[0]!.icon, "H", "with Home's icon");
});

test("filtering is by label, case-blind, with Reviews' and Activity's extra words; no match is empty", () => {
  const only = (q: string) => { const m = matching(rows, q); return [...ids(m.main), ...ids(m.tools), ...ids(m.filters)]; };
  assert.deepEqual(only("rev"), ["open-prs"]);
  assert.deepEqual(only("REV"), ["open-prs"]);
  assert.deepEqual(only("prs"), ["open-prs"]);
  assert.deepEqual(only("open prs"), ["open-prs"]);
  assert.deepEqual(only("board"), ["board"]);
  assert.deepEqual(only("zzz"), []);
});
