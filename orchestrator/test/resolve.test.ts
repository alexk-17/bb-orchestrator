// orch_resolve and orch_handoff against a fake bb host, through the real server entry. Requested 2026-11-14: resolve
// archives a clean thread and refuses a dirty one with the reason (a branch merged locally, without a PR, counts);
// a handoff hides its stopped predecessor at once, and resolving the successor archives both, predecessor first, so
// the shared worktree goes only once.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../server.ts";
import { Engine } from "../core/engine.ts";

type Thread = { id: string; projectId: string; environmentId: string | null; title: string; lastReadAt: number | null; latestAttentionAt: null; status: string; archivedAt: number | null };
type Tool = { name: string; execute: (p: unknown, ctx: { threadId: string }) => Promise<{ content: { text: string }[]; isError?: boolean }> };

/** bb--git workspaceStatus for a worktree with these uncommitted files and this many commits not in `base`. */
const status = (files: string[], ahead: number, base = "main") => ({
  outcome: "available",
  workspace: {
    workingTree: { hasUncommittedChanges: files.length > 0, state: files.length ? "dirty" : "clean", fileCount: files.length, files: files.map((path) => ({ path })) },
    checkout: { kind: "branch", branchName: "feat" },
    branch: { currentBranch: "feat", defaultBranch: "main" },
    mergeBase: { mergeBaseBranch: base, aheadCount: ahead, hasCommittedUnmergedChanges: ahead > 0, squashMergeCheckComplete: true, commits: Array.from({ length: ahead }, (_, i) => ({ shortSha: `c${i}`, subject: `work ${i}` })) },
  },
});

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** The real plugin on a fake host: lead T-lead and its thread T-w (thread:demo:1) in env E1, merged locally into main. */
async function host() {
  const root = mkdtempSync(join(tmpdir(), "orch-resolve-"));
  roots.push(root);
  const worktree = join(root, "wt");
  mkdirSync(worktree);
  const db = Object.assign(new DatabaseSync(join(root, "data.db")), { name: join(root, "data.db") });
  const pre = new Engine(db as never, { now: Date.now, deliver: async () => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  pre.register("T-lead", "lead", "demo");
  pre.register("T-w", "thread", "demo", "T-lead");
  pre.setEnvironment("T-w", "E1");
  pre.report(pre.agentByThread("T-w")!, "Done", "merged into main", null); // a local merge resolves once the thread reported
  const threads = new Map<string, Thread>();
  const th = (id: string, environmentId: string | null) => threads.set(id, { id, projectId: "P1", environmentId, title: id, lastReadAt: null, latestAttentionAt: null, status: "idle", archivedAt: null });
  th("T-lead", "E0");
  th("T-w", "E1");
  // a reading, or a function of the workspaceStatus input (the base it compares with)
  const git = { E1: status([], 0) as unknown };
  const remotes: string[] = []; // none: a local-only repo
  const cap = { n: 1000 };
  const prs: Record<string, unknown> = {}; // no PR: this project merges locally
  const rec = { archived: [] as string[], hidden: [] as string[], stopped: [] as string[], prompts: [] as string[], parented: [] as { threadId: string; parentThreadId: string; parentNotifications?: string }[] };
  const tools = new Map<string, Tool>();
  let cliRun: ((argv: string[], ctx: { threadId: string | null; cwd: string | null }) => Promise<{ exitCode: number; stdout: string; stderr?: string }>) | null = null;
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : noop), apply: () => noop });
  const sdk = {
    providers: { models: async () => ({ modelLoadError: null, providers: [{ id: "codex", available: true }], models: [{ id: "gpt-6-astra", model: "gpt-6-astra", isDefault: true }] }) },
    threads: {
      get: async ({ threadId }: { threadId: string }) => {
        const t = threads.get(threadId);
        if (!t) throw new Error(`no thread ${threadId}`);
        return t;
      },
      archive: async ({ threadId }: { threadId: string }) => {
        rec.archived.push(threadId);
        threads.get(threadId)!.archivedAt = Date.now();
        return { ok: true, archivedThreadIds: [threadId] };
      },
      update: async (u: { threadId: string; visibility?: string; parentThreadId?: string; parentNotifications?: string }) => {
        if (u.visibility === "hidden") rec.hidden.push(u.threadId);
        if (u.parentThreadId) rec.parented.push({ threadId: u.threadId, parentThreadId: u.parentThreadId, parentNotifications: u.parentNotifications });
        return {};
      },
      stop: async ({ threadId }: { threadId: string }) => void rec.stopped.push(threadId),
      spawn: async ({ prompt }: { prompt: string }) => {
        rec.prompts.push(prompt);
        th("T-succ", "E1");
        return { id: "T-succ" };
      },
      updatePluginMetadata: async () => ({}),
    },
    environments: { get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, path: worktree, mergeBaseBranch: null }) },
    plugins: {
      callRpc: async ({ pluginId, method, input }: { pluginId: string; method: string; input: { environmentId?: string } }) => {
        if (pluginId === "bb--github-pr-status") return prs;
        if (pluginId !== "bb--git") throw new Error(`unexpected rpc ${pluginId}.${method}`);
        if (method === "refresh") return { ok: true };
        // like bb--git: at most `cap` rows unless a query names the branch
        if (method === "branches") return { branches: ["main", "feat"], remoteBranches: (input as { query?: string }).query ? remotes.filter((r) => r.includes((input as { query: string }).query)) : remotes.slice(0, cap.n) };
        if (method === "workspaceStatus") {
          const g = git[input.environmentId as "E1"];
          return typeof g === "function" ? g(input) : g;
        }
        throw new Error(`unexpected ${method}`);
      },
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
              Object.assign(v, { stateDir: join(root, "state"), projectsDir: join(root, "projects"), memoryConfig: "", diskPath: root });
              return { get: async () => v, onChange: () => {} };
            },
          };
        if (k === "storage") return { database: () => db, kv: noop };
        if (k === "agents") return { registerTool: (t: Tool) => tools.set(t.name, t), configure: () => {}, contributeInstructions: () => {} };
        if (k === "sdk") return sdk;
        if (k === "cli") return { register: (c: { run: typeof cliRun }) => (cliRun = c.run) };
        return noop;
      },
    },
  );
  await plugin(bb);
  const call = async (name: string, p: unknown) => (await tools.get(name)!.execute(p, { threadId: "T-lead" })).content[0]!.text;
  const roleOf = (id: string) => (db.prepare("SELECT retired_at FROM agents WHERE thread_id = ?").get(id) as { retired_at: number | null }).retired_at === null;
  const cli = async (argv: string[], threadId: string | null) => {
    const r = await cliRun!(argv, { threadId, cwd: null });
    return { stdout: r.stdout, stderr: r.stderr ?? "" };
  };
  return { call, cli, rec, git, remotes, cap, prs, roleOf, worktree, threads, pre, db, root };
}

test("a dirty worktree is refused with the reason, and nothing is archived", async () => {
  const h = await host();
  h.git.E1 = status(["src/a.ts"], 2);
  const out = await h.call("orch_resolve", { to: "thread:demo:1" });
  assert.match(out, /isn't clean: uncommitted changes in 1 file\(s\): src\/a\.ts/);
  assert.deepEqual(h.rec.archived, []);
  assert.equal(h.roleOf("T-w"), true, "the thread keeps its role to finish the work");
  h.git.E1 = status([], 2);
  assert.match(await h.call("orch_resolve", { to: "thread:demo:1" }), /2 commit\(s\) not in main and there is no remote: c0 work 0, c1 work 1/);
  assert.deepEqual(h.rec.archived, []);
});

test("a clean thread merged locally, with no PR and its report unread, is resolved and archived", async () => {
  const h = await host();
  const out = await h.call("orch_resolve", { to: "thread:demo:1" });
  assert.match(out, /Resolved thread:demo:1 \(its branch is in main/);
  assert.deepEqual(h.rec.archived, ["T-w"]);
  assert.equal(h.roleOf("T-w"), false);
});

test("untracked handoff-*.md and report.md don't block resolve; archiving keeps copies of them and of outputs recorded in the worktree", async () => {
  const h = await host();
  writeFileSync(join(h.worktree, "handoff-2026-11-14.md"), "# handoff\n");
  writeFileSync(join(h.worktree, "report.md"), "# report\n");
  writeFileSync(join(h.worktree, "proof.png"), "png");
  const notes = [{ path: "handoff-2026-11-14.md", status: "??" }, { path: "report.md", status: "??" }];
  const s = status([], 0) as any;
  Object.assign(s.workspace.workingTree, { hasUncommittedChanges: true, state: "untracked", fileCount: 2, files: notes });
  h.git.E1 = s;
  const { output } = h.pre.addOutput(h.pre.agentByThread("T-w")!, { title: "proof", kind: "image", path: join(h.worktree, "proof.png"), url: null, note: null }, { roots: [h.worktree], hostId: "H1" });
  const out = await h.call("orch_resolve", { to: "thread:demo:1" });
  assert.match(out, /Resolved thread:demo:1 .*Archived T-w\./);
  // bb removes the worktree about 5 minutes after the archive: the notes and the output must survive it
  const kept = join(h.root, "state", "threads", "T-w");
  assert.equal(readFileSync(join(kept, "handoff-2026-11-14.md"), "utf8"), "# handoff\n");
  assert.equal(readFileSync(join(kept, "report.md"), "utf8"), "# report\n");
  const moved = (h.db.prepare("SELECT path FROM outputs WHERE id = ?").get(output.id) as { path: string }).path;
  assert.equal(moved, join(kept, "outputs", "proof.png"), "the Outputs tab opens the copy, not the worktree");
  assert.equal(readFileSync(moved, "utf8"), "png");
  const row = h.db.prepare("SELECT body FROM board WHERE kind = 'archived' AND ref = 'T-w'").get() as { body: string };
  assert.match(row.body, /Kept handoff-2026-11-14\.md, report\.md, 1 output\(s\) in .*threads\/T-w\./);
  rmSync(h.worktree, { recursive: true });
  assert.ok(existsSync(moved), "the copy outlives the worktree");
});

test("any other untracked file still refuses, naming it, and nothing is copied or archived", async () => {
  const h = await host();
  const s = status([], 0) as any;
  Object.assign(s.workspace.workingTree, { hasUncommittedChanges: true, state: "untracked", fileCount: 2, files: [{ path: "report.md", status: "??" }, { path: "scratch.log", status: "??" }] });
  h.git.E1 = s;
  assert.match(await h.call("orch_resolve", { to: "thread:demo:1" }), /isn't clean: uncommitted changes in 1 file\(s\): scratch\.log/);
  assert.deepEqual(h.rec.archived, []);
  assert.equal(existsSync(join(h.root, "state", "threads", "T-w")), false);
});

test("a thread bb already archived, or with no worktree, isn't refused for good: nothing there is left to lose", async () => {
  const h = await host();
  h.git.E1 = { outcome: "unavailable", reason: "missing", message: "the worktree is gone" };
  h.threads.get("T-w")!.lastReadAt = Date.now() + 1000; // the owner read its report: the gate passes, only the worktree check is left
  assert.match(await h.call("orch_resolve", { to: "thread:demo:1" }), /isn't clean: its git status is unavailable \(the worktree is gone\)/);
  h.threads.get("T-w")!.archivedAt = Date.now();
  assert.match(await h.call("orch_resolve", { to: "thread:demo:1" }), /Resolved thread:demo:1 .*bb already archived it.*\. bb had already archived it\. Post an update with orch_status/);
  assert.deepEqual(h.rec.archived, [], "bb archived it already: no second archive");
  assert.equal(h.roleOf("T-w"), false);
});

test("a handoff hides its predecessor at once; resolving the successor archives both, predecessor first", async () => {
  const h = await host();
  writeFileSync(join(h.worktree, "handoff-2026-11-14.md"), "# handoff\n");
  const out = await h.call("orch_handoff", { to: "thread:demo:1", file: "handoff-2026-11-14.md", provider: "codex" });
  assert.match(out, /T-w is stopped and hidden/);
  assert.deepEqual(h.rec.stopped, ["T-w"]);
  assert.deepEqual(h.rec.hidden, ["T-w"], "the stopped predecessor leaves the sidebar now, not at resolve");
  assert.deepEqual(h.rec.archived, [], "and is not archived: it shares the successor's worktree");
  assert.doesNotMatch(h.rec.prompts[0]!, /scoping thread/, "a thread started for no scoping task isn't told it is one");
  // the successor gets the level orch_spawn_thread sets: under "auto", bb woke the lead at every turn end of a
  // handed-off successor (seen live, 2026-11-24), outside the plugin's inbox and its wake gap
  assert.deepEqual(h.rec.parented, [{ threadId: "T-succ", parentThreadId: "T-lead", parentNotifications: "stuck" }]);
  const res = await h.call("orch_resolve", { to: "thread:demo:1" });
  assert.match(res, /Archived T-w, T-succ/);
  assert.deepEqual(h.rec.archived, ["T-w", "T-succ"]);
});

// 1.13.0: a scoping thread handed to another provider must still know it is one (read-only, questions to its lead,
// findings in one file); without the section the successor would take the handoff file as build work.
test("a handoff of a scoping thread keeps the scoping text in its successor's prompt, and the successor plans the task", async () => {
  const h = await host();
  const lead = h.pre.agentByThread("T-lead")!;
  const t = h.pre.openTask(lead, "Export format");
  h.db.prepare(`INSERT INTO spawns (thread_id, plan_id, via, lead, created_at, scope_task) VALUES ('T-w', NULL, 'plan', 'lead:demo', ?, ?)`).run(Date.now(), t.id);
  assert.equal(h.pre.taskPlanner(t.id)?.threadId, "T-w");
  writeFileSync(join(h.worktree, "handoff-2026-11-14.md"), "# handoff\n");
  assert.match(await h.call("orch_handoff", { to: "thread:demo:1", file: "handoff-2026-11-14.md", provider: "codex" }), /T-w is stopped/);
  const prompt = h.rec.prompts[0]!;
  assert.match(prompt, /^You take over thread:demo:1 \(from thread T-w\)/, "the takeover text comes first");
  assert.match(prompt, new RegExp(`## You are the scoping thread for demo's task "Export format" \\(${t.id}\\)`));
  assert.match(prompt, /read-only investigation/);
  assert.equal(h.pre.taskPlanner(t.id)?.threadId, "T-succ", "the planner the owner sees moves to the successor");
});

test("a handoff of a thread whose scoping task is closed gets no scoping text", async () => {
  const h = await host();
  const lead = h.pre.agentByThread("T-lead")!;
  const t = h.pre.openTask(lead, "Export format");
  h.db.prepare(`INSERT INTO spawns (thread_id, plan_id, via, lead, created_at, scope_task) VALUES ('T-w', NULL, 'plan', 'lead:demo', ?, ?)`).run(Date.now(), t.id);
  h.pre.dropTask(lead, t.id);
  writeFileSync(join(h.worktree, "handoff-2026-11-14.md"), "# handoff\n");
  await h.call("orch_handoff", { to: "thread:demo:1", file: "handoff-2026-11-14.md", provider: "codex" });
  assert.doesNotMatch(h.rec.prompts[0]!, /scoping thread/, "the task is over: the thread is an ordinary one now");
});

test("the sweep lists retired threads clean or dirty, refuses agents, and --apply hides predecessors and archives the clean", async () => {
  const h = await host();
  writeFileSync(join(h.worktree, "handoff-2026-11-14.md"), "# handoff\n");
  await h.call("orch_handoff", { to: "thread:demo:1", file: "handoff-2026-11-14.md", provider: "codex" });
  h.rec.hidden.length = 0;
  const agent = await h.cli(["sweep"], "T-lead");
  assert.match(agent.stderr, /agents don't sweep threads/);
  const list = await h.cli(["sweep"], null);
  assert.match(list.stdout, /T-w +thread:demo:1 +handoff predecessor .* clean: its branch is in main/);
  assert.match(list.stdout, /1 thread\(s\); --apply/);
  assert.deepEqual([h.rec.hidden, h.rec.archived], [[], []], "the listing changes nothing");
  const applied = await h.cli(["sweep", "--apply"], null);
  assert.match(applied.stdout, /applied: hid 1, archived 1/);
  assert.deepEqual([h.rec.hidden, h.rec.archived], [["T-w"], ["T-w"]]);
});

// agent-v2's lead still runs with the 1.2 schema, where rule_id is required: it can send an empty one
test("orch_answer through the real tool: an empty rule_id and a note settle the card as the lead's own call", async () => {
  const h = await host();
  const d = h.pre.ask(h.pre.agentByThread("T-w")!, { title: "Ticket?", question: "Ticket it?", options: [{ label: "Yes" }, { label: "No" }] });
  assert.match(await h.call("orch_answer", { id: d.id, rule_id: "", option: "1" }), /note/);
  assert.match(await h.call("orch_answer", { id: d.id, rule_id: "", option: "1", note: "follow-ups get tickets" }), new RegExp(`Settled ${d.id}`));
  assert.equal(h.pre.decision(d.id)!.answer!.via, "lead");
});

// The threads ported from the old tool (agent-v2, 2026-11-15): every worktree of the monorepo shares one .git, whose local dev
// was far behind origin/dev, so each branch read as thousands of commits "not in dev" and resolve refused.
test("a branch is compared with origin's copy of its base, never a stale local base branch", async () => {
  const h = await host();
  h.remotes.push("origin/main");
  h.git.E1 = (input: { mergeBaseBranch?: string }) => (input.mergeBaseBranch === "origin/main" ? status([], 0, "origin/main") : status([], 7171));
  assert.match(await h.call("orch_resolve", { to: "thread:demo:1" }), /Resolved thread:demo:1 \(its branch is in origin\/main/);
  assert.deepEqual(h.rec.archived, ["T-w"]);
});

test("against origin's base, work that is really unmerged and unpushed is still refused", async () => {
  const h = await host();
  h.remotes.push("origin/main");
  h.git.E1 = (input: { mergeBaseBranch?: string }) => (input.mergeBaseBranch === "origin/main" ? status([], 1, "origin/main") : status([], 5346));
  assert.match(await h.call("orch_resolve", { to: "thread:demo:1" }), /1 commit\(s\) not in origin\/main and feat isn't pushed: c0 work 0/);
  assert.deepEqual(h.rec.archived, []);
});

// thread:agent-v2:4: PR 1179 was closed unmerged on 11-12, its fix landed through another PR, and the thread
// reported; resolve still refused because the PR wasn't merged and the owner hadn't read the report.
test("a PR closed without merging resolves once the thread has reported", async () => {
  const h = await host();
  h.remotes.push("origin/feat");
  // pushed, but not in main: only the PR (or the owner's read) can settle it
  h.git.E1 = (input: { mergeBaseBranch?: string }) => (input.mergeBaseBranch === "origin/feat" ? status([], 0, "origin/feat") : status([], 3));
  h.prs.E1 = { outcome: "available", pullRequest: { url: "https://github.com/o/r/pull/9", number: 9, state: "open", attention: "none", checks: { state: "passing" } } };
  assert.match(await h.call("orch_resolve", { to: "thread:demo:1" }), /hasn't read its last report/, "an open PR still waits");
  h.prs.E1 = { outcome: "available", pullRequest: { url: "https://github.com/o/r/pull/9", number: 9, state: "closed", attention: "closed", checks: { state: "passing" } } };
  assert.match(await h.call("orch_resolve", { to: "thread:demo:1" }), /Resolved thread:demo:1 \(its PR was closed without merging and it has reported/);
  assert.deepEqual(h.rec.archived, ["T-w"]);
});

// The monorepo has more remote branches than bb lists in one page; origin/dev was in it, the branches' copies weren't
test("the base's and the branch's remote copies are found past bb's page of remote branches", async () => {
  const h = await host();
  h.remotes.push("origin/zz-1", "origin/zz-2", "origin/main", "origin/feat");
  h.cap.n = 2;
  h.git.E1 = (input: { mergeBaseBranch?: string }) =>
    input.mergeBaseBranch === "origin/main" ? status([], 4, "origin/main") : input.mergeBaseBranch === "origin/feat" ? status([], 0, "origin/feat") : status([], 7171);
  assert.match(await h.call("orch_resolve", { to: "thread:demo:1" }), /hasn't read its last report/, "compared with origin/main, and seen as pushed: only the PR or a read is missing");
  h.prs.E1 = { outcome: "available", pullRequest: { url: "https://github.com/o/r/pull/9", number: 9, state: "closed", attention: "closed", checks: { state: "passing" } } };
  assert.match(await h.call("orch_resolve", { to: "thread:demo:1" }), /closed without merging and it has reported; worktree clean: its branch is pushed \(origin\/feat\)/);
});

// 2026-11-17 (the owner, via a lead): "we should be allow to close threads with open prs we just need to track them". A
// thread whose open PR someone else now owns resolves with handed_off; the PR is kept on the project page, not lost.
test("an open PR handed off to someone else resolves, and the project lists it under Handed off", async () => {
  const h = await host();
  h.remotes.push("origin/feat");
  h.git.E1 = (input: { mergeBaseBranch?: string }) => (input.mergeBaseBranch === "origin/feat" ? status([], 0, "origin/feat") : status([], 3));
  h.prs.E1 = { outcome: "available", pullRequest: { url: "https://github.com/o/r/pull/9", number: 9, state: "open", attention: "none", checks: { state: "passing" } } };
  // the JSON-string form older agents send
  const out = await h.call("orch_resolve", { to: "thread:demo:1", handed_off: JSON.stringify({ pr: "https://github.com/o/r/pull/9", owner: "Chris", note: "he has the review" }) });
  assert.match(out, /Resolved thread:demo:1 \(its open PR is handed off to Chris/);
  assert.match(out, /PROJECT\.md 'Open PRs handed off'/);
  assert.deepEqual(h.rec.archived, ["T-w"]);
  assert.deepEqual(h.pre.handedOffPrs().get("demo")?.map((x) => [x.pr, x.owner, x.note, x.thread]), [["https://github.com/o/r/pull/9", "Chris", "he has the review", "thread:demo:1"]]);
});

test("an open PR without handed_off is still refused", async () => {
  const h = await host();
  h.remotes.push("origin/feat");
  h.git.E1 = (input: { mergeBaseBranch?: string }) => (input.mergeBaseBranch === "origin/feat" ? status([], 0, "origin/feat") : status([], 3));
  h.prs.E1 = { outcome: "available", pullRequest: { url: "https://github.com/o/r/pull/9", number: 9, state: "open", attention: "none", checks: { state: "passing" } } };
  assert.match(await h.call("orch_resolve", { to: "thread:demo:1" }), /hasn't read its last report/);
  assert.deepEqual(h.rec.archived, []);
  assert.equal(h.pre.handedOffPrs().size, 0);
});

test("handed_off never excuses a dirty worktree: the work would be lost with the thread", async () => {
  const h = await host();
  h.git.E1 = status(["src/a.ts"], 2);
  const out = await h.call("orch_resolve", { to: "thread:demo:1", handed_off: { pr: "https://github.com/o/r/pull/9", owner: "Chris" } });
  assert.match(out, /isn't clean: uncommitted changes in 1 file\(s\): src\/a\.ts/);
  assert.deepEqual(h.rec.archived, []);
  assert.equal(h.roleOf("T-w"), true);
  assert.equal(h.pre.handedOffPrs().size, 0);
});
