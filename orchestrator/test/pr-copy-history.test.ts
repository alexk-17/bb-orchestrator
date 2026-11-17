import assert from "node:assert/strict";
import { test } from "node:test";
import { copySummary } from "../core/pr-copy-summary.ts";
import { changesSinceCopy, saveCopy, snapshotRow, type CopyHistory, type SnapshotPr } from "../core/pr-copy-history.ts";

const row = (n = 1, patch: Partial<SnapshotPr> = {}): SnapshotPr => ({ url: `https://github.com/acme/widgets/pull/${n}`, nodeId: `PR_${n}`, repo: "acme/widgets", number: n, title: "Fix widgets", bucket: "needs-review", sha: "one", review: "review required", approvers: [], ci: "pending", ...patch });

test("body summary prefers Summary/What, takes one sentence, strips ticket and markdown noise", () => {
  assert.equal(copySummary("Intro about an unrelated thing.\n\n## Summary\n\n- Fixes **links** in [chat](https://example.com). Second sentence.\n\n## Tests\nPassed.", "feat(ui): title"), "Fixes links in chat.");
  assert.equal(copySummary("## What changed\nCloses ENG-123.\n\nKeeps `drafts` after refresh. Adds another thing.", "title"), "Keeps drafts after refresh.");
  assert.equal(copySummary("## What\n[ENG-123](https://linear.app/a/issue/ENG-123)\n\nShows &amp; saves the choice. Second.", "title"), "Shows & saves the choice.");
  assert.equal(copySummary("First paragraph has the answer. Another sentence.\n\nNext paragraph.", "title"), "First paragraph has the answer.");
  assert.equal(copySummary("<!-- private -->\n```js\nwrong();\n```\n![image](https://image.test)\n\n## Summary\nhttps://github.com/acme/widgets/pull/9\n\nFixes the button.", "title"), "Fixes the button.");
});

test("summary falls back to the unprefixed title and caps output to 140 characters", () => {
  assert.equal(copySummary("## Summary\n- [ ] TODO\n\n## Tests\nPassed.", "fix(ui)!: Keep the selection [ENG-123]"), "Keep the selection");
  assert.equal(copySummary("", "feat(api): Handle retries"), "Handle retries");
  assert.ok(copySummary("## Summary\n" + "word ".repeat(60), "title").length <= 140);
  assert.equal(copySummary("", "Human title: keeps the colon"), "Human title: keeps the colon");
});

test("first copy has no delta; subsequent copies compare all requested fields", () => {
  assert.deepEqual(changesSinceCopy({}, [row()], {}), []);
  const before = saveCopy({}, [row()], null, 100);
  const changed = row(1, { bucket: "approved", sha: "two", review: "approved", approvers: ["alice"], ci: "pass", title: "Fix widgets safely" });
  const delta = changesSinceCopy(before, [changed, row(2)], {});
  assert.equal(delta.length, 2);
  assert.deepEqual(delta[0]!.reasons, ["Needs a review → Has a human approval", "New commits", "Reviews changed", "CI: pending → pass", "Title changed"]);
  assert.ok(delta[1]!.reasons[0]!.includes("New PR"));
  assert.deepEqual(changesSinceCopy(saveCopy(before, [changed, row(2)], null, 200), [changed, row(2)], {}), []);
});

test("section copies preserve other section baselines, including moves out and an empty section", () => {
  const old = saveCopy({}, [row(), row(2, { bucket: "approved" })], null, 100);
  const current = [row(1, { bucket: "approved" }), row(2, { bucket: "approved", sha: "new" })];
  const next = saveCopy(old, current, "needs-review", 200);
  assert.deepEqual(next.approved, old.approved);
  assert.equal(next["needs-review"]!.at, 200);
  assert.deepEqual(next["needs-review"]!.prs, []);
  assert.ok(changesSinceCopy(next, current, {}).some((c) => c.url === row(2).url && c.reasons.includes("New commits")));
});

test("disappearances require an explicit GitHub state; still-open/unknown/truncated reads aren't closures", () => {
  const before = saveCopy({}, [row(), row(2), row(3)], null, 100);
  const delta = changesSinceCopy(before, [], { [row().url]: "MERGED", [row(2).url]: "CLOSED", [row(3).url]: "OPEN" });
  assert.deepEqual(delta.map((d) => d.reasons), [["Merged"], ["Closed"], ["No longer listed (still open)"]]);
  assert.deepEqual(changesSinceCopy(before, [], {})[0]!.reasons, ["No longer listed (status unconfirmed)"]);
  assert.match(changesSinceCopy(before, [row(1, { bucket: null })], {})[0]!.reasons[0]!, /Outside review sections/);
});

test("approver order and case do not create a false change; snapshots are copies, not aliases", () => {
  const r = row(1, { approvers: ["Alice", "bob"] });
  const before = saveCopy({}, [r], null, 100);
  assert.deepEqual(changesSinceCopy(before, [row(1, { approvers: ["BOB", "alice"] })], {}), []);
  r.approvers.push("charlie");
  assert.deepEqual(before["needs-review"]!.prs[0]!.approvers, ["alice", "bob"]);
  assert.deepEqual(snapshotRow(r).approvers, ["alice", "bob", "charlie"]);
});

test("copy storage survives recreation, isolates logins and serializes concurrent section writes", async () => {
  const { createCopyStore } = await import("../open-prs/copy-store.ts");
  const values = new Map<string, unknown>();
  const kv = { get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined, set: async <T>(key: string, value: T) => { values.set(key, structuredClone(value)); } };
  const store = createCopyStore(kv, () => 123);
  await Promise.all([
    store.remember({ login: "Alice", section: "needs-review", prs: [row()] }),
    store.remember({ login: "alice", section: "approved", prs: [row(2, { bucket: "approved" })] }),
  ]);
  const restored = await createCopyStore(kv).read("ALICE");
  assert.equal(restored["needs-review"]!.prs[0]!.number, 1);
  assert.equal(restored.approved!.prs[0]!.number, 2);
  assert.deepEqual(await store.read("bob"), {});
});

test("a failed storage write keeps the old baseline and doesn't poison the next copy", async () => {
  const { createCopyStore } = await import("../open-prs/copy-store.ts");
  let value: unknown, fail = false;
  const kv = { get: async <T>() => structuredClone(value) as T | undefined, set: async <T>(_key: string, next: T) => { if (fail) throw new Error("disk full"); value = structuredClone(next); } };
  const store = createCopyStore(kv, () => 100);
  await store.remember({ login: "alice", section: null, prs: [row()] });
  fail = true;
  await assert.rejects(store.remember({ login: "alice", section: null, prs: [row(2)] }), /disk full/);
  assert.equal((await store.read("alice"))["needs-review"]!.prs[0]!.number, 1);
  fail = false;
  await store.remember({ login: "alice", section: null, prs: [row(3)] });
  assert.equal((await store.read("alice"))["needs-review"]!.prs[0]!.number, 3);
});

test("summary and scoped change header appear in both clipboard flavors; opt-out keeps both flavors clean", async () => {
  const { formatReviewQueue } = await import("../core/pr-review-queue.ts");
  const p = { ...row(), author: "author", reviewers: [], mentions: [], copySummary: "Keeps links & names readable." };
  const changes = changesSinceCopy(saveCopy({}, [row(1, { sha: "old" })], null, 100), [p], {});
  const copied = formatReviewQueue([p], "needs-review", changes);
  assert.match(copied.text, /^Changes since last copy\n• widgets#1: New commits/);
  assert.match(copied.html, /<strong>Changes since last copy<\/strong>/);
  assert.match(copied.html, /<br>Keeps links &amp; names readable/);
  assert.match(copied.text, /\n  Keeps links & names readable/);
  assert.ok(!formatReviewQueue([p]).text.includes("Changes since last copy"));
  assert.ok(!formatReviewQueue([p], "approved", changes).text.includes("New commits"));
  assert.ok(!copied.html.includes("|widgets#"));
});

test("inline What sections beat template TL;DR labels and generated release headings", () => {
  assert.equal(copySummary("**TL;DR.** Fix disappearing instructions. Another sentence.\n\n**Touches.** API and chat\n\n**What changes.** Reloading a run restores waiting instructions. Delivered instructions stay absent.\n\n## Summary\n- **Bug Fixes**\n  - Generic generated summary.", "fix(api): title"), "Reloading a run restores waiting instructions.");
  assert.equal(copySummary("**TL;DR.** Keeps links readable. Other details.", "title"), "Keeps links readable.");
  assert.equal(copySummary("## Summary\n- **Bug Fixes**\n  - Keeps links readable. Other details.", "title"), "Keeps links readable.");
  assert.equal(copySummary("Useful first paragraph. More detail.\n\n## Summary\nTODO\n\n## Tests\nPassed.", "title"), "Useful first paragraph.");
});
