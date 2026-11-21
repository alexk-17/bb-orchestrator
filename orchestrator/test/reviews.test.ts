// Why: Home first step 3 (2026-11-20) makes Reviews one page: your PRs, then Team boards and the CodeRabbit queue only once used, so an unused board neither shows nor reads.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { shownTabs } from "../app/hidden-tabs.ts";
import { SET_UP, navOf, placeOf } from "../app/nav.ts";
import { toPath } from "../app/route.ts";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const app = src("app.tsx");
const reviews = src("app/reviews.tsx");

test("Reviews draws your PRs always, and Team boards and CodeRabbit only when shown (used, and not in hiddenTabs)", () => {
  assert.match(reviews, /<Section id="open-prs" title="Your PRs">\s*<OpenPrsView \/>/);
  assert.match(reviews, /\{shown\.has\("multiplayer"\) \? \(\s*<Section id="multiplayer" title="Team boards">\s*\{multiplayer\(\)\}/);
  assert.match(reviews, /\{shown\.has\("coderabbit"\) \? \(\s*<Section id="coderabbit" title="CodeRabbit queue">\s*\{coderabbit\(\)\}/);
  assert.match(app, /case "open-prs":\s*return <ReviewsView shown=\{new Set\(visible\.map\(\(v\) => v\.id\)\)\} multiplayer=\{\(\) => <TeamBoards [^\n]*\} coderabbit=\{\(\) => <ReviewQueueView \/>\} \/>;/, "sections are thunks: an unused one is never mounted, so never read");
  assert.match(app, /const visible = shownTabs\(VIEWS, new Set\(config\.data\?\.hiddenTabs \?\? \[\]\), scopeWaiting, new Set\(panes\(layout\.root\)\.map\(\(p\) => p\.route\.view\)\), inUse, PLACES\);/);
});

test("an unused board's way in stays: Tools → Set up opens its own page, which is still a page", () => {
  const nav = navOf([{ id: "multiplayer", label: "Multiplayer" }, { id: "coderabbit", label: "CodeRabbit" }, { id: "open-prs", label: "Open PRs" }], new Set());
  assert.deepEqual(nav.tools.filter((t) => t.id in SET_UP).map((t) => t.id), ["multiplayer", "coderabbit"]);
  assert.match(app, /\{ id: "multiplayer", subPath: "multiplayer"/);
  assert.match(app, /\{ id: "coderabbit", subPath: "coderabbit"/);
  assert.match(app, /case "multiplayer": \{[\s\S]*?return <MultiplayerTab /);
  assert.equal(placeOf("multiplayer"), "open-prs", "its page lights Reviews");
  assert.equal(placeOf("coderabbit"), "open-prs");
});

test("bb's title bar names the place: Reviews, not the old Open PRs tab", () => {
  assert.match(app, /return \{ title: MAIN\.find\(\(m\) => m\.id === view\)\?\.label \?\? VIEWS\.find/);
});

test("Team boards are cards, as in reviews-1440; each opens its board on the Multiplayer page (multiplayer/<id>)", () => {
  const mp = src("multiplayer/app.tsx");
  assert.match(mp, /export function TeamBoards\(\{ onOpen \}/);
  assert.match(mp, /data-team-board=\{b\.id\} onClick=\{\(\) => onOpen\(b\.id\)\}/);
  assert.match(app, /<TeamBoards onOpen=\{\(board\) => to\(\{ view: "multiplayer", path: \[board\], params: \{\} \}\)\} \/>/, "in the pane it was clicked in");
  assert.match(app, /const boardLink = route\.path\[0\] \?\? null;\s*return <MultiplayerTab key=\{boardLink \?\? ""\} initial=\{boardLink\}/, "the link picks that board");
  assert.equal(toPath({ view: "multiplayer", path: ["b-1"], params: {} }, [{ id: "multiplayer", subPath: "multiplayer" }]), "multiplayer/b-1", "its URL is multiplayer/<id>");
  assert.match(mp, /const \[picked, setPicked\] = useState<string \| null>\(initial\);/);
  assert.doesNotMatch(src("app/reviews.tsx"), /ToggleGroup|<Tabs/, "Reviews adds no row of tabs of its own: only Your PRs' filter");
});

test("hiddenTabs (the lead's call): a hidden multiplayer or coderabbit keeps its section hidden even once used", () => {
  const views = [{ id: "open-prs", label: "Open PRs" }, { id: "multiplayer", label: "Multiplayer" }, { id: "coderabbit", label: "CodeRabbit" }, { id: "rules", label: "Rules" }];
  const inUse = new Set(["multiplayer", "coderabbit"]);
  const ids = (hidden: string[]) => shownTabs(views, new Set(hidden), 0, new Set(), inUse, new Set(["open-prs"])).map((v) => v.id);
  assert.deepEqual(ids([]), ["open-prs", "multiplayer", "coderabbit", "rules"], "used: both sections show");
  assert.deepEqual(ids(["multiplayer"]), ["open-prs", "coderabbit", "rules"]);
  assert.deepEqual(ids(["codeRabbit".toLowerCase()]), ["open-prs", "multiplayer", "rules"]);
  assert.match(src("server.ts"), /Multiplayer and CodeRabbit hide their section in Reviews/);
});
