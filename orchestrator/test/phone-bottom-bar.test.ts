// The owner, 2026-11-21, on his phone: "the bottom navigation is actually not good. i hate that there's all that extra
// space that's being wasted". bb's app shell already pads the bottom safe-area inset under every page; the bar padded
// it again, so an iPhone showed 34 px of padding inside the bar and 34 px of empty strip under it, and the buttons were
// 58 px tall. The bar is a standard tab bar: 48 px buttons, the inset counted once (by bb). Then (2026-11-21): "the spacing
// looks really weird on the icons below. there's no padding on top ... move the icons lower": the icons sit 8 px under
// the bar's top border, the label under them, clear of the home-indicator area below the bar.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const nav = readFileSync(new URL("../app/page-nav.tsx", import.meta.url), "utf8");
const bar = nav.slice(nav.indexOf("export function BottomBar("), nav.indexOf("export function PlaceLinks("));

test("the phone bar adds no safe-area padding of its own: bb's shell already pads the inset", () => {
  assert.ok(bar.length > 0);
  assert.doesNotMatch(bar, /safe-area-inset/, "padding the inset here counts it twice on an iPhone");
});

test("the phone bar's buttons are a standard tab bar's height, not grown by padding", () => {
  assert.match(bar, /const cell = \(active: boolean\) => `relative h-12 w-full min-w-0 flex-col justify-start gap-0\.5 rounded-none px-0 pt-2 pb-0/, "48 px buttons, the icons 8 px under the top border");
  assert.doesNotMatch(bar, /\bh-auto\b|\bpy-2\b/, "padding-grown buttons were 58 px tall");
});
