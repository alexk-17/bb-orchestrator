// notifyOnlyOrchestrator (README, "Orchestrator notifications only"). The setting borrows the owner's push-notifications
// levels: they are the owner's own choices, so switching it off must give back exactly what was there, a restart must
// never save the muted levels as "the owner's", and a default install must not move a single level. Muting threads
// must not mute the orchestrator's own cards: they are the one thing the setting promises to keep.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileNotifyOnly, serialReconcile, type ChildLevel, type Level, type NotifyPorts, type NotifySaved } from "../core/notify-only.ts";
import plugin from "../server.ts";
import { Engine } from "../core/engine.ts";

/** A push-notifications plugin as the orchestrator sees it, plus the orchestrator's kv. Records every write. */
function fakePush(defaultLevel: unknown, childLevel: unknown, cos: string | null = "T-cos", parents: Record<string, string | null> = {}) {
  const st = { defaultLevel, childLevel, own: new Map<string, ChildLevel>(), kv: null as NotifySaved | null, writes: [] as string[], cos };
  const ports: NotifyPorts = {
    levels: async () => ({ defaultLevel: st.defaultLevel, childLevel: st.childLevel }),
    setLevels: async (v) => {
      st.writes.push(`levels ${v.defaultLevel}/${v.childLevel}`);
      st.defaultLevel = v.defaultLevel;
      st.childLevel = v.childLevel;
    },
    ownLevel: async (t) => st.own.get(t) ?? "inherit",
    setOwnLevel: async (t, l) => {
      st.writes.push(`own ${t} ${l}`);
      if (l === "inherit") st.own.delete(t);
      else st.own.set(t, l);
    },
    parentOf: async (t) => parents[t] ?? null,
    cosThread: () => st.cos,
    load: async () => (st.kv ? structuredClone(st.kv) : null),
    save: async (v) => {
      st.writes.push(v ? "save" : "forget");
      st.kv = v ? structuredClone(v) : null;
    },
  };
  return { st, ports };
}

test("a default install (setting off, nothing saved) changes no level and writes nothing", async () => {
  const { st, ports } = fakePush("input-only", "input-only");
  st.own.set("T-other", "all");
  assert.equal(await reconcileNotifyOnly(false, ports), "off");
  assert.deepEqual(st.writes, [], "off with nothing saved must not touch push-notifications");
  assert.deepEqual([st.defaultLevel, st.childLevel, st.own.get("T-other")], ["input-only", "input-only", "all"]);
});

for (const [d, c] of [["all", "input-only"], ["input-only", "inherit"], ["all", "all"], ["input-only", "muted"]] as [Level, ChildLevel][]) {
  test(`on then off gives back exactly ${d}/${c} and clears the CoS level it set`, async () => {
    const { st, ports } = fakePush(d, c);
    st.own.set("T-mine", "all"); // a level the owner set on some thread: never touched
    await reconcileNotifyOnly(true, ports);
    assert.deepEqual([st.defaultLevel, st.childLevel], ["muted", "muted"], "every other thread is muted");
    assert.equal(st.own.get("T-cos"), d, "the CoS keeps what it resolved to before (a top-level thread: defaultLevel)");
    await reconcileNotifyOnly(false, ports);
    assert.deepEqual([st.defaultLevel, st.childLevel], [d, c], "the owner's levels come back exactly");
    assert.equal(st.own.has("T-cos"), false, "the CoS is back to inheriting");
    assert.equal(st.own.get("T-mine"), "all");
    assert.equal(st.kv, null, "nothing left saved: a later on saves afresh");
  });
}

test("a CoS that is a child thread keeps the child level it resolved to", async () => {
  const { st, ports } = fakePush("all", "input-only", "T-cos", { "T-cos": "T-parent" });
  await reconcileNotifyOnly(true, ports);
  assert.equal(st.own.get("T-cos"), "input-only");
});

test("a restart while on never saves the muted levels as the owner's", async () => {
  const { st, ports } = fakePush("all", "input-only");
  await reconcileNotifyOnly(true, ports);
  // the plugin reloads (or is reinstalled): the kv survives, the reconcile runs again, and again each minute
  await reconcileNotifyOnly(true, ports);
  await reconcileNotifyOnly(true, ports);
  assert.deepEqual(st.kv && [st.kv.defaultLevel, st.kv.childLevel], ["all", "input-only"]);
  assert.equal(st.writes.filter((w) => w.startsWith("levels")).length, 1, "muted once, not again on every pass");
  await reconcileNotifyOnly(false, ports);
  assert.deepEqual([st.defaultLevel, st.childLevel], ["all", "input-only"]);
});

test("a crash after saving but before muting is finished on the next pass, and still restores", async () => {
  const { st, ports } = fakePush("all", "all");
  const crashing: NotifyPorts = { ...ports, setLevels: async () => { throw new Error("bb went away"); } };
  await assert.rejects(reconcileNotifyOnly(true, crashing));
  assert.deepEqual(st.kv && [st.kv.defaultLevel, st.kv.childLevel], ["all", "all"], "saved first");
  await reconcileNotifyOnly(true, ports);
  assert.deepEqual([st.defaultLevel, st.childLevel], ["muted", "muted"]);
  await reconcileNotifyOnly(false, ports);
  assert.deepEqual([st.defaultLevel, st.childLevel], ["all", "all"]);
});

test("a new CoS thread gets the level too, and both are cleared when off", async () => {
  const { st, ports } = fakePush("input-only", "input-only");
  await reconcileNotifyOnly(true, ports);
  st.cos = "T-cos2"; // the CoS was replaced
  await reconcileNotifyOnly(true, ports);
  assert.equal(st.own.get("T-cos2"), "input-only");
  await reconcileNotifyOnly(false, ports);
  assert.deepEqual([st.own.has("T-cos"), st.own.has("T-cos2")], [false, false]);
});

test("off leaves a CoS level the owner changed meanwhile", async () => {
  const { st, ports } = fakePush("input-only", "input-only");
  await reconcileNotifyOnly(true, ports);
  st.own.set("T-cos", "all"); // the owner's own choice, made while on
  await reconcileNotifyOnly(false, ports);
  assert.equal(st.own.get("T-cos"), "all");
});

test("push-notifications not running: nothing saved, and the next pass applies", async () => {
  const { st, ports } = fakePush("input-only", "input-only");
  const down: NotifyPorts = { ...ports, levels: async () => { throw new Error("HTTP 404: plugin is not running"); } };
  await assert.rejects(reconcileNotifyOnly(true, down));
  assert.equal(st.kv, null);
  await reconcileNotifyOnly(true, ports);
  assert.equal(st.defaultLevel, "muted");
});

test("a quick on-off-on runs one reconcile at a time and ends on, with the owner's levels still saved", async () => {
  const { st, ports } = fakePush("all", "input-only");
  let on = true;
  const slow: NotifyPorts = { ...ports, setLevels: async (v) => { await new Promise((r) => setTimeout(r, 5)); await ports.setLevels(v); } };
  const run = serialReconcile(() => on, slow, () => {});
  const a = run();
  on = false;
  const b = run();
  on = true;
  await Promise.all([a, b, run()]);
  assert.deepEqual([st.defaultLevel, st.childLevel], ["muted", "muted"]);
  assert.deepEqual(st.kv && [st.kv.defaultLevel, st.kv.childLevel], ["all", "input-only"]);
});

// ---------------------------------------------------------------- the whole plugin, against a stubbed bb SDK

type Tool = { name: string; execute: (p: unknown, ctx: { threadId: string }) => Promise<{ content: { text: string }[]; isError?: boolean }> };
type Service = { start: (signal: AbortSignal) => Promise<void> };

/** A fake bb host whose push-notifications keeps levels and, like the real one, sends without consulting them. */
function host(settings: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "orch-notify-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "demo"), { recursive: true });
  writeFileSync(join(projects, "demo", "PROJECT.md"), "# demo\n");
  writeFileSync(join(projects, "demo", "project.json"), "{}");
  const db = Object.assign(new DatabaseSync(join(root, "data.db")), { name: join(root, "data.db") });
  const push = { values: { mobileEnabled: false, webEnabled: true, desktopEnabled: true, defaultLevel: "input-only", childLevel: "input-only" } as Record<string, unknown>, own: new Map<string, string>() };
  const rec = { tools: new Map<string, Tool>(), services: new Map<string, Service>(), sent: [] as Record<string, unknown>[], writes: [] as string[] };
  const kv = new Map<string, unknown>();
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : noop), apply: () => noop });
  const sdk = {
    plugins: {
      getSettings: async ({ pluginId }: { pluginId: string }) => (pluginId === "push-notifications" ? { values: { ...push.values } } : { values: {} }),
      updateSettings: async ({ pluginId, values }: { pluginId: string; values: Record<string, unknown> }) => {
        rec.writes.push(`settings ${pluginId} ${JSON.stringify(values)}`);
        Object.assign(push.values, values);
        return { values: push.values };
      },
      callRpc: async ({ pluginId, method, input }: { pluginId: string; method: string; input: any }) => {
        if (pluginId !== "push-notifications") return {};
        if (method === "notifications.send") {
          rec.sent.push(input);
          return { ok: true, channels: ["web", "desktop"] };
        }
        if (method === "threadNotifications.list") return { threads: Object.fromEntries(input.threadIds.filter((t: string) => push.own.has(t)).map((t: string) => [t, { own: push.own.get(t), ancestorCap: null }])) };
        if (method === "threadNotifications.set") {
          rec.writes.push(`own ${input.threadId} ${input.level}`);
          if (input.level === "inherit") push.own.delete(input.threadId);
          else push.own.set(input.threadId, input.level);
          return { own: input.level, ancestorCap: null };
        }
        throw new Error(`unexpected ${method}`);
      },
    },
    threads: { get: async ({ threadId }: { threadId: string }) => ({ id: threadId, parentThreadId: null, archivedAt: null }) },
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
              Object.assign(v, { stateDir: join(root, "state"), projectsDir: projects, memoryConfig: "", diskPath: root }, settings);
              return { get: async () => v, onChange: () => {} };
            },
          };
        if (k === "storage") return { database: () => db, kv: { get: async (key: string) => kv.get(key), set: async (key: string, v: unknown) => void kv.set(key, v), delete: async (key: string) => void kv.delete(key) } };
        if (k === "sdk") return new Proxy(sdk as any, { get: (t, a) => t[a] ?? noop });
        if (k === "agents") return new Proxy({ registerTool: (t: Tool) => rec.tools.set(t.name, t) } as any, { get: (t, a) => t[a] ?? noop });
        if (k === "background") return { service: (name: string, s: Service) => rec.services.set(name, s), schedule: () => {} };
        if (k === "log") return { info: () => {}, warn: () => {}, error: () => {} };
        return noop;
      },
    },
  );
  return { bb, db, root, push, rec };
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** One pass of the notify-only service, then stop it. */
async function onePass(h: ReturnType<typeof host>): Promise<void> {
  const stop = new AbortController();
  const run = h.rec.services.get("notify-only")!.start(stop.signal);
  await new Promise((r) => setTimeout(r, 20));
  stop.abort();
  await run;
}

test("plugin: a default install moves no push-notifications level", async () => {
  const h = host({});
  roots.push(h.root);
  await plugin(h.bb);
  await onePass(h);
  assert.deepEqual(h.rec.writes, [], "notifyOnlyOrchestrator defaults to off and writes nothing");
  assert.deepEqual([h.push.values.defaultLevel, h.push.values.childLevel], ["input-only", "input-only"]);
});

test("plugin: with it on, threads are muted but a card still notifies, opening the asker's thread", async () => {
  const h = host({ notifyOnlyOrchestrator: true });
  roots.push(h.root);
  const e = new Engine(h.db as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  e.register("T-cos", "cos", null);
  e.register("T-lead", "lead", "demo");
  await plugin(h.bb);
  await onePass(h);
  assert.deepEqual([h.push.values.defaultLevel, h.push.values.childLevel], ["muted", "muted"], "ordinary threads are muted");
  assert.equal(h.push.own.get("T-cos"), "input-only", "the CoS still notifies at the level it had");
  assert.equal(h.push.own.has("T-lead"), false, "a lead is muted with the rest");
  // a lead asks; the CoS puts it to the owner: the card enters Needs you
  const asked = await h.rec.tools.get("orch_ask")!.execute({ title: "Ship it?", question: "Ship the release?", options: [{ label: "Yes" }, { label: "No" }] }, { threadId: "T-lead" });
  assert.ok(!asked.isError, asked.content[0].text);
  const id = /d-[0-9TZ]+-[0-9a-f]+/.exec(asked.content[0].text)![0];
  const triaged = await h.rec.tools.get("orch_triage")!.execute({ id, action: "ask_person", question: "Ship the release?", options: [{ label: "Yes" }, { label: "No" }] }, { threadId: "T-cos" });
  assert.ok(!triaged.isError, triaged.content[0].text);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.rec.sent.length, 1, "the card went out once, through notifications.send, which no thread level mutes");
  assert.match(String(h.rec.sent[0].title), /^Needs you: /);
  assert.equal(h.rec.sent[0].threadId, "T-lead", "a click opens the asker's thread");
});
