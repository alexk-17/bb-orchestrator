// Why: Home first step 3 (2026-11-20): Delivered is In review, then Decided, then a Files and withdrawn page with Back, so a phone never stacks two rows of tabs there.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const view = src("app/past-view.tsx");
const deliverables = src("app/deliverables.tsx");

test("Delivered opens on Decided; an old outputs link opens on Files", () => {
  assert.match(deliverables, /useState<View>\(\{ \.\.\.START, filter: files \? "files" : "decided" \}\)/);
  assert.match(deliverables, /const heading = off \? "Files and withdrawn" : view\.filter === "decided" \? "Decided" : "Past deliverables";/);
});

test("Files and withdrawn is a page of its own: Back, one row of Withdrawn · Files, the kind as a Select, and no In review above it", () => {
  assert.match(view, /export const OFF_PAGE: readonly Filter\[\] = \["withdrawn", "files"\];/);
  assert.equal((view.match(/<ToggleGroup /g) ?? []).length, 1, "one row of tabs, and only on that page");
  assert.match(view, /\{off \? \(\s*<div[^>]*>\s*<Button[^>]*data-past-back=""/);
  assert.match(view, /<SelectTrigger aria-label="Kind of file" data-past-kind=""/);
  assert.match(deliverables, /\{off \? null : review\.length === 0 \? empty : review\.map/, "phone: no In review on the page");
  assert.match(deliverables, /<section aria-label="In review" hidden=\{off\}>/, "web: no In review on the page");
  assert.equal((deliverables.match(/\{off \? null : <FilesAndWithdrawn tab=\{tab\} setView=\{setView\} \/>\}/g) ?? []).length, 2, "the way there, under Decided, on phone and web");
});
