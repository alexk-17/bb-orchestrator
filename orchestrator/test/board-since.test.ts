// The work board's since-T lens (SCOPE piece 6). The owner comes back after time away, picks a time, and
// reads one line of counts and the cards that moved. So:
// - the counts must match the task_moves log and the allowlist exactly, and nothing else: about 5,000 thread status
//   flips a weekend must never count, and a quiet drop (a plan edit) isn't news;
// - every picker option must give its own T ("since I last looked" alone fails after a weekend);
// - merges come from GitHub as well as the log (the log misses merges), counted once, and the merges no task holds are
//   listed so the CoS can file them; whose merges count never falls back to everyone's (a colleague's merge isn't news);
// - the CoS's tidy records and a task added and quietly dropped in the window are plan edits, not news;
// - gh is only ever asked to read.
// All data is made up.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine } from "../core/engine.ts";
import { statusParams } from "../core/status.ts";
import { boardPrs, countMoves, emptyCache, typedSince, SINCE_POLL_CAP, fileThemText, lastWeekday, parseChoice, parseLogin, parseMerged, parseReleases, sinceGhArgs, sinceKeep, sinceOf, sincePoll, sinceRepos, sinceStrip, SINCE_MAX_MS, whoseMerges, type GhMerge, type RepoRead, type SinceCache } from "../core/since.ts";
import { boardSinceSchema } from "../contract.ts";
import { registerBoardSince, SINCE_REFRESH_MS } from "../board-since.ts";
import { linkPr } from "../core/tasks.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const H = 3_600_000;
const THU = Date.parse("2026-11-19T10:00:00Z");
const FRI18 = Date.parse("2026-11-20T18:00:00Z");
const SAT = Date.parse("2026-11-21T00:00:00Z");
const SUN = Date.parse("2026-11-22T00:00:00Z");
const MON = Date.parse("2026-11-23T09:00:00Z");
const scratch = mkdtempSync(join(tmpdir(), "board-since-"));
mkdirSync(join(scratch, "lead"), { recursive: true });
writeFileSync(join(scratch, "lead", "shot.png"), "png");
const place = { roots: [{ path: join(scratch, "lead"), hostId: "host-1" }] };
const proof = [{ kind: "image" as const, caption: "the screen", path: join(scratch, "lead", "shot.png") }];
const opts = [{ label: "Go" }, { label: "Not now" }];

function setup() {
  const clock = { t: THU };
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, { now: () => clock.t, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { owner: "Robin", batchInbox: false });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "demo");
  const publish = (steps: unknown) => e.publishStatus(lead, statusParams.parse({ goal: "Ship the demo", steps })).steps.map((x) => x.id!);
  const spawn = (threadId: string, task: string) => {
    const plan = e.ask(lead, { title: "Start a thread?", question: "Start one thread?", options: opts, kind: "plan", threads: 1, task });
    e.triageAskPerson(cos, plan.id, { question: "Start one thread?", options: [], allowText: true });
    e.personAnswer(plan.id, e.decision(plan.id)!.rev, "1", null, "desktop");
    e.confirmSpawn(e.reserveSpawn(lead, plan.id), threadId);
    return e.register(threadId, "thread", "demo", "T-lead");
  };
  return { e, db, lead, clock, publish, spawn, at: (t: number) => (clock.t = t) };
}

const strip = (s: ReturnType<typeof setup>, since: number, extra: Partial<Parameters<typeof sinceStrip>[1]> = {}) =>
  sinceStrip(s.db as never, { since, now: s.clock.t, looked: null, project: null, cache: emptyCache(), attached: new Set(), whose: whoseMerges("", null), ...extra });

/** A made-up weekend: four tasks on Thursday, then moves from Saturday to Sunday, and 300 thread status flips. */
function weekend() {
  const s = setup();
  const [login, billing, docs, idea] = s.publish([
    { title: "Login page", state: "current" },
    { title: "Billing export", state: "next" },
    { title: "Docs refresh", state: "next" },
    { title: "Old idea", state: "next" },
  ]);
  s.spawn("T-1", login!);
  // Saturday 02:00: the login thread flips working/idle 300 times; no column changes
  s.at(SAT + 2 * H);
  for (let i = 0; i < 300; i++) s.e.setStatus("T-1", i % 2 ? "idle" : "active");
  assert.equal(s.e.settleBoard(), 0, "thread status flips move no card");
  // Saturday 03:10: billing gets a blocker
  s.at(SAT + 3 * H + 10 * 60_000);
  const steps = (o: { loginDone?: boolean; billingBlocked?: boolean; extra?: unknown[]; dropIdea?: boolean }) => [
    { id: login, title: "Login page", state: o.loginDone ? "done" : "current" },
    { id: billing, title: "Billing export", state: "next", ...(o.billingBlocked ? { blocker: "waiting on the payments sandbox" } : {}) },
    { id: docs, title: "Docs refresh", state: "next" },
    ...(o.dropIdea ? [] : [{ id: idea, title: "Old idea", state: "next" }]),
    ...(o.extra ?? []),
  ];
  s.publish(steps({ billingBlocked: true }));
  // Saturday 11:30: login is done; a new task, Search, is added; the old idea leaves the list with nothing attached
  s.at(SAT + 11.5 * H);
  const search = s.publish(steps({ loginDone: true, billingBlocked: true, dropIdea: true, extra: [{ title: "Search", state: "next" }] }))[3]!;
  // Sunday 09:05: docs has a deliverable in the owner's review; a new task, Push, gets a thread
  s.at(SUN + 9 * H + 5 * 60_000);
  s.e.deliver(s.lead, { title: "Docs preview", summary: "Ready.", proof, task: docs }, place);
  const push = s.publish(steps({ loginDone: true, billingBlocked: true, dropIdea: true, extra: [{ id: search, title: "Search", state: "next" }, { title: "Push", state: "next" }] }))[4]!;
  s.spawn("T-2", push);
  s.e.settleBoard();
  // Sunday 10:00: billing is unblocked (a round trip back to Planned); Push leaves the list with its thread attached
  s.at(SUN + 10 * H);
  s.publish(steps({ loginDone: true, dropIdea: true, extra: [{ id: search, title: "Search", state: "next" }] }));
  s.at(MON);
  s.e.settleBoard();
  return { s, ids: { login: login!, billing: billing!, docs: docs!, idea: idea!, search, push } };
}

test("the strip counts the task_moves log since T and nothing else: a weekend, checked by hand", () => {
  const { s, ids } = weekend();
  const st = strip(s, FRI18);
  assert.deepEqual(st.counts, { shipped: 1, new: 2, waiting: 1, blocked: 1, dropped: 1 }, "login shipped; search and push new; docs waits; billing became blocked; push dropped with its thread (the quiet drop of the old idea is a plan edit)");
  assert.deepEqual(Object.keys(st.moved).sort(), [ids.billing, ids.docs, ids.idea, ids.login, ids.push, ids.search].sort(), "every task with a row since T moved, the quiet drop too");
  assert.deepEqual(st.moved[ids.billing], { from: "planned", to: "planned", at: SUN + 10 * H, isNew: false }, "a round trip is a move, from its first row's from to its last row's to");
  assert.deepEqual(st.moved[ids.login], { from: "in_progress", to: "shipped", at: SAT + 11.5 * H, isNew: false });
  assert.equal(st.moved[ids.search]!.isNew, true);
  // every count is a moved card, so "only cards that moved" never hides a counted one
  const rows = s.db.prepare(`SELECT COUNT(*) AS n FROM task_moves WHERE at >= ?`).get(FRI18) as { n: number };
  assert.ok(rows.n >= Object.keys(st.moved).length);
});

test("a later T counts only the rows after it; a row before T never counts", () => {
  const { s, ids } = weekend();
  const st = strip(s, SUN);
  assert.deepEqual(st.counts, { shipped: 0, new: 1, waiting: 1, blocked: 0, dropped: 1 });
  assert.deepEqual(Object.keys(st.moved).sort(), [ids.billing, ids.docs, ids.push].sort());
  assert.deepEqual(st.moved[ids.billing], { from: "blocked", to: "planned", at: SUN + 10 * H, isNew: false });
  assert.deepEqual(strip(s, MON + 1).counts, { shipped: 0, new: 0, waiting: 0, blocked: 0, dropped: 0 }, "nothing after the last row");
  assert.equal(Object.keys(strip(s, THU).moved).length, 6, "from Thursday on every task is new");
  assert.equal(strip(s, THU).counts.new, 5, "the old idea was added and quietly dropped inside the window: a plan edit, not new");
  assert.equal(strip(s, THU).counts.dropped, 1, "and not dropped either; push, dropped with its thread, is both new and dropped");
});

test("now waiting means still waiting: a task that waited and moved on doesn't count", () => {
  const rows = [
    { task: "t-a", project: "p", from_col: "planned", to_col: "waiting", at: 10, why: null, seq: 1 },
    { task: "t-a", project: "p", from_col: "waiting", to_col: "in_progress", at: 20, why: null, seq: 2 },
    { task: "t-b", project: "p", from_col: "planned", to_col: "waiting", at: 5, why: null, seq: 3 },
    { task: "t-c", project: "p", from_col: "in_review", to_col: "waiting", at: 15, why: null, seq: 4 },
  ];
  const { counts, moved } = countMoves(rows, 8);
  assert.equal(counts.waiting, 1, "t-c only: t-a moved on, t-b went to waiting before T");
  assert.equal(moved["t-b"], undefined);
});

test("each picker option gives its own T, and the saved choice survives junk", () => {
  const now = MON;
  const looked = SUN + 22 * H + 59 * 60_000;
  const day = sinceOf({ kind: "24h" }, now, looked);
  const fri = sinceOf({ kind: "weekday" }, now, looked);
  const seen = sinceOf({ kind: "looked" }, now, looked);
  const picked = sinceOf({ kind: "at", at: SAT }, now, looked);
  assert.equal(new Set([day, fri, seen, picked]).size, 4);
  assert.equal(seen, looked);
  assert.equal(picked, SAT);
  assert.ok(now - day >= 24 * H && now - day < 24 * H + 15 * 60_000);
  assert.equal(sinceOf({ kind: "24h" }, now + 60_000, looked), day, "the last 24 h moves in 15-minute steps, so the read's input is stable between renders");
  const f = new Date(fri);
  assert.deepEqual([f.getDay(), f.getHours(), f.getMinutes()], [5, 18, 0], "the weekday preset is Friday 18:00, local time");
  assert.ok(fri < now && now - fri <= 7 * 24 * H);
  const friNow = new Date(2026, 10, 20, 18, 0, 0).getTime();
  assert.equal(lastWeekday(friNow), friNow - 7 * 24 * H, "at Friday 18:00 itself, the preset is the Friday before");
  assert.equal(sinceOf({ kind: "looked" }, now, null), day, "before the first look, the last 24 h");
  assert.equal(sinceOf({ kind: "at", at: 0 }, now, null), now - SINCE_MAX_MS, "a picked time reaches back 14 days at most");
  assert.deepEqual(parseChoice({ kind: "at", at: "x" }), { kind: "weekday" });
  assert.deepEqual(parseChoice(null), { kind: "weekday" });
  assert.deepEqual(parseChoice({ kind: "looked" }), { kind: "looked" });
});

// ---------------------------------------------------------------- GitHub

const MERGED_JSON = [
  { number: 1302, url: "https://github.com/acme-co/widgets/pull/1302", title: "Fix the widget spinner", mergedAt: "2026-11-21T14:00:00Z", author: { login: "robin-example" } },
  { number: 1290, url: "https://github.com/acme-co/widgets/pull/1290", title: "Login page", mergedAt: "2026-11-21T11:00:00Z", author: { login: "robin-example" } },
  { number: 1250, url: "https://github.com/acme-co/widgets/pull/1250", title: "Old", mergedAt: "2026-11-18T11:00:00Z", author: { login: "robin-example" } },
  { number: 1311, url: "https://github.com/acme-co/widgets/pull/1311", title: "A colleague's change", mergedAt: "2026-11-22T08:00:00Z", author: { login: "sam-example" } },
  { number: 9, title: "no url" },
];
const RELEASES_JSON = [
  { tagName: "v2.4.0", name: "2.4.0", publishedAt: "2026-11-22T12:00:00Z", isDraft: false },
  { tagName: "v2.5.0", name: "", publishedAt: "2026-11-22T13:00:00Z", isDraft: true },
  { tagName: "v2.3.0", name: "2.3.0", publishedAt: "2026-11-10T12:00:00Z", isDraft: false },
];

test("gh is asked only to read: fixed lists, a checked repo and day", () => {
  assert.deepEqual(sinceGhArgs.merged("acme-co/widgets", "2026-11-09").slice(0, 3), ["pr", "list", "--repo"]);
  assert.deepEqual(sinceGhArgs.releases("acme-co/widgets").slice(0, 2), ["release", "list"]);
  assert.throws(() => sinceGhArgs.merged("acme-co/widgets --web", "2026-11-09"));
  assert.throws(() => sinceGhArgs.merged("acme-co/widgets", "2026-11-09; rm"));
  assert.throws(() => sinceGhArgs.releases("../x"));
  assert.deepEqual(sinceGhArgs.login(), ["api", "user", "--jq", ".login"], "a GET of the signed-in user, keeping only its login");
  for (const a of [...sinceGhArgs.merged("a/b", "2026-01-01"), ...sinceGhArgs.releases("a/b"), ...sinceGhArgs.login()])
    assert.doesNotMatch(a, /^(merge|create|edit|close|delete|comment|-X|--method|-f|-F|--field|--raw-field|--input)$/);
});

test("gh's JSON parses to dated merges and published releases", () => {
  const m = parseMerged(MERGED_JSON);
  assert.equal(m.length, 4, "one without a URL is skipped");
  assert.deepEqual(m[0], { url: "https://github.com/acme-co/widgets/pull/1302", number: 1302, title: "Fix the widget spinner", mergedAt: Date.parse("2026-11-21T14:00:00Z"), author: "robin-example" });
  const r = parseReleases(RELEASES_JSON, "acme-co/widgets");
  assert.deepEqual(r.map((x) => x.tag), ["v2.4.0", "v2.3.0"], "drafts are left out");
  assert.equal(r[0]!.url, "https://github.com/acme-co/widgets/releases/tag/v2.4.0");
  assert.throws(() => parseMerged({ message: "error" }));
  assert.equal(parseLogin("robin-example\n"), "robin-example");
  assert.equal(parseLogin(""), null);
  assert.equal(parseLogin("not a login"), null);
  assert.equal(parseLogin({ login: "x" }), null);
});

test("the repos come from each project's PR events", () => {
  const { s } = weekend();
  const ev = s.db.prepare(`INSERT INTO events (at, kind, project, address, thread_id, value, ref, note) VALUES (?, 'pr', ?, NULL, NULL, ?, ?, ?)`);
  ev.run(THU, "demo", "open", "https://github.com/acme-co/widgets/pull/1290", "1290");
  ev.run(THU, "other", "open", "https://github.com/acme-co/widgets/pull/77", "77");
  ev.run(THU, "other", "open", "https://github.com/acme-co/site/pull/3", "3");
  ev.run(THU, "other", "open", "https://gitlab.example/x/y/pull/3", "3");
  assert.deepEqual([...sinceRepos(s.db as never, MON, [])], [["acme-co/site", ["other"]], ["acme-co/widgets", ["demo", "other"]]]);
});

// The GitHub cache (Codex review, two rounds): reading is capped, keeping is not. A merge inside the picker's longest
// window is never dropped because too many repos are active, because its PR's events are old, or because another
// project shares its repo; and repos nothing names any more leave the cache, failed reads included.
const D = 86_400_000;
const merge = (repo: string, n: number, at: number, author: string | null): GhMerge => ({ url: `https://github.com/${repo}/pull/${n}`, number: n, title: `PR ${n}`, mergedAt: at, author });
const entry = (projects: string[], merged: GhMerge[], o: Partial<SinceCache["repos"][string]> = {}): SinceCache["repos"][string] => ({ at: MON - H, tried: MON - H, projects, merged, releases: [], error: null, ...o });
const none = (repos: string[]) => new Map<string, RepoRead>(repos.map((r) => [r, { merged: [], releases: [] }]));

test("51 active repos: 50 are read a pass, the 51st keeps its merge, waits its turn and is said to, then goes first", () => {
  const s = setup();
  s.at(MON);
  const ev = s.db.prepare(`INSERT INTO events (at, kind, project, address, thread_id, value, ref, note) VALUES (?, 'pr', 'demo', NULL, NULL, 'open', ?, '1')`);
  const names = Array.from({ length: 51 }, (_, i) => `acme-co/repo-${String(i).padStart(2, "0")}`);
  names.forEach((r, i) => ev.run(MON - i * H, `https://github.com/${r}/pull/1`)); // repo-50 is the least recently active
  const repos = sinceRepos(s.db as never, MON, []);
  assert.equal(repos.size, 51, "every active repo is one to read");
  // last pass read all 51; repo-50 holds the owner's merge and the most recent try, so it's the one left for later
  // (and a tasked merge of unknown author, #6)
  const prev: SinceCache = { at: MON - H, repos: Object.fromEntries(names.map((r) => [r, entry(["demo"], r === "acme-co/repo-50" ? [merge(r, 5, MON - 2 * H, "robin-example"), merge(r, 6, MON - 3 * H, null)] : [], { tried: r === "acme-co/repo-50" ? MON - H : MON - 2 * H })])) };
  const poll = sincePoll(repos, prev);
  assert.equal(poll.length, SINCE_POLL_CAP);
  assert.ok(!poll.includes("acme-co/repo-50"));
  const next = { at: MON, ...sinceKeep(prev, repos, none(poll), MON) };
  assert.deepEqual(next.pending, ["acme-co/repo-50"]);
  const st = strip(s, FRI18, { cache: next, whose: whoseMerges("robin-example", null) });
  assert.equal(st.merged, 1, "the least recently active repo's merge still counts");
  assert.equal(st.github.pending, 1, "and the strip says a repo waits its turn");
  assert.equal(strip(s, FRI18, { cache: next, attached: new Set(["https://github.com/acme-co/repo-50/pull/6"]) }).merged, 1, "so does its tasked merge");
  assert.equal(sincePoll(repos, next)[0], "acme-co/repo-50", "next pass reads it first");
  const after = { at: MON + H, ...sinceKeep(next, repos, none(sincePoll(repos, next)), MON + H) };
  assert.equal(strip(s, FRI18, { cache: after }).github.pending, 1, "one other repo waits now, and none is dropped");
  assert.equal(Object.keys(after.repos).length, 51);
});

test("a task's PR opened 31 days ago that merges today is still read, and its merge counts", () => {
  const s = setup();
  s.at(MON);
  const url = "https://github.com/acme-co/legacy/pull/9";
  s.db.prepare(`INSERT INTO events (at, kind, project, address, thread_id, value, ref, note) VALUES (?, 'pr', 'demo', NULL, NULL, 'open', ?, '9')`).run(MON - 31 * D, url);
  assert.deepEqual([...sinceRepos(s.db as never, MON, []).keys()], [], "no recent event and not on the board: not read");
  const repos = sinceRepos(s.db as never, MON, [{ url, project: "demo" }]);
  assert.deepEqual([...repos], [["acme-co/legacy", ["demo"]]], "a PR on the board keeps its repo read, however old its events");
  const prev: SinceCache = { at: MON - H, repos: { "acme-co/legacy": entry(["demo"], [merge("acme-co/legacy", 9, MON - 2 * H, null)]) } };
  const next = { at: MON, ...sinceKeep(prev, repos, none([]), MON) };
  assert.equal(strip(s, FRI18, { cache: next, attached: new Set([url]) }).merged, 1, "the task's merge counts");
  const read = { at: MON, ...sinceKeep(prev, repos, new Map([["acme-co/legacy", { merged: [merge("acme-co/legacy", 9, MON - 2 * H, null)], releases: [] }]]), MON) };
  assert.equal(strip(s, FRI18, { cache: read, attached: new Set([url]) }).merged, 1);
});

test("the background job's board read names a task's PR whose only event is 31 days old", () => {
  // the real path: a thread on a task logged its PR 31 days ago; the job reads the board as the service does
  const s = setup();
  const [task] = s.publish([{ title: "Legacy fix", state: "current" }]);
  const t = s.spawn("T-9", task!);
  const url = "https://github.com/acme-co/legacy/pull/9";
  s.at(MON);
  s.db.prepare(`INSERT INTO events (at, kind, project, address, thread_id, value, ref, note) VALUES (?, 'pr', 'demo', ?, ?, 'open', ?, '9')`).run(MON - 31 * D, t.address, t.threadId, url);
  linkPr(s.db as never, url, task!, "bb", t.address, MON - 31 * D); // as Engine.prSeen links it (task_prs)
  const prs = boardPrs(s.e.workBoard({ since: MON - SINCE_MAX_MS, project: null }));
  assert.deepEqual(prs.map(({ url, project, resolved }) => ({ url, project, resolved })), [{ url, project: "demo", resolved: false }], "the board holds the task's PR");
  assert.deepEqual([...sinceRepos(s.db as never, MON, prs)], [["acme-co/legacy", ["demo"]]]);
});

test("an unfinished task's 1,000 closed PRs from a retired thread leave the cache; its open PR's repo stays", () => {
  // Codex round 3: a merged or closed PR on the board keeps nothing read for good. Only an unresolved one does; a
  // resolved one follows the 30-day and 14-day rules like any other PR event
  const s = setup();
  const [task] = s.publish([{ title: "Long project", state: "current" }]);
  const t = s.spawn("T-9", task!);
  s.at(MON - 60 * D);
  const ev = s.db.prepare(`INSERT INTO events (at, kind, project, address, thread_id, value, ref, note) VALUES (?, 'pr', 'demo', ?, ?, ?, ?, '1')`);
  const dead = Array.from({ length: 1000 }, (_, i) => `old-org/closed-${i}`);
  const link = (url: string) => linkPr(s.db as never, url, task!, "bb", t.address, MON - 60 * D); // as Engine.prSeen links them
  dead.forEach((r) => (ev.run(MON - 60 * D, t.address, t.threadId, "closed", `https://github.com/${r}/pull/1`), link(`https://github.com/${r}/pull/1`)));
  ev.run(MON - 60 * D, t.address, t.threadId, "open", "https://github.com/acme-co/live/pull/7");
  link("https://github.com/acme-co/live/pull/7");
  s.e.retire(t.threadId);
  s.at(MON);
  const prs = boardPrs(s.e.workBoard({ since: MON - SINCE_MAX_MS, project: null }));
  assert.deepEqual(prs.filter((p) => !p.resolved).map((p) => p.url), ["https://github.com/acme-co/live/pull/7"], "only the open PR is unresolved");
  assert.ok(prs.filter((p) => p.resolved).every((p) => p.at === MON - 60 * D), "the closed ones were last seen 60 days ago");
  const prev: SinceCache = { at: MON - H, repos: Object.fromEntries([...dead, "acme-co/live"].map((r) => [r, entry(["demo"], [], { error: "gh: not found" })])) };
  const repos = sinceRepos(s.db as never, MON, prs);
  assert.deepEqual([...repos.keys()], ["acme-co/live"]);
  assert.deepEqual(Object.keys(sinceKeep(prev, repos, new Map(), MON).repos), ["acme-co/live"], "the closed PRs' repos leave the cache");
});

test("a repo two projects share stays in both, though one project's PR events are old", () => {
  const s = setup();
  s.at(MON);
  const ev = s.db.prepare(`INSERT INTO events (at, kind, project, address, thread_id, value, ref, note) VALUES (?, 'pr', ?, NULL, NULL, 'open', ?, ?)`);
  ev.run(MON - 40 * D, "old", "https://github.com/acme-co/shared/pull/1", "1");
  ev.run(MON - D, "demo", "https://github.com/acme-co/shared/pull/2", "2");
  const repos = sinceRepos(s.db as never, MON, []);
  assert.deepEqual([...repos], [["acme-co/shared", ["demo", "old"]]]);
  const next = { at: MON, ...sinceKeep(emptyCache(), repos, new Map([["acme-co/shared", { merged: [merge("acme-co/shared", 1, MON - H, "robin-example")], releases: [] }]]), MON) };
  assert.equal(strip(s, FRI18, { cache: next, project: "old", whose: whoseMerges("robin-example", null) }).merged, 1, "the older project still counts its merge");
});

test("1,000 dead repos leave the cache, failed reads included; a merge inside the window outlives its repo's last mention", () => {
  // years of history: 1,000 repos last named 60+ days ago, each kept by an old cache with a failed read. The log last
  // saw their PRs open, but no live thread reads them and no task holds them, so they aren't on the board: stale opens
  // don't keep a repo read
  const s = setup();
  s.at(MON);
  const ev = s.db.prepare(`INSERT INTO events (at, kind, project, address, thread_id, value, ref, note) VALUES (?, 'pr', 'demo', NULL, NULL, 'open', ?, '1')`);
  const dead = Array.from({ length: 1000 }, (_, i) => `old-org/repo-${i}`);
  dead.forEach((r, i) => ev.run(MON - 60 * D - i * D, `https://github.com/${r}/pull/1`));
  const prev: SinceCache = { at: MON - H, repos: Object.fromEntries(dead.map((r, i) => [r, entry(["demo"], [merge(r, 1, MON - 60 * D - i * D, "robin-example")], { error: "gh: not found" })])) };
  prev.repos["old-org/recent"] = entry(["demo"], [merge("old-org/recent", 2, MON - 2 * D, "robin-example")]);
  const repos = sinceRepos(s.db as never, MON, boardPrs(s.e.workBoard({ since: MON - SINCE_MAX_MS, project: null })));
  assert.equal(repos.size, 0, "no repo is read for them");
  const next = { at: MON, ...sinceKeep(prev, repos, new Map(), MON) };
  assert.deepEqual(Object.keys(next.repos), ["old-org/recent"], "only the repo whose merge is inside the 14 days stays");
  assert.equal(strip(s, MON - 7 * D, { cache: next, whose: whoseMerges("robin-example", null) }).merged, 1);
  // and with all 1,000 on the board, a pass still reads only SINCE_POLL_CAP of them
  const onBoard = dead.map((r) => ({ url: `https://github.com/${r}/pull/1`, project: "demo" }));
  assert.equal(sincePoll(sinceRepos(s.db as never, MON, onBoard), prev).length, SINCE_POLL_CAP);
});

// The background service itself, over repeated passes (Codex round 4): a fake bb with one connected machine whose gh
// answers per repo and pass; the plugin kv in memory; sleep ends each pass, and the run stops after `passes`.
function service(s: ReturnType<typeof setup>, activity: (repo: string, pass: number) => RepoRead) {
  const kv = new Map<string, unknown>();
  const calls: string[][] = [];
  let pass = 0;
  let passes = 0;
  let svc: { start: (signal: AbortSignal) => Promise<void> } | null = null;
  const ac = new AbortController();
  const bb = {
    hosts: {
      experimental_client: () => ({
        call: async (method: string, input: { repo?: string }) => {
          if (method === "board.ghLogin") throw new Error("not signed in");
          (calls[pass] ??= []).push(input.repo!);
          const r = activity(input.repo!, pass);
          if ("error" in r) throw new Error(r.error);
          return r;
        },
      }),
    },
    sdk: { hosts: { list: async () => [{ id: "host-1", type: "persistent", lifecycle: { phase: "active" }, status: "connected" }] } },
    storage: { kv: { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)) } },
    realtime: { publish: () => {} },
    log: { warn: () => {} },
    background: { service: (_n: string, x: typeof svc) => void (svc = x) },
  };
  const sleep = async (ms: number) => {
    if (ms !== SINCE_REFRESH_MS) return;
    if (++pass >= passes) ac.abort();
  };
  const api = registerBoardSince(bb as never, { db: s.db as never, engine: s.e, login: () => "robin-example", mark: () => {}, sleep });
  return { api, calls, run: async (n: number) => ((passes = n), await svc!.start(ac.signal)) };
}

test("a reported PR first linked after it merged (no PR event) is still read, and its hour-old merge counts", async () => {
  const s = setup();
  const [task] = s.publish([{ title: "Quick fix", state: "current" }]);
  const t = s.spawn("T-9", task!);
  const now = Date.now();
  const url = "https://github.com/acme-co/quick/pull/4";
  s.at(now - H);
  s.e.prSeen(t, "env-9", { outcome: "available", pullRequest: { url, number: 4, state: "merged", attention: "merged", checks: { state: "passing" } } }, "", true);
  assert.equal((s.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'pr'`).get() as { n: number }).n, 0, "linking logs no PR event");
  s.at(now);
  const svc = service(s, (repo) => ({ merged: [merge(repo, 4, now - H, null)], releases: [] }));
  await svc.run(1);
  assert.deepEqual(svc.calls.flat(), ["acme-co/quick"], "its repo is read");
  assert.equal((await svc.api.read({ since: now - D, project: null })).merged, 1, "the task's merge counts");
});

test("the service builds each pass on the last: rotation reaches all 51 repos, and a failed read keeps the verified merge", async () => {
  const now = Date.now();
  {
    const s = setup();
    s.at(now);
    const ev = s.db.prepare(`INSERT INTO events (at, kind, project, address, thread_id, value, ref, note) VALUES (?, 'pr', 'demo', NULL, NULL, 'open', ?, '1')`);
    const names = Array.from({ length: 51 }, (_, i) => `acme-co/repo-${String(i).padStart(2, "0")}`);
    names.forEach((r, i) => ev.run(now - (i + 1) * 60_000, `https://github.com/${r}/pull/1`));
    const svc = service(s, () => ({ merged: [], releases: [] }));
    await svc.run(2);
    assert.equal(svc.calls[0]!.length, SINCE_POLL_CAP);
    assert.ok(svc.calls[1]!.includes("acme-co/repo-50"), "the second pass reads the repo the first left");
    assert.deepEqual([...new Set(svc.calls.flat())].sort(), names, "all 51 are read");
  }
  {
    const s = setup();
    s.at(now);
    s.db.prepare(`INSERT INTO events (at, kind, project, address, thread_id, value, ref, note) VALUES (?, 'pr', 'demo', NULL, NULL, 'open', ?, '1')`).run(now - H, "https://github.com/acme-co/solo/pull/1");
    const svc = service(s, (repo, pass) => (pass === 0 ? { merged: [merge(repo, 1, now - H, "robin-example")], releases: [] } : { error: "gh: rate limited" }));
    await svc.run(2);
    assert.equal(svc.calls.flat().length, 2, "read twice: once good, once failed");
    const st = await svc.api.read({ since: now - D, project: null });
    assert.equal(st.merged, 1, "the failed read keeps the verified merge");
    assert.deepEqual(st.github.errors, ["acme-co/solo: gh: rate limited"]);
  }
});

test("merges: GitHub's and the log's, once each, the owner's or a task's; those no task holds are listed for the CoS", () => {
  const { s } = weekend();
  // the log saw only 1290 (its thread was live), and one merge GitHub has no read for yet
  const ev = s.db.prepare(`INSERT INTO events (at, kind, project, address, thread_id, value, ref, note) VALUES (?, 'pr', 'demo', NULL, NULL, 'merged', ?, ?)`);
  ev.run(SAT + 11 * H, "https://github.com/acme-co/widgets/pull/1290", "1290");
  ev.run(SUN + 2 * H, "https://github.com/acme-co/widgets/pull/1295", "1295");
  const cache: SinceCache = { at: MON, repos: { "acme-co/widgets": { at: MON, projects: ["demo"], merged: parseMerged(MERGED_JSON), releases: parseReleases(RELEASES_JSON, "acme-co/widgets"), error: null } } };
  const attached = new Set(["https://github.com/acme-co/widgets/pull/1290"]);
  const st = strip(s, FRI18, { cache, attached, whose: whoseMerges("Robin-Example", null) });
  assert.equal(st.merged, 2, "1302 (the owner's) and 1290 (tasked); 1250 is before T; a colleague's 1311 isn't the owner's; 1295 has no known author yet");
  assert.deepEqual(st.noTask.map((m) => m.number), [1302], "the tasked 1290 left out");
  // an untasked merge whose author isn't known (only the log has seen it, or GitHub names no author: a deleted account)
  // might be a colleague's, so it never counts as the owner's; a task holding it makes it count
  assert.equal(strip(s, FRI18, { cache, attached: new Set([...attached, "https://github.com/acme-co/widgets/pull/1295"]), whose: whoseMerges("Robin-Example", null) }).merged, 3, "1295 counts once a task holds it");
  const ghost: SinceCache = { ...cache, repos: { "acme-co/widgets": { ...cache.repos["acme-co/widgets"]!, merged: [...cache.repos["acme-co/widgets"]!.merged, { url: "https://github.com/acme-co/widgets/pull/1320", number: 1320, title: "By a deleted account", mergedAt: SUN, author: null }] } } };
  assert.equal(strip(s, FRI18, { cache: ghost, attached, whose: whoseMerges("Robin-Example", null) }).merged, 2, "a GitHub merge with no author doesn't count");
  assert.deepEqual(st.releases.map((r) => r.tag), ["v2.4.0"]);
  assert.deepEqual(st.whose, { by: "setting", login: "Robin-Example" });
  assert.equal(strip(s, FRI18, { cache, attached, whose: whoseMerges("robin-example", null), project: "elsewhere" }).merged, 0, "a project filter keeps its own repos and log");
  assert.doesNotThrow(() => boardSinceSchema.parse(st), "the strip is the RPC's shape");
  const text = fileThemText(st.noTask, FRI18);
  assert.match(text, /^Merged since 2026-11-20 18:00 UTC with no task/);
  assert.match(text, /- https:\/\/github\.com\/acme-co\/widgets\/pull\/1302 Fix the widget spinner/);
  assert.equal(text.split("\n").length, 2, "one message, one line per merge");
});

test("approvals count each owner approval since T, and the approval count is project-scoped", () => {
  const s = setup();
  const [a] = s.publish([{ title: "Report", state: "current" }]);
  const d = s.e.deliver(s.lead, { title: "The report", summary: "Done.", proof, task: a }, place);
  s.at(SAT);
  s.e.personApprove(d.id, 1, null);
  assert.equal(strip(s, FRI18).approved, 1);
  assert.equal(strip(s, SAT + 1).approved, 0);
  assert.equal(strip(s, FRI18, { project: "other" }).approved, 0);
});

test("whose merges: the setting, else gh's signed-in login, else tasked PRs only; never every merge", () => {
  assert.deepEqual(whoseMerges("@Robin-Example ", "gh-user"), { by: "setting", login: "Robin-Example" }, "the setting wins over gh");
  assert.deepEqual(whoseMerges("", "gh-user"), { by: "gh", login: "gh-user" }, "no setting: gh's login");
  assert.deepEqual(whoseMerges("not a login!", "gh-user"), { by: "gh", login: "gh-user" }, "a setting that isn't a login is no setting");
  assert.deepEqual(whoseMerges("", null), { by: "tasked", login: null }, "no setting, no gh login: tasked PRs only");
  assert.deepEqual(whoseMerges("", undefined), { by: "tasked", login: null }, "a cache from before the gh login was kept");
  assert.deepEqual(whoseMerges("", "bad login"), { by: "tasked", login: null });

  const { s } = weekend();
  s.db.prepare(`INSERT INTO events (at, kind, project, address, thread_id, value, ref, note) VALUES (?, 'pr', 'demo', NULL, NULL, 'merged', ?, ?)`).run(SUN + 2 * H, "https://github.com/acme-co/widgets/pull/1295", "1295");
  const cache: SinceCache = { at: MON, ghLogin: "sam-example", repos: { "acme-co/widgets": { at: MON, projects: ["demo"], merged: parseMerged(MERGED_JSON), releases: [], error: null } } };
  const attached = new Set(["https://github.com/acme-co/widgets/pull/1290"]);
  // gh is signed in as sam-example: sam's 1311 and the tasked 1290; robin's untasked 1302 isn't sam's, and the log's
  // untasked 1295 has no known author
  const gh = strip(s, FRI18, { cache, attached, whose: whoseMerges("", cache.ghLogin) });
  assert.deepEqual(gh.whose, { by: "gh", login: "sam-example" });
  assert.equal(gh.merged, 2);
  // tasked only: 1290 alone; the log's untasked 1295 and every author's untasked merge stay out, so nothing waits to be filed
  const tasked = strip(s, FRI18, { cache, attached, whose: whoseMerges("", null) });
  assert.equal(tasked.merged, 1, "with no login known, only PRs a task holds count, never all four in the repo");
  assert.deepEqual(tasked.noTask, []);
  assert.doesNotThrow(() => boardSinceSchema.parse(tasked));
  assert.doesNotThrow(() => boardSinceSchema.parse(gh));
});

test("the CoS's tidy rows: a record whose from equals its to isn't a move, and a merge into another task isn't a drop", () => {
  const row = (seq: number, task: string, from_col: string | null, to_col: string, at: number, why: string | null) => ({ task, project: "p", from_col, to_col, at, why, seq });
  const rows = [
    // a: waits on the owner, then the CoS files a PR on it: a record, the task stays waiting
    row(1, "t-a", "planned", "waiting", 10, "card d-1 waits on the owner"),
    row(2, "t-a", "waiting", "waiting", 20, "cos: file pr https://github.com/acme-co/widgets/pull/1"),
    // b: dropped with attachments before T; the CoS confirms the drop in the window
    row(3, "t-b", "in_progress", "dropped", 1, "dropped with attachments"),
    row(4, "t-b", "dropped", "dropped", 30, "cos: confirm drop"),
    // c: the CoS merges c into d: c goes to dropped (why cos: merge), d logs its own record
    row(5, "t-c", "planned", "dropped", 40, "cos: merge into t-d"),
    row(6, "t-d", "planned", "planned", 40, "cos: merge t-c \"Login\" in"),
    // e: dropped quietly before T, restored by the CoS in the window
    row(7, "t-e", "planned", "dropped", 2, "dropped"),
    row(8, "t-e", "dropped", "planned", 50, "cos: restore"),
  ];
  const { counts, moved } = countMoves(rows, 5);
  assert.deepEqual(counts, { shipped: 0, new: 0, waiting: 1, blocked: 0, dropped: 0 }, "a still waits (the file record doesn't hide it); c's merge isn't a drop; nothing is new");
  assert.deepEqual(Object.keys(moved).sort(), ["t-a", "t-c", "t-e"], "b's confirm and d's merge record aren't moves");
  assert.deepEqual(moved["t-a"], { from: "planned", to: "waiting", at: 10, isNew: false }, "the record's time doesn't move the card's");
  assert.deepEqual(moved["t-e"], { from: "dropped", to: "planned", at: 50, isNew: false }, "a restore is a move, not a new task");
});

test("a task added and quietly dropped inside the window counts in neither new nor dropped; one dropped with its things counts in both", () => {
  const row = (seq: number, task: string, from_col: string | null, to_col: string, at: number, why: string | null) => ({ task, project: "p", from_col, to_col, at, why, seq });
  const rows = [
    row(1, "t-x", null, "planned", 10, "planned"),
    row(2, "t-x", "planned", "dropped", 20, "dropped"),
    row(3, "t-y", null, "planned", 10, "planned"),
    row(4, "t-y", "planned", "in_progress", 15, "T-1 working"),
    row(5, "t-y", "in_progress", "dropped", 20, "dropped with attachments"),
    row(6, "t-z", null, "planned", 1, "planned"),
    row(7, "t-z", "planned", "dropped", 20, "dropped"),
  ];
  const { counts, moved } = countMoves(rows, 5);
  assert.deepEqual(counts, { shipped: 0, new: 1, waiting: 0, blocked: 0, dropped: 1 }, "y only: x was a plan edit; z, added before T, is a quiet drop");
  assert.equal(moved["t-x"]!.isNew, true, "x still shows as a card that moved, for the only-moved view");
  assert.equal(countMoves(rows, 15).counts.new, 0, "a T after x's add sees only its quiet drop");
});

test("a typed time counts only once it is a whole time in the last 14 days, so the dates a date field passes through read nothing", () => {
  const now = Date.parse("2026-11-24T16:00:00");
  assert.equal(typedSince("2026-11-22T00:00", now), Date.parse("2026-11-22T00:00"));
  assert.equal(typedSince("0002-11-22T00:00", now), null, "the year while it is typed");
  assert.equal(typedSince("2026-11-02T00:00", now), null, "the 2nd on the way to the 22nd: more than 14 days back");
  assert.equal(typedSince("2026-11-25T00:00", now), null, "after now");
  assert.equal(typedSince("", now), null, "a cleared field");
});
