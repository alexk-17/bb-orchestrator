// An image in a card pops out full-size on one click (2026-11-20, the owner: no side panel step first). What matters: the
// picture is an anchor whose plain click opens the in-page viewer (not bb's file preview pane), a modifier or middle click
// keeps the browser's own behaviour on the full-size href, and every card that draws a proof image inline uses it: the
// deliverable card, a past deliverable's files, and the Home feed's screenshot (whose line under it still opens the post).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { createElement as h, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanTsx, importTsx } from "./tsx-render.ts";

after(cleanTsx);

type Any = ComponentType<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const mod = await importTsx<{ ImagePopout: Any; popsOut: (e: object) => boolean }>("app/image-popout.tsx");
const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("the card's picture is a zoom-in anchor to the full-size image that says it opens a dialog, with the dialog closed until clicked", () => {
  const s = renderToStaticMarkup(h(mod.ImagePopout, { src: "/proof/p1", caption: "Settings page", className: "frame" }, h("img", { src: "/proof/p1", alt: "Settings page" })));
  assert.match(s, /<a [^>]*href="\/proof\/p1"/);
  assert.match(s, /data-popout=""/);
  assert.match(s, /aria-haspopup="dialog"/);
  assert.match(s, /class="cursor-zoom-in \[-webkit-touch-callout:none\] frame"/, "no iOS image callout on a long-press: the menu shows instead");
  assert.match(s, /<img src="\/proof\/p1" alt="Settings page"\/>/);
  assert.doesNotMatch(s, /role="dialog"/, "nothing pops out until a click");
});

test("only a plain left click pops it out; cmd, ctrl, shift, alt and middle clicks keep the browser's own new tab", () => {
  const base = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
  assert.equal(mod.popsOut(base), true);
  for (const k of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) assert.equal(mod.popsOut({ ...base, [k]: true }), false, k);
  assert.equal(mod.popsOut({ ...base, button: 1 }), false, "middle click");
});

test("a plain click loads the viewer (PhotoSwipe, photo-viewer.ts) only then, and gives focus back to the picture when it closes", () => {
  const s = src("app/image-popout.tsx");
  assert.match(s, /await import\("\.\/photo-viewer\.ts"\)/, "loaded on the first click: the card and its tests never load PhotoSwipe");
  assert.match(s, /onClosed: \(\) => \{\s*done\(\);\s*trigger\.current\?\.focus\(\);/);
  assert.match(s, /e\.stopPropagation\(\);\s*void open\(\)/, "the click doesn't reach the card under it (a phone's post opens on a tap)");
  assert.doesNotMatch(s, /Open ↗|DialogPrimitive/, "no Radix dialog and no Open link any more");
});

// review of public PR #17: the viewer used to outlive its card. A card left while the picture loaded opened the viewer
// over the next screen, and an open one stayed on top of a screen that no longer had the card.
test("the viewer lives as long as its card: leaving the card cancels the load and takes an open viewer down", () => {
  const s = src("app/image-popout.tsx");
  assert.match(s, /useEffect\(\(\) => \(\) => viewer\.current\?\.abort\(\), \[\]\)/, "unmount aborts the card's viewer");
  assert.match(s, /await import\("\.\/photo-viewer\.ts"\);\s*if \(live\.signal\.aborted\) return;/, "a card gone while the code loaded opens nothing");
  assert.match(s, /signal: live\.signal/);
  assert.match(s, /if \(viewer\.current\) return;/, "a second click while one loads or shows opens no second viewer");
  const v = src("app/photo-viewer.ts");
  const open = v.slice(v.indexOf("export async function openViewer"));
  assert.ok(open.indexOf("if (o.signal.aborted) return false;", open.indexOf("await sizeOf(")) > 0, "checked again once the picture's size is known, before anything is added to the page");
  assert.ok(open.indexOf("return false") < open.indexOf("document.body.appendChild(host)"), "nothing reaches the page for a card already gone");
  assert.match(v, /const stop = \(\) => img\.removeAttribute\("src"\);\s*signal\.addEventListener\("abort", stop/, "the picture's fetch stops");
  assert.match(open, /const gone = \(\) => takeDown\(pswp, host\);\s*o\.signal\.addEventListener\("abort", gone/, "the card going takes it down (viewer-lifetime.ts)");
  assert.match(open, /pswp\.on\("destroy", \(\) => \{\s*o\.signal\.removeEventListener\("abort", gone\);/, "a viewer closed by hand drops its listener");
});

test("the viewer feels like Photos: pinch, double-tap and wheel zoom, drag down to close; a labelled dialog with the caption and the two opens", () => {
  const v = src("app/photo-viewer.ts");
  assert.match(v, /from "photoswipe"/);
  assert.doesNotMatch(v, /closeOnVerticalDrag:\s*false|pinchToClose:\s*false/, "drag down (and pinch in) to close stay on (PhotoSwipe's defaults)");
  assert.match(v, /wheelToZoom: true/);
  assert.match(v, /secondaryZoomLevel:/, "double-tap or click zooms in");
  assert.match(v, /setAttribute\("aria-label", o\.caption \|\| "Image"\)/, "the dialog is named by the caption");
  assert.match(v, /name: "popout-caption"/);
  assert.match(v, /title: "Open in side panel"[\s\S]{0,400}if \(o\.sidePanel\?\.\(\)\) pswp\.close\(\);\s*else window\.open\(o\.src/, "bb declining the pane falls back to a new tab");
  assert.match(v, /title: "Open in new tab"/);
  assert.match(v, /for \(const \[k, v\] of Object\.entries\(PORTAL\)\) host\.setAttribute/, "it sits in a host carrying the plugin's overlay attributes");
  const css = src("app/photo-viewer.css");
  // a touch screen keeps a visible, tappable Close (review of public PR #17): a drag down is a gesture not everyone
  // finds or can do. Only the zoom button goes to screen readers there, as a pinch zooms.
  const touch = css.slice(css.indexOf("@media (hover: none) and (pointer: coarse)"));
  assert.match(touch, /\.pswp__button--zoom \{[\s\S]*clip-path: inset\(50%\)/, "on touch the zoom button is for screen readers only");
  assert.doesNotMatch(touch, /button--close/, "on touch Close stays visible at PhotoSwipe's 50 x 60 px");
  assert.match(v, /tapAction: false/, "a tap doesn't hide the controls, and Close with them");
  assert.match(css, /safe-area-inset-bottom/);
  assert.equal(JSON.parse(src("package.json")).dependencies.photoswipe, "5.4.4", "pinned");
});

test("a right-click (long-press on touch) on the card's picture offers the side panel and a new tab", () => {
  const s = src("app/image-popout.tsx");
  assert.match(s, /ContextMenu as MenuPrimitive/, "Radix's ContextMenu from radix-ui, already a dependency");
  assert.match(s, /<ImageMenu src=\{src\} sidePanel=\{sidePanel\}>\s*<a/);
  assert.match(s, />\s*Open in side panel\s*</);
  assert.match(s, />\s*Open in new tab\s*</);
  assert.match(s, /if \(sidePanel\(\)\) onPicked\?\.\(\);\s*else window\.open\(src/, "bb declining the pane falls back to a new tab");
});

test("every card that draws a proof image inline pops it out instead of opening bb's pane first", () => {
  const d = src("app/deliverables.tsx");
  assert.match(d, /p\.kind === "image"\)[\s\S]{0,300}<ImagePopout src=\{proofSrc\(p\.id\)\} caption=\{p\.caption\} sidePanel=\{\(\) => openInBb\(navigate, p\)\}/, "deliverable card, its side panel through bb's pane");
  const f = src("app/files.tsx");
  assert.match(f, /export function FileFull[\s\S]{0,500}<ImagePopout[\s\S]{0,200}sidePanel=\{\(\) => openInBb\(navigate, openable\(f, host\)\)\}/, "a past deliverable's images");
  const feed = src("app/feed.tsx");
  const thumb = feed.slice(feed.indexOf("p.deliverable?.thumb && !phone ?"), feed.indexOf("p.card && p.card.options.length"));
  assert.match(thumb, /<ImagePopout src=\{proofSrc\(p\.deliverable\.thumb\)\}[^>]*sidePanel=\{p\.deliverable\.thumbFile \? \(\) => openInBb\(navigate, p\.deliverable!\.thumbFile!\)/, "the Home feed's screenshot, its side panel by the file's host and path");
  assert.match(thumb, /onClick=\{onOpen\} data-thumb-open=""[\s\S]*screenshot/, "the '1 of N screenshots' line still opens the post");
  assert.doesNotMatch(thumb.slice(0, thumb.indexOf("</ImagePopout>")), /onOpen/, "the picture itself doesn't open the post");
  // the phone's 56 px shot beside the title (1.40.13) pops out too: on a phone it is the only picture a post shows
  const phone = feed.slice(feed.indexOf('data-post-body=""'), feed.indexOf("p.deliverable?.thumb && !phone ?"));
  assert.match(phone, /<div className="k-thumb h-14 shrink-0" data-thumb=\{p\.deliverable\.thumb\}>\s*<ImagePopout src=\{proofSrc\(p\.deliverable\.thumb\)\}/, "the phone feed's shot");
  assert.doesNotMatch(phone.slice(phone.indexOf("k-thumb"), phone.indexOf("</ImagePopout>")), /onOpen/, "the shot itself doesn't open the post");
  // Delivered's closed card on a phone keeps its own rule (1.40.13): a tap anywhere on it, its shot included, opens the
  // whole card, whose pictures then pop out
  const c = d.slice(d.indexOf("function CompactCard("), d.indexOf("\n}\n", d.indexOf("function CompactCard(")));
  assert.match(c, /aria-label=\{`Open: \$\{shot\.caption\}`\} onClick=\{onOpen\} data-thumb=\{shot\.id\}/, "the closed card's shot opens the card");
  assert.doesNotMatch(c, /ImagePopout/);
});

// review of public PR #17's landing (P1): PhotoSwipe 5.4.4 ignores destroy() while it is still opening, then binds its
// document keydown and focusin listeners when the opening ends. A card left during the opening fade left the viewer
// alive and the arrow keys and Tab captured on the next screen. A stand-in PhotoSwipe that behaves the same way: destroy()
// does nothing until it is open, and the opening's end binds the listeners before anyone else hears of it.
test("the card going during the opening fade still destroys the viewer, and its listeners never outlive the opening", async () => {
  const { takeDown } = await import("../app/viewer-lifetime.ts");
  const fake = () => {
    const on: Record<string, (() => void)[]> = {};
    const v = {
      opener: { isOpen: false },
      isDestroying: false,
      listeners: 0,
      destroyed: false,
      on: (n: string, fn: () => void) => void (on[n] ??= []).push(fn),
      destroy() {
        if (!v.opener.isOpen && !v.isDestroying) return; // 5.4.4: close() returns early while opening
        v.isDestroying = true;
        v.listeners = 0; // events.removeAll()
        v.destroyed = true;
      },
      // the opening ends: PhotoSwipe's own handler (registered in init, so first) binds keydown and focusin
      openEnds() {
        v.opener.isOpen = true;
        v.listeners = 2;
        for (const fn of on.openingAnimationEnd ?? []) fn();
      },
    };
    return v;
  };
  const host = { style: { display: "" } } as unknown as HTMLElement;
  const opening = fake();
  takeDown(opening, host);
  assert.equal(host.style.display, "none", "out of sight at once");
  assert.equal(opening.destroyed, false, "destroy() while opening does nothing in 5.4.4");
  opening.openEnds();
  assert.equal(opening.destroyed, true, "destroyed as soon as the opening ends");
  assert.equal(opening.listeners, 0, "the keydown and focusin listeners bound at the opening's end are gone in the same dispatch");
  const open = fake();
  open.opener.isOpen = true;
  takeDown(open, { style: {} } as unknown as HTMLElement);
  assert.equal(open.destroyed, true, "open: destroyed at once");
  // the old way: destroy() once, and the host removed, left the opening one alive with its listeners
  const old = fake();
  old.destroy();
  old.openEnds();
  assert.equal(old.listeners, 2, "the stand-in reproduces the leak");
});
