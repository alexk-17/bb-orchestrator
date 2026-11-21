// The owner, 2026-11-21, on the phone: "look at my delivered there's overflows which cause horizontal scrolling that's
// weird on phone". Measured on the live app at 390 px: a deliverable's "Details: …" fold toggle was one unbreakable line
// up to 570 px wide (a shadcn Button is nowrap and does not shrink), so the Home scroller took 590 px of content and the
// whole page slid sideways. Wide things scroll inside their own box (diagrams, code); the page only scrolls up and down.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const answer = readFileSync(new URL("../app/answer-ui.tsx", import.meta.url), "utf8");
const fold = answer.slice(answer.indexOf("export function Fold("), answer.indexOf("export function OtherBox("));
const feed = readFileSync(new URL("../app/feed.tsx", import.meta.url), "utf8");
const blocks = readFileSync(new URL("../app/visual-blocks.tsx", import.meta.url), "utf8");

test("a fold toggle's label wraps inside the card instead of running past it", () => {
  assert.ok(fold.length > 0);
  const toggle = fold.match(/<Btn[^>]*data-fold-toggle=""[^>]*>/)?.[0] ?? "";
  assert.match(toggle, /\bwhitespace-normal\b/, "a Button is nowrap: a long Details label was 570 px on a 390 px phone");
  assert.match(toggle, /\bh-auto\b/, "a wrapped label needs the toggle to grow taller than h-7");
  assert.match(toggle, /\bmax-w-full\b/, "the toggle never gets wider than the card");
  assert.match(fold, /\[overflow-wrap:anywhere\]">\{label\}/, "a long token in the label (a path, an id) breaks too");
});

test("the Home scroller never scrolls sideways: the page moves only up and down", () => {
  const scroller = feed.match(/<div ref=\{scroller\} className=\{cx\("([^"]*)"/)?.[1] ?? "";
  assert.match(scroller, /\boverflow-x-hidden\b/, "anything too wide must not turn the whole page into a sideways scroller");
  assert.match(scroller, /\boverflow-y-auto\b/);
});

test("a diagram's legend wraps instead of being cut off at the card's edge", () => {
  const panel = blocks.slice(blocks.indexOf("function Panel("), blocks.indexOf("function Panel(") + 900);
  assert.match(panel, /<div className="flex min-h-11 flex-wrap /, "the legend takes its own row when it doesn't fit beside the title");
  assert.match(panel, /ml-auto inline-flex max-w-full flex-wrap/, "Added / Changed / Removed ran past the card at 360 px");
});

test("a file's name button may shrink and wrap: a long name never runs past a phone's edge", () => {
  const files = readFileSync(new URL("../app/files.tsx", import.meta.url), "utf8");
  const open = files.match(/export const OPEN = "([^"]*)"/)?.[1] ?? "";
  for (const c of ["min-w-0", "max-w-full", "shrink", "whitespace-normal", "[overflow-wrap:anywhere]"])
    assert.ok(open.split(" ").includes(c), `${c}: prod-chat-e4a3-microvm-rca-2026-11-20.md ran 38 px past a 390 px phone`);
});

test("a block's title stays beside its icon; only the note drops to its own row", () => {
  const panel = blocks.slice(blocks.indexOf("function Panel("), blocks.indexOf("function Panel(") + 900);
  assert.match(panel, /min-w-0 flex-1 basis-32 text-sm font-semibold/, "in a wrapping row, a long title would otherwise drop under its icon");
});

test("short answer buttons and a file's deliverable link wrap instead of running past a phone's edge", () => {
  const pill = answer.match(/<Btn key=\{o\.key\} tone=\{primary \? "primary" : "outline"\} className=\{cn\("([^"]*)"/)?.[1] ?? "";
  for (const c of ["h-auto", "max-w-full", "whitespace-normal"]) assert.ok(pill.split(" ").includes(c), `${c}: a 32-character label with no spaces is wider than a 360 px card`);
  const files = readFileSync(new URL("../app/files.tsx", import.meta.url), "utf8");
  const link = files.match(/data-file-deliverable=\{f\.d\.id\} className="([^"]*)"/)?.[1] ?? "";
  for (const c of ["max-w-full", "min-w-0", "shrink", "whitespace-normal"]) assert.ok(link.split(" ").includes(c), `${c}: a Button is shrink-0 and would hold a long title on one line`);
});
