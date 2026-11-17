// Live installed-plugin proof. --demo uses example PRs and in-memory history for public screenshots.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { saveCopy, snapshotRow } from "../../core/pr-copy-history.ts";
const { values } = parseArgs({ options: { out: { type: "string" }, base: { type: "string", default: "http://127.0.0.1:38886" }, executable: { type: "string" }, demo: { type: "boolean" } } });
if (!values.out) throw new Error("--out DIR is required");
mkdirSync(values.out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(values.executable ? { executablePath: values.executable } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  let demoView;
  if (values.demo) {
    const basePr = { project: null, lead: null, agent: null, draft: false, review: "review required", approved: false, approvals: "0 approvals", approvers: [], sha: "head", ci: "pass", merge: "mergeable", summary: "", needsReview: true, excluded: false, updatedAt: new Date().toISOString(), candidates: [], repo: "example/widgets", author: "octocat" };
    const make = (p) => ({ ...basePr, ...p, nodeId: `PR_${p.number}`, url: `https://github.com/example/widgets/pull/${p.number}` });
    const prs = [
      make({ number: 101, title: "Keep shared links readable when pasted into chat", copySummary: "Pasted links retain their labels and still open the right page.", bucket: "needs-review", reviewers: ["alex"], mentions: ["@Alex"] }),
      make({ number: 102, title: "Restore the selected project after refreshing the page", copySummary: "Your project selection survives a browser refresh.", bucket: "needs-rereview", reviewers: ["sam"], mentions: ["@Sam Example"] }),
      make({ number: 103, title: "Show when the last GitHub check completed", copySummary: "The PR list shows how fresh its GitHub data is.", bucket: "approved", reviewers: ["lee"], mentions: ["@Lee"], approvers: ["lee"], approved: true, review: "approved", approvals: "1 approval" }),
      make({ number: 104, title: "Preserve drafts when switching tabs", copySummary: "Unsent notes stay available when you return to the composer.", bucket: "needs-review", reviewers: [], mentions: [] }),
    ];
    const before = [
      { ...prs[0], sha: "old", ci: "pending" },
      { ...prs[1], bucket: "needs-review", sha: "old" },
      { ...prs[2], bucket: "needs-rereview", review: "review required", approvers: [] },
      make({ number: 105, title: "Make keyboard navigation consistent", bucket: "needs-review" }),
      make({ number: 106, title: "Remove an obsolete preview", bucket: "approved" }),
    ].map(snapshotRow);
    demoView = { state: "ok", login: "octocat", notes: [], pollMinutes: 5, channel: null, excluded: [], more: false, fetchedAt: Date.now(), error: null, prs, copyHistory: saveCopy({}, before, null, Date.now() - 3600_000), departed: { "https://github.com/example/widgets/pull/105": "MERGED", "https://github.com/example/widgets/pull/106": "CLOSED" } };
    await page.route("**/plugins/orchestrator/rpc/openPrs", (route) => route.fulfill({ json: { ok: true, result: demoView } }));
    await page.route("**/plugins/orchestrator/rpc/rememberPrCopy", (route) => {
      const input = route.request().postDataJSON();
      demoView.copyHistory = saveCopy(demoView.copyHistory, input.prs, input.section, Date.now());
      return route.fulfill({ json: { ok: true, result: demoView.copyHistory } });
    });
  }
  const read = async () => page.evaluate(async () => {
    const r = await fetch("/api/v1/plugins/orchestrator/rpc/openPrs", { method: "POST", headers: { "content-type": "application/json" }, body: "null" });
    const j = await r.json(); if (!j.ok) throw new Error(JSON.stringify(j)); return j.result;
  });
  const clipboard = async () => page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return { types: item.types, html: await (await item.getType("text/html")).text(), text: await (await item.getType("text/plain")).text() };
  });
  const tab = page.locator("[data-pr-review-queue]");
  const copied = async (button) => {
    const [response] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/rpc/rememberPrCopy") && r.request().method() === "POST"), button.click()]);
    const result = await response.json(); assert.equal(result.ok, true, JSON.stringify(result));
    await tab.getByRole("status").filter({ hasText: "Copied and saved" }).waitFor();
    return result.result;
  };
  await page.goto(`${values.base}/plugins/orchestrator/home/prs`);
  await tab.locator("[data-review-pr]").first().waitFor({ timeout: 120_000 });
  assert.equal(await tab.locator("[data-review-section]").count(), 3);
  const summaries = await tab.locator("[data-pr-summary]").allTextContents();
  assert.ok(summaries.every((s) => s.length > 0 && s.length <= 140));
  assert.equal(await tab.locator("[data-include-changes]").isChecked(), true);
  if (values.demo) {
    const changes = await tab.locator("[data-copy-changes]").innerText();
    for (const phrase of ["New PR", "New commits", "CI:", "Merged", "Closed", "→"]) assert.ok(changes.includes(phrase), phrase);
    assert.equal(await tab.locator("[data-pr-changed]").count(), 4);
  }
  const capture = async (width, name) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(500);
    const height = await tab.evaluate((el) => el.scrollHeight);
    await page.setViewportSize({ width, height: Math.max(1000, height + 350) });
    await page.waitForTimeout(500);
    await tab.evaluate((el) => { for (let p = el; p; p = p.parentElement) p.scrollTop = 0; });
    await tab.screenshot({ path: join(values.out, name) });
  };
  await capture(1440, "prs-tab.png");
  await capture(430, "prs-tab-narrow.png");
  assert.equal(await tab.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
  // Save the copy with visible changes before advancing its baseline.
  let history = await copied(tab.locator("[data-copy-all]"));
  const all = await clipboard();
  assert.ok(all.types.includes("text/html") && all.types.includes("text/plain"));
  assert.match(all.html, /<a href="https:\/\/github.com\//);
  assert.ok(!/<https?:\/\/[^>]+\|/.test(all.text));
  if (values.demo) assert.match(all.text, /^Changes since last copy/);
  for (const s of summaries) assert.ok(all.text.includes(s), s);
  writeFileSync(join(values.out, "copied.html"), all.html);
  writeFileSync(join(values.out, "copied.txt"), all.text);
  writeFileSync(join(values.out, "sample.html"), all.html);
  writeFileSync(join(values.out, "sample.txt"), all.text);
  const links = await page.evaluate((html) => [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("a")].map((a) => a.getAttribute("href")), all.html);
  assert.ok(links.every((url) => /^https:\/\/github.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url)));
  const scopes = [];
  for (const id of ["needs-review", "needs-rereview", "approved"]) {
    const before = history;
    history = await copied(tab.locator(`[data-review-section="${id}"]`).getByRole("button"));
    for (const other of ["needs-review", "needs-rereview", "approved"].filter((s) => s !== id)) assert.deepEqual(history[other], before[other]);
    scopes.push(id);
  }
  await page.reload();
  await tab.locator("[data-review-pr]").first().waitFor();
  assert.deepEqual((await read()).copyHistory, history, "history survives a page reload");
  await tab.locator("[data-include-changes]").uncheck();
  history = await copied(tab.locator("[data-copy-all]"));
  assert.ok(!(await clipboard()).text.includes("Changes since last copy"));
  await tab.locator("[data-include-changes]").check();
  const saveFailure = (route) => route.fulfill({ status: 503, json: { ok: false, error: "Test storage failure" } });
  await page.route("**/plugins/orchestrator/rpc/rememberPrCopy", saveFailure);
  await tab.locator("[data-copy-all]").click();
  await tab.getByRole("status").filter({ hasText: "Copied, but could not confirm the baseline was saved." }).waitFor();
  assert.deepEqual((await read()).copyHistory, history);
  await page.unroute("**/plugins/orchestrator/rpc/rememberPrCopy", saveFailure);
  await page.evaluate(() => { navigator.clipboard.write = async () => { throw new Error("permission denied"); }; });
  await tab.locator("[data-copy-all]").click();
  await tab.getByRole("status").filter({ hasText: "Could not copy both formats." }).waitFor();
  assert.deepEqual((await read()).copyHistory, history, "failed clipboard writes must not advance history");
  assert.deepEqual(errors, []);
  const report = { data: values.demo ? "synthetic example PRs" : "live GitHub", types: all.types, links: links.length, summaryCount: summaries.length, sectionIsolation: scopes, historySurvivesReload: true, toggle: "passed", clipboardFailurePreservesHistory: true, storageFailureReportedSeparately: true, errors, narrowOverflow: false, at: new Date().toISOString() };
  writeFileSync(join(values.out, "browser-proof.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
