// The view picker (feel spec part 1, P1–P15) in a real browser, against a seeded bb only (live-guard.ts): node test/e2e/picker.mjs <base URL> [out dir] [--live]
import { checkBase } from "./live-guard.ts";
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const live = argv.includes("--live");
const [given, out] = argv.filter((a) => a !== "--live");
const base = checkBase(given, live);
const PAGE = `${base}/plugins/orchestrator/home`;
// Playwright loads only after the base passed the guard
const { chromium } = await import("playwright-core");
// overlay scrollbars, as on the owner's Mac (hidden until scrolled): the smallest pane's list must still show it has more rows
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-features=OverlayScrollbar"], ignoreDefaultArgs: ["--hide-scrollbars"] });
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
// read-only on the seeded data: a stray press must not answer a shared card (2026-11-20: one did, and broke P12 in panes.mjs)
const writes = [];
let routed = 0;
// Home takes the focus by its header's free space: a press in its list could land on an answer
async function focusHome(page) {
  const h = paneOf(page, "home").locator("[data-pane-header]");
  const b = await h.boundingBox();
  await h.click({ position: { x: Math.round(b.width * 0.55), y: Math.round(b.height / 2) } });
  await page.waitForTimeout(300);
}
async function open(kind = "desktop", { video = null, dark = false } = {}) {
  const ctx = await browser.newContext({ ...VP[kind], colorScheme: dark ? "dark" : "light", ...(video && out ? { recordVideo: { dir: `${out}/video-${video}`, size: VP[kind].viewport } } : {}) });
  contexts.push(ctx);
  await ctx.route(/\/api\/v1\/plugins\/orchestrator\/http\//, (r) => {
    routed++;
    const path = new URL(r.request().url()).pathname;
    if (r.request().method() === "GET" || /\/(feed\/seen|projects\/message-seen)$/.test(path)) return r.continue();
    writes.push(path);
    return r.abort();
  });
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
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${name}.png` });
};
const panes = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-pane]")]
      .filter((p) => p.getBoundingClientRect().width > 0)
      .map((p) => {
        const r = p.getBoundingClientRect();
        return { id: p.getAttribute("data-pane"), view: p.getAttribute("data-pane-view"), focused: p.hasAttribute("data-focused"), x: r.x, y: r.y, w: r.width, h: r.height };
      })
      .sort((a, b) => a.y - b.y || a.x - b.x),
  );
const say = (ps) => ps.map((p) => `${p.view}${p.focused ? "*" : ""}@${Math.round(p.x)},${Math.round(p.y)} ${Math.round(p.w)}x${Math.round(p.h)}`).join(" | ");
async function openBeside(page, view) {
  await page.locator(`[data-page-sidebar] [data-nav="${view}"]`).first().hover();
  await page.locator(`[data-page-sidebar] [data-beside="${view}"]`).first().click();
  await page.waitForTimeout(1200);
}
// the Sidebar as its rail, by its toggle; then a pane beside by Ctrl+click on a rail item (the rail has no Open beside).
// Since 1.37.1 the Sidebar folds only by its toggle: two panes at 1180, or three columns at 1440, need it
async function toRail(page) {
  if (await page.locator("[data-page-sidebar][data-rail]").count()) return;
  await page.locator("[data-sidebar-toggle]").first().click();
  await page.waitForTimeout(800);
}
async function railBeside(page, view) {
  await toRail(page);
  await page.locator(`[data-page-sidebar] [data-nav="${view}"]`).first().click({ modifiers: ["Control"] });
  await page.waitForTimeout(1200);
}
const paneOf = (page, view) => page.locator(`[data-pane][data-pane-view="${view}"]`).first();
const card = (page) => page.locator("[data-view-picker]");
// since 1.40.4 every row stays in the DOM; one the filter leaves out is hidden and disabled
const rowsShown = (page) => page.evaluate(() => [...document.querySelectorAll("[data-picker-row]")].filter((r) => r.getAttribute("data-disabled") !== "true" && getComputedStyle(r).display !== "none").map((r) => r.getAttribute("data-picker-row")));
const state = (page) => page.evaluate(() => ({ layout: localStorage.getItem("orchestrator.layout.v2"), href: location.href, history: history.length }));
/** The one selected row, and what marks it. */
const selection = (page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-picker-row]")];
    const sel = rows.filter((r) => r.getAttribute("data-selected") === "true");
    const enter = rows.filter((r) => {
      const k = r.querySelector("[data-picker-enter]");
      return k && getComputedStyle(k).display !== "none";
    });
    const other = rows.find((r) => r.getAttribute("data-selected") !== "true");
    return {
      n: sel.length,
      id: sel[0]?.getAttribute("data-picker-row") ?? null,
      enter: enter.map((r) => r.getAttribute("data-picker-row")),
      weight: sel[0] ? Number(getComputedStyle(sel[0]).fontWeight) : 0,
      bg: sel[0] ? getComputedStyle(sel[0]).backgroundColor : null,
      otherBg: other ? getComputedStyle(other).backgroundColor : null,
    };
  });
const oneSelected = async (page, where) => {
  const s = await selection(page);
  must(s.n === 1 && s.enter.length === 1 && s.enter[0] === s.id && s.weight >= 500 && s.bg !== s.otherBg, `${where}: ${JSON.stringify(s)}`);
  return s.id;
};
// tag every drawn pane's element, to prove the same DOM nodes survive
const tagAll = (page) => page.evaluate(() => document.querySelectorAll("[data-pane]").forEach((p) => (p.__tag = p.getAttribute("data-pane"))));
const sameNodes = (page, ids) => page.evaluate((ids) => ids.every((id) => document.querySelector(`[data-pane="${id}"]`)?.__tag === id), ids);
const close1 = (a, b) => Math.abs(a - b) <= 0.5;

try {
  // split → picker: P1–P9, P12, P14, the Esc / ✕ / outside cancels, a reload while pending
  {
    const page = await open("desktop", { video: "split-pick" });
    await openBeside(page, "projects");
    // the open Sidebar's own items, in its order, and its places' icons, read before any picker is open (since 1.40.0 every
    // item is a picker row: Home's filters under Home but All, which is Home's own row, a place's sections, then all of Tools)
    const sidebar = await page.evaluate(() => ({
      ids: [...new Set([...document.querySelectorAll("[data-page-sidebar] [data-beside], [data-page-sidebar] [data-tools-group] [data-tool]")].map((b) => b.getAttribute("data-beside") ?? b.getAttribute("data-tool")))].filter((id) => id !== "home/all"),
      main: ["home", "chat", "projects", "open-prs"].map((id) => {
        const b = document.querySelector(`[data-page-sidebar] [data-nav="${id}"]`);
        return { id, label: b?.textContent?.replace(/\d+$/, "").trim(), icon: b?.querySelector("svg")?.getAttribute("class") };
      }),
      tools: [...document.querySelectorAll("[data-page-sidebar] [data-tools-group] [data-tool]")].map((t) => t.getAttribute("data-tool")),
    }));
    await toRail(page);
    await shot(page, "before-two-panes");

    const before = await panes(page);
    const saved = await state(page);
    await tagAll(page);
    const proj = paneOf(page, "projects");
    await check("P1 Split right shows the picker with its field focused, within 2 frames", async () => {
      const r = await page.evaluate(async (id) => {
        document.querySelector(`[data-pane="${id}"] [data-split-right]`).click();
        await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
        const c = document.querySelector("[data-view-picker]");
        return { visible: !!c && Number(getComputedStyle(c).opacity) > 0, opacity: c ? Number(getComputedStyle(c).opacity).toFixed(2) : null, focused: document.activeElement?.matches("[data-picker-input]") ?? false };
      }, before.find((p) => p.view === "projects").id);
      must(r.visible && r.focused, JSON.stringify(r));
      return r;
    });
    await shot(page, "split-picker");
    const pend = (await panes(page)).find((p) => p.view === "projects" && p.x > before[1].x + 10) ?? (await panes(page))[2];
    await check("The new pane is empty with a muted body, headed 'New pane' with a cancel, and it has the focus line; the Sidebar shows no active item", async () => {
      const r = await page.evaluate((id) => {
        const p = document.querySelector(`[data-pane="${id}"]`);
        return {
          title: p.querySelector("[data-pane-title]")?.textContent,
          cancel: !!p.querySelector("[data-cancel-pane]"),
          splits: p.querySelectorAll("[data-split-right], [data-view-control], [data-pane-grip]").length,
          focused: p.hasAttribute("data-focused"),
          active: document.querySelectorAll("[data-page-sidebar] [data-active=true]").length,
        };
      }, pend.id);
      must(r.title === "New pane" && r.cancel && r.splits === 0 && r.focused && r.active === 0, JSON.stringify(r));
      return r;
    });
    await check("P2 The card is centred in the pane body, 16 px or more from every edge", async () => {
      const r = await page.evaluate((id) => {
        const b = document.querySelector(`[data-pane="${id}"] [data-pane-body]`).getBoundingClientRect();
        const c = document.querySelector("[data-view-picker]").getBoundingClientRect();
        return { dx: c.x + c.width / 2 - (b.x + b.width / 2), dy: c.y + c.height / 2 - (b.y + b.height / 2), gaps: [c.x - b.x, b.right - c.right, c.y - b.y, b.bottom - c.bottom].map(Math.round), w: Math.round(c.width) };
      }, pend.id);
      must(Math.abs(r.dx) <= 1 && Math.abs(r.dy) <= 1 && r.gaps.every((g) => g >= 16), JSON.stringify(r));
      return r;
    });
    await check("P4 The rows are the open Sidebar's items in its order (Home's filters, sections, then all of Tools); each place has its label and icon, Tools rows none", async () => {
      const r = await page.evaluate(() =>
        [...document.querySelectorAll("[data-picker-row]")].map((row) => ({ id: row.getAttribute("data-picker-row"), label: row.querySelector(".truncate")?.textContent, icon: row.querySelector("svg:not([data-picker-current])")?.getAttribute("class") ?? null })),
      );
      const lucide = (c) => c?.split(" ").find((x) => x.startsWith("lucide-"));
      must(sidebar.ids.length > 8 && sidebar.tools.length > 0, `the Sidebar read nothing: ${JSON.stringify(sidebar.ids)}`);
      must(JSON.stringify(r.map((x) => x.id)) === JSON.stringify(sidebar.ids), `${r.map((x) => x.id)} ≠ ${sidebar.ids}`);
      for (const m of sidebar.main) {
        const row = r.find((x) => x.id === m.id);
        must(row?.label === m.label && lucide(row?.icon) === lucide(m.icon), `${m.id}: ${JSON.stringify(row)} vs ${JSON.stringify(m)}`);
      }
      must(r.filter((x) => sidebar.tools.includes(x.id)).every((x) => x.icon === null), "a Tools row has an icon");
      return r.map((x) => x.label).join(", ");
    });
    await check("P5 One selected row at every step (open, ↓, ↑, pointer, typing), marked ↵ and medium; it starts on the page split from; the placeholder names the target", async () => {
      const seen = [await oneSelected(page, "open")];
      must(seen[0] === "projects", `starts on ${seen[0]}`);
      await page.keyboard.press("ArrowDown");
      seen.push(await oneSelected(page, "down"));
      await page.keyboard.press("ArrowUp");
      seen.push(await oneSelected(page, "up"));
      await page.locator('[data-picker-row="chat"]').hover();
      await page.waitForTimeout(150);
      seen.push(await oneSelected(page, "pointer"));
      await page.keyboard.type("r");
      seen.push(await oneSelected(page, "typing"));
      const ph = await page.locator("[data-picker-input]").getAttribute("placeholder");
      must(seen.join() === "projects,open-prs,projects,chat," + seen[4] && ph === "Pick a view for the new pane", `${seen} / ${ph}`);
      return seen.join(" → ");
    });
    await check("P3 The card's top edge stays put while typing", async () => {
      await page.locator("[data-picker-input]").fill("");
      await page.waitForTimeout(150);
      const top = async () => (await card(page).boundingBox()).y;
      const t0 = await top();
      await page.keyboard.type("re");
      await page.waitForTimeout(150);
      const t1 = await top();
      await shot(page, "filtered");
      await page.locator("[data-picker-input]").fill("");
      await page.keyboard.type("zzz");
      await page.waitForTimeout(150);
      const t2 = await top();
      must(close1(t0, t1) && close1(t0, t2), `${t0} → ${t1} → ${t2}`);
      return { t0, t1, t2 };
    });
    await check("P9 rev, need and zzz filter as the Sidebar reads; no match says so and Enter does nothing", async () => {
      const q = async (s) => {
        await page.locator("[data-picker-input]").fill(s);
        await page.waitForTimeout(150);
        return rowsShown(page);
      };
      const rev = await q("rev");
      const need = await q("need");
      const needLabel = await page.locator('[data-picker-row="home/needs"]').textContent();
      const zzz = await q("zzz");
      const empty = await card(page).textContent();
      await shot(page, "no-match");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(300);
      const still = await card(page).count();
      must(JSON.stringify(rev) === '["open-prs"]' && JSON.stringify(need) === '["home/needs"]' && /^Needs you/.test(needLabel?.trim() ?? "") && zzz.length === 0 && /No views match\./.test(empty) && still === 1, JSON.stringify({ rev, need, needLabel, zzz, still }));
      await page.locator("[data-picker-input]").fill("");
      return { rev, need, zzz };
    });
    await check("P8 Nothing is written while pending: the saved layout, the URL and the history", async () => {
      const now = await state(page);
      must(now.layout === saved.layout && now.href === saved.href && now.history === saved.history, JSON.stringify({ saved, now }));
    });
    await check("A press on the new pane's own header keeps the picker and puts the focus back in its field", async () => {
      await page.locator(`[data-pane="${pend.id}"] [data-pane-title]`).click();
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => ({ open: !!document.querySelector("[data-view-picker]"), focus: document.activeElement?.matches("[data-picker-input]") }));
      must(r.open && r.focus, JSON.stringify(r));
    });
    await check("A reload while pending shows the layout from before the split", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("[data-orch]");
      await page.waitForTimeout(3000);
      const ps = await panes(page);
      must(ps.length === 2 && !(await card(page).count()), say(ps));
      return say(ps);
    });
    // P7: Esc cancels exactly
    await tagAll(page);
    const p0 = await panes(page);
    const s0 = await state(page);
    await check("P7 Esc cancels the split exactly: the saved layout, every rect, the same DOM nodes, and the focus back on Split right", async () => {
      await paneOf(page, "projects").locator("[data-split-right]").click();
      await page.waitForTimeout(400);
      must(await card(page).count(), "no picker");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      const p1 = await panes(page);
      const s1 = await state(page);
      const same = await sameNodes(page, p0.map((p) => p.id));
      const focus = await page.evaluate(() => document.activeElement?.hasAttribute("data-split-right") && document.activeElement.closest("[data-pane]")?.getAttribute("data-pane-view"));
      must(s1.layout === s0.layout && p1.length === p0.length && p1.every((p, i) => close1(p.x, p0[i].x) && close1(p.y, p0[i].y) && close1(p.w, p0[i].w) && close1(p.h, p0[i].h)), `${say(p0)} → ${say(p1)}`);
      must(same && focus === "projects", JSON.stringify({ same, focus }));
      return say(p1);
    });
    await check("The ✕ on the new pane cancels too, and so does a press in another pane", async () => {
      await paneOf(page, "projects").locator("[data-split-down]").click();
      await page.waitForTimeout(400);
      await page.locator("[data-cancel-pane]").click();
      await page.waitForTimeout(400);
      const a = (await panes(page)).length;
      await paneOf(page, "projects").locator("[data-split-down]").click();
      await page.waitForTimeout(400);
      // a point in Home's body that is no control, so the press can't answer a card
      const blank = await page.evaluate(() => {
        const p = document.querySelector('[data-pane][data-pane-view="home"]');
        const r = p.getBoundingClientRect();
        for (let y = r.top + 80; y < r.bottom - 20; y += 24)
          for (let x = r.left + 20; x < r.right - 20; x += 40) {
            const el = document.elementFromPoint(x, y);
            if (el && p.contains(el) && !el.closest("button, a, input, textarea, label, [role=button], [role=menuitem], [role=checkbox], [data-pane-header], [tabindex]:not([data-pane])")) return { x: x - r.left, y: y - r.top };
          }
        return null;
      });
      must(blank, "no point in Home's body free of controls");
      await paneOf(page, "home").click({ position: blank });
      await page.waitForTimeout(400);
      const b = await panes(page);
      const focusIn = await page.evaluate(() => document.activeElement?.closest("[data-pane]")?.getAttribute("data-pane-view") ?? document.activeElement?.tagName);
      must(a === 2 && b.length === 2 && !(await card(page).count()), `${a}, ${say(b)}`);
      must(b.find((p) => p.view === "home").focused && focusIn !== "projects", `the press in Home lost to the opener: ${say(b)}, focus in ${focusIn}`);
    });
    await check("P12 A Sidebar click while the picker is open is a pick: that page fills the new pane", async () => {
      await paneOf(page, "projects").locator("[data-split-right]").click();
      await page.waitForTimeout(400);
      const pending = (await panes(page)).length;
      await page.locator('[data-page-sidebar] [data-nav="chat"]').first().click();
      await page.waitForTimeout(1200);
      const ps = await panes(page);
      must(pending === 3 && ps.length === 3 && ps[2].view === "chat" && ps[2].focused && ps[1].view === "projects", `${pending}: ${say(ps)}`);
      return say(ps);
    });
    await page.context().close();
  }

  // the Tools menu, IME, Back and a resize while a split waits
  {
    const page = await open("desktop");
    await openBeside(page, "projects");
    await toRail(page);
    const split = async () => {
      await paneOf(page, "projects").locator("[data-split-right]").click();
      await page.waitForTimeout(400);
      must(await card(page).count(), "no picker");
    };
    await check("Esc with the Sidebar's Tools menu open closes the menu, not the picker; a Tools pick there fills the new pane", async () => {
      await split();
      await page.locator('[data-page-sidebar] [data-nav="tools"]').click();
      await page.waitForTimeout(400);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const menu = await page.locator("[data-tools-menu]").count();
      const still = await card(page).count();
      await page.locator('[data-page-sidebar] [data-nav="tools"]').click();
      await page.waitForTimeout(400);
      await page.locator('[data-tools-menu] [data-tool="rules"]').click();
      await page.waitForTimeout(1200);
      const ps = await panes(page);
      must(menu === 0 && still === 1, JSON.stringify({ menu, still }));
      must(ps.length === 3 && ps[2].view === "rules" && ps[2].focused, say(ps));
      await page.locator("[data-pane]").last().locator("[data-close-pane]").click();
      await page.waitForTimeout(600);
      return say(ps);
    });
    await check("Enter while an IME is composing picks nothing", async () => {
      await split();
      await page.evaluate(() => document.querySelector("[data-picker-input]").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
      await page.waitForTimeout(400);
      const r = { open: await card(page).count(), panes: (await panes(page)).length };
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      must(r.open === 1 && r.panes === 3, JSON.stringify(r));
      return r;
    });
    await check("Back while a split waits cancels it first, then goes back in its pane", async () => {
      await page.locator('[data-page-sidebar] [data-nav="chat"]').first().click();
      await page.waitForTimeout(1200);
      const mid = await panes(page);
      await paneOf(page, "chat").locator("[data-split-right]").click();
      await page.waitForTimeout(400);
      await page.goBack();
      await page.waitForTimeout(1500);
      const ps = await panes(page);
      must(mid[1].view === "chat" && !(await card(page).count()) && ps.length === 2 && ps[1].view === "projects", `${say(mid)} → ${say(ps)}`);
      return say(ps);
    });
    await check("A window resize after which the pending pane no longer fits cancels it", async () => {
      await split();
      await page.setViewportSize({ width: 1180, height: 820 });
      await page.waitForTimeout(800);
      const ps = await panes(page);
      const r = { open: await card(page).count(), panes: ps.length, saved: (await state(page)).layout?.length };
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(600);
      must(r.open === 0 && r.panes === 2, `${JSON.stringify(r)} ${say(ps)}`);
      return r;
    });
    await page.context().close();
  }

  // a clean recording: split → type → Enter, split → Esc
  {
    const page = await open("desktop", { video: "split-type-enter" });
    await openBeside(page, "projects");
    await toRail(page);
    await page.waitForTimeout(600);
    await paneOf(page, "projects").locator("[data-split-right]").click();
    await page.waitForTimeout(900);
    await page.keyboard.type("rev", { delay: 180 });
    await page.waitForTimeout(700);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
    await paneOf(page, "home").locator("[data-split-down]").click();
    await page.waitForTimeout(1200);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1200);
    await page.context().close();
  }

  // P6 and P15: keyboard only
  {
    const page = await open("desktop", { video: "keyboard" });
    await openBeside(page, "projects");
    await check("P15 - in a pane opens the picker with its field focused; Esc restores the layout and puts the focus back in that pane", async () => {
      await focusHome(page);
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      const s0 = await state(page);
      const n0 = (await panes(page)).length;
      await page.keyboard.press("-");
      await page.waitForTimeout(400);
      const opened = await page.evaluate(() => document.activeElement?.matches("[data-picker-input]") && document.querySelectorAll("[data-pane]").length);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      const s1 = await state(page);
      const focusIn = await page.evaluate(() => document.activeElement?.closest("[data-pane]")?.getAttribute("data-pane-view"));
      must(opened === n0 + 1 && s1.layout === s0.layout && focusIn === "home" && (await panes(page)).length === n0, JSON.stringify({ opened, n0, focusIn }));
    });
    await check("P9 The page's keys are dead while the picker is open: ? opens no shortcut sheet there (and does when it is closed)", async () => {
      await focusHome(page);
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      const sheet = () => page.locator("[data-key-help]").count();
      await page.keyboard.press("Shift+Slash");
      await page.waitForTimeout(400);
      const closed = await sheet();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      await paneOf(page, "projects").locator("[data-view-control]").click();
      await page.waitForTimeout(300);
      await page.keyboard.press("Shift+Slash");
      await page.waitForTimeout(400);
      const open = await sheet();
      const typed = await page.locator("[data-picker-input]").inputValue();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      must(closed > 0 && open === 0 && typed === "?", JSON.stringify({ closed, open, typed }));
      return { closed, open, typed };
    });
    await check("P9 j with the picker open moves no Home selection: it is typed into the field", async () => {
      // Home's Needs you list is where j and k walk the cards
      await focusHome(page);
      await page.locator('[data-page-sidebar] [data-feed-filter="needs"]').first().click();
      await page.waitForTimeout(1200);
      await focusHome(page);
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      const selected = () => page.evaluate(() => {
        const cards = [...document.querySelectorAll('[data-pane-view="home"] [data-selected=""]')];
        return cards.length ? cards.map((c) => c.textContent.slice(0, 40)).join(",") : null;
      });
      await page.keyboard.press("j");
      await page.waitForTimeout(250);
      await page.keyboard.press("j");
      await page.waitForTimeout(250);
      const before = await selected();
      await paneOf(page, "projects").locator("[data-view-control]").click();
      await page.waitForTimeout(300);
      await page.keyboard.press("j");
      await page.keyboard.press("j");
      await page.waitForTimeout(300);
      const during = await selected();
      const typed = await page.locator("[data-picker-input]").inputValue();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      // back to All on the Home pane (a Sidebar filter acts on the focused pane, which Esc left on Projects)
      await focusHome(page);
      await page.locator('[data-page-sidebar] [data-feed-filter="all"]').first().click();
      await page.waitForTimeout(800);
      must(before !== null && during === before && typed === "jj", JSON.stringify({ before, during, typed }));
      return { before, during, typed };
    });
    await check("P6 Keyboard only: focus Split down, Enter, ↓, Enter fills the new pane with the row selected (Reviews)", async () => {
      await paneOf(page, "projects").locator("[data-split-down]").focus();
      await page.keyboard.press("Enter");
      await page.waitForTimeout(400);
      await page.keyboard.press("ArrowDown");
      const sel = (await selection(page)).id;
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1200);
      const ps = await panes(page);
      const focusIn = await page.evaluate(() => document.activeElement?.closest("[data-pane]")?.getAttribute("data-pane-view"));
      must(sel === "open-prs" && ps.length === 3 && ps[2].view === "open-prs" && ps[2].focused && focusIn === "open-prs", `${sel}: ${say(ps)}, focus in ${focusIn}`);
      return say(ps);
    });
    await page.context().close();
  }

  // change in place: P10, P11
  {
    const page = await open("desktop", { video: "change-view" });
    await openBeside(page, "projects");
    await check("P11 Every pane header holds the view control, focused or not: a bordered button with an icon and a chevron, named 'Change view, now …'", async () => {
      const r = await page.evaluate(() =>
        [...document.querySelectorAll("[data-pane]")].map((p) => {
          const b = p.querySelector("[data-view-control]");
          return { focused: p.hasAttribute("data-focused"), tag: b?.tagName, border: b ? parseFloat(getComputedStyle(b).borderTopWidth) : 0, svgs: b?.querySelectorAll("svg").length ?? 0, name: b?.getAttribute("aria-label"), color: b ? getComputedStyle(b.querySelector("[data-pane-title]")).color : null };
        }),
      );
      must(r.length === 2 && r.every((x) => x.tag === "BUTTON" && x.border >= 1 && x.svgs === 2 && /^Change view, now /.test(x.name)), JSON.stringify(r));
      must(r[0].color !== r[1].color, "focused and unfocused labels look the same");
      return r.map((x) => x.name);
    });
    await shot(page, "header-controls");
    await tagAll(page);
    const p0 = await panes(page);
    const h0 = (await state(page)).history;
    await check("P10 Change view on the Home pane: Chat replaces it in place (same pane, same rect), the other pane untouched, one Back step", async () => {
      await paneOf(page, "home").locator("[data-view-control]").click();
      await page.waitForTimeout(400);
      const r0 = await page.evaluate(() => ({
        mode: document.querySelector("[data-view-picker]")?.getAttribute("data-view-picker"),
        check: document.querySelector("[data-picker-current]")?.closest("[data-picker-row]")?.getAttribute("data-picker-row"),
        sel: document.querySelector('[data-picker-row][data-selected="true"]')?.getAttribute("data-picker-row"),
        placeholder: document.querySelector("[data-picker-input]")?.getAttribute("placeholder"),
        under: !!document.querySelector('[data-pane-view="home"] [data-feed]'),
      }));
      await shot(page, "change-view");
      must(r0.mode === "change" && r0.check === "home" && r0.sel === "home" && r0.placeholder === "Change this pane's view" && r0.under, JSON.stringify(r0));
      await page.locator('[data-picker-row="chat"]').click();
      await page.waitForTimeout(1200);
      const p1 = await panes(page);
      const changed = p1.find((p) => p.id === p0[0].id);
      const other = p1.find((p) => p.id === p0[1].id);
      const h1 = (await state(page)).history;
      must(changed.view === "chat" && changed.focused && close1(changed.x, p0[0].x) && close1(changed.w, p0[0].w) && close1(changed.h, p0[0].h), say(p1));
      must(close1(other.x, p0[1].x) && close1(other.w, p0[1].w) && (await sameNodes(page, [p0[0].id, p0[1].id])) && h1 === h0 + 1, `${say(p1)}, history ${h0} → ${h1}`);
      await page.goBack();
      await page.waitForTimeout(1500);
      const p2 = await panes(page);
      must(p2.find((p) => p.id === p0[0].id)?.view === "home", `after Back: ${say(p2)}`);
      return say(p1);
    });
    await check("A second click on the control closes the picker; Esc closes it with the pane unchanged", async () => {
      const ctl = paneOf(page, "projects").locator("[data-view-control]");
      await ctl.click();
      await page.waitForTimeout(300);
      const a = await card(page).count();
      await ctl.click();
      await page.waitForTimeout(300);
      const b = await card(page).count();
      await ctl.click();
      await page.waitForTimeout(300);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const c = await card(page).count();
      const view = await page.locator("[data-pane]").nth(1).getAttribute("data-pane-view");
      must(a === 1 && b === 0 && c === 0 && view === "projects", JSON.stringify({ a, b, c, view }));
    });
    await check("A press in another pane's text field closes a change picker and keeps the focus in that field", async () => {
      await page.locator("[data-pane]").first().locator("[data-view-control]").click();
      await page.waitForTimeout(400);
      const field = paneOf(page, "projects").locator("input").first();
      await field.click();
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => ({ open: !!document.querySelector("[data-view-picker]"), tag: document.activeElement?.tagName, inProjects: !!document.activeElement?.closest('[data-pane-view="projects"]') }));
      must(!r.open && r.tag === "INPUT" && r.inProjects, JSON.stringify(r));
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      return r;
    });
    await check("P11 At a 320 px pane nothing in the header is clipped; P2 the picker fits a 320 px pane with 16 px to each edge", async () => {
      const sep = page.locator("[data-panes] [role=separator]").first();
      const b = await sep.boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + 300);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + b.width / 2 - 60 * i, b.y + 300);
      await page.mouse.up();
      await page.waitForTimeout(600);
      const ps = await panes(page);
      const r = await page.evaluate((id) => {
        const h = document.querySelector(`[data-pane="${id}"] [data-pane-header]`);
        const hr = h.getBoundingClientRect();
        const kids = [...h.querySelectorAll("button, [data-pane-grip]")].map((k) => k.getBoundingClientRect());
        return { scroll: h.scrollWidth, client: h.clientWidth, inside: kids.every((k) => k.left >= hr.left - 0.5 && k.right <= hr.right + 0.5) };
      }, ps[0].id);
      must(Math.round(ps[0].w) <= 321 && r.scroll <= r.client && r.inside, `${say(ps)} ${JSON.stringify(r)}`);
      await page.locator("[data-pane]").first().locator("[data-view-control]").click();
      await page.waitForTimeout(400);
      const g = await page.evaluate((id) => {
        const b = document.querySelector(`[data-pane="${id}"] [data-pane-body]`).getBoundingClientRect();
        const c = document.querySelector("[data-view-picker]").getBoundingClientRect();
        return { w: Math.round(c.width), gaps: [c.x - b.x, b.right - c.right, c.y - b.y, b.bottom - c.bottom].map(Math.round) };
      }, ps[0].id);
      await shot(page, "min-pane-picker");
      await page.keyboard.press("Escape");
      must(g.w === Math.round(ps[0].w) - 32 && g.gaps.every((x) => x >= 16), JSON.stringify(g));
      return g;
    });
    await check("P2 In a 320 × 240 pane the card is 288 wide, 16 px clear of every edge, and has no footer; the list shows its scrollbar", async () => {
      const narrow = (await panes(page))[0];
      await page.locator(`[data-pane="${narrow.id}"] [data-split-down]`).click();
      await page.waitForTimeout(400);
      await page.locator('[data-picker-row="chat"]').click();
      await page.waitForTimeout(1200);
      const sep = page.locator('[data-panes] [role=separator][aria-orientation=horizontal]').first();
      const b = await sep.boundingBox();
      await page.mouse.move(b.x + b.width / 2 + 40, b.y + b.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + b.width / 2 + 40, b.y + b.height / 2 + 50 * i);
      await page.mouse.up();
      await page.waitForTimeout(600);
      const small = (await panes(page)).find((p) => p.view === "chat");
      await page.locator(`[data-pane="${small.id}"] [data-view-control]`).click();
      await page.waitForTimeout(500);
      const g = await page.evaluate((id) => {
        const b = document.querySelector(`[data-pane="${id}"] [data-pane-body]`).getBoundingClientRect();
        const c = document.querySelector("[data-view-picker]").getBoundingClientRect();
        const f = document.querySelector("[data-picker-footer]");
        const l = document.querySelector("[data-view-picker] [cmdk-list]");
        return { pane: [Math.round(b.width), Math.round(b.height)], card: [Math.round(c.width), Math.round(c.height)], gaps: [c.x - b.x, b.right - c.right, c.y - b.y, b.bottom - c.bottom].map(Math.round), footer: f ? getComputedStyle(f).display : "none", overflows: l.scrollHeight > l.clientHeight, scrollbar: l.offsetWidth - l.clientWidth };
      }, small.id);
      await shot(page, "smallest-pane-picker");
      await page.keyboard.press("Escape");
      must(Math.round(small.w) <= 321 && Math.round(small.h) <= 241, `pane ${Math.round(small.w)}×${Math.round(small.h)}`);
      must(g.card[0] === 288 && g.gaps.every((x) => x >= 16) && g.footer === "none", JSON.stringify(g));
      must(g.overflows && g.scrollbar >= 8, `the list hides that it has more rows: ${JSON.stringify(g)}`);
      return g;
    });
    await page.context().close();
  }

  // P14: the picker's first frame, against the same run's baselines
  {
    const page = await open("desktop");
    await openBeside(page, "projects");
    await toRail(page);
    // long tasks from the click to the first frame that draws the picker, read at that frame
    const long = (js) =>
      page.evaluate(async (js) => {
        const l = [];
        const po = new PerformanceObserver((x) => x.getEntries().forEach((e) => l.push(Math.round(e.duration))));
        po.observe({ type: "longtask" });
        await new Promise((o) => setTimeout(o, 600));
        const idle = [...l];
        l.length = 0;
        const t0 = performance.now();
        const had = !!document.querySelector("[data-view-picker]");
        new Function(js)();
        // to the first frame that draws a picker (it may mount a frame after the split), else two frames
        let frames = 0;
        await new Promise((o) => {
          const tick = () => {
            frames++;
            if ((had || document.querySelector("[data-view-picker]") || frames >= 30) && frames >= 2) o();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        await new Promise((o) => requestAnimationFrame(o));
        po.takeRecords().forEach((e) => l.push(Math.round(e.duration)));
        po.disconnect();
        return { idle, during: l, frames, ms: Math.round(performance.now() - t0) };
      }, js);
    const esc = async () => {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    };
    await check("P14 No long task over 50 ms from the click to the picker's first frame, beyond the idle baseline (with a focus change and an Open beside of the same pane measured for comparison)", async () => {
      const change = [], splitM = [], focus = [];
      for (let i = 0; i < 3; i++) {
        focus.push(await long(`document.querySelector('[data-pane-view="${i % 2 ? "home" : "projects"}"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`));
        change.push(await long(`document.querySelector('[data-pane-view="home"] [data-view-control]').click()`));
        await esc();
        splitM.push(await long(`document.querySelector('[data-pane-view="projects"] [data-split-right]').click()`));
        await esc();
      }
      // Open beside, as the rail does it: Ctrl+click on Chat
      const beside = await long(`document.querySelector('[data-page-sidebar] [data-nav="chat"]').dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }))`);
      const worst = (xs) => Math.max(0, ...xs.flatMap((x) => x.during));
      const idle = Math.max(0, ...[...change, ...splitM, ...focus].flatMap((x) => x.idle));
      const r = { idle, focusChange: worst(focus), changeCold: worst(change.slice(0, 1)), change: worst(change.slice(1)), splitCold: worst(splitM.slice(0, 1)), split: worst(splitM.slice(1)), openBeside: worst([beside]), runs: { change, split: splitM, focus, beside } };
      if (out) writeFileSync(`${out}/p14.json`, JSON.stringify(r, null, 1));
      must([r.changeCold, r.change, r.splitCold, r.split].every((x) => x <= Math.max(50, idle)), JSON.stringify(r));
      return r;
    });
    await page.context().close();
  }

  // dark, and 1180
  {
    const page = await open("desktop", { dark: true });
    await openBeside(page, "projects");
    await toRail(page);
    await paneOf(page, "projects").locator("[data-split-right]").click();
    await page.waitForTimeout(500);
    await shot(page, "split-picker-dark");
    await check("Dark P5: one selected row, marked ↵ and medium, its background unlike the others'", async () => {
      await oneSelected(page, "dark open");
      await page.keyboard.press("ArrowDown");
      return oneSelected(page, "dark down");
    });
    await check("Dark: the card is drawn in the popover colour, not white", async () => {
      const bg = await card(page).evaluate((c) => getComputedStyle(c).backgroundColor);
      const dark = await page.evaluate(() => document.documentElement.classList.contains("dark") || matchMedia("(prefers-color-scheme: dark)").matches);
      must(dark && bg !== "rgb(255, 255, 255)", `${bg}, dark ${dark}`);
      return bg;
    });
    await check("Dark P11: each pane's view control is a bordered button with an icon and a chevron", async () => {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => [...document.querySelectorAll("[data-view-control]")].map((b) => ({ border: parseFloat(getComputedStyle(b).borderTopWidth), color: getComputedStyle(b).borderTopColor, svgs: b.querySelectorAll("svg").length })));
      must(r.length === 2 && r.every((x) => x.border >= 1 && x.svgs === 2), JSON.stringify(r));
      return r;
    });
    await page.context().close();
  }
  {
    const page = await open("tablet");
    await railBeside(page, "projects");
    await check("1180: Split down opens the picker in the new pane; a pick fills it", async () => {
      await paneOf(page, "projects").locator("[data-split-down]").click();
      await page.waitForTimeout(500);
      const opened = await card(page).count();
      await shot(page, "tablet-picker");
      await page.locator('[data-picker-row="chat"]').click();
      await page.waitForTimeout(1200);
      const ps = await panes(page);
      must(opened === 1 && ps.length === 3 && ps.some((p) => p.view === "chat" && p.focused), say(ps));
      return say(ps);
    });
    await page.context().close();
  }

  // P13: not on a phone, nor in the one-at-a-time switcher
  {
    const page = await open("phone");
    await check("P13 Phone: no view control, no picker", async () => {
      await page.keyboard.press("\\");
      await page.waitForTimeout(300);
      must(!(await page.locator("[data-view-control], [data-view-picker]").count()), "a control or picker on a phone");
    });
    await page.context().close();
  }
  {
    const page = await open("desktop");
    await openBeside(page, "projects");
    await openBeside(page, "chat");
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.waitForTimeout(800);
    await openBeside(page, "home");
    await page.waitForTimeout(500);
    await check("P13 One at a time (the switcher): no view control, no picker", async () => {
      const sw = await page.locator("[data-pane-switcher]").count();
      must(sw === 1, `no switcher (${say(await panes(page))})`);
      must(!(await page.locator("[data-view-control], [data-view-picker]").count()), "a control or picker in the switcher");
    });
    await page.context().close();
  }
  await check("Read-only: no answer, defer or other owner write left the page", async () => {
    must(routed > 0 && !writes.length, `${routed} routed; writes: ${writes.join(", ")}`);
    return { routed };
  });
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks pass`);
if (out) (await import("node:fs")).writeFileSync(`${out}/checks.json`, JSON.stringify(results, null, 1));
process.exit(failed.length ? 1 : 0);
