// The CoS starts leads and creates projects (2026-11-16): orch_start_lead must be the owner's Start lead button with a
// different "who", never a second copy of its checks, or the two drift and the CoS starts a lead the button would
// refuse (a held project, a second lead splitting one project's mail). orch_new_project writes a project the button can
// start, refuses anything that would clobber or shadow an existing one, and leaves nothing behind when it refuses.
// The server tests load the real server entry against a fake bb host, so both callers run the real wiring.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import plugin from "../server.ts";
import { Engine, type DeliverResult } from "../core/engine.ts";
import { EngineError } from "../core/model.ts";
import { liveProjects } from "../core/memory.ts";
import { newProject, type NewProjectPorts } from "../core/new-project.ts";
import { primaryRepo } from "../core/start.ts";
import { WRITES } from "../contract.ts";
import { z } from "zod";

// Scratch space inside the worktree (git-ignored): never the system temp folder, never a real projects folder.
const SCRATCH = join(import.meta.dirname, "..", ".scratch-test");
mkdirSync(SCRATCH, { recursive: true });
const roots: string[] = [];
const scratch = (name: string) => {
  const d = mkdtempSync(join(SCRATCH, `${name}-`));
  roots.push(d);
  return d;
};
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const RECORD = "record.json";
const ports = { now: () => Date.parse("2026-11-16T10:00:00Z"), deliver: async (): Promise<DeliverResult> => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} };

/** A project folder like the real ones: PROJECT.md naming its repo, and its record. */
function projectFolder(root: string, slug: string, repo: string | null, base = "dev"): void {
  mkdirSync(join(root, slug), { recursive: true });
  writeFileSync(join(root, slug, "PROJECT.md"), `# ${slug}\n\n## Goal\nTest.\n\n${repo ? `## Repos\n- \`${repo}\`, base \`${base}\`: the repo.\n` : "## Scope\nNo repo yet.\n"}`);
  writeFileSync(join(root, slug, RECORD), JSON.stringify({ slug, archived_at: null }));
}

type Tool = { name: string; parameters: { parse(v: unknown): unknown }; execute(p: unknown, ctx: { threadId: string }): Promise<{ content: { text: string }[]; isError?: boolean }> };
type Route = (c: unknown) => Promise<Response>;

/** The real server against a fake bb: records tools, routes and spawns; one connected host, one bb project for the repo. */
async function server(settings: Record<string, unknown> = {}) {
  const root = scratch("server");
  const projects = join(root, "projects");
  const repo = join(root, "repo");
  mkdirSync(projects, { recursive: true });
  mkdirSync(repo);
  const db = Object.assign(new DatabaseSync(join(root, "data.db")), { name: join(root, "data.db") });
  const tools = new Map<string, Tool>();
  const routes = new Map<string, Route>();
  const spawns: Record<string, any>[] = [];
  const sends: Record<string, any>[] = [];
  let cli: any;
  let instructions: (c: { threadId: string }) => string | null = () => null;
  const threadRows = new Map<string, any>();
  const metadata: any[] = [];
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : noop), apply: () => noop });
  const sdk = {
    environments: { get: async () => ({ hostId: "host-1" }) },
    providers: { models: async () => ({ modelLoadError: null, providers: [{ id: "claude-code", available: true }, { id: "codex", available: true }], models: ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-astra"].map((model) => ({ id: model, model, reasoningDiscovery: "known", supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "medium" }] })) }) },
    hosts: { list: async () => [{ id: "host-1", status: "connected", lifecycle: { phase: "active" } }] },
    projects: { list: async () => [{ id: "bbp-1", name: "repo", sources: [{ hostId: "host-1", path: repo }] }], create: noop, get: noop },
    threads: {
      spawn: async (a: Record<string, any>) => {
        spawns.push(a);
        return { id: `T-${spawns.length}`, environmentId: `env-${spawns.length}` };
      },
      send: async (input: Record<string, any>) => { sends.push(input); return { delivery: "sent" }; },
      queuedMessages: { list: async () => [] },
      updatePluginMetadata: async (p: any) => { metadata.push(p); return {}; },
      get: async ({ threadId }: { threadId: string }) => threadRows.get(threadId) ?? ({ id: threadId, projectId: "bbp-1", environmentId: "env-lead", status: "idle", archivedAt: null, parentThreadId: null }),
      list: async () => [],
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
              Object.assign(v, { stateDir: join(root, "state"), projectsDir: projects, projectRecord: RECORD, memoryConfig: "", diskPath: root, ownerName: "", ...settings });
              return { get: async () => v, onChange: () => {} };
            },
          };
        if (k === "storage") return { database: () => db, kv: noop };
        if (k === "agents") return new Proxy({ registerTool: (t: Tool) => tools.set(t.name, t), contributeInstructions: (f: any) => { instructions = f; } }, { get: (a: any, n) => a[n] ?? noop });
        if (k === "cli") return { register: (c: any) => { cli = c.run; } };
        if (k === "http") return { route: (_m: string, path: string, h: Route) => routes.set(path, h) };
        if (k === "sdk") return new Proxy(sdk, { get: (s: any, n) => s[n] ?? noop });
        if (k === "background") return { service: () => {} };
        if (k === "log") return { info: () => {}, warn: () => {}, error: () => {} };
        return noop;
      },
    },
  );
  await plugin(bb);
  const engine = new Engine(db as never, ports, {});
  /** The owner's Start lead button: a POST from the app's own screen. */
  const button = async (slug: string) => {
    const c = {
      req: { url: "http://app.test/x", header: (n: string) => ({ origin: "http://app.test", "sec-fetch-site": "same-origin" })[n.toLowerCase()], json: async () => ({ slug }) },
      json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
    };
    const res = await routes.get(WRITES.startLead)!(c);
    return (await res.json()) as { ok: boolean; result?: { address: string }; error?: { kind: string; message: string } };
  };
  /** An agent's tool call, its raw arguments parsed by the tool's own schema as bb does. */
  const call = async (name: string, raw: unknown, threadId: string) => {
    const t = tools.get(name)!;
    const r = await t.execute(t.parameters.parse(raw), { threadId });
    return { ok: !r.isError, text: r.content[0]!.text };
  };
  return { root, projects, repo, engine, tools, spawns, sends, db, button, call, instructions: (threadId: string) => instructions({ threadId }), threadRows, metadata, cli: (args: string[], threadId: string | null = null) => cli(args, { threadId, cwd: root }) };
}

const cosStarted = (e: Engine, address: string) => e.board().find((b) => b.title === `cos started ${address}`);

test("the CoS gets both tools; nobody else can use them", async () => {
  const s = await server();
  s.engine.register("T-cos", "cos", null);
  s.engine.register("T-lead", "lead", "other");
  projectFolder(s.projects, "alpha", s.repo);
  for (const [tool, args] of [["orch_start_lead", { slug: "alpha" }], ["orch_new_project", { brief: { slug: "beta", title: "B", repo: s.repo, goal: "g" } }]] as const) {
    assert.deepEqual(await s.call(tool, args, "T-lead"), { ok: false, text: "forbidden: CoS only" }, `${tool}: a lead is refused`);
    assert.match((await s.call(tool, args, "T-stranger")).text, /^forbidden: this thread has no orchestrator role/, `${tool}: a thread with no role is refused`);
  }
  assert.equal(s.spawns.length, 0, "nothing started");
  assert.ok(!existsSync(join(s.projects, "beta")), "nothing created");
  // bb turns each tool's parameters into JSON Schema for the agent (io: input); a schema it can't convert fails activation
  for (const name of ["orch_start_lead", "orch_new_project"]) {
    const js = z.toJSONSchema(s.tools.get(name)!.parameters as never, { io: "input" }) as { required?: string[] };
    assert.deepEqual(js.required ?? [], [], `${name}: every parameter is optional, so a stale or partial call reaches the tool's own refusal`);
  }
});

test("orch_start_lead refuses exactly what the Start lead button refuses, with the same reason, before any spawn", async () => {
  const s = await server();
  s.engine.register("T-cos", "cos", null);
  projectFolder(s.projects, "norepo", null);
  projectFolder(s.projects, "gone", join(s.root, "no-such-repo"));
  projectFolder(s.projects, "held", s.repo);
  s.engine.ensureProject("held", null);
  s.engine.setHold("held", true);
  projectFolder(s.projects, "running", s.repo);
  s.engine.register("T-running", "lead", "running");
  const cases: [string, string, RegExp][] = [
    ["nofolder", "not_found", /nofolder has no project folder/],
    ["norepo", "bad_state", /PROJECT\.md names no repo/],
    ["gone", "bad_state", /repo .*no-such-repo isn't on this machine/],
    ["held", "bad_state", /held is on hold: resume it first/],
    ["running", "conflict", /lead:running is already running/],
    ["Not A Slug", "invalid", /bad project slug/],
  ];
  for (const [slug, kind, why] of cases) {
    const viaButton = await s.button(slug);
    const viaCos = await s.call("orch_start_lead", { slug }, "T-cos");
    assert.equal(viaButton.ok, false, `${slug}: the button refuses`);
    assert.equal(viaButton.error!.kind, kind, `${slug}: the button's refusal kind`);
    assert.match(viaButton.error!.message, why, `${slug}: the button's reason`);
    assert.deepEqual(viaCos, { ok: false, text: viaButton.error!.message }, `${slug}: the CoS gets the button's refusal word for word`);
  }
  assert.equal(s.spawns.length, 0, "no refusal spawned anything");
});

test("a CoS start and an owner start spawn the same lead; only who started it differs, on the board and in the history", async () => {
  const s = await server();
  s.engine.register("T-cos", "cos", null);
  projectFolder(s.projects, "alpha", s.repo);
  projectFolder(s.projects, "beta", s.repo);

  const r = await s.call("orch_start_lead", { slug: "alpha" }, "T-cos");
  assert.ok(r.ok, r.text);
  assert.match(r.text, /^Started lead:alpha \(T-1\)/);
  const b = await s.button("beta");
  assert.ok(b.ok && b.result!.address === "lead:beta");

  const [cos, person] = s.spawns;
  for (const [sp, slug] of [[cos, "alpha"], [person, "beta"]] as const) {
    assert.deepEqual(sp!.environment, { type: "host", hostId: "host-1", workspace: { type: "unmanaged", path: join(s.projects, slug) } }, `${slug}: runs in its project folder`);
    assert.equal(sp!.projectId, "bbp-1", `${slug}: in the repo's bb project`);
    assert.deepEqual(sp!.pluginMetadata, { role: "lead", project: slug });
    assert.match(sp!.prompt, new RegExp(`worktree of ${s.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Base branch: dev\\.`), `${slug}: the lead brief names its repo and base`);
  }
  assert.equal(cos!.prompt.replaceAll("alpha", "X"), person!.prompt.replaceAll("beta", "X"), "the same brief either way");
  assert.equal(cos!.model, person!.model);

  const n = cosStarted(s.engine, "lead:alpha");
  assert.ok(n, "the board shows cos started lead:alpha");
  assert.equal(n!.from, "cos");
  assert.equal(n!.project, "alpha");
  const own = s.engine.board().find((x) => x.title === "Started lead:beta");
  assert.ok(own && own.from === "person", "the button's notice is unchanged");
  assert.ok(!cosStarted(s.engine, "lead:beta"));

  const db = (s.engine as unknown as { db: DatabaseSync }).db;
  const note = (address: string) => (db.prepare(`SELECT note FROM events WHERE kind = 'spawn' AND address = ?`).get(address) as { note: string }).note;
  assert.equal(note("lead:alpha"), "started by cos");
  assert.equal(note("lead:beta"), "started by person");

  assert.deepEqual(await s.call("orch_start_lead", { slug: "alpha" }, "T-cos"), { ok: false, text: `conflict: lead:alpha is already running (unknown, thread T-1)` }, "a second start is refused");
  assert.equal(s.spawns.length, 2);
});

test("a CoS start of an archived project's lead brings the project back, said as the CoS's doing", async () => {
  const s = await server();
  s.engine.register("T-cos", "cos", null);
  projectFolder(s.projects, "alpha", s.repo);
  s.engine.register("T-old", "lead", "alpha");
  s.engine.archiveProject("alpha");
  assert.ok((await s.call("orch_start_lead", { slug: "alpha" }, "T-cos")).ok);
  const back = s.engine.board().find((x) => x.title === "alpha brought back");
  assert.equal(back?.from, "cos");
});

test("orch_start_lead with no slug says what to give, and stale schemas' JSON-string briefs still create a project", async () => {
  const s = await server();
  s.engine.register("T-cos", "cos", null);
  assert.deepEqual(await s.call("orch_start_lead", {}, "T-cos"), { ok: false, text: "invalid: give slug: the project to start the lead of" });
  assert.match((await s.call("orch_new_project", {}, "T-cos")).text, /^invalid: give brief/);

  const brief = JSON.stringify({ slug: "gamma", title: "Gamma", repo: s.repo, goal: "Ship gamma.", constraints: JSON.stringify(["No prod changes.", "No /tmp caches."]), priority: "high" });
  const r = await s.call("orch_new_project", { brief }, "T-cos");
  assert.ok(r.ok, r.text);
  assert.match(r.text, /^Created gamma \(priority high\)/);
  assert.match(readFileSync(join(s.projects, "gamma", "PROJECT.md"), "utf8"), /## Limits\n- No prod changes\.\n- No \/tmp caches\./);
  assert.equal(s.engine.project("gamma")?.priority, "high");
  const n = s.engine.board().find((x) => x.title === "cos created project gamma");
  assert.equal(n?.from, "cos");
  assert.equal(s.spawns.length, 0, "creating a project starts no lead");

  // the new project is one the button and the CoS can start
  const started = await s.call("orch_start_lead", { slug: "gamma" }, "T-cos");
  assert.ok(started.ok, started.text);
  assert.equal(s.spawns[0]!.environment.workspace.path, join(s.projects, "gamma"));
});

// ---------------------------------------------------------------- newProject, the core

function core(over: Partial<NewProjectPorts> = {}) {
  const root = scratch("core");
  const repo = join(root, "repo");
  mkdirSync(repo);
  const engine = new Engine(new DatabaseSync(":memory:") as never, ports, {});
  const p: NewProjectPorts = { engine, root: join(root, "projects"), record: RECORD, memoryFolder: () => undefined, now: ports.now(), by: "cos", ...over };
  const brief = { slug: "delta", title: "Delta", repo, goal: "Build delta.", base: "main", constraints: ["No prod."], priority: "normal" };
  return { root, repo, engine, p, brief };
}

const refused = (kind: string, why: RegExp) => (e: unknown) => e instanceof EngineError && e.kind === kind && why.test(e.message);

test("newProject writes the folder in the existing projects' shape, the row and one notice", () => {
  const { engine, p, brief, repo } = core();
  const r = newProject(p, { ...brief, repo_url: "https://git.example.com/acme/delta.git" });
  const folder = join(p.root, "delta");
  assert.equal(r.folder, folder);
  assert.deepEqual(readdirSync(folder).sort(), ["PROJECT.md", "library", "memory", RECORD, "scratch"]);
  const rec = JSON.parse(readFileSync(join(folder, RECORD), "utf8"));
  assert.deepEqual(Object.keys(rec), ["slug", "name", "dir", "repo", "created_at", "archived_at", "on_hold"], "the record's keys, in the real records' order");
  assert.deepEqual(rec, { slug: "delta", name: "Delta", dir: folder, repo: { path: repo, base: "main" }, created_at: "2026-11-16T10:00:00.000Z", archived_at: null, on_hold: null });
  const md = readFileSync(join(folder, "PROJECT.md"), "utf8");
  assert.match(md, /^# Delta \(delta\)\n\n## Goal\nBuild delta\.\n\n## Repos\n/);
  assert.match(md, /Remote: https:\/\/git\.example\.com\/acme\/delta\.git\./);
  assert.match(md, /## Limits\n- No prod\.\n/);
  assert.deepEqual(primaryRepo(md), { path: repo, base: "main" }, "Start lead reads back the repo and base");
  assert.deepEqual(liveProjects(p.root, RECORD), ["delta"], "it shows in Projects with its Start lead button");
  assert.equal(engine.project("delta")?.priority, "normal");
  const notices = engine.board().filter((b) => b.project === "delta");
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.title, "cos created project delta");
  assert.equal(notices[0]!.from, "cos");
});

test("newProject refuses an incomplete or malformed brief, naming the field", () => {
  const { p, brief, root } = core();
  writeFileSync(join(root, "a-file"), "");
  const cases: [Record<string, unknown>, string, RegExp][] = [
    [{}, "invalid", /the brief needs slug, title, repo, goal/],
    [{ ...brief, goal: "  " }, "invalid", /the brief needs goal/],
    [{ ...brief, slug: "Bad Slug" }, "invalid", /slug Bad Slug/],
    [{ ...brief, slug: "x".repeat(41) }, "invalid", /at most 40 characters/],
    [{ ...brief, title: "two\nlines" }, "invalid", /title: one line/],
    [{ ...brief, repo: "https://git.example.com/acme/delta.git" }, "invalid", /is a URL: clone it first and pass the local path/],
    [{ ...brief, repo: "git@example.com:acme/delta.git" }, "invalid", /is a URL: clone it first/],
    [{ ...brief, repo: "relative/path" }, "invalid", /absolute path/],
    [{ ...brief, repo: join(root, "no-such-repo") }, "not_found", /no-such-repo doesn't exist on this machine/],
    [{ ...brief, repo: join(root, "a-file") }, "invalid", /isn't a folder/],
    [{ ...brief, repo_url: "not a url" }, "invalid", /repo_url/],
    [{ ...brief, base: "bad branch" }, "invalid", /base: a branch name/],
    [{ ...brief, goal: "Do it.\n## Repos\n- `/elsewhere`" }, "invalid", /goal: no markdown headings/],
    [{ ...brief, constraints: [1, 2] }, "invalid", /constraints: a list/],
    [{ ...brief, constraints: ["fine", "two\n## Repos\n- `/elsewhere`"] }, "invalid", /constraints: a list of one-line strings/],
    [{ ...brief, constraints: "[not json" }, "invalid", /constraints: a list/],
    [{ ...brief, priority: "asap" }, "invalid", /priority is one of urgent, high, normal, low/],
  ];
  for (const [b, kind, why] of cases) assert.throws(() => newProject(p, b), refused(kind, why), JSON.stringify(b).slice(0, 80));
  assert.throws(() => newProject({ ...p, record: "../x.json" }, brief), refused("bad_state", /projectRecord/));
  assert.ok(!existsSync(p.root) || readdirSync(p.root).length === 0, "a refused brief leaves nothing behind");
});

test("newProject never takes a slug that is already used: a folder (even empty), a memory project, or a project row (archived too)", () => {
  const { engine, p, brief, root } = core();
  mkdirSync(join(p.root, "delta"), { recursive: true });
  assert.throws(() => newProject(p, brief), refused("conflict", /delta already exists/), "an empty folder is not overwritten");
  rmSync(join(p.root, "delta"), { recursive: true });

  const mem = join(root, "memory-root", "delta");
  assert.throws(() => newProject({ ...p, memoryFolder: (s) => (s === "delta" ? mem : undefined) }, brief), refused("conflict", /already a memory project/));

  engine.register("T-old", "lead", "delta");
  engine.archiveProject("delta");
  assert.throws(() => newProject(p, brief), refused("conflict", /delta is already a project/), "an archived project keeps its slug");
  assert.deepEqual(readdirSync(p.root), [], "no folder, no temporary folder left behind");
  assert.equal(engine.board().filter((b) => b.title.startsWith("cos created")).length, 0, "no notice for a refusal");
});

test("a second newProject for the same slug is refused and leaves the first untouched", () => {
  const { p, brief } = core();
  newProject(p, brief);
  const before = readFileSync(join(p.root, "delta", "PROJECT.md"), "utf8");
  assert.throws(() => newProject(p, { ...brief, title: "Other", goal: "Other." }), refused("conflict", /already exists/));
  assert.equal(readFileSync(join(p.root, "delta", "PROJECT.md"), "utf8"), before);
});

test("constraints given as lines, and no base, still make a project Start lead can read", () => {
  const { p, brief, repo } = core();
  const { base: _b, ...rest } = brief;
  newProject(p, { ...rest, constraints: "- one\n* two\n\nthree" });
  const md = readFileSync(join(p.root, "delta", "PROJECT.md"), "utf8");
  assert.match(md, /## Limits\n- one\n- two\n- three\n/);
  assert.deepEqual(primaryRepo(md), { path: repo, base: null });
  assert.equal(JSON.parse(readFileSync(join(p.root, "delta", RECORD), "utf8")).repo.base, null);
});


test("batchInbox on: quiet INFO, snapshot ack and non-steering wake", async () => {
  const s = await server({ batchInbox: true });
  s.engine.register("T-cos", "cos", null);
  s.engine.register("T-lead", "lead", "demo");
  s.engine.setStatus("T-lead", "idle");
  assert.equal((await s.call("orch_send", {to:"lead:demo",text:"quiet",severity:"INFO"}, "T-cos")).ok,true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.sends.length,0);
  await s.call("orch_send", {to:"lead:demo",text:"action",ref:"proof-ref"}, "T-cos");
  s.db.prepare("UPDATE inbox_wakes SET due_at=0").run();
  const digest = JSON.parse((await s.call("orch_inbox", {}, "T-lead")).text);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(digest.count,2); assert.match(digest.text,/proof-ref/);
  assert.equal(s.sends.length,1); assert.equal(s.sends[0]!.mode,"queue-if-active");
  assert.equal((await s.call("orch_ack", {through:digest.cursor}, "T-cos")).ok,false);
  assert.equal((await s.call("orch_ack", {through:digest.cursor}, "T-lead")).ok,true);
  assert.equal(JSON.parse((await s.call("orch_inbox", {}, "T-lead")).text).count,0);
  assert.equal((await s.call("orch_inbox", {wakes:true}, "T-lead")).ok,false);
  assert.equal((await s.call("orch_inbox", {wakes:true}, "T-cos")).ok,true);
});

// An upgrade must not change how any role gets its mail: batching is the owner's choice, never a default.
test("by default the server keeps per-message delivery and today's inbox instructions", async () => {
  const s = await server();
  s.engine.register("T-cos", "cos", null); s.engine.register("T-lead", "lead", "demo");
  await s.call("orch_send",{to:"lead:demo",text:"legacy"},"T-cos");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(s.sends.length,1); assert.equal(s.sends[0]!.mode,"steer-if-active");
  assert.match((await s.call("orch_inbox",{},"T-lead")).text,/Open items/);
  assert.match(s.instructions("T-lead") ?? "", /^\[orchestrator\] Your current inbox \(as of [^)]+\):\nYou are lead:demo\./, "the same instructions as before batching existed");
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM inbox_entries").get() as { n: number }).n, 0, "nothing goes into the batch ledger");
  assert.equal((await s.call("orch_ack", { through: "x" }, "T-lead")).ok, false, "no cursor acks while batching is off");
});

for (const by of ["cos", "person"] as const) {
  test(`${by} starts a Codex lead with the exact configured model and existing gates`, async () => {
    const s = await server({ leadProvider: "codex", leadModel: "gpt-6-astra", leadReasoning: "high" });
    s.engine.register("T-cos", "cos", null);
    projectFolder(s.projects, "alpha", s.repo);
    const start = () => by === "cos" ? s.call("orch_start_lead", { slug: "alpha" }, "T-cos") : s.button("alpha");
    assert.ok((await start()).ok);
    assert.equal(s.spawns[0]!.providerId, "codex");
    assert.equal(s.spawns[0]!.model, "gpt-6-astra");
    assert.equal(s.spawns[0]!.reasoningLevel, "high");
    assert.equal((await start()).ok, false, "a second live lead is still refused");
    assert.equal(s.spawns.length, 1);
  });
}

test("an unavailable configured model does not spawn a fallback lead", async () => {
  const s = await server({ leadProvider: "codex", leadModel: "missing-model" });
  s.engine.register("T-cos", "cos", null);
  projectFolder(s.projects, "alpha", s.repo);
  const result = await s.call("orch_start_lead", { slug: "alpha" }, "T-cos");
  assert.equal(result.ok, false);
  assert.match(result.text, /model missing-model is unavailable/);
  assert.equal(s.spawns.length, 0);
  assert.equal(s.engine.agentByAddress("lead:alpha"), null);
});

test("worker spawn preserves provider, parent and approved-plan count; unavailable model releases reservation", async () => {
  const s = await server();
  const cos = s.engine.register("T-cos", "cos", null);
  const lead = s.engine.register("T-lead", "lead", "alpha");
  const d = s.engine.ask(lead, { title: "Plan", question: "Start one?", options: [{ label: "Go" }, { label: "Wait" }], kind: "plan", threads: 1 });
  const args = { plan: d.id, title: "Worker", prompt: "Test", provider: "codex", model: "gpt-6-astra" };
  assert.equal((await s.call("orch_spawn_thread", args, lead.threadId)).ok, false);
  assert.equal(s.spawns.length, 0);
  s.engine.triageAskPerson(cos, d.id, { question: "Start?", options: [{ label: "Go" }, { label: "Wait" }], allowText: true });
  s.engine.personAnswer(d.id, s.engine.needsYou().cards[0]!.rev, "1", null, "desktop");
  assert.equal((await s.call("orch_spawn_thread", { ...args, model: "missing" }, lead.threadId)).ok, false);
  assert.equal(s.spawns.length, 0);
  const result = await s.call("orch_spawn_thread", args, lead.threadId);
  assert.ok(result.ok, result.text);
  assert.equal(s.spawns[0]!.providerId, "codex");
  assert.equal(s.spawns[0]!.model, "gpt-6-astra");
  assert.equal(s.spawns[0]!.parentThreadId, lead.threadId);
  assert.equal(s.spawns[0]!.environment.workspace.type, "managed-worktree");
  assert.equal((await s.call("orch_spawn_thread", args, lead.threadId)).ok, false);
  assert.equal(s.spawns.length, 1);
});

test("CLI spawn forwards explicit provider/model without a fallback", async () => {
  const s = await server();
  const file = join(s.root, "prompt.md");
  writeFileSync(file, "Test");
  const args = ["spawn", "lead", "alpha", "--project-id", "bbp-1", "--prompt-file", file, "--provider", "codex", "--model", "gpt-6-astra"];
  const result = await s.cli(args);
  assert.equal(result.exitCode ?? 0, 0, result.stderr);
  assert.equal(s.spawns.length, 1);
  assert.equal(s.spawns[0]!.providerId, "codex");
  assert.equal(s.spawns[0]!.model, "gpt-6-astra");
});

test("integration CLI is opt-in, rejects agent callers and preserves idempotent receipts", async () => {
  const s = await server({ integrationRoutes: '{"fleet":["cos"]}' });
  s.engine.register("T-cos", "cos", null);
  const file = join(s.root, "import.json");
  writeFileSync(file, JSON.stringify({ source: "fleet", id: "one", to: "cos", sender: "worker", task: "task", severity: "INFO", summary: "Quiet", createdAt: 1 }));
  assert.equal((await s.cli(["integration", "import", file], "unregistered-agent")).exitCode, 1);
  const first = await s.cli(["integration", "import", file]);
  assert.equal(first.exitCode, 0, first.stderr);
  const second = await s.cli(["integration", "import", file]);
  assert.equal(JSON.parse(first.stdout).itemId, JSON.parse(second.stdout).itemId);
  const receipts = await s.cli(["integration", "receipts", "fleet"]);
  assert.equal(JSON.parse(receipts.stdout).length, 1);
  const disabled = await server();
  assert.equal((await disabled.cli(["integration", "import", file])).exitCode, 1);
  assert.equal((await s.cli(["adopt", "T-worker", "thread", "--project", "alpha", "--parent", "T-lead", "--approval", "test"], "unregistered-agent")).exitCode, 1);
});

test("operator adopts existing parented lead and worker through the CLI without spawning or reparenting", async () => {
  const s = await server();
  s.engine.register("T-cos", "cos", null);
  for (const [id, parent] of [["T-lead", "T-cos"], ["T-worker", "T-lead"]]) s.threadRows.set(id, { id, parentThreadId: parent, projectId: "bbp-1", environmentId: `env-${id}`, status: "idle", archivedAt: null });
  for (const [id, role, parent] of [["T-lead", "lead", "T-cos"], ["T-worker", "thread", "T-lead"]]) {
    const args = ["adopt", id!, role!, "--project", "alpha", "--parent", parent!, "--approval", "approved-map"];
    const first = await s.cli(args);
    assert.equal(first.exitCode, 0, first.stderr);
    assert.equal((await s.cli(args)).stdout, first.stdout);
    assert.equal(s.engine.agentByThread(id!)!.parentThreadId, parent);
    assert.equal(s.engine.agentByThread(id!)!.environmentId, `env-${id}`);
  }
  assert.equal(s.spawns.length, 0);
  assert.equal(s.engine.board().filter((b) => b.title.startsWith("Adopted ")).length, 2);
  assert.equal(s.metadata.length, 4);
  assert.match((await s.cli(["status"])).stdout, /T-worker parent=T-lead/);
});
