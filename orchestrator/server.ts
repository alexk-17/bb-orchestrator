import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { execFile } from "node:child_process";
import { runGroup } from "./core/run-group.ts";
import { randomUUID } from "node:crypto";
import { cliRun, setupSidebar } from "./core/sidebar.ts";
import { chmodSync, closeSync, cpSync, createReadStream, openSync, readdirSync, readSync, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { approveBody, type DeliverableFolders, type DeliverableRows, PROOF_ROUTE, type ProjectOrder, requestChangesBody, secretBody, type Pathways, type PathwaysErrorKind } from "./contract.ts";
import { projectIssues, pathwaysMap, linkPathwaysDecisions, attachPathwaysPreflight, draftPathwaysDecision, summarizePathwaysRetro, pathwaysDecisionKey, submitPathwaysDecision, mapPathwaysLimited, selectPathwaysMap, type PathwaysIssue } from "./core/pathways.ts";
import { collectPathwaysProofRecords, reducePathwaysPr, reducePathwaysProof, reducePathwaysWaitLane } from "./core/pathways-pr.ts";
import { createPathwaysSnapshots, type PathwaysSnapshot, type PathwaysView } from "./core/pathways-snapshot.ts";
import { localPathwaysMap } from "./core/pathways-local.ts";
import type { FeedPrompt } from "./core/feed.ts";
import { type DeliverPlace, type OutputPlace, type ProofInput, SCOPING_SUMMARY_MAX, SCOPING_TASK_NAME_MAX, SECRET_TTL_MS } from "./core/engine.ts";
import { deliverBlocks, deliverPoints, fromJson, inputBlocksSchema, lessTextRefusal, looksLikeCode } from "./blocks.ts";
import { CARD_CAPS, DELIVER_BUDGET, deliverBudgetRefusal } from "./core/caps.ts";
import { ignoredTopLevelUpdate, statusParams, statusLine } from "./core/status.ts";
import { type DirectImage, MAX_IMAGE_BYTES, imageInput, safeName, sniff } from "./core/direct-images.ts";
import { checkAnswers, toQuestions } from "./interactions.ts";
import { BB, type ChangeNotice, KNOWN_TABLES } from "./change-notice.ts";
import { ReadCache, shareReads } from "./core/read-cache.ts";
import { loopDelay, timeReads } from "./core/slow-reads.ts";
import { ChangeTables, recordWrites } from "./core/write-log.ts";

type RawInteraction = { id: string; createdAt?: number; kind?: string; status?: string; payload?: { kind?: string } };
import { type Deliverable, oneLine, PROJECT_MODES, PROOF_KINDS, type ProjectMode } from "./core/model.ts";
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
  boardMoveBody,
  viewPrefBody,
  viewPrefsSchema,
  type ViewPrefs,
  directMessageBody,
  directImageBody,
  cosImageBody,
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
  feedResendBody,
  feedSeenBody,
  interactionAnswerBody,
  startLeadBody,
  archiveProjectBody,
  projectModeBody,
  scopeThreadBody,
  unscopeThreadBody,
  watchAddBody,
  watchDropBody,
  watchMoveBody,
  watchRetargetBody,
  pathwaysDecisionSubmitBody,
  WRITES,
  type Card,
  type Watchers,
} from "./contract.ts";
import type { Db } from "./core/db.ts";
import { deliverableIndex, deliverableRows, deliverableWhole } from "./core/deliverables-view.ts";
import { type DeliverResult, Engine, OUTPUT_KINDS, parseSince, type PrResult, type Settings, WAIT_WHEN } from "./core/engine.ts";
import { PINS_MAX } from "./core/pins.ts";
import { DAY_MS, prune, pruneSummary } from "./core/retention.ts";
import { GONE_CHECK_MS, lookThreads } from "./core/gone.ts";
import { autoUnderLead, type BbNotify } from "./core/notify-level.ts";
import { readThreadPrs } from "./core/pr-links.ts";
import { AlarmState, describe as describeAlarm, sample, type Snapshot, type Thresholds } from "./core/host.ts";
import {
  LIMIT_DEFAULT, LIMIT_MAX, LINES_DEFAULT, LINES_MAX, liveProjects, loadMemory, mapArgv, configEnvName, PROJECT_RECORD, mapOutcome, memoryConfigPath, memoryProjects,
  memorySetup, type MemoryLocal, pageArgv, QUERY_MAX, REF_MAX, searchArgv, SLUG, TOOL_PAGE, TOOL_SEARCH, toolResult,
} from "./core/memory.ts";
import { formAt, tokensForLevel } from "./mons.ts";
import { placeable, pruneSections } from "./core/sections.ts";
import { type Agent, type Decision, EngineError, OUTCOMES, projectTitle, type Role, ROLES, sectionTitle } from "./core/model.ts";
import { introSentence, type LeadStartPorts, loadBrief, samePath, scopingThreadStart, startLead, type StartedBy } from "./core/start.ts";
import { readPersonaPack } from "./personas.ts";
import { externalMailSchema, integrationRoutes, allowImport } from "./core/integration.ts";
import { adoptThread, type AdoptThread } from "./core/adopt.ts";
import { spawnSelection, START_DEFAULTS } from "./core/provider.ts";
import { newProject } from "./core/new-project.ts";
import { cosTitleOf, ownerWords, type OwnerWords } from "./core/owner.ts";
import { type DreamOptions, Dreams, loadDreamConfig, parseTimers, parseUnits, realDreamPorts, toolsDir } from "./core/dreams.ts";
import { registerCloud } from "./cloud/server.ts";
import { registerOpenPrs } from "./open-prs/server.ts";
import { registerBoardSince, sinceRead } from "./board-since.ts";
import { FILE_KINDS, TIDY_ACTIONS } from "./core/board-tidy.ts";
import { OPEN_PRS_COPIED, OPEN_PRS_POST, openPrsCopiedBody, openPrsPostBody } from "./open-prs/contract.ts";
import { registerReviewQueue } from "./review-queue/server.ts";
import { queueSetUp } from "./core/review-queue.ts";
import { shownUntilUsed } from "./app/hidden-tabs.ts";
import { registerSlackWatch } from "./slack-watch/server.ts";
import { registerMultiplayer } from "./multiplayer/server.ts";
import { MULTIPLAYER_WRITES } from "./multiplayer/contract.ts";
import { boardAddBody, boardRemoveBody } from "./multiplayer/core/boards.ts";
import { recordParams } from "./multiplayer/core/records.ts";
import { everyArg } from "./multiplayer/core/watch.ts";
import { registerVoice } from "./voice/server.ts";
import { REVIEW_QUEUE_WRITE, queueActionSchema } from "./review-queue/contract.ts";
import { uncoveredWaitUrls } from "./core/open-prs.ts";
import { JOB_IDS, jobRefusal, jobsView, watchText } from "./core/watchers.ts";
import { registerGameboy } from "./gameboy/server.ts";
import { baseBranchOf, EXEMPT_NOTE, remoteBase, remoteBranchFor, worktreeVerdict, type Verdict, type WorkspaceRead } from "./core/clean.ts";
import { DEFAULT_CONFIG_PATH as DEFAULT_CLOUD_CONFIG } from "./cloud/core/config.ts";
import { type ChildLevel, type NotifySaved, SAVED_KEY as NOTIFY_SAVED, serialReconcile } from "./core/notify-only.ts";

const TOOLS_BY_ROLE: Record<Role, string[]> = {
  thread: ["orch_ask", "orch_ack", "orch_send", "orch_inbox", "orch_report", "orch_output"],
  lead: ["orch_ask", "orch_forward", "orch_answer", "orch_ack", "orch_send", "orch_inbox", "orch_report", "orch_stop_thread", "orch_spawn_thread", "orch_resolve", "orch_handoff", "orch_output", "orch_deliver", "orch_deliver_withdraw", "orch_status", "orch_scope_task", "orch_review_record"],
  cos: ["orch_triage", "orch_propose_rule", "orch_ack", "orch_send", "orch_inbox", "orch_needs_you", "orch_moot", "orch_board_tidy", "orch_deliverables", "orch_dead_letters", "orch_start_lead", "orch_new_project", "orch_project_mode", "orch_watch", "orch_reply_owner"],
  steward: ["orch_ask", "orch_ack", "orch_send", "orch_inbox", "orch_host", "orch_cleanup", "orch_needs_you", "orch_deliverables"],
};

const roleBrief = (o: OwnerWords): Record<Role, string> => ({
  cos: `You are the Chief of Staff (cos) in ${o.name}'s orchestrator. You hear only what needs judgment: new decisions to triage and messages to you. For each decision use orch_triage: settle (only by citing a standing rule id that covers it; never a merge card), ask_person (2-4 options, recommended first), or merge a question into a duplicate question (never a plan or merge card). Ack messages with orch_ack. You get a read-only copy of each answer ${o.name} gives (no ack). orch_needs_you lists what is on ${o.name}'s Needs you now and what was answered or went moot lately; when a card there no longer needs an answer (its PR merged, the asker found out), take it off with orch_moot(id, reason): the asker is told why. orch_deliverables lists what leads delivered to ${o.name}, its review state and proof. Dead letters (mail nobody took) come to you, not ${o.name}'s board: an hourly notice lists new ones; with orch_dead_letters resend one, re-route it to the right address, close it for its recipient, or escalate it to ${o.name}'s board with your note when only ${o.name} can fix it. orch_new_project(brief) creates a project (its folder with PROJECT.md and the project record, and its row at the brief's priority) from slug, title, repo (an existing absolute path; a URL alone is refused, nothing is cloned), goal, and optional repo_url, base, constraints, priority, mode; it refuses a taken slug or folder and never starts the lead. mode=scoping starts the project in scoping mode: its lead's cards and deliverables go only to ${o.name}'s Scope tab, you get read-only copies (never triage, settle, merge or moot them), and ${o.name}'s yes on the lead's "Scoping done?" card makes it active; orch_project_mode(slug, mode) sets or clears it on an existing project. orch_watch lists every open PR wait and timed job, and adds, retargets (another PR and/or condition), moves (to another agent) or drops any PR wait, for anyone; its owners are told. Intervals are ${o.name}'s settings: you only list them. orch_start_lead(slug) starts lead:<slug> through the same checks as ${o.name}'s Start lead button (project folder, a repo under "## Repos" that exists here, not on hold, no live lead); ${o.name}'s board shows that you started it. You get a read-only copy of each direct message ${o.name} sends a lead from the Projects tab and of the lead's ack note: for 48 h it wins on its point over your instructions, earlier or later, and as a dead letter you may resend or escalate it but never re-route or close it. ${o.Name}'s replies to you under a post in the feed are tracked: answer each with orch_reply_owner(ref=<its id>, text), which shows your reply under it in ${o.name}'s feed; an answer only in your chat leaves it "no reply yet". A message typed straight into your chat (the Chat tab) is plain chat: answer it there. Tidy the work board at each digest with orch_board_tidy: action=list shows each project's tasks dropped with attachments, its Unfiled threads, PRs, deliverables and cards, and its open tasks. A drop the lead meant (the work is over or lives elsewhere): confirm it, or merge it into the task that carries on; one dropped by mistake: restore it (its lead is told to send it back). File an Unfiled item under a task (file, with kind, ref and task) only when it is obvious where it belongs (its title or PR names the task, its thread was briefed for it); otherwise ask the lead with orch_send which task it belongs to, and file it on the answer. Merge two tasks that are the same work. A request to file merges that have no task ("file them") is the same: file each PR its thread holds under its task; a PR no thread holds you may file itself (kind pr, its URL) when its task is obvious, and the next PR pass reads its state from GitHub; ask the lead for the rest. Each change tells the lead. When a lead starts, plans or reports work one of ${o.name}'s standing practices in your recovery view covers, remind the lead of it and check that the plan's done criteria or the report say it was done (that includes plan cards you settle); ask the lead when they don't. Do not poll; wait for [orchestrator] messages.`,
  steward: `You are the Steward (steward) of the runner's resources. Host alarms arrive as [orchestrator] alarm messages with a snapshot. Report with orch_send to cos; run only the allow-listed orch_cleanup actions on your own; anything else (stopping a process, deleting other files) becomes an orch_ask card listing the exact commands. When ${o.name} answers Go on your own cleanup card, run exactly those commands, after re-checking each path for 0 processes, 0 dirty and 0 unpushed; a refused command goes back to ${o.name} with the denial and the allow rule it needs. Never kill processes you didn't start, remove a worktree outside such a card, touch other agents' files or point caches at /tmp.`,
  lead: `You are a project lead in ${o.name}'s orchestrator. Your threads' questions come to you as decision.new: settle with orch_answer (citing a standing rule that covers it, or with a note as your own call), else orch_forward to file it up. Answers to your decisions come only to you: relay to the thread with orch_send(ref=<decision id>) unless you withhold it, and ack. An answer to carry out only once a PR gets somewhere ("merge when approved"): ack it with pr and when, and the orchestrator brings it back to you then and reminds you daily; arm no watcher of your own. Use orch_ask for your own questions (2-4 options, recommended first; it never blocks). While your project is scoping (orch_inbox says so), your cards and deliverables go only to ${o.name}'s Scope tab: ask ${o.name} there, start no build threads (read-only investigation is fine), and end it with orch_ask(scoping_done={summary, project_md}) once the goal, constraints and first plan are in PROJECT.md. To scope only part of a project, open a scoping task (orch_scope_task), start its scoping thread with orch_spawn_thread(scope_task) and file its cards with scope_task (${o.name} sees who plans each task: you, or its scoping thread); orch_ask(scoping_done={summary, doc, task}) proposes closing it, and ${o.name}'s yes closes only that task. Threads start only from a plan card ${o.name} approved: orch_ask(kind=plan, threads=<n>, options with the go option first) lists each thread (title, goal, model, done criteria); once the answer is its go, start each with orch_spawn_thread(plan=<id>). Threads you start any other way are flagged. Put each of ${o.name}'s standing practices in your recovery view that applies into your plan cards' done criteria and your threads' briefs, and check your threads' reports against it.Resolve a finished thread with orch_resolve: it retires the role and archives the thread once its worktree is clean (nothing uncommitted, its branch in its base branch or pushed) and its PR is merged, its branch is merged into its base, its PR was closed unmerged after its report, or ${o.name} has read its final report, or pass handed_off {pr, owner} when its open PR now belongs to someone else; a dirty worktree is refused with the reason. To swap a thread to another provider, have it write handoff-<UTC date>.md in its worktree, then orch_handoff. ${o.Name} sees only your deliverables and your questions: orch_deliver (finished work with proof) and orch_ask. Bundle your threads' work into deliverables that prove the result (screenshots, video, test output, PR), not into narration. Write them for a 10-second read: visuals first; each decision or finding is one line plus a short why (points); a one-line summary; no file:line, SHAs, logs or tool names at the top, those go in text or doc proof under Details (a PR review: a verdicts block for every PR, the recommended decisions, then 2-4 findings; proof that something works: screenshots or video of it happening, checks; a root cause: rca, a screenshot of the failure, a diagram of where it sits). Never message ${o.name} any other way. ${o.Name} may write to you directly from the Projects tab (a direct message, kind owner.message): answer it only with orch_ack(id, outcome, note), at once even for long work; the note is what ${o.name} reads on the row ("done" means taken, so say whether it is finished) and the CoS gets a copy. For 48 h it wins on its point over a CoS instruction, earlier or later; only ${o.name}'s own later word changes it. If the CoS says ${o.name} changed their mind, file one card with both instructions as options; say in your note what you set aside, and tell the CoS. orch_inbox lists those still in force. A direct message is never an approval: a merge, a production change or a public push still needs its own card citing the message id, and it can't be acked with pr and when. On deliverable.changes: fix it, then orch_deliver(revises=<id>). On deliverable.next: do what ${o.name} asked, then ack it with an outcome and a note saying what you did; the note shows on the deliverable. orch_output only records a file (for example one you then give as proof); it never reaches ${o.name}. Publish orch_status (goal, numbered steps with the current one, what you wait on, blockers) when you start, at each step change and whenever what you wait on changes: it is your project page's step bar, and stale after 2 h. Each step is a task on the work board: send every step back with the id (t-…) the last reply gave it, also when you reword it, and name the task (task=) on plan cards, orch_ask and orch_deliver. A step that is stuck takes a one-line blocker (steps[].blocker). When a thread finishes and at each milestone, include update (working_on: 1-3 bullets, at, needs) in orch_status: it is the Lead status card on your project and replaces the last one. Write it for ${o.name}, in plain words, about the task and what is done: 1-3 short bullets of at most 12 words each; no SHAs, run ids, file paths, flag internals or tool names unless ${o.name} needs them to act. Good: 'Search fix merged; preview ready for Robin to test'. Bad: 'Rebased 4087 onto main at 3f2a1c9, CI run 88123 green'.`,
  thread: `You are a worker thread in ${o.name}'s orchestrator. Ask your lead with orch_ask (2-4 options, recommended first); it returns at once with an id, so carry on or end your turn: the answer comes as a message. Message only your lead (orch_send). When an answer or message is handled, close it with orch_ack(id, outcome); replying to its sender with ref=<its id> closes it as replied, and an ack after that still records the real outcome. Report finished work with orch_report (with the PR URL when there is one). Follow each of ${o.name}'s standing practices in your recovery view that applies to your work, and say in your report what you did for it. Use orch_output to record a finished artefact (a doc, video, image, report or link) so your lead can put it in a deliverable as proof; ${o.name} sees only what your lead delivers.`,
});

function errText(e: unknown): string {
  if (e instanceof EngineError) return `${e.kind}: ${e.message}`;
  return String(e instanceof Error ? e.message : e);
}

/** 0 is off, so no `|| default`. */
function gapMs(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(30 * 60_000, Math.max(0, v)) : 120_000;
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
    batchInbox: { type: "boolean", label: "Batched inbox: one debounced wake per recipient instead of each message into a turn (on, the default; off: per-message delivery)", default: true },
    inboxDebounceMs: { type: "number", label: "Inbox wake debounce (milliseconds)", default: 2000 },
    inboxGapMs: { type: "number", label: "Lead wake gap: least time between two inbox wakes of the same lead; the owner's items and overdue items skip it (milliseconds, 0 = off)", default: 120000 },
    resendMinutes: { type: "number", label: "Unacked items are re-sent after the recipient idles (minutes)", default: 10 },
    diskPct: { type: "number", label: "Disk alarm (%)", default: 85 },
    swapPct: { type: "number", label: "Swap alarm (%)", default: 50 },
    memPct: { type: "number", label: "Memory alarm (%)", default: 90 },
    cpuPct: { type: "number", label: "CPU pin alarm (%)", default: 95 },
    sustainSeconds: { type: "number", label: "Alarm must hold for (seconds)", default: 300 },
    sampleSeconds: { type: "number", label: "Host sample every (seconds)", default: 60 },
    diskPath: { type: "string", label: "Disk to watch", default: "/" },
    cosCompactTokens: { type: "number", label: "Compact the CoS's context above (tokens) when idle: off by default; Claude Code compacts on its own", description: "Off by default (0): Claude Code compacts on its own, and the plugin never clears an agent's context. Set a token count (say 300000) to also have the plugin ask Claude Code to /compact the idle CoS above it. A retired cosClearTokens is never carried over: it is only unset, so an upgrade never switches this on.", default: 0 },
    projectsDir: { type: "string", label: "Projects folder: one folder per project, with PROJECT.md and a project record (empty: projects/ in the plugin's data folder)", default: "" },
    projectRecord: { type: "string", label: "Project record file in each project folder (JSON; archived_at set hides the project)", default: "project.json" },
    memoryConfig: { type: "string", label: "Memory config file (JSON with a memory block). Empty: memory is off and the orchestrator runs no memory tool", default: "" },
    memoryConfigEnv: { type: "string", label: "Environment variable that passes the memory config's path to the memory tools (empty: not passed)", default: "MEMORY_CONFIG" },
    memorySearch: { type: "string", label: "memory-search command (empty: the config's memory.search)", default: "" },
    prPollMinutes: { type: "number", label: "Check PRs every (minutes); 0 = never", default: 5 },
    retentionDays: { type: "number", label: "Delete finished mail, settled cards, closed PR waits, Board rows and Steward alarms older than (days); 0 = keep forever", description: "Only what is finished goes: open cards and mail, and anything they still point at, stay whatever their age. Agents, projects, deliverables, outputs, rules and pins are never deleted.", default: 0 },
    activityRetentionDays: { type: "number", label: "Delete activity-log entries (the project pages' history) older than (days); 0 = keep forever", default: 0 },
    linearWorkspace: { type: "string", label: "Linear workspace (the slug in linear.app/<slug>): Linear ids in the Projects tab link to their issues. Empty: they stay plain text", default: "" },
    linearTeams: { type: "string", label: "Linear team keys that link, comma-separated (empty: every key). Ids of other teams, and look-alikes such as model names, stay plain text", default: "" },
    hiddenTabs: { type: "string", label: "Pages to hide, comma-separated (ids or labels, e.g. gameboy, rules, activity). Empty: show every page. Scope still shows while something waits in it or you're on it. Multiplayer and CodeRabbit hide their section in Reviews. needs-you and deliverables do nothing: Home's Needs you and Delivered filters never hide", default: "" },
    showGameBoy: { type: "boolean", label: "Tools: Game Boy", default: false },
    showCloud: { type: "boolean", label: "Tools: Cloud", default: false },
    pokemon: { type: "boolean", label: "Pokémon", description: "Give each agent a Pokémon that evolves as it levels: sprites in the app and the sidebar, its name in its brief, evolutions on the board. Each project gets a Pokémon type: its lead and threads share it, and its colour is the project's accent. Sprites load from PokeAPI's public sprite repo at runtime. Pokémon is a trademark of Nintendo, Creatures and GAME FREAK; this plugin is not affiliated with them.", default: false },
    personaPack: { type: "string", label: "Personas pack (with Pokémon on): the absolute path of a JSON pack", description: "Optional, empty by default. A pack gives the CoS, the Steward and each lead a persona (a name, a title and an image) in place of a Pokémon of their own; threads stay Pokémon and draw from their lead's persona's lines first. The plugin ships no pack. It is read when this is saved and when the plugin loads; a pack that fails its checks is ignored, with the problems in the log. Check one with: node personas-check.ts <path>.", default: "" },
    pushNeedsYou: { type: "boolean", label: "Desktop/web push when a card enters Needs you (never sent while mobile push is on)", default: true },
    notifyOnlyOrchestrator: { type: "boolean", label: "Orchestrator notifications only", description: "bb notifies you only for the orchestrator: Needs-you cards, deliveries and the CoS thread. Mutes every other thread by setting push-notifications' defaultLevel and childLevel to muted; switching it off restores them. Card and delivery pushes still need pushNeedsYou on and mobile push off.", default: false },
    dreamsEnabled: { type: "boolean", label: "Nightly dream batch and daily memory check (needs a memory config with memory.dreamDir)", default: false },
    dreamDailyAt: { type: "string", label: "Dream time HH:MM, used only when the memory config has no memory.dailyAt", default: "" },
    dreamZone: { type: "string", label: "Time zone of the dream time", default: "UTC" },
    memoryUnits: { type: "string", label: "Memory check: systemd user unit patterns to watch for failures, space-separated (empty: none)", default: "" },
    memoryTimers: { type: "string", label: "Memory check: <unit>.timer=<minutes> pairs; a timer that hasn't run for that long is stale (empty: none)", default: "" },
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
    cloudConfigPath: { type: "string", label: "Cloud tab config file", description: "On the machine (~/ is its home): which AWS accounts and GCP projects are dev or prod, and their PIM groups. See cloud/config.example.json. Without it the Cloud tab says what to set up.", default: DEFAULT_CLOUD_CONFIG },
    gcpLoginConfig: { type: "string", label: "Cloud tab: GCP login config", description: "Full path of the workforce login config (gcp-login-config.json) on the machine. Empty: look in the usual places.", default: "" },
    githubLogin: { type: "string", label: "Open PRs: your GitHub login", description: "The tab lists every open PR this login authored, through the machine's own gh login (read-only). Empty: the tab says to set it.", default: "" },
    reviewChannel: { type: "string", label: "Open PRs: code-review channel", description: "A Slack channel name (team-reviews), its ID, or an https link to it. With slackToken set, Post sends the review text here after a preview and a confirm; without it, Post copies the text and opens this channel.", default: "" },
    reviewExcludedProjects: { type: "string", label: "Open PRs: projects left out of Post", description: "Project slugs, separated by commas or spaces. Their PRs start unticked in the Post preview.", default: "" },
    slackHandleMap: { type: "string", label: "Open PRs: GitHub login to Slack handle", description: "A JSON object, e.g. {\"some-login\": \"slackname\"}. Only mapped logins are tagged @handle; anyone else is shown by plain name, never guessed.", default: "", experimental_multiline: true },
    // A secret: kept by bb in a 0600 file, read only by the server, never sent to the page.
    reviewQueueDryRun: { type: "boolean", label: "Review queue: dry-run (nothing is posted to GitHub)", description: "On: the queue checks and picks a PR and shows what it would post, and posts nothing. Keep it on while another CodeRabbit scheduler runs; turn it off only once you've decided the queue should post \"@coderabbitai review\" for you.", default: true },
    slackToken: { type: "string", secret: true, label: "Open PRs: Slack token for Post", description: "Empty: Post copies the text and opens reviewChannel. Set: Post sends it to reviewChannel after a preview and a confirm. To post as yourself, use a user token: create a Slack app (api.slack.com/apps), add the User Token Scopes chat:write, channels:read, groups:read (for a private channel) and users:read (to turn @handles into mentions), install it to your workspace, and paste its User OAuth Token (xoxp-…). A bot token (xoxb-…) with the same scopes works too; invite the bot to the channel." },
    aiPlayerEndpoint: { type: "string", label: "Game Boy AI player: decision API endpoint", description: "The full URL the server POSTs each turn to: the game screen (a PNG) and a compact game state, with one typed choice question for the next input. See gameboy/README.md for what it must accept. Empty: the AI player is off and its toggle hidden.", default: "" },
    aiPlayerModel: { type: "string", label: "Game Boy AI player: model", description: "Sent as the request's model. Empty: no model field.", default: "" },
    aiPlayerKeyFile: { type: "string", label: "Game Boy AI player: key file (a dotenv file on this machine)", description: "The path of a dotenv file that holds the API key (~/ is the home folder). It is read by the server on each turn; the key never goes to the page or a log.", default: "" },
    aiPlayerKeyName: { type: "string", label: "Game Boy AI player: the key's name in that file", default: "" },
    aiPlayerKey: { type: "string", secret: true, label: "Game Boy AI player: API key (instead of a key file)", description: "Optional. Kept by bb as a secret and read only by the server. The key file is the usual way; this wins when both are set." },
    aiPlayerHeaders: { type: "string", label: "Game Boy AI player: extra request headers", description: "One Name: value per line, sent with each call, for an API that wants an opt-in header to take images. Authorization and Content-Type are set by the plugin.", default: "", experimental_multiline: true },
    aiPlayerName: { type: "string", label: "Game Boy AI player: its name", description: "The toggle reads \"<name> plays\", and the line under the game \"<name>: <buttons> (<confidence>): <why>\". Empty: AI.", default: "" },
    aiPlayerGapSeconds: { type: "number", label: "Game Boy AI player: seconds between calls (at least)", default: 3 },
    aiPlayerSessionCalls: { type: "number", label: "Game Boy AI player: calls per session (one toggle-on)", default: 100 },
    aiPlayerDayCalls: { type: "number", label: "Game Boy AI player: calls per day (UTC)", default: 500 },
    linearApiKey: { type: "string", secret: true, label: "Pathways: Linear personal API key" },
  });
  const retired = bb.settings.define({
    cosClearTokens: { type: "number", label: "Retired: replaced by cosCompactTokens, never carried over (unset at load; leave unset)" },
  });
  await retireClearSetting(retired, (m) => bb.log.warn(m));
  let cfg = await settings.get();
  let lastPack: { text: string; pack: Settings["personas"] } = { text: "null", pack: null };
  const loadPack = (path: string): Settings["personas"] => {
    let pack: Settings["personas"] = null;
    if (path.trim()) {
      try {
        pack = readPersonaPack(path.trim());
      } catch (e) {
        pack = { error: errText(e) };
        bb.log.warn(`personas: ${pack.error}`);
      }
    }
    const text = JSON.stringify(pack);
    if (text !== lastPack.text) lastPack = { text, pack };
    return lastPack.pack;
  };
  const O = ownerWords(cfg.ownerName);
  registerCloud(bb, () => cfg);
  const dataDir = dirname(bb.storage.database().name);
  registerGameboy(bb, join(dataDir, "gameboy"), () => cfg);
  const stateDir = () => cfg.stateDir.trim() || join(dataDir, "state");
  const projectsDir = () => memoryConfigPath(cfg.projectsDir) ?? join(dataDir, "projects");
  const projectRecord = () => cfg.projectRecord.trim() || PROJECT_RECORD;
  const loadedAt = Date.now();
  const ran: Record<string, number> = {};
  const mark = (job: string) => void (ran[job] = Date.now());
  const notices = new ChangeTables(KNOWN_TABLES);
  const reads = new ReadCache(5_000, Date.now);
  const loop = loopDelay();
  const db = recordWrites(bb.storage.database() as unknown as Db, (tables) => {
    notices.wrote(tables);
    reads.bump();
  });

  // Services start only after a successful activation, so a throwing activation leaves no timer running.
  let announcing = false;
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  const EVERYTHING = ["*"];
  const changed = (tables?: readonly string[]) => {
    notices.call(tables);
    if (!announcing || changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      bb.realtime.publish(CHANGED_CHANNEL, { tables: notices.take() } satisfies ChangeNotice);
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

  async function sendWithImages(req: { threadId: string; mode: "queue-if-active" | "steer-if-active"; senderThreadId?: string }, text: string, images: Pick<DirectImage, "path" | "sourceProject">[], what: string) {
    const textOnly = () => bb.sdk.threads.send({ ...req, input: [{ type: "text", text, mentions: [] }] });
    if (!images.length) return textOnly();
    try {
      return await bb.sdk.threads.send({ ...req, input: [{ type: "text", text, mentions: [] }, ...images.map(imageInput)] });
    } catch (e) {
      bb.log.warn(`${what}: bb refused ${images.length} image input(s) (${errText(e).slice(0, 200)}); sent the text with their paths only`);
      return textOnly();
    }
  }

  async function deliver(threadId: string, text: string, item: { sender: string; id?: string; kind?: string; body?: string }): Promise<DeliverResult> {
    const agent = engine.agentByThread(threadId);
    if (agent?.status === "stopped") return { delivery: "held", why: "stopped by the orchestrator" };
    const t = await bb.sdk.threads.get({ threadId });
    if ((t as { archivedAt?: number | null }).archivedAt) return { delivery: "held", why: "archived" };
    const sender = engine.agentByAddress(item.sender);
    const images = item.id && (item.kind === "owner.message" || item.kind === "owner.cos") ? engine.directImagesOf(item.id) : [];
    const wake = !!item.id?.startsWith("wake:");
    const queue = wake || item.kind === "owner.cos";
    const req = { threadId, mode: queue ? ("queue-if-active" as const) : ("steer-if-active" as const), ...(sender ? { senderThreadId: sender.threadId } : {}) };
    // A wake bb queues behind a running turn goes bare: its digest would be stale by the time it is read.
    const busy = !["idle", "error"].includes(String((t as { status?: string }).status ?? "idle"));
    const res = await sendWithImages(req, wake && busy && item.body ? item.body : text, images, item.id ?? "");
    if (res.delivery === "queued") return { delivery: "queued", queuedMessageId: res.queuedMessage.id };
    return { delivery: "sent" };
  }

  let slackWatch: ReturnType<typeof registerSlackWatch> | undefined;
  const effectiveRoutes = () => {
    const legacy = integrationRoutes(cfg.integrationRoutes), watched = slackWatch?.routes() ?? {};
    return { ...legacy, ...Object.fromEntries(Object.entries(watched).map(([source, to]) => [source, Object.hasOwn(legacy, source) ? [] : to])) };
  };
  const engine = new Engine(
    db,
    { now: () => Date.now(), externalEnabled: (source, to) => {
      try { allowImport(effectiveRoutes(), source, to); return true; }
      catch { return false; }
    }, deliver, mirror, changed, log: (m) => bb.log.warn(m), cardUp: (d) => void pushCard(d), delivered: (d) => void pushDelivered(d), files: () => ({ dir: join(stateDir(), "deliverables"), kept: join(stateDir(), "threads") }) },
    { escalateMs: cfg.escalateMinutes * 60_000, resendMs: cfg.resendMinutes * 60_000, owner: cfg.ownerName, pokemon: cfg.pokemon, batchInbox: cfg.batchInbox, inboxDebounceMs: Math.min(60000, Math.max(0, cfg.inboxDebounceMs || 2000)), inboxGapMs: gapMs(cfg.inboxGapMs), personas: loadPack(cfg.personaPack) },
  );
  const openPrs = registerOpenPrs(bb, engine, () => cfg);
  const boardSince = registerBoardSince(bb, { db, engine, login: () => cfg.githubLogin, mark, sleep });
  const VIEW_PREFS = "viewPrefs";
  const viewPrefs = async (): Promise<ViewPrefs> => {
    const kept = viewPrefsSchema.safeParse(await bb.storage.kv.get<unknown>(VIEW_PREFS));
    return kept.success ? kept.data : { projectsView: null, boardFolds: {}, rev: 0 };
  };
  // After the engine, whose migrations made its tables.
  const reviewQueue = registerReviewQueue(bb, { db, dryRun: () => cfg.reviewQueueDryRun !== false });
  const multiplayer = registerMultiplayer(bb, { db, engine, dir: join(dataDir, "multiplayer"), settings: () => cfg, routes: effectiveRoutes });
  slackWatch = registerSlackWatch(bb, {
    db, dir: join(dataDir, "slack-watch"), legacyRoutes: () => integrationRoutes(cfg.integrationRoutes),
    routeEnabled: (source, to) => { try { return effectiveRoutes()[source]?.includes(to) ?? false; } catch { return false; } },
    recipient: address => { const a = engine.agentByAddress(address); return !!a && a.status !== "stopped"; },
    importMail: mail => { const item = engine.importMail(mail); void flush(); return item; },
    heartbeat: (source, everyMs) => multiplayer.heartbeat(source, everyMs),
    audit: action => { engine.boardAdd("notice", "orchestrator", null, `CLI: ${action}`, "Operator changed a Slack watcher. Credentials and arguments are omitted.", null); },
  });
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
  // A service, never activation: a failed reconcile must not fail the plugin, and it retries each minute.
  bb.background.service("notify-only", {
    async start(signal) {
      while (!signal.aborted) {
        await unlessAborted(notifyOnly(), signal);
        mark("notify-only");
        await sleep(60_000, signal);
      }
    },
  });

  settings.onChange((next) => {
    if (next.pushNeedsYou && !cfg.pushNeedsYou) void resumePush();
    const notifyFlip = next.notifyOnlyOrchestrator !== cfg.notifyOnlyOrchestrator;
    cfg = next;
    reviewQueue.changed();
    changed(EVERYTHING);
    const before = engine.settings;
    engine.settings = { escalateMs: next.escalateMinutes * 60_000, resendMs: next.resendMinutes * 60_000, owner: next.ownerName, pokemon: next.pokemon, batchInbox: next.batchInbox, inboxDebounceMs: Math.min(60000, Math.max(0, next.inboxDebounceMs || 2000)), inboxGapMs: gapMs(next.inboxGapMs), personas: loadPack(next.personaPack) };
    if (engine.settings.inboxGapMs !== before.inboxGapMs) void flush();
    reloadMemory();
    if (notifyFlip) void notifyOnly();
  });

  // Read outside configure, which must stay synchronous and fast.
  let memory: MemoryLocal | null = null;
  let memoryProjectsNow: ReadonlyMap<string, string> = new Map();
  let memoryState = "";
  function reloadMemory(): void {
    const { local, why } = loadMemory(memoryConfigPath(cfg.memoryConfig), cfg.memorySearch);
    memory = local;
    memoryProjectsNow = local ? memoryProjects(local) : new Map();
    for (const slug of liveProjects(projectsDir(), projectRecord())) engine.ensureProject(slug, null);
    const now = local ? `${memoryProjectsNow.size} projects, config ${local.configPath}, search ${local.search}` : `off: ${why}`;
    if (now !== memoryState) bb.log.info(`memory: ${now}`);
    memoryState = now;
  }
  reloadMemory();
  const sharedRoots = () => [stateDir(), ...(memory?.vault ? [memory.vault] : [])];
  // A service, never setInterval: bb runs no dispose hook, so an interval outlives a failed reload.
  bb.background.service("memory", {
    async start(signal) {
      announcing = true;
      loop.start();
      changed(EVERYTHING);
      signal.addEventListener("abort", () => {
        announcing = false;
        loop.stop();
        if (changeTimer) clearTimeout(changeTimer);
        changeTimer = null;
      }, { once: true });
      while (!signal.aborted) {
        await sleep(60_000, signal);
        if (signal.aborted) break;
        try {
          reloadMemory();
          mark("memory");
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
      void runGroup(l.search, argv, { timeoutMs, maxBuffer: 4 << 20, env: configEnv ? { ...process.env, [configEnv]: l.configPath } : process.env }).then((r) =>
        resolve({ exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }));
    });
  const mapped = new Set<string>();
  function recordFolder(folder: string, project: string): void {
    const key = `${folder}\t${project}`;
    if (mapped.has(key)) return;
    mapped.add(key);
    void memoryRun(mapArgv({ folder, project }), 60_000).then((r) => {
      const outcome = mapOutcome(r.exitCode);
      const why = (r.stderr.trim() || r.stdout.trim()).split("\n").pop();
      if (outcome === "retry") {
        mapped.delete(key);
        return bb.log.warn(`memory: worktree map for ${folder}: ${why}`);
      }
      bb.log.info(`memory: worktree map: ${outcome}: ${why}`);
    });
  }

  let flushing: Promise<void> | null = null;
  // A flush asked for while one is in flight runs again after it: the one in flight read its recipients before the new mail existed.
  let flushAgain = false;
  const flush = (): Promise<void> => {
    if (flushing) {
      flushAgain = true;
      return flushing;
    }
    flushing = engine.flush().finally(() => {
      flushing = null;
      if (flushAgain) {
        flushAgain = false;
        void flush();
      } else armWake();
    });
    return flushing;
  };
  const MAX_TIMER_MS = 2_147_483_647; // setTimeout's largest delay; a longer one fires after 1 ms
  let wakeTimers = false;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let wakeAt = Infinity;
  function armWake(): void {
    if (!wakeTimers || !engine.settings.batchInbox) return;
    const now = Date.now();
    const again = engine.flushAgain;
    const next = again ? now : engine.nextWakeAt();
    if (next === null || (!again && next <= now) || (wakeTimer && wakeAt <= next)) return;
    if (wakeTimer) clearTimeout(wakeTimer);
    const delay = again ? 0 : Math.min(next - now + 20, MAX_TIMER_MS);
    wakeAt = now + delay;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      wakeAt = Infinity;
      void flush();
    }, delay);
  }

  const caller = (threadId: string | undefined | null): Agent => {
    const a = threadId ? engine.agentByThread(threadId) : null;
    if (!a) throw new EngineError("forbidden", "this thread has no orchestrator role");
    return a;
  };
  const guard = <T>(f: () => T): T => {
    try {
      return f();
    } catch (e) {
      throw e instanceof EngineError ? e : new EngineError("invalid", errText(e));
    }
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
  const SCOPING_DONE = z.preprocess(fromJson, z.object({ summary: z.string().optional(), project_md: z.string().optional(), doc: z.string().optional(), task: z.string().optional() }).or(z.string()));
  const scopingDoneIn = (v: unknown): { summary: string; projectMd: string; doc?: string; task?: string } => {
    const o = typeof v === "string" ? fromJson(v) : v;
    if (!o || typeof o !== "object") throw new EngineError("invalid", 'scoping_done is {summary, project_md}: the goal, constraints and first plan, and the PROJECT.md they are in (for a scoping task: {summary, doc, task})');
    const { summary, project_md, doc, task } = o as { summary?: unknown; project_md?: unknown; doc?: unknown; task?: unknown };
    const md = typeof project_md === "string" ? project_md.trim() : "";
    const file = typeof doc === "string" ? doc.trim() : "";
    for (const [what, f] of [["doc", file], ["project_md", md]] as const)
      if (f && isAbsolute(f) && !existsSync(f)) throw new EngineError("not_found", `scoping_done.${what} ${f} doesn't exist: write ${typeof task === "string" && task.trim() ? "the task's findings" : "the goal, constraints and first plan"} there first`);
    return { summary: typeof summary === "string" ? summary : "", projectMd: md, ...(file ? { doc: file } : {}), ...(typeof task === "string" && task.trim() ? { task: task.trim() } : {}) };
  };
  const SCOPE_TASK = z.preprocess((v) => (typeof v === "string" && /^\s*"/.test(v) ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v), z.string().max(80));
  const scopeWhere = (project: string | null, task: string | null | undefined) => {
    const t = task ? engine.task(task) : null;
    return t ? `scoping task ${t.id} ${JSON.stringify(t.name)}` : `${project} is scoping`;
  };

  bb.agents.registerTool({
    name: "orch_ask",
    description: `File a question with 2-4 options, the recommended one FIRST. A thread's goes to its lead; a lead's or the Steward's to the CoS and on to ${O.name}. Returns the decision id at once; never blocks. The answer arrives later as an [orchestrator] message. When an answer or a direct message from ${O.name} makes your open card stale, revise it (revises=<its id>, why, and the full new card) instead of filing another.`,
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
      scoping_done: SCOPING_DONE.optional().describe(
        `Lead of a scoping project only: this card asks ${O.name} "Scoping done?". summary: the goal, constraints and first plan (at most ${SCOPING_SUMMARY_MAX} characters); project_md: the absolute path of the PROJECT.md they are written in. The options you pass are replaced by the fixed Yes / Not yet; a yes makes the project active. Refused when the project isn't scoping. With task (an open scoping task's id or name) and doc (the absolute path of the file its findings are in) instead of project_md: a yes closes only that task, in a project of either mode`,
      ),
      scope_task: SCOPE_TASK.optional().describe(
        `Lead only: an open scoping task's id (st-…) or name (orch_scope_task). The card goes only to ${O.name}'s Scope tab, under that task: no CoS triage, no standing rule; the CoS gets a read-only copy. Leave it out for the normal route. Refused for a task that is done, dropped or unknown`,
      ),
      revises: z.string().optional().describe(`The id of your own unanswered card to replace with this title, question, context and options (same id, same place on ${O.name}'s Needs you; an answer to the old version is refused). A plan keeps exactly one go; threads may change`),
      why: z.string().max(300).optional().describe("With revises: one line on what made the card stale (the CoS reads it)"),
      task: z.string().max(80).optional().describe("The work-board task it is about: its id (t-…, from orch_status) or an open step's title. On a plan card, the threads it starts work on that task. Default: your thread's task"),
    }),
    execute: (p, { threadId }) =>
      run(threadId, (a) => {
        if (p.merge && !p.revises && !p.blocks?.some((b) => b.kind === "pr")) throw new EngineError("invalid", "a merge card needs a pr block (the PR's URL, and a one-line verdict as its note)");
        const done = p.scoping_done === undefined ? null : scopingDoneIn(p.scoping_done);
        const d = engine.ask(a, { title: p.title, question: p.question, context: p.context, options: p.options, kind: p.kind, threads: p.threads, action: p.merge ? "merge" : null, key: p.key ?? null, blocks: p.blocks, scopingDone: done, scopeTask: p.scope_task ?? null, revises: p.revises ?? null, why: p.why ?? null, task: p.task ?? null });
        if (p.revises) return `Revised ${d.id} (revision ${d.orchestrator.revised?.count ?? 1}) in place${d.state === "asked" ? `: ${O.name} sees the new version` : ""}. The answer will come as a message; don't wait on it.`;
        if (d.orchestrator.scope) return `Filed ${d.id} in ${O.name}'s Scope pane (${scopeWhere(a.project, d.orchestrator.scope_task)}: no CoS triage, no standing rule; the CoS gets a read-only copy). The answer will come as a message; don't wait on it.`;
        return `Filed ${d.id} (${d.orchestrator.at_level === "lead" ? `with ${`lead:${a.project}`}` : "with the CoS"}). The answer will come as a message; don't wait on it.`;
      }),
  });

  bb.agents.registerTool({
    name: "orch_forward",
    description: `Lead only: file your thread's question up to the CoS (and ${O.name}). You become its asker: the answer comes to you, and you relay it. A question from a scoping thread (started with scope_task) goes to ${O.name}'s Scope tab under its task while the task is open; scope_task files any question there.`,
    presentation: { label: { pending: "Filing a question up", completed: "Filed a question up" } },
    parameters: z.object({
      id: z.string(),
      note: z.string().max(2000).optional(),
      scope_task: SCOPE_TASK.optional().describe(`An open scoping task's id or name: the question goes only to ${O.name}'s Scope tab under it (default: the asking thread's task, if it is a scoping thread)`),
    }),
    execute: (p, { threadId }) =>
      run(threadId, (a) => {
        const d = engine.forward(a, p.id, p.note ?? null, p.scope_task ?? null);
        return d.orchestrator.scope ? `Filed ${d.id} in ${O.name}'s Scope pane (${scopeWhere(a.project, d.orchestrator.scope_task)}: no CoS triage; the CoS gets a read-only copy).` : `Filed ${d.id} with the CoS.`;
      }),
  });

  bb.agents.registerTool({
    name: "orch_scope_task",
    description: `Lead only: scope one part of your project with ${O.name} while the rest goes the normal way. action=open with name (one line of at most ${SCOPING_TASK_NAME_MAX} characters, not one of your open tasks') opens a scoping task and returns its id: what you file with scope_task=<id> (orch_ask, orch_forward, orch_deliver) goes only to ${O.name}'s Scope tab under it (no CoS triage, no standing rule; the CoS gets read-only copies), and orch_spawn_thread(scope_task) starts its scoping thread. orch_ask(scoping_done={summary, doc, task}) proposes closing it; ${O.name}'s yes closes only that task. action=drop with task (its id or name) drops one you no longer need: what still waits under it goes the normal way. orch_inbox lists your open tasks.`,
    presentation: { label: { pending: "Changing a scoping task", completed: "Changed a scoping task" } },
    parameters: z.object({
      action: z.string().max(10).optional().describe("open | drop"),
      name: z.string().max(200).optional().describe(`open: the task's name, one line of at most ${SCOPING_TASK_NAME_MAX} characters`),
      task: SCOPE_TASK.optional().describe("drop: the task's id (st-…) or name"),
    }),
    execute: (p, { threadId }) =>
      run(threadId, (a) => {
        if (a.role !== "lead") throw new EngineError("forbidden", "lead only");
        const action = String(p.action ?? "").trim();
        if (action === "open") {
          if (!p.name?.trim()) throw new EngineError("invalid", "give name: the part of the project to scope, in one line");
          const t = engine.openTask(a, p.name);
          return `Opened scoping task ${t.id} ${JSON.stringify(t.name)} in ${t.project}. You are planning it until you start a scoping thread with scope_task (${O.name}'s Scope tab shows who plans it). File its cards and deliverables with scope_task="${t.id}" (orch_ask, orch_forward, orch_deliver): they go only to ${O.name}'s Scope tab, under it. Start its scoping thread from an approved plan with orch_spawn_thread(scope_task="${t.id}"). Propose closing it with orch_ask(scoping_done={summary, doc, task: "${t.id}"}).`;
        }
        if (action === "drop") {
          const ref = p.task ?? p.name;
          if (!ref?.trim()) throw new EngineError("invalid", "give task: the id (st-…) or name of the scoping task to drop");
          const r = engine.dropTask(a, ref);
          return `Dropped scoping task ${r.task.id} ${JSON.stringify(r.task.name)}.${r.moved ? ` ${r.moved} still open under it moved to ${engine.isScoping(a.project) ? "the whole project's Scope pane" : "Needs you and Deliverables"}.` : ""}`;
        }
        throw new EngineError("invalid", 'give action: "open" (with name) or "drop" (with task)');
      }),
  });

  bb.agents.registerTool({
    name: "orch_answer",
    description: "Lead only: settle your own thread's question. Cite a standing rule that covers it (rule id from orch_inbox), or leave rule_id out (or empty) and give a note saying why: it is recorded as your own call.",
    presentation: { label: { pending: "Settling a question", completed: "Settled a question" } },
    parameters: z.object({
      id: z.string(),
      rule_id: z.string().optional(),
      option: z.string().describe("option id, e.g. \"1\""),
      note: z.string().max(2000).optional(),
      revision: z.number().int().min(0).optional().describe("The revision of the question you answer, from its thread's revision notice; leave out for one never revised. A newer revision is refused as stale"),
    }),
    execute: (p, { threadId }) => run(threadId, (a) => `Settled ${engine.leadAnswer(a, p.id, p.rule_id ?? null, p.option, p.note ?? null, p.revision ?? 0).id}; the answer goes to the thread.`),
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
      revision: z.number().int().min(0).optional().describe("settle, ask_person, merge, bounce: the revision of the card you triaged, from its asker's revision notice; leave out for a card never revised. A newer revision is refused as stale"),
      into_revision: z.number().int().min(0).optional().describe("merge only: the revision of the card you merge into, as you read it; leave out for one never revised. A newer revision is refused as stale"),
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
          return `Sent ${engine.triageBounce(a, p.id, p.note, p.revision).id} back to its asker with your note; it never reaches ${O.name}.`;
        }
        if (p.action === "settle") {
          if (!p.rule_id || !p.option) throw new EngineError("invalid", "settle needs rule_id and option");
          return `Settled ${engine.triageSettle(a, p.id, p.rule_id, p.option, p.note ?? null, p.revision).id} from ${p.rule_id}.`;
        }
        if (p.action === "merge") {
          if (!p.into) throw new EngineError("invalid", "merge needs into");
          return `Merged ${engine.triageMerge(a, p.id, p.into, p.revision, p.into_revision ?? 0).id} into ${p.into}.`;
        }
        if (!p.question || !p.options) throw new EngineError("invalid", "ask_person needs question and options");
        return `${engine.triageAskPerson(a, p.id, { title: p.title, question: p.question, context: p.context, options: p.options, allowText: p.allow_text ?? true, revision: p.revision }).id} is in ${O.name}'s Needs you.`;
      }),
  });

  const cosOrSteward = (a: Agent) => {
    if (a.role !== "cos" && a.role !== "steward") throw new EngineError("forbidden", "CoS and Steward only");
  };
  bb.agents.registerTool({
    name: "orch_propose_rule",
    description: `CoS only: propose a standing instruction from ${O.name}'s own words in chat or a card note. Give it in one line (at most 120 characters: the card shows it whole and a yes saves exactly that), quote the words, and optionally name a project. kind: practice (the default) for an instruction agents follow, such as "always use this tool"; it settles no card. plan only when it really settles plan decisions: a plan rule lets you approve the plan cards it covers without ${O.name}. ${O.name} gets one "Make this a practice?" or "Make this a rule?" card; only their yes adds it to Rules.`,
    presentation: { label: { pending: "Proposing a standing rule", completed: "Proposed a standing rule" } },
    parameters: z.object({
      text: z.string().max(120),
      quote: z.string().max(600),
      project: z.string().nullable().optional(),
      kind: z.enum(["practice", "plan"]).optional().describe("practice (default): followed, settles nothing; plan: lets you approve the plan cards it covers"),
    }),
    execute: (p, { threadId }) => run(threadId, (a) => {
      const d = engine.proposeStatedRule(a, p.text, p.quote, p.project ?? null, p.kind ?? "practice");
      return `${d.id} ${JSON.stringify(d.request.title)} is in ${O.name}'s Needs you. A yes adds it to Rules; the answer comes to you.`;
    }),
  });

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
    name: "orch_reply_owner",
    description: `CoS only: answer ${O.name}'s message to you (an owner.cos item, i-…). Your reply shows under it in ${O.name}'s feed, nested under the post it was about, and the message counts as answered. It reaches no thread; it approves nothing.`,
    presentation: { label: { pending: `Replying to ${O.name}`, completed: `Replied to ${O.name}` } },
    parameters: z.object({ ref: z.string().describe(`The id of ${O.name}'s message, i-…`), text: z.string().min(1).max(4000).describe("Your answer, in plain words") }),
    execute: (p, { threadId }) =>
      run(threadId, (a) => {
        const r = engine.replyOwner(a, p.ref, p.text);
        return `Replied to ${p.ref} (${r.id}): it shows under it in ${O.name}'s feed.`;
      }),
  });

  bb.agents.registerTool({
    name: "orch_board_tidy",
    description: `CoS only: read and tidy the work board. action=list (default): per project, the tasks dropped with attachments, the Unfiled threads, PRs, deliverables and cards, and the open tasks (ids t-…). merge(task, into): fold task into into, a task of the same project; its threads, deliverables and cards move, and its id redirects to into. restore(task): a dropped task opens again, with what its drop moved to Unfiled; its lead is told to send it back in its steps. file(kind, ref, task): attach an Unfiled thread (address or bb thread id), PR (URL; it files the thread that holds it, or, when no thread holds it, the PR itself: its state is unknown until the next PR pass reads it from GitHub), deliverable (dl-…) or card (d-…) to a task of its project. confirm(task): accept a drop; it leaves the dropped list and its things stay Unfiled. Each change is logged on the board as yours and its lead gets a notice.`,
    presentation: { label: { pending: "Tidying the board", completed: "Tidied the board" } },
    parameters: z.object({
      action: z.enum(TIDY_ACTIONS).optional(),
      task: z.string().max(80).optional().describe("merge: the task to fold in; restore/confirm: the dropped task; file: the task to file under (t-…)"),
      into: z.string().max(80).optional().describe("merge: the task that keeps going (t-…)"),
      kind: z.enum(FILE_KINDS).optional().describe("file: what ref is"),
      ref: z.string().max(400).optional().describe("file: a thread address or bb thread id, a PR URL, a deliverable id or a card id"),
      project: z.string().max(40).optional().describe("list: only this project"),
    }),
    // A PR filed with no thread holding it is read by the wait pass, never here: no GitHub on the request path.
    execute: (p, { threadId }) => run(threadId, (a) => engine.boardTidy(a, { ...p, action: p.action ?? "list" })),
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
        if (/^d-[\w-]+$/.test(p.id)) rmSync(join(stateDir(), "secrets", `${p.id}.txt`), { force: true });
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
    description: "Your recovery view: unread items, decisions waiting for you, your own open decisions, the standing rules you may cite, and the standing practices to follow (they settle nothing). With batchInbox on: ALL unread oldest first with full bodies, ids, refs and an ack-through cursor; reading never acknowledges. The CoS may inspect wakes or retry_wake by recipient.",
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

  type ThreadInfo = { id: string; projectId: string; environmentId: string | null; title: string | null; lastReadAt: number | null; latestAttentionAt: number | null; status: string };
  const threadInfo = async (threadId: string) => (await bb.sdk.threads.get({ threadId })) as unknown as ThreadInfo;

  async function prFetch(envIds: string[]): Promise<Record<string, PrResult>> {
    if (envIds.length === 0) return {};
    return (await bb.sdk.plugins.callRpc({ pluginId: "bb--github-pr-status", method: "pullRequests", input: { keys: envIds.slice(0, 200) }, outputSchema: z.record(z.string(), z.any()) })) as Record<string, PrResult>;
  }

  async function prPass(fake: Record<string, PrResult> | null, signal?: AbortSignal, seen?: PrResult[], byEnv?: Map<string, PrResult>): Promise<string> {
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
    if (seen && !fake) seen.push(...Object.values(res));
    if (byEnv && !fake) for (const [env, r] of Object.entries(res)) byEnv.set(env, r);
    const changedFor: string[] = [];
    for (const a of agents) {
      const r = res[a.environmentId!];
      if (r && engine.prSeen(a, a.environmentId!, r, fake ? " [injected]" : "")) changedFor.push(a.address);
    }
    if (changedFor.length) await flush();
    const summary = agents.map((a) => `${a.address}: ${res[a.environmentId!]?.outcome ?? "no reading"}`).join("; ");
    return `${changedFor.length ? `changed: ${changedFor.join(", ")}` : "no change"} (${summary || "no agents with an environment"})`;
  }

  const prChecked = new Map<string, string>();
  let lastNoHead = "";
  async function linkPass(bbReadings: Map<string, PrResult>, covered: PrResult[], signal?: AbortSignal): Promise<void> {
    const r = await readThreadPrs(engine, bbReadings, covered, {
      heads: async (ids) => {
        const rows = (await bb.sdk.plugins.callRpc({ pluginId: "bb--git", method: "status", input: { keys: ids.slice(0, 200) }, outputSchema: z.record(z.string(), z.any()) })) as Record<string, { outcome?: string; workspace?: { checkout?: { headSha?: string | null } } }>;
        return Object.fromEntries(ids.map((id) => [id, rows[id]?.outcome === "available" ? (rows[id]!.workspace?.checkout?.headSha ?? null) : null]));
      },
      read: (url) => openPrs.readWait(url, signal),
    }, prChecked, signal);
    if (r.linked.length) bb.log.info(`pr-links: linked ${r.linked.join(", ")}`);
    if (r.failed) bb.log.warn(`pr-links: ${r.failed} gh read(s) failed`);
    if (r.headsError) bb.log.warn(`pr-links: bb git status failed, no reported PR was compared: ${r.headsError}`);
    const noHead = r.noHead.join(", ");
    if (noHead && noHead !== lastNoHead) bb.log.info(`pr-links: no HEAD from bb git for ${noHead}; their reported PRs wait for one`);
    if (!r.headsError) lastNoHead = noHead;
    if (r.noHeadRef.length) bb.log.warn(`pr-links: gh read without a head commit, not compared: ${r.noHeadRef.join(", ")}`);
    if (r.unmatched.length) bb.log.info(`pr-links: not linked, the PR's head isn't the environment's HEAD: ${r.unmatched.join("; ")}`);
    if (r.read) await flush();
  }

  async function waitPass(covered: PrResult[], signal?: AbortSignal): Promise<string> {
    const urls = uncoveredWaitUrls([...engine.openWaitUrls(), ...engine.linkedPrsToRead()], covered);
    let closed = 0;
    let failed = 0;
    for (const url of urls) {
      if (signal?.aborted) return "stopped";
      const r = await unlessAborted(
        openPrs.readWait(url, signal).catch((e: unknown) => {
          failed++;
          bb.log.warn(`pr-wait ${url}: ${errText(e)}`);
          return null;
        }),
        signal,
      );
      if (r) closed += engine.waitPrSeen(r).length;
    }
    engine.pruneWaitReadings();
    if (closed) await flush();
    return `${urls.length} read with gh${failed ? ` (${failed} failed)` : ""}, ${closed} closed`;
  }

  const watchersView = (): Watchers => ({ waits: engine.watchList(), jobs: jobsView(cfg, { ...ran, ...engine.watchRuns() }), conditions: [...WAIT_WHEN] });

  bb.agents.registerTool({
    name: "orch_watch",
    description: `CoS only: the Watchers list. list (the default): every open PR wait (whose, which PR, condition, age, last reading) and every timed job (interval, last and next run). add (to, pr, when, note): a PR wait for any live agent; once the PR is there it gets the note back as work. retarget (id, pr and/or when): point a wait at another PR or condition. move (id, to): hand a wait to another live agent. drop (id): stop a wait. Every change tells the wait's old and new owner and shows on ${O.name}'s board. Intervals are ${O.name}'s settings: jobs are listed only, never changed.`,
    presentation: { label: { pending: "Reading the watchers", completed: "Read the watchers" } },
    parameters: z.object({
      action: z.enum(["list", "add", "retarget", "move", "drop"]).optional().describe("list (default), add, retarget, move or drop"),
      id: z.string().max(40).optional().describe("The PR wait's id (w-…) for retarget, move or drop"),
      to: z.string().max(120).optional().describe("add, move: the live agent's address"),
      pr: z.string().max(300).optional().describe("add, retarget: the PR's URL"),
      when: z.enum(WAIT_WHEN).optional().describe("add, retarget: approved, green (checks passing), ready (to merge) or merged"),
      note: z.string().max(600).optional().describe("add: what the agent carries out once the PR is there"),
    }),
    execute: (p, { threadId }) =>
      run(threadId, (a) => {
        if (a.role !== "cos") throw new EngineError("forbidden", "CoS only");
        const action = p.action ?? "list";
        if (action === "list") return watchText(engine.watchList(), jobsView(cfg, { ...ran, ...engine.watchRuns() }), Date.now());
        if (p.id && JOB_IDS.has(p.id)) throw new EngineError("forbidden", jobRefusal(p.id, cfg));
        if (action === "add") {
          if (!p.to || !p.pr || !p.when || !p.note) throw new EngineError("invalid", "add needs to, pr, when and note");
          return engine.watchAdd(a, { to: p.to, pr: p.pr, when: p.when, note: p.note });
        }
        if (!p.id) throw new EngineError("invalid", `${action} needs id: the PR wait (w-…); orch_watch lists them`);
        if (action === "retarget") return engine.watchRetarget(a, p.id, { pr: p.pr ?? null, when: p.when ?? null });
        if (action === "move") {
          if (!p.to) throw new EngineError("invalid", "move needs to: the live agent that gets the wait");
          return engine.watchMove(a, p.id, p.to);
        }
        return engine.watchDrop(a, p.id);
      }),
  });

  bb.agents.registerTool({
    name: "orch_spawn_thread",
    description: `Lead only: start one thread of a plan card ${O.name} approved (its go option). Each gets its own new worktree, you as its bb parent, and the orchestrator role. Refused without an approved plan, past the plan's thread count, or while the project is on hold. With scope_task it is that scoping task's scoping thread: its brief says so (read-only investigation; questions and findings to you), and orch_forward files its questions under the task.`,
    presentation: { label: { pending: "Starting a thread", completed: "Started a thread" } },
    parameters: z.object({
      provider: z.string().min(1).max(100).optional().describe("Provider id (default: claude-code); unavailable selections are refused"),
      plan: z.string().describe("The approved plan card's decision id (d-…)"),
      title: z.string().min(1).max(80),
      prompt: z.string().min(1).max(20000).describe("The thread's brief: goal, scope, constraints, done criteria"),
      model: z.string().max(80).optional(),
      reasoning: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      base_branch: z.string().max(200).optional().describe("Branch the worktree starts from (default: the repo's default)"),
      scope_task: SCOPE_TASK.optional().describe("An open scoping task's id or name: the thread is its scoping thread"),
    }),
    execute: async (p, { threadId }) => {
      let token: string | null = null;
      try {
        const a = caller(threadId);
        const task = p.scope_task ? engine.resolveTask(a, p.scope_task) : null;
        token = engine.reserveSpawn(a, p.plan, task?.id ?? null);
        const lead = await threadInfo(a.threadId);
        engine.ensureProject(a.project!, lead.projectId);
        const leadEnv = lead.environmentId ? ((await bb.sdk.environments.get({ environmentId: lead.environmentId })) as unknown as { hostId?: string | null }) : null;
        if (!leadEnv?.hostId) throw new EngineError("bad_state", "can't tell which machine the lead runs on");
        const selection = await spawnSelection(bb.sdk.providers, { hostId: leadEnv.hostId, projectId: lead.projectId }, p, { defaults: {}, warn: (m) => bb.log.warn(m) });
        const t = await bb.sdk.threads.spawn({
          projectId: lead.projectId,
          environment: { type: "host", hostId: leadEnv.hostId, workspace: { type: "managed-worktree", baseBranch: p.base_branch ? { kind: "named", name: p.base_branch } : { kind: "default" } } },
          prompt: task ? `${p.prompt.trimEnd()}\n\n${scopingThreadStart(a.project!, task, O.Name, a.address)}\n` : p.prompt,
          title: p.title,
          ...selection,
          parentThreadId: a.threadId,
          parentNotifications: "stuck",
          pluginMetadata: { role: "thread", project: a.project, plan: p.plan, ...(task ? { scope_task: task.id } : {}) },
        } as Parameters<typeof bb.sdk.threads.spawn>[0]);
        engine.confirmSpawn(token, t.id);
        token = null;
        const reg = engine.agentByThread(t.id) ?? engine.register(t.id, "thread", a.project, a.threadId);
        engine.setEnvironment(t.id, (t as unknown as ThreadInfo).environmentId ?? null);
        await bb.sdk.threads.updatePluginMetadata({ threadId: t.id, set: { address: reg.address, role: reg.role } });
        void flush();
        void placeSections();
        return ok(`Started ${reg.address} (${t.id}${reg.mon ? `, ${reg.mon}` : ""}) from ${p.plan}${task ? `, the scoping thread for task ${task.id} ${JSON.stringify(task.name)}` : ""}. It reports to you; a report, a question, a failure or a prompt it waits on wakes you, and each finished turn is an INFO line in your next digest.`);
      } catch (e) {
        if (token) {
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

  async function spawnedAnyway(leadThreadId: string | undefined, plan: string, title: string): Promise<string | null> {
    if (!leadThreadId) return null;
    const kids = (await bb.sdk.threads.list({ parentThreadId: leadThreadId, originPluginId: bb.pluginId, limit: 200 })).filter((t) => t.title === title);
    if (!kids.length) return null;
    const meta = await bb.sdk.threads.experimental_listPluginMetadata({ threadIds: kids.map((t) => t.id) });
    const ids = meta.threads.filter((m) => (m.metadata as { plan?: unknown }).plan === plan).map((m) => m.threadId);
    return ids.find((id) => !engine.hasSpawn(id)) ?? null;
  }

  const gitCall = (method: string, input: Record<string, string | number>) => bb.sdk.plugins.callRpc({ pluginId: "bb--git", method, input, outputSchema: z.any() });
  async function worktreeOf(environmentId: string | null, archivedAt: number | null = null): Promise<Verdict> {
    // Nothing to lose when there is no worktree or bb already archived the thread; a refusal here could never clear.
    if (!environmentId) return { clean: true, inBase: false, why: "it has no worktree" };
    if (archivedAt) return { clean: true, inBase: false, why: "bb already archived it" };
    try {
      await gitCall("refresh", { environmentId });
      const env = (await bb.sdk.environments.get({ environmentId })) as unknown as { mergeBaseBranch?: string | null };
      let base = (await gitCall("workspaceStatus", { environmentId, ...(env.mergeBaseBranch ? { mergeBaseBranch: env.mergeBaseBranch } : {}) })) as WorkspaceRead;
      if (base.outcome === "available" && "workspace" in base && !base.workspace.mergeBase) {
        base = (await gitCall("workspaceStatus", { environmentId, mergeBaseBranch: base.workspace.branch.defaultBranch })) as WorkspaceRead;
      }
      // bb lists at most 1000 remote branches, so the base's and the branch's copies are looked up by name.
      const listed = async (query?: string) => ((await gitCall("branches", { environmentId, limit: 1000, ...(query ? { query } : {}) })) as { remoteBranches?: string[] }).remoteBranches ?? [];
      const baseName = baseBranchOf(base);
      let remotes = [...new Set([...(await listed()), ...(baseName ? await listed(baseName) : [])])];
      // Against origin's base, never a stale local one; no fetch, which would write refs in a checkout other agents share.
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

  /** A failed copy throws: the archive waits rather than lose the notes. */
  function keepFiles(threadId: string, worktree: string | null): string {
    if (!worktree || !existsSync(worktree)) return "";
    const root = realpathSync(worktree);
    const notes = readdirSync(root, { withFileTypes: true }).filter((d) => d.isFile() && EXEMPT_NOTE.test(d.name)).map((d) => d.name);
    const into = engine.deliverableForThread(threadId, root);
    const dir = join(stateDir(), "threads", threadId);
    for (const n of notes) {
      if (into && engine.keepInDeliverable(into.id, join(root, n)).stored === "copied") continue;
      mkdirSync(dir, { recursive: true });
      cpSync(join(root, n), join(dir, n));
    }
    let moved = 0;
    for (const o of into ? engine.threadOutputs(threadId, root) : engine.outputsUnder(root)) {
      if (!existsSync(o.path!)) continue;
      const inWorktree = o.path!.startsWith(root + sep);
      if (into) {
        const k = engine.keepInDeliverable(into.id, o.path!);
        if (k.stored === "copied") {
          if (inWorktree) engine.repointOutput(o.id, k.path);
          moved++;
          continue;
        }
      }
      if (!inWorktree) continue;
      const to = join(dir, "outputs", relative(root, o.path!));
      mkdirSync(dirname(to), { recursive: true });
      cpSync(o.path!, to, { recursive: true });
      engine.repointOutput(o.id, to);
      moved++;
    }
    const what = [...notes, ...(moved ? [`${moved} output(s)`] : [])];
    return what.length ? ` Kept ${what.join(", ")} in ${into ? `${into.id}'s folder ${into.folder}` : dir}.` : "";
  }

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

  // An object, or the JSON string older-schema agents send; parsed again in execute so both reach the engine alike.
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
        const before: string[] = [];
        for (const id of engine.predecessors(t.threadId)) {
          const pt = await threadInfo(id).catch(() => null);
          if (pt && pt.environmentId === th.environmentId) before.push(id);
        }
        const out = engine.resolve(a, p.to, { prMerged: merged || engine.prFor(th.environmentId)?.state === "merged", prClosed: closed || engine.prFor(th.environmentId)?.state === "closed", lastReadAt: th.lastReadAt, worktree: await worktreeOf(th.environmentId, (th as { archivedAt?: number | null }).archivedAt ?? null), handedOff: p.handed_off === undefined ? null : HANDED_OFF.parse(p.handed_off) });
        // Predecessors first: they share the worktree, so it goes only with the last of them.
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
        const task = engine.scopingTaskOfThread(t.threadId);
        const takeover = `You take over ${p.to} (from thread ${t.threadId}) in this worktree. Read ${file} first: it says what is done, how to test, and what to do next. You are ${p.to} in ${ownerWords(cfg.ownerName).name}'s orchestrator; your lead is lead:${a.project}.`;
        // Spawned without a parent so the auto-register for a lead's new child doesn't take it; the parent is set below.
        const n = await bb.sdk.threads.spawn({
          projectId: th.projectId,
          environment: { type: "reuse", environmentId: th.environmentId },
          prompt: task ? `${takeover}\n\n${scopingThreadStart(a.project!, task, ownerWords(cfg.ownerName).Name, a.address)}\n` : takeover,
          title: `${th.title ?? p.to} (${p.provider})`,
          ...selection,
          pluginMetadata: { role: "thread", project: a.project, successorOf: t.threadId },
        } as Parameters<typeof bb.sdk.threads.spawn>[0]);
        let succ: Agent;
        try {
          succ = engine.takeOver(t.threadId, n.id, `${p.provider}${p.model ? ` ${p.model}` : ""}; ${file}`, { from: (th as { providerId?: string }).providerId ?? null, to: p.provider });
        } catch (e) {
          await bb.sdk.threads.stop({ threadId: n.id }).catch((x: unknown) => bb.log.warn(`handoff: stop orphan ${n.id}: ${errText(x)}`));
          throw new Error(`${errText(e)} (the new thread ${n.id} was stopped; ${p.to} is unchanged)`);
        }
        await bb.sdk.threads.update({ threadId: n.id, parentThreadId: a.threadId, parentNotifications: "stuck" } as Parameters<typeof bb.sdk.threads.update>[0]);
        await bb.sdk.threads.updatePluginMetadata({ threadId: n.id, set: { address: succ.address, role: succ.role } });
        await bb.sdk.threads.stop({ threadId: t.threadId }).catch((e: unknown) => bb.log.warn(`handoff: stop ${t.threadId}: ${errText(e)}`));
        // Hidden at once, not archived: it shares the successor's worktree, and resolving the successor archives both.
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

  // A push that reached a phone pauses it across reloads, so a reload can't buy another phone notification.
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
  /** A thread bb no longer has is refused before anything is sent, so that one goes again without it. */
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

  async function pinPlace(slug: string): Promise<OutputPlace> {
    const lead = engine.agentByAddress(`lead:${slug}`);
    if (!lead) return { roots: sharedRoots(), hostId: null };
    const { roots } = await deliverPlace(lead);
    return { roots: roots.map((r) => r.path), hostId: roots.find((r) => r.hostId)?.hostId ?? null, hosts: roots };
  }

  // An object, or the JSON string older-schema agents send; parsed again in execute, where the host may pass it raw.
  const DELIVER_BOARD = z.preprocess(fromJson, z.object({ id: z.string().trim().min(1).max(500), record: z.string().trim().max(40).optional(), flag: z.string().trim().max(160).optional() }).strict());
  const boardIn = (a: Agent, raw: unknown): { id: string; record?: string; flag?: string } | null => {
    if (raw === undefined || raw === null || raw === "") return null;
    const parsed = DELIVER_BOARD.safeParse(raw);
    if (!parsed.success) throw new EngineError("invalid", `board: ${parsed.error.issues.map((i) => `${i.path.join(".") || "board"}: ${i.message}`).join("; ")}`);
    const b = multiplayer.store.resolve(parsed.data.id);
    if (!b) throw new EngineError("not_found", `no board ${JSON.stringify(parsed.data.id)}: ${ownerWords(cfg.ownerName).name} adds boards on the Multiplayer tab`);
    const record = parsed.data.record || undefined;
    if (record) {
      const r = multiplayer.store.record(record);
      if (!r || r.lead !== a.address) throw new EngineError("not_found", `${record} is not one of your review records`);
      if (r.board !== b.id) throw new EngineError("invalid", `${record} is on another board`);
    }
    const flag = parsed.data.flag ? oneLine(parsed.data.flag, 160, "board.flag") : undefined;
    return { id: b.id, ...(record ? { record } : {}), ...(flag ? { flag } : {}) };
  };

  bb.agents.registerTool({
    name: "orch_deliver",
    description:
      `Lead only: hand ${O.name} a finished deliverable with proof; this and orch_ask are the only ways to reach ${O.name}. At least one proof item: ` +
      "image, video or text (a file path), doc (a path or URL), pr or link (a URL). A file must be inside your worktree, one of your threads' worktrees, " +
      `${sharedRoots().join(" or ")}; text at most 256 KB; images png/jpg/gif/webp/avif, videos mp4/webm/mov. ` +
      `The summary, points and blocks together show at most ${DELIVER_BUDGET} characters. ` +
      `${O.Name} approves it (maybe with a next action: deliverable.next, do it and ack with a note) or requests changes; on deliverable.changes, fix it and call this again with revises=<id>. When a new deliverable makes one of yours still in review out of date, deliver it with revises=<that id>; if it's a different topic that still makes the old one moot, withdraw the old one (orch_deliver_withdraw).`,
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
      revises: z.string().optional().describe(`The id of your deliverable ${O.name} sent back with changes, or one still in review that this one replaces (same id, rev + 1)`),
      scope_task: SCOPE_TASK.optional().describe(`An open scoping task's id or name: ${O.name} reviews it in the Scope tab under that task, not on Deliverables; the CoS gets a read-only copy. A revision stays in its task while the task is open`),
      task: z.string().max(80).optional().describe("The work-board task it delivers: its id (t-…, from orch_status) or an open step's title. A revision keeps the last one"),
      board: DELIVER_BOARD.optional().describe(
        `A review a Multiplayer board triggered: {id: the board (mb-…, its channel id or link), record: your review record (rr-…), flag: one line when it needs ${O.name} (couldn't verify, interview pending)}. ${O.Name} reviews it on that board, never on Deliverables; a flag also files a Needs you card. A revision keeps its board`,
      ),
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
        const board = boardIn(a, p.board);
        const place = p.proof.some((x) => x.path) ? await deliverPlace(a) : { roots: [] };
        const d = engine.deliver(a, { title: p.title, summary: p.summary, points: p.points, proof: p.proof as ProofInput[], revises: p.revises ?? null, blocks: p.blocks, scopeTask: p.scope_task ?? null, board, task: p.task ?? null }, place);
        if (d.board?.record) multiplayer.store.linkDeliverable(d.board.record, a.address, d.id);
        if (d.board) multiplayer.changed();
        void flush();
        if (d.board) return ok(`Delivered ${d.id} rev ${d.rev}: on its board's review view on the Multiplayer tab, not Deliverables${d.board.card ? `; the flag filed Needs you card ${d.board.card}` : ""}. The approval or requested changes come as a message.`);
        return ok(`Delivered ${d.id} rev ${d.rev}: in ${ownerWords(cfg.ownerName).name}'s review${d.scope ? ` in the Scope tab (${scopeWhere(d.project, d.scope_task)}; the CoS gets a read-only copy)` : ""}. The approval or requested changes come as a message.`);
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
    name: "orch_review_record",
    description:
      `Lead only: the review record behind a review request on one of ${O.name}'s Multiplayer boards, drawn on that board's Now, Timeline and review views. ` +
      "File one per request (no id: give board, wake, request and prs) and update it by id at each step: the thread, each GitHub review URL, the Slack reply's link, the deliverable, and state (reviewing, replying, waits, done). " +
      "Each step's time is recorded when it first appears. Store ids and links only, never Slack text. Returns the record's id.",
    presentation: { label: { pending: "Recording a review", completed: "Recorded a review" } },
    parameters: recordParams,
    execute: (p, { threadId }) =>
      run(threadId, (a) => {
        if (a.role !== "lead") throw new EngineError("forbidden", "only a lead files review records");
        const parsed = recordParams.safeParse(p);
        if (!parsed.success) throw new EngineError("invalid", parsed.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`).join("; "));
        const { record: r, created } = guard(() => multiplayer.file({ address: a.address, project: a.project }, parsed.data));
        return `${created ? "Filed" : "Updated"} ${r.id} on board ${r.board}: ${r.state}, ${r.prs.length} PR(s), ${r.reviews.length} review(s)${r.deliverable ? `, deliverable ${r.deliverable}` : ""}.`;
      }),
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
        const parsed = statusParams.safeParse(p);
        if (!parsed.success) throw new EngineError("invalid", parsed.error.issues.map((i) => `${i.path.join(".") || "status"}: ${i.message}`).join("; "));
        const s = engine.publishStatus(a, parsed.data);
        const ignored = ignoredTopLevelUpdate(parsed.data);
        const note = ignored.length ? ` Ignored top-level ${ignored.join(", ")}: update was given and wins; put them inside update.` : "";
        const ids = s.steps.length ? ` Task ids: ${s.steps.map((x) => `${x.id} ${JSON.stringify(x.title)}`).join("; ")}. Send each step back with its id (steps[].id), also when you reword it.` : "";
        return `Published: ${statusLine(s, ownerWords(cfg.ownerName).name) || s.goal}.${ids}${note}`;
      }),
  });

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
          const th = await threadInfo(a.threadId);
          if (th.environmentId) {
            const env = (await bb.sdk.environments.get({ environmentId: th.environmentId })) as unknown as { path?: string | null; hostId?: string | null };
            if (env.path) roots.unshift(env.path);
            hostId = env.hostId ?? null;
          }
          if (!hostId) throw new EngineError("bad_state", `your thread has no environment on a bb host, so ${ownerWords(cfg.ownerName).name} couldn't open the file`);
        }
        const { output, created } = engine.addOutput(a, { title: p.title, kind: p.kind, path: p.path ?? null, url: p.url ?? null, note: p.note ?? null }, { roots, hostId });
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

  // Listed only for threads of a memory project; the CoS and the Steward never get them.
  const memoryCaller = (threadId: string | undefined) => {
    const a = threadId ? engine.agentByThread(threadId) : null;
    if (a && (a.role === "cos" || a.role === "steward")) throw new EngineError("forbidden", "not for the CoS or the Steward");
    return a;
  };
  bb.agents.registerTool({
    name: TOOL_SEARCH,
    description:
      "Search the memory: the vault (project pages, decisions), each project's notes and, with transcripts, past Claude " +
      "sessions. Keyword search (ripgrep, BM25): seconds. Each hit is `path:line [project]` and a snippet; read one with memory_page. It stops after 45 s.",
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
        return toolResult(await memoryRun(searchArgv(p), 45_000));
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

  // Tools per role come from the store, the authority: thread metadata is only a mirror any agent could write.
  bb.agents.configure((context) => {
    const a = engine.agentByThread(context.thread.id);
    const seeded = (context.pluginMetadata as { role?: unknown }).role;
    const role = a?.role ?? (context.origin.pluginId === bb.pluginId && ROLES.includes(seeded as Role) ? (seeded as Role) : null);
    if (!role) {
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

  bb.agents.contributeInstructions(({ threadId }) => {
    const a = threadId ? engine.agentByThread(threadId) : null;
    if (!a) return null;
    if (!engine.settings.batchInbox) return `[orchestrator] Your current inbox (as of ${new Date().toISOString()}):\n${engine.inbox(a).text}`;
    const delivery = "Batch inbox: a debounced wake carries your unread mail and its cursor. Handle it, then orch_ack(through=<cursor>). Replies do not ack unread. INFO stays quiet unless needs_reply or due. Decision outcomes still use orch_ack(id,outcome). ";
    return `[orchestrator] ${delivery}Your current recovery view (not a digest read; as of ${new Date().toISOString()}):\n${engine.inbox(a).text}`;
  });

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
    reads.forget(thread.id);
    if (!engine.agentByThread(thread.id)) return;
    engine.setStatus(thread.id, "active");
    void flush();
  });
  const bbParent = (t: unknown) => (t as { parentThreadId?: string | null }).parentThreadId ?? null;
  const bbNotify = (t: unknown) => (t as { parentNotifications?: string }).parentNotifications;
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    reads.forget(thread.id);
    const a = engine.agentByThread(thread.id);
    if (!a) return;
    engine.setStatus(thread.id, "idle");
    void collectXp(thread.id);
    if (a.role === "thread" && !engine.bbTellsSupervisor(a, bbParent(thread), bbNotify(thread), "turn"))
      engine.notifySupervisor(a, `finished a turn. Last words: ${JSON.stringify((lastAssistantText ?? "").slice(0, 400))}`);
    void flush();
  });
  bb.events.on("thread.failed", ({ thread, error }) => {
    reads.forget(thread.id);
    const a = engine.agentByThread(thread.id);
    if (!a) return;
    engine.setStatus(thread.id, "error");
    if (!engine.bbTellsSupervisor(a, bbParent(thread), bbNotify(thread), "failure"))
      engine.notifySupervisor(a, `failed: ${error ?? "unknown error"}`, a.role === "thread");
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
    reads.forget(thread.id);
    if (engine.agentByThread(thread.id)) engine.setStatus(thread.id, "archived");
  });
  bb.events.on("thread.unarchived", ({ thread }) => reads.forget(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => reads.forget(thread.id));
  bb.events.on("experimental_thread.read", ({ thread }) => reads.forget(thread.id));
  bb.events.on("interaction.pending", ({ thread, interaction }) => {
    reads.forget(thread.id);
    const a = engine.agentByThread(thread.id);
    if (!a) return;
    if (a.role === "thread" && !engine.bbTellsSupervisor(a, bbParent(thread), bbNotify(thread), "turn")) {
      engine.notifySupervisor(a, "is waiting on a prompt in its bb thread (a permission or a question); it can't go on until it is answered.", true, `pending:${interaction.id}`);
      void flush();
    }
    changed([BB]);
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
      // The reading can lag the compaction: wait for a new one, and at least COMPACT_COOLDOWN_MS, before asking again.
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

  // Only threads with no section are placed, so a thread the owner moves by hand stays where they put it.
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
        const kept = r.kept.join(", ");
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

  const levelInfo = (a: Agent) => {
    const { tokens, level } = engine.xpOf(a.address);
    const form = formAt(a.mon, level, a.monPin);
    return { level, xp: tokens, xpThis: tokensForLevel(level), xpNext: tokensForLevel(level + 1), form: form?.name ?? a.mon, formDex: form?.dex ?? null };
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

  const runPrune = (dryRun: boolean): string => {
    const { counts, decisions } = prune(db, Date.now(), cfg, dryRun);
    if (dryRun) return `would delete: ${pruneSummary(counts)}`;
    for (const id of decisions) rmSync(join(stateDir(), "decisions", `${id}.json`), { force: true });
    // VACUUM can't run inside a transaction.
    if (Object.values(counts).some((n) => n > 0)) db.exec("VACUUM");
    return `deleted: ${pruneSummary(counts)}`;
  };

  bb.background.service("clock", {
    async start(signal) {
      try {
        const b = engine.backfillFiles();
        if (b.deliverables) bb.log.info(`deliverable files: ${b.deliverables} folder(s), ${b.copied} copied, ${b.reused} reused, ${b.tooBig} over the cap, ${b.failed} failed, ${b.missing.length} missing`);
      } catch (e) {
        bb.log.warn(`deliverable files: ${errText(e)}`);
      }
      // bb waits 5 s for a stopped service, then fails the reload: a stopped clock stops waiting on a pass and drops a slow call's result.
      const reconcile = async () => {
        const stale = engine.sweepStaleSpawns(loadedAt);
        if (stale) bb.log.info(`spawns: released ${stale} stale reservation(s)`);
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
          const threads = await lookThreads(engine, engine.agents(), (threadId) => bb.sdk.threads.get({ threadId }), signal);
          for (const a of engine.agents()) {
            if (signal.aborted) return;
            const t = threads.get(a.threadId);
            if (!t) continue;
            // bb reports an archived thread's last status (e.g. idle); keep it archived, so a Start can replace it.
            const archived = !!(t as { archivedAt?: number | null }).archivedAt;
            if (a.status === "stopped" && !archived) continue;
            engine.setStatus(a.threadId, archived ? "archived" : t.status);
            if (!a.environmentId) engine.setEnvironment(a.threadId, (t as unknown as ThreadInfo).environmentId ?? null);
          }
          for (const { agent, leadThreadId } of autoUnderLead(engine, threads as unknown as Map<string, BbNotify>)) {
            if (signal.aborted) return;
            try {
              await bb.sdk.threads.update({ threadId: agent.threadId, parentThreadId: leadThreadId, parentNotifications: "stuck" } as Parameters<typeof bb.sdk.threads.update>[0]);
              bb.log.info(`notify level: ${agent.address} (${agent.threadId}) auto -> stuck under its lead ${leadThreadId}, as orch_spawn_thread sets`);
            } catch (e) {
              bb.log.warn(`notify level: ${agent.address} (${agent.threadId}): ${errText(e)}`);
            }
          }
        } catch (e) {
          bb.log.warn(`reconcile: ${errText(e)}`);
        }
      };
      let lastCompactCheck = 0;
      let lastPrCheck = 0;
      let lastPlace = 0;
      let lastXp = 0;
      let lastPrune = 0;
      let lastThreads = Date.now();
      const pass = async () => {
        try {
          engine.tick();
          mark("tick");
          sweepSecrets(join(stateDir(), "secrets"), Date.now() - SECRET_TTL_MS);
          engine.flagUnplanned(60_000);
          await flush();
          if (signal.aborted) return;
          if (cfg.prPollMinutes > 0 && Date.now() - lastPrCheck > cfg.prPollMinutes * 60_000) {
            lastPrCheck = Date.now();
            const seen: PrResult[] = [];
            const byEnv = new Map<string, PrResult>();
            await prPass(null, signal, seen, byEnv).catch((e) => bb.log.warn(`pr-watch: ${errText(e)}`));
            if (!signal.aborted) await linkPass(byEnv, seen, signal).catch((e) => bb.log.warn(`pr-links: ${errText(e)}`));
            if (!signal.aborted) await waitPass(seen, signal).catch((e) => bb.log.warn(`pr-wait: ${errText(e)}`));
            mark("pr-watch");
          }
          if (Date.now() - lastXp > 120_000) {
            lastXp = Date.now();
            mark("xp");
            for (const a of engine.agents()) {
              if (signal.aborted) return;
              if (a.status !== "archived") await collectXp(a.threadId);
            }
          }
          if (signal.aborted) return;
          if (Date.now() - lastPlace > 30_000) {
            lastPlace = Date.now();
            mark("layout");
            await placeSections();
            await pruneProjectSections();
          }
          if (signal.aborted) return;
          if (Date.now() - lastThreads > GONE_CHECK_MS) {
            lastThreads = Date.now();
            await lookThreads(engine, engine.agents(), (threadId) => bb.sdk.threads.get({ threadId }), signal);
            await flush();
          }
          if (signal.aborted) return;
          if (Date.now() - lastPrune > DAY_MS && (cfg.retentionDays > 0 || cfg.activityRetentionDays > 0)) {
            lastPrune = Date.now();
            mark("retention");
            bb.log.info(`retention: ${runPrune(false)}`);
          }
          if (signal.aborted) return;
          if (Date.now() - lastCompactCheck > 60_000) {
            lastCompactCheck = Date.now();
            if (cfg.cosCompactTokens > 0) mark("compaction");
            await compactCos(false);
          }
        } catch (e) {
          if (!signal.aborted) bb.log.warn(`clock: ${errText(e)}`);
        }
      };
      wakeTimers = true;
      signal.addEventListener("abort", () => {
        wakeTimers = false;
        if (wakeTimer) clearTimeout(wakeTimer);
        wakeTimer = null;
        wakeAt = Infinity;
      }, { once: true });
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
      alarms.restore(engine.lastAlarmLevel(), Date.now(), thresholds().sustainMs);
      while (!signal.aborted) {
        try {
          const now = Date.now();
          const s = sample(cfg.diskPath, now);
          mark("sampler");
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
        // A stopped service stops waiting: bb gives it 5 s, and a step's systemctl and git calls may take 30 s.
        await unlessAborted(dreams.step().catch((e) => bb.log.warn(`dreams: ${errText(e)}`)), signal);
        mark("dreams");
        await sleep(60_000, signal);
      }
    },
  });

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
    scopingDone: d.orchestrator.scoping_done ? { summary: d.orchestrator.scoping_done.summary, projectMd: d.orchestrator.scoping_done.project_md ?? d.orchestrator.scoping_done.doc ?? "" } : null,
    scopeTask: d.orchestrator.scope_task ?? null,
    revised: d.orchestrator.revised?.count ?? 0,
  });

  const providerOf = new Map<string, string | null>();
  const pathwaysSnapshotFile = (slug: string) => join(stateDir(), "pathways", `${slug}.json`);
  const pathwaysSnapshots = createPathwaysSnapshots({
    now: () => Date.now(),
    maxAgeMs: 60_000,
    read: (slug) => {
      try {
        return JSON.parse(readFileSync(pathwaysSnapshotFile(slug), "utf8")) as PathwaysSnapshot;
      } catch {
        return null;
      }
    },
    write: (slug, snapshot) => {
      const file = pathwaysSnapshotFile(slug);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(snapshot));
      renameSync(`${file}.tmp`, file);
    },
  });
  let feedPrompts: FeedPrompt[] = [];
  type ThreadRead = ThreadInfo & { environment?: { branchName?: string | null } | null };
  const threadRead = (threadId: string) =>
    reads.thread(threadId, "get", () => (bb.sdk.threads.get({ threadId, include: "environment" } as Parameters<typeof bb.sdk.threads.get>[0]) as Promise<unknown> as Promise<ThreadRead>).catch(() => null));
  const contextRead = (threadId: string) => reads.thread(threadId, "context", () => bb.sdk.threads.context({ threadId }).catch(() => null));
  const interactionsRead = (threadId: string) =>
    reads.thread(threadId, "interactions", () => (bb.sdk.threads.interactions.list({ threadId }) as Promise<unknown> as Promise<RawInteraction[]>).catch(() => null));
  const onSlowRead = (name: string, ms: number) => {
    const d = loop.take();
    bb.log.warn(`slow read ${name}: ${Math.round(ms)} ms (event loop delay since the last slow read: ${d ? `p99 ${d.p99} ms, max ${d.max} ms` : "no new samples"})`);
  };
  bb.rpc.register(rpcContract, timeReads(shareReads(reads, ["needsYou", "agents", "scope"], {
    async howItWorks() {
      return { markdown: readFileSync(join(import.meta.dirname, "USAGE.md"), "utf8") };
    },
    async config() {
      return {
        ownerName: cfg.ownerName.trim(),
        cosTitle: cosTitleOf(cfg.cosTitle),
        linearWorkspace: cfg.linearWorkspace.trim(),
        linearTeams: cfg.linearTeams.split(",").map((t) => t.trim()).filter(Boolean),
        hiddenTabs: cfg.hiddenTabs.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
        shown: shownUntilUsed({ boards: multiplayer.store.boards().length, queueSetUp: queueSetUp(reviewQueue.store.get(), cfg.reviewQueueDryRun !== false), gameboy: cfg.showGameBoy === true, cloud: cfg.showCloud === true }),
      };
    },
    async needsYou({ zone }) {
      const v = engine.needsYou();
      // Asked of bb 8 at a time: one by one costs a round trip per agent, and all at once times out under load.
      const list = engine.agents();
      const perAgent: NeedsYou["interactions"][] = new Array(list.length);
      let next = 0;
      const one = async (a: (typeof list)[number]): Promise<NeedsYou["interactions"]> => {
        const rows = ((await interactionsRead(a.threadId)) ?? []).filter((r) => (r.status ?? "pending") === "pending");
        if (!rows.length) return [];
        const t = await threadRead(a.threadId);
        if (!t) return [];
        return rows.map((r) => {
          const kind = r.kind ?? r.payload?.kind ?? "prompt";
          return { id: r.id, threadId: a.threadId, address: a.address, title: t.title ?? a.address, kind, since: r.createdAt ? new Date(r.createdAt).toISOString() : null, questions: kind === "user_question" ? toQuestions(r.payload) : [] };
        });
      };
      await Promise.all(
        Array.from({ length: Math.min(8, list.length) }, async () => {
          while (next < list.length) {
            const i = next++;
            perAgent[i] = await one(list[i]!);
          }
        }),
      );
      const interactions: NeedsYou["interactions"] = perAgent.flat();
      const was = feedPrompts.map((p) => p.id).join();
      feedPrompts = interactions.filter((i) => !i.address.startsWith("thread:")).map((i) => ({ id: i.id, threadId: i.threadId, address: i.address, title: i.title, since: i.since }));
      // A prompt answered in bb itself reaches the page as a status flip, which refetches this read but not the feed.
      if (feedPrompts.map((p) => p.id).join() !== was) changed([BB]);
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
      const assigned = engine.personaAssignments();
      return {
        rows: engine.board(),
        watchers: watchersView(),
        directUnread: [...engine.directLines()].filter(([, d]) => d.unread).map(([slug]) => slug),
        dead: engine.deadLetters({ board: true }).map((i) => ({ id: i.id, recipient: i.recipient, sender: i.sender, kind: i.kind, body: i.body, note: i.note, createdAt: i.createdAt })),
        agents: engine.agents().map((a) => ({ threadId: a.threadId, address: a.address, role: a.role, project: a.project, status: a.status, mon: a.mon, monType: engine.accentType(a.project), ...engine.faceOf(a, assigned) })),
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
      const assigned = engine.personaAssignments();
      return engine.projects().map((p) => {
        const lead = agents.find((a) => a.role === "lead" && a.project === p.slug && a.status !== "archived");
        return {
          slug: p.slug,
          priority: p.priority,
          heldAt: p.heldAt,
          archivedAt: p.archivedAt,
          createdAt: p.createdAt,
          mode: p.mode,
          lead: lead ? { address: lead.address, threadId: lead.threadId, status: lead.status, mon: lead.mon, persona: engine.personaOf(lead, assigned) } : null,
          monType: engine.accentType(p.slug),
          threads: agents.filter((a) => a.role === "thread" && a.project === p.slug).length,
          openPlans: engine.openPlans(p.slug),
          status: engine.leadStatus(p.slug),
          summary: summaries.get(p.slug) ?? null,
          direct: direct.get(p.slug) ?? null,
          prs: prs.filter((x) => x.project === p.slug).map(({ project: _, ...x }) => x),
          handedOff: handedOff.get(p.slug) ?? [],
          tasks: engine.openTasks(p.slug).map((t) => ({ id: t.id, name: t.name, planner: engine.taskPlanner(t.id)?.address ?? null })),
        };
      });
    },
    async agents(): Promise<Agents> {
      const assigned = engine.personaAssignments();
      return Promise.all(
        engine.agents().map(async (a) => {
          const t = await threadRead(a.threadId);
          const ctx = await contextRead(a.threadId);
          const pr = engine.prFor(a.environmentId);
          const proj = a.project ? engine.project(a.project) : null;
          return {
            monType: engine.accentType(a.project),
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
            persona: engine.personaOf(a, assigned),
            ...levelInfo(a),
            model: ctx?.usage?.snapshot?.model ?? null,
            usedTokens: ctx?.usage?.usedTokens ?? null,
            contextWindow: ctx?.usage?.modelContextWindow ?? null,
            branch: t?.environment?.branchName ?? null,
            pr: pr ? { url: pr.url, number: pr.number, state: pr.state, attention: pr.attention, checks: pr.checks, review: pr.review } : null,
            unread: !!(t?.latestAttentionAt && (!t.lastReadAt || t.latestAttentionAt > t.lastReadAt)),
            flags: a.flags ? a.flags.split(",").filter(Boolean) : [],
            scopeTask: a.role === "thread" ? ((t) => (t ? { id: t.id, name: t.name } : null))(engine.scopingTaskOfThread(a.threadId)) : null,
          };
        }),
      );
    },
    projectBook({ slug, dayStart }) {
      return engine.projectBook(slug, dayStart);
    },
    async scope() {
      const planner = async (taskId: string) => {
        const a = engine.taskPlanner(taskId);
        if (!a) return null;
        const t = await threadRead(a.threadId);
        const at = engine.lastReportAt(a.address);
        const text = at === null ? null : engine.lastReport(a.address);
        return { address: a.address, threadId: a.threadId, title: t?.title?.trim() || null, status: a.status, idleAt: a.idleAt, report: text !== null && at !== null ? { text, at } : null };
      };
      const projects = await Promise.all(
        engine.scopeView().map(async (p) => ({
          slug: p.slug,
          whole: p.whole,
          tasks: await Promise.all(p.tasks.map(async (t) => ({ id: t.id, name: t.name, openedAt: t.openedAt, planner: await planner(t.id) }))),
          cards: p.cards.map((d) => card(d)),
        })),
      );
      return { projects, badge: projects.reduce((n, p) => n + p.cards.length, 0) };
    },
    async pathways({ slug, refresh }): Promise<PathwaysView> {
      const failure = (error: string, errorKind: PathwaysErrorKind | null = null): PathwaysView => ({ error, errorKind, map: null, retro: null, fetchedAt: null, refreshing: false });
      const recordRel = `projects/${slug}/${projectRecord()}`;
      const retroDecisions = (list: ReturnType<typeof engine.decisions>) =>
        list.map((decision) => ({ id: decision.id, title: decision.ask?.title ?? decision.request.title, state: decision.state }));
      if (!engine.project(slug)) return failure("Pathways project not found.", "project-missing");
      const apiKey = cfg.linearApiKey?.trim();
      let linearProjectId: string | undefined;
      let linearMapIssue: string | undefined;
      const recordPath = join(projectsDir(), slug, projectRecord());
      if (existsSync(recordPath)) {
        try {
          const parsed = JSON.parse(readFileSync(recordPath, "utf8")) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return failure(`Invalid JSON in ${recordRel}: expected a JSON object. Fix the file, then click Refresh.`, "invalid-record");
          }
          const record = parsed as { linearProjectId?: unknown; linearMapIssue?: unknown };
          linearProjectId = typeof record.linearProjectId === "string" ? record.linearProjectId.trim() : undefined;
          linearMapIssue = typeof record.linearMapIssue === "string" ? record.linearMapIssue.trim() : undefined;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          return failure(`Invalid JSON in ${recordRel}: ${detail}. Fix the JSON syntax, then click Refresh.`, "invalid-record");
        }
      }
      if (!apiKey || !linearProjectId) {
        const readLocal = async (): Promise<Pathways> => {
          const now = Date.now();
          const status = engine.leadStatus(slug);
          const rawThreads = engine.agents().filter((a) => a.role === "thread" && a.project === slug && a.status !== "archived");
          const threads = await mapPathwaysLimited(rawThreads, 8, async (a) => {
            const info = (await bb.sdk.threads.get({ threadId: a.threadId }).catch(() => null)) as { title?: string | null; status?: string | null } | null;
            const pr = engine.prFor(a.environmentId);
            return {
              address: a.address,
              threadId: a.threadId,
              title: info?.title?.trim() || engine.lastReport(a.address)?.split("\n")[0]?.trim() || a.address,
              status: info?.status?.trim() || a.status,
              prUrls: pr?.url ? [pr.url] : [],
            };
          });
          const decisions = engine.decisions(5000).filter((decision) => decision.project === slug);
          const prs = engine.knownPrs().filter((p) => p.project === slug);
          const deliverables = engine.deliverables().filter((deliverable) => deliverable.project === slug);
          const waits = engine.openWaits();
          const map = localPathwaysMap({
            slug,
            status,
            threads,
            decisions: decisions.map((decision) => ({
              id: decision.id,
              state: decision.state,
              title: decision.ask?.title ?? decision.request.title,
              question: decision.ask?.question ?? decision.request.question,
              action: decision.orchestrator.action,
              createdAt: decision.created_at,
              prUrls: (decision.request.blocks ?? []).flatMap((block) => (block.kind === "pr" ? [block.url] : [])),
            })),
            prs,
            deliverables,
            waits,
            now,
          });
          const retroSummary = summarizePathwaysRetro(map, retroDecisions(decisions), now);
          const retro =
            retroSummary.finished.length ||
            retroSummary.mergedPrs.length ||
            retroSummary.decisions.length ||
            retroSummary.stalled.length
              ? { ...retroSummary, doc: null, hostId: null }
              : null;
          const notice = linearProjectId && !apiKey ? "Linear project is linked (linearProjectId is set), but linearApiKey is unset in Orchestrator plugin settings. Showing the local map until you set linearApiKey and refresh." : null;
          return { error: null, notice, map, retro };
        };
        const localKey = `local:${linearProjectId ? "unkeyed" : "direct"}`;
        return pathwaysSnapshots.view(slug, refresh ?? false, readLocal, localKey);
      }
      class LinearRequestError extends Error {
        readonly status: number | null;
        readonly retryAfter: number | null;
        readonly graphql: string | null;
        constructor(opts: { status?: number | null; retryAfter?: number | null; graphql?: string | null }) {
          super("Linear request failed");
          this.status = opts.status ?? null;
          this.retryAfter = opts.retryAfter ?? null;
          this.graphql = opts.graphql ?? null;
        }
      }
      const read = async (): Promise<Pathways> => { try {
        const request = async <T,>(query: string, id: string, after: string | null = null): Promise<T> => {
          const response = await fetch("https://api.linear.app/graphql", { method: "POST", headers: { Authorization: apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables: { id, after } }), signal: AbortSignal.timeout(12_000) });
          if (!response.ok) {
            const rawRetry = response.status === 429 ? response.headers.get("retry-after")?.trim() : undefined;
            const secs = rawRetry && /^\d+$/.test(rawRetry) ? Number(rawRetry) : null;
            throw new LinearRequestError({ status: response.status, retryAfter: secs && secs > 0 ? secs : null });
          }
          const result = await response.json() as { data?: T; errors?: { message?: unknown }[] };
          if (result.errors?.length || !result.data) {
            const firstMsg = result.errors?.find((e) => typeof e?.message === "string" && e.message.trim())?.message;
            const detail = typeof firstMsg === "string" ? firstMsg.replace(/\s+/g, " ").trim().slice(0, 200) : "";
            throw new LinearRequestError({ graphql: detail });
          }
          return result.data;
        };
        const summary = await projectIssues((after) => request<{ project: { issues: { nodes: { identifier: string; parent: { identifier: string } | null; labels: { nodes: { name: string }[] } }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null }>(`query($id: String!, $after: String) { project(id: $id) { issues(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { identifier parent { identifier } labels { nodes { name } } } } } }`, linearProjectId, after));
        if (!summary) return failure(`Linear project "${linearProjectId}" was not found. Update linearProjectId in ${recordRel}, then click Refresh.`, "project-missing");
        const mapIndex = selectPathwaysMap(summary, linearMapIssue);
        if (!mapIndex) return failure(linearMapIssue ? `Map issue "${linearMapIssue}" was not found in Linear project "${linearProjectId}". Update linearMapIssue in ${recordRel}, then click Refresh.` : `No map issue with label "wayfinder:map" was found in Linear project "${linearProjectId}". Add that label in Linear or set linearMapIssue in ${recordRel}, then click Refresh.`, "map-missing");
        const ids = [mapIndex.identifier, ...summary.filter((issue) => issue.parent?.identifier === mapIndex.identifier).map((issue) => issue.identifier)];
        const detailQuery = `query($id: String!) { issue(id: $id) { identifier title url description updatedAt state { type name } priority estimate assignee { name } labels { nodes { name } } parent { identifier } attachments { nodes { id url } } relations { nodes { type relatedIssue { identifier title url state { type } } } } inverseRelations { nodes { type issue { identifier title url state { type } } } } } }`;
        const issues = await mapPathwaysLimited(ids, 8, async (id) => (await request<{ issue: PathwaysIssue | null }>(detailQuery, id)).issue);
        if (issues.some((issue) => !issue)) return failure("Pathways Linear issue details were missing. Try Refresh.");
        const map = pathwaysMap(issues[0]!, issues.slice(1) as PathwaysIssue[]);
        const decisions = engine.decisions(5000).filter((decision) => decision.project === slug);
        linkPathwaysDecisions(map, issues.slice(1) as PathwaysIssue[], decisions.map((decision) => ({ id: decision.id, state: decision.state, title: decision.request.title, context: decision.request.context, project: decision.project, prUrls: (decision.request.blocks ?? []).flatMap((block) => block.kind === "pr" ? [block.url] : []) })));
        for (const ticket of map.tickets) if (ticket.readiness.state === "needs decision" || ticket.displayState === "blocked") ticket.decisionDraft = draftPathwaysDecision(ticket);
        const deliverables = engine.deliverables().filter((deliverable) => deliverable.project === slug);
        const waits = engine.openWaits();
        const linked = map.tickets.flatMap((ticket) => ticket.prLink.urls.map((url) => ({ ticket, url })));
        await mapPathwaysLimited(linked, 8, async ({ ticket, url }) => {
          const reading = await openPrs.readPathways(url).catch(() => ({ outcome: "unavailable" as const }));
          const pr = reducePathwaysPr(url, reading, Date.now());
          const proof = reducePathwaysProof(pr, collectPathwaysProofRecords(url, deliverables));
          const mergeDecision = decisions.find((decision) => decision.orchestrator.action === "merge" && decision.request.blocks?.some((block) => block.kind === "pr" && block.url.replace(/\/+$/, "").toLowerCase() === url));
          const waitLane = reducePathwaysWaitLane(pr, proof, waits.filter((wait) => wait.prUrl.replace(/\/+$/, "").toLowerCase() === url), mergeDecision ? { id: mergeDecision.id, state: mergeDecision.state, createdAt: Date.parse(mergeDecision.created_at) } : null);
          ticket.prs.push({ pr, proof, waitLane });
        });
        for (const ticket of map.tickets) {
          ticket.prs.sort((a, b) => a.pr.url.localeCompare(b.pr.url));
          const primary = ticket.prs.filter(({ pr }) => pr.state !== "merged" && pr.state !== "closed").sort((a, b) => ({ unavailable: 0, blocked: 1, ready: 2, merged: 3, closed: 4 })[a.pr.state] - ({ unavailable: 0, blocked: 1, ready: 2, merged: 3, closed: 4 })[b.pr.state])[0];
          ticket.pr = primary?.pr ?? null;
          ticket.proof = primary?.proof ?? null;
          ticket.waitLane = primary?.waitLane ?? null;
        }
        attachPathwaysPreflight(map, issues.slice(1) as PathwaysIssue[]);
        const retroLibrary = join(projectsDir(), slug, "library");
        let retroDoc: string | null = null;
        if (existsSync(retroLibrary)) retroDoc = readdirSync(retroLibrary).filter((name) => /retro/i.test(name) && /\.md$/i.test(name)).sort()[0] ?? null;
        const retro = { ...summarizePathwaysRetro(map, retroDecisions(decisions), Date.now()), doc: retroDoc ? join(retroLibrary, retroDoc) : null, hostId: retroDoc ? await onlyHost().catch(() => null) : null };
        return { error: null, map, retro };
      } catch (error) {
        if (error instanceof LinearRequestError) {
          if (error.status === 401 || error.status === 403) {
            return failure(`Linear rejected linearApiKey (HTTP ${error.status}). Update linearApiKey in Orchestrator plugin settings, then click Refresh.`, "auth");
          }
          if (error.status === 429) {
            const wait = error.retryAfter ? `about ${error.retryAfter}s` : "a minute";
            return failure(`Linear rate limit reached (HTTP 429). Wait ${wait} before clicking Refresh.`, "rate-limit");
          }
          if (error.status != null && error.status >= 500) {
            return failure(`Linear returned a server error (HTTP ${error.status}). Try Refresh again shortly.`, "server");
          }
          if (error.graphql !== null) {
            const detail = error.graphql ? `: ${error.graphql}` : "";
            return failure(`Linear GraphQL error${detail}. Check linearProjectId ("${linearProjectId}") in ${recordRel} and linearApiKey permissions in Orchestrator settings.`, "graphql");
          }
          return failure(`Linear request failed (HTTP ${error.status}). Check your connection and click Refresh.`, "network");
        }
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          return failure("Linear request timed out after 12s. Check Linear status or your connection, then click Refresh.", "timeout");
        }
        return failure("Linear request failed (network error). Check your connection and click Refresh.", "network");
      } };
      const linearKey = `linear:${linearProjectId}:${linearMapIssue ?? ""}`;
      return pathwaysSnapshots.view(slug, refresh ?? false, read, linearKey);
    },
    feed({ cursor, filter }) {
      return engine.feed({ cursor, filter }, feedPrompts);
    },
    feedThread({ about, before }) {
      return engine.feedThread(about, before);
    },
    cosLine({ before }) {
      return engine.cosLine(before);
    },
    directHistory({ slug, before, limit }) {
      return engine.directHistory(slug, before ?? null, limit ?? 30);
    },
    searchCards({ q }) {
      return engine.searchAnswered(q);
    },
    workBoard({ since, project }) {
      return engine.workBoard({ since: since ?? null, project: project ?? null });
    },
    async boardSince(input) {
      return sinceRead(db, engine, await boardSince.cache(), cfg.githubLogin, input);
    },
    async viewPrefs() {
      return viewPrefs();
    },
    async projectHistory({ slug }) {
      const ids = engine.projectThreadIds(slug);
      await Promise.all(
        ids
          .filter((id) => !providerOf.has(id))
          .map(async (id) => {
            const t = (await bb.sdk.threads.get({ threadId: id }).catch(() => null)) as { providerId?: string } | null;
            providerOf.set(id, t?.providerId ?? null);
          }),
      );
      return engine.projectHistory(slug, providerOf);
    },
    projectOrder(): ProjectOrder {
      return engine.projects().map((p) => ({ slug: p.slug, monType: engine.accentType(p.slug) }));
    },
    outputs(): Outputs {
      return engine.outputs().map((o) => ({ id: o.id, title: o.title, kind: o.kind, path: o.path, url: o.url, hostId: o.hostId, note: o.note, project: o.project, author: o.author, at: o.at, gone: o.path !== null && !existsSync(o.path) }));
    },
    deliverableFolders(): DeliverableFolders {
      return engine.deliverableFolders();
    },
    deliverables(): DeliverableRows {
      return deliverableRows(engine);
    },
    deliverable({ id }) {
      return deliverableWhole(engine, id);
    },
    deliverableIndex() {
      return deliverableIndex(engine);
    },
  }), onSlowRead));

  // bb's "local" auth lets a request with no Origin through; this also wants the page's own origin and a same-origin fetch.
  const appUrls = (): string[] => {
    const urls: (string | null)[] = [];
    try {
      urls.push(bb.server.experimental_appUrl);
      urls.push(bb.server.loopbackBaseUrl);
    } catch {
    }
    return urls.filter((u): u is string => !!u);
  };
  const notFromScreens = (c: { req: { url: string; header(name: string): string | undefined } }) =>
    writeOriginProblem({ origin: c.req.header("origin"), secFetchSite: c.req.header("sec-fetch-site"), requestUrl: c.req.url, appUrls: appUrls() });
  await registerVoice(bb, { engine, ownerName: () => cfg.ownerName, originProblem: (h) => writeOriginProblem({ ...h, appUrls: appUrls() }) });
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

  // A code the owner pastes: written to a 0600 file, never into the decision.
  const keepSecret = (id: string, rev: number, value: string, via: "desktop" | "phone" | "voice", typed: boolean) => {
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
  write(WRITES.pathwaysDecision, pathwaysDecisionSubmitBody, (b) => {
    const lead = engine.agentByAddress(`lead:${b.slug}`);
    if (!lead || lead.role !== "lead" || lead.project !== b.slug) throw new EngineError("not_found", "Live project lead not found");
    const prior = engine.decisionByRequestKey(lead.address, pathwaysDecisionKey(b.ticketId, b.question));
    if (prior) return prior.id;
    const project = engine.project(b.slug);
    const snapshotMap = pathwaysSnapshots.peek(b.slug)?.value.map;
    if (snapshotMap?.source === "orchestrator") throw new EngineError("bad_state", "Decision drafts are only supported for Linear maps");
    const ticket = snapshotMap?.tickets.find((item) => item.identifier === b.ticketId);
    if (!project || !ticket) throw new EngineError("not_found", "Project or ticket not found; refresh Pathways");
    if (ticket.readiness.state !== "needs decision" && ticket.displayState !== "blocked") throw new EngineError("bad_state", "Ticket has no recorded decision blocker");
    const draft = draftPathwaysDecision(ticket);
    if (b.question !== draft.question) throw new EngineError("conflict", "Ticket question changed; refresh Pathways");
    draft.options = b.options;
    const id = submitPathwaysDecision(draft, { existing: (key) => engine.decisionByRequestKey(lead.address, key)?.id ?? null, create: (key, value) => engine.ask(lead, { title: value.title, question: value.question, context: value.context, options: value.options, key }).id });
    pathwaysSnapshots.markStale(b.slug);
    return id;
  });
  write(WRITES.answer, answerBody, (b) =>
    b.option === null && looksLikeCode(b.text) ? keepSecret(b.id, b.rev, b.text!, b.via, true) : engine.personAnswer(b.id, b.rev, b.option, b.text, b.via).rev,
  );
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
  write(OPEN_PRS_POST, openPrsPostBody, (b) => openPrs.post(b.key));
  write(OPEN_PRS_COPIED, openPrsCopiedBody, (b) => openPrs.copied(b));
  write(REVIEW_QUEUE_WRITE, queueActionSchema, (b) => reviewQueue.act(b));
  write(MULTIPLAYER_WRITES.add, boardAddBody, (b) => guard(() => multiplayer.addBoard(b)));
  write(MULTIPLAYER_WRITES.remove, boardRemoveBody, (b) => guard(() => multiplayer.removeBoard(b.id)));
  write(WRITES.resend, resendBody, (b) => engine.resend(b.id).id);
  write(WRITES.priority, priorityBody, (b) => engine.setPriority(b.slug, b.priority));
  write(WRITES.hold, holdBody, (b) => engine.setHold(b.slug, b.held));
  write(WRITES.boardMove, boardMoveBody, (b) => engine.boardMove(b.task, b.to));
  // One save at a time, in order: each reads the kept choices and writes them back whole, so two at once would lose one.
  let prefSaves: Promise<unknown> = Promise.resolve();
  write(WRITES.viewPref, viewPrefBody, (b) => {
    const save = prefSaves.then(async () => {
      const was = await viewPrefs();
      const rev = was.rev + 1;
      const next: ViewPrefs = "projectsView" in b ? { ...was, projectsView: b.projectsView, rev } : { ...was, boardFolds: { ...was.boardFolds, [b.board]: b.folded }, rev };
      await bb.storage.kv.set(VIEW_PREFS, next);
      return { rev };
    });
    prefSaves = save.catch(() => undefined);
    return save;
  });
  write(WRITES.directMessage, directMessageBody, (b) => engine.ownerMessage(b.slug, b.text, b.followUp ?? null, b.images ?? [], b.about ?? null, b.task ?? null).id);
  write(WRITES.feedSeen, feedSeenBody, (b) => engine.markFeedSeen(b.upTo));
  write(WRITES.feedResend, feedResendBody, (b) => engine.resendOwner(b.id).id);
  // Only the branch and the size are logged, never the bytes.
  const keepImage = async (to: string, threadId: string, b: { name: string; data: string }) => {
    const bytes = Buffer.from(b.data, "base64");
    if (bytes.length > MAX_IMAGE_BYTES) throw new EngineError("invalid", `an image is at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    const mime = sniff(bytes);
    if (!mime) throw new EngineError("invalid", "not a png, jpeg, gif or webp image");
    const name = safeName(b.name, mime);
    let kept: { path: string; sourceProject: string | null } | null = null;
    let why = "";
    try {
      const projectId = ((await bb.sdk.threads.get({ threadId })) as { projectId?: string }).projectId;
      if (!projectId) why = "no bb project";
      else {
        const up = await bb.sdk.projects.attachments.upload({ projectId, clientFile: new Uint8Array(bytes), filename: name, mimeType: mime });
        if (up?.path && isAbsolute(up.path)) kept = { path: up.path, sourceProject: projectId };
        else why = "no absolute path";
      }
    } catch (e) {
      why = errText(e).slice(0, 200);
    }
    if (!kept) {
      const dir = join(stateDir(), "direct-images");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${name}`);
      writeFileSync(path, bytes, { mode: 0o600 });
      kept = { path, sourceProject: null };
    }
    bb.log.info(`direct image for ${to}: ${bytes.length} bytes, ${kept.sourceProject ? "bb attachments" : `own folder (${why})`}`);
    return { name, mime, size: bytes.length, path: kept.path, sourceProject: kept.sourceProject };
  };
  write(WRITES.directImage, directImageBody, async (b) => {
    const lead = engine.agentByAddress(`lead:${b.slug}`);
    if (!lead) throw new EngineError("bad_state", `${b.slug} has no live lead: start it first`);
    return engine.addDirectImage(b.slug, await keepImage(b.slug, lead.threadId, b));
  });
  write(WRITES.cosImage, cosImageBody, async (b) => {
    const cos = engine.liveAt("cos");
    if (!cos) throw new EngineError("not_found", "No Chief of Staff is running: start it from the Projects tab");
    return engine.addCosImage(await keepImage("cos", cos.threadId, b));
  });
  write(WRITES.directSeen, directSeenBody, (b) => engine.markDirectSeen(b.slug, b.upTo));
  write(WRITES.outputRemove, outputRemoveBody, (b) => engine.removeOutput(b.id));
  write(WRITES.pin, pinBody, async (b) => engine.pin(b.slug, b.target, { title: b.title ?? null, by: "owner" }, await pinPlace(b.slug)).pin.id);
  write(WRITES.unpin, unpinBody, (b) => engine.unpinDoc(b.id, { by: "owner" }).id);
  write(WRITES.approve, approveBody, (b) => engine.personApprove(b.id, b.rev, b.note, b.next ?? null).rev);
  write(WRITES.requestChanges, requestChangesBody, (b) => engine.personRequestChanges(b.id, b.rev, b.text).rev);
  write(WRITES.projectMode, projectModeBody, (b) => engine.setMode(b.slug, b.mode, "person").mode);
  write(WRITES.watchAdd, watchAddBody, (b) => engine.watchAdd(null, b));
  write(WRITES.watchRetarget, watchRetargetBody, (b) => engine.watchRetarget(null, b.id, { pr: b.pr ?? null, when: b.when ?? null }));
  write(WRITES.watchMove, watchMoveBody, (b) => engine.watchMove(null, b.id, b.to));
  write(WRITES.watchDrop, watchDropBody, (b) => engine.watchDrop(null, b.id));
  write(WRITES.scopeThread, scopeThreadBody, (b) => engine.ownerScopeThread(b.threadId, { task: b.task ?? null, name: b.name ?? null }).task.id);
  write(WRITES.unscopeThread, unscopeThreadBody, (b) => engine.ownerUnscopeThread(b.threadId)?.id ?? null);
  // Read-only, so bb's "local" auth guards it (a same-origin <img>/<video> sends no Origin); never HTML or SVG, nothing sniffed or run.
  bb.http.route("GET", PROOF_ROUTE, async (c) => {
    let f: ReturnType<typeof engine.proofFile>;
    try {
      const output = c.req.query("output");
      f = output ? engine.outputFile(output) : engine.proofFile(String(c.req.query("id") ?? ""));
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
        const fd = openSync(f.path, "r");
        try {
          const buf = Buffer.alloc(Math.min(statSync(f.path).size, f.maxBytes));
          const n = readSync(fd, buf, 0, buf.length, 0);
          return new Response(buf.subarray(0, n), { headers });
        } finally {
          closeSync(fd);
        }
      }
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

  const BRIEF_DIR = join(import.meta.dirname, "briefs");
  type BbProject = { id: string; name: string; sources?: { hostId: string; path: string; isDefault?: boolean }[] };

  async function onlyHost(): Promise<string> {
    const hosts = (await bb.sdk.hosts.list()).filter((h) => h.status === "connected" && h.lifecycle.phase === "active");
    if (hosts.length !== 1) throw new EngineError("bad_state", `can't tell which machine to create the bb project on: ${hosts.length} connected hosts`);
    return hosts[0]!.id;
  }

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

  async function homeProject(): Promise<{ projectId: string; hostId: string }> {
    const id = cfg.homeProjectId.trim();
    if (!id) return bbProjectFor(stateDir());
    const p = (await bb.sdk.projects.get({ projectId: id })) as unknown as BbProject;
    const src = p.sources?.find((s) => s.isDefault) ?? p.sources?.[0];
    if (!src) throw new EngineError("bad_state", `the home project ${id} has no folder on a machine`);
    return { projectId: p.id, hostId: src.hostId };
  }

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

  write(WRITES.cosMessage, cosMessageBody, ({ text, images = [], about }) => {
    const it = engine.ownerCosMessage(text, images, about ?? null);
    return { id: it.id, threadId: engine.liveAt("cos")?.threadId ?? null };
  });

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
    reads.forget(threadId); // answered: the page's refetch must not find it still pending
    return { threadId };
  });

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
            mode: z.string().optional().describe(`scoping: ${O.name} settles its scope with the lead first, in the Scope tab | active (default)`),
          }),
        )
        .optional()
        .describe("slug, title, repo, goal (needed); repo_url, base, constraints, priority, mode"),
    }),
    execute: async (p, { threadId }) => {
      try {
        const a = caller(threadId);
        if (a.role !== "cos") throw new EngineError("forbidden", "CoS only");
        if (!p.brief || typeof p.brief !== "object") throw new EngineError("invalid", "give brief: {slug, title, repo, goal, repo_url?, base?, constraints?, priority?, mode?}");
        const r = await oneAtATime(async () =>
          newProject({ engine, root: projectsDir(), record: projectRecord(), memoryFolder: (slug) => memoryProjectsNow.get(slug), now: Date.now(), by: "cos", log: (m) => bb.log.warn(m) }, p.brief!),
        );
        void flush();
        return ok(`Created ${r.slug} (priority ${r.priority}${r.mode === "scoping" ? ", scoping mode" : ""}) in ${r.folder}: ${r.files.map((f) => basename(f)).join(", ")}. No lead yet: start it with orch_start_lead(slug="${r.slug}").`);
      } catch (e) {
        return fail(errText(e));
      }
    },
  });

  bb.agents.registerTool({
    name: "orch_project_mode",
    description: `CoS only: set a project's mode. scoping: its lead's cards and deliverables go only to ${O.name}'s Scope tab (no triage for you, no standing rule; you get read-only copies), and its lead is told to start no build threads. active: the normal flow; what waits in the Scope pane moves to Needs you and Deliverables. The lead's "Scoping done?" card, answered yes, sets active by itself.`,
    presentation: { label: { pending: "Setting a project's mode", completed: "Set a project's mode" } },
    parameters: z.object({
      slug: z.string().max(80).optional().describe("The project's slug"),
      mode: z.string().max(20).optional().describe("scoping | active"),
    }),
    execute: (p, { threadId }) =>
      run(threadId, (a) => {
        if (a.role !== "cos") throw new EngineError("forbidden", "CoS only");
        const slug = String(p.slug ?? "").trim();
        const mode = String(p.mode ?? "").trim();
        if (!slug || !mode) throw new EngineError("invalid", "give slug and mode (scoping | active)");
        if (!PROJECT_MODES.includes(mode as ProjectMode)) throw new EngineError("invalid", `mode is one of ${PROJECT_MODES.join(", ")}`);
        const before = engine.project(slug)?.mode;
        const r = engine.setMode(slug, mode as ProjectMode, "cos");
        if (before === r.mode) return `${slug} is already ${r.mode}; nothing changed.`;
        return `${slug} is ${r.mode} now.${r.mode === "scoping" ? ` Its lead's cards go to ${O.name}'s Scope tab; you get read-only copies.` : " Its cards take the normal route; what waited in the Scope pane moved to Needs you and Deliverables."}`;
      }),
  });

  startRoute(WRITES.roleStart, roleStartBody, async ({ role }) => {
    engine.checkStart(role, null);
    const folder = join(stateDir(), role);
    const prompt = loadBrief(BRIEF_DIR, role, { pokemon: introSentence(engine.monForStart(role, null), engine.personaForStart(role, null)), folder, owner: ownerWords(cfg.ownerName).name });
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

  const usage = [
    "bb orchestrator status",
    "bb orchestrator integration import <json-file> | integration receipts <source> [after-sequence] [limit] | integration heartbeat <source> [--every <minutes>]",
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
    "bb orchestrator prune [--dry-run]",
  ];
  bb.cli.register({
    name: "orchestrator",
    summary: "Roles, decisions and mail of the bb orchestrator",
    commands: [...usage.map((u) => ({ name: u.split(" ")[2]!, summary: u, usage: u })), ...slackWatch.cli.commands!],
    async run(argv, ctx) {
      if (argv[0] === "slack-watch") return slackWatch!.cli.run(argv, ctx);
      const out = (s: string, code = 0) => ({ exitCode: code, stdout: s.endsWith("\n") ? s : `${s}\n` });
      try {
        const [cmd, ...rest] = argv;
        // ctx.threadId is the caller's BB_THREAD_ID, unverified: the `self` checks stop honest mistakes, and privileged commands leave a Board line.
        const self = ctx.threadId ? engine.agentByThread(ctx.threadId) : null;
        if (privileged(cmd, rest))
          engine.boardAdd("notice", "orchestrator", null, `CLI: bb orchestrator ${argv.join(" ")}`.slice(0, 200), `Run from ${self ? self.address : ctx.threadId ? `thread ${ctx.threadId}` : "no bb thread (a terminal, or a caller that dropped BB_THREAD_ID)"}${ctx.cwd ? ` in ${ctx.cwd}` : ""}.`, null);
        switch (cmd) {
          case "pin":
          case "unpin": {
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
              if (Object.hasOwn(slackWatch!.routes(), mail.source)) throw new EngineError("forbidden", "watcher sources are reserved for slack-watch");
              allowImport(integrationRoutes(cfg.integrationRoutes), mail.source, mail.to);
              const item = engine.importMail(mail);
              void flush();
              return out(JSON.stringify({ itemId: item.id, state: item.state }));
            }
            if (rest[0] === "receipts" && rest[1]) {
              return out(JSON.stringify(engine.externalReceipts(rest[1], Number(rest[2] ?? 0), Number(rest[3] ?? 100))));
            }
            if (rest[0] === "heartbeat" && rest[1] && !rest[1].startsWith("--")) {
              if (Object.hasOwn(slackWatch!.routes(), rest[1]!)) throw new EngineError("forbidden", "watcher heartbeats require a completed scan");
              allowImport(integrationRoutes(cfg.integrationRoutes), rest[1]!);
              const b = guard(() => multiplayer.heartbeat(rest[1]!, everyArg(rest)));
              return out(JSON.stringify({ source: b.source, lastAt: b.lastAt, everyMs: b.everyMs, reads: b.reads }));
            }
            throw new EngineError("invalid", "integration import <json-file> | integration receipts <source> [after-sequence] [limit] | integration heartbeat <source> [--every <minutes>]");
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
              parent: async (id, parentThreadId, notify) => { await bb.sdk.threads.update({ threadId: id, parentThreadId, parentNotifications: notify }); },
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
            const run = cliRun(process.env.BB_CLI || "bb", bb.server.loopbackBaseUrl);
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
          case "prune": {
            const why = pruneRefusal(self, rest.includes("--dry-run"));
            if (why) throw new EngineError("forbidden", why);
            return out(runPrune(rest.includes("--dry-run")));
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
          case "sweep": {
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

/** A real prune never comes from an agent: it deletes the owner's record. */
export function pruneRefusal(self: Agent | null, dryRun: boolean): string | null {
  if (!self || (dryRun && self.role === "steward")) return null;
  const rule = "only the Steward may run `bb orchestrator prune --dry-run` (it counts, and deletes nothing); the real prune runs once a day under the owner's retention settings, or from the owner's terminal";
  return self.role === "steward" ? `the Steward may run only \`bb orchestrator prune --dry-run\`: ${rule}` : rule;
}

export function mayRead(a: Agent, d: Decision): boolean {
  if (a.role === "cos") return true;
  if (a.address === d.orchestrator.asker || a.address === d.orchestrator.origin) return true;
  return a.role === "lead" && d.project === a.project;
}

const COMPACT_COOLDOWN_MS = 10 * 60_000;

/** bb reads a stored value only through a descriptor, so the old key keeps one and is unset once at load; its value is never carried over. */
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
    case "prune":
      return !rest.includes("--dry-run");
    default:
      return false;
  }
}

/** Why a write isn't from the app's own page, or null; a tunnel rewrites both Origin and host to loopback. */
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

export function handoffFile(root: string, given: string): string {
  const inside = (f: string) => isAbsolute(f) && (f === root || f.startsWith(root + sep));
  const named = resolvePath(root, given);
  if (!inside(named) || !existsSync(named)) throw new EngineError("invalid", `no handoff file ${given} in ${root}`);
  const file = realpathSync(named); // a symlink in the worktree must not point the successor outside it
  if (!inside(file)) throw new EngineError("invalid", `${given} resolves outside ${root}`);
  return file;
}

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

function zonedWallTime(zone: string, now: number, dayOffset: number, hour: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const guess = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + dayOffset, hour);
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
    }
  }
}
