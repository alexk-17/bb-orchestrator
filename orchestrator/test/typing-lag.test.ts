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

// Public PR #22 brought one back by hand (2026-11-22): `.k-plist:has(> .k-prow[data-fold]) > .k-prow`, the same
// ancestor-anchored :has() as a group-has class, written in a CSS string instead. So the check reads the plugin's own
// CSS too: a :has() may pick the element it is on, never something under or beside it.
/**
 * Each selector in the CSS text whose :has() anchor sits above what it styles: after the :has(...) comes a combinator.
 * It reads whole rules, not lines (review of public PR #22's landing): a selector runs from the end of the previous
 * block, declaration or template string to its "{", across line breaks and after other rules on the same line, with CSS
 * comments taken out first, and each selector of a list judged on its own. A stretch that holds code, a line comment or
 * a string (";", "}", "/", a backtick, a quote outside an attribute's [ ]) is not a selector, so prose, code and class
 * strings never match.
 */
function ancestorHas(text: string): string[] {
  const out: string[] = [];
  // CSS comments go first: a comment inside a selector ("a:has(b) /* x */ c") is still that selector
  const css = text.replace(/\/\*[\s\S]*?\*\//g, " ");
  for (let at = css.indexOf(":has("); at >= 0; at = css.indexOf(":has(", at + 5)) {
    const before = css.slice(0, at);
    const start = Math.max(...["{", "}", ";", "`"].map((c) => before.lastIndexOf(c) + 1));
    // the :has( ... ) itself, nested parens included
    let depth = 0;
    let end = at + 4;
    for (; end < css.length; end++) {
      if (css[end] === "(") depth++;
      else if (css[end] === ")" && --depth === 0) break;
    }
    const brace = css.indexOf("{", end);
    if (brace < 0) continue;
    // the selector it sits in, on its own: the list's other selectors don't count either way
    const lead = css.slice(start, at).split(",").pop()!;
    let rest = css.slice(end + 1, brace);
    // code, a line comment or a string is not a selector: a quote is only ever inside an attribute's [ ]
    const bare = (x: string) => x.replace(/\[[^\]]*\]/g, "");
    if (/[;{}`/"']/.test(bare(lead)) || /[;}`/"']/.test(bare(rest.split(",")[0]))) continue;
    // the rest of this selector, up to the next top-level comma of its list
    let d = 0;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "(") d++;
      else if (rest[i] === ")") d--;
      else if (rest[i] === "," && d <= 0) {
        rest = rest.slice(0, i);
        break;
      }
    }
    // closing parens of an enclosing :not( / :is( and more pseudo-classes on the same element are fine; a combinator
    // followed by another element is not
    if (/^[^\s>+~]*\s*[>+~\s]\s*[^\s>+~)]/.test(rest.replace(/\s+$/, ""))) out.push(`${lead}${css.slice(at, end + 1)}${rest}`.replace(/\s+/g, " ").trim());
  }
  return out;
}

test("the check catches an ancestor :has() written by hand, and lets a :has() that styles its own element through", () => {
  assert.deepEqual(ancestorHas("[data-orch] .orch-cc .k-plist:has(> .k-prow[data-fold]) > .k-prow { grid-template-columns: 1fr; }"), ["[data-orch] .orch-cc .k-plist:has(> .k-prow[data-fold]) > .k-prow"]);
  assert.equal(ancestorHas(".a:hover:not(:has(button:hover)) .grip { color: red; }").length, 1, "inside :not() too");
  assert.equal(ancestorHas(".a:has(.b) ~ .c { color: red; }").length, 1, "a sibling too");
  assert.deepEqual(ancestorHas(".footer :has(> .composer) { max-width: 760px; }"), [], "styles the element it is on");
  assert.deepEqual(ancestorHas(".a:has(.b):hover, .c > .d { color: red; }"), [], "a later selector in the list is not part of it");
  assert.deepEqual(ancestorHas(".k-plist[data-folds] > .k-prow { color: red; }"), [], "an explicit attribute is fine");
  assert.equal(ancestorHas(".a,\n.b:has(> .c) .d,\n.e {\n  color: red;\n}").length, 1, "a selector list split over lines");
  // review of public PR #22's landing: both came back clean from the line-by-line reading
  assert.equal(ancestorHas(".a:has(.b) .c\n{ color: red; }").length, 1, "the rule's { on the next line");
  assert.deepEqual(ancestorHas(".a {} .b:has(.c) .d {}"), [".b:has(.c) .d"], "another rule before it on the same line");
  assert.deepEqual(ancestorHas("// bb's own :has() rules, which restyle the page;\nconst x = () => { return 1; };"), [], "prose and code are not selectors");
  // the review of 4f3de83: a comment inside the selector, or after the list's comma, hid the rule
  assert.deepEqual(ancestorHas(".a:has(.b) /* scope */ .c {}"), [".a:has(.b) .c"], "a comment between the :has() and what it styles");
  assert.deepEqual(ancestorHas(".a:has(.b) .c, /* unrelated */ .d {}"), [".a:has(.b) .c"], "a comment later in the selector list");
  assert.deepEqual(ancestorHas(".x, .a:has(.b) .c {}"), [".a:has(.b) .c"], "the list's earlier selector doesn't hide it");
  assert.deepEqual(ancestorHas(".a:has(.b), /* fine */ .c .d {}"), [], "a :has() on its own element, then an ordinary selector");
  assert.deepEqual(ancestorHas('cn("p-2 [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]", className)} {...props}'), [], "a Tailwind class string is not a rule");
  assert.deepEqual(ancestorHas('[data-a="x"]:has(.b) [data-c="y"] {}'), ['[data-a="x"]:has(.b) [data-c="y"]'], "quotes inside an attribute's [ ] are still a selector");
});

// One was in the plugin before this check read handwritten CSS. It is named, with why it stays for now; a new one fails.
// The pane header's grip lights on hover only. (accent.ts colours bb's own sidebar group labels with one too, but it
// builds the selector from parts in code, which a reading of the source can't see: a selector put together in code is
// beyond this check, so review one by hand.)
const KNOWN_ANCESTOR_HAS = [{ file: "../app/panes.tsx", has: "[data-orch] [data-pane-header]:hover:not(:has(button:hover)) [data-pane-grip]" }];

test("no handwritten CSS in the plugin has a :has() anchored above what it styles", () => {
  const files = (dir: string): string[] => readdirSync(new URL(dir, import.meta.url)).flatMap((n) => (statSync(new URL(dir + n, import.meta.url)).isDirectory() ? files(`${dir}${n}/`) : /\.(tsx?|css)$/.test(n) ? [`${dir}${n}`] : []));
  const offenders: string[] = [];
  for (const f of [...files("../app/"), "../app.tsx"]) {
    const found = ancestorHas(readFileSync(new URL(f, import.meta.url), "utf8"));
    for (const sel of found) if (!KNOWN_ANCESTOR_HAS.some((k) => k.file === f && sel.includes(k.has))) offenders.push(`${f}: ${sel}`);
  }
  assert.deepEqual(offenders, [], "an ancestor :has() makes every element added or removed on bb's page restyle; give the element an explicit class or attribute");
  assert.match(projects, /\.k-plist\[data-folds\] > \.k-prow \{/, "the chevron's column follows the list's own attribute (public PR #22)");
  assert.match(projects, /data-folds=\{folds\(main\)\}/);
});
