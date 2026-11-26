// The slow-read log (lag fix, 2026-11-24): when the page lags, the log must say which read was slow, and only then. A line
// per read would drown the log; none for a read that threw would hide the slowest failures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loopDelay, SLOW_READ_MS, timeReads } from "../core/slow-reads.ts";

test("a read slower than 500 ms is reported once, by name; a faster one is not", async () => {
  let t = 0;
  const slow: [string, number][] = [];
  const h = timeReads(
    {
      fast: async () => ((t += SLOW_READ_MS - 1), "a"),
      slow: async () => ((t += SLOW_READ_MS + 250), "b"),
      sync: () => ((t += 900), "c"),
      fails: async () => {
        t += 2_000;
        throw new Error("made-up failure");
      },
      notAFunction: 3,
    },
    (name, ms) => slow.push([name, ms]),
    () => t,
  );
  assert.equal(await h.fast(), "a");
  assert.equal(await h.slow(), "b");
  assert.equal(h.sync(), "c", "a sync read stays sync");
  await assert.rejects(h.fails(), /made-up failure/);
  assert.equal(h.notAFunction, 3);
  assert.deepEqual(slow, [["slow", SLOW_READ_MS + 250], ["sync", 900], ["fails", 2_000]]);
});

test("the event loop's delay is reported only while sampled, and starts over after each report", async () => {
  const d = loopDelay();
  assert.equal(d.take(), null, "not started");
  d.start();
  await new Promise((r) => setTimeout(r, 60)); // its sampling timer is running
  const until = Date.now() + 120;
  while (Date.now() < until); // block the loop
  await new Promise((r) => setTimeout(r, 60));
  const got = d.take();
  assert.ok(got && got.max >= 50, JSON.stringify(got));
  const next = d.take();
  assert.ok(next === null || next.max < 50, `the block was reported already: ${JSON.stringify(next)}`);
  d.stop();
  assert.equal(d.take(), null, "stopped");
});
