// Live proof of the installed plugin: real GitHub RPC, UI, rich clipboard and narrow layout.
// node test/e2e/pr-review-queue.mjs --out /absolute/evidence/directory
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
const { values } = parseArgs({ options: { out: { type: "string" }, base: { type: "string", default: "http://127.0.0.1:38886" }, executable: { type: "string" }, demo: { type: "boolean" } } });
if (!values.out) throw new Error("--out DIR is required");
mkdirSync(values.out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(values.executable ? { executablePath: values.executable } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (values.demo) {
    const basePr = { project: null, lead: null, agent: null, draft: false, review: "review required", approved: false, approvals: "0 approvals", ci: "pass", merge: "mergeable", summary: "", needsReview: true, excluded: false, updatedAt: new Date().toISOString(), candidates: [], repo: "example/widgets", author: "octocat" };
    const prs = [
      { number: 101, title: "Keep shared links readable when pasted into chat", bucket: "needs-review", reviewers: ["alex"], mentions: ["@Alex"] },
      { number: 102, title: "Restore the selected project after refreshing the page", bucket: "needs-rereview", reviewers: ["sam"], mentions: ["@Sam Example"] },
      { number: 103, title: "Show when the last GitHub check completed", bucket: "approved", reviewers: ["lee"], mentions: ["@Lee"], approved: true, review: "approved", approvals: "1 approval" },
    ].map((p) => ({ ...basePr, ...p, url: `https://github.com/example/widgets/pull/${p.number}` }));
    await page.route("**/plugins/orchestrator/rpc/openPrs", (route) => route.fulfill({ json: { ok: true, result: { state: "ok", login: "octocat", notes: [], pollMinutes: 5, channel: null, excluded: [], more: false, fetchedAt: Date.now(), error: null, prs } } }));
  }
  await page.goto(`${values.base}/plugins/orchestrator/home/prs`);
  const tab = page.locator("[data-pr-review-queue]");
  await tab.waitFor({ timeout: 60_000 });
  await tab.locator("[data-review-pr]").first().waitFor({ timeout: 120_000 });
  assert.equal(await tab.locator("[data-review-section]").count(), 3);
  await tab.locator("[data-copy-all]").click();
  await page.waitForFunction(async () => {
    const items = await navigator.clipboard.read();
    return items[0]?.types.includes("text/html") && (await (await items[0].getType("text/plain")).text()).startsWith("Needs a review");
  });
  const clipboard = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return { types: item.types, html: await (await item.getType("text/html")).text(), text: await (await item.getType("text/plain")).text() };
  });
  assert.ok(clipboard.types.includes("text/html") && clipboard.types.includes("text/plain"));
  assert.match(clipboard.html, /<a href="https:\/\/github.com\//);
  assert.match(clipboard.text, /https:\/\/github.com\/.+\/pull\/\d+/);
  assert.ok(!/<https?:\/\/[^>]+\|/.test(clipboard.text));
  const anchorChecks = await page.evaluate((html) => {
    const d = new DOMParser().parseFromString(html, "text/html");
    return [...d.querySelectorAll("a")].map((a) => ({ href: a.getAttribute("href"), label: a.textContent }));
  }, clipboard.html);
  assert.ok(anchorChecks.every((a) => /^https:\/\/github.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(a.href)));
  writeFileSync(join(values.out, "copied.html"), clipboard.html);
  writeFileSync(join(values.out, "copied.txt"), clipboard.text);
  const copiedSections = [];
  for (const section of await tab.locator("[data-review-section]").all()) {
    const button = section.getByRole("button");
    if (!await button.isEnabled()) continue;
    await button.click();
    const title = (await section.locator("h3").innerText()).replace(/\s+\d+$/, "");
    await page.waitForFunction(async (title) => (await navigator.clipboard.readText()).startsWith(title), title);
    copiedSections.push(title);
  }
  const capture = async (width, name) => {
    await page.setViewportSize({ width, height: 1000 });
    // Pane width changes remount content. Fit its full height so nested scrolling doesn't clip the capture.
    await page.waitForTimeout(500);
    const height = await tab.evaluate((el) => el.scrollHeight);
    await page.setViewportSize({ width, height: Math.max(1000, height + 350) });
    await page.waitForTimeout(500);
    await tab.evaluate((el) => { for (let p = el; p; p = p.parentElement) p.scrollTop = 0; });
    await tab.screenshot({ path: join(values.out, name) });
  };
  await capture(1440, "prs-tab.png");
  await capture(430, "prs-tab-narrow.png");
  const overflow = await tab.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  assert.equal(overflow, false, "tab must not overflow at phone width");
  // Denied clipboard permission must show an error instead of success or a plain-text fallback.
  await page.evaluate(() => { navigator.clipboard.write = async () => { throw new Error("permission denied"); }; });
  await tab.locator("[data-copy-all]").click();
  await tab.getByRole("status").filter({ hasText: "Could not copy both formats." }).waitFor();
  assert.deepEqual(errors, []);
  const report = { data: values.demo ? "synthetic example PRs" : "live GitHub", types: clipboard.types, links: anchorChecks.length, copiedSections, errors, narrowOverflow: overflow, clipboardFailure: "visible error", at: new Date().toISOString() };
  writeFileSync(join(values.out, "browser-proof.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
