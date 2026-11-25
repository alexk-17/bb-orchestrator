import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const FILES = [
  "projects.tsx", "cc-lines.tsx", "project-detail.tsx", "direct-line.tsx", "ref-text.tsx", "project-book.tsx", "search.tsx",
  "agent-bits.tsx", "mon.tsx", "status-bar.tsx", "ui.tsx", "kit-ui.tsx", "thread-card.tsx", "pins.tsx",
  "scope.tsx",
  "work-board.tsx", "work-board-panel.tsx", "work-board-drag.ts",
  "board-since.tsx",
  "project-colour.ts",
  "board-fold.ts",
  "view-pref.ts",
  ...readdirSync(new URL("../app/ui/", import.meta.url)).filter((f) => /\.tsx?$/.test(f)).map((f) => `ui/${f}`),
];
const BAR = /border-?left|borderLeft|border-?inline-?start|borderInlineStart|\bborder-[ls](?:-|\b)|inset\s+-?[1-9][\d.]*px\s+0/;

test("app/ui is read", () => assert.ok(FILES.includes("ui/button.tsx") && FILES.includes("ui/card.tsx"), "the shadcn components are in the list"));

const EDGES: Record<string, string[]> = {
  "ui/sidebar.tsx": [
    `: "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l",`,
    `"mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l border-sidebar-border px-2.5 py-0.5",`,
  ],
  "ui/sheet.tsx": [`"inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",`],
  "projects.tsx": [`[data-orch] .orch-cc .k-kids > ul::before { content: ""; position: absolute; top: 0; bottom: 0; left: 28px; z-index: 1; pointer-events: none; border-left: 1px solid var(--border); opacity: 0.7; }`],
};

for (const f of FILES) {
  test(`${f}: no left border or vertical bar`, () => {
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
