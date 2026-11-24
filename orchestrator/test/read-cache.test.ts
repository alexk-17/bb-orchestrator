// bb's thread reads, kept briefly and shared (core/read-cache.ts; lag fix 2026-11-23). The agents read asked bb twice
// for every live agent on every change notice (64 calls for 32 agents) and needsYou once each: the page lagged by
// seconds. Kept reads must never hide a change bb announced: a forgotten thread is read again at once, and a read that
// was on its way when bb announced a change is not kept. Shared reads must never hand a later caller a result computed
// before a change it should see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReadCache, shareReads } from "../core/read-cache.ts";

function setup(ttl = 5_000) {
  const clock = { t: 1_000 };
  const cache = new ReadCache(ttl, () => clock.t);
  const calls: string[] = [];
  const load = (id: string, value: unknown = `v${calls.length}`) => () => {
    calls.push(id);
    return Promise.resolve(value);
  };
  return { clock, cache, calls, load };
}

/** A load that answers only when told: a bb call still on its way. */
function pending<T>() {
  let answer!: (v: T) => void;
  const p = new Promise<T>((r) => (answer = r));
  return { p, answer };
}

test("a thread's read is kept for the TTL: a second read within it asks bb nothing", async () => {
  const s = setup();
  assert.equal(await s.cache.thread("T1", "get", s.load("T1", "title A")), "title A");
  s.clock.t += 4_999;
  assert.equal(await s.cache.thread("T1", "get", s.load("T1", "title B")), "title A");
  assert.deepEqual(s.calls, ["T1"]);
});

test("after the TTL a read asks bb again (what bb doesn't announce, a title or the context use, is never older)", async () => {
  const s = setup();
  await s.cache.thread("T1", "get", s.load("T1", "title A"));
  s.clock.t += 5_001;
  assert.equal(await s.cache.thread("T1", "get", s.load("T1", "title B")), "title B");
  assert.deepEqual(s.calls, ["T1", "T1"]);
});

test("forgetting a thread (bb announced it changed) reads it again at once, and only it", async () => {
  const s = setup();
  for (const id of ["T1", "T2"]) for (const what of ["get", "context", "interactions"]) await s.cache.thread(id, what, s.load(`${id}:${what}`));
  s.calls.length = 0;
  s.cache.forget("T1");
  for (const id of ["T1", "T2"]) for (const what of ["get", "context", "interactions"]) await s.cache.thread(id, what, s.load(`${id}:${what}`));
  assert.deepEqual(s.calls, ["T1:get", "T1:context", "T1:interactions"], "T2's kept reads still serve");
});

test("one thread's id that prefixes another's never forgets the other", async () => {
  const s = setup();
  await s.cache.thread("T1", "get", s.load("T1"));
  await s.cache.thread("T10", "get", s.load("T10"));
  s.calls.length = 0;
  s.cache.forget("T1");
  await s.cache.thread("T10", "get", s.load("T10"));
  assert.deepEqual(s.calls, []);
});

test("callers while a read is on its way share it: one bb call", async () => {
  const s = setup();
  const slow = pending<string>();
  let n = 0;
  const a = s.cache.thread("T1", "get", () => (n++, slow.p));
  const b = s.cache.thread("T1", "get", () => (n++, slow.p));
  slow.answer("x");
  assert.deepEqual(await Promise.all([a, b]), ["x", "x"]);
  assert.equal(n, 1);
});

test("a read on its way when the thread is forgotten is not kept: it may predate the change", async () => {
  const s = setup();
  const before = pending<string>();
  const old = s.cache.thread("T1", "interactions", () => before.p);
  s.cache.forget("T1"); // e.g. the owner answered its prompt
  const fresh = s.cache.thread("T1", "interactions", s.load("T1", "after"));
  before.answer("before");
  assert.equal(await old, "before", "its own caller still gets its answer");
  assert.equal(await fresh, "after");
  assert.equal(await s.cache.thread("T1", "interactions", s.load("T1", "later")), "after", "the read after the change is the one kept");
});

test("a load that throws is not kept: the next read asks again", async () => {
  const s = setup();
  await assert.rejects(s.cache.thread("T1", "get", () => Promise.reject(new Error("down"))));
  assert.equal(await s.cache.thread("T1", "get", s.load("T1", "up")), "up");
});

test("concurrent shared reads wait on one computation, and nothing is kept once it settles", async () => {
  const s = setup();
  const slow = pending<number>();
  let runs = 0;
  const run = () => (runs++, slow.p);
  const a = s.cache.share("agents", run);
  const b = s.cache.share("agents", run);
  slow.answer(7);
  assert.deepEqual(await Promise.all([a, b]), [7, 7]);
  assert.equal(runs, 1);
  await s.cache.share("agents", () => (runs++, Promise.resolve(8)));
  assert.equal(runs, 2, "a read after it settled computes again");
});

test("a shared read started before a change is not joined by a read after it", async () => {
  const s = setup();
  for (const change of [() => s.cache.bump(), () => s.cache.forget("T1")]) {
    const slow = pending<string>();
    const before = s.cache.share("needsYou", () => slow.p);
    change(); // a database write, or bb's news of a thread
    const after = s.cache.share("needsYou", () => Promise.resolve("after"));
    slow.answer("before");
    assert.equal(await before, "before");
    assert.equal(await after, "after", "the read that started after the change sees it");
  }
});

test("a shared read that fails reaches every caller, and the next read runs again", async () => {
  const s = setup();
  let reject!: (e: Error) => void;
  const p = new Promise<never>((_, r) => (reject = r));
  const a = s.cache.share("scope", () => p);
  const b = s.cache.share("scope", () => p);
  reject(new Error("down"));
  await assert.rejects(a);
  await assert.rejects(b);
  assert.equal(await s.cache.share("scope", () => Promise.resolve("ok")), "ok");
});

test("shareReads shares only the named handlers, by input", async () => {
  const s = setup();
  const runs: string[] = [];
  const gate = pending<void>();
  const h = shareReads(s.cache, ["needsYou"], {
    needsYou: async (input: { zone: string }) => (runs.push(`n:${input.zone}`), await gate.p, input.zone),
    board: async () => (runs.push("b"), await gate.p, "board"),
  });
  const calls = [h.needsYou({ zone: "UTC" }), h.needsYou({ zone: "UTC" }), h.needsYou({ zone: "Europe/Paris" }), h.board(), h.board()];
  gate.answer();
  assert.deepEqual(await Promise.all(calls), ["UTC", "UTC", "Europe/Paris", "board", "board"]);
  assert.deepEqual(runs, ["n:UTC", "n:Europe/Paris", "b", "b"]);
});
