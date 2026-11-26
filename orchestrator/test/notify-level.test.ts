// The startup reconcile of bb notify levels (2026-11-24, the lead's ask). Threads made before handoff
// and adoption set "stuck" kept bb's "auto", and bb woke their lead with "… completed" at every turn end, outside the
// plugin's inbox and its wake gap (seven handed-off successors in orchestrator alone, seen live). On install, each
// such thread must move to "stuck" with nothing done by hand, and nothing else may change: a lead's or the CoS's
// level, a thread under another parent, an archived one. A restart must change nothing more.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../server.ts";
import { Engine } from "../core/engine.ts";
import { autoUnderLead, type BbNotify } from "../core/notify-level.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Service = { start: (signal: AbortSignal) => Promise<void> };

/** cos, leads kite and otter, and kite/otter threads in every case the reconcile must tell apart. */
function world(db: DatabaseSync) {
  const e = new Engine(db as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  e.register("T-cos", "cos", null);
  e.register("T-kite", "lead", "kite");
  e.register("T-otter", "lead", "otter");
  for (const id of ["T-succ", "T-new", "T-off", "T-cosparent", "T-orphan", "T-archived", "T-gone", "T-other"]) e.register(id, "thread", "kite", "T-kite");
  e.register("T-o1", "thread", "otter", "T-otter");
  e.retire("T-gone");
  const bb = new Map<string, BbNotify & { id: string; status: string }>([
    ["T-cos", { id: "T-cos", status: "idle", parentThreadId: null, parentNotifications: "auto", archivedAt: null }],
    ["T-kite", { id: "T-kite", status: "idle", parentThreadId: "T-cos", parentNotifications: "auto", archivedAt: null }],
    ["T-otter", { id: "T-otter", status: "idle", parentThreadId: null, parentNotifications: "auto", archivedAt: null }],
    // a handed-off successor from before this release: the one case to change
    ["T-succ", { id: "T-succ", status: "idle", parentThreadId: "T-kite", parentNotifications: "auto", archivedAt: null }],
    ["T-new", { id: "T-new", status: "idle", parentThreadId: "T-kite", parentNotifications: "stuck", archivedAt: null }],
    ["T-off", { id: "T-off", status: "idle", parentThreadId: "T-kite", parentNotifications: "off", archivedAt: null }],
    ["T-cosparent", { id: "T-cosparent", status: "idle", parentThreadId: "T-cos", parentNotifications: "auto", archivedAt: null }],
    ["T-orphan", { id: "T-orphan", status: "idle", parentThreadId: null, parentNotifications: "auto", archivedAt: null }],
    ["T-archived", { id: "T-archived", status: "idle", parentThreadId: "T-kite", parentNotifications: "auto", archivedAt: 42 }],
    ["T-gone", { id: "T-gone", status: "idle", parentThreadId: "T-kite", parentNotifications: "auto", archivedAt: null }],
    // a kite thread whose bb parent is otter's lead: not its own lead, left alone
    ["T-other", { id: "T-other", status: "idle", parentThreadId: "T-otter", parentNotifications: "auto", archivedAt: null }],
    ["T-o1", { id: "T-o1", status: "idle", parentThreadId: "T-otter", parentNotifications: "auto", archivedAt: null }],
  ]);
  return { e, bb };
}

test("only a live thread at auto under its own lead's thread is picked", () => {
  const { e, bb } = world(new DatabaseSync(":memory:"));
  assert.deepEqual(
    autoUnderLead(e, bb).map((x) => [x.agent.threadId, x.leadThreadId]),
    [["T-succ", "T-kite"], ["T-o1", "T-otter"]],
    "leads, the CoS, stuck/off, another or no bb parent, archived and retired threads are all left as they are",
  );
});

/** The real server entry on a fake bb host that keeps each thread's level; runs the clock service as bb does. */
function host(root: string) {
  const db = Object.assign(new DatabaseSync(join(root, "data.db")), { name: join(root, "data.db") });
  const { bb: threads } = world(db);
  const updates: Record<string, unknown>[] = [];
  const info: string[] = [];
  const looked = { n: 0 };
  const services = new Map<string, Service>();
  const sdk = (path: string[]): any =>
    new Proxy(function () {}, {
      get: (_t, k) => (k === "then" ? undefined : sdk([...path, String(k)])),
      apply: (_t, _this, args: any[]) => {
        const p = path.join(".");
        if (p === "threads.get") {
          looked.n++;
          const t = threads.get(args[0].threadId);
          return t ? Promise.resolve({ ...t }) : Promise.reject(Object.assign(new Error("no thread"), { code: "thread_not_found" }));
        }
        // other startup work updates threads too (sidebar sections): only level changes are recorded here
        if (p === "threads.update" && "parentNotifications" in args[0]) {
          updates.push(args[0]);
          Object.assign(threads.get(args[0].threadId)!, { parentThreadId: args[0].parentThreadId, parentNotifications: args[0].parentNotifications });
          return Promise.resolve({});
        }
        if (/\.list$/.test(p)) return Promise.resolve([]);
        return Promise.resolve({});
      },
    });
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : noop), apply: () => noop });
  const bb: any = new Proxy({}, {
    get(_t, k) {
      if (k === "pluginId") return "orchestrator";
      if (k === "settings")
        return { define: (schema: Record<string, { default: unknown }>) => {
          const v: any = Object.fromEntries(Object.entries(schema).map(([key, d]) => [key, d.default]));
          Object.assign(v, { stateDir: join(root, "state"), projectsDir: join(root, "projects"), memoryConfig: "", diskPath: root, prPollMinutes: 0 });
          return { get: async () => v, onChange: () => {} };
        } };
      if (k === "storage") return { database: () => db, kv: { get: async () => null, set: async () => {}, delete: async () => {} } };
      if (k === "sdk") return sdk([]);
      if (k === "agents") return new Proxy({ registerTool: () => {} } as any, { get: (o, kk) => o[kk] ?? (() => {}) });
      if (k === "background") return { service: (name: string, s: Service) => services.set(name, s) };
      if (k === "log") return { info: (m: string) => info.push(m), warn: () => {}, error: () => {} };
      return noop;
    },
  });
  return { bb, threads, updates, info, services, looked };
}

/** One plugin start: activation, then the clock's startup reconcile, then stop. */
async function start(h: ReturnType<typeof host>) {
  await plugin(h.bb);
  const stop = new AbortController();
  const clock = h.services.get("clock")!.start(stop.signal);
  // the reconcile looks up all 11 live agents' threads, then fixes levels; wait for the lookups, then let it finish
  const from = h.looked.n;
  for (let i = 0; i < 500 && h.looked.n - from < 11; i++) await sleep(20);
  assert.ok(h.looked.n - from >= 11, "the startup reconcile ran");
  await sleep(300);
  stop.abort();
  await clock;
}

test("on start, each such thread moves to stuck with one log line, and a restart changes nothing more", async () => {
  const root = mkdtempSync(join(tmpdir(), "orch-notify-"));
  roots.push(root);
  mkdirSync(join(root, "projects"));
  const h = host(root);
  await start(h);
  assert.deepEqual(h.updates, [
    { threadId: "T-succ", parentThreadId: "T-kite", parentNotifications: "stuck" },
    { threadId: "T-o1", parentThreadId: "T-otter", parentNotifications: "stuck" },
  ], "the same parent, now stuck: bb no longer wakes the lead at each turn end");
  const lines = h.info.filter((m) => m.startsWith("notify level:"));
  assert.equal(lines.length, 2, "one line per change");
  assert.match(lines[0]!, /thread:kite:1 \(T-succ\) auto -> stuck under its lead T-kite/);
  for (const id of ["T-cos", "T-kite", "T-otter", "T-cosparent", "T-orphan", "T-archived", "T-gone", "T-other"])
    assert.equal(h.threads.get(id)!.parentNotifications, "auto", `${id} is left at auto`);
  assert.equal(h.threads.get("T-off")!.parentNotifications, "off");

  h.updates.length = 0;
  h.info.length = 0;
  await start(h);
  assert.deepEqual(h.updates, [], "idempotent: a restart finds nothing left at auto under its lead");
  assert.equal(h.info.filter((m) => m.startsWith("notify level:")).length, 0);
});
