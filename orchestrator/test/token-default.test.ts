// The batched inbox is the default (2026-11-20, tokens; the owner's yes). Per-message delivery woke an agent into its own
// turn for every notice and copy, each re-reading a context of ~230k tokens: on the replay day the default spent 28%
// more. An install that never set batchInbox batches after the update; one that saved false keeps per-message delivery.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../server.ts";
import { Engine, DEFAULT_SETTINGS } from "../core/engine.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake bb whose saved settings are `saved`; what isn't saved takes the setting's declared default, as bb does. */
function host(saved: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "orch-default-"));
  roots.push(root);
  mkdirSync(join(root, "projects"));
  const db = Object.assign(new DatabaseSync(join(root, "data.db")), { name: join(root, "data.db") });
  const sends: { threadId: string; text: string }[] = [];
  const tools: Record<string, { execute: (p: unknown, ctx: { threadId: string }) => Promise<unknown> }> = {};
  const sdk = (path: string[]): any =>
    new Proxy(function () {}, {
      get: (_t, k) => (k === "then" ? undefined : sdk([...path, String(k)])),
      apply: (_t, _this, args: any[]) => {
        const p = path.join(".");
        if (p === "threads.send") {
          sends.push({ threadId: args[0].threadId, text: args[0].input.map((x: { text?: string }) => x.text ?? "").join("") });
          return Promise.resolve({ delivery: "sent" });
        }
        if (p === "threads.get") return Promise.resolve({ status: "idle", archivedAt: null });
        if (/\.list$/.test(p)) return Promise.resolve([]);
        return Promise.resolve({});
      },
    });
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : noop), apply: () => noop });
  const bb: any = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "pluginId") return "orchestrator";
        if (k === "settings")
          return {
            define: (schema: Record<string, { default: unknown }>) => {
              const v: any = Object.fromEntries(Object.entries(schema).map(([key, d]) => [key, d.default]));
              Object.assign(v, { stateDir: join(root, "state"), projectsDir: join(root, "projects"), memoryConfig: "", diskPath: root, inboxDebounceMs: 1, prPollMinutes: 0 }, saved);
              return { get: async () => v, onChange: () => {} };
            },
          };
        if (k === "storage") return { database: () => db, kv: { get: async () => null, set: async () => {}, delete: async () => {} } };
        if (k === "sdk") return sdk([]);
        if (k === "agents") return new Proxy({ registerTool: (t: any) => (tools[t.name] = t) } as any, { get: (o, kk) => o[kk] ?? (() => {}) });
        if (k === "background") return { service: () => {} };
        if (k === "log") return { info: () => {}, warn: () => {}, error: () => {} };
        return noop;
      },
    },
  );
  return { bb, db, sends, tools };
}

async function noticeAndMessage(saved: Record<string, unknown>) {
  const h = host(saved);
  const e = new Engine(h.db as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "kite");
  e.setStatus(lead.threadId, "idle");
  await plugin(h.bb);
  await h.tools.orch_send!.execute({ to: lead.address, text: "fyi: the release went out", severity: "INFO" }, { threadId: cos.threadId });
  await sleep(20);
  const afterNotice = h.sends.filter((s) => s.threadId === lead.threadId).length;
  await h.tools.orch_send!.execute({ to: lead.address, text: "please check the release notes" }, { threadId: cos.threadId });
  await sleep(20);
  await h.tools.orch_inbox!.execute({}, { threadId: cos.threadId }); // a later tool call's flush sends a due wake
  await sleep(20);
  return { afterNotice, toLead: h.sends.filter((s) => s.threadId === lead.threadId) };
}

test("an install that never set batchInbox batches: a notice wakes no one, a message wakes once with the digest", async () => {
  const r = await noticeAndMessage({});
  assert.equal(r.afterNotice, 0, "the INFO notice started no turn");
  assert.equal(r.toLead.length, 1, "one wake for both");
  assert.match(r.toLead[0]!.text, /^\[orchestrator\] Inbox wake/);
  assert.match(r.toLead[0]!.text, /fyi: the release went out[\s\S]*please check the release notes/, "the notice rides along");
});

test("an install that saved batchInbox false keeps per-message delivery", async () => {
  const r = await noticeAndMessage({ batchInbox: false });
  assert.equal(r.afterNotice, 1, "the notice is its own turn, as before");
  assert.equal(r.toLead.length, 2);
  assert.ok(r.toLead.every((s) => !s.text.includes("Inbox wake")));
});

test("the engine's own default matches the setting's", () => {
  assert.equal(DEFAULT_SETTINGS.batchInbox, true);
  const e = new Engine(new DatabaseSync(":memory:") as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  assert.equal(e.settings.batchInbox, true);
});
