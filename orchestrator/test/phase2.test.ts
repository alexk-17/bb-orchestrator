// Phase 2's promises (docs/phase2-plan.md): the owner's priority and hold, the hard plan gate, PR news only on change,
// resolve without deleting worktrees, a handoff that keeps the address, Needs-you push, and each agent's Pokémon.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, type DeliverResult, type PrResult } from "../core/engine.ts";
import type { Decision, Item } from "../core/model.ts";

function setup() {
  let clock = Date.parse("2026-11-13T10:00:00Z");
  const sent: { threadId: string; item: Item }[] = [];
  const up: string[] = [];
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, {
    now: () => clock,
    async deliver(threadId, _text, item): Promise<DeliverResult> {
      sent.push({ threadId, item });
      return { delivery: "sent" };
    },
    mirror: () => {},
    changed: () => {},
    log: () => {},
    cardUp: (d: Decision) => up.push(d.id),
  }, { batchInbox: false, pokemon: true }); // these tests pin the Pokémon behaviour (the setting on)
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-la", "lead", "alpha");
  return { e, db, cos, lead, sent, up, advance: (ms: number) => (clock += ms), now: () => clock };
}

const plan = [{ label: "Go: 2 threads" }, { label: "Not now" }];

/** Lead files a plan; the CoS puts it to the owner; the owner answers with `option`. */
function decidePlan(s: ReturnType<typeof setup>, option: string, threads = 2) {
  const d = s.e.ask(s.lead, { title: "Plan?", question: "Start these threads?", options: plan, kind: "plan", threads });
  s.e.triageAskPerson(s.cos, d.id, { question: "alpha wants to start 2 threads", options: [{ label: "x" }, { label: "y" }], allowText: true });
  const card = s.e.needsYou().cards[0]!;
  s.e.personAnswer(d.id, card.rev, option, null, "desktop");
  return d.id;
}

test("a held project's mail waits, and resuming sends it: the owner can pause a project without losing anything", async () => {
  const s = setup();
  s.e.setHold("alpha", true);
  s.e.send(s.cos, "lead:alpha", "Status?", null);
  await s.e.flush();
  assert.equal(s.sent.length, 0, "nothing reaches a held project's lead");
  assert.match(s.e.inbox(s.lead).text, /ON HOLD/);
  s.e.setHold("alpha", false);
  await s.e.flush();
  assert.equal(s.sent.length, 1, "resume delivers what waited");
});

test("projects sort by the owner's priority, so the urgent one is first on their screen", () => {
  const s = setup();
  s.e.register("T-lb", "lead", "beta");
  s.e.setPriority("beta", "urgent");
  assert.deepEqual(s.e.projects().map((p) => p.slug), ["beta", "alpha"]);
  assert.throws(() => s.e.setPriority("beta", "asap" as never), /priority is one of/);
});

test("the plan gate: no threads without the owner's go, and never more than the plan asked for", () => {
  const s = setup();
  const noGo = decidePlan(s, "2");
  assert.throws(() => s.e.reserveSpawn(s.lead, noGo), /not its go option/, "answering 'Not now' starts nothing");
  const go = decidePlan(s, "1", 2);
  const a = s.e.reserveSpawn(s.lead, go);
  s.e.confirmSpawn(a, "T-w1");
  const b = s.e.reserveSpawn(s.lead, go);
  s.e.releaseSpawn(b); // a failed spawn gives its slot back
  s.e.confirmSpawn(s.e.reserveSpawn(s.lead, go), "T-w2");
  assert.throws(() => s.e.reserveSpawn(s.lead, go), /all started/);
});

test("the plan gate holds against a held project and against another lead's plan", () => {
  const s = setup();
  const go = decidePlan(s, "1");
  const other = s.e.register("T-lb", "lead", "beta");
  assert.throws(() => s.e.reserveSpawn(other, go), /alpha's plan|lead:alpha's plan/);
  s.e.setHold("alpha", true);
  assert.throws(() => s.e.reserveSpawn(s.lead, go), /on hold/);
});

test("a plan's go option survives the CoS rewording it, and a note alone can't approve it", async () => {
  const s = setup();
  const d = s.e.ask(s.lead, { title: "Plan?", question: "Start?", options: [{ label: "Not now" }, { label: "Go", go: true }], kind: "plan" });
  s.e.triageAskPerson(s.cos, d.id, { question: "reworded", options: [{ label: "Yes" }, { label: "No" }], allowText: true });
  const card = s.e.needsYou().cards[0]!;
  assert.deepEqual(card.ask!.options.map((o) => o.label), ["Not now", "Go"], "the lead's options, not the CoS's");
  assert.equal(card.ask!.allow_text, true, "the owner may answer a plan in their own words");
  s.e.personAnswer(d.id, card.rev, null, "use 1 thread, not 2", "desktop");
  assert.throws(() => s.e.reserveSpawn(s.lead, d.id), /not its go option/, "a note alone is no go");
  await s.e.flush();
  const answer = s.sent.find((x) => x.threadId === "T-la" && x.item.kind === "decision.answer" && x.item.ref === d.id);
  assert.match(answer!.item.body, /use 1 thread, not 2/, "the lead gets the owner's words, to re-file a corrected plan");
  assert.throws(() => s.e.ask(s.lead, { title: "Q", question: "Q?", options: [{ label: "a", go: true }, { label: "b" }] }), /only a plan/);
});

test("a plan answered with its go plus a note is a go, and the note reaches the lead with the answer", async () => {
  const s = setup();
  const d2 = s.e.ask(s.lead, { title: "Plan?", question: "Start these threads?", options: plan, kind: "plan", threads: 2 });
  s.e.triageAskPerson(s.cos, d2.id, { question: "alpha wants 2 threads", options: [{ label: "x" }], allowText: true });
  const c2 = s.e.needsYou().cards[0]!;
  assert.equal(c2.ask!.allow_text, true);
  s.e.personAnswer(d2.id, c2.rev, "1", "keep them read-only", "desktop");
  s.e.confirmSpawn(s.e.reserveSpawn(s.lead, d2.id), "T-w1");
  await s.e.flush();
  const answer = s.sent.find((x) => x.item.kind === "decision.answer" && x.item.ref === d2.id)!;
  assert.equal(answer.threadId, "T-la");
  assert.match(answer.item.body, /option 1 "Go: 2 threads", note: "keep them read-only"/);
});

test("a plan the CoS didn't triage in time reaches the owner with the words box on", () => {
  const s = setup();
  const d = s.e.ask(s.lead, { title: "Plan?", question: "Start these threads?", options: plan, kind: "plan", threads: 2 });
  s.advance(24 * 3600_000);
  s.e.tick();
  const card = s.e.needsYou().cards.find((c) => c.id === d.id)!;
  assert.equal(card.ask!.allow_text, true);
  assert.deepEqual(card.ask!.options.map((o) => o.label), ["Go: 2 threads", "Not now"]);
});

test("a thread no plan started is flagged once, to the Board and its lead, after a grace period", async () => {
  const s = setup();
  s.e.register("T-stray", "thread", "alpha", "T-la");
  assert.equal(s.e.flagUnplanned(60_000), 0, "not inside the grace period (the spawn may still be recording)");
  s.advance(61_000);
  assert.equal(s.e.flagUnplanned(60_000), 1);
  assert.equal(s.e.flagUnplanned(60_000), 0, "once only");
  assert.ok(s.e.board().some((r) => r.kind === "unplanned"));
  await s.e.flush();
  assert.ok(s.sent.some((x) => x.threadId === "T-la" && /without an approved plan/.test(x.item.body)));
  // a planned one and one the owner registered themselves are not strays
  const go = decidePlan(s, "1");
  s.e.register("T-ok", "thread", "alpha", "T-la");
  s.e.confirmSpawn(s.e.reserveSpawn(s.lead, go), "T-ok");
  s.e.register("T-owner", "thread", "alpha", null);
  s.e.recordManual("T-owner");
  s.advance(61_000);
  assert.equal(s.e.flagUnplanned(60_000), 0);
});

const pr = (state: string, attention = "none", checks = "pending"): PrResult => ({ outcome: "available", pullRequest: { url: "https://github.com/o/r/pull/7", number: 7, state, attention, checks: { state: checks } } });

test("PR news only on a change; absent or unavailable (a suspended machine) is never news", async () => {
  const s = setup();
  const w = s.e.register("T-w1", "thread", "alpha", "T-la");
  assert.equal(s.e.prSeen(w, "env1", pr("open")), true, "a new PR is news");
  assert.equal(s.e.prSeen(w, "env1", pr("open")), false, "the same reading again is not");
  assert.equal(s.e.prSeen(w, "env1", { outcome: "unavailable", message: "machine asleep" }), false);
  assert.equal(s.e.prSeen(w, "env1", { outcome: "absent" }), false);
  await s.e.flush();
  assert.equal(s.sent.filter((x) => x.threadId === "T-la").length, 1, "the lead heard once");
  assert.equal(s.sent.filter((x) => x.threadId === "T-cos").length, 0, "an open PR isn't the CoS's business");
  s.e.prSeen(w, "env1", pr("open", "ready_to_merge", "passing"));
  await s.e.flush();
  assert.equal(s.sent.filter((x) => x.threadId === "T-cos").length, 1, "ready to merge goes to the CoS too");
  assert.equal(s.e.prFor("env1")!.attention, "ready_to_merge");
  assert.equal(s.e.lastReportAt(w.address), null, "PR readings don't count as the thread's report");
});

test("resolve needs a clean worktree, and a merged PR, a local merge or the owner having read the final report", () => {
  // Requested 2026-11-14: resolve = retire + archive, so nothing in the worktree may be lost, and a branch merged by a
  // local fast-forward (no PR, as in this project) is finished too.
  const s = setup();
  const pushed = { clean: true as const, inBase: false, why: "its branch is pushed (origin/w1)" };
  const w = s.e.register("T-w1", "thread", "alpha", "T-la");
  assert.throws(() => s.e.resolve(s.lead, w.address, { prMerged: true, lastReadAt: null }), /worktree state is unknown/);
  assert.throws(
    () => s.e.resolve(s.lead, w.address, { prMerged: true, lastReadAt: null, worktree: { clean: false, why: "uncommitted changes in 1 file(s): a.ts" } }),
    /isn't clean: uncommitted changes in 1 file\(s\): a\.ts/,
    "a merged PR doesn't excuse a dirty worktree",
  );
  assert.ok(s.e.agentByThread("T-w1"), "a refused resolve keeps the role");
  assert.throws(() => s.e.resolve(s.lead, w.address, { prMerged: false, lastReadAt: null, worktree: pushed }), /no report/);
  s.e.report(w, "Done", "all of it", null);
  assert.throws(() => s.e.resolve(s.lead, w.address, { prMerged: false, lastReadAt: s.now() - 1, worktree: pushed }), /hasn't read/);
  assert.throws(() => s.e.archivable("T-w1"), /wasn't resolved/, "no Archive button before resolve");
  s.e.resolve(s.lead, w.address, { prMerged: false, lastReadAt: s.now(), worktree: pushed });
  assert.equal(s.e.agentByThread("T-w1"), null, "role retired");
  assert.ok(s.e.board().some((r) => r.kind === "resolved" && r.ref === "T-w1"));
  s.e.archivable("T-w1"); // the Board's Archive stays as the fallback when bb's archive fails
  const w2 = s.e.register("T-w2", "thread", "alpha", "T-la");
  s.e.resolve(s.lead, w2.address, { prMerged: true, lastReadAt: null, worktree: pushed });
  // merged locally: no PR, and nobody has read it; its branch is in main. A branch with no commits reads the same,
  // so the thread must have reported.
  const w4 = s.e.register("T-w4", "thread", "alpha", "T-la");
  const inMain = { clean: true as const, inBase: true, why: "its branch is in main" };
  assert.throws(() => s.e.resolve(s.lead, w4.address, { prMerged: false, lastReadAt: null, worktree: inMain }), /no report/);
  s.e.report(w4, "Done", "merged into main", null);
  assert.match(s.e.resolve(s.lead, w4.address, { prMerged: false, lastReadAt: null, worktree: inMain }), /its branch is in main/);
  const other = s.e.register("T-lb", "lead", "beta");
  const w3 = s.e.register("T-w3", "thread", "alpha", "T-la");
  assert.throws(() => s.e.resolve(other, w3.address, { prMerged: true, lastReadAt: null, worktree: pushed }), /your own threads/);
  // a lead that resolves again (it lost track) hears it's done, not that the thread isn't its own
  assert.match(s.e.resolve(s.lead, w.address, { prMerged: true, lastReadAt: null }), /already resolved/);
  assert.throws(() => s.e.resolve(other, w.address, { prMerged: true, lastReadAt: null }), /your own threads/, "another project's lead still can't");
});

test("a handoff's predecessors are found through the takeover, oldest first, and the sweep marks them", () => {
  // The first holder often has no environment recorded (live rows of 2026-11-14), so the link is the takeover itself.
  const s = setup();
  s.e.register("T-a", "thread", "alpha", "T-la");
  s.advance(60_000);
  s.e.takeOver("T-a", "T-b", "handoff-1.md");
  s.advance(60_000);
  s.e.takeOver("T-b", "T-c", "handoff-2.md");
  s.advance(60_000);
  assert.deepEqual(s.e.predecessors("T-c"), ["T-a", "T-b"]);
  assert.deepEqual(s.e.predecessors("T-a"), []);
  const done = s.e.register("T-d", "thread", "alpha", "T-la");
  s.e.retire(done.threadId);
  const swept = s.e.retiredThreads().map((r) => `${r.threadId}:${r.predecessor}`);
  assert.deepEqual(swept, ["T-a:true", "T-b:true", "T-d:false"]);
});

test("a handoff keeps the address, the Pokémon, the plan slot and the unacked mail", async () => {
  const s = setup();
  const go = decidePlan(s, "1", 2);
  const w = s.e.register("T-old", "thread", "alpha", "T-la");
  s.e.confirmSpawn(s.e.reserveSpawn(s.lead, go), "T-old");
  s.e.send(s.lead, w.address, "Fix the test.", null);
  await s.e.flush();
  const n = s.e.takeOver("T-old", "T-new", "handoff-2026-11-13.md");
  assert.equal(n.address, w.address);
  assert.equal(n.mon, w.mon);
  assert.equal(s.e.agentByThread("T-old"), null);
  await s.e.flush();
  assert.ok(s.sent.some((x) => x.threadId === "T-new" && x.item.body === "Fix the test."), "the open message reaches the successor");
  s.advance(61_000);
  assert.equal(s.e.flagUnplanned(60_000), 0, "a successor is not a stray");
  // the successor holds the old thread's slot, it doesn't take a second one: the plan's other thread can still start
  assert.equal((s.db.prepare(`SELECT COUNT(*) AS c FROM spawns WHERE plan_id = ?`).get(go) as { c: number }).c, 1);
  s.e.confirmSpawn(s.e.reserveSpawn(s.lead, go), "T-w2");
  assert.throws(() => s.e.reserveSpawn(s.lead, go), /all started/, "and the plan's count still caps it");
});

test("a handoff of a thread no plan started still marks the successor as handed over, not a stray", () => {
  const s = setup();
  s.e.register("T-old", "thread", "alpha", "T-la");
  s.e.takeOver("T-old", "T-new", "handoff.md");
  s.advance(61_000);
  assert.equal(s.e.flagUnplanned(60_000), 0);
});

test("The owner gets a push when a card enters Needs you: asked by the CoS, escalated, or back from a deferral", () => {
  const s = setup();
  const d1 = s.e.ask(s.lead, { title: "A?", question: "A?", options: plan });
  s.e.triageAskPerson(s.cos, d1.id, { question: "A?", options: plan, allowText: true });
  const d2 = s.e.ask(s.lead, { title: "B?", question: "B?", options: plan });
  s.advance(s.e.settings.escalateMs + 1);
  s.e.tick();
  const c = s.e.needsYou().cards.find((x) => x.id === d1.id)!;
  s.e.personDefer(d1.id, c.rev, "1h", s.now() + 1000, "desktop");
  s.advance(2000);
  s.e.tick();
  assert.deepEqual(s.up, [d1.id, d2.id, d1.id]);
});

test("each role agent gets its Pokémon: Rayquaza, Chansey, its type's lead line, the type's three-stage threads, no repeats while live", () => {
  const s = setup();
  const st = s.e.register("T-st", "steward", null);
  const lb = s.e.register("T-lb", "lead", "beta");
  const t1 = s.e.register("T-w1", "thread", "alpha", "T-la");
  const t2 = s.e.register("T-w2", "thread", "alpha", "T-la");
  assert.equal(s.cos.mon, "Rayquaza");
  assert.equal(st.mon, "Chansey");
  // alpha and beta match no type's words: the first free types, Normal then Fire
  assert.deepEqual([s.lead.mon, lb.mon], ["Porygon", "Charmander"], "leads start at the base of their type's line");
  assert.deepEqual([t1.mon, t2.mon], ["Whismur", "Lillipup"]);
  s.e.retire("T-w1");
  assert.equal(s.e.register("T-w3", "thread", "alpha", "T-la").mon, "Whismur", "a retired thread's Pokémon is free again");
});

test("a reservation left by a plugin restart mid-spawn gives its slot back, so the plan isn't short a thread forever", () => {
  const s = setup();
  const go = decidePlan(s, "1", 2);
  s.e.reserveSpawn(s.lead, go); // the old plugin instance stops here: never confirmed, never released
  s.advance(1000);
  const loadedAt = s.now(); // the new instance loads
  const inFlight = s.e.reserveSpawn(s.lead, go); // a spawn of the new instance, still awaiting bb
  assert.throws(() => s.e.reserveSpawn(s.lead, go), /all started/, "the stale row holds a slot");
  assert.equal(s.e.sweepStaleSpawns(loadedAt), 1, "only the old instance's reservation goes");
  s.e.confirmSpawn(inFlight, "T-w1");
  s.e.confirmSpawn(s.e.reserveSpawn(s.lead, go), "T-w2");
  assert.throws(() => s.e.reserveSpawn(s.lead, go), /all started/, "and the plan's count still caps it");
});

test("the CoS, the Steward and the leads are shiny so the owner's standing agents stand out; threads stay normal", async () => {
  const { isShiny, monSprite, monByName } = await import("../mons.ts");
  assert.deepEqual(["cos", "steward", "lead", "thread"].map(isShiny), [true, true, true, false]);
  const r = monByName("Rayquaza")!;
  assert.match(monSprite(r, true, true), /animated\/shiny\/384\.gif$/);
  assert.match(monSprite(r, false, true), /pokemon\/shiny\/384\.png$/);
  assert.doesNotMatch(monSprite(monByName("Caterpie")!, true, false), /shiny/);
});

test("The owner reads project names title-cased in the sidebar, acronyms kept: slugs are for machines", async () => {
  const { projectTitle } = await import("../core/model.ts");
  assert.equal(projectTitle("search-llms"), "Search LLMs");
  assert.equal(projectTitle("microvm-disks"), "MicroVM Disks");
  assert.equal(projectTitle("qa-dashboards"), "QA Dashboards");
  assert.equal(projectTitle("fde-onboarding"), "FDE Onboarding");
});

test("sidebar sections are the plain title-cased project name (the owner dropped the emoji)", async () => {
  const { sectionTitle } = await import("../core/model.ts");
  assert.equal(sectionTitle("search-llms"), "Search LLMs");
  assert.equal(sectionTitle(null), "Orchestrator");
});

test("a project's type fits its work (the owner: a PR review lead is a smart type), its lead is that type's line, and two projects never share a type", async () => {
  const { pickMon, pickType } = await import("../mons.ts");
  const lead = (p: string, taken: string[] = []) => pickMon("lead", [], pickType(p, taken)).name;
  assert.equal(pickType("code-reviews", []), "dark", "reviews: Dark, three heads review from every side");
  assert.equal(lead("code-reviews"), "Deino");
  assert.equal(lead("search-llms"), "Beldum", "AI: Psychic, grows into the supercomputer brain");
  assert.equal(lead("bug-triage"), "Scyther", "bugs: a Bug type");
  assert.equal(lead("release-train"), "Dratini", "shipping: Flying, grows into the mail carrier");
  assert.equal(lead("microvm-disks"), "Gible", "file systems: Ground, a digger");
  assert.equal(pickType("search-llms", ["psychic"]), "fairy", "a taken type: the sibling of the matched one");
  assert.equal(pickType("alpha", []), "normal", "no match: the first free type");
  assert.equal(pickType("alpha", ["normal", "fire"]), "water");
});

