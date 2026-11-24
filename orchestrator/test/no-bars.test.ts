// No vertical accent lines on the Projects tab (2026-11-16, the owner: "remove the vertical line on the card vibecoded bs
// on the selected project and the uis"). A selected, loud or expanded project says so with a background tint or a
// heavier weight, never with a coloured left edge; the project page's thread tree indents without a rail. This reads
// the tab's own sources, so a left bar added back in any of them fails here, before a screenshot would catch it.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

// every component the tab renders (projects.tsx's, project-book.tsx's and search.tsx's own imports included)
const FILES = [
  "projects.tsx", "cc-lines.tsx", "project-detail.tsx", "direct-line.tsx", "ref-text.tsx", "project-book.tsx", "search.tsx",
  "agent-bits.tsx", "mon.tsx", "status-bar.tsx", "ui.tsx", "kit-ui.tsx", "thread-card.tsx", "pins.tsx",
  // the Scope tab follows the same rule
  "scope.tsx",
  // the work board (2026-11-23): its cards and columns show state with tints and chips only
  "work-board.tsx", "work-board-panel.tsx", "work-board-drag.ts",
  // its since lens (2026-11-24): the strip and the moved-card chip
  "board-since.tsx",
  // 2026-11-17: every shadcn component in app/ui, which every tab is moving onto (read from the folder, so a new one is in)
  ...readdirSync(new URL("../app/ui/", import.meta.url)).filter((f) => /\.tsx?$/.test(f)).map((f) => `ui/${f}`),
];
// a left or inline-start border, Tailwind's border-l/border-s, or an inset shadow with an x offset (inset 2px 0 0 …)
const BAR = /border-?left|borderLeft|border-?inline-?start|borderInlineStart|\bborder-[ls](?:-|\b)|inset\s+-?[1-9][\d.]*px\s+0/;

test("app/ui is read", () => assert.ok(FILES.includes("ui/button.tsx") && FILES.includes("ui/card.tsx"), "the shadcn components are in the list"));

// shadcn's grey structural hairlines the approved Home first mockups draw (2026-11-20), never a selection or a colour
const EDGES: Record<string, string[]> = {
  "ui/sidebar.tsx": [
    `: "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l",`,
    `"mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l border-sidebar-border px-2.5 py-0.5",`,
  ],
  "ui/sheet.tsx": [`"inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",`],
  // 2026-11-22, the owner: a project's scoping children on a thin tree line, as bb's sidebar draws threads under their
  // lead (the ui/sidebar.tsx sub-menu line above). A grey structural hairline, never a selection or a colour
  "projects.tsx": [`[data-orch] .orch-cc .k-kids > ul::before { content: ""; position: absolute; top: 0; bottom: 0; left: 28px; z-index: 1; pointer-events: none; border-left: 1px solid var(--border); opacity: 0.7; }`],
};

for (const f of FILES) {
  test(`${f}: no left border or vertical bar`, () => {
    // a renamed or missing file fails here: a check that reads nothing must not pass
    const src = readFileSync(new URL(`../app/${f}`, import.meta.url), "utf8");
    const hits = src.split("\n").filter((l) => BAR.test(l) && !/^\s*(\/\/|\/\*|\*)/.test(l) && !(EDGES[f] ?? []).includes(l.trim()));
    assert.deepEqual(hits, [], `${f} draws a vertical bar`);
  });
}

test("the pattern catches the bars that were there", () => {
  for (const s of [`.proj[data-loud] { box-shadow: inset 2px 0 0 var(--x); }`, `style={{ borderLeft: "1.5px solid" }}`, `className="border-l-2"`, `border-left: 3px solid`]) assert.match(s, BAR, s);
  for (const s of [`box-shadow: inset 0 0 0 1px var(--x)`, `border-bottom: 1px solid`, `border-radius: 8px`]) assert.doesNotMatch(s, BAR, s);
});

test("the Scope tab cancels the rule down the side of a card's detail", () => {
  // Needs you's card (answer-ui.tsx) draws its detail with a hairline down its left side, and the Scope tab shows that
  // same card. While the shared rule is there, the Scope tab must cancel it in its cards column.
  const read = (f: string) => readFileSync(new URL(`../app/${f}`, import.meta.url), "utf8");
  const shared = /\.orch-md \{[^}]*border-left/.test(read("answer-ui.tsx"));
  if (shared) assert.match(read("scope.tsx"), /\.orch-scope \[data-scope-cards\] \.orch-md \{[^}]*\bborder: 0;/, "the Scope tab shows the card's detail with a left rule");
});

test("each allowed edge is still in its file and is a grey hairline, not a colour", () => {
  for (const [f, lines] of Object.entries(EDGES)) {
    const src = readFileSync(new URL(`../app/${f}`, import.meta.url), "utf8").split("\n").map((l) => l.trim());
    for (const l of lines) {
      assert.ok(src.includes(l), `${f} no longer has: ${l}`);
      assert.doesNotMatch(l, /border-l-[2-9]|border-(?:primary|destructive|accent|orch|\[)/, `${f}: an allowed edge must stay a 1px neutral line`);
    }
  }
});

// 2026-11-23: the Pathways graph drew a 3-unit SVG rect in the state colour down each ticket node's left edge, which the
// CSS pattern above cannot see. A node now shows its state with a tint and a dot. Any SVG rect whose literal width is
// 4 or less is a vertical bar in the making, so it fails here.
const SVG_BAR = /<rect\b[^>]*?\swidth=(?:"|\{)\s*(?:[0-4](?:\.\d+)?)\s*(?:"|\})/;
const rects = (src: string) => src.match(/<rect\b[^>]*>/g) ?? [];
for (const f of FILES.filter((f) => f.endsWith(".tsx"))) {
  test(`${f}: no narrow SVG rect (a left bar)`, () => {
    const src = readFileSync(new URL(`../app/${f}`, import.meta.url), "utf8");
    assert.deepEqual(rects(src).filter((r) => SVG_BAR.test(r)), [], `${f} draws a narrow SVG bar`);
  });
}

test("the SVG pattern catches the Pathways node bar that was there", () => {
  const old = `<rect
                          x={box.x + 1}
                          y={box.y + 5}
                          width="3"
                          height={box.h - 10}
                          rx="1.5"
                          fill={color}
                        />`;
  assert.equal(rects(old).filter((r) => SVG_BAR.test(r)).length, 1);
  for (const s of [`<rect width={4} height={20} />`, `<rect x="0" width="2.5" />`]) assert.match(s, SVG_BAR, s);
  for (const s of [`<rect x={box.x} width={box.w} height={box.h} />`, `<rect width="5" height="5" />`, `<rect x="2" y="3" width="12" height="3" />`, `<rect x={x} width={w} height={3} />`]) assert.doesNotMatch(s, SVG_BAR, s);
});
