// Drag to dock (split panes, release 3) in a real browser, against a seeded bb only (live-guard.ts): node test/e2e/dock.mjs <base URL> [out dir] [--live]
import { checkBase } from "./live-guard.ts";
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const live = argv.includes("--live");
const [given, out] = argv.filter((a) => a !== "--live");
const base = checkBase(given, live);
const PAGE = `${base}/plugins/orchestrator/home`;
// Playwright loads only after the base passed the guard
const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const VP = {
  desktop: { viewport: { width: 1440, height: 900 } },
  tablet: { viewport: { width: 1180, height: 820 }, hasTouch: true },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
};
const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`ok   ${name}${detail ? `  ${JSON.stringify(detail)}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, detail: String(e?.message ?? e) });
    console.log(`FAIL ${name}  ${String(e?.message ?? e).split("\n")[0]}`);
  }
}
const must = (ok, msg) => {
  if (!ok) throw new Error(msg);
};
const contexts = [];
async function open(kind = "desktop", { video = null } = {}) {
  const ctx = await browser.newContext({ ...VP[kind], colorScheme: "light", ...(video && out ? { recordVideo: { dir: `${out}/video-${video}`, size: VP[kind].viewport } } : {}) });
  contexts.push(ctx);
  ctx.setDefaultTimeout(10000);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("[data-orch]", { timeout: 120000 });
  await page.waitForTimeout(3000);
  return page;
}
const shot = async (page, name) => {
  if (!out) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}.png` });
};
/** The drawn panes in reading order: view, focus, place. */
const panes = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-pane]")]
      .filter((p) => p.getBoundingClientRect().width > 0)
      .map((p) => {
        const r = p.getBoundingClientRect();
        return { id: p.getAttribute("data-pane"), view: p.getAttribute("data-pane-view"), focused: p.hasAttribute("data-focused"), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      })
      .sort((a, b) => a.y - b.y || a.x - b.x),
  );
const say = (ps) => ps.map((p) => `${p.view}${p.focused ? "*" : ""}@${p.x},${p.y}`).join(" | ");
const paneBy = (page, view) => page.locator(`[data-pane][data-pane-view="${view}"]`).first();
async function openBeside(page, view) {
  await page.locator(`[data-page-sidebar] [data-nav="${view}"]`).first().hover();
  await page.locator(`[data-page-sidebar] [data-beside="${view}"]`).first().click();
  await page.waitForTimeout(1200);
}
// the Sidebar as its rail, by its toggle; then a pane beside by Ctrl+click on a rail item (the rail has no Open beside).
// Since 1.37.1 the Sidebar folds only by its toggle: two panes at 1180 need it
async function railBeside(page, view) {
  if (!(await page.locator("[data-page-sidebar][data-rail]").count())) {
    await page.locator("[data-sidebar-toggle]").first().click();
    await page.waitForTimeout(800);
  }
  await page.locator(`[data-page-sidebar] [data-nav="${view}"]`).first().click({ modifiers: ["Control"] });
  await page.waitForTimeout(1200);
}
/** Drag from `from` (a locator) to a point at (fx, fy) of `to`'s box, by mouse; `esc` presses Escape before letting go. */
async function drag(page, from, to, fx, fy, { esc = false, shotAs = null } = {}) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  const x = b.x + b.width * fx;
  const y = b.y + b.height * fy;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(a.x + a.width / 2 + ((x - a.x - a.width / 2) * i) / 12, a.y + a.height / 2 + ((y - a.y - a.height / 2) * i) / 12);
  await page.waitForTimeout(300);
  const preview = await page.locator("[data-dock-preview]").getAttribute("data-dock-preview").catch(() => null);
  if (shotAs) await shot(page, shotAs);
  if (esc) await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.waitForTimeout(900);
  return preview;
}
const tag = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (el) el.__mountTag = "kept";
  return !!el;
}, sel);
const tagged = (page, sel) => page.evaluate((s) => document.querySelector(s)?.__mountTag === "kept", sel);
const HOME_FEED = '[data-pane-view="home"] [data-feed]';
// \\ and - open the view picker; Enter picks the page split from, the copy a split used to make
async function splitKey(page, key) {
  await page.keyboard.press(key);
  await page.waitForTimeout(400);
  if (await page.locator("[data-view-picker]").count()) await page.keyboard.press("Enter");
}
// the drop target is the pane that gets re-parented, so its body is tagged too
const PROJ_BODY = '[data-pane-view="projects"] input';
const keptBoth = async (page) => {
  must(await tagged(page, HOME_FEED), "Home remounted");
  must(await tagged(page, PROJ_BODY), "Projects remounted");
};

try {
  // a pane dragged by its header grip onto each edge and the centre of another
  {
    const page = await open("desktop", { video: "dock" });
    await openBeside(page, "projects");
    must((await tag(page, HOME_FEED)) && (await tag(page, PROJ_BODY)), "nothing to tag");
    const grip = (view) => paneBy(page, view).locator("[data-pane-grip]");
    const hint = () => page.evaluate(() => ({ text: document.querySelector("[data-drag-hint]")?.textContent ?? null, saved: localStorage.getItem("orchestrator.hint.drag.v1") }));
    const hint0 = await hint();
    await shot(page, "hint");
    await check("Drag Home onto Projects' bottom edge: Home docks below it, with a preview while dragging, and is never remounted", async () => {
      const preview = await drag(page, grip("home"), paneBy(page, "projects"), 0.5, 0.92, { shotAs: "dock-preview-bottom" });
      const ps = await panes(page);
      const [p, h] = [ps.find((x) => x.view === "projects"), ps.find((x) => x.view === "home")];
      must(preview?.endsWith(":bottom"), `preview ${preview}`);
      must(h.y > p.y && Math.abs(h.x - p.x) <= 2 && h.focused, say(ps));
      await keptBoth(page);
      return say(ps);
    });
    await shot(page, "dock-bottom");
    await check("…then onto Projects' top edge: Home goes above it", async () => {
      const preview = await drag(page, grip("home"), paneBy(page, "projects"), 0.5, 0.15);
      const ps = await panes(page);
      const [p, h] = [ps.find((x) => x.view === "projects"), ps.find((x) => x.view === "home")];
      must(preview?.endsWith(":top"), `preview ${preview}`);
      must(h.y < p.y && Math.abs(h.x - p.x) <= 2, say(ps));
      await keptBoth(page);
      return say(ps);
    });
    await check("…then onto its right edge: Home sits to the right", async () => {
      const preview = await drag(page, grip("home"), paneBy(page, "projects"), 0.92, 0.5);
      const ps = await panes(page);
      const [p, h] = [ps.find((x) => x.view === "projects"), ps.find((x) => x.view === "home")];
      must(preview?.endsWith(":right"), `preview ${preview}`);
      must(h.x > p.x && Math.abs(h.y - p.y) <= 2, say(ps));
      await keptBoth(page);
      return say(ps);
    });
    await check("…then onto its left edge: Home is back on the left", async () => {
      const preview = await drag(page, grip("home"), paneBy(page, "projects"), 0.08, 0.5);
      const ps = await panes(page);
      const [p, h] = [ps.find((x) => x.view === "projects"), ps.find((x) => x.view === "home")];
      must(preview?.endsWith(":left"), `preview ${preview}`);
      must(h.x < p.x && Math.abs(h.y - p.y) <= 2, say(ps));
      await keptBoth(page);
      return say(ps);
    });
    await check("The centre swaps the two panes", async () => {
      const before = await panes(page);
      const preview = await drag(page, grip("home"), paneBy(page, "projects"), 0.5, 0.5);
      const after = await panes(page);
      must(preview?.endsWith(":center"), `preview ${preview}`);
      must(before[0].view === "home" && after[0].view === "projects" && after[1].view === "home", `${say(before)} → ${say(after)}`);
      await keptBoth(page);
      return `${say(before)} → ${say(after)}`;
    });
    await check("Esc during a drag drops nothing", async () => {
      const before = say(await panes(page));
      const preview = await drag(page, grip("home"), paneBy(page, "projects"), 0.08, 0.5, { esc: true });
      const after = say(await panes(page));
      must(preview?.endsWith(":left") && after === before, `preview ${preview}: ${before} → ${after}`);
      must(!(await page.locator("[data-dock-preview]").count()), "the preview stayed");
      return after;
    });
    await check("A dock survives a reload", async () => {
      const before = say(await panes(page));
      must(before.startsWith("projects"), `no dock to keep: ${before}`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-orch]");
      await page.waitForTimeout(3000);
      const after = say(await panes(page));
      must(after.replace(/\*/g, "") === before.replace(/\*/g, ""), `${before} → ${after}`);
      return after;
    });
    await check("A5 The hint shows the first time two panes exist, with both sentences, goes after the first landed drop and stays gone after a reload", async () => {
      const now = await hint();
      must(/Drag a pane by its header to move it\./.test(hint0.text ?? "") && /Drag a page from the sidebar into a pane\./.test(hint0.text ?? "") && hint0.saved === null, JSON.stringify(hint0));
      must(now.text === null && now.saved === "1", JSON.stringify(now));
      return { first: hint0.text, afterDropAndReload: now };
    });
    await page.context().close();
  }

  // a Sidebar item dropped on a pane: an edge makes a new pane there, the centre changes that pane's page
  {
    const page = await open("desktop", { video: "sidebar-drop" });
    await check("Drag Chat from the Sidebar onto Home's right edge: a new Chat pane there", async () => {
      await drag(page, page.locator('[data-page-sidebar] [data-nav="chat"]').first(), paneBy(page, "home"), 0.9, 0.5, { shotAs: "sidebar-drag-preview" });
      const ps = await panes(page);
      must(ps.length === 2 && ps[0].view === "home" && ps[1].view === "chat" && ps[1].focused, say(ps));
      return say(ps);
    });
    await check("Drag Projects onto the Chat pane's centre: that pane goes to Projects", async () => {
      await drag(page, page.locator('[data-page-sidebar] [data-nav="projects"]').first(), paneBy(page, "chat"), 0.5, 0.5);
      const ps = await panes(page);
      must(ps.length === 2 && ps[1].view === "projects" && ps[1].focused && ps[0].view === "home", say(ps));
      return say(ps);
    });
    await check("Drag Home's Needs you filter onto the Projects pane's bottom edge: a new Home pane there, on that filter", async () => {
      await drag(page, page.locator('[data-page-sidebar] [data-feed-filter="needs"]').first(), paneBy(page, "projects"), 0.5, 0.9);
      const ps = await panes(page);
      const [p, h] = [ps.find((x) => x.view === "projects"), ps.find((x) => x.view === "home" && x.focused)];
      const url = decodeURIComponent(decodeURIComponent(page.url()));
      must(ps.length === 3 && p && h && h.y > p.y && Math.abs(h.x - p.x) <= 2, say(ps));
      must(/home\/needs/.test(url), `url ${url}`);
      return say(ps);
    });
    // a press on a Sidebar item: release after `px` pixels, pressing Escape first when `esc`
    const press = async (sel, px, esc = false) => {
      const b = await page.locator(sel).first().boundingBox();
      const [x, y] = [b.x + 30, b.y + b.height / 2];
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 4; i++) await page.mouse.move(x + (px * i) / 4, y);
      await page.waitForTimeout(200);
      if (esc) await page.keyboard.press("Escape");
      await page.mouse.up();
      await page.waitForTimeout(900);
    };
    await check("A press that moves 3 px is still a click: the focused pane goes there", async () => {
      await press('[data-page-sidebar] [data-nav="chat"]', 3);
      const ps = await panes(page);
      must(ps.length === 3 && ps.find((x) => x.focused)?.view === "chat", say(ps));
      return say(ps);
    });
    await check("Esc during a Sidebar drag drops nothing, and the release is not a click", async () => {
      const before = say(await panes(page));
      await press('[data-page-sidebar] [data-nav="projects"]', 20, true);
      const after = say(await panes(page));
      must(after === before, `${before} → ${after}`);
      return after;
    });
    await page.context().close();
  }

  // an edge whose drop would not fit is not offered: the whole pane is then the centre (feel spec 3.3, No room)
  {
    const page = await open();
    await check("With no room left, a Sidebar item over a pane's edge offers only its centre, and the drop replaces that pane's page", async () => {
      await page.locator("[data-pane]").first().click({ position: { x: 5, y: 80 } });
      // split until a split is refused: the page is then full
      for (let n = 1, i = 0; i < 6; i++) {
        await splitKey(page, "\\");
        await page.waitForTimeout(700);
        const m = (await panes(page)).length;
        if (m === n) break;
        n = m;
      }
      const before = await panes(page);
      // beside the open Sidebar, two columns fill 1440 (1.37.1)
      must(before.length >= 2, `set-up: ${say(before)}`);
      const last = page.locator("[data-pane]").last();
      const id = await last.getAttribute("data-pane");
      const preview = await drag(page, page.locator('[data-page-sidebar] [data-nav="chat"]').first(), last, 0.9, 0.5);
      const after = await panes(page);
      const ids = (ps) => ps.map((p) => p.id).join(",");
      must(preview === `${id}:center`, `preview ${preview}, want ${id}:center`);
      must(after.length === before.length && ids(after) === ids(before) && after.find((p) => p.id === id)?.view === "chat", `${say(before)} → ${say(after)}`);
      return { preview, after: say(after) };
    });
    await page.context().close();
  }

  // a finger on the grip docks too
  {
    const page = await open("tablet", { video: "touch" });
    await railBeside(page, "projects");
    await check("1180 touch: a finger drags Home's grip onto Projects' bottom edge", async () => {
      const a = await paneBy(page, "home").locator("[data-pane-grip]").boundingBox();
      const t = await paneBy(page, "projects").boundingBox();
      const cdp = await page.context().newCDPSession(page);
      const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
      const [x0, y0] = [a.x + a.width / 2, a.y + a.height / 2];
      const [x1, y1] = [t.x + t.width / 2, t.y + t.height * 0.9];
      await touch("touchStart", x0, y0);
      for (let i = 1; i <= 12; i++) await touch("touchMove", x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * i) / 12);
      await touch("touchEnd");
      await page.waitForTimeout(900);
      const ps = await panes(page);
      const [p, h] = [ps.find((x) => x.view === "projects"), ps.find((x) => x.view === "home")];
      must(h && p && h.y > p.y && Math.abs(h.x - p.x) <= 2, say(ps));
      return say(ps);
    });
    await shot(page, "tablet-touch-dock");
    await page.context().close();
  }

  // Ctrl/Cmd+click: in the pane beside, else a new pane to the right
  {
    const page = await open("desktop", { video: "ctrl-click" });
    await check("Ctrl+click on a Sidebar place opens it beside the focused pane", async () => {
      await page.locator('[data-page-sidebar] [data-nav="projects"]').first().click({ modifiers: ["ControlOrMeta"] });
      await page.waitForTimeout(1200);
      const ps = await panes(page);
      must(ps.length === 2 && ps[0].view === "home" && ps[1].view === "projects" && ps[1].focused, say(ps));
      return say(ps);
    });
    await check("Ctrl+click on a project in the left pane opens it in the pane to its right", async () => {
      await page.locator('[data-page-sidebar] [data-nav="projects"]').first().click({ modifiers: [] });
      await page.locator("[data-pane]").first().click({ position: { x: 5, y: 60 } });
      await page.locator('[data-page-sidebar] [data-nav="projects"]').first().click();
      await page.waitForTimeout(1000);
      const left = page.locator("[data-pane]").first();
      const slug = await left.locator("[data-select-project]").first().getAttribute("data-select-project");
      await left.locator("[data-select-project]").first().click({ modifiers: ["ControlOrMeta"] });
      await page.waitForTimeout(1200);
      const right = await page.locator("[data-pane]").nth(1).locator("[data-project-page]").getAttribute("data-project-page").catch(() => null);
      const leftPage = await left.locator("[data-project-page]").count();
      must(right === slug && !leftPage, `right ${right}, left page ${leftPage}`);
      return slug;
    });
    await shot(page, "ctrl-click-beside");
    await page.context().close();
  }
  {
    const page = await open();
    await openBeside(page, "projects");
    await check("Ctrl+click on a card in Home opens it in the pane to its right, in the same tab", async () => {
      const home = paneBy(page, "home");
      await home.click({ position: { x: 5, y: 80 } });
      const key = await home.locator("[data-open-post]").first().getAttribute("data-open-post");
      await home.locator("[data-open-post]").first().click({ modifiers: ["ControlOrMeta"] });
      await page.waitForTimeout(1200);
      const ps = await panes(page);
      const right = await page.locator("[data-pane]").nth(1).locator("[data-item]").getAttribute("data-item").catch(() => null);
      const left = await page.locator("[data-pane]").first().locator("[data-item]").count();
      must(ps.length === 2 && right === key && !left, `${say(ps)}: right ${right}, left ${left}`);
      must(page.context().pages().length === 1, `${page.context().pages().length} tabs`);
      return key;
    });
    await shot(page, "ctrl-click-card");
    await page.context().close();
  }

  // the keys
  {
    const page = await open("desktop", { video: "keys" });
    await check("\\ splits the focused pane right, - splits it down, ] and [ walk the focus", async () => {
      await page.locator("[data-pane]").first().click({ position: { x: 5, y: 80 } });
      await splitKey(page, "\\");
      await page.waitForTimeout(900);
      const a = await panes(page);
      await splitKey(page, "-");
      await page.waitForTimeout(900);
      const b = await panes(page);
      const focus = async () => (await panes(page)).findIndex((p) => p.focused);
      const f0 = await focus();
      await page.keyboard.press("]");
      await page.waitForTimeout(400);
      const f1 = await focus();
      await page.keyboard.press("[");
      await page.waitForTimeout(400);
      const f2 = await focus();
      must(a.length === 2 && a[1].x > a[0].x, `\\: ${say(a)}`);
      must(b.length === 3 && b.some((p, i) => i > 0 && p.y > b[0].y), `-: ${say(b)}`);
      must(f1 !== f0 && f2 === f0, `focus ${f0} → ${f1} → ${f2}`);
      return say(b);
    });
    await shot(page, "keys-split");
    await page.context().close();
  }

  // the phone: nothing to drag
  {
    const page = await open("phone");
    await check("Phone: no grip, no pane header, the bottom bar as before", async () => {
      must(!(await page.locator("[data-pane-grip], [data-pane-header]").count()), "a grip on a phone");
      must(await page.locator("[data-bottom-bar]").count(), "no bottom bar");
    });
    await shot(page, "phone");
    await page.context().close();
  }
  // "smooth" and "apparent" (feel spec 4.1, 4.2): frame times against the run's idle baseline, written to smooth.json
  {
    const F = await import("./frames.mjs");
    const smooth = {};
    const save = () => out && writeFileSync(`${out}/smooth.json`, JSON.stringify(smooth, null, 1));
    const page = await open("desktop", { video: "smooth" });
    await openBeside(page, "projects");
    smooth.idle = await F.idle(page);
    const grip = paneBy(page, "home").locator("[data-pane-grip]");
    const gb = await grip.boundingBox();
    const pb = await paneBy(page, "projects").boundingBox();
    const at = (fx, fy) => [pb.x + pb.width * fx, pb.y + pb.height * fy];
    // hover the grip first: a tooltip that opens and then closes is part of a real drag's cost
    await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
    await page.waitForTimeout(900);
    const before = await page.evaluate(() => ({ scroll: [...document.querySelectorAll("[data-pane]")].map((p) => p.querySelector(".orch-pane__scroll")?.scrollTop ?? 0) }));
    await F.start(page);
    await page.mouse.down();
    await F.path(page, F.through([[gb.x + gb.width / 2, gb.y + gb.height / 2], [gb.x + 20, gb.y + 12], at(0.1, 0.5), at(0.5, 0.5), at(0.9, 0.5), at(0.5, 0.1), at(0.5, 0.9), at(0.5, 0.5), at(0.92, 0.5)], 15));
    await page.mouse.up();
    await page.waitForTimeout(700);
    const rec = await F.stop(page);
    const up = rec.ups.at(-1) ?? rec.frames.at(-1).t;
    const press = rec.moves[0]?.t ?? rec.frames[0].t;
    const p0 = rec.moves[0];
    // the drag starts at the move that takes the pointer 6 px from the press; A6 reads the frame after it
    const go = rec.moves.find((m) => p0 && Math.hypot(m.x - p0.x, m.y - p0.y) >= 6);
    const startF = rec.frames.findIndex((f) => go && f.t > go.t);
    const t0 = rec.frames[startF]?.t ?? press;
    const during = rec.frames.filter((f) => f.t >= t0 && f.t <= up);
    const gaps = F.summary(F.gapsOf(rec.frames, t0, up));
    const long = rec.long.filter((l) => l.t >= press - 5 && l.t <= up);
    smooth.drag = { gaps, long, frames: during.length, moves: rec.moves.length };
    await check("S1 60 fps while dragging: frame gaps' 95th percentile at most 1.5 × the idle baseline's, none over 50 ms", async () => {
      must(gaps.p95 <= Math.max(1.5 * smooth.idle.p95, 17.5) && gaps.max <= 50, JSON.stringify({ idle: smooth.idle, drag: gaps }));
      return { idle: smooth.idle, drag: gaps };
    });
    await check("S2 No long task over 50 ms while dragging", async () => {
      must(long.every((l) => l.ms <= 50), JSON.stringify(long));
      return long;
    });
    await check("S3 The preview keeps up: in every frame its box is the zone it names (no transition trails it)", async () => {
      const bad = [];
      for (const f of during.filter((f) => f.preview?.at)) {
        const [id, edge] = f.preview.at.split(":");
        const p = f.panes.find((x) => x.id === id);
        if (!p) continue;
        const r = p.rect;
        const half = { left: [r.x, r.y, r.w / 2, r.h], right: [r.x + r.w / 2, r.y, r.w / 2, r.h], top: [r.x, r.y, r.w, r.h / 2], bottom: [r.x, r.y + r.h / 2, r.w, r.h / 2], center: [r.x, r.y, r.w, r.h] }[edge];
        const want = [half[0] + 4, half[1] + 4, half[2] - 8, half[3] - 8];
        const got = [f.preview.rect.x, f.preview.rect.y, f.preview.rect.w, f.preview.rect.h];
        if (want.some((v, i) => Math.abs(v - got[i]) > 1)) bad.push({ t: Math.round(f.t), at: f.preview.at, want: want.map(Math.round), got: got.map(Math.round) });
      }
      const trans = [...new Set(during.filter((f) => f.preview).map((f) => `${f.preview.transition} ${f.preview.duration}`))];
      smooth.previewMismatch = bad.length;
      must(!bad.length && trans.every((x) => !/\b(all|left|top|width|height)\b/.test(x) || /^\S+ 0s$/.test(x)), JSON.stringify({ mismatched: bad.slice(0, 3), n: bad.length, transitions: trans }));
      return { frames: during.filter((f) => f.preview).length, transitions: trans };
    });
    await check("S4 Nothing else moves while dragging: every pane's box is constant from drag start to release", async () => {
      const first = during[0]?.panes;
      const moved = during.filter((f) => JSON.stringify(f.panes.map((p) => p.box)) !== JSON.stringify(first.map((p) => p.box)));
      must(first && !moved.length, `${moved.length} frames moved`);
      return { frames: during.length };
    });
    await check("A6 The drag explains itself: the frame after it starts shows a ghost, the source at 50% and the grabbing cursor; over a pane the preview has a label naming the result", async () => {
      const f = rec.frames[startF];
      const src = f?.panes.find((p) => p.view === "home");
      const labelled = during.find((x) => x.preview);
      const r = { afterMs: go && f ? Math.round(f.t - go.t) : null, ghost: f?.ghost ? Number(f.ghost.opacity) : 0, ghostText: f?.ghost?.text ?? null, ghostAt: f?.ghost?.rect ?? null, source: src ? Number(src.opacity) : null, cursor: f?.cursor ?? null, label: labelled?.preview?.label ?? "", labelAfterMs: labelled && go ? Math.round(labelled.t - go.t) : null };
      // over the dragged pane itself (no target yet) the cursor is not-allowed; grabbing once over a target
      const overTarget = during.find((x) => x.preview);
      r.cursorOverTarget = overTarget?.cursor ?? null;
      must(r.ghost > 0 && /Home/.test(r.ghostText ?? "") && r.source === 0.5 && /grabbing|not-allowed/.test(r.cursor ?? "") && r.cursorOverTarget === "grabbing" && /Move here|Swap with/.test(r.label), JSON.stringify(r));
      return r;
    });
    const after = rec.frames.filter((f) => f.t > up);
    await check("S5 No layout jump on drop: every pane's layout box in the first frame after the release equals its box 500 ms later; scrollTop unchanged", async () => {
      const a = after[0];
      const b = after.find((f) => f.t >= up + 500) ?? after.at(-1);
      const scroll = await page.evaluate(() => [...document.querySelectorAll("[data-pane]")].map((p) => p.querySelector(".orch-pane__scroll")?.scrollTop ?? 0));
      const same = a && b && JSON.stringify(a.panes.map((p) => [p.id, p.box])) === JSON.stringify(b.panes.map((p) => [p.id, p.box]));
      smooth.drop = { first: a?.panes.map((p) => p.box), late: b?.panes.map((p) => p.box), scrollBefore: before.scroll, scrollAfter: scroll };
      must(same && JSON.stringify(scroll) === JSON.stringify(before.scroll), JSON.stringify(smooth.drop));
      return { panes: a.panes.length };
    });
    await check("S7 The settle is short and cheap: done within 200 ms of the release, animating only transform and opacity", async () => {
      smooth.settle = F.settleOf(rec.frames, up);
      const { props, layout, lastAt, frames } = smooth.settle;
      must(frames > 0 && !layout.length && props.every((p) => p === "transform" || p === "opacity") && lastAt <= 200, JSON.stringify(smooth.settle));
      return smooth.settle;
    });
    await check("S8 No text is selected during or after the drag", async () => {
      const sel = rec.frames.find((f) => f.selection.trim());
      const now = await page.evaluate(() => String(getSelection()).trim());
      must(!sel && !now, JSON.stringify({ during: sel?.selection.slice(0, 40), after: now.slice(0, 40) }));
    });
    save();
    // a trace file of one drag, for the grade (tracing adds its own cost, so it is a separate drag)
    if (out) {
      const g = await paneBy(page, "projects").locator("[data-pane-grip]").boundingBox();
      const hb = await paneBy(page, "home").boundingBox();
      await browser.startTracing(page, { path: `${out}/trace-dock.json`, screenshots: false });
      await page.mouse.move(g.x + 12, g.y + 12);
      await page.mouse.down();
      await F.path(page, F.through([[g.x + 12, g.y + 12], [hb.x + hb.width * 0.5, hb.y + hb.height * 0.5], [hb.x + hb.width * 0.1, hb.y + hb.height * 0.5]], 20));
      await page.mouse.up();
      await page.waitForTimeout(500);
      await browser.stopTracing();
    }
    await page.context().close();

    // S9: Esc from a pane that does not have the focus
    {
      const page = await open("desktop");
      await openBeside(page, "projects");
      await check("S9 Esc mid-drag from an unfocused pane: the saved layout, every rect and the focus are unchanged; ghost and preview gone within 200 ms", async () => {
        const s0 = await page.evaluate(() => ({ layout: localStorage.getItem("orchestrator.layout.v2"), href: location.href, focus: document.querySelector("[data-pane][data-focused]")?.getAttribute("data-pane"), active: document.activeElement?.tagName }));
        const r0 = await panes(page);
        const g = await paneBy(page, "home").locator("[data-pane-grip]").boundingBox();
        const pb = await paneBy(page, "projects").boundingBox();
        await page.mouse.move(g.x + 12, g.y + 12);
        await page.mouse.down();
        await F.path(page, F.through([[g.x + 12, g.y + 12], [pb.x + pb.width * 0.5, pb.y + pb.height * 0.5]], 15));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
        const gone = await page.evaluate(() => !document.querySelector("[data-dock-ghost]") && ![...document.querySelectorAll("[data-dock-preview]")].some((p) => getComputedStyle(p).display !== "none"));
        await page.mouse.up();
        await page.waitForTimeout(400);
        const s1 = await page.evaluate(() => ({ layout: localStorage.getItem("orchestrator.layout.v2"), href: location.href, focus: document.querySelector("[data-pane][data-focused]")?.getAttribute("data-pane"), active: document.activeElement?.tagName }));
        const r1 = await panes(page);
        const sel = await page.evaluate(() => String(getSelection()).trim());
        smooth.esc = { gone, same: s1.layout === s0.layout, focus: [s0.focus, s1.focus], selection: sel.slice(0, 40) };
        must(gone && s1.layout === s0.layout && s1.href === s0.href && s1.focus === s0.focus && say(r1) === say(r0) && !sel, JSON.stringify({ s0, s1, gone, r0: say(r0), r1: say(r1), sel }));
        return smooth.esc;
      });
      await check("A right click mid-drag cancels it as Esc does: the ghost goes back, nothing changes at the release", async () => {
        const s0 = await page.evaluate(() => localStorage.getItem("orchestrator.layout.v2"));
        const g = await paneBy(page, "home").locator("[data-pane-grip]").boundingBox();
        const pb = await paneBy(page, "projects").boundingBox();
        await page.mouse.move(g.x + 12, g.y + 12);
        await page.mouse.down();
        await F.path(page, F.through([[g.x + 12, g.y + 12], [pb.x + pb.width * 0.9, pb.y + pb.height * 0.5]], 15));
        const shown = await page.evaluate(() => !!document.querySelector("[data-dock-ghost]"));
        await page.mouse.down({ button: "right" });
        await page.waitForTimeout(250);
        const gone = await page.evaluate(() => !document.querySelector("[data-dock-ghost]") && !document.querySelector("[data-dock-preview]"));
        await page.mouse.up({ button: "right" });
        await page.mouse.up();
        await page.waitForTimeout(400);
        const s1 = await page.evaluate(() => localStorage.getItem("orchestrator.layout.v2"));
        must(shown && gone && s1 === s0, JSON.stringify({ shown, gone, same: s1 === s0 }));
        return { shown, gone };
      });
      await check("S8 A drag released on no target selects no text and changes nothing", async () => {
        const g = await paneBy(page, "home").locator("[data-pane-grip]").boundingBox();
        const s0 = await page.evaluate(() => localStorage.getItem("orchestrator.layout.v2"));
        await page.mouse.move(g.x + 12, g.y + 12);
        await page.mouse.down();
        await F.path(page, F.through([[g.x + 12, g.y + 12], [g.x + 200, g.y + 300], [200, 500]], 15));
        await page.mouse.up();
        await page.waitForTimeout(400);
        const r = await page.evaluate(() => ({ sel: String(getSelection()).trim().slice(0, 60), layout: localStorage.getItem("orchestrator.layout.v2") }));
        must(!r.sel && r.layout === s0, JSON.stringify({ sel: r.sel, changed: r.layout !== s0 }));
      });
      await check("S8 A drag from the header's free space, landed and released on no target, selects no text", async () => {
        const hb = await paneBy(page, "home").locator("[data-pane-header]").boundingBox();
        const pb = await paneBy(page, "projects").boundingBox();
        const [x, y] = [hb.x + hb.width * 0.55, hb.y + hb.height / 2];
        const sels = [];
        for (const to of [[pb.x + pb.width * 0.5, pb.y + pb.height * 0.5], [200, 500]]) {
          const h = await paneBy(page, "home").locator("[data-pane-header]").boundingBox();
          const from = [h.x + h.width * 0.55, h.y + h.height / 2];
          await page.mouse.move(...from);
          await page.mouse.down();
          await F.path(page, F.through([from, [from[0] + 40, from[1] + 120], to], 15));
          await page.mouse.up();
          await page.waitForTimeout(400);
          sels.push(await page.evaluate(() => String(getSelection()).trim().slice(0, 60)));
        }
        must(x > 0 && y > 0 && sels.every((s) => !s), JSON.stringify(sels));
        return sels;
      });
      save();
      await page.context().close();
    }

    // S5 with a Sidebar drop that adds a third column. The Sidebar stays open unless its toggle is pressed (1.37.1), so
    // with it open a third column isn't offered; with the rail, the drop adds it and nothing jumps
    {
      const page = await open("desktop");
      await openBeside(page, "projects");
      const toEdge = async () => {
        const row = page.locator('[data-page-sidebar] [data-nav="chat"]').first();
        const rb = await row.boundingBox();
        const pb = await paneBy(page, "projects").boundingBox();
        const from = [rb.x + rb.width / 2, rb.y + rb.height / 2];
        await page.mouse.move(...from);
        await page.mouse.down();
        await F.path(page, F.through([from, [pb.x + pb.width * 0.5, pb.y + pb.height * 0.5], [pb.x + pb.width * 0.92, pb.y + pb.height * 0.5]], 15));
      };
      await check("With the Sidebar open, Projects' right edge offers no third column: the preview is its centre, and Esc drops nothing", async () => {
        await toEdge();
        await page.waitForTimeout(200);
        const at = await page.locator("[data-dock-preview]").getAttribute("data-dock-preview").catch(() => null);
        await page.keyboard.press("Escape");
        await page.mouse.up();
        await page.waitForTimeout(500);
        const n = (await panes(page)).length;
        must(/:center$/.test(at ?? "") && n === 2, JSON.stringify({ at, panes: n }));
        return { at };
      });
      await page.locator("[data-sidebar-toggle]").first().click();
      await page.waitForTimeout(800);
      await F.start(page);
      await toEdge();
      await page.mouse.up();
      await page.waitForTimeout(800);
      const rec = await F.stop(page);
      const up = rec.ups.at(-1);
      const after = rec.frames.filter((f) => f.t > up && f.panes.length === 3);
      await check("S5 With the rail, a Sidebar drop that adds a third column: every box in the first frame with three panes equals its box 500 ms later", async () => {
        const a = after[0];
        const b = after.find((f) => f.t >= a.t + 500) ?? after.at(-1);
        const ok = a && b && JSON.stringify(a.panes.map((p) => [p.id, p.box])) === JSON.stringify(b.panes.map((p) => [p.id, p.box]));
        smooth.railDrop = { first: a?.panes.map((p) => p.box), late: b?.panes.map((p) => p.box), firstAt: a ? Math.round(a.t - up) : null };
        must(ok, JSON.stringify(smooth.railDrop));
        return smooth.railDrop;
      });
      await check("S7 A new pane from the Sidebar fades in (opacity only) and is done within 200 ms; nothing animates a width", async () => {
        smooth.newPane = F.settleOf(rec.frames, up);
        const { props, layout, lastAt, frames } = smooth.newPane;
        must(frames > 0 && !layout.length && props.every((p) => p === "transform" || p === "opacity") && lastAt <= 200, JSON.stringify(smooth.newPane));
        return smooth.newPane;
      });
      save();
      await page.context().close();
    }

    // reduced motion: nothing animates
    {
      const ctx = await browser.newContext({ ...VP.desktop, colorScheme: "light", reducedMotion: "reduce" });
      contexts.push(ctx);
      const page = await ctx.newPage();
      await page.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForSelector("[data-orch]", { timeout: 120000 });
      await page.waitForTimeout(3000);
      await openBeside(page, "projects");
      await check("S7 With prefers-reduced-motion nothing animates: no slide, no fade, no ghost return", async () => {
        const g = await paneBy(page, "home").locator("[data-pane-grip]").boundingBox();
        const pb = await paneBy(page, "projects").boundingBox();
        await F.start(page);
        await page.mouse.move(g.x + 12, g.y + 12);
        await page.mouse.down();
        await F.path(page, F.through([[g.x + 12, g.y + 12], [pb.x + pb.width * 0.5, pb.y + pb.height * 0.5], [pb.x + pb.width * 0.92, pb.y + pb.height * 0.5]], 12));
        await page.mouse.up();
        await page.waitForTimeout(500);
        const rec = await F.stop(page);
        const mine = (a) => a.on === "pane" || a.on === "drag" || a.props.some((p) => F.LAYOUT_PROPS.test(p));
        const anim = rec.frames.filter((f) => f.anims.some(mine));
        smooth.reducedMotion = { animatedFrames: anim.length, sample: anim.slice(0, 2).map((f) => f.anims), other: [...new Set(rec.frames.flatMap((f) => f.anims.filter((a) => !mine(a)).map((a) => `${a.props.join("+")} on ${a.on}`)))] };
        must(!anim.length, JSON.stringify(smooth.reducedMotion));
        return smooth.reducedMotion;
      });
      save();
      await ctx.close();
    }

    // A3, A4 at rest and on hover, light and dark
    for (const dark of [false, true]) {
      const ctx = await browser.newContext({ ...VP.desktop, colorScheme: dark ? "dark" : "light" });
      contexts.push(ctx);
      const page = await ctx.newPage();
      await page.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForSelector("[data-orch]", { timeout: 120000 });
      await page.waitForTimeout(3000);
      await openBeside(page, "projects");
      const tag = dark ? " (dark)" : "";
      await check(`A3 Every pane header shows its grip at rest: 16 px, opacity 1, contrast 3:1 or more; cursor grab on the grip and the header's free space${tag}`, async () => {
        const r = await page.evaluate(() => {
          const lum = (c) => {
            const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
            if (/oklch/.test(c)) return m[0] > 1 ? m[0] / 100 : m[0];
            const [r, g, b] = m.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; } return "rgb(255,255,255)"; };
          return [...document.querySelectorAll("[data-pane-header]")].map((h) => {
            const g = h.querySelector("[data-pane-grip]");
            const svg = g?.querySelector("svg");
            const r = svg?.getBoundingClientRect();
            const fg = svg ? getComputedStyle(svg).color : null;
            const ok = (oklch) => oklch;
            const L1 = fg ? lum(fg) : 0, L2 = lum(bgOf(h));
            const isOk = /oklch/.test(fg ?? "");
            // oklch lightness is perceptual; compare as relative luminance by cubing it
            const Y1 = isOk ? L1 ** 3 : L1, Y2 = /oklch/.test(bgOf(h)) ? L2 ** 3 : L2;
            const contrast = (Math.max(Y1, Y2) + 0.05) / (Math.min(Y1, Y2) + 0.05);
            const hb = h.getBoundingClientRect();
            const freeX = hb.left + hb.width * 0.55, freeY = hb.top + hb.height / 2;
            const free = document.elementFromPoint(freeX, freeY);
            return { size: r ? Math.round(r.width) : 0, opacity: g ? Number(getComputedStyle(g).opacity) : 0, contrast: Math.round(contrast * 10) / 10, gripCursor: g ? getComputedStyle(g).cursor : null, freeCursor: free ? getComputedStyle(free).cursor : null };
          });
        });
        must(r.length === 2 && r.every((x) => x.size === 16 && x.opacity === 1 && x.contrast >= 3 && x.gripCursor === "grab" && x.freeCursor === "grab"), JSON.stringify(r));
        return r;
      });
      await check(`A4 A Sidebar row says it drags: its grip shows within 100 ms of hover, and Open beside's tooltip says "drag into a pane"${tag}`, async () => {
        const row = page.locator('[data-page-sidebar] [data-nav="chat"]').first();
        const b = await row.boundingBox();
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        await page.waitForTimeout(100);
        const grip = await page.evaluate(() => {
          const g = document.querySelector('[data-page-sidebar] [data-nav-grip="chat"]');
          return g ? Number(getComputedStyle(g).opacity) : 0;
        });
        await page.locator('[data-page-sidebar] [data-beside="chat"]').first().hover();
        await page.waitForTimeout(900);
        const tip = await page.locator('[data-slot="tooltip-content"]').allTextContents().catch(() => []);
        must(grip > 0.9 && tip.some((t) => /drag into a pane/i.test(t)), JSON.stringify({ grip, tip }));
        return { grip, tip };
      });
      await shot(page, `sidebar-hover${dark ? "-dark" : ""}`);
      await check(`A6 and S3 in a drag: a ghost naming the page, a labelled preview on the zone it names, in every frame${tag}`, async () => {
        const g = await paneBy(page, "home").locator("[data-pane-grip]").boundingBox();
        const pb = await paneBy(page, "projects").boundingBox();
        await F.start(page);
        await page.mouse.move(g.x + 12, g.y + 12);
        await page.mouse.down();
        await F.path(page, F.through([[g.x + 12, g.y + 12], [pb.x + pb.width * 0.5, pb.y + pb.height * 0.5], [pb.x + pb.width * 0.9, pb.y + pb.height * 0.5]], 15));
        await page.waitForTimeout(200);
        if (out) await page.screenshot({ path: `${out}/drag-preview${dark ? "-dark" : ""}.png` });
        await page.keyboard.press("Escape");
        await page.mouse.up();
        await page.waitForTimeout(400);
        const rec = await F.stop(page);
        const shown = rec.frames.filter((f) => f.preview);
        const bad = shown.filter((f) => {
          const [id, edge] = f.preview.at.split(":");
          const r = f.panes.find((x) => x.id === id)?.rect;
          if (!r) return true;
          const h = { left: [r.x, r.y, r.w / 2, r.h], right: [r.x + r.w / 2, r.y, r.w / 2, r.h], top: [r.x, r.y, r.w, r.h / 2], bottom: [r.x, r.y + r.h / 2, r.w, r.h / 2], center: [r.x, r.y, r.w, r.h] }[edge];
          return [h[0] + 4, h[1] + 4, h[2] - 8, h[3] - 8].some((v, i) => Math.abs(v - [f.preview.rect.x, f.preview.rect.y, f.preview.rect.w, f.preview.rect.h][i]) > 1);
        });
        const labels = [...new Set(shown.map((f) => f.preview.label))];
        const ghost = rec.frames.find((f) => f.ghost)?.ghost;
        must(ghost && /Home/.test(ghost.text) && shown.length && !bad.length && labels.includes("Move here") && labels.some((l) => /^Swap with /.test(l)), JSON.stringify({ ghost, labels, bad: bad.length }));
        return { ghost: ghost.text, labels, frames: shown.length };
      });
      // a drag from Home's grip that holds over Projects' right part, for the drag layer's checks
      const holdDrag = async (then) => {
        const g = await paneBy(page, "home").locator("[data-pane-grip]").boundingBox();
        const pb = await paneBy(page, "projects").boundingBox();
        await page.mouse.move(g.x + 8, g.y + 8);
        await page.mouse.down();
        await page.mouse.move(pb.x + pb.width * 0.9, pb.y + pb.height * 0.5, { steps: 12 });
        await page.waitForTimeout(250);
        try {
          return await then();
        } finally {
          await page.keyboard.press("Escape");
          await page.mouse.up();
          await page.waitForTimeout(500);
        }
      };
      await check(`The drag layer carries bb's plugin marks, so the preview has its fill and border; the layer itself is clear and the ghost and label opaque${tag}`, async () => {
        const look = await holdDrag(async () => {
          const r = await page.evaluate(() => {
            const alpha = (c) => (c === "transparent" ? 0 : Number(c.match(/\/\s*([\d.]+)\s*\)$/)?.[1] ?? c.match(/^rgba\([^)]*,\s*([\d.]+)\)$/)?.[1] ?? 1));
            const cover = document.querySelector("[data-drag-cover]");
            const p = document.querySelector("[data-dock-preview]");
            const bg = (el) => (el ? getComputedStyle(el).backgroundColor : "transparent");
            return { marks: !!cover && ["data-bb-portaled-overlay", "data-bb-plugin-root"].every((k) => cover.hasAttribute(k)) && cover.getAttribute("data-bb-plugin") === "orchestrator", cover: alpha(bg(cover)), preview: alpha(bg(p)), border: alpha(p ? getComputedStyle(p).borderTopColor : "transparent"), ghost: alpha(bg(document.querySelector("[data-dock-ghost]"))), label: alpha(bg(p?.querySelector("span"))) };
          });
          if (out) await page.screenshot({ path: `${out}/drag-layer${dark ? "-dark" : ""}.png` });
          return r;
        });
        must(look.marks && look.cover === 0 && look.preview > 0 && look.preview < 1 && look.border > 0 && look.ghost === 1 && look.label === 1, JSON.stringify(look));
        return look;
      });
      await check(`The ghost stays inside the window at its bottom-right corner, beside the pointer, not under it${tag}`, async () => {
        const vp = page.viewportSize();
        const r = await holdDrag(async () => {
          await page.mouse.move(vp.width - 3, vp.height - 3, { steps: 6 });
          await page.waitForTimeout(250);
          const g = await page.evaluate(() => document.querySelector("[data-dock-ghost]")?.getBoundingClientRect().toJSON() ?? null);
          if (out) await page.screenshot({ path: `${out}/drag-corner${dark ? "-dark" : ""}.png` });
          return g && { l: Math.round(g.left), t: Math.round(g.top), r: Math.round(g.right), b: Math.round(g.bottom) };
        });
        must(r && r.l >= 0 && r.t >= 0 && r.r <= vp.width && r.b <= vp.height && !(vp.width - 3 >= r.l && vp.width - 3 <= r.r && vp.height - 3 >= r.t && vp.height - 3 <= r.b), JSON.stringify({ r, vp }));
        return r;
      });
      await check(`The one-time hint hides while a drag is on and comes back after it${tag}`, async () => {
        const seen = () => page.evaluate(() => { const h = document.querySelector("[data-drag-hint]"); return h ? getComputedStyle(h).visibility : null; });
        const before = await seen();
        const during = await holdDrag(seen);
        const r = { before, during, after: await seen(), cover: await page.locator("[data-drag-cover]").count() };
        must(before === "visible" && during === "hidden" && r.after === "visible" && !r.cover, JSON.stringify(r));
        return r;
      });
      await ctx.close();
    }
  }
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks pass`);
if (out) writeFileSync(`${out}/checks.json`, JSON.stringify(results, null, 1));
process.exit(failed.length ? 1 : 0);
