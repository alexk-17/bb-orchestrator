// orch_board_tidy's own wiring (Codex review of ecd4681): filing a PR no thread holds never reads GitHub on the request
// path. The reply must not wait on a machine (a slow or dead host would hold the CoS's turn), and a refused caller must
// cause no GitHub read and no write: only the wait pass reads filed PRs. The real server entry against a fake bb whose
// one connected host counts every call and never answers.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import plugin from "../server.ts";
import { Engine, type DeliverResult } from "../core/engine.ts";
import { statusParams } from "../core/status.ts";

const SCRATCH = join(import.meta.dirname, "..", ".scratch-test");
mkdirSync(SCRATCH, { recursive: true });
const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

type Tool = { name: string; parameters: { parse(v: unknown): unknown }; execute(p: unknown, ctx: { threadId: string }): Promise<{ content: { text: string }[]; isError?: boolean }> };
const PR = "https://github.com/acme-co/widgets/pull/9";

async function server() {
  const root = mkdtempSync(join(SCRATCH, "board-tidy-tool-"));
  roots.push(root);
  const db = Object.assign(new DatabaseSync(join(root, "data.db")), { name: join(root, "data.db") });
  const tools = new Map<string, Tool>();
  const hostCalls: string[] = [];
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : noop), apply: () => noop });
  const sdk = {
    hosts: { list: async () => [{ id: "host-1", type: "persistent", status: "connected", lifecycle: { phase: "active" } }] },
    threads: { get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", archivedAt: null }), send: async () => ({ delivery: "sent" }), queuedMessages: { list: async () => [] }, list: async () => [] },
  };
  // a machine that takes every call and never answers
  const host = { call: (method: string) => (hostCalls.push(method), new Promise(() => {})) };
  const bb: any = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "pluginId") return "orchestrator";
        if (k === "settings")
          return {
            define: (schema: Record<string, { default: unknown }>) => {
              const v: Record<string, unknown> = Object.fromEntries(Object.entries(schema).map(([key, d]) => [key, d.default]));
              Object.assign(v, { batchInbox: false, stateDir: join(root, "state"), projectsDir: join(root, "projects"), memoryConfig: "", diskPath: root, ownerName: "" });
              return { get: async () => v, onChange: () => {} };
            },
          };
        if (k === "storage") return { database: () => db, kv: noop };
        if (k === "agents") return new Proxy({ registerTool: (t: Tool) => tools.set(t.name, t) }, { get: (a: any, n) => a[n] ?? noop });
        if (k === "hosts") return new Proxy({ experimental_client: () => host }, { get: (a: any, n) => a[n] ?? noop });
        if (k === "sdk") return new Proxy(sdk, { get: (s: any, n) => s[n] ?? noop });
        if (k === "background") return { service: () => {} };
        if (k === "log") return { info: () => {}, warn: () => {}, error: () => {} };
        return noop;
      },
    },
  );
  await plugin(bb);
  const engine = new Engine(db as never, { now: () => Date.now(), deliver: async (): Promise<DeliverResult> => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { batchInbox: false });
  const call = async (raw: unknown, threadId: string) => {
    const t = tools.get("orch_board_tidy")!;
    // a reply that waited on the host would never come: fail fast instead of hanging the suite
    const r = await Promise.race([t.execute(t.parameters.parse(raw), { threadId }), new Promise<never>((_, no) => setTimeout(() => no(new Error("the tool waited on the host")), 2000))]);
    return { ok: !r.isError, text: r.content[0]!.text };
  };
  return { engine, db, call, hostCalls };
}

test("filing a PR no thread holds replies at once and reads no GitHub; a refused caller reads and writes nothing", async () => {
  const s = await server();
  s.engine.register("T-cos", "cos", null);
  const lead = s.engine.register("T-lead", "lead", "demo");
  const [a] = s.engine.publishStatus(lead, statusParams.parse({ goal: "Ship", steps: [{ title: "Hotfix", state: "current" }] })).steps.map((x) => x.id!);
  const rows = () => ({
    filed: s.db.prepare(`SELECT url, task FROM task_prs`).all().map((r) => ({ ...r })),
    readings: (s.db.prepare(`SELECT COUNT(*) AS n FROM pr_readings`).get() as { n: number }).n,
  });

  const r = await s.call({ action: "file", kind: "pr", ref: PR, task: a }, "T-cos");
  assert.ok(r.ok, r.text);
  assert.deepEqual(s.hostCalls, [], "no GitHub read on the request path: the wait pass reads it");
  assert.deepEqual(rows(), { filed: [{ url: PR, task: a }], readings: 0 }, "filed, its state unknown until read");

  // a lead naming the already filed PR is refused: no GitHub read, nothing written
  const before = rows();
  const refused = await s.call({ action: "file", kind: "pr", ref: PR, task: a }, "T-lead");
  assert.deepEqual(refused, { ok: false, text: "forbidden: only the CoS tidies the work board" });
  assert.deepEqual(s.hostCalls, []);
  assert.deepEqual(rows(), before);
});
