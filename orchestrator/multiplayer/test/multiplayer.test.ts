import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import plugin from "../../server.ts";
import { Engine } from "../../core/engine.ts";
import { WRITES, deliverablesSchema, outputsSchema, type Deliverables, type Outputs } from "../../contract.ts";
import { inReview, onDeliverablesTab } from "../../app/kit.ts";
import { deliverablesTab, offBoards, START } from "../../app/past.ts";
import { MULTIPLAYER_WRITES, multiplayerViewSchema, type BoardView, type MultiplayerView } from "../contract.ts";
import { checkBoard, parseChannel } from "../core/boards.ts";
import { firstSentence, parseReview, reviewArgs, type ReviewRead } from "../core/findings.ts";
import { healthAt, open, settled } from "../core/views.ts";
import { everyArg, health } from "../core/watch.ts";
import { boardSlack, SLACK_READS } from "../slack.ts";

const CH = "CFAKE00001";
const CH2 = "GFAKE00002";
const PR1 = "https://github.com/acme-co/widgets/pull/41";
const PR2 = "https://github.com/acme-co/widgets/pull/42";
const REVIEW1 = `${PR1}#pullrequestreview-9001`;
const ASK = `https://acme.slack.com/archives/${CH}/p1700000000000100`;
const REPLY = `https://acme.slack.com/archives/${CH}/p1700000000000200`;
const SOURCE = "pr-watch-test";

const scratchRoot = join(import.meta.dirname, ".scratch");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "mp-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

type Tool = { name: string; execute: (p: unknown, ctx: { threadId: string }) => Promise<{ content: { text: string }[]; isError?: boolean }> };
type Route = (c: unknown) => Promise<Response>;
type Cli = (argv: string[], ctx: { threadId?: string; cwd?: string }) => Promise<{ exitCode: number; stdout: string; stderr?: string }>;

/** The real plugin on a fake bb: the CoS, leads otter and kite, an otter thread; one machine whose gh answers `reviews`. */
async function host(opts: { slackToken?: string; reviews?: Record<string, ReviewRead>; env?: boolean } = {}) {
  const root = mkdtempSync(join(scratch, "h-"));
  const file = join(root, "data.db");
  const raw = new DatabaseSync(file);
  const pre = new Engine(raw as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  pre.register("T-cos", "cos", null);
  pre.register("T-lo", "lead", "otter");
  pre.register("T-lk", "lead", "kite");
  pre.register("T-th", "thread", "otter", "T-lo");
  const rpc: Record<string, (input: unknown) => Promise<unknown>> = {};
  const tools = new Map<string, Tool>();
  const routes = new Map<string, Route>();
  let cli: Cli | null = null;
  const ghCalls: string[] = [];
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : noop), apply: () => noop });
  const sdk = {
    threads: { get: async ({ threadId }: { threadId: string }) => ({ id: threadId, title: null, archivedAt: null, status: "idle", environmentId: opts.env ? "env-1" : null }), context: async () => null, send: async () => ({ delivery: "sent" }), interactions: { list: async () => [] } },
    hosts: { list: async () => [{ id: "m1", name: "box", type: "persistent", lifecycle: { phase: "active" }, status: "connected" }] },
    environments: { get: async () => ({ path: root, hostId: "m1" }) },
  };
  const ghClient = {
    call: async (method: string, input: { url: string }) => {
      ghCalls.push(`${method} ${input.url}`);
      const r = opts.reviews?.[input.url];
      if (!r) throw new Error("no such review");
      return r;
    },
  };
  const bb: any = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "pluginId") return "orchestrator";
        if (k === "settings")
          return {
            define: (schema: Record<string, { default: unknown }>) => {
              const v: any = Object.fromEntries(Object.entries(schema).map(([key, d]) => [key, d.default]));
              Object.assign(v, { stateDir: join(root, "state"), projectsDir: join(root, "projects"), memoryConfig: "", prPollMinutes: 0, dreamsEnabled: false, cloudConfigPath: join(root, "no-cloud.json"), integrationRoutes: JSON.stringify({ [SOURCE]: ["lead:otter"] }), slackToken: opts.slackToken });
              return { get: async () => v, onChange: () => {} };
            },
          };
        if (k === "storage") return { database: () => Object.assign(raw, { name: file }), kv: noop };
        if (k === "agents") return { registerTool: (t: Tool) => tools.set(t.name, t), configure: () => {}, contributeInstructions: () => {} };
        if (k === "rpc") return { register: (_c: unknown, handlers: typeof rpc) => Object.assign(rpc, handlers) };
        if (k === "http") return { route: (method: string, path: string, h: Route) => routes.set(`${method} ${path}`, h) };
        if (k === "server") return { loopbackBaseUrl: "http://127.0.0.1:9", experimental_appUrl: null };
        if (k === "hosts") return { experimental_client: () => ghClient };
        if (k === "cli") return { register: (c: { run: Cli }) => (cli = c.run) };
        if (k === "sdk") return new Proxy(sdk, { get: (t: any, key) => (key in t ? t[key] : noop) });
        return noop;
      },
    },
  );
  await plugin(bb);
  const post = async (path: string, body: unknown, origin = "http://127.0.0.1:9") => {
    const headers: Record<string, string> = { origin, "sec-fetch-site": "same-origin" };
    const c = {
      req: { url: `http://127.0.0.1:9/api/v1/plugins/orchestrator/http${path}`, header: (n: string) => headers[n.toLowerCase()], json: async () => body },
      json: (b: unknown, status = 200) => new Response(JSON.stringify(b), { status }),
    };
    const route = routes.get(`POST ${path}`);
    assert.ok(route, `the plugin serves ${path}`);
    const r = await route(c);
    return { status: r.status, ...((await r.json()) as { ok: boolean; result?: any; error?: { kind: string; message: string } }) };
  };
  const tool = async (name: string, p: unknown, threadId = "T-lo") => {
    const r = await tools.get(name)!.execute(p, { threadId });
    return { text: r.content[0]!.text, error: !!r.isError };
  };
  // checked against the contract as bb checks every RPC answer: an answer that fails it never reaches the page
  const view = async () => {
    const r = await multiplayerViewSchema["~standard"].validate(await rpc.multiplayer!(null));
    assert.equal(r.issues, undefined, JSON.stringify(r.issues));
    return (r as { value: MultiplayerView }).value;
  };
  const deliverables = async () => {
    const r = await deliverablesSchema["~standard"].validate(await rpc.deliverables!(null));
    assert.equal(r.issues, undefined, JSON.stringify(r.issues));
    return (r as { value: Deliverables }).value;
  };
  const needs = async () => (await rpc.needsYou!({ zone: "UTC" })) as { cards: { id: string; rev: number }[] };
  const settle = () => new Promise((r) => setTimeout(r, 20));
  return { raw, rpc, tools, post, tool, view, deliverables, needs, cli: () => cli!, ghCalls, settle, root };
}

const idOf = (text: string, prefix: string) => new RegExp(`\\b(${prefix}-[a-f0-9]+)\\b`).exec(text)?.[1] ?? assert.fail(`no ${prefix} id in ${JSON.stringify(text)}`);
const proof = [{ kind: "link", caption: "The review", url: "https://example.com/review" }];

test("a board is added and removed only by the owner's page, and only names a real watcher", async () => {
  const h = await host();
  assert.deepEqual(Object.keys(h.rpc).filter((k) => /multiplayer/i.test(k)), ["multiplayer"], "agents can read the tab and change nothing");
  const evil = await h.post(MULTIPLAYER_WRITES.add, { channel: CH }, "http://evil.test");
  assert.equal(evil.status, 403, "a foreign page can't add a board");
  assert.deepEqual((await h.view()).boards, [], "and the refused write added nothing");
  const bad = await h.post(MULTIPLAYER_WRITES.add, { channel: CH, watcher: "nobody" });
  assert.equal(bad.ok, false, "a watcher that isn't an integrationRoutes source is refused");
  assert.equal((await h.post(MULTIPLAYER_WRITES.add, { channel: "general" })).ok, false, "a name alone can't be read: a link or id is needed");
  const added = await h.post(MULTIPLAYER_WRITES.add, { channel: `https://acme.slack.com/archives/${CH}`, watcher: SOURCE, name: "reviews", purpose: "Code review requests" });
  assert.equal(added.ok, true, added.error?.message);
  assert.equal((await h.post(MULTIPLAYER_WRITES.add, { channel: CH })).ok, false, "the same channel twice is refused");
  const v = await h.view();
  assert.equal(v.boards.length, 1);
  assert.deepEqual([v.boards[0]!.channel, v.boards[0]!.name, v.boards[0]!.from, v.boards[0]!.open], [CH, "reviews", "typed", `https://acme.slack.com/archives/${CH}`], "without a token the typed fields stand in");
  assert.deepEqual(v.sources, [SOURCE]);
  assert.equal((await h.post(MULTIPLAYER_WRITES.remove, { id: added.result }, "http://evil.test")).status, 403, "a foreign page can't remove one either");
  assert.equal((await h.post(MULTIPLAYER_WRITES.remove, { id: added.result })).ok, true);
  assert.deepEqual((await h.view()).boards, []);
  h.raw.close();
});

test("a pasted channel link or id is the channel; anything else is refused", () => {
  assert.deepEqual(parseChannel(CH), { channel: CH, link: null });
  assert.deepEqual(parseChannel(`https://acme.slack.com/archives/${CH2}/p1700000000000100`), { channel: CH2, link: `https://acme.slack.com/archives/${CH2}` }, "a message link names its channel");
  assert.deepEqual(parseChannel(`https://app.slack.com/client/TFAKE0001/${CH}`), { channel: CH, link: null });
  assert.equal(parseChannel("https://evil.test/archives/CFAKE00001"), null);
  assert.throws(() => checkBoard({ channel: CH, setup: "https://evil.test/x" }, []), /Slack message link/);
});

test("a lead files a record and updates it step by step; nobody else can", async () => {
  const h = await host();
  const b = (await h.post(MULTIPLAYER_WRITES.add, { channel: CH, watcher: SOURCE })).result as string;
  const filed = await h.tool("orch_review_record", { board: CH, wake: "w-1", request: { permalink: ASK, at: "2026-11-19T13:05:00Z", asker: "UFAKE0001" }, prs: [{ url: PR1, class: "risky" }, { url: PR2, class: "simple" }] });
  assert.equal(filed.error, false, filed.text);
  const id = idOf(filed.text, "rr");
  let r = (await h.view()).records[0]!;
  assert.deepEqual([r.id, r.board, r.state, r.asker, r.askedAt, r.prs.map((p) => [p.name, p.class])], [id, b, "reviewing", { id: "UFAKE0001", name: null }, Date.parse("2026-11-19T13:05:00Z"), [["widgets#41", "risky"], ["widgets#42", "simple"]]]);
  assert.equal(r.times.asked, Date.parse("2026-11-19T13:05:00Z"), "Asked is the request's own time");

  const again = await h.tool("orch_review_record", { board: b, wake: "w-1", prs: "[{\"url\":\"" + PR1 + "\",\"class\":\"review\"}]" });
  assert.equal(idOf(again.text, "rr"), id, "the same wake again updates its record (a safe retry), and prs may come as a JSON string");

  assert.equal((await h.tool("orch_review_record", { id, thread: "thread:otter:1", reviews: [REVIEW1] })).error, false);
  r = (await h.view()).records[0]!;
  assert.equal(r.prs[0]!.class, "review", "a PR given again takes its new class");
  assert.ok(r.times.thread && r.times.review, "the thread and review steps got their times");
  assert.equal(r.times.reply, undefined, "a step not reached has no time");
  const reviewAt = r.times.review;
  await new Promise((res) => setTimeout(res, 5));
  await h.tool("orch_review_record", { id, reviews: [REVIEW1], reply: REPLY, state: "done", note: "GitHub review posted" });
  r = (await h.view()).records[0]!;
  assert.deepEqual([r.state, r.reply, r.note, r.times.review], ["done", REPLY, "GitHub review posted", reviewAt], "a step's time is its first, not its latest");
  assert.ok(r.times.reply && r.times.done);

  const other = await h.tool("orch_review_record", { id, state: "reviewing" }, "T-lk");
  assert.match(other.text, /lead:otter's record/, "another lead can't touch it");
  assert.match((await h.tool("orch_review_record", { board: b, prs: [{ url: PR1 }] }, "T-th")).text, /only a lead/);
  assert.match((await h.tool("orch_review_record", { board: b, request: { asker: "Robin" } })).text, /Slack user id/, "an asker is an id, never a name");
  assert.match((await h.tool("orch_review_record", { id, reviews: [`${PR2.replace("42", "43")}#pullrequestreview-1`] })).text, /doesn't list/);
  assert.match((await h.tool("orch_review_record", { board: "mb-nope" })).text, /No board/);
  h.raw.close();
});

test("a board's deliverable stays off Deliverables in every state, shows on its review, and board may be a JSON string", async () => {
  const h = await host();
  const b = (await h.post(MULTIPLAYER_WRITES.add, { channel: CH, watcher: SOURCE })).result as string;
  const rec = idOf((await h.tool("orch_review_record", { board: b, wake: "w-2", prs: [{ url: PR1 }] })).text, "rr");
  const asObject = await h.tool("orch_deliver", { title: "Review widgets#41", summary: "Changes requested.", proof, board: { id: b, record: rec } });
  assert.equal(asObject.error, false, asObject.text);
  const asString = await h.tool("orch_deliver", { title: "Review widgets#42", summary: "Approved.", proof, board: JSON.stringify({ id: CH }) });
  assert.equal(asString.error, false, `an old-schema lead's JSON string is taken: ${asString.text}`);
  assert.equal((await h.tool("orch_deliver", { title: "Plain", summary: "Not a board's.", proof })).error, false);
  const [d1, d2] = [idOf(asObject.text, "v"), idOf(asString.text, "v")];

  let all = await h.deliverables();
  const byId = (id: string) => all.find((d) => d.id === id)!;
  assert.deepEqual(byId(d1).board, { id: b, record: rec, flag: null }, "the page sees the board through the deliverables read");
  assert.equal(byId(d2).board?.id, b, "a channel id resolves to its board");
  assert.deepEqual(all.filter(onDeliverablesTab).map((d) => d.title), ["Plain"], "the Deliverables tab lists only the plain one");
  assert.deepEqual(inReview(all).map((d) => d.title), ["Plain"], "and its count and the rail badge leave the board's out");

  const r = (await h.view()).records.find((x) => x.id === rec)!;
  assert.deepEqual(r.deliverable, { id: d1, state: "review", rev: 1, flag: null, card: null }, "the record points at its deliverable");
  assert.equal(r.waitsOnYou, true, "in review, it waits on the owner");
  assert.ok(r.times.deliverable);

  assert.equal((await h.post(WRITES.approve, { id: d1, rev: 1, note: null })).ok, true, "the review view's Approve");
  assert.equal((await h.post(WRITES.requestChanges, { id: d2, rev: 1, text: "Say why it is safe" })).ok, true, "and its Send back");
  all = await h.deliverables();
  assert.deepEqual(all.filter(onDeliverablesTab).map((d) => d.title), ["Plain"], "decided, they still stay off Deliverables");
  assert.equal((await h.view()).records.find((x) => x.id === rec)!.waitsOnYou, false);
  assert.equal((await h.post(MULTIPLAYER_WRITES.remove, { id: b })).ok, false, "a sent-back review's revision keeps its board: removing it now would hide that revision");

  const rev = await h.tool("orch_deliver", { title: "Review widgets#42", summary: "Approved, with why.", proof, revises: d2 });
  assert.equal(rev.error, false, rev.text);
  all = await h.deliverables();
  assert.equal(byId(d2).board?.id, b, "a revision without board (an old-schema lead) stays on its board");
  assert.equal(all.filter(onDeliverablesTab).length, 1);
  assert.match((await h.tool("orch_deliver", { title: "x", summary: "y", proof, board: { id: b, record: "rr-0000" } })).text, /not one of your review records/);
  assert.equal((await h.post(MULTIPLAYER_WRITES.remove, { id: b })).ok, false, "a board whose review waits on the owner can't be removed (it would vanish)");

  const copy = `'v-' || printf('%06x', i)`;
  h.raw
    .prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
       INSERT INTO deliverables (id, project, lead, title, summary, state, rev, created_at, updated_at, json)
       SELECT ${copy}, project, lead, title, summary, state, rev, created_at, updated_at + i, json_set(json, '$.id', ${copy}, '$.updatedAt', updated_at + i) FROM deliverables, n WHERE id = ?`,
    )
    .run(d1);
  all = await h.deliverables();
  assert.equal(all.filter((d) => d.board).length, 200, "board reviews have their own 200 newest");
  assert.deepEqual(all.filter(onDeliverablesTab).map((d) => d.title), ["Plain"], "200 newer board reviews don't push a past deliverable off the read");
  h.raw.close();
});

test("a removed board takes no new review: its watcher and lead may still be running, and the owner would never see it", async () => {
  const h = await host();
  const b = (await h.post(MULTIPLAYER_WRITES.add, { channel: CH, watcher: SOURCE })).result as string;
  const d = idOf((await h.tool("orch_deliver", { title: "Review widgets#41", summary: "Approved.", proof, board: { id: b } })).text, "v");
  assert.equal((await h.post(WRITES.approve, { id: d, rev: 1, note: null })).ok, true);
  assert.equal((await h.post(MULTIPLAYER_WRITES.remove, { id: b })).ok, true, "nothing open: it can go");
  for (const board of [{ id: b }, { id: CH }, JSON.stringify({ id: CH })]) {
    const r = await h.tool("orch_deliver", { title: "Review widgets#44", summary: "Approved.", proof, board });
    assert.equal(r.error, true, `refused by ${JSON.stringify(board)}`);
    assert.match(r.text, /no board/);
  }
  assert.match((await h.tool("orch_deliver", { title: "Review widgets#41", summary: "Again.", proof, revises: d })).text, /revise only a deliverable/, "a decided one can't come back in review");
  assert.match((await h.tool("orch_review_record", { board: CH, wake: "w-late", prs: [{ url: PR1 }] })).text, /No board/, "nor can a new record start there");
  assert.deepEqual((await h.deliverables()).map((x) => x.state), ["approved"], "nothing waits on the owner behind the removed board");
  h.raw.close();
});

test("a board review's files and recorded outputs stay off Deliverables' Files too", async () => {
  const h = await host({ env: true });
  const b = (await h.post(MULTIPLAYER_WRITES.add, { channel: CH, watcher: SOURCE })).result as string;
  mkdirSync(join(h.root, "state"), { recursive: true });
  const [report, plain] = [join(h.root, "state", "review.md"), join(h.root, "state", "plan.md")];
  writeFileSync(report, "# Review\n");
  writeFileSync(plain, "# Plan\n");
  for (const [title, path, url] of [["The review", report, null], ["The review link", null, "https://example.com/review"], ["The plan", plain, null]] as const) {
    const o = await h.tool("orch_output", { title, kind: "doc", ...(path ? { path } : { url }) });
    assert.equal(o.error, false, o.text);
  }
  const sent = await h.tool("orch_deliver", { title: "Review widgets#41", summary: "Changes requested.", proof: [{ kind: "doc", caption: "The review", path: report }, ...proof], board: { id: b } });
  assert.equal(sent.error, false, sent.text);
  assert.equal((await h.tool("orch_deliver", { title: "Plan", summary: "Not a board's.", proof: [{ kind: "doc", caption: "The plan", path: plain }] })).error, false);
  const r = await outputsSchema["~standard"].validate(await h.rpc.outputs!(null));
  assert.equal(r.issues, undefined);
  const os = (r as { value: Outputs }).value;
  const all = await h.deliverables();
  const tab = deliverablesTab(all.filter(onDeliverablesTab), offBoards(all, os), START);
  assert.deepEqual(tab.files.map((f) => f.name).sort(), ["plan.md"], "only the plain deliverable's file: the board review's report and link stay on its review");
  h.raw.close();
});

test("a flagged review files a Needs you card, and deciding it in either place closes the other", async () => {
  const h = await host();
  const b = (await h.post(MULTIPLAYER_WRITES.add, { channel: CH, watcher: SOURCE })).result as string;
  const rec = idOf((await h.tool("orch_review_record", { board: b, wake: "w-9", prs: [{ url: PR1 }], state: "waits" })).text, "rr");
  assert.equal((await h.view()).records[0]!.waitsOnYou, true, "the lead's waits, before any deliverable");
  const d1 = idOf((await h.tool("orch_deliver", { title: "Review widgets#38", summary: "CI red.", proof, board: { id: b, record: rec, flag: "Couldn't verify: CI red" } })).text, "v");
  const d2 = idOf((await h.tool("orch_deliver", { title: "Review widgets#39", summary: "Interview pending.", proof, board: { id: b, flag: "Interview pending" } })).text, "v");
  let cards = (await h.needs()).cards;
  assert.equal(cards.length, 2, "each flag reached Needs you");
  const shown = (await h.rpc.needsYou!({ zone: "UTC" })) as { cards: { options: { recommended: boolean }[] }[] };
  assert.deepEqual(shown.cards[0]!.options.map((o) => o.recommended), [false, false], "a flagged review recommends neither answer");
  const card1 = (await h.deliverables()).find((d) => d.id === d1)!;
  assert.equal(card1.state, "review");

  const c1 = h.raw.prepare(`SELECT id, json FROM decisions WHERE json_extract(json, '$.orchestrator.board_review.deliverable') = ?`).get(d1) as { id: string; json: string };
  const rev = JSON.parse(c1.json).rev;
  assert.equal((await h.post(WRITES.answer, { id: c1.id, rev, option: "1", text: null, via: "desktop" })).ok, true, "Approve on the card");
  assert.equal((await h.deliverables()).find((d) => d.id === d1)!.state, "approved", "approved the deliverable itself");
  assert.equal((await h.view()).records[0]!.waitsOnYou, false, "decided, its record no longer waits on the owner, though the lead's state still says waits");
  assert.equal((await h.needs()).cards.length, 1);

  assert.equal((await h.post(WRITES.approve, { id: d2, rev: 1, note: null })).ok, true, "Approve on the review view");
  cards = (await h.needs()).cards;
  assert.deepEqual(cards, [], "took its card off Needs you");
  const c2 = h.raw.prepare(`SELECT json FROM decisions WHERE json_extract(json, '$.orchestrator.board_review.deliverable') = ?`).get(d2) as { json: string };
  assert.equal(JSON.parse(c2.json).state, "withdrawn");
  h.raw.close();
});

test("a watcher is healthy while its reads come on time and late once one is overdue", () => {
  const min = 60_000;
  const beat = { source: SOURCE, lastAt: 0, prevAt: null, everyMs: 5 * min, reads: 1 };
  assert.deepEqual(health(null, 0), { state: "none" });
  assert.equal(health(beat, 4 * min).state, "healthy");
  assert.equal(health(beat, 7.5 * min).state, "healthy", "a read may run up to half an interval past its time");
  assert.equal(health(beat, 7.5 * min + 1).state, "late");
  assert.equal(health(beat, 60 * min).state, "late");
  assert.equal((health(beat, 0) as { nextAt: number }).nextAt, 5 * min, "the next read is the last plus the interval");
  assert.equal(health({ ...beat, everyMs: 30_000 }, 30_000 + 60_000).state, "healthy", "the grace is at least a minute");
  assert.equal(health({ ...beat, everyMs: null, prevAt: -10 * min }, 16 * min).state, "late", "without --every, the gap between the last two reads is the interval");
  assert.equal(health({ ...beat, everyMs: null }, 99 * min).state, "unknown", "one read and no interval: no judgement");
  const read = { watch: { health: { ...health(beat, min), lastAt: 0 } } } as unknown as BoardView;
  assert.equal(healthAt(read, 4 * min).watch!.health.state, "healthy");
  assert.equal(healthAt(read, 60 * min).watch!.health.state, "late", "an open page turns late on its own clock: a stopped watcher sends no change to refetch on");
  assert.equal(everyArg(["x", "--every", "5"]), 5 * min);
  assert.equal(everyArg(["x"]), null);
  assert.throws(() => everyArg(["x", "--every", "soon"]));
});

test("the heartbeat is the operator's: an agent can't fake a read, and an unknown source is refused", async () => {
  const h = await host();
  await h.post(MULTIPLAYER_WRITES.add, { channel: CH, watcher: SOURCE });
  const cli = h.cli();
  const fromAgent = await cli(["integration", "heartbeat", SOURCE], { threadId: "T-lo" }).catch((e: Error) => ({ exitCode: 1, stdout: e.message }));
  assert.notEqual(fromAgent.exitCode, 0, "refused from a thread");
  assert.equal((await h.view()).boards[0]!.watch!.health.state, "none", "and recorded nothing");
  const unknown = await cli(["integration", "heartbeat", "nobody"], {}).catch((e: Error) => ({ exitCode: 1, stdout: e.message }));
  assert.notEqual(unknown.exitCode, 0);
  const okRead = await cli(["integration", "heartbeat", SOURCE, "--every", "5"], {});
  assert.equal(okRead.exitCode, 0, okRead.stdout);
  const w = (await h.view()).boards[0]!.watch!;
  assert.deepEqual([w.health.state, w.health.everyMs, w.reads, w.agents.map((a) => a.address)], ["healthy", 300_000, 1, ["lead:otter"]]);
  await cli(["integration", "heartbeat", SOURCE], {});
  assert.equal((await h.view()).boards[0]!.watch!.reads, 2, "each read is counted, and the interval it gave is kept");
  assert.equal((await h.view()).boards[0]!.watch!.health.everyMs, 300_000);
  const board = h.raw.prepare(`SELECT COUNT(*) AS n FROM board WHERE title LIKE '%heartbeat%'`).get() as { n: number };
  assert.equal(board.n, 0, "a read every few minutes leaves no Board row");
  h.raw.close();
});

function fakeSlack() {
  const methods: string[] = [];
  const fetch = async (url: string) => {
    const m = new URL(url).pathname.replace("/api/", "");
    methods.push(m);
    const body: Record<string, unknown> =
      m === "conversations.info"
        ? { ok: true, channel: { id: CH, name: "reviews", is_private: true, purpose: { value: "Code review requests" } } }
        : m === "pins.list"
          ? { ok: true, items: [{ type: "message", created: 2, message: { text: "SECRET later pin", permalink: `${ASK}9` } }, { type: "message", created: 1, message: { text: "SECRET setup words", permalink: ASK } }] }
          : m === "users.info"
            ? { ok: true, user: { id: "UFAKE0001", name: "robin", profile: { display_name: "Robin" } } }
            : { ok: false, error: "unexpected" };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
  };
  return { methods, fetch };
}

test("the header reads only conversations.info, pins.list and users.info, and keeps no message text", async () => {
  const s = fakeSlack();
  let landed = 0;
  const slack = boardSlack(s.fetch, () => landed++);
  assert.equal(slack.header("test-token", CH), undefined, "a first read never waits on Slack");
  assert.equal(slack.user("test-token", "UFAKE0001"), undefined);
  for (let i = 0; i < 50 && landed < 2; i++) await new Promise((r) => setTimeout(r, 5));
  const head = slack.header("test-token", CH)!;
  assert.deepEqual(head, { name: "reviews", private: true, purpose: "Code review requests", setup: ASK, note: null }, "the oldest pin is the setup message, by its link only");
  assert.equal(slack.user("test-token", "UFAKE0001"), "Robin");
  assert.ok(!JSON.stringify(head).includes("SECRET"), "no pinned message text is kept");
  assert.ok(s.methods.length >= 3);
  assert.deepEqual(s.methods.filter((m) => !(SLACK_READS as readonly string[]).includes(m)), [], "nothing beyond the three reads (no history)");
});

test("through the whole plugin, with a token, the tab calls Slack for nothing but the header and askers", async () => {
  const s = fakeSlack();
  const real = globalThis.fetch;
  globalThis.fetch = s.fetch as never;
  try {
    const h = await host({ slackToken: "test-token" });
    const b = (await h.post(MULTIPLAYER_WRITES.add, { channel: CH, watcher: SOURCE })).result as string;
    await h.tool("orch_review_record", { board: b, wake: "w-3", request: { permalink: ASK, asker: "UFAKE0001" }, prs: [{ url: PR1 }] });
    await h.view();
    await new Promise((r) => setTimeout(r, 50));
    const v = await h.view();
    assert.deepEqual([v.boards[0]!.name, v.boards[0]!.from, v.boards[0]!.private, v.boards[0]!.setup], ["reviews", "slack", true, ASK]);
    assert.equal(v.records[0]!.asker?.name, "Robin", "askers by their Slack name");
    assert.deepEqual([...new Set(s.methods)].sort(), [...SLACK_READS].sort());
    h.raw.close();
  } finally {
    globalThis.fetch = real;
  }
});

test("the module's source names no Slack history or posting method", () => {
  const dir = join(import.meta.dirname, "..");
  const files = [...readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx")).map((f) => join(dir, f)), ...readdirSync(join(dir, "core")).map((f) => join(dir, "core", f))];
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), /conversations\.(history|replies)|chat\.(postMessage|update)|search\.messages/, f);
});

const READ: ReviewRead = {
  title: "Add retry to the sync job",
  state: "CHANGES_REQUESTED",
  submittedAt: 1,
  commit: "4f2a9c1",
  author: "reviewer",
  findings: [{ path: "export/retry.ts", line: 88, first: "Cap the retry loop.", url: `${PR1}#discussion_r1` }],
};

test("a review's findings are its inline comments: path:line, the first sentence and the link, read once per review", async () => {
  assert.equal(firstSentence("**Cap the retry loop**: it spins forever. Stop after 5.\n```ts\nwhile(1){}\n```"), "Cap the retry loop: it spins forever.");
  assert.equal(firstSentence("> quoted\nLog the count, not the batch"), "Log the count, not the batch");
  assert.equal(firstSentence("Pass `f`, not `resolve_qpath` (see #12), like:\n```\nlet x = 1;\n```\nSo no vec."), "Pass f, not resolve_qpath (see #12), like:", "identifiers and refs kept whole, and the sentence stops at the code");
  const c = (review: number, path: string, body: string, n: number) => ({ pull_request_review_id: review, path, line: null, original_line: n, position: 1, body, html_url: `https://github.com/x/y/pull/1#discussion_r${n}` });
  const pages = [[c(9001, "a.ts", "Rename it. Then test.", 3), c(8000, "b.ts", "Another review's.", 4)], [c(9001, "c.md", "```suggestion\nx\n```", 5)]];
  const parsed = parseReview({ title: "T" }, { id: 9001, state: "COMMENTED", submitted_at: "2026-11-19T13:25:00Z", commit_id: "abc", user: { login: "r" } }, pages);
  assert.deepEqual(
    parsed.findings.map((f) => [f.path, f.line, f.first]),
    [["a.ts", 3, "Rename it."], ["c.md", 5, "Suggested change"]],
    "only this review's comments, across pages; an outdated comment keeps its original line; a bare suggestion still says something",
  );
  assert.deepEqual(reviewArgs(REVIEW1).comments, ["api", "--paginate", "--slurp", "repos/acme-co/widgets/pulls/41/comments?per_page=100"], "the PR's comments: the review's own endpoint has no line numbers");

  const h = await host({ reviews: { [REVIEW1]: READ } });
  const b = (await h.post(MULTIPLAYER_WRITES.add, { channel: CH })).result as string;
  await h.tool("orch_review_record", { board: b, prs: [{ url: PR1 }], reviews: [REVIEW1] });
  assert.equal((await h.view()).records[0]!.prs[0]!.review?.findings, null, "the first read doesn't wait on GitHub");
  await h.settle();
  const pr = (await h.view()).records[0]!.prs[0]!;
  assert.deepEqual([pr.title, pr.review?.verdict, pr.review?.findings?.length, pr.review?.findings?.[0]?.first], ["Add retry to the sync job", "Changes requested", 1, "Cap the retry loop."]);
  await h.view();
  await h.settle();
  assert.equal(h.ghCalls.length, 1, "a review is read from GitHub once");
  const cached = JSON.parse(readFileSync(join(h.root, "multiplayer", "reviews", "9001.json"), "utf8"));
  assert.equal(cached.findings[0].first, "Cap the retry loop.", "cached by review id in the plugin's data dir");

  const seeded = await host();
  mkdirSync(join(seeded.root, "multiplayer", "reviews"), { recursive: true });
  writeFileSync(join(seeded.root, "multiplayer", "reviews", "9001.json"), JSON.stringify(READ));
  const sb = (await seeded.post(MULTIPLAYER_WRITES.add, { channel: CH })).result as string;
  await seeded.tool("orch_review_record", { board: sb, prs: [{ url: PR1 }], reviews: [REVIEW1] });
  assert.equal((await seeded.view()).records[0]!.prs[0]!.review?.verdict, "Changes requested");
  assert.deepEqual(seeded.ghCalls, [], "a cached review is never read again");
  h.raw.close();
  seeded.raw.close();
});

test("the tab is Multiplayer, right after Open PRs, shown once a board exists, and hiddenTabs hides it like any other", async () => {
  const app = readFileSync(join(import.meta.dirname, "..", "..", "app.tsx"), "utf8");
  assert.match(app, /\{ id: "open-prs", subPath: "open-prs", label: "Open PRs" \},\n(?:\s+\/\/[^\n]*\n)?\s+\{ id: "multiplayer", subPath: "multiplayer", label: "Multiplayer" \},/);
  const { shownTabs, shownUntilUsed } = await import("../../app/hidden-tabs.ts");
  const views = [{ id: "open-prs", label: "Open PRs" }, { id: "multiplayer", label: "Multiplayer" }, { id: "board", label: "Activity" }];
  const boards = (n: number) => new Set(shownUntilUsed({ boards: n, queueSetUp: false, gameboy: false, cloud: false }));
  assert.deepEqual(shownTabs(views, new Set(), 0, new Set(), boards(0)).map((v) => v.id), ["open-prs", "board"], "no board yet: hidden");
  assert.deepEqual(shownTabs(views, new Set(), 0, new Set(), boards(1)).map((v) => v.id), ["open-prs", "multiplayer", "board"], "a board: shown");
  assert.deepEqual(shownTabs(views, new Set(["multiplayer"]), 0, new Set(), boards(1)).map((v) => v.id), ["open-prs", "board"]);
});

test("a review the owner decided leaves Working now, whatever state the lead last set", () => {
  const base = { id: "rr-1", board: "mb-1", lead: "lead:otter", note: null, asker: null, permalink: null, askedAt: 1, times: {}, thread: null, prs: [], reply: null, createdAt: 1 };
  const waits = { ...base, state: "waits" as const, deliverable: { id: "v-1", state: "approved", rev: 1, flag: "x", card: null }, waitsOnYou: false };
  assert.equal(settled(waits), true);
  assert.equal(open(waits), false, "approved: nothing left for anyone");
  assert.equal(open({ ...waits, deliverable: { ...waits.deliverable, state: "review" }, waitsOnYou: true }), true, "in review: it waits on the owner");
  assert.equal(open({ ...base, state: "reviewing", deliverable: null, waitsOnYou: false }), true, "still being reviewed");
});
