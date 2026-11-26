import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine } from "../core/engine.ts";
import { adoptThread, type Adoption, type AdoptThread } from "../core/adopt.ts";

function setup() {
  const engine = new Engine(new DatabaseSync(":memory:") as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  engine.register("cos", "cos", null);
  engine.register("lead", "lead", "alpha", "cos");
  const rows = new Map<string, AdoptThread>(["worker", "lead", "cos"].map((id) => [id, { id, status: "idle", archivedAt: null, parentThreadId: null, environmentId: `env-${id}`, projectId: "project" }]));
  const changes: string[] = [];
  const request: Adoption = { threadId: "worker", role: "thread", project: "alpha", parentThreadId: "lead", approval: "owner-approved migration 1" };
  const ports = { engine, queued: async () => false, get: async (id: string) => ({ ...rows.get(id)! }), parent: async (id: string, parent: string, notify: string) => { Object.assign(rows.get(id)!, { parentThreadId: parent, parentNotifications: notify }); changes.push(id); }, mirror: async () => {} };
  return { engine, rows, changes, request, ports };
}

test("adoption preserves thread/environment, sets both parents and idle state, retries without allocating an address", async () => {
  const s = setup();
  const a = await adoptThread(s.ports, s.request);
  assert.equal(a.threadId, "worker");
  assert.equal(a.address, "thread:alpha:1");
  assert.equal(a.parentThreadId, "lead");
  assert.equal(a.environmentId, "env-worker");
  assert.equal(a.status, "idle");
  assert.equal(s.rows.get("worker")!.parentThreadId, "lead");
  assert.equal((await adoptThread(s.ports, s.request)).address, a.address);
  assert.deepEqual(s.changes, ["worker"]);
  assert.equal(s.engine.board().filter((b) => b.title.startsWith("Adopted ")).length, 1);
  assert.equal(s.engine.flagUnplanned(0), 0, "explicitly adopted workers are not accidental unplanned spawns");
});

// 2026-11-24 (the lead's call): bb woke a lead at every turn end of its adopted threads,
// because adoption kept bb's "auto" level, while threads from orch_spawn_thread are "stuck" and wake it only through
// the plugin (reports, prompts, failures), within the lead wake gap. An adopted thread must match the spawn path.
test("an adopted thread gets the spawn path's notify level, even when its bb parent was already right", async () => {
  const s = setup();
  Object.assign(s.rows.get("worker")!, { parentThreadId: "lead", parentNotifications: "auto" });
  await adoptThread(s.ports, s.request);
  assert.equal(s.rows.get("worker")!.parentNotifications, "stuck", "under auto bb would wake the lead at every turn end");
  assert.equal(s.rows.get("worker")!.parentThreadId, "lead");
  await adoptThread(s.ports, s.request);
  assert.deepEqual(s.changes, ["worker"], "a retry on a thread already at stuck changes nothing");
});

test("an adopted lead under the CoS is not switched to stuck: only threads match the spawn path", async () => {
  const s = setup();
  const engine = new Engine(new DatabaseSync(":memory:") as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  engine.register("cos", "cos", null);
  Object.assign(s.rows.get("lead")!, { parentThreadId: "cos", parentNotifications: "auto" });
  await adoptThread({ ...s.ports, engine }, { threadId: "lead", role: "lead", project: "alpha", parentThreadId: "cos", approval: "owner-approved migration 2" });
  assert.equal(s.rows.get("lead")!.parentNotifications, "auto");
  assert.deepEqual(s.changes, []);
});

test("active/archived threads and parent conflicts fail before mutation", async () => {
  for (const patch of [{ status: "active" }, { archivedAt: 42 }, { parentThreadId: "other" }, { environmentId: null }]) {
    const s = setup();
    Object.assign(s.rows.get("worker")!, patch);
    await assert.rejects(adoptThread(s.ports, s.request));
    assert.deepEqual(s.changes, []);
    assert.equal(s.engine.agentByThread("worker"), null);
  }
});

test("no role takeover, cross-project parent, missing approval or archived project", async () => {
  for (const patch of [{ role: "cos", project: null, parentThreadId: null }, { parentThreadId: "cos" }, { project: "beta" }, { approval: "" }] as Partial<Adoption>[]) {
    const s = setup();
    await assert.rejects(adoptThread(s.ports, { ...s.request, ...patch }));
    assert.deepEqual(s.changes, []);
  }
  const s = setup();
  s.engine.setHold("alpha", true);
  await assert.rejects(adoptThread(s.ports, s.request), /held or archived/);
});

test("an old role-set without a parent can be repaired only against the matching role and project", async () => {
  const s = setup();
  const old = s.engine.register("worker", "thread", "alpha");
  assert.equal((await adoptThread(s.ports, s.request)).address, old.address);
  assert.equal(s.engine.agentByThread("worker")!.parentThreadId, "lead");
  await assert.rejects(adoptThread(s.ports, { ...s.request, role: "lead" }), /parent must|conflicts/);
});

test("failure after parent update or registration converges on retry without respawning", async () => {
  const s = setup();
  let reads = 0;
  await assert.rejects(adoptThread({ ...s.ports, get: async (id) => { if (++reads === 3) throw new Error("read failed"); return s.ports.get(id); } }, s.request), /read failed/);
  assert.equal(s.engine.agentByThread("worker"), null);
  await assert.rejects(adoptThread({ ...s.ports, mirror: async () => { throw new Error("mirror failed"); } }, s.request), /mirror failed/);
  const id = s.engine.agentByThread("worker")!.address;
  assert.equal((await adoptThread(s.ports, s.request)).address, id);
  assert.deepEqual(s.changes, ["worker"]);
});

test("concurrent activation is reported rather than registering an active thread", async () => {
  const s = setup();
  await assert.rejects(adoptThread({ ...s.ports, parent: async (id, parent, notify) => { await s.ports.parent(id, parent, notify); s.rows.get(id)!.status = "active"; } }, s.request), /idle/);
  assert.equal(s.engine.agentByThread("worker"), null);
});

test("queued work prevents adoption even when bb reports idle", async () => {
  const s = setup();
  await assert.rejects(adoptThread({ ...s.ports, queued: async () => true }, s.request), /empty message queue/);
  assert.deepEqual(s.changes, []);
  assert.equal(s.engine.agentByThread("worker"), null);
});
