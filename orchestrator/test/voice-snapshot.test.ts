import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, estimateTokens, SNAPSHOT_TOKENS } from "../voice/snapshot.ts";
import { NOW, board, card } from "./voice-fixtures.ts";

test("the snapshot carries cards, projects, PR waits, deliverables and messages", () => {
  const s = buildSnapshot(board(), NOW);
  for (const want of ["card D0001 (rev 1)", "options: 1=Small (recommended); 2=Large", "alpha-api: high", "beta-web: normal, held", "waits on: a design review", "W1 [alpha-api] export endpoint", "passing, approved", "deliverable X1 (rev 1) [beta-web] New settings page", "Ship the export behind a flag", "Choose a logo: The blue one"]) {
    assert.ok(s.includes(want), `missing: ${want}\n${s}`);
  }
});

test("cards are oldest first; the oldest ten in full, the rest by title only", () => {
  const b = board(14);
  const s = buildSnapshot(b, NOW);
  // card 14 is the oldest (askedAt NOW - 14 min)
  assert.ok(s.indexOf("card D0014") < s.indexOf("card D0001"));
  assert.ok(s.includes("Which cache size should widget 14 use?"), "oldest has its question");
  assert.ok(s.includes("Which cache size should widget 5 use?"), "tenth oldest has its question");
  assert.ok(!s.includes("Which cache size should widget 4 use?"), "eleventh oldest is title only");
  assert.ok(s.includes("card D0004"), "but still listed");
});

test("the snapshot stays within its token budget on a large board, and keeps the cards", () => {
  const b = board(60);
  b.cards = b.cards.map((c) => ({ ...c, question: "Q ".repeat(300), title: `${c.title} ${"t".repeat(80)}` }));
  b.messages = Array.from({ length: 40 }, (_, i) => ({ at: NOW - i * 1000, from: "owner", to: "alpha-api lead", text: "m".repeat(400) }));
  const s = buildSnapshot(b, NOW);
  assert.ok(estimateTokens(s) <= SNAPSHOT_TOKENS, `${estimateTokens(s)} tokens`);
  assert.ok(s.includes("card D0060"), "the oldest card survives trimming");
});

test("ages read as minutes, hours and days", () => {
  const b = board(0);
  b.cards = [card(1, { askedAt: NOW - 2 * 3_600_000 }), card(2, { askedAt: NOW - 3 * 86_400_000 })];
  const s = buildSnapshot(b, NOW);
  assert.ok(s.includes("waiting 2h"));
  assert.ok(s.includes("waiting 3d"));
});
