import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../core/engine.ts";
import { migrate, tuneConnection, type Db } from "../core/db.ts";

const ports = { now: () => 1_000_000, deliver: async () => ({ delivery: "sent" as const }), mirror: () => {}, changed: () => {}, log: () => {} };

/** An engine whose database records each statement it prepares (in order) and its query plan. */
function traced(settings: Record<string, unknown> = {}) {
  const raw = new DatabaseSync(":memory:");
  const plans = new Map<string, string>();
  const prepared: string[] = [];
  const plan = (sql: string) => {
    if (/^\s*(SELECT|INSERT|UPDATE|DELETE)/i.test(sql) && !plans.has(sql)) {
      try {
        plans.set(sql, (raw.prepare(`EXPLAIN QUERY PLAN ${sql.trim().replace(/;$/, "")}`).all() as { detail: string }[]).map((r) => r.detail).join(" | "));
      } catch {
        // a statement on a table made later
      }
    }
  };
  const db: Db = {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => {
      plan(sql);
      prepared.push(sql);
      return raw.prepare(sql) as never;
    },
  };
  const e = new Engine(db, ports, settings);
  return { e, raw, plans, prepared, reset: () => (plans.clear(), (prepared.length = 0)) };
}
const planOf = (t: ReturnType<typeof traced>, has: string) => [...t.plans].find(([sql]) => sql.includes(has))?.[1];

test("the plugin's connection commits without an fsync per write, caches 32 MB, maps the file and sorts in memory", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-dbpass-"));
  try {
    const db = new DatabaseSync(join(dir, "data.db"));
    db.exec("PRAGMA journal_mode = WAL");
    tuneConnection(db as unknown as Db);
    const one = (p: string) => Object.values(db.prepare(`PRAGMA ${p}`).get() as Record<string, number>)[0];
    assert.equal(one("synchronous"), 1, "NORMAL");
    assert.equal(one("cache_size"), -32768, "32 MB, in KiB");
    assert.equal(one("mmap_size"), 268435456);
    assert.equal(one("temp_store"), 2, "MEMORY");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the plugin leaves no planner statistics: with them, the indexed reads planned worse", () => {
  // the indexes are chosen for the planner without statistics
  const db = new DatabaseSync(":memory:") as unknown as Db;
  tuneConnection(db);
  migrate(db);
  migrate(db);
  const stat = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'`).get();
  assert.equal(stat, undefined, "no ANALYZE ran");
});

test("nothing in the plugin runs ANALYZE or PRAGMA optimize (activation, the clock, retention)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const f of ["../server.ts", ...readdirSync(join(here, "../core")).filter((n) => n.endsWith(".ts")).map((n) => `../core/${n}`)]) {
    const src = readFileSync(join(here, f), "utf8");
    // only SQL the plugin executes: a string literal passed to exec or prepare, so a comment can't trip it
    const executed = /\.(?:exec|prepare)\(\s*(["'`])(?:(?!\1)[\s\S])*?\b(?:ANALYZE|PRAGMA\s+optimize|PRAGMA\s+analysis_limit)\b/i;
    assert.doesNotMatch(src, executed, f);
  }
});

test("two unused indexes are gone; decisions_state stays because the gate's key lookup must keep decisions_project_state", () => {
  const t = traced();
  const names = new Set((t.raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as { name: string }[]).map((r) => r.name));
  for (const gone of ["handed_off_prs_project", "multiplayer_records_board"]) assert.ok(!names.has(gone), `${gone} dropped`);
  for (const made of ["outputs_at", "inbox_actionable", "decisions_state"]) assert.ok(names.has(made), `${made} present`);
  // with a decisions (state, updated_at) index, the planner takes it here instead of decisions_project_state
  const a = t.e.register("t-a", "lead", "alpha");
  t.e.ask(a, { title: "Pick one?", question: "Which one?", options: [{ label: "A" }, { label: "B" }], key: "k1" });
  const gate = planOf(t, "$.request_key') = ? AND project IS ?");
  assert.ok(gate, "the gate looked up earlier answers by key");
  assert.match(gate, /USING INDEX decisions_project_state/);
});

test("the inbox flush reads the unread through its partial index and asks about an import pause only for imported mail", async () => {
  const t = traced({ batchInbox: true, inboxDebounceMs: 0 });
  const cos = t.e.register("t-cos", "cos", null);
  const a = t.e.register("t-a", "lead", "alpha");
  for (const x of [cos, a]) t.e.setStatus(x.threadId, "idle");
  const it = t.e.send(cos, a.address, "local mail", null, null, { severity: "ACTION" });
  const asked: string[] = [];
  const woke: string[] = [];
  t.reset();
  await t.e.batch.flush({
    debounceMs: 0,
    retryMs: 60_000,
    agent: (address) => t.e.agentByAddress(address),
    held: () => false,
    deliver: async (x) => (woke.push(x.address), { delivery: "sent" }),
    log: () => {},
    // a route that is off for everything: only imported mail can be held by it
    paused: (id) => (asked.push(id), true),
  });
  assert.deepEqual(asked, [], "a local item is never an import, so its pause is never looked up");
  assert.deepEqual(woke, [a.address], "and it still wakes its recipient");
  assert.ok(it.id);
  assert.match(planOf(t, "FROM inbox_entries e LEFT JOIN external_mail")!, /USING INDEX inbox_actionable/);
});

test("an imported item whose route is off still holds its recipient's wake", async () => {
  // the pause is the import route's: moving the check behind the import join must not lose it
  const t = traced({ batchInbox: true, inboxDebounceMs: 0 });
  const a = t.e.register("t-a", "lead", "alpha");
  t.e.setStatus(a.threadId, "idle");
  const it = t.e.importMail({ source: "fleet", id: "x-1", originalId: null, to: a.address, sender: "worker", task: "t", severity: "ACTION", summary: "s", body: "", refs: [], re: null, createdAt: 1_000_000, dueAt: null, needsReply: false } as never);
  const woke: string[] = [];
  await t.e.batch.flush({
    debounceMs: 0,
    retryMs: 60_000,
    agent: (address) => t.e.agentByAddress(address),
    held: () => false,
    deliver: async (x) => (woke.push(x.address), { delivery: "sent" }),
    log: () => {},
    paused: (id) => id === it.id,
  });
  assert.deepEqual(woke, [], "paused: no wake");
});

test("outputs come newest first from an index, with no sort, in the same order as before", () => {
  const t = traced();
  const lead = t.e.register("t-lead", "lead", "alpha");
  t.reset();
  t.e.outputs();
  assert.match(planOf(t, "FROM outputs ORDER BY at DESC")!, /SCAN outputs USING INDEX outputs_at/);
  assert.doesNotMatch(planOf(t, "FROM outputs ORDER BY at DESC")!, /TEMP B-TREE/);
  void lead;
});

test("projects are one read, still ordered by priority then name", () => {
  const t = traced();
  for (const [slug, prio] of [["zeta", "normal"], ["alpha", "low"], ["mid", "urgent"], ["beta", "normal"]] as const) {
    t.e.register(`t-${slug}`, "lead", slug);
    t.e.setPriority(slug, prio);
  }
  t.reset();
  const got = t.e.projects();
  assert.equal(t.prepared.filter((s) => /FROM projects/.test(s)).length, 1, "not one read per project");
  assert.deepEqual(got.map((p) => p.slug), ["mid", "beta", "zeta", "alpha"]);
  assert.deepEqual(got.find((p) => p.slug === "alpha"), t.e.project("alpha"), "the same rows project() reads");
});

test("Pathways reads one project's cards newest first, even when other projects filed more since", () => {
  const t = traced();
  const a = t.e.register("t-a", "lead", "alpha");
  const b = t.e.register("t-b", "lead", "beta");
  const ask = (lead: typeof a, n: number) => t.e.ask(lead, { title: `card ${n}?`, question: "which?", options: [{ label: "A" }, { label: "B" }] } as never).id;
  const mine = [ask(a, 1), ask(a, 2)];
  for (let i = 0; i < 5; i++) ask(b, 10 + i);
  // a limit over every project's cards would lose this one's
  assert.deepEqual(t.e.projectDecisions("alpha", 3).map((d) => d.id), [...mine].sort().reverse());
  assert.ok(t.e.projectDecisions("alpha").every((d) => d.project === "alpha"));
  assert.equal(t.e.projectDecisions("beta").length, 5);
});
