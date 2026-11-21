// The owner, 2026-11-20: "the input bars right now are so slow and laggy". Measured on the live app, each keystroke in a
// reply box changed the DOM twice over: React rewrote the controlled textarea's text child, and re-rendered the attach
// button's hidden file input, which resets its name and type. Inside bb's page each such change sets off bb's own :has()
// rules, and about 3,500 elements were restyled per key (a bare textarea on the same page: about 190). Every other text
// field had the same fault: a controlled <input> is re-rendered on each key, and React resets its name and type (the
// Projects search: about 2,000 elements per key; the view picker's filter: about 1,800). A keystroke must change nothing
// in the DOM but the text the owner typed.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { after, test } from "node:test";
import { createElement as h, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanTsx, importTsx } from "./tsx-render.ts";

after(cleanTsx);

type Any = ComponentType<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const rc = await importTsx<Record<string, Any>>("app/reply-composer.tsx");
const ui = await importTsx<Record<string, Any>>("app/ui/input.tsx");
const attach = readFileSync(new URL("../app/image-attach.tsx", import.meta.url), "utf8");
const input = readFileSync(new URL("../app/ui/input.tsx", import.meta.url), "utf8");
const command = readFileSync(new URL("../app/ui/command.tsx", import.meta.url), "utf8");

test("the reply field's text is not React's to rewrite: value never reaches the textarea as a controlled prop", () => {
  const html = renderToStaticMarkup(h(rc.ReplyField!, { value: "ship it today", onChange: () => {} }));
  assert.match(html, /<textarea[^>]*><\/textarea>/, "a controlled textarea gets its text child rewritten on every key");
  assert.doesNotMatch(html, /ship it today/);
});

test("the attach button's hidden file input does not re-render when the box does", () => {
  assert.match(attach, /const FilePicker = memo\(function FilePicker/, "the input must sit in a memoized component");
  assert.match(attach, /<FilePicker picker=\{picker\} onPick=\{onPick\} \/>/, "only the ref and a stable callback may reach it");
  assert.match(attach, /const onPick = useCallback\(\(files: File\[\]\) => latest\.current\(files\), \[\]\);/, "the callback must be stable across keystrokes");
});

test("the shared Input's value never reaches the <input> as a controlled prop, and the <input> only renders through memo", () => {
  const html = renderToStaticMarkup(h(ui.Input!, { value: "orchestr", onChange: () => {} }));
  assert.doesNotMatch(html, /value=/, "a controlled <input> re-renders on every key, and React resets its name and type");
  assert.match(input, /const Field = React\.memo\(function Field/, "the <input> must sit in a memoized component");
  assert.match(input, /function Input\([^)]*\) \{\n  return \(\n    <StillInput/, "Input must draw StillInput");
});

test("the command filter (the view picker's) is the still input, not cmdk's Input", () => {
  assert.doesNotMatch(command, /<CommandPrimitive\.Input/, "cmdk's Input re-renders on every key");
  assert.match(command, /<StillInput\n        ref=\{field\}\n        cmdk-input=""/, "the filter keeps cmdk's attribute, so its styles and the browser checks still find it");
  assert.match(command, /setAttribute\("aria-activedescendant", active\)/, "the active row is still announced");
});

// Measured on the live app (2026-11-20): inside bb's page, one element added or removed restyles about 2,700 elements,
// because of :has() rules in the page's CSS (bb's Terminals plugin's, and Tailwind group-has classes). So a keystroke in
// a filter must not add or remove rows: the Projects results follow the box once typing pauses, and the view picker
// keeps every row and hides the ones that don't match.
const projects = readFileSync(new URL("../app/projects.tsx", import.meta.url), "utf8");
const picker = readFileSync(new URL("../app/view-picker.tsx", import.meta.url), "utf8");

test("the Projects results follow the search box once typing pauses, not on each key", () => {
  assert.match(projects, /const found = useSettled\(query\);/);
  assert.match(projects, /<SearchBox value=\{query\} onChange=\{setQuery\} \/>/, "the box itself shows every key at once");
  for (const use of ["searchLoaded(live, lanes, cards, found,", "searchedProjects(filtered, hits, found)", "<SearchHits q={found}"]) assert.ok(projects.includes(use), `results must follow the settled words: ${use}`);
  assert.doesNotMatch(projects, /searchLoaded\([^)]*\bquery\b/, "a result list fed by the raw box re-renders rows on every key");
});

test("the view picker hides rows that don't match instead of removing them, and the arrows skip them", () => {
  assert.match(picker, /\{rows\.main\.length \? <CommandGroup style=\{shown\.main\.length \? undefined : off\}>\{rows\.main\.map\(row\)\}/, "every row is drawn, matching or not");
  assert.match(picker, /disabled=\{!on\.has\(r\.id\)\} style=\{on\.has\(r\.id\) \? undefined : off\}/, "a hidden row must be disabled too, or the arrows land on it");
  assert.doesNotMatch(picker, /shown\.(main|tools|filters)\.map\(row\)/, "drawing only the matches adds and removes rows per key");
});

// The same evening: the rules behind that restyle are :has() rules whose anchor is an ancestor of what they style.
// Tailwind writes one for each group-has-* class (`:is(.group\/x:has(...) *)`), and for a has-* class that styles
// children (`.x:has(...) > *`). Each such rule alone made every element added or removed anywhere on bb's page restyle
// about 2,700 elements. Our nine are gone (the rows pass their own classes instead); none may come back.
test("no Tailwind class in the plugin compiles to a :has() rule anchored above what it styles", () => {
  const files = (dir: string): string[] => readdirSync(new URL(dir, import.meta.url)).flatMap((n) => (statSync(new URL(dir + n, import.meta.url)).isDirectory() ? files(`${dir}${n}/`) : /\.(tsx?|css)$/.test(n) ? [`${dir}${n}`] : []));
  const offenders: string[] = [];
  for (const f of [...files("../app/"), "../app.tsx"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    for (const m of src.matchAll(/(?<![\w-])(?:group|peer)-has-[^\s"'`]*|(?<![\w-])has-[^\s"'`]*?:(?:-?space-[xy]|\*|divide)[^\s"'`]*/g)) offenders.push(`${f}: ${m[0]}`);
  }
  assert.deepEqual(offenders, [], "a group-has-* or child-styling has-* class makes the whole page restyle on every DOM insert");
});
