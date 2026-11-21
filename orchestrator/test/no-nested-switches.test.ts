// Why: the owner asked "why is there a nested tab?"; a switch hides half a view behind a click, so each of the four is one scroll (2026-11-20).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { recordRows } from "../app/kit.ts";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const fn = (s: string, name: string) => s.slice(s.indexOf(`function ${name}(`), s.indexOf("\n}\n", s.indexOf(`function ${name}(`)));

test("the book's record is one list, newest first, every row tagged done or decided", () => {
  const done = [
    { kind: "merged" as const, text: "PR 12 merged", at: 300, ref: null, state: null },
    { kind: "report" as const, text: "Report", at: 100, ref: null, state: null },
  ];
  const decided = [{ id: "d-1", title: "Ship it?", answer: "Yes", at: 200 }];
  const rows = recordRows(done, decided);
  assert.deepEqual(rows.map((r) => [r.t, r.at]), [["done", 300], ["decided", 200], ["done", 100]], "a decision sits between the two things done around it");
  assert.equal(recordRows([], []).length, 0);
});

test("the book draws the record without a Done | Decided switch", () => {
  const book = src("app/project-book.tsx");
  assert.doesNotMatch(book, /from "\.\/ui\/tabs\.tsx"|data-record-tab/, "no tabs in the book");
  assert.match(book, /recordRows\(book\?\.done \?\? \[\], book\?\.decided \?\? \[\]\)/);
  assert.match(book, /data-record-row="decided"/);
  assert.match(book, /data-record-row="done"/);
});

test("a project's page shows Timeline, Flow and Dependencies on one scroll; Range stays a filter", () => {
  const page = fn(src("app/project-detail.tsx"), "ProjectSections");
  assert.match(fn(src("app/project-detail.tsx"), "ProjectDetail"), /<ProjectSections /);
  assert.doesNotMatch(page, /ToggleGroup/, "no view switch on the page");
  for (const s of ["timeline", "flow", "deps"]) assert.match(page, new RegExp(`<DetailSection name="${s}"`), s);
  assert.match(src("app/project-detail.tsx"), /aria-label="Range"/, "the Range chips are a filter and stay");
});

test("Scope's chat is the lead's chat; the scoping thread is a link out", () => {
  const chat = fn(src("app/scope.tsx"), "ScopeChat");
  assert.doesNotMatch(chat, /Tabs|Whose chat|ThreadBox/);
  assert.match(chat, /navigate\.toThread\(planner\.threadId\)/);
  assert.match(chat, /<ChatBody /);
});

test("a Multiplayer board shows its Timeline under Now, not behind a toggle", () => {
  const tab = fn(src("multiplayer/app.tsx"), "MultiplayerTab");
  assert.doesNotMatch(tab, /ToggleGroup|data-view-now|data-view-timeline/);
  assert.ok(tab.indexOf("<Now ") >= 0 && tab.indexOf("<Now ") < tab.indexOf("<Timeline "), "Now first, then Timeline");
  assert.match(tab, /back=\{\(\) => setView\(\{ t: "now" \}\)\}/, "a record's review goes back to the board");
});
