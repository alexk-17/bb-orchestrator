// Option tiles' badges (2026-11-18): pressing must move nothing, because Needs you arms cards by position and a tile that
// grows on a pick is a mis-click risk. Recommended has a row reserved on every tile only while a tile has it; Picked sits
// in the title row, always laid out, so a pick changes no tile's height, on a card with no Recommended option too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pickedClass, reservesBadgeRow } from "../app/option-tiles.ts";

const src = readFileSync(new URL("../app/answer-ui.tsx", import.meta.url), "utf8");

test("a card with no Recommended option reserves no badge row, ticked or not", () => {
  assert.equal(reservesBadgeRow([{}, {}]), false);
  assert.equal(reservesBadgeRow([{ recommended: false }, { recommended: false }]), false, "a pickable card with nothing picked has no empty row");
  assert.equal(reservesBadgeRow([]), false);
});

test("a Recommended option makes every tile reserve the row, so their heights stay equal", () => {
  assert.equal(reservesBadgeRow([{ recommended: true }, {}]), true);
});

test("a pick changes no tile's height, and stepper drafts navigate, reconcile, and batch-submit sequentially", async () => {
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
  const formatNote = (_c: unknown, d: { note: string }) => d.note;
  const mkCard = (id: string, rev = 1, allowText = true) => ({
    id,
    rev,
    allowText,
    options: [{ id: "1" }, { id: "2" }],
  });
  const c1 = mkCard("d1");
  const c2 = mkCard("d2");
  const c3 = mkCard("d3");
  const c4 = mkCard("d4");

  assert.equal(stepperMod.canOfferStepper([]), false, "stepper: hidden for 0 cards");
  assert.equal(stepperMod.canOfferStepper([c1]), false, "stepper: hidden for 1 card");
  assert.equal(stepperMod.canOfferStepper([c1, c2]), true, "stepper: offered for 2+ cards");

  let s = stepperMod.openStepper([c1, c2, c3, c4]);
  assert.equal(s.index, 0, "stepper: starts on card 0");
  assert.equal(stepperMod.isReview(s), false, "stepper: not on review at start");
  assert.equal(stepperMod.positionLabel(s), "1 of 4", "stepper: shows 1 of 4");

  s = stepperMod.saveDraft(s, "d1", { option: "1", note: "", unticked: new Map() }, true);
  assert.equal(s.index, 1, "stepper: pick advances");
  assert.equal(stepperMod.positionLabel(s), "2 of 4", "stepper: shows 2 of 4");
  assert.equal(s.drafts.get("d1")?.option, "1", "stepper: keeps option draft");
  assert.equal(s.drafts.get("d1")?.rev, 1, "stepper: stamps draft rev");

  s = stepperMod.stepBack(s);
  assert.equal(s.index, 0, "stepper: Back returns to card 0");
  assert.equal(s.drafts.get("d1")?.option, "1", "stepper: Back retains pick");

  s = stepperMod.saveDraft(s, "d1", { option: "2", note: "updated note", unticked: new Map() }, true);
  assert.equal(s.index, 1, "stepper: re-pick advances");
  assert.equal(s.drafts.get("d1")?.option, "2", "stepper: updates option draft");
  assert.equal(s.drafts.get("d1")?.note, "updated note", "stepper: updates note draft");

  s = stepperMod.stepNext(s);
  assert.equal(s.index, 2, "stepper: Next skips card 2");
  assert.equal(s.drafts.has("d2"), false, "stepper: skipped card has no draft");

  s = stepperMod.saveDraft(s, "d3", { option: null, note: "custom reply", unticked: new Map() }, true);
  assert.equal(s.index, 3, "stepper: Other saves and advances");
  assert.equal(s.drafts.get("d3")?.option, null, "stepper: Other stores null option");
  assert.equal(s.drafts.get("d3")?.note, "custom reply", "stepper: Other stores text");

  s = stepperMod.stepBack(s);
  assert.equal(s.index, 2, "stepper: Back to Other card");
  assert.equal(s.drafts.get("d3")?.note, "custom reply", "stepper: Other text survives Back");
  s = stepperMod.stepNext(s);
  assert.equal(s.index, 3, "stepper: Next after Back");
  assert.equal(s.drafts.get("d3")?.note, "custom reply", "stepper: Other text survives Next");

  s = stepperMod.saveDraft(s, "d4", { option: "1", note: "", unticked: new Map() }, true);
  assert.equal(stepperMod.isReview(s), true, "stepper: advances to review after last card");

  s = stepperMod.reconcileStepper(s, [c1, c2, { ...c3, rev: 2 }]);
  assert.deepEqual(
    s.cards.map((c) => c.id),
    ["d1", "d2"],
    "stepper: drops missing and changed non-failed cards",
  );
  assert.equal(s.drafts.has("d3"), false, "stepper: drops draft for changed card");
  assert.equal(s.drafts.has("d4"), false, "stepper: drops draft for missing card");
  assert.equal(s.droppedAnswered, 1, "stepper: counts answered elsewhere");
  assert.equal(s.droppedChanged, 1, "stepper: counts changed elsewhere");
  assert.match(stepperMod.droppedNotice(s) ?? "", /1 card was answered elsewhere/, "stepper: formats notice");
  s = stepperMod.clearNotice(s);
  assert.equal(stepperMod.droppedNotice(s), null, "stepper: dismisses notice");

  let s2 = stepperMod.openStepper([c1, c2, c3]);
  s2 = stepperMod.saveDraft(s2, "d1", { option: "1", note: "", unticked: new Map() }, true);
  s2 = stepperMod.saveDraft(s2, "d2", { option: "2", note: "", unticked: new Map() }, true);
  s2 = stepperMod.saveDraft(s2, "d3", { option: "1", note: "", unticked: new Map() }, true);
  s2 = stepperMod.saveDraft(s2, "d2", { option: "1", note: "edited on review", unticked: new Map() }, false);
  assert.equal(stepperMod.isReview(s2), true, "stepper: inline review edit stays on review");
  assert.equal(s2.drafts.get("d2")?.note, "edited on review", "stepper: review edit saves note");

  const order: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let unlockWaits = 0;
  const batchRes = await stepperMod.submitBatch(stepperMod.submittableDrafts(s2, formatNote), {
    waitForUnlock: async () => {
      unlockWaits += 1;
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
  assert.deepEqual(order, ["d1", "d2", "d3"], "stepper: sends drafts in order");
  assert.equal(maxInFlight, 1, "stepper: never sends in parallel");
  assert.equal(unlockWaits, 3, "stepper: waits for page unlock before every card");
  assert.deepEqual(batchRes.succeeded, ["d1"], "stepper: records succeeded cards");
  assert.equal(batchRes.failed.has("d2"), true, "stepper: records conflict failure");
  assert.equal(batchRes.failed.has("d3"), true, "stepper: never treats null write as success");

  const afterPartial = stepperMod.applyBatchResult(s2, batchRes);
  assert.deepEqual(
    afterPartial.cards.map((c) => c.id),
    ["d2", "d3"],
    "stepper: removes succeeded cards and keeps failed ones",
  );
  assert.equal(afterPartial.drafts.get("d2")?.note, "edited on review", "stepper: keeps failed conflict draft");
  assert.equal(afterPartial.drafts.get("d3")?.option, "1", "stepper: keeps busy failure draft");
  assert.equal(stepperMod.isReview(afterPartial), true, "stepper: stays on review after partial failure");

  const reconciledAfterConflict = stepperMod.reconcileStepper(afterPartial, [{ ...c2, rev: 2 }, c3]);
  const updatedD2 = reconciledAfterConflict.cards.find((c) => c.id === "d2")!;
  const keptDraftD2 = reconciledAfterConflict.drafts.get("d2")!;
  assert.equal(updatedD2.rev, 2, "stepper: refreshes failed card to latest rev");
  assert.equal(keptDraftD2.note, "edited on review", "stepper: keeps prior draft text visible");
  assert.equal(stepperMod.isStaleDraft(updatedD2, keptDraftD2), true, "stepper: marks old-rev draft stale");
  assert.deepEqual(
    stepperMod.submittableDrafts(reconciledAfterConflict, formatNote).map((i) => i.card.id),
    ["d3"],
    "stepper: refuses to auto-retry stale-rev draft until re-saved",
  );

  const resavedD2 = stepperMod.saveDraft(reconciledAfterConflict, "d2", { option: "1", note: "reconfirmed for rev 2", unticked: new Map() }, false);
  assert.equal(stepperMod.isStaleDraft(resavedD2.cards.find((c) => c.id === "d2")!, resavedD2.drafts.get("d2")!), false, "stepper: re-saving stamps new rev");
  assert.deepEqual(
    stepperMod.submittableDrafts(resavedD2, formatNote).map((i) => i.card.id),
    ["d2", "d3"],
    "stepper: re-saved draft becomes submittable again",
  );

  const droppedFailedMissing = stepperMod.reconcileStepper(afterPartial, [c3]);
  assert.deepEqual(
    droppedFailedMissing.cards.map((c) => c.id),
    ["d3"],
    "stepper: missing failed card drops out with the same rule as any missing card",
  );
  assert.equal(droppedFailedMissing.droppedAnswered, 1, "stepper: counts missing failed card in notice");
  assert.equal(droppedFailedMissing.failures.has("d2"), false, "stepper: clears failure for dropped missing card");

  const staleSent: string[] = [];
  const staleRes = await stepperMod.submitBatch(stepperMod.submittableDrafts(s2, formatNote), {
    waitForUnlock: async () => {},
    latestCard: (id) => (id === "d2" ? { ...c2, rev: 9 } : [c1, c2, c3].find((c) => c.id === id)),
    sendOne: async (card) => {
      staleSent.push(`${card.id}@${card.rev}`);
      return { ok: true };
    },
  });
  assert.deepEqual(staleSent, ["d1@1", "d3@1"], "stepper: never sends stale rev during batch");
  assert.equal(staleRes.failed.has("d2"), true, "stepper: marks mid-batch rev change as failed");
});
