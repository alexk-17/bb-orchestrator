// Phase-1 click-through: one step per run, so the proof can interleave with real agent turns.
//   node test/e2e/proof.mjs <step> [args…] --base <harness URL> --out <dir> [--live]
// --base is required (2026-11-18): there is no default. The live app (127.0.0.1:38886) is refused unless --live is given
// too, because these steps answer, defer and resend for real (live-guard.ts). Point it at your harness.
// Steps:
//   shot <name> [view]                 screenshot a view (needs-you | board | rules)
//   answer <decisionId> <optionId> <name>   one tap on an option; waits for the card to show answered
//   doubletap <decisionId> <name>      two raw clicks on option 1 of that card, <400 ms apart (and a dblclick);
//                                      prints which decisions changed state
//   note <decisionId> <text> <name>    a note-only answer
//   defer <decisionId> <preset> <name> defer through the menu
//   return <decisionId> <name>         bring a deferred card back
//   resend <itemId> <name>             resend a dead letter from the board
//   rule <text> <project|-> <name>     add a standing rule from the Rules screen
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { checkBase, isLiveBase } from "./live-guard.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string" }, base: { type: "string" }, live: { type: "boolean", default: false } } });
const base = checkBase(values.base, values.live);
const out = values.out;
if (!out) throw new Error("--out DIR");
mkdirSync(out, { recursive: true });
const [step, ...args] = positionals;
const report = { step, args, at: new Date().toISOString(), console: [], notes: [] };

// A decision's state from the same bb the page is on: the bb CLI for the runner's own bb, the base's /decision route for
// any other (a harness on made-up data). Never the CLI for another base, so a harness run can't read the live bb.
const state = async (id) =>
  isLiveBase(base)
    ? JSON.parse(execFileSync("bb", ["orchestrator", "decision", id], { encoding: "utf8" })).state
    : (await (await fetch(`${base}/decision?id=${encodeURIComponent(id)}`)).json()).state;
// Playwright loads only after the base passed the guard
const { chromium } = await import("playwright-core");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("console", (m) => { if (m.type() === "error") report.console.push(m.text()); });
page.on("pageerror", (e) => report.console.push(String(e)));
const shot = async (name) => { await page.waitForTimeout(300); await page.screenshot({ path: join(out, `${name}.png`), fullPage: true }); report.notes.push(`screenshot ${name}.png`); };
const go = async (view = "needs-you") => {
  const sub = view === "needs-you" ? "" : `/${view}`;
  await page.goto(`${base}/plugins/orchestrator/home${sub}`, { waitUntil: "load", timeout: 60_000 });
  await page.locator(`[data-view="${view}"]`).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
};
const card = (id) => page.locator(`[data-card="${id}"]`);
const armed = async (id, opt = "1") => card(id).locator(`[data-option="${opt}"][data-armed="true"]`).waitFor({ timeout: 10_000 });

try {
  switch (step) {
    case "shot":
      await go(args[1] ?? "needs-you");
      await shot(args[0]);
      break;
    case "answer": {
      const [id, opt, name] = args;
      await go();
      await armed(id, opt);
      report.before = await state(id);
      await shot(`${name}-before`);
      await card(id).locator(`[data-option="${opt}"]`).click();
      await card(id).and(page.locator('[data-state="answered"]')).waitFor({ timeout: 15_000 }).catch(() => report.notes.push("no answered placeholder seen"));
      await shot(`${name}-tapped`);
      await page.waitForTimeout(1500);
      await shot(`${name}-after`);
      report.after = await state(id);
      break;
    }
    case "doubletap": {
      const [id, name] = args;
      await go();
      await armed(id);
      const ids = await page.locator("[data-card]").evaluateAll((els) => els.map((e) => e.getAttribute("data-card")));
      report.cardsBefore = Object.fromEntries(await Promise.all(ids.map(async (i) => [i, await state(i)])));
      await shot(`${name}-before`);
      const box = await card(id).locator('[data-option="1"]').boundingBox();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.click(x, y);
      await page.waitForTimeout(120);
      await page.mouse.click(x, y); // the second tap of a fast double tap, same spot
      await page.waitForTimeout(150);
      await page.mouse.dblclick(x, y); // and a real double click on top
      await page.waitForTimeout(250);
      if (process.env.STORM) {
        // keep tapping the same spot every 150 ms for 2 s: across the moment the next card slides into this slot
        report.storm = [];
        for (let t = 0; t < 2000; t += 150) {
          await page.mouse.click(x, y);
          report.storm.push(await page.locator("[data-card]").first().getAttribute("data-card"));
          await page.waitForTimeout(150);
        }
      }
      await shot(`${name}-during`);
      await page.waitForTimeout(2500);
      await shot(`${name}-after`);
      report.cardsAfter = Object.fromEntries(await Promise.all(ids.map(async (i) => [i, await state(i)])));
      const changed = ids.filter((i) => report.cardsBefore[i] !== report.cardsAfter[i]);
      report.changed = changed;
      if (changed.length !== 1 || changed[0] !== id) throw new Error(`expected only ${id} answered, changed: ${changed.join(", ")}`);
      break;
    }
    case "arming": {
      // answer card A, then click card B's option 1 the moment B lands where A's option was: it must be unarmed
      const [a, b, name] = args;
      await go();
      await armed(a);
      await armed(b);
      const boxA = await card(a).locator('[data-option="1"]').boundingBox();
      const x = boxA.x + boxA.width / 2, y = boxA.y + boxA.height / 2;
      report.before = { [a]: await state(a), [b]: await state(b) };
      await page.mouse.click(x, y);
      const t0 = Date.now();
      let landed = null;
      while (Date.now() - t0 < 10_000) {
        const bb2 = await card(b).locator('[data-option="1"]').boundingBox().catch(() => null);
        if (bb2 && y >= bb2.y && y <= bb2.y + bb2.height) { landed = Date.now() - t0; break; }
        await page.waitForTimeout(10);
      }
      if (landed === null) throw new Error(`${b} never reached the clicked spot`);
      report.armedAtClick = await card(b).locator('[data-option="1"]').getAttribute("data-armed");
      await page.mouse.click(x, y);
      report.landedAfterMs = landed;
      await shot(`${name}-at-second-click`);
      await page.waitForTimeout(2000);
      await shot(`${name}-after`);
      report.after = { [a]: await state(a), [b]: await state(b) };
      if (report.after[b] !== "asked") throw new Error(`${b} was answered by the second click`);
      break;
    }
    case "revoke": {
      const [ruleId, name] = args;
      await go("rules");
      await page.locator(`[data-revoke="${ruleId}"]`).click();
      await page.locator(`[data-rule="${ruleId}"][data-revoked="true"]`).waitFor({ timeout: 15_000 });
      await shot(`${name}-after`);
      break;
    }
    case "note": {
      const [id, text, name] = args;
      await go();
      await armed(id);
      const toggle = card(id).locator("[data-note-toggle]");
      if (await toggle.count()) await toggle.click();
      await card(id).locator("[data-note]").fill(text);
      await shot(`${name}-typed`);
      await card(id).locator("[data-note-send]").click();
      await page.waitForTimeout(2000);
      await shot(`${name}-after`);
      report.after = await state(id);
      break;
    }
    case "defer": {
      const [id, preset, name] = args;
      await go();
      await armed(id);
      await card(id).locator("[data-defer]").click();
      await page.locator(`[data-preset="${preset}"]`).waitFor();
      await shot(`${name}-menu`);
      await page.locator(`[data-preset="${preset}"]`).click();
      await page.waitForTimeout(2000);
      await shot(`${name}-after`);
      break;
    }
    case "return": {
      const [id, name] = args;
      await go();
      await card(id).locator("[data-return]").click();
      await page.waitForTimeout(2000);
      await shot(`${name}-after`);
      break;
    }
    case "resend": {
      const [itemId, name] = args;
      await go("board");
      await shot(`${name}-before`);
      await page.locator(`[data-resend="${itemId}"]`).click();
      await page.waitForTimeout(2000);
      await shot(`${name}-after`);
      break;
    }
    case "rule": {
      const [text, project, name] = args;
      await go("rules");
      const form = page.locator("[data-rule-form]");
      await form.locator('input[name="text"]').fill(text);
      if (project !== "-") await form.locator('input[name="project"]').fill(project);
      await form.locator('input[name="source"]').fill("phase-1 proof, a test operator");
      await shot(`${name}-filled`);
      await form.locator('button[type="submit"]').click();
      await page.waitForTimeout(1500);
      await shot(`${name}-after`);
      break;
    }
    case "pathways-guide": {
      const [slug, ticketId, name = "guide"] = args;
      if (!slug || !ticketId) throw new Error("pathways-guide <slug> <ticketId> [name]");
      const fixtureGuide = {
        framing: "Decide how to validate session tokens locally and in CI without manual secret rotation.",
        routes: [
          {
            label: "Static env key",
            approach: "Read a long-lived API key from an environment variable.",
            tradeoffs: "Trivial to wire; static credential rotation burden.",
            risk: "medium",
            reversible: "easy",
            size: "S",
            firstStep: "Add env lookup behind token adapter.",
            proof: "Unit test passes with fixture key.",
          },
          {
            label: "Scoped local key file",
            approach: "Read a 0600 local key file behind a minimal provider interface.",
            tradeoffs: "Fast vertical slice with clear file boundary; needs per-host setup.",
            risk: "low",
            reversible: "easy",
            size: "S",
            firstStep: "Implement 0600 file reader with permission check.",
            proof: "Unit test rejects world-readable files and loads valid key.",
          },
          {
            label: "Ephemeral OIDC broker",
            approach: "Exchange workload identity for short-lived session tokens.",
            tradeoffs: "No static secrets; requires broker infra before first user test.",
            risk: "high",
            reversible: "hard",
            size: "L",
            firstStep: "Spike token exchange against staging OIDC.",
            proof: "Staging endpoint accepts minted token.",
          },
        ],
        recommended: 1,
        why: "Smallest verifiable slice with strong local boundary and easy upgrade path to OIDC.",
        principles: [2, 3, 6, 8],
        risks: ["Reject key files with permissions looser than 0600.", "Keep key contents out of logs and prompts."],
      };
      report.guideRequests = [];
      const attachFakeGuide = async (targetPage) => {
        await targetPage.route("**/api/v1/plugins/orchestrator/http/pathways/guide", async (route) => {
          const req = route.request();
          const body = JSON.parse(req.postData() || "{}");
          report.guideRequests.push({ method: req.method(), body });
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              result: {
                guide: fixtureGuide,
                error: null,
                provider: "claude-code",
                model: "claude-haiku-5-5",
                cached: false,
              },
            }),
          });
        });
      };
      const openTicketDetail = async (targetPage) => {
        const url = `${base}/plugins/orchestrator/home/projects/${encodeURIComponent(slug)}?pathways=1`;
        await targetPage.goto(url, { waitUntil: "load", timeout: 60_000 });
        const toggle = targetPage.locator(`[data-pathways-toggle="${slug}"]`).first();
        await toggle.waitFor({ timeout: 30_000 });
        if ((await toggle.getAttribute("data-state")) !== "open" && (await toggle.getAttribute("aria-expanded")) !== "true") {
          await toggle.click();
        }
        const ticketButton = targetPage.locator(`[data-pathways-row="${ticketId}"], [data-pathways-node="${ticketId}"]`).first();
        await ticketButton.waitFor({ timeout: 30_000 });
        await ticketButton.click();
        await targetPage.locator(`[data-pathways-detail="${ticketId}"]`).waitFor({ timeout: 15_000 });
      };

      await page.setViewportSize({ width: 1280, height: 900 });
      await attachFakeGuide(page);
      await openTicketDetail(page);
      const detail = page.locator(`[data-pathways-detail="${ticketId}"]`);
      await detail.locator("[data-pathways-guide-run]").waitFor({ timeout: 10_000 });
      if ((await detail.locator("[data-pathways-guide-card]").count()) !== 0) {
        throw new Error("guide auto-ran before clicking Guide me");
      }
      await detail.locator("[data-pathways-guide-run]").click();
      await detail.locator("[data-pathways-guide-card]").waitFor({ timeout: 15_000 });
      const routeCount = await detail.locator("[data-pathways-guide-route]").count();
      if (routeCount !== 3) throw new Error(`expected 3 guide routes, got ${routeCount}`);
      const notice = await detail.locator("[data-pathways-guide-notice]").textContent();
      if (!notice?.includes("claude-haiku-5-5")) throw new Error(`missing model notice: ${notice}`);
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(out, `${name}-1280.png`) });
      report.notes.push(`screenshot ${name}-1280.png`);
      await detail.locator("[data-pathways-guide-apply]").click();
      const opt0 = await detail.locator(`#${ticketId}-option-0`).inputValue();
      const opt1 = await detail.locator(`#${ticketId}-option-1`).inputValue();
      if (opt0 !== "Scoped local key file" || opt1 !== "Static env key") {
        throw new Error(`unexpected applied draft options: ${JSON.stringify([opt0, opt1])}`);
      }
      await detail.locator(`#${ticketId}-option-0`).scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(out, `${name}-draft-1280.png`) });
      report.notes.push(`screenshot ${name}-draft-1280.png`);

      const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
      mobilePage.on("console", (m) => { if (m.type() === "error") report.console.push(m.text()); });
      mobilePage.on("pageerror", (e) => report.console.push(String(e)));
      try {
        await attachFakeGuide(mobilePage);
        await openTicketDetail(mobilePage);
        const mobileDetail = mobilePage.locator(`[data-pathways-detail="${ticketId}"]`);
        await mobileDetail.locator("[data-pathways-guide-run]").click();
        await mobileDetail.locator("[data-pathways-guide-card]").waitFor({ timeout: 15_000 });
        const overflow = await mobileDetail.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
        if (overflow) throw new Error("mobile guide detail overflows horizontally at 390px");
        await mobilePage.waitForTimeout(250);
        await mobilePage.screenshot({ path: join(out, `${name}-390.png`) });
        report.notes.push(`screenshot ${name}-390.png`);
        await mobileDetail.locator("[data-pathways-guide-apply]").click();
        const mobileOpt0 = await mobileDetail.locator(`#${ticketId}-option-0`).inputValue();
        if (mobileOpt0 !== "Scoped local key file") {
          throw new Error(`unexpected mobile draft option: ${mobileOpt0}`);
        }
      } finally {
        await mobilePage.close();
      }
      break;
    }
    default:
      throw new Error(`unknown step ${step}`);
  }
} catch (e) {
  report.error = String(e);
  await page.screenshot({ path: join(out, `error-${step}.png`), fullPage: true }).catch(() => {});
} finally {
  writeFileSync(join(out, `report-${step}-${Date.now()}.json`), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
process.exit(report.error ? 1 : 0);
