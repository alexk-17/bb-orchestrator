// bb-plugin-orchestrator, the server: roles, decisions, mail, rules, the board and the Steward, on bb's own events.
// Spec: docs/orchestrator-spec.md in the source repo. The engine (core/engine.ts) holds every rule; this file wires
// it to bb: agent tools, per-role configuration and live instructions, lifecycle events, the clock, the host sampler,
// RPC reads, the owner's HTTP writes and the `bb orchestrator` CLI.
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { execFile } from "node:child_process";
import { type BbRun, setupSidebar } from "./core/sidebar.ts";
// deliverables
import { chmodSync, closeSync, cpSync, createReadStream, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { approveBody, type Deliverables, PROOF_ROUTE, type ProjectOrder, requestChangesBody, secretBody } from "./contract.ts";
import { type DeliverPlace, type OutputPlace, type ProofInput, SECRET_TTL_MS } from "./core/engine.ts";
import { deliverBlocks, deliverPoints, fromJson, inputBlocksSchema, lessTextRefusal, looksLikeCode } from "./blocks.ts";
import { CARD_CAPS, DELIVER_BUDGET, deliverBudgetRefusal } from "./core/caps.ts";
import { ignoredTopLevelUpdate, statusParams, statusLine } from "./core/status.ts";
import { checkAnswers, toQuestions } from "./interactions.ts";

/** A pending interaction as bb lists it (only the fields read here). */
type RawInteraction = { id: string; createdAt?: number; kind?: string; status?: string; payload?: { kind?: string } };
import { type Deliverable, PROOF_KINDS } from "./core/model.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  type Agents,
  answerBody,
  archiveBody,
  outputRemoveBody,
  pinBody,
  unpinBody,
  type Outputs,
  CHANGED_CHANNEL,
  holdBody,
  directMessageBody,
  directSeenBody,
  priorityBody,
  type Projects,
  deferBody,
  type NeedsYou,
  type Preset,
  resendBody,
  returnBody,
  rpcContract,
  ruleAddBody,
  ruleRevokeBody,
  roleStartBody,
  cosMessageBody,
  interactionAnswerBody,
  startLeadBody,
  archiveProjectBody,
  WRITES,
  type Card,
} from "./contract.ts";
import type { Db } from "./core/db.ts";
import { type DeliverResult, Engine, OUTPUT_KINDS, parseSince, type PrResult, WAIT_WHEN } from "./core/engine.ts";
import { PINS_MAX } from "./core/pins.ts";
import { AlarmState, describe as describeAlarm, sample, type Snapshot, type Thresholds } from "./core/host.ts";
import {
  LIMIT_DEFAULT, LIMIT_MAX, LINES_DEFAULT, LINES_MAX, liveProjects, loadMemory, mapArgv, configEnvName, PROJECT_RECORD, mapOutcome, memoryConfigPath, memoryProjects,
  memorySetup, type MemoryLocal, pageArgv, QUERY_MAX, REF_MAX, searchArgv, SLUG, TOOL_PAGE, TOOL_SEARCH, toolResult,
} from "./core/memory.ts";
import { formAt, tokensForLevel } from "./mons.ts";
import { placeable, pruneSections } from "./core/sections.ts";
import { type Agent, type Decision, EngineError, OUTCOMES, projectTitle, type Role, ROLES, sectionTitle } from "./core/model.ts";
import { type LeadStartPorts, loadBrief, pokemonSentence, samePath, startLead, type StartedBy } from "./core/start.ts";
import { externalMailSchema, integrationRoutes, allowImport } from "./core/integration.ts";
import { adoptThread, type AdoptThread } from "./core/adopt.ts";
import { spawnSelection, START_DEFAULTS } from "./core/provider.ts";
import { newProject } from "./core/new-project.ts";
import { cosTitleOf, ownerWords, type OwnerWords } from "./core/owner.ts";
// dreams
import { type DreamOptions, Dreams, loadDreamConfig, parseTimers, parseUnits, realDreamPorts, toolsDir } from "./core/dreams.ts";
// the Cloud tab
import { registerCloud } from "./cloud/server.ts";
import { registerOpenPrs } from "./open-prs/server.ts";
// the Game Boy tab
import { registerGameboy } from "./gameboy/server.ts";
import { baseBranchOf, EXEMPT_NOTE, remoteBase, remoteBranchFor, worktreeVerdict, type Verdict, type WorkspaceRead } from "./core/clean.ts";
import { DEFAULT_CONFIG_PATH as DEFAULT_CLOUD_CONFIG } from "./cloud/core/config.ts";
import { type ChildLevel, type NotifySaved, SAVED_KEY as NOTIFY_SAVED, serialReconcile } from "./core/notify-only.ts";

const TOOLS_BY_ROLE: Record<Role, string[]> = {
  thread: ["orch_ask", "orch_ack", "orch_send", "orch_inbox", "orch_report", "orch_output"],
  lead: ["orch_ask", "orch_forward", "orch_answer", "orch_ack", "orch_send", "orch_inbox", "orch_report", "orch_stop_thread", "orch_spawn_thread", "orch_resolve", "orch_handoff", "orch_output", "orch_deliver", "orch_deliver_withdraw", "orch_status"],
  cos: ["orch_triage", "orch_ack", "orch_send", "orch_inbox", "orch_needs_you", "orch_moot", "orch_deliverables", "orch_dead_letters", "orch_start_lead", "orch_new_project"],
  steward: ["orch_ask", "orch_ack", "orch_send", "orch_inbox", "orch_host", "orch_cleanup", "orch_needs_you", "orch_deliverables"],
};

/** Each role's standing instructions; `o` names the owner (the ownerName setting). */
const roleBrief = (o: OwnerWords): Record<Role, string> => ({
  cos: `You are the Chief of Staff (cos) in ${o.name}'s orchestrator. You hear only what needs judgment: new decisions to triage and messages to you. For each decision use orch_triage: settle (only by citing a standing rule id that covers it; never a merge card), ask_person (2-4 options, recommended first), or merge a question into a duplicate question (never a plan or merge card). Ack messages with orch_ack. You get a read-only copy of each answer ${o.name} gives (no ack). orch_needs_you lists what is on ${o.name}'s Needs you now and what was answered or went moot lately; when a card there no longer needs an answer (its PR merged, the asker found out), take it off with orch_moot(id, reason): the asker is told why. orch_deliverables lists what leads delivered to ${o.name}, its review state and proof. Dead letters (mail nobody took) come to you, not ${o.name}'s board: an hourly notice lists new ones; with orch_dead_letters resend one, re-route it to the right address, close it for its recipient, or escalate it to ${o.name}'s board with your note when only ${o.name} can fix it. orch_new_project(brief) creates a project (its folder with PROJECT.md and the project record, and its row at the brief's priority) from slug, title, repo (an existing absolute path; a URL alone is refused, nothing is cloned), goal, and optional repo_url, base, constraints, priority; it refuses a taken slug or folder and never starts the lead. orch_start_lead(slug) starts lead:<slug> through the same checks as ${o.name}'s Start lead button (project folder, a repo under "## Repos" that exists here, not on hold, no live lead); ${o.name}'s board shows that you started it. You get a read-only copy of each direct message ${o.name} sends a lead from the Projects tab and of the lead's ack note: for 48 h it wins on its point over your instructions, earlier or later, and as a dead letter you may resend or escalate it but never re-route or close it. Do not poll; wait for [orchestrator] messages.`,
  steward: `You are the Steward (steward) of the runner's resources. Host alarms arrive as [orchestrator] alarm messages with a snapshot. Report with orch_send to cos; run only the allow-listed orch_cleanup actions on your own; anything else (stopping a process, deleting other files) becomes an orch_ask card. Never kill processes you didn't start, remove worktrees, touch other agents' files or point caches at /tmp.`,
  lead: `You are a project lead in ${o.name}'s orchestrator. Your threads' questions come to you as decision.new: settle with orch_answer (citing a standing rule that covers it, or with a note as your own call), else orch_forward to file it up. Answers to your decisions come only to you: relay to the thread with orch_send(ref=<decision id>) unless you withhold it, and ack. An answer to carry out only once a PR gets somewhere ("merge when approved"): ack it with pr and when, and the orchestrator brings it back to you then and reminds you daily; arm no watcher of your own. Use orch_ask for your own questions (2-4 options, recommended first; it never blocks). Threads start only from a plan card ${o.name} approved: orch_ask(kind=plan, threads=<n>, options with the go option first) lists each thread (title, goal, model, done criteria); once the answer is its go, start each with orch_spawn_thread(plan=<id>). Threads you start any other way are flagged. Resolve a finished thread with orch_resolve: it retires the role and archives the thread once its worktree is clean (nothing uncommitted, its branch in its base branch or pushed) and its PR is merged, its branch is merged into its base, its PR was closed unmerged after its report, or ${o.name} has read its final report, or pass handed_off {pr, owner} when its open PR now belongs to someone else; a dirty worktree is refused with the reason. To swap a thread to another provider, have it write handoff-<UTC date>.md in its worktree, then orch_handoff. ${o.Name} sees only your deliverables and your questions: orch_deliver (finished work with proof) and orch_ask. Bundle your threads' work into deliverables that prove the result (screenshots, video, test output, PR), not into narration. Write them for a 10-second read: visuals first; each decision or finding is one line plus a short why (points); a one-line summary; no file:line, SHAs, logs or tool names at the top, those go in text or doc proof under Details (a PR review: a verdicts block for every PR, the recommended decisions, then 2-4 findings; proof that something works: screenshots or video of it happening, checks; a root cause: rca, a screenshot of the failure, a diagram of where it sits). Never message ${o.name} any other way. ${o.Name} may write to you directly from the Projects tab (a direct message, kind owner.message): answer it only with orch_ack(id, outcome, note), at once even for long work; the note is what ${o.name} reads on the row ("done" means taken, so say whether it is finished) and the CoS gets a copy. For 48 h it wins on its point over a CoS instruction, earlier or later; only ${o.name}'s own later word changes it. If the CoS says ${o.name} changed their mind, file one card with both instructions as options; say in your note what you set aside, and tell the CoS. orch_inbox lists those still in force. A direct message is never an approval: a merge, a production change or a public push still needs its own card citing the message id, and it can't be acked with pr and when. On deliverable.changes: fix it, then orch_deliver(revises=<id>). On deliverable.next: do what ${o.name} asked, then ack it with an outcome and a note saying what you did; the note shows on the deliverable. orch_output only records a file (for example one you then give as proof); it never reaches ${o.name}. Publish orch_status (goal, numbered steps with the current one, what you wait on, blockers) when you start, at each step change and whenever what you wait on changes: it is your project page's step bar, and stale after 2 h. When a thread finishes and at each milestone, include update (working_on: 1-3 bullets, at, needs) in orch_status: it is the Lead status card on your project and replaces the last one. Write it for ${o.name}, in plain words, about the task and what is done: 1-3 short bullets of at most 12 words each; no SHAs, run ids, file paths, flag internals or tool names unless ${o.name} needs them to act. Good: 'Search fix merged; preview ready for Robin to test'. Bad: 'Rebased 4087 onto main at 3f2a1c9, CI run 88123 green'.`,
  thread: `You are a worker thread in ${o.name}'s orchestrator. Ask your lead with orch_ask (2-4 options, recommended first); it returns at once with an id, so carry on or end your turn: the answer comes as a message. Message only your lead (orch_send). When an answer or message is handled, close it with orch_ack(id, outcome); replying to its sender with ref=<its id> closes it as replied, and an ack after that still records the real outcome. Report finished work with orch_report (with the PR URL when there is one). Use orch_output to record a finished artefact (a doc, video, image, report or link) so your lead can put it in a deliverable as proof; ${o.name} sees only what your lead delivers.`,
});

function errText(e: unknown): string {
  if (e instanceof EngineError) return `${e.kind}: ${e.message}`;
  return String(e instanceof Error ? e.message : e);
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    ownerName: { type: "string", label: "Your name, as agents and screens say it (empty: agents say \"the owner\", screens say \"you\")", default: "" },
    cosTitle: { type: "string", label: "The CoS's name on its thread and in the app", default: "Chief of Staff" },
    stateDir: { type: "string", label: "State folder: decisions/<id>.json, the CoS and Steward folders, dream jobs (empty: state/ in the plugin's data folder)", default: "" },
    escalateMinutes: { type: "number", label: "Untriaged decisions go to you after (minutes)", default: 5 },
    batchInbox: { type: "boolean", label: "Batched inbox: one debounced wake per recipient instead of each message into a turn (off, the default: per-message delivery)", default: false },
    inboxDebounceMs: { type: "number", label: "Inbox wake debounce (milliseconds)", default: 2000 },
    resendMinutes: { type: "number", label: "Unacked items are re-sent after the recipient idles (minutes)", default: 10 },
    diskPct: { type: "number", label: "Disk alarm (%)", default: 85 },
    swapPct: { type: "number", label: "Swap alarm (%)", default: 50 },
    memPct: { type: "number", label: "Memory alarm (%)", default: 90 },
    cpuPct: { type: "number", label: "CPU pin alarm (%)", default: 95 },
    sustainSeconds: { type: "number", label: "Alarm must hold for (seconds)", default: 300 },
    sampleSeconds: { type: "number", label: "Host sample every (seconds)", default: 60 },
    diskPath: { type: "string", label: "Disk to watch", default: "/" },
    cosCompactTokens: { type: "number", label: "Compact the CoS's context above (tokens) when idle: off by default; Claude Code compacts on its own", description: "Off by default (0): Claude Code compacts on its own, and the plugin never clears an agent's context. Set a token count (say 300000) to also have the plugin ask Claude Code to /compact the idle CoS above it. A retired cosClearTokens is never carried over: it is only unset, so an upgrade never switches this on.", default: 0 },
    // projects: one folder each, with PROJECT.md and a project record
    projectsDir: { type: "string", label: "Projects folder: one folder per project, with PROJECT.md and a project record (empty: projects/ in the plugin's data folder)", default: "" },
    projectRecord: { type: "string", label: "Project record file in each project folder (JSON; archived_at set hides the project)", default: "project.json" },
    // memory (opt-in)
    memoryConfig: { type: "string", label: "Memory config file (JSON with a memory block). Empty: memory is off and the orchestrator runs no memory tool", default: "" },
    memoryConfigEnv: { type: "string", label: "Environment variable that passes the memory config's path to the memory tools (empty: not passed)", default: "MEMORY_CONFIG" },
    memorySearch: { type: "string", label: "memory-search command (empty: the config's memory.search)", default: "" },
    prPollMinutes: { type: "number", label: "Check PRs every (minutes); 0 = never", default: 5 },
    linearWorkspace: { type: "string", label: "Linear workspace (the slug in linear.app/<slug>): Linear ids in the Projects tab link to their issues. Empty: they stay plain text", default: "" },
    // fork (Caroline): tabs to hide from the page, by id or label, comma-separated. Empty shows them all.
    hiddenTabs: { type: "string", label: "Tabs to hide, comma-separated (ids or labels, e.g. gameboy, rules, activity). Empty: show every tab", default: "" },
    linearTeams: { type: "string", label: "Linear team keys that link, comma-separated (empty: every key). Ids of other teams, and look-alikes such as model names, stay plain text", default: "" },
    pokemon: { type: "boolean", label: "Pokémon", description: "Give each agent a Pokémon that evolves as it levels: sprites in the app and the sidebar, its name in its brief, evolutions on the board. Each project gets a Pokémon type: its lead and threads share it, and its colour is the project's accent. Sprites load from PokeAPI's public sprite repo at runtime. Pokémon is a trademark of Nintendo, Creatures and GAME FREAK; this plugin is not affiliated with them.", default: false },
    pushNeedsYou: { type: "boolean", label: "Desktop/web push when a card enters Needs you (never sent while mobile push is on)", default: true },
    notifyOnlyOrchestrator: { type: "boolean", label: "Orchestrator notifications only", description: "bb notifies you only for the orchestrator: Needs-you cards, deliveries and the CoS thread. Mutes every other thread by setting push-notifications' defaultLevel and childLevel to muted; switching it off restores them. Card and delivery pushes still need pushNeedsYou on and mobile push off.", default: false },
    // dreams
    dreamsEnabled: { type: "boolean", label: "Nightly dream batch and daily memory check (needs a memory config with memory.dreamDir)", default: false },
    dreamDailyAt: { type: "string", label: "Dream time HH:MM, used only when the memory config has no memory.dailyAt", default: "" },
    dreamZone: { type: "string", label: "Time zone of the dream time", default: "UTC" },
    memoryUnits: { type: "string", label: "Memory check: systemd user unit patterns to watch for failures, space-separated (empty: none)", default: "" },
    memoryTimers: { type: "string", label: "Memory check: <unit>.timer=<minutes> pairs; a timer that hasn't run for that long is stale (empty: none)", default: "" },
    // The owner's Start buttons (Projects tab)
    integrationRoutes: { type: "string", label: "External mail source → allowed recipient addresses (JSON; empty disables imports)", default: "{}" },
    leadProvider: { type: "string", label: "Provider of the lead started from the Projects tab", default: START_DEFAULTS.lead.provider },
    leadModel: { type: "string", label: "Model of a lead started from the Projects tab", default: START_DEFAULTS.lead.model },
    leadReasoning: { type: "string", label: "Reasoning of a lead started from the Projects tab", default: START_DEFAULTS.lead.reasoning },
    cosProvider: { type: "string", label: "Provider of the cos started from the Projects tab", default: START_DEFAULTS.cos.provider },
    cosModel: { type: "string", label: "Model of the CoS started from the Projects tab", default: START_DEFAULTS.cos.model },
    cosReasoning: { type: "string", label: "Reasoning of the CoS started from the Projects tab", default: START_DEFAULTS.cos.reasoning },
    stewardProvider: { type: "string", label: "Provider of the steward started from the Projects tab", default: START_DEFAULTS.steward.provider },
    stewardModel: { type: "string", label: "Model of the Steward started from the Projects tab", default: START_DEFAULTS.steward.model },
    stewardReasoning: { type: "string", label: "Reasoning of the Steward started from the Projects tab", default: START_DEFAULTS.steward.reasoning },
    homeProjectId: { type: "string", label: "bb project of the CoS and the Steward (empty: the bb project of the mirror folder, created when missing)", default: "" },
    // the Cloud tab (cloud/)
    cloudConfigPath: { type: "string", label: "Cloud tab config file", description: "On the machine (~/ is its home): which AWS accounts and GCP projects are dev or prod, and their PIM groups. See cloud/config.example.json. Without it the Cloud tab says what to set up.", default: DEFAULT_CLOUD_CONFIG },
    gcpLoginConfig: { type: "string", label: "Cloud tab: GCP login config", description: "Full path of the workforce login config (gcp-login-config.json) on the machine. Empty: look in the usual places.", default: "" },
    // the Open PRs tab (open-prs/): all empty by default; the tab says what to set
    githubLogin: { type: "string", label: "Open PRs: your GitHub login", description: "The tab lists every open PR this login authored, through the machine's own gh login (read-only). Empty: the tab says to set it.", default: "" },
    reviewChannel: { type: "string", label: "Open PRs: code-review channel", description: "A Slack channel name (team-reviews) or an https link to it. Post copies the review text and opens this channel; it never sends anything itself.", default: "" },
    reviewExcludedProjects: { type: "string", label: "Open PRs: projects left out of Post", description: "Project slugs, separated by commas or spaces. Their PRs start unticked in the Post preview.", default: "" },
    slackHandleMap: { type: "string", label: "Open PRs: GitHub login to Slack handle", description: "A JSON object, e.g. {\"some-login\": \"slackname\"}. Only mapped logins are tagged @handle; anyone else is shown by plain name, never guessed.", default: "", experimental_multiline: true },
  });
  // The retired name of cosCompactTokens: never carried over, only unset (retireClearSetting).
  const retired = bb.settings.define({
    cosClearTokens: { type: "number", label: "Retired: replaced by cosCompactTokens, never carried over (unset at load; leave unset)" },
  });
  await retireClearSetting(retired, (m) => bb.log.warn(m));
  let cfg = await settings.get();
  /** The owner in tool descriptions, as at load: a changed ownerName reaches them on the next plugin reload. */
  const O = ownerWords(cfg.ownerName);
  registerCloud(bb, () => cfg);
  const dataDir = dirname(bb.storage.database().name);
  registerGameboy(bb, join(dataDir, "gameboy"));
  /** The state folder: the setting, else state/ beside the plugin's database. */
  const stateDir = () => cfg.stateDir.trim() || join(dataDir, "state");
  /** The projects folder: the setting (`~` is the home folder), else projects/ beside the plugin's database. */
  const projectsDir = () => memoryConfigPath(cfg.projectsDir) ?? join(dataDir, "projects");
  const projectRecord = () => cfg.projectRecord.trim() || PROJECT_RECORD;
  const loadedAt = Date.now();
  const db = bb.storage.database() as unknown as Db;

  // ---------------------------------------------------------------- engine ports
  // The page's change notice waits for the services: bb starts them only once activation succeeded, so a timer is
  // never left running by an activation that throws (bb then runs no dispose hook). They announce once on start.
  let announcing = false;
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    if (!announcing || changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      bb.realtime.publish(CHANGED_CHANNEL, {});
    }, 150);
  };

  const mirror = (d: Decision) => {
    try {
      const dir = join(stateDir(), "decisions");
      mkdirSync(join(dir, ".tmp"), { recursive: true, mode: 0o700 });
      const tmp = join(dir, ".tmp", `${d.id}.${process.pid}.json`);
      writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
      renameSync(tmp, join(dir, `${d.id}.json`));
    } catch (e) {
      bb.log.warn(`mirror ${d.id}: ${String(e)}`);
    }
  };

  async function deliver(threadId: string, text: string, item: { sender: string; id?: string }): Promise<DeliverResult> {
    const agent = engine.agentByThread(threadId);
    if (agent?.status === "stopped") return { delivery: "held", why: "stopped by the orchestrator" };
    const t = await bb.sdk.threads.get({ threadId });
    if ((t as { archivedAt?: number | null }).archivedAt) return { delivery: "held", why: "archived" };
    const sender = engine.agentByAddress(item.sender);
    // 2026-11-13: queued behind a running turn, mail waited 15-60+ min on threads that stay busy (median 25 s queued vs
    // 0.08 s direct). Steering adds it to the running turn, so the agent reads it at its next tool boundary; where
    // nothing can be steered bb starts a turn, or queues it (a provider that can't steer).
    const res = await bb.sdk.threads.send({
      threadId,
      mode: item.id?.startsWith("wake:") ? "queue-if-active" : "steer-if-active",
      input: [{ type: "text", text, mentions: [] }],
      ...(sender ? { senderThreadId: sender.threadId } : {}),
    });
    if (res.delivery === "queued") return { delivery: "queued", queuedMessageId: res.queuedMessage.id };
    return { delivery: "sent" };
  }

  const engine = new Engine(
    db,
    { now: () => Date.now(), externalEnabled: (source, to) => {
      try { allowImport(integrationRoutes(cfg.integrationRoutes), source, to); return true; }
      catch { return false; }
    }, deliver, mirror, changed, log: (m) => bb.log.warn(m), cardUp: (d) => void pushCard(d), delivered: (d) => void pushDelivered(d) },
    { escalateMs: cfg.escalateMinutes * 60_000, resendMs: cfg.resendMinutes * 60_000, owner: cfg.ownerName, pokemon: cfg.pokemon, batchInbox: cfg.batchInbox, inboxDebounceMs: Math.min(60000, Math.max(0, cfg.inboxDebounceMs || 2000)) },
  );
  registerOpenPrs(bb, engine, () => cfg);
  // ---------------------------------------------------------------- notifyOnlyOrchestrator (core/notify-only.ts)
  const PN = "push-notifications";
  const notifyOnly = serialReconcile(
    () => cfg.notifyOnlyOrchestrator === true,
    {
      levels: async () => ((await bb.sdk.plugins.getSettings({ pluginId: PN })) as unknown as { values: { defaultLevel: unknown; childLevel: unknown } }).values,
      setLevels: async (v) => void (await bb.sdk.plugins.updateSettings({ pluginId: PN, values: { defaultLevel: v.defaultLevel, childLevel: v.childLevel } })),
      ownLevel: async (threadId) => {
        const r = (await bb.sdk.plugins.callRpc({ pluginId: PN, method: "threadNotifications.list", input: { threadIds: [threadId] }, outputSchema: z.object({ threads: z.record(z.string(), z.object({ own: z.string() }).passthrough()) }) })) as { threads: Record<string, { own: string }> };
        return (r.threads[threadId]?.own ?? "inherit") as ChildLevel;
      },
      setOwnLevel: async (threadId, level) => void (await bb.sdk.plugins.callRpc({ pluginId: PN, method: "threadNotifications.set", input: { threadId, level }, outputSchema: z.any() })),
      parentOf: async (threadId) => ((await bb.sdk.threads.get({ threadId })) as { parentThreadId?: string | null }).parentThreadId ?? null,
      cosThread: () => engine.agentByAddress("cos")?.threadId ?? null,
      load: async () => (await bb.storage.kv.get<NotifySaved>(NOTIFY_SAVED)) ?? null,
      save: async (v) => void (v ? await bb.storage.kv.set(NOTIFY_SAVED, v) : await bb.storage.kv.delete(NOTIFY_SAVED)),
    },
    (m) => bb.log.info(m),
  );
  // Started as a service, never during activation: a failed reconcile must not fail the plugin, and it retries each minute.
  bb.background.service("notify-only", {
    async start(signal) {
      while (!signal.aborted) {
        await unlessAborted(notifyOnly(), signal);
        await sleep(60_000, signal);
      }
    },
  });

  settings.onChange((next) => {
    if (next.pushNeedsYou && !cfg.pushNeedsYou) void resumePush(); // the push was switched back on: lift a pause
    const notifyFlip = next.notifyOnlyOrchestrator !== cfg.notifyOnlyOrchestrator;
    cfg = next;
    changed(); // the page re-reads its config (owner name, CoS title) and the agents (Pokémon on or off)
    engine.settings = { escalateMs: next.escalateMinutes * 60_000, resendMs: next.resendMinutes * 60_000, owner: next.ownerName, pokemon: next.pokemon, batchInbox: next.batchInbox, inboxDebounceMs: Math.min(60000, Math.max(0, next.inboxDebounceMs || 2000)) };
    reloadMemory();
    if (notifyFlip) void notifyOnly();
  });

  // ---------------------------------------------------------------- the memory engine (docs/memory-port.md)
  // Read outside configure, which must stay synchronous and fast; read again each minute for new projects.
  let memory: MemoryLocal | null = null;
  let memoryProjectsNow: ReadonlyMap<string, string> = new Map();
  let memoryState = "";
  function reloadMemory(): void {
    const { local, why } = loadMemory(memoryConfigPath(cfg.memoryConfig), cfg.memorySearch);
    memory = local;
    memoryProjectsNow = local ? memoryProjects(local) : new Map();
    // a live project folder gets its row in Projects (and its Start lead button) without waiting for a lead
    for (const slug of liveProjects(projectsDir(), projectRecord())) engine.ensureProject(slug, null);
    const now = local ? `${memoryProjectsNow.size} projects, config ${local.configPath}, search ${local.search}` : `off: ${why}`;
    if (now !== memoryState) bb.log.info(`memory: ${now}`);
    memoryState = now;
  }
  reloadMemory();
  /** Where a recorded file may lie outside the caller's own folder: the state folder, and the vault when memory is on. */
  const sharedRoots = () => [stateDir(), ...(memory?.vault ? [memory.vault] : [])];
  // Read again each minute from a service, never a setInterval here: an interval outlived a failed reload and threw
  // "The database connection is not open" every minute (2026-11-14), since bb runs no dispose hook for it.
  bb.background.service("memory", {
    async start(signal) {
      announcing = true;
      changed();
      signal.addEventListener("abort", () => {
        announcing = false;
        if (changeTimer) clearTimeout(changeTimer);
        changeTimer = null;
      }, { once: true });
      while (!signal.aborted) {
        await sleep(60_000, signal);
        if (signal.aborted) break;
        try {
          reloadMemory();
        } catch (e) {
          bb.log.warn(`memory: ${errText(e)}`);
        }
      }
    },
  });
  const memoryRun = (argv: string[], timeoutMs: number) =>
    new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      const l = memory;
      if (!l) return resolve({ exitCode: 2, stdout: "", stderr: `memory is off: ${memoryState}` });
      const configEnv = configEnvName(cfg.memoryConfigEnv);
      execFile(l.search, argv, { timeout: timeoutMs, maxBuffer: 4 << 20, env: configEnv ? { ...process.env, [configEnv]: l.configPath } : process.env }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) || (err && code === 1 ? err.message : "") });
      });
    });
  // A thread's folder in memory-search's worktree map, once per folder: its sessions then count for its project.
  const mapped = new Set<string>();
  function recordFolder(folder: string, project: string): void {
    const key = `${folder}\t${project}`;
    if (mapped.has(key)) return;
    mapped.add(key);
    void memoryRun(mapArgv({ folder, project }), 60_000).then((r) => {
      const outcome = mapOutcome(r.exitCode);
      const why = (r.stderr.trim() || r.stdout.trim()).split("\n").pop();
      if (outcome === "retry") {
        mapped.delete(key); // asked again at the thread's next turn
        return bb.log.warn(`memory: worktree map for ${folder}: ${why}`);
      }
      bb.log.info(`memory: worktree map: ${outcome}: ${why}`);
    });
  }

  let flushing: Promise<void> | null = null;
  const flush = () => {
    flushing ??= engine.flush().finally(() => {
      flushing = null;
    });
    return flushing;
  };

  // ---------------------------------------------------------------- agent tools
  const caller = (threadId: string | undefined | null): Agent => {
    const a = threadId ? engine.agentByThread(threadId) : null;
    if (!a) throw new EngineError("forbidden", "this thread has no orchestrator role");
    return a;
  };
  const run = async (threadId: string | undefined, fn: (a: Agent) => string) => {
    try {
      const out = fn(caller(threadId));
      void flush();
      return ok(out);
    } catch (e) {
      return fail(errText(e));
    }
  };
  const optionsSchema = z.array(z.object({ label: z.string().min(1).max(80), detail: z.string().max(300).optional() })).min(2).max(4);

  bb.agents.registerTool({
    name: "orch_ask",
    description: `File a question with 2-4 options, the recommended one FIRST. A thread's goes to its lead; a lead's or the Steward's to the CoS and on to ${O.name}. Returns the decision id at once; never blocks. The answer arrives later as an [orchestrator] message.`,
    presentation: { label: { pending: "Filing a question", completed: "Filed a question" } },
    parameters: z.object({
      title: z.string().min(1).max(60).describe("Short label, ends in ? where natural"),
      question: z.string().min(1).max(600).describe(`The question, one line, at most ${CARD_CAPS.question} characters`),
      context: z.string().max(8000).optional().describe(`Why it matters, at most ${CARD_CAPS.context} characters (blocks don't count). For a plan: the numbered thread list (title, goal, model, done criteria, size), at most ${CARD_CAPS.planContext}`),
      options: z.array(z.object({ label: z.string().min(1).max(80), detail: z.string().max(300).optional().describe(`What it does, at most ${CARD_CAPS.detail} characters`), go: z.boolean().optional().describe("plan only: the approving option (default: the first)") })).min(2).max(4),
      kind: z.enum(["question", "plan"]).optional().describe("plan: a lead's thread plan; its go lets you orch_spawn_thread"),
      threads: z.number().int().min(1).max(10).optional().describe("plan only: how many threads the go starts"),
      merge: z.boolean().optional().describe(`true for a PR merge card (only ${O.name} may answer it)`),
      key: z.string().max(80).optional().describe("Dedupe key, e.g. <project>:<topic>"),
      blocks: inputBlocksSchema
        .optional()
        .describe(
          `Typed parts ${O.name}'s card draws as components instead of prose: login (a sign-in link, its code and expiry; paste=true when ${O.name} must paste a code back, which reaches you only as a file path), steps (what to do and what ${O.name} should see), pr (drawn with its live state), list (an exact list; selectable lets ${O.name} untick items), facts (figures, sizes, before/after), command (the exact command), decisions (one line each, a short why). Use them instead of putting links, codes, lists or commands in the context. A merge card needs a pr block: the card leads with it.`,
        ),
    }),
    execute: (p, { threadId }) =>
      run(threadId, (a) => {
        if (p.merge && !p.blocks?.some((b) => b.kind === "pr")) throw new EngineError("invalid", "a merge card needs a pr block (the PR's URL, and a one-line verdict as its note)");
        const d = engine.ask(a, { title: p.title, question: p.question, context: p.context, options: p.options, kind: p.kind, threads: p.threads, action: p.merge ? "merge" : null, key: p.key ?? null, blocks: p.blocks });
        return `Filed ${d.id} (${d.orchestrator.at_level === "lead" ? `with ${`lead:${a.project}`}` : "with the CoS"}). The answer will come as a message; don't wait on it.`;
      }),
  });

  bb.agents.registerTool({
    name: "orch_forward",
    description: `Lead only: file your thread's question up to the CoS (and ${O.name}). You become its asker: the answer comes to you, and you relay it.`,
    presentation: { label: { pending: "Filing a question up", completed: "Filed a question up" } },
    parameters: z.object({ id: z.string(), note: z.string().max(2000).optional() }),
    execute: (p, { threadId }) => run(threadId, (a) => `Filed ${engine.forward(a, p.id, p.note ?? null).id} with the CoS.`),
  });

  bb.agents.registerTool({
    name: "orch_answer",
    description: "Lead only: settle your own thread's question. Cite a standing rule that covers it (rule id from orch_inbox), or leave rule_id out (or empty) and give a note saying why: it is recorded as your own call.",
    presentation: { label: { pending: "Settling a question", completed: "Settled a question" } },
    parameters: z.object({ id: z.string(), rule_id: z.string().optional(), option: z.string().describe("option id, e.g. \"1\""), note: z.string().max(2000).optional() }),
    execute: (p, { threadId }) => run(threadId, (a) => `Settled ${engine.leadAnswer(a, p.id, p.rule_id ?? null, p.option, p.note ?? null).id}; the answer goes to the thread.`),
  });

  bb.agents.registerTool({
    name: "orch_triage",
    description: `CoS only. action=settle: answer from a standing rule (rule_id + option; refused for merge cards). action=ask_person: put it to ${O.name} (question + 2-4 options, recommended first; question at most ${CARD_CAPS.question} characters, details ${CARD_CAPS.detail}, context ${CARD_CAPS.context}). action=merge: it duplicates \`into\`. action=bounce: send it back to its asker instead of on to ${O.name}, note = what to fix (no where or how, a stale claim, a step it can take itself). action=propose_rule: after a rule offer, id = one of its cards, note = the rule in one line (at most 120), rule = optional {from, words, without, key_prefix, option} to narrow the offer's; ${O.name} gets one "Make this a rule?" card.`,
    presentation: { label: { pending: "Triaging a decision", completed: "Triaged a decision" } },
    parameters: z.object({
      id: z.string(),
      action: z.enum(["settle", "ask_person", "merge", "bounce", "propose_rule"]),
      rule_id: z.string().optional(),
      option: z.string().optional(),
      note: z.string().max(2000).optional(),
      title: z.string().max(60).optional(),
      question: z.string().max(600).optional(),
      context: z.string().max(8000).optional(),
      options: optionsSchema.optional(),
      allow_text: z.boolean().optional(),
      into: z.string().optional(),
      rule: z
        .preprocess(fromJson, z.object({ from: z.array(z.string()).optional(), words: z.array(z.string()).optional(), without: z.array(z.string()).optional(), key_prefix: z.string().optional(), option: z.array(z.string()).optional() }))
        .optional()
        .describe("propose_rule only: what the rule matches, if narrower than the offer's"),
    }),
    execute: (p, { threadId }) =>
      run(threadId, (a) => {
        if (p.action === "propose_rule") {
          if (!p.note) throw new EngineError("invalid", "propose_rule needs note: the rule in one line");
          const d = engine.proposeRule(a, p.id, p.note, p.rule ?? null);
          return `${d.id} "Make this a rule?" is in ${O.name}'s Needs you. A yes adds the rule; the answer comes to you.`;
        }
        if (p.action === "bounce") {
          if (!p.note) throw new EngineError("invalid", "bounce needs note: what the asker should fix");
          return `Sent ${engine.triageBounce(a, p.id, p.note).id} back to its asker with your note; it never reaches ${O.name}.`;
        }
        if (p.action === "settle") {
          if (!p.rule_id || !p.option) throw new EngineError("invalid", "settle needs rule_id and option");
          return `Settled ${engine.triageSettle(a, p.id, p.rule_id, p.option, p.note ?? null).id} from ${p.rule_id}.`;
        }
        if (p.action === "merge") {
          if (!p.into) throw new EngineError("invalid", "merge needs into");
          return `Merged ${engine.triageMerge(a, p.id, p.into).id} into ${p.into}.`;
        }
        if (!p.question || !p.options) throw new EngineError("invalid", "ask_person needs question and options");
        return `${engine.triageAskPerson(a, p.id, { title: p.title, question: p.question, context: p.context, options: p.options, allowText: p.allow_text ?? true }).id} is in ${O.name}'s Needs you.`;
      }),
  });

  // The CoS's (and the Steward's) view of the owner's Needs you (2026-11-15): the same rows the app shows, as text.
  const cosOrSteward = (a: Agent) => {
    if (a.role !== "cos" && a.role !== "steward") throw new EngineError("forbidden", "CoS and Steward only");
  };
  bb.agents.registerTool({
    name: "orch_needs_you",
    description: `CoS and Steward only: what is on ${O.name}'s Needs you now (each card's id, project, asker, title, how long it has waited; deferred ones; ones still with the CoS), and what ${O.name} answered (with the option chosen) or what went moot, in the last 24h and newest 20 by default (widen with \`since\` and \`limit\`).`,
    presentation: { label: { pending: "Reading Needs you", completed: "Read Needs you" } },
    parameters: z.object({
      since: z.string().max(40).optional().describe("Answered and moot cards since: an ISO time or a span like 24h or 7d (default 24h)"),
      limit: z.number().int().min(1).max(200).optional().describe("At most this many answered (and moot) cards, newest first (default 20)"),
      project: z.string().max(40).optional().describe("Only this project's cards"),
    }),
    execute: (p, { threadId }) =>
      run(threadId, (a) => {
        cosOrSteward(a);
        return engine.needsYouView({ since: p.since ? parseSince(p.since, Date.now(), 0) : null, limit: p.limit ?? null, project: p.project || null }).text;
      }),
  });

  bb.agents.registerTool({
    name: "orch_deliverables",
    description: `CoS and Steward only: the deliverables leads handed ${O.name}, per project, from the same table the Deliverables tab reads: id, lead, title, rev, state (in review, approved, changes requested with ${O.name}'s note, withdrawn), dates, and the latest revision's proof (PR and link URLs, file paths, captions).`,
    presentation: { label: { pending: "Reading deliverables", completed: "Read deliverables" } },
    parameters: z.object({
      project: z.string().max(40).optional().describe("Only this project's"),
      state: z.enum(["review", "approved", "changes", "withdrawn"]).optional().describe("review = in review; changes = changes requested"),
      since: z.string().max(40).optional().describe("Only those updated since: an ISO time or a span like 24h or 7d"),
      limit: z.number().int().min(1).max(200).optional().describe("At most this many, newest change first (default 50)"),
    }),
    execute: (p, { threadId }) =>
      run(threadId, (a) => {
        cosOrSteward(a);
        const since = p.since ? parseSince(p.since, Date.now(), 0) : null;
        return engine.deliverablesView({ project: p.project || null, state: p.state ?? null, since, limit: p.limit }).text;
      }),
  });

  bb.agents.registerTool({
    name: "orch_dead_letters",
    description: `CoS only: the dead letters (mail nobody acked or nobody can take), which come to you, not ${O.name}'s board. action=list (default): each with id, sender, recipient, kind, age and why it died. action=resend: send it again to its recipient. action=reroute: send it to \`to\` instead (its sender still gets the ack). action=close: close it for its recipient with \`outcome\` and a note (its sender is told). action=escalate: put it on ${O.name}'s board with your \`note\`; only escalated ones reach the board.`,
    presentation: { label: { pending: "Handling dead letters", completed: "Handled dead letters" } },
    parameters: z.object({
      action: z.enum(["list", "resend", "reroute", "close", "escalate"]).optional(),
      id: z.string().optional().describe("The dead letter's item id, i-…"),
      to: z.string().optional().describe("reroute: the address to send it to"),
      outcome: z.enum(["done", "refused", "failed", "superseded"]).optional().describe("close: the outcome on the recipient's behalf"),
      note: z.string().max(2000).optional().describe(`close/reroute: why; escalate (needed): what ${O.name} should do, one line`),
    }),
    execute: (p, { threadId }) =>
      run(threadId, (a) => {
        if (a.role !== "cos") throw new EngineError("forbidden", "CoS only");
        const action = p.action ?? "list";
        if (action === "list") return engine.deadLettersText(a).text;
        if (!p.id) throw new EngineError("invalid", `${action} needs id`);
        if (action === "resend") { const it = engine.resend(p.id, a.address); return `Resent ${it.id} to ${it.recipient}.`; }
        if (action === "reroute") {
          if (!p.to) throw new EngineError("invalid", "reroute needs to");
          return `Re-routed ${engine.reroute(a, p.id, p.to, p.note ?? null).id} to ${p.to}.`;
        }
        if (action === "close") {
          if (!p.outcome) throw new EngineError("invalid", "close needs outcome");
          return `Closed ${engine.closeDead(a, p.id, p.outcome, p.note ?? null).id}: ${p.outcome}.`;
        }
        if (!p.note) throw new EngineError("invalid", `escalate needs a note: what ${O.name} should do`);
        return `${engine.escalateDead(a, p.id, p.note).id} is on ${O.name}'s board with your note.`;
      }),
  });

  bb.agents.registerTool({
    name: "orch_moot",
    description: `CoS only: take an open card off ${O.name}'s Needs you because it no longer needs an answer (its PR merged, the asker found out). It is withdrawn, never answered; the asker gets a notice with your reason, cards merged into it go too, and an answer ${O.name} sends later is refused.`,
    presentation: { label: { pending: "Marking a card moot", completed: "Marked a card moot" } },
    parameters: z.object({ id: z.string().describe("The decision id, d-…"), reason: z.string().min(1).max(300).describe("One line: why it no longer needs an answer") }),
    execute: (p, { threadId }) =>
      run(threadId, (a) => {
        const d = engine.moot(a, p.id, p.reason);
        return `${d.id} is moot: off ${O.name}'s Needs you${d.merged.length ? ` with ${d.merged.join(", ")}` : ""}; ${d.orchestrator.asker} is told why.`;
      }),
  });

  bb.agents.registerTool({
    name: "orch_ack",
    description: `Close a message (i-…) or an answered decision (d-…) once handled, with an outcome: ${OUTCOMES.join(" | ")}, and an optional note. When the answer is to be carried out only once a PR gets somewhere ("merge when approved", "after CI is green", "when merged"), also give pr (its URL) and when: the orchestrator watches the PR and sends the answer back to you when it is, with a reminder each day until then. No watcher of your own needed. With batchInbox on: ack a handled digest with through=<cursor> alone; decision outcomes still use id/outcome, and a cursor ack is only mail handling.`,
    presentation: { label: { pending: "Acking", completed: "Acked" } },
    parameters: z.object({
      id: z.string().optional(),
      through: z.string().optional().describe("Ack-through cursor returned by your inbox digest"),
      outcome: z.enum(["done", "refused", "failed", "superseded"]).optional(),
      note: z.string().max(2000).optional(),
      pr: z.string().max(300).optional().describe("The PR this answer waits on: its URL"),
      when: z.enum(WAIT_WHEN).optional().describe("What it waits for: approved, green (checks passing), ready (to merge) or merged"),
    }),
    execute: (p, { threadId }) =>
      run(threadId, (a) => {
        if (p.through) {
          if (!engine.settings.batchInbox || p.id || p.outcome || p.pr || p.when || p.note) throw new EngineError("invalid", "use through alone in batch mode");
          return `Acknowledged ${engine.batch.ack(a, p.through)} unread items through this digest.`;
        }
        if (!p.id || !p.outcome) throw new EngineError("invalid", "give through, or id and outcome");
        if (!!p.pr !== !!p.when) throw new EngineError("invalid", "give pr and when together");
        const r = engine.ack(a, p.id, p.outcome, p.note ?? null, p.pr && p.when ? { pr: p.pr, when: p.when } : null);
        if (/^d-[\w-]+$/.test(p.id)) rmSync(join(stateDir(), "secrets", `${p.id}.txt`), { force: true }); // a pasted code goes once handled
        return r;
      }),
  });

  bb.agents.registerTool({
    name: "orch_send",
    description: "Message another agent by address (cos, steward, lead:<project>, thread:<project>:<n>). A thread may message only its lead; lead-to-lead is copied to the CoS. `key` makes a retry safe; `ref` names the decision a relay is about, or the message (i-…) you are answering: that closes it as replied, so a reply needs no separate ack. With batchInbox on: a reply never acknowledges unread mail (use the digest cursor), and severity INFO is quiet unless needs_reply or due_at (epoch milliseconds).",
    presentation: { label: { pending: "Sending a message", completed: "Sent a message" } },
    parameters: z.object({ to: z.string(), text: z.string().min(1).max(4000), key: z.string().max(80).optional(), ref: z.string().optional(), severity: z.enum(["INFO", "ACTION"]).optional(), needs_reply: z.boolean().optional(), due_at: z.number().int().nonnegative().optional() }),
    execute: (p, { threadId }) => run(threadId, (a) => `Queued ${engine.send(a, p.to, p.text, p.key ?? null, p.ref ?? null, { severity: p.severity, needsReply: p.needs_reply, dueAt: p.due_at }).id} to ${p.to}.`),
  });

  bb.agents.registerTool({
    name: "orch_inbox",
    description: "Your recovery view: unread items, decisions waiting for you, your own open decisions, and the standing rules you may cite. With batchInbox on: ALL unread oldest first with full bodies, ids, refs and an ack-through cursor; reading never acknowledges. The CoS may inspect wakes or retry_wake by recipient.",
    presentation: { label: { pending: "Reading the inbox", completed: "Read the inbox" } },
    parameters: z.object({
      id: z.string().regex(/^i-[a-f0-9]+$/).optional().describe("Read the complete text of one item addressed to you, including passive INFO"),
      wakes: z.boolean().optional(),
      retry_wake: z.string().optional(),
    }),
    execute: (p, { threadId }) => run(threadId, (a) => {
      if (p.id) return engine.readItem(a, p.id);
      if (p.wakes || p.retry_wake) {
        if (a.role !== "cos") throw new EngineError("forbidden", "only CoS manages inbox wakes");
        if (p.retry_wake) engine.batch.retry(p.retry_wake);
        return JSON.stringify(engine.batch.wakes());
      }
      return engine.settings.batchInbox ? JSON.stringify(engine.batch.read(a)) : engine.inbox(a).text;
    }),
  });

  bb.agents.registerTool({
    name: "orch_report",
    description: "Report finished work (optionally a PR URL). Goes to the board and your lead, never to the CoS. `ref`: your lead's message (i-…) this report answers; it closes as replied. With batchInbox on, the digest still needs its cursor ack.",
    presentation: { label: { pending: "Reporting", completed: "Reported" } },
    parameters: z.object({ title: z.string().min(1).max(120), body: z.string().max(8000), pr: z.string().url().optional(), ref: z.string().max(80).optional() }),
    execute: (p, { threadId }) => run(threadId, (a) => engine.report(a, p.title, p.body, p.pr ?? null, p.ref ?? null)),
  });

  bb.agents.registerTool({
    name: "orch_stop_thread",
    description: "Lead only: stop one of your threads. Messages to it wait until it is started again.",
    presentation: { label: { pending: "Stopping a thread", completed: "Stopped a thread" } },
    parameters: z.object({ to: z.string().describe("thread:<project>:<n>") }),
    execute: async (p, { threadId }) => {
      try {
        const a = caller(threadId);
        const t = engine.agentByAddress(p.to);
        if (!t || t.role !== "thread" || t.project !== a.project || a.role !== "lead") throw new EngineError("forbidden", "stop only your own threads");
        await stopAgent(t);
        return ok(`Stopped ${p.to}.`);
      } catch (e) {
        return fail(errText(e));
      }
    },
  });


  // ---------------------------------------------------------------- phase 2: plans → threads, PRs, resolve, handoff
  type ThreadInfo = { id: string; projectId: string; environmentId: string | null; title: string | null; lastReadAt: number | null; latestAttentionAt: number | null; status: string };
  const threadInfo = async (threadId: string) => (await bb.sdk.threads.get({ threadId })) as unknown as ThreadInfo;

  /** bb's PR status per environment (bb--github-pr-status). Read-only; one call for many environments. */
  async function prFetch(envIds: string[]): Promise<Record<string, PrResult>> {
    if (envIds.length === 0) return {};
    return (await bb.sdk.plugins.callRpc({ pluginId: "bb--github-pr-status", method: "pullRequests", input: { keys: envIds.slice(0, 200) }, outputSchema: z.record(z.string(), z.any()) })) as Record<string, PrResult>;
  }

  /** One pr-watch pass. `fake` (address → reading) is the proof hook: injected readings, labelled on the Board. */
  async function prPass(fake: Record<string, PrResult> | null, signal?: AbortSignal): Promise<string> {
    const live = engine.agents().filter((a) => a.role === "thread" || a.role === "lead");
    for (const a of live) {
      if (signal?.aborted) return "stopped";
      if (a.environmentId) continue;
      const t = await threadInfo(a.threadId).catch(() => null);
      if (t?.environmentId) engine.setEnvironment(a.threadId, t.environmentId);
    }
    const agents = engine.agents().filter((a) => (a.role === "thread" || a.role === "lead") && a.environmentId);
    const res: Record<string, PrResult> | null = fake
      ? Object.fromEntries(agents.filter((a) => fake[a.address]).map((a) => [a.environmentId!, fake[a.address]!]))
      : await unlessAborted(prFetch([...new Set(agents.map((a) => a.environmentId!))]), signal);
    if (!res) return "stopped";
    const changedFor: string[] = [];
    for (const a of agents) {
      const r = res[a.environmentId!];
      if (r && engine.prSeen(a, a.environmentId!, r, fake ? " [injected]" : "")) changedFor.push(a.address);
    }
    if (changedFor.length) await flush();
    const summary = agents.map((a) => `${a.address}: ${res[a.environmentId!]?.outcome ?? "no reading"}`).join("; ");
    return `${changedFor.length ? `changed: ${changedFor.join(", ")}` : "no change"} (${summary || "no agents with an environment"})`;
  }

  bb.agents.registerTool({
    name: "orch_spawn_thread",
    description: `Lead only: start one thread of a plan card ${O.name} approved (its go option). Each gets its own new worktree, you as its bb parent, and the orchestrator role. Refused without an approved plan, past the plan's thread count, or while the project is on hold.`,
    presentation: { label: { pending: "Starting a thread", completed: "Started a thread" } },
    parameters: z.object({
      provider: z.string().min(1).max(100).optional().describe("Provider id (default: claude-code); unavailable selections are refused"),
      plan: z.string().describe("The approved plan card's decision id (d-…)"),
      title: z.string().min(1).max(80),
      prompt: z.string().min(1).max(20000).describe("The thread's brief: goal, scope, constraints, done criteria"),
      model: z.string().max(80).optional(),
      reasoning: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      base_branch: z.string().max(200).optional().describe("Branch the worktree starts from (default: the repo's default)"),
    }),
    execute: async (p, { threadId }) => {
      let token: string | null = null;
      try {
        const a = caller(threadId);
        token = engine.reserveSpawn(a, p.plan);
        const lead = await threadInfo(a.threadId);
        engine.ensureProject(a.project!, lead.projectId);
        // a new worktree on the lead's own machine (bb needs the host for a managed worktree)
        const leadEnv = lead.environmentId ? ((await bb.sdk.environments.get({ environmentId: lead.environmentId })) as unknown as { hostId?: string | null }) : null;
        if (!leadEnv?.hostId) throw new EngineError("bad_state", "can't tell which machine the lead runs on");
        const selection = await spawnSelection(bb.sdk.providers, { hostId: leadEnv.hostId, projectId: lead.projectId }, p, { defaults: {}, warn: (m) => bb.log.warn(m) });
        const t = await bb.sdk.threads.spawn({
          projectId: lead.projectId,
          environment: { type: "host", hostId: leadEnv.hostId, workspace: { type: "managed-worktree", baseBranch: p.base_branch ? { kind: "named", name: p.base_branch } : { kind: "default" } } },
          prompt: p.prompt,
          title: p.title,
          ...selection,
          parentThreadId: a.threadId,
          parentNotifications: "auto",
          pluginMetadata: { role: "thread", project: a.project, plan: p.plan },
        } as Parameters<typeof bb.sdk.threads.spawn>[0]);
        engine.confirmSpawn(token, t.id);
        token = null;
        const reg = engine.agentByThread(t.id) ?? engine.register(t.id, "thread", a.project, a.threadId);
        engine.setEnvironment(t.id, (t as unknown as ThreadInfo).environmentId ?? null);
        await bb.sdk.threads.updatePluginMetadata({ threadId: t.id, set: { address: reg.address, role: reg.role } });
        void flush();
        void placeSections();
        return ok(`Started ${reg.address} (${t.id}${reg.mon ? `, ${reg.mon}` : ""}) from ${p.plan}. It reports to you; bb tells you when it finishes a turn.`);
      } catch (e) {
        if (token) {
          // bb may have created the thread before the call failed (a timeout): then it takes the slot, not a stray flag
          const child = await spawnedAnyway(threadId, p.plan, p.title).catch(() => null);
          if (child) {
            engine.confirmSpawn(token, child);
            return fail(`${errText(e)} (bb did create ${child}; it holds a slot of ${p.plan} — check it before starting another)`);
          }
          engine.releaseSpawn(token);
        }
        return fail(errText(e));
      }
    },
  });

  /** A child of the lead that this plugin spawned for `plan` with `title` and that holds no slot yet, or null. */
  async function spawnedAnyway(leadThreadId: string | undefined, plan: string, title: string): Promise<string | null> {
    if (!leadThreadId) return null;
    const kids = (await bb.sdk.threads.list({ parentThreadId: leadThreadId, originPluginId: bb.pluginId, limit: 200 })).filter((t) => t.title === title);
    if (!kids.length) return null;
    const meta = await bb.sdk.threads.experimental_listPluginMetadata({ threadIds: kids.map((t) => t.id) });
    const ids = meta.threads.filter((m) => (m.metadata as { plan?: unknown }).plan === plan).map((m) => m.threadId);
    return ids.find((id) => !engine.hasSpawn(id)) ?? null;
  }

  /** bb--git's view of a thread's worktree, read fresh: is anything there that archiving would lose? */
  const gitCall = (method: string, input: Record<string, string | number>) => bb.sdk.plugins.callRpc({ pluginId: "bb--git", method, input, outputSchema: z.any() });
  async function worktreeOf(environmentId: string | null, archivedAt: number | null = null): Promise<Verdict> {
    // nothing to lose: no worktree, or bb already archived the thread (its worktree is bb's to keep or remove). A refusal
    // here could never clear, and the role would stay live for good.
    if (!environmentId) return { clean: true, inBase: false, why: "it has no worktree" };
    if (archivedAt) return { clean: true, inBase: false, why: "bb already archived it" };
    try {
      await gitCall("refresh", { environmentId });
      const env = (await bb.sdk.environments.get({ environmentId })) as unknown as { mergeBaseBranch?: string | null };
      let base = (await gitCall("workspaceStatus", { environmentId, ...(env.mergeBaseBranch ? { mergeBaseBranch: env.mergeBaseBranch } : {}) })) as WorkspaceRead;
      if (base.outcome === "available" && "workspace" in base && !base.workspace.mergeBase) {
        base = (await gitCall("workspaceStatus", { environmentId, mergeBaseBranch: base.workspace.branch.defaultBranch })) as WorkspaceRead;
      }
      // bb lists at most 1000 remote branches (a large monorepo has more): the base's and the branch's copies are looked up by name
      const listed = async (query?: string) => ((await gitCall("branches", { environmentId, limit: 1000, ...(query ? { query } : {}) })) as { remoteBranches?: string[] }).remoteBranches ?? [];
      const baseName = baseBranchOf(base);
      let remotes = [...new Set([...(await listed()), ...(baseName ? await listed(baseName) : [])])];
      // against origin's base, never a stale local one. No fetch: it would write refs in a checkout other agents share,
      // and a stale origin/<base> can only refuse a clean worktree (retry after a fetch), never pass a dirty one.
      const upstream = remoteBase(base, remotes);
      if (upstream) base = (await gitCall("workspaceStatus", { environmentId, mergeBaseBranch: upstream })) as WorkspaceRead;
      const branch = base.outcome === "available" && "workspace" in base && base.workspace.checkout.kind === "branch" ? (base.workspace.checkout.branchName ?? null) : null;
      if (branch) remotes = [...new Set([...remotes, ...(await listed(branch))])];
      const remote = remoteBranchFor(branch, remotes);
      const pushed = remote ? ((await gitCall("workspaceStatus", { environmentId, mergeBaseBranch: remote })) as WorkspaceRead) : null;
      return worktreeVerdict(base, remotes, pushed);
    } catch (e) {
      return { clean: false, why: `its git status couldn't be read (${errText(e)})` };
    }
  }

  /**
   * Before bb archives a thread (and, once no thread holds it, removes its worktree): copy the notes the clean check lets
   * stay uncommitted (handoff-*.md, report.md at the root) and the files of outputs recorded inside the worktree to
   * <stateDir>/threads/<id>/, and point those outputs at the copies so the Deliverables tab still opens them. Says what was
   * kept, or "" when nothing was. A failed copy throws: the archive waits rather than lose them.
   */
  function keepFiles(threadId: string, worktree: string | null): string {
    if (!worktree || !existsSync(worktree)) return "";
    const root = realpathSync(worktree);
    const dir = join(stateDir(), "threads", threadId);
    const notes = readdirSync(root, { withFileTypes: true }).filter((d) => d.isFile() && EXEMPT_NOTE.test(d.name)).map((d) => d.name);
    for (const n of notes) {
      mkdirSync(dir, { recursive: true });
      cpSync(join(root, n), join(dir, n));
    }
    let moved = 0;
    for (const o of engine.outputsUnder(root)) {
      if (!existsSync(o.path!)) continue; // already gone: nothing left to keep
      const to = join(dir, "outputs", relative(root, o.path!));
      mkdirSync(dirname(to), { recursive: true });
      cpSync(o.path!, to, { recursive: true });
      engine.repointOutput(o.id, to);
      moved++;
    }
    const what = [...notes, ...(moved ? [`${moved} output(s)`] : [])];
    return what.length ? ` Kept ${what.join(", ")} in ${dir}.` : "";
  }

  /** bb archives these threads in order (handoff predecessors first); each gets its Board row, a failure a notice. Skips what bb already archived. */
  async function archiveThreads(ids: string[], project: string | null): Promise<{ archived: string[]; failed: string[] }> {
    const archived: string[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      const t = (await bb.sdk.threads.get({ threadId: id }).catch(() => null)) as (ThreadInfo & { archivedAt?: number | null }) | null;
      if (!t || t.archivedAt) continue;
      try {
        const env = t.environmentId ? ((await bb.sdk.environments.get({ environmentId: t.environmentId })) as unknown as { path?: string | null }) : null;
        const kept = keepFiles(id, env?.path ?? null);
        const r = await bb.sdk.threads.archive({ threadId: id });
        engine.boardAdd("archived", "orchestrator", project, `Archived ${id}`, `bb archived: ${r.archivedThreadIds.join(", ")}. The branch stays.${kept}`, id);
        archived.push(id);
      } catch (e) {
        failed.push(`${id} (${errText(e)})`);
      }
    }
    if (failed.length) engine.boardAdd("notice", "orchestrator", project, `${failed.length} thread(s) not archived in bb`, `Archive them by hand: ${failed.join(", ")}`, null);
    return { archived, failed };
  }

  // an object, or the JSON-string form agents on an older schema send; parsed again in execute (idempotent) so both reach the engine as one
  const HANDED_OFF = z.preprocess(fromJson, z.object({ pr: z.string().min(1).max(500).describe("The open PR's https link"), owner: z.string().min(1).max(40).describe("Who has the PR now"), note: z.string().max(200).optional() }));
  const RESOLVE_UPDATE = "Post an update with orch_status (update: working_on 1-3 bullets, at, needs): it is the Lead status card on your project. Plain words about the task and what is done; no SHAs, run ids or tool names.";
  bb.agents.registerTool({
    name: "orch_resolve",
    description: `Lead only: resolve one of your finished threads: retires its role and archives it (with the thread it took over from, if any). Needs a clean worktree: nothing uncommitted (untracked handoff-*.md and report.md at its root don't count; archiving keeps a copy of them and of outputs in the worktree), and its branch in its base branch or pushed; a dirty one is refused with the reason. And its PR merged, its branch merged into its base branch (a local merge counts), its PR closed without merging once it has reported, or ${O.name} has read the thread since its last orch_report, or pass handed_off {pr, owner} when its open PR now belongs to someone else (the project page lists it under Handed off). A thread bb already archived is resolved on its own.`,
    presentation: { label: { pending: "Resolving a thread", completed: "Resolved a thread" } },
    parameters: z.object({
      to: z.string().describe("thread:<project>:<n>"),
      handed_off: HANDED_OFF.optional().describe("Resolve while its PR is still open because someone else owns it now: {pr, owner, note?}"),
    }),
    execute: async (p, { threadId }) => {
      try {
        const a = caller(threadId);
        const t = engine.agentByAddress(p.to);
        // a retired address: the engine says whether it was already resolved (no PR lookup needed)
        if (!t) return ok(engine.resolve(a, p.to, { prMerged: false, lastReadAt: null }));
        if (t.role !== "thread" || t.project !== a.project) throw new EngineError("forbidden", "resolve only your own threads");
        const th = await threadInfo(t.threadId);
        let merged = false;
        let closed = false;
        if (th.environmentId) {
          const r = (await prFetch([th.environmentId]))[th.environmentId];
          if (r) {
            engine.prSeen(t, th.environmentId, r);
            merged = r.outcome === "available" && r.pullRequest.state === "merged";
            closed = r.outcome === "available" && r.pullRequest.state === "closed";
          }
        }
        // only predecessors in the same bb environment: the link is the takeover's instant, the worktree must match too
        const before: string[] = [];
        for (const id of engine.predecessors(t.threadId)) {
          const pt = await threadInfo(id).catch(() => null);
          if (pt && pt.environmentId === th.environmentId) before.push(id);
        }
        const out = engine.resolve(a, p.to, { prMerged: merged || engine.prFor(th.environmentId)?.state === "merged", prClosed: closed || engine.prFor(th.environmentId)?.state === "closed", lastReadAt: th.lastReadAt, worktree: await worktreeOf(th.environmentId, (th as { archivedAt?: number | null }).archivedAt ?? null), handedOff: p.handed_off === undefined ? null : HANDED_OFF.parse(p.handed_off) });
        // predecessors first: they share the worktree, so it goes (if ever) only with the last of them
        const { archived, failed } = await archiveThreads([...before, t.threadId], a.project);
        void flush();
        const said = [archived.length ? `Archived ${archived.join(", ")}.` : "", failed.length ? `Not archived: ${failed.join(", ")}.` : ""].filter(Boolean);
        const tell = p.handed_off ? " Add it to your PROJECT.md 'Open PRs handed off' list if you keep one." : "";
        return ok(`${out} ${said.join(" ") || "bb had already archived it."}${tell} ${RESOLVE_UPDATE}`);
      } catch (e) {
        return fail(errText(e));
      }
    },
  });

  bb.agents.registerTool({
    name: "orch_handoff",
    description: "Lead only: hand one of your threads to a new thread on another provider, in the same worktree and branch. The thread must first write its handoff file (handoff-<UTC date>.md: PR, what's done and verified, how to test, risks, comments, next step). The successor keeps the address and its mail; the old thread is stopped and hidden. Resolving the successor later archives both.",
    presentation: { label: { pending: "Handing a thread over", completed: "Handed a thread over" } },
    parameters: z.object({
      to: z.string().describe("thread:<project>:<n>"),
      file: z.string().min(1).max(500).describe("The handoff file, relative to the thread's worktree or absolute inside it"),
      provider: z.enum(["claude-code", "codex"]),
      model: z.string().max(80).optional(),
      reasoning: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    }),
    execute: async (p, { threadId }) => {
      try {
        const a = caller(threadId);
        const t = engine.agentByAddress(p.to);
        if (a.role !== "lead" || !t || t.role !== "thread" || t.project !== a.project) throw new EngineError("forbidden", "hand over only your own threads");
        if (engine.project(a.project!)?.heldAt) throw new EngineError("bad_state", `${a.project} is on hold`);
        const th = await threadInfo(t.threadId);
        if (!th.environmentId) throw new EngineError("bad_state", `${p.to} has no environment`);
        const env = (await bb.sdk.environments.get({ environmentId: th.environmentId })) as unknown as { path?: string | null };
        if (!env.path) throw new EngineError("bad_state", `${p.to}'s environment has no folder on this machine`);
        const root = realpathSync(env.path);
        const file = handoffFile(root, p.file);
        const selection = await spawnSelection(bb.sdk.providers, { environmentId: th.environmentId }, p);
        // spawned without a parent, so the auto-register for a lead's new child doesn't take it; the parent is set below
        const n = await bb.sdk.threads.spawn({
          projectId: th.projectId,
          environment: { type: "reuse", environmentId: th.environmentId },
          prompt: `You take over ${p.to} (from thread ${t.threadId}) in this worktree. Read ${file} first: it says what is done, how to test, and what to do next. You are ${p.to} in ${ownerWords(cfg.ownerName).name}'s orchestrator; your lead is lead:${a.project}.`,
          title: `${th.title ?? p.to} (${p.provider})`,
          ...selection,
          pluginMetadata: { role: "thread", project: a.project, successorOf: t.threadId },
        } as Parameters<typeof bb.sdk.threads.spawn>[0]);
        let succ: Agent;
        try {
          succ = engine.takeOver(t.threadId, n.id, `${p.provider}${p.model ? ` ${p.model}` : ""}; ${file}`, { from: (th as { providerId?: string }).providerId ?? null, to: p.provider });
        } catch (e) {
          // no role for it: stop the successor rather than leave it working as an orphan in the same worktree
          await bb.sdk.threads.stop({ threadId: n.id }).catch((x: unknown) => bb.log.warn(`handoff: stop orphan ${n.id}: ${errText(x)}`));
          throw new Error(`${errText(e)} (the new thread ${n.id} was stopped; ${p.to} is unchanged)`);
        }
        await bb.sdk.threads.update({ threadId: n.id, parentThreadId: a.threadId, parentNotifications: "auto" } as Parameters<typeof bb.sdk.threads.update>[0]);
        await bb.sdk.threads.updatePluginMetadata({ threadId: n.id, set: { address: succ.address, role: succ.role } });
        await bb.sdk.threads.stop({ threadId: t.threadId }).catch((e: unknown) => bb.log.warn(`handoff: stop ${t.threadId}: ${errText(e)}`));
        // hidden at once, not archived: it shares the successor's worktree, and resolving the successor archives both
        const hidden = await bb.sdk.threads
          .update({ threadId: t.threadId, visibility: "hidden" } as Parameters<typeof bb.sdk.threads.update>[0])
          .then(() => true)
          .catch((e: unknown) => (bb.log.warn(`handoff: hide ${t.threadId}: ${errText(e)}`), false));
        void flush();
        return ok(`${p.to} is now ${n.id} on ${p.provider}; ${t.threadId} is stopped${hidden ? " and hidden" : " (not hidden: see the log)"}. Resolving ${p.to} archives both.`);
      } catch (e) {
        return fail(errText(e));
      }
    },
  });

  // ---------------------------------------------------------------- push: a card entered Needs you (desktop/web only)
  // A push that reached a phone pauses it across reloads (a reload must not buy one more phone notification). With
  // mobile push on, nothing is sent anyway: that pause is re-found on every card. Switching pushNeedsYou off and on lifts
  // either.
  const PUSH_PAUSED = "pushPaused";
  let pushBlocked = false;
  try {
    pushBlocked = (await bb.storage.kv.get<boolean>(PUSH_PAUSED)) === true;
  } catch (e) {
    bb.log.warn(`push: read the pause: ${errText(e)}`);
  }
  const pausePush = (title: string, body: string, ref: string | null, keep: boolean) => {
    pushBlocked = true;
    if (keep) void Promise.resolve().then(() => bb.storage.kv.set(PUSH_PAUSED, true)).catch((e: unknown) => bb.log.warn(`push: keep the pause: ${errText(e)}`));
    engine.boardAdd("notice", "orchestrator", null, title, body, ref);
  };
  async function resumePush(): Promise<void> {
    if (!pushBlocked) return;
    pushBlocked = false;
    await Promise.resolve().then(() => bb.storage.kv.delete(PUSH_PAUSED)).catch((e: unknown) => bb.log.warn(`push: lift the pause: ${errText(e)}`));
    engine.boardAdd("notice", "orchestrator", null, "Needs-you push resumed", "pushNeedsYou was switched back on. It pauses again if mobile push is on.", null);
  }
  /**
   * notifications.send, which thread levels never mute (so notifyOnlyOrchestrator keeps these). With threadId a click
   * opens that thread; a thread bb no longer has is refused before anything is sent, so that one goes again without it.
   */
  async function sendPush(input: { title: string; body: string }, threadId: string | null): Promise<{ channels: string[] }> {
    const send = (withThread: boolean) =>
      bb.sdk.plugins.callRpc({
        pluginId: "push-notifications",
        method: "notifications.send",
        input: withThread && threadId ? { ...input, threadId } : input,
        outputSchema: z.object({ channels: z.array(z.string()) }).passthrough(),
      }) as Promise<{ channels: string[] }>;
    if (!threadId) return send(false);
    try {
      return await send(true);
    } catch (e) {
      if (!/thread_not_found|Thread not found/i.test(errText(e))) throw e;
      return send(false);
    }
  }
  async function pushCard(d: Decision): Promise<void> {
    if (!cfg.pushNeedsYou || pushBlocked) return bb.log.info(`push ${d.id}: off (${pushBlocked ? "paused" : "setting"})`);
    try {
      const ps = (await bb.sdk.plugins.getSettings({ pluginId: "push-notifications" })) as unknown as { values?: { mobileEnabled?: boolean } };
      if (ps.values?.mobileEnabled !== false) {
        pausePush("Needs-you push is paused: mobile push is on", "The orchestrator never sends a phone notification. Turn mobile push off, then switch pushNeedsYou off and on again (or reload the plugin).", null, false);
        return;
      }
      bb.log.info(`push ${d.id}: sending (mobile push is off)`);
      const res = await sendPush(
        { title: `Needs you: ${d.ask?.title ?? d.request.title}`, body: `${d.project ? `${d.project} · ` : ""}${d.ask?.question ?? d.request.question}`.slice(0, 180) },
        engine.agentByAddress(d.request.by.address)?.threadId ?? d.request.by.thread ?? null,
      );
      bb.log.info(`push ${d.id}: reached ${JSON.stringify(res.channels)}`);
      if (res.channels.includes("mobile")) pausePush("Needs-you push reached a phone; paused", "Mobile push must be off. Paused (also across reloads) until pushNeedsYou is switched off and on again.", d.id, true);
    } catch (e) {
      bb.log.warn(`push ${d.id}: ${errText(e)}`);
    }
  }

  // ---------------------------------------------------------------- push: a lead delivered (desktop/web only)
  // pushCard's guard, for a deliverable. TODO after the p-fixes/p-lead merge: fold the shared guard into one helper.
  async function pushDelivered(d: Deliverable): Promise<void> {
    if (!cfg.pushNeedsYou || pushBlocked) return bb.log.info(`push ${d.id}: off (${pushBlocked ? "paused" : "setting"})`);
    try {
      const ps = (await bb.sdk.plugins.getSettings({ pluginId: "push-notifications" })) as unknown as { values?: { mobileEnabled?: boolean } };
      if (ps.values?.mobileEnabled !== false) {
        pushBlocked = true;
        engine.boardAdd("notice", "orchestrator", null, "Needs-you push is paused: mobile push is on", "The orchestrator never sends a phone notification. Turn mobile push off (or pushNeedsYou off) and reload the plugin.", null);
        return;
      }
      const res = await sendPush(
        { title: `Delivered: ${d.title}`, body: `${d.project ? `${d.project} · ` : ""}${d.rev > 1 ? `rev ${d.rev} · ` : ""}${d.summary}`.slice(0, 180) },
        engine.agentByAddress(d.lead)?.threadId ?? null,
      );
      bb.log.info(`push ${d.id}: reached ${JSON.stringify(res.channels)}`);
      if (res.channels.includes("mobile")) {
        pushBlocked = true;
        engine.boardAdd("notice", "orchestrator", null, "Needs-you push reached a phone; paused", "Mobile push must be off. Paused until the plugin reloads.", d.id);
      }
    } catch (e) {
      bb.log.warn(`push ${d.id}: ${errText(e)}`);
    }
  }

  // ---------------------------------------------------------------- deliverables: the lead's finished work, with proof, for the owner
  /** The folders a lead's proof may come from: its own environment, its threads' environments, the shared folders. */
  async function deliverPlace(lead: Agent): Promise<DeliverPlace> {
    const envOf = async (a: Agent) => {
      const envId = a.environmentId ?? (await threadInfo(a.threadId).catch(() => null))?.environmentId ?? null;
      if (!envId) return null;
      const env = (await bb.sdk.environments.get({ environmentId: envId }).catch(() => null)) as unknown as { path?: string | null; hostId?: string | null } | null;
      return env?.path ? { path: env.path, hostId: env.hostId ?? null } : null;
    };
    const own = await envOf(lead);
    const threads = engine.agents().filter((t) => t.role === "thread" && t.project === lead.project);
    const theirs = await Promise.all(threads.map(envOf));
    const roots = [own, ...theirs].filter((r): r is { path: string; hostId: string | null } => r !== null);
    for (const path of sharedRoots()) roots.push({ path, hostId: own?.hostId ?? null });
    return { roots };
  }

  /**
   * Where a project's file pins may come from, whoever pins: its lead's proof folders (deliverPlace, unchanged), on the
   * lead's host. No lead: the shared folders only, and no host, so a file pin is refused (a link or deliverable is fine).
   */
  async function pinPlace(slug: string): Promise<OutputPlace> {
    const lead = engine.agentByAddress(`lead:${slug}`);
    if (!lead) return { roots: sharedRoots(), hostId: null };
    const { roots } = await deliverPlace(lead);
    // each root keeps its own host: a file opens on the machine of the folder it is in (engine.pin, hostOfPath)
    return { roots: roots.map((r) => r.path), hostId: roots.find((r) => r.hostId)?.hostId ?? null, hosts: roots };
  }

  bb.agents.registerTool({
    name: "orch_deliver",
    description:
      `Lead only: hand ${O.name} a finished deliverable with proof; this and orch_ask are the only ways to reach ${O.name}. At least one proof item: ` +
      "image, video or text (a file path), doc (a path or URL), pr or link (a URL). A file must be inside your worktree, one of your threads' worktrees, " +
      `${sharedRoots().join(" or ")}; text at most 256 KB; images png/jpg/gif/webp/avif, videos mp4/webm/mov. ` +
      `The summary, points and blocks together show at most ${DELIVER_BUDGET} characters. ` +
      `${O.Name} approves it (maybe with a next action: deliverable.next, do it and ack with a note) or requests changes; on deliverable.changes, fix it and call this again with revises=<id>.`,
    presentation: { label: { pending: `Delivering to ${O.name}`, completed: `Delivered to ${O.name}` } },
    parameters: z.object({
      title: z.string().min(1).max(120),
      summary: z
        .string()
        .min(1)
        .max(900)
        .describe("One line of context, at most 160 characters: what this is. It sits above the visuals; the points say what was decided and found"),
      points: deliverPoints.describe(
        "2-6 points, drawn first after the visuals: each decision or finding as one plain line (headline) with a short why. No file:line, SHAs, logs or tool names; those go in proof. With points, the summary is one line (160), captions 80, and decisions blocks 70 + a 110 why",
      ),
      proof: z
        .array(
          z.object({
            kind: z.enum(PROOF_KINDS),
            caption: z.string().min(1).max(200).describe("One short line, at most 80 characters: what this proves"),
            path: z.string().min(1).max(4000).optional().describe("Absolute path of the file (image, video, text, doc)"),
            url: z.string().min(1).max(4000).optional().describe("http(s) URL (pr, link, doc)"),
          }),
        )
        .min(1)
        .max(20),
      revises: z.string().optional().describe(`The id of your deliverable ${O.name} sent back with changes`),
      blocks: deliverBlocks.describe(
        `Typed parts drawn as visuals, under the screenshots: verdicts (a PR review: one tile per PR with a short verdict), decisions (what was decided, proposed or needs ${O.name}, each with a one-line why), ` +
          "diagram (2-14 boxes and arrows, each marked added/changed/removed/same: what a PR changes, or where a bug sits), " +
          "rca (symptom, root cause, fix), changes (what still has to change: must/should/nit, with where), checks (what was proven and how), " +
          "facts (figures, before/after), steps, pr, list, command. Use them instead of prose.",
      ),
    }),
    execute: async (p, { threadId }) => {
      try {
        const a = caller(threadId);
        if (a.role !== "lead") throw new EngineError("forbidden", `only a lead delivers to ${ownerWords(cfg.ownerName).name}`);
        const tooLong = lessTextRefusal(p) ?? deliverBudgetRefusal(p);
        if (tooLong) throw new EngineError("invalid", tooLong);
        const place = p.proof.some((x) => x.path) ? await deliverPlace(a) : { roots: [] };
        const d = engine.deliver(a, { title: p.title, summary: p.summary, points: p.points, proof: p.proof as ProofInput[], revises: p.revises ?? null, blocks: p.blocks }, place);
        void flush();
        return ok(`Delivered ${d.id} rev ${d.rev}: in ${ownerWords(cfg.ownerName).name}'s review. The approval or requested changes come as a message.`);
      } catch (e) {
        return fail(errText(e));
      }
    },
  });

  bb.agents.registerTool({
    name: "orch_deliver_withdraw",
    description: "Lead only: take back one of your deliverables that is in review or sent back (never an approved one).",
    presentation: { label: { pending: "Withdrawing a deliverable", completed: "Withdrew a deliverable" } },
    parameters: z.object({ id: z.string(), reason: z.string().max(2000).optional() }),
    execute: (p, { threadId }) => run(threadId, (a) => `Withdrew ${engine.withdrawDeliverable(a, p.id, p.reason ?? null).id}.`),
  });

  bb.agents.registerTool({
    name: "orch_status",
    description:
      `Lead only: publish where your project is, drawn as the step bar on its page and a line on Projects. Call it when you start, at each step change and whenever what you wait on changes; after 2 h without one it shows as stale. ` +
      `A field you leave out keeps its last value; null or [] clears it. waiting_on.kind owner means ${O.name}. ` +
      `update (working_on: 1-3 bullets, at, needs) is the Lead status card on your project: include it when a thread finishes and at each milestone; it replaces the last one.`,
    presentation: { label: { pending: "Publishing status", completed: "Published status" } },
    parameters: statusParams,
    execute: (p, { threadId }) =>
      run(threadId, (a) => {
        // parsed again (it is idempotent): JSON-string arguments must decode even where the host passed them raw
        const parsed = statusParams.safeParse(p);
        if (!parsed.success) throw new EngineError("invalid", parsed.error.issues.map((i) => `${i.path.join(".") || "status"}: ${i.message}`).join("; "));
        const s = engine.publishStatus(a, parsed.data);
        const ignored = ignoredTopLevelUpdate(parsed.data);
        const note = ignored.length ? ` Ignored top-level ${ignored.join(", ")}: update was given and wins; put them inside update.` : "";
        return `Published: ${statusLine(s, ownerWords(cfg.ownerName).name) || s.goal}.${note}`;
      }),
  });

  // ---------------------------------------------------------------- outputs (phase 3): finished artefacts for the owner
  bb.agents.registerTool({
    name: "orch_output",
    description:
      `Record a finished artefact (a doc, video, image, report or link) for use as deliverable proof. It is listed on the Deliverables tab (inside the deliverable that uses it as proof, else under Files) and in Activity; it does not notify ${O.name}. ` +
      `A file is an absolute path inside your worktree, ${sharedRoots().join(" or ")}; ${O.name} opens it in bb's preview. A link is an http(s) URL. ` +
      `Lead only: pin: true also pins it to your project's Pinned strip (at most ${PINS_MAX}); \`bb orchestrator unpin <project> <path|url|pin id>\` unpins it.`,
    presentation: { label: { pending: "Recording an output", completed: "Recorded an output" } },
    parameters: z.object({
      title: z.string().min(1).max(200),
      kind: z.enum(OUTPUT_KINDS),
      path: z.string().min(1).max(4000).optional().describe("Absolute path of the file (give this or url)"),
      url: z.string().min(1).max(4000).optional().describe("An http(s) link (give this or path)"),
      note: z.string().max(2000).optional().describe(`One or two lines for ${O.name}: what it is, what to look at`),
      pin: z.boolean().optional().describe("Lead only: also pin it to your project's Pinned strip, under the message box"),
    }),
    execute: async (p, { threadId }) => {
      try {
        const a = caller(threadId);
        if (p.pin && (a.role !== "lead" || !a.project)) throw new EngineError("forbidden", "only a lead pins to its project");
        const roots = sharedRoots();
        let hostId: string | null = null;
        if (p.path) {
          // the caller's own folder and the host it is on, as orch_handoff finds a thread's worktree
          const th = await threadInfo(a.threadId);
          if (th.environmentId) {
            const env = (await bb.sdk.environments.get({ environmentId: th.environmentId })) as unknown as { path?: string | null; hostId?: string | null };
            if (env.path) roots.unshift(env.path);
            hostId = env.hostId ?? null;
          }
          if (!hostId) throw new EngineError("bad_state", `your thread has no environment on a bb host, so ${ownerWords(cfg.ownerName).name} couldn't open the file`);
        }
        const { output, created } = engine.addOutput(a, { title: p.title, kind: p.kind, path: p.path ?? null, url: p.url ?? null, note: p.note ?? null }, { roots, hostId });
        // the output's own path already passed the proof check against these roots; a repeat output still pins
        const pinned = p.pin ? engine.pin(a.project!, output.path ?? output.url!, { title: p.title, by: a }, { roots, hostId: output.hostId ?? hostId }) : null;
        const pinNote = pinned ? (pinned.created ? ` Pinned as ${pinned.pin.id}.` : ` Already pinned as ${pinned.pin.id}.`) : "";
        return ok((created ? `Recorded ${output.id}: on ${ownerWords(cfg.ownerName).name}'s Deliverables tab (Files until a deliverable uses it as proof) and the Board.` : `Already recorded as ${output.id}.`) + pinNote);
      } catch (e) {
        return fail(errText(e));
      }
    },
  });

  bb.agents.registerTool({
    name: "orch_host",
    description: "Steward only: the host's CPU, memory, swap and disk now.",
    presentation: { label: { pending: "Reading the host", completed: "Read the host" } },
    parameters: z.object({}),
    execute: (_p, { threadId }) =>
      run(threadId, (a) => {
        if (a.role !== "steward") throw new EngineError("forbidden", "Steward only");
        return JSON.stringify(sample(cfg.diskPath, Date.now()));
      }),
  });

  // The Steward's own actions (2026-11-13): fixed argv, nothing else.
  const CLEANUPS: Record<string, string[]> = {
    "bb-plugin-prune": [process.env.BB_CLI || "bb", "plugin", "prune"],
    "npm-cache-verify": ["npm", "cache", "verify"],
    "uv-cache-prune": ["uv", "cache", "prune"],
    "yarn-cache-clean": ["yarn", "cache", "clean"],
  };
  bb.agents.registerTool({
    name: "orch_cleanup",
    description: `Steward only: run one allow-listed cleanup: ${Object.keys(CLEANUPS).join(", ")}. Anything else needs ${O.name} (orch_ask).`,
    presentation: { label: { pending: "Running a cleanup", completed: "Ran a cleanup" } },
    parameters: z.object({ action: z.enum(Object.keys(CLEANUPS) as [string, ...string[]]) }),
    execute: async (p, { threadId }) => {
      try {
        const a = caller(threadId);
        if (a.role !== "steward") throw new EngineError("forbidden", "Steward only");
        const [cmd, ...args] = CLEANUPS[p.action]!;
        const out = await new Promise<string>((resolve) =>
          execFile(cmd!, args, { timeout: 600_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => resolve(`${err ? `exit ${String((err as { code?: unknown }).code ?? err.message)}\n` : ""}${stdout}${stderr}`.slice(-4000))),
        );
        engine.boardAdd("notice", a.address, null, `Steward ran ${p.action}`, out, null);
        return ok(out || "done");
      } catch (e) {
        return fail(errText(e));
      }
    },
  });

  // The memory tools: leads and threads of a known memory project (memorySetup). Read-only.
  // Read-only, listed only for threads of a memory project (memorySetup); the CoS and the Steward never get them.
  const memoryCaller = (threadId: string | undefined) => {
    const a = threadId ? engine.agentByThread(threadId) : null;
    if (a && (a.role === "cos" || a.role === "steward")) throw new EngineError("forbidden", "not for the CoS or the Steward");
    return a;
  };
  bb.agents.registerTool({
    name: TOOL_SEARCH,
    description:
      "Search the memory: the vault (project pages, decisions), each project's notes and, with transcripts, past Claude " +
      "sessions. Hybrid search. Each hit is `path:line [project]` and a snippet; read one with memory_page. It can take minutes.",
    presentation: { label: { pending: "Searching memory", completed: "Searched memory" } },
    parameters: z.object({
      query: z.string().min(1).max(QUERY_MAX).describe("What to look for, in words"),
      project: z.string().regex(SLUG).optional().describe("Keep to one project: its slug"),
      transcripts: z.boolean().optional().describe("Also search past Claude sessions (slower)"),
      limit: z.number().int().min(1).max(LIMIT_MAX).optional().describe(`Hits per section (default ${LIMIT_DEFAULT})`),
    }),
    execute: async (p, { threadId }) => {
      try {
        memoryCaller(threadId);
        return toolResult(await memoryRun(searchArgv(p), 10 * 60_000));
      } catch (e) {
        return fail(errText(e));
      }
    },
  });
  bb.agents.registerTool({
    name: TOOL_PAGE,
    description: "Read a memory page: a project's vault page by its slug, or a memory_search hit by its `path:line`. Read-only.",
    presentation: { label: { pending: "Reading a memory page", completed: "Read a memory page" } },
    parameters: z.object({
      ref: z.string().min(1).max(REF_MAX).describe("A project slug, or a hit's path or path:line"),
      lines: z.number().int().min(1).max(LINES_MAX).optional().describe(`How many lines (default ${LINES_DEFAULT})`),
    }),
    execute: async (p, { threadId }) => {
      try {
        memoryCaller(threadId);
        return toolResult(await memoryRun(pageArgv(p), 60_000));
      } catch (e) {
        return fail(errText(e));
      }
    },
  });

  // Tools per role, from the store (the authority; thread metadata is only a mirror any agent could write).
  // A thread spawned by `bb orchestrator spawn` carries its role in seeded metadata, so its first session already
  // lists its tools; every tool call still checks the store.
  bb.agents.configure((context) => {
    const a = engine.agentByThread(context.thread.id);
    const seeded = (context.pluginMetadata as { role?: unknown }).role;
    const role = a?.role ?? (context.origin.pluginId === bb.pluginId && ROLES.includes(seeded as Role) ? (seeded as Role) : null);
    if (!role) {
      // a thread without a role: only the memory tools, when its bb project is a memory project
      const mem = memorySetup({ role: null, project: null }, context.project.name, context.environment.path, memory, memoryProjectsNow, cfg.ownerName);
      if (mem.map) recordFolder(mem.map.folder, mem.map.project);
      return mem.tools.length ? { tools: mem.tools, skills: ["memory"], instructions: mem.instructions } : { tools: [], skills: [] };
    }
    const project = a?.project ?? ((context.pluginMetadata as { project?: unknown }).project as string | null | undefined) ?? null;
    const mem = memorySetup({ role, project }, context.project.name, context.environment.path, memory, memoryProjectsNow, cfg.ownerName);
    if (mem.map) recordFolder(mem.map.folder, mem.map.project);
    return {
      tools: [...TOOLS_BY_ROLE[role], ...mem.tools],
      skills: mem.tools.length ? ["orchestrator", "memory"] : ["orchestrator"],
      instructions: mem.instructions ? `${roleBrief(ownerWords(cfg.ownerName))[role]}\n\n${mem.instructions}` : roleBrief(ownerWords(cfg.ownerName))[role],
    };
  });

  // The live recovery view, rebuilt whenever bb resolves the thread's config (a start, a turn, after a compaction).
  bb.agents.contributeInstructions(({ threadId }) => {
    const a = threadId ? engine.agentByThread(threadId) : null;
    if (!a) return null;
    if (!engine.settings.batchInbox) return `[orchestrator] Your current inbox (as of ${new Date().toISOString()}):\n${engine.inbox(a).text}`;
    const delivery = "Batch inbox: on a debounced wake, orch_inbox reads ALL unread oldest first. Handle it, then orch_ack(through=<cursor>). Replies do not ack unread. INFO stays quiet unless needs_reply or due. Decision outcomes still use orch_ack(id,outcome). ";
    return `[orchestrator] ${delivery}Your current recovery view (not a digest read; as of ${new Date().toISOString()}):\n${engine.inbox(a).text}`;
  });

  // ---------------------------------------------------------------- events
  bb.events.on("thread.created", async ({ thread }) => {
    const parent = (thread as { parentThreadId?: string | null }).parentThreadId ?? null;
    if (!parent || engine.agentByThread(thread.id)) return;
    const lead = engine.agentByThread(parent);
    if (lead?.role !== "lead") return;
    try {
      const a = engine.register(thread.id, "thread", lead.project, parent);
      engine.setEnvironment(thread.id, (thread as { environmentId?: string | null }).environmentId ?? null);
      await bb.sdk.threads.updatePluginMetadata({ threadId: thread.id, set: { address: a.address, role: a.role } });
      bb.log.info(`registered ${thread.id} as ${a.address}`);
    } catch (e) {
      bb.log.warn(`auto-register ${thread.id}: ${errText(e)}`);
    }
  });
  bb.events.on("thread.active", ({ thread }) => {
    if (!engine.agentByThread(thread.id)) return;
    engine.setStatus(thread.id, "active");
    void flush();
  });
  const bbParent = (t: unknown) => (t as { parentThreadId?: string | null }).parentThreadId ?? null;
  const bbNotify = (t: unknown) => (t as { parentNotifications?: string }).parentNotifications;
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    const a = engine.agentByThread(thread.id);
    if (!a) return;
    engine.setStatus(thread.id, "idle");
    void collectXp(thread.id);
    if (a.role === "thread" && !engine.bbTellsSupervisor(a, bbParent(thread), bbNotify(thread), "turn"))
      engine.notifySupervisor(a, `finished a turn. Last words: ${JSON.stringify((lastAssistantText ?? "").slice(0, 400))}`);
    void flush();
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    const a = engine.agentByThread(thread.id);
    if (!a) return;
    engine.setStatus(thread.id, "error");
    if (!engine.bbTellsSupervisor(a, bbParent(thread), bbNotify(thread), "failure"))
      engine.notifySupervisor(a, `failed: ${error ?? "unknown error"}`);
    void flush();
  });
  bb.events.on("turn.failed", (ev) => {
    const a = engine.agentByThread(ev.threadId);
    if (!a) return;
    const rl = ev.rateLimits ? ` Rate limits: ${JSON.stringify(ev.rateLimits).slice(0, 400)}` : "";
    engine.notifySupervisor(a, `a turn failed (${ev.errorInfo ? JSON.stringify(ev.errorInfo).slice(0, 300) : "no detail"}).${rl}`);
    void flush();
  });
  bb.events.on("thread.archived", ({ thread }) => {
    if (engine.agentByThread(thread.id)) engine.setStatus(thread.id, "archived");
  });
  bb.events.on("interaction.pending", ({ thread }) => {
    if (engine.agentByThread(thread.id)) changed();
  });
  bb.events.on("message.dispatched", ({ entry }) => engine.dispatched(entry.id));
  bb.events.on("message.cancelled", ({ entry }) => engine.cancelled(entry.id));

  async function stopAgent(t: Agent) {
    engine.setStatus(t.threadId, "stopped");
    await bb.sdk.threads.stop({ threadId: t.threadId });
    engine.boardAdd("notice", "orchestrator", t.project, `${t.address} stopped`, "", t.threadId);
  }
  async function startAgent(t: Agent) {
    engine.setStatus(t.threadId, "active");
    await flush();
  }

  // ---------------------------------------------------------------- the clock, the CoS's context, the host
  // Claude Code's own /compact (bb's threads.compact), never a clear: the CoS keeps a summary of its conversation in the
  // same session (2026-11-16). Its open items also come back on every turn through its instructions and orch_inbox.
  let lastCompact: { capturedAt: string | null; at: number } | null = null;
  async function compactCos(force: boolean): Promise<string> {
    const cos = engine.agentByAddress("cos");
    if (!cos) return "no CoS";
    if (!force && cfg.cosCompactTokens <= 0) return "compaction is off (cosCompactTokens = 0); Claude Code still auto-compacts on its own";
    const t = await bb.sdk.threads.get({ threadId: cos.threadId });
    if (t.status !== "idle") return `CoS is ${t.status}; not compacting`;
    const ctx = await bb.sdk.threads.context({ threadId: cos.threadId });
    const used = ctx.usage?.usedTokens ?? 0;
    const capturedAt = ctx.usage?.snapshot?.capturedAt ?? null;
    if (!force) {
      if (used < cfg.cosCompactTokens) return `CoS at ${used} tokens; under the threshold`;
      // the reading can lag the compaction: wait for a new one, and at least COMPACT_COOLDOWN_MS, before asking again
      if (lastCompact && (lastCompact.capturedAt === capturedAt || Date.now() - lastCompact.at < COMPACT_COOLDOWN_MS))
        return `CoS at ${used} tokens; a compaction was requested at ${new Date(lastCompact.at).toISOString()}, waiting for a new reading`;
    }
    try {
      await bb.sdk.threads.compact({ threadId: cos.threadId });
    } catch (e) {
      return `couldn't compact the CoS: ${errText(e)}`;
    }
    lastCompact = { capturedAt, at: Date.now() };
    engine.boardAdd("notice", "orchestrator", null, `Asked Claude Code to compact the CoS's context (${used} tokens)`, "It summarizes the conversation and goes on in the same session; open items also stay in the CoS's instructions and orch_inbox.", cos.threadId);
    return `requested compaction of the CoS's context at ${used} tokens`;
  }

  // ---------------------------------------------------------------- the sidebar: one section per project (2026-11-13)
  // Each lead and its threads sit in a bb thread section named after the project; the CoS and the Steward in
  // "Orchestrator". Only threads with no section are placed, so a thread the owner moves by hand stays where they put it.
  const placed = new Set<string>();
  let placing: Promise<void> | null = null;
  const placeSections = (): Promise<void> =>
    (placing ??= (async () => {
      try {
        const live = placeable(engine.agents(), placed, engine.projects());
        if (!live.length) return;
        const rank = new Map(engine.projects().map((p, i) => [p.slug, i]));
        live.sort((x, y) => (rank.get(x.project ?? "") ?? 99) - (rank.get(y.project ?? "") ?? 99));
        const sections = await bb.sdk.threadSections.list();
        const byName = new Map(sections.map((x) => [x.name, x.id]));
        for (const a of live) {
          const name = sectionTitle(a.project);
          const t = await bb.sdk.threads.get({ threadId: a.threadId }).catch(() => null);
          if (!t) continue;
          if ((t as { sectionId?: string | null }).sectionId) {
            placed.add(a.threadId);
            continue;
          }
          let id = byName.get(name);
          if (!id) {
            id = (await bb.sdk.threadSections.create({ name })).id;
            byName.set(name, id);
          }
          await bb.sdk.threads.update({ threadId: a.threadId, sectionId: id });
          placed.add(a.threadId);
        }
      } catch (e) {
        bb.log.warn(`sections: ${errText(e)}`);
      } finally {
        placing = null;
      }
    })());

  // An archived project's section goes (2026-11-16); see core/sections.ts. Runs at load, after an archive and on the clock.
  let pruning: Promise<void> | null = null;
  let lastKept = "";
  const pruneProjectSections = (): Promise<void> =>
    (pruning ??= (async () => {
      try {
        const r = await pruneSections(
          {
            list: () => bb.sdk.threadSections.list(),
            liveThreadsIn: async (sectionId) => (await bb.sdk.threads.list({ sectionId, archived: false, includeHidden: true, limit: 200 })).map((t) => t.id),
            remove: (id) => bb.sdk.threadSections.delete({ id }),
          },
          engine.projects(),
        );
        if (r.removed.length) bb.log.info(`sections: removed ${r.removed.join(", ")} (archived project${r.removed.length === 1 ? "" : "s"})`);
        const kept = r.kept.join(", "); // once per change: this runs every 30 s
        if (kept !== lastKept) {
          lastKept = kept;
          if (kept) bb.log.info(`sections: kept ${kept}`);
        }
      } catch (e) {
        bb.log.warn(`sections prune: ${errText(e)}`);
      } finally {
        pruning = null;
      }
    })());

  // ---------------------------------------------------------------- levels: XP from each turn's token usage
  // bb logs a thread/tokenUsage/updated event per turn; its `last.totalTokens` is that turn's tokens (cache reads
  // included). Counted after the thread's cursor, so each turn counts once, and from the start for a new agent.
  const levelInfo = (a: Agent) => {
    const { tokens, level } = engine.xpOf(a.address);
    return { level, xp: tokens, xpThis: tokensForLevel(level), xpNext: tokensForLevel(level + 1), form: formAt(a.mon, level, a.monPin)?.name ?? a.mon };
  };
  const xpBusy = new Set<string>();
  const collectXp = async (threadId: string): Promise<void> => {
    if (xpBusy.has(threadId) || !engine.agentByThread(threadId)) return;
    xpBusy.add(threadId);
    try {
      let after = engine.xpCursor(threadId);
      for (let page = 0; page < 50; page++) {
        const rows = (await bb.sdk.threads.events.list({ threadId, types: ["thread/tokenUsage/updated"], afterSeq: String(after), order: "asc", limit: "100" })) as unknown as {
          seq: number | string;
          data?: { tokenUsage?: { last?: { totalTokens?: number } } };
        }[];
        if (!rows.length) break;
        let tokens = 0;
        for (const r of rows) tokens += r.data?.tokenUsage?.last?.totalTokens ?? 0;
        after = Math.max(...rows.map((r) => Number(r.seq)));
        engine.gainXp(threadId, tokens, after);
        if (rows.length < 100) break;
      }
    } catch (e) {
      bb.log.warn(`xp ${threadId}: ${errText(e)}`);
    } finally {
      xpBusy.delete(threadId);
    }
  };

  bb.background.service("clock", {
    async start(signal) {
      // bb waits 5 s for a stopped service, then fails the reload ("service clock did not stop", 2026-11-14, during a
      // pr-watch pass). So the clock stops waiting on a pass once it is stopped (a slow call's result is dropped), and
      // a pass checks the signal between steps and threads, so little of it runs on after that.
      const reconcile = async () => {
        // reservations an earlier instance left mid-spawn (never confirmed or released) give their slots back
        const stale = engine.sweepStaleSpawns(loadedAt);
        if (stale) bb.log.info(`spawns: released ${stale} stale reservation(s)`);
        // after a restart: queued rows that went while we were away count as delivered
        try {
          for (const it of engine.queuedItems()) {
            if (signal.aborted) return;
            const to = engine.agentByAddress(it.recipient);
            if (!to) continue;
            const rows = await bb.sdk.threads.queuedMessages.list({ threadId: to.threadId });
            if (!rows.some((r) => r.id === it.queuedMessageId)) engine.reconcileQueued((queued) => queued.id === it.id ? false : null);
          }
          for (const wake of engine.batch.wakes().filter((w) => w.state === "queued")) {
            if (signal.aborted) return;
            const to = engine.agentByAddress(wake.recipient);
            if (!to || !wake.queued_id) continue;
            const rows = await bb.sdk.threads.queuedMessages.list({ threadId: to.threadId });
            if (!rows.some((r) => r.id === wake.queued_id)) engine.batch.missingQueue(wake.queued_id);
          }
          for (const a of engine.agents()) {
            if (signal.aborted) return;
            if (a.status === "stopped") continue;
            const t = await bb.sdk.threads.get({ threadId: a.threadId }).catch(() => null);
            // bb reports an archived thread's last status (e.g. idle); keep it archived, so a Start can replace it
            if (t) engine.setStatus(a.threadId, (t as { archivedAt?: number | null }).archivedAt ? "archived" : t.status);
            if (t && !a.environmentId) engine.setEnvironment(a.threadId, (t as unknown as ThreadInfo).environmentId ?? null);
          }
        } catch (e) {
          bb.log.warn(`reconcile: ${errText(e)}`);
        }
      };
      let lastCompactCheck = 0;
      let lastPrCheck = 0;
      let lastPlace = 0;
      let lastXp = 0;
      const pass = async () => {
        try {
          engine.tick();
          sweepSecrets(join(stateDir(), "secrets"), Date.now() - SECRET_TTL_MS);
          engine.flagUnplanned(60_000);
          await flush();
          if (signal.aborted) return;
          if (cfg.prPollMinutes > 0 && Date.now() - lastPrCheck > cfg.prPollMinutes * 60_000) {
            lastPrCheck = Date.now();
            await prPass(null, signal).catch((e) => bb.log.warn(`pr-watch: ${errText(e)}`));
          }
          if (Date.now() - lastXp > 120_000) {
            lastXp = Date.now();
            for (const a of engine.agents()) {
              if (signal.aborted) return;
              if (a.status !== "archived") await collectXp(a.threadId);
            }
          }
          if (signal.aborted) return;
          if (Date.now() - lastPlace > 30_000) {
            lastPlace = Date.now();
            await placeSections();
            await pruneProjectSections();
          }
          if (signal.aborted) return;
          if (Date.now() - lastCompactCheck > 60_000) {
            lastCompactCheck = Date.now();
            await compactCos(false);
          }
        } catch (e) {
          if (!signal.aborted) bb.log.warn(`clock: ${errText(e)}`);
        }
      };
      await unlessAborted(reconcile(), signal);
      while (!signal.aborted) {
        await unlessAborted(pass(), signal);
        await sleep(5_000, signal);
      }
    },
  });

  const alarms = new AlarmState();
  const thresholds = (): Thresholds => ({ diskPct: cfg.diskPct, swapPct: cfg.swapPct, memPct: cfg.memPct, cpuPct: cfg.cpuPct, sustainMs: cfg.sustainSeconds * 1000 });
  let lastSnapshot: Snapshot | null = null;
  bb.background.service("steward-sampler", {
    async start(signal) {
      // a restart must not re-fire the level the Steward already heard
      alarms.restore(engine.lastAlarmLevel(), Date.now(), thresholds().sustainMs);
      while (!signal.aborted) {
        try {
          const now = Date.now();
          const s = sample(cfg.diskPath, now);
          lastSnapshot = s;
          const t = thresholds();
          const level = alarms.step(s, t, now);
          if (level !== null) {
            engine.alarm(level, s as unknown as Record<string, unknown>, describeAlarm(level, s, t));
            await flush();
          }
        } catch (e) {
          bb.log.warn(`sampler: ${errText(e)}`);
        }
        await sleep(Math.max(5, cfg.sampleSeconds) * 1000, signal);
      }
    },
  });

  // ---------------------------------------------------------------- dreams (phase 3, gap 5): nightly batch, memory check
  const dreamConfig = () => (memory ? loadDreamConfig(memory.configPath).config : null);
  const dreamOpts = (): DreamOptions => {
    const dc = dreamConfig();
    return {
      enabled: cfg.dreamsEnabled === true && dc !== null,
      dailyAt: dc?.dailyAt || (cfg.dreamDailyAt ?? "").trim(),
      zone: (cfg.dreamZone ?? "").trim() || "UTC",
      carry: dc?.carry ?? [],
      held: engine.projects().filter((p) => p.heldAt !== null).map((p) => p.slug),
      owner: cfg.ownerName,
      timers: parseTimers(cfg.memoryTimers),
    };
  };
  const dreams = new Dreams(
    db,
    engine,
    realDreamPorts({
      jobsDir: join(stateDir(), "dream", "jobs"),
      tools: () => (memory ? toolsDir(memory.search) : null),
      memoryConfig: () => memory?.configPath ?? null,
      configEnv: () => configEnvName(cfg.memoryConfigEnv),
      units: () => parseUnits(cfg.memoryUnits),
      dreamDir: () => dreamConfig()?.dreamDir ?? null,
      vault: () => memory?.vault ?? null,
      log: (m) => bb.log.info(m),
    }),
    dreamOpts,
  );
  bb.background.service("dreams", {
    async start(signal) {
      while (!signal.aborted) {
        // stopped mid-step, it stops waiting (bb gives a stopped service 5 s; a step's systemctl and git calls may take 30 s)
        await unlessAborted(dreams.step().catch((e) => bb.log.warn(`dreams: ${errText(e)}`)), signal);
        await sleep(60_000, signal);
      }
    },
  });

  // ---------------------------------------------------------------- reads (RPC)
  const card = (d: Decision, held: readonly Decision[] = []): Card => ({
    id: d.id,
    rev: d.rev,
    project: d.project,
    asker: d.orchestrator.asker,
    origin: d.orchestrator.origin,
    title: d.ask?.title ?? d.request.title,
    question: d.ask?.question ?? d.request.question,
    context: d.ask?.context ?? d.request.context,
    options: (d.ask?.options ?? d.request.options).map((o, i) => ({ id: o.id, label: o.label, detail: o.detail, recommended: o.recommended ?? i === 0 })),
    allowText: d.ask?.allow_text ?? true,
    askedAt: d.ask?.at ?? d.created_at,
    escalated: d.orchestrator.triage.escalated_at !== null,
    merge: d.orchestrator.action === "merge",
    deferred: d.deferred !== null,
    deferredUntil: d.deferred?.until ?? null,
    returnedAt: d.returned?.at ?? null,
    blocks: d.request.blocks ?? [],
    queued: held.filter((h) => h.orchestrator.held?.behind === d.id).length,
    prs: (d.request.blocks ?? []).flatMap((b) => {
      if (b.kind !== "pr") return [];
      const pr = engine.prByUrl(b.url);
      return pr ? [{ ...pr, url: b.url }] : [];
    }),
  });

  const providerOf = new Map<string, string | null>();
  bb.rpc.register(rpcContract, {
    async config() {
      return {
        ownerName: cfg.ownerName.trim(),
        cosTitle: cosTitleOf(cfg.cosTitle),
        linearWorkspace: cfg.linearWorkspace.trim(),
        linearTeams: cfg.linearTeams.split(",").map((t) => t.trim()).filter(Boolean),
        hiddenTabs: cfg.hiddenTabs.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
      };
    },
    async needsYou({ zone }) {
      const v = engine.needsYou();
      const interactions: NeedsYou["interactions"] = [];
      for (const a of engine.agents()) {
        try {
          const rows = ((await bb.sdk.threads.interactions.list({ threadId: a.threadId })) as unknown as RawInteraction[]).filter((r) => (r.status ?? "pending") === "pending");
          if (!rows.length) continue;
          const t = await bb.sdk.threads.get({ threadId: a.threadId });
          for (const r of rows) {
            const kind = r.kind ?? r.payload?.kind ?? "prompt";
            interactions.push({ id: r.id, threadId: a.threadId, address: a.address, title: t.title ?? a.address, kind, since: r.createdAt ? new Date(r.createdAt).toISOString() : null, questions: kind === "user_question" ? toQuestions(r.payload) : [] });
          }
        } catch {
          // a thread that is gone has nothing pending
        }
      }
      return {
        cards: v.cards.map((d) => card(d, v.held)),
        deferred: v.deferred.map((d) => card(d)),
        triaging: v.triaging.map((d) => ({ id: d.id, title: d.request.title, origin: d.orchestrator.origin, project: d.project, dueAt: d.orchestrator.triage.due_at })),
        interactions,
        presets: presets(zone, Date.now()),
        badge: v.cards.length + interactions.length,
      };
    },
    board() {
      return {
        rows: engine.board(),
        directUnread: [...engine.directLines()].filter(([, d]) => d.unread).map(([slug]) => slug),
        dead: engine.deadLetters({ board: true }).map((i) => ({ id: i.id, recipient: i.recipient, sender: i.sender, kind: i.kind, body: i.body, note: i.note, createdAt: i.createdAt })),
        agents: engine.agents().map((a) => ({ threadId: a.threadId, address: a.address, role: a.role, project: a.project, status: a.status, mon: a.mon, monType: engine.accentType(a.project) })),
        rules: engine.rules().map((r) => ({ id: r.id, text: r.text, project: r.project, kinds: r.kinds, expiresAt: r.expiresAt, source: r.source, createdAt: r.createdAt, revokedAt: r.revokedAt })),
        decisions: engine.decisions(50).map((d) => ({
          id: d.id,
          state: d.state,
          title: d.request.title,
          origin: d.orchestrator.origin,
          asker: d.orchestrator.asker,
          level: d.orchestrator.at_level,
          answer: d.answer ? `${d.answer.label ?? ""}${d.answer.text ? ` (${d.answer.text})` : ""} by ${d.answer.by} via ${d.answer.via}` : null,
          ack: d.ack ? `${d.ack.outcome} by ${d.ack.by}${d.ack.note ? `: ${d.ack.note}` : ""}` : null,
          updatedAt: d.updated_at,
        })),
      };
    },
    projects(): Projects {
      const agents = engine.agents();
      const summaries = engine.projectSummaries();
      const direct = engine.directLines();
      const prs = engine.knownPrs();
      const handedOff = engine.handedOffPrs();
      return engine.projects().map((p) => {
        const lead = agents.find((a) => a.role === "lead" && a.project === p.slug && a.status !== "archived");
        return {
          slug: p.slug,
          priority: p.priority,
          heldAt: p.heldAt,
          archivedAt: p.archivedAt,
          lead: lead ? { address: lead.address, threadId: lead.threadId, status: lead.status, mon: lead.mon } : null,
          monType: engine.accentType(p.slug), // the project accent: none with the setting off
          threads: agents.filter((a) => a.role === "thread" && a.project === p.slug).length,
          openPlans: engine.openPlans(p.slug),
          status: engine.leadStatus(p.slug),
          summary: summaries.get(p.slug) ?? null,
          direct: direct.get(p.slug) ?? null,
          prs: prs.filter((x) => x.project === p.slug).map(({ project: _, ...x }) => x),
          handedOff: handedOff.get(p.slug) ?? [],
        };
      });
    },
    async agents(): Promise<Agents> {
      return Promise.all(
        engine.agents().map(async (a) => {
          const t = (await bb.sdk.threads.get({ threadId: a.threadId, include: "environment" } as Parameters<typeof bb.sdk.threads.get>[0]).catch(() => null)) as
            | (ThreadInfo & { environment?: { branchName?: string | null } | null })
            | null;
          const ctx = await bb.sdk.threads.context({ threadId: a.threadId }).catch(() => null);
          const pr = engine.prFor(a.environmentId);
          const proj = a.project ? engine.project(a.project) : null;
          return {
            monType: engine.accentType(a.project), // the project accent for the sidebar: none with the setting off
            threadId: a.threadId,
            address: a.address,
            role: a.role,
            project: a.project,
            priority: proj?.priority ?? null,
            held: !!proj?.heldAt,
            status: t?.status ?? a.status,
            engineStatus: a.status,
            idleAt: a.idleAt,
            title: t?.title ?? null,
            lastReport: engine.lastReport(a.address),
            provider: (t as { providerId?: string } | null)?.providerId ?? null,
            mon: a.mon,
            ...levelInfo(a),
            model: ctx?.usage?.snapshot?.model ?? null,
            usedTokens: ctx?.usage?.usedTokens ?? null,
            contextWindow: ctx?.usage?.modelContextWindow ?? null,
            branch: t?.environment?.branchName ?? null,
            pr: pr ? { url: pr.url, number: pr.number, state: pr.state, attention: pr.attention, checks: pr.checks, review: pr.review } : null,
            unread: !!(t?.latestAttentionAt && (!t.lastReadAt || t.latestAttentionAt > t.lastReadAt)),
            flags: a.flags ? a.flags.split(",").filter(Boolean) : [],
          };
        }),
      );
    },
    projectBook({ slug, dayStart }) {
      return engine.projectBook(slug, dayStart);
    },
    directHistory({ slug, before, limit }) {
      return engine.directHistory(slug, before ?? null, limit ?? 30);
    },
    searchCards({ q }) {
      return engine.searchAnswered(q);
    },
    async projectHistory({ slug }) {
      const ids = engine.projectThreadIds(slug);
      // bb's provider per thread, asked once per thread for the plugin's life (it never changes)
      await Promise.all(
        ids
          .filter((id) => !providerOf.has(id))
          .map(async (id) => {
            const t = (await bb.sdk.threads.get({ threadId: id }).catch(() => null)) as { providerId?: string } | null;
            // a failed lookup is kept too (as unknown): it must not cost a bb call on every refetch
            providerOf.set(id, t?.providerId ?? null);
          }),
      );
      return engine.projectHistory(slug, providerOf);
    },
    /**
     * For the Deliverables tree: every project in the order the sidebar places new sections in, with its accent. The page
     * reorders it by the viewer's own section order (core/project-order.ts), which only the viewer's bb client can read.
     */
    projectOrder(): ProjectOrder {
      return engine.projects().map((p) => ({ slug: p.slug, monType: engine.accentType(p.slug) }));
    },
    outputs(): Outputs {
      return engine.outputs().map((o) => ({ id: o.id, title: o.title, kind: o.kind, path: o.path, url: o.url, hostId: o.hostId, note: o.note, project: o.project, author: o.author, at: o.at }));
    },
    deliverables(): Deliverables {
      return engine.deliverables().map((d) => ({
        id: d.id,
        project: d.project,
        lead: d.lead,
        leadMon: engine.agentByAddress(d.lead)?.mon ?? null,
        title: d.title,
        summary: d.summary,
        state: d.state,
        rev: d.rev,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        revisions: d.revisions.map((r) => ({
          rev: r.rev,
          summary: r.summary,
          at: r.at,
          blocks: r.blocks ?? [],
          points: r.points ?? [],
          prs: (r.blocks ?? []).flatMap((b) => {
            if (b.kind !== "pr") return [];
            const pr = engine.prByUrl(b.url);
            return pr ? [{ ...pr, url: b.url }] : [];
          }),
          proof: r.proof.map((x) => {
            const pr = x.kind === "pr" && x.url ? engine.prByUrl(x.url) : null;
            return { ...x, pr: pr ? { url: pr.url, number: pr.number, state: pr.state, attention: pr.attention, checks: pr.checks } : null };
          }),
        })),
        feedback: d.feedback,
        withdrawn: d.withdrawn,
        next: engine.deliverableNext(d),
      }));
    },
  });

  // ---------------------------------------------------------------- the owner's writes (HTTP, browser Origin required)
  // bb's "local" auth already refuses a foreign Origin but lets a request with none through; this also wants the page's
  // own origin and a same-origin fetch. Headers can be forged by any local process: see docs/security-notes.md.
  const appUrls = (): string[] => {
    const urls: (string | null)[] = [];
    try {
      urls.push(bb.server.experimental_appUrl); // BB_APP_URL, e.g. a TLS proxy's public URL
      urls.push(bb.server.loopbackBaseUrl);
    } catch {
      // not bound yet, or an older bb: the request's own host still counts
    }
    return urls.filter((u): u is string => !!u);
  };
  const notFromScreens = (c: { req: { url: string; header(name: string): string | undefined } }) =>
    writeOriginProblem({ origin: c.req.header("origin"), secFetchSite: c.req.header("sec-fetch-site"), requestUrl: c.req.url, appUrls: appUrls() });
  const write = <S extends z.ZodTypeAny>(path: string, schema: S, fn: (body: z.infer<S>) => unknown) =>
    bb.http.route("POST", path, async (c) => {
      const why = notFromScreens(c);
      if (why) return c.json({ ok: false, error: { kind: "forbidden", message: `writes come only from the app's screens (${why})` } }, 403);
      let body: z.infer<S>;
      try {
        body = schema.parse(await c.req.json());
      } catch (e) {
        return c.json({ ok: false, error: { kind: "invalid", message: errText(e) } }, 400);
      }
      try {
        const result = await fn(body);
        void flush();
        return c.json({ ok: true, result: result ?? null });
      } catch (e) {
        const kind = e instanceof EngineError ? e.kind : "error";
        return c.json({ ok: false, error: { kind, message: errText(e) } }, kind === "conflict" ? 409 : kind === "not_found" ? 404 : 422);
      }
    });

  // A code the owner pastes: written to a 0600 file, never into the decision (personSecret)
  const keepSecret = (id: string, rev: number, value: string, via: "desktop" | "phone", typed: boolean) => {
    const dir = join(stateDir(), "secrets");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const file = join(dir, `${id.replace(/[^\w-]/g, "")}.txt`);
    writeFileSync(file, value.trim(), { mode: 0o600 });
    try {
      return engine.personSecret(id, rev, file, via, typed).rev;
    } catch (e) {
      rmSync(file, { force: true });
      throw e;
    }
  };
  // a code typed into "Other" goes the masked field's way (looksLikeCode)
  write(WRITES.answer, answerBody, (b) =>
    b.option === null && looksLikeCode(b.text) ? keepSecret(b.id, b.rev, b.text!, b.via, true) : engine.personAnswer(b.id, b.rev, b.option, b.text, b.via).rev,
  );
  // a login block's masked field
  write(WRITES.secret, secretBody, (b) => keepSecret(b.id, b.rev, b.value, b.via, false));
  write(WRITES.defer, deferBody, (b) => {
    const p = presets(b.zone, Date.now()).find((x) => x.id === b.preset);
    if (!p) throw new EngineError("invalid", `preset ${b.preset} isn't offered now`);
    return engine.personDefer(b.id, b.rev, b.preset, p.until ? Date.parse(p.until) : null, b.via).rev;
  });
  write(WRITES.return, returnBody, (b) => engine.personReturn(b.id, b.rev).rev);
  write(WRITES.ruleAdd, ruleAddBody, (b) =>
    engine.addRule({ text: b.text, project: b.project || null, kinds: b.kinds, expiresAt: b.expiresInDays ? Date.now() + b.expiresInDays * 86_400_000 : null, source: b.source }).id,
  );
  write(WRITES.ruleRevoke, ruleRevokeBody, (b) => engine.revokeRule(b.id));
  write(WRITES.resend, resendBody, (b) => engine.resend(b.id).id);
  write(WRITES.priority, priorityBody, (b) => engine.setPriority(b.slug, b.priority));
  write(WRITES.hold, holdBody, (b) => engine.setHold(b.slug, b.held));
  // the owner's direct line to a lead (PLAN 3): an item, never a push; the CoS gets a copy
  write(WRITES.directMessage, directMessageBody, (b) => engine.ownerMessage(b.slug, b.text, b.followUp ?? null).id);
  write(WRITES.directSeen, directSeenBody, (b) => engine.markDirectSeen(b.slug, b.upTo));
  write(WRITES.outputRemove, outputRemoveBody, (b) => engine.removeOutput(b.id));
  // pinned documents: the owner pins a pasted path or URL, or a deliverable (core/pins.ts); paths get the proof check
  write(WRITES.pin, pinBody, async (b) => engine.pin(b.slug, b.target, { title: b.title ?? null, by: "owner" }, await pinPlace(b.slug)).pin.id);
  write(WRITES.unpin, unpinBody, (b) => engine.unpinDoc(b.id, { by: "owner" }).id);
  write(WRITES.approve, approveBody, (b) => engine.personApprove(b.id, b.rev, b.note, b.next ?? null).rev);
  write(WRITES.requestChanges, requestChangesBody, (b) => engine.personRequestChanges(b.id, b.rev, b.text).rev);
  // A registered proof file's bytes, by proof id only (engine.proofFile decides). Read-only, so bb's "local" auth is the
  // guard: a same-origin <img>/<video> sends no Origin header. Never HTML or SVG; nothing sniffed, nothing run.
  bb.http.route("GET", PROOF_ROUTE, async (c) => {
    let f: ReturnType<typeof engine.proofFile>;
    try {
      f = engine.proofFile(String(c.req.query("id") ?? ""));
    } catch (e) {
      return c.json({ ok: false, error: { kind: e instanceof EngineError ? e.kind : "error", message: errText(e) } }, 404);
    }
    const headers: Record<string, string> = {
      "content-type": f.contentType,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-cache",
    };
    try {
      if (f.maxBytes !== null) {
        // text: at most the cap, read as such (never the whole file then a slice)
        const fd = openSync(f.path, "r");
        try {
          const buf = Buffer.alloc(Math.min(statSync(f.path).size, f.maxBytes));
          const n = readSync(fd, buf, 0, buf.length, 0);
          return new Response(buf.subarray(0, n), { headers });
        } finally {
          closeSync(fd);
        }
      }
      // image/video: streamed; one byte range (a video's seek) answered with 206
      const size = statSync(f.path).size;
      headers["accept-ranges"] = "bytes";
      const m = /^bytes=(\d*)-(\d*)$/.exec((c.req.header("range") ?? "").trim());
      let start = 0;
      let end = size - 1;
      let status = 200;
      if (m && (m[1] || m[2])) {
        if (m[1]) {
          start = Number(m[1]);
          end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        } else {
          start = Math.max(0, size - Number(m[2]));
        }
        if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
        status = 206;
        headers["content-range"] = `bytes ${start}-${end}/${size}`;
      }
      headers["content-length"] = String(size === 0 ? 0 : end - start + 1);
      const body = size === 0 ? null : (Readable.toWeb(createReadStream(f.path, { start, end })) as unknown as BodyInit);
      return new Response(body, { status, headers });
    } catch (e) {
      return c.json({ ok: false, error: { kind: "error", message: errText(e) } }, 500);
    }
  });
  bb.http.route("POST", WRITES.archive, async (c) => {
    // The owner's Archive click on a resolved thread. Async (bb's archive), so not through write().
    const why = notFromScreens(c);
    if (why) return c.json({ ok: false, error: { kind: "forbidden", message: `writes come only from the app's screens (${why})` } }, 403);
    try {
      const b = archiveBody.parse(await c.req.json());
      engine.archivable(b.threadId);
      const r = await bb.sdk.threads.archive({ threadId: b.threadId });
      engine.boardAdd("archived", "person", null, `Archived ${b.threadId}`, `bb archived: ${r.archivedThreadIds.join(", ")}. Its worktree goes after bb's grace period; the branch stays.`, b.threadId);
      return c.json({ ok: true, result: r.archivedThreadIds });
    } catch (e) {
      const kind = e instanceof EngineError ? e.kind : "error";
      return c.json({ ok: false, error: { kind, message: errText(e) } }, kind === "forbidden" ? 403 : 422);
    }
  });

  // ---------------------------------------------------------------- the owner's Start buttons: a lead, the CoS, the Steward
  // A lead runs in its project's notes folder (PROJECT.md, library/, memory/) as an unmanaged workspace, inside the bb
  // project of the repo PROJECT.md names, so orch_spawn_thread gives its threads that repo's worktrees. The CoS and the
  // Steward run in <stateDir>/<role>/ in the home project. Every check runs before the spawn; starts go one at a time.
  const BRIEF_DIR = join(import.meta.dirname, "briefs");
  type BbProject = { id: string; name: string; sources?: { hostId: string; path: string; isDefault?: boolean }[] };

  /** The one connected host, for a new bb project. */
  async function onlyHost(): Promise<string> {
    const hosts = (await bb.sdk.hosts.list()).filter((h) => h.status === "connected" && h.lifecycle.phase === "active");
    if (hosts.length !== 1) throw new EngineError("bad_state", `can't tell which machine to create the bb project on: ${hosts.length} connected hosts`);
    return hosts[0]!.id;
  }

  /** The bb project whose source folder is `path`, with that source's host; created when there is none. */
  async function bbProjectFor(path: string): Promise<{ projectId: string; hostId: string }> {
    for (const p of (await bb.sdk.projects.list()) as unknown as BbProject[]) {
      const src = p.sources?.find((s) => samePath(s.path, path));
      if (src) return { projectId: p.id, hostId: src.hostId };
    }
    const hostId = await onlyHost();
    try {
      const p = await bb.sdk.projects.create({ name: basename(path), source: { type: "local_path", hostId, path } });
      engine.boardAdd("notice", "orchestrator", null, `Created bb project ${p.name}`, `For ${path} (${p.id}).`, null);
      return { projectId: p.id, hostId };
    } catch (e) {
      throw new EngineError("bad_state", `no bb project has ${path} as its folder, and bb refused to create one: ${errText(e)}`);
    }
  }

  /** The CoS's and the Steward's bb project: the homeProjectId setting, else the bb project of the mirror folder. */
  async function homeProject(): Promise<{ projectId: string; hostId: string }> {
    const id = cfg.homeProjectId.trim();
    if (!id) return bbProjectFor(stateDir());
    const p = (await bb.sdk.projects.get({ projectId: id })) as unknown as BbProject;
    const src = p.sources?.find((s) => s.isDefault) ?? p.sources?.[0];
    if (!src) throw new EngineError("bad_state", `the home project ${id} has no folder on a machine`);
    return { projectId: p.id, hostId: src.hostId };
  }

  /**
   * Spawn and register one agent the owner (or, for a lead, the CoS) started. A failure after the spawn names the
   * thread, which then exists.
   */
  async function spawnStarted(p: { role: Role; project: string | null; projectId: string; hostId: string; folder: string; prompt: string; title: string; provider: string; model: string; reasoning: string; by: StartedBy }): Promise<Agent> {
    const selection = await spawnSelection(bb.sdk.providers, { hostId: p.hostId, projectId: p.projectId }, p, { defaults: p.role === "thread" ? undefined : START_DEFAULTS[p.role], warn: (m) => bb.log.warn(m) });
    const t = await bb.sdk.threads.spawn({
      projectId: p.projectId,
      environment: { type: "host", hostId: p.hostId, workspace: { type: "unmanaged", path: p.folder } },
      prompt: p.prompt,
      title: p.title,
      ...selection,
      pluginMetadata: { role: p.role, project: p.project },
    });
    try {
      const a = engine.registerStarted(t.id, p.role, p.project, p.by);
      if (a.role === "lead") engine.ensureProject(a.project!, p.projectId);
      engine.setEnvironment(t.id, (t as unknown as ThreadInfo).environmentId ?? null);
      await bb.sdk.threads.updatePluginMetadata({ threadId: t.id, set: { address: a.address, role: a.role } });
      void placeSections();
      engine.startedNotice(a, p.by, `Thread ${t.id} (${a.mon ? `${a.mon}, ` : ""}${p.model} ${p.reasoning}) in ${p.folder}.`, t.id);
      return a;
    } catch (e) {
      throw new EngineError("bad_state", `thread ${t.id} started but didn't register: ${errText(e)}. Give it its role with: bb orchestrator role set ${t.id} ${p.role}${p.project ? ` ${p.project}` : ""}`);
    }
  }

  let starting: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = starting.then(fn, fn);
    starting = next.catch(() => {});
    return next;
  };
  const startRoute = <S extends z.ZodTypeAny>(path: string, schema: S, fn: (body: z.infer<S>) => Promise<unknown>) =>
    bb.http.route("POST", path, async (c) => {
      // async (bb's spawn), so not through write(); the same Origin guard
      const why = notFromScreens(c);
      if (why) return c.json({ ok: false, error: { kind: "forbidden", message: `writes come only from the app's screens (${why})` } }, 403);
      let body: z.infer<S>;
      try {
        body = schema.parse(await c.req.json());
      } catch (e) {
        return c.json({ ok: false, error: { kind: "invalid", message: errText(e) } }, 400);
      }
      try {
        const result = await oneAtATime(() => fn(body));
        void flush();
        return c.json({ ok: true, result: result ?? null });
      } catch (e) {
        const kind = e instanceof EngineError ? e.kind : "error";
        return c.json({ ok: false, error: { kind, message: errText(e) } }, kind === "conflict" ? 409 : kind === "not_found" ? 404 : 422);
      }
    });

  // Requested 2026-11-13: a quick message to the CoS from the Orchestrator page. It lands in the CoS's chat as their own
  // message (no sender thread), queued if the CoS is mid-turn.
  startRoute(WRITES.cosMessage, cosMessageBody, async ({ text }) => {
    const cos = engine.liveAt("cos");
    if (!cos) throw new EngineError("not_found", "No Chief of Staff is running: start it from the Projects tab");
    const res = await bb.sdk.threads.send({ threadId: cos.threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
    return { threadId: cos.threadId, delivery: res.delivery };
  });

  // The owner answers an agent's own question (AskUserQuestion) from its card: checked against what was asked, then sent
  // back through bb exactly as the thread's prompt would send it.
  startRoute(WRITES.interactionAnswer, interactionAnswerBody, async ({ threadId, interactionId, answers }) => {
    if (!engine.agents().some((a) => a.threadId === threadId)) throw new EngineError("not_found", "That thread isn't one of the orchestrator's agents");
    let ix: RawInteraction;
    try {
      ix = (await bb.sdk.threads.interactions.get({ threadId, interactionId })) as unknown as RawInteraction;
    } catch {
      throw new EngineError("not_found", "That question is gone: the agent withdrew it or its turn ended");
    }
    if ((ix.status ?? "pending") !== "pending") throw new EngineError("conflict", "That question was already answered");
    if ((ix.kind ?? ix.payload?.kind) !== "user_question") throw new EngineError("bad_state", "Only questions can be answered here: open the thread");
    const checked = checkAnswers(toQuestions(ix.payload), answers);
    await bb.sdk.threads.interactions.resolve({ threadId, interactionId, resolution: { kind: "user_answer", answers: checked } });
    return { threadId };
  });

  // Requested 2026-11-13: "release projects to the wild from their leads": archive a finished project. The engine retires
  // its agents, closes their waiting mail and withdraws their open cards in one step; then bb archives the threads
  // (threads first, the lead last). A thread bb can't archive is reported, never retried behind his back.
  startRoute(WRITES.archiveProject, archiveProjectBody, async ({ slug }) => {
    const all = engine.agents();
    const { threadIds } = engine.archiveProject(slug);
    const leadFirst = (id: string) => (all.find((a) => a.threadId === id)?.role === "lead" ? 1 : 0);
    const failed: string[] = [];
    for (const threadId of [...threadIds].sort((a, b) => leadFirst(a) - leadFirst(b))) {
      const t = await bb.sdk.threads.get({ threadId }).catch(() => null);
      if (!t || (t as { archivedAt?: number | null }).archivedAt) continue;
      await bb.sdk.threads.archive({ threadId }).catch((e) => failed.push(`${threadId} (${errText(e)})`));
    }
    if (failed.length) engine.boardAdd("notice", "orchestrator", slug, `${slug}: ${failed.length} thread(s) not archived in bb`, `Archive them by hand: ${failed.join(", ")}`, null);
    await pruneProjectSections();
    return { slug, threads: threadIds.length, failed };
  });

  // One Start lead path (core/start.ts startLead) for the owner's button and the CoS's orch_start_lead; only who
  // started it differs, recorded on the spawn event and the board notice.
  const leadStart = (by: StartedBy): LeadStartPorts => ({
    engine,
    projectsDir: projectsDir(),
    memoryFolder: (slug) => memoryProjectsNow.get(slug),
    memoryState,
    briefDir: BRIEF_DIR,
    owner: ownerWords(cfg.ownerName).name,
    bbProject: bbProjectFor,
    spawn: ({ slug, projectId, hostId, folder, prompt }) =>
      spawnStarted({ role: "lead", project: slug, projectId, hostId, folder, prompt, title: `Lead · ${projectTitle(slug)}`, provider: cfg.leadProvider, model: cfg.leadModel, reasoning: cfg.leadReasoning, by }),
  });

  startRoute(WRITES.startLead, startLeadBody, async ({ slug }) => {
    const a = await startLead(leadStart("person"), slug);
    return { threadId: a.threadId, address: a.address, mon: a.mon };
  });

  bb.agents.registerTool({
    name: "orch_start_lead",
    description: `CoS only: start lead:<slug>, exactly as ${O.name}'s Start lead button does. Refused when the project folder (<projects folder>/<slug>/PROJECT.md, or a memory project folder) is missing, its PROJECT.md names no repo under "## Repos" or that repo isn't on this machine, the project is on hold, or its lead is already running. ${O.Name}'s board shows "cos started lead:<slug>".`,
    presentation: { label: { pending: "Starting a lead", completed: "Started a lead" } },
    parameters: z.object({ slug: z.string().max(80).optional().describe("The project's slug, e.g. the folder name in the projects folder") }),
    execute: async (p, { threadId }) => {
      try {
        const a = caller(threadId);
        if (a.role !== "cos") throw new EngineError("forbidden", "CoS only");
        const slug = String(p.slug ?? "").trim();
        if (!slug) throw new EngineError("invalid", "give slug: the project to start the lead of");
        const lead = await oneAtATime(() => startLead(leadStart("cos"), slug));
        void flush();
        return ok(`Started ${lead.address} (${lead.threadId}${lead.mon ? `, ${lead.mon}` : ""}). ${O.Name}'s board shows "cos started ${lead.address}".`);
      } catch (e) {
        return fail(errText(e));
      }
    },
  });

  bb.agents.registerTool({
    name: "orch_new_project",
    description: `CoS only: create a project from a brief: its folder in the projects folder with PROJECT.md and the project record, and its row in Projects at the brief's priority. It does not start the lead (orch_start_lead does). Refused when a field is missing, the slug is taken (an existing folder, memory project or project, archived ones included), or the repo isn't an existing folder on this machine; a repo URL alone is refused (clone it first: this tool never clones). ${O.Name}'s board shows "cos created project <slug>".`,
    presentation: { label: { pending: "Creating a project", completed: "Created a project" } },
    parameters: z.object({
      brief: z
        .preprocess(
          fromJson,
          z.object({
            slug: z.string().optional().describe("lowercase letters, digits and -, at most 40"),
            title: z.string().optional().describe("The project's name, one line"),
            repo: z.string().optional().describe("The repo's absolute path on this machine (must exist)"),
            repo_url: z.string().optional().describe("Its remote URL, recorded in PROJECT.md"),
            base: z.string().optional().describe("The branch threads start from (default: the repo's default)"),
            goal: z.string().optional(),
            constraints: z.array(z.string()).or(z.string()).optional().describe("A list of one-line limits, or one per line"),
            priority: z.string().optional().describe("urgent | high | normal | low (default normal)"),
          }),
        )
        .optional()
        .describe("slug, title, repo, goal (needed); repo_url, base, constraints, priority"),
    }),
    execute: async (p, { threadId }) => {
      try {
        const a = caller(threadId);
        if (a.role !== "cos") throw new EngineError("forbidden", "CoS only");
        if (!p.brief || typeof p.brief !== "object") throw new EngineError("invalid", "give brief: {slug, title, repo, goal, repo_url?, base?, constraints?, priority?}");
        const r = await oneAtATime(async () =>
          newProject({ engine, root: projectsDir(), record: projectRecord(), memoryFolder: (slug) => memoryProjectsNow.get(slug), now: Date.now(), by: "cos" }, p.brief!),
        );
        void flush();
        return ok(`Created ${r.slug} (priority ${r.priority}) in ${r.folder}: ${r.files.map((f) => basename(f)).join(", ")}. No lead yet: start it with orch_start_lead(slug="${r.slug}").`);
      } catch (e) {
        return fail(errText(e));
      }
    },
  });

  startRoute(WRITES.roleStart, roleStartBody, async ({ role }) => {
    engine.checkStart(role, null);
    const folder = join(stateDir(), role);
    const prompt = loadBrief(BRIEF_DIR, role, { pokemon: pokemonSentence(engine.monForStart(role, null)), folder, owner: ownerWords(cfg.ownerName).name });
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const { projectId, hostId } = await homeProject();
    engine.checkStart(role, null);
    const a = await spawnStarted({
      role,
      project: null,
      projectId,
      hostId,
      folder,
      prompt,
      title: role === "cos" ? cosTitleOf(cfg.cosTitle) : "Steward",
      provider: role === "cos" ? cfg.cosProvider : cfg.stewardProvider,
      model: role === "cos" ? cfg.cosModel : cfg.stewardModel,
      reasoning: role === "cos" ? cfg.cosReasoning : cfg.stewardReasoning,
      by: "person",
    });
    return { threadId: a.threadId, address: a.address, mon: a.mon };
  });

  // ---------------------------------------------------------------- CLI
  const usage = [
    "bb orchestrator status",
    "bb orchestrator integration import <json-file> | integration receipts <source> [after-sequence] [limit]",
    "bb orchestrator adopt <threadId> <role> --approval <reference> [--project <slug>] [--parent <threadId>]",
    "bb orchestrator role set <threadId> <cos|steward|lead|thread> [<project>]",
    "bb orchestrator role clear <threadId>",
    "bb orchestrator spawn <role> [<project>] --project-id <id> --title T --prompt-file F [--parent <threadId>] [--provider P] [--model M]",
    "bb orchestrator inbox [--thread <id>] [--hook]",
    "bb orchestrator stop <address> | start <address>",
    "bb orchestrator compact-cos [--force]",
    "bb orchestrator host",
    "bb orchestrator decision <id>",
    "bb orchestrator tick",
    "bb orchestrator pr-check [--fake <file: {address: PrResult}>]",
    "bb orchestrator project <slug> [--priority urgent|high|normal|low] [--hold|--resume]",
    "bb orchestrator dreams run-now [--dry-run] | dreams status",
    "bb orchestrator sweep [--apply]",
    "bb orchestrator setup sidebar",
    "bb orchestrator pin <project> <path|url|deliverable> [--title T]",
    "bb orchestrator unpin <project> <path|url|deliverable|pin id>",
  ];
  bb.cli.register({
    name: "orchestrator",
    summary: "Roles, decisions and mail of the bb orchestrator",
    commands: usage.map((u) => ({ name: u.split(" ")[2]!, summary: u, usage: u })),
    async run(argv, ctx) {
      const out = (s: string, code = 0) => ({ exitCode: code, stdout: s.endsWith("\n") ? s : `${s}\n` });
      try {
        const [cmd, ...rest] = argv;
        // ctx.threadId is the caller's BB_THREAD_ID, unverified: an agent can drop it (docs/security-notes.md). So the
        // `self` checks stop an agent's honest mistakes, and every privileged command leaves a line on the owner's Board.
        const self = ctx.threadId ? engine.agentByThread(ctx.threadId) : null;
        if (privileged(cmd, rest))
          engine.boardAdd("notice", "orchestrator", null, `CLI: bb orchestrator ${argv.join(" ")}`.slice(0, 200), `Run from ${self ? self.address : ctx.threadId ? `thread ${ctx.threadId}` : "no bb thread (a terminal, or a caller that dropped BB_THREAD_ID)"}${ctx.cwd ? ` in ${ctx.cwd}` : ""}.`, null);
        switch (cmd) {
          case "pin":
          case "unpin": {
            // the owner from a terminal, or the project's own lead; a file gets the same proof check as from the page
            const [slug, target] = rest;
            if (!slug || !target || target.startsWith("--")) throw new EngineError("invalid", cmd === "pin" ? "pin <project> <path|url|deliverable> [--title T]" : "unpin <project> <path|url|deliverable|pin id>");
            const by = self ?? "owner";
            if (cmd === "unpin") return out(`unpinned ${engine.unpinDoc(target, { by, project: slug }).id}`);
            const ti = rest.indexOf("--title");
            const r = engine.pin(slug, target, { title: ti >= 0 ? (rest[ti + 1] ?? null) : null, by }, await pinPlace(slug));
            return out(`${r.created ? "pinned" : "already pinned"} ${r.pin.id}: ${r.pin.title}`);
          }
          case "status": {
            const lines = engine.agents().map((a) => `${a.address.padEnd(24)} ${a.role.padEnd(8)} ${a.status.padEnd(8)} ${a.threadId} parent=${a.parentThreadId ?? "none"}`);
            const ny = engine.needsYou();
            return out(`${lines.join("\n") || "no agents"}\nNeeds you: ${ny.cards.length} card(s), ${ny.triaging.length} being triaged, ${ny.deferred.length} deferred; dead letters: ${engine.deadLetters().length}`);
          }
          case "integration": {
            if (ctx.threadId) throw new EngineError("forbidden", "external integration is operator-only");
            if (rest[0] === "import" && rest.length === 2) {
              const { readFileSync, statSync } = await import("node:fs");
              if (statSync(rest[1]!).size > 65536) throw new EngineError("invalid", "external mail file exceeds 64 KiB");
              const mail = externalMailSchema.parse(JSON.parse(readFileSync(rest[1]!, "utf8")));
              allowImport(integrationRoutes(cfg.integrationRoutes), mail.source, mail.to);
              const item = engine.importMail(mail);
              void flush();
              return out(JSON.stringify({ itemId: item.id, state: item.state }));
            }
            if (rest[0] === "receipts" && rest[1]) {
              return out(JSON.stringify(engine.externalReceipts(rest[1], Number(rest[2] ?? 0), Number(rest[3] ?? 100))));
            }
            throw new EngineError("invalid", "integration import <json-file> | integration receipts <source> [after-sequence] [limit]");
          }
          case "adopt": {
            if (ctx.threadId) throw new EngineError("forbidden", "agents cannot adopt role threads");
            const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i < 0 ? null : rest[i + 1] ?? null; };
            const [threadId, role] = rest;
            if (!threadId || !ROLES.includes(role as Role)) throw new EngineError("invalid", "adopt <threadId> <role> --approval <reference> [--project <slug>] [--parent <threadId>]");
            const a = await oneAtATime(() => adoptThread({
              engine,
              get: async (id) => await bb.sdk.threads.get({ threadId: id }) as unknown as AdoptThread,
              queued: async (id) => (await bb.sdk.threads.queuedMessages.list({ threadId: id })).length > 0,
              parent: async (id, parentThreadId) => { await bb.sdk.threads.update({ threadId: id, parentThreadId, parentNotifications: "auto" }); },
              mirror: async (id, address, role) => { await bb.sdk.threads.updatePluginMetadata({ threadId: id, set: { address, role } }); },
            }, { threadId, role: role as Role, project: flag("project"), parentThreadId: flag("parent"), approval: flag("approval") ?? "" }));
            return out(`${a.threadId} is ${a.address}; parent=${a.parentThreadId ?? "none"}`);
          }
          case "role": {
            if (self) throw new EngineError("forbidden", `${self.address} can't change roles`);
            const [sub, threadId, role, project] = rest;
            if (!threadId) throw new EngineError("invalid", "role set <threadId> <cos|steward|lead|thread> [<project>]");
            if (sub === "clear") {
              engine.retire(threadId);
              return out(`cleared ${threadId}`);
            }
            if (sub !== "set" || !ROLES.includes(role as Role)) throw new EngineError("invalid", "role set <threadId> <cos|steward|lead|thread> [<project>]");
            const th = await threadInfo(threadId);
            const a = engine.register(threadId, role as Role, project ?? null);
            if (a.role === "lead") engine.ensureProject(a.project!, th.projectId);
            if (a.role === "thread") engine.recordManual(threadId);
            engine.setEnvironment(threadId, th.environmentId);
            await bb.sdk.threads.updatePluginMetadata({ threadId, set: { address: a.address, role: a.role } });
            return out(`${threadId} is ${a.address}`);
          }
          case "spawn": {
            // bb orchestrator spawn <role> [<project>] --project-id <proj_…> --title T --prompt-file F [--parent <threadId>] [--provider P] [--model M] [--reasoning L]
            if (self) throw new EngineError("forbidden", "agents don't spawn role threads");
            const flag = (n: string) => {
              const i = rest.indexOf(`--${n}`);
              return i >= 0 ? rest[i + 1] : undefined;
            };
            const [role, maybeProject] = rest;
            const project = maybeProject && !maybeProject.startsWith("--") ? maybeProject : null;
            const projectId = flag("project-id");
            const promptFile = flag("prompt-file");
            if (!ROLES.includes(role as Role) || !projectId || !promptFile) throw new EngineError("invalid", "spawn <role> [<project>] --project-id <id> --title T --prompt-file F [--parent <threadId>] [--provider P] [--model M] [--reasoning L]");
            const { readFileSync } = await import("node:fs");
            const prompt = readFileSync(promptFile, "utf8");
            const parent = flag("parent");
            const selection = await spawnSelection(bb.sdk.providers, { projectId }, { provider: flag("provider"), model: flag("model"), reasoning: flag("reasoning") }, { defaults: {}, warn: (m) => bb.log.warn(m) });
            const t = await bb.sdk.threads.spawn({
              projectId,
              environment: { type: "project-default" },
              prompt,
              title: flag("title") ?? `${role}${project ? ` ${project}` : ""}`,
              ...selection,
              ...(parent ? { parentThreadId: parent } : {}),
              pluginMetadata: { role: role!, project },
            } as Parameters<typeof bb.sdk.threads.spawn>[0]);
            const a = engine.agentByThread(t.id) ?? engine.register(t.id, role as Role, project, parent ?? null);
            if (a.role === "lead") engine.ensureProject(a.project!, projectId);
            if (a.role === "thread") engine.recordManual(t.id);
            engine.setEnvironment(t.id, (t as unknown as ThreadInfo).environmentId ?? null);
            await bb.sdk.threads.updatePluginMetadata({ threadId: t.id, set: { address: a.address } });
            return out(`${t.id} is ${a.address}`);
          }
          case "setup": {
            if (rest[0] !== "sidebar") throw new EngineError("invalid", "setup sidebar");
            if (self) throw new EngineError("forbidden", "agents don't change the sidebar layout");
            const pins = engine.agents().filter((a) => a.role === "cos" || a.role === "steward").map((a) => ({ label: a.role === "cos" ? "Chief of Staff" : "Steward", threadId: a.threadId }));
            const bin = process.env.BB_CLI || "bb";
            const run: BbRun = (args) => new Promise((resolve, reject) => execFile(bin, args, { timeout: 60_000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => (err ? reject(new EngineError("invalid", `bb ${args.join(" ")}: ${stderr || err.message}`.slice(0, 400))) : resolve(stdout))));
            return out((await setupSidebar(run, pins)).join("\n"));
          }
          case "inbox": {
            const i = rest.indexOf("--thread");
            const tid = i >= 0 ? rest[i + 1] : ctx.threadId;
            if (self && tid !== self.threadId) throw new EngineError("forbidden", `${self.address} reads only its own inbox`);
            const a = tid ? engine.agentByThread(tid) : null;
            if (!a) return out(rest.includes("--hook") ? "" : "this thread has no orchestrator role", rest.includes("--hook") ? 0 : 1);
            return out(engine.settings.batchInbox && !rest.includes("--hook") ? JSON.stringify(engine.batch.read(a)) : engine.inbox(a).text);
          }
          case "stop":
          case "start": {
            if (self) throw new EngineError("forbidden", "agents use orch_stop_thread");
            const a = rest[0] ? engine.agentByAddress(rest[0]) : null;
            if (!a) throw new EngineError("not_found", `no agent ${rest[0] ?? ""}`);
            if (cmd === "stop") await stopAgent(a);
            else await startAgent(a);
            return out(`${cmd === "stop" ? "stopped" : "started"} ${a.address}`);
          }
          case "compact-cos":
            if (self) throw new EngineError("forbidden", "not from an agent");
            return out(await compactCos(rest.includes("--force")));
          case "host":
            return out(JSON.stringify({ snapshot: lastSnapshot ?? sample(cfg.diskPath, Date.now()), level: alarms.level, thresholds: thresholds() }, null, 2));
          case "decision": {
            const d = rest[0] ? engine.decision(rest[0]) : null;
            if (!d) throw new EngineError("not_found", `no decision ${rest[0] ?? ""}`);
            if (self && !mayRead(self, d)) throw new EngineError("forbidden", `${self.address} reads only its own decisions`);
            return out(JSON.stringify(d, null, 2));
          }
          case "tick":
            engine.tick();
            await flush();
            return out("ticked");
          case "pr-check": {
            if (self) throw new EngineError("forbidden", "not from an agent");
            const i = rest.indexOf("--fake");
            const { readFileSync } = await import("node:fs");
            const fake = i >= 0 ? (JSON.parse(readFileSync(rest[i + 1]!, "utf8")) as Record<string, PrResult>) : null;
            return out(await prPass(fake));
          }
          case "project": {
            if (self) throw new EngineError("forbidden", "not from an agent");
            const slug = rest[0];
            if (!slug || !engine.project(slug)) throw new EngineError("not_found", `no project ${slug ?? ""}`);
            const i = rest.indexOf("--priority");
            if (i >= 0) engine.setPriority(slug, rest[i + 1] as never);
            if (rest.includes("--hold")) engine.setHold(slug, true);
            if (rest.includes("--resume")) {
              engine.setHold(slug, false);
              await flush();
            }
            return out(JSON.stringify(engine.project(slug)));
          }
          // dreams
          case "sweep": {
            // One-time cleanup (2026-11-14): retired threads bb still lists. The listing marks each clean or dirty;
            // --apply hides the handoff predecessors and archives only the clean ones. The owner approves the list first.
            if (self) throw new EngineError("forbidden", "agents don't sweep threads");
            const apply = rest.includes("--apply");
            const lines: string[] = [];
            let hid = 0;
            let archived = 0;
            for (const r of engine.retiredThreads()) {
              const t = (await bb.sdk.threads.get({ threadId: r.threadId }).catch(() => null)) as (ThreadInfo & { archivedAt?: number | null }) | null;
              if (!t || t.archivedAt) continue;
              const v = await worktreeOf(t.environmentId ?? r.environmentId);
              const kind = r.predecessor ? "handoff predecessor" : "retired";
              lines.push(`${r.threadId}  ${r.address.padEnd(24)} ${kind.padEnd(19)} ${new Date(r.retiredAt).toISOString()}  ${v.clean ? "clean" : "dirty"}: ${v.why}`);
              if (!apply) continue;
              if (r.predecessor) {
                const ok = await bb.sdk.threads
                  .update({ threadId: r.threadId, visibility: "hidden" } as Parameters<typeof bb.sdk.threads.update>[0])
                  .then(() => true)
                  .catch((e: unknown) => (lines.push(`  ${r.threadId}: not hidden (${errText(e)})`), false));
                if (ok) hid++;
              }
              if (v.clean && (await archiveThreads([r.threadId], r.project)).archived.length) archived++;
            }
            const tail = apply ? `applied: hid ${hid}, archived ${archived}` : `${lines.length} thread(s); --apply hides the handoff predecessors and archives the clean ones`;
            return out(`${lines.length ? lines.join("\n") : "no retired threads left unarchived"}\n${tail}`);
          }
          case "dreams": {
            if (self) throw new EngineError("forbidden", "not from an agent");
            if (rest[0] === "status") return out(dreams.status());
            if (rest[0] !== "run-now") throw new EngineError("invalid", usage[usage.length - 1]!);
            const { date } = dreams.due();
            const existing = dreams.batch(date);
            if (rest.includes("--dry-run")) {
              const p = dreams.plan(date);
              const tools = memory ? toolsDir(memory.search) : null;
              return out(JSON.stringify({ date, enabled: dreamOpts().enabled, existing: existing?.state ?? null, run: p.run, skipped: p.skipped, carry: p.carry, command: ["python3", "-I", tools ? join(tools, "memory-dream-launch") : "(memory tools not found)", ...p.args] }, null, 2));
            }
            if (!dreamOpts().enabled) throw new EngineError("bad_state", "dreams are off: turn on dreamsEnabled (the memory config needs memory.dreamDir)");
            if (existing) throw new EngineError("bad_state", `the batch of ${date} exists (${existing.state})`);
            const b = await dreams.start(date);
            return out(`${b.date} ${b.run}: ${b.state}${b.note ? ` (${b.note})` : ""}`);
          }
          default:
            return out(usage.join("\n"), cmd ? 2 : 0);
        }
      } catch (e) {
        return { exitCode: 1, stdout: "", stderr: `${errText(e)}\n` };
      }
    },
  });

  bb.onDispose(() => {
    announcing = false;
    if (changeTimer) clearTimeout(changeTimer);
  });
}

/** An agent reads a decision it asked or started; a lead also its project's; the CoS every one (it triages them). */
export function mayRead(a: Agent, d: Decision): boolean {
  if (a.role === "cos") return true;
  if (a.address === d.orchestrator.asker || a.address === d.orchestrator.origin) return true;
  return a.role === "lead" && d.project === a.project;
}

/** After the orchestrator asked for a CoS compaction, the clock waits at least this long before asking again. */
const COMPACT_COOLDOWN_MS = 10 * 60_000;

/**
 * 1.5.1 replaced cosClearTokens (a clear threshold) with cosCompactTokens. bb has no rename and reads a stored value
 * only through a descriptor, so the old key keeps one and is unset once at load. Whatever it held (150000, 0 or
 * nothing) is NOT carried over: plugin compaction is off by default (cosCompactTokens = 0) and only an explicit
 * opt-in turns it on, so an upgrade never switches it on, and an owner's stored cosCompactTokens is never touched.
 * Claude Code's own auto-compaction handles the context either way. A failure is logged and never stops the load.
 */
export async function retireClearSetting(
  old: { get(): Promise<{ cosClearTokens?: number }>; experimental_set?: (v: { cosClearTokens: null }) => Promise<unknown> },
  log: (m: string) => void,
): Promise<void> {
  try {
    const was = (await old.get()).cosClearTokens;
    if (typeof was !== "number" || !old.experimental_set) return;
    await old.experimental_set({ cosClearTokens: null });
  } catch (e) {
    log(`unsetting the retired cosClearTokens: ${errText(e)}`);
  }
}

/** The CLI commands that change roles, threads, projects or state: each leaves an audit line on the Board. */
export function privileged(cmd: string | undefined, rest: string[]): boolean {
  switch (cmd) {
    case "adopt":
    case "role":
    case "spawn":
    case "stop":
    case "start":
    case "compact-cos":
    case "pr-check":
    case "setup":
    case "sweep":
    case "pin":
    case "unpin":
      return true;
    case "integration":
      return rest[0] === "import";
    case "project":
      return rest.includes("--priority") || rest.includes("--hold") || rest.includes("--resume");
    case "dreams":
      return rest[0] === "run-now" && !rest.includes("--dry-run");
    default:
      return false;
  }
}

/**
 * Why a write isn't from the app's own page, or null. The Origin must be the request's own host (loopback, or the
 * tunnel, which rewrites both to loopback) or bb's configured app URL (BB_APP_URL, e.g. a TLS proxy in front of an http
 * backend, so the scheme isn't compared) or its loopback URL; a browser's Sec-Fetch-Site, when sent, must say same-origin.
 */
export function writeOriginProblem(h: { origin: string | undefined; secFetchSite: string | undefined; requestUrl: string; appUrls: string[] }): string | null {
  if (!h.origin) return "no Origin";
  let host: string;
  try {
    host = new URL(h.origin).host;
  } catch {
    return `bad Origin ${h.origin}`;
  }
  const ok = [h.requestUrl, ...h.appUrls].some((u) => {
    try {
      return new URL(u).host === host;
    } catch {
      return false;
    }
  });
  if (!ok) return `Origin ${h.origin} isn't this app`;
  if (h.secFetchSite !== undefined && h.secFetchSite !== "same-origin") return `Sec-Fetch-Site ${h.secFetchSite}`;
  return null;
}

/** The handoff file's realpath, inside the worktree `root` (a realpath) after symlinks, or `invalid`. */
export function handoffFile(root: string, given: string): string {
  const inside = (f: string) => isAbsolute(f) && (f === root || f.startsWith(root + sep));
  const named = resolvePath(root, given);
  if (!inside(named) || !existsSync(named)) throw new EngineError("invalid", `no handoff file ${given} in ${root}`);
  const file = realpathSync(named); // a symlink in the worktree must not point the successor outside it
  if (!inside(file)) throw new EngineError("invalid", `${given} resolves outside ${root}`);
  return file;
}

/** `p`, or null once `signal` aborts: a stopping service stops waiting on a slow call and drops its result. */
export function unlessAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.resolve(null);
  }
  return new Promise<T | null>((resolve, reject) => {
    const stop = () => resolve(null);
    signal.addEventListener("abort", stop, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", stop);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", stop);
        reject(e);
      },
    );
  });
}

/** A sleep that ends early when the service is stopped (reload, disable, shutdown). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

// ---- defer presets, in the viewer's zone (1 hour, this evening 18:00 before 17:00, tomorrow 09:00, until brought back)
function zonedWallTime(zone: string, now: number, dayOffset: number, hour: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const guess = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + dayOffset, hour);
  // shift by the zone's offset at that moment
  const asZone = (ms: number) => {
    const q = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
        .formatToParts(new Date(ms))
        .map((p) => [p.type, p.value]),
    ) as Record<string, string>;
    return Date.UTC(Number(q.year), Number(q.month) - 1, Number(q.day), Number(q.hour) % 24, Number(q.minute));
  };
  return guess - (asZone(guess) - guess);
}

export function presets(zone: string, now: number): Preset[] {
  let z = zone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
  } catch {
    z = "UTC";
  }
  const hourNow = Number(new Intl.DateTimeFormat("en-US", { timeZone: z, hour: "2-digit", hour12: false }).format(new Date(now))) % 24;
  const fmt = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: z, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
  const out: Preset[] = [{ id: "1h", label: "1 hour", until: new Date(now + 3600_000).toISOString() }];
  if (hourNow < 17) {
    const ev = zonedWallTime(z, now, 0, 18);
    out.push({ id: "evening", label: `This evening (${fmt(ev)})`, until: new Date(ev).toISOString() });
  }
  const tm = zonedWallTime(z, now, 1, 9);
  out.push({ id: "tomorrow", label: `Tomorrow (${fmt(tm)})`, until: new Date(tm).toISOString() });
  out.push({ id: "manual", label: "Until I bring it back", until: null });
  return out;
}

/** Pasted sign-in codes older than `before` (ms) are deleted, whether or not the asker acked. */
function sweepSecrets(dir: string, before: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const f = join(dir, n);
    try {
      if (statSync(f).mtimeMs < before) rmSync(f, { force: true });
    } catch {
      // gone already
    }
  }
}
