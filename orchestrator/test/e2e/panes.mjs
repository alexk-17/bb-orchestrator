// Split panes in a real browser, against a seeded bb only (live-guard.ts): node test/e2e/panes.mjs <base URL> [out dir] [--live]
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
async function open(kind = "desktop") {
  const ctx = await browser.newContext({ ...VP[kind], colorScheme: "light" });
  ctx.setDefaultTimeout(15000);
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
const pane = (page, i) => page.locator("[data-pane]").nth(i);
/** Each drawn pane: its view, focus, Home filter, whether an item is open, the open project. */
const panes = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-pane]")]
      .filter((p) => p.getBoundingClientRect().width > 0)
      .map((p) => ({
        view: p.getAttribute("data-pane-view"),
        focused: p.hasAttribute("data-focused"),
        filter: p.querySelector("[data-home-body]")?.getAttribute("data-home-body") ?? (p.querySelector("[data-feed]") ? (p.querySelector("[data-home-header] h1")?.textContent ?? "all") : null),
        item: !!p.querySelector("[data-feed-pane], .k-overlay"),
        project: p.querySelector("[data-project-detail]")?.getAttribute("data-project-detail") ?? p.querySelector("[data-project-page]")?.getAttribute("data-project-page") ?? null,
        selected: p.querySelector("[data-card][data-selected]")?.getAttribute("data-card") ?? null,
      })),
  );
const say = (ps) => ps.map((p) => `${p.view}${p.filter && p.filter.toLowerCase() !== "all" ? `/${p.filter.toLowerCase()}` : ""}${p.project ? `/${p.project}` : ""}${p.item ? "+item" : ""}${p.focused ? "*" : ""}`).join(" | ");
async function focusPane(page, i) {
  // the header's free space: the title is inside the view control, which opens the picker
  const h = pane(page, i).locator("[data-pane-header]");
  const b = await h.boundingBox();
  await h.click({ position: { x: Math.round(b.width * 0.55), y: Math.round(b.height / 2) } });
  await page.waitForTimeout(600);
}
async function openBeside(page, view) {
  await page.locator(`[data-page-sidebar] [data-nav="${view}"]`).first().hover();
  await page.locator(`[data-page-sidebar] [data-beside="${view}"]`).first().click();
  await page.waitForTimeout(1500);
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
async function filter(page, f) {
  await page.locator(`[data-page-sidebar] [data-feed-filter="${f}"]`).first().click();
  await page.waitForTimeout(1200);
}
async function openItem(page, i) {
  await pane(page, i).locator("[data-post] [data-open]").first().click();
  await page.waitForTimeout(1200);
}
/** A project in a narrow pane opens as the pane's own page (release 2); before, a row expanded and Timeline opened it. */
async function openProject(page, i, n = 0) {
  const p = pane(page, i);
  await p.locator("[data-select-project]").nth(n).click();
  await page.waitForTimeout(1200);
  const timeline = p.locator("[data-open-project]:visible");
  if (!(await p.locator("[data-project-page]").count()) && (await timeline.count())) {
    await timeline.first().click();
    await page.waitForTimeout(1200);
  }
}
async function dragDivider(page, dx) {
  const b = await page.locator("[data-divider], [role=separator][aria-orientation]").first().boundingBox();
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y);
  await page.mouse.up();
  await page.waitForTimeout(600);
}
/** Tag Home's feed node: the same node later means the pane was never remounted. */
const tag = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-pane-view="home"] [data-feed]');
  if (el) el.__mountTag = "kept";
  return !!el;
});
const tagged = (page) => page.evaluate(() => document.querySelector('[data-pane-view="home"] [data-feed]')?.__mountTag === "kept");
const scrolled = (page) => page.evaluate(() => document.querySelector('[data-pane-view="home"] [data-feed-scroll]')?.scrollTop ?? 0);

try {
  // P5: no layout change remounts a pane, and Home's opened item stays open
  {
    const page = await open();
    await openItem(page, 0);
    must(await tag(page), "no Home pane");
    await page.evaluate(() => document.querySelector('[data-pane-view="home"] [data-feed-scroll]')?.scrollTo({ top: 300 }));
    must((await scrolled(page)) > 0, "the list does not scroll");
    await check("P5 mount: split (Open beside) keeps the Home pane mounted, its item open", async () => {
      await openBeside(page, "projects");
      const ps = await panes(page);
      must(await tagged(page), `Home remounted: ${say(ps)}`);
      must(ps.find((p) => p.view === "home")?.item, `item closed: ${say(ps)}`);
      must((await scrolled(page)) > 0, "the list scrolled back to the top");
      return say(ps);
    });
    await check("P1 focus: the focused pane's header looks different from the other's", async () => {
      const st = await page.evaluate(() =>
        [...document.querySelectorAll("[data-pane]")].map((p) => {
          const h = p.querySelector("header");
          const t = p.querySelector("[data-pane-title]");
          const hs = h && getComputedStyle(h);
          return { focused: p.hasAttribute("data-focused"), header: hs ? `${hs.borderTopWidth} ${hs.borderTopColor} ${hs.boxShadow} ${t ? getComputedStyle(t).color : ""}` : null };
        }),
      );
      must(st.length === 2 && st.filter((s) => s.focused).length === 1, `focus marks ${JSON.stringify(st)}`);
      must(st[0].header !== st[1].header, `headers identical: ${st[0].header}`);
      return st;
    });
    await shot(page, "two-panes-focus");
    await check("P5 mount: a divider drag keeps the Home pane mounted", async () => {
      await tag(page);
      await dragDivider(page, 120);
      must(await tagged(page), `Home remounted: ${say(await panes(page))}`);
    });
    await check("P5 mount: crossing 720 px and back keeps the Home pane mounted, its item open", async () => {
      await tag(page);
      // a 1000 px window: bb keeps its sidebar docked, so the page crosses 720 px without bb switching to its phone layout
      await page.setViewportSize({ width: 1000, height: 900 });
      must(await page.evaluate(() => document.querySelector("[data-orch]").getBoundingClientRect().width < 720), "the page did not go under 720 px");
      await page.waitForTimeout(1200);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(1200);
      const ps = await panes(page);
      must(await tagged(page), `Home remounted: ${say(ps)}`);
      must(ps.find((p) => p.view === "home")?.item, `item closed: ${say(ps)}`);
      must((await scrolled(page)) > 0, "the list scrolled back to the top");
      return say(ps);
    });
    await check("P5 mount: closing the sibling keeps the Home pane mounted, its item open", async () => {
      await tag(page);
      await pane(page, 1).locator("[data-close-pane]").click();
      await page.waitForTimeout(1000);
      const ps = await panes(page);
      must(await tagged(page), `Home remounted: ${say(ps)}`);
      must(ps.length === 1 && ps[0].item, `item closed: ${say(ps)}`);
      must((await scrolled(page)) > 0, "the list scrolled back to the top");
      return say(ps);
    });
    await check("700 px window (bb's own phone layout): if bb keeps the page, the pane is kept too", async () => {
      await tag(page);
      await page.evaluate(() => (document.querySelector("[data-orch]").__mountTag = "kept"));
      await page.setViewportSize({ width: 700, height: 900 });
      await page.waitForTimeout(1200);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(1200);
      const pageKept = await page.evaluate(() => document.querySelector("[data-orch]")?.__mountTag === "kept");
      const paneKept = await tagged(page);
      must(!pageKept || paneKept, "bb kept the page but the pane remounted");
      return { pageKept, paneKept };
    });
    await page.context().close();
  }

  // the Game Boy (an iframe) and the chat stay mounted through a split, a divider drag, crossing 720 px and a close
  {
    const page = await open();
    await check("P5 mount: the Game Boy's iframe and the chat pane are never reloaded or remounted", async () => {
      await page.goto(`${PAGE}/gameboy`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-pane-view="gameboy"] iframe');
      await page.waitForTimeout(2500);
      const game = () => page.frames().find((f) => f.url().includes("/gameboy/play"));
      await game().evaluate(() => (window.__kept = "kept"));
      await openBeside(page, "chat");
      await page.evaluate(() => (document.querySelector('[data-pane-view="chat"] > :last-child').__mountTag = "kept"));
      const chatKept = () => page.evaluate(() => document.querySelector('[data-pane-view="chat"] > :last-child')?.__mountTag === "kept");
      await dragDivider(page, -100);
      await page.setViewportSize({ width: 1000, height: 900 });
      await page.waitForTimeout(1200);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(1200);
      must(await chatKept(), "the chat remounted");
      await pane(page, 1).locator("[data-close-pane]").click();
      await page.waitForTimeout(1000);
      must((await game()?.evaluate(() => window.__kept).catch(() => null)) === "kept", "the Game Boy's iframe reloaded");
      return "game and chat kept";
    });
    await page.context().close();
  }

  // P2: the Sidebar acts on the pane that shows the focus, and only on it
  {
    const page = await open();
    await page.locator('[data-page-sidebar] [data-nav="chat"]').first().click();
    await page.waitForTimeout(1000);
    await openBeside(page, "projects");
    await check("P2 nav target: a Sidebar filter changes the pane marked focused, and only it", async () => {
      const before = await panes(page);
      const marked = await page.evaluate(() => {
        const hs = [...document.querySelectorAll("[data-pane]")].map((p) => {
          const h = p.querySelector("header");
          const t = p.querySelector("[data-pane-title]");
          return h ? `${getComputedStyle(h).borderTopWidth} ${getComputedStyle(h).borderTopColor} ${getComputedStyle(h).boxShadow} ${t ? getComputedStyle(t).color : ""}` : "";
        });
        return hs[0] !== hs[1];
      });
      must(marked, "no visible focus mark before the click");
      const target = before.findIndex((p) => p.focused);
      await filter(page, "delivered");
      const after = await panes(page);
      must(after[target].view === "home" && after[target].filter === "delivered", `focused pane: ${say(after)}`);
      must(after[1 - target].view === before[1 - target].view, `the other pane changed: ${say(before)} → ${say(after)}`);
      return `${say(before)} → ${say(after)}`;
    });
    await page.context().close();
  }

  // P4 + P12: the same page twice is two pages
  {
    const page = await open();
    await openBeside(page, "home");
    await filter(page, "delivered");
    await focusPane(page, 0);
    await filter(page, "needs");
    await check("P4 two Home panes hold different filters", async () => {
      const ps = await panes(page);
      must(ps[0].filter === "needs" && ps[1].filter === "delivered", say(ps));
      return say(ps);
    });
    await shot(page, "two-home-filters");
    await focusPane(page, 1);
    await filter(page, "needs");
    await check("P12 J/K move only the focused pane's selection", async () => {
      await focusPane(page, 0);
      await page.keyboard.press("j");
      await page.keyboard.press("j");
      await page.waitForTimeout(400);
      const a = await panes(page);
      await focusPane(page, 1);
      await page.keyboard.press("j");
      await page.waitForTimeout(400);
      const b = await panes(page);
      must(a[0].selected && b[0].selected === a[0].selected, `left moved with the right: ${a[0].selected} → ${b[0].selected}`);
      must(b[1].selected && b[1].selected !== b[0].selected, `one selection for both: ${b[0].selected} / ${b[1].selected}`);
      return { left: b[0].selected, right: b[1].selected };
    });
    await page.context().close();
  }
  {
    const page = await open();
    await page.locator('[data-page-sidebar] [data-nav="projects"]').first().click();
    await page.waitForTimeout(1200);
    await openBeside(page, "projects");
    await check("P4 two Projects panes hold different projects", async () => {
      await openProject(page, 1, 0);
      await focusPane(page, 0);
      await openProject(page, 0, 1);
      const ps = await panes(page);
      must(ps[0].project && ps[1].project && ps[0].project !== ps[1].project, say(ps));
      return say(ps);
    });
    await shot(page, "two-projects");
    await page.context().close();
  }

  // P9: a reload restores each pane's page and item
  {
    const page = await open();
    await check("P9 reload restores each pane's page, filter, item and project", async () => {
      await openBeside(page, "projects");
      await focusPane(page, 0);
      await filter(page, "alerts");
      await openItem(page, 0);
      await focusPane(page, 1);
      await openProject(page, 1, 0);
      const before = await panes(page);
      await shot(page, "reload-before");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-orch]");
      await page.waitForTimeout(3500);
      const after = await panes(page);
      must(say(after) === say(before), `${say(before)} → ${say(after)}`);
      return say(after);
    });
    await shot(page, "reload-after");
    await page.context().close();
  }

  // P10: Back undoes one step, in the pane it happened in
  {
    const page = await open();
    await openBeside(page, "projects");
    await focusPane(page, 0);
    await page.locator('[data-page-sidebar] [data-nav="chat"]').first().click();
    await page.waitForTimeout(1000);
    await focusPane(page, 1);
    const before = await panes(page);
    await shot(page, "back-before");
    await page.goBack();
    await page.waitForTimeout(2000);
    await check("P10 Back undoes one step: the left pane goes back to Home, the right one stays", async () => {
      const after = await panes(page);
      must(after.length === 2 && after[0].view === "home" && after[0].focused && after[1].view === "projects", `${say(before)} → ${say(after)}`);
      return `${say(before)} → ${say(after)}`;
    });
    await shot(page, "back-after");
    await check("P10 Forward redoes it", async () => {
      await page.goForward();
      await page.waitForTimeout(2000);
      const after = await panes(page);
      must(after[0].view === "chat" && after[1].view === "projects", say(after));
      return say(after);
    });
    await check("P10 Back after opening a project closes it, in its own pane", async () => {
      await openProject(page, 1, 0);
      const opened = await panes(page);
      await page.goBack();
      await page.waitForTimeout(2000);
      const after = await panes(page);
      must(opened[1].project && !after[1].project && after[0].view === "chat", `${say(opened)} → ${say(after)}`);
      return `${say(opened)} → ${say(after)}`;
    });
    await page.context().close();
  }

  // Back after a reload, and after leaving the page for another bb page and coming back
  {
    const page = await open();
    await openBeside(page, "projects");
    await check("P10 Back after a reload undoes the step from before the reload", async () => {
      await openProject(page, 1, 0);
      const opened = await panes(page);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-orch]");
      await page.waitForTimeout(3500);
      await page.goBack();
      await page.waitForTimeout(2000);
      const after = await panes(page);
      must(opened[1].project && !after[1].project && after[0].view === "home", `${say(opened)} → ${say(after)}`);
      return `${say(opened)} → ${say(after)}`;
    });
    await check("P10 leave for bb's settings, Back returns to both panes as they were, Back again undoes one step", async () => {
      await openProject(page, 1, 0);
      const opened = await panes(page);
      await page.locator('a[href="/settings/mobile"]').first().click();
      await page.waitForTimeout(2000);
      must(!(await page.locator("[data-orch]").count()), "did not leave the page");
      await page.goBack();
      await page.waitForSelector("[data-orch]");
      await page.waitForTimeout(3000);
      const back = await panes(page);
      must(say(back) === say(opened), `${say(opened)} → ${say(back)}`);
      await page.goBack();
      await page.waitForTimeout(2000);
      const undone = await panes(page);
      must(!undone[1]?.project && undone[0]?.view === "home", `then ${say(undone)}`);
      return `${say(opened)} → away → ${say(back)} → ${say(undone)}`;
    });
    await page.context().close();
  }

  // 1180 × 820, touch: two panes, focus marked
  {
    const page = await open("tablet");
    await railBeside(page, "projects");
    await check("tablet 1180: two panes drawn, one marked focused", async () => {
      const ps = await panes(page);
      must(ps.length === 2 && ps.filter((p) => p.focused).length === 1, say(ps));
      return say(ps);
    });
    await shot(page, "tablet-two-panes");
    await page.context().close();
  }

  // the phone: no change (one screen, the bottom bar, an item full screen with Back)
  {
    const page = await open("phone");
    await check("phone: one pane and the bottom bar; an opened item hides the bar and Back closes it", async () => {
      must(await page.locator("[data-bottom-bar]").count(), "no bottom bar");
      await openItem(page, 0);
      must((await page.locator("[data-bottom-bar]").count()) === 0, "the bar stays over the item");
      await shot(page, "phone-item");
      await page.goBack();
      await page.waitForTimeout(1500);
      must(await page.locator("[data-bottom-bar]").count(), "Back did not close the item");
      must(new URL(page.url()).pathname.startsWith("/plugins/orchestrator"), `Back left the page: ${page.url()}`);
    });
    await shot(page, "phone-home");
    await page.context().close();
  }
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks pass`);
if (out) (await import("node:fs")).writeFileSync(`${out}/checks.json`, JSON.stringify(results, null, 1));
process.exit(failed.length ? 1 : 0);
