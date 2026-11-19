import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Engine } from "../core/engine.ts";
import { attachPathwaysPreflight, fogBullets, linkPathwaysDecisions, mapPathwaysLimited, pathwaysMap, projectIssues, selectPathwaysMap, summarizePathwaysRetro, type PathwaysIssue } from "../core/pathways.ts";
import { createPathwaysSnapshots, type PathwaysSnapshot } from "../core/pathways-snapshot.ts";
import { pathwaysViewSchema, type Pathways } from "../contract.ts";
import plugin from "../server.ts";

test("Pathways detail reads cap concurrency and preserve order; the last map is served while a refresh runs", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapPathwaysLimited(Array.from({ length: 17 }, (_, index) => index), 8, async (index) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return index * 2;
  });
  assert.equal(peak, 8);
  assert.deepEqual(result, Array.from({ length: 17 }, (_, index) => index * 2));

  const fresh = (title: string) => ({ error: null, map: { identifier: "ENG-123", title, url: "", tickets: [], external: [], edges: [], fog: [], frontier: [], claimed: [], blocked: [], firstPath: [], ownerActions: [] }, retro: null }) as unknown as Pathways;
  const failed = (error: string) => ({ error, map: null, retro: null }) as unknown as Pathways;
  const disk = new Map<string, PathwaysSnapshot>();
  let clock = 1_000;
  let loads = 0;
  let answer: () => Promise<Pathways> = async () => fresh("fresh-1");
  const load = async () => { loads++; return answer(); };
  const snapshots = createPathwaysSnapshots({
    now: () => clock,
    maxAgeMs: 60_000,
    read: (slug) => disk.get(slug) ?? null,
    write: (slug, snapshot) => disk.set(slug, snapshot),
  });
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const first = await snapshots.view("demo", false, load);
  assert.equal(first.map?.title, "fresh-1");
  assert.equal(first.refreshing, false);
  assert.equal(first.fetchedAt, 1_000);
  await snapshots.view("demo", false, load);
  assert.equal(loads, 1, "inside the 60 s cache nothing is re-read");

  clock += 61_000;
  answer = () => new Promise((resolve) => setTimeout(() => resolve(fresh("fresh-2")), 5));
  const served = await snapshots.view("demo", false, load);
  assert.equal(served.map?.title, "fresh-1", "an expired snapshot is served at once");
  assert.equal(served.fetchedAt, 1_000);
  assert.equal(served.refreshing, true);
  await snapshots.view("demo", false, load);
  assert.equal(loads, 2, "concurrent loads share one background refresh");
  await wait(20);
  assert.equal(snapshots.peek("demo")?.value.map?.title, "fresh-2");
  assert.deepEqual(disk.get("demo")?.value, fresh("fresh-2"), "the saved snapshot equals the fresh map it came from");

  clock += 61_000;
  answer = async () => failed("Pathways Linear request failed: HTTP 500. Check the connection and try Refresh.");
  const kept = await snapshots.view("demo", true, load);
  assert.equal(kept.map?.title, "fresh-2", "a failed refresh keeps the last map");
  assert.match(kept.error ?? "", /HTTP 500/);
  assert.equal(kept.refreshing, false);
  const loadsAfterFailure = loads;
  const polled = await snapshots.view("demo", false, load);
  assert.equal(loads, loadsAfterFailure, "a failed refresh is not retried by polling until the cache age passes");
  assert.equal(polled.refreshing, false);
  assert.match(polled.error ?? "", /HTTP 500/);

  const root = mkdtempSync(join(tmpdir(), "orch-pathways-local-"));
  try {
    mkdirSync(join(root, "projects", "alpha"), { recursive: true });
    mkdirSync(join(root, "projects", "empty"), { recursive: true });
    writeFileSync(join(root, "projects", "alpha", "project.json"), JSON.stringify({ slug: "alpha" }));
    const db = Object.assign(new DatabaseSync(join(root, "data.db")), { name: join(root, "data.db") });
    const engine = new Engine(db as never, { now: () => 10_000, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
    const cos = engine.register("T-cos", "cos", null);
    const leadAlpha = engine.register("T-lead-alpha", "lead", "alpha");
    engine.register("T-lead-empty", "lead", "empty");
    const thr1 = engine.register("T-thr-1", "thread", "alpha", leadAlpha.threadId);
    engine.setStatus(thr1.threadId, "active");
    engine.setEnvironment(thr1.threadId, "env-thr-1");
    const thr2 = engine.register("T-thr-2", "thread", "alpha", leadAlpha.threadId);
    engine.setStatus(thr2.threadId, "archived");
    engine.setEnvironment(leadAlpha.threadId, "env-lead-alpha");
    engine.publishStatus(leadAlpha, {
      goal: "Ship alpha",
      steps: [
        { title: "Design API", state: "done" },
        { title: "Skip old spike", state: "skipped" },
        { title: "Build worker", state: "current" },
        { title: "Run QA", state: "next" },
        { title: "Release", state: "next" },
      ],
      blockers: ["Waiting on staging key"],
    });
    const openCard = engine.ask(leadAlpha, { title: "Approve staging deploy", question: "May we deploy to staging?", options: [{ label: "Yes" }, { label: "No" }] });
    engine.triageAskPerson(cos, openCard.id, { title: "Approve staging deploy", question: "May we deploy to staging?", options: [{ label: "Yes" }, { label: "No" }], allowText: true });
    const answeredCard = engine.ask(leadAlpha, { title: "Pick storage", question: "SQLite or Postgres?", options: [{ label: "SQLite" }, { label: "Postgres" }] });
    engine.triageAskPerson(cos, answeredCard.id, { title: "Pick storage", question: "SQLite or Postgres?", options: [{ label: "SQLite" }, { label: "Postgres" }], allowText: true });
    const askedAnswered = engine.decision(answeredCard.id)!;
    engine.personAnswer(answeredCard.id, askedAnswered.rev, askedAnswered.ask!.options[0]!.id, null, "desktop");
    engine.prSeen(thr1, "env-thr-1", { outcome: "available", pullRequest: { number: 42, url: "https://github.com/acme/alpha/pull/42", state: "open", review: { state: "review_required" }, checks: { state: "passing" }, mergeability: { state: "ready_to_merge" } } });
    engine.prSeen(leadAlpha, "env-lead-alpha", { outcome: "available", pullRequest: { number: 43, url: "https://github.com/acme/alpha/pull/43", state: "open", review: { state: "approved" }, checks: { state: "passing" }, mergeability: { state: "ready_to_merge" } } });

    const boot = async (linearApiKey: string) => {
      const rpc: Record<string, (input: unknown) => Promise<unknown>> = {};
      const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : noop), apply: () => noop });
      const sdk = (path: string[]): any =>
        new Proxy(function () {}, {
          get: (_t, k) => (k === "then" ? undefined : sdk([...path, String(k)])),
          apply: (_t, _this, args: any[]) => {
            if (path.join(".") === "threads.get") {
              if (args[0]?.threadId === "T-thr-1") return Promise.resolve({ title: "Worker implementation", status: "active" });
              return Promise.resolve({ title: null, status: "idle" });
            }
            return Promise.resolve({});
          },
        });
      const bb: any = new Proxy(
        {},
        {
          get(_t, k) {
            if (k === "pluginId") return "orchestrator";
            if (k === "settings")
              return {
                define: (schema: Record<string, { default: unknown }>) => {
                  const v: any = Object.fromEntries(Object.entries(schema).map(([key, d]) => [key, d.default]));
                  Object.assign(v, { stateDir: join(root, "state"), projectsDir: join(root, "projects"), memoryConfig: "", diskPath: root, linearApiKey });
                  return { get: async () => v, onChange: () => {} };
                },
              };
            if (k === "storage") return { database: () => db, kv: noop };
            if (k === "sdk") return sdk([]);
            if (k === "rpc") return { register: (_c: unknown, h: typeof rpc) => Object.assign(rpc, h) };
            if (k === "log") return { info: () => {}, warn: () => {}, error: () => {} };
            return noop;
          },
        },
      );
      await plugin(bb);
      return rpc.pathways as (input: { slug: string; refresh?: boolean }) => Promise<ReturnType<typeof pathwaysViewSchema.parse>>;
    };

    const callNoKey = await boot("");
    const local = pathwaysViewSchema.parse(await callNoKey({ slug: "alpha" }));
    assert.equal(local.error, null);
    assert.ok(local.map);
    assert.equal(local.map.source, "orchestrator");
    assert.ok(local.fetchedAt != null);
    assert.equal(local.refreshing, false);
    const byId = new Map(local.map.tickets.map((t) => [t.identifier, t]));
    assert.equal(byId.get("STEP-1")?.displayState, "done");
    assert.equal(byId.has("STEP-2"), false);
    assert.equal(byId.get("STEP-3")?.displayState, "claimed");
    assert.equal(byId.get("STEP-3")?.waitsOnYou, true);
    assert.equal(byId.get("STEP-4")?.displayState, "ready");
    assert.equal(byId.get("STEP-5")?.displayState, "blocked");
    assert.equal(byId.has("THR-1"), true);
    assert.match(byId.get("THR-1")!.title, /Worker implementation/);
    assert.match(byId.get("THR-1")!.title, /active/);
    assert.equal(byId.has("THR-2"), false);
    assert.deepEqual(byId.get("THR-1")?.prLink.urls, ["https://github.com/acme/alpha/pull/42"]);
    assert.deepEqual(byId.get("STEP-3")?.prLink.urls, ["https://github.com/acme/alpha/pull/43"]);
    const cardTicket = byId.get(`CARD-${openCard.id.slice(-6)}`);
    assert.ok(cardTicket);
    assert.equal(cardTicket.displayState, "needs-you");
    assert.equal(cardTicket.decision.cardId, openCard.id);
    assert.deepEqual(cardTicket.decision.direct, ["STEP-3"]);
    assert.deepEqual(cardTicket.decision.transitive, ["STEP-4", "STEP-5"]);
    assert.ok(local.map.edges.some((e) => e.from === "STEP-1" && e.to === "STEP-3" && e.type === "blocks"));
    assert.ok(local.map.edges.some((e) => e.from === "STEP-3" && e.to === "STEP-4" && e.type === "blocks"));
    assert.ok(local.map.edges.some((e) => e.from === "STEP-4" && e.to === "STEP-5" && e.type === "blocks"));
    assert.ok(local.map.edges.some((e) => e.from === cardTicket.identifier && e.to === "STEP-3" && e.type === "blocks"));
    assert.ok(local.map.edges.some((e) => e.from === "STEP-3" && e.to === "THR-1" && e.type === "related"));
    assert.deepEqual(local.map.firstPath, ["STEP-3", "STEP-4", "STEP-5"]);
    assert.equal(local.map.ownerActions.length, 1);
    assert.equal(local.map.ownerActions[0]?.identifier, cardTicket.identifier);
    assert.equal(local.map.ownerActions[0]?.next, "STEP-3");
    assert.equal(local.map.ownerActions[0]?.neededBefore, 1);
    assert.deepEqual(local.map.fog, ["Waiting on staging key"]);
    assert.ok(local.map.tickets.every((t) => t.decisionDraft === null));
    assert.equal(local.retro, null);

    const emptyView = pathwaysViewSchema.parse(await callNoKey({ slug: "empty" }));
    assert.equal(emptyView.error, null);
    assert.ok(emptyView.map);
    assert.equal(emptyView.map.source, "orchestrator");
    assert.deepEqual(emptyView.map.tickets, []);
    assert.deepEqual(emptyView.map.edges, []);
    assert.deepEqual(emptyView.map.firstPath, []);
    assert.equal(emptyView.retro, null);

    const callWithKeyNoLink = await boot("lin_api_test");
    const noLink = pathwaysViewSchema.parse(await callWithKeyNoLink({ slug: "alpha", refresh: true }));
    assert.equal(noLink.error, null);
    assert.equal(noLink.map?.source, "orchestrator");
    assert.deepEqual(noLink.map?.firstPath, ["STEP-3", "STEP-4", "STEP-5"]);

    writeFileSync(join(root, "projects", "empty", "project.json"), "{bad-json");
    const badRecord = pathwaysViewSchema.parse(await callWithKeyNoLink({ slug: "empty", refresh: true }));
    assert.equal(badRecord.map, null);
    assert.match(badRecord.error ?? "", /Linear project link/);

    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a withdrawn Pathways card does not satisfy a later submit with the same key", () => {
  const engine = new Engine(new DatabaseSync(":memory:") as never, { now: () => 1000, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  const cos = engine.register("T-cos", "cos", null);
  const lead = engine.register("T-lead", "lead", "seed");
  const input = { title: "Choose?", question: "Which choice?", options: [{ label: "One" }, { label: "Two" }], key: "pathways:T-1:which-choice" };
  const first = engine.ask(lead, input);
  assert.equal(engine.decisionByRequestKey(lead.address, input.key)?.id, first.id);
  engine.triageBounce(cos, first.id, "Try again");
  assert.equal(engine.decisionByRequestKey(lead.address, input.key), null);
  const second = engine.ask(lead, input);
  assert.notEqual(second.id, first.id);
});

test("retro cites finished tickets, answered decisions, and the longest recorded wait", () => {
  const map = pathwaysMap(issue("MAP-1", { parent: null }), [issue("T-1", { state: { type: "completed", name: "Done" } }), issue("T-2")]);
  map.tickets[1]!.waitLane = { head: null, reviewFreshness: "unknown", steps: [{ kind: "human review", state: "pending", since: 1000, owner: null, note: "waiting" }] };
  const retro = summarizePathwaysRetro(map, [{ id: "d-1", title: "Choose a route", state: "answered" }], 5000);
  assert.equal(retro.finished[0]?.label, "T-1");
  assert.deepEqual(retro.mergedPrs, []);
  assert.equal(retro.decisions[0]?.title, "Choose a route");
  assert.equal(retro.stalled[0]?.label, "T-2");
  assert.equal(retro.stalled[0]?.durationMs, 4000);
  map.tickets[1]!.pr = { url: "https://github.com/acme/app/pull/101", state: "merged", number: 101, title: null, draft: false, head: null, createdAt: null, headCommittedAt: null, checksPendingSince: null, reviews: [], staleReviewDismissal: null, requiredApprovals: null, review: "", checks: "", mergeability: "", reason: "Merged", retrievedAt: 0 };
  map.tickets[0]!.prs = [{ pr: map.tickets[1]!.pr!, proof: { state: "unrecorded", verifiedSha: null, liveInterface: null, qaPacketUrl: null, missing: [], sourceUrl: null, sourceLabel: null, observedAt: null }, waitLane: { head: null, reviewFreshness: "unknown", steps: [] } }];
  assert.deepEqual(summarizePathwaysRetro(map, [], 5000).mergedPrs, [{ ticket: "T-1", url: "https://github.com/acme/app/pull/101" }]);
  assert.deepEqual(summarizePathwaysRetro(map, [], 5000).finished.map((item) => item.label), ["T-1"]);
});

const issue = (identifier: string, change: Partial<PathwaysIssue> = {}): PathwaysIssue => ({ identifier, title: identifier, url: `https://linear.app/test/issue/${identifier}`, description: "## Question\nChoose.\n## Acceptance criteria\nDecided.", state: { type: "started", name: "In Progress" }, priority: 3, estimate: 2, assignee: null, labels: { nodes: [{ name: "wayfinder:task" }] }, parent: { identifier: "MAP-1" }, relations: { nodes: [] }, inverseRelations: { nodes: [] }, ...change });
const blockedBy = (identifier: string, type = "started") => ({ type: "blocks", issue: { identifier, state: { type } } });

test("frontier readiness keeps research and missing proof plans distinct", () => {
  const map = issue("MAP-1", { parent: null });
  const result = pathwaysMap(map, [
    issue("T-1", { estimate: null }),
    issue("R-1", { labels: { nodes: [{ name: "wayfinder:research" }] }, estimate: null }),
    issue("T-2", { description: "## Acceptance criteria\nDone." }),
    issue("T-3", { description: "## Acceptance criteria\nDone.\n## Verification\nExercise the real UI." }),
  ]);
  const readiness = (id: string) => result.tickets.find((ticket) => ticket.identifier === id)?.readiness;
  assert.deepEqual(readiness("T-1"), { state: "needs decision", reasons: ["Estimate not recorded", "Verification plan not recorded"], source: "https://linear.app/test/issue/T-1" });
  assert.deepEqual(readiness("R-1"), { state: "needs decision", reasons: ["Question: Choose.", "Decision not recorded", "Verification plan not recorded"], source: "https://linear.app/test/issue/R-1" });
  assert.deepEqual(readiness("T-2"), { state: "needs proof plan", reasons: ["Verification plan not recorded"], source: "https://linear.app/test/issue/T-2" });
  assert.deepEqual(readiness("T-3"), { state: "ready", reasons: [], source: "https://linear.app/test/issue/T-3" });
});

test("owner actions name explicit work and reach two dependent steps", () => {
  const map = issue("MAP-1", { parent: null });
  const result = pathwaysMap(map, [
    issue("Y-1", { title: "Sign in to staging", labels: { nodes: [{ name: "wayfinder:needs-you" }, { name: "wayfinder:task" }] }, relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "Y-2", state: { type: "started" } } }] } }),
    issue("Y-2", { inverseRelations: { nodes: [blockedBy("Y-1")] }, relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "Y-3", state: { type: "started" } } }] } }),
    issue("Y-3", { inverseRelations: { nodes: [blockedBy("Y-2")] } }),
    issue("Y-4", { title: "Bring the answer", labels: { nodes: [{ name: "wayfinder:needs-you" }] } }),
  ]);
  assert.deepEqual(result.ownerActions.find((action) => action.identifier === "Y-1"), { identifier: "Y-1", url: "https://linear.app/test/issue/Y-1", action: "Sign in to staging", kind: "sign-in", affected: ["Y-2", "Y-3"], next: "Y-2", neededBefore: 2, onlyOpenBlocker: true });
  assert.equal(result.ownerActions.find((action) => action.identifier === "Y-4")?.kind, "other");
});

test("ticket PR linkage comes only from explicit attachment or description URLs", () => {
  const map = issue("MAP-1", { parent: null });
  const url = "https://github.com/acme/app/pull/101";
  const result = pathwaysMap(map, [issue("T-1", { title: "PR 101", attachments: { nodes: [{ id: "attachment-1", url }] } }), issue("T-2", { title: "PR 101" })]);
  assert.deepEqual(result.tickets.find((ticket) => ticket.identifier === "T-1")?.prLink, { state: "linked", urls: [url], source: "attachment" });
  assert.deepEqual(result.tickets.find((ticket) => ticket.identifier === "T-2")?.prLink, { state: "missing", urls: [], source: null });
});

test("an explicit card link previews direct and transitive impact, then stops waiting when answered", () => {
  const cardId = "d-test-card-1";
  const children = [
    issue("T-1", { description: `Decision card: ${cardId}`, relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "T-2", state: { type: "started" } } }] } }),
    issue("T-2", { inverseRelations: { nodes: [blockedBy("T-1")] }, relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "T-3", state: { type: "started" } } }] } }),
    issue("T-3", { inverseRelations: { nodes: [blockedBy("T-2")] } }),
    issue("T-4", { title: cardId }),
  ];
  const map = pathwaysMap(issue("MAP-1", { parent: null }), children);
  const cards = [{ id: cardId, state: "asked", title: "Choose the pilot", context: "", project: "seed" }];
  linkPathwaysDecisions(map, children, cards);
  assert.deepEqual(map.tickets[0]?.decision, { state: "linked", cardId, cardState: "asked", title: "Choose the pilot", waiting: true, direct: ["T-2"], transitive: ["T-3"] });
  assert(!map.tickets[0]?.readiness.reasons.includes("Decision not recorded"));
  assert.equal(map.tickets[3]?.decision.state, "missing");
  linkPathwaysDecisions(map, children, []);
  assert.equal(map.tickets[0]?.decision.state, "missing");
  assert.deepEqual(map.tickets[0]?.decision.direct, ["T-2"]);
  assert.deepEqual(map.tickets[0]?.decision.transitive, ["T-3"]);
  linkPathwaysDecisions(map, children, [{ ...cards[0]!, state: "answered" }]);
  assert.equal(map.tickets[0]?.decision.waiting, false);
  assert.equal(map.tickets[0]?.state.type, "started");
  linkPathwaysDecisions(map, children, [{ ...cards[0]!, context: children[1]!.url }]);
  assert.equal(map.tickets[1]?.decision.cardId, cardId);
  linkPathwaysDecisions(map, children, [{ ...cards[0]!, context: children[1]!.url }, { ...cards[0]!, id: "d-test-card-2", context: children[1]!.url }]);
  assert.equal(map.tickets[1]?.decision.state, "ambiguous");
});

test("Dev AWS proof without an explicit access ticket fails preflight closed", () => {
  const root = issue("MAP-1", { parent: null });
  const task = issue("T-1", { description: "## Verification\nEnvironment: Dev AWS\nVerifier: dashboard UI\nOwner action: the owner signs in" });
  const map = pathwaysMap(root, [task]);
  attachPathwaysPreflight(map, [task]);
  assert.deepEqual(map.tickets[0]?.preflight, { state: "needs access", environment: "Dev AWS", verifier: "dashboard UI", ownerAction: "the owner signs in", accessTicket: null, gaps: ["Access ticket not recorded"], source: task.url });
  const access = issue("T-2", { title: "Dev AWS access" });
  const linked = issue("T-1", { description: "## Verification\nEnvironment: Dev AWS\nVerifier: dashboard UI\nOwner action: the owner signs in\nAccess ticket: T-2" });
  const second = pathwaysMap(root, [linked, access]);
  attachPathwaysPreflight(second, [linked, access]);
  assert.equal(second.tickets[0]?.preflight.state, "declared");
  assert.equal(second.tickets[0]?.preflight.accessTicket, "T-2");
  second.tickets[0]!.proof = { state: "blocked", verifiedSha: null, liveInterface: null, qaPacketUrl: null, missing: ["Live verification blocked"], sourceUrl: null, sourceLabel: "Fixture blocked proof", observedAt: 1000 };
  attachPathwaysPreflight(second, [linked, access]);
  assert.equal(second.tickets[0]?.preflight.state, "blocked");
  assert(second.tickets[0]?.preflight.gaps.includes("Proof record blocked"));
});

test("frontier, claims, blockers, unknowns, fog, priority, and pagination", async () => {
  const map = issue("MAP-1", { description: "## Destination\nDone\n## Not yet specified\n- Hidden question\n* Another area\n## Out of scope\n- Excluded", parent: null });
  const children = [
    issue("T-1", { priority: 2, estimate: 3, relations: { nodes: [{ type: "related", relatedIssue: { identifier: "T-2", state: { type: "started" } } }] } }),
    issue("T-2", { priority: 2, estimate: 1 }),
    issue("T-3", { inverseRelations: { nodes: [blockedBy("T-1")] } }),
    issue("T-4", { inverseRelations: { nodes: [blockedBy("T-1", "completed")] } }),
    issue("T-5", { inverseRelations: { nodes: [{ type: "blocks", issue: { identifier: "OUT-1", title: "Outside approval", url: "https://linear.app/test/issue/OUT-1", state: { type: "started" } } }] } }),
    issue("T-6", { assignee: { name: "Owner" } }),
    issue("T-7", { estimate: null }),
    issue("T-8", { description: "" }),
    issue("T-9", { description: "## Question\nWhat?" }),
    issue("T-10", { labels: { nodes: [{ name: "wayfinder:research" }] } }),
    issue("T-11", { labels: { nodes: [{ name: "spike" }] } }),
    issue("T-12", { labels: { nodes: [{ name: "question" }] } }),
    issue("T-13", { labels: { nodes: [{ name: "open-question" }] } }),
    issue("T-14", { priority: 1, labels: { nodes: [{ name: "wayfinder:research" }] }, estimate: null, description: "", relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "T-19", state: { type: "started" } } }, { type: "blocks", relatedIssue: { identifier: "T-18", state: { type: "started" } } }] } }),
    issue("T-15", { labels: { nodes: [{ name: "wayfinder:task" }, { name: "wayfinder:needs-you" }] }, relations: { nodes: [{ type: "blocks", relatedIssue: { identifier: "T-16", state: { type: "started" } } }] } }),
    issue("T-16", { inverseRelations: { nodes: [blockedBy("T-15")] } }),
    issue("T-17", { state: { type: "completed", name: "Done" } }),
    issue("T-18", { inverseRelations: { nodes: [blockedBy("T-14")] } }),
    issue("T-19", { inverseRelations: { nodes: [blockedBy("T-14")] } }),
    issue("T-20", { labels: { nodes: [{ name: "wayfinder:prototype" }] }, estimate: null, description: "" }),
    issue("T-21", { labels: { nodes: [] }, description: "Work described without a proof plan" }),
  ];
  const result = pathwaysMap(map, children);
  assert.deepEqual(result.fog, ["Hidden question", "Another area"]);
  assert.deepEqual(fogBullets("## Not yet specified\n- First\n## Out of scope\n- Never"), ["First"]);
  assert.deepEqual(result.frontier.slice(0, 2), ["T-14", "T-2"]);
  assert(result.frontier.includes("T-4"));
  assert(!result.frontier.includes("T-3"));
  assert.deepEqual(result.claimed, ["T-6"]);
  assert.deepEqual(result.blocked, ["T-16", "T-18", "T-19", "T-3", "T-5"]);
  assert.deepEqual(result.tickets.find((ticket) => ticket.identifier === "T-3")?.blockers, ["T-1"]);
  assert.deepEqual(result.tickets.find((ticket) => ticket.identifier === "T-4")?.blockers, []);
  for (const id of ["T-5", "T-7", "T-8", "T-9", "T-10", "T-11", "T-12", "T-13"]) assert(result.tickets.find((ticket) => ticket.identifier === id)?.unknown.length);
  assert(result.edges.some((edge) => edge.from === "T-1" && edge.to === "T-3" && edge.type === "blocks"));
  assert(result.edges.some((edge) => edge.type === "related" && [edge.from, edge.to].includes("T-1") && [edge.from, edge.to].includes("T-2")));
  assert(result.edges.some((edge) => edge.from === "MAP-1" && edge.to === "T-1" && edge.type === "sub-issue"));
  assert.equal(result.tickets.find((ticket) => ticket.identifier === "T-14")?.unknown.join(","), "Research question");
  assert.deepEqual(result.tickets.find((ticket) => ticket.identifier === "T-20")?.unknown, []);
  assert.equal(result.tickets.find((ticket) => ticket.identifier === "T-15")?.displayState, "needs-you");
  assert.equal(result.tickets.find((ticket) => ticket.identifier === "T-16")?.waitsOnYou, true);
  assert.equal(result.tickets.find((ticket) => ticket.identifier === "T-17")?.displayState, "done");
  assert.equal(result.tickets.find((ticket) => ticket.identifier === "T-6")?.displayState, "claimed");
  assert.equal(result.tickets.find((ticket) => ticket.identifier === "T-3")?.displayState, "blocked");
  assert.equal(result.tickets.find((ticket) => ticket.identifier === "T-7")?.displayState, "unknown");
  assert.equal(result.tickets.find((ticket) => ticket.identifier === "T-2")?.displayState, "ready");
  assert.equal(result.tickets.find((ticket) => ticket.identifier === "T-21")?.readiness.state, "needs proof plan");
  assert.deepEqual(result.firstPath, ["T-14", "T-18"]);
  assert.deepEqual(result.external.map((item) => [item.identifier, item.title, item.url]), [["OUT-1", "Outside approval", "https://linear.app/test/issue/OUT-1"]]);
  assert(result.edges.some((edge) => edge.from === "OUT-1" && edge.to === "T-5" && edge.type === "blocks"));
  const calls: (string | null)[] = [];
  const nodes = await projectIssues(async (cursor) => {
    calls.push(cursor);
    return { project: { issues: { nodes: [{ identifier: cursor ?? "FIRST" }], pageInfo: { hasNextPage: cursor === null, endCursor: cursor === null ? "NEXT" : null } } } };
  });
  assert.deepEqual(calls, [null, "NEXT"]);
  assert.deepEqual(nodes?.map((node) => node.identifier), ["FIRST", "NEXT"]);
  const mapCandidates = [{ identifier: "MAP-1", labels: { nodes: [{ name: "map" }] } }, { identifier: "MAP-2", labels: { nodes: [{ name: "wayfinder:map" }] } }];
  assert.equal(selectPathwaysMap(mapCandidates, "MAP-1")?.identifier, "MAP-1");
  assert.equal(selectPathwaysMap(mapCandidates)?.identifier, "MAP-2");
  assert.equal(selectPathwaysMap(mapCandidates, "MISSING"), undefined);
});

test("an explicit linked PR block links the same card in decision preview and timeline", () => {
  const prUrl = "https://github.com/acme/app/pull/101";
  const children = [issue("T-1", { attachments: { nodes: [{ id: "a-1", url: prUrl }] } })];
  const map = pathwaysMap(issue("MAP-1", { parent: null }), children);
  linkPathwaysDecisions(map, children, [{ id: "d-pr", state: "asked", title: "PR decision", context: "T-1", project: "seed", prUrls: [prUrl] }]);
  assert.equal(map.tickets[0]?.decision.cardId, "d-pr");
});

test("decision preview is read-only and submit is idempotent for the ticket question", async () => {
  const { draftPathwaysDecision, submitPathwaysDecision } = await import("../core/pathways.ts");
  const child = issue("T-1", { labels: { nodes: [{ name: "wayfinder:research" }] }, description: "## Question\nWhich source?" });
  const map = pathwaysMap(issue("MAP-1", { parent: null }), [child]);
  const ticket = map.tickets[0]!;
  let created = 0;
  const draft = draftPathwaysDecision(ticket);
  assert.equal(created, 0);
  assert.equal(draft.ticketId, "T-1");
  assert.equal(draft.question, "Which source?");
  assert.equal(draft.title, "Which source?");
  const longQuestion = "Which source systems can supply status, ownership, and update times for the first view?";
  const longDraft = draftPathwaysDecision({ ...ticket, readiness: { ...ticket.readiness, reasons: [`Question: ${longQuestion}`] } });
  assert(longDraft.title.length <= 60);
  assert(longDraft.title.startsWith("Which source systems"));
  assert(longDraft.title.endsWith("…"));
  assert.equal(draftPathwaysDecision({ ...ticket, readiness: { ...ticket.readiness, reasons: [] } }).title, "Decision for T-1?");
  const ids = new Map<string, string>();
  const deps = { existing: (key: string) => ids.get(key) ?? null, create: (key: string) => { created++; ids.set(key, "d-one"); return "d-one"; } };
  assert.equal(submitPathwaysDecision(draft, deps), "d-one");
  assert.equal(submitPathwaysDecision(draft, deps), "d-one");
  assert.equal(created, 1);
  assert(draft.context.includes(child.url));
});

test("linked decision replaces the missing-decision reason", () => {
  const child = issue("R-1", { labels: { nodes: [{ name: "wayfinder:research" }] }, description: "## Question\nWhich source?" });
  const map = pathwaysMap(issue("MAP-1", { parent: null }), [child]);
  assert(map.tickets[0]?.readiness.reasons.includes("Decision not recorded"));
  linkPathwaysDecisions(map, [child], [{ id: "d-linked", state: "asked", title: "Choose", context: child.url, project: "seed" }]);
  assert(!map.tickets[0]?.readiness.reasons.includes("Decision not recorded"));
  assert(map.tickets[0]?.readiness.reasons.includes("Decision awaiting answer (d-linked)"));
  linkPathwaysDecisions(map, [child], []);
  assert(map.tickets[0]?.readiness.reasons.includes("Decision not recorded"));
  for (const state of ["withdrawn", "merged"]) {
    linkPathwaysDecisions(map, [child], [{ id: "d-dead", state, title: "Choose", context: child.url, project: "seed" }]);
    assert(!map.tickets[0]?.readiness.reasons.some((reason) => reason.startsWith("Decision answered")));
  }
});
