// The hiddenTabs setting (2026-11-17). Why it matters: the owner hides tabs they never use, but a setting that names
// every tab, or a capitalised label, must not leave a blank page, and the default (empty) must show every tab.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

test("hiding every tab shows them all; a pane left on a hidden tab moves to one that shows", () => {
  assert.match(app, /const visible = VIEWS\.some\(\(v\) => !isHidden\(v\)\) \? VIEWS\.filter\(\(v\) => !isHidden\(v\)\) : VIEWS;/);
  assert.match(app, /setView\(l, p\.id, visible\[0\]!\.id\)/);
});

test("the setting is empty by default and matched case-insensitively against ids and labels", () => {
  assert.match(server, /hiddenTabs: \{ type: "string", [^\n]*default: "" \}/);
  assert.match(server, /hiddenTabs: cfg\.hiddenTabs\.split\(","\)\.map\(\(t\) => t\.trim\(\)\.toLowerCase\(\)\)\.filter\(Boolean\)/);
  assert.match(app, /hiddenTabs\.has\(v\.id\) \|\| hiddenTabs\.has\(v\.label\.toLowerCase\(\)\)/);
});
