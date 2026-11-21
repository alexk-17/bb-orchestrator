// A thread's PR links in `prs` (2026-11-19). The Steward's prune pass listed threads with open PRs as "no PR on record",
// because it reads a thread's PRs by its thread id, as the project summaries do. Cause: after a handoff, the successor
// shares its predecessor's environment, but bb's reading of the PR doesn't change, and an unchanged reading wrote
// nothing, so the row kept naming the retired predecessor. A thread whose PR goes unseen looks finished (or prune-safe
// once an old PR of its environment merges), so the rows must follow the live holder.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, type DeliverResult, type PrResult } from "../core/engine.ts";
import { MIGRATIONS, migrate } from "../core/db.ts";
import { readThreadPrs } from "../core/pr-links.ts";
import { parseWaitReading } from "../core/open-prs.ts";
import { prHostDefs } from "../open-prs/host-contract.ts";

function setup() {
  let clock = Date.parse("2026-11-19T01:00:00Z");
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, {
    now: () => clock,
    deliver: async (): Promise<DeliverResult> => ({ delivery: "sent" }),
    mirror: () => {},
    changed: () => {},
    log: () => {},
  });
  e.register("T-cos", "cos", null);
  e.register("T-lead", "lead", "alpha");
  /** The PRs each live thread holds, read the way the Steward and the project summaries read them: by thread id. */
  const linked = () =>
    (db.prepare(`SELECT a.address, p.number FROM agents a JOIN prs p ON p.thread_id = a.thread_id WHERE a.retired_at IS NULL ORDER BY a.address, p.number`).all() as { address: string; number: number }[]).map(
      (r) => `${r.address} #${r.number}`,
    );
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return { e, db, linked, count, advance: (ms: number) => (clock += ms) };
}

const pr = (n: number, state = "draft"): PrResult => ({
  outcome: "available",
  pullRequest: { url: `https://github.com/example/app/pull/${n}`, number: n, state, attention: state, checks: { state: "passing" }, review: { state: "none" }, mergeability: { state: state === "draft" ? "draft" : "mergeable" } },
});

test("a handoff successor holds its environment's PR on the next reading, though the PR itself is unchanged", () => {
  const s = setup();
  const t = s.e.register("T-first", "thread", "alpha", "T-lead");
  s.e.setEnvironment(t.threadId, "env-1");
  s.e.prSeen(t, "env-1", pr(101));
  assert.deepEqual(s.linked(), ["thread:alpha:1 #101"]);
  s.advance(60_000);
  const next = s.e.takeOver(t.threadId, "T-second", "context full");
  const board = s.count(`SELECT count(*) AS n FROM board`);
  const items = s.count(`SELECT count(*) AS n FROM items`);
  assert.equal(s.e.prSeen(next, "env-1", pr(101)), false, "the same reading is still no news");
  assert.deepEqual(s.linked(), ["thread:alpha:1 #101"], "the live holder, T-second, holds it");
  assert.equal((s.db.prepare(`SELECT thread_id FROM prs WHERE environment_id = 'env-1'`).get() as { thread_id: string }).thread_id, "T-second");
  assert.equal(s.count(`SELECT count(*) AS n FROM board`), board, "re-linking is quiet: no Board row");
  assert.equal(s.count(`SELECT count(*) AS n FROM items`), items, "and no notice to anyone");
});

test("a reading that isn't available (bb found no PR, or the machine is off) still moves the environment's rows to the live holder", () => {
  const s = setup();
  const t = s.e.register("T-first", "thread", "alpha", "T-lead");
  s.e.setEnvironment(t.threadId, "env-1");
  s.e.prSeen(t, "env-1", pr(101, "merged"));
  const next = s.e.takeOver(t.threadId, "T-second", "context full");
  s.e.prSeen(next, "env-1", { outcome: "unavailable", message: "the machine is off" });
  assert.equal((s.db.prepare(`SELECT thread_id FROM prs WHERE environment_id = 'env-1'`).get() as { thread_id: string }).thread_id, "T-second");
});

// One environment can hold more than one PR: a thread opened a second PR after its first merged, or bb's reading moved
// to a new branch. The row was keyed by environment, so the second reading overwrote the first, and whichever came last
// was "the thread's PR", merged or not. Now each PR keeps its row; the newest open one is the thread's PR.

test("an environment holds two PRs: the newest open one is the thread's PR, whatever order they were read in", () => {
  const s = setup();
  const t = s.e.register("T-first", "thread", "alpha", "T-lead");
  s.e.setEnvironment(t.threadId, "env-1");
  s.e.prSeen(t, "env-1", pr(205));
  s.e.prSeen(t, "env-1", pr(101, "merged"));
  assert.equal(s.e.prFor("env-1")?.number, 205, "an old merged PR doesn't make the thread look finished");
  assert.deepEqual(s.linked(), ["thread:alpha:1 #101", "thread:alpha:1 #205"], "both stay linked to the thread");
});

test("the other PR stays readable by its URL: a wait on the older PR goes by the older PR, not the newest one", () => {
  const s = setup();
  const t = s.e.register("T-first", "thread", "alpha", "T-lead");
  s.e.setEnvironment(t.threadId, "env-1");
  s.e.prSeen(t, "env-1", pr(101, "merged"));
  s.e.prSeen(t, "env-1", pr(205));
  assert.equal(s.e.prByUrl("https://github.com/example/app/pull/101")?.state, "merged");
  assert.equal(s.e.waitPr("https://github.com/example/app/pull/101")?.number, 101);
  assert.equal(s.e.prByUrl("https://github.com/example/app/pull/205")?.state, "draft");
});

// A PR opened from a branch that isn't the environment's: the thread pushed its HEAD under another name, or opened a
// follow-up PR from a second worktree. bb reads the environment's own branch only, so it found no PR, or an old one.
// The thread's report (orch_report with pr) names it, but a report is no proof of ownership: a QA or review thread
// reports the PRs it checked. So a reported PR is linked only when its head commit is the thread's environment's HEAD,
// the commit the thread pushed. A wrong link is the risky way round: it sends PR notices about a PR the thread only
// checked, and a merged one can make the thread look prune-safe.

const head = (n: number) => `c0ffee${n}`.padEnd(40, "0");
const ABSENT: PrResult = { outcome: "absent" };
const ghPr = (n: number, state = "draft", oid = head(n)): PrResult => {
  const r = pr(n, state) as Extract<PrResult, { outcome: "available" }>;
  return { outcome: "available", pullRequest: { ...r.pullRequest, headRefOid: oid } };
};

function reported() {
  const s = setup();
  const owner = s.e.register("T-owner", "thread", "alpha", "T-lead");
  const qa = s.e.register("T-qa", "thread", "alpha", "T-lead");
  s.e.setEnvironment(owner.threadId, "env-owner");
  s.e.setEnvironment(qa.threadId, "env-qa");
  const url = (n: number) => `https://github.com/example/app/pull/${n}`;
  s.e.report(owner, "PR 205 is up", "Draft, CI green.", url(205));
  s.e.report(qa, "Verified 205", "QA pass on the preview.", url(205));
  s.e.report(qa, "Verified 300", "QA pass on the preview.", url(300));
  const heads: Record<string, string | null> = { "env-owner": head(205), "env-qa": head(999) };
  const prs: Record<string, PrResult> = { [url(205)]: ghPr(205), [url(300)]: ghPr(300) };
  const reads: string[] = [];
  const io = {
    heads: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, heads[id] ?? null])),
    read: async (u: string) => {
      reads.push(u);
      return prs[u] ?? { outcome: "absent" as const };
    },
  };
  const checked = new Map<string, string>();
  /** One pass after bb's, whose readings are `bb` by environment: by default bb finds no PR on either thread's branch. */
  const pass = (bb: Record<string, PrResult> = {}) => readThreadPrs(s.e, new Map(Object.entries({ "env-owner": ABSENT, "env-qa": ABSENT, ...bb })), [], io, checked);
  return { ...s, owner, qa, url, heads, prs, reads, pass };
}

test("a PR the thread reported, whose head commit is its environment's HEAD, is linked to it; a thread that only checked it gets nothing", async () => {
  const s = reported();
  const board = s.count(`SELECT count(*) AS n FROM board`);
  const items = s.count(`SELECT count(*) AS n FROM items`);
  await s.pass();
  assert.deepEqual(s.linked(), ["thread:alpha:1 #205"], "the owner holds 205; the QA thread holds neither 205 nor 300");
  assert.equal(s.e.prFor("env-owner")?.number, 205);
  assert.equal(s.count(`SELECT count(*) AS n FROM board`), board, "the first link is quiet: the PR is old news to its own thread");
  assert.equal(s.count(`SELECT count(*) AS n FROM items`), items, "and no notice to the lead or the CoS");
});

test("once linked, later changes are news like any PR reading, until the PR is merged or closed; then it isn't read again", async () => {
  const s = reported();
  await s.pass();
  s.prs[s.url(205)] = ghPr(205, "open");
  s.heads["env-owner"] = head(206); // the thread committed more: the link stays
  await s.pass();
  assert.match(s.db.prepare(`SELECT body FROM items WHERE recipient = 'lead:alpha' AND kind = 'notice' ORDER BY rowid DESC`).get()!.body as string, /thread:alpha:1: PR #205 open/);
  s.prs[s.url(205)] = ghPr(205, "merged");
  await s.pass();
  assert.equal(s.e.prFor("env-owner")?.state, "merged");
  const n = s.reads.filter((u) => u === s.url(205)).length;
  await s.pass();
  assert.equal(s.reads.filter((u) => u === s.url(205)).length, n, "a merged PR isn't read again");
});

test("an unlinked reported PR is read again only when the environment's HEAD moved; a pass with nothing new reads nothing", async () => {
  const s = reported();
  await s.pass();
  const n = s.reads.filter((u) => u === s.url(300)).length;
  await s.pass();
  assert.equal(s.reads.filter((u) => u === s.url(300)).length, n, "the QA thread's HEAD didn't move: its report isn't read again");
  s.heads["env-qa"] = head(300); // the QA thread checked out 300's commit and pushed it: then 300 is its own
  await s.pass();
  assert.deepEqual(s.linked(), ["thread:alpha:1 #205", "thread:alpha:2 #300"]);
});

test("a PR bb already read for this pass, or one another live environment holds, is never read or linked from a report", async () => {
  const s = reported();
  const other = s.e.register("T-other", "thread", "alpha", "T-lead");
  s.e.setEnvironment(other.threadId, "env-other");
  s.e.prSeen(other, "env-other", pr(300)); // bb reads 300 on its own branch: it is that thread's PR
  s.heads["env-qa"] = head(300);
  await s.pass({ "env-owner": pr(205), "env-other": pr(300) }); // bb's readings this pass covered 205 and 300
  assert.ok(!s.reads.includes(s.url(205)), "205 is covered: bb read it this pass");
  assert.deepEqual(s.linked(), ["thread:alpha:3 #300"], "300 stays the thread's that bb reads it for, though the QA thread's HEAD is its head commit");
});

test("where bb didn't answer for an environment (its machine is off), its PRs aren't read with gh: one PR never flips between two readers", async () => {
  const s = reported();
  await s.pass();
  const n = s.reads.filter((u) => u === s.url(205)).length;
  await s.pass({ "env-owner": { outcome: "unavailable", message: "the machine is off" } });
  assert.equal(s.reads.filter((u) => u === s.url(205)).length, n);
  await s.pass();
  assert.equal(s.reads.filter((u) => u === s.url(205)).length, n + 1, "read again once bb answers");
});

test("the reports of a handoff predecessor count: the address reported it, and the successor holds the environment", async () => {
  const s = reported();
  s.e.takeOver(s.owner.threadId, "T-owner-2", "context full");
  await s.pass();
  assert.deepEqual(s.linked(), ["thread:alpha:1 #205"]);
  assert.equal(s.e.prFor("env-owner")?.threadId, "T-owner-2");
});

test("an upgraded database keeps its PR rows, and then an environment can hold a second PR", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE _migrations (id INTEGER PRIMARY KEY)`);
  const before = MIGRATIONS.findIndex((m) => /CREATE TABLE prs_v2/.test(m));
  assert.ok(before > 0, "the prs rebuild is a migration of its own, appended");
  assert.equal(before, 36, "appended at 36: later migrations come after it, never before");
  MIGRATIONS.slice(0, before).forEach((sql, i) => {
    db.exec(sql);
    db.prepare(`INSERT INTO _migrations (id) VALUES (?)`).run(i);
  });
  db.prepare(`INSERT INTO prs (environment_id, thread_id, url, number, state, attention, checks, sig, seen_at) VALUES ('env-1', 'T-1', 'https://github.com/example/app/pull/101', 101, 'merged', 'merged', 'passing', 'v2|x', 1)`).run();
  migrate(db as never);
  db.prepare(`INSERT INTO prs (environment_id, thread_id, url, number, state, attention, checks, sig, seen_at) VALUES ('env-1', 'T-1', 'https://github.com/example/app/pull/205', 205, 'draft', 'draft', 'passing', 'v2|y', 2)`).run();
  assert.deepEqual((db.prepare(`SELECT number FROM prs WHERE environment_id = 'env-1' ORDER BY number`).all() as { number: number }[]).map((r) => r.number), [101, 205]);
});

// Live, 2026-11-19: a reported PR whose head commit was its environment's HEAD never linked, and the plugin log said
// nothing. bb parses a host call's output with the method's schema (validateValue: `~standard.validate`), and the
// prs.wait schema didn't name headRefOid, so gh's head commit was dropped on the way to the server: every compare
// failed, quietly. These run a reading through the same schema bb uses, and require a line for every unlinked report.

/** One gh reading the way the server gets it: gh's JSON, the host's parse, then bb's check against the host schema. */
async function overTheHost(n: number, headRefOid: string | null): Promise<PrResult> {
  const gh = { url: `https://github.com/example/app/pull/${n}`, number: n, state: "OPEN", isDraft: true, reviewDecision: "", statusCheckRollup: [], mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", ...(headRefOid ? { headRefOid } : {}) };
  const checked = await prHostDefs["prs.wait"].output["~standard"].validate(parseWaitReading(gh));
  assert.equal(checked.issues, undefined, "the reading passes the host schema");
  return (checked as { value: PrResult }).value;
}

test("a reported PR read over the host keeps its head commit, so it links when that commit is the environment's HEAD", async () => {
  const s = reported();
  s.prs[s.url(205)] = await overTheHost(205, head(205));
  s.prs[s.url(300)] = await overTheHost(300, head(300));
  const r = await s.pass();
  assert.deepEqual(r.linked, ["thread:alpha:1 https://github.com/example/app/pull/205"]);
  assert.deepEqual(s.linked(), ["thread:alpha:1 #205"]);
});

test("nothing that leaves a report unlinked is silent: no HEAD, a failed bb git call, a reading without a head, a head that differs", async () => {
  const s = reported();
  s.heads["env-owner"] = null;
  let r = await s.pass();
  assert.deepEqual(r.noHead, ["env-owner"], "the owner's environment gave no HEAD (its machine is off)");
  assert.deepEqual(
    r.unmatched,
    ["thread:alpha:2 https://github.com/example/app/pull/205: head c0ffee20500, environment HEAD c0ffee99900", "thread:alpha:2 https://github.com/example/app/pull/300: head c0ffee30000, environment HEAD c0ffee99900"],
    "the QA thread compared both PRs it reported and linked neither",
  );

  const failing = await readThreadPrs(s.e, new Map([["env-owner", ABSENT], ["env-qa", ABSENT]]), [], { heads: async () => Promise.reject(new Error("bb--git: no such method")), read: async () => ABSENT }, new Map());
  assert.equal(failing.headsError, "bb--git: no such method");
  assert.deepEqual([failing.read, failing.linked, failing.noHead], [0, [], []], "no HEAD known: nothing read, nothing blamed on a machine");

  s.heads["env-owner"] = head(205);
  s.prs[s.url(205)] = await overTheHost(205, null); // a reading without its head commit can't be compared
  s.reads.length = 0;
  r = await s.pass();
  assert.deepEqual(r.noHeadRef, [s.url(205)]);
  assert.deepEqual(s.linked(), []);
  s.prs[s.url(205)] = await overTheHost(205, head(205));
  r = await s.pass();
  assert.deepEqual(r.linked, ["thread:alpha:1 https://github.com/example/app/pull/205"], "it wasn't marked compared, so the next pass reads it again and links it");
});
