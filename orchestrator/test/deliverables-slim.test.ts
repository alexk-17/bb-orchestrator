// The Deliverables list is slim (2026-11-23, lag: 743 KB for 200 deliverables on every change): a past row carries only
// what its closed card shows, a card opened reads its deliverable whole, and search and Files read every revision from
// the index read. What the owner sees must not change: an in-review card is whole at once, an opened one matches the
// old list's row exactly, and search and Files still find what only an older revision holds.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "../core/engine.ts";
import { deliverableIndex, deliverableRow, deliverableRows, deliverableWhole, lookups } from "../core/deliverables-view.ts";
import { deliverableIndexSchema, deliverableSchema, deliverablesSchema } from "../contract.ts";
import { expand, isPartial } from "../app/deliverable-data.ts";
import { START, deliverablesTab, shownDeliverable } from "../app/past.ts";
import { onDeliverablesTab } from "../app/kit.ts";

const scratchRoot = join(import.meta.dirname, ".scratch");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "slim-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const file = (rel: string) => {
  const p = join(scratch, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "x");
  return p;
};
const env = join(scratch, "env");
const place = { roots: [{ path: env, hostId: "host-a" }] };
const first = file("env/shots/first-try.png");
const second = file("env/shots/second-try.png");
const notes = file("env/out/old-notes.txt");

function setup() {
  let clock = Date.parse("2026-11-20T09:00:00Z");
  const e = new Engine(new DatabaseSync(":memory:") as never, { now: () => clock, deliver: async () => ({ delivery: "sent" as const }), mirror: () => {}, changed: () => {}, log: () => {} }, { batchInbox: false });
  const lead = e.register("T-lead", "lead", "alpha");
  const tick = () => (clock += 60_000);
  // rev 1: a finding only it states, and a text file only it proves with; rev 2 replaces both; then approved
  const d = e.deliver(lead, { title: "Checkout", summary: "First try.", points: [{ kind: "finding", headline: "Totals were rounded twice", why: "the old cart and the new tax line" }, { kind: "decision", headline: "Keep the old cart", why: "fewer moves" }], proof: [{ kind: "image", caption: "before", path: first }, { kind: "text", caption: "notes", path: notes }] }, place);
  tick();
  e.personRequestChanges(d.id, 1, "Round once.");
  tick();
  e.deliver(lead, { title: "Checkout", summary: "Rounded once.", revises: d.id, proof: [{ kind: "image", caption: "after", path: second }] }, place);
  tick();
  e.personApprove(d.id, 2, null);
  tick();
  const open = e.deliver(lead, { title: "Search box", summary: "Wider box.", proof: [{ kind: "image", caption: "box", path: second }] }, place);
  return { e, past: d.id, open: open.id, lead, tick, hold: () => clock };
}

test("a past row is slim: no revisions, only its shown revision's summary, proof count and first screenshot; a row in review stays whole", () => {
  const s = setup();
  const rows = deliverablesSchema.parse(deliverableRows(s.e));
  const past = rows.find((r) => r.id === s.past)!;
  assert.equal(past.revisions, null, "a past row leaves its revisions to the opened card");
  assert.equal(past.latest?.rev, 2);
  assert.equal(past.latest?.summary, "Rounded once.");
  assert.equal(past.latest?.proofs, 1);
  assert.equal(past.latest?.shot?.caption, "after", "the closed card's screenshot is the shown revision's first image");
  const open = rows.find((r) => r.id === s.open)!;
  assert.equal(open.revisions?.length, 1, "a card in review draws at once, whole");
  assert.deepEqual(expand(rows)!.find((d) => d.id === s.open), deliverableWhole(s.e, s.open), "in review, the row is the whole deliverable");
});

test("opening a card reads it whole: exactly what the old list carried for it, every revision with its proof", () => {
  const s = setup();
  const whole = deliverableSchema.parse(deliverableWhole(s.e, s.past));
  assert.deepEqual(whole, deliverableRow(s.e, s.e.deliverable(s.past)!, lookups(s.e)));
  assert.deepEqual(whole.revisions.map((r) => r.rev), [1, 2]);
  assert.equal(deliverableWhole(s.e, "v-none"), null);
  // a rebuilt row is marked, so the card knows to read it whole; a row in review isn't
  const ds = expand(deliverablesSchema.parse(deliverableRows(s.e)))!;
  assert.equal(isPartial(ds.find((d) => d.id === s.past)!), true);
  assert.equal(isPartial(ds.find((d) => d.id === s.open)!), false);
});

test("search finds words only an older revision's points hold, and Files a proof file only an older revision filed, once the index is in", () => {
  const s = setup();
  const rows = deliverablesSchema.parse(deliverableRows(s.e));
  const index = deliverableIndexSchema.parse(deliverableIndex(s.e));
  const withIndex = expand(rows, index)!;
  const hits = (q: string) => deliverablesTab(withIndex, [], { ...START, query: q }).past.map((d) => d.id);
  assert.deepEqual(hits("rounded twice"), [s.past], "rev 1's finding");
  assert.deepEqual(hits("old cart"), [s.past], "rev 1's why");
  const files = deliverablesTab(withIndex, [], { ...START, filter: "files", query: "old-notes" }).files;
  assert.deepEqual(files.map((f) => [f.d?.id, f.name]), [[s.past, "old-notes.txt"]], "rev 1's text file is still under Files");
  // until the index is in, search reads what the slim rows hold: the shown revision only
  const slimHits = deliverablesTab(expand(rows)!, [], { ...START, query: "rounded" }).past.map((d) => d.id);
  assert.deepEqual(slimHits, [s.past], "the shown revision's summary is searchable at once");
});

test("the slim list is much smaller than the whole one for the same deliverables", () => {
  const s = setup();
  const whole = JSON.stringify(s.e.deliverables(200).map((d) => deliverableRow(s.e, d, lookups(s.e))));
  const slim = JSON.stringify(deliverableRows(s.e));
  assert.ok(slim.length < whole.length, `${slim.length} < ${whole.length}`);
});

// 2026-11-24: on desktop with nothing in review, Delivered opens on its newest past card by itself. Drawn from a slim row
// it showed a loading skeleton until its whole read came back, where the whole list drew it at once. The list carries
// that one card whole, so the server must pick exactly the card the screen shows, whatever else is listed.
test("the card Delivered shows on its own is whole in the list: the screen's own pick, never drawn loading", () => {
  const s = setup();
  const check = (why: string, want: string, pastWhole: string[]) => {
    const rows = deliverablesSchema.parse(deliverableRows(s.e));
    const shown = shownDeliverable(expand(rows)!.filter(onDeliverablesTab), null)!;
    assert.equal(shown.id, want, why);
    assert.equal(isPartial(shown), false, `${why}: whole at once`);
    assert.deepEqual(shown, deliverableWhole(s.e, shown.id), `${why}: exactly the opened card's read`);
    assert.deepEqual(rows.filter((r) => r.revisions && r.state !== "review").map((r) => r.id), pastWhole, `${why}: no other past row grows`);
  };
  check("a card in review is the one shown, whole already", s.open, []);
  s.tick();
  s.e.personApprove(s.open, 1, null);
  check("nothing in review: the newest past card", s.open, [s.open]);
  s.tick();
  const t = s.e.openTask(s.lead, "Export format");
  s.e.deliver(s.lead, { title: "Export spike", summary: "Costs.", proof: [{ kind: "link", caption: "notes", url: "https://example.com/n" }], scopeTask: t.id }, { roots: [] });
  check("a newer scoping review is the Scope tab's, not this one's", s.open, [s.open]);
  s.tick();
  s.e.deliver(s.lead, { title: "Review widgets#41", summary: "Changes requested.", proof: [{ kind: "link", caption: "review", url: "https://example.com/review" }], board: { id: "b-1" } }, { roots: [] });
  check("a newer board review is Multiplayer's", s.open, [s.open]);
  // two past cards saved in the same millisecond: the server breaks the tie as the screen does
  s.tick();
  const link = [{ kind: "link" as const, caption: "x", url: "https://example.com/x" }];
  const one = s.e.deliver(s.lead, { title: "Tie one", summary: "Same time.", proof: link }, { roots: [] });
  const two = s.e.deliver(s.lead, { title: "Tie two", summary: "Same time.", proof: link }, { roots: [] });
  s.tick();
  s.e.personApprove(two.id, 1, null);
  s.e.personRequestChanges(one.id, 1, "One more pass.");
  const tied = [one.id, two.id].sort().reverse();
  assert.equal(s.e.deliverable(one.id)!.updatedAt, s.e.deliverable(two.id)!.updatedAt, "the fixture ties");
  check("a tie at the newest time", tied[0]!, [tied[0]!]);
});

