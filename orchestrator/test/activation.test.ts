// Activation leaves nothing running when it fails. bb discards a failed activation without running its dispose hooks
// (it closes the database and never starts its services), so a timer started during activation outlived it: on
// 2026-11-14 a failed reload's interval threw "The database connection is not open" every minute, and bb kept marking
// the live plugin "uncaught error". These tests load the real server entry against a fake bb host.
import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { unlessAborted } from "../server.ts";
import { Engine } from "../core/engine.ts";

/** A live project folder: its PROJECT.md and its record, so each memory reload writes its row to the database. */
function liveProject(projects: string, slug: string): void {
  mkdirSync(join(projects, slug), { recursive: true });
  writeFileSync(join(projects, slug, "PROJECT.md"), `# ${slug}\n`);
  writeFileSync(join(projects, slug, "project.json"), "{}");
}

type Service = { start: (signal: AbortSignal) => Promise<void> };

/**
 * A fake bb host: records services, dispose hooks, change notices and logs; `failAt` makes that registration throw,
 * and `hangSdk` makes every bb.sdk call never answer (a slow host or another plugin's RPC).
 */
function fakeHost(failAt: "cli" | null, hangSdk = false) {
  const root = mkdtempSync(join(tmpdir(), "orch-activation-"));
  const projects = join(root, "projects");
  liveProject(projects, "demo");
  const db = Object.assign(new DatabaseSync(join(root, "data.db")), { name: join(root, "data.db") });
  const rec = { services: new Map<string, Service>(), dispose: [] as (() => unknown)[], published: 0, logs: [] as string[] };
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : noop), apply: () => noop });
  const hanging: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : hanging), apply: () => new Promise(() => {}) });
  const bb: any = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "pluginId") return "orchestrator";
        if (k === "settings")
          return {
            define: (schema: Record<string, { default: unknown }>) => {
              const v: any = Object.fromEntries(Object.entries(schema).map(([key, d]) => [key, d.default]));
              Object.assign(v, { stateDir: join(root, "state"), projectsDir: projects, memoryConfig: "", diskPath: root });
              return { get: async () => v, onChange: () => {} };
            },
          };
        if (k === "storage") return { database: () => db, kv: noop };
        if (k === "sdk" && hangSdk) return hanging;
        if (k === "background") return { service: (name: string, s: Service) => rec.services.set(name, s), schedule: () => {} };
        if (k === "onDispose") return (h: () => unknown) => rec.dispose.push(h);
        if (k === "realtime") return { publish: () => rec.published++, subscribe: noop };
        if (k === "log") return { info: (m: string) => rec.logs.push(m), warn: (m: string) => rec.logs.push(m), error: (m: string) => rec.logs.push(m) };
        if (k === "cli" && failAt === "cli")
          return {
            register: () => {
              throw new Error("activation failed late");
            },
          };
        return noop;
      },
    },
  );
  return { bb, db, rec, root, projects };
}

const roots: string[] = [];
afterEach(() => {
  mock.timers.reset();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const settle = () => new Promise<void>((r) => setImmediate(r));

test("an activation that throws after the timers would start leaves none running", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = fakeHost("cli");
  roots.push(h.root);
  await assert.rejects(plugin(h.bb), /activation failed late/);
  // what bb does with a failed candidate: close its database, run no dispose hook, start no service
  h.db.close();
  h.rec.logs.length = 0;
  h.rec.published = 0;
  // the memory reload used to be a 60 s setInterval: it would read the closed database here and throw
  assert.doesNotThrow(() => mock.timers.tick(10 * 60_000));
  await settle();
  assert.equal(h.rec.published, 0, "no change notice from a discarded activation");
  assert.deepEqual(h.rec.logs, [], "nothing of the discarded activation runs");
});

test("after a good activation the services reload memory each minute and stop at once", async () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const h = fakeHost(null);
  roots.push(h.root);
  await plugin(h.bb);
  assert.ok(h.rec.services.has("memory"), "the minute's memory reload is a service bb starts after activation");
  // a project folder that appears later gets its row on the next minute, as with the old interval
  liveProject(h.projects, "later");
  const has = (slug: string) => h.db.prepare("SELECT 1 FROM projects WHERE slug = ?").get(slug) !== undefined;
  assert.equal(has("later"), false);
  const stop = new AbortController();
  const memory = h.rec.services.get("memory")!.start(stop.signal);
  await settle();
  mock.timers.tick(200); // the change notice's debounce
  assert.equal(h.rec.published > 0, true, "the services announce the page once they run");
  mock.timers.tick(60_000);
  await settle();
  assert.equal(has("later"), true);
  // bb stops the services, then runs the dispose hooks, then closes the database
  stop.abort();
  await memory;
  for (const d of h.rec.dispose.reverse()) await d();
  h.db.close();
  assert.doesNotThrow(() => mock.timers.tick(10 * 60_000));
});

test("a stopping service stops waiting on a slow call", async () => {
  const stop = new AbortController();
  const hung = new Promise<string>(() => {});
  const waiting = unlessAborted(hung, stop.signal);
  stop.abort();
  assert.equal(await waiting, null);
  assert.equal(await unlessAborted(Promise.resolve("read"), new AbortController().signal), "read");
  assert.equal(await unlessAborted(Promise.resolve("read")), "read");
  await assert.rejects(unlessAborted(Promise.reject(new Error("down")), new AbortController().signal), /down/);
});

test("the clock stops at once while a bb call never answers", async () => {
  // bb gives a stopped service 5 s, then fails the reload ("service clock did not stop", 2026-11-14)
  const h = fakeHost(null, true);
  roots.push(h.root);
  // a thread with a role: the clock's first pass reads it from bb, and that read never answers
  new Engine(h.db as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }).register("T-lead", "lead", "demo");
  await plugin(h.bb);
  const stop = new AbortController();
  const clock = h.rec.services.get("clock")!.start(stop.signal);
  await new Promise((r) => setTimeout(r, 50));
  stop.abort();
  const stopped = await Promise.race([clock.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 1_000))]);
  assert.equal(stopped, true, "the clock settles within a second of its stop, not when the call answers");
});
