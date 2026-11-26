import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { FRESH_DEBOUNCE_MS, freshRead, spaced, turnDelay } from "../app/fresh-read.ts";

test("a read is read again when its answer turns by the clock, never sooner and never in a loop", () => {
  assert.equal(turnDelay(undefined), null, "no answer yet");
  assert.equal(turnDelay({ now: 1000, turnsAt: null }), null, "nothing shown turns by the clock");
  assert.equal(turnDelay({ now: 1000, turnsAt: 61_000 }), 60_000);
  assert.equal(turnDelay({ now: 1000, turnsAt: 900 }), 0, "already due: at once");
  assert.equal(turnDelay({ now: 0, turnsAt: 36000 * 60 * 1000 }), 2 ** 31 - 1, "a resend setting of 36000 minutes: setTimeout runs a longer delay at once, and each read would arm it again");
});

function clock(t: { after: (f: () => void) => void }) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  t.after(() => mock.timers.reset());
  // in 10 ms steps: a mocked Date reads the end of the tick its timer fired in; a settled read's callbacks run between
  const tick = async (ms: number) => {
    for (let i = 0; i < ms; i += 10) {
      mock.timers.tick(10);
      await new Promise((r) => setImmediate(r));
    }
  };
  return { tick, at: () => Date.now() };
}

const done = Promise.resolve();

test("notices every 500 ms never starve the read: each runs within 800 ms of the notice that queued it, and a deadline reads on time", async (t) => {
  const c = clock(t);
  const reads: number[] = [];
  const s = freshRead(() => (reads.push(c.at()), done), () => false);
  s.turnsIn(3300);
  const sent: number[] = [];
  for (let i = 0; i < 12; i++) {
    sent.push(c.at());
    s.notice();
    await c.tick(500);
  }
  assert.ok(reads.includes(3300), `the deadline read at its time, through the notices: ${reads}`);
  const forNotices = reads.filter((r) => r !== 3300);
  assert.ok(forNotices.length >= 5, `the notices were read while they kept coming: ${forNotices}`);
  assert.equal(forNotices[0], FRESH_DEBOUNCE_MS, "the first notice's read is not pushed back by the next ones");
  let prev = -Infinity;
  for (const r of forNotices) {
    const queuedBy = sent.find((x) => x > prev)!;
    assert.ok(r >= queuedBy && r - queuedBy <= FRESH_DEBOUNCE_MS, `read at ${r}, queued by the notice at ${queuedBy}`);
    prev = r;
  }
});

// bb's refetch: a read started while another is in flight cancels that one, which then never reaches the cache
function slowQuery(c: { at: () => number }, ms: number) {
  let latest = 0;
  let inFlight = 0;
  const q = { maxInFlight: 0, landed: [] as { sent: number; at: number }[] };
  const refetch = () => {
    const id = ++latest;
    const sent = c.at();
    q.maxInFlight = Math.max(q.maxInFlight, ++inFlight);
    return new Promise<void>((done) =>
      setTimeout(() => {
        inFlight--;
        if (id === latest) q.landed.push({ sent, at: c.at() });
        done();
      }, ms),
    );
  };
  return { q, refetch };
}

test("slow reads under notices every 250 ms: one read at a time, the cache updates during the burst, and the deadline lands", async (t) => {
  const c = clock(t);
  const { q, refetch } = slowQuery(c, 1250);
  const s = freshRead(refetch, () => false);
  s.turnsIn(3300);
  for (let i = 0; i < 32; i++) {
    s.notice();
    await c.tick(250);
  }
  const burstEnd = c.at();
  assert.equal(q.maxInFlight, 1, "a read never starts while another is in flight, so none is cancelled");
  const during = q.landed.filter((l) => l.at <= burstEnd);
  assert.ok(during.length >= 4, `reads reached the cache while the notices kept coming: ${JSON.stringify(q.landed)}`);
  assert.ok(during.some((l) => l.sent >= 3300 && l.at <= 3300 + 2 * 1250), `a read sent at or after the deadline reached the cache within two reads of it: ${JSON.stringify(q.landed)}`);
  await c.tick(3000);
  assert.ok(q.landed.at(-1)!.sent >= burstEnd - 250, "the last notice's read lands after the burst");
});

test("a deadline that comes during a slow read is not dropped: it reads once that read settles", async (t) => {
  const c = clock(t);
  const sent: number[] = [];
  const s = freshRead(() => (sent.push(c.at()), new Promise<void>((r) => setTimeout(r, 1250))), () => false);
  s.opened(true);
  s.turnsIn(500);
  await c.tick(3000);
  assert.deepEqual(sent, [0, 1250]);
});

test("a read that throws before it starts leaves the schedule working", async (t) => {
  const c = clock(t);
  let n = 0;
  const s = freshRead(() => {
    if (n++ === 0) throw new Error("no read");
    return done;
  }, () => false);
  s.opened(true);
  await c.tick(10);
  s.opened(true);
  assert.equal(n, 2);
});

test("a view opened on a cached copy reads it at once; one with nothing cached leaves the read to the query", (t) => {
  clock(t);
  let n = 0;
  const s = freshRead(() => (n++, done), () => false);
  s.opened(false);
  assert.equal(n, 0);
  s.opened(true);
  assert.equal(n, 1, "a reply that came while it was closed, with its notice gone, shows on reopening");
});

test("a view turned off drops its queued read and its deadline, so nothing reads a query it no longer shows", async (t) => {
  const c = clock(t);
  let n = 0;
  let isHidden = true;
  const s = freshRead(() => (n++, done), () => isHidden);
  s.notice();
  s.turnsIn(100);
  await c.tick(200);
  s.stop();
  await c.tick(5000);
  isHidden = false;
  s.shown();
  assert.equal(n, 0, "nor a read that was due while hidden");
});

test("a view whose query changes forgets the read still pending for the old one, so the new query's reads run", async (t) => {
  const c = clock(t);
  let target = "old";
  const sent: string[] = [];
  const s = freshRead(() => (sent.push(target), target === "old" ? new Promise<void>(() => {}) : done), () => false);
  s.opened(true);
  target = "new";
  s.stop();
  s.opened(true);
  s.notice();
  await c.tick(1000);
  assert.deepEqual(sent, ["old", "new", "new"], "bb leaves the old query's read pending: the new one reads at once and after its notice");
});

test("a late answer for the old query starts nothing while the new query's read is in flight", async (t) => {
  const c = clock(t);
  let target = "old";
  let answerOld!: () => void;
  const sent: string[] = [];
  const s = freshRead(() => (sent.push(target), target === "old" ? new Promise<void>((r) => (answerOld = r)) : new Promise<void>((r) => setTimeout(r, 1000))), () => false);
  s.opened(true);
  target = "new";
  s.stop();
  s.opened(true);
  s.notice();
  await c.tick(900);
  answerOld();
  await c.tick(50);
  assert.deepEqual(sent, ["old", "new"], "a read started now would cancel the new one in flight");
  await c.tick(1100);
  assert.deepEqual(sent, ["old", "new", "new"], "the notice's read runs once the new read lands");
});

// react-query: with nothing cached yet, a refetch joins the fetch in flight instead of starting one
test("a read that joins the first fetch in flight reads once more when it lands, so a change made meanwhile shows", async (t) => {
  const c = clock(t);
  let server = 0;
  let data: number | undefined;
  let inFlight: Promise<void> | undefined;
  let latest = 0;
  const fetch = () => {
    const id = ++latest;
    const v = server;
    return (inFlight = new Promise<void>((done) =>
      setTimeout(() => {
        if (id === latest) [data, inFlight] = [v, undefined];
        done();
      }, 1000),
    ));
  };
  const refetch = () => (inFlight && data === undefined ? inFlight : fetch());
  // the hook sees the query as of its last render, which comes a tick after the fetch lands
  let seen = { data, fetching: false };
  const render = () => {
    const next = { data, fetching: inFlight !== undefined };
    setTimeout(() => ((seen = next), render()), 10);
  };
  render();
  const s = freshRead(refetch, () => false, () => seen.data === undefined && seen.fetching);
  void fetch();
  s.opened(false);
  await c.tick(100);
  server = 1;
  s.notice();
  await c.tick(3000);
  assert.equal(data, 1, "the notice's read joined a fetch sent before the change");
  assert.equal(latest, 2, "one more fetch, not one per read that saw the old render");
});

test("a read due while the page is hidden runs once when it is shown", async (t) => {
  const c = clock(t);
  let n = 0;
  let isHidden = true;
  const s = freshRead(() => (n++, done), () => isHidden);
  s.turnsIn(100);
  s.notice();
  await c.tick(1000);
  assert.equal(n, 0);
  isHidden = false;
  s.shown();
  s.shown();
  assert.equal(n, 1);
});

test("Delivered's disk rereads: a focus inside the gap is not dropped, it reads once when the gap ends", async (t) => {
  const c = clock(t);
  const reads: number[] = [];
  const disk = spaced(() => reads.push(c.at()), 1000);
  disk.call();
  assert.deepEqual(reads, [0], "the first focus reads at once");
  await c.tick(300);
  disk.call();
  await c.tick(100);
  disk.call();
  assert.deepEqual(reads, [0], "focus again within the second: not yet");
  await c.tick(600);
  assert.deepEqual(reads, [0, 1000], "one read when the gap ends, for both");
  await c.tick(5000);
  disk.call();
  assert.deepEqual(reads, [0, 1000, 6000], "after the gap, at once again");
  disk.call();
  disk.stop();
  await c.tick(5000);
  assert.deepEqual(reads, [0, 1000, 6000], "stopped: the trailing read is dropped with the page");
});
