// The one reply box (2026-11-20). The owner called the box to a lead broken. What was wrong: a
// divider ran between the text area and the buttons, attach and Reply sat apart, and "not an approval" was said twice
// (the subtitle and the footer). Their model is X's inline reply: the avatar, a borderless field that grows, and one
// thin row (icon tools left, a pill right) with at most one tiny hint. app/reply-composer.tsx draws every reply box, so
// the rules are checked on its rendered markup, and the old box's markup is the fixture each check must reject. Then the
// sources: every box the owner writes in goes through it, and no box can grow a second copy of the notice.
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
/** The visible words; elements are word breaks ("approval" in one tag and "A reply" in the next stay two words) */
const text = (e: El): string => e.kids.map((k) => (typeof k === "string" ? k : ` ${text(k)} `)).join("");
const classes = (e: El) => (e.attrs.class ?? "").split(/\s+/).filter(Boolean);
const by = (root: El, attr: string, value?: string) => els(root).filter((e) => attr in e.attrs && (value === undefined || e.attrs[attr] === value));
const up = (e: El, attr: string): El | null => (e.parent ? (attr in e.parent.attrs ? e.parent : up(e.parent, attr)) : null);

// --- the three rules, as checks on a rendered box ---
/** Anything that draws a line across the box: a separator, an hr, or a top/bottom/y border or divide on any element */
const dividers = (box: El) => els(box).filter((e) => e.tag === "hr" || e.attrs.role === "separator" || e.attrs["data-slot"] === "separator" || classes(e).some((c) => /^(?:[\w-]+:)*(?:border-[tby](?:-\d+)?|divide-[xy](?:-\d+)?)$/.test(c)));
/** The one row both live in, or null when they sit in different rows */
const sharedRow = (box: El, a: string, b: string) => {
  const ra = up(by(box, "data-t", a)[0]!, "data-composer-row");
  const rb = up(by(box, "data-t", b)[0]!, "data-composer-row");
  return ra && ra === rb ? ra : null;
};
/** How often the box's visible words say it is not an approval (attributes, the hover title included, aren't counted) */
const notices = (s: string) => s.match(/\b(?:not|isn't) an approval\b/gi)?.length ?? 0;

// The box the owner complained about (feed.tsx before 2026-11-20), cut down to what the rules see.
const OLD = parse(
  `<div class="rounded-xl border p-3 shadow-xs" data-reply-box="post:1"><div><span>To </span><span>Lead · orchestrator</span><p data-reply-hint="">Direct message · the CoS gets a copy · not an approval</p></div>` +
    `<textarea class="mt-2 border-0 px-0"></textarea><div class="mt-2 flex items-center gap-2 border-t pt-2" data-composer-row=""><button data-t="attach"></button></div>` +
    `<div data-composer-row=""><button data-t="send">Reply</button></div><p>A reply isn't an approval or an answer to a card. For 48 h it wins over a CoS instruction on its point.</p></div>`,
);

const box = (hint = true) =>
  parse(
    renderToStaticMarkup(
      h(rc.ReplyComposer!, {
        "data-reply-box": "post:1",
        field: h(rc.ReplyField!, { "aria-label": "Reply to Lead · checkout-flow", placeholder: "Reply to Lead · checkout-flow…", value: "", onChange: () => {} }),
        tools: h("button", { "data-t": "attach", type: "button" }),
        hint: hint ? h(rc.ReplyHint!, { detail: "Goes straight to the lead; the CoS gets a copy. For 48 h it wins over a CoS instruction on its point." }, "Not an approval") : null,
        actions: h(rc.ReplyButton!, { "data-t": "send", disabled: true }, "Reply"),
      }),
    ),
  );

test("the old box fails every rule (so the checks below can fail)", () => {
  assert.ok(dividers(OLD).length > 0, "the border-t over the buttons is a divider");
  assert.equal(sharedRow(OLD, "attach", "send"), null, "attach and Reply in different rows");
  assert.equal(notices(text(OLD)), 2, "said as the subtitle and again as the footer");
});

test("no divider inside a reply box, and the field has no box of its own, dark included", () => {
  const b = box();
  assert.deepEqual(dividers(b).map((e) => e.attrs.class), []);
  const field = els(b).find((e) => e.tag === "textarea")!;
  const c = classes(field);
  for (const want of ["border-0", "bg-transparent", "[&:is(.dark_*)]:bg-transparent", "shadow-none", "focus-visible:ring-0", "field-sizing-content", "resize-none"]) assert.ok(c.includes(want), want);
  // what made the old one look boxed: the base's border, its dark fill and its shadow must lose to the overrides
  for (const gone of ["border", "[&:is(.dark_*)]:bg-input/30", "shadow-xs", "rounded-md", "px-3"]) assert.ok(!c.includes(gone), gone);
  // the ring went; a keyboard user still sees where focus is: a bar down the field's left edge, beside the text, never under it
  assert.ok(c.includes("focus-visible:shadow-[inset_2px_0_0_var(--ring)]"), "a visible focus cue");
  assert.ok(!c.some((x) => /^focus-visible:shadow-\[inset_0_/.test(x)), "the cue is no line between the field and the row");
});

test("attach and the main action sit on one row, under the field, with the owner's avatar beside them", () => {
  const b = box();
  const row = sharedRow(b, "attach", "send");
  assert.ok(row, "one row holds both");
  const field = els(b).find((e) => e.tag === "textarea")!;
  assert.equal(up(field, "data-composer-row"), null, "the field is above the row, not in it");
  assert.equal(by(b, "data-composer-row").length, 1, "one row, not a row per button");
  const send = by(b, "data-t", "send")[0]!;
  for (const c of ["rounded-full", "disabled:opacity-50"]) assert.ok(classes(send).includes(c), c);
  assert.ok(!classes(send).some((c) => /^bg-(muted|secondary)/.test(c)), "dimmed primary, not a grey fill");
  const face = els(b).find((e) => (e.attrs["data-slot"] ?? "").startsWith("avatar"));
  assert.ok(face, "the owner's avatar");
  assert.ok(els(b).indexOf(face!) < els(b).indexOf(field), "on the left, before the field");
});

test("the notice is said once: the hint, with the 48 h rule as its detail (a title on hover, a popover on a tap)", () => {
  const b = box();
  assert.equal(notices(text(b)), 1);
  const hint = els(b).find((e) => e.attrs["aria-haspopup"] === "dialog")!;
  assert.ok(hint, "the hint is a button a phone can tap");
  assert.match(hint.attrs.title ?? "", /48\sh/);
  assert.equal(notices(text(box(false))), 0, "no hint, no notice: the box adds none of its own");
  // a phone's row is too narrow for tools, hint and buttons: the hint takes its own line under them (the container
  // query), so the buttons never split across lines around it; with room it sits between them
  const slot = up(hint, "data-composer-hint-slot")!;
  assert.ok(slot && up(slot, "data-composer-row"), "the hint is in the row");
  for (const c of ["order-last", "basis-full", "@sm/reply:order-none", "@sm/reply:basis-0", "@sm/reply:flex-1"]) assert.ok(classes(slot).includes(c), c);
  assert.ok(els(b).some((e) => classes(e).includes("@container/reply")), "the row measures its own column, not the window");
});

// --- the sources: every reply box goes through the one composer ---
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
const code = (s: string) =>
  s
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join("\n");

test("every reply box is the one composer: no other file draws a text area of its own", () => {
  const users = appFiles().filter((f) => /from "\.\/ui\/textarea\.tsx"|<textarea\b/.test(code(src(f))));
  assert.deepEqual(users, ["app/reply-composer.tsx"]);
  const boxes: Record<string, number> = { "app/feed.tsx": 1, "app/direct-line.tsx": 1, "app/answer-ui.tsx": 1, "app/deliverables.tsx": 2 };
  for (const [f, n] of Object.entries(boxes)) assert.equal(code(src(f)).match(/<ReplyComposer\b/g)?.length ?? 0, n, f);
});

test("the feed's reply and the box to a lead say 'not an approval' once, and name who it goes to", () => {
  const feed = code(src("app/feed.tsx"));
  const reply = feed.slice(feed.indexOf("const LEAD_REPLY_RULES"), feed.indexOf("function ItemPane"));
  assert.ok(reply.includes("function ReplyBox"), "the slice holds the reply box");
  assert.equal(notices(reply), 1, "the hint only; its detail doesn't repeat it");
  assert.match(reply, /placeholder=\{replyTo\(line, cosTitle\)\}/);
  assert.match(feed, /data-reply-open=\{p\.key\}[^\n]*\n\s*<AgentFace [^\n]*\/>\s*\{replyTo\(p\.line, cosTitle\)\}/, "the closed pill says the same");
  assert.match(feed, /return `Reply to \$\{to\.name\}\$\{to\.sub \? ` · \$\{to\.sub\}` : ""\}…`;/, "the recipient by name and project");
  assert.doesNotMatch(reply, /border-t|<Separator/);
  const line = code(src("app/direct-line.tsx"));
  const composer = line.slice(line.indexOf("export function Composer"));
  assert.equal(notices(composer), 1, "the hint only: not the placeholder, the title or the rules");
  assert.match(composer, /placeholder=\{`Message Lead · \$\{project\.slug\}…`\}/);
  assert.doesNotMatch(composer, /title=\{rules\}/, "the field's hover title no longer repeats the rules");
  assert.doesNotMatch(line, /\.k-composer[^{]*\{[^}]*border-(top|bottom)/, "no line inside the composer's own CSS");
});

// The lead's answer (2026-11-20): idle, the box to a lead in a project's head is one line, like X's collapsed reply,
// which saves a row so the whole box shows at 1440x900; focused or with words in it, it opens to two rows. The field
// must be the same element in both, so a click in it keeps its focus while the box opens.
test("idle, the box is one line: the field, then the tools and the pill beside it, no hint; focused, two rows", () => {
  const render = (inline: boolean) =>
    parse(
      renderToStaticMarkup(
        h(rc.ReplyComposer!, {
          inline,
          field: h(rc.ReplyField!, { value: "", onChange: () => {} }),
          tools: h("button", { "data-t": "attach", type: "button" }),
          hint: h(rc.ReplyHint!, { detail: "x" }, "Not an approval"),
          actions: h(rc.ReplyButton!, { "data-t": "send" }, "Send"),
        }),
      ),
    );
  const one = render(true);
  const field = els(one).find((e) => e.tag === "textarea")!;
  const row = by(one, "data-composer-row")[0]!;
  assert.equal(field.parent, row.parent, "the field and the row share one line");
  assert.ok(classes(field.parent!).includes("flex") && classes(field.parent!).includes("items-center"), "side by side");
  assert.ok(!classes(row).includes("mt-1"), "no row under the field");
  assert.equal(notices(text(one)), 0, "no hint while idle");
  assert.ok("data-inline" in by(one, "data-reply-composer")[0]!.attrs);
  const two = render(false);
  const field2 = els(two).find((e) => e.tag === "textarea")!;
  assert.ok(!classes(field2.parent!).includes("items-center"), "two rows: the field above, the row under it");
  assert.ok(classes(by(two, "data-composer-row")[0]!).includes("mt-1"));
  assert.equal(notices(text(two)), 1);
  // same tree in both: the textarea is the column's first child either way, so React keeps it (and its focus)
  assert.equal(field.parent!.kids.indexOf(field), 0);
  assert.equal(field2.parent!.kids.indexOf(field2), 0);
});

test("the compact box to a lead is idle on one line until focus comes into it or it holds anything", () => {
  const line = code(src("app/direct-line.tsx"));
  assert.match(line, /const idle = compact && !within && !text && !images\.length && !why && !states\?\.dead\.length;/);
  assert.match(line, /inline=\{idle\}/);
  assert.match(line, /onBlur=\{\(e\) => \{\s*if \(!e\.currentTarget\.contains\(e\.relatedTarget as Node \| null\)\) setWithin\(false\);/, "focus moving to Send or attach keeps it open");
});
