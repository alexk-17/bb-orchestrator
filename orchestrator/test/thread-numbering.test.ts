// A thread's number is one past the highest ever given in its project. register() counted the project's thread rows,
// but a retired thread re-registering deletes its own retired row first, so the count stood still: five retired threads
// re-registering into one project all got the same number, the first took it, and the other four failed with
// "conflict: thread:<project>:N is already taken".
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine } from "../core/engine.ts";
import { MIGRATIONS } from "../core/db.ts";

function setup() {
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, { now: () => Date.parse("2026-11-19T04:00:00Z"), deliver: async () => ({ delivery: "held", why: "test" }), mirror: () => {}, changed: () => {}, log: () => {} });
  e.register("T-la", "lead", "alpha");
  return { e, db };
}

test("the first thread in a project is :1, and each next one counts up", () => {
  const { e } = setup();
  assert.equal(e.register("T-1", "thread", "alpha", "T-la").address, "thread:alpha:1");
  assert.equal(e.register("T-2", "thread", "alpha", "T-la").address, "thread:alpha:2");
});

test("five retired threads re-register: each gets a distinct new number past every old one, with no conflict", () => {
  const { e, db } = setup();
  for (let i = 1; i <= 23; i++) e.register(`T-${i}`, "thread", "alpha", "T-la");
  const rehomed = ["T-19", "T-20", "T-21", "T-22", "T-23"];
  for (const t of rehomed) e.setStatus(t, "archived"); // retired: their rows keep :19–:23
  const got = rehomed.map((t) => e.register(t, "thread", "alpha", "T-la").address);
  assert.deepEqual(got, ["thread:alpha:24", "thread:alpha:25", "thread:alpha:26", "thread:alpha:27", "thread:alpha:28"]);
  const live = db.prepare(`SELECT address FROM agents WHERE project = 'alpha' AND role = 'thread' AND retired_at IS NULL`).all() as { address: string }[];
  assert.equal(new Set(live.map((r) => r.address)).size, live.length, "no live address is held twice");
});

test("a number a retired row still holds is never given again, nor the re-registering thread's own old one", () => {
  const { e } = setup();
  e.register("T-1", "thread", "alpha", "T-la");
  e.register("T-2", "thread", "alpha", "T-la");
  e.setStatus("T-2", "archived"); // :2 is the highest, held only by T-2's retired row
  assert.equal(e.register("T-3", "thread", "alpha", "T-la").address, "thread:alpha:3", "not :2: a retired row holds it");
  e.setStatus("T-3", "archived");
  assert.equal(e.register("T-3", "thread", "alpha", "T-la").address, "thread:alpha:4", "not its own old :3: items name that one");
});

test("gaps stay gaps: a missing number is not filled", () => {
  const { e, db } = setup();
  e.register("T-1", "thread", "alpha", "T-la");
  e.register("T-2", "thread", "alpha", "T-la");
  e.register("T-3", "thread", "alpha", "T-la");
  db.prepare(`DELETE FROM agents WHERE thread_id = 'T-2'`).run(); // a row gone, as a re-registration leaves it
  assert.equal(e.register("T-4", "thread", "alpha", "T-la").address, "thread:alpha:4");
});

test("numbers are per project: another project's threads don't move this one's", () => {
  const { e } = setup();
  e.register("T-lb", "lead", "beta");
  for (let i = 1; i <= 3; i++) e.register(`T-b${i}`, "thread", "beta", "T-lb");
  assert.equal(e.register("T-a1", "thread", "alpha", "T-la").address, "thread:alpha:1");
});

// Its number is the address items, history and references name: given twice, two unrelated threads share one history.
test("the highest-numbered retired thread moving to another project never frees its number in the old one", () => {
  const { e } = setup();
  e.register("T-lb", "lead", "beta");
  e.register("T-1", "thread", "alpha", "T-la");
  e.register("T-2", "thread", "alpha", "T-la");
  e.register("T-3", "thread", "alpha", "T-la");
  e.setStatus("T-3", "archived");
  assert.equal(e.register("T-3", "thread", "beta", "T-lb").address, "thread:beta:1", "its retired alpha row is gone");
  assert.equal(e.register("T-4", "thread", "alpha", "T-la").address, "thread:alpha:4", "not :3, which T-3 held");
});

test("the highest-numbered retired thread becoming a lead never frees its number either", () => {
  const { e } = setup();
  e.register("T-1", "thread", "alpha", "T-la");
  e.register("T-2", "thread", "alpha", "T-la");
  e.setStatus("T-2", "archived");
  assert.equal(e.register("T-2", "lead", "gamma").address, "lead:gamma");
  assert.equal(e.register("T-3", "thread", "alpha", "T-la").address, "thread:alpha:3", "not :2, which T-2 held");
  e.setStatus("T-3", "archived");
  e.register("T-3", "lead", "delta");
  assert.equal(e.register("T-4", "thread", "alpha", "T-la").address, "thread:alpha:4", "nor :3");
});

test("a database from before the counter is seeded from its agent rows and spawn history, so numbers already given stay given", () => {
  const db = new DatabaseSync(":memory:");
  const ports = { now: () => Date.parse("2026-11-19T04:00:00Z"), deliver: async () => ({ delivery: "held" as const, why: "test" }), mirror: () => {}, changed: () => {}, log: () => {} };
  const e = new Engine(db as never, ports);
  e.register("T-la", "lead", "alpha");
  for (let i = 1; i <= 5; i++) e.register(`T-${i}`, "thread", "alpha", "T-la");
  // the counter's own migration, found by its text: later ones (the Slack watcher's) come after it
  const counter = MIGRATIONS.findIndex((sql) => sql.startsWith("CREATE TABLE thread_numbers"));
  assert.ok(counter > 0);
  // as the old engine left it: no counter, :5's row gone with its move, :4's row still there; only spawn events remember :5
  db.exec(`DELETE FROM thread_numbers; DELETE FROM agents WHERE thread_id IN ('T-5'); DELETE FROM _migrations WHERE id = ${counter}; DROP TABLE thread_numbers`);
  const again = new Engine(db as never, ports);
  assert.deepEqual(db.prepare(`SELECT project, last FROM thread_numbers`).all().map((r) => ({ ...r })), [{ project: "alpha", last: 5 }]);
  assert.equal(again.register("T-6", "thread", "alpha", "T-la").address, "thread:alpha:6");
});
