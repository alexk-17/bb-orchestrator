// The rail badge stays live while the page is hidden (2026-11-24). The lag fix paused every change-notice refetch on a
// hidden page; the owner watches the badge from bb's other pages to know something needs the owner, so the badge's reads
// (Needs you, Delivered, Scope) refetch hidden or not, and every other read waits until the page is shown.
// A card arrives on Needs you while the page is hidden: another client brings a deferred card back (/return), the same
// change an agent's new card makes to these reads. The badge must count it without the page being shown, and the page's
// other reads (the board, the config) must not refetch until it is.
//   node test/e2e/hidden-badge.mjs --base <harness URL> --out <dir> [--live]
// It defers and brings back a card for real, so --base is required and the live app is refused (live-guard.ts).
// Headless Chromium keeps every page visible: the hidden state is set in the page (document.visibilityState, its event).
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { checkBase } from "./live-guard.ts";

const { values } = parseArgs({ options: { out: { type: "string" }, base: { type: "string" }, live: { type: "boolean", default: false } } });
const base = checkBase(values.base, values.live);
const out = values.out;
if (!out) throw new Error("--out DIR");
mkdirSync(out, { recursive: true });
const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const write = async (path, body) => {
  const r = await fetch(`${base}/api/v1/plugins/orchestrator/http${path}`, { method: "POST", headers: { "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${path}: ${JSON.stringify(j)}`);
  return j.result;
};
const BADGE = '[aria-label^="Orchestrator, "]';
const needsOf = (label) => Number(/(\d+) in Needs you/.exec(label ?? "")?.[1] ?? 0);

const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const failures = [];
const report = { base, steps: [], failures };
try {
  const p = await (await b.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const reqs = [];
  let cards = [];
  p.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.includes("/orchestrator/rpc/")) reqs.push({ t: Date.now(), m: u.pathname.split("/").pop() });
  });
  p.on("response", async (r) => {
    if (!new URL(r.url()).pathname.endsWith("/rpc/needsYou")) return;
    try {
      const j = await r.json();
      const v = j.result ?? j.data ?? j;
      if (Array.isArray(v?.cards)) cards = v.cards.map((c) => ({ id: c.id, rev: c.rev }));
    } catch {}
  });
  const badgeNeeds = async () => needsOf(await p.locator(BADGE).first().getAttribute("aria-label").catch(() => null));
  const until = async (what, ok, ms = 15_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await ok()) return Date.now() - t0;
      await p.waitForTimeout(50);
    }
    failures.push(`${what}: not within ${ms} ms`);
    return null;
  };
  const setHidden = (h) =>
    p.evaluate((hidden) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event("visibilitychange"));
    }, h);

  await p.goto(`${base}/plugins/orchestrator/home/needs-you`, { waitUntil: "domcontentloaded" });
  await p.locator("[data-card]").first().waitFor({ timeout: 60_000 });
  await until("a needsYou read with cards", async () => cards.length > 0);
  const card = cards.at(-1);
  const start = await badgeNeeds();
  report.steps.push({ step: "loaded", badgeNeeds: start, card: card.id });

  // deferred while shown: off Needs you
  const deferredRev = await write("/defer", { id: card.id, rev: card.rev, preset: "manual", zone: "UTC", via: "desktop" });
  report.steps.push({ step: "deferred (shown)", ms: await until("the badge drops the deferred card", async () => (await badgeNeeds()) === start - 1) });
  await p.waitForTimeout(2_000); // the deferral's own notices are done

  // hidden: the card comes back
  await setHidden(true);
  const t0 = Date.now();
  await write("/return", { id: card.id, rev: deferredRev });
  const ms = await until("the hidden page's badge counts the card that came back", async () => (await badgeNeeds()) === start);
  await p.waitForTimeout(3_000); // later notices (the flush) come too
  const hiddenReads = reqs.filter((r) => r.t >= t0).map((r) => r.m);
  report.steps.push({ step: "card back (hidden)", ms, badgeNeeds: await badgeNeeds(), reads: hiddenReads });
  const BADGE_READS = ["needsYou", "deliverables", "scope"];
  if (!hiddenReads.includes("needsYou")) failures.push("hidden: Needs you was not refetched");
  const others = hiddenReads.filter((m) => !BADGE_READS.includes(m));
  if (others.length) failures.push(`hidden: reads other than the badge's refetched: ${others.join(", ")}`);

  // shown again: the paused reads refetch once (the board shows the card's return)
  const t1 = Date.now();
  await setHidden(false);
  await p.waitForTimeout(2_000);
  const shownReads = reqs.filter((r) => r.t >= t1).map((r) => r.m);
  report.steps.push({ step: "shown again", reads: shownReads });
  if (!shownReads.includes("board")) failures.push("shown: the board did not refetch what it missed");
  await p.screenshot({ path: join(out, "hidden-badge-after-1440.png") });
} finally {
  await b.close();
  writeFileSync(join(out, "hidden-badge.json"), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report));
}
process.exit(failures.length ? 1 : 0);
