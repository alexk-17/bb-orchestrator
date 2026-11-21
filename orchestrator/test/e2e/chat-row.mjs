// The project's chat row and its message box in a real browser, against a seeded bb only (live-guard.ts):
//   node test/e2e/chat-row.mjs <base URL> <project slug> [out dir] [--live]
// 1.36.0 regression (2026-11-20, the lead): on desktop, with a project open beside the list, the head (name row, the
// lead's profile card, the chat card) passed its 50% cap. The closed "Chat with lead" row was the one thing left
// to shrink: it went down to 10 px, and its text spilled over the message box. The rule (projects.tsx, 2026-11-17)
// is that an open chat gives up room, its transcript scrolling inside the card, while the name row and the message box
// stay whole. A closed chat row never shrinks below its own height, and past the cap the head scrolls inside itself.
// 1.36.1 (2026-11-20, the lead): with a profile card the head passed its 50% cap at 1440x900 and scrolled, so Send sat
// under the fold, and an open transcript was sized from a constant. Now the whole message box (field, attach, Send)
// must be in the head's visible box, closed and open, at every size. At 1440x900 the head must not scroll at all, and
// the cards below must keep at least a third of the detail.
// The lead's answer (2026-11-20): the idle box sits on one line, like X's collapsed reply, and the focused, expanded box
// must stay in view too, so each size is also checked with words typed in it, closed and open.
// Checked closed, then open, at 1440x900, in a 720 px pane (a 1040 px window less bb's 320 px sidebar) and in a short
// 1440x640 window. It exits 1 on any failure; with an out dir it saves a shot of each.
import { checkBase } from "./live-guard.ts";
const argv = process.argv.slice(2);
const live = argv.includes("--live");
const [given, slug, out] = argv.filter((a) => a !== "--live");
const base = checkBase(given, live);
if (!slug) throw new Error("usage: chat-row.mjs <base URL> <project slug> [out dir] [--live]");
// Playwright loads only after the base passed the guard
const { chromium } = await import("playwright-core");
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const SIZES = { "1440x900": { width: 1440, height: 900 }, "pane720": { width: 1040, height: 900 }, "1440x640": { width: 1440, height: 640 } };
let failed = 0;

const measure = (page) =>
  page.evaluate((s) => {
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    const head = document.querySelector(`[data-chat-toggle="${s}"]`);
    const chat = document.querySelector(`[data-chat="${s}"]`);
    const box = document.querySelector(`[data-composer="${s}"]`);
    const fixed = document.querySelector(`[data-detail-head="${s}"]`);
    if (!head || !chat || !box || !fixed) return { missing: { head: !!head, chat: !!chat, box: !!box, fixed: !!fixed } };
    const [h, c, b, f, d] = [r(head), r(chat), r(box), r(fixed), r(fixed.parentElement)];
    const send = r(document.querySelector(`[data-direct-send="${s}"]`));
    const attach = r(document.querySelector(`[data-direct-attach="${s}"]`));
    const field = r(box.querySelector("textarea"));
    const cards = r(fixed.parentElement.querySelector(":scope > .k-dcards"));
    // what of the box shows: each part inside the head's visible box (and the window)
    const shows = (x) => !!x && x.top >= Math.max(f.top, 0) - 0.5 && x.bottom <= Math.min(f.bottom, innerHeight) + 0.5;
    // a head too tall for a short window scrolls, and the box sticks to the bottom of what shows, over what scrolls
    // under it: then the row must still be reachable, its middle hit with the head scrolled to the top (1.36.0's row
    // under the box took no clicks at all)
    const sticky = getComputedStyle(box).position === "sticky";
    let rowReachable = null;
    if (sticky && fixed.scrollHeight > fixed.clientHeight) {
      const was = fixed.scrollTop;
      fixed.scrollTop = 0;
      const hr = head.getBoundingClientRect();
      rowReachable = head.contains(document.elementFromPoint(hr.left + hr.width / 2, hr.top + hr.height / 2));
      fixed.scrollTop = was;
    }
    // the row's own height: what its content needs (a squeezed button's scrollHeight is still its content's)
    return { sticky, rowReachable, head: Math.round(h.height), headNeeds: head.scrollHeight, chat: Math.round(c.height), gap: Math.round(b.top - h.bottom), fixed: Math.round(f.height), headOver: fixed.scrollHeight - fixed.clientHeight, detail: Math.round(d.height), cards: cards ? Math.round(cards.height) : null, wide: !!fixed.closest("[data-fits-pane]"), boxShows: { field: shows(field), attach: shows(attach), send: shows(send) }, inline: box.hasAttribute("data-inline"), boxH: Math.round(b.height), open: chat.getAttribute("data-open") };
  }, slug);

function judge(m, size) {
  if (m.missing) return [`not on the page: ${JSON.stringify(m.missing)}`];
  const bad = [];
  const hidden = Object.entries(m.boxShows).filter(([, v]) => !v).map(([k]) => k);
  if (hidden.length) bad.push(`the message box isn't whole in the head's visible box: ${hidden.join(", ")} hidden`);
  if (size === "1440x900" && m.wide) {
    if (m.headOver > 1) bad.push(`the head scrolls (${m.headOver}px over) at 1440x900`);
    if (m.cards !== null && m.cards < m.detail / 3 - 4) bad.push(`the cards keep ${m.cards}px, under a third of the detail's ${m.detail}px`);
  }
  if (m.head + 1 < m.headNeeds) bad.push(`the chat row is squeezed: ${m.head}px of the ${m.headNeeds}px it needs`);
  if (m.chat + 1 < m.head) bad.push(`the chat section (${m.chat}px) is shorter than its row (${m.head}px)`);
  if (m.gap < -0.5 && !(m.sticky && m.headOver > 1 && m.rowReachable)) bad.push(`the chat row overlaps the message box by ${-m.gap}px${m.sticky && m.headOver > 1 ? ", and the row can't be reached" : ""}`);
  return bad;
}

for (const [name, viewport] of Object.entries(SIZES)) {
  const ctx = await browser.newContext({ viewport, colorScheme: "light" });
  ctx.setDefaultTimeout(15000);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto(`${base}/plugins/orchestrator/home/projects/@${encodeURIComponent(slug)}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector(`[data-composer="${slug}"]`, { timeout: 120000 });
  await page.waitForTimeout(2500);
  // closed first (a reload may restore it open), then open
  const toggle = page.locator(`[data-chat-toggle="${slug}"]`);
  // a real click: on 1.36.0 the message box covered the row, so the chat could not be opened at all
  const click = () => toggle.click({ timeout: 4000 }).then(() => null, () => "the row can't be clicked: something covers it");
  if ((await toggle.getAttribute("aria-expanded")) === "true") await click();
  const field = page.locator(`[data-composer="${slug}"] textarea`);
  for (const state of ["closed", "closed, typing", "open", "open, typing"]) {
    // typing: the box focused and open to two rows; the words are cleared again before the next state, never sent
    if (state === "open") await field.fill("");
    let blocked = state === "open" ? await click() : null;
    if (state.endsWith("typing")) {
      // a real click where it shows; a field under the fold or covered is a failure, then focused anyway to measure
      blocked = await field.click({ timeout: 4000 }).then(() => null, () => "the field can't be clicked where it is");
      if (blocked) await field.focus();
      await page.keyboard.insertText("Can you ship it behind the flag today?");
    }
    await page.waitForTimeout(800);
    const m = await measure(page);
    const bad = judge(m, name);
    if (blocked) bad.push(blocked);
    // idle (empty, not focused), the box is one line, like X's collapsed reply; typing opens it to two rows
    if (!m.missing && !state.endsWith("typing") && !m.inline) bad.push(`the idle box isn't on one line (${m.boxH}px tall)`);
    if (!m.missing && state.endsWith("typing") && m.inline) bad.push("the focused box stayed on one line");
    const open = state.startsWith("open");
    if (m.open !== (open ? "true" : "false") && !m.missing) bad.push(`expected the chat ${open ? "open" : "closed"}, it is data-open=${m.open}`);
    console.log(`${bad.length ? "FAIL" : "ok  "} ${name} ${state}  ${JSON.stringify(m)}${bad.length ? `\n     ${bad.join("\n     ")}` : ""}`);
    if (bad.length) failed++;
    if (out) await page.screenshot({ path: `${out}/chat-row-${name}-${state.replace(", ", "-")}.png` });
  }
  await field.fill("");
  await ctx.close();
}
await browser.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
