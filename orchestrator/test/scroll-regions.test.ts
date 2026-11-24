// Only the cards scroll (2026-11-17, the owner: "the left navigation bar should stay in the same locations and also the
// header card should only the cards should scroll"). Wide, Projects and Scope take the pane's whole height
// (panes.tsx [data-fits-pane]); the list and the detail's header sit outside the one region that scrolls, and the cards
// are inside it. Before, the pane scrolled everything as one page, so the list and the header went up with the cards.
// This reads the sources, so the rule going fails here before a screenshot would catch it; the old lines are the fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

/** The body of one top-level function, up to the next one */
const fn = (s: string, name: string) => {
  const at = s.indexOf(`function ${name}(`);
  if (at < 0) return "";
  const next = s.slice(at + 1).search(/\n(export )?function /);
  return s.slice(at, next < 0 ? undefined : at + 1 + next);
};
/** The <div>s a stretch of JSX leaves open: 0 when every one it opens is closed in it */
const openDivs = (jsx: string) => (jsx.match(/<div\b[^>]*[^/]>/g)?.length ?? 0) - (jsx.match(/<\/div>/g)?.length ?? 0);
/** A CSS rule's declarations, by its exact selector */
const rule = (s: string, selector: string) => s.split("\n").find((l) => l.startsWith(`${selector} {`)) ?? "";

/**
 * Where the detail's parts sit, from the JSX between the head's opening tag and the cards': the head (name row and chat
 * card, its composer with it) closed before the cards' region opens, and the cards (ProjectBook) inside that region.
 */
function detailOrder(detail: string): string | null {
  const head = detail.indexOf('<div className="k-dfixed"');
  const cards = detail.indexOf('<div className="k-dcards"');
  const book = detail.indexOf("<ProjectBook");
  if (head < 0) return "no fixed head";
  if (cards < 0) return "no region for the cards";
  if (!(head < cards && cards < book)) return "the cards are not inside their region";
  for (const part of ['className="k-dhead"', "<ChatCard", "<Composer"]) {
    const at = detail.indexOf(part);
    if (!(head < at && at < cards)) return `${part} is not in the fixed head`;
  }
  if (openDivs(detail.slice(head, cards)) !== 0) return "the head is still open where the cards start: it would scroll with them";
  if (openDivs(detail.slice(cards, book)) !== 1) return "ProjectBook is not inside the cards' region";
  return null;
}

test("the pane hands a [data-fits-pane] tab its height and scrolls nothing itself", () => {
  const panes = src("app/panes.tsx");
  const frame = rule(panes, "[data-orch] .orch-pane__scroll[data-fits]");
  assert.match(frame, /display: flex;/);
  assert.match(frame, /overflow: hidden;/, "the pane would scroll the list and the header with the cards");
  // a stable gutter under overflow: hidden still takes the scrollbar's room
  assert.match(frame, /scrollbar-gutter: auto;/);
  assert.match(rule(panes, "[data-orch] .orch-pane__scroll[data-fits] > div"), /flex: 1 1 auto;.*min-height: 0;/);
  assert.match(rule(panes, "[data-orch] [data-fits-pane]"), /flex: 1 1 auto;.*min-height: 0;/);
  // the owner, 2026-11-20: "the input bars right now are so slow and laggy". A has-selector on the pane's scroller made
  // every keystroke restyle the whole pane; the views now tell their pane with usePaneFits
  assert.doesNotMatch(panes, /orch-pane__scroll:has\(/, "a has-selector on the pane's scroller restyles the pane on every keystroke");
  assert.match(src("app/projects.tsx"), /usePaneFits\(wide && listShown\)/);
  assert.match(src("app/scope.tsx"), /usePaneFits\(wide \|\| fits\)/);
});

/** The guards of a view's early returns: `if (x) return …` at the top level of its body */
const earlyReturns = (view: string) => [...view.matchAll(/\n {2}if \((.*)\)\s*return\b/g)].map((m) => m[1]);

test("Projects asks its pane to fit only while it draws the list that fits: the board and the Timeline page scroll", () => {
  // the owner, 2026-11-24: on a project's Timeline page, opened from the list, the lanes ran past the pane and the rest
  // could not be reached. The ask followed the list's width, which outlives the list's root, so the pane stopped
  // scrolling for a page that has no [data-fits-pane] root and no scroll region of its own
  const view = fn(src("app/projects.tsx"), "ProjectsView");
  assert.match(view, /usePaneFits\(wide && listShown\);/);
  assert.doesNotMatch(view, /usePaneFits\(wide\);/, "the ask that cut the Timeline page off");
  const shown = view.match(/const listShown = (.*);/)?.[1] ?? "";
  // every early return draws something other than the list's root, so each one is outside listShown; a new one has to
  // be added here, and to listShown when it doesn't draw the root
  assert.deepEqual(earlyReturns(view), ["board", "!all", "linked && !phone"]);
  assert.match(shown, /!board\b/, "the board draws no [data-fits-pane] root");
  assert.match(shown, /!!q\.data\b/, "nor does the loading state (all = q.data)");
  assert.match(shown, /!\(detail && !phone && q\.data\.some\(\(p\) => p\.slug === detail\)\)/, "nor does the web project page (linked && !phone)");
  assert.match(view, /const linked = detail \? all\.find\(\(p\) => p\.slug === detail\) : undefined;/, "listShown mirrors how linked is found");
  // the check reads the returns it should: the old body, with the board's return on two lines
  assert.deepEqual(earlyReturns("\n  if (board)\n    return (\n  if (!all) return <ReadState />;\n  const x = () => {\n    if (y) return 1;\n  };"), ["board", "!all"]);
});

test("the board's open-card panel never holds the wheel it can't use: over a short panel, the board scrolls", () => {
  // the owner, 2026-11-24: "the workboard is literally not scrollable". After the pane fix one place still was: with a
  // card open, its panel covers the board's right-hand columns (400 px of a pane of about 820). overscroll-behavior: contain on a box that is overflow-y: auto
  // stops the wheel there even when the box has nothing to scroll, so half the board ignored the wheel
  const side = rule(src("app/work-board.tsx"), ".wb-side");
  assert.ok(side, "the panel's rule is found");
  assert.doesNotMatch(side, /overscroll-behavior(-y)?:\s*(contain|none)/, "the panel would keep the board still under the pointer");
  // it still scrolls itself when it is long, and stays in sight while the board scrolls under it
  assert.match(side, /overflow-y: auto;/);
  assert.match(side, /position: sticky;/);
  // the check reads the rule it should: the old line is the fixture
  assert.match(rule(".wb-side { position: sticky; overflow-y: auto; overscroll-behavior: contain; }", ".wb-side"), /overscroll-behavior(-y)?:\s*(contain|none)/);
});

test("Projects, wide: the list and the project's header stay put, only the cards scroll", () => {
  const projects = src("app/projects.tsx");
  // only the wide layout opts in: one column keeps the pane's one scroll, a project opening as its own page
  assert.match(projects, /<div ref=\{root\} data-projects-width=\{width\} data-fits-pane=\{wide \|\| undefined\}>/);
  assert.match(projects, /<div className=\{wide \? "k-listpane" : undefined\} data-projects-list="">/);
  // the height reaches the two columns, which scroll each on its own
  assert.match(rule(projects, "[data-orch] [data-fits-pane] .b-body"), /flex: 1 1 0;.*min-height: 0;.*grid-template-rows: minmax\(0, 1fr\);.*align-items: stretch;/);
  assert.match(rule(projects, "[data-orch] [data-fits-pane] .b-body > .k-listpane"), /min-height: 0;.*overflow-y: auto;/, "the list scrolls on its own when taller");
  assert.match(rule(projects, "[data-orch] [data-fits-pane] .b-body > .detail > .k-dcards"), /flex: 1 1 0;.*overflow-y: auto;/, "the cards scroll in their own region");
  // the head (2026-11-20, 1.36.1): never cut below its own height while the cards keep 48 px, so a closed chat's message box
  // shows whole; the 50% cap hid Send under the fold once a profile card joined the head
  assert.match(rule(projects, "[data-orch] [data-fits-pane] .b-body > .detail > .k-dfixed"), /flex: none; min-height: 0; max-height: calc\(100% - 48px\); overflow-y: auto;/);
  assert.doesNotMatch(projects, /max-height: 50%;/, "the 1.36.1 cap: Send under the fold at 1440x900");
  // nothing in the chat card shrinks (1.36.0: the row slid under the box); an open transcript is measured (head-fit.ts)
  assert.match(projects, /\.k-dfixed > \.k-chatcard, [^{]*\.k-dfixed \.k-chat, [^{]*\.k-dfixed \.k-chat > \* \{ flex: none; \}/, "the card, the chat, its row and its transcript keep their size");
  assert.doesNotMatch(projects, /\.k-dfixed \.k-chat[^{]*\{ flex: 0 1 auto; min-height: 0; \}/, "the 1.36.0 line: the closed row shrank under the box");
  assert.doesNotMatch(projects, /cqh - 240px/, "the 1.36.1 constant for the rest of the head: 150 px off with a profile card");
  assert.match(projects, /\.k-dfixed \.k-chat > \.k-leadthread \{ height: var\(--k-transcript-h, var\(--k-leadthread-h, 480px\)\); \}/);
  assert.match(projects, /\.k-dfixed \.k-chat > \.k-chat__log \{ max-height: var\(--k-transcript-h, 480px\); \}/);
  assert.match(projects, /const headFit = useHeadFit<HTMLDivElement>\(\);/);
  assert.match(projects, /<div className="k-dfixed" ref=\{headFit\} data-detail-head=\{project\.slug\}>/, "the measure is on the head");
  // past the room (a short window) the head scrolls, and the message box stays stuck to the bottom of what shows
  assert.match(projects, /\.k-dfixed > \.k-chatcard \{ overflow: clip; \}/, "clip, not hidden: a hidden card would be the box's scroller and unstick it");
  assert.match(projects, /\.k-dfixed \.k-composer \{ position: sticky; bottom: 0; z-index: 1; background: var\(--card\); \}/);
  // the real-browser check (Send inside the head's visible box, closed and open, three sizes) is test/e2e/chat-row.mjs
  assert.equal(detailOrder(fn(projects, "DetailPanel")), null);
  // a new project's cards start at the top: the detail is a new element per project, the list the same one
  assert.match(projects, /<DetailPanel key=\{p\.slug\} /);
  assert.match(projects, /detailPanel\(selected\)/);
  // the old detail: the head and the cards one flow inside the pane's scroll
  const old = `<div className="k-dhead">…</div>
        {project.lead ? (<ChatCard slug={project.slug}><Composer compact /></ChatCard>) : null}
        <ProjectBook project={project} />`;
  assert.equal(detailOrder(old), "no fixed head");
  // the head left open around the cards: it would scroll with them
  assert.match(detailOrder('<div className="k-dfixed"><div className="k-dhead"></div><ChatCard><Composer /></ChatCard><div className="k-dcards"><ProjectBook /></div></div>') ?? "", /still open/);
});

test("Scope, wide: the entry's header card stays put beside Projects' list, only the body scrolls", () => {
  const scope = src("app/scope.tsx");
  // since 2026-11-20 the entry sits beside Projects' list (fits), which holds the Scoping rows
  assert.match(scope, /<div ref=\{setRoot\} data-scope-tab="" data-scope-width=\{width\} data-fits-pane=\{wide \|\| fits \|\| undefined\} className=\{fits \? "flex min-h-0 flex-col" : undefined\}>/);
  assert.match(src("app/projects.tsx"), /entryOnly fits=\{wide\}/);
  assert.match(rule(scope, "[data-orch] [data-fits-pane] .orch-scope__grid"), /min-height: 0;.*grid-template-rows: minmax\(0, 1fr\);/);
  assert.match(rule(scope, "[data-orch] [data-fits-pane] .orch-scope__list"), /min-height: 0;.*overflow-y: auto;/);
  assert.match(rule(scope, "[data-orch] [data-fits-pane] .orch-scope__fixed"), /flex: none;/);
  assert.match(rule(scope, "[data-orch] [data-fits-pane] .orch-scope__body"), /flex: 1 1 0;.*overflow-y: auto;/);
  // the header card in the fixed part, closed before the body; the cards and the chat (its composer) in the body
  const view = fn(scope, "ScopeView");
  const fixed = view.indexOf('<div className="orch-scope__fixed"');
  const head = view.indexOf("{head}", fixed);
  const body = view.indexOf('className="orch-scope__body"');
  assert.ok(fixed > 0 && fixed < head && head < body, "the header card is in the fixed part");
  assert.equal(openDivs(view.slice(fixed, view.lastIndexOf("<div", body))), 0, "the fixed part is closed where the body starts");
  assert.match(view.slice(body, body + 800), /\{chatCol\}/);
  assert.match(view.slice(body, body + 800), /cardsCol/);
  // each entry's body starts at the top
  assert.match(view, /<div key=\{entry\.key\} className="orch-scope__body"/);
});

test("the web Timeline page lays out its own scroll: Back and the name stay put, the Range stays on top of the lanes", () => {
  // the owner, 2026-11-24: with many threads the lanes ran past the pane. The page now asks for the pane's height and
  // marks its root, in one component, so the two can't part again; scrolled to the last lane, Back and Range still show
  const detail = src("app/project-detail.tsx");
  const page = fn(detail, "ProjectDetail");
  assert.match(page, /usePaneFits\(true\);/, "the page asks for the pane's height");
  assert.match(page, /<div data-project-detail=\{project\.slug\} data-fits-pane="" /, "and marks the root the pane hands it to");
  const head = page.indexOf("data-detail-name-row");
  const back = page.indexOf("data-detail-back");
  const region = page.indexOf("data-detail-scroll=");
  assert.ok(head > 0 && head < back && back < region, "Back is in the name row, above the region");
  const regionTag = page.slice(page.lastIndexOf("<div", region), region);
  assert.equal(openDivs(page.slice(page.lastIndexOf("<div", head), page.lastIndexOf("<div", region))), 0, "the name row is closed where the region opens: it would scroll with the lanes");
  assert.match(regionTag, /min-h-0/, "without min-height 0 the region grows past the pane instead of scrolling");
  assert.match(regionTag, /flex-1/);
  assert.match(regionTag, /overflow-y-auto/);
  for (const part of ["<StatusBar", "<AllWaits", "<ProjectSections", "<PathwaysPart"]) assert.ok(page.indexOf(part) > region, `${part} scrolls in the region (its height has no bound)`);
  // the Range row sticks over the lanes, opaque, so the lanes pass under it
  const timeline = fn(detail, "Timeline");
  const range = timeline.slice(timeline.lastIndexOf("<div", timeline.indexOf("data-range-row")), timeline.indexOf('aria-label="Range"'));
  assert.match(range, /sticky top-0/);
  assert.match(range, /bg-background/, "a see-through row would draw the lanes through the toggle");
  // the old page: one flow inside the pane's scroll, with no region of its own
  const old = fn(`export function ProjectDetail() {
    return (
      <div data-project-detail={project.slug} className="flex min-w-0 flex-col gap-3 pb-8">
        <div className="flex min-w-0 flex-wrap items-center gap-2"><Btn data-detail-back="" /></div>
        <ProjectSections />
      </div>
    );
  }`, "ProjectDetail");
  assert.doesNotMatch(old, /data-fits-pane/);
  assert.equal(old.indexOf("data-detail-scroll="), -1);
});
