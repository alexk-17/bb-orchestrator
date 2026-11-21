// Why: the owner on the phone's Projects view (2026-11-20): "way too much empty space", and two stacked tab rows are "so
// confusing". Scope and Pathways folded into Projects (build plan step 3), so the page has
// one row of tabs, a phone's tapped project opens its own page, and old links and saved panes still land somewhere real.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RENAMED_VIEWS, parse } from "../app/layout.ts";
import { fromPath, toPath } from "../app/route.ts";
import { SUBS, navOf } from "../app/nav.ts";
import { PHONE_QUERY } from "../app/phone.ts";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const fn = (s: string, name: string) => s.slice(s.indexOf(`function ${name}(`), s.indexOf("\n}\n", s.indexOf(`function ${name}(`)));
const VIEWS = [
  { id: "home", subPath: "" },
  { id: "projects", subPath: "projects" },
  { id: "board", subPath: "board" },
];

test("Projects has no pages row: no sub-pages, so a phone shows only its filter row under bb's header", () => {
  assert.equal(SUBS.projects, undefined, "a sub-page here would draw the pages row above the filters again");
  const nav = navOf(["home", "chat", "projects", "open-prs"].map((id) => ({ id, label: id })), new Set());
  assert.deepEqual(nav.main.find((m) => m.id === "projects")!.subs, []);
  const app = src("app.tsx");
  assert.doesNotMatch(app, /id: "scope", subPath: "scope"/, "Scope is no view of its own");
  assert.doesNotMatch(app, /id: "pathways", subPath: "pathways"/, "Pathways is no view of its own");
});

test("old Scope and Pathways links and saved panes open Projects, at the entry or project they named", () => {
  assert.equal(RENAMED_VIEWS.scope, "projects");
  assert.equal(RENAMED_VIEWS.pathways, "projects");
  for (const p of ["scope", "scope/kite", "pathways", "pathways/kite"]) assert.equal(fromPath(p, VIEWS).view, "projects", p);
  assert.deepEqual(fromPath("pathways/kite", VIEWS).path, ["kite"], "a Pathways link opens that project's page, which holds Pathways");
  assert.equal(fromPath("scope/kite%2Fst-1a2b", VIEWS).params.scope, "kite/st-1a2b", "a scoping task's entry");
  assert.equal(fromPath("scope", VIEWS).params.scope, undefined, "bare Scope: the list, with its Scoping group on top");
  assert.equal(fromPath("scope/%E0%A4%A", VIEWS).params.scope, undefined, "a broken escape opens the list, not an error");
  const entry = { view: "projects", path: [], params: { scope: "kite/st-1" } };
  assert.deepEqual(fromPath(toPath(entry, VIEWS), VIEWS), entry, "back on Projects, the same entry is open");
  assert.equal(toPath({ view: "projects", path: ["kite"], params: {} }, VIEWS), "projects/kite");
  const saved = parse({ root: { kind: "pane", id: "p1", view: "scope" }, focus: "p1" }, VIEWS);
  assert.equal(saved && saved.root.kind === "pane" ? saved.root.route.view : null, "projects", "a saved Scope pane keeps its place");
});

test("a scoping card stays reachable: opening it lands on its entry's page in Projects, where it is drawn", () => {
  const app = src("app.tsx");
  const open = app.slice(app.indexOf("const openCard = "), app.indexOf("const render = "));
  assert.match(open, /params: \{ scope: scopeEntryOf\(scoping, /, "not the bare list, where no card is drawn");
  assert.match(open, /act\(lay\.current!\.focus, \{ view: "projects"/, "in the focused pane");
  assert.match(app, /projects: scopeWaiting \|\| /, "what waits there is counted on Projects in the nav");
});

test("on a phone a tapped project opens its own page with a Back row; in a narrow pane too, never expanded in the list", () => {
  const p = src("app/projects.tsx");
  // the lead (2026-11-20): only bb's phone layout, never a pane's width, so a narrowed desktop window doesn't change
  assert.equal(PHONE_QUERY, "(max-width: 767px) and (pointer: coarse)", "bb's own touch-phone layout (spec.md)");
  assert.match(p, /const phone = useTouchPhone\(\);/);
  assert.match(p, /\) : linked && phone \? \(\s*detailPanel\(linked, \{ onBack: \(\) => open\(null\), page: true \}\)/);
  assert.match(p, /\) : phone \? \(\s*<ListRow [^>]*onSelect=\{\(\) => open\(p\.slug\)\} \/>/, "a phone row opens the page");
  // the owner (2026-11-20): an item opened in a narrow pane opens inside that pane, with Back
  assert.match(p, /\) : pickedPage && !phone \? \(\s*detailPanel\(pickedPage, \{ onBack: \(\) => onPick\(null\) \}\)/, "a narrow pane's row opens the project's page");
  assert.doesNotMatch(p, /ListRowInPlace|data-in-place/, "nothing expands in place any more");
  assert.match(p, /if \(linked && !phone\) return <ProjectDetail /, "web's project page is its history and Pathways, as before");
  assert.match(p, /\{onBack \? <BackRow onBack=\{onBack\}>\{more\}<\/BackRow> : null\}/, "the ⋯ shares the Back row, so no control sits alone on a line");
  assert.match(p, /\{onBack \? <ProjectSections /, "a phone's page holds Timeline, Flow and Dependencies");
  assert.match(p, /<ScopingRows /, "the Scoping group sits in the list");
  // Pathways reads Linear: it fetches only once opened
  assert.match(src("app/project-detail.tsx"), /<CollapsibleContent>\{open \? <PathwaysSection /);
  assert.doesNotMatch(src("app.tsx"), /focusedView === "projects" && \(detail/, "the bottom bar is left as it was (the nav-panes pause)");
});

test("a project row shows no lead title or type, on phone and web", () => {
  const p = src("app/projects.tsx");
  // the owner (2026-11-20): "we don't need those types on the project names anymore; it doesn't really help and just adds clutter"
  for (const name of ["ListRow", "ArchivedRow"]) {
    const row = fn(p, name);
    assert.ok(row.length > 100, name);
    assert.doesNotMatch(row, /k-mon|k-type|className="who"|head\.name|head\.type/, `${name} draws no title or type`);
  }
  assert.doesNotMatch(fn(p, "ListRow"), /PathwaysLink/, "no Pathways button on the row, which covered the lead's name");
});

test("a phone's project row sits on the 16 px gutter: name and age over state, working and one count", () => {
  const p = src("app/projects.tsx");
  const phone = (sel: string) => new RegExp(`\\[data-orch\\] \\.orch-cc\\[data-phone\\] ${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(p)?.[1] ?? "";
  assert.match(phone(".k-prow"), /padding: 10px 0;/, "no inset of its own: the pane's 16 px is the gutter");
  assert.match(phone(".k-prow .k-sub"), /flex-wrap: wrap;.*overflow: visible;/, "the working count wraps rather than being cut");
  assert.match(phone(".standing"), /flex-wrap: nowrap;/, "the standing agents take one line");
  assert.match(phone(".top .filters"), /width: 100%;/, "the filter row fits the screen");
  assert.match(p, /data-phone=\{phone \|\| undefined\}/, "only bb's phone layout gets them");
  assert.match(src("app/panes.tsx"), /"px-4 pt-4"/, "the pane's one gutter");
});

// 2026-11-20: on a phone, a tap in the message box to the lead (its focus picks the project) routed to projects/@<slug>,
// which a phone draws as the list, so the owner was thrown out of the project they were writing in. The route that the
// pick writes is the bug, so the check is on the route: from the phone's page, a pick must leave the route alone.
test("on a phone's project page, focusing the message box keeps the owner on that page", () => {
  const picked = fromPath(toPath({ view: "projects", path: [], params: { open: "ledger-sync" } }, VIEWS), VIEWS);
  assert.deepEqual(picked.path, [], "a pick is projects/@<slug>: no project page, the list on a phone");
  const s = src("app/projects.tsx");
  const phonePage = s.match(/linked && phone \? \(\s*detailPanel\(linked, \{([^}]*)\}\)/);
  assert.ok(phonePage, "the phone's project page is a detail panel");
  assert.match(phonePage[1]!, /\bpage: true\b/, "marked as the page itself");
  assert.match(s, /onPick=\{o\.page \? \(\) => \{\} : \(\) => onPick\(p\.slug\)\}/, "the page's pick routes nowhere");
});
