// The popover's three rules, each of which the owner reads at a glance: the bar
// colour must agree with the ring, the accounts must stand in the order the pool
// spends them, and the reset time must say when, without making anyone count days.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DANGER, WARN, barOf, resetShort, routingOrder, toneOf } from "../lib/limits.ts";

test("tone: neutral under 60, amber from 60, red from 85, on the rounded figure shown", () => {
  assert.equal(WARN, 60);
  assert.equal(DANGER, 85);
  assert.equal(toneOf(null), "normal");
  assert.equal(toneOf(0), "normal");
  assert.equal(toneOf(59), "normal");
  assert.equal(toneOf(59.4), "normal");
  // 59.6 reads "60%": it must not stay grey
  assert.equal(toneOf(59.6), "warn");
  assert.equal(toneOf(60), "warn");
  assert.equal(toneOf(84), "warn");
  // 84.6 reads "85%": it must not stay amber
  assert.equal(toneOf(84.6), "danger");
  assert.equal(toneOf(85), "danger");
  assert.equal(toneOf(100), "danger");
});

test("bar: percent is rounded and clamped to 0–100, so an exhausted window is a full red bar", () => {
  const now = new Date(2026, 10, 20, 12, 0);
  const w = (label: string, usedPercent: number) => ({ label, usedPercent, resetsAt: null });
  assert.deepEqual(
    [barOf(w("Weekly limit", 100), now).percent, barOf(w("Weekly limit", 100), now).tone],
    [100, "danger"],
  );
  assert.equal(barOf(w("Weekly limit", 130), now).percent, 100);
  assert.equal(barOf(w("Weekly limit", -5), now).percent, 0);
  assert.equal(barOf(w("Weekly limit", 63.4), now).percent, 63);
  assert.equal(barOf(w("Weekly limit", 63.4), now).tone, "warn");
  assert.equal(barOf(w("Current session", NaN), now).percent, 0);
  // labels: the API's and the pooler's names for the same windows read the same
  assert.equal(barOf(w("Current session", 1), now).label, "Session");
  assert.equal(barOf(w("Five-hour limit", 1), now).label, "Session");
  assert.equal(barOf(w("Weekly limit", 1), now).label, "Week");
  assert.equal(barOf(w("Weekly · Fable", 1), now).label, "Fable");
  assert.equal(barOf(w("Weekly · Fable", 1), now).title, "Weekly · Fable");
});

test("reset: clock alone today, weekday within the week, date further out", () => {
  // Local-time dates, so the test holds in any timezone. 20 Nov 2026 is a Friday.
  const now = new Date(2026, 10, 20, 10, 0);
  const at = (d: number, h: number, m: number, s = 0) => new Date(2026, 10, d, h, m, s).toISOString();
  assert.equal(resetShort(at(20, 21, 20), now), "resets 21:20");
  assert.equal(resetShort(at(24, 2, 0), now), "resets Tue 02:00");
  assert.equal(resetShort(at(26, 2, 0), now), "resets Thu 02:00");
  // a week away is the same weekday as today: a date, not "Fri"
  assert.equal(resetShort(at(27, 9, 0), now), "resets 27 Nov 09:00");
  // the API sends seconds; 23:59:40 rounds into tomorrow, and the day follows the rounding
  assert.equal(resetShort(at(20, 23, 59, 40), now), "resets Sat 00:00");
  assert.equal(resetShort(at(20, 14, 19, 59), now), "resets 14:20");
  assert.equal(resetShort(null, now), "");
  assert.equal(resetShort("not a date", now), "");
});

test("order: enabled accounts by priority (ties keep the order added), disabled ones last", () => {
  const a = (id: string, priority: number | null, enabled = true) => ({ id, priority, enabled });
  const order = routingOrder([
    a("off-first", 0, false),
    a("p200", 200),
    a("p100-added-first", 100),
    a("p100-added-second", 100),
    a("p-10", -10),
    a("off-late", 50, false),
  ]).map((x) => x.id);
  assert.deepEqual(order, ["p-10", "p100-added-first", "p100-added-second", "p200", "off-first", "off-late"]);
  // no pooler status (priority unknown): the list order stands
  assert.deepEqual(routingOrder([a("x", null), a("y", null), a("z", null)]).map((x) => x.id), ["x", "y", "z"]);
});
