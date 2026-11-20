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

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    base: { type: "string" },
    live: { type: "boolean", default: false },
    mobile: { type: "boolean", default: false },
  },
});
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
const context = await browser.newContext({
  viewport: values.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
  hasTouch: values.mobile,
  isMobile: values.mobile,
});
const page = await context.newPage();
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
    case "stepper": {
      const [mode, name] = args;
      await go();
      const ids = await page.locator("[data-card]").evaluateAll((els) => els.map((e) => e.getAttribute("data-card")));
      if (ids.length < 3) throw new Error(`need >=3 cards for stepper proof, got ${ids.length}`);
      await page.locator("[data-stepper-start]").waitFor({ timeout: 5_000 });
      await shot(`${name}-offer`);
      await page.locator("[data-stepper-start]").click();
      await page.locator("[data-stepper]").waitFor({ timeout: 5_000 });
      const pos1 = await page.locator("[data-stepper-pos]").textContent();
      if (!pos1?.includes(`1 of ${ids.length}`)) throw new Error(`expected 1 of ${ids.length}, got ${pos1}`);
      await shot(`${name}-step1`);
      const overflow1 = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      if (overflow1) throw new Error("horizontal overflow on step 1");

      await armed(ids[0], "1");
      await card(ids[0]).locator('[data-option="1"]').click();
      await page.locator(`[data-card="${ids[1]}"]`).waitFor({ timeout: 5_000 });
      const pos2 = await page.locator("[data-stepper-pos]").textContent();
      if (!pos2?.includes(`2 of ${ids.length}`)) throw new Error(`expected 2 of ${ids.length}, got ${pos2}`);

      await page.locator("[data-stepper-exit]").click();
      await page.locator("[data-stepper]").waitFor({ state: "detached", timeout: 5_000 });
      const resumeText = await page.locator("[data-stepper-start]").textContent();
      if (!resumeText?.includes("1 drafted")) throw new Error(`expected Show all to keep drafts, got ${resumeText}`);
      await page.locator("[data-stepper-start]").click();
      await page.locator(`[data-card="${ids[1]}"]`).waitFor({ timeout: 5_000 });

      await page.locator("[data-stepper-back]").click();
      await page.locator(`[data-card="${ids[0]}"]`).waitFor({ timeout: 5_000 });
      const pressedBack = await card(ids[0]).locator('[data-option="1"]').getAttribute("aria-pressed");
      if (pressedBack !== "true") throw new Error(`expected Back to keep pick on ${ids[0]}, got aria-pressed=${pressedBack}`);
      await shot(`${name}-back-kept`);

      await page.locator("[data-stepper-next]").click();
      await page.locator(`[data-card="${ids[1]}"]`).waitFor({ timeout: 5_000 });
      await page.locator("[data-stepper-next]").click();
      await page.locator(`[data-card="${ids[2]}"]`).waitFor({ timeout: 5_000 });

      await armed(ids[2], "1");
      await card(ids[2]).locator("[data-note]").fill("Schedule with dual-key overlap");
      await card(ids[2]).locator("[data-note-send]").click();
      for (let idx = 3; idx < ids.length; idx++) {
        await page.locator(`[data-card="${ids[idx]}"]`).waitFor({ timeout: 5_000 });
        await armed(ids[idx], "2");
        await card(ids[idx]).locator('[data-option="2"]').click();
      }

      await page.locator("[data-stepper-review]").waitFor({ timeout: 5_000 });
      const overflowRev = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      if (overflowRev) throw new Error("horizontal overflow on review");
      await shot(`${name}-review`);

      await page.locator(`[data-review-edit="${ids[0]}"][data-armed="true"]`).waitFor({ timeout: 10_000 });
      await page.locator(`[data-review-edit="${ids[0]}"]`).click();
      await page.locator(`[data-review-editor="${ids[0]}"] [data-option="2"][data-armed="true"]`).waitFor({ timeout: 10_000 });
      await page.locator(`[data-review-editor="${ids[0]}"] [data-option="2"]`).click();
      await page.locator(`[data-review-editor="${ids[0]}"]`).waitFor({ state: "detached", timeout: 5_000 });

      await page.locator('[data-stepper-submit][data-armed="true"]').waitFor({ timeout: 10_000 });

      let holdingReads = false;
      const heldRoutes = [];
      if (mode === "partial") {
        holdingReads = true;
        await page.route("**/api/harness/needs-you*", async (route) => {
          if (!holdingReads) {
            await route.continue().catch(() => {});
            return;
          }
          heldRoutes.push(route);
        });
        const bumpRes = await fetch(`${base}/harness/bump-rev`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: ids[2], question: "Updated question: rotate webhook key immediately?" }),
        });
        if (!bumpRes.ok) throw new Error(`bump-rev failed: ${bumpRes.status}`);
      }

      await page.locator("[data-stepper-submit]").click();

      if (mode === "partial") {
        await page.locator(`[data-review-error="${ids[2]}"]`).waitFor({ timeout: 15_000 });
        holdingReads = false;
        await Promise.all(heldRoutes.splice(0).map((r) => r.continue().catch(() => {})));
        await page.unroute("**/api/harness/needs-you*");
        await page.locator(`[data-review-stale="${ids[2]}"]`).waitFor({ timeout: 10_000 });
        await shot(`${name}-partial-failure`);
        const failedCardCount = await page.locator(`[data-review-card="${ids[2]}"]`).count();
        const succeededCardCount = await page.locator(`[data-review-card="${ids[0]}"]`).count();
        if (failedCardCount !== 1 || succeededCardCount !== 0) {
          throw new Error(`expected failed ${ids[2]} kept (${failedCardCount}) and succeeded ${ids[0]} gone (${succeededCardCount})`);
        }
        const keptDraft = await page.locator(`[data-review-answer="${ids[2]}"]`).textContent();
        if (!keptDraft?.includes("Schedule with dual-key overlap")) {
          throw new Error(`expected kept draft text, got ${keptDraft}`);
        }
        const retryDisabled = await page.locator("[data-stepper-submit]").isDisabled();
        if (!retryDisabled) {
          throw new Error("expected Retry to stay disabled while failed draft is stale");
        }
        report.after = Object.fromEntries(await Promise.all(ids.map(async (i) => [i, await state(i)])));
        if (report.after[ids[0]] !== "answered" || report.after[ids[1]] !== "asked" || report.after[ids[2]] !== "asked") {
          throw new Error(`unexpected partial states: ${JSON.stringify(report.after)}`);
        }
      } else {
        await page.locator("[data-stepper]").waitFor({ state: "detached", timeout: 15_000 });
        await page.waitForTimeout(800);
        await shot(`${name}-submitted`);
        report.after = Object.fromEntries(await Promise.all(ids.map(async (i) => [i, await state(i)])));
        if (report.after[ids[0]] !== "answered" || report.after[ids[1]] !== "asked" || report.after[ids[2]] !== "answered") {
          throw new Error(`unexpected submitted states: ${JSON.stringify(report.after)}`);
        }
      }
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
    default:
      throw new Error(`unknown step ${step}`);
  }
} catch (e) {
  report.error = String(e);
  await page.screenshot({ path: join(out, `error-${step}.png`), fullPage: true }).catch(() => {});
} finally {
  writeFileSync(join(out, `report-${step}-${Date.now()}.json`), JSON.stringify(report, null, 2));
  await context.close();
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
process.exit(report.error ? 1 : 0);
