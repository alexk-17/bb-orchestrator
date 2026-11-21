// The e2e scripts never reach the live app by accident (2026-11-18): proof.mjs answers, defers and resends for real and
// compose.mjs sends a message, so a run with no base, or with the live app's address, must stop before a browser opens. Only an explicit --live gets past.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkBase, isLiveBase } from "./e2e/live-guard.ts";

test("no base is refused: there is no default to fall back on", () => {
  assert.throws(() => checkBase(undefined, false), /required/);
  assert.throws(() => checkBase("", true), /required/);
  assert.throws(() => checkBase("127.0.0.1:4100", false), /not a URL/);
});

test("the live app is refused under each loopback name unless --live is given", () => {
  for (const b of ["http://127.0.0.1:38886", "http://localhost:38886/", "http://LOCALHOST:38886", "http://[::1]:38886", "http://0.0.0.0:38886"]) {
    assert.ok(isLiveBase(b), b);
    assert.throws(() => checkBase(b, false), /live app/, b);
    assert.equal(checkBase(b, true), b.replace(/\/+$/, ""), `${b} with --live`);
  }
});

test("a harness URL passes, on any other port or host", () => {
  for (const b of ["http://127.0.0.1:4100", "http://localhost:38887", "http://example.test:38886"]) {
    assert.equal(isLiveBase(b), false, b);
    assert.equal(checkBase(`${b}/`, false), b);
  }
});

test("every e2e script runs the guard before Playwright loads, and keeps no live default", () => {
  for (const f of ["proof.mjs", "less-text.mjs", "compose.mjs", "open-prs-post.mjs", "panes.mjs", "split-tree.mjs", "dock.mjs", "dividers.mjs", "picker.mjs"]) {
    const src = readFileSync(new URL(`./e2e/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /default:\s*["']http/, `${f} has a default base`);
    assert.doesNotMatch(src, /^import .*playwright/m, `${f} loads Playwright before the guard`);
    const guard = src.indexOf("checkBase(");
    const pw = src.indexOf('import("playwright-core")');
    assert.ok(guard > 0 && pw > guard, `${f}: the guard runs before Playwright is loaded`);
  }
});

test("compose.mjs, which really sends, has no hard-coded app address left", () => {
  const src = readFileSync(new URL("./e2e/compose.mjs", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"); // its header comment may name the live app
  assert.doesNotMatch(code, /127\.0\.0\.1|localhost|38886/, "compose.mjs names an address instead of taking --base");
  assert.match(src, /goto\(`\$\{base\}\//, "it navigates under the checked base");
});
