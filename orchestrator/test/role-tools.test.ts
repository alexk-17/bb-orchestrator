import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import plugin from "../server.ts";
import { Engine } from "../core/engine.ts";
import { roleToolsChanges } from "../core/role-tools.ts";
import type { Role } from "../core/model.ts";

const SCRATCH = join(import.meta.dirname, "..", ".scratch-test");
mkdirSync(SCRATCH, { recursive: true });
const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const KV_KEY = "roleTools";
type Configure = (context: unknown) => { tools: (string | { name: string })[] };
type Service = { start(signal: AbortSignal): Promise<void> };
type World = ReturnType<typeof world>;

function world(batchInbox = true) {
  const root = mkdtempSync(join(SCRATCH, "role-tools-"));
  roots.push(root);
  const db = Object.assign(new DatabaseSync(join(root, "data.db")), { name: join(root, "data.db") });
  const sent: string[] = [];
  const e = new Engine(db as never, { now: Date.now, deliver: async (threadId) => (sent.push(threadId), { delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  e.register("T-cos", "cos", null);
  e.register("T-st", "steward", null);
  e.register("T-la", "lead", "alpha");
  for (const t of ["T-w1", "T-w2", "T-w3", "T-w4", "T-w5"]) e.register(t, "thread", "alpha", "T-la");
  for (const t of ["T-cos", "T-st", "T-la", "T-w3"]) e.setStatus(t, "idle");
  e.setStatus("T-w1", "active");
  e.setStatus("T-w2", "stopped");
  e.setStatus("T-w4", "error");
  const address = (threadId: string) => e.agentByThread(threadId)!.address;
  return { root, db, e, sent, batchInbox, kv: new Map<string, unknown>(), address };
}

async function load(w: World) {
  const services = new Map<string, Service>();
  let configure: Configure | null = null;
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : noop), apply: () => noop });
  const sdk = {
    threads: {
      get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", archivedAt: null }),
      send: async ({ threadId }: { threadId: string }) => (w.sent.push(threadId), { delivery: "sent" }),
      queuedMessages: { list: async () => [] },
      list: async () => [],
    },
  };
  const kv = {
    get: async (key: string) => structuredClone(w.kv.get(key)),
    set: async (key: string, v: unknown) => void w.kv.set(key, structuredClone(v)),
    delete: async (key: string) => void w.kv.delete(key),
  };
  const bb: any = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "pluginId") return "orchestrator";
        if (k === "settings")
          return {
            define: (schema: Record<string, { default: unknown }>) => {
              const v: Record<string, unknown> = Object.fromEntries(Object.entries(schema).map(([key, d]) => [key, d.default]));
              Object.assign(v, { batchInbox: w.batchInbox, stateDir: join(w.root, "state"), projectsDir: join(w.root, "projects"), memoryConfig: "", diskPath: w.root, ownerName: "" });
              return { get: async () => v, onChange: () => {} };
            },
          };
        if (k === "storage") return { database: () => w.db, kv };
        if (k === "agents") return new Proxy({ configure: (p: Configure) => void (configure = p) }, { get: (a: any, n) => a[n] ?? noop });
        if (k === "sdk") return new Proxy(sdk, { get: (s: any, n) => s[n] ?? noop });
        if (k === "background") return { service: (name: string, s: Service) => void services.set(name, s) };
        if (k === "log") return { info: () => {}, warn: () => {}, error: () => {} };
        return noop;
      },
    },
  );
  await plugin(bb);
  const toolsOf = (threadId: string) =>
    configure!({
      thread: { id: threadId, title: null, parentThreadId: null, sourceThreadId: null },
      pluginMetadata: {},
      origin: { kind: null, pluginId: null },
      project: { id: "p", kind: "standard", name: "alpha", gitRemoteUrl: null },
      environment: { id: "env", name: null, path: null, branchName: null, workspaceProvisionType: null },
      host: { id: "h", name: "h" },
      provider: { id: "claude-code", model: "m", capabilities: { supportsNativeUserQuestion: false } },
    }).tools.map((t) => (typeof t === "string" ? t : t.name));
  return { services, toolsOf };
}

async function activate(w: World) {
  const h = await load(w);
  const check = h.services.get("role-tools");
  assert.ok(check, "the tool check runs as a service, so an activation bb discards leaves nothing behind");
  await check.start(new AbortController().signal);
  return h;
}

const notices = (w: World) =>
  w.db.prepare(`SELECT id, recipient, body, state FROM items WHERE sender = 'orchestrator' AND kind = 'notice' AND body LIKE '%bb thread stop --self%' ORDER BY recipient`).all() as {
    id: string;
    recipient: string;
    body: string;
    state: string;
  }[];

const unreadNotice = (w: World, threadId: string) => w.e.batch.read(w.e.agentByThread(threadId)!).text.includes("bb thread stop --self");

async function staleBaseline(w: World, drop: Partial<Record<Role, string>>) {
  const now = (await load(w)).toolsOf;
  const lists: Record<Role, string[]> = { cos: now("T-cos"), steward: now("T-st"), lead: now("T-la"), thread: now("T-w1") };
  for (const [role, tool] of Object.entries(drop) as [Role, string][]) assert.ok(lists[role].includes(tool), `${role} has ${tool}`);
  const stale = Object.fromEntries((Object.keys(lists) as Role[]).map((r) => [r, { tools: lists[r].filter((t) => t !== drop[r]), gen: 0 }]));
  w.kv.set(KV_KEY, structuredClone(stale));
  return stale;
}

test("an install that changes a role's tools tells each live agent of that role once, and nobody else", async () => {
  const w = world();
  const stale = await staleBaseline(w, { cos: "orch_board_tidy", thread: "orch_output" });

  const h = await load(w);
  assert.deepEqual(notices(w), [], "activation itself writes nothing: bb may still discard it");
  await h.services.get("role-tools")!.start(new AbortController().signal);

  const told = notices(w);
  assert.deepEqual(
    told.map((n) => n.recipient),
    [w.address("T-cos"), w.address("T-w1"), w.address("T-w3"), w.address("T-w5")].sort(),
    "a thread just given its role, before any status read, is told; stopped and failed ones are not",
  );
  assert.match(told.find((n) => n.recipient === "cos")!.body, /orch_board_tidy/);
  for (const n of told.filter((n) => n.recipient !== "cos")) {
    assert.match(n.body, /orch_output/);
    assert.doesNotMatch(n.body, /orch_board_tidy/, "each agent hears only its own role's change");
  }

  const entries = w.db.prepare(`SELECT DISTINCT severity FROM inbox_entries WHERE item_id IN (${told.map(() => "?").join(",")})`).all(...told.map((n) => n.id)) as { severity: string }[];
  assert.deepEqual(entries.map((r) => r.severity), ["INFO"]);
  await w.e.flush();
  assert.equal((w.db.prepare(`SELECT COUNT(*) AS n FROM inbox_wakes`).get() as { n: number }).n, 0, "the notice waits for the next real wake: it never starts a turn of its own");
  assert.deepEqual(w.sent, []);

  await activate(w);
  assert.equal(notices(w).length, 4, "the next activation sees no change");

  w.kv.set(KV_KEY, structuredClone(stale));
  await activate(w);
  assert.equal(notices(w).length, 4, "a replay after the notices but before the baseline write tells nobody twice");
});

test("a failed notice write keeps the old baseline, so the next activation still tells", async () => {
  const w = world();
  const stale = await staleBaseline(w, { cos: "orch_board_tidy" });
  w.db.exec(`CREATE TEMP TRIGGER no_role_tools BEFORE INSERT ON items WHEN NEW.send_key LIKE 'role-tools:%' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  await activate(w);
  assert.deepEqual(notices(w), []);
  assert.deepEqual(w.kv.get(KV_KEY), stale);

  w.db.exec(`DROP TRIGGER no_role_tools`);
  await activate(w);
  assert.deepEqual(notices(w).map((n) => n.recipient), ["cos"]);
});

test("a role-tools notice stays with the thread it was written for", async () => {
  const w = world();
  await staleBaseline(w, { cos: "orch_board_tidy", lead: "orch_spawn_thread", thread: "orch_output" });
  await activate(w);
  assert.ok(unreadNotice(w, "T-la") && unreadNotice(w, "T-cos") && unreadNotice(w, "T-w1"));

  w.e.setStatus("T-la", "archived");
  w.e.registerStarted("T-la2", "lead", "alpha");
  assert.ok(!unreadNotice(w, "T-la2"), "a new lead started with the new tools");

  w.e.takeOver("T-cos", "T-cos2", "handoff");
  assert.ok(!unreadNotice(w, "T-cos2"), "a handoff successor started with the new tools");

  const id = notices(w).find((n) => n.recipient === w.address("T-w1"))!.id;
  w.e.retire("T-w1");
  assert.equal(notices(w).find((n) => n.id === id)!.state, "closed", "a retired thread's notice is no dead letter for the CoS");
});

test("a retirement that fails partway keeps the role, so its notice never becomes a dead letter", async () => {
  const w = world();
  await staleBaseline(w, { thread: "orch_output" });
  await activate(w);
  const id = notices(w).find((n) => n.recipient === w.address("T-w1"))!.id;
  w.db.exec(`CREATE TEMP TRIGGER no_close BEFORE UPDATE OF state ON items WHEN OLD.send_key LIKE 'role-tools:%' BEGIN SELECT RAISE(ABORT, 'bb exited'); END`);
  assert.throws(() => w.e.retire("T-w1"));
  w.db.exec(`DROP TRIGGER no_close`);
  assert.ok(w.e.agentByThread("T-w1"), "no half-retired role for the clock to dead-letter mail under");
  w.e.retire("T-w1");
  assert.equal(notices(w).find((n) => n.id === id)!.state, "closed");
});

test("an archived project's lead notice never reaches the lead that brings it back", async () => {
  const w = world();
  await staleBaseline(w, { lead: "orch_spawn_thread" });
  await activate(w);
  assert.ok(unreadNotice(w, "T-la"));
  w.e.archiveProject("alpha");
  w.e.registerStarted("T-la2", "lead", "alpha");
  assert.ok(!unreadNotice(w, "T-la2"));
});

test("with per-message delivery a notice is never sent on its own", async () => {
  const off = world(false);
  await staleBaseline(off, { cos: "orch_board_tidy" });
  await activate(off);
  assert.deepEqual(notices(off), [], "each pending item would go out alone and start a turn");
  assert.deepEqual(off.sent, []);

  const w = world();
  await staleBaseline(w, { cos: "orch_board_tidy" });
  await activate(w);
  assert.equal(notices(w).length, 1);
  w.e.settings = { ...w.e.settings, batchInbox: false };
  await w.e.flush();
  assert.deepEqual(w.sent, [], "switching batching off must not send what was waiting for a wake");
  assert.deepEqual(notices(w).map((n) => n.state), ["closed"]);
});

test("a role dropped from the list and restored later never reuses a sent notice's key", () => {
  const keys: string[] = [];
  let kept: unknown = { thread: { tools: ["a", "b"], gen: 0 } };
  const step = (current: Partial<Record<Role, string[]>>) => {
    const r = roleToolsChanges(kept, current as Record<Role, string[]>);
    kept = r.baseline;
    keys.push(...r.changes.map((c) => c.key));
    return r.changes.length;
  };
  assert.equal(step({ thread: ["a", "b", "c"] }), 1);
  step({});
  step({ thread: ["a", "b"] });
  assert.equal(step({ thread: ["a", "b", "c"] }), 1);
  assert.equal(new Set(keys).size, keys.length, `keys: ${keys.join(" ")}`);
});

test("an install that leaves every role's tools as they were tells nobody", async () => {
  const w = world();
  await activate(w);
  assert.deepEqual(notices(w), [], "with no baseline yet, nobody can be known to hold old tools");
  assert.ok(w.kv.has(KV_KEY), "the first activation records the baseline the next install compares with");
  await activate(w);
  await activate(w);
  assert.deepEqual(notices(w), []);
});
