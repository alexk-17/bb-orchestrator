// The page's navigation stays put (2026-11-17, the owner: it must not move while switching views). Since Home first (2026-11-20) there is no tab strip: the Sidebar and the bottom bar sit outside the panes, so no view can move them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("no tab strip in a pane; the navigation is drawn once, outside the panes, at a fixed width", () => {
  const panes = src("app/panes.tsx");
  assert.doesNotMatch(panes, /<Tabs\b|TabsList|data-tab-strip/, "no page picker or tabs in a pane");
  // the owner (2026-11-20, the split tree): a pane header holds Split right, Split down and Close, nothing else
  assert.match(panes, /label="Split right"[\s\S]*label="Split down"[\s\S]*label="Close"/);
  const app = src("app.tsx");
  const shell = app.slice(app.indexOf('<div className="flex min-h-0 flex-1">'));
  assert.ok(shell.indexOf("<PageSidebar ") >= 0 && shell.indexOf("<PageSidebar ") < shell.indexOf("<PaneLayout"), "the Sidebar sits before the panes, not in them");
  assert.ok(shell.indexOf("<BottomBar ") > shell.indexOf("<PaneLayout"), "the bottom bar sits under the panes");
  assert.match(src("app/page-nav.tsx"), /"--sidebar-width": "14rem"/, "a fixed width: a count coming or going moves nothing");
});

// The owner (2026-11-20) on the docked Chief of Staff input bar: "we can't have the input bar showing up, disappearing,
// showing up, disappearing ... just fucking remove it. no one uses it." So no tab, and not the feed, draws it, and nothing
// can bring it back; the owner writes to the CoS by replying under a post in the feed, or in the Chat tab's own chat.
test("no docked Chief of Staff input bar on any tab or in the feed", () => {
  for (const f of ["app.tsx", "app/feed.tsx", "app/cos-chat.tsx"]) {
    const s = src(f);
    assert.ok(s.length > 0, f); // a check that reads nothing must not pass
    assert.doesNotMatch(s, /<CosComposer\b|cos-composer\.tsx|data-feed-dock/, f);
  }
  assert.throws(() => src("app/cos-composer.tsx"), "the bar's component is gone");
  // the lines that drew it
  assert.match('<CosComposer agents={board.data?.agents} refetchAll={refetchAll} compact={compact} />', /<CosComposer\b/);
  assert.match('<div className={cx("shrink-0")} data-feed-dock="">', /data-feed-dock/);
});

