// A project's head fits its room (2026-11-20, 1.36.1, the lead: "the message box must be whole without scrolling").
// The 1.36.1 transcript was sized from a constant for the rest of the head (240 px), which was 150 px short with a
// profile card, so the message box went under the fold. The height is now the measured room less the measured rest.
// These are the numbers the lead measured on the live app and the isolated bb's, so a constant in place of a measure,
// or a share that starves the cards, fails here; the browser check is test/e2e/chat-row.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HEAD_SHARE, TRANSCRIPT_MAX, TRANSCRIPT_MIN, transcriptFit } from "../app/head-fit.ts";

test("the transcript takes what the room leaves after the rest of the head, between 48 and 480 px", () => {
  // 1440x900 wide: a 704 px detail, its 16 px gap, a head of 379 px without the transcript (profile card, open row, box)
  const room = 704 * HEAD_SHARE - 16;
  assert.equal(transcriptFit(379, room), 74, "what is left, not a constant");
  assert.ok(379 + transcriptFit(379, room) + 16 <= 704 - 704 / 3 + 0.5, "the cards keep at least a third");
  // the 1.36.1 constant would have given 352 - 240 = 112 px: 150 px too tall with this head, so the box went under the fold
  assert.notEqual(transcriptFit(379, room), Math.round(704 / 2 - 240));
  // no profile card: more room for the transcript
  assert.equal(transcriptFit(255, room), 198);
  // a tall window: never past 480
  assert.equal(transcriptFit(255, 1400 * HEAD_SHARE - 16), TRANSCRIPT_MAX);
  // a short window (1440x640): never under 48; the head scrolls and the box stays stuck in view (projects.tsx)
  assert.equal(transcriptFit(379, 444 * HEAD_SHARE - 16), TRANSCRIPT_MIN);
});

test("wide, the head may take two thirds: the cards keep a third", () => {
  assert.ok(HEAD_SHARE > 0.5, "more than the old 50% cap, which hid Send at 1440x900");
  assert.ok(HEAD_SHARE <= 2 / 3, "the cards keep at least a third");
});
