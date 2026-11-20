// Option tiles' badges (2026-11-18): pressing must move nothing, because Needs you arms cards by position and a tile that
// grows on a pick is a mis-click risk. Recommended has a row reserved on every tile only while a tile has it; Picked sits
// in the title row, always laid out, so a pick changes no tile's height, on a card with no Recommended option too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pickedClass, reservesBadgeRow } from "../app/option-tiles.ts";

const src = readFileSync(new URL("../app/answer-ui.tsx", import.meta.url), "utf8");
const needsYouSrc = readFileSync(new URL("../app/needs-you.tsx", import.meta.url), "utf8");

test("a card with no Recommended option reserves no badge row, ticked or not", () => {
  assert.equal(reservesBadgeRow([{}, {}]), false);
  assert.equal(reservesBadgeRow([{ recommended: false }, { recommended: false }]), false, "a pickable card with nothing picked has no empty row");
  assert.equal(reservesBadgeRow([]), false);
});

test("a Recommended option makes every tile reserve the row, so their heights stay equal", () => {
  assert.equal(reservesBadgeRow([{ recommended: true }, {}]), true);
});

test("a pick changes no tile's height: the Picked badge is the same box ticked or not, in the title row, never a row of its own", async () => {
  const off = pickedClass(false).split(" ");
  const on = pickedClass(true).split(" ");
  assert.deepEqual(off.filter((c) => c !== "invisible"), on, "only visibility differs between picked and not");
  assert.ok(off.includes("invisible") && !on.includes("invisible"));
  assert.ok(on.includes("-my-0.5"), "it never makes the title row taller than one line");
  const title = src.slice(src.indexOf('data-tile-title=""'), src.indexOf("{o.detail ?"));
  assert.match(title, /pickedClass\(o\.pressed\)/, "Picked is drawn in the title row, whatever the card recommends");
  assert.doesNotMatch(src.slice(src.indexOf("{badges ? ("), src.indexOf("</Btn>")), /Picked/, "the reserved badge row holds Recommended only, so a pick adds no row");
  assert.match(src, /o\.pressed !== undefined \? \(\s*<Badge variant="outline" className=\{pickedClass\(o\.pressed\)\}/, "drawn whenever the answer can be picked, not only once picked");

  const stepperMod = await import("../app/answer-stepper.ts");
  const mkCard = (id: string, rev = 1, allowText = true) => ({
    id,
    rev,
    allowText,
    options: [
      { id: "1", label: "Yes" },
      { id: "2", label: "No" },
    ],
  });
  const c1 = mkCard("d1");
  const c2 = mkCard("d2");
  const c3 = mkCard("d3");
  const c4 = mkCard("d4");

  assert.equal(stepperMod.canOfferStepper([]), false);
  assert.equal(stepperMod.canOfferStepper([c1]), false);
  assert.equal(stepperMod.canOfferStepper([c1, c2]), true);

  let s = stepperMod.openStepper([c1, c2, c3, c4]);
  assert.equal(s.index, 0);
  assert.equal(stepperMod.isReview(s), false);
  assert.equal(stepperMod.positionLabel(s), "1 of 4");

  s = stepperMod.saveDraft(s, "d1", { option: "1", note: "", unticked: new Map() }, true);
  assert.equal(s.index, 1);
  assert.equal(stepperMod.positionLabel(s), "2 of 4");
  assert.equal(s.drafts.get("d1")?.option, "1");

  s = stepperMod.stepBack(s);
  assert.equal(s.index, 0);
  assert.equal(s.drafts.get("d1")?.option, "1");

  s = stepperMod.saveDraft(s, "d1", { option: "2", note: "updated note", unticked: new Map() }, true);
  assert.equal(s.index, 1);
  assert.equal(s.drafts.get("d1")?.option, "2");
  assert.equal(s.drafts.get("d1")?.note, "updated note");

  s = stepperMod.stepNext(s);
  assert.equal(s.index, 2);
  assert.equal(s.drafts.has("d2"), false);

  s = stepperMod.saveDraft(s, "d3", { option: null, note: "custom reply", unticked: new Map() }, true);
  assert.equal(s.index, 3);
  assert.equal(s.drafts.get("d3")?.option, null);
  assert.equal(s.drafts.get("d3")?.note, "custom reply");

  s = stepperMod.stepBack(s);
  assert.equal(s.index, 2);
  assert.equal(s.drafts.get("d3")?.note, "custom reply");
  s = stepperMod.stepNext(s);
  assert.equal(s.index, 3);
  assert.equal(s.drafts.get("d3")?.note, "custom reply");

  s = stepperMod.saveDraft(s, "d4", { option: "1", note: "", unticked: new Map() }, true);
  assert.equal(stepperMod.isReview(s), true);

  s = stepperMod.reconcileStepper(s, [c1, c2, { ...c3, rev: 2 }]);
  assert.deepEqual(
    s.cards.map((c) => c.id),
    ["d1", "d2"],
  );
  assert.equal(s.drafts.has("d3"), false);
  assert.equal(s.drafts.has("d4"), false);
  assert.equal(s.droppedAnswered, 1);
  assert.equal(s.droppedChanged, 1);
  assert.match(stepperMod.droppedNotice(s) ?? "", /1 card was answered elsewhere/);

  let s2 = stepperMod.openStepper([c1, c2, c3]);
  s2 = stepperMod.saveDraft(s2, "d1", { option: "1", note: "", unticked: new Map() }, true);
  s2 = stepperMod.saveDraft(s2, "d2", { option: "2", note: "", unticked: new Map() }, true);
  s2 = stepperMod.saveDraft(s2, "d3", { option: "1", note: "", unticked: new Map() }, true);
  s2 = stepperMod.saveDraft(s2, "d2", { option: "1", note: "edited on review", unticked: new Map() }, false);
  assert.equal(stepperMod.isReview(s2), true);
  assert.equal(s2.drafts.get("d2")?.note, "edited on review");

  const order: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let unlockWaits = 0;
  const batchRes = await stepperMod.submitBatch(stepperMod.submittableDrafts(s2), {
    waitForUnlock: async () => {
      unlockWaits += 1;
      return true;
    },
    latestCard: (id) => [c1, c2, c3].find((c) => c.id === id),
    sendOne: async (card) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(card.id);
      await Promise.resolve();
      inFlight -= 1;
      if (card.id === "d2") return { ok: false, kind: "conflict", message: "rev mismatch" };
      if (card.id === "d3") return null;
      return { ok: true };
    },
  });
  assert.deepEqual(order, ["d1", "d2", "d3"]);
  assert.equal(maxInFlight, 1);
  assert.equal(unlockWaits, 3);
  assert.deepEqual(batchRes.succeeded, ["d1"]);
  assert.equal(batchRes.failed.has("d2"), true);
  assert.equal(batchRes.failed.has("d3"), true);

  const afterPartial = stepperMod.applyBatchResult(s2, batchRes);
  assert.deepEqual(
    afterPartial.cards.map((c) => c.id),
    ["d2", "d3"],
  );
  assert.equal(afterPartial.drafts.get("d2")?.note, "edited on review");
  assert.equal(afterPartial.drafts.get("d3")?.option, "1");
  assert.equal(stepperMod.isReview(afterPartial), true);

  const reconciledAfterConflict = stepperMod.reconcileStepper(afterPartial, [{ ...c2, rev: 2 }, c3]);
  assert.equal(reconciledAfterConflict.cards.find((c) => c.id === "d2")?.rev, 2);
  assert.equal(reconciledAfterConflict.drafts.get("d2")?.note, "edited on review");
  assert.equal(reconciledAfterConflict.failures.has("d2"), true);

  const staleSent: string[] = [];
  const staleRes = await stepperMod.submitBatch(stepperMod.submittableDrafts(s2), {
    waitForUnlock: async () => true,
    latestCard: (id) => (id === "d2" ? { ...c2, rev: 9 } : [c1, c2, c3].find((c) => c.id === id)),
    sendOne: async (card) => {
      staleSent.push(`${card.id}@${card.rev}`);
      return { ok: true };
    },
  });
  assert.deepEqual(staleSent, ["d1@1", "d3@1"]);
  assert.equal(staleRes.failed.has("d2"), true);

  assert.match(needsYouSrc, /Answer one at a time/);
  assert.match(needsYouSrc, /data-stepper-submit/);
  assert.match(needsYouSrc, /data-arm="stepper-submit"/);
});
