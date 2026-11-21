// The dividers (1.34.1: a gutter and a grip) in a real browser, against a seeded bb only (live-guard.ts): node test/e2e/dividers.mjs <base URL> [out dir] [--live]
import { checkBase } from "./live-guard.ts";
import { writeFileSync } from "node:fs";
import * as F from "./frames.mjs";
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
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${name}.png` });
};
const panes = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-pane]")]
      .filter((p) => p.getBoundingClientRect().width > 0)
      .map((p) => {
        const r = p.getBoundingClientRect();
        return { view: p.getAttribute("data-pane-view"), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      })
      .sort((a, b) => a.y - b.y || a.x - b.x),
  );
const say = (ps) => ps.map((p) => `${p.view}@${p.x},${p.y} ${p.w}x${p.h}`).join(" | ");
async function openBeside(page, view) {
  await page.locator(`[data-page-sidebar] [data-nav="${view}"]`).first().hover();
  await page.locator(`[data-page-sidebar] [data-beside="${view}"]`).first().click();
  await page.waitForTimeout(1200);
}
// at 1180 a second pane fits only beside the rail (since 1.37.1 the Sidebar folds into it only by its toggle)
async function railBeside(page, view) {
  if (!(await page.locator("[data-page-sidebar][data-rail]").count())) {
    await page.locator("[data-sidebar-toggle]").first().click();
    await page.waitForTimeout(800);
  }
  await page.locator(`[data-page-sidebar] [data-nav="${view}"]`).first().click({ modifiers: ["Control"] });
  await page.waitForTimeout(1200);
}
/** The divider's look, read from the page: its box, fills, its centre line and its grip. */
const look = (page, nth = 0) =>
  page.evaluate((n) => {
    const d = document.querySelectorAll("[data-panes] [data-divider]")[n];
    if (!d) return null;
    const r = d.getBoundingClientRect();
    const cs = getComputedStyle(d);
    const line = getComputedStyle(d, "::before");
    const g = d.querySelector(":scope > div");
    const gr = g?.getBoundingClientRect();
    const probe = document.createElement("div");
    probe.className = "border-border bg-border";
    document.body.append(probe);
    const border = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      state: d.getAttribute("data-separator"),
      w: Math.round(r.width),
      h: Math.round(r.height),
      fill: cs.backgroundColor,
      border,
      line: line.backgroundColor,
      grip: gr ? { w: Math.round(gr.width), h: Math.round(gr.height), cx: Math.round(gr.x + gr.width / 2 - r.x - r.width / 2), cy: Math.round(gr.y + gr.height / 2 - r.y - r.height / 2), fill: getComputedStyle(g).backgroundColor, visible: getComputedStyle(g).visibility === "visible" && Number(getComputedStyle(g).opacity) > 0.5 } : null,
    };
  }, nth);
const clear = (c) => !c || c === "rgba(0, 0, 0, 0)" || c === "transparent";
const smooth = {};
const save = () => out && writeFileSync(`${out}/smooth.json`, JSON.stringify(smooth, null, 1));

try {
  {
    const page = await open("desktop", { video: "divider-drag" });
    await openBeside(page, "projects");
    await shot(page, "rest");
    await check("Two panes stand apart on an 8 px muted gutter, not touching", async () => {
      const ps = await panes(page);
      const l = await look(page);
      const gap = ps[1].x - (ps[0].x + ps[0].w);
      must(ps.length === 2 && l, `${say(ps)}, divider ${JSON.stringify(l)}`);
      must(l.w === 8 && gap >= 8, `gutter ${l.w} px, gap ${gap} px`);
      must(!clear(l.fill) && l.fill !== l.border, `fill ${l.fill} (border ${l.border})`);
      return { gutter: l.w, gap, fill: l.fill };
    });
    await check("The grip is shown on the divider at rest: shadcn's 12 × 16, centred, not the bare border line", async () => {
      const l = await look(page);
      must(l.grip && l.grip.visible && l.grip.w >= 10 && l.grip.h >= 14, `grip ${JSON.stringify(l.grip)}`);
      must(Math.abs(l.grip.cx) <= 1 && Math.abs(l.grip.cy) <= 1, `off centre ${l.grip.cx},${l.grip.cy}`);
      return l.grip;
    });
    const d = page.locator("[data-panes] [data-divider]").first();
    await check("Hover lights the gutter: accent fill, a centre line in the primary colour, the resize cursor", async () => {
      const rest = await look(page);
      const b = await d.boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + 200);
      await page.waitForTimeout(250);
      const h = await look(page);
      const cursor = await page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)).cursor + "/" + getComputedStyle(document.body).cursor, [b.x + b.width / 2, b.y + 200]);
      must(h.state === "hover", `state ${h.state}`);
      must(h.fill !== rest.fill && !clear(h.line), `fill ${rest.fill} → ${h.fill}, line ${h.line}`);
      must(/ew-resize|col-resize/.test(cursor), `cursor ${cursor}`);
      return { fill: h.fill, line: h.line, cursor };
    });
    await shot(page, "hover");
    // a real pointer drag from 3 px left of, on, and 3 px right of the centre line: each moves the divider
    for (const [off, dx] of [[-3, -80], [0, 120], [3, -80]]) {
      await check(`A mouse drag starting ${off} px from the line moves the divider`, async () => {
        const b = await d.boundingBox();
        const x0 = b.x + b.width / 2 + off;
        const before = (await panes(page))[0].w;
        await page.mouse.move(10, 600);
        await page.waitForTimeout(200);
        const rest = await look(page);
        await page.mouse.move(x0, b.y + 300);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + (dx * i) / 8, b.y + 300);
        const mid = await look(page);
        if (off === 0) await shot(page, "dragging");
        await page.mouse.up();
        await page.waitForTimeout(500);
        const after = (await panes(page))[0].w;
        must(Math.abs(after - before - dx) <= 12, `Home ${before} → ${after}, wanted ${dx > 0 ? "+" : ""}${dx}`);
        must(mid.state === "active" && !clear(mid.line), `while dragging: ${mid.state}, line ${mid.line}`);
        must(mid.grip.fill !== rest.grip.fill, `grip not lit: ${rest.grip.fill} → ${mid.grip.fill}`);
        return { before, after, grip: mid.grip.fill };
      });
    }
    await check("A2 The divider answers within 150 ms: the hover look (centre line and grip) in the first frame that shows it, and the resize cursor 5 px either side of the centre", async () => {
      await page.mouse.move(10, 600);
      await page.waitForTimeout(400);
      const b = await d.boundingBox();
      const cx = b.x + b.width / 2;
      await page.evaluate(() => {
        const d = document.querySelector("[data-panes] [data-divider]");
        const g = d.querySelector(":scope > div");
        const rest = getComputedStyle(g).backgroundColor;
        const w = { move: null, lit: null };
        window.__a2 = w;
        window.addEventListener("pointermove", (e) => (w.move ??= e.timeStamp), { capture: true, once: true });
        const tick = (t) => {
          if (w.move !== null && d.getAttribute("data-separator") === "hover" && getComputedStyle(g).backgroundColor !== rest && getComputedStyle(d, "::before").backgroundColor !== "rgba(0, 0, 0, 0)") return void (w.lit = t);
          if (performance.now() - (w.move ?? performance.now()) < 1000) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await page.mouse.move(cx, b.y + 260);
      await page.waitForTimeout(400);
      const w = await page.evaluate(() => window.__a2);
      const ms = w.lit !== null && w.move !== null ? Math.round(w.lit - w.move) : null;
      const cursors = [];
      for (const off of [-5, 5]) {
        await page.mouse.move(cx + off, b.y + 300);
        await page.waitForTimeout(150);
        cursors.push(await page.evaluate(([x, y]) => `${getComputedStyle(document.elementFromPoint(x, y)).cursor}/${getComputedStyle(document.body).cursor}`, [cx + off, b.y + 300]));
      }
      smooth.a2 = { hoverLookMs: ms, cursors };
      must(ms !== null && ms <= 150 && cursors.every((c) => /ew-resize|col-resize/.test(c)), JSON.stringify(smooth.a2));
      return smooth.a2;
    });
    await check("S10 The divider tracks the pointer: the pane edge within 1 px of it in the frame after each move (between the minimums); frame gaps at most 2 × the idle baseline", async () => {
      await page.mouse.move(10, 600);
      await page.waitForTimeout(300);
      smooth.idle = await F.idle(page);
      const b = await d.boundingBox();
      const [x0, y] = [b.x + b.width / 2, b.y + 320];
      // the frame's own layout (slot) and, after the page's ResizeObserver placed the panes, the pane drawn over it
      await page.evaluate(() => {
        const w = { ro: [] };
        window.__s10 = w;
        const left = () => document.querySelector("[data-panes] [data-pane-slot]");
        w.obs = new ResizeObserver(() => {
          const s = left();
          const p = s && document.querySelector(`[data-pane="${CSS.escape(s.getAttribute("data-pane-slot"))}"]`);
          if (s && p) w.ro.push({ t: performance.now(), slot: s.getBoundingClientRect().right, pane: p.getBoundingClientRect().right });
        });
        document.querySelectorAll("[data-panes] [data-pane-slot]").forEach((s) => w.obs.observe(s));
      });
      const p0 = await page.evaluate(() => document.querySelector("[data-panes] [data-pane]:not([style*='display: none'])")?.getBoundingClientRect().right);
      await F.start(page);
      await page.mouse.move(x0, y);
      await page.mouse.down();
      await F.path(page, F.through([[x0, y], [x0 - 220, y], [x0 + 260, y], [x0 + 40, y]], 40));
      await page.mouse.up();
      await page.waitForTimeout(300);
      const rec = await F.stop(page);
      const ro = await page.evaluate(() => {
        window.__s10.obs.disconnect();
        return window.__s10.ro;
      });
      const up = rec.ups.at(-1);
      const moves = rec.moves.filter((m) => m.t <= up);
      const first = moves[0];
      const box = await page.evaluate(() => document.querySelector("[data-panes]").getBoundingClientRect().toJSON());
      // the left pane's right edge where the pointer says it should be, if both panes stay at 320 or more
      const want = (m) => p0 + (m.x - first.x);
      const inRange = (e) => e - box.left >= 320 + 0.5 && box.right - e - 8 >= 320 + 0.5;
      const frames = rec.frames.filter((f) => f.t > first.t && f.t <= up);
      const misses = [];
      let n = 0;
      for (const f of frames) {
        const m = moves.filter((x) => x.t < f.t).at(-1);
        const next = rec.frames.find((g) => g.t > f.t);
        // the pane as drawn in this frame: after the page's ResizeObserver ran, before the next frame
        const drawn = ro.filter((r) => r.t >= f.t && (!next || r.t < next.t)).at(-1);
        const edge = drawn?.pane ?? f.panes.slice().sort((a, b) => a.rect.x - b.rect.x)[0].rect.x + f.panes.slice().sort((a, b) => a.rect.x - b.rect.x)[0].rect.w;
        if (!m || !inRange(want(m))) continue;
        n++;
        if (Math.abs(edge - want(m)) > 1) misses.push({ t: Math.round(f.t - first.t), want: Math.round(want(m)), edge: Math.round(edge) });
      }
      const gaps = F.summary(F.gapsOf(rec.frames, first.t, up));
      const long = rec.long.filter((l) => l.t >= first.t && l.t <= up);
      smooth.s10 = { frames: n, misses: misses.length, sample: misses.slice(0, 5), slotEqualsPane: ro.every((r) => Math.abs(r.slot - r.pane) <= 0.5), gaps, idle: smooth.idle, long };
      must(n > 20 && !misses.length && smooth.s10.slotEqualsPane && gaps.p95 <= Math.max(2 * smooth.idle.p95, 17.5) && gaps.max <= 50, JSON.stringify(smooth.s10));
      return { frames: n, misses: misses.length, gaps, idle: smooth.idle, long: long.length };
    });
    await check("The resize cursor without a page-wide rule: none on hover or in a drag; past the minimum a layer keeps the resize cursor; it goes at the release, a press makes none, and the next click reaches a pane", async () => {
      const rules = () => page.evaluate(() => document.adoptedStyleSheets.flatMap((x) => [...x.cssRules].map((r) => r.cssText)).filter((t) => /cursor/.test(t)));
      const covers = () => page.locator("[data-resize-cover]").count();
      const b = await d.boundingBox();
      const [cx, y] = [b.x + b.width / 2, b.y + 300];
      await page.mouse.move(cx, y);
      await page.waitForTimeout(200);
      const hover = await rules();
      await page.mouse.down();
      await page.mouse.move(cx - 40, y, { steps: 4 });
      const box = await page.evaluate(() => document.querySelector("[data-panes]").getBoundingClientRect().toJSON());
      // past the left pane's minimum the divider stops and the pointer leaves it
      await page.mouse.move(box.left + 60, y, { steps: 8 });
      await page.waitForTimeout(150);
      const during = { rules: await rules(), covers: await covers(), cursor: await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return `${el?.hasAttribute("data-resize-cover") ? "cover" : el?.tagName}:${el && getComputedStyle(el).cursor}`; }, [box.left + 60, y]) };
      await page.mouse.up();
      await page.waitForTimeout(200);
      const afterUp = await covers();
      const b2 = await d.boundingBox();
      await page.mouse.move(b2.x + b2.width / 2, y);
      await page.mouse.down();
      await page.waitForTimeout(150);
      const pressed = await covers();
      await page.mouse.up();
      await page.waitForTimeout(150);
      const reach = await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest("[data-pane]"), [box.left + 150, box.top + 120]);
      const r = { hover, during, afterUp, pressed, afterPress: await covers(), reach };
      // back to the even split for the checks after this one
      await page.mouse.dblclick(b2.x + b2.width / 2, y);
      await page.waitForTimeout(400);
      must(!hover.length && !during.rules.length && during.covers === 1 && /^cover:col-resize$/.test(during.cursor) && !afterUp && !pressed && !r.afterPress && reach, JSON.stringify(r));
      return r;
    });
    save();
    await check("A drag leaves no text selected", async () => {
      const sel = await page.evaluate(() => String(getSelection()).trim());
      must(sel === "", `selected: ${sel.slice(0, 60)}`);
    });
    await check("Double-click on the gutter makes the two panes equal", async () => {
      const b = await d.boundingBox();
      await page.mouse.dblclick(b.x + b.width / 2, b.y + 300);
      await page.waitForTimeout(500);
      const ps = await panes(page);
      must(Math.abs(ps[0].w - ps[1].w) <= 4, say(ps));
      return say(ps);
    });
    await check("Split down: a stacked gutter, 8 px high, its grip turned, panes apart", async () => {
      await page.locator("[data-pane]").nth(1).locator("[data-split-down]").click();
      await page.waitForTimeout(1200);
      const ps = await panes(page);
      const n = await page.locator("[data-panes] [data-divider]").count();
      const looks = await Promise.all([...Array(n).keys()].map((i) => look(page, i)));
      const flat = looks.find((x) => x.h === 8 && x.w > 100);
      const [top, bottom] = ps.filter((p) => p.x === ps[ps.length - 1].x);
      must(flat && flat.grip && flat.grip.w > flat.grip.h, `stacked divider ${JSON.stringify(looks)}`);
      must(bottom.y - (top.y + top.h) >= 8, say(ps));
      return say(ps);
    });
    await check("The side-by-side divider's grip moves off the junction with the stacked gutter, to the middle of its longer free stretch", async () => {
      const r = await page.evaluate(() => {
        const ds = [...document.querySelectorAll("[data-panes] [data-divider]")].map((d) => ({ d, r: d.getBoundingClientRect() }));
        const tall = ds.find((x) => x.r.height > x.r.width);
        const flat = ds.find((x) => x.r.width > x.r.height);
        const g = tall?.d.querySelector(":scope > div")?.getBoundingClientRect();
        if (!tall || !flat || !g) return null;
        const gy = g.y + g.height / 2;
        const jy = flat.r.y + flat.r.height / 2;
        return { grip: Math.round(gy - tall.r.y), junction: Math.round(jy - tall.r.y), length: Math.round(tall.r.height), apart: Math.round(Math.abs(gy - jy)) };
      });
      // even split: the junction at the middle, so the grip goes to the middle of the upper half
      must(r && r.apart >= 24 && Math.abs(r.grip - r.length / 4) <= 8, JSON.stringify(r));
      return r;
    });
    await shot(page, "stacked");
    await page.context().close();
  }
  {
    const page = await open("tablet");
    await railBeside(page, "projects");
    await check("1180 touch: a finger 10 px off the line drags the divider (24 px hit area)", async () => {
      const b = await page.locator("[data-panes] [data-divider]").first().boundingBox();
      const before = (await panes(page)).map((p) => p.w);
      const cdp = await page.context().newCDPSession(page);
      const y = b.y + 300;
      const touch = (type, x) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
      const x0 = b.x + b.width / 2 + 10;
      await touch("touchStart", x0);
      for (let i = 1; i <= 6; i++) await touch("touchMove", x0 + 12 * i);
      await touch("touchEnd");
      await page.waitForTimeout(600);
      const after = (await panes(page)).map((p) => p.w);
      must(after[0] > before[0] + 30, `${before} → ${after}`);
      must(after.every((w) => w >= 319), `a pane under 320: ${after}`);
      return { before, after };
    });
    await page.context().close();
  }
  {
    const page = await open("phone");
    await check("Phone: no divider, the bottom bar as before", async () => {
      must(!(await page.locator("[data-divider]").count()), "a divider on a phone");
      must(await page.locator("[data-bottom-bar]").count(), "no bottom bar");
    });
    await page.context().close();
  }
} finally {
  for (const c of contexts) await c.close().catch(() => {});
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks pass`);
save();
if (out) writeFileSync(`${out}/checks.json`, JSON.stringify(results, null, 1));
process.exit(failed.length ? 1 : 0);
