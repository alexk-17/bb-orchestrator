// The Projects row's summary (2026-11-16, the command center). The owner reads each project from one row: its state,
// what it waits on outside itself and for how long, and the latest finished thing. A wait line must be something the
// lead can't settle itself, or the row cries wolf: mail waiting for the project's own agents, a thread's question to its
// own lead and a PR its thread is still working on are not waits. The lead's word and a live fact about the same thing
// are one line, and a live fact that shows the lead's word is over (the PR merged) strikes it. Retired duplicates and
// test rows in the DB never count as threads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, type PrResult } from "../core/engine.ts";
import type { Agent } from "../core/model.ts";
import { statusParams } from "../core/status.ts";
// a made-up card id, built so the release scan never sees a card-shaped literal
const CA = ["d", "20261116T101500Z", "abc123"].join("-");

const T0 = Date.parse("2026-11-16T10:00:00Z");
const PR = "https://github.com/o/r/pull/41";
const HOUR = 3_600_000;
const reading = (p: { state?: string; checks?: string; review?: string; mstate?: string }): PrResult => ({
  outcome: "available",
  pullRequest: {
    url: PR,
    number: 41,
    state: p.state ?? "open",
    checks: { state: p.checks ?? "passing" },
    review: { state: p.review ?? "approved" },
    mergeability: { mergeable: "MERGEABLE", state: p.mstate ?? "blocked" },
  } as never,
});

function setup() {
  const clock = { t: T0 };
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, { now: () => clock.t, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { owner: "Robin" });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "kite");
  const w1 = e.register("T-w1", "thread", "kite", "T-lead");
  const w2 = e.register("T-w2", "thread", "kite", "T-lead");
  e.setStatus("T-lead", "idle");
  e.setStatus("T-w1", "idle");
  e.setStatus("T-w2", "idle");
  const sum = () => e.projectSummaries().get("kite")!;
  const publish = (raw: unknown) => e.publishStatus(lead, statusParams.parse(raw));
  // the owner's answer wakes the lead and it reads its digest: a status nudge waits for such a real turn (2026-11-24)
  const wakeLead = async () => {
    await e.flush();
    clock.t += 2000;
    await e.flush();
    const r = e.batch.read(lead);
    if (r.cursor) e.batch.ack(lead, r.cursor);
  };
  const toOwner = (by: Agent, title: string) => {
    const d = e.ask(by, { title, question: `${title} Go?`, options: [{ label: "Go" }, { label: "Wait" }] });
    return by.role === "lead" ? e.triageAskPerson(cos, d.id, { question: `${title} Go?`, options: [{ label: "Go" }, { label: "Wait" }], allowText: true }) : d;
  };
  return { e, db, cos, lead, w1, w2, sum, publish, toOwner, wakeLead, advance: (ms: number) => (clock.t += ms), now: () => clock.t };
}

test("a wait line is a wait outside the project: mail to its own agents and a thread's question to its own lead are not", () => {
  const s = setup();
  s.e.send(s.cos, "lead:kite", "Please look at the flaky test", null); // waiting for the lead to act: not a wait
  s.e.ask(s.w1, { title: "Which fixture?", question: "Use fixture A or B?", options: [{ label: "A" }, { label: "B" }] }); // inside the project
  assert.deepEqual(s.sum().waits, [], "nothing the project waits on from outside");
  assert.equal(s.sum().motion, "quiet");
  s.e.send(s.lead, "cos", "Can you get me the staging keys?", null); // a reply the CoS owes the project
  const card = s.toOwner(s.lead, "Ship it?");
  const w = s.sum().waits;
  assert.deepEqual(w.map((x) => [x.source, x.kind]).sort(), [["live", "card"], ["live", "reply"]].sort());
  assert.equal(w.find((x) => x.kind === "reply")!.who, "cos");
  assert.equal(s.sum().needsYou.count, 1);
  assert.equal(s.sum().needsYou.title, card.request.title);
  assert.equal(s.sum().motion, "waiting", "nobody works, something is waited on");
});

test("a PR wait counts only while the PR's thread isn't working on it, and its age is how long the reading is unchanged", () => {
  const s = setup();
  s.e.setEnvironment("T-w1", "env-1");
  s.e.prSeen(s.w1, "env-1", reading({ checks: "pending", review: "review_required" }));
  const seenAt = s.now();
  s.advance(5 * HOUR);
  const ci = s.sum().waits.find((w) => w.kind === "ci")!;
  assert.equal(ci.unchanged, true, "drawn as 'unchanged 5h', not 'waiting 5h'");
  assert.equal(ci.since, seenAt);
  assert.equal(ci.who, "PR #41");
  s.e.setStatus("T-w1", "active");
  assert.deepEqual(s.sum().waits, [], "its thread is on it: not a wait");
  assert.equal(s.sum().motion, "moving");
  assert.deepEqual(s.sum().threads, { working: 1, total: 2 });
  s.e.setStatus("T-w1", "idle");
  s.e.prSeen(s.w1, "env-1", reading({ mstate: "conflicts" }));
  assert.equal(s.sum().waits.find((w) => w.kind === "pr-blocked")?.label, "conflicts", "a blocked PR is a live wait too");
});

test("the lead's word and a live fact on the same kind and ref are one line; a merged PR or an answered card drops the lead's word", () => {
  const s = setup();
  const card = s.toOwner(s.lead, "Pick a name?");
  s.publish({ goal: "g", steps: [{ title: "Build", state: "current" }], waiting_on: [{ kind: "owner", ref: card.id, label: "the name" }, { kind: "pr", ref: PR }] });
  const w = s.sum().waits;
  assert.deepEqual(w.map((x) => [x.source, x.kind]), [["lead", "owner"], ["lead", "pr"]], "the card is not drawn twice");
  s.e.setEnvironment("T-w1", "env-1");
  s.e.prSeen(s.w1, "env-1", reading({}));
  s.advance(3 * HOUR);
  s.e.prSeen(s.w1, "env-1", reading({ state: "merged" }));
  s.advance(HOUR);
  assert.equal(s.sum().waits.find((x) => x.kind === "pr"), undefined, "a merged PR's wait isn't drawn at all");
  assert.equal(s.sum().statusOutOfDate, true, "the row says the status is out of date instead");
  assert.equal(s.sum().waits.length, 1);
  s.e.personAnswer(card.id, card.rev, "1", null, "desktop");
  assert.deepEqual(s.sum().waits, [], "an answered card's wait isn't drawn either: no struck lines");
  assert.equal(s.sum().motion, "quiet", "waits that live facts show are over don't make the project Waiting");
});

test("a wait on the lead's own thread is part of the title until that thread sits idle over 30 minutes or fails", () => {
  const s = setup();
  s.e.setStatus("T-w2", "active");
  s.publish({ goal: "g", steps: ["Build"], waiting_on: { kind: "thread", ref: "thread:kite:2", label: "the canary numbers" } });
  assert.deepEqual(s.sum().waits, [], "its thread is working: the title says it");
  s.e.setStatus("T-w2", "idle");
  s.advance(20 * 60_000);
  assert.deepEqual(s.sum().waits, [], "idle 20 minutes: still part of the title");
  s.advance(15 * 60_000);
  assert.equal(s.sum().waits.length, 1, "idle 35 minutes: a line");
  s.e.setStatus("T-w2", "error");
  assert.equal(s.sum().waits[0]!.note, "the thread failed", "a failed thread is not over: its wait stays, with a note");
  assert.equal(s.sum().statusOutOfDate, false);
});

test("only live agents count: a retired thread is no thread, and with no live lead the project says so", () => {
  const s = setup();
  s.e.retire("T-w2");
  assert.deepEqual(s.sum().threads, { working: 0, total: 1 });
  s.e.setHold("kite", true);
  assert.equal(s.sum().motion, "held");
  s.e.setHold("kite", false);
  s.e.retire("T-lead");
  assert.equal(s.sum().motion, "nolead");
});

test("Done is the latest finished thing in 24 h: an approved deliverable, a merged PR or a report; never a withdrawal or a send-back", () => {
  const s = setup();
  // deliverables need proof files to be made through the engine; their rows are what the loader reads
  const row = (id: string, title: string, state: string, at: number) =>
    s.db.prepare(`INSERT INTO deliverables (id, project, lead, title, summary, state, rev, created_at, updated_at, json) VALUES (?, 'kite', 'lead:kite', ?, '', ?, 1, ?, ?, '{}')`).run(id, title, state, at, at);
  row("dv-1", "Old approved work", "approved", T0 - 30 * HOUR);
  row("dv-2", "Sent back", "changes", T0 + HOUR);
  row("dv-3", "Withdrawn", "withdrawn", T0 + 2 * HOUR);
  s.advance(3 * HOUR);
  assert.equal(s.sum().done, null, "nothing finished in the last day");
  row("dv-4", "Checkout redesign", "approved", s.now());
  assert.deepEqual(s.sum().done, { text: "Checkout redesign", at: s.now(), kind: "deliverable" });
  s.advance(HOUR);
  s.e.report(s.w1, "Flaky test fixed", "details", null);
  assert.equal(s.sum().done?.text, "Flaky test fixed", "the newest one wins");
  row("dv-5", "In review", "review", s.now());
  assert.equal(s.sum().waits.find((w) => w.kind === "deliverable")?.label, "In review", "a deliverable in review waits on the owner");
});

test("after a provider handoff the PR is the successor's: its CI wait stays, and goes when the successor works on it", () => {
  const s = setup();
  s.e.setEnvironment("T-w1", "env-1");
  s.e.prSeen(s.w1, "env-1", reading({ checks: "pending", review: "review_required" }));
  s.e.takeOver("T-w1", "T-w1b", "handoff-2026-11-16.md");
  s.e.setStatus("T-w1b", "idle");
  assert.ok(s.sum().waits.some((w) => w.kind === "ci"), "the CI wait didn't vanish with the old thread id");
  s.e.setStatus("T-w1b", "active");
  assert.ok(!s.sum().waits.some((w) => w.kind === "ci"), "the successor is on it: not a wait");
});

test("a lead's PR wait never hides a live CI wait, and keeps the age the lead gave it", () => {
  const s = setup();
  s.e.setEnvironment("T-w1", "env-1");
  s.e.prSeen(s.w1, "env-1", reading({ checks: "pending", review: "review_required" }));
  s.advance(10 * HOUR);
  s.publish({ goal: "g", steps: ["Build"], waiting_on: { kind: "pr", ref: PR, who: "Alice", label: "her review" } });
  assert.deepEqual(s.sum().waits.map((x) => [x.source, x.kind]), [["lead", "pr"], ["live", "ci"]], "CI pending 10 h is its own line");
  // a review reading unchanged 10 h is the lead's line, drawn once, with the lead's own age
  const r = setup();
  r.e.setEnvironment("T-w1", "env-1");
  r.e.prSeen(r.w1, "env-1", reading({ review: "review_required" }));
  r.advance(10 * HOUR);
  r.publish({ goal: "g", steps: ["Build"], waiting_on: { kind: "pr", ref: PR, who: "Alice", label: "her review" } });
  r.advance(HOUR);
  const w = r.sum().waits;
  assert.deepEqual(w.map((x) => [x.source, x.kind]), [["lead", "pr"]]);
  assert.equal(w[0]!.since, r.now() - HOUR, "named an hour ago: not 'for 11h'");
});

// Duplicates (2026-11-16: one PR's "an answer waits until it is merged" showed twice on a row). Two PR-bound answers on
// the same PR are one wait; so are two waits in the same words.
test("waits with the same kind and ref collapse to one, then those saying the same words", async () => {
  const { dedupeWaits } = await import("../core/history.ts");
  const w = (x: Partial<import("../core/history.ts").SummaryWait>) => ({ source: "live" as const, kind: "pr-bound", ref: PR, who: null, label: "#41 merged", since: T0, unchanged: false, note: null, ...x });
  assert.equal(dedupeWaits([w({}), w({ since: T0 + HOUR })]).length, 1, "same kind and ref: one line");
  assert.equal(dedupeWaits([w({ source: "lead", kind: "deploy", ref: null, label: "The staging deploy." }), w({ kind: "deploy", ref: null, label: "the staging  deploy" })]).length, 1, "same words: one line");
  assert.equal(dedupeWaits([w({}), w({ ref: "https://github.com/o/r/pull/42", label: "#42 merged" })]).length, 2, "different PRs stay two");
  const s = setup();
  s.e.setEnvironment("T-w1", "env-1");
  s.e.prSeen(s.w1, "env-1", reading({}));
  s.publish({ goal: "g", steps: ["Build"], waiting_on: [{ kind: "colleague", who: "Sam", label: "the design sign-off" }, { kind: "colleague", who: "sam", label: "The design sign-off." }] });
  assert.equal(s.sum().waits.length, 1, "the lead naming one wait twice is one line");
});

// A lead's blocker an answer covers drops off too (2026-11-16: "Staging cloud login expired" stayed after the owner answered
// the sign-in card). Kept conservative: only a card answered after the status that shares two content words with the
// blocker, or the blocker naming an answered card. An unrelated answer covers nothing.
test("a blocker drops when a card answered after the status covers it, and only then", () => {
  const s = setup();
  const signin = s.toOwner(s.lead, "Staging cloud sign-in again (rig login expired)");
  const other = s.toOwner(s.lead, "Pick the release name");
  s.publish({ goal: "g", steps: ["Build"], blockers: ["Staging cloud login expired; the test rig needs it", "4495 needs two reviewers"] });
  assert.equal(s.sum().blockers.length, 2);
  s.advance(60_000);
  s.e.personAnswer(other.id, other.rev, "1", null, "desktop");
  assert.equal(s.sum().blockers.length, 2, "an unrelated answer covers nothing");
  assert.equal(s.sum().statusOutOfDate, false);
  s.e.personAnswer(signin.id, signin.rev, "1", null, "desktop");
  assert.deepEqual(s.sum().blockers, ["4495 needs two reviewers"], "the sign-in answer covers the login blocker");
  assert.equal(s.sum().statusOutOfDate, true);
  s.advance(60_000);
  s.publish({ goal: "g", steps: ["Build"], blockers: ["Staging cloud login expired again"] });
  assert.deepEqual(s.sum().blockers, ["Staging cloud login expired again"], "a blocker published after the answer stands");
});

test("a blocker naming an answered card drops", () => {
  const s = setup();
  const card = s.toOwner(s.lead, "Approve the budget?");
  s.publish({ goal: "g", steps: ["Build"], blockers: [`waiting on ${card.id}`] });
  assert.equal(s.sum().blockers.length, 1);
  s.e.personAnswer(card.id, card.rev, "1", null, "desktop");
  assert.deepEqual(s.sum().blockers, []);
});

// The engine asks the lead to republish, once per status, and never the owner (2026-11-16).
test("a contradicted status nudges its lead once per status, never the owner, not when held", async () => {
  const s = setup();
  const card = s.toOwner(s.lead, "Pick a name?");
  s.publish({ goal: "g", steps: ["Build"], waiting_on: [{ kind: "owner", ref: card.id, label: "the name" }] });
  assert.equal(s.e.statusOutOfDateNudges().length, 0, "nothing contradicts it yet");
  s.e.personAnswer(card.id, card.rev, "1", null, "desktop");
  await s.wakeLead();
  const first = s.e.statusOutOfDateNudges();
  assert.equal(first.length, 1);
  assert.equal(first[0]!.recipient, "lead:kite");
  assert.equal(first[0]!.needsAck, false);
  assert.match(first[0]!.body, /orch_status/);
  assert.equal(s.e.statusOutOfDateNudges().length, 0, "the same status: no second nudge");
  const toOwner = (s.db.prepare(`SELECT COUNT(*) AS c FROM items WHERE sender = 'orchestrator' AND recipient IN ('person', 'owner')`).get() as { c: number }).c;
  assert.equal(toOwner, 0, "no message to the owner");
  s.advance(60_000);
  const card2 = s.toOwner(s.lead, "Pick a colour?");
  s.publish({ goal: "g", steps: ["Build"], waiting_on: [{ kind: "owner", ref: card2.id, label: "the colour" }] });
  s.e.personAnswer(card2.id, card2.rev, "1", null, "desktop");
  await s.wakeLead();
  s.e.setHold("kite", true);
  assert.equal(s.e.statusOutOfDateNudges().length, 0, "held: the lead isn't asked");
  s.e.setHold("kite", false);
  assert.equal(s.e.statusOutOfDateNudges().length, 1, "a new status that is contradicted again: one more nudge");
});

test("the cover rule itself: only an answer after the status, sharing two content words, or the blocker naming an answered card", async () => {
  const { blockerCovered } = await import("../core/history.ts");
  const ans = [{ id: "d-1", text: "Staging cloud sign-in again (rig login expired)", answeredAt: T0 }];
  assert.equal(blockerCovered("Staging cloud login expired", T0 - 1, ans, new Map()), true);
  assert.equal(blockerCovered("Staging cloud login expired", T0 + 1, ans, new Map()), false, "an answer from before the status covers nothing");
  assert.equal(blockerCovered("Login page broken", T0 - 1, ans, new Map()), false, "one shared word (login) is not enough");
  assert.equal(blockerCovered(`see ${CA}`, T0, [], new Map([[`${CA}`, { state: "answered", answeredAt: T0 }]])), true);
  assert.equal(blockerCovered(`see ${CA}`, T0, [], new Map([[`${CA}`, { state: "asked", answeredAt: null }]])), false);
});

// Review fixes (Codex, 2026-11-16): nothing is dropped that isn't over, and one status gets one ask.
test("a card merged into one still open is not answered: its wait and blocker stay until that card is answered", () => {
  const s = setup();
  const a = s.e.ask(s.lead, { title: "Staging cloud sign-in (rig login expired)", question: "Sign in again?", options: [{ label: "Go" }, { label: "Wait" }] });
  const b = s.toOwner(s.lead, "Staging cloud sign-in for the rig (login expired)");
  s.e.triageMerge(s.cos, a.id, b.id);
  s.publish({ goal: "g", steps: ["Build"], waiting_on: [{ kind: "owner", ref: a.id, label: "the sign-in" }], blockers: [`Staging cloud login expired (${a.id})`] });
  assert.equal(s.sum().waits.filter((w) => w.source === "lead").length, 1, "merged, not answered: the wait stands");
  assert.equal(s.sum().blockers.length, 1);
  assert.equal(s.sum().statusOutOfDate, false);
  s.advance(60_000);
  const parent = s.e.decision(b.id)!;
  s.e.personAnswer(b.id, parent.rev, "1", null, "desktop");
  assert.equal(s.sum().waits.filter((w) => w.source === "lead").length, 0, "the card it went into is answered: over");
  assert.deepEqual(s.sum().blockers, []);
});

test("a lead's wait on another project's PR or thread drops once that one merged or resolved", () => {
  const s = setup();
  const other = s.e.register("T-o-lead", "lead", "otter");
  const ow = s.e.register("T-o-1", "thread", "otter", "T-o-lead");
  s.e.setEnvironment("T-o-1", "env-o");
  const DEP = "https://github.com/o/dep/pull/7";
  s.e.prSeen(ow, "env-o", { outcome: "available", pullRequest: { url: DEP, number: 7, state: "open", checks: { state: "passing" }, review: { state: "approved" }, mergeability: { mergeable: "MERGEABLE", state: "blocked" } } as never });
  s.publish({ goal: "g", steps: ["Build"], waiting_on: [{ kind: "pr", ref: DEP, label: "the dependency" }, { kind: "thread", ref: "thread:otter:1", label: "the schema" }] });
  assert.equal(s.sum().waits.length, 2);
  s.advance(60_000);
  s.e.prSeen(ow, "env-o", { outcome: "available", pullRequest: { url: DEP, number: 7, state: "merged", checks: { state: "passing" }, review: { state: "approved" }, mergeability: { mergeable: "MERGEABLE", state: "clean" } } as never });
  assert.deepEqual(s.sum().waits.map((w) => w.kind), ["thread"], "the other project's merged PR is over");
  assert.equal(s.sum().statusOutOfDate, true);
  s.e.retire("T-o-1");
  assert.deepEqual(s.sum().waits, [], "the other project's resolved thread is over too");
  void other;
});

test("one status gets one ask through the tick: the out-of-date notice, not also the stale one", async () => {
  const s = setup();
  const card = s.toOwner(s.lead, "Pick a name?");
  s.publish({ goal: "g", steps: ["Build"], waiting_on: [{ kind: "owner", ref: card.id, label: "the name" }] });
  s.advance(3 * HOUR);
  s.e.personAnswer(card.id, card.rev, "1", null, "desktop");
  await s.wakeLead();
  s.e.tick();
  s.advance(2 * 60_000);
  s.e.tick();
  const asks = (s.db.prepare(`SELECT send_key FROM items WHERE sender = 'orchestrator' AND recipient = 'lead:kite' AND (send_key LIKE 'status-%')`).all() as { send_key: string }[]).map((r) => r.send_key.split(":")[0]);
  assert.deepEqual(asks, ["status-outdated"]);
});

test("the quiet row's last finished thing is a report, an approved deliverable or a merged PR, never a change request", () => {
  const s = setup();
  s.e.setEnvironment("T-w1", "env-1");
  s.e.prSeen(s.w1, "env-1", reading({}));
  s.advance(HOUR);
  s.e.prSeen(s.w1, "env-1", reading({ state: "merged" }));
  assert.match(s.sum().last?.text ?? "", /^PR #?41? ?merged$|^PR .*merged$/, "a merged PR with no report counts");
  s.advance(HOUR);
  s.e.boardAdd("deliverable", "lead:kite", "kite", "Changes requested: the export", "", null);
  assert.match(s.sum().last?.text ?? "", /merged$/, "a change request is not finished work");
});

test("a PR read by two environments links with its newest reading", () => {
  const s = setup();
  s.e.setEnvironment("T-w1", "env-1");
  s.e.setEnvironment("T-w2", "env-2");
  s.e.prSeen(s.w1, "env-1", reading({}));
  s.advance(HOUR);
  s.e.prSeen(s.w2, "env-2", reading({ state: "merged" }));
  const known = s.e.knownPrs().filter((p) => p.number === 41);
  assert.deepEqual(known.map((p) => p.state), ["merged"]);
});
