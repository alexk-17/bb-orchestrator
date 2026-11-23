// Every text box the owner writes a message in is one compact bar. 2026-11-21, the owner: "we need to fix the text bars
// for like the 'other' option or request changes back to the same one that's there for the talk directly to lead". The
// box to a lead (direct-line.tsx Composer, in Projects and Scope) is the model: one bordered line that grows as you type,
// the buttons inline beside it at its last line, and under them, across the bar, the thumbnails and one quiet line.
// reply-composer.tsx CompactBar draws it, and the box to a lead, a card's "Other", the feed's reply and a deliverable's
// "Request changes" all use it; nothing else lays the bar out.
// What the owner called broken before must not come back: the X-style composer (an avatar beside a borderless field, its
// buttons on a row under it; 2026-11-20 to 2026-11-21, "the new input bar is terrible"), a divider between the field and
// its buttons, a disabled primary drawn as a grey block, a notice said twice, and a box that lags as you type (a
// controlled textarea, or an element mounted per keystroke: test/typing-lag.test.ts says why).
// The bar is rendered in node and checked on its markup; the boxes import bb's SDK, so their wiring is checked on their
// sources. The old boxes' markup is the fixture each rule must reject, so every check here can fail.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { createElement as h, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanTsx, importTsx } from "./tsx-render.ts";

after(cleanTsx);

type Any = ComponentType<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const rc = await importTsx<Record<string, Any>>("app/reply-composer.tsx");
const ui = await importTsx<Record<string, Any>>("app/ui.tsx");
const ROOT = new URL("..", import.meta.url).pathname;
const src = (f: string) => readFileSync(join(ROOT, f), "utf8");

// --- a small tree for React's static markup (well formed: every element closes, or is void, or ends in "/>") ---
type El = { tag: string; attrs: Record<string, string>; kids: (El | string)[]; parent: El | null };
const VOID = new Set(["img", "input", "br", "hr", "meta", "link", "source", "wbr"]);
const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };
const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#x27);/g, (e) => ENT[e]!);
function parse(html: string): El {
  const root: El = { tag: "#root", attrs: {}, kids: [], parent: null };
  let cur = root;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
    if (m[5] !== undefined) {
      cur.kids.push(decode(m[5]));
      continue;
    }
    const [, close, tag, attrs = "", self] = m;
    if (close) {
      cur = cur.parent ?? root;
      continue;
    }
    const el: El = { tag: tag!, attrs: Object.fromEntries([...attrs.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)].map((a) => [a[1]!, decode(a[2] ?? "")])), kids: [], parent: cur };
    cur.kids.push(el);
    if (!self && !VOID.has(tag!)) cur = el;
  }
  return root;
}
const els = (e: El): El[] => e.kids.flatMap((k) => (typeof k === "string" ? [] : [k, ...els(k)]));
const kids = (e: El) => e.kids.filter((k): k is El => typeof k !== "string");
/** The visible words; elements are word breaks ("approval" in one tag and "A reply" in the next stay two words) */
const text = (e: El): string => e.kids.map((k) => (typeof k === "string" ? k : ` ${text(k)} `)).join("");
const classes = (e: El) => (e.attrs.class ?? "").split(/\s+/).filter(Boolean);
const by = (root: El, attr: string, value?: string) => els(root).filter((e) => attr in e.attrs && (value === undefined || e.attrs[attr] === value));
const up = (e: El, attr: string): El | null => (e.parent ? (attr in e.parent.attrs ? e.parent : up(e.parent, attr)) : null);

// --- the rules, as checks on a rendered box ---
/** Anything that draws a line across the box: a separator, an hr, or a top/bottom/y border or divide on any element */
const dividers = (box: El) => els(box).filter((e) => e.tag === "hr" || e.attrs.role === "separator" || e.attrs["data-slot"] === "separator" || classes(e).some((c) => /^(?:[\w-]+:)*(?:border-[tby](?:-\d+)?|divide-[xy](?:-\d+)?)$/.test(c)));
/** The bar's row holding both the field and the main action, or null when the action sits on a row of its own */
const fieldRow = (box: El) => {
  const field = els(box).find((e) => e.tag === "textarea");
  const send = by(box, "data-t", "send")[0];
  const a = field && up(field, "data-bar-row");
  return a && send && a === up(send, "data-bar-row") ? a : null;
};
/** A face drawn in the box: an avatar slot or an image */
const faces = (box: El) => els(box).filter((e) => (e.attrs["data-slot"] ?? "").startsWith("avatar") || e.tag === "img");
/** How often the box's visible words say it is not an approval (attributes, the hover title included, aren't counted) */
const notices = (s: string) => s.match(/\b(?:not|isn't) an approval\b/gi)?.length ?? 0;

// --- the sources: every message box draws the one bar ---
/** The UI sources (app/, not app/ui) */
function appFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) e !== "ui" && walk(p);
      else if (/\.tsx?$/.test(e)) out.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, "app"));
  walk(join(ROOT, "voice"));
  return out.sort();
}
function code(s: string) {
  return s
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join("\n");
}
/** One function's source, to its closing brace */
const fnOf = (f: string, name: string) => {
  const s = code(src(f));
  const at = s.indexOf(`function ${name}(`);
  return at < 0 ? "" : s.slice(at, s.indexOf("\n}\n", at));
};
/** A JSX prop's expression (`name={…}`), by its braces */
function prop(s: string, name: string): string {
  const at = s.indexOf(` ${name}={`);
  if (at < 0) return "";
  const open = at + name.length + 2;
  for (let i = open, depth = 0; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return s.slice(open + 1, i);
  }
  return "";
}
/** What a box puts under its bar: the children of its <CompactBar> */
const under = (s: string) => {
  const end = s.indexOf(prop(s, "actions")) + prop(s, "actions").length;
  const close = s.indexOf("</CompactBar>", end);
  return close < 0 ? "" : s.slice(end, close);
};
/** A deliverable's change box: Review's `asking` branch */
const changes = () => {
  const r = fnOf("app/deliverables.tsx", "Review");
  return r.slice(r.indexOf("{asking ? ("), r.indexOf(") : (", r.indexOf("{asking ? (")));
};
const BOXES = [
  { name: "the box to a lead", file: "app/direct-line.tsx", s: () => fnOf("app/direct-line.tsx", "Composer"), field: "aria-label={`Message to lead:${project.slug}`}", send: "data-direct-send={project.slug}" },
  { name: "a card's Other", file: "app/answer-ui.tsx", s: () => fnOf("app/answer-ui.tsx", "OtherBox"), field: 'data-note=""', send: 'data-note-send=""' },
  { name: "the feed's reply", file: "app/feed.tsx", s: () => fnOf("app/feed.tsx", "ReplyBox"), field: 'data-reply-text=""', send: "data-reply-send={p.key}" },
  { name: "request changes", file: "app/deliverables.tsx", s: changes, field: "data-changes-text={d.id}", send: "data-changes-send={d.id}" },
];

// The boxes the owner complained about, cut down to what the rules see.
// The feed's reply before 2026-11-20: a divider over the buttons, attach and Reply apart, the notice said twice.
const BOXED_2020 = parse(
  `<div class="rounded-xl border p-3 shadow-xs" data-reply-box="post:1"><div><span>To </span><span>Lead · orchestrator</span><p data-reply-hint="">Direct message · the CoS gets a copy · not an approval</p></div>` +
    `<textarea class="mt-2 border-0 px-0"></textarea><div class="mt-2 flex items-center gap-2 border-t pt-2" data-bar-row=""><button data-t="attach"></button></div>` +
    `<div data-bar-row=""><button data-t="send">Reply</button></div><p>A reply isn't an approval or an answer to a card. For 48 h it wins over a CoS instruction on its point.</p></div>`,
);
// The X-style composer (ReplyComposer, 2026-11-20 to 2026-11-21): the owner's avatar, a borderless field, and the
// buttons on a row under the field.
const XSTYLE = parse(
  `<div data-reply-composer="" class="flex gap-3 items-start"><div class="shrink-0 pt-0.5"><span data-slot="avatar"><span data-slot="avatar-fallback">Y</span></span></div>` +
    `<div class="@container/reply min-w-0 flex-1"><textarea class="min-h-9 rounded-none border-0 bg-transparent px-0"></textarea>` +
    `<div data-bar-row="" class="mt-1 flex flex-wrap items-center gap-x-2"><div><button data-t="attach"></button></div><div class="ml-auto"><button data-t="send" class="rounded-full">Reply</button></div></div></div></div>`,
);
// A deliverable's Request changes in 1.40.13: a "What to change" label, a three-line box, and Cancel / Send back on a row under it.
const CHANGES_1_40 = parse(
  `<div class="mt-3 grid gap-2"><div class="grid min-w-0 gap-1.5"><label>What to change</label><textarea class="min-h-20 border rounded-md"></textarea></div>` +
    `<div data-bar-row="" class="flex flex-wrap justify-end gap-2"><button data-t="cancel">Cancel</button><button data-t="send">Send back</button></div></div>`,
);

/** The bar as a box draws it: the field, attach and the main action beside it, the thumbnails and a quiet line under them */
const bar = (props: Record<string, unknown> = {}) =>
  parse(
    renderToStaticMarkup(
      h(
        rc.CompactBar!,
        {
          "data-composer": "checkout-flow",
          className: "k-composer px-4 py-3",
          field: h(rc.ReplyField!, { "aria-label": "Message to lead:checkout-flow", placeholder: "Message the lead…", value: "", onChange: () => {} }),
          actions: [h("button", { key: "a", "data-t": "attach", type: "button" }), h(ui.Btn!, { key: "s", tone: "primary", "data-t": "send", disabled: true }, "Send")],
          ...props,
        },
        h("ul", { "data-t": "thumbs" }),
        h("div", { "data-t": "meta", hidden: true }, h(rc.ReplyHint!, { detail: "For 48 h it wins over a CoS instruction on its point." }, "Not an approval")),
      ),
    ),
  );

test("the compact bar: the field and its actions on one row, the main action beside the field; what goes with it under the row", () => {
  // the old boxes fail the checks the bar must pass (so they can fail)
  assert.ok(dividers(BOXED_2020).length > 0, "the border-t over the buttons is a divider");
  assert.equal(fieldRow(BOXED_2020), null, "Reply on a row of its own");
  assert.equal(notices(text(BOXED_2020)), 2, "said as the subtitle and again as the footer");
  assert.ok(faces(XSTYLE).length > 0, "the X-style composer draws the owner's avatar");
  assert.equal(fieldRow(XSTYLE), null, "its buttons sit on a row under the field");
  assert.equal(fieldRow(CHANGES_1_40), null, "Cancel and Send back sat on a row under the change box");
  assert.equal(typeof rc.CompactBar, "function", "reply-composer.tsx draws the one shared bar");
  const b = bar();
  const root = kids(b)[0]!;
  assert.ok("data-compact-bar" in root.attrs);
  const [row, ...under] = kids(root);
  // the field | its actions, the actions at the field's last line as it grows (the box to a lead's 1.16.0 grid)
  assert.ok(row && "data-bar-row" in row.attrs, "the row comes first");
  for (const c of ["grid", "grid-cols-[minmax(0,1fr)_auto]", "items-end", "gap-2"]) assert.ok(classes(row).includes(c), c);
  const [fieldCell, actionsCell] = kids(row);
  assert.equal(kids(row).length, 2, "two cells: the field, its actions");
  assert.ok(classes(fieldCell!).includes("min-w-0"), "the field's cell never widens the bar past a phone's width");
  assert.equal(kids(fieldCell!)[0]?.tag, "textarea");
  for (const c of ["flex", "items-center", "gap-1"]) assert.ok(classes(actionsCell!).includes(c), c);
  assert.deepEqual(kids(actionsCell!).map((e) => e.attrs["data-t"]), ["attach", "send"], "attach, then the main action last");
  assert.ok(fieldRow(b), "the main action sits on the field's row");
  // under it, each across the bar's width, 8 px apart (a column): never in the row, never beside the buttons
  assert.deepEqual(under.map((e) => e.attrs["data-t"]), ["thumbs", "meta"]);
  for (const c of ["flex", "flex-col", "gap-2", "min-w-0"]) assert.ok(classes(root).includes(c), c);
  // the box's own class, padding and hooks reach the bar (the sticky rule in projects.tsx finds .k-composer)
  for (const c of ["k-composer", "px-4", "py-3"]) assert.ok(classes(root).includes(c), c);
  assert.equal(root.attrs["data-composer"], "checkout-flow");
  // no avatar, no divider, and a disabled main action is the primary dimmed, never a grey block
  assert.deepEqual(faces(b), [], "no avatar");
  assert.deepEqual(dividers(b).map((e) => e.attrs.class), []);
  const send = by(b, "data-t", "send")[0]!;
  assert.equal(send.attrs["data-variant"], "default", "the primary");
  for (const c of ["bg-primary", "disabled:opacity-50", "h-9"]) assert.ok(classes(send).includes(c), c);
  assert.ok(!classes(send).some((c) => /^(?:disabled:)?bg-(?:muted|secondary)/.test(c)), "dimmed primary, not a grey fill");
  assert.equal(notices(text(b)), 1, "the bar adds no notice of its own");
});

test("nothing is mounted per keystroke: the bar draws the same elements empty or full, and no box mounts anything on the words", () => {
  assert.equal(typeof rc.CompactBar, "function", "the one bar");
  const shape = (e: El): string => `${e.tag}[${kids(e).map(shape).join(",")}]`;
  const empty = bar();
  const full = bar({ field: h(rc.ReplyField!, { value: "ship it today", onChange: () => {} }) });
  assert.equal(shape(full), shape(empty), "a keystroke adds or removes no element");
  // a child that has nothing to say yet keeps its place in the page, hidden: a hidden child takes no row and no gap
  assert.ok("hidden" in by(empty, "data-t", "meta")[0]!.attrs);
  const fn = code(src("app/reply-composer.tsx"));
  const compactBar = fn.slice(fn.indexOf("export function CompactBar"));
  assert.ok(compactBar.length > 100);
  assert.doesNotMatch(compactBar, /\?|&&/, "the bar mounts nothing on a condition");
  for (const b of BOXES) {
    const s = b.s();
    // an element mounted on the typed words (`{text ? <…`, `{value && <…`) adds a node to bb's page on a keystroke
    assert.doesNotMatch(s, /\{\s*!?\(?\s*(?:text|value|next|action|draft)\b[^{}\n]*(?:\?|&&)\s*\(?\s*</, `${b.name}: nothing mounts on the words`);
  }
});

test("every field is a boxed ReplyField, never a controlled textarea, and there is no other look", () => {
  const field = els(parse(renderToStaticMarkup(h(rc.ReplyField!, { value: "ship it", onChange: () => {} })))).find((e) => e.tag === "textarea")!;
  const c = classes(field);
  // shadcn's Textarea as it is (border, rounding, padding, shadow, its dark fill and focus ring), one 36 px line when
  // empty (1 + 6 + 22 + 6 + 1), growing to about eight lines; 16 px on a phone (no zoom on focus), 15 px from md
  for (const want of ["border", "border-input", "rounded-md", "px-3", "shadow-xs", "[&:is(.dark_*)]:bg-input/30", "focus-visible:ring-[3px]", "field-sizing-content", "resize-none", "min-h-9", "max-h-44", "min-w-0", "py-1.5", "leading-[22px]", "text-base", "md:text-[15px]"]) assert.ok(c.includes(want), want);
  // the X-style field's look is gone: no borderless, unfilled, ringless field
  for (const gone of ["border-0", "rounded-none", "shadow-none", "focus-visible:ring-0", "[&:is(.dark_*)]:bg-transparent", "px-0", "min-h-16", "md:text-sm", "py-2"]) assert.ok(!c.includes(gone), gone);
  assert.equal(rc.REPLY_FIELD, undefined, "no borderless look left to pick");
  assert.deepEqual(field.kids, [], "the text is not React's to rewrite on every key");
  assert.ok(!("value" in field.attrs) && !("look" in field.attrs));
  // every text area in the app is ReplyField, and each one is in a box this file knows
  const users = appFiles().filter((f) => /from "\.\/ui\/textarea\.tsx"|<textarea\b/.test(code(src(f))));
  assert.deepEqual(users, ["app/reply-composer.tsx"]);
  const fields = Object.fromEntries(appFiles().map((f) => [f, code(src(f)).match(/<ReplyField\b/g)?.length ?? 0]).filter(([, n]) => n));
  assert.deepEqual(fields, { "app/answer-ui.tsx": 1, "app/deliverables.tsx": 2, "app/direct-line.tsx": 1, "app/feed.tsx": 1 }, "Other, request changes and the next move, the box to a lead, the feed's reply");
});

test("one shared CompactBar: the box to a lead, Other, the feed's reply and request changes draw it, and nothing else lays the bar out", () => {
  for (const b of BOXES) {
    const s = b.s();
    assert.ok(s.length > 200, `${b.name}: the slice holds its code`);
    assert.equal(s.match(/<CompactBar\b/g)?.length ?? 0, 1, `${b.name}: the one bar`);
    assert.match(src(b.file), /import \{[^}]*\bCompactBar\b[^}]*\} from "\.\/reply-composer\.tsx";/, `${b.name}: from reply-composer.tsx`);
    const field = prop(s, "field");
    const actions = prop(s, "actions");
    assert.match(field, /^\s*<ReplyField\b/, `${b.name}: its field is a ReplyField`);
    assert.ok(field.includes(b.field), `${b.name}: the field keeps its hook (${b.field})`);
    // each bar's main action sits on the field's row: it is the bar's action, last, and the primary
    assert.match(actions, new RegExp(`<Btn tone="primary"[^>]*${b.send.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `${b.name}: the primary is beside the field`);
    assert.ok(actions.lastIndexOf("<Btn") === actions.indexOf('<Btn tone="primary"'), `${b.name}: the primary is the last action`);
    assert.ok(!under(s).includes(b.send) && !field.includes(b.send), `${b.name}: the primary is nowhere else`);
  }
  // the bar's grid is written once, in reply-composer.tsx: no box has a copy of its own (the lead's old .k-composer grid went)
  const grids = appFiles().filter((f) => /grid-cols-\[minmax\(0,1fr\)_auto\]|grid-template-columns: minmax\(0, 1fr\) auto/.test(code(src(f))));
  assert.deepEqual(grids, ["app/reply-composer.tsx"]);
  const users = Object.fromEntries(appFiles().map((f) => [f, code(src(f)).match(/<CompactBar\b/g)?.length ?? 0]).filter(([, n]) => n));
  assert.deepEqual(users, { "app/answer-ui.tsx": 1, "app/deliverables.tsx": 1, "app/direct-line.tsx": 1, "app/feed.tsx": 1 });
  // Other is drawn by OtherBox only: the two Needs you cards and a question card use it
  assert.equal(code(src("app/needs-you.tsx")).match(/<OtherBox\b/g)?.length, 2);
  assert.equal(code(src("app/question-card.tsx")).match(/<OtherBox\b/g)?.length, 1);
});

test("no file imports or draws ReplyComposer, and no message box draws an avatar", () => {
  assert.equal(rc.ReplyComposer, undefined, "reply-composer.tsx exports no X-style composer");
  assert.deepEqual(appFiles().filter((f) => /\bReplyComposer\b|data-reply-composer|@container\/reply/.test(code(src(f)))), [], "nothing draws it or its markup");
  assert.doesNotMatch(src("app/reply-composer.tsx"), /face\.tsx|AgentFace|Avatar/, "the bar has no face to draw");
  for (const b of BOXES) assert.doesNotMatch(b.s(), /<AgentFace\b|<Avatar\b|avatar/i, `${b.name}: no avatar`);
});

test("no divider between a field and its buttons, and the notice said once", () => {
  assert.equal(typeof rc.CompactBar, "function", "the one bar");
  assert.deepEqual(dividers(bar()).map((e) => e.attrs.class), [], "none in the bar");
  for (const b of BOXES) {
    const s = b.s();
    assert.doesNotMatch(s, /border-[tby]\b|divide-[xy]|<Separator|<hr\b/, `${b.name}: no divider`);
    assert.doesNotMatch(s, /<Textarea\b|<textarea\b/, `${b.name}: no text area of its own`);
    assert.ok(notices(s) <= 1, `${b.name}: never said twice`);
  }
  assert.doesNotMatch(code(src("app/direct-line.tsx")), /\.k-composer[^{]*\{[^}]*border-(top|bottom)/, "no line inside the composer's own CSS");
  // the one hint: a button a phone can tap, its rule's detail the hover title and the popover
  const hint = els(parse(renderToStaticMarkup(h(rc.ReplyHint!, { detail: "For 48 h it wins over a CoS instruction on its point." }, "Not an approval")))).find((e) => e.attrs["aria-haspopup"] === "dialog")!;
  assert.ok(hint, "the hint is a button a phone can tap");
  assert.match(hint.attrs.title ?? "", /48\sh/);
});

test("the box to a lead: same look and hooks, its bar CompactBar; the quiet line mounted always, hidden until typed in", () => {
  const all = code(src("app/direct-line.tsx"));
  const s = fnOf("app/direct-line.tsx", "Composer");
  assert.match(s, /<CompactBar\s+role="group"\s+aria-label=\{`Message the \$\{project\.slug\} lead`\}\s+data-composer=\{project\.slug\}\s+className=\{cn\("k-composer px-4 py-3", compact && "compact"\)\}\s+\{\.\.\.drop\}/, "its padding (12px 16px), hooks and drop zone");
  assert.doesNotMatch(all, /\.k-composer \{|\.k-composer__actions|\.k-composer__wide/, "its own grid went: CompactBar lays it out");
  assert.match(prop(s, "actions"), /<AttachButton [^\n]*data-direct-attach[^]*<Btn tone="primary"[^\n]*data-direct-send=/, "attach, then Send");
  assert.match(prop(s, "field"), /placeholder=\{compact \? "Message the lead…" : `Message Lead · \$\{project\.slug\}…`\}/);
  const rest = under(s);
  assert.ok(rest.indexOf("<ImageThumbs") >= 0 && rest.indexOf("<ImageThumbs") < rest.indexOf("k-composer__meta"), "the thumbnails, then the quiet line, under the bar");
  // compact (a project's head): the quiet line shows once typed in, or while a message needs a Resend; Scope's always
  assert.match(s, /const quiet = !compact \|\| !!text \|\| !!images\.length \|\| !!states\?\.dead\.length;/);
  assert.match(rest, /<div className="k-composer__meta" hidden=\{!quiet\}>/, "a direct child of the bar (test/e2e/chat-row.mjs reads it there)");
  assert.match(all, /\.k-composer__meta\[hidden\] \{ display: none; \}/, "its display: flex must not beat the hidden attribute");
  assert.match(s, /className=\{cn\("[^"]*", !following && "hidden"\)\}/, "the follow-up switch hides by a class; it is not unmounted");
  assert.match(s, /<span className="k-composer__hint" data-composer-hint="">/);
  assert.doesNotMatch(s, /\{\s*(?:following \|\| quiet|quiet|following) \?/, "nothing mounts or unmounts on the first keystroke");
  assert.equal(notices(s), 1, "the hint only: not the placeholder, the title or the rules");
  assert.doesNotMatch(s, /title=\{rules\}/, "the field's hover title doesn't repeat the rules");
});

test("a card's Other: the boxed field and Send beside it, ⌘/Ctrl+Enter sends; on a phone, Other still opens it, focused", () => {
  const s = fnOf("app/answer-ui.tsx", "OtherBox");
  const field = prop(s, "field");
  assert.match(field, /placeholder=\{placeholder\}/);
  assert.match(field, /e\.key === "Enter" && \(e\.metaKey \|\| e\.ctrlKey\)[^]*onSend\(\)/, "⌘/Ctrl+Enter sends");
  const actions = prop(s, "actions");
  assert.equal(actions.match(/<Btn\b/g)?.length, 1, "Send only");
  assert.match(actions, /<Btn tone="primary" data-note-send="" disabled=\{disabled \|\| value\.trim\(\) === ""\} onClick=\{onSend\}>\s*\{sendLabel\}/, "off while empty");
  assert.equal(under(s), "", "nothing under it");
  // the phone behaviour from 1.40.13 (test/phone-declutter.test.ts pins the rest): a button that shows this box, focused
  const card = fnOf("app/needs-you.tsx", "CardView");
  assert.match(card, /if \(otherOpen\) otherWrap\.current\?\.querySelector\("textarea"\)\?\.focus\(\);/);
  assert.match(card, /<div ref=\{otherWrap\} data-other="">\s*<OtherBox /);
});

test("the feed's reply: the boxed field, attach and Reply beside it; under it one muted line: the rev, the hint, Cancel", () => {
  const s = fnOf("app/feed.tsx", "ReplyBox");
  assert.match(s, /<CompactBar\s+data-reply-box=\{p\.key\}\s+data-line=\{line\}\s+\{\.\.\.drop\}/, "its hooks and drop zone");
  const field = prop(s, "field");
  for (const want of ["autoFocus={focus}", "placeholder={replyTo(line, cosTitle)}", 'data-reply-text=""', "onPaste=", "e.metaKey || e.ctrlKey"]) assert.ok(field.includes(want), want);
  assert.match(prop(s, "actions"), /^\s*<>\s*<AttachButton [^\n]*"data-reply-attach": ""[^]*<Btn tone="primary" data-reply-send=\{p\.key\}[^\n]*>\s*\{staging \? "Sending…" : "Reply"\}\s*<\/Btn>\s*<\/>\s*$/, "attach, then Reply, and nothing else");
  const rest = under(s);
  const line = rest.slice(rest.indexOf("data-reply-meta"));
  assert.match(rest, /<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-reply-meta="">/, "one muted line, always mounted");
  assert.ok(line.indexOf("about rev {p.deliverable.rev}") < line.indexOf("<ReplyHint data-reply-hint") && line.indexOf("<ReplyHint") < line.indexOf("Cancel"), "the rev, the hint, then Cancel");
  assert.match(line, /\{onDone \? \(\s*<Button type="button" variant="ghost" size="xs"[^>]*onClick=\{onDone\}>\s*Cancel/, "Cancel, a small ghost button, when the box can close");
  assert.ok(rest.indexOf("<ImageThumbs") < rest.indexOf("data-reply-meta"), "the thumbnails above the line");
  assert.equal(notices(s), 1, "the hint only; its detail doesn't repeat it");
  // the box and the closed pill (a button that opens it) say who it goes to the same way
  const feed = code(src("app/feed.tsx"));
  assert.match(feed, /data-reply-open=\{p\.key\}[^\n]*\n\s*<span className="truncate">\{replyTo\(p\.line, cosTitle\)\}<\/span>/, "the closed bar says the same");
  const pill = feed.slice(feed.lastIndexOf("<Button", feed.indexOf("data-reply-open={p.key}")), feed.indexOf("</Button>", feed.indexOf("data-reply-open={p.key}")));
  assert.doesNotMatch(pill, /AgentFace|rounded-full/, "closed, it looks like the bar's field: no avatar, no pill");
  assert.match(feed, /return `Reply to \$\{to\.name\}\$\{to\.sub \? ` · \$\{to\.sub\}` : ""\}…`;/, "the recipient by name and project");
});

test("a deliverable's Request changes: one bar, the field focused, a 32 px X to cancel and Send back beside it, on a phone too", () => {
  const s = changes();
  assert.doesNotMatch(s, /What to change<|<Label\b|min-h-20/, "no label over a three-line box");
  const field = prop(s, "field");
  for (const want of ["autoFocus", 'aria-label="What to change"', 'placeholder="What to change?"', "data-changes-text={d.id}", "onChange={(e) => setText(e.target.value)}"]) assert.ok(field.includes(want), want);
  assert.match(field, /e\.key === "Enter" && \(e\.metaKey \|\| e\.ctrlKey\)[^]*if \(!busy && text\.trim\(\)\) void sendBack\(\);/, "⌘/Ctrl+Enter sends it back");
  const actions = prop(s, "actions");
  // a 360 px phone's card leaves the field about 140 px only beside an icon Cancel and "Send back": no worded Cancel
  assert.equal(actions.match(/<Btn\b/g)?.length, 2, "Cancel and Send back only");
  assert.match(actions, /^\s*<>\s*<Btn tone="ghost" size="sm" className="text-muted-foreground" aria-label="Cancel" title="Cancel" disabled=\{busy\} onClick=\{\(\) => setAsking\(false\)\} icon=\{<X aria-hidden \/>\} \/>/, "Cancel first: a 32 px ghost X (Btn's icon-sm), no words");
  assert.match(actions, /<Btn tone="primary" data-changes-send=\{d\.id\} disabled=\{busy \|\| !text\.trim\(\)\} onClick=\{\(\) => void sendBack\(\)\}>\s*Send back\s*<\/Btn>/, "off while empty or busy");
  assert.equal(under(s), "", "nothing under it");
  // the phone's closed card opens the same change box: its own row is only for while it is not asking
  const r = fnOf("app/deliverables.tsx", "Review");
  assert.match(r, /if \(compact && !asking\)\s*return \(/);
  assert.equal(r.match(/<CompactBar\b/g)?.length, 1, "one change box for both");
});

// The next move keeps its 1.40.12 layout (the owner approved it): a boxed field, then Request changes and the approve
// button on one right-aligned row, and one muted line under them.
test("a deliverable's next move: unchanged, the field, then Request changes and the approve button on one right-aligned row", () => {
  const s = fnOf("app/deliverables.tsx", "Review");
  const next = s.slice(s.lastIndexOf("<ReplyField", s.indexOf("data-next-text={d.id}")), s.indexOf("data-next-text={d.id}"));
  // one line when empty, growing to about four
  assert.match(next, /className="max-h-28"/);
  // the field sizes to its placeholder: at 16 px in a 360 px phone's card about 30 characters fit on the one line
  const ph = next.match(/placeholder="([^"]*)"/)?.[1] ?? "";
  assert.ok(ph.length > 0 && ph.length <= 28, `"${ph}": a longer placeholder made the empty box two lines tall at 360 px`);
  assert.ok(!prop(changes(), "field").includes("data-next-text"), "not the change box's field");
  const rows = [...s.matchAll(/<div className="flex flex-wrap justify-end gap-2">([^]*?)<\/div>/g)].map((m) => m[1]!);
  assert.equal(rows.length, 1, "the next move's row");
  assert.match(rows[0]!, /<Btn data-changes=\{d\.id\}[^]*Request changes[^]*<Btn\s+tone="primary"\s+data-approve=\{d\.id\}\s+data-next-send=\{action \? d\.id : undefined\}[^]*\{action \? "Send to lead" : "Done, nothing more"\}/);
  // the hint, once: the button's title and one muted line under the row (a phone has no hover), always mounted
  assert.equal(s.match(/data-approve-hint/g)?.length ?? 0, 1, "one muted line");
  assert.match(s, /<p data-approve-hint="" className="m-0 text-right text-xs text-muted-foreground">/);
  assert.equal(s.match(/Closes it; the lead does nothing further/g)?.length ?? 0, 2, "the title and the one line, nowhere else");
  assert.equal(s.match(/Approves it; the lead does this and reports back/g)?.length ?? 0, 1);
});

test("an empty field is one line whatever its placeholder: a long one never makes the empty bar taller", () => {
  const rc = src("app/reply-composer.tsx");
  const boxed = rc.match(/export const BOXED_FIELD =\s*"([^"]*)"/)?.[1] ?? "";
  for (const c of ["placeholder-shown:h-9", "placeholder-shown:overflow-hidden", "placeholder-shown:whitespace-nowrap"])
    assert.ok(boxed.split(" ").includes(c), `${c}: "Reply to Lead · project…" beside a phone's buttons made the empty box three lines tall`);
});
