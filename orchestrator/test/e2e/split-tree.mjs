// The split tree (split panes, release 2) in a real browser, against a seeded bb only (live-guard.ts): node test/e2e/split-tree.mjs <base URL> [out dir] [--live]
import { checkBase } from "./live-guard.ts";
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
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${name}.png` });
};
const pane = (page, i) => page.locator("[data-pane]:visible").nth(i);
/** The drawn panes: view, focus, size, and an open project. */
const panes = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-pane]")]
      .filter((p) => p.getBoundingClientRect().width > 0)
      .map((p) => {
        const r = p.getBoundingClientRect();
        return { view: p.getAttribute("data-pane-view"), focused: p.hasAttribute("data-focused"), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }),
  );
const say = (ps) => ps.map((p) => `${p.view}${p.focused ? "*" : ""}(${p.w}×${p.h})`).join(" | ");
const sidebarW = (page) => page.evaluate(() => Math.round(document.querySelector("[data-page-sidebar]")?.getBoundingClientRect().width ?? 0));
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
async function headerButton(page, i, what) {
  await pane(page, i).locator(`[data-${what}]`).click();
  await page.waitForTimeout(500);
  // a split opens the view picker; Enter picks the page split from, the copy a split used to make
  if (await page.locator("[data-view-picker]").count()) await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
}
const tag = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (el) el.__mountTag = "kept";
  return !!el;
}, sel);
const tagged = (page, sel) => page.evaluate((s) => document.querySelector(s)?.__mountTag === "kept", sel);
const HOME_FEED = '[data-pane-view="home"] [data-feed]';

try {
  // split right and down from a pane's header; each new pane copies its pane's place and takes the focus
  {
    const page = await open("desktop", { video: "split" });
    await openBeside(page, "projects");
    await tag(page, HOME_FEED);
    await check("Split down puts a copy of the pane below it, focused", async () => {
      await headerButton(page, 1, "split-down");
      const ps = await panes(page);
      must(ps.length === 3, `3 panes, got ${say(ps)}`);
      const below = ps.filter((p) => p.view === "projects");
      must(below.length === 2 && below[0].x === below[1].x && below[1].y > below[0].y, `a Projects pane under Projects: ${say(ps)}`);
      must(below[1].focused, `the new pane has the focus: ${say(ps)}`);
      return say(ps);
    });
    await shot(page, "split-down");
    // the Sidebar stays open (1.37.1, the owner: "where did all the other tabs go"): it turns into the rail only by its toggle
    await check("With the Sidebar open a third column doesn't fit: Split right is refused, the note says to collapse the Sidebar, and the Sidebar stays open", async () => {
      const before = await panes(page);
      await headerButton(page, 0, "split-right");
      const after = await panes(page);
      const note = await page.locator("[data-key-note]").textContent().catch(() => "");
      const w = await sidebarW(page);
      must(after.length === before.length, `${say(before)} → ${say(after)}`);
      must(/no room/i.test(note ?? "") && /collapse the sidebar/i.test(note ?? ""), `note: ${note}`);
      must(w > 64, `the Sidebar folded to ${w} px by itself`);
      return { note, sidebar: w };
    });
    await check("After the Sidebar's toggle, Split right puts a copy of the pane to its right, focused; the Home pane never remounts", async () => {
      await page.locator("[data-sidebar-toggle]").first().click();
      await page.waitForTimeout(800);
      await headerButton(page, 0, "split-right");
      const ps = await panes(page);
      must(ps.length === 4, `4 panes, got ${say(ps)}`);
      const homes = ps.filter((p) => p.view === "home");
      must(homes.length === 2 && homes[1].x > homes[0].x && homes[1].focused, say(ps));
      must(await tagged(page, HOME_FEED), "the first Home pane remounted");
      return say(ps);
    });
    await shot(page, "split-right");
    await check("Every pane keeps the 320 × 240 minimum; the rail is there because its toggle was pressed, and that choice is saved", async () => {
      const ps = await panes(page);
      must(ps.every((p) => p.w >= 319 && p.h >= 239), say(ps));
      const w = await sidebarW(page);
      must(w > 0 && w <= 64, `the Sidebar is ${w} px`);
      const saved = await page.evaluate(() => localStorage.getItem("orchestrator.sidebar.v1"));
      must(saved === "rail", `saved: ${saved}`);
      return { sidebar: w, panes: say(ps) };
    });
    await check("A split with no room is refused, with one line saying why", async () => {
      const before = (await panes(page)).length;
      await headerButton(page, 0, "split-right");
      const after = (await panes(page)).length;
      const note = await page.locator("[data-key-note]").textContent().catch(() => "");
      must(after === before, `${before} → ${after} panes`);
      must(/no room/i.test(note ?? ""), `note: ${note}`);
      return note;
    });
    await page.context().close();
  }

  // dividers: mouse, keyboard, double-click, the pixel minimum, and no remount
  {
    const page = await open("desktop", { video: "divider" });
    await openBeside(page, "projects");
    await tag(page, HOME_FEED);
    const sep = page.locator("[data-panes] [role=separator]").first();
    await check("A divider is a separator with a value, and arrow keys move it", async () => {
      must(await sep.count(), "no separator");
      const v0 = Number(await sep.getAttribute("aria-valuenow"));
      await sep.focus();
      for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(500);
      const v1 = Number(await sep.getAttribute("aria-valuenow"));
      must(Number.isFinite(v0) && v1 < v0, `aria-valuenow ${v0} → ${v1}`);
      return { from: v0, to: v1 };
    });
    await check("Dragging a divider (4 px off its line) stops at 320 px and keeps the Home pane mounted", async () => {
      const b = await sep.boundingBox();
      await page.mouse.move(b.x + b.width / 2 + 4, b.y + 300);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + 4 - 60 * i, b.y + 300);
      await page.mouse.up();
      await page.waitForTimeout(600);
      const ps = await panes(page);
      must(ps.every((p) => p.w >= 319), `a pane under 320: ${say(ps)}`);
      must(ps[0].w <= 330, `the divider did not move to the minimum: ${say(ps)}`);
      must(await tagged(page, HOME_FEED), "the Home pane remounted");
      return say(ps);
    });
    await shot(page, "divider-min");
    await check("A drag survives a reload (the sizes are saved)", async () => {
      const before = (await panes(page)).map((p) => p.w);
      must(Math.abs(before[0] - before[1]) > 40, `nothing to restore: ${before}`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-orch]");
      await page.waitForTimeout(3000);
      const after = (await panes(page)).map((p) => p.w);
      must(after.length === 2 && Math.abs(after[0] - before[0]) <= 4, `${before} → ${after}`);
      return { before, after };
    });
    await check("Double-click on a divider (4 px off its line) makes the two panes equal", async () => {
      const unequal = await panes(page);
      must(Math.abs(unequal[0].w - unequal[1].w) > 40, `already equal: ${say(unequal)}`);
      const b = await page.locator("[data-panes] [role=separator]").first().boundingBox();
      await page.mouse.dblclick(b.x + b.width / 2 + 4, b.y + 300);
      await page.waitForTimeout(600);
      const ps = await panes(page);
      must(Math.abs(ps[0].w - ps[1].w) <= 4, say(ps));
      return say(ps);
    });
    await page.context().close();
  }

  // the Sidebar rail by its toggle, remembered per browser
  {
    const page = await open("desktop", { video: "rail" });
    await check("The Sidebar's toggle collapses it to an icon rail in the page's flow, and a reload keeps it", async () => {
      const open0 = await sidebarW(page);
      await page.locator("[data-sidebar-toggle]").first().click();
      await page.waitForTimeout(600);
      const rail = await sidebarW(page);
      const position = await page.evaluate(() => getComputedStyle(document.querySelector("[data-page-sidebar]")).position);
      await shot(page, "rail");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-orch]");
      await page.waitForTimeout(2500);
      const kept = await sidebarW(page);
      must(open0 > 150 && rail > 0 && rail <= 64 && kept === rail, `open ${open0}, rail ${rail}, after reload ${kept}`);
      must(position !== "fixed", "the rail is position: fixed");
      return { open: open0, rail, kept };
    });
    await check("In the rail, Home opens a small menu with its filters; Chat goes straight to its page", async () => {
      await page.locator('[data-page-sidebar] [data-nav="home"]').first().click();
      await page.waitForTimeout(500);
      const menu = await page.locator('[role=menu] [data-feed-filter="needs"]').count();
      await page.keyboard.press("Escape");
      await page.locator('[data-page-sidebar] [data-nav="chat"]').first().click();
      await page.waitForTimeout(800);
      const ps = await panes(page);
      must(menu > 0, "no filter menu");
      must(ps[0]?.view === "chat", say(ps));
      return say(ps);
    });
    await page.locator("[data-sidebar-toggle]").first().click({ timeout: 2000 }).catch(() => {});
    await page.context().close();
  }

  // the switcher: panes that don't fit show one at a time, and come back when there is room
  {
    const page = await open("desktop", { video: "switcher" });
    await openBeside(page, "projects");
    // Home | Projects over Projects fits at 1440 beside the open Sidebar; at 1180 two columns no longer do
    await check("1180: the panes don't fit beside the open Sidebar; one pane shows with a \"1 of 3\" switcher that reaches the others", async () => {
      await headerButton(page, 1, "split-down");
      await page.setViewportSize({ width: 1180, height: 820 });
      await page.waitForTimeout(1200);
      const ps = await panes(page);
      const sw = page.locator("[data-pane-switcher]");
      must(ps.length === 1, `one pane drawn: ${say(ps)}`);
      const text = (await sw.textContent()) ?? "";
      must(/of 3/.test(text), `switcher: ${text}`);
      must(!(await page.locator("[data-pane-header]:visible").count()), "a pane header under the switcher");
      await shot(page, "switcher");
      const drawn = () => page.evaluate(() => [...document.querySelectorAll("[data-pane]")].filter((p) => p.offsetWidth > 0).map((p) => ({ id: p.getAttribute("data-pane"), focused: p.hasAttribute("data-focused") })));
      const d1 = await drawn();
      await sw.locator('[data-switch="next"]').click();
      await page.waitForTimeout(800);
      const text2 = (await sw.textContent()) ?? "";
      must(text2 !== text, `${text} → ${text2}`);
      // the counter alone moves even when the old pane stays drawn: the one drawn pane must be the focused one, and a new one
      const d2 = await drawn();
      await page.keyboard.press("]");
      await page.waitForTimeout(800);
      const d3 = await drawn();
      must(d2.length === 1 && d2[0].focused && d2[0].id !== d1[0].id && d3.length === 1 && d3[0].focused && d3[0].id !== d2[0].id, JSON.stringify({ first: d1, next: d2, key: d3 }));
      return `${text} → ${text2}`;
    });
    await check("Back at 1440 the three panes return as they were", async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(1200);
      const ps = await panes(page);
      must(ps.length === 3 && !(await page.locator("[data-pane-switcher]").count()), say(ps));
      return say(ps);
    });
    await page.context().close();
  }

  // Open beside is visible on touch, sub-pages included
  {
    const page = await open("tablet");
    await check("1180 touch: Open beside is visible without hover, on places and on Home's filters", async () => {
      const ops = await page.evaluate(() => [...document.querySelectorAll("[data-page-sidebar] [data-beside]")].map((b) => ({ id: b.getAttribute("data-beside"), o: Number(getComputedStyle(b).opacity) })));
      must(ops.length >= 4 + 4, `${ops.length} Open beside buttons: ${JSON.stringify(ops)}`);
      must(ops.every((b) => b.o > 0.5), `hidden: ${JSON.stringify(ops.filter((b) => b.o <= 0.5))}`);
      return ops.map((b) => b.id).join(",");
    });
    await shot(page, "tablet-open-beside");
    await check("1180 touch: a finger 8 px off the divider drags it", async () => {
      await railBeside(page, "projects");
      const b = await page.locator("[data-panes] [role=separator]").first().boundingBox();
      const before = (await panes(page)).map((p) => p.w);
      const cdp = await page.context().newCDPSession(page);
      const y = b.y + 300;
      const touch = (type, x) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
      const x0 = b.x + b.width / 2 + 8;
      await touch("touchStart", x0);
      for (let i = 1; i <= 6; i++) await touch("touchMove", x0 + 15 * i);
      await touch("touchEnd");
      await page.waitForTimeout(600);
      const after = (await panes(page)).map((p) => p.w);
      must(after[0] > before[0] + 30, `${before} → ${after}`);
      must(after.every((w) => w >= 319), `a pane under 320: ${after}`);
      return { before, after };
    });
    await page.context().close();
  }

  // an item in a narrow pane opens inside it, with Back; a single pane at 1440 shows list and item together
  {
    const page = await open();
    await page.locator('[data-page-sidebar] [data-nav="projects"]').first().click();
    await page.waitForTimeout(1500);
    await check("One Projects pane at 1440 shows the list and the selected project together", async () => {
      const layout = await pane(page, 0).locator("[data-projects-tab]").getAttribute("data-layout");
      must(layout === "list-detail", `layout ${layout}`);
      return layout;
    });
    await shot(page, "projects-1440-list-detail");
    await openBeside(page, "projects");
    await check("In a narrow pane a project opens inside the pane, with Back, not expanded in the list", async () => {
      const p = pane(page, 1);
      const slug = await p.locator("[data-select-project]").first().getAttribute("data-select-project");
      await p.locator("[data-select-project]").first().click();
      await page.waitForTimeout(1200);
      const inline = await p.locator("[data-in-place]").count();
      const pageOf = await p.locator("[data-project-page]").getAttribute("data-project-page").catch(() => null);
      must(!inline && pageOf === slug, `inline ${inline}, page ${pageOf}`);
      await shot(page, "narrow-project-open");
      await p.locator("[data-detail-back]").first().click();
      await page.waitForTimeout(1000);
      must(await p.locator("[data-select-project]").count(), "Back did not return to the list");
      await p.locator("[data-select-project]").first().click();
      await page.waitForTimeout(1000);
      await page.goBack();
      await page.waitForTimeout(1500);
      must(await p.locator("[data-select-project]").count(), "the browser's Back did not return to the list");
      return slug;
    });
    await page.context().close();
  }

  // the phone: one screen and the bottom bar; no pane headers or split gestures
  {
    const page = await open("phone");
    await check("Phone: one pane, the bottom bar, no pane header or split control", async () => {
      must(await page.locator("[data-bottom-bar]").count(), "no bottom bar");
      must(!(await page.locator("[data-split-right], [data-split-down], [data-pane-header]").count()), "split controls on a phone");
      return say(await panes(page));
    });
    await shot(page, "phone");
    await page.context().close();
  }
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks pass`);
if (out) (await import("node:fs")).writeFileSync(`${out}/checks.json`, JSON.stringify(results, null, 1));
process.exit(failed.length ? 1 : 0);
