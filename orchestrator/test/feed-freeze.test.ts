// Why: a click on another Home filter is itself a pressed pointer, and the freeze drew the old filter's posts as the new filter's list: "Nothing here yet" behind a "1 new" pill (3 of 3 on 1.26.1 and 1.28.0).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const feed = readFileSync(new URL("../app/feed.tsx", import.meta.url), "utf8");

test("the freeze under a pressed pointer holds only the same filter's last drawing", () => {
  assert.match(feed, /const view = frozen && last\.current\.filter === filter && last\.current\.feed \? last\.current\.feed : live;/);
  assert.match(feed, /last\.current = \{ filter, feed: view \};/, "each drawing is remembered with its filter");
  assert.doesNotMatch(feed, /frozen && last\.current \? last\.current : live/);
});
