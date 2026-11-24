// A hidden page's listeners (app/change-listener.ts, lag fix 2026-11-24) gather the notices that came while it was hidden
// and get them as one when it is shown again. That one notice must refetch every read any of them would have: a read
// left out stays stale until some later notice happens to touch it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeNotices, touches } from "../change-notice.ts";

test("notices missed while the page was hidden refetch, on return, every read any of them would have", () => {
  // app/change-listener.ts hands a listener the notices that came while hidden as one
  const m = mergeNotices({ tables: ["decisions"] }, { tables: ["items", "decisions"] });
  assert.deepEqual(m, { tables: ["decisions", "items"] });
  assert.ok(touches(m, "needsYou") && touches(m, "directHistory"), "each notice's reads");
  assert.ok(!touches(m, "config"));
  // a notice that names nothing (everything refetches) wins
  assert.deepEqual(mergeNotices({ tables: ["items"] }, { tables: null }), { tables: null });
  assert.deepEqual(mergeNotices({}, { tables: ["items"] }), { tables: null });
});
