// The orchestrator's engine: who is who, decisions, mail, rules and the board, over one SQLite database.
//
// Every write is a transaction on the store; delivery to a bb thread is a separate step (`flush`) that the server
// runs through bb's SDK. An item is written before it is sent, so a crash between the two re-sends it, marked
// "(again)" — never loses it. Nothing here calls a model: escalation, resends and dead letters are the `tick`.
import { cosLine, feedPage, feedThread, type CosLineEntry, type FeedFilter, type FeedMsg, type FeedPage, type FeedPrompt, type FeedSource } from "./feed.ts";
import { BatchInbox, type MailPolicy } from "./batch-inbox.ts";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, sep } from "node:path";
import { type Db, migrate, prepareHinted, tx } from "./db.ts";
import { MON_POOLS, baseOf, builtInMon, familyThreads, formAt, levelFor, monByName, pickMon, pickPackThread, pickType, setPackLines, shownStage, specialtyLines, typeFamily, type Mon, type MonType, type PackLine } from "../mons.ts";
import { agentPersona, assignPersonas, type AgentPersona, type PersonaPack } from "../personas.ts";
import { blocksSchema, pointsSchema, type Block, type Point } from "../blocks.ts";
import { ownerWords, type OwnerWords } from "./owner.ts";
import type { Verdict } from "./clean.ts";
import { externalBody, externalMailSchema, externalPreview, type ExternalMail } from "./integration.ts";
import type { StartedBy } from "./start.ts";
import { MOOT_MIN_SHARED, MOOT_WINDOW_MS, sharedWords } from "./moot.ts";
import { cardRefusal } from "./caps.ts";
import { LIVE } from "../change-notice.ts";
import { type DirectImage, type ImageType, MAX_IMAGE_BYTES, MAX_IMAGES, withImages, wordsOf } from "./direct-images.ts";
import { type BbPrReading, PR_URL_RE } from "./open-prs.ts";
import type { WaitView } from "./watchers.ts";
import { type LeadStatus, normalizeStatus, sameWait, type StatusParams, STATUS_STALE_MS, statusLine } from "./status.ts";
import { addressTask, assignTasks, linkCardPrs, linkDeliverablePrs, linkPr, resolveTaskRef, taskRow, TaskError, waitTask, type TaskRow as WorkTaskRow } from "./tasks.ts";
import { readBoard, settleColumns } from "./work-board.ts";
import { COLUMN_LABEL, type BoardColumn, type WorkBoard } from "../contract.ts";
import { confirmDrop, fileItem, type FileKind, markStaleFlagged, mergeTask, restoreTask, staleNotice, staleTasks, type StaleTask, type TidyAction, tidyList, TidyRefusal } from "./board-tidy.ts";
import { backfillEvents, buildHistory, buildSummary, logEvent, logSince, SUMMARY_DONE_MS, type DecisionLite, type EventIn, type EventRow, type HistoryInput, type ProjectHistory, type ProjectSummary, type SummaryInput } from "./history.ts";
import { waitsOf } from "./status.ts";
import { COPY_MAX, fileProof, folderFor, keepFile, keptCopy, listFolder, type Kept, writeReadme } from "./deliverable-files.ts";
import { addPin, findPin, getPin, pinViews, unpin, type Pin, type PinTarget, type PinView } from "./pins.ts";
import { SUMMARY_ANSWERED_SQL, projectBook, searchAnswered, type CardHit, type ProjectBook } from "./book.ts";

type HistoryAgent = HistoryInput["agents"][number];
import { type RuleMatch, type Shape, allowFrom, matchRule, offerFor, ownerPick, shapeOf, words } from "./rules.ts";

/** orch_needs_you's answered and moot lists by default: the last day, newest 20. */
export const RECENT_DEFAULT = { ms: 24 * 3_600_000, limit: 20, maxLimit: 200 } as const;
export const DLQ_WAKE_MS = 60 * 60_000;
/** How long a PR-bound answer waits before its owner is reminded, and then between reminders. */
export const WAIT_NUDGE_MS = 24 * 3_600_000;
/** What a PR-bound answer waits for. Merged satisfies every one; a PR closed unmerged ends the wait unmet. */
export const WAIT_WHEN = ["approved", "green", "ready", "merged"] as const;
export type WaitWhen = (typeof WAIT_WHEN)[number];
/** How often the CoS gets the stale-thread list at most, and how long idle (or silent) counts as stale. */
export const STALE_WAKE_MS = 24 * 3_600_000;
/** How long mail to an address no agent holds yet (a new project's lead, the first CoS) waits for one before it is a dead letter. */
export const UNHELD_GRACE_MS = 24 * 3_600_000;
/** How far apart bb's two "no such thread" answers must be before an agent is retired for it (threadNotFound). */
export const GONE_CONFIRM_MS = 5 * 60_000;
/** A feed post by its key (Engine.post): `line` is where a reply to it goes, null when it only opens. */
export interface Post { key: string; kind: string; id: string; title: string; project: string | null; line: string | null; rev: number | null }
export interface DirectLine {
  messages: { id: string; text: string; at: number; followUp: string | null; state: string; outcome: string | null; note: string | null; answeredAt: number | null; unread: boolean; images?: { name: string }[] }[];
  unread: boolean;
}
/** For this long the owner's direct word wins on its point over a CoS instruction, earlier or later. */
export const DIRECT_IN_FORCE_MS = 48 * 3_600_000;
export const DIRECT_SHOWN = 4;
/** An owner's message that starts a feed post of its own: its about becomes msg:<its id>. */
export const OWN_POST = "msg:";
/** direct_images rows staged for the owner's tracked messages to the CoS (no project). */
export const COS_IMAGES = "@cos";
const WHEN_WORDS: Record<WaitWhen, string> = { approved: "approved", green: "green (checks passing)", ready: "ready to merge", merged: "merged" };
/** How far apart a handoff's retire and its successor's start may lie. */
const HANDOFF_GAP_MS = 1000;
/** How long a pasted sign-in code stays on disk at most. */
export const SECRET_TTL_MS = 30 * 60_000;
import {
  type Agent,
  addressFor,
  type Decision,
  type Deliverable,
  type DeliverableNext,
  EngineError,
  iso,
  type Item,
  type ItemKind,
  type Level,
  oneLine,
  type Opt,
  type Closed,
  type Outcome,
  OUTCOMES,
  type Priority,
  PRIORITIES,
  PROJECT_MODES,
  PROJECT_RE,
  type ProjectMode,
  type Proof,
  PROOF_KINDS,
  type ProofKind,
  type Role,
  ROLES,
  type Rule,
  isPractice,
  type ScopingTask,
  type ScopingTaskState,
} from "./model.ts";

export interface Settings {
  escalateMs: number; // an untriaged decision goes to the owner after this
  resendMs: number; // an unacked item is re-sent after its recipient has been idle this long
  owner: string; // the ownerName setting: how agents' messages name the owner ("" = "the owner")
  // Off: agents still get a Pokémon in the database, so switching on shows it, but every Agent handed out has mon null.
  pokemon: boolean;
  batchInbox: boolean; // off is per-message delivery
  inboxDebounceMs: number;
  // A lead's least time between two inbox wakes; 0 is off.
  inboxGapMs?: number;
  // The pack the personaPack setting names, already checked; { error } when the path is set but the pack failed; null when
  // none is set. Picks follow a loaded pack whatever the pokemon setting; what shows needs pokemon on too.
  personas?: PersonaPack | { error: string } | null;
}
export const DEFAULT_SETTINGS: Settings = { escalateMs: 5 * 60_000, resendMs: 10 * 60_000, owner: "", pokemon: false, batchInbox: true, inboxDebounceMs: 2000, inboxGapMs: 120_000, personas: null };
const packOf = (x: Settings["personas"]): PersonaPack | null => (x && !("error" in x) ? x : null);

export type DeliverResult = { delivery: "sent" } | { delivery: "queued"; queuedMessageId: string } | { delivery: "held"; why: string };

export interface Ports {
  now(): number;
  /** Current operator allow-list: disabling a route pauses unsent external mail and retries. */
  externalEnabled?(source: string, recipient: string): boolean;
  /** Send one item's text to a thread. "held": the thread can't take it now (stopped); try again when it starts. */
  deliver(threadId: string, text: string, item: Item): Promise<DeliverResult>;
  mirror(d: Decision): void;
  /** Something the screens show changed; `tables`: what it changed beyond the writes recorded (change-notice.ts). */
  changed(tables?: readonly string[]): void;
  /** A card just entered the owner's Needs you (asked, escalated, or back from a deferral by time). */
  cardUp?(d: Decision): void;
  delivered?(d: Deliverable): void;
  /** Where deliverables keep their own files (core/deliverable-files.ts); none: proof stays where the lead filed it. */
  files?(): { dir: string; maxBytes?: number; kept?: string } | null;
  log(msg: string): void;
}

const hex = (n: number) => randomBytes(n).toString("hex");
/** A span for agents' eyes: "45s", "12m", "3h 5m", "2d 4h". */
export function ago(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ""}`;
}
/** A `since` filter: an ISO time, or a span back from now ("90m", "24h", "7d"). */
export function parseSince(s: string | null | undefined, now: number, fallbackMs: number): number {
  const v = (s ?? "").trim();
  if (!v) return now - fallbackMs;
  const span = /^(\d+)\s*([mhd])$/i.exec(v);
  if (span) return now - Number(span[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[span[2]!.toLowerCase() as "m" | "h" | "d"];
  const at = Date.parse(v);
  if (Number.isNaN(at)) throw new EngineError("invalid", `since is an ISO time or a span like 24h or 7d, not ${JSON.stringify(v)}`);
  return at;
}
function decisionId(now: number): string {
  const t = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `d-${t}-${hex(3)}`;
}

interface ItemRow {
  id: string;
  recipient: string;
  sender: string;
  kind: string;
  ref: string | null;
  body: string;
  send_key: string | null;
  needs_ack: number;
  state: string;
  attempts: number;
  queued_message_id: string | null;
  created_at: number;
  delivered_at: number | null;
  closed_at: number | null;
  outcome: string | null;
  note: string | null;
  dead_seq: number | null;
  dead_at: number | null;
  on_board: number;
  about: string | null;
}
const toItem = (r: ItemRow): Item => ({
  id: r.id,
  recipient: r.recipient,
  sender: r.sender,
  kind: r.kind as ItemKind,
  ref: r.ref,
  body: r.body,
  sendKey: r.send_key,
  needsAck: r.needs_ack === 1,
  state: r.state as Item["state"],
  attempts: r.attempts,
  queuedMessageId: r.queued_message_id,
  createdAt: r.created_at,
  deliveredAt: r.delivered_at,
  closedAt: r.closed_at,
  outcome: r.outcome,
  note: r.note,
  deadAt: r.dead_at ?? null,
  onBoard: r.on_board === 1,
  about: r.about ?? null,
});

interface AgentRow {
  thread_id: string;
  address: string;
  role: string;
  project: string | null;
  parent_thread_id: string | null;
  status: string;
  idle_at: number | null;
  environment_id: string | null;
  mon: string | null;
  mon_stage: number | null;
  mon_stage_level: number | null;
  flags: string;
}
const toAgent = (r: AgentRow, pokemon: boolean): Agent => ({
  threadId: r.thread_id,
  address: r.address,
  role: r.role as Role,
  project: r.project,
  parentThreadId: r.parent_thread_id,
  status: r.status,
  idleAt: r.idle_at,
  environmentId: r.environment_id ?? null,
  mon: pokemon ? (r.mon ?? null) : null,
  monPin: pokemon && r.mon_stage != null && r.mon_stage_level != null ? { stage: r.mon_stage, level: r.mon_stage_level } : null,
  flags: r.flags ?? "",
});

export interface ProjectRow {
  slug: string;
  bbProjectId: string | null;
  priority: Priority;
  heldAt: number | null;
  archivedAt: number | null;
  createdAt: number;
  monType: MonType | null; // its Pokémon type (mons.ts TYPES), whatever the setting
  mode: ProjectMode; // scoping: its lead's cards and deliverables go only to the owner's Scope pane
}

/** One environment's PR as bb's PR status reports it (bb--github-pr-status `pullRequests`); a PR wait's gh reading too. */
export type PrResult = BbPrReading;

export interface PrRow {
  environmentId: string;
  threadId: string;
  url: string | null;
  number: number | null;
  state: string | null;
  attention: string | null;
  checks: string | null;
  /** The review decision (approved, changes_requested, review_required, none) from a v2 signature; null for an older format. */
  review: string | null;
  seenAt: number;
}

type PrsRow = { environment_id: string; thread_id: string; url: string | null; number: number | null; state: string | null; attention: string | null; checks: string | null; sig: string; seen_at: number };
const prRow = (r: PrsRow | undefined): PrRow | null => {
  if (!r) return null;
  // the signature is v2|url|state|checks|review|merge|queued (prSeen)
  const review = r.sig.startsWith("v2|") ? r.sig.split("|")[4] || null : null;
  return { environmentId: r.environment_id, threadId: r.thread_id, url: r.url, number: r.number, state: r.state, attention: r.attention, checks: r.checks, review, seenAt: r.seen_at };
};

interface RuleRow {
  id: string;
  text: string;
  project: string | null;
  kinds: string;
  expires_at: number | null;
  granted_by: string;
  source: string;
  created_at: number;
  revoked_at: number | null;
  match: string | null;
}
const toRule = (r: RuleRow): Rule => ({
  id: r.id,
  text: r.text,
  project: r.project,
  kinds: JSON.parse(r.kinds),
  expiresAt: r.expires_at,
  grantedBy: "person",
  source: r.source,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
  match: r.match ? (JSON.parse(r.match) as RuleMatch) : null,
});

interface ProjectDbRow {
  slug: string;
  bb_project_id: string | null;
  priority: string;
  held_at: number | null;
  archived_at: number | null;
  created_at: number;
  mon_type: string | null;
  mode: string | null;
}
const toProjectRow = (r: ProjectDbRow): ProjectRow => ({
  slug: r.slug,
  bbProjectId: r.bb_project_id,
  priority: r.priority as Priority,
  heldAt: r.held_at,
  archivedAt: r.archived_at,
  createdAt: r.created_at,
  monType: typeFamily(r.mon_type)?.type ?? null,
  mode: r.mode === "scoping" ? "scoping" : "active",
});

/** An ask's blocks, checked here too (tests and the engine's own callers skip the tool's schema). */
function parseBlocks(blocks: unknown): Block[] {
  const r = blocksSchema.safeParse(blocks ?? []);
  if (!r.success) throw new EngineError("invalid", `blocks: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return r.data;
}

interface DirectImageRow { id: string; slug: string; item_id: string | null; n: number | null; name: string; mime: string; size: number; path: string; source_project: string | null; created_at: number }
function imageOf(r: DirectImageRow): DirectImage {
  return { id: r.id, name: r.name, mime: r.mime as ImageType, size: r.size, path: r.path, sourceProject: r.source_project };
}

/** An owner.message item as the page shows it. `unread`: answers after the owner last opened the line, by item id. */
function directMessageOf(it: Item, unread: Map<string, number>, images: DirectImage[] = []): DirectLine["messages"][number] {
  return {
    id: it.id, text: wordsOf(it.body, images), at: it.createdAt, ...(images.length ? { images: images.map((i) => ({ name: i.name })) } : {}), followUp: it.ref, state: it.state,
    outcome: it.state === "closed" ? it.outcome : null, note: it.state === "closed" ? it.note : null,
    // an unread answer's time is its event's, the exact value the seen cursor is compared with (closed_at is
    // stamped a moment earlier on a live clock, so a cursor capped at it would never pass the answer)
    answeredAt: it.state === "closed" ? (unread.get(it.id) ?? it.closedAt) : null,
    unread: it.state === "closed" && unread.has(it.id),
  };
}

/** orch_resolve's handed_off: the open PR's link, who has it now, and an optional note. */
export interface HandedOffIn {
  pr: string;
  owner: string;
  note?: string | null;
}
export interface HandedOff {
  pr: string;
  owner: string;
  note: string | null;
  at: number;
  thread: string;
}
function handedOffOf(h: HandedOffIn): { pr: string; owner: string; note: string | null } {
  const pr = h.pr.trim();
  if (!/^https:\/\/\S+\/pull\/\d+\/?$/.test(pr)) throw new EngineError("invalid", "handed_off.pr is the open PR's https link (…/pull/<n>)");
  const owner = h.owner.trim();
  if (!owner || owner.length > 40 || /\n/.test(owner)) throw new EngineError("invalid", "handed_off.owner is who has the PR now, one line of at most 40 characters");
  const note = h.note?.trim() || null;
  if (note && note.length > 200) throw new EngineError("invalid", "handed_off.note is at most 200 characters");
  return { pr, owner, note };
}

function parsePoints(points: unknown): { points?: Point[] } {
  if (points === undefined || points === null) return {};
  const r = pointsSchema.safeParse(points);
  if (!r.success) throw new EngineError("invalid", `points: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return { points: r.data };
}

/** A plan's go and thread count: exactly one go option (the recommended one unless another is marked), 1 to 10 threads. */
function planOf(options: Opt[], threads: number): { threads: number; go: string } {
  const gos = options.filter((o) => o.go);
  if (gos.length > 1) throw new EngineError("invalid", "a plan has exactly one go option");
  if (gos.length === 0) options[0]!.go = true;
  if (!Number.isInteger(threads) || threads < 1 || threads > 10) throw new EngineError("invalid", "a plan starts 1 to 10 threads");
  return { threads, go: options.find((o) => o.go)!.id };
}

export interface AskInput {
  title: string;
  question: string;
  context?: string;
  options: { label: string; detail?: string; go?: boolean }[];
  kind?: "question" | "plan";
  /** A plan: how many threads its go lets the lead start (1-10). */
  threads?: number;
  action?: "merge" | null;
  key?: string | null;
  blocks?: Block[];
  /**
   * "Scoping done?": a scoping project's lead proposes the end, with its summary and PROJECT.md. With task: it proposes
   * closing that scoping task, with the file (doc, or projectMd) its findings are in.
   */
  scopingDone?: { summary: string; projectMd?: string; doc?: string; task?: string | null } | null;
  /** A lead's scoping task (its id or an open task's name): the card goes to the owner's Scope pane under it. */
  scopeTask?: string | null;
  /** Revise this open card of the asker's own (its decision id) instead of filing a new one; `why` says what made it stale. */
  revises?: string | null;
  why?: string | null;
  /** The work-board task it is about (core/tasks.ts: an id or an open task's title); else it follows its thread's. A plan card's threads get it. */
  task?: string | null;
}

/** The "Scoping done?" card's options, fixed so the owner's yes can't be misread: option 1 makes the project active. */
export const SCOPING_DONE_OPTIONS = [
  { label: "Yes, scoping is done", detail: "The project becomes active: the normal card flow from now on" },
  { label: "Not yet", detail: "It stays scoping; say in the note what is missing" },
] as const;
/** A scoping task's "Scoping done?": option 1 closes only that task; the rest of the project is unchanged. */
export const SCOPING_TASK_DONE_OPTIONS = [
  { label: "Yes, scoping is done", detail: "The task closes; its cards go the normal way from now on" },
  { label: "Not yet", detail: "The task stays open; say in the note what is missing" },
] as const;
/** The summary's cap: the goal, the constraints and the first plan, as a plan's thread list. */
export const SCOPING_SUMMARY_MAX = 1600;
export const SCOPING_TASK_NAME_MAX = 60;

export interface BoardRow {
  id: string;
  kind: string;
  from: string | null;
  project: string | null;
  title: string;
  body: string;
  ref: string | null;
  at: number;
}


export const OUTPUT_KINDS = ["doc", "video", "image", "report", "link"] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

export interface OutputInput {
  title: string;
  kind: OutputKind;
  path?: string | null;
  url?: string | null;
  note?: string | null;
}
/** The folders a file may resolve into (missing ones are skipped), and the bb host they are on. */
export interface OutputPlace {
  roots: string[];
  hostId: string | null;
  /** each root's own host, when they differ (a project's lead and threads on different machines); else `hostId` */
  hosts?: { path: string; hostId: string | null }[];
}

/**
 * The host of the root that holds `real` (a realpath), the deepest when roots nest: that root's own host, null when it
 * has none, undefined when no root holds it.
 */
export function hostOfPath(real: string, hosts: { path: string; hostId: string | null }[]): string | null | undefined {
  let best: { len: number; hostId: string | null } | null = null;
  for (const h of hosts) {
    let r: string;
    try {
      r = realpathSync(h.path);
    } catch {
      continue;
    }
    if (real.startsWith(r.endsWith(sep) ? r : r + sep) && (!best || r.length > best.len)) best = { len: r.length, hostId: h.hostId };
  }
  return best ? best.hostId : undefined;
}
export interface OutputRow {
  id: string;
  title: string;
  kind: OutputKind;
  path: string | null;
  url: string | null;
  hostId: string | null;
  note: string | null;
  project: string | null;
  author: string;
  threadId: string;
  at: number;
}
interface OutputDbRow {
  id: string;
  title: string;
  kind: string;
  path: string | null;
  url: string | null;
  host_id: string | null;
  note: string | null;
  project: string | null;
  author: string;
  thread_id: string;
  at: number;
}
const toOutput = (r: OutputDbRow): OutputRow => ({
  id: r.id,
  title: r.title,
  kind: r.kind as OutputKind,
  path: r.path,
  url: r.url,
  hostId: r.host_id,
  note: r.note,
  project: r.project,
  author: r.author,
  threadId: r.thread_id,
  at: r.at,
});

/** A recorded file's realpath, or `invalid`: absolute, an existing file, and inside one of `roots` after symlinks. */
/** `whose`: how the error names the first root, for whoever reads it (the agent's own folder, or a project's for the owner). */
export function outputPath(p: string, roots: string[], whose = "your environment folder"): string {
  if (!isAbsolute(p)) throw new EngineError("invalid", `the path must be absolute: ${p}`);
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    throw new EngineError("invalid", `no such file: ${p}`);
  }
  if (!statSync(real).isFile()) throw new EngineError("invalid", `not a file: ${p}`);
  const inside = roots.some((root) => {
    let r: string;
    try {
      r = realpathSync(root);
    } catch {
      return false;
    }
    return real.startsWith(r.endsWith(sep) ? r : r + sep);
  });
  if (!inside) throw new EngineError("invalid", `${p} is outside ${whose} and the shared folders (${roots.join(", ")})`);
  return real;
}

/** An http(s) link as URL writes it, or `invalid` (no javascript:, file: or other schemes on the owner's screen). */
export function outputUrl(u: string): string {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new EngineError("invalid", `not a URL: ${u}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new EngineError("invalid", `only http(s) links, not ${url.protocol}`);
  return url.href;
}


/** A file still at the realpath it was registered with (missing, or swapped for a symlink: no). */
function registered(path: string): boolean {
  try {
    return realpathSync(path) === path;
  } catch {
    return false;
  }
}

export const TEXT_PROOF_MAX = 256 * 1024;
export const PROOF_MAX = 20;
/**
 * What the proof route may serve, by kind and extension. Never HTML or SVG: a file a lead picked must not run script
 * on bb's origin, where the owner's writes live. Text is always served as plain text.
 */
export const PROOF_TYPES: Record<"image" | "video", Record<string, string>> = {
  image: { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif" },
  video: { ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime" },
};
const TEXT_TYPE = "text/plain; charset=utf-8";
/** `at` when it is still the file registered there: its own realpath (not since swapped for a symlink) and a file. */
function stillFile(at: string): string | null {
  try {
    const real = realpathSync(at);
    return real === at && statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

export interface ProofInput {
  kind: ProofKind;
  caption: string;
  path?: string | null;
  url?: string | null;
}
export interface DeliverInput {
  title: string;
  summary: string;
  proof: ProofInput[];
  revises?: string | null;
  blocks?: Block[];
  /** 2-6 decisions and findings, one line each with a short why, drawn before any prose. Absent: the old layout. */
  points?: Point[];
  /** A scoping task (its id or an open task's name): reviewed in the owner's Scope pane under it. */
  scopeTask?: string | null;
  /** A Multiplayer board's review (its board id, resolved by the caller): reviewed on that board, never on Deliverables. */
  board?: { id: string; record?: string; flag?: string } | null;
  /** The work-board task it belongs to (core/tasks.ts: an id or an open task's title); a revision keeps the last one. */
  task?: string | null;
}
interface TaskRow {
  id: string;
  project: string;
  name: string;
  state: string;
  opened_by: string;
  opened_at: number;
  closed_at: number | null;
  summary: string | null;
  doc: string | null;
}
const toTask = (r: TaskRow): ScopingTask => ({ id: r.id, project: r.project, name: r.name, state: r.state as ScopingTaskState, openedBy: r.opened_by, openedAt: r.opened_at, closedAt: r.closed_at, summary: r.summary, doc: r.doc });

/** The folders a proof file may resolve into, each with the bb host it is on (missing folders are skipped). */
export interface DeliverPlace {
  roots: { path: string; hostId: string | null }[];
}

interface DeliverableDbRow {
  id: string;
  json: string;
}

/** A PR wait's own gh reading of a PR no live environment shows (waitPrSeen). */
interface PrReadingRow {
  url: string;
  number: number | null;
  state: string | null;
  attention: string | null;
  checks: string | null;
  sig: string;
  seen_at: number;
  read_at: number;
}

interface WaitRow {
  id: string;
  owner: string;
  ref: string;
  about: string;
  pr_url: string;
  cond: string;
  created_at: number;
  nudged_at: number | null;
  closed_at: number | null;
  outcome: string | null;
  item_id: string | null;
}

const awaitsApproval = (state: string | null, review: string | null) => state === "open" && (review === "review_required" || review === "review_requested");
/** An open PR still missing its approval: GitHub reads it mergeable or BLOCKED as it recomputes, so for the owner both are one word, one notice. */
const approvalWord = (state: string | null, review: string | null, merge: string | null) => (awaitsApproval(state, review) && (merge === "mergeable" || merge === "blocked") ? "needs_approval" : merge);

/**
 * One PR reading's facts as the engine keeps them, for bb's readings and a PR wait's gh reading alike, so "ready" has
 * one rule. `prevMerge`: the last known mergeability (undefined: none). GitHub reads mergeable UNKNOWN while it
 * recomputes after any push to the base: an unknown mergeability keeps the last known one.
 */
function prFacts(pr: Extract<PrResult, { outcome: "available" }>["pullRequest"], prevMerge: string | null | undefined) {
  const checks = pr.checks?.state ?? null;
  const attention = pr.attention ?? null;
  // an injected reading or an older bb has no mergeability or review: its attention stands in for both
  const raw = pr.mergeability ? pr.mergeability.mergeable : undefined;
  const review = pr.mergeability || pr.review ? (pr.review?.state ?? null) : null;
  // a kept "needs_approval" whose approval has come since says nothing: unknown, never a guess at ready
  const kept = prevMerge === "needs_approval" && !awaitsApproval(pr.state, review) ? "unknown" : (prevMerge ?? "unknown");
  const merge = approvalWord(pr.state, review, !pr.mergeability ? attention : raw && raw !== "UNKNOWN" ? (pr.mergeability.state ?? null) : kept);
  const queued = pr.inMergeQueue === true;
  const sig = ["v2", pr.url, pr.state, checks ?? "", review ?? "", merge ?? "", queued ? "queued" : ""].join("|");
  // ready to merge, by bb's own order, from the signature's fields (bb's attention says "none" mid-recompute)
  const ready = merge === "ready_to_merge" || (pr.state === "open" && merge === "mergeable" && checks === "passing" && !queued && !["changes_requested", "review_requested", "review_required"].includes(review ?? ""));
  // what the lanes and deliverables show: as the notice says it, not bb's word of the moment
  const shown = merge === "conflicts" && pr.state === "open" ? "conflicts" : ready ? "ready_to_merge" : attention;
  return { checks, review, merge, queued, sig, ready, shown };
}

/** How long a card waits off Needs you behind an earlier one from the same asker and project, at most (batching). */
export const HOLD_MS = 10 * 60_000;
/** How long an answered card's key stays taken: asking it again means the answer wasn't acted on. */
export const KEY_REUSE_MS = 24 * 3_600_000;

export const OFFER_DAYS = 14;

/**
 * The rule an offer suggests: who asked (a thread's number widened to its project), the words every card's title and
 * question share, the key stem they share, and the words every chosen option shares. It errs narrow: all shared words.
 */
export function suggestMatch(cards: Decision[]): RuleMatch {
  const widen = (a: string) => (/^thread:[^:]+:\d+$/.test(a) ? a.replace(/:\d+$/, ":*") : a);
  const from = [...new Set(cards.flatMap((c) => [widen(c.orchestrator.origin), widen(c.orchestrator.asker)]))].sort();
  const common = (lists: string[][]) => (lists.length ? [...new Set(lists[0])].filter((w) => lists.every((l) => l.includes(w))) : []);
  const heads = cards.map((c) => words(`${c.request.title} ${c.request.question}`));
  const chosen = cards.map((c) => words((c.request.options.find((o) => o.id === ownerPick(c))?.label ?? "").replace(/\(recommended\)/gi, "")));
  const stems = cards.map((c) => (c.request_key ? c.request_key.replace(/([-_:.]*\d+)+$/, "") : null));
  const keyPrefix = stems[0] && stems.every((k) => k === stems[0]) ? stems[0] : null;
  return { from, words: common(heads).slice(0, 6), without: [], key_prefix: keyPrefix, option: common(chosen).filter((w) => !["now", "yes", "go", "ok"].includes(w)) };
}

/** A rule's match as the CoS gave it: the fields it may set, words lowercased, and enough to be narrow. */
export function checkMatch(raw: unknown): RuleMatch {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown, what: string) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim() || x.length > 60)) throw new EngineError("invalid", `rule.${what} is a list of words`);
    return (v as string[]).map((x) => x.trim().toLowerCase());
  };
  const m: RuleMatch = { from: list(o.from, "from"), words: list(o.words, "words"), without: list(o.without, "without"), key_prefix: typeof o.key_prefix === "string" && o.key_prefix.trim() ? o.key_prefix.trim() : null, option: list(o.option, "option") };
  if (!m.from.length) throw new EngineError("invalid", "rule.from names whose cards it covers (addresses; thread:<project>:* for a project's threads)");
  if (!m.option.length) throw new EngineError("invalid", "rule.option names the words of the option it answers with: the cards' answers share none, so narrow the rule to cards that do");
  if (!m.words.length && !m.key_prefix) throw new EngineError("invalid", "rule.words (or rule.key_prefix) says what the cards are about: a rule on every card from an asker is too wide");
  return m;
}

export class Engine {
  private _settings: Settings;
  private packLines: Record<string, PackLine> | null = null;
  readonly batch: BatchInbox;
  private inflight = new Set<string>();
  /** The connection's write count at the last flush's change notice (changedSinceFlush); -1: none yet. */
  private flushWrites = -1;
  /** When bb first answered "no such thread" for an agent's thread, by thread id (threadNotFound). A reload starts over. */
  private notFoundAt = new Map<string, number>();

  private db: Db;
  private ports: Ports;

  constructor(db: Db, ports: Ports, settings: Partial<Settings> = {}) {
    this.db = db;
    this.ports = ports;
    this._settings = { ...DEFAULT_SETTINGS, ...settings };
    this.usePackLines(this.pack?.lines ?? null);
    migrate(db);
    this.batch = new BatchInbox(db, () => this.now(), (id) => {
      const it = this.item(id);
      return it ? this.renderInDigest(it) : null;
    });
    if (this.settings.batchInbox) this.batch.sync();
    // the Pokémon families: it must never stop the plugin from starting (its transaction rolls back on a failure). A
    // pack that failed its checks moves nothing: a typo in it is not its removal.
    if (!this.packBroken) this.settleLogged();
    this.settleRelayedCards();
    // the project page's history: once, from what the older tables say. It must never stop the plugin from starting.
    try {
      if (backfillEvents(this.db, this.now())) this.ports.log("events: backfilled the project history log");
    } catch (e) {
      this.ports.log(`events: backfill failed, the log starts empty: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private event(e: Omit<EventIn, "at"> & { at?: number }): void {
    logEvent(this.db, { ...e, at: e.at ?? this.now() });
  }

  private get owner(): OwnerWords {
    return ownerWords(this.settings.owner);
  }

  /**
   * Settle every live agent's Pokémon: no two live agents share a line (baseOf). Projects oldest first: each keeps its
   * type unless an older live project holds it, else picks one (pickType). Leads and threads keep their Pokémon when it
   * still fits their project's family and no older live agent holds it; the rest get the next free one (pickMon). A
   * moved agent keeps its stage (a StagePin at its current level); XP stays with its address.
   * With the pokemon setting on and a pack, threads settle by their trainers' tiers (threadTiers), tier by tier across
   * every project: a thread already on one of its lines keeps it, then the rest, oldest first, take its first free line,
   * never another live trainer's signature nor the CoS's or the Steward's line. A line goes to the thread that ranks it
   * higher. A thread moved in a tier keeps its level and shows the new line's form at it (no StagePin). A thread past
   * every tier keeps a free line it has, else takes the last resort (pickThread).
   * Idempotent: a second run moves nothing. Returns how many agents moved.
   */
  settleMons(): number {
    const pack = this.pack;
    const people = this.leadsArePeople;
    return tx(this.db, () => {
      const projects = this.db.prepare(`SELECT slug, mon_type FROM projects WHERE archived_at IS NULL ORDER BY created_at, slug`).all() as { slug: string; mon_type: string | null }[];
      const types: string[] = [];
      for (const p of projects) {
        const t = p.mon_type && typeFamily(p.mon_type) && !types.includes(p.mon_type) ? p.mon_type : pickType(p.slug, types);
        if (t !== p.mon_type) this.db.prepare(`UPDATE projects SET mon_type = ? WHERE slug = ?`).run(t, p.slug);
        types.push(t);
      }
      const rows = this.db
        .prepare(`SELECT thread_id, address, role, project, mon, mon_stage, mon_stage_level FROM agents WHERE retired_at IS NULL ORDER BY CASE role WHEN 'cos' THEN 0 WHEN 'steward' THEN 1 WHEN 'lead' THEN 2 ELSE 3 END, created_at, thread_id`)
        .all() as { thread_id: string; address: string; role: Role; project: string | null; mon: string | null; mon_stage: number | null; mon_stage_level: number | null }[];
      // with a pack a lead is a person: its Pokémon is kept, unseen and unmoved, and no longer holds its line
      if (pack) rows.splice(0, rows.length, ...rows.filter((r) => r.role !== "lead"));
      // first every rightful holder keeps its Pokémon, then only the rest are re-picked, so no one else's changes.
      // `held` is by line (baseOf): the Steward's Chansey holds Happiny's line
      const held: string[] = [];
      // the Pokémon a misfit gets: a thread's by its trainer's lines (pickThread), any other's by its pool (pickMon); it
      // keeps its stage (a StagePin at its level)
      let moved = 0;
      const repick = (r: (typeof rows)[number]) => {
        const next = (pack && r.role === "thread" ? this.pickThread(held, r.project, true) : pickMon(r.role, held, this.projectType(r.project))).name;
        held.push(baseOf(next));
        if (next === r.mon) return;
        const { level } = this.xpOf(r.address);
        const pin = r.mon_stage != null && r.mon_stage_level != null ? { stage: r.mon_stage, level: r.mon_stage_level } : null;
        // a line no longer known (a pack's, after the pack went before this process started) has no stages to read: its
        // pin, if it had one, is kept; else the new line shows its own stage at the level
        const known = !!monByName(r.mon);
        const stage = known ? shownStage(r.mon, level, pin) : (pin?.stage ?? null);
        this.db.prepare(`UPDATE agents SET mon = ?, mon_stage = ?, mon_stage_level = ? WHERE thread_id = ?`).run(next, stage, known ? level : (pin?.level ?? null), r.thread_id);
        moved++;
      };
      // with people, threads settle by their trainers' tiers below; first the CoS and the Steward, whose lines no thread takes
      const threads = people ? rows.filter((r) => r.role === "thread") : [];
      const misfits = rows.filter((r) => {
        if (people && r.role === "thread") return false;
        if (!this.monFits(r.role, r.mon, r.project, held)) return true;
        held.push(baseOf(r.mon!));
        return false;
      });
      for (const r of misfits) repick(r);
      if (people) {
        // nothing is held until claimed in this run
        const assigned = this.personaAssignments();
        const tiers = new Map<string | null, string[][]>();
        const tiersOf = (project: string | null) => tiers.get(project) ?? tiers.set(project, this.threadTiers(project, assigned).tiers).get(project)!;
        const claimed = new Map<string, string>();
        const free = (n: string) => !held.includes(baseOf(n));
        const claim = (r: (typeof rows)[number], line: string) => {
          claimed.set(r.thread_id, line);
          held.push(baseOf(line));
        };
        for (let k = 0; k < 3; k++) { // the roster, the specialty, the fits
          for (const r of threads) if (!claimed.has(r.thread_id) && r.mon && free(r.mon) && tiersOf(r.project)[k]!.some((n) => baseOf(n) === baseOf(r.mon!))) claim(r, r.mon);
          for (const r of threads) {
            if (claimed.has(r.thread_id)) continue;
            const line = tiersOf(r.project)[k]!.find(free);
            if (line) claim(r, line);
          }
        }
        for (const [threadId, line] of claimed) {
          if (rows.find((r) => r.thread_id === threadId)!.mon === line) continue;
          // a tier move keeps the level and shows the new line's form at it (no StagePin)
          this.db.prepare(`UPDATE agents SET mon = ?, mon_stage = NULL, mon_stage_level = NULL WHERE thread_id = ?`).run(line, threadId);
          moved++;
        }
        // the last resort (rare): a thread keeps a line no one claimed, else it gets the next free one
        const rest = threads.filter((r) => !claimed.has(r.thread_id));
        const keep = rest.filter((r) => this.monFits(r.role, r.mon, r.project, held) && !!held.push(baseOf(r.mon!)));
        for (const r of rest) if (!keep.includes(r)) repick(r);
      }
      return moved;
    });
  }

  /** Whether an agent's Pokémon may stay, given the lines older live agents hold (settleMons: `held` is by baseOf). */
  private monFits(role: Role, mon: string | null, project: string | null, held: readonly string[]): boolean {
    if (!mon || held.includes(baseOf(mon)) || !(builtInMon(mon) || this.pack?.lines?.[mon])) return false;
    if (role === "cos" || role === "steward") return MON_POOLS[role].some((x) => x.name === mon);
    const fam = typeFamily(this.projectType(project));
    if (!fam) return false;
    // with a pack, a thread keeps any Pokémon it can show that no older agent holds; its roster lines are settleMons's
    if (this.pack && role === "thread") return true;
    if (role === "lead") return mon === fam.lead || (held.includes(fam.lead) && MON_POOLS.lead.some((x) => x.name === mon));
    const own = familyThreads(fam);
    return own.includes(mon) || (own.every((n) => held.includes(n)) && MON_POOLS.thread.some((x) => x.name === mon));
  }

  private projectType(project: string | null): MonType | null {
    if (!project) return null;
    return ((this.db.prepare(`SELECT mon_type FROM projects WHERE slug = ?`).get(project) as { mon_type: string | null } | undefined)?.mon_type as MonType | null) ?? null;
  }

  /**
   * A project's Pokémon type: its own, unless another live project holds it, else the one pickType gives. `assign` stores
   * it (only on a project that has a row).
   */
  typeFor(project: string | null, assign = true): MonType | null {
    if (!project) return null;
    const own = this.projectType(project);
    const taken = (this.db.prepare(`SELECT mon_type FROM projects WHERE archived_at IS NULL AND slug != ? AND mon_type IS NOT NULL`).all(project) as { mon_type: string }[]).map((r) => r.mon_type);
    if (own && !taken.includes(own)) return own;
    const t = pickType(project, taken);
    if (assign) this.db.prepare(`UPDATE projects SET mon_type = ? WHERE slug = ?`).run(t, project);
    return t;
  }

  /** A project's accent type for the screens (app/accent.ts): its Pokémon type, none with the pokemon setting off. */
  accentType(project: string | null): MonType | null {
    return this.settings.pokemon && project ? (this.project(project)?.monType ?? null) : null;
  }

  /** An agent's form at a level: its line's, or the stage it keeps (StagePin). */
  formOf(a: Agent, level: number): Mon | null {
    return formAt(a.mon, level, a.monPin);
  }


  get settings(): Settings {
    return this._settings;
  }
  /**
   * New settings. A changed pack registers its lines and settles the Pokémon once, with the old pack's lines still
   * readable so a thread that moves off one keeps its stage. So does turning the pokemon setting on with a pack loaded.
   * A pack that failed its checks changes nothing until it is fixed or unset.
   */
  set settings(next: Settings) {
    const before = this._settings.personas ?? null;
    const wasPeople = this.leadsArePeople;
    this._settings = next;
    if (this.packBroken || ((next.personas ?? null) === before && (wasPeople || !this.leadsArePeople))) return;
    const lines = this.pack?.lines ?? null;
    this.usePackLines({ ...(this.packLines ?? {}), ...(lines ?? {}) });
    this.settleLogged();
    this.usePackLines(lines);
    this.ports.changed();
  }

  private settleLogged(): void {
    try {
      const moved = this.settleMons();
      if (moved) this.ports.log(`pokemon: ${moved} agent(s) moved to their project's type`);
    } catch (e) {
      this.ports.log(`pokemon: settling failed, Pokémon unchanged: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private usePackLines(lines: Record<string, PackLine> | null): void {
    this.packLines = lines;
    setPackLines(lines);
  }

  /** The loaded pack (null: none, or one that failed its checks). */
  get pack(): PersonaPack | null {
    return packOf(this._settings.personas);
  }

  private get packBroken(): boolean {
    const x = this._settings.personas;
    return !!x && "error" in x;
  }

  /** Leads are people: the pokemon setting is on and a pack is loaded. Their Pokémon is hidden then. */
  private get leadsArePeople(): boolean {
    return this.settings.pokemon && !!this.pack;
  }

  private toAgent(r: AgentRow): Agent {
    const a = toAgent(r, this.settings.pokemon);
    return this.leadsArePeople && a.role === "lead" ? { ...a, mon: null, monPin: null } : a;
  }

  /**
   * Each live lead's persona id, by project (personas.ts assignPersonas), leads in the order they started, so a lead
   * that starts later never takes an earlier one's persona. `also`: a lead about to start (the brief's prediction).
   */
  personaAssignments(also: string | null = null): Map<string, string> {
    const pack = this.pack;
    if (!pack) return new Map();
    const leads = (this.db.prepare(`SELECT project FROM agents WHERE role = 'lead' AND retired_at IS NULL AND status != 'archived' ORDER BY created_at, thread_id`).all() as { project: string }[])
      .filter((r) => r.project !== also)
      .map((r) => ({ project: r.project, type: this.projectType(r.project) }));
    if (also) leads.push({ project: also, type: this.typeFor(also, false) });
    return assignPersonas(pack, leads);
  }

  /** A thread's Pokémon while a pack is loaded: its trainer's lines first, never another live trainer's signature line. */
  private pickThread(taken: readonly string[], project: string | null, assign: boolean): Mon {
    const type = this.typeFor(project, assign);
    const { tiers, skip } = this.threadTiers(project);
    return pickPackThread(taken, type, tiers.flat(), skip);
  }

  /**
   * A project's threads' lines while a pack is loaded (pickThread, settleMons), in tiers: its lead's
   * persona's roster (signature first), then the lines of its specialty type (mons.ts specialtyLines; none for a persona
   * with no type), then its good fits. Each line once, in its first tier, by line. `skip`: every other live trainer's
   * signature (roster[0]) unless it is this one's too, left out of every tier. The last resort (the project's family,
   * then any free line) is pickPackThread's.
   */
  private threadTiers(project: string | null, assigned: Map<string, string> = this.personaAssignments()): { tiers: string[][]; skip: string[] } {
    const pack = this.pack;
    if (!pack) return { tiers: [[], [], []], skip: [] };
    const persona = project ? pack.personas[assigned.get(project) ?? ""] : undefined;
    const roster = persona?.roster ?? [];
    const skip = [...assigned].filter(([p]) => p !== project).map(([, x]) => pack.personas[x]?.roster?.[0]).filter((n): n is string => !!n && n !== roster[0]);
    const seen = new Set<string>();
    const tier = (names: readonly string[]) => names.filter((n) => !!monByName(n) && !skip.includes(n) && !seen.has(baseOf(n)) && !!seen.add(baseOf(n)));
    return { tiers: [tier(roster), tier(specialtyLines(persona?.type)), tier(persona?.fits ?? [])], skip };
  }

  /**
   * What the screens show for an agent with a persona: the CoS's and the Steward's (with their Pokémon as partner) and
   * each live lead's. Null for threads, and whenever the pokemon setting is off or no pack is loaded.
   */
  personaOf(a: Agent, assigned: Map<string, string> | null = null): AgentPersona | null {
    const pack = this.leadsArePeople ? this.pack : null;
    if (!pack) return null;
    const id = a.role === "cos" || a.role === "steward" ? pack.roles?.[a.role] : a.role === "lead" && a.project && a.status !== "archived" ? (assigned ?? this.personaAssignments()).get(a.project) : undefined;
    const p = id ? pack.personas[id] : undefined;
    if (!p) return null;
    return agentPersona(p, a.role === "lead" ? null : (this.formOf(a, this.xpOf(a.address).level)?.name ?? a.mon));
  }

  /**
   * An agent's look for the screens that don't read the agents RPC (the board's agents, the deliverable cards):
   * its persona (personaOf), and its Pokémon's National Dex number, which the browser's mons.ts doesn't know for a pack's
   * line. Both null with the setting off, as `mon` is.
   */
  faceOf(a: Agent, assigned: Map<string, string> | null = null): { dex: number | null; persona: AgentPersona | null } {
    return { dex: monByName(a.mon)?.dex ?? null, persona: this.personaOf(a, assigned) };
  }

  /** The persona registerStarted's agent will have, for its brief (null: none; see personaOf). */
  personaForStart(role: Role, project: string | null): AgentPersona | null {
    const pack = this.leadsArePeople ? this.pack : null;
    if (!pack || role === "thread") return null;
    const id = role === "lead" ? (project ? this.personaAssignments(project).get(project) : undefined) : pack.roles?.[role];
    const p = id ? pack.personas[id] : undefined;
    return p ? agentPersona(p, role === "lead" ? null : this.monForStart(role, null)) : null;
  }

  private now() {
    return this.ports.now();
  }


  agentByThread(threadId: string): Agent | null {
    const r = this.db.prepare(`SELECT * FROM agents WHERE thread_id = ? AND retired_at IS NULL`).get(threadId) as AgentRow | undefined;
    return r ? this.toAgent(r) : null;
  }

  /** A thread's agent, retired ones too (the newest role it had). */
  agentByThreadEver(threadId: string): Agent | null {
    const r = this.db.prepare(`SELECT * FROM agents WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1`).get(threadId) as AgentRow | undefined;
    return r ? this.toAgent(r) : null;
  }

  agentByAddress(address: string): Agent | null {
    const r = this.db.prepare(`SELECT * FROM agents WHERE address = ? AND retired_at IS NULL`).get(address) as AgentRow | undefined;
    return r ? this.toAgent(r) : null;
  }

  agents(): Agent[] {
    return (this.db.prepare(`SELECT * FROM agents WHERE retired_at IS NULL ORDER BY created_at`).all() as AgentRow[]).map((r) => this.toAgent(r));
  }

  /**
   * Give a thread a role. Leads and threads need a project; one CoS, one Steward and one lead per project. `startedBy`:
   * who pressed Start (registerStarted), kept on the spawn event.
   */
  register(threadId: string, role: Role, project: string | null, parentThreadId: string | null = null, startedBy: StartedBy | null = null): Agent {
    if (!ROLES.includes(role)) throw new EngineError("invalid", `unknown role ${role}`);
    if (project !== null && !PROJECT_RE.test(project)) throw new EngineError("invalid", `bad project slug ${project}`);
    return tx(this.db, () => {
      const existing = this.agentByThread(threadId);
      if (existing) {
        if (existing.role === role && existing.project === (role === "cos" || role === "steward" ? null : project)) return existing;
        throw new EngineError("conflict", `thread ${threadId} is already ${existing.address}`);
      }
      const proj = role === "cos" || role === "steward" ? null : project;
      // the next number is one past the highest ever given in the project, retired ones included (items and history
      // name them), read before this thread's own retired row goes; thread_numbers keeps that highest when its row is gone.
      let n: number | undefined;
      if (role === "thread") {
        const prefix = `thread:${proj}:`;
        const m = this.db
          .prepare(`SELECT MAX(CAST(substr(address, ?) AS INTEGER)) AS m FROM agents WHERE role = 'thread' AND project = ? AND substr(address, 1, ?) = ?`)
          .get(prefix.length + 1, proj, prefix.length, prefix) as { m: number | null };
        const last = this.db.prepare(`SELECT last FROM thread_numbers WHERE project = ?`).get(proj) as { last: number } | undefined;
        n = Math.max(m.m ?? 0, last?.last ?? 0) + 1;
        this.db.prepare(`INSERT INTO thread_numbers (project, last) VALUES (?, ?) ON CONFLICT (project) DO UPDATE SET last = excluded.last`).run(proj, n);
      }
      // a retired thread may take a new role; its old address stays retired (items keep naming it)
      this.db.prepare(`DELETE FROM agents WHERE thread_id = ? AND retired_at IS NOT NULL`).run(threadId);
      const address = addressFor(role, proj, n);
      if (this.agentByAddress(address)) throw new EngineError("conflict", `${address} is already taken`);
      if (role === "lead") this.ensureProject(proj!, null); // its type is picked before its Pokémon
      this.db
        .prepare(`INSERT INTO agents (thread_id, address, role, project, parent_thread_id, status, created_at, mon) VALUES (?, ?, ?, ?, ?, 'unknown', ?, ?)`)
        .run(threadId, address, role, proj, parentThreadId, this.now(), this.nextMon(role, null, proj));
      this.event({ kind: "spawn", project: proj, address, threadId, value: role, ref: parentThreadId, note: startedBy ? `started by ${startedBy}` : null });
      if (role === "lead") {
        this.ensureProject(proj!, null);
        // the owner's direct messages the last lead never acked pass to this one, dead ones too (a new reader)
        const passed = this.db.prepare(`SELECT id FROM items WHERE recipient = ? AND kind = 'owner.message' AND state IN ('queued','delivered','dead')`).all(address) as { id: string }[];
        this.db.prepare(`UPDATE items SET state = 'pending', queued_message_id = NULL, delivered_at = NULL, attempts = 0, on_board = 0 WHERE recipient = ? AND kind = 'owner.message' AND state IN ('queued','delivered','dead')`).run(address);
        for (const { id } of passed) this.batch.reroute(id, address); // batched: unread again for the new reader, even if the last lead read it in a digest
        if (this.project(proj!)?.archivedAt) {
          this.db.prepare(`UPDATE projects SET archived_at = NULL WHERE slug = ?`).run(proj);
          this.boardAdd("notice", startedBy ?? "person", proj, `${proj} brought back`, `${address} started.`, threadId);
        }
      }
      this.ports.changed();
      return this.agentByThread(threadId)!;
    });
  }

  /** Validate before touching bb, and again when committing the adoption. */
  checkAdoption(p: { threadId: string; role: Role; project: string | null; parentThreadId: string | null; approval: string }): void {
    if (!p.approval.trim() || p.approval.length > 1000) throw new EngineError("invalid", "adoption needs an approval reference (1–1000 characters)");
    if (!ROLES.includes(p.role)) throw new EngineError("invalid", "unknown adoption role");
    if (p.role === "lead" || p.role === "thread") {
      if (!p.project || !PROJECT_RE.test(p.project)) throw new EngineError("invalid", "adoption needs a valid project");
      if (this.project(p.project)?.heldAt || this.project(p.project)?.archivedAt) throw new EngineError("bad_state", "cannot adopt into a held or archived project");
    } else if (p.project !== null) throw new EngineError("invalid", "standing roles have no project");
    if (p.role === "cos") {
      if (p.parentThreadId !== null) throw new EngineError("invalid", "cos has no parent");
    } else {
      const parent = p.parentThreadId ? this.agentByThread(p.parentThreadId) : null;
      const expected = p.role === "thread" ? `lead:${p.project}` : "cos";
      if (!parent || parent.address !== expected || parent.status === "archived" || parent.threadId === p.threadId) throw new EngineError("invalid", `adoption parent must be the live ${expected}`);
    }
    const old = this.agentByThread(p.threadId);
    if (old && (old.role !== p.role || old.project !== p.project || (old.parentThreadId !== null && old.parentThreadId !== p.parentThreadId))) throw new EngineError("conflict", "adoption conflicts with existing role, project or parent");
    if (!old && p.role !== "thread" && this.agentByAddress(addressFor(p.role, p.project))) throw new EngineError("conflict", "role is occupied; adoption cannot take it over");
    if (!old && this.db.prepare(`SELECT thread_id FROM agents WHERE thread_id = ?`).get(p.threadId)) throw new EngineError("conflict", "cannot adopt a retired role holder");
  }

  adopt(p: { threadId: string; role: Role; project: string | null; parentThreadId: string | null; approval: string }, environmentId: string | null, bbProjectId: string): Agent {
    return tx(this.db, () => {
      this.checkAdoption(p);
      const previous = this.agentByThread(p.threadId);
      const a = this.register(p.threadId, p.role, p.project, p.parentThreadId);
      this.db.prepare(`UPDATE agents SET parent_thread_id = ? WHERE thread_id = ?`).run(p.parentThreadId, p.threadId);
      this.setEnvironment(p.threadId, environmentId);
      this.setStatus(p.threadId, "idle");
      if (p.role === "lead") this.ensureProject(p.project!, bbProjectId);
      if (p.role === "thread") this.recordManual(p.threadId);
      if (!previous || previous.parentThreadId !== p.parentThreadId) this.boardAdd("notice", "person", p.project, `Adopted ${a.address}`, `Existing thread ${p.threadId}; parent ${p.parentThreadId ?? "none"}; approval: ${p.approval}`, p.threadId);
      return this.agentByThread(p.threadId)!;
    });
  }

  /** An address's XP (tokens processed) and level. */
  xpOf(address: string): { tokens: number; level: number } {
    const r = this.db.prepare(`SELECT tokens FROM xp WHERE address = ?`).get(address) as { tokens: number } | undefined;
    const tokens = r?.tokens ?? 0;
    return { tokens, level: levelFor(tokens) };
  }

  /** The last token-usage event counted for a thread (0: none yet). */
  xpCursor(threadId: string): number {
    return (this.db.prepare(`SELECT seq FROM xp_cursor WHERE thread_id = ?`).get(threadId) as { seq: number } | undefined)?.seq ?? 0;
  }

  /**
   * Count a thread's new turns: add their tokens to its address's XP and move the cursor. A level-up that reaches an
   * evolution posts once to Activity ("Caterpie evolved into Metapod"). Returns the new level.
   */
  gainXp(threadId: string, tokens: number, seq: number): number {
    const a = this.agentByThread(threadId);
    if (!a) return 0;
    return tx(this.db, () => {
      if (seq <= this.xpCursor(threadId)) return this.xpOf(a.address).level;
      const before = this.xpOf(a.address);
      this.db
        .prepare(`INSERT INTO xp (address, tokens, updated_at) VALUES (?, ?, ?) ON CONFLICT(address) DO UPDATE SET tokens = tokens + excluded.tokens, updated_at = excluded.updated_at`)
        .run(a.address, Math.max(0, Math.round(tokens)), this.now());
      this.db.prepare(`INSERT INTO xp_cursor (thread_id, seq) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET seq = excluded.seq`).run(threadId, seq);
      const after = this.xpOf(a.address);
      const was = this.formOf(a, before.level);
      const now = this.formOf(a, after.level);
      if (was && now && was.name !== now.name)
        this.boardAdd("notice", a.address, a.project, `${was.name} evolved into ${now.name}!`, `${a.address} reached level ${after.level}.`, threadId);
      if (after.level !== before.level) this.ports.changed();
      return after.level;
    });
  }

  /**
   * The Pokémon the next agent of this role gets (mons.ts pickMon): no live agent of any role holds its line, and a lead's or
   * thread's fits its project's type. Picked with the setting off too, so switching it on shows one. `assign` false
   * only predicts it (the brief, before the thread exists): the project's type is not stored then.
   */
  nextMon(role: Role, exceptThreadId: string | null = null, project: string | null = null, assign = true): string {
    const rows = this.db.prepare(`SELECT mon, role FROM agents WHERE retired_at IS NULL AND mon IS NOT NULL AND thread_id IS NOT ?`).all(exceptThreadId) as { mon: string; role: string }[];
    // with a pack, a thread draws from its trainer's lines first, and the leads' (unseen) Pokémon hold nothing
    if (this.pack && role === "thread") return this.pickThread(rows.filter((r) => r.role !== "lead").map((r) => r.mon), project, assign).name;
    const taken = rows.map((r) => r.mon);
    return pickMon(role, taken, role === "lead" || role === "thread" ? this.typeFor(project, assign) : null).name;
  }


  /** The agent at an address that still counts: not retired, and its thread not archived. */
  liveAt(address: string): Agent | null {
    const a = this.agentByAddress(address);
    return a && a.status !== "archived" ? a : null;
  }

  /** Before the owner starts a lead, the CoS or the Steward: refused while one is live, or a lead's project is on hold. */
  checkStart(role: Role, project: string | null): string {
    if (role === "thread") throw new EngineError("invalid", "threads start from a lead's plan card, not from here");
    if (role === "lead") {
      if (!project || !PROJECT_RE.test(project)) throw new EngineError("invalid", `bad project slug ${project ?? ""}`);
      if (this.project(project)?.heldAt) throw new EngineError("bad_state", `${project} is on hold: resume it first`);
    }
    const address = addressFor(role, role === "lead" ? project : null);
    const live = this.liveAt(address);
    if (live) throw new EngineError("conflict", `${address} is already running (${live.status}, thread ${live.threadId})`);
    return address;
  }

  /**
   * The Pokémon registerStarted will give, for the brief: an archived holder of the address doesn't count, as it is
   * retired then. Null with the pokemon setting off.
   */
  monForStart(role: Role, project: string | null): string | null {
    if (!this.settings.pokemon || (role === "lead" && this.pack)) return null; // with a pack, a lead is a person

    const old = this.agentByAddress(addressFor(role, role === "lead" ? project : null));
    return this.nextMon(role, old?.status === "archived" ? old.threadId : null, project, false);
  }

  /**
   * Register a thread the owner (or the CoS, for a lead) just started. An archived holder of the address is retired in
   * the same step. Who started it goes on the spawn event.
   */
  registerStarted(threadId: string, role: Role, project: string | null, by: StartedBy = "person"): Agent {
    return tx(this.db, () => {
      const old = this.agentByAddress(addressFor(role, role === "lead" ? project : null));
      if (old && old.status === "archived") this.retire(old.threadId, true); // the new holder takes over the address and its mail
      return this.register(threadId, role, project, null, by);
    });
  }

  /** The board notice for a started agent: "Started <address>" from the owner, "cos started <address>" from the CoS. */
  startedNotice(a: Agent, by: StartedBy, body: string, threadId: string): void {
    this.boardAdd("notice", by, a.project, by === "cos" ? `cos started ${a.address}` : `Started ${a.address}`, body, threadId);
  }

  /** Retire a thread's role. Its unacked mail becomes dead letters (the CoS resends them), never the next holder's mail. */
  retire(threadId: string, keepMail = false, at = this.now()): void {
    const a = this.agentByThread(threadId);
    this.db.prepare(`UPDATE agents SET retired_at = ? WHERE thread_id = ? AND retired_at IS NULL`).run(at, threadId);
    if (a) this.event({ at, kind: "retire", project: a.project, address: a.address, threadId });
    if (a) this.batch.handoff(a.address); // its wake can't wake the next holder, and a dead or queued one would block that holder's wakes
    if (!keepMail) this.deadLetterOrphans();
    this.ports.changed();
  }

  /**
   * Mail no live agent can take is a dead letter: else it would wait forever, or reach whoever takes the address next.
   * A stopped agent still holds its address, so its mail waits for it; a new agent under an old address takes the mail.
   * This covers every address with no live agent, delivered mail too, in both modes. Mail to a retired holder dies at
   * once. An address with no agent row at all may just not be registered yet (a new project's lead, the first CoS), so
   * its mail waits UNHELD_GRACE_MS for one, its wake with it, and is a dead letter only after that. (A thread that takes
   * a new role drops its retired row: that address waits too.)
   * The owner's direct message to a lead is the exception: it is to the project's lead, whoever that is, so it waits
   * for the next one (register re-sends it). So is the engine's own "orchestrator" address: a dream card's answer goes
   * there and the card's ack closes it (orchestratorAck). Nothing reads that inbox, so its unread is dropped instead.
   */
  private deadLetterOrphans(): void {
    const rows = this.db
      .prepare(
        `SELECT i.*, EXISTS (SELECT 1 FROM agents r WHERE r.address = i.recipient) AS retired FROM items i
         WHERE i.state IN ('pending','delivered') AND i.kind <> 'owner.message' AND i.recipient <> 'orchestrator'
           AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.address = i.recipient AND a.retired_at IS NULL)
           AND (EXISTS (SELECT 1 FROM agents r WHERE r.address = i.recipient) OR i.created_at <= ?)`,
      )
      .all(this.now() - UNHELD_GRACE_MS) as (ItemRow & { retired: number })[];
    for (const r of rows) this.dead(toItem(r), `${r.recipient} has no live agent (${r.retired ? "its holder retired" : `no agent took that address within ${ago(UNHELD_GRACE_MS)}`})`);
    this.batch.droppedFor("orchestrator"); // batched: no wake waits on it; flush clears the wake
  }

  /**
   * A thread's runtime state. "stopped" (set by the orchestrator's stop) sticks until the thread runs again. A worker
   * thread bb archived is retired at once. `gone`: bb no longer has the thread at all (threadNotFound), which is retired
   * the same way.
   */
  setStatus(threadId: string, status: string, gone = false): void {
    const cur = this.agentByThread(threadId);
    if (!cur) return;
    if (cur.status === "stopped" && status !== "active" && status !== "archived") return;
    // idle since it went idle: the startup reconcile re-reports every agent's status, and a repeat isn't a new idle
    const idle = status === "idle" ? (cur.status === "idle" && cur.idleAt !== null ? cur.idleAt : this.now()) : null;
    this.db.prepare(`UPDATE agents SET status = ?, idle_at = ?, last_idle_at = COALESCE(?, last_idle_at) WHERE thread_id = ?`).run(status, idle, idle, threadId);
    // a change only: the startup reconcile re-reports every agent's status
    if (cur.status !== status) this.event({ kind: "status", project: cur.project, address: cur.address, threadId, value: status });
    // live or not (liveAt): the feed's reply line and an archived lead's persona go by it, not by every status flip
    if ((cur.status === "archived") !== (status === "archived")) this.ports.changed([LIVE]);
    if (status === "archived" && cur.role === "thread") {
      tx(this.db, () => {
        this.retire(threadId);
        // an "archived" row: the thread is gone already, so the Board offers no Archive button for it
        this.boardAdd("archived", "orchestrator", cur.project, `${cur.address} retired: ${gone ? "bb no longer has its thread" : "its thread was archived in bb"}`, "Its role is retired; mail still waiting for it is a dead letter.", threadId);
      });
    }
  }

  /**
   * bb answered "no such thread" for an agent's thread; bb sends no archive event for it. The first answer is only noted.
   * Another at least GONE_CONFIRM_MS later retires it as an archived thread is (setStatus). Returns whether it was
   * retired. Only bb's clear not-found comes here (core/gone.ts): a failed lookup is no answer, and a found thread
   * clears the note (threadFound).
   */
  threadNotFound(threadId: string): boolean {
    if (!this.agentByThread(threadId)) return false;
    const first = this.notFoundAt.get(threadId);
    if (first === undefined) {
      this.notFoundAt.set(threadId, this.now());
      return false;
    }
    if (this.now() - first < GONE_CONFIRM_MS) return false;
    this.notFoundAt.delete(threadId);
    this.setStatus(threadId, "archived", true);
    return true;
  }

  /** bb has the thread after all: an earlier not-found no longer counts. */
  threadFound(threadId: string): void {
    this.notFoundAt.delete(threadId);
  }

  /** Who supervises an address: a thread's lead, a lead's CoS. */
  supervisorOf(a: Agent): string | null {
    if (a.role === "thread") return `lead:${a.project}`;
    if (a.role === "lead" || a.role === "steward") return "cos";
    return null;
  }

  /**
   * Whether bb itself already tells the supervisor about this outcome: the supervisor is the thread's bb parent and
   * the thread's parentNotifications covers it ("auto": every outcome; "stuck": failures only). Then a notice from
   * us would make the lead spend a second turn on the same news.
   */
  bbTellsSupervisor(a: Agent, bbParentId: string | null, mode: string | undefined, outcome: "turn" | "failure"): boolean {
    const sup = this.supervisorOf(a);
    const supAgent = sup ? this.agentByAddress(sup) : null;
    if (!supAgent || !bbParentId || supAgent.threadId !== bbParentId) return false;
    return mode === "auto" || (mode === "stuck" && outcome === "failure");
  }

  /** The route table. Returns the extra recipients that get a read-only copy. */
  route(from: Agent, to: string): { copies: string[] } {
    const target = this.agentByAddress(to);
    if (!target) throw new EngineError("not_found", `no agent at ${to}`);
    if (target.address === from.address) throw new EngineError("invalid", "that is you");
    switch (from.role) {
      case "thread":
        if (to !== `lead:${from.project}`) throw new EngineError("forbidden", `a thread may message only its lead (lead:${from.project})`);
        return { copies: [] };
      case "lead":
        if (target.role === "lead") return { copies: ["cos"] };
        if (target.role === "thread" && target.project !== from.project) throw new EngineError("forbidden", "a lead may message only its own threads");
        return { copies: [] };
      case "cos":
        if (target.role === "thread") throw new EngineError("forbidden", "the CoS messages leads, not their threads");
        return { copies: [] };
      case "steward":
        if (target.role === "thread") throw new EngineError("forbidden", "the Steward messages the CoS and leads");
        return { copies: [] };
    }
  }


  /** External labels are provenance, never an internal sender or an owner approval. */
  importMail(raw: ExternalMail): Item {
    const mail = externalMailSchema.parse(raw);
    const json = JSON.stringify(mail);
    return tx(this.db, () => {
      const old = this.db.prepare(`SELECT item_id, json FROM external_mail WHERE source = ? AND external_id = ?`).get(mail.source, mail.id) as { item_id: string; json: string } | undefined;
      if (old) {
        if (old.json !== json) throw new EngineError("conflict", "external id was already imported with different content");
        return this.item(old.item_id)!;
      }
      if (!this.agentByAddress(mail.to)) throw new EngineError("not_found", `no agent at ${mail.to}`);
      const quiet = mail.severity === "INFO" && !mail.needsReply;
      const key = `external:${createHash("sha256").update(`${mail.source}\0${mail.id}`).digest("hex")}`;
      const body = externalBody(mail);
      const item = this.put({ recipient: mail.to, sender: `external:${mail.source}`, kind: "notice", body, key, needsAck: !quiet || mail.dueAt !== null });
      // batched, the import's own policy decides its wake: INFO without needsReply waits for its deadline, or for good
      if (this.settings.batchInbox) this.batch.policy(item.id, { severity: mail.severity === "INFO" ? "INFO" : "ACTION", needsReply: mail.needsReply, dueAt: mail.dueAt });
      this.db.prepare(`INSERT INTO external_mail (source, external_id, item_id, json, quiet, due_at) VALUES (?, ?, ?, ?, ?, ?)`).run(mail.source, mail.id, item.id, json, quiet ? 1 : 0, mail.dueAt);
      this.ports.changed();
      return item;
    });
  }

  /** An imported item whose source/recipient route is off: its delivery and retries wait (the batched wake too). */
  private importPaused(itemId: string): boolean {
    const x = this.db.prepare(`SELECT source, json FROM external_mail WHERE item_id = ?`).get(itemId) as { source: string; json: string } | undefined;
    if (!x) return false;
    const to = this.item(itemId)?.recipient ?? (JSON.parse(x.json) as ExternalMail).to;
    return this.ports.externalEnabled?.(x.source, to) === false;
  }

  /** Stable import sequence for pagination. Rescan from zero to refresh mutable receipt states. */
  externalReceipts(source: string, after = 0, limit = 100) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new EngineError("invalid", "receipt page needs after >= 0 and limit 1–100");
    const rows = this.db.prepare(`SELECT seq, external_id, item_id FROM external_mail WHERE source = ? AND seq > ? ORDER BY seq LIMIT ?`).all(source, after, limit) as { seq: number; external_id: string; item_id: string }[];
    return rows.map((r) => {
      const it = this.item(r.item_id)!;
      // readAt: the recipient's digest ack (batched inbox only); wake: the recipient's wake that covers it, while unread
      const { readAt, wake } = this.batch.receipt(it.id);
      return { sequence: r.seq, externalId: r.external_id, itemId: it.id, state: it.state, queuedMessageId: it.queuedMessageId, paused: this.ports.externalEnabled?.(source, it.recipient) === false, deliveredAt: it.deliveredAt, outcome: it.outcome, note: it.note, readAt, wake };
    });
  }

  private item(id: string): Item | null {
    const r = this.db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as ItemRow | undefined;
    return r ? toItem(r) : null;
  }

  /** Write an item. With a key, writing it again returns the first one (a safe resend). `about: OWN_POST` keys it to itself. */
  private put(p: { recipient: string; sender: string; kind: ItemKind; ref?: string | null; body: string; key?: string | null; needsAck: boolean; about?: string | null }): Item {
    if (p.key) {
      const r = this.db.prepare(`SELECT * FROM items WHERE sender = ? AND send_key = ?`).get(p.sender, p.key) as ItemRow | undefined;
      if (r) return toItem(r);
    }
    const id = `i-${hex(6)}`;
    this.db
      .prepare(
        `INSERT INTO items (id, recipient, sender, kind, ref, body, send_key, needs_ack, state, attempts, created_at, about) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(id, p.recipient, p.sender, p.kind, p.ref ?? null, p.body, p.key ?? null, p.needsAck ? 1 : 0, this.now(), p.about === OWN_POST ? `msg:${id}` : (p.about ?? null));
    const item = this.item(id)!;
    if (this.settings.batchInbox) this.batch.record(item);
    return item;
  }

  private closeItems(where: string, params: unknown[], outcome: string | null, note: string | null): void {
    this.db
      .prepare(`UPDATE items SET state = 'closed', closed_at = ?, outcome = ?, note = ? WHERE state IN ('pending','queued','delivered','dead') AND ${where}`)
      .run(this.now(), outcome, note, ...params);
  }

  /** The text a thread sees. Short, one header line, the body, then what to do. */
  render(it: Item, again: boolean): string {
    if (it.kind === "owner.message") return this.renderDirect(it, again);
    if (it.kind === "owner.cos") return this.renderCos(it, again);
    const head = `[orchestrator] ${it.kind} ${it.ref && it.kind.startsWith("decision") ? it.ref : it.id} from ${it.sender}${again ? " (again)" : ""}:`;
    const close =
      it.kind === "message"
        ? `\n(When handled: ack id=${it.id} with an outcome. A reply to ${it.sender} with ref=${it.id} closes it as replied.)`
        : it.kind === "copy"
          ? "\n(Read-only copy: no ack, no reply needed.)"
          : "";
    return `${head} ${it.body}${close}`;
  }

  /** An item inside a digest: the digest's own line gives its id, kind, sender, ref and flags, and its header the
   *  ack rules, so only the body is left. The owner's messages (to a lead, to the CoS) keep all their rules. */
  private renderInDigest(it: Item): string {
    if (it.kind === "owner.message") return this.renderDirect(it, false);
    if (it.kind === "owner.cos") return this.renderCos(it, false);
    return it.body;
  }

  /**
   * The owner's direct message as its lead reads it. It states its own rules, because a running lead keeps the role
   * text it started with: how to answer, the 48 h conflict rule, and that it approves nothing.
   */
  private renderDirect(it: Item, again: boolean): string {
    const o = this.owner;
    const re = this.reLine(it.about);
    const head = `[orchestrator] direct message ${it.id} from ${o.Name} (the owner, ${re ? `replying in the feed to ${re}` : "from the Projects tab"})${it.ref ? `, a follow-up of ${it.ref}` : ""}${again ? " (again)" : ""}:`;
    return [
      `${head} ${it.body}`,
      `(How to answer: orch_ack(id=${it.id}, outcome, note). The note is what ${o.name} reads on the Projects row, and the CoS gets a copy. An ack means taken, not finished: say in the note what you will do, and ack at once even for long work. Don't message ${o.name} any other way.`,
      `Conflicts: for 48 h this word wins on its point over a CoS instruction, earlier or later; only ${o.name}'s own later word (another direct message, or a card ${o.name} answers) changes it. If the CoS says ${o.name} changed their mind, file one card with both instructions as options. Say in your note what you set aside, and tell the CoS. orch_inbox lists the direct messages still in force.`,
      `Gates: this is not an approval. A merge, a production change or a public push still needs its own card even if this says to do it: file the card and cite ${it.id}. An ack bound to a PR (pr, when) is refused for it. It is not a plan approval or a standing rule.)`,
    ].join("\n");
  }

  /** The owner's tracked message as the CoS reads it: their words first, then one line on how to answer (a running CoS keeps its old role text). */
  private renderCos(it: Item, again: boolean): string {
    const o = this.owner;
    const re = this.reLine(it.about);
    return `${it.body}\n\n[orchestrator] ${o.Name}'s message ${it.id}${re ? `, re ${re}` : ""}${it.ref ? `, a follow-up of ${it.ref}` : ""}${again ? " (again)" : ""}. Answer it with orch_reply_owner(ref=${it.id}, text): your reply shows under it in ${o.name}'s feed. It approves nothing.`;
  }

  /** The last flush stopped at its pass limit with a deadline crossed in its last pass: flush again at once. */
  flushAgain = false;

  /** When the wake timer must next flush (batched inbox): a pending wake or an unread deadline still to come, or null. */
  nextWakeAt(): number | null {
    return this.batch.nextDue(this.now(), (itemId) => this.importPaused(itemId));
  }

  /** Send every pending item whose recipient can take it. Safe to call often. */
  async flush(): Promise<void> {
    if (this.settings.batchInbox) {
      const paused = (itemId: string) => this.importPaused(itemId);
      const pass = () => this.batch.flush({
        debounceMs: this.settings.inboxDebounceMs,
        retryMs: this.settings.resendMs,
        gapMs: this.settings.inboxGapMs ?? 0,
        agent: (address) => this.agentByAddress(address),
        held: (a) => !!(a.project && this.project(a.project)?.heldAt),
        deliver: (a, text, token, bare) => this.ports.deliver(a.threadId, text, { id: `wake:${token}`, sender: "orchestrator", recipient: a.address, kind: "notice", body: bare } as Item),
        log: (text) => this.ports.log(text),
        dead: (recipient, _token, note) => this.wakeDead(recipient, note),
        paused,
      });
      // A pass waits on each delivery; a deadline or a wake that came due meanwhile was judged with the time from before
      // it, and the wake timer leaves out what is already due. So pass again at once while something came due, up to five
      // passes. If the fifth had something come due too, flushAgain says so, and the server runs another flush at once from
      // its wake timer, after yielding.
      // Cleared first: a pass that throws must not leave it set, or the server's 0 ms timer would retry in a hot loop.
      this.flushAgain = false;
      let crossed = false;
      for (let i = 0, since = this.now(); i < 5; i++) {
        await pass();
        const now = this.now();
        crossed = this.batch.cameDue(since, now, paused);
        if (!crossed) break;
        since = now;
      }
      this.flushAgain = crossed;
      this.changedSinceFlush();
      return;
    }
    const rows = (this.db.prepare(`SELECT * FROM items WHERE state = 'pending' ORDER BY created_at`).all() as ItemRow[]).map(toItem);
    for (const it of rows) {
      if (this.inflight.has(it.id)) continue;
      const external = this.db.prepare(`SELECT source, quiet, due_at FROM external_mail WHERE item_id = ?`).get(it.id) as { source: string; quiet: number; due_at: number | null } | undefined;
      if (external && this.ports.externalEnabled?.(external.source, it.recipient) === false) continue;
      if (external?.quiet && (external.due_at === null || external.due_at > this.now())) continue;
      const to = this.agentByAddress(it.recipient);
      if (!to) continue;
      if (to.project && this.project(to.project)?.heldAt) continue; // a project on hold holds its mail
      this.inflight.add(it.id);
      try {
        const res = await this.ports.deliver(to.threadId, this.render(it, it.attempts > 0), it);
        const t = this.now();
        if (res.delivery === "sent") {
          this.db.prepare(`UPDATE items SET state = 'delivered', delivered_at = ?, attempts = attempts + 1 WHERE id = ? AND state = 'pending'`).run(t, it.id);
        } else if (res.delivery === "queued") {
          this.db
            .prepare(`UPDATE items SET state = 'queued', queued_message_id = ?, attempts = attempts + 1 WHERE id = ? AND state = 'pending'`)
            .run(res.queuedMessageId, it.id);
        }
        // held: stays pending until the thread starts again
        this.closeUnacked(it.id);
      } catch (e) {
        this.ports.log(`deliver ${it.id} to ${it.recipient} failed: ${String(e)}`);
      } finally {
        this.inflight.delete(it.id);
      }
    }
    this.changedSinceFlush();
  }

  /**
   * The change notice a flush gives, only when the database changed since the last flush's: flush runs on every tool
   * call, every turn start and end and every clock pass, and each notice makes every open page re-read its RPCs. Any
   * write on this connection counts, whoever made it: a status flip, a tool's write, the flush's own wake rows.
   */
  private changedSinceFlush(): void {
    const n = (this.db.prepare(`SELECT total_changes() AS n`).get() as { n: number }).n;
    if (n === this.flushWrites) return;
    this.flushWrites = n;
    this.ports.changed();
  }

  /** A newer message from the same sender to the same recipient that was delivered or closed: its id, else null. */
  private newerMail(it: Item): string | null {
    const r = this.db
      .prepare(`SELECT id FROM items WHERE recipient = ? AND sender = ? AND kind = 'message' AND id != ? AND created_at > ? AND state IN ('delivered','closed') ORDER BY created_at DESC LIMIT 1`)
      .get(it.recipient, it.sender, it.id, it.createdAt) as { id: string } | undefined;
    return r?.id ?? null;
  }

  /** Items nobody acks are closed once delivered. */
  private closeUnacked(id: string) {
    this.db.prepare(`UPDATE items SET state = 'closed', closed_at = ? WHERE id = ? AND needs_ack = 0 AND state = 'delivered'`).run(this.now(), id);
  }

  /** bb dispatched a queued row: the item it carried is delivered. */
  dispatched(queuedMessageId: string): void {
    this.batch.dispatched(queuedMessageId);
    const r = this.db.prepare(`SELECT id FROM items WHERE queued_message_id = ? AND state = 'queued'`).get(queuedMessageId) as { id: string } | undefined;
    if (!r) return;
    this.db.prepare(`UPDATE items SET state = 'delivered', delivered_at = ? WHERE id = ?`).run(this.now(), r.id);
    this.closeUnacked(r.id);
    this.ports.changed();
  }

  /** The user removed a queued row before it went: it isn't delivered, so it becomes a dead letter. */
  cancelled(queuedMessageId: string): void {
    const wake = this.batch.cancelled(queuedMessageId);
    if (wake) this.wakeDead(wake.recipient, wake.note);
    const r = this.db.prepare(`SELECT * FROM items WHERE queued_message_id = ? AND state = 'queued'`).get(queuedMessageId) as ItemRow | undefined;
    if (r) this.dead(toItem(r), "its queued message was removed before it was sent");
  }

  /** Queued rows whose message is gone (dispatched while we were not loaded) count as delivered. */
  reconcileQueued(stillQueued: (it: Item) => boolean | null): void {
    const rows = (this.db.prepare(`SELECT * FROM items WHERE state = 'queued'`).all() as ItemRow[]).map(toItem);
    for (const it of rows) {
      const q = stillQueued(it);
      if (q === false && !this.db.prepare(`SELECT 1 FROM external_mail WHERE item_id = ?`).get(it.id)) this.dispatched(it.queuedMessageId!);
    }
  }

  queuedItems(): Item[] {
    return (this.db.prepare(`SELECT * FROM items WHERE state = 'queued'`).all() as ItemRow[]).map(toItem);
  }

  /**
   * A dead letter goes to the CoS's dead letters, not the owner's board: the CoS resends, re-routes, closes
   * or escalates it (orch_dead_letters), and the hourly wake tells it about new ones. The supervisor still hears.
   */
  private dead(it: Item, why: string): void {
    tx(this.db, () => {
      const seq = (this.db.prepare(`SELECT COALESCE(MAX(dead_seq), 0) + 1 AS n FROM items`).get() as { n: number }).n;
      this.db.prepare(`UPDATE items SET state = 'dead', note = ?, dead_seq = ?, dead_at = ?, on_board = 0 WHERE id = ?`).run(why, seq, this.now(), it.id);
      this.batch.dropped(it.id);
      const to = this.agentByAddress(it.recipient);
      const sup = to ? this.supervisorOf(to) : null;
      if (sup && this.agentByAddress(sup)) {
        this.put({ recipient: sup, sender: "orchestrator", kind: "notice", ref: it.id, body: `${it.recipient} never acked ${it.kind} ${it.ref ?? it.id} from ${it.sender} (${why}). It is a dead letter; the CoS handles it.`, needsAck: false });
      }
    });
    this.ports.changed();
  }

  /**
   * A recipient's inbox wake died: its unread mail waits and nothing else will wake it, so the CoS is told (an
   * actionable notice, which wakes the CoS) to retry it once the recipient can take it. When the dead wake is the CoS's
   * own, or there is no CoS, the owner's board gets it instead.
   */
  private wakeDead(recipient: string, note: string): void {
    const body = `${recipient}'s inbox wake is dead (${note}). Its unread mail is kept, but nothing will wake ${recipient} for it. Check the thread, then retry with orch_inbox(retry_wake=${JSON.stringify(recipient)}).`;
    if (recipient !== "cos" && this.agentByAddress("cos")) {
      const it = this.put({ recipient: "cos", sender: "orchestrator", kind: "notice", body, needsAck: false });
      this.batch.policy(it.id, { severity: "ACTION" });
    } else this.boardAdd("notice", "orchestrator", null, `Inbox wake dead for ${recipient}`, body, null);
    this.ports.changed();
  }

  /** The owner resends a dead letter from the board, or the CoS from its dead letters (no board row then). */
  resend(itemId: string, by = "person"): Item {
    const it = this.mustDead(itemId);
    // any address with no live agent, not only a retired one: the sweep would make it a dead letter again
    if (!this.agentByAddress(it.recipient))
      throw new EngineError("bad_state", `${it.recipient} has no live agent: give the address a role first${by === "person" ? "" : ", or re-route it"}`);
    this.db.prepare(`UPDATE items SET state = 'pending', attempts = 1, queued_message_id = NULL, delivered_at = NULL WHERE id = ?`).run(itemId);
    this.batch.reroute(itemId, it.recipient); // batched: unread again, as a new arrival
    if (by === "person") this.boardAdd("notice", "person", null, `Resent ${itemId} to ${it.recipient}`, "", itemId);
    this.ports.changed();
    return this.item(itemId)!;
  }

  private mustDead(itemId: string): Item {
    const it = this.item(itemId);
    if (!it) throw new EngineError("not_found", `no item ${itemId}`);
    if (it.state !== "dead") throw new EngineError("bad_state", `${itemId} is ${it.state}, not a dead letter`);
    return it;
  }


  private cosOnly(by: Agent): void {
    if (by.role !== "cos") throw new EngineError("forbidden", "only the CoS manages dead letters");
  }

  deadLettersText(by: Agent): { text: string; count: number } {
    this.cosOnly(by);
    const t = this.now();
    const rows = (this.db.prepare(`SELECT * FROM items WHERE state = 'dead' ORDER BY COALESCE(dead_seq, 0), created_at`).all() as ItemRow[]).map(toItem);
    const lines = [rows.length ? `Dead letters (${rows.length}):` : "No dead letters."];
    for (const it of rows) lines.push(this.deadLine(it, t));
    if (rows.length) lines.push("Act on each with orch_dead_letters(action=resend|reroute|close|escalate, id, …).");
    return { text: lines.join("\n"), count: rows.length };
  }

  private deadLine(it: Item, t: number): string {
    const age = it.deadAt !== null ? `died ${ago(t - it.deadAt)} ago` : `sent ${ago(t - it.createdAt)} ago`;
    return `- ${it.id} ${it.kind}${it.ref ? ` (${it.ref})` : ""} ${it.sender} → ${it.recipient}, ${age}: ${it.note ?? "?"}${it.onBoard ? ` [on ${this.owner.name}'s board]` : ""}. ${this.importPreview(it.id, 160) ?? JSON.stringify(it.body.replace(/\s+/g, " ").slice(0, 160))}`;
  }

  /** An imported item's one-line preview (labelled, from what was imported, whatever its body became), else null. */
  private importPreview(id: string, max: number): string | null {
    const external = this.db.prepare(`SELECT json FROM external_mail WHERE item_id = ?`).get(id) as { json: string } | undefined;
    return external ? externalPreview(JSON.parse(external.json) as ExternalMail, max) : null;
  }

  /** The CoS sends a dead letter to another live address. Its sender and id stay, so an ack (and its note) still reach the sender. */
  reroute(by: Agent, itemId: string, to: string, note: string | null): Item {
    this.cosOnly(by);
    return tx(this.db, () => {
      const it = this.mustDead(itemId);
      const target = this.agentByAddress(to);
      if (!target) throw new EngineError("not_found", `no live agent at ${to}`);
      if (to === it.recipient) throw new EngineError("invalid", `${itemId} is already to ${to}: resend it instead`);
      // a decision's items name the decision (d-…), which only its asker acks; a deliverable's belong to its lead
      if (it.kind.startsWith("decision.") || it.kind.startsWith("deliverable."))
        throw new EngineError("invalid", `${itemId} is a ${it.kind}: only ${it.recipient} can act on it, so resend, close or escalate it`);
      // the owner writes to a project's lead only: never to a thread or another project's lead
      if (it.kind === "owner.message") throw new EngineError("forbidden", `${itemId} is ${this.owner.name}'s direct message to ${it.recipient}: it can't be re-routed. Resend it, or escalate it to ${this.owner.name}'s board`);
      const why = note?.trim() ? `: ${note.trim().slice(0, 300)}` : "";
      this.db
        .prepare(`UPDATE items SET recipient = ?, body = ?, state = 'pending', attempts = 0, queued_message_id = NULL, delivered_at = NULL, on_board = 0, note = ? WHERE id = ?`)
        .run(to, `(re-routed by the CoS from ${it.recipient}${why}) ${it.body}`, `re-routed from ${it.recipient} by ${by.address}`, itemId);
      this.batch.reroute(itemId, to);
      this.ports.changed();
      return this.item(itemId)!;
    });
  }

  /** The CoS closes a dead letter on its recipient's behalf. The sender hears the outcome. */
  closeDead(by: Agent, itemId: string, outcome: Outcome, note: string | null): Item {
    this.cosOnly(by);
    if (!OUTCOMES.includes(outcome)) throw new EngineError("invalid", `outcome is one of ${OUTCOMES.join(", ")}`);
    return tx(this.db, () => {
      const it = this.mustDead(itemId);
      // only its lead answers a direct message: the CoS closing it would put words in the lead's mouth
      if (it.kind === "owner.message") throw new EngineError("forbidden", `${itemId} is ${this.owner.name}'s direct message to ${it.recipient}: only that lead closes it. Resend it, or escalate it to ${this.owner.name}'s board`);
      const words = note?.trim() ? note.trim().slice(0, 2000) : null;
      this.closeItems(`id = ?`, [itemId], outcome, `closed by ${by.address} for ${it.recipient}${words ? `: ${words}` : ""} (it died: ${it.note ?? "?"})`);
      if (it.sender !== by.address && this.agentByAddress(it.sender))
        this.put({
          recipient: it.sender,
          sender: by.address,
          kind: "notice",
          ref: it.id,
          body: `${it.recipient} never took your ${it.kind} ${it.id} (${it.note ?? "a dead letter"}); ${by.address} closed it for them: ${outcome}${words ? `, note: ${JSON.stringify(words)}` : ""}.`,
          key: `acknote:dead:${it.id}`,
          needsAck: false,
        });
      this.ports.changed();
      return this.item(itemId)!;
    });
  }

  /** The CoS puts a dead letter on the owner's board with its note: the only way a new one reaches the board. */
  escalateDead(by: Agent, itemId: string, note: string): Item {
    this.cosOnly(by);
    const words = oneLine(note ?? "", 500, "note");
    return tx(this.db, () => {
      const it = this.mustDead(itemId);
      if (it.onBoard) throw new EngineError("bad_state", `${itemId} is already on ${this.owner.name}'s board`);
      this.db.prepare(`UPDATE items SET on_board = 1, note = ? WHERE id = ?`).run(`CoS: ${words} (it died: ${it.note ?? "?"})`, itemId);
      const project = this.agentByAddress(it.recipient)?.project ?? this.agentByAddress(it.sender)?.project ?? null;
      this.boardAdd("dead", by.address, project, `Dead letter to ${it.recipient}, escalated by the CoS`, `${words}\n${it.kind} ${it.id} from ${it.sender}: ${it.note ?? "?"}. ${it.body}`, it.id);
      return this.item(itemId)!;
    });
  }

  private cursor(name: string): number | null {
    return (this.db.prepare(`SELECT value FROM cursors WHERE name = ?`).get(name) as { value: number } | undefined)?.value ?? null;
  }

  private setCursor(name: string, value: number): void {
    this.db.prepare(`INSERT INTO cursors (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value`).run(name, value);
  }

  /**
   * The dead-letter wake (from tick): at most once per DLQ_WAKE_MS, one info item to the CoS listing the
   * dead letters new since the last wake, only when there are some. Without a live CoS the cursor stays, so the next
   * CoS hears them. Returns the item it sent, if any.
   */
  dlqWake(): Item | null {
    const t = this.now();
    const checked = this.cursor("dlq.checked_at");
    if (checked !== null && t - checked < DLQ_WAKE_MS) return null;
    return tx(this.db, () => {
      this.setCursor("dlq.checked_at", t);
      if (!this.agentByAddress("cos")) return null;
      const seen = this.cursor("dlq.seq") ?? 0;
      const rows = (this.db.prepare(`SELECT * FROM items WHERE state = 'dead' AND on_board = 0 AND dead_seq > ? ORDER BY dead_seq`).all(seen) as ItemRow[]);
      if (!rows.length) return null;
      const last = rows.at(-1)!.dead_seq!;
      const shown = rows.slice(0, 20).map((r) => this.deadLine(toItem(r), t));
      const more = rows.length > shown.length ? [`…and ${rows.length - shown.length} more (orch_dead_letters lists them all).`] : [];
      const it = this.put({
        recipient: "cos",
        sender: "orchestrator",
        kind: "notice",
        ref: null,
        body: `${rows.length} new dead letter${rows.length === 1 ? "" : "s"} since the last check:\n${[...shown, ...more].join("\n")}\nFor each: orch_dead_letters(action=resend | reroute (to) | close (outcome) | escalate (note, puts it on ${this.owner.name}'s board)).`,
        key: `dlq-wake:${last}`,
        needsAck: false,
      });
      this.setCursor("dlq.seq", last);
      this.ports.changed();
      return it;
    });
  }


  send(from: Agent, to: string, text: string, key: string | null, ref: string | null = null, policy: MailPolicy = {}): Item {
    const body = text.trim();
    if (!body) throw new EngineError("invalid", "empty message");
    if (body.length > 4000) throw new EngineError("invalid", "a message is at most 4000 characters");
    const { copies } = this.route(from, to);
    return tx(this.db, () => {
      const retry = key ? this.db.prepare(`SELECT 1 FROM items WHERE sender = ? AND send_key = ?`).get(from.address, key) : null;
      const it = this.put({ recipient: to, sender: from.address, kind: "message", ref, body, key, needsAck: true });
      if (!retry && this.settings.batchInbox) this.batch.policy(it.id, policy);
      if (!retry) this.replyCloses(from, to, ref, it); // a keyed retry is the old reply, not a new answer

      const d = ref?.startsWith("d-") ? this.decision(ref) : null;
      if (d && this.relaySettles(d, from.address, to)) this.settleByRelay(d, it, this.now());
      for (const c of copies) {
        if (!this.agentByAddress(c)) continue;
        this.put({ recipient: c, sender: from.address, kind: "copy", ref: it.id, body: `(copy of ${it.id} to ${to}) ${body}`, key: key ? `copy:${c}:${key}` : `copy:${c}:${it.id}`, needsAck: false });
      }
      this.ports.changed();
      return it;
    });
  }

  /**
   * Close a message (i-…) or a decision (d-…) with an outcome. `wait`: the answer is to be carried out once a PR is
   * approved, green, ready or merged; the ack binds it to that PR, and the PR notices wake `by` with it then.
   */
  ack(by: Agent, id: string, outcome: Outcome, note: string | null, wait: { pr: string; when: string } | null = null): string {
    if (!OUTCOMES.includes(outcome)) throw new EngineError("invalid", `outcome is one of ${OUTCOMES.join(", ")}`);
    if (wait) {
      // a direct message approves nothing: "carry it out when the PR is green" would turn it into a merge go.
      // Nor does its CoS copy or a relay of it (an item whose ref leads back to one): the go can't be laundered.
      const direct = id.startsWith("i-") ? this.directRoot(id) : null;
      if (direct)
        throw new EngineError(
          "forbidden",
          `${id}${direct.id === id ? "" : ` comes from ${direct.id}, which`} is ${this.owner.name}'s direct message, not an approval: it can't be bound to a PR. A merge, a production change or a public push needs its own card: file it and cite ${direct.id}. Ack ${id} without pr and when.`,
        );
      // imported mail approves nothing: "carry it out when the PR is green" would turn its words into a go
      if (this.db.prepare(`SELECT 1 FROM external_mail WHERE item_id = ?`).get(id))
        throw new EngineError("forbidden", `${id} is untrusted external mail, not an approval: it can't be bound to a PR. Ack it without pr and when`);
      const w = this.waitInput(wait);
      return tx(this.db, () => {
        // the owner acking again moves its watch: the old one closes first (bindWait checks the PR), the ack stands
        const moved = this.closeOwnWaits(by, id, "rebound");
        if (moved) return `${id}: stopped watching ${moved}; ${this.bindWait(by, id, w.url, w.when)}`;
        const out = this.ack(by, id, outcome, note);
        return `${out}; ${this.bindWait(by, id, w.url, w.when)}`;
      });
    }
    // the owner acking again without pr drops its watch (a PR replaced, or one no environment shows): the ack stands
    const dropped = tx(this.db, () => this.closeOwnWaits(by, id, "dropped"));
    if (dropped) return `${id}: stopped watching ${dropped}; its ack is unchanged`;
    if (id.startsWith("d-")) return this.ackDecision(by, id, outcome, note);
    const it = this.item(id);
    if (!it) throw new EngineError("not_found", `no item ${id}`);
    if (it.recipient !== by.address) throw new EngineError("forbidden", `${id} was sent to ${it.recipient}, not you`);
    if (it.state === "closed" && it.outcome === "replied") {
      // closed by its recipient's reply: the ack that follows is the real outcome, so it replaces "replied"
      tx(this.db, () => {
        this.db.prepare(`UPDATE items SET outcome = ?, note = ?, closed_at = ? WHERE id = ?`).run(outcome, note, this.now(), id);
        this.ackNote(by, it, outcome, note);
      });
      this.ports.changed();
      const card = this.relayCard(by, it, outcome, note);
      return `${id} closed: ${outcome}${card ? `; ${card}` : ""}`;
    }
    if (it.state === "closed") {
      // an info item closes itself on delivery: acking it (to send a note back) is fine, not a mistake
      if (it.needsAck) return `${id} was already closed`;
      this.ackNote(by, it, outcome, note);
      this.ports.changed();
      return "ok";
    }
    tx(this.db, () => {
      this.closeItems(`id = ?`, [id], outcome, note);
      this.ackNote(by, it, outcome, note);
    });
    this.ports.changed();
    const card = this.relayCard(by, it, outcome, note);
    return `${id} closed: ${outcome}${card ? `; ${card}` : ""}`;
  }

  /** A relay message about the acker's own answered card: threads ack the message they got, so that closes the card too. */
  private relayCard(by: Agent, it: Item, outcome: Closed, note: string | null): string | null {
    const d = it.kind === "message" && it.ref?.startsWith("d-") ? this.decision(it.ref) : null;
    const open = d && (d.state === "answered" || (d.state === "acked" && d.ack?.outcome === "replied"));
    if (d && open && d.orchestrator.asker === by.address && d.relay?.items.includes(`${by.address}/${it.id}`)) return this.ackDecision(by, d.id, outcome, note);
    return null;
  }

  /**
   * A reply counts as the ack. Mail from `from` to `to` closes the one message `to` sent `from` that it answers, as
   * "replied" (answered, not done), with the reply as its note:
   * - ref=<that message's id>: always;
   * - no ref: only when it is the only message from `to` that `from` hasn't closed, it arrived since `from` last went
   *   idle (this is the same turn), and this is `from`'s first mail to `to` since. Its note says so, for audits.
   * The sender gets the reply itself, so no ack note goes back.
   */
  private replyCloses(from: Agent, to: string, ref: string | null, reply: { id: string; body: string }): Item | null {
    const open = (r: ItemRow | undefined) => !!r && r.kind === "message" && r.needs_ack === 1 && r.recipient === from.address && r.sender === to && ["pending", "queued", "delivered", "dead"].includes(r.state);
    let it: Item | null = null;
    let how: string;
    if (ref?.startsWith("i-")) {
      const r = this.db.prepare(`SELECT * FROM items WHERE id = ?`).get(ref) as ItemRow | undefined;
      if (!open(r)) return null;
      it = toItem(r!);
      how = `replied in ${reply.id}`;
    } else if (!ref) {
      // batched, no message is delivered into a turn, so "the same turn" can't be told: only a ref closes
      if (this.settings.batchInbox) return null;
      const rows = this.db.prepare(`SELECT * FROM items WHERE recipient = ? AND sender = ? AND kind = 'message' AND needs_ack = 1 AND state IN ('pending','queued','delivered','dead')`).all(from.address, to) as ItemRow[];
      const only = rows.length === 1 ? rows[0]! : null;
      const me = this.db.prepare(`SELECT status, last_idle_at FROM agents WHERE address = ? AND retired_at IS NULL`).get(from.address) as { status: string; last_idle_at: number | null } | undefined;
      if (!only || only.state !== "delivered" || only.delivered_at === null || !me) return null;
      if (me.status !== "active" || (me.last_idle_at !== null && me.last_idle_at > only.delivered_at)) return null;
      const earlier = this.db
        .prepare(`SELECT 1 FROM items WHERE sender = ? AND recipient = ? AND kind IN ('message','notice') AND id != ? AND created_at >= ? LIMIT 1`)
        .get(from.address, to, reply.id, only.delivered_at);
      if (earlier) return null;
      it = toItem(only);
      how = `same-turn reply ${reply.id} (no ref)`;
    } else return null;
    this.closeItems(`id = ?`, [it.id], "replied", `${how}: ${reply.body.replace(/\s+/g, " ").slice(0, 2000)}`);
    this.relayCard(from, it, "replied", `${how}`);
    return this.item(it.id);
  }

  /**
   * An ack's note goes back to the agent that sent the item, as an info item. A note item itself never sends one back,
   * so two agents can't bounce notes.
   */
  private ackNote(by: Agent, it: Item, outcome: Closed, note: string | null): void {
    if (it.kind === "owner.message") return this.directNote(by, it, outcome, note);
    const words = note?.trim();
    if (!words || it.sendKey?.startsWith("acknote:")) return;
    if (it.sender === by.address || !this.agentByAddress(it.sender)) return; // "person", "orchestrator", a retired sender
    const about = it.body.replace(/\s+/g, " ").slice(0, 80);
    this.put({
      recipient: it.sender,
      sender: by.address,
      kind: "notice",
      ref: it.id,
      body: `${by.address} acked your ${it.kind} ${it.id} (${JSON.stringify(about)}): ${outcome}, note: ${JSON.stringify(words.slice(0, 2000))}`,
      key: `acknote:${it.id}`,
      needsAck: false,
    });
  }

  /**
   * A lead acked the owner's direct message: the note shows on the Projects row (it is the item's own note), the CoS
   * gets a read-only copy, and Activity keeps a row. Never a push: the row's dot is the only signal.
   */
  private directNote(by: Agent, it: Item, outcome: Closed, note: string | null): void {
    const words = note?.trim() ? note.trim().slice(0, 2000) : null;
    const t = this.now();
    const what = `${by.address} acked ${this.owner.name}'s direct message ${it.id}: ${outcome}${words ? `, note: ${JSON.stringify(words)}` : " (no note)"}`;
    if (this.agentByAddress("cos") && by.address !== "cos")
      this.put({ recipient: "cos", sender: by.address, kind: "copy", ref: it.id, body: `(copy) ${what}. ${this.owner.Name} wrote: ${JSON.stringify(it.body.replace(/\s+/g, " ").slice(0, 300))}`, key: `directnote:${it.id}:${t}`, needsAck: false });
    this.boardAdd("direct", by.address, by.project, `${by.address} answered ${this.owner.name}: ${outcome}`, words ?? "", it.id);
    // the lead's answer, as its own record: the unread dot counts these, never a closure by archive or anything else
    this.event({ at: t, kind: "direct-answer", project: it.recipient.slice("lead:".length), address: by.address, threadId: by.threadId, ref: it.id, value: outcome });
  }


  /** The owner's direct message an item is, or comes from through its refs (a copy, a relay, a relay of a relay). */
  private directRoot(id: string): Item | null {
    let it = this.item(id);
    for (let hops = 0; it && hops < 8; hops++) {
      if (it.kind === "owner.message" || it.kind === "owner.cos") return it;
      if (!it.ref?.startsWith("i-")) return null;
      it = this.item(it.ref);
    }
    return null;
  }

  /**
   * The owner writes to a project's lead from its Projects row: an item from "person", needs ack, at most 4000
   * characters. `followUp` names an earlier direct message to the same lead. Refused without a live lead. The CoS gets
   * a read-only copy and Activity keeps a row. Never a push.
   */
  ownerMessage(slug: string, text: string, followUp: string | null = null, images: string[] = [], about: string | null = null, task: string | null = null): Item {
    const words = text.trim();
    if (!words && !images.length) throw new EngineError("invalid", "empty message");
    if (words.length > 4000) throw new EngineError("invalid", `a message is at most 4000 characters; this is ${words.length}`);
    if (images.length > MAX_IMAGES) throw new EngineError("invalid", `a message carries at most ${MAX_IMAGES} images; this has ${images.length}`);
    const p = this.project(slug);
    if (!p) throw new EngineError("not_found", `no project ${slug}`);
    if (p.archivedAt) throw new EngineError("bad_state", `${slug} is archived: start its lead first`);
    const to = `lead:${slug}`;
    if (!this.liveAt(to)) throw new EngineError("bad_state", `${slug} has no live lead: start it first`);
    return tx(this.db, () => {
      const thread = this.conversation(to, "owner.message", followUp, about);
      followUp = thread.followUp;
      if (followUp) {
        const first = this.item(followUp);
        if (!first || first.kind !== "owner.message" || first.recipient !== to) throw new EngineError("invalid", `${followUp} isn't a direct message to ${to}`);
      }
      // its images: each sent for this project and on no message yet; their paths end the body
      const imgs = [...new Set(images)].map((id) => this.directImageRow(id));
      if (imgs.length !== images.length) throw new EngineError("invalid", "an image is named twice");
      for (const i of imgs) if (!i || i.slug !== slug || i.item_id !== null) throw new EngineError("invalid", "an image isn't one sent for this message: attach it again");
      const kept = imgs.map((i) => imageOf(i!));
      // from the work board's card panel: the task it is about, by id, heads the message
      const onTask = task ? this.taskGuard(() => resolveTaskRef(this.db, slug, task)) : null;
      if (onTask && onTask.id !== task) throw new EngineError("invalid", `name the task by its id, not ${JSON.stringify(task)}`);
      const body = `${onTask ? `About task ${onTask.id} ${JSON.stringify(onTask.title)} on the work board:\n` : ""}${withImages(words, kept)}`;
      const it = this.put({ recipient: to, sender: "person", kind: "owner.message", ref: followUp, body, needsAck: true, about: thread.about });
      kept.forEach((i, n) => this.db.prepare(`UPDATE direct_images SET item_id = ?, n = ? WHERE id = ?`).run(it.id, n, i.id));
      const re = this.reLine(it.about);
      if (this.agentByAddress("cos"))
        this.put({ recipient: "cos", sender: "person", kind: "copy", ref: it.id, body: `(copy of ${this.owner.name}'s direct message ${it.id} to ${to}${followUp ? `, a follow-up of ${followUp}` : ""}${re ? `, re ${re}` : ""}; ${to} answers it, not you) ${body}`, key: `copy:cos:${it.id}`, needsAck: false });
      this.boardAdd("direct", "person", slug, `${this.owner.Name} → ${to}${followUp ? ` (follow-up of ${followUp})` : ""}`, body, it.id);
      this.ports.changed();
      return it;
    });
  }

  /** An owner message's conversation: `about` (checked against line `to`), else `followUp`'s post, else its own. */
  private conversation(to: string, kind: "owner.message" | "owner.cos", followUp: string | null, about: string | null): { about: string; followUp: string | null } {
    if (about) {
      const post = this.post(about);
      if (!post) throw new EngineError("not_found", `no post ${about}`);
      if (post.line !== to) throw new EngineError("invalid", `a reply to ${about} goes to ${post.line ?? "nobody (it only opens)"}, not ${to}`);
      const last = this.db.prepare(`SELECT id FROM items WHERE about = ? AND kind = ? AND recipient = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(about, kind, to) as { id: string } | undefined;
      return { about, followUp: followUp ?? last?.id ?? (about.startsWith("msg:") ? about.slice(4) : null) };
    }
    const prev = followUp ? this.item(followUp) : null;
    return { about: prev?.about ?? (followUp ? `msg:${followUp}` : OWN_POST), followUp };
  }

  /** A feed post by its key: what it is, its title, and the line a reply takes; null if none. */
  post(key: string): Post | null {
    const i = key.indexOf(":");
    const kind = key.slice(0, i);
    const id = key.slice(i + 1);
    if (i < 1 || !id) return null;
    if (kind === "decision") {
      const d = this.decision(id);
      if (!d) return null;
      const origin = d.orchestrator.origin;
      const line = origin === "cos" ? "cos" : origin === "steward" || !d.project ? null : `lead:${d.project}`;
      return { key, kind, id, title: d.ask?.title ?? d.request.title, project: d.project, line, rev: null };
    }
    if (kind === "deliverable") {
      const d = this.deliverable(id);
      return d ? { key, kind, id, title: d.title, project: d.project, line: d.lead, rev: d.rev } : null;
    }
    if (kind === "status") return this.project(id) ? { key, kind, id, title: `${id}'s status`, project: id, line: `lead:${id}`, rev: null } : null;
    if (kind === "merge") {
      const r = this.db.prepare(`SELECT project, note FROM events WHERE ref = ? AND kind = 'pr' AND value = 'merged' ORDER BY at DESC LIMIT 1`).get(id) as { project: string | null; note: string | null } | undefined;
      return r ? { key, kind, id, title: `PR ${r.note ? `#${r.note} ` : ""}merged`, project: r.project, line: r.project ? `lead:${r.project}` : null, rev: null } : null;
    }
    if (kind === "board") {
      const r = this.db.prepare(`SELECT kind, project, title FROM board WHERE id = ?`).get(id) as { kind: string; project: string | null; title: string } | undefined;
      if (!r || (r.kind !== "dead" && r.kind !== "alarm")) return null;
      return { key, kind, id, title: r.title, project: r.project, line: r.kind === "dead" ? "cos" : null, rev: null };
    }
    if (kind === "msg") {
      const it = this.item(id);
      if (!it || (it.kind !== "owner.message" && it.kind !== "owner.cos")) return null;
      return { key, kind, id, title: it.body.replace(/\s+/g, " ").slice(0, 80), project: it.recipient.startsWith("lead:") ? it.recipient.slice(5) : null, line: it.recipient, rev: null };
    }
    return null;
  }

  /** The post a message is about, as its reader is told ("deliverable v-1 “Onboarding checklist” (rev 2)"); none for its own post. */
  private reLine(about: string | null): string | null {
    if (!about || about.startsWith("msg:")) return null;
    const p = this.post(about);
    if (!p) return null;
    const what = { decision: "card", deliverable: "deliverable", status: "the status card of", merge: "", board: "" }[p.kind as "decision"] ?? "";
    if (p.kind === "status") return `${what} ${p.id}`;
    if (p.kind === "merge") return `the merge of ${p.id}`;
    return `${what ? `${what} ` : ""}${p.id} ${JSON.stringify(p.title)}${p.rev ? ` (rev ${p.rev})` : ""}`;
  }

  /** The owner's tracked message to the CoS, answered with orch_reply_owner; `images` are addCosImage ids. */
  ownerCosMessage(text: string, images: string[] = [], about: string | null = null): Item {
    const words = text.trim();
    if (!words && !images.length) throw new EngineError("invalid", "empty message");
    if (words.length > 8000) throw new EngineError("invalid", `a message is at most 8000 characters; this is ${words.length}`);
    if (images.length > MAX_IMAGES) throw new EngineError("invalid", `a message carries at most ${MAX_IMAGES} images; this has ${images.length}`);
    if (!this.liveAt("cos")) throw new EngineError("bad_state", "No Chief of Staff is running: start it from the Projects tab");
    return tx(this.db, () => {
      const thread = this.conversation("cos", "owner.cos", null, about);
      const imgs = [...new Set(images)].map((id) => this.directImageRow(id));
      if (imgs.length !== images.length) throw new EngineError("invalid", "an image is named twice");
      for (const i of imgs) if (!i || i.slug !== COS_IMAGES || i.item_id !== null) throw new EngineError("invalid", "an image isn't one sent for this message: attach it again");
      const kept = imgs.map((i) => imageOf(i!));
      const it = this.put({ recipient: "cos", sender: "person", kind: "owner.cos", ref: thread.followUp, body: withImages(words, kept), needsAck: true, about: thread.about });
      kept.forEach((i, n) => this.db.prepare(`UPDATE direct_images SET item_id = ?, n = ? WHERE id = ?`).run(it.id, n, i.id));
      if (this.settings.batchInbox) this.batch.policy(it.id, { severity: "ACTION", needsReply: true });
      this.boardAdd("direct", "person", null, `${this.owner.Name} → cos`, it.body, it.id);
      this.ports.changed();
      return it;
    });
  }

  /** An image staged for the owner's next message to the CoS, kept by the server at `img.path`: its id. */
  addCosImage(img: { name: string; mime: ImageType; size: number; path: string; sourceProject: string | null }): string {
    if (img.size > MAX_IMAGE_BYTES) throw new EngineError("invalid", `an image is at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    if (!isAbsolute(img.path)) throw new EngineError("invalid", "an image is kept at an absolute path");
    const id = `img-${hex(6)}`;
    this.db
      .prepare(`INSERT INTO direct_images (id, slug, item_id, n, name, mime, size, path, source_project, created_at) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`)
      .run(id, COS_IMAGES, img.name, img.mime, img.size, img.path, img.sourceProject, this.now());
    return id;
  }

  /** orch_reply_owner: the CoS's reply, recorded under the message's post, never delivered; it closes the message. */
  replyOwner(by: Agent, ref: string, text: string): Item {
    if (by.role !== "cos") throw new EngineError("forbidden", "only the CoS replies to the owner's messages");
    const words = text.trim();
    if (!words) throw new EngineError("invalid", "empty reply");
    if (words.length > 4000) throw new EngineError("invalid", `a reply is at most 4000 characters; this is ${words.length}`);
    const it = this.item(ref);
    if (!it || it.kind !== "owner.cos") throw new EngineError("invalid", `${ref} isn't ${this.owner.name}'s message to you: orch_reply_owner answers an owner.cos item`);
    const id = `i-${hex(6)}`;
    tx(this.db, () => {
      const t = this.now();
      this.db
        .prepare(`INSERT INTO items (id, recipient, sender, kind, ref, body, needs_ack, state, attempts, created_at, closed_at, outcome, about) VALUES (?, 'person', ?, 'cos.reply', ?, ?, 0, 'closed', 0, ?, ?, 'done', ?)`)
        .run(id, by.address, ref, words, t, t, it.about);
      this.closeItems(`id = ?`, [ref], "replied", `replied in ${id}`);
      this.batch.readOne(ref);
    });
    this.ports.changed();
    return this.item(id)!;
  }

  private cosReplyTo(id: string): Item | null {
    const r = this.db.prepare(`SELECT * FROM items WHERE ref = ? AND kind = 'cos.reply' ORDER BY created_at DESC LIMIT 1`).get(id) as ItemRow | undefined;
    return r ? toItem(r) : null;
  }

  /** The owner's Resend: a dead letter is resent; an unanswered one is redelivered or its recipient re-woken. */
  resendOwner(id: string): Item {
    const it = this.item(id);
    if (!it || it.sender !== "person" || (it.kind !== "owner.message" && it.kind !== "owner.cos")) throw new EngineError("invalid", `${id} isn't one of ${this.owner.name}'s messages`);
    if (it.state === "dead") return this.resend(id);
    if (it.kind === "owner.message" ? it.state === "closed" : !!this.cosReplyTo(id)) throw new EngineError("bad_state", `${id} is answered`);
    // batched, an unread message stays pending: its wake is what went out
    if ((it.state === "pending" && !this.settings.batchInbox) || it.state === "queued") throw new EngineError("bad_state", `${id} is still on its way to ${it.recipient}`);
    if (!this.agentByAddress(it.recipient)) throw new EngineError("bad_state", `${it.recipient} has no live agent: start it first`);
    tx(this.db, () => {
      // batched, the re-wake is its delivery: the feed's resend clock starts again from it
      this.db.prepare(`UPDATE items SET state = 'pending', attempts = MAX(attempts, 1), queued_message_id = NULL, delivered_at = ?, closed_at = NULL, outcome = NULL, note = NULL WHERE id = ?`).run(this.settings.batchInbox ? this.now() : null, id);
      if (this.settings.batchInbox) {
        this.batch.reroute(id, it.recipient);
        this.batch.rewake(it.recipient);
      }
      this.boardAdd("notice", "person", null, `Resent ${id} to ${it.recipient}`, "", id);
    });
    this.ports.changed();
    return this.item(id)!;
  }

  private feedSource(prompts: FeedPrompt[] = []): FeedSource {
    // a page asks once per post whether its line is live: many posts share a line, so each address is looked up once
    const live = new Map<string, boolean>();
    return {
      db: this.db,
      now: this.now(),
      seen: this.feedSeen(),
      resendMs: this.settings.resendMs,
      batched: this.settings.batchInbox,
      batchReadAt: (id) => this.batch.readAt(id), // the feed's read receipts: change-notice.ts READS.feed names inbox_entries
      openCards: this.needsYou().cards,
      scopeCards: this.scopeView().flatMap((p) => p.cards),
      live: (address) => live.get(address) ?? (live.set(address, !!this.liveAt(address)), live.get(address)!),
      heldProjects: new Set(this.projects().filter((p) => p.heldAt).map((p) => p.slug)),
      prompts,
    };
  }

  /** One page of the Feed tab (core/feed.ts). `prompts`: the pending bb prompts the server last read for Needs you. */
  feed(opts: { cursor: string | null; filter: FeedFilter; limit?: number }, prompts: FeedPrompt[] = []): FeedPage {
    return feedPage(this.feedSource(prompts), opts);
  }

  cosLine(before: number | null, limit = 40): { entries: CosLineEntry[]; more: boolean } {
    return cosLine(this.feedSource(), before, limit, (about) => {
      const p = this.post(about);
      return p ? `${p.title}${p.rev ? `, rev ${p.rev}` : ""}${p.project ? ` · ${p.project}` : ""}` : null;
    });
  }

  feedThread(about: string, before: number | null, limit = 100): { messages: FeedMsg[]; more: boolean } {
    return feedThread(this.feedSource(), about, before, limit);
  }

  /** The feed's one seen-up-to line: posts with agent activity after it are new. */
  feedSeen(): number {
    return this.cursor("feed.seen") ?? 0;
  }

  /** The owner left the feed, or marked all read: the line moves to `upTo`, only forward and never past now. */
  markFeedSeen(upTo: number): number {
    const v = Math.max(this.feedSeen(), Math.min(upTo, this.now()));
    this.setCursor("feed.seen", v);
    this.ports.changed();
    return v;
  }

  /**
   * An image the page sent for a message to a project's lead, kept by the server at `img.path`: its id,
   * which the message names. The server has checked its bytes (core/direct-images.ts sniff); the bytes never come here.
   */
  addDirectImage(slug: string, img: { name: string; mime: ImageType; size: number; path: string; sourceProject: string | null }): string {
    if (!this.project(slug)) throw new EngineError("not_found", `no project ${slug}`);
    if (img.size > MAX_IMAGE_BYTES) throw new EngineError("invalid", `an image is at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    if (!isAbsolute(img.path)) throw new EngineError("invalid", "an image is kept at an absolute path");
    const id = `img-${hex(6)}`;
    this.db
      .prepare(`INSERT INTO direct_images (id, slug, item_id, n, name, mime, size, path, source_project, created_at) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`)
      .run(id, slug, img.name, img.mime, img.size, img.path, img.sourceProject, this.now());
    return id;
  }

  private directImageRow(id: string): DirectImageRow | undefined {
    return this.db.prepare(`SELECT * FROM direct_images WHERE id = ?`).get(id) as DirectImageRow | undefined;
  }

  /** The images a direct message carries, in the order the owner attached them. */
  directImagesOf(itemId: string): DirectImage[] {
    return (this.db.prepare(`SELECT * FROM direct_images WHERE item_id = ? ORDER BY n`).all(itemId) as DirectImageRow[]).map(imageOf);
  }

  /** The owner's direct messages to a lead still in force: the last 48 h, newest first, whatever their state. */
  directInForce(to: string): Item[] {
    return (this.db.prepare(`SELECT * FROM items WHERE recipient = ? AND kind = 'owner.message' AND created_at >= ? ORDER BY created_at DESC`).all(to, this.now() - DIRECT_IN_FORCE_MS) as ItemRow[]).map(toItem);
  }

  /**
   * Each live project's direct line for the Projects row: its latest DIRECT_SHOWN messages, plus every message whose
   * lead answer the owner hasn't seen (so the row can show each one), newest first. Unread counts only the leads'
   * answers (direct-answer events), never a closure by archive. Archived projects have none. Per project, the reads
   * go through the items (recipient) and events (project, at) indexes, so a long history isn't scanned.
   */
  directLines(): Map<string, DirectLine> {
    const seen = new Map((this.db.prepare(`SELECT name, value FROM cursors WHERE name LIKE 'direct.seen:%'`).all() as { name: string; value: number }[]).map((r) => [r.name.slice("direct.seen:".length), r.value]));
    const latest = this.db.prepare(`SELECT * FROM items WHERE recipient = ? AND kind = 'owner.message' ORDER BY created_at DESC LIMIT ?`);
    const answers = this.db.prepare(`SELECT ref, MAX(at) AS at FROM events WHERE project = ? AND at > ? AND kind = 'direct-answer' GROUP BY ref`);
    const out = new Map<string, DirectLine>();
    for (const { slug } of this.db.prepare(`SELECT slug FROM projects WHERE archived_at IS NULL`).all() as { slug: string }[]) {
      const after = seen.get(slug) ?? 0;
      const unread = new Map((answers.all(slug, after) as { ref: string; at: number }[]).map((r) => [r.ref, r.at]));
      const items = (latest.all(`lead:${slug}`, DIRECT_SHOWN) as ItemRow[]).map(toItem);
      for (const id of unread.keys()) if (!items.some((it) => it.id === id)) { const it = this.item(id); if (it) items.push(it); }
      if (!items.length) continue;
      items.sort((x, y) => y.createdAt - x.createdAt);
      out.set(slug, { messages: items.map((it) => directMessageOf(it, unread, this.directImagesOf(it.id))), unread: unread.size > 0 });
    }
    return out;
  }

  /**
   * One project's direct messages, newest first, for the chat log: read only when the owner opens it, so the
   * Projects read stays at DIRECT_SHOWN per row. `before`: only messages created before it (the "Older" cursor).
   */
  directHistory(slug: string, before: number | null, limit: number): { messages: DirectLine["messages"]; more: boolean } {
    if (!this.project(slug)) throw new EngineError("not_found", `no project ${slug}`);
    const n = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db
      .prepare(`SELECT * FROM items WHERE recipient = ? AND kind = 'owner.message' AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(`lead:${slug}`, before ?? Number.MAX_SAFE_INTEGER, n + 1) as ItemRow[];
    const answers = this.db.prepare(`SELECT ref, MAX(at) AS at FROM events WHERE project = ? AND at > ? AND kind = 'direct-answer' GROUP BY ref`);
    const unread = new Map((answers.all(slug, this.directSeen(slug)) as { ref: string; at: number }[]).map((r) => [r.ref, r.at]));
    return { messages: rows.slice(0, n).map(toItem).map((it) => directMessageOf(it, unread, this.directImagesOf(it.id))), more: rows.length > n };
  }

  /** When the owner last looked at a project's direct thread (opened its composer): answers after it are new. */
  directSeen(slug: string): number {
    return this.cursor(`direct.seen:${slug}`) ?? 0;
  }

  /**
   * The owner opened a project's direct thread, which showed answers up to `upTo` (the newest it drew): those are seen.
   * Only from that action, never a render. The cursor never goes back, nor past now, so an answer that arrived after
   * the page drew stays new.
   */
  markDirectSeen(slug: string, upTo: number): void {
    if (!this.project(slug)) throw new EngineError("not_found", `no project ${slug}`);
    this.setCursor(`direct.seen:${slug}`, Math.max(this.directSeen(slug), Math.min(upTo, this.now())));
    this.ports.changed();
  }


  /** A wait's PR (its URL, or its number when exactly one PR the plugin reads has it) and condition, or `invalid`. */
  private waitInput(w: { pr: string; when: string }): { url: string; when: WaitWhen } {
    if (!WAIT_WHEN.includes(w.when as WaitWhen)) throw new EngineError("invalid", `when is one of ${WAIT_WHEN.join(", ")}`);
    const raw = (w.pr ?? "").trim().replace(/\/+$/, "");
    const n = /^#?(\d+)$/.exec(raw);
    if (n) {
      const urls = (this.db.prepare(`SELECT DISTINCT url FROM prs WHERE url LIKE ?`).all(`%/pull/${n[1]}`) as { url: string }[]).map((r) => r.url);
      if (urls.length !== 1) throw new EngineError("invalid", `${urls.length ? "more than one PR" : "no PR the plugin reads"} is #${n[1]}: give the PR's URL`);
      return { url: urls[0]!, when: w.when as WaitWhen };
    }
    if (!/^https:\/\/[^/\s]+\/[^\s]+\/pull\/\d+$/.test(raw)) throw new EngineError("invalid", `pr is a pull request URL (https://…/pull/<n>) or its number, not ${JSON.stringify(w.pr)}`);
    return { url: raw, when: w.when as WaitWhen };
  }

  private waitAbout(id: string): string {
    const d = id.startsWith("d-") ? this.decision(id) : null;
    if (d) {
      const a = d.answer;
      return `${id} ${JSON.stringify(d.ask?.title ?? d.request.title)} answered: ${a?.option ? `option ${a.option} ${JSON.stringify(a.label)}` : "no option"}${a?.text ? `, note: ${JSON.stringify(a.text.slice(0, 600))}` : ""}`;
    }
    const it = this.item(id);
    return `${id} from ${it?.sender ?? "?"}: ${JSON.stringify((it?.body ?? "").replace(/\s+/g, " ").slice(0, 600))}`;
  }

  private bindWait(by: Agent, id: string, url: string, when: WaitWhen): string {
    const wid = `w-${hex(4)}`;
    this.db.prepare(`INSERT INTO waits (id, owner, ref, about, pr_url, cond, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(wid, by.address, id, this.waitAbout(id), url, when, this.now());
    // the PR a wait watches belongs to the owner's task (a lead's: its card's), and stays after the wait closes
    linkPr(this.db, url, waitTask(this.db, by.address, id), "wait", by.address, this.now());
    const shown = this.prByUrl(url);
    const woke = this.checkWaits(url);
    if (woke.includes(wid)) return `bound to ${url}: it is ${WHEN_WORDS[when]} already, so it is back in your inbox now (${wid})`;
    return `bound to ${url} (${wid}): you get it back when the PR is ${WHEN_WORDS[when]}, and a reminder each day until then${shown ? "" : ". No thread's environment shows this PR, so the plugin reads it by its URL on each PR check"}`;
  }

  /** Close `by`'s own open waits on `ref` (never another agent's) with `outcome`. Returns their PRs, or null when none. */
  private closeOwnWaits(by: Agent, ref: string, outcome: "rebound" | "dropped"): string | null {
    const rows = this.db.prepare(`SELECT * FROM waits WHERE closed_at IS NULL AND owner = ? AND ref = ? ORDER BY created_at`).all(by.address, ref) as WaitRow[];
    if (!rows.length) return null;
    this.db.prepare(`UPDATE waits SET closed_at = ?, outcome = ? WHERE closed_at IS NULL AND owner = ? AND ref = ?`).run(this.now(), outcome, by.address, ref);
    this.ports.changed();
    return rows.map((w) => `${w.pr_url} (${w.id})`).join(", ");
  }

  /** Whether a PR reading meets a wait's condition: true, false, or "never" (closed without merging). */
  private waitMet(pr: PrRow, when: WaitWhen): boolean | "never" {
    if (pr.state === "merged") return true;
    if (pr.state === "closed") return "never";
    if (when === "approved") return pr.review === "approved";
    if (when === "green") return pr.checks === "passing";
    if (when === "ready") return pr.attention === "ready_to_merge";
    return false;
  }

  /** Wake the owners of the open waits on `url` whose condition the latest reading meets. Returns the waits it closed. */
  private checkWaits(url: string): string[] {
    const pr = this.waitPr(url);
    if (!pr) return [];
    const rows = this.db.prepare(`SELECT * FROM waits WHERE closed_at IS NULL AND pr_url = ?`).all(pr.url ?? url) as WaitRow[];
    const done: string[] = [];
    for (const w of rows) {
      const met = this.waitMet(pr, w.cond as WaitWhen);
      if (!met) continue;
      const what = `PR${pr.number ? ` #${pr.number}` : ""} ${met === "never" ? "was closed without merging, so it will never be" : "is"} ${WHEN_WORDS[w.cond as WaitWhen]}${met === "never" ? "" : ` (${pr.state}${pr.checks ? `, checks ${pr.checks}` : ""}${pr.review ? `, review ${pr.review.replace(/_/g, " ")}` : ""})`}`;
      const it = this.put({
        recipient: w.owner,
        sender: "orchestrator",
        kind: "message",
        ref: w.ref,
        body: `${what}: ${pr.url ?? url}. ${w.ref === w.id ? `PR wait ${w.id} was set on it` : `You bound ${w.ref} to it`} ${ago(this.now() - w.created_at)} ago: ${w.about}. ${met === "never" ? "Decide what happens instead" : "Carry it out now"}, then ack this.`,
        key: `wait:${w.id}`,
        needsAck: true,
      });
      this.db.prepare(`UPDATE waits SET closed_at = ?, outcome = ?, item_id = ? WHERE id = ?`).run(this.now(), met === "never" ? "closed" : "met", it.id, w.id);
      done.push(w.id);
    }
    if (done.length) this.ports.changed();
    return done;
  }

  /** From the tick: a wait unmet a day after it was bound (or last reminded) reminds its owner, once a day. */
  private nudgeWaits(): void {
    const t = this.now();
    const rows = this.db.prepare(`SELECT * FROM waits WHERE closed_at IS NULL AND COALESCE(nudged_at, created_at) <= ?`).all(t - WAIT_NUDGE_MS) as WaitRow[];
    for (const w of rows) {
      tx(this.db, () => {
        this.db.prepare(`UPDATE waits SET nudged_at = ? WHERE id = ?`).run(t, w.id);
        if (!this.agentByAddress(w.owner)) return;
        const pr = this.waitPr(w.pr_url);
        const seen = pr ? `unchanged for ${ago(t - pr.seenAt)}: ${pr.state ?? "?"}${pr.checks ? `, checks ${pr.checks}` : ""}${pr.review ? `, review ${pr.review.replace(/_/g, " ")}` : ""}${pr.attention ? `, ${pr.attention.replace(/_/g, " ")}` : ""}` : "the plugin hasn't been able to read it yet: no thread's environment shows it, and gh hasn't answered for it";
        this.put({
          recipient: w.owner,
          sender: "orchestrator",
          kind: "notice",
          ref: w.ref,
          body: `Still waiting (${ago(t - w.created_at)}): ${w.pr_url} isn't ${WHEN_WORDS[w.cond as WaitWhen]} yet (${seen}). It holds ${w.about}. Chase it, or ack ${w.ref} again with pr and when to watch another PR, or with no pr to stop watching.`,
          key: `wait-nudge:${w.id}:${t}`,
          needsAck: false,
        });
      });
    }
  }

  /**
   * The reading a wait on `url` goes by: the PR wait's own gh reading when there is one (kept only while no live
   * environment's bb reading covers the PR: prSeen drops it), else bb's latest reading of it, else null.
   */
  waitPr(url: string): PrRow | null {
    const bare = url.replace(/\/+$/, "");
    const r = this.db.prepare(`SELECT * FROM pr_readings WHERE url = ?`).get(bare) as PrReadingRow | undefined;
    return r ? { environmentId: "", threadId: "", url: r.url, number: r.number, state: r.state, attention: r.attention, checks: r.checks, review: r.sig.split("|")[4] || null, seenAt: r.seen_at } : this.prByUrl(bare);
  }

  openWaitUrls(): string[] {
    return (this.db.prepare(`SELECT DISTINCT pr_url FROM waits WHERE closed_at IS NULL ORDER BY pr_url`).all() as { pr_url: string }[]).map((r) => r.pr_url);
  }

  /**
   * A PR wait's own reading (gh pr view by URL, open-prs/host.ts), for a PR no live environment's bb reading covered
   * this pass. Kept per URL (when it last changed and when it was read), then the waits on it are checked with the same
   * rule as bb's readings (prFacts). Anything but an available reading writes nothing and closes nothing. Returns the
   * waits it closed.
   */
  waitPrSeen(res: PrResult): string[] {
    if (res.outcome !== "available") return [];
    const pr = res.pullRequest;
    const url = pr.url.replace(/\/+$/, "");
    const old = this.db.prepare(`SELECT sig, seen_at FROM pr_readings WHERE url = ?`).get(url) as { sig: string; seen_at: number } | undefined;
    const f = prFacts({ ...pr, url }, old ? old.sig.split("|")[5] || null : undefined);
    const t = this.now();
    return tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO pr_readings (url, number, state, attention, checks, sig, seen_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(url) DO UPDATE SET number = excluded.number, state = excluded.state, attention = excluded.attention, checks = excluded.checks,
             sig = excluded.sig, seen_at = excluded.seen_at, read_at = excluded.read_at`,
        )
        .run(url, pr.number ?? null, pr.state, f.shown, f.checks, f.sig, old && old.sig === f.sig ? old.seen_at : t, t);
      this.logSettledPr(url, pr.state, pr.number ?? null);
      return this.checkWaits(url);
    });
  }

  /**
   * A merge or close a PR wait's own reading saw goes in the PR log too, under the PR's holder (its bb reading's thread,
   * else whoever the log last named), as prSeen logs a live thread's: pruneWaitReadings drops the reading once the wait
   * is met, and the work board (core/work-board.ts) must still know a retired thread's PR merged. Once per state.
   */
  private logSettledPr(url: string, state: string, number: number | null): void {
    if (state !== "merged" && state !== "closed") return;
    const last = this.db.prepare(`SELECT value, address, project, thread_id FROM events WHERE kind = 'pr' AND ref = ? ORDER BY at DESC, seq DESC LIMIT 1`).get(url) as
      | { value: string | null; address: string | null; project: string | null; thread_id: string | null }
      | undefined;
    if (last?.value === state) return;
    const held = this.db.prepare(`SELECT a.address, a.project, a.thread_id FROM prs p JOIN agents a ON a.thread_id = p.thread_id WHERE p.url = ? ORDER BY p.seen_at DESC LIMIT 1`).get(url) as
      | { address: string; project: string | null; thread_id: string }
      | undefined;
    const who = held ?? last;
    this.event({ kind: "pr", project: who?.project ?? null, address: who?.address ?? null, threadId: who?.thread_id ?? null, value: state, ref: url, note: number != null ? String(number) : null });
  }

  /** Drop the gh readings no open wait names any more (a wait met, moved or dropped) and no PR link needs (a linked URL's state is read per URL). Returns how many went. */
  pruneWaitReadings(): number {
    // a tidy's read request ends once its PR is linked (filed) or after a day; its reading is kept while it lasts
    this.db.prepare(`DELETE FROM pr_read_requests WHERE url IN (SELECT url FROM task_prs) OR at < ?`).run(this.now() - 24 * 3_600_000);
    return Number(
      (this.db.prepare(`DELETE FROM pr_readings WHERE url NOT IN (SELECT pr_url FROM waits WHERE closed_at IS NULL) AND url NOT IN (SELECT url FROM task_prs) AND url NOT IN (SELECT url FROM pr_read_requests)`).run() as { changes: number | bigint }).changes,
    );
  }

  /**
   * The linked PRs (task_prs, every path), and those a refused tidy asked for (pr_read_requests), that gh still has to read: no state yet, or a newest state (bb's reading, a
   * gh reading or the PR log, as the board takes it) that isn't merged or closed. The wait pass reads them with the
   * waits' PRs, so an unknown state resolves itself; a final one is not read again.
   */
  linkedPrsToRead(): string[] {
    return (
      this.db
        .prepare(
          `WITH s AS (
             SELECT rtrim(trim(url), '/') AS u, state, seen_at AS at FROM prs
             UNION ALL SELECT url, state, seen_at FROM pr_readings
             UNION ALL SELECT rtrim(trim(ref), '/'), value, at FROM events WHERE kind = 'pr' AND ref IS NOT NULL
           ), latest AS (SELECT u, state, MAX(at) FROM s GROUP BY u)
           SELECT DISTINCT t.url FROM (SELECT url FROM task_prs UNION SELECT url FROM pr_read_requests) t LEFT JOIN latest l ON l.u = t.url WHERE l.state IS NULL OR l.state NOT IN ('merged', 'closed') ORDER BY t.url`,
        )
        .all() as { url: string }[]
    ).map((r) => r.url);
  }

  // The owner (from the Board) and the CoS (orch_watch) may list, add, retarget, move or drop any open PR wait, for any
  // recipient. Leads and threads keep only orch_ack's own-wait moves. Each change tells the wait's old and new owner in
  // one line and logs a Board row. `by` null is the owner.

  /** Who is changing a wait, in words: the owner, or the CoS. Anyone else is refused. */
  private watcher(by: Agent | null): { who: string; from: string } {
    if (by === null) return { who: this.owner.Name, from: "person" };
    if (by.role !== "cos") throw new EngineError("forbidden", "only the CoS (orch_watch) and the owner (the Board) change PR waits; acks move your own (orch_ack with pr and when)");
    return { who: "The CoS", from: by.address };
  }

  private openWait(id: string): WaitRow {
    const w = this.db.prepare(`SELECT * FROM waits WHERE id = ?`).get(id) as WaitRow | undefined;
    if (!w) throw new EngineError("not_found", `no PR wait ${id}`);
    if (w.closed_at !== null) throw new EngineError("bad_state", `${id} is closed already (${w.outcome ?? "closed"})`);
    return w;
  }

  private liveAddress(to: string): Agent {
    const a = this.agentByAddress(to.trim());
    if (!a) throw new EngineError("invalid", `${JSON.stringify(to)} is no live agent's address`);
    return a;
  }

  /** One line to a wait's owner (skipped when the address has no live holder: no dead letter for a notice). */
  private watchTell(to: string, body: string, key: string): void {
    if (!this.agentByAddress(to)) return;
    this.put({ recipient: to, sender: "orchestrator", kind: "notice", ref: null, body, key, needsAck: false });
  }

  /** When the tick's daily and hourly checks last ran, for the Watchers list (their own cursors; waits' nudges). */
  watchRuns(): Record<string, number | undefined> {
    const nudged = (this.db.prepare(`SELECT MAX(nudged_at) AS t FROM waits`).get() as { t: number | null }).t;
    return { stale: this.cursor("stale.checked_at") ?? undefined, "dead-letters": this.cursor("dlq.checked_at") ?? undefined, "wait-nudges": nudged ?? undefined };
  }

  /** Every open PR wait with its latest reading, oldest first. */
  watchList(): WaitView[] {
    const rows = this.db.prepare(`SELECT * FROM waits WHERE closed_at IS NULL ORDER BY created_at, rowid`).all() as WaitRow[];
    return rows.map((w) => {
      const gh = this.db.prepare(`SELECT read_at FROM pr_readings WHERE url = ?`).get(w.pr_url) as { read_at: number } | undefined;
      const pr = this.waitPr(w.pr_url);
      return {
        id: w.id,
        owner: w.owner,
        ownerLive: !!this.agentByAddress(w.owner),
        ref: w.ref,
        about: w.about,
        prUrl: w.pr_url,
        when: w.cond,
        createdAt: w.created_at,
        reading: pr ? { state: pr.state, checks: pr.checks, review: pr.review, attention: pr.attention, source: gh ? "gh" : "bb", changedAt: pr.seenAt, readAt: gh?.read_at ?? null } : null,
      };
    });
  }

  /** A new PR wait for `to`: when the PR gets there, `to` gets `note` back as work to carry out. */
  watchAdd(by: Agent | null, input: { to: string; pr: string; when: string; note: string }): string {
    const { who, from } = this.watcher(by);
    const to = this.liveAddress(input.to);
    const w = this.waitInput({ pr: input.pr, when: input.when });
    const note = input.note.replace(/\s+/g, " ").trim();
    if (!note) throw new EngineError("invalid", "give note: what the recipient carries out once the PR is there");
    const wid = `w-${hex(4)}`;
    return tx(this.db, () => {
      this.db.prepare(`INSERT INTO waits (id, owner, ref, about, pr_url, cond, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(wid, to.address, wid, `${who}'s note: ${JSON.stringify(note.slice(0, 600))}`, w.url, w.when, this.now());
      linkPr(this.db, w.url, waitTask(this.db, to.address, wid), "wait", to.address, this.now());
      const line = `${who} added PR wait ${wid} for ${to.address}: until ${w.url} is ${WHEN_WORDS[w.when]}`;
      this.watchTell(to.address, `${who} added a PR wait for you (${wid}): once ${w.url} is ${WHEN_WORDS[w.when]}, carry out ${JSON.stringify(note.slice(0, 300))}. It comes back to you then.`, `watch:${wid}:add`);
      this.boardAdd("notice", from, to.project, line, note.slice(0, 600), wid);
      const woke = this.checkWaits(w.url);
      return woke.includes(wid) ? `${line}; it is ${WHEN_WORDS[w.when]} already, so it went to ${to.address} at once` : line;
    });
  }

  /** Point an open wait at another PR and/or condition; checked against the new PR at once. */
  watchRetarget(by: Agent | null, id: string, input: { pr?: string | null; when?: string | null }): string {
    const { who, from } = this.watcher(by);
    const w = this.openWait(id);
    if (!input.pr && !input.when) throw new EngineError("invalid", "give pr and/or when: the wait's new PR, condition or both");
    const next = this.waitInput({ pr: input.pr || w.pr_url, when: input.when || w.cond });
    if (next.url === w.pr_url && next.when === w.cond) return `${id} already waits until ${w.pr_url} is ${WHEN_WORDS[next.when]}; nothing changed`;
    return tx(this.db, () => {
      this.db.prepare(`UPDATE waits SET pr_url = ?, cond = ? WHERE id = ?`).run(next.url, next.when, id);
      // the new PR joins the owner's task; the old one's link stays (it was on the task, and it may still be unmerged)
      linkPr(this.db, next.url, waitTask(this.db, w.owner, w.ref), "wait", w.owner, this.now());
      const was = `${w.pr_url} ${WHEN_WORDS[w.cond as WaitWhen]}`;
      const now = `${next.url} ${WHEN_WORDS[next.when]}`;
      this.watchTell(w.owner, `${who} retargeted your PR wait ${id} (${w.ref}): now until ${now}, was ${was}.`, `watch:${id}:retarget:${this.now()}`);
      this.boardAdd("notice", from, this.agentByAddress(w.owner)?.project ?? null, `${who} retargeted PR wait ${id} (${w.owner}): ${now}, was ${was}`, "", id);
      const woke = this.checkWaits(next.url);
      return `${id} now waits until ${now} (was ${was})${woke.includes(id) ? `; it is there already, so it went to ${w.owner} at once` : ""}`;
    });
  }

  /** Hand an open wait to another live agent: it gets the answer back when the PR gets there. */
  watchMove(by: Agent | null, id: string, toAddress: string): string {
    const { who, from } = this.watcher(by);
    const w = this.openWait(id);
    const to = this.liveAddress(toAddress);
    if (to.address === w.owner) return `${id} is ${w.owner}'s already; nothing changed`;
    return tx(this.db, () => {
      this.db.prepare(`UPDATE waits SET owner = ? WHERE id = ?`).run(to.address, id);
      linkPr(this.db, w.pr_url, waitTask(this.db, to.address, w.ref), "wait", to.address, this.now());
      const what = `${w.pr_url} ${WHEN_WORDS[w.cond as WaitWhen]}`;
      this.watchTell(w.owner, `${who} moved your PR wait ${id} (${w.ref}, until ${what}) to ${to.address}.`, `watch:${id}:move-from:${this.now()}`);
      this.watchTell(to.address, `${who} gave you PR wait ${id} from ${w.owner}: once ${what}, you get back ${w.about.replace(/\s+/g, " ").slice(0, 300)}.`, `watch:${id}:move-to:${this.now()}`);
      this.boardAdd("notice", from, to.project, `${who} moved PR wait ${id} from ${w.owner} to ${to.address}: until ${what}`, "", id);
      return `${id} moved from ${w.owner} to ${to.address}: until ${what}`;
    });
  }

  watchDrop(by: Agent | null, id: string): string {
    const { who, from } = this.watcher(by);
    const w = this.openWait(id);
    return tx(this.db, () => {
      this.db.prepare(`UPDATE waits SET closed_at = ?, outcome = 'dropped' WHERE id = ?`).run(this.now(), id);
      const what = `${w.pr_url} ${WHEN_WORDS[w.cond as WaitWhen]}`;
      this.watchTell(w.owner, `${who} dropped your PR wait ${id} (${w.ref}, until ${what}): nothing comes back for it.`, `watch:${id}:drop`);
      this.boardAdd("notice", from, this.agentByAddress(w.owner)?.project ?? null, `${who} dropped PR wait ${id} (${w.owner}): until ${what}`, "", id);
      this.ports.changed();
      return `${id} dropped (${w.owner}, until ${what})`;
    });
  }

  /** An agent's open waits, for its inbox and the stale-thread check. */
  openWaits(owner: string | null = null): { id: string; owner: string; ref: string; prUrl: string; when: WaitWhen; createdAt: number }[] {
    return (this.db.prepare(`SELECT * FROM waits WHERE closed_at IS NULL AND (? IS NULL OR owner = ?) ORDER BY created_at`).all(owner, owner) as WaitRow[]).map((w) => ({ id: w.id, owner: w.owner, ref: w.ref, prUrl: w.pr_url, when: w.cond as WaitWhen, createdAt: w.created_at }));
  }


  /**
   * What the daily check lists: live threads idle over STALE_WAKE_MS that wait on nothing (no open card they asked,
   * no PR waiting on CI or a review, no answer bound to their PR), and live leads registered that long ago that never
   * sent anything (no mail, card, report or deliverable under their address; board rows the engine writes for them,
   * such as PR readings, don't count).
   */
  staleList(): { threads: { address: string; idleAt: number }[]; leads: { address: string; since: number }[] } {
    const t = this.now();
    const cut = t - STALE_WAKE_MS;
    const threads = this.agents()
      .filter((a) => a.role === "thread" && a.status === "idle" && a.idleAt !== null && a.idleAt <= cut)
      .filter((a) => !this.db.prepare(`SELECT 1 FROM decisions WHERE (asker = ? OR origin = ?) AND state IN ('open','asked','merged') LIMIT 1`).get(a.address, a.address))
      .filter((a) => {
        const pr = this.prFor(a.environmentId);
        const live = pr && (pr.state === "open" || pr.state === "draft");
        if (live && (pr.checks === "pending" || ["review_required", "review_requested"].includes(pr.review ?? "") || pr.attention === "review_requested")) return false;
        return !this.db.prepare(`SELECT 1 FROM waits WHERE closed_at IS NULL AND (owner = ? OR pr_url = ?) LIMIT 1`).get(a.address, pr?.url ?? "");
      })
      .map((a) => ({ address: a.address, idleAt: a.idleAt! }));
    // since its first start: a lead restarted today under an old address has had days to speak
    const leads = (
      this.db
        .prepare(`SELECT a.address, (SELECT MIN(created_at) FROM agents b WHERE b.address = a.address) AS since FROM agents a WHERE a.role = 'lead' AND a.retired_at IS NULL ORDER BY a.address`)
        .all() as { address: string; since: number }[]
    )
      .filter((l) => l.since <= cut)
      .filter(
        (l) =>
          !this.db
            .prepare(
              `SELECT 1 FROM items WHERE sender = ? UNION ALL SELECT 1 FROM decisions WHERE asker = ? UNION ALL SELECT 1 FROM board WHERE from_address = ? AND kind IN ('report','pr','deliverable') UNION ALL SELECT 1 FROM deliverables WHERE lead = ? LIMIT 1`,
            )
            .get(l.address, l.address, l.address, l.address),
      )
      .map((l) => ({ address: l.address, since: l.since }));
    return { threads: threads.sort((a, b) => a.idleAt - b.idleAt), leads };
  }

  /**
   * The daily stale-thread item (from tick): at most once per STALE_WAKE_MS, one info item to the CoS with
   * staleList, only when it lists someone and differs from the last list it was sent (the same idle threads every day
   * are one item, not seven). Never to the owner.
   */
  staleWake(): Item | null {
    const t = this.now();
    const checked = this.cursor("stale.checked_at");
    if (checked !== null && t - checked < STALE_WAKE_MS) return null;
    return tx(this.db, () => {
      this.setCursor("stale.checked_at", t);
      if (!this.agentByAddress("cos")) return null;
      const { threads, leads } = this.staleList();
      if (!threads.length && !leads.length) return null;
      const names = [...threads.map((x) => x.address), ...leads.map((x) => x.address)].sort().join("\n");
      let hash = 0x811c9dc5;
      for (let i = 0; i < names.length; i++) hash = Math.imul(hash ^ names.charCodeAt(i), 0x01000193) >>> 0;
      if (this.cursor("stale.hash") === hash) return null;
      this.setCursor("stale.hash", hash);
      const lines = [
        ...(threads.length ? [`Threads idle over a day with nothing to wait on (${threads.length}):`] : []),
        ...threads.map((x) => {
          const r = this.lastReport(x.address);
          return `- ${x.address}: idle ${ago(t - x.idleAt)}${r ? `; last report ${JSON.stringify(r)}` : "; no report"}`;
        }),
        ...(leads.length ? [`Leads that never sent anything (${leads.length}):`] : []),
        ...leads.map((x) => `- ${x.address}: started ${ago(t - x.since)} ago`),
      ];
      const it = this.put({
        recipient: "cos",
        sender: "orchestrator",
        kind: "notice",
        ref: null,
        body: `Daily stale-thread check:\n${lines.join("\n")}\nAsk each one's lead to resolve, restart or brief it (orch_send); put it to ${this.owner.name} only if it needs them.`,
        key: `stale:${hash}:${t}`,
        needsAck: false,
      });
      this.ports.changed();
      return it;
    });
  }


  /** orch_status: a lead publishes where its project is. Missing fields keep the last status's values. */
  publishStatus(a: Agent, p: StatusParams): LeadStatus {
    if (a.role !== "lead" || !a.project) throw new EngineError("forbidden", "only a lead publishes its project's status");
    const project = a.project;
    return tx(this.db, () => {
      const prev = this.leadStatus(project);
      const legacySince = prev && !prev.waits ? this.legacyWaitSince(project, prev) : null;
      const r = normalizeStatus(p, prev, { now: this.now(), by: a.address, ownerName: this.settings.owner ?? "", legacySince });
      if ("refusal" in r) throw new EngineError("invalid", r.refusal);
      const s = r.status;
      // the steps are the project's work-board tasks: each gets its id, and the tasks follow (core/tasks.ts)
      if (p.steps !== undefined) s.steps = this.taskGuard(() => assignTasks(this.db, project, s.steps, s.updatedAt));
      const json = JSON.stringify(s);
      this.db
        .prepare(
          `INSERT INTO lead_status (project, address, thread_id, json, updated_at, nudged_at) VALUES (?, ?, ?, ?, ?, NULL)
           ON CONFLICT (project) DO UPDATE SET address = excluded.address, thread_id = excluded.thread_id, json = excluded.json, updated_at = excluded.updated_at, nudged_at = NULL`,
        )
        .run(project, a.address, a.threadId, json, s.updatedAt);
      this.event({ at: s.updatedAt, kind: "lead-status", project, address: a.address, threadId: a.threadId, value: json });
      if (p.steps !== undefined) settleColumns(this.db, s.updatedAt, { log: true, by: a.address, project });
      this.ports.changed();
      return s;
    });
  }

  /**
   * A status stored before the waits list has no `since`: its one wait was first published at the oldest lead-status
   * event of the run of publishes, newest first, that kept the same kind and ref. Reads at most the last 50 publishes.
   */
  legacyWaitSince(project: string, s: LeadStatus): number {
    const w = s.waitingOn;
    let since = s.updatedAt;
    const rows = this.db.prepare(`SELECT at, value FROM events WHERE project = ? AND kind = 'lead-status' ORDER BY seq DESC LIMIT 50`).all(project) as { at: number; value: string | null }[];
    for (const r of rows) {
      let was: LeadStatus["waitingOn"] | undefined;
      try {
        was = (JSON.parse(r.value ?? "null") as LeadStatus | null)?.waitingOn;
      } catch {
        break;
      }
      if (!was || !sameWait(was, w)) break;
      since = Math.min(since, r.at);
    }
    return since;
  }

  private taskGuard<T>(fn: () => T, unread?: (urls: string[]) => void): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof TidyRefusal) unread?.(e.readFirst);
      if (e instanceof TaskError) throw new EngineError("invalid", e.message);
      throw e;
    }
  }

  /** The work-board task an agent names (orch_ask, orch_deliver: an id or an open task's title) in its project. */
  workTask(by: Agent, ref: string): WorkTaskRow {
    return this.taskGuard(() => resolveTaskRef(this.db, by.project, ref));
  }

  /** The work board (core/work-board.ts): read-only. */
  workBoard(opts: { since?: number | null; project?: string | null } = {}): WorkBoard {
    return readBoard(this.db, this.now(), opts);
  }

  /**
   * The owner's hand move of a task on the work board. It writes only the task's hand move:
   * the column, its time and the attachments' signature now, so it holds until something attached changes (the board's
   * `sig`). A move to the column the attachments give clears the hand move. The project's pending changes are logged
   * first as the engine's, so task_moves puts exactly this move down to the owner. The lead gets an INFO notice and the
   * CoS a copy. A move never merges a PR, answers a card or approves a deliverable: moving to Shipped ships nothing, and
   * moving out of Waiting on you leaves the card open (the notice says so).
   */
  boardMove(id: string, to: BoardColumn): { task: string; from: BoardColumn; to: BoardColumn; holds: boolean } {
    return tx(this.db, () => {
      const row = taskRow(this.db, id);
      if (!row) throw new EngineError("not_found", `no task ${id}`);
      if (row.state === "dropped") throw new EngineError("bad_state", `task ${id} was dropped: the CoS can restore it`);
      const now = this.now();
      settleColumns(this.db, now, { log: true, by: "engine", project: row.project });
      const t = readBoard(this.db, now, { project: row.project, since: 0 }).projects[0]?.tasks.find((x) => x.id === id);
      if (!t) throw new EngineError("not_found", `task ${id} is not on the board`);
      if (t.column === to) return { task: id, from: t.column, to, holds: !!t.hand?.holds };
      const back = to === t.derived;
      if (back) this.db.prepare(`UPDATE tasks SET hand_col = NULL, hand_at = NULL, hand_sig = NULL WHERE id = ?`).run(id);
      else this.db.prepare(`UPDATE tasks SET hand_col = ?, hand_at = ?, hand_sig = ? WHERE id = ?`).run(to, now, t.sig, id);
      settleColumns(this.db, now, { log: true, by: "person", project: row.project });
      const open = t.cards.filter((c) => c.ownerWaits);
      const lead = `lead:${row.project}`;
      const body =
        `${this.owner.Name} moved task ${id} ${JSON.stringify(t.title)} from ${COLUMN_LABEL[t.column]} to ${COLUMN_LABEL[to]} on the work board. ` +
        (back ? "That is where its attachments put it, so no hand move holds." : "It holds there until something attached to it changes (a thread, PR, deliverable or card).") +
        ` The move merged, answered and approved nothing${open.length ? `; ${open.map((c) => `card ${c.id}`).join(", ")} still waits on ${this.owner.name}` : ""}.`;
      if (this.agentByAddress(lead)) {
        const it = this.put({ recipient: lead, sender: "orchestrator", kind: "notice", ref: null, body, needsAck: false });
        if (this.agentByAddress("cos")) this.put({ recipient: "cos", sender: "orchestrator", kind: "copy", ref: it.id, body: `(copy of the notice ${it.id} to ${lead}) ${body}`, key: `copy:cos:${it.id}`, needsAck: false });
      }
      this.ports.changed();
      return { task: id, from: t.column, to, holds: !back };
    });
  }

  /** Log the work board's column changes since the last settle (task_moves); from the tick, once a minute. */
  settleBoard(): number {
    return tx(this.db, () => settleColumns(this.db, this.now(), { log: true, by: "engine" }));
  }

  /**
   * orch_board_tidy (core/board-tidy.ts): the CoS reads and tidies the work board. CoS only. Each change is one
   * transaction: the action's own task_moves row (by cos), the project's knock-on column changes (by cos), and an INFO
   * notice to the project's lead.
   */
  boardTidy(by: Agent, p: { action: TidyAction; task?: string | null; into?: string | null; kind?: FileKind | null; ref?: string | null; project?: string | null }): string {
    if (by.role !== "cos") throw new EngineError("forbidden", "only the CoS tidies the work board");
    if (p.action === "list") return tidyList(this.db, this.now(), p.project || null);
    const need = (v: string | null | undefined, what: string) => {
      if (!v) throw new EngineError("invalid", `${p.action} needs ${what}`);
      return v;
    };
    let readFirst: string[] = [];
    try {
      return this.tidyTx(by, p, need, (urls) => (readFirst = urls));
    } finally {
      // a refusal rolled its transaction back; the PRs nobody has read yet are queued for the next PR pass after it
      // (pr_read_requests, read by linkedPrsToRead), never read here: no GitHub call on the tool's request path
      if (readFirst.length) {
        const at = this.now();
        tx(this.db, () => {
          for (const url of readFirst) this.db.prepare(`INSERT INTO pr_read_requests (url, at) VALUES (?, ?) ON CONFLICT(url) DO UPDATE SET at = excluded.at`).run(url, at);
        });
      }
    }
  }

  private tidyTx(by: Agent, p: { action: TidyAction; task?: string | null; into?: string | null; kind?: FileKind | null; ref?: string | null }, need: (v: string | null | undefined, what: string) => string, unread: (urls: string[]) => void): string {
    return tx(this.db, () => {
      const now = this.now();
      const r = this.taskGuard(() =>
        p.action === "merge"
          ? mergeTask(this.db, now, need(p.task, "task (the one to fold in)"), need(p.into, "into (the task that keeps it)"))
          : p.action === "restore"
            ? restoreTask(this.db, now, need(p.task, "task"))
            : p.action === "confirm"
              ? confirmDrop(this.db, now, need(p.task, "task"))
              : fileItem(this.db, now, (p.kind ?? need(null, "kind (thread, pr, deliverable or card)")) as FileKind, need(p.ref, "ref (what to file)"), need(p.task, "task (where to file it)")),
        unread,
      );
      if (r.project) settleColumns(this.db, now, { log: true, by: "cos", project: r.project });
      const lead = r.project ? `lead:${r.project}` : null;
      if (r.notice && lead && this.agentByAddress(lead)) this.put({ recipient: lead, sender: by.address, kind: "notice", ref: null, body: r.notice, needsAck: false });
      this.ports.changed();
      return r.text;
    });
  }

  /**
   * The stale-task flag (core/board-tidy.ts staleTasks), from the tick with the board settle: one notice per lead
   * listing its tasks that look finished but have a live thread idling on them, each task at most once a day. A
   * project with no lead is not stamped, so its lead hears once it starts.
   */
  flagStaleTasks(): StaleTask[] {
    return tx(this.db, () => {
      const now = this.now();
      const byProject = new Map<string, StaleTask[]>();
      for (const t of staleTasks(this.db, now)) byProject.set(t.project, [...(byProject.get(t.project) ?? []), t]);
      const sent: StaleTask[] = [];
      for (const [project, tasks] of byProject) {
        const lead = `lead:${project}`;
        if (!this.agentByAddress(lead)) continue;
        const it = this.put({ recipient: lead, sender: "orchestrator", kind: "notice", ref: null, body: staleNotice(tasks), key: `stale-tasks:${tasks.map((t) => t.id).join(",")}:${now}`, needsAck: false });
        if (this.settings.batchInbox) this.batch.policy(it.id, { severity: "ACTION" });
        markStaleFlagged(this.db, now, tasks.map((t) => t.id));
        sent.push(...tasks);
      }
      if (sent.length) this.ports.changed();
      return sent;
    });
  }

  leadStatus(project: string): LeadStatus | null {
    const r = this.db.prepare(`SELECT json FROM lead_status WHERE project = ?`).get(project) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as LeadStatus) : null;
  }

  /**
   * The newest change in a project after `since`, from the event log (a thread's state, a PR's state, a thread
   * spawned or resolved) or an answered card, or null. The lead's own state changes are not news to it.
   */
  private projectChangedSince(project: string, lead: string, since: number): number | null {
    const ev = this.db
      .prepare(`SELECT MAX(at) AS at FROM events WHERE project = ? AND at > ? AND backfill = 0 AND (kind IN ('pr','spawn','resolve') OR (kind = 'status' AND address <> ?))`)
      .get(project, since, lead) as { at: number | null };
    const ans = this.db
      .prepare(`SELECT MAX(json_extract(json, '$.answer.at')) AS at FROM decisions WHERE (project = ? OR asker = ? OR origin = ? OR asker LIKE ? OR origin LIKE ?) AND json_extract(json, '$.answer.at') > ?`)
      .get(project, lead, lead, `thread:${project}:%`, `thread:${project}:%`, iso(since)) as { at: string | null };
    const at = Math.max(ev.at ?? 0, ans.at ? Date.parse(ans.at) : 0);
    return at > 0 ? at : null;
  }

  /**
   * From the tick: a status over STATUS_STALE_MS old is nudged only when something changed in its project since the last
   * publish (projectChangedSince), at most once per change, and never twice within STATUS_STALE_MS. One info item to
   * the lead, never a card. Only a lead that published once is nudged (it has the tool); a held project isn't.
   */
  /**
   * Status nudges only after a real turn: a lead that no inbox wake has woken since it published can't have moved on,
   * so a nudge would only ride along as noise. Per-message mode keeps no wake record, so there every nudge goes.
   */
  private hadRealTurnSince(lead: string, since: number): boolean {
    return !this.settings.batchInbox || this.batch.wokenSince(lead, since);
  }

  statusNudges(): Item[] {
    const t = this.now();
    const rows = this.db.prepare(`SELECT project, json, updated_at, nudged_at FROM lead_status WHERE updated_at < ? AND (nudged_at IS NULL OR nudged_at < ?)`).all(t - STATUS_STALE_MS, t - STATUS_STALE_MS) as {
      project: string;
      json: string;
      updated_at: number;
      nudged_at: number | null;
    }[];
    const out: Item[] = [];
    for (const r of rows) {
      const lead = this.agentByAddress(`lead:${r.project}`);
      if (!lead || lead.status === "archived" || this.project(r.project)?.heldAt != null) continue;
      if (!this.hadRealTurnSince(lead.address, r.updated_at)) continue; // checked before nudged_at moves: deferred, not lost
      const changed = this.projectChangedSince(r.project, lead.address, Math.max(r.updated_at, r.nudged_at ?? 0));
      if (changed === null) continue;
      const s = JSON.parse(r.json) as LeadStatus;
      out.push(
        tx(this.db, () => {
          this.db.prepare(`UPDATE lead_status SET nudged_at = ? WHERE project = ?`).run(t, r.project);
          const where = statusLine(s, this.owner.name);
          return this.put({
            recipient: lead.address,
            sender: "orchestrator",
            kind: "notice",
            ref: null,
            body: `Your status on the project page is ${ago(t - r.updated_at)} old${where ? ` (${where})` : ""}, and your project changed ${ago(t - changed)} ago. Publish orch_status with where you are now; the same status again confirms it.`,
            key: `status-nudge:${r.project}:${changed}`,
            needsAck: false,
          });
        }),
      );
    }
    if (out.length) this.ports.changed();
    return out;
  }

  /**
   * From the tick: a status a live fact contradicts (a wait it names is answered, merged or resolved, or an answer
   * covers a blocker; buildSummary's statusOutOfDate) gets its lead one notice to republish, at most once per status
   * (the key is the status's time), never a message to the owner. Not for a held project or one with no live lead; the
   * row says "Status out of date" either way.
   */
  statusOutOfDateNudges(): Item[] {
    const out: Item[] = [];
    for (const [slug, sum] of this.projectSummaries()) {
      if (!sum.statusOutOfDate || this.project(slug)?.heldAt != null) continue;
      const lead = `lead:${slug}`;
      const s = this.leadStatus(slug);
      if (!s || !this.liveAt(lead)) continue;
      if (!this.hadRealTurnSince(lead, s.updatedAt)) continue; // before the key or nudged_at is spent: deferred, not lost
      const key = `status-outdated:${slug}:${s.updatedAt}`;
      if (this.db.prepare(`SELECT 1 FROM items WHERE sender = 'orchestrator' AND send_key = ?`).get(key)) continue;
      // the stale nudge already asked for a new status within its window: one ask is enough
      const n = this.db.prepare(`SELECT nudged_at FROM lead_status WHERE project = ?`).get(slug) as { nudged_at: number | null } | undefined;
      if (n?.nudged_at != null && n.nudged_at > s.updatedAt && this.now() - n.nudged_at < STATUS_STALE_MS) continue;
      this.db.prepare(`UPDATE lead_status SET nudged_at = ? WHERE project = ?`).run(this.now(), slug);
      out.push(
        this.put({
          recipient: lead,
          sender: "orchestrator",
          kind: "notice",
          ref: null,
          body: `Your status on the Projects row is out of date: something it names has since been answered, merged or resolved. Publish orch_status with what you wait on and what blocks you now; the row hides the parts that are over meanwhile.`,
          key,
          needsAck: false,
        }),
      );
    }
    if (out.length) this.ports.changed();
    return out;
  }


  decision(id: string): Decision | null {
    const r = this.db.prepare(`SELECT json FROM decisions WHERE id = ?`).get(id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as Decision) : null;
  }

  private mustDecision(id: string): Decision {
    const d = this.decision(id);
    if (!d) throw new EngineError("not_found", `no decision ${id}`);
    return d;
  }

  /** Save a decision: rev + 1, one history entry, the row's columns, and the mirror (for decisions above a lead). */
  private save(d: Decision, event: Decision["history"][number]["event"], by: string, note: string | null, expectRev: number | null): Decision {
    const cur = this.decision(d.id);
    if (cur && expectRev !== null && cur.rev !== expectRev) throw new EngineError("conflict", `${d.id} changed (rev ${cur.rev}, you saw ${expectRev})`);
    const t = this.now();
    d.rev = (cur?.rev ?? 0) + 1;
    d.updated_at = iso(t);
    d.history.push({ at: iso(t), rev: d.rev, event, state: d.state, by, note });
    const o = d.orchestrator;
    const deferredUntil = d.deferred?.until ? Date.parse(d.deferred.until) : null;
    this.db
      .prepare(
        `INSERT INTO decisions (id, state, at_level, asker, origin, project, action, triage_due_at, deferred_until, deferred_manual, json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, at_level = excluded.at_level, asker = excluded.asker, origin = excluded.origin,
           project = excluded.project, action = excluded.action, triage_due_at = excluded.triage_due_at, deferred_until = excluded.deferred_until,
           deferred_manual = excluded.deferred_manual, json = excluded.json, updated_at = excluded.updated_at`,
      )
      .run(
        d.id,
        d.state,
        o.at_level,
        o.asker,
        o.origin,
        d.project,
        o.action,
        o.triage.due_at && !o.triage.triaged_at ? Date.parse(o.triage.due_at) : null,
        deferredUntil,
        d.deferred && d.deferred.until === null ? 1 : 0,
        JSON.stringify(d),
        t,
      );
    linkCardPrs(this.db, d, t);
    if (o.at_level !== "lead") this.ports.mirror(d);
    this.ports.changed();
    return d;
  }

  private options(raw: AskInput["options"], min: number): Opt[] {
    if (raw.length < min || raw.length > 4) throw new EngineError("invalid", `give ${min} to 4 options, the recommended one first`);
    return raw.map((o, i) => ({
      id: String(i + 1),
      label: oneLine(o.label, 80, `option ${i + 1}'s label`),
      detail: o.detail ? oneLine(o.detail, 300, `option ${i + 1}'s detail`) : "",
      ...(o.go ? { go: true } : {}),
    }));
  }

  /**
   * The asker revises its own unanswered card. Same id; the save bumps rev, so an answer to the old rev is refused as
   * changed. On the owner's Needs you (or Scope pane) it is updated in place and the CoS gets a read-only copy; still
   * waiting for triage, the CoS is told to triage this version; with a thread's lead, the lead is told.
   */
  private revise(by: Agent, id: string, input: AskInput): Decision {
    const why = oneLine(input.why ?? "", 300, "why (what made the card stale)");
    return tx(this.db, () => {
      const d = this.mustDecision(id);
      if (d.orchestrator.asker !== by.address) throw new EngineError("forbidden", `only ${d.orchestrator.asker}, who asked ${id}, revises it`);
      if (d.state !== "open" && d.state !== "asked") throw new EngineError("bad_state", `${id} is ${d.state}${d.withdrawn ? ` (${d.withdrawn.moot ? "moot" : "withdrawn"}: ${d.withdrawn.reason})` : ""}: only an unanswered card can be revised; ask again with a new card`);
      if (d.orchestrator.scoping_done) throw new EngineError("invalid", `${id} is a "Scoping done?" card: its options are fixed`);
      if ((input.kind ?? d.kind) !== d.kind || (input.action ?? d.orchestrator.action) !== d.orchestrator.action) throw new EngineError("invalid", `${id} is a ${d.orchestrator.action === "merge" ? "merge card" : d.kind}: a revision keeps its kind`);
      const options = this.options(input.options, 2);
      const tooLong = cardRefusal({ question: input.question, context: input.context, options, kind: d.kind });
      if (tooLong) throw new EngineError("invalid", tooLong);
      if (d.kind === "plan") d.orchestrator.plan = planOf(options, input.threads ?? d.orchestrator.plan?.threads ?? 1);
      else if (options.some((o) => o.go)) throw new EngineError("invalid", "only a plan has a go option");
      const r = d.request;
      r.title = oneLine(input.title, 60, "title");
      r.question = oneLine(input.question, 600, "question");
      r.context = (input.context ?? "").slice(0, 8192);
      r.options = options;
      if (input.blocks !== undefined) r.blocks = parseBlocks(input.blocks);
      if (input.task) d.orchestrator.task = this.workTask(by, input.task).id;
      // a merge card stays one: the owner's yes is read against its PR, so a revision can't drop it
      if (d.orchestrator.action === "merge" && !(r.blocks ?? []).some((b) => b.kind === "pr")) throw new EngineError("invalid", `${id} is a merge card: its revision needs a pr block (the PR's URL, and a one-line verdict as its note)`);
      if (d.orchestrator.at_level !== "lead") this.gate(d);
      const n = (d.orchestrator.revised?.count ?? 0) + 1;
      d.orchestrator.revised = { count: n, at: iso(this.now()), why };
      // on the owner's screen: the asker's new wording replaces the CoS's; same place in the list, no new push
      if (d.ask) d.ask = { ...d.ask, title: r.title, question: r.question, context: r.context, options: options.map((o, i) => ({ ...o, recommended: i === 0 })) };
      // cards merged into it duplicated the old question: one answer to the new one mustn't settle them, so each goes
      // back to the CoS's triage on its own
      const detached = d.merged.map((mid) => this.decision(mid)).filter((m): m is Decision => !!m && m.state === "merged");
      d.merged = [];
      this.save(d, "revise", by.address, why, null);
      for (const m of detached) {
        m.state = "open";
        m.merged_into = null;
        m.orchestrator.triage.triaged_at = null;
        m.orchestrator.triage.by = null;
        this.save(m, "merge", "engine", `detached: ${d.id}, which it was merged into, was revised by its asker`, null);
        this.fileWithCos(m, m.orchestrator.asker);
      }
      const card = `${d.id} ${JSON.stringify(r.title)}`;
      if (d.orchestrator.at_level === "lead") {
        if (this.agentByAddress(`lead:${d.project}`)) this.put({ recipient: `lead:${d.project}`, sender: by.address, kind: "notice", ref: d.id, body: `${by.address} revised ${card} (revision ${n}): ${JSON.stringify(why)}. This version replaces the one you had: ${this.describe(d, "lead")}`, key: `revise:${d.id}:${n}`, needsAck: false });
      } else if (this.agentByAddress("cos")) {
        const body =
          d.state === "asked"
            ? `${by.address} revised ${card} (revision ${n}), already on ${this.owner.name}'s ${d.orchestrator.scope ? "Scope pane" : "Needs you"}: ${JSON.stringify(why)}. Read-only copy: it was updated in place there, with the asker's new wording; nothing for you to do (to merge a card into it, pass into_revision=${n}). Question: ${JSON.stringify(r.question)} Options: ${options.map((o) => `${o.id}) ${JSON.stringify(o.label)}`).join(" ")}.`
            : `${by.address} revised ${card} (revision ${n}) before you triaged it: ${JSON.stringify(why)}. Triage this version with revision=${n}, not the one you had: ${this.describe(d, "cos")}`;
        const back = detached.length ? ` ${detached.map((m) => m.id).join(", ")} ${detached.length === 1 ? "was" : "were"} merged into it and ${detached.length === 1 ? "is" : "are"} back with you to triage on ${detached.length === 1 ? "its" : "their"} own.` : "";
        this.put({ recipient: "cos", sender: by.address, kind: d.state === "asked" ? "copy" : "notice", ref: d.id, body: body + back, key: `revise:${d.id}:${n}`, needsAck: false });
      }
      return this.mustDecision(d.id);
    });
  }

  /** File a question. A thread's goes to its lead; a lead's or the Steward's to the CoS. Never blocks. */
  ask(by: Agent, input: AskInput): Decision {
    if (by.role === "cos") throw new EngineError("forbidden", `the CoS asks ${this.owner.name} through triage(ask_person)`);
    if (input.revises) return this.revise(by, input.revises, input);
    const t = this.now();
    // a scoping project's lead, or a lead filing into one of its scoping tasks, files into the owner's Scope pane; its
    // threads still ask it
    const done = input.scopingDone ? this.scopingDone(by, input) : null;
    const named = input.scopeTask ? this.resolveTask(by, input.scopeTask) : null;
    if (named && done?.task && named.id !== done.task) throw new EngineError("invalid", `scope_task ${named.id} and scoping_done.task ${done.task} name different tasks: give one`);
    const task = done?.task ?? named?.id ?? null;
    const scoping = by.role === "lead" && (!!task || this.isScoping(by.project));
    const options = this.options(done ? (done.task ? SCOPING_TASK_DONE_OPTIONS : SCOPING_DONE_OPTIONS).map((o) => ({ ...o })) : input.options, 2);
    const kind = input.kind ?? "question";
    const tooLong = cardRefusal({ question: input.question, context: input.context, options, kind });
    if (tooLong) throw new EngineError("invalid", tooLong);
    let plan: { threads: number; go: string } | null = null;
    if (kind === "plan") {
      if (by.role !== "lead") throw new EngineError("forbidden", "only a lead files a plan card");
      plan = planOf(options, input.threads ?? 1);
    } else if (options.some((o) => o.go)) throw new EngineError("invalid", "only a plan has a go option");
    const atCos = by.role !== "thread";
    const asker = by.address;
    const workTask = input.task ? this.workTask(by, input.task).id : null;
    return tx(this.db, () => {
      if (input.key) {
        const dup = this.db.prepare(`SELECT id FROM decisions WHERE asker = ? AND json_extract(json, '$.request_key') = ? AND state IN ('open','asked')`).get(asker, input.key) as { id: string } | undefined;
        if (dup) return this.mustDecision(dup.id);
      }
      if (done) {
        // one at a time: per task, and one for the whole project
        const open = this.db
          .prepare(`SELECT id FROM decisions WHERE project = ? AND state IN ('open','asked') AND json_extract(json, '$.orchestrator.scoping_done') IS NOT NULL AND json_extract(json, '$.orchestrator.scoping_done.task') IS ?`)
          .get(by.project, done.task ?? null) as { id: string } | undefined;
        if (open) throw new EngineError("bad_state", `${open.id} already asks ${this.owner.name} whether ${done.task ? `scoping task ${done.task}` : "scoping"} is done: wait for that answer`);
      }
      const d: Decision = {
        schema: 1,
        id: decisionId(t),
        rev: 0,
        state: "open",
        kind,
        created_at: iso(t),
        updated_at: iso(t),
        project: by.project,
        request_key: input.key ?? null,
        request: {
          by: { role: by.role, project: by.project, thread: by.threadId, terminal: null, machine: null, address: by.address },
          title: oneLine(input.title, 60, "title"),
          question: oneLine(input.question, 600, "question"),
          context: (input.context ?? "").slice(0, 8192),
          options,
          blocks: parseBlocks(input.blocks),
        },
        reply_to: { labels: { "orchestrator.address": asker }, terminal: null, machine: null },
        ask: null,
        answer: null,
        relay: null,
        ack: null,
        cos_notified_at: null,
        owed_from: null,
        merged_into: null,
        merged: [],
        withdrawn: null,
        deferred: null,
        returned: null,
        history: [],
        orchestrator: {
          at_level: atCos ? "cos" : "lead",
          asker,
          origin: by.address,
          action: input.action ?? null,
          triage: { filed_at: null, due_at: null, triaged_at: null, by: null, escalated_at: null },
          forwarded_by: null,
          plan,
          ...(done ? { scoping_done: done } : {}),
          ...(task ? { scope_task: task } : {}),
          ...(workTask ? { task: workTask } : {}),
        },
      };
      if (atCos) this.gate(d);
      this.save(d, "add", by.address, null, null);
      if (scoping) {
        this.fileInScope(d, by.address);
        return this.mustDecision(d.id);
      }
      if (this.ruleSettles(d)) return this.mustDecision(d.id);
      if (atCos) this.fileWithCos(d, by.address);
      else {
        // a scoping thread's question: the lead's forward files it under the thread's task
        const tt = this.threadTask(d);
        const from = tt ? ` From the scoping thread for task ${JSON.stringify(tt.name)} (${tt.id}): orch_forward files it in ${this.owner.name}'s Scope pane under that task.` : "";
        this.put({ recipient: `lead:${by.project}`, sender: by.address, kind: "decision.new", ref: d.id, body: this.describe(d, "lead") + from, needsAck: false });
      }
      return this.mustDecision(d.id);
    });
  }

  /**
   * A "Scoping done?" card's checks: a scoping project's lead, a plain question, a summary and its PROJECT.md. With task
   *: one of the lead's open scoping tasks, in a project of either mode, and the file its findings are in.
   */
  private scopingDone(by: Agent, input: AskInput): { summary: string; project_md?: string; doc?: string; task?: string } {
    const s = input.scopingDone!;
    if (by.role !== "lead") throw new EngineError("forbidden", "only a lead proposes the end of its project's scoping");
    const task = s.task ? this.resolveTask(by, s.task) : null;
    if (!task && !this.isScoping(by.project)) throw new EngineError("bad_state", `${by.project} isn't scoping: "Scoping done?" is only for a project in scoping mode, or for one of its open scoping tasks (give task)`);
    if ((input.kind ?? "question") !== "question" || input.action) throw new EngineError("invalid", `"Scoping done?" is a plain question: no plan, no merge card`);
    const summary = String(s.summary ?? "").trim();
    if (!summary) throw new EngineError("invalid", `scoping_done needs summary: ${task ? "what the task settled" : "the goal, the constraints and the first plan, as written to PROJECT.md"}`);
    if (summary.length > SCOPING_SUMMARY_MAX) throw new EngineError("invalid", `scoping_done's summary is ${summary.length} characters; the cap is ${SCOPING_SUMMARY_MAX}. Keep the goal, the constraints and the first plan; the rest is in ${task ? "the doc" : "PROJECT.md"}`);
    if (task) {
      const doc = String(s.doc ?? s.projectMd ?? "").trim();
      if (!isAbsolute(doc)) throw new EngineError("invalid", "scoping_done with task needs doc (or project_md): the absolute path of the file you wrote the task's findings to");
      return { summary, doc, task: task.id };
    }
    const md = String(s.projectMd ?? "").trim();
    if (!isAbsolute(md) || !/(^|\/)PROJECT\.md$/.test(md)) throw new EngineError("invalid", "scoping_done needs project_md: the absolute path of the PROJECT.md you wrote the summary to");
    return { summary, project_md: md };
  }

  private describe(d: Decision, forWhom: "lead" | "cos"): string {
    const opts = d.request.options.map((o) => `${o.id}) ${JSON.stringify(o.label)}${o.id === "1" ? " (recommended)" : ""}${o.detail ? ` — ${o.detail}` : ""}`).join(" ");
    const what =
      forWhom === "lead"
        ? "Settle it with answer(id, option, rule_id) if a project rule covers it, or answer(id, option, note) as your own call, else forward(id) to file it up."
        : d.orchestrator.action === "merge"
          ? "A merge card: you may not settle or merge it. triage(ask_person)."
          : "triage it: settle (cite a rule id), ask_person, or merge into a duplicate.";
    // its asker revised it: the CoS triages it naming that revision (cosDecision), so the notice says which one this is
    const n = d.orchestrator.revised?.count ?? 0;
    const rev = !n ? "" : forWhom === "cos" ? ` This is revision ${n}: triage it with revision=${n}, and merge another card into it with into_revision=${n}.` : ` This is revision ${n}: answer it with revision=${n}.`;
    return `${JSON.stringify(d.request.title)} ${JSON.stringify(d.request.question)} Options: ${opts}. ${what}${rev}`;
  }

  private fileWithCos(d: Decision, by: string): void {
    const t = this.now();
    d.orchestrator.at_level = "cos";
    d.orchestrator.triage.filed_at = iso(t);
    d.orchestrator.triage.due_at = iso(t + this.settings.escalateMs);
    const it = this.put({ recipient: "cos", sender: by, kind: "decision.new", ref: d.id, body: this.describe(d, "cos") + this.likelyMoot(d, t), needsAck: false });
    d.cos_notified_at = iso(t);
    this.save(d, "notify", "engine", `inbox ${it.id}`, null);
  }

  /**
   * The auto-moot flag on a card filed with the CoS: " Likely moot: …" naming the change note by the same lead's
   * owner, in the last day, that shares words with it (core/moot.ts), else "". Only a flag: the CoS decides.
   */
  likelyMoot(d: Decision, at: number): string {
    const text = `${d.request.title} ${d.request.question}`;
    const notes = (this.db.prepare(`SELECT json FROM deliverables WHERE lead = ? AND updated_at >= ?`).all(d.orchestrator.asker, at - MOOT_WINDOW_MS) as { json: string }[]).flatMap((r) => {
      const v = JSON.parse(r.json) as Deliverable;
      return v.feedback.filter((f) => f.outcome === "changes" && f.text && Date.parse(f.at) <= at && Date.parse(f.at) >= at - MOOT_WINDOW_MS).map((f) => ({ v, f, shared: sharedWords(text, f.text!) }));
    });
    const hit = notes.filter((n) => n.shared.length >= MOOT_MIN_SHARED).sort((a, b) => b.shared.length - a.shared.length || Date.parse(b.f.at) - Date.parse(a.f.at))[0];
    if (!hit) return "";
    return ` Likely moot: ${this.owner.name}'s change note on ${hit.v.id} ${JSON.stringify(hit.v.title)} ${ago(at - Date.parse(hit.f.at))} ago already asks for this: ${JSON.stringify(hit.f.text!.slice(0, 300))} (shared: ${hit.shared.join(", ")}). ${d.kind === "plan" || d.orchestrator.action === "merge" ? `A ${d.kind === "plan" ? "plan's go" : "merge card's yes"} still comes from ${this.owner.name}: if the note covers it, say so when you ask.` : `If the note covers it, orch_moot it instead of asking ${this.owner.name}.`}`;
  }

  /**
   * A lead files its thread's question up to the CoS. The lead becomes the asker: the answer comes to it. With
   * `scopeTask`, or from a thread started for a scoping task that is still open, it goes to the owner's Scope
   * pane under that task instead.
   */
  forward(by: Agent, id: string, note: string | null, scopeTask: string | null = null): Decision {
    return tx(this.db, () => {
      const d = this.mustDecision(id);
      if (by.role !== "lead" || d.orchestrator.at_level !== "lead" || d.project !== by.project) throw new EngineError("forbidden", `${id} isn't your thread's question`);
      if (d.state !== "open") throw new EngineError("bad_state", `${id} is ${d.state}`);
      const task = scopeTask ? this.resolveTask(by, scopeTask) : this.threadTask(d);
      if (task) d.orchestrator.scope_task = task.id;
      d.orchestrator.asker = by.address;
      d.orchestrator.forwarded_by = by.address;
      d.reply_to.labels = { "orchestrator.address": by.address };
      if (note) d.request.context = `${d.request.context}\n\nLead's note: ${note}`.trim().slice(0, 8192);
      this.gate(d);
      if (task || this.isScoping(by.project)) this.fileInScope(d, by.address); // the lead's card now: the Scope pane, like its own
      else if (!this.ruleSettles(d)) this.fileWithCos(d, by.address);
      return this.mustDecision(id);
    });
  }

  private ruleFor(ruleId: string, d: Decision, option: string): Rule {
    const r = this.db.prepare(`SELECT * FROM rules WHERE id = ?`).get(ruleId) as RuleRow | undefined;
    if (!r) throw new EngineError("not_found", `no standing rule ${ruleId}${d.orchestrator.at_level === "lead" ? " (to answer as your own call, send an empty rule_id and a note saying why)" : ""}`);
    const rule = toRule(r);
    if (isPractice(rule)) throw new EngineError("forbidden", `${ruleId} is a standing practice from ${this.owner.name}, not a rule: it settles nothing${d.orchestrator.at_level === "lead" ? " (to answer as your own call, send an empty rule_id and a note saying why)" : ""}`);
    if (rule.revokedAt !== null) throw new EngineError("forbidden", `rule ${ruleId} was revoked`);
    if (rule.expiresAt !== null && rule.expiresAt <= this.now()) throw new EngineError("forbidden", `rule ${ruleId} has expired`);
    if (rule.project !== null && rule.project !== d.project) throw new EngineError("forbidden", `rule ${ruleId} covers ${rule.project}, not ${d.project ?? "no project"}`);
    if (!rule.kinds.includes(d.kind)) throw new EngineError("forbidden", `rule ${ruleId} doesn't cover ${d.kind}s`);
    // a rule from the owner's answers covers only the cards it matches, and only with its own answer
    if (rule.match) {
      const m = matchRule(rule.match, d);
      if ("miss" in m) throw new EngineError("forbidden", `rule ${ruleId} doesn't cover ${d.id}: ${m.miss}`);
      if (m.option !== option) throw new EngineError("forbidden", `rule ${ruleId} answers ${d.id} with option ${m.option}, not ${option}`);
    }
    return rule;
  }

  /**
   * A new card a standing rule from the owner's answers covers is settled by it at once: never on the owner's Needs
   * you, and the CoS (or, for a thread's card, the lead) hears which rule did it. Exactly one rule must match: two that
   * both match are left to the people (they might disagree).
   */
  private ruleSettles(d: Decision): boolean {
    if (d.state !== "open" || d.orchestrator.scope) return false; // a scoping card is the owner's to answer, in the pane
    const hits = this.liveRules(d.project).flatMap((r) => {
      if (!r.match || isPractice(r) || !r.kinds.includes(d.kind)) return [];
      const m = matchRule(r.match, d);
      return "option" in m ? [{ r, option: m.option }] : [];
    });
    if (hits.length !== 1) return false;
    const { r, option } = hits[0]!;
    const opt = d.request.options.find((o) => o.id === option)!;
    const t = iso(this.now());
    d.state = "answered";
    d.answer = { option, label: opt.label, text: `Settled by standing rule ${r.id}: ${r.text}`, by: "rule", via: "rule", at: t, source: `rule ${r.id}` };
    d.orchestrator.triage.triaged_at ??= t;
    d.orchestrator.triage.by ??= `rule ${r.id}`;
    this.save(d, "answer", "engine", `rule ${r.id}`, null);
    this.relay(d);
    const watcher = d.orchestrator.at_level === "lead" ? `lead:${d.project}` : "cos";
    if (watcher !== d.orchestrator.asker && this.agentByAddress(watcher))
      this.put({
        recipient: watcher,
        sender: "rule",
        kind: "notice",
        ref: d.id,
        body: `Standing rule ${r.id} settled ${d.id} ${JSON.stringify(d.request.title)} from ${d.orchestrator.origin} with option ${option} ${JSON.stringify(opt.label)}; it didn't reach ${this.owner.name}. If it shouldn't have, tell ${this.owner.name} (the rule is revoked on the Rules tab).`,
        key: `rule-settled:${d.id}`,
        needsAck: false,
      });
    return true;
  }

  private settle(d: Decision, by: Agent, ruleId: string, option: string, note: string | null): Decision {
    if (d.orchestrator.action === "merge") throw new EngineError("forbidden", `${d.id} is a merge card: only ${this.owner.name} answers it`);
    const opt = (d.ask?.options ?? d.request.options).find((o) => o.id === option);
    if (!opt) throw new EngineError("invalid", `no option ${option}`);
    const rule = this.ruleFor(ruleId, d, option);
    d.state = "answered";
    d.answer = { option, label: opt.label, text: note, by: by.role === "cos" ? "cos" : by.address, via: by.role === "cos" ? "cos" : "rule", at: iso(this.now()), source: `rule ${rule.id}` };
    d.orchestrator.triage.triaged_at ??= iso(this.now());
    d.orchestrator.triage.by ??= by.address;
    this.save(d, "answer", by.address, `rule ${rule.id}`, null);
    this.relay(d);
    return this.mustDecision(d.id);
  }

  /**
   * A lead settles its own thread's question: from a project rule, or with no rule (null or "") as its own call, which
   * needs a note saying why.
   */
  /** `revision`: the version of the thread's question the lead answers (0 or left out: never revised); a newer one is refused. */
  leadAnswer(by: Agent, id: string, ruleId: string | null, option: string, note: string | null, revision = 0): Decision {
    return tx(this.db, () => {
      const d = this.mustDecision(id);
      if (by.role !== "lead" || d.orchestrator.at_level !== "lead" || d.project !== by.project) throw new EngineError("forbidden", `${id} isn't your thread's question`);
      if (d.state !== "open") throw new EngineError("bad_state", `${id} is ${d.state}`);
      // an option id means what the version the lead read said: a thread's revision since may have replaced its options
      const now = d.orchestrator.revised?.count ?? 0;
      if (revision !== now) throw new EngineError("conflict", `${id} is at revision ${now}, you answered revision ${revision}: its thread revised it since. Answer this version with revision=${now}: ${this.describe(d, "lead")}`);
      if (ruleId?.trim()) return this.settle(d, by, ruleId.trim(), option, note);
      if (d.orchestrator.action === "merge") throw new EngineError("forbidden", `${d.id} is a merge card: only ${this.owner.name} answers it`);
      if (d.kind !== "question") throw new EngineError("forbidden", `${d.id} is a ${d.kind}: only a standing rule settles it below ${this.owner.name}`);
      if (!note?.trim()) throw new EngineError("invalid", "with no rule_id, give a note saying why: it is recorded as your own call");
      const opt = d.request.options.find((o) => o.id === option);
      if (!opt) throw new EngineError("invalid", `no option ${option}`);
      d.state = "answered";
      d.answer = { option, label: opt.label, text: note.trim(), by: by.address, via: "lead", at: iso(this.now()), source: "lead's own call" };
      this.save(d, "answer", by.address, "lead's own call", null);
      this.relay(d);
      return this.mustDecision(d.id);
    });
  }

  /**
   * Whether a message from `sender` to `to` about card `d` is its lead relaying its own call: an open question at lead
   * level (never forwarded, never a merge card) from that project's lead to the thread that asked it. Such a relay
   * settles the card, else it stays open for good and the thread can't ack it.
   */
  private relaySettles(d: Decision, sender: string, to: string): boolean {
    const o = d.orchestrator;
    return d.kind === "question" && d.state === "open" && o.at_level === "lead" && o.action === null && o.forwarded_by === null && d.project !== null && sender === `lead:${d.project}` && to === o.origin;
  }

  /** The card is answered by the lead's relay message `it` (its text is the answer); the thread got it already. */
  private settleByRelay(d: Decision, it: Item, at: number): void {
    d.state = "answered";
    d.answer = { option: null, label: null, text: it.body, by: it.sender, via: "lead", at: iso(at), source: `lead's own call, relayed in ${it.id}` };
    this.save(d, "answer", it.sender, `lead's own call (relay ${it.id})`, null);
    d.relay = { at: iso(at), ok: true, to: [it.recipient], items: [`${it.recipient}/${it.id}`], attempts: 1, error: null };
    this.save(d, "relay", "engine", `relayed by ${it.sender}: ${it.recipient}/${it.id}`, null);
  }

  /**
   * One-off repair, run at start: cards a lead answered with send(ref=<card>) before relays settled them. Each is
   * settled from its first relay, and acked when the thread had already closed that relay (it can't ack the card any
   * more: the thread may be gone). Idempotent: a settled card no longer matches. Never touches a card above the lead.
   */
  private settleRelayedCards(): void {
    const open = (this.db.prepare(`SELECT json FROM decisions WHERE state = 'open' AND at_level = 'lead' ORDER BY id`).all() as { json: string }[]).map((r) => JSON.parse(r.json) as Decision);
    for (const d of open) {
      const relays = (this.db.prepare(`SELECT * FROM items WHERE kind = 'message' AND ref = ? AND recipient = ? ORDER BY created_at, id`).all(d.id, d.orchestrator.origin) as ItemRow[]).filter((r) =>
        this.relaySettles(d, r.sender, r.recipient),
      );
      const first = relays[0];
      if (!first) continue;
      tx(this.db, () => {
        this.settleByRelay(d, toItem(first), first.created_at);
        if (first.state === "closed" && OUTCOMES.includes(first.outcome as Outcome)) {
          d.state = "acked";
          d.ack = { by: first.recipient, at: iso(first.closed_at ?? first.created_at), note: `closed with its relay ${first.id}${first.note ? `: ${first.note}` : ""}`, outcome: first.outcome as Outcome };
          this.save(d, "ack", "engine", `${first.recipient} closed relay ${first.id} (${first.outcome})`, null);
        }
      });
    }
  }

  triageSettle(by: Agent, id: string, ruleId: string, option: string, note: string | null, revision?: number): Decision {
    return tx(this.db, () => {
      const d = this.cosDecision(by, id, revision);
      return this.settle(d, by, ruleId, option, note);
    });
  }

  /** A card the CoS triages, as the version it read (`revision`, 0 or left out for one never revised): an asker's revision since is refused as stale. */
  private cosDecision(by: Agent, id: string, revision = 0): Decision {
    if (by.role !== "cos") throw new EngineError("forbidden", "only the CoS triages");
    const d = this.mustDecision(id);
    if (d.orchestrator.at_level !== "cos") throw new EngineError("bad_state", `${id} isn't waiting for triage (it is at ${d.orchestrator.at_level})`);
    if (d.state !== "open") throw new EngineError("bad_state", `${id} is ${d.state}`);
    const now = d.orchestrator.revised?.count ?? 0;
    if (revision !== now) throw new EngineError("conflict", `${id} is at revision ${now}, you triaged revision ${revision}: its asker revised it since. Triage this version with revision=${now}: ${this.describe(d, "cos")}`);
    return d;
  }

  triageAskPerson(by: Agent, id: string, p: { title?: string; question: string; context?: string; options: { label: string; detail?: string }[]; allowText: boolean; revision?: number }): Decision {
    return tx(this.db, () => {
      const d = this.cosDecision(by, id, p.revision);
      // a plan's options are the lead's (the go option must survive); the CoS may reword only the question
      const options = d.kind === "plan" ? d.request.options : this.options(p.options, 2);
      // the owner reads the CoS's wording, so it gets the asker's caps; a context left out is the asker's, already checked
      const tooLong = cardRefusal({ question: p.question, context: p.context ?? "", options: d.kind === "plan" ? [] : options, kind: d.kind });
      if (tooLong) throw new EngineError("invalid", tooLong);
      this.putAsk(d, "cos", p.title ?? d.request.title, p.question, p.context ?? d.request.context, options, p.allowText);
      d.orchestrator.triage.triaged_at = iso(this.now());
      d.orchestrator.triage.by = by.address;
      this.save(d, "ask", by.address, null, null);
      this.upOrHold(d);
      return this.mustDecision(id);
    });
  }

  private putAsk(d: Decision, by: string, title: string, question: string, context: string, options: Opt[], allowText: boolean) {
    d.state = "asked";
    d.orchestrator.at_level = "person";
    d.ask = {
      by,
      at: iso(this.now()),
      title: oneLine(title, 60, "title"),
      question: oneLine(question, 600, "question"),
      context: context.slice(0, 8192),
      options: options.map((o, i) => ({ ...o, recommended: i === 0 })),
      allow_text: allowText,
    };
  }

  triageMerge(by: Agent, id: string, into: string, revision?: number, intoRevision = 0): Decision {
    return tx(this.db, () => {
      const d = this.cosDecision(by, id, revision);
      const p = this.mustDecision(into);
      if (p.id === d.id) throw new EngineError("invalid", "a decision can't merge into itself");
      // the duplicate takes the destination's answer: judged a duplicate of a version its asker has since revised, it isn't
      const now = p.orchestrator.revised?.count ?? 0;
      if (intoRevision !== now) throw new EngineError("conflict", `${into} is at revision ${now}, you merged into revision ${intoRevision}: its asker revised it since. Check it still duplicates ${id}, then merge with into_revision=${now}: ${this.describe(p, "cos")}`);
      if (!["open", "asked"].includes(p.state) || p.orchestrator.at_level === "lead") throw new EngineError("bad_state", `${into} is ${p.state} at ${p.orchestrator.at_level}`);
      if (p.orchestrator.scope) throw new EngineError("forbidden", `${into} waits in ${this.owner.name}'s Scope pane (${this.scopeWhy(p.project, p.orchestrator.scope_task)}): your copy is read-only`);
      // a merged card takes its parent's answer: a plan's go or a merge card's yes must come from the owner on that card itself
      if (d.kind === "plan" || p.kind === "plan") throw new EngineError("forbidden", `a plan card is never merged: ${this.owner.name} approves each plan on its own card`);
      if (d.orchestrator.action === "merge" || p.orchestrator.action === "merge") throw new EngineError("forbidden", `a merge card is never merged: ${this.owner.name} answers each PR's card in person`);
      if (d.kind !== p.kind || d.orchestrator.action !== p.orchestrator.action) throw new EngineError("invalid", `${id} and ${into} aren't the same kind of card, so one answer can't settle both`);
      d.state = "merged";
      d.merged_into = p.id;
      d.orchestrator.triage.triaged_at = iso(this.now());
      d.orchestrator.triage.by = by.address;
      this.save(d, "merge", by.address, `into ${p.id}`, null);
      if (!p.merged.includes(d.id)) p.merged.push(d.id);
      this.save(p, "merge", by.address, `absorbed ${d.id}`, null);
      return this.mustDecision(id);
    });
  }

  /**
   * The owner answered a card: the CoS gets a read-only copy with the project, the card's title and what was chosen.
   * Once per card: not for the merged duplicates the answer is copied to, and not when the CoS itself is the asker.
   */
  private copyAnswerToCos(d: Decision, what: string): void {
    const o = d.orchestrator;
    if (o.asker === "cos" || !this.agentByAddress("cos")) return;
    const from = o.origin !== o.asker ? `, first asked by ${o.origin}` : "";
    const merged = d.merged.length ? ` It also settles ${d.merged.join(", ")}.` : "";
    this.put({
      recipient: "cos",
      sender: "person",
      kind: "copy",
      ref: d.id,
      body: `${this.owner.Name} answered ${d.id} ${JSON.stringify(d.ask?.title ?? d.request.title)} (project ${d.project ?? "none"}, asked by ${o.asker}${from}): ${what}. The answer went to ${o.asker}.${merged}`,
      key: `cos-copy:${d.id}`,
      needsAck: false,
    });
  }

  /** The answer goes to the asker (the CoS gets a copy of the owner's answers); merged duplicates get a copy, each to its own asker. */
  private relay(d: Decision): void {
    const a = d.answer!;
    const what = `${a.option ? `option ${a.option} ${JSON.stringify(a.label)}` : "no option"}${a.text ? `, note: ${JSON.stringify(a.text)}` : ""}`;
    const relayHint =
      d.orchestrator.forwarded_by && d.orchestrator.origin !== d.orchestrator.asker
        ? ` It was ${d.orchestrator.origin}'s question: relay it with send(to=${JSON.stringify(d.orchestrator.origin)}, ref=${JSON.stringify(d.id)}) unless you withhold it.`
        : "";
    const it = this.put({
      recipient: d.orchestrator.asker,
      sender: a.by === "person" ? "person" : a.by,
      kind: "decision.answer",
      ref: d.id,
      body: `${JSON.stringify(d.ask?.title ?? d.request.title)} answered: ${what}.${relayHint} Close it with ack(id=${JSON.stringify(d.id)}, outcome) once acted on.`,
      key: `answer:${d.id}`,
      needsAck: true,
    });
    d.relay = { at: iso(this.now()), ok: true, to: [d.orchestrator.asker], items: [`${d.orchestrator.asker}/${it.id}`], attempts: 1, error: null };
    this.save(d, "relay", "engine", `queued: ${d.orchestrator.asker}/${it.id}`, null);
    for (const mid of d.merged) {
      const m = this.decision(mid);
      if (!m || m.state !== "merged") continue;
      if (m.kind === "plan" || m.kind !== d.kind || m.orchestrator.action !== d.orchestrator.action) continue; // never carry an answer across kinds
      m.state = "answered";
      m.answer = { ...a, via: "merged" };
      this.save(m, "answer", "engine", `copied from ${d.id}`, null);
      this.relay(m);
    }
  }

  private ackDecision(by: Agent, id: string, outcome: Closed, note: string | null): string {
    return tx(this.db, () => {
      const d = this.mustDecision(id);
      // once a lead forwarded it, the lead is the asker and alone acks it; the origin thread acks the relay item it got
      const forwarded = d.orchestrator.forwarded_by !== null && d.orchestrator.origin !== d.orchestrator.asker;
      if (by.address !== d.orchestrator.asker && (forwarded || by.address !== d.orchestrator.origin))
        throw new EngineError("forbidden", forwarded ? `only ${d.orchestrator.asker} acks ${id}; ack the relay message you got instead` : `only ${d.orchestrator.asker} or ${d.orchestrator.origin} acks ${id}`);
      // a card closed by a reply ("replied") takes the asker's real outcome when it acks after all
      if (d.state === "acked" && d.ack?.outcome !== "replied") return `${id} was already acked`;
      if (d.state !== "answered" && d.state !== "acked") throw new EngineError("bad_state", `${id} is ${d.state}: nothing to ack yet`);
      d.state = "acked";
      d.ack = { by: by.address, at: iso(this.now()), note, outcome };
      const wasDeferred = d.deferred !== null;
      d.deferred = null;
      this.save(d, "ack", by.address, `${outcome}${note ? `: ${note}` : ""}${wasDeferred ? " (acked while deferred)" : ""}`, null);
      // the acker's own answer item (and any message to it about this decision) is handled; other recipients' items aren't
      const handled = (this.db.prepare(`SELECT * FROM items WHERE recipient = ? AND ref = ? AND kind IN ('decision.answer','message') AND state IN ('pending','queued','delivered','dead')`).all(by.address, id) as ItemRow[]).map(toItem);
      this.closeItems(`recipient = ? AND ref = ? AND kind IN ('decision.answer','message')`, [by.address, id], outcome, note);
      for (const it of handled) this.ackNote(by, it, outcome, note); // a rule answer's sender (the CoS, a lead) hears the note
      return `${id} acked: ${outcome}`;
    });
  }


  /**
   * A card entering the owner's Needs you while the same lead has another card there from the same
   * project, asked under HOLD_MS ago, waits behind it: off the page and no push, so four cards in fifteen minutes
   * arrive one at a time, and a follow-up the first answer settles can be withdrawn before the owner sees it.
   */
  private upOrHold(d: Decision): void {
    const o = d.orchestrator;
    const t = this.now();
    const leader =
      o.asker.startsWith("lead:")
        ? (this.db.prepare(`SELECT json FROM decisions WHERE state = 'asked' AND at_level = 'person' AND asker = ? AND project IS ? AND id != ? ORDER BY id`).all(o.asker, d.project, d.id) as { json: string }[])
            .map((r) => JSON.parse(r.json) as Decision)
            .find((p) => !p.orchestrator.scope && !p.deferred && !p.orchestrator.held && p.ask && t - Date.parse(p.ask.at) < HOLD_MS)
        : undefined;
    if (!leader) {
      this.ports.cardUp?.(d);
      return;
    }
    o.held = { behind: leader.id, at: iso(t), until: iso(t + HOLD_MS) };
    this.save(d, "notify", "engine", `held behind ${leader.id}`, null);
  }

  /** On the clock: a held card goes up once its leader is off Needs you or its hold ran out; the rest move behind it. */
  private releaseHeld(): void {
    const t = this.now();
    const held = (this.db.prepare(`SELECT json FROM decisions WHERE state = 'asked' AND json_extract(json, '$.orchestrator.held') IS NOT NULL ORDER BY id`).all() as { json: string }[]).map(
      (r) => JSON.parse(r.json) as Decision,
    );
    const released = new Map<string, string>(); // leader id -> the card that took its place
    for (const d of held) {
      tx(this.db, () => {
        const h = d.orchestrator.held!;
        const behind = released.get(h.behind) ?? h.behind;
        const leader = this.decision(behind);
        const waiting = leader !== null && leader.state === "asked" && !leader.deferred && (!leader.orchestrator.held || released.has(h.behind));
        if (waiting && t < Date.parse(h.until)) {
          if (behind !== h.behind) {
            d.orchestrator.held = { ...h, behind };
            this.save(d, "notify", "engine", `held behind ${behind}`, null);
          }
          return;
        }
        d.orchestrator.held = null;
        d.ask!.at = iso(t);
        this.save(d, "notify", "engine", waiting ? "hold ran out" : `${behind} is off Needs you`, null);
        if (!waiting) released.set(h.behind, d.id);
        this.ports.cardUp?.(d);
      });
    }
  }

  /**
   * The deterministic gate, where a card enters the CoS's triage: one that can't be good is refused to its asker at once,
   * with what to fix, and never reaches the CoS or the owner. Judgment calls (no where, no how, a stale claim) are the
   * CoS's: triage(bounce).
   */
  private gate(d: Decision): void {
    const r = d.request;
    for (const b of r.blocks ?? []) if (b.kind === "command" && !b.where?.trim()) throw new EngineError("invalid", `a command block needs where: where it runs (runner, Mac, prod) and in which terminal or settings file`);
    const labels = r.options.map((o) => o.label.trim().toLowerCase());
    if (new Set(labels).size !== labels.length) throw new EngineError("invalid", "two options have the same label: say how they differ");
    if (d.request_key) {
      const prior = (this.db.prepare(`SELECT json FROM decisions WHERE json_extract(json, '$.request_key') = ? AND project IS ? AND state IN ('answered','acked') AND updated_at >= ? ORDER BY updated_at DESC`).all(d.request_key, d.project, this.now() - KEY_REUSE_MS) as { json: string }[])
        .map((x) => JSON.parse(x.json) as Decision)
        .find((p) => p.answer?.by === "person");
      if (prior) {
        const a = prior.answer!;
        throw new EngineError(
          "bad_state",
          `${this.owner.name} answered ${prior.id} with key ${d.request_key} ${ago(this.now() - Date.parse(a.at))} ago: ${a.label ? JSON.stringify(a.label) : ""}${a.text ? ` ${JSON.stringify(a.text.slice(0, 200))}` : ""}. Act on that answer; if something changed since, ask with a new key and say in the question what changed`,
        );
      }
    }
  }

  /**
   * The CoS sends a card back to its asker instead of on to the owner (no where or how, a claim it knows is stale, a
   * step the asker can take itself). Withdrawn with the reason, never answered; the asker is told what to fix, and
   * cards merged into it go back too.
   */
  triageBounce(by: Agent, id: string, reason: string, revision?: number): Decision {
    const why = oneLine(reason ?? "", 300, "the reason (note)");
    return tx(this.db, () => {
      const d = this.cosDecision(by, id, revision);
      this.bounceOne(d, why, by.address);
      for (const mid of d.merged) {
        const m = this.decision(mid);
        if (m && m.state === "merged") this.bounceOne(m, `${d.id}, which it was merged into, went back: ${why}`, by.address);
      }
      return this.mustDecision(id);
    });
  }

  private bounceOne(d: Decision, why: string, by: string): void {
    const t = iso(this.now());
    d.state = "withdrawn";
    d.withdrawn = { by, at: t, reason: why, bounced: true };
    d.orchestrator.triage.triaged_at ??= t;
    d.orchestrator.triage.by ??= by;
    this.save(d, "withdraw", by, `bounced: ${why}`, null);
    const o = d.orchestrator;
    if (!this.agentByAddress(o.asker)) return;
    const relayHint = o.forwarded_by && o.origin !== o.asker ? ` It was ${o.origin}'s question: tell it, or settle it yourself.` : "";
    this.put({
      recipient: o.asker,
      sender: by,
      kind: "notice",
      ref: d.id,
      body: `${by} sent ${d.id} ${JSON.stringify(d.request.title)} back instead of on to ${this.owner.name}: ${JSON.stringify(why)}. Fix that and ask again with a new card (orch_ask); this one is closed and no answer will come.${relayHint}`,
      key: `bounce:${d.id}`,
      needsAck: false,
    });
  }


  /**
   * The CoS takes a card off the owner's Needs you because it no longer needs an answer (the PR merged, the asker
   * found out). It is withdrawn with the reason, never answered: a plan's go or a merge card's yes can't come from it.
   * The asker hears why; cards merged into it go too, each asker told. A later answer is refused with the reason.
   */
  moot(by: Agent, id: string, reason: string): Decision {
    if (by.role !== "cos") throw new EngineError("forbidden", "only the CoS marks a card moot");
    const why = oneLine(reason ?? "", 300, "reason");
    return tx(this.db, () => {
      const d = this.mustDecision(id);
      if (d.orchestrator.at_level === "lead") throw new EngineError("bad_state", `${id} is with ${d.orchestrator.asker}'s lead, not on ${this.owner.name}'s Needs you`);
      if (d.orchestrator.scope) throw new EngineError("forbidden", `${id} waits in ${this.owner.name}'s Scope pane (${this.scopeWhy(d.project, d.orchestrator.scope_task)}), not on Needs you: your copy is read-only`);
      if (d.state !== "open" && d.state !== "asked") throw new EngineError("bad_state", `${id} is ${d.state}${d.withdrawn?.moot ? " (already moot)" : ""}: only an open card can be moot`);
      this.mootOne(d, why, by.address);
      for (const mid of d.merged) {
        const m = this.decision(mid);
        if (m && m.state === "merged") this.mootOne(m, `${d.id}, which it was merged into, is moot: ${why}`, by.address);
      }
      this.releaseHeld();
      return this.mustDecision(id);
    });
  }

  private mootOne(d: Decision, why: string, by: string): void {
    const t = iso(this.now());
    d.state = "withdrawn";
    d.withdrawn = { by, at: t, reason: why, moot: true };
    d.deferred = null;
    d.orchestrator.triage.triaged_at ??= t;
    d.orchestrator.triage.by ??= by;
    this.save(d, "withdraw", by, `moot: ${why}`, null);
    const o = d.orchestrator;
    if (o.asker === by || !this.agentByAddress(o.asker)) return; // "orchestrator" (a dream card) reads the state itself
    const relayHint = o.forwarded_by && o.origin !== o.asker ? ` It was ${o.origin}'s question: tell it.` : "";
    this.put({
      recipient: o.asker,
      sender: by,
      kind: "notice",
      ref: d.id,
      body: `${by} marked ${d.id} ${JSON.stringify(d.ask?.title ?? d.request.title)} moot: ${JSON.stringify(why)}. It is off ${this.owner.name}'s Needs you and no answer will come; don't wait on it.${relayHint}`,
      key: `moot:${d.id}`,
      needsAck: false,
    });
  }

  /** The owner's writes on a moot card are refused with the CoS's reason (before the rev check: the moot bumped it). */
  private refuseMoot(d: Decision): void {
    if (d.withdrawn?.moot) throw new EngineError("bad_state", `${d.id} was marked moot by ${d.withdrawn.by} (${d.withdrawn.reason}); it is off Needs you and nothing was sent`);
  }


  personAnswer(id: string, rev: number, option: string | null, text: string | null, via: "desktop" | "phone" | "voice"): Decision {
    return tx(this.db, () => {
      const d = this.mustDecision(id);
      this.refuseMoot(d);
      if (d.rev !== rev) throw new EngineError("conflict", `${id} changed since you saw it`);
      if (d.state !== "asked" || !d.ask) throw new EngineError("bad_state", `${id} is ${d.state}`);
      const t = text?.trim() || null;
      const opt = option === null ? null : d.ask.options.find((o) => o.id === option);
      if (option !== null && !opt) throw new EngineError("invalid", `no option ${option}`);
      if (!opt && !t) throw new EngineError("invalid", "pick an option or write a note");
      if (!opt && !d.ask.allow_text) throw new EngineError("invalid", "this question needs an option");
      d.state = "answered";
      d.answer = { option: opt?.id ?? null, label: opt?.label ?? null, text: t, by: "person", via, at: iso(this.now()), source: "bb-orchestrator" };
      const wasDeferred = d.deferred !== null;
      d.deferred = null;
      const proposal = d.orchestrator.rule_proposal;
      if (proposal && opt?.id === "1") {
        const r = this.addRule({ text: proposal.text, project: proposal.project, kinds: proposal.kinds ?? ["question"], expiresAt: null, source: proposal.evidence.length ? `card ${d.id}, from ${proposal.evidence.length} of ${this.owner.name}'s answers` : `card ${d.id}, from ${this.owner.name}'s words`, match: proposal.match });
        proposal.rule_id = r.id;
      }
      this.save(d, "answer", "person", wasDeferred ? "answered while deferred" : proposal?.rule_id ? `rule ${proposal.rule_id} added` : null, rev);
      this.relay(d);
      this.copyAnswerToCos(d, `option ${opt ? `${opt.id} ${JSON.stringify(opt.label)}` : "none"}${t ? `, note: ${JSON.stringify(t)}` : ""}`);
      // "Scoping done?": only option 1 is the yes; "Not yet" or a note alone keeps scoping (the note went to the lead). A
      // task's closes only that task; the project's mode and its other tasks stay as they are.
      const sd = d.orchestrator.scoping_done;
      if (sd && d.project && opt?.id === "1") {
        if (sd.task) this.closeTask(sd.task, "done", "person", d.id, sd.summary, sd.doc ?? null);
        else this.setMode(d.project, "active", "person", d.id);
      }
      if (d.orchestrator.board_review) this.settleBoardCard(d);
      if (proposal?.rule_id) this.put({ recipient: "cos", sender: "person", kind: "notice", ref: d.id, body: `Rule ${proposal.rule_id} is live: ${JSON.stringify(proposal.text)}. It settles the cards it matches by itself; you hear about each one.`, key: `rule-live:${d.id}`, needsAck: false });
      this.offerRule(d);
      this.releaseHeld();
      return this.mustDecision(id);
    });
  }

  /**
   * The owner pasted a sign-in code into a login block's masked field (blocks.ts, paste). The server has already written it to
   * `file` (0600); the decision records only that path, never the code, and the asker reads the file straight into its
   * command. The file goes when the asker acks, or after SECRET_TTL_MS.
   */
  /** `typed`: the code came through "Other" (looksLikeCode), so the card needn't have asked for one with a login block. */
  personSecret(id: string, rev: number, file: string, via: "desktop" | "phone" | "voice", typed = false): Decision {
    return tx(this.db, () => {
      const d = this.mustDecision(id);
      this.refuseMoot(d);
      if (d.rev !== rev) throw new EngineError("conflict", `${id} changed since you saw it`);
      if (d.state !== "asked" || !d.ask) throw new EngineError("bad_state", `${id} is ${d.state}`);
      if (!typed && !(d.request.blocks ?? []).some((b) => b.kind === "login" && b.paste)) throw new EngineError("invalid", `${id} doesn't ask for a code`);
      const text = `${this.owner.Name} pasted the code. It is in ${file} (only this user can read it). Read it straight into the command (for example \`cmd < ${file}\`); never print it or copy it into a message, file or commit. It is deleted when you ack this, or after ${Math.round(SECRET_TTL_MS / 60000)} min.`;
      d.state = "answered";
      d.answer = { option: null, label: null, text, by: "person", via, at: iso(this.now()), source: "bb-orchestrator" };
      const wasDeferred = d.deferred !== null;
      d.deferred = null;
      this.save(d, "answer", "person", wasDeferred ? "code sent while deferred" : "code sent", rev);
      this.relay(d);
      this.copyAnswerToCos(d, "pasted a sign-in code (it went to the asker as a file)"); // never the file's path
      this.releaseHeld();
      return this.mustDecision(id);
    });
  }

  personDefer(id: string, rev: number, preset: string, until: number | null, via: "desktop" | "phone" | "voice"): Decision {
    return tx(this.db, () => {
      const d = this.mustDecision(id);
      this.refuseMoot(d);
      if (d.rev !== rev) throw new EngineError("conflict", `${id} changed since you saw it`);
      if (d.state !== "asked") throw new EngineError("bad_state", `${id} is ${d.state}`);
      const it = this.put({
        recipient: d.orchestrator.asker,
        sender: "person",
        kind: "decision.deferred",
        ref: d.id,
        body: `${this.owner.Name} deferred ${JSON.stringify(d.ask?.title ?? d.request.title)} ${until === null ? "until it is brought back" : `until ${iso(until)}`}. Don't wait on it.`,
        key: `defer:${d.id}:${rev}`,
        needsAck: false,
      });
      d.deferred = { until: until === null ? null : iso(until), preset, by: "person", via, source: "bb-orchestrator", at: iso(this.now()), rev: rev + 1, item: `${d.orchestrator.asker}/${it.id}` };
      this.save(d, "defer", "person", until === null ? "until brought back" : `until ${iso(until)}`, rev);
      this.releaseHeld();
      return this.mustDecision(id);
    });
  }

  personReturn(id: string, rev: number | null, by: "person" | "engine" = "person"): Decision {
    return tx(this.db, () => {
      const d = this.mustDecision(id);
      this.refuseMoot(d);
      if (rev !== null && d.rev !== rev) throw new EngineError("conflict", `${id} changed since you saw it`);
      if (!d.deferred) throw new EngineError("bad_state", `${id} isn't deferred`);
      d.deferred = null;
      d.returned = { at: iso(this.now()), by, why: by === "engine" ? "time" : "brought back", source: by === "person" ? "bb-orchestrator" : null };
      this.save(d, "return", by, null, rev);
      if (by === "engine" && !d.orchestrator.scope) this.ports.cardUp?.(d);
      return this.mustDecision(id);
    });
  }


  addRule(p: { text: string; project: string | null; kinds: string[]; expiresAt: number | null; source: string; match?: RuleMatch | null }): Rule {
    // a practice settles nothing, so it never shares a row with the kinds that settle, nor matches cards
    if (p.kinds.includes("practice") && (p.kinds.some((k) => k !== "practice") || p.match)) throw new EngineError("invalid", "a practice stands alone: its only kind is practice (never with question or plan), and it matches no cards");
    const kinds = p.kinds.includes("practice") ? ["practice"] : p.kinds.filter((k) => k === "question" || k === "plan");
    if (kinds.length === 0) throw new EngineError("invalid", "a rule covers questions and/or plans (never merges), or is a practice");
    if (p.project !== null && !PROJECT_RE.test(p.project)) throw new EngineError("invalid", `bad project ${p.project}`);
    const id = `r-${hex(3)}`;
    this.db
      .prepare(`INSERT INTO rules (id, text, project, kinds, expires_at, granted_by, source, created_at, match) VALUES (?, ?, ?, ?, ?, 'person', ?, ?, ?)`)
      .run(id, oneLine(p.text, 300, "rule text"), p.project, JSON.stringify(kinds), p.expiresAt, oneLine(p.source, 200, "source"), this.now(), p.match ? JSON.stringify(p.match) : null);
    this.ports.changed();
    return this.rules().find((r) => r.id === id)!;
  }

  revokeRule(id: string): void {
    this.db.prepare(`UPDATE rules SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(this.now(), id);
    this.ports.changed();
  }

  rules(): Rule[] {
    return (this.db.prepare(`SELECT * FROM rules ORDER BY created_at DESC`).all() as RuleRow[]).map(toRule);
  }

  liveRules(project: string | null): Rule[] {
    return this.allLiveRules().filter((r) => r.project === null || r.project === project);
  }

  /** Every rule not revoked or expired, whatever its project. */
  private allLiveRules(): Rule[] {
    const t = this.now();
    return this.rules().filter((r) => r.revokedAt === null && (r.expiresAt === null || r.expiresAt > t));
  }

  // After the owner answers a card, the engine looks for earlier cards they answered the same way (rules.ts sameWay).
  // The CoS is offered a rule once per set of cards; it proposes one with triage(propose_rule), the owner gets one
  // "Make this a rule?" card, and their yes adds the rule, which then settles the cards it matches (ruleSettles).

  /** The owner's answered cards in `grp` over the last OFFER_DAYS, as offers compare them. */
  private answeredShapes(except: string | null): { shape: Shape; d: Decision }[] {
    const since = this.now() - OFFER_DAYS * 86_400_000;
    return (this.db.prepare(`SELECT json FROM decisions WHERE state IN ('answered','acked') AND updated_at >= ? ORDER BY id`).all(since) as { json: string }[])
      .map((r) => JSON.parse(r.json) as Decision)
      .filter((d) => d.id !== except)
      .flatMap((d) => {
        const shape = shapeOf(d);
        return shape ? [{ shape, d }] : [];
      });
  }

  /** Every card the owner answered with an option in `grp` over the last OFFER_DAYS, evidence or not. */
  private answeredInGroup(grp: string): Decision[] {
    const since = this.now() - OFFER_DAYS * 86_400_000;
    return (this.db.prepare(`SELECT json FROM decisions WHERE state IN ('answered','acked') AND updated_at >= ? ORDER BY id`).all(since) as { json: string }[])
      .map((r) => JSON.parse(r.json) as Decision)
      .filter((d) => d.answer?.by === "person" && d.answer.option && d.kind === "question" && !d.orchestrator.rule_proposal && (d.project !== null ? `project:${d.project}` : `asker:${d.orchestrator.origin}`) === grp);
  }

  private offerRule(d: Decision): void {
    const s = shapeOf(d);
    if (!s || !this.agentByAddress("cos")) return;
    const earlier = this.answeredShapes(d.id).filter((x) => x.shape.group === s.group);
    const ev = offerFor(s, earlier.map((x) => x.shape));
    if (!ev) return;
    const ids = ev.map((e) => e.id);
    const prior = (this.db.prepare(`SELECT evidence FROM rule_offers WHERE grp = ?`).all(s.group) as { evidence: string }[]).flatMap((r) => JSON.parse(r.evidence) as string[]);
    if (ids.some((id) => prior.includes(id))) return; // these cards were offered already
    const cards = [...earlier.filter((x) => ids.includes(x.shape.id)).map((x) => x.d), d];
    const suggested = suggestMatch(cards);
    const offerId = `ro-${hex(4)}`;
    this.db.prepare(`INSERT INTO rule_offers (id, grp, evidence, suggested, at) VALUES (?, ?, ?, ?, ?)`).run(offerId, s.group, JSON.stringify(ids), JSON.stringify(suggested), this.now());
    const fits = cards.filter((c) => {
      const m = matchRule(suggested, c);
      return "option" in m && m.option === ownerPick(c);
    });
    const lines = cards.map((c) => `- ${c.id} ${JSON.stringify(c.request.title)}: ${JSON.stringify(c.answer!.label)}`);
    const how = suggested.option.length
      ? `A rule would settle cards from ${suggested.from.join(" or ")} whose title and question say ${suggested.words.map((w) => JSON.stringify(w)).join(", ") || "(nothing in common)"}${suggested.key_prefix ? ` with a key starting ${suggested.key_prefix}` : ""}, with the option saying ${JSON.stringify(suggested.option.join(" "))}. It fits ${fits.length} of these ${cards.length}.`
      : `Their answers share no words, so no rule can name the option for all of them; a narrower rule needs its own rule.option words.`;
    this.put({
      recipient: "cos",
      sender: "engine",
      kind: "notice",
      ref: d.id,
      key: `rule-offer:${offerId}`,
      needsAck: true,
      body:
        `Rule offer ${offerId}: ${this.owner.name} answered ${cards.length} cards (${s.group.startsWith("project:") ? `project ${s.group.slice("project:".length)}` : `from ${s.group.slice("asker:".length)}`}) the same way:\n${lines.join("\n")}\n${how}\n` +
        `If the next ones should be settled without ${this.owner.name}, propose it: triage(action=propose_rule, id=${JSON.stringify(d.id)}, note=<the rule in one line, at most 120 characters>), ` +
        `optionally rule={from, words, without, key_prefix, option} to narrow it. ${this.owner.Name} gets one "Make this a rule?" card. Propose a rule, or ack this offer with outcome="refused" and a note for one-offs.`,
    });
  }

  /**
   * The CoS proposes a rule from an offer's cards: one "Make this a rule?" card for the owner. Refused unless the rule
   * fits at least 2 of the cards it comes from, and never when it would answer one of the owner's recent cards
   * differently from how they did.
   */
  proposeRule(by: Agent, evidenceId: string, text: string, given: Partial<RuleMatch> | null): Decision {
    if (by.role !== "cos") throw new EngineError("forbidden", "only the CoS proposes a rule");
    const ruleText = oneLine(text ?? "", 120, "rule text (the note)");
    return tx(this.db, () => {
      const offer = (this.db.prepare(`SELECT * FROM rule_offers ORDER BY at DESC`).all() as { id: string; grp: string; evidence: string; suggested: string }[]).find((o) =>
        (JSON.parse(o.evidence) as string[]).includes(evidenceId),
      );
      if (!offer) throw new EngineError("invalid", `${evidenceId} isn't in a rule offer: propose a rule only from an offer's cards`);
      const suggested = JSON.parse(offer.suggested) as RuleMatch;
      const evidence = (JSON.parse(offer.evidence) as string[]).map((id) => this.mustDecision(id));
      // The stop words it lets through come from the evidence alone (checkMatch drops any the CoS gives).
      const match: RuleMatch = { ...checkMatch(given ? { ...suggested, ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) } : suggested), allow: allowFrom(evidence) };
      for (const d of this.answeredInGroup(offer.grp)) {
        if (ownerPick(d) === null && "option" in matchRule(match, d))
          throw new EngineError("forbidden", `the rule matches ${d.id} ${JSON.stringify(d.request.title)}, where it can't be told which of the asker's options ${this.owner.name} chose: narrow it (rule.words, rule.without)`);
      }
      for (const { d } of this.answeredShapes(null).filter((x) => x.shape.group === offer.grp)) {
        const m = matchRule(match, d);
        if ("option" in m && m.option !== ownerPick(d))
          throw new EngineError("forbidden", `the rule would answer ${d.id} ${JSON.stringify(d.request.title)} with option ${m.option}, but ${this.owner.name} chose ${JSON.stringify(d.answer!.label)}: narrow it (rule.words, rule.without)`);
      }
      const misses: string[] = [];
      const fits = evidence.filter((c) => {
        const m = matchRule(match, c);
        if ("miss" in m) misses.push(`${c.id}: ${m.miss}`);
        return "option" in m && m.option === ownerPick(c);
      });
      if (fits.length < 2) throw new EngineError("invalid", `the rule fits ${fits.length} of the ${evidence.length} cards it comes from; it needs 2 (${misses.join("; ")})`);
      const key = `rule-proposal:${offer.id}`;
      const dup = this.db.prepare(`SELECT id FROM decisions WHERE asker = 'cos' AND json_extract(json, '$.request_key') = ? AND state IN ('open','asked')`).get(key) as { id: string } | undefined;
      if (dup) {
        this.closeItems(`recipient = 'cos' AND send_key = ?`, [`rule-offer:${offer.id}`], "done", `proposed as ${dup.id}`);
        return this.mustDecision(dup.id);
      }
      const project = offer.grp.startsWith("project:") ? offer.grp.slice("project:".length) : null;
      const t = this.now();
      const options: Opt[] = [
        { id: "1", label: "Make it a rule", detail: "Matching cards are settled without you; revoke it on the Rules tab" },
        { id: "2", label: "No rule", detail: "Keep sending me these cards" },
      ];
      const context =
        `It settles cards from ${match.from.join(" or ")} whose title and question say ${match.words.map((w) => JSON.stringify(w)).join(", ") || "anything"}` +
        `${match.key_prefix ? ` (key ${match.key_prefix}…)` : ""}, with the option saying ${JSON.stringify(match.option.join(" "))}. ` +
        `Never a merge, a plan or a sign-in, nor a card that says production, deploy, delete, access or spend anywhere on it` +
        `${match.allow!.length ? ` (except ${match.allow!.map((x) => `${JSON.stringify(x.word.replace(/\*$/, ""))} in ${x.field === "label" || x.field === "detail" ? `an option's ${x.field}` : `the ${x.field}`}`).join(", ")}, as on every card below)` : ""}` +
        `${match.without.length ? `, or that mentions ${match.without.join(", ")}` : ""}. It fits ${fits.length} of the ${evidence.length} cards below.`;
      const question = `Make this a standing rule? ${ruleText}`;
      const d: Decision = {
        schema: 1,
        id: decisionId(t),
        rev: 0,
        state: "open",
        kind: "question",
        created_at: iso(t),
        updated_at: iso(t),
        project,
        request_key: key,
        request: {
          by: { role: "cos", project: null, thread: by.threadId, terminal: null, machine: null, address: "cos" },
          title: "Make this a rule?",
          question,
          context: context.slice(0, 600),
          options,
          blocks: [{ kind: "list", title: `Your answers (${evidence.length})`, items: evidence.slice(0, 50).map((c) => ({ label: c.request.title, meta: `You chose: ${c.answer!.label ?? ""}`.slice(0, 80) })) }],
        },
        reply_to: { labels: { "orchestrator.address": "cos" }, terminal: null, machine: null },
        ask: null,
        answer: null,
        relay: null,
        ack: null,
        cos_notified_at: null,
        owed_from: null,
        merged_into: null,
        merged: [],
        withdrawn: null,
        deferred: null,
        returned: null,
        history: [],
        orchestrator: {
          at_level: "person",
          asker: "cos",
          origin: "cos",
          action: null,
          triage: { filed_at: null, due_at: null, triaged_at: iso(t), by: "cos", escalated_at: null },
          forwarded_by: null,
          plan: null,
          rule_proposal: { text: ruleText, project, match, evidence: evidence.map((c) => c.id), rule_id: null },
        },
      };
      this.save(d, "add", "cos", `rule offer ${offer.id}`, null);
      this.putAsk(d, "cos", d.request.title, question, d.request.context, options, false);
      this.save(d, "ask", "cos", null, null);
      this.ports.cardUp?.(d);
      this.closeItems(`recipient = 'cos' AND send_key = ?`, [`rule-offer:${offer.id}`], "done", `proposed as ${d.id}`);
      return this.mustDecision(d.id);
    });
  }

  /**
   * The CoS proposes a standing instruction the owner stated in their own words (chat, a card note). By default it is a
   * practice: leads, the CoS and threads follow it, and it settles no card. Only one that really settles plan decisions
   * is a plan rule (it lets the CoS approve the plan cards it covers), and its card says so. The card's
   * question carries the whole text, so the owner approves exactly what is saved.
   */
  proposeStatedRule(by: Agent, text: string, quote: string, project: string | null = null, kind: "practice" | "plan" = "practice"): Decision {
    if (by.role !== "cos") throw new EngineError("forbidden", "only the CoS proposes a rule");
    if (kind !== "practice" && kind !== "plan") throw new EngineError("invalid", `kind is practice or plan, not ${kind}`);
    const ruleText = oneLine(text ?? "", 120, "rule text");
    const ownerQuote = (quote ?? "").trim().slice(0, 600);
    if (!ownerQuote) throw new EngineError("invalid", "quote is empty");
    if (project !== null && !PROJECT_RE.test(project)) throw new EngineError("invalid", `bad project ${project}`);
    const normalized = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
    const key = `rule-stated:${createHash("sha256").update(JSON.stringify([normalized(ruleText), project, kind])).digest("hex")}`;
    return tx(this.db, () => {
      if (this.rules().some((r) => r.revokedAt === null && (r.expiresAt === null || r.expiresAt > this.now()) && r.project === project && normalized(r.text) === normalized(ruleText)))
        throw new EngineError("invalid", "an active rule already has this text and project");
      const dup = this.db.prepare(`SELECT id FROM decisions WHERE asker = 'cos' AND json_extract(json, '$.request_key') = ? AND state IN ('open','asked')`).get(key) as { id: string } | undefined;
      if (dup) return this.mustDecision(dup.id);
      const t = this.now();
      const practice = kind === "practice";
      const options: Opt[] = practice
        ? [{ id: "1", label: "Make it a practice", detail: "Add it to Rules: agents follow it; it settles no card" }, { id: "2", label: "No", detail: "Leave it off Rules" }]
        : [{ id: "1", label: "Make it a rule", detail: "Add it to Rules: the CoS may approve the plans it covers" }, { id: "2", label: "No rule", detail: "Leave it off Rules" }];
      // never cut: the text is at most 120 characters, so the question shows all of it
      const question = practice ? `Make this a standing practice? ${ruleText}` : `Make this a plan rule? ${ruleText}`;
      const what = practice ? "A practice: leads, the CoS and threads follow it; it settles no card." : "A plan rule: the CoS may approve the plan cards it covers without you.";
      const context = `${what}\n\nYour words: ${JSON.stringify(ownerQuote)}`;
      const d: Decision = {
        schema: 1,
        id: decisionId(t),
        rev: 0,
        state: "open",
        kind: "question",
        created_at: iso(t),
        updated_at: iso(t),
        project,
        request_key: key,
        request: {
          by: { role: "cos", project: null, thread: by.threadId, terminal: null, machine: null, address: "cos" },
          title: practice ? "Make this a practice?" : "Make this a rule?",
          question,
          context,
          options,
          blocks: [],
        },
        reply_to: { labels: { "orchestrator.address": "cos" }, terminal: null, machine: null },
        ask: null,
        answer: null,
        relay: null,
        ack: null,
        cos_notified_at: null,
        owed_from: null,
        merged_into: null,
        merged: [],
        withdrawn: null,
        deferred: null,
        returned: null,
        history: [],
        orchestrator: {
          at_level: "person",
          asker: "cos",
          origin: "cos",
          action: null,
          triage: { filed_at: null, due_at: null, triaged_at: iso(t), by: "cos", escalated_at: null },
          forwarded_by: null,
          plan: null,
          rule_proposal: { text: ruleText, project, match: null, evidence: [], kinds: [kind], rule_id: null },
        },
      };
      this.save(d, "add", "cos", "stated rule", null);
      this.putAsk(d, "cos", d.request.title, question, context, options, false);
      this.save(d, "ask", "cos", null, null);
      this.ports.cardUp?.(d);
      return this.mustDecision(d.id);
    });
  }


  boardAdd(kind: string, from: string | null, project: string | null, title: string, body: string, ref: string | null): void {
    this.db.prepare(`INSERT INTO board (id, kind, from_address, project, title, body, ref, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(`b-${hex(6)}`, kind, from, project, title.slice(0, 200), body.slice(0, 8000), ref, this.now());
    this.ports.changed();
  }

  board(limit = 200): BoardRow[] {
    return (this.db.prepare(`SELECT * FROM board ORDER BY at DESC, rowid ASC LIMIT ?`).all(limit) as { id: string; kind: string; from_address: string | null; project: string | null; title: string; body: string; ref: string | null; at: number }[]).map((r) => ({
      id: r.id,
      kind: r.kind,
      from: r.from_address,
      project: r.project,
      title: r.title,
      body: r.body,
      ref: r.ref,
      at: r.at,
    }));
  }

  /** The title of the last report an address filed (orch_report), for the Projects tab's lanes. */
  lastReport(address: string): string | null {
    const r = this.db.prepare(`SELECT title FROM board WHERE from_address = ? AND kind IN ('report', 'pr') ORDER BY at DESC LIMIT 1`).get(address) as { title: string } | undefined;
    return r?.title ?? null;
  }

  /** `ref`: the lead's message this report answers, which it closes as replied (a reply counts as the ack). */
  report(by: Agent, title: string, body: string, pr: string | null, ref: string | null = null): string {
    return tx(this.db, () => {
      this.boardAdd(pr ? "pr" : "report", by.address, by.project, oneLine(title, 120, "title"), body, pr);
      if (by.role !== "thread") return "On the board.";
      // a reported PR belongs to the thread's task even if bb never reads it: unread, it keeps the task off Shipped
      if (pr) linkPr(this.db, pr, addressTask(this.db, by.address), "report", by.address, this.now());
      const lead = `lead:${by.project}`;
      const it = this.put({ recipient: lead, sender: by.address, kind: "notice", ref: ref?.startsWith("i-") ? ref : null, body: `report: ${JSON.stringify(title)}${pr ? ` (${pr})` : ""}. It is on the board.`, needsAck: false });
      // a report wakes its lead: new threads' turn ends do not (parentNotifications "stuck")
      if (this.settings.batchInbox) this.batch.policy(it.id, { severity: "ACTION" });
      const closed = this.replyCloses(by, lead, ref?.trim() || null, { id: it.id, body: `report ${JSON.stringify(title)}${pr ? ` (${pr})` : ""}: ${body}` });
      return `On the board and sent to your lead.${closed ? ` It closes ${closed.id} as replied.` : ""}`;
    });
  }

  /** wake: an ACTION notice (a failure, a thread blocked on a prompt); a plain turn end stays INFO, for the next digest. */
  notifySupervisor(a: Agent, body: string, wake = false, key: string | null = null): void {
    const sup = this.supervisorOf(a);
    if (!sup || !this.agentByAddress(sup)) return;
    const it = this.put({ recipient: sup, sender: "orchestrator", kind: "notice", ref: null, body: `${a.address}: ${body}`, key, needsAck: false });
    if (wake && this.settings.batchInbox) this.batch.policy(it.id, { severity: "ACTION" });
  }

  alarm(level: string, snapshot: Record<string, unknown>, summary: string): Item | null {
    const steward = this.agentByAddress("steward");
    const id = `a-${hex(4)}`;
    let it: Item | null = null;
    if (steward) it = this.put({ recipient: "steward", sender: "orchestrator", kind: "alarm", ref: id, body: `${summary} Snapshot: ${JSON.stringify(snapshot)}`, needsAck: false });
    this.db.prepare(`INSERT INTO alarms (id, level, snapshot, at, item_id) VALUES (?, ?, ?, ?, ?)`).run(id, level, JSON.stringify(snapshot), this.now(), it?.id ?? null);
    this.boardAdd("alarm", "orchestrator", null, summary, JSON.stringify(snapshot), id);
    return it;
  }

  lastAlarmLevel(): string | null {
    const r = this.db.prepare(`SELECT level FROM alarms ORDER BY at DESC LIMIT 1`).get() as { level: string } | undefined;
    return r?.level ?? null;
  }



  ensureProject(slug: string, bbProjectId: string | null): void {
    this.db.prepare(`INSERT OR IGNORE INTO projects (slug, bb_project_id, created_at) VALUES (?, ?, ?)`).run(slug, bbProjectId, this.now());
    if (bbProjectId) this.db.prepare(`UPDATE projects SET bb_project_id = ? WHERE slug = ? AND bb_project_id IS NULL`).run(bbProjectId, slug);
  }

  project(slug: string): ProjectRow | null {
    const r = this.db.prepare(`SELECT * FROM projects WHERE slug = ?`).get(slug) as ProjectDbRow | undefined;
    return r ? toProjectRow(r) : null;
  }

  projects(): ProjectRow[] {
    const rank = (p: string) => PRIORITIES.indexOf(p as Priority);
    return (this.db.prepare(`SELECT * FROM projects`).all() as ProjectDbRow[])
      .map(toProjectRow)
      .sort((a, b) => rank(a.priority) - rank(b.priority) || a.slug.localeCompare(b.slug));
  }

  /**
   * A new project's row (orch_new_project), with its priority and one board notice. Refused when the slug already has
   * a row, archived or not: a new project never takes over an old one's history.
   */
  createProject(slug: string, priority: Priority, by: string, title: string, body: string, mode: ProjectMode = "active"): void {
    if (!PROJECT_RE.test(slug)) throw new EngineError("invalid", `bad project slug ${slug}`);
    if (!PRIORITIES.includes(priority)) throw new EngineError("invalid", `priority is one of ${PRIORITIES.join(", ")}`);
    if (!PROJECT_MODES.includes(mode)) throw new EngineError("invalid", `mode is one of ${PROJECT_MODES.join(", ")}`);
    tx(this.db, () => {
      if (this.project(slug)) throw new EngineError("conflict", `${slug} is already a project`);
      this.db.prepare(`INSERT INTO projects (slug, bb_project_id, priority, created_at, mode) VALUES (?, NULL, ?, ?, ?)`).run(slug, priority, this.now(), mode);
      if (mode === "scoping") this.event({ kind: "mode", project: slug, address: `lead:${slug}`, threadId: null, value: mode, note: by });
      this.boardAdd("notice", by, slug, title, body, null);
    });
  }

  // While a project is scoping, the owner works its scope out with its lead directly, in the Scope tab: the lead's cards
  // (questions, plans) and deliverables go only there. They skip the CoS's triage and Needs you, no standing rule settles
  // them, and the CoS gets a read-only copy of each. The lead proposes the end with a "Scoping done?" card; the owner's
  // yes (or the CoS's orch_project_mode) makes the project active, and what still waits in the pane moves to the
  // normal places then, so nothing is stranded in neither.

  isScoping(project: string | null): boolean {
    return !!project && this.project(project)?.mode === "scoping";
  }

  /**
   * Set a project's mode (the CoS's orch_project_mode, or the owner's yes on "Scoping done?" with `card`). A timeline event
   * and a board notice record it; the lead is told what changed, and the CoS gets a copy unless it made the change. Going
   * active releases the pane: its open cards go to Needs you and its deliverables in review to Deliverables, and an
   * open "Scoping done?" card that didn't make the change is withdrawn (nothing left to decide). Same mode: a no-op.
   */
  setMode(slug: string, mode: ProjectMode, by: string, card: string | null = null): ProjectRow {
    if (!PROJECT_MODES.includes(mode)) throw new EngineError("invalid", `mode is one of ${PROJECT_MODES.join(", ")}`);
    return tx(this.db, () => {
      const p = this.project(slug);
      if (!p) throw new EngineError("not_found", `no project ${slug}`);
      if (p.archivedAt) throw new EngineError("bad_state", `${slug} is archived`);
      if (p.mode === mode) return p;
      this.db.prepare(`UPDATE projects SET mode = ? WHERE slug = ?`).run(mode, slug);
      this.event({ kind: "mode", project: slug, address: `lead:${slug}`, threadId: null, value: mode, note: by, ref: card });
      const o = this.owner;
      const who = by === "person" ? o.Name : by;
      // what waits under a scoping task still open stays: the task is scoped on its own
      const moved = mode === "active" ? this.releaseScope(slug, (task) => !task || this.task(task)?.state !== "scoping", by, card, `${slug} is active now (${who} ended scoping)`) : 0;
      const what =
        mode === "scoping"
          ? `${slug} is scoping: its lead's cards and deliverables go only to ${o.name}'s Scope pane, and no standing rule settles them.`
          : `${slug} is active: scoping is done and its cards go the normal way (CoS triage, Needs you).${moved ? ` ${moved} still open moved from the Scope pane.` : ""}`;
      this.boardAdd("notice", by, slug, `${slug}: ${mode === "scoping" ? "scoping" : "scoping done, active"}`, what, card);
      if (this.liveAt(`lead:${slug}`))
        this.put({
          recipient: `lead:${slug}`,
          sender: by === "person" ? "person" : by,
          kind: "notice",
          ref: card,
          body:
            mode === "scoping"
              ? `${who} put ${slug} in scoping mode. Work its scope out with ${o.name} directly: your cards and deliverables go only to ${o.name}'s Scope pane (no CoS triage, no standing rule). Start no build threads until scoping is done; read-only investigation is fine. When the goal, constraints and first plan are in PROJECT.md, file orch_ask with scoping_done {summary, project_md}.`
              : `${who} ended scoping: ${slug} is active. Your cards go the normal way again (CoS triage, Needs you); threads start from a plan card ${o.name} approves.`,
          key: `mode:${slug}:${mode}:${this.now()}`,
          needsAck: false,
        });
      if (by !== "cos" && this.agentByAddress("cos"))
        this.put({ recipient: "cos", sender: by === "person" ? "person" : by, kind: "copy", ref: card, body: `${who} set ${slug} to ${mode}. ${what}`, key: `mode-copy:${slug}:${mode}:${this.now()}`, needsAck: false });
      this.ports.changed();
      return this.project(slug)!;
    });
  }

  /**
   * Release the Scope pane's open cards and deliverables in review that `pick` takes (by their task id, or null): while
   * the project is active, to Needs you and Deliverables; while it scopes as a whole, back to its whole-project pane (they
   * only lose the task). An open "Scoping done?" among them, except `keep` (the card that made the change), is withdrawn
   * with `reason`: nothing is left to decide. How many moved.
   */
  private releaseScope(slug: string, pick: (task: string | null) => boolean, by: string, keep: string | null, reason: string): number {
    const whole = this.isScoping(slug);
    let moved = 0;
    const open = (this.db.prepare(`SELECT json FROM decisions WHERE project = ? AND state = 'asked' AND json_extract(json, '$.orchestrator.scope') = 1 ORDER BY id`).all(slug) as { json: string }[]).map((r) => JSON.parse(r.json) as Decision);
    for (const d of open) {
      if (d.id === keep || !pick(d.orchestrator.scope_task ?? null)) continue;
      if (d.orchestrator.scoping_done) {
        d.state = "withdrawn";
        d.withdrawn = { by, at: iso(this.now()), reason };
        this.save(d, "withdraw", by, "scoping ended", null);
        continue;
      }
      delete d.orchestrator.scope_task;
      moved++;
      if (whole) {
        this.save(d, "notify", "engine", "its scoping task closed: to the whole project's Scope pane", null);
        continue;
      }
      d.orchestrator.scope = false;
      this.save(d, "notify", "engine", "scoping ended: to Needs you", null);
      this.upOrHold(d);
    }
    for (const v of this.db.prepare(`SELECT json FROM deliverables WHERE project = ? AND state = 'review' AND json_extract(json, '$.scope') = 1`).all(slug) as { json: string }[]) {
      const d = JSON.parse(v.json) as Deliverable;
      if (!pick(d.scope_task ?? null)) continue;
      delete d.scope_task;
      moved++;
      if (!whole) delete d.scope;
      this.saveDeliverable(d);
      if (!whole) this.ports.delivered?.(d);
    }
    return moved;
  }

  task(id: string): ScopingTask | null {
    const r = this.db.prepare(`SELECT * FROM scoping_tasks WHERE id = ?`).get(id) as TaskRow | undefined;
    return r ? toTask(r) : null;
  }

  /** The open scoping tasks of live projects, oldest first: one project's, or all of them. */
  openTasks(project: string | null = null): ScopingTask[] {
    return (
      this.db
        .prepare(`SELECT t.* FROM scoping_tasks t JOIN projects p ON p.slug = t.project WHERE t.state = 'scoping' AND p.archived_at IS NULL AND (? IS NULL OR t.project = ?) ORDER BY t.opened_at, t.rowid`)
        .all(project, project) as unknown as TaskRow[]
    ).map(toTask);
  }

  /**
   * A lead's open scoping task, by its id or its name (any case). Refused, with what to do instead: from anyone but a
   * lead, for another project's task, for a task that is done or dropped, or for one that doesn't exist.
   */
  resolveTask(by: Agent, ref: string): ScopingTask {
    if (by.role !== "lead" || !by.project) throw new EngineError("forbidden", `only a lead files into a scoping task${by.role === "thread" ? ": ask your lead as always, and it files your questions into the task" : ""}`);
    const key = String(ref ?? "").trim();
    if (!key) throw new EngineError("invalid", "scope_task is empty: give an open scoping task's id (st-…) or name, or leave it out");
    const byName = this.db.prepare(`SELECT * FROM scoping_tasks WHERE project = ? AND name = ? COLLATE NOCASE ORDER BY state = 'scoping' DESC, opened_at DESC LIMIT 1`).get(by.project, key) as TaskRow | undefined;
    const t = this.task(key) ?? (byName ? toTask(byName) : null);
    if (!t) throw new EngineError("not_found", `${by.project} has no scoping task ${JSON.stringify(key)}: open one with orch_scope_task(action="open", name), or leave scope_task out`);
    if (t.project !== by.project) throw new EngineError("forbidden", `${t.id} is ${t.project}'s scoping task, not ${by.project}'s`);
    if (t.state !== "scoping") throw new EngineError("bad_state", `scoping task ${t.id} ${JSON.stringify(t.name)} is ${t.state}${t.closedAt ? ` since ${iso(t.closedAt)}` : ""}, not open: leave scope_task out, or open a new task`);
    return t;
  }

  /**
   * A lead opens a scoping task in its project (orch_scope_task open), in either mode: the cards and deliverables it files
   * with the task go to the owner's Scope pane under it, and the rest of the project is unchanged. A timeline event and a
   * board notice record it, and the CoS gets a copy. Refused: a name already open in the project (any case).
   */
  openTask(by: Agent, name: string): ScopingTask {
    if (by.role !== "lead" || !by.project) throw new EngineError("forbidden", "only a lead opens a scoping task");
    return this.openTaskIn(by.project, name, by.address);
  }

  /** Open a scoping task in `slug`, by a lead's address or "person" (the owner, from the Projects view: ownerScopeThread). */
  private openTaskIn(slug: string, name: string, by: string): ScopingTask {
    const n = oneLine(String(name ?? ""), SCOPING_TASK_NAME_MAX, "the task's name");
    return tx(this.db, () => {
      const p = this.project(slug);
      if (!p) throw new EngineError("not_found", `no project ${slug}`);
      if (p.archivedAt) throw new EngineError("bad_state", `${slug} is archived`);
      const dup = this.db.prepare(`SELECT id FROM scoping_tasks WHERE project = ? AND state = 'scoping' AND name = ? COLLATE NOCASE`).get(slug, n) as { id: string } | undefined;
      if (dup) throw new EngineError("conflict", `${slug} already has an open scoping task ${JSON.stringify(n)} (${dup.id}): file into it, or pick another name`);
      const id = `st-${hex(4)}`;
      this.db.prepare(`INSERT INTO scoping_tasks (id, project, name, state, opened_by, opened_at) VALUES (?, ?, ?, 'scoping', ?, ?)`).run(id, slug, n, by, this.now());
      this.event({ kind: "scope-task", project: slug, address: `lead:${slug}`, threadId: null, value: "scoping", note: n, ref: id });
      const o = this.owner;
      const what = `${by === "person" ? o.Name : by} opened scoping task ${id} ${JSON.stringify(n)} in ${slug}: the cards and deliverables filed with that task go only to ${o.name}'s Scope pane, under the task, and no standing rule settles them. The rest of ${slug} goes the normal way.`;
      this.boardAdd("notice", by, slug, `${slug}: scoping task ${JSON.stringify(n)}`, what, id);
      if (this.agentByAddress("cos")) this.put({ recipient: "cos", sender: by, kind: "copy", ref: id, body: `${what} You get read-only copies of them (don't triage, settle, merge or moot them).`, key: `scope-task-copy:${id}:scoping`, needsAck: false });
      this.ports.changed();
      return this.task(id)!;
    });
  }

  /** A lead drops a scoping task it no longer needs (orch_scope_task drop): what still waits under it is released. */
  dropTask(by: Agent, ref: string): { task: ScopingTask; moved: number } {
    return tx(this.db, () => {
      const t = this.resolveTask(by, ref);
      const moved = this.closeTask(t.id, "dropped", by.address, null, null, null);
      return { task: this.task(t.id)!, moved };
    });
  }

  /**
   * Close a scoping task: done (the owner's yes on its "Scoping done?", with the summary and doc) or dropped (by its
   * lead). A timeline event and a board notice record it, and the lead (unless it did it) and the CoS are told. What still
   * waits under it is released (releaseScope); nothing else in the project changes. Not open any more: a no-op.
   */
  private closeTask(id: string, state: Exclude<ScopingTaskState, "scoping">, by: string, card: string | null, summary: string | null, doc: string | null): number {
    const t = this.task(id);
    if (!t || t.state !== "scoping") return 0;
    const lead = `lead:${t.project}`;
    const who = by === "person" ? this.owner.Name : by;
    this.db.prepare(`UPDATE scoping_tasks SET state = ?, closed_at = ?, summary = ?, doc = ? WHERE id = ?`).run(state, this.now(), summary, doc, id);
    this.event({ kind: "scope-task", project: t.project, address: lead, threadId: null, value: state, note: t.name, ref: card ?? id });
    const moved = this.releaseScope(t.project, (task) => task === id, by, card, `scoping task ${id} is ${state} (${who})`);
    const where = this.isScoping(t.project) ? `${t.project}'s whole-project Scope pane (${t.project} still scopes as a whole)` : "Needs you and Deliverables";
    const what = `${who} ${state === "done" ? "closed" : "dropped"} scoping task ${id} ${JSON.stringify(t.name)} in ${t.project}${doc ? ` (findings: ${doc})` : ""}.${moved ? ` ${moved} still open under it moved to ${where}.` : ""} The rest of ${t.project} is unchanged.`;
    this.boardAdd("notice", by, t.project, `${t.project}: scoping task ${JSON.stringify(t.name)} ${state}`, what, card ?? id);
    const sender = by === "person" ? "person" : by;
    if (by !== lead && this.liveAt(lead)) this.put({ recipient: lead, sender, kind: "notice", ref: card ?? id, body: what, key: `scope-task:${id}:${state}`, needsAck: false });
    if (by !== "cos" && this.agentByAddress("cos")) this.put({ recipient: "cos", sender, kind: "copy", ref: card ?? id, body: what, key: `scope-task-copy:${id}:${state}`, needsAck: false });
    this.ports.changed();
    return moved;
  }

  /**
   * The open scoping task the thread that asked `d` was started for (orch_spawn_thread scope_task), or null. Through the
   * asker's live holder first (a handoff moves the spawn row to the successor), then the thread that asked.
   */
  private threadTask(d: Decision): ScopingTask | null {
    if (d.request.by.role !== "thread") return null;
    for (const id of [this.agentByAddress(d.orchestrator.origin)?.threadId, d.request.by.thread]) {
      if (!id) continue;
      const r = this.db.prepare(`SELECT scope_task FROM spawns WHERE thread_id = ?`).get(id) as { scope_task: string | null } | undefined;
      if (!r) continue;
      const t = r.scope_task ? this.task(r.scope_task) : null;
      return t?.state === "scoping" ? t : null;
    }
    return null;
  }

  /**
   * Who plans an open scoping task: its scoping thread (the newest live thread orch_spawn_thread started with
   * the task or the owner picked for it; a handoff moves the spawn row to the successor), or null while the lead plans it itself. A stopped or
   * archived thread plans nothing. The owner's Scope tab and the lead's inbox both read this, so they say the same.
   */
  taskPlanner(taskId: string): Agent | null {
    const r = this.db
      .prepare(`SELECT a.thread_id FROM spawns s JOIN agents a ON a.thread_id = s.thread_id WHERE s.scope_task = ? AND a.retired_at IS NULL AND a.role = 'thread' AND a.status NOT IN ('stopped', 'archived') ORDER BY COALESCE(s.scoped_at, s.created_at) DESC, s.rowid DESC LIMIT 1`)
      .get(taskId) as { thread_id: string } | undefined;
    return r ? this.agentByThread(r.thread_id) : null;
  }

  /** The open scoping task a thread was started for (orch_spawn_thread scope_task), or null: what its handoff must carry on. */
  scopingTaskOfThread(threadId: string): ScopingTask | null {
    const r = this.db.prepare(`SELECT scope_task FROM spawns WHERE thread_id = ?`).get(threadId) as { scope_task: string | null } | undefined;
    const t = r?.scope_task ? this.task(r.scope_task) : null;
    return t?.state === "scoping" ? t : null;
  }

  /**
   * The owner makes a thread a scoping thread from the Projects view: of an open task of its project (`task`, its
   * id or name), or of a new one they open for it (`name`, through openTask's own path). Its spawn row names the task, as
   * orch_spawn_thread's scope_task does, so the cards its lead forwards from it go to the Scope pane under the task; the
   * owner's pick plans the task (taskPlanner). The thread is told to investigate read-only, the lead which thread plans
   * which task, and the CoS gets a copy; a timeline event and a board notice record it. Refused for anything but a live
   * thread of a live project. Already that task's scoping thread: a no-op.
   */
  ownerScopeThread(threadId: string, pick: { task?: string | null; name?: string | null }): { task: ScopingTask; opened: boolean; changed: boolean } {
    return tx(this.db, () => {
      const a = this.scopableThread(threadId);
      const slug = a.project!;
      const key = String(pick.task ?? "").trim();
      const fresh = String(pick.name ?? "").trim();
      if (!key === !fresh) throw new EngineError("invalid", "give task (an open scoping task's id or name) or name (a new task), not both");
      let t: ScopingTask;
      if (key) {
        const byName = this.db.prepare(`SELECT * FROM scoping_tasks WHERE project = ? AND name = ? COLLATE NOCASE AND state = 'scoping'`).get(slug, key) as TaskRow | undefined;
        const found = this.task(key) ?? (byName ? toTask(byName) : null);
        if (!found || found.project !== slug) throw new EngineError("not_found", `${slug} has no scoping task ${JSON.stringify(key)}`);
        if (found.state !== "scoping") throw new EngineError("bad_state", `scoping task ${found.id} ${JSON.stringify(found.name)} is ${found.state}, not open`);
        t = found;
      } else t = this.openTaskIn(slug, fresh, "person");
      const prev = this.scopingTaskOfThread(threadId);
      if (prev?.id === t.id) return { task: t, opened: false, changed: false };
      const now = this.now();
      if (this.hasSpawn(threadId)) this.db.prepare(`UPDATE spawns SET scope_task = ?, scoped_at = ? WHERE thread_id = ?`).run(t.id, now, threadId);
      // a thread no plan started (adopted, or a lead's own bb child) has no row yet: the owner's pick is its record
      else this.db.prepare(`INSERT INTO spawns (thread_id, plan_id, via, lead, created_at, scope_task, scoped_at) VALUES (?, NULL, 'scope', NULL, ?, ?, ?)`).run(threadId, now, t.id, now);
      this.event({ kind: "scope-thread", project: slug, address: a.address, threadId, value: "scoping", note: t.name, ref: t.id });
      const o = this.owner;
      const name = `task ${JSON.stringify(t.name)} (${t.id})`;
      const left = prev ? ` It no longer scopes task ${JSON.stringify(prev.name)} (${prev.id}): ${this.plannerWords(prev.id)} plans that one now.` : "";
      const what = `${o.Name} made ${a.address} the scoping thread for ${slug}'s ${name}${key ? "" : ", a task they opened for it"}: it plans that task now, and the questions from it that the lead forwards go to ${o.name}'s Scope pane under the task. It was told to investigate read-only and make no changes.${left}`;
      this.boardAdd("notice", "person", slug, `${slug}: ${a.address} scopes ${JSON.stringify(t.name)}`, what, t.id);
      this.put({ recipient: a.address, sender: "person", kind: "notice", ref: t.id, body: `You are now the scoping thread for ${name} in ${slug}. Investigate read-only and make no changes. Your questions and findings go to your lead.`, key: `scope-thread:${threadId}:${t.id}:${now}`, needsAck: false });
      if (this.liveAt(`lead:${slug}`)) this.put({ recipient: `lead:${slug}`, sender: "person", kind: "notice", ref: t.id, body: what, key: `scope-thread-lead:${threadId}:${t.id}:${now}`, needsAck: false });
      if (this.agentByAddress("cos")) this.put({ recipient: "cos", sender: "person", kind: "copy", ref: t.id, body: what, key: `scope-thread-copy:${threadId}:${t.id}:${now}`, needsAck: false });
      this.ports.changed();
      return { task: t, opened: !key, changed: true };
    });
  }

  /**
   * The owner's "Stop scoping" on a thread: it is no longer its task's scoping thread, and the cards its lead
   * forwards from it go the normal way again. The task stays open, planned by the lead (or by another live scoping thread
   * of it); dropping it is the lead's. The thread, the lead and the CoS are told; a timeline event records it. A thread
   * that scopes no open task: a no-op (null).
   */
  ownerUnscopeThread(threadId: string): ScopingTask | null {
    return tx(this.db, () => {
      const a = this.scopableThread(threadId);
      const slug = a.project!;
      const t = this.scopingTaskOfThread(threadId);
      if (!t) return null;
      const now = this.now();
      // the row stays (a plan's row still holds its slot); only the task goes
      this.db.prepare(`UPDATE spawns SET scope_task = NULL, scoped_at = NULL WHERE thread_id = ?`).run(threadId);
      this.event({ kind: "scope-thread", project: slug, address: a.address, threadId, value: "stopped", note: t.name, ref: t.id });
      const o = this.owner;
      const name = `task ${JSON.stringify(t.name)} (${t.id})`;
      const what = `${o.Name} stopped ${a.address} scoping ${slug}'s ${name}: ${this.plannerWords(t.id)} plans it now. The task stays open (drop it with orch_scope_task if it isn't needed), and the questions from ${a.address} that the lead forwards go the normal way again.`;
      this.boardAdd("notice", "person", slug, `${slug}: ${a.address} stopped scoping ${JSON.stringify(t.name)}`, what, t.id);
      this.put({ recipient: a.address, sender: "person", kind: "notice", ref: t.id, body: `${o.Name} stopped your scoping: you are no longer the scoping thread for ${name}. Your questions go to your lead the normal way; ask it before you change anything.`, key: `unscope-thread:${threadId}:${t.id}:${now}`, needsAck: false });
      if (this.liveAt(`lead:${slug}`)) this.put({ recipient: `lead:${slug}`, sender: "person", kind: "notice", ref: t.id, body: what, key: `unscope-thread-lead:${threadId}:${t.id}:${now}`, needsAck: false });
      if (this.agentByAddress("cos")) this.put({ recipient: "cos", sender: "person", kind: "copy", ref: t.id, body: what, key: `unscope-thread-copy:${threadId}:${t.id}:${now}`, needsAck: false });
      this.ports.changed();
      return t;
    });
  }

  /** A thread the owner may switch to scoping or back: live (not stopped or archived), of a live project. */
  private scopableThread(threadId: string): Agent {
    const a = this.agentByThread(threadId);
    if (!a) throw new EngineError("not_found", `no live agent on thread ${threadId}`);
    if (a.role !== "thread" || !a.project) throw new EngineError("forbidden", `${a.address} isn't a project's thread: only a thread scopes a task (a lead's whole project scopes with Start scoping)`);
    if (a.status === "stopped" || a.status === "archived") throw new EngineError("bad_state", `${a.address} is ${a.status}`);
    const p = this.project(a.project);
    if (!p || p.archivedAt) throw new EngineError("bad_state", `${a.project} is archived`);
    return a;
  }

  /** Who plans an open task, in messages: "its scoping thread <address>", else "the lead". */
  private plannerWords(taskId: string): string {
    const by = this.taskPlanner(taskId);
    return by ? `its scoping thread ${by.address}` : "the lead";
  }

  /** Why a card or deliverable waits in the Scope pane, as messages say it: its scoping task, else its project scoping. */
  private scopeWhy(project: string | null, task: string | null | undefined): string {
    const t = task ? this.task(task) : null;
    return t ? `in ${project}'s scoping task ${JSON.stringify(t.name)} (${t.id})` : `while ${project} is scoping`;
  }

  /** A card from a scoping project's lead, or one filed into a scoping task: straight to the owner in its Scope pane, and a read-only copy to the CoS. */
  private fileInScope(d: Decision, by: string): void {
    this.putAsk(d, by, d.request.title, d.request.question, d.request.context, d.request.options, true);
    d.orchestrator.scope = true;
    this.save(d, "ask", "engine", "scoping: in the owner's Scope pane", null);
    if (!this.agentByAddress("cos")) return;
    const o = this.owner;
    const done = d.orchestrator.scoping_done;
    this.put({
      recipient: "cos",
      sender: by,
      kind: "copy",
      ref: d.id,
      body: `${by} asked ${d.id} ${JSON.stringify(d.request.title)}${d.kind === "plan" ? " (a plan card)" : ""} ${this.scopeWhy(d.project, d.orchestrator.scope_task)}: it went straight to ${o.name}'s Scope pane, not to your triage. Read-only: don't triage, settle, merge or moot it; ${o.name} answers it there with the lead. Question: ${JSON.stringify(d.request.question)}${done ? (done.task ? ` It proposes closing that scoping task (${done.doc})` : ` It proposes ending scoping (${done.project_md})`) + `: ${JSON.stringify(done.summary.slice(0, 600))}` : ""}`,
      key: `scope-copy:${d.id}`,
      needsAck: false,
    });
  }

  /**
   * What waits on the owner in the Scope pane, per project: those scoping as a whole and those with open scoping tasks
   * Each has its open tasks, its open cards and its deliverables in review; each card and deliverable names its
   * task (scope_task), or none for the whole project.
   */
  scopeView(): { slug: string; whole: boolean; tasks: ScopingTask[]; cards: Decision[]; deliverables: Deliverable[] }[] {
    const rows = this.db
      .prepare(`SELECT slug, mode FROM projects p WHERE archived_at IS NULL AND (mode = 'scoping' OR EXISTS (SELECT 1 FROM scoping_tasks t WHERE t.project = p.slug AND t.state = 'scoping')) ORDER BY slug`)
      .all() as { slug: string; mode: string }[];
    return rows.map(({ slug, mode }) => ({
      slug,
      whole: mode === "scoping",
      tasks: this.openTasks(slug),
      cards: (this.db.prepare(`SELECT json FROM decisions WHERE project = ? AND state = 'asked' AND json_extract(json, '$.orchestrator.scope') = 1 ORDER BY id`).all(slug) as { json: string }[]).map((r) => JSON.parse(r.json) as Decision),
      deliverables: (this.db.prepare(`SELECT json FROM deliverables WHERE project = ? AND state = 'review' AND json_extract(json, '$.scope') = 1 ORDER BY updated_at DESC`).all(slug) as { json: string }[]).map((r) => JSON.parse(r.json) as Deliverable),
    }));
  }

  /**
   * The Scope pane as the CoS reads it (orch_inbox, orch_needs_you): a line per project scoping as a whole and per open
   * scoping task, each starting "- <slug>:", or none while nothing scopes.
   */
  private scopeLines(): string[] {
    const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
    const lines = this.scopeView().flatMap((p) => {
      const open = new Set(p.tasks.map((t) => t.id));
      const under = (task: string | null) => (t: string | null | undefined) => (task ? t === task : !t || !open.has(t));
      const line = (head: string, task: string | null) => {
        const cards = p.cards.filter((d) => under(task)(d.orchestrator.scope_task));
        const dl = p.deliverables.filter((d) => under(task)(d.scope_task));
        return `- ${p.slug}: ${head}${n(cards.length, "open card")}${dl.length ? `, ${n(dl.length, "deliverable")} in review` : ""}${cards.some((d) => d.orchestrator.scoping_done) ? ' (incl. "Scoping done?")' : ""}`;
      };
      return [...(p.whole ? [line("", null)] : []), ...p.tasks.map((t) => line(`task ${JSON.stringify(t.name)} (${t.id}), `, t.id))];
    });
    if (!lines.length) return [];
    const o = this.owner;
    return [`Scoping with ${o.name} directly (${lines.length}): their cards wait in ${o.name}'s Scope pane, not your triage; you get read-only copies (don't triage, settle, merge or moot them):`, ...lines];
  }

  setPriority(slug: string, priority: Priority): void {
    if (!PRIORITIES.includes(priority)) throw new EngineError("invalid", `priority is one of ${PRIORITIES.join(", ")}`);
    if (!this.project(slug)) throw new EngineError("not_found", `no project ${slug}`);
    this.db.prepare(`UPDATE projects SET priority = ? WHERE slug = ?`).run(priority, slug);
    this.boardAdd("notice", "person", slug, `${slug}: priority ${priority}`, "", null);
  }

  /** On hold: the project's mail waits (flush skips it) and its lead can't start threads. Resume sends it. */
  setHold(slug: string, held: boolean): void {
    const p = this.project(slug);
    if (!p) throw new EngineError("not_found", `no project ${slug}`);
    if (!!p.heldAt === held) return;
    this.db.prepare(`UPDATE projects SET held_at = ? WHERE slug = ?`).run(held ? this.now() : null, slug);
    this.boardAdd("notice", "person", slug, `${slug} ${held ? "on hold" : "resumed"}`, held ? "Its mail waits and its lead can't start threads until you resume it." : "", null);
  }

  /**
   * Archive a project (the user, from its lead's row or the Projects tab): the work is done and handed off. Its lead and
   * threads are retired, the mail still waiting for them is closed (not dead letters: nobody should resend it), and its
   * cards still waiting for an answer are withdrawn. Deliverables and outputs stay. Returns the threads to archive in
   * bb. Starting its lead again brings the project back.
   */
  archiveProject(slug: string): { threadIds: string[] } {
    return tx(this.db, () => {
      const p = this.project(slug);
      if (!p) throw new EngineError("not_found", `no project ${slug}`);
      if (p.archivedAt) throw new EngineError("bad_state", `${slug} is already archived`);
      const agents = this.agents().filter((a) => a.project === slug && (a.role === "lead" || a.role === "thread"));
      const note = "project archived";
      for (const a of agents) {
        this.closeItems(`recipient = ?`, [a.address], "superseded", note);
        this.db.prepare(`UPDATE agents SET retired_at = ? WHERE thread_id = ? AND retired_at IS NULL`).run(this.now(), a.threadId);
        this.event({ kind: "retire", project: a.project, address: a.address, threadId: a.threadId });
      }
      // the cards its own agents asked; a card the CoS asked about the project is the CoS's to settle
      const ours = (addr: string) => addr === `lead:${slug}` || addr.startsWith(`thread:${slug}:`);
      const open = (this.db.prepare(`SELECT id, asker, origin FROM decisions WHERE state IN ('open','asked')`).all() as { id: string; asker: string; origin: string }[]).filter(
        (r) => ours(r.asker) || ours(r.origin),
      );
      for (const { id } of open) {
        const d = this.mustDecision(id);
        d.state = "withdrawn";
        d.withdrawn = { by: "person", at: iso(this.now()), reason: note };
        d.deferred = null;
        this.save(d, "withdraw", "person", note, null);
      }
      this.db.prepare(`UPDATE projects SET archived_at = ?, held_at = NULL WHERE slug = ?`).run(this.now(), slug);
      const who = agents.length ? agents.map((a) => a.address).join(", ") : "no agents";
      this.boardAdd("archived", "person", slug, `${slug} archived`, `Retired ${who}; ${open.length} open card${open.length === 1 ? "" : "s"} withdrawn. Its deliverables and outputs stay. Start its lead to bring it back.`, null);
      this.ports.changed();
      return { threadIds: agents.map((a) => a.threadId) };
    });
  }

  /** Every bb thread that held one of a project's addresses, live or retired. */
  projectThreadIds(slug: string): string[] {
    return (this.db.prepare(`SELECT thread_id FROM agents WHERE project = ? UNION SELECT thread_id FROM events WHERE project = ? AND thread_id IS NOT NULL`).all(slug, slug) as { thread_id: string }[]).map((r) => r.thread_id);
  }

  /**
   * One project's history for its page (history.ts): every lead and thread that held one of its addresses, from the
   * events log and the current tables, and what waits on what. `providers`: bb's provider per thread id, where known.
   */
  projectHistory(slug: string, providers: Map<string, string | null> = new Map()): ProjectHistory {
    const p = this.project(slug);
    if (!p) throw new EngineError("not_found", `no project ${slug}`);
    const agents = this.db.prepare(`SELECT thread_id, address, role, parent_thread_id, status, created_at, retired_at FROM agents WHERE project = ? AND role IN ('lead','thread')`).all(slug) as HistoryAgent[];
    const events = this.db.prepare(`SELECT * FROM events WHERE project = ? ORDER BY at, seq`).all(slug) as unknown as EventRow[];
    const addresses = new Set([...agents.map((a) => a.address), ...events.map((e) => e.address).filter((x): x is string => !!x)]);
    const ours = (addr: string) => addresses.has(addr);
    const decisions: DecisionLite[] = (this.db.prepare(`SELECT json FROM decisions WHERE project = ? OR asker IN (SELECT address FROM agents WHERE project = ?) ORDER BY rowid`).all(slug, slug) as { json: string }[]).map((r) => {
      const d = JSON.parse(r.json) as Decision;
      const end = d.answer?.at ?? d.withdrawn?.at ?? (d.state === "merged" || d.state === "acked" ? d.updated_at : null);
      return {
        id: d.id,
        state: d.state,
        level: d.orchestrator.at_level,
        asker: d.orchestrator.asker,
        origin: d.orchestrator.origin,
        title: d.request.title,
        createdAt: Date.parse(d.created_at),
        // as Needs you shows it (server.ts card())
        askedAt: Date.parse(d.ask?.at ?? d.created_at),
        endedAt: end ? Date.parse(end) : null,
        deferred: d.deferred !== null,
        heldBehind: d.orchestrator.held?.behind ?? null,
      };
    });
    const items = (
      this.db.prepare(`SELECT id, sender, recipient, kind, state, body, created_at FROM items WHERE needs_ack = 1 AND (state IN ('pending','queued','delivered') OR state = 'dead')`).all() as HistoryInput["items"]
    ).filter((i) => ours(i.sender) || ours(i.recipient));
    const waits = (this.db.prepare(`SELECT id, owner, pr_url, cond, created_at FROM waits WHERE closed_at IS NULL`).all() as HistoryInput["waits"]).filter((w) => ours(w.owner));
    const prs = this.db.prepare(`SELECT thread_id, url, number, state, checks, sig, attention FROM prs`).all() as HistoryInput["prs"];
    const ids = new Set([...agents.map((a) => a.thread_id), ...events.map((e) => e.thread_id)]);
    return buildHistory({ slug, now: this.now(), logSince: logSince(this.db), heldAt: p.heldAt, agents, events, decisions, waits, items, prs: prs.filter((x) => ids.has(x.thread_id)), providers });
  }

  /**
   * Every project's row summary (history.ts buildSummary) from one batch of SQL reads: no bb calls, and never the
   * history loader (it reads a project's whole event log). Live agents only count as working or as threads; retired
   * ones only name the project's past addresses. A status stored before the waits list is dated from its log.
   */
  projectSummaries(): Map<string, ProjectSummary> {
    const t = this.now();
    const since = t - SUMMARY_DONE_MS;
    const projects = this.db.prepare(`SELECT slug, held_at FROM projects WHERE archived_at IS NULL`).all() as { slug: string; held_at: number | null }[];
    // every agent row once: the leads' and threads' by project, and every address for what a wait may name (refAgents)
    const everyAgent = this.db.prepare(`SELECT thread_id, address, role, project, status, idle_at, retired_at FROM agents`).all() as (SummaryInput["agents"][number] & { project: string | null })[];
    const agents = everyAgent.filter((a): a is SummaryInput["agents"][number] & { project: string } => (a.role === "lead" || a.role === "thread") && a.project !== null);
    const statuses = new Map((this.db.prepare(`SELECT project, json FROM lead_status`).all() as { project: string; json: string }[]).map((r) => [r.project, JSON.parse(r.json) as LeadStatus]));
    const decisions = (
      this.db
        .prepare(
          `SELECT id, state, at_level AS level, asker, origin, project, json_extract(json, '$.request.title') AS title, json_extract(json, '$.created_at') AS created,
             json_extract(json, '$.ask.at') AS asked, json_extract(json, '$.deferred') IS NOT NULL AS deferred, json_extract(json, '$.orchestrator.held.behind') AS held,
             COALESCE(json_extract(json, '$.ask.question'), json_extract(json, '$.request.question')) AS question
           FROM decisions WHERE state IN ('open','asked')`,
        )
        .all() as { id: string; state: string; level: string; asker: string; origin: string; project: string | null; title: string; created: string; asked: string | null; deferred: number; held: string | null; question: string | null }[]
    ).map((d) => ({ id: d.id, state: d.state, level: d.level, asker: d.asker, origin: d.origin, title: d.title, createdAt: Date.parse(d.created), askedAt: Date.parse(d.asked ?? d.created), endedAt: null, deferred: !!d.deferred, heldBehind: d.held, question: d.question ?? undefined }) satisfies DecisionLite);
    const items = this.db
      .prepare(`SELECT id, sender, recipient, kind, state, substr(body, 1, 200) AS body, created_at FROM items WHERE needs_ack = 1 AND state IN ('pending','queued','delivered','dead') AND (sender LIKE 'lead:%' OR sender LIKE 'thread:%' OR recipient LIKE 'lead:%' OR recipient LIKE 'thread:%')`)
      .all() as HistoryInput["items"];
    const waits = this.db.prepare(`SELECT id, owner, pr_url, cond, created_at FROM waits WHERE closed_at IS NULL`).all() as HistoryInput["waits"];
    const prs = this.db.prepare(`SELECT thread_id, url, number, state, checks, sig, attention, seen_at FROM prs`).all() as SummaryInput["prs"];
    const deliverables = this.db.prepare(`SELECT id, project, title, state, updated_at FROM deliverables WHERE state = 'review' OR (state = 'approved' AND updated_at >= ?)`).all(since) as { id: string; project: string | null; title: string; state: string; updated_at: number }[];
    const merged = this.db.prepare(`SELECT project, at, ref, note FROM events WHERE kind = 'pr' AND value = 'merged' AND at >= ? AND project IS NOT NULL ORDER BY project, at, rowid`).all(since) as { project: string; at: number; ref: string | null; note: string | null }[];
    const reports = this.db.prepare(`SELECT project, title, at FROM board WHERE kind IN ('report','pr') AND at >= ? AND project IS NOT NULL AND from_address LIKE 'thread:%' ORDER BY rowid`).all(since) as { project: string; title: string; at: number }[];
    // the latest finished thing at any age, for a quiet row: a report, an approved deliverable or a merged PR
    const last = new Map<string, { text: string; at: number }>();
    const later = (project: string | null, text: string, at: number) => {
      if (project && at > (last.get(project)?.at ?? 0)) last.set(project, { text, at });
    };
    // INDEXED BY: without statistics the planner walks every report by kind and sorts them. Of the rows at a project's
    // latest time, the first written (lowest rowid) is the one; so for merges, where the indexes would otherwise break
    // ties by title or PR number.
    for (const r of prepareHinted(
      this.db,
      "board_reports",
      `SELECT m.project, (SELECT title FROM board WHERE kind IN ('report','pr') AND project = m.project AND at = m.at ORDER BY rowid LIMIT 1) AS title, m.at FROM (SELECT project, MAX(at) AS at FROM board INDEXED BY board_reports WHERE kind IN ('report','pr') AND project IS NOT NULL GROUP BY project) m`,
    ).all() as { project: string; title: string; at: number }[])
      later(r.project, r.title, r.at);
    for (const r of this.db.prepare(`SELECT project, title, MAX(updated_at) AS at FROM deliverables WHERE state = 'approved' GROUP BY project`).all() as { project: string | null; title: string; at: number }[]) later(r.project, `Approved: ${r.title}`, r.at);
    for (const r of this.db.prepare(`SELECT m.project, (SELECT note FROM events WHERE kind = 'pr' AND value = 'merged' AND project = m.project AND at = m.at ORDER BY rowid LIMIT 1) AS note, m.at FROM (SELECT project, MAX(at) AS at FROM events WHERE kind = 'pr' AND value = 'merged' AND project IS NOT NULL GROUP BY project) m`).all() as { project: string; note: string | null; at: number }[]) later(r.project, `PR ${r.note ? `#${r.note} ` : ""}merged`, r.at);
    // the cards the leads' own waits and blockers name, in any state, to drop a wait that was answered
    const active = new Set(projects.map((p) => p.slug));
    const named = [...statuses].filter(([slug]) => active.has(slug)).flatMap(([, s]) => [...waitsOf(s).filter((w) => w.kind === "owner" && w.ref?.startsWith("d-")).map((w) => w.ref!), ...s.blockers.flatMap((b) => b.match(/\bd-[0-9A-Za-z-]+/g) ?? [])]);
    const cards = new Map<string, { state: string; answeredAt: number | null }>();
    // a merged card has no answer until the card it went into is answered, which gives it that answer (triageMerge)
    const card = this.db.prepare(`SELECT state, json_extract(json, '$.answer.at') AS at FROM decisions WHERE id = ?`);
    for (const id of named) {
      const r = card.get(id) as { state: string; at: string | null } | undefined;
      if (r) cards.set(id, { state: r.state, answeredAt: r.at ? Date.parse(r.at) : null });
    }
    // cards answered after the oldest live status with a blocker: what can cover a blocker (history.ts blockerCovered);
    // archived projects' statuses don't widen it. The answer time's index (db.ts decisions_answer_at) reads only those answers.
    const blocked = [...statuses].filter(([slug, s]) => active.has(slug) && s.blockers.length);
    const answered = blocked.length
      ? (
          this.db
            .prepare(SUMMARY_ANSWERED_SQL)
            .all(iso(Math.min(...blocked.map(([, s]) => s.updatedAt)))) as { id: string; project: string | null; asker: string; origin: string; title: string; question: string | null; at: string }[]
        ).map((d) => ({ ...d, answeredAt: Date.parse(d.at) }))
      : [];
    // what a lead's wait may name outside its project: any PR's latest reading, any address and whether it is held now
    const refPrs = new Map<string, { state: string | null; seen_at: number }>();
    for (const x of prs) if (x.url && x.seen_at >= (refPrs.get(x.url)?.seen_at ?? -1)) refPrs.set(x.url, { state: x.state, seen_at: x.seen_at });
    const refAgents = new Map<string, boolean>();
    for (const a of everyAgent)
      refAgents.set(a.address, (refAgents.get(a.address) ?? false) || (a.retired_at === null && a.status !== "archived"));
    const out = new Map<string, ProjectSummary>();
    for (const p of projects) {
      const mine = agents.filter((a) => a.project === p.slug);
      const ours = new Set(mine.map((a) => a.address));
      const ids = new Set(mine.map((a) => a.thread_id));
      const status = statuses.get(p.slug) ?? null;
      const statusWaits = status ? (status.waits ?? waitsOf(status).map((w) => ({ ...w, since: this.legacyWaitSince(p.slug, status) }))) : [];
      out.set(
        p.slug,
        buildSummary({
          slug: p.slug,
          now: t,
          heldAt: p.held_at,
          hasLead: mine.some((a) => a.role === "lead" && a.retired_at === null && a.status !== "archived"),
          status: status ? { waits: statusWaits, blockers: status.blockers, updatedAt: status.updatedAt } : null,
          agents: mine,
          decisions: decisions.filter((d) => ours.has(d.asker) || ours.has(d.origin)),
          items: items.filter((i) => ours.has(i.sender) || ours.has(i.recipient)),
          waits: waits.filter((w) => ours.has(w.owner)),
          prs: prs.filter((x) => ids.has(x.thread_id)),
          deliverables: deliverables.filter((d) => d.project === p.slug),
          cards,
          refPrs,
          refAgents,
          answered: answered.filter((d) => d.project === p.slug || ours.has(d.asker) || ours.has(d.origin)).map((d) => ({ id: d.id, text: `${d.title} ${d.question ?? ""}`, answeredAt: d.answeredAt })),
          last: last.get(p.slug) ?? null,
          done: [
            ...deliverables.filter((d) => d.project === p.slug && d.state === "approved").map((d) => ({ text: d.title, at: d.updated_at, kind: "deliverable" as const })),
            ...merged.filter((m) => m.project === p.slug).map((m) => ({ text: `PR ${m.note ? `#${m.note} ` : ""}merged`, at: m.at, kind: "merged" as const })),
            ...reports.filter((r) => r.project === p.slug).map((r) => ({ text: r.title, at: r.at, kind: "report" as const })),
          ],
        }),
      );
    }
    return out;
  }


  openPlans(slug: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM decisions WHERE project = ? AND state IN ('open','asked') AND json_extract(json, '$.kind') = 'plan'`).get(slug) as { c: number }).c;
  }

  /** A plan card the lead may start threads from: its own, approved with the go option. */
  approvedPlan(lead: Agent, planId: string): Decision {
    const d = this.mustDecision(planId);
    if (d.kind !== "plan" || !d.orchestrator.plan) throw new EngineError("invalid", `${planId} isn't a plan card`);
    if (d.request.by.address !== lead.address) throw new EngineError("forbidden", `${planId} is ${d.request.by.address}'s plan`);
    if (d.state !== "answered" && d.state !== "acked") throw new EngineError("bad_state", `${planId} is ${d.state}: no go yet`);
    if (d.answer?.option !== d.orchestrator.plan.go) throw new EngineError("forbidden", `${planId} was answered "${d.answer?.label ?? d.answer?.text ?? "?"}", not its go option`);
    return d;
  }

  /**
   * Reserve one of a plan's thread slots before spawning; confirm with the new thread's id, or release on failure. With
   * `scopeTask` the thread is that open task's scoping thread: its spawn row names the task.
   */
  reserveSpawn(lead: Agent, planId: string, scopeTask: string | null = null): string {
    if (lead.role !== "lead") throw new EngineError("forbidden", "only a lead starts threads");
    return tx(this.db, () => {
      if (this.project(lead.project!)?.heldAt) throw new EngineError("bad_state", `${lead.project} is on hold`);
      const d = this.approvedPlan(lead, planId);
      const used = (this.db.prepare(`SELECT COUNT(*) AS c FROM spawns WHERE plan_id = ?`).get(planId) as { c: number }).c;
      if (used >= d.orchestrator.plan!.threads) throw new EngineError("bad_state", `${planId} allows ${d.orchestrator.plan!.threads} thread(s); all started`);
      const task = scopeTask ? this.resolveTask(lead, scopeTask).id : null;
      // the plan's work-board task, while it isn't dropped: the thread is attached to it
      const work = d.orchestrator.task ? (this.db.prepare(`SELECT id FROM tasks WHERE id = ? AND state <> 'dropped'`).get(d.orchestrator.task) as { id: string } | undefined)?.id ?? null : null;
      const token = `pending:${hex(4)}`;
      this.db.prepare(`INSERT INTO spawns (thread_id, plan_id, via, lead, created_at, scope_task, task) VALUES (?, ?, 'plan', ?, ?, ?, ?)`).run(token, planId, lead.address, this.now(), task, work);
      return token;
    });
  }

  confirmSpawn(token: string, threadId: string): void {
    this.db.prepare(`UPDATE spawns SET thread_id = ? WHERE thread_id = ?`).run(threadId, token);
  }

  releaseSpawn(token: string): void {
    this.db.prepare(`DELETE FROM spawns WHERE thread_id = ?`).run(token);
  }

  hasSpawn(threadId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM spawns WHERE thread_id = ?`).get(threadId);
  }

  /** Reservations an earlier plugin instance left unconfirmed (it stopped mid-spawn): give their slots back. */
  sweepStaleSpawns(before: number): number {
    const r = this.db.prepare(`DELETE FROM spawns WHERE thread_id LIKE 'pending:%' AND created_at < ?`).run(before) as { changes: number | bigint };
    return Number(r.changes);
  }

  /** The owner gave the role themselves (CLI): not a stray. */
  recordManual(threadId: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO spawns (thread_id, plan_id, via, lead, created_at) VALUES (?, NULL, 'person', NULL, ?)`).run(threadId, this.now());
  }

  /** Threads that no plan started (a lead's native bb child), once each, older than graceMs: Board + lead. */
  flagUnplanned(graceMs: number): number {
    const rows = this.db
      .prepare(
        `SELECT a.* FROM agents a LEFT JOIN spawns s ON s.thread_id = a.thread_id
         WHERE a.role = 'thread' AND a.retired_at IS NULL AND s.thread_id IS NULL AND a.created_at <= ? AND instr(a.flags, 'unplanned') = 0`,
      )
      .all(this.now() - graceMs) as AgentRow[];
    for (const r of rows) {
      const a = this.toAgent(r);
      this.db.prepare(`UPDATE agents SET flags = trim(flags || ',unplanned', ',') WHERE thread_id = ?`).run(a.threadId);
      this.boardAdd("unplanned", "orchestrator", a.project, `${a.address} started without a plan card`, `Thread ${a.threadId} was started outside orch_spawn_thread. It works as usual; this is the record.`, a.threadId);
      if (this.agentByAddress(`lead:${a.project}`)) this.put({ recipient: `lead:${a.project}`, sender: "orchestrator", kind: "notice", ref: a.threadId, body: `${a.address} was started without an approved plan card; it is flagged on the board. Start threads with orch_spawn_thread from an approved plan.`, needsAck: false });
    }
    if (rows.length) this.ports.changed();
    return rows.length;
  }


  setEnvironment(threadId: string, environmentId: string | null): void {
    this.db.prepare(`UPDATE agents SET environment_id = ? WHERE thread_id = ? AND retired_at IS NULL AND environment_id IS NOT ?`).run(environmentId, threadId, environmentId);
  }

  /** Every PR the plugin has read, with its project (through the thread that holds it): the links' PR numbers (refs.ts). */
  knownPrs(): { project: string | null; number: number; url: string; state: string; checks: string | null; review: string | null; attention: string | null }[] {
    const rows = this.db
      .prepare(`SELECT p.url, p.number, p.state, p.checks, p.sig, p.attention, a.project FROM prs p LEFT JOIN agents a ON a.thread_id = p.thread_id WHERE p.url IS NOT NULL AND p.number IS NOT NULL ORDER BY p.seen_at DESC`)
      .all() as { url: string; number: number; state: string | null; checks: string | null; sig: string; attention: string | null; project: string | null }[];
    // several environments can have read one PR: its newest reading only
    const seen = new Set<string>();
    return rows.filter((r) => !seen.has(r.url) && !!seen.add(r.url)).map((r) => ({ project: r.project, number: r.number, url: r.url, state: r.state ?? "open", checks: r.checks, review: r.sig.startsWith("v2|") ? r.sig.split("|")[4] || null : null, attention: r.attention }));
  }

  /** One project's Decided, Done, merges since the page's day start and blockers' start (book.ts): for the project opened. */
  projectBook(slug: string, dayStart?: number): ProjectBook & { pins: PinView[] } {
    if (!this.project(slug)) throw new EngineError("not_found", `no project ${slug}`);
    return { ...projectBook(this.db, slug, this.leadStatus(slug), this.now(), dayStart), pins: pinViews(this.db, slug) };
  }

  /** Older answered cards for the Projects search (book.ts). */
  searchAnswered(q: string): CardHit[] {
    return searchAnswered(this.db, q);
  }

  /** The thread's PR in an environment: the newest open one (PR numbers grow), else the newest. The others stay readable by URL (prByUrl). */
  prFor(environmentId: string | null): PrRow | null {
    if (!environmentId) return null;
    return prRow(this.db.prepare(`SELECT * FROM prs WHERE environment_id = ? ORDER BY state IN ('open','draft') DESC, number DESC, seen_at DESC LIMIT 1`).get(environmentId) as PrsRow | undefined);
  }

  /**
   * One PR reading for an agent's environment. Only a change is news: absent/unavailable are never a change (a
   * suspended machine or a restart must not flood anyone). A change goes to the Board and the lead; ready to merge or
   * merged also to the CoS. Returns whether it changed.
   *
   * A change is one of state, checks, review or mergeability. GitHub reads mergeable UNKNOWN while it recomputes after
   * any push to the base, and bb then derives another attention ("review requested", "blocked", none) until the next
   * reading flips back, which would send a notice at an unchanged head. An unknown mergeability keeps the last known
   * one, and the notice says only what the signature holds, so two notices in a row never read the same.
   *
   * Each PR has its own row in the environment (prFor reads the newest open one). `linking`: the first reading of a PR
   * the thread reported from another branch (core/pr-links.ts) links it quietly, with no Board row, notice or log line,
   * since it is old news to the thread that opened it; its later changes are news as any PR's are.
   */
  prSeen(a: Agent, environmentId: string, res: PrResult, label = "", linking = false): boolean {
    // the environment's PRs are its live holder's: a handoff successor shares the environment, and an unchanged reading
    // below writes nothing, so the rows kept naming the retired predecessor. Quiet: the PR didn't change.
    this.db.prepare(`UPDATE prs SET thread_id = ? WHERE environment_id = ? AND thread_id <> ?`).run(a.threadId, environmentId, a.threadId);
    if (res.outcome !== "available") return false;
    const pr = res.pullRequest;
    // the PR belongs to its holder's task for good (on every reading, so a thread filed later links on its next one)
    linkPr(this.db, pr.url, addressTask(this.db, a.address), "bb", a.address, this.now());
    // bb reads this PR now: a PR wait's own gh reading of it is older news (bb's reading is kept when it has one)
    this.db.prepare(`DELETE FROM pr_readings WHERE url = ?`).run(pr.url.replace(/\/+$/, ""));
    const old = this.db.prepare(`SELECT url, state, checks, attention, sig FROM prs WHERE environment_id = ? AND url = ?`).get(environmentId, pr.url) as
      | { url: string | null; state: string | null; checks: string | null; attention: string | null; sig: string }
      | undefined;
    const legacy = old !== undefined && !old.sig.startsWith("v2|"); // older signature: url|state|attention|checks
    const prev = !old || old.url !== pr.url ? null : legacy ? { merge: old.attention === "conflicts" ? "conflicts" : null } : { merge: old.sig.split("|")[5] || null };
    const { checks, review, merge, queued, sig, ready, shown } = prFacts(pr, prev ? prev.merge : undefined);
    if (old?.sig === sig) return false;
    // a changed signature format, or an old merge word for the same state, is no news: the first reading only rewrites it
    const was = old && !legacy ? old.sig.split("|") : null;
    const reworded = !!was && [...was.slice(0, 5), approvalWord(was[2] ?? null, was[4] || null, was[5] || null) ?? "", ...was.slice(6)].join("|") === sig;
    const linked = linking && !old;
    const quiet = linked || reworded || (legacy && old.url === pr.url && old.state === pr.state && old.checks === checks);
    return tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO prs (environment_id, thread_id, url, number, state, attention, checks, sig, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(environment_id, url) DO UPDATE SET thread_id = excluded.thread_id, number = excluded.number, state = excluded.state,
             attention = excluded.attention, checks = excluded.checks, sig = excluded.sig, seen_at = excluded.seen_at`,
        )
        .run(environmentId, a.threadId, pr.url, pr.number ?? null, pr.state, shown, checks, sig, this.now());
      // the log keeps the PR's state changes (opened, merged, closed), not its checks or review
      if (!linked && (!old || old.url !== pr.url || old.state !== pr.state))
        this.event({ kind: "pr", project: a.project, address: a.address, threadId: a.threadId, value: pr.state, ref: pr.url, note: pr.number != null ? String(pr.number) : null });
      this.checkWaits(pr.url);
      if (quiet) return false;
      const settled = pr.state === "merged" || pr.state === "closed";
      const facts = settled ? [] : [merge, review, queued ? "queued" : null].filter((x): x is string => !!x && x !== "none" && x !== "unknown" && x !== pr.state).map((x) => x.replace(/_/g, " "));
      const what = `PR${pr.number ? ` #${pr.number}` : ""} ${pr.state}${facts.length ? ` (${facts.join(", ")})` : ""}${checks ? `, checks ${checks}` : ""}`;
      this.boardAdd("prstate", a.address, a.project, `${a.address}: ${what}${label}`, pr.url, pr.url);
      const body = `${a.address}: ${what}${label} ${pr.url}`;
      if (a.role === "thread" && this.agentByAddress(`lead:${a.project}`)) this.put({ recipient: `lead:${a.project}`, sender: "orchestrator", kind: "notice", ref: pr.url, body, needsAck: false });
      if ((pr.state === "merged" || ready) && this.agentByAddress("cos")) this.put({ recipient: "cos", sender: "orchestrator", kind: "notice", ref: pr.url, body, needsAck: false });
      this.ports.changed();
      return true;
    });
  }

  /**
   * The PRs of live environments that bb's readings this pass (`bb`, by environment) didn't cover, to read by URL with gh
   * (core/pr-links.ts). `linked`: an environment's other PR, not merged or closed yet, where bb answered for the
   * environment (another PR, or none). Where bb didn't answer (a machine that's off) nothing is read: the
   * environment's own PR must not go back and forth between bb's reading and gh's. Not linked: a PR a live thread
   * reported (orch_report pr, any holder of its address) that no row of its environment holds, and that no other live
   * environment holds either (bb read it there, on its own branch: it is that thread's PR).
   */
  prsToRead(bb: ReadonlyMap<string, PrResult>): { agent: Agent; url: string; linked: boolean }[] {
    const skip = new Set([...bb.values()].flatMap((r) => (r.outcome === "available" ? [r.pullRequest.url.trim().replace(/\/+$/, "")] : [])));
    const live = new Map(this.agents().filter((a) => (a.role === "thread" || a.role === "lead") && a.environmentId && a.status !== "archived").map((a) => [a.environmentId!, a]));
    const out: { agent: Agent; url: string; linked: boolean }[] = [];
    const held = this.db.prepare(`SELECT environment_id, url, state FROM prs`).all() as { environment_id: string; url: string; state: string | null }[];
    for (const r of held) {
      const a = live.get(r.environment_id);
      const answered = bb.get(r.environment_id)?.outcome;
      if (a && (answered === "available" || answered === "absent") && !skip.has(r.url) && r.state !== "merged" && r.state !== "closed") out.push({ agent: a, url: r.url, linked: true });
    }
    const liveHeld = new Set(held.filter((r) => live.has(r.environment_id)).map((r) => r.url));
    const reports = this.db.prepare(`SELECT DISTINCT from_address, ref FROM board WHERE kind = 'pr' AND from_address LIKE 'thread:%' AND ref IS NOT NULL`).all() as { from_address: string; ref: string }[];
    const byAddress = new Map([...live.values()].filter((a) => a.role === "thread").map((a) => [a.address, a]));
    const seen = new Set<string>();
    for (const r of reports) {
      const a = byAddress.get(r.from_address);
      const url = r.ref.trim().replace(/\/+$/, "");
      if (!a || !PR_URL_RE.test(url) || skip.has(url) || liveHeld.has(url) || seen.has(`${a.threadId} ${url}`)) continue;
      seen.add(`${a.threadId} ${url}`);
      out.push({ agent: a, url, linked: false });
    }
    return out;
  }

  /** When the thread last reported finished work (orch_report), or null. */
  lastReportAt(address: string): number | null {
    const r = this.db.prepare(`SELECT MAX(at) AS at FROM board WHERE from_address = ? AND kind IN ('report','pr')`).get(address) as { at: number | null };
    return r.at;
  }

  /**
   * A lead resolves one of its threads: allowed once its worktree is clean (`worktree`: nothing uncommitted, its branch
   * in its base branch or pushed), and its PR is merged, its branch is in its base branch (a local merge, no PR), its
   * PR was closed without merging and it has reported, its open PR is handed off to someone else (`handedOff`, recorded
   * for the project page), or the owner has read the thread since its last report. The role is retired; the caller then archives the thread
   * and its handoff predecessors.
   */
  resolve(lead: Agent, to: string, facts: { prMerged: boolean; prClosed?: boolean; lastReadAt: number | null; worktree?: Verdict; handedOff?: HandedOffIn | null }): string {
    if (lead.role !== "lead") throw new EngineError("forbidden", "only a lead resolves threads");
    const t = this.agentByAddress(to);
    if (!t) {
      // a retired address isn't "someone else's thread": say what happened to it
      const old = this.db.prepare(`SELECT thread_id, project, retired_at FROM agents WHERE address = ? AND retired_at IS NOT NULL ORDER BY retired_at DESC LIMIT 1`).get(to) as
        | { thread_id: string; project: string | null; retired_at: number }
        | undefined;
      if (old && old.project === lead.project) {
        const done = this.db.prepare(`SELECT 1 FROM board WHERE kind IN ('resolved','archived') AND ref = ?`).get(old.thread_id);
        if (done) return `${to} was already resolved (${iso(old.retired_at)}); nothing more to do.`;
        throw new EngineError("bad_state", `${to} is retired (${iso(old.retired_at)}); there is nothing to resolve`);
      }
    }
    if (!t || t.role !== "thread" || t.project !== lead.project) throw new EngineError("forbidden", "resolve only your own threads");
    const w = facts.worktree;
    if (!w) throw new EngineError("bad_state", `${to}'s worktree state is unknown`);
    if (!w.clean) throw new EngineError("bad_state", `${to}'s worktree isn't clean: ${w.why}. Have the thread commit and merge or push, then resolve`);
    const off = facts.handedOff ? handedOffOf(facts.handedOff) : null;
    let why: string;
    if (facts.prMerged) why = "its PR is merged";
    else if (w.inBase) {
      // a branch with no commits of its own also reads as "in main": the thread must have reported its work
      if (this.lastReportAt(to) === null) throw new EngineError("bad_state", `${to} has no report: it reports with orch_report first`);
      why = w.why;
    } else if (facts.prClosed) {
      // closed without merging (dropped, or landed another way): the thread's report says which; nothing waits on the PR
      if (this.lastReportAt(to) === null) throw new EngineError("bad_state", `${to}'s PR was closed and it has no report: it reports with orch_report first`);
      why = "its PR was closed without merging and it has reported";
    } else if (off) {
      // the PR stays open, but it is someone else's now: the project page lists it under Handed off
      why = `its open PR is handed off to ${off.owner}`;
    } else {
      const rep = this.lastReportAt(to);
      if (rep === null) throw new EngineError("bad_state", `${to} has no merged PR and no report: it reports with orch_report first`);
      if (facts.lastReadAt === null || facts.lastReadAt < rep) throw new EngineError("bad_state", `${to}'s PR isn't merged and ${this.owner.name} hasn't read its last report yet`);
      why = `${this.owner.name} has read its final report`;
    }
    tx(this.db, () => {
      this.retire(t.threadId);
      this.event({ kind: "resolve", project: t.project, address: t.address, threadId: t.threadId, value: why, ...(off ? { ref: off.pr, note: off.owner } : {}) });
      if (off)
        this.db
          .prepare(`INSERT INTO handed_off_prs (project, thread_address, thread_id, pr, owner, note, by_address, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(t.project, t.address, t.threadId, off.pr, off.owner, off.note, lead.address, this.now());
      // the handed-off PR stays on the thread's task, whatever bb's last reading of it was: it blocks Shipped until it merges
      if (off) linkPr(this.db, off.pr, addressTask(this.db, t.address), "handoff", t.address, this.now());
      this.boardAdd("resolved", lead.address, lead.project, `${to} resolved: ${why}`, `Its worktree is clean (${w.why}); the thread is archived.`, t.threadId);
    });
    return `Resolved ${to} (${why === w.why ? why : `${why}; worktree clean: ${w.why}`}).`;
  }

  /** Open PRs whose threads were resolved as handed off, newest first, per project (the project page's Handed off list). */
  handedOffPrs(): Map<string, HandedOff[]> {
    const rows = this.db.prepare(`SELECT project, thread_address, pr, owner, note, at FROM handed_off_prs WHERE project IS NOT NULL ORDER BY at DESC, id DESC`).all() as { project: string; thread_address: string; pr: string; owner: string; note: string | null; at: number }[];
    const out = new Map<string, HandedOff[]>();
    for (const r of rows) out.set(r.project, [...(out.get(r.project) ?? []), { pr: r.pr, owner: r.owner, note: r.note, at: r.at, thread: r.thread_address }]);
    return out;
  }

  /**
   * The handoff predecessors of a thread, oldest first: takeOver retires the old holder of the address and adds the
   * successor in one step, so a predecessor's retired_at is its successor's created_at (the first holder often has no
   * environment recorded, so the environment can't link them). A second's gap is allowed. Resolving the successor archives these first.
   */
  predecessors(threadId: string): string[] {
    const prev = this.db.prepare(
      `SELECT p.thread_id FROM agents s JOIN agents p ON p.address = s.address AND p.thread_id <> s.thread_id AND p.retired_at BETWEEN s.created_at - ${HANDOFF_GAP_MS} AND s.created_at
        WHERE s.thread_id = ? ORDER BY p.retired_at DESC LIMIT 1`,
    );
    const out: string[] = [];
    for (let id = threadId; ; ) {
      const r = prev.get(id) as { thread_id: string } | undefined;
      if (!r || out.includes(r.thread_id)) break;
      out.unshift(r.thread_id);
      id = r.thread_id;
    }
    return out;
  }

  /** Threads (role thread, never a lead, the CoS or the Steward) whose role is retired, for the one-time sweep; `predecessor` marks a handoff's stopped thread. */
  retiredThreads(): { threadId: string; address: string; project: string | null; environmentId: string | null; retiredAt: number; predecessor: boolean }[] {
    const rows = this.db
      .prepare(
        `SELECT r.thread_id, r.address, r.project, r.environment_id, r.retired_at,
                EXISTS (SELECT 1 FROM agents n WHERE n.address = r.address AND n.thread_id <> r.thread_id AND n.created_at BETWEEN r.retired_at AND r.retired_at + ${HANDOFF_GAP_MS}) AS predecessor
           FROM agents r
          WHERE r.retired_at IS NOT NULL AND r.role = 'thread'
          ORDER BY r.retired_at`,
      )
      .all() as { thread_id: string; address: string; project: string | null; environment_id: string | null; retired_at: number; predecessor: number }[];
    return rows.map((r) => ({ threadId: r.thread_id, address: r.address, project: r.project, environmentId: r.environment_id, retiredAt: r.retired_at, predecessor: r.predecessor === 1 }));
  }

  /** The owner's Archive click is allowed only on a resolved thread. */
  archivable(threadId: string): void {
    const r = this.db.prepare(`SELECT 1 FROM board WHERE kind = 'resolved' AND ref = ?`).get(threadId);
    if (!r) throw new EngineError("forbidden", `${threadId} wasn't resolved`);
    if (this.agentByThread(threadId)) throw new EngineError("bad_state", `${threadId} has a live role again`);
  }

  /** A handoff successor takes over the address (and its mail, Pokémon and plan slot); the old thread is retired. */
  takeOver(oldThreadId: string, newThreadId: string, note: string, providers: { from: string | null; to: string | null } = { from: null, to: null }): Agent {
    return tx(this.db, () => {
      const old = this.agentByThread(oldThreadId);
      if (!old) throw new EngineError("not_found", `${oldThreadId} has no live role`);
      if (this.agentByThread(newThreadId)) throw new EngineError("conflict", `${newThreadId} already has a role`);
      // one instant for both: the predecessor's retired_at is the successor's created_at (predecessors() links them)
      const at = this.now();
      this.retire(oldThreadId, true, at);
      this.batch.handoff(old.address);
      this.db
        .prepare(
          `INSERT INTO agents (thread_id, address, role, project, parent_thread_id, status, created_at, mon, mon_stage, mon_stage_level, environment_id)
           SELECT ?, ?, ?, ?, ?, 'unknown', ?, mon, mon_stage, mon_stage_level, ? FROM agents WHERE thread_id = ?`,
        )
        .run(newThreadId, old.address, old.role, old.project, old.parentThreadId, at, old.environmentId, oldThreadId);
      // the successor takes the old thread's spawn row (and so its plan slot); it never adds a second row on the plan
      const moved = this.db.prepare(`UPDATE spawns SET thread_id = ? WHERE thread_id = ?`).run(newThreadId, oldThreadId) as { changes: number | bigint };
      if (Number(moved.changes) === 0) this.db.prepare(`INSERT OR IGNORE INTO spawns (thread_id, plan_id, via, lead, created_at) VALUES (?, NULL, 'handoff', NULL, ?)`).run(newThreadId, this.now());
      // the old thread's undelivered mail now goes to the successor (delivered-but-unacked items are re-sent once)
      this.db.prepare(`UPDATE items SET state = 'pending', queued_message_id = NULL WHERE recipient = ? AND state IN ('queued','delivered') AND needs_ack = 1`).run(old.address);
      this.event({ at, kind: "handoff", project: old.project, address: old.address, threadId: newThreadId, ref: oldThreadId, value: providers.to, note: providers.from });
      this.boardAdd("notice", "orchestrator", old.project, `${old.address} handed over`, `${oldThreadId} → ${newThreadId}. ${note}`, newThreadId);
      return this.agentByThread(newThreadId)!;
    });
  }


  /**
   * A lead or thread records a finished artefact. A file must be absolute, exist, and resolve (symlinks followed)
   * inside one of `place.roots` (the caller's environment folder and the shared state and vault folders); its realpath
   * is kept. A link must be http(s): it becomes a link on the owner's screen. The same file or link twice in a project is
   * one output. A new one also goes on the Board.
   */
  addOutput(by: Agent, input: OutputInput, place: OutputPlace): { output: OutputRow; created: boolean } {
    if (by.role !== "lead" && by.role !== "thread") throw new EngineError("forbidden", "only leads and threads record outputs");
    const title = oneLine(input.title, 200, "title");
    if (!OUTPUT_KINDS.includes(input.kind)) throw new EngineError("invalid", `kind is one of ${OUTPUT_KINDS.join(", ")}`);
    const hasPath = input.path != null && input.path !== "";
    const hasUrl = input.url != null && input.url !== "";
    if (hasPath === hasUrl) throw new EngineError("invalid", "give one of path or url");
    if (input.kind === "link" && !hasUrl) throw new EngineError("invalid", "a link is a url, not a path");
    const path = hasPath ? outputPath(input.path!, place.roots) : null;
    const url = hasUrl ? outputUrl(input.url!) : null;
    const note = input.note?.trim() ? input.note.trim().slice(0, 2000) : null;
    return tx(this.db, () => {
      const there = this.db.prepare(`SELECT * FROM outputs WHERE project IS ? AND (path = ? OR url = ?)`).get(by.project, path, url) as OutputDbRow | undefined;
      if (there) return { output: toOutput(there), created: false };
      const id = `o-${hex(6)}`;
      this.db
        .prepare(`INSERT INTO outputs (id, title, kind, path, url, host_id, note, project, author, thread_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, title, input.kind, path, url, path ? place.hostId : null, note, by.project, by.address, by.threadId, this.now());
      this.boardAdd("output", by.address, by.project, title, `${input.kind}: ${path ?? url}${note ? `\n${note}` : ""}`, id);
      return { output: this.output(id)!, created: true };
    });
  }

  output(id: string): OutputRow | null {
    const r = this.db.prepare(`SELECT * FROM outputs WHERE id = ?`).get(id) as OutputDbRow | undefined;
    return r ? toOutput(r) : null;
  }

  /** Newest first. */
  outputs(limit = 500): OutputRow[] {
    return (this.db.prepare(`SELECT * FROM outputs ORDER BY at DESC, id DESC LIMIT ?`).all(limit) as OutputDbRow[]).map(toOutput);
  }

  /** Outputs whose file is inside `dir` (a worktree about to be archived, which bb then removes). */
  outputsUnder(dir: string): OutputRow[] {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    return (this.db.prepare(`SELECT * FROM outputs WHERE path IS NOT NULL AND substr(path, 1, ?) = ?`).all(prefix.length, prefix) as OutputDbRow[]).map(toOutput);
  }

  /** Points an output at a kept copy of its file, so the Deliverables tab still opens it once the worktree is gone. */
  repointOutput(id: string, path: string): void {
    const o = this.output(id);
    const was = o?.path ?? null;
    this.db.prepare(`UPDATE outputs SET path = ? WHERE id = ?`).run(path, id);
    // a live pin of that file follows it to the kept copy: the worktree it was in goes after archive's grace period
    // stored as its realpath, as pinning does: pinViews treats a path that resolves elsewhere as gone
    let real = path;
    try {
      real = realpathSync(path);
    } catch {
      /* not there (yet): kept as given */
    }
    // only the output's own project and host: the same path in another project, or on another machine, is another file
    if (o && was) this.db.prepare(`UPDATE project_pins SET path = ? WHERE kind = 'file' AND path = ? AND project IS ? AND host_id IS ? AND unpinned_at IS NULL`).run(real, was, o.project, o.hostId);
    this.ports.changed();
  }

  /** The owner removes one from the record (the file itself is never touched). Only their HTTP write calls this. */
  removeOutput(id: string): void {
    if (!this.output(id)) throw new EngineError("not_found", `no output ${id}`);
    this.db.prepare(`DELETE FROM outputs WHERE id = ?`).run(id);
    this.ports.changed();
  }


  /**
   * Pins a document to a project's strip. `target`: an http(s) URL (outputUrl), a deliverable id of this project, or an
   * absolute path, checked exactly as proof is (outputPath: realpath, inside `place.roots`) and opened on `place.hostId`.
   * `by`: the owner (the page or the CLI), or the project's own lead. Threads don't pin: the strip is the lead's shortlist.
   */
  pin(project: string, target: string, o: { title?: string | null; by: Agent | "owner" }, place: OutputPlace): { pin: Pin; created: boolean } {
    if (!this.project(project)) throw new EngineError("not_found", `no project ${project}`);
    if (o.by !== "owner" && (o.by.role !== "lead" || o.by.project !== project)) throw new EngineError("forbidden", `only ${project}'s lead or the owner pins to ${project}`);
    const raw = target.trim();
    let t: PinTarget;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !raw.startsWith("/")) t = { kind: "link", url: outputUrl(raw) };
    else if (/^v-[0-9a-f]{6,}$/.test(raw)) t = { kind: "deliverable", id: raw };
    else {
      const path = outputPath(raw, place.roots, o.by === "owner" ? `${project}'s folders` : undefined);
      // the machine of the folder it is in: a thread's worktree on another host must open there, not on the lead's. A
      // folder without a host never borrows another's: the same path there could be a different file.
      const own = place.hosts ? hostOfPath(path, place.hosts) : undefined;
      const hostId = own === undefined ? place.hostId : own;
      if (!hostId) throw new EngineError("bad_state", `no bb host for ${project}'s folders, so the file couldn't be opened`);
      t = { kind: "file", path, hostId };
    }
    const r = addPin(this.db, project, t, { title: o.title, by: o.by === "owner" ? "owner" : o.by.address, now: this.now(), id: `pin-${hex(6)}` });
    if (r.created) this.ports.changed();
    return r;
  }

  /** Unpins by id, or by its path, URL or deliverable id within `project`. A lead unpins only in its own project. */
  unpinDoc(ref: string, o: { by: Agent | "owner"; project?: string | null }): Pin {
    const p = o.project ? findPin(this.db, o.project, ref) : getPin(this.db, ref);
    if (!p) throw new EngineError("not_found", `no pin ${ref}${o.project ? ` in ${o.project}` : ""}`);
    if (o.by !== "owner" && (o.by.role !== "lead" || o.by.project !== p.project)) throw new EngineError("forbidden", `only ${p.project}'s lead or the owner unpins there`);
    const was = p.unpinnedAt;
    const out = unpin(this.db, p.id, this.now());
    if (was === null) this.ports.changed();
    return out;
  }

  /** A project's live pins, with "updated" read now (file mtimes, deliverables' latest revision). */
  pins(project: string): PinView[] {
    return pinViews(this.db, project);
  }


  deliverable(id: string): Deliverable | null {
    const r = this.db.prepare(`SELECT id, json FROM deliverables WHERE id = ?`).get(id) as DeliverableDbRow | undefined;
    return r ? (JSON.parse(r.json) as Deliverable) : null;
  }

  private mustDeliverable(id: string): Deliverable {
    const d = this.deliverable(id);
    if (!d) throw new EngineError("not_found", `no deliverable ${id}`);
    return d;
  }

  /** Newest change first; `board`: only a board's (true) or only the rest (false). */
  deliverables(limit = 200, board?: boolean): Deliverable[] {
    const only = board === undefined ? "" : `WHERE json_extract(json, '$.board') IS ${board ? "NOT " : ""}NULL`;
    return (this.db.prepare(`SELECT id, json FROM deliverables ${only} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(limit) as DeliverableDbRow[]).map((r) => JSON.parse(r.json));
  }

  private saveDeliverable(d: Deliverable): void {
    d.updatedAt = this.now();
    this.db
      .prepare(
        `INSERT INTO deliverables (id, project, lead, title, summary, state, rev, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, summary = excluded.summary, state = excluded.state, rev = excluded.rev,
           updated_at = excluded.updated_at, json = excluded.json`,
      )
      .run(d.id, d.project, d.lead, d.title, d.summary, d.state, d.rev, d.createdAt, d.updatedAt, JSON.stringify(d));
    linkDeliverablePrs(this.db, d, d.updatedAt);
    this.readme(d);
    this.ports.changed();
  }


  /** Its README follows every save (state, revision, retitle). A failed write is logged, never a failed save. */
  private readme(d: Deliverable): void {
    if (!d.folder) return;
    try {
      writeReadme(d, d.folder);
    } catch (e) {
      this.ports.log(`deliverable ${d.id}: README not written (${String(e)})`);
    }
  }

  /**
   * Copy the file proof in `proof` into the deliverable's folder (made on first use) and point each item at its copy.
   * Items already filed are left as they are; a failed copy keeps the original and is tried again by the backfill.
   * Returns what each item it filed got (none: nothing changed). Without a files port nothing is copied.
   */
  private fileInto(d: Deliverable, proof: Proof[]): Kept[] {
    const f = this.ports.files?.();
    if (!f || !proof.some((p) => p.path && (!p.stored || p.stored === "failed"))) return [];
    try {
      if (!d.folder || !existsSync(d.folder)) {
        const at = d.folder ?? folderFor(f.dir, d);
        mkdirSync(at, { recursive: true });
        d.folder = realpathSync(at);
      }
    } catch (e) {
      this.ports.log(`deliverable ${d.id}: no folder (${String(e)})`);
      return [];
    }
    const kept: Kept[] = [];
    for (const p of proof) {
      if (!p.path || (p.stored && p.stored !== "failed")) continue;
      const was = p.source ?? p.path;
      // proof is registered by realpath: one since swapped for a symlink is no longer that file (proofFile refuses it too)
      let k: Kept = registered(was) ? keepFile(d.folder, was, f.maxBytes ?? COPY_MAX) : { stored: "missing" };
      // gone from its worktree, but the archive kept it as a thread output: copy that (the proof's source stays the original)
      const archived = k.stored === "missing" && f.kept ? keptCopy(f.kept, was) : null;
      if (archived) {
        k = keepFile(d.folder, archived, f.maxBytes ?? COPY_MAX);
        if (k.stored === "copied") p.source = was;
      }
      if (k.stored === "failed") this.ports.log(`deliverable ${d.id}: ${p.path} not copied (${k.why})`);
      fileProof(p, k);
      kept.push(k);
    }
    return kept;
  }

  /**
   * One-time and idempotent (run on every start): copy the surviving files of earlier deliverables into
   * their folders, and record the missing ones. Each proof item it files is marked, so a second run copies nothing. It
   * isn't activity: updated_at, the Board and pushes are untouched.
   */
  backfillFiles(): { deliverables: number; copied: number; reused: number; tooBig: number; failed: number; missing: { id: string; title: string; path: string }[] } {
    const out = { deliverables: 0, copied: 0, reused: 0, tooBig: 0, failed: 0, missing: [] as { id: string; title: string; path: string }[] };
    if (!this.ports.files?.()) return out;
    const rows = this.db.prepare(`SELECT id, json FROM deliverables ORDER BY created_at, id`).all() as DeliverableDbRow[];
    for (const row of rows) {
      const d = JSON.parse(row.json) as Deliverable;
      const proof = d.revisions.flatMap((r) => r.proof);
      const missingBefore = new Set(proof.filter((p) => p.stored === "missing").map((p) => p.id));
      const kept = this.fileInto(d, proof);
      if (!kept.length && d.folder) continue;
      if (!kept.length) {
        // links only: a folder for its README all the same, so every deliverable is browsed the same way
        const f = this.ports.files!()!;
        const at = folderFor(f.dir, d);
        try {
          mkdirSync(at, { recursive: true });
          d.folder = realpathSync(at);
        } catch (e) {
          this.ports.log(`deliverable ${d.id}: no folder (${String(e)})`);
          continue;
        }
      }
      out.deliverables++;
      for (const k of kept) {
        // reused: a copy that already held these bytes (a later revision showing the same file again)
        if (k.stored === "copied") out[k.reused ? "reused" : "copied"]++;
        else if (k.stored === "too_big") out.tooBig++;
        else if (k.stored === "failed") out.failed++;
      }
      for (const p of proof) if (p.stored === "missing" && !missingBefore.has(p.id)) out.missing.push({ id: d.id, title: d.title, path: p.path! });
      this.db.prepare(`UPDATE deliverables SET json = ? WHERE id = ?`).run(JSON.stringify(d), d.id);
      this.readme(d);
    }
    if (out.deliverables) this.ports.changed();
    return out;
  }

  /**
   * The folder a resolving thread's notes and outputs go to: the newest deliverable of its project's lead that shows
   * the thread's work, that is a proof file from inside its worktree (`root`) or one of the outputs it recorded.
   */
  deliverableForThread(threadId: string, root: string | null): Deliverable | null {
    // retired or not: archiving follows the resolve
    const a = this.db.prepare(`SELECT project FROM agents WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1`).get(threadId) as { project: string | null } | undefined;
    if (!a?.project) return null;
    const prefix = root ? (root.endsWith(sep) ? root : root + sep) : null;
    const mine = new Set((this.db.prepare(`SELECT path, url FROM outputs WHERE thread_id = ?`).all(threadId) as { path: string | null; url: string | null }[]).flatMap((o) => [o.path, o.url]).filter((x): x is string => !!x));
    const rows = this.db.prepare(`SELECT json FROM deliverables WHERE lead = ? ORDER BY updated_at DESC, id DESC`).all(`lead:${a.project}`) as { json: string }[];
    for (const r of rows) {
      const d = JSON.parse(r.json) as Deliverable;
      if (!d.folder) continue;
      const shows = d.revisions.some((v) =>
        v.proof.some((p) => [p.source, p.path, p.url].some((x) => !!x && (mine.has(x) || (!!prefix && x.startsWith(prefix))))),
      );
      if (shows) return d;
    }
    return null;
  }

  /**
   * The folders of the deliverables the tab shows (the same newest 200), listed, for the Deliverables tab. `hostId`: the
   * host of a copied proof file; every folder is on that machine, the plugin's own (null: none copied yet).
   */
  deliverableFolders(): { hostId: string | null; folders: Record<string, NonNullable<ReturnType<typeof listFolder>>> } {
    const folders: Record<string, NonNullable<ReturnType<typeof listFolder>>> = {};
    let hostId: string | null = null;
    for (const d of [...this.deliverables(200, false), ...this.deliverables(200, true)]) {
      hostId ??= d.revisions.flatMap((r) => r.proof).find((p) => p.stored === "copied" && p.hostId)?.hostId ?? null;
      const f = d.folder ? listFolder(d.folder) : null;
      if (f) folders[d.id] = f;
    }
    return { hostId, folders };
  }

  /** The outputs a resolving thread's archive keeps: every one inside its worktree (whoever recorded it), and its own. */
  threadOutputs(threadId: string, root: string): OutputRow[] {
    const own = (this.db.prepare(`SELECT * FROM outputs WHERE thread_id = ? AND path IS NOT NULL`).all(threadId) as OutputDbRow[]).map(toOutput);
    const seen = new Set<string>();
    return [...this.outputsUnder(root), ...own].filter((o) => !seen.has(o.id) && !!seen.add(o.id));
  }

  /** Copy a file into a deliverable's folder (a thread's notes and outputs as it resolves) and rewrite its README. */
  keepInDeliverable(id: string, src: string): Kept {
    const d = this.mustDeliverable(id);
    if (!d.folder) throw new EngineError("bad_state", `${id} has no folder`);
    const k = keepFile(d.folder, src, this.ports.files?.()?.maxBytes ?? COPY_MAX);
    if (k.stored === "failed") throw new Error(`${src} not copied into ${d.folder}: ${k.why}`);
    this.readme(d);
    return k;
  }

  /**
   * Check each proof item: a file the way orch_output checks one (absolute, a file, inside `place.roots` after
   * symlinks), kept with the host of the folder it is in; a link http(s) only. Images and videos must be a type the
   * proof route serves; text must be small enough to show.
   */
  private proofItems(raw: ProofInput[], place: DeliverPlace): Proof[] {
    if (!Array.isArray(raw) || raw.length === 0) throw new EngineError("invalid", "a deliverable needs proof: at least one screenshot, video, test output, PR, doc or link");
    if (raw.length > PROOF_MAX) throw new EngineError("invalid", `at most ${PROOF_MAX} proof items`);
    const roots = place.roots.map((r) => r.path);
    return raw.map((p, i) => {
      const what = `proof ${i + 1}`;
      if (!PROOF_KINDS.includes(p.kind)) throw new EngineError("invalid", `${what}: kind is one of ${PROOF_KINDS.join(", ")}`);
      const caption = oneLine(p.caption ?? "", 200, `${what}'s caption`);
      const hasPath = p.path != null && p.path !== "";
      const hasUrl = p.url != null && p.url !== "";
      if (hasPath === hasUrl) throw new EngineError("invalid", `${what}: give one of path or url`);
      if ((p.kind === "image" || p.kind === "video" || p.kind === "text") && !hasPath) throw new EngineError("invalid", `${what}: ${p.kind} proof is a file path`);
      if ((p.kind === "pr" || p.kind === "link") && !hasUrl) throw new EngineError("invalid", `${what}: ${p.kind} proof is a url`);
      if (!hasPath) return { id: `p-${hex(6)}`, kind: p.kind, caption, path: null, url: outputUrl(p.url!), hostId: null };
      const path = outputPath(p.path!, roots);
      if (p.kind === "image" || p.kind === "video") {
        const ext = extname(path).toLowerCase();
        if (!PROOF_TYPES[p.kind][ext]) throw new EngineError("invalid", `${what}: ${p.kind} proof is one of ${Object.keys(PROOF_TYPES[p.kind]).join(" ")}`);
      }
      if (p.kind === "text" && statSync(path).size > TEXT_PROOF_MAX) throw new EngineError("invalid", `${what}: text proof is at most ${TEXT_PROOF_MAX / 1024} KB; cut it to the part that proves the result`);
      const host = place.roots.find((r) => {
        try {
          const real = realpathSync(r.path);
          return path.startsWith(real.endsWith(sep) ? real : real + sep);
        } catch {
          return false;
        }
      });
      if (p.kind === "doc" && !host?.hostId) throw new EngineError("invalid", `${what}: can't tell which bb host ${p.path} is on, so ${this.owner.name} couldn't open it`);
      return { id: `p-${hex(6)}`, kind: p.kind, caption, path, url: null, hostId: host?.hostId ?? null };
    });
  }

  /**
   * A lead hands the owner a finished deliverable with proof, or (`revises`) a new revision of one the owner sent back. It goes
   * into the owner's review, a quiet Activity row records it, and the push hook fires.
   */
  deliver(by: Agent, input: DeliverInput, place: DeliverPlace): Deliverable {
    if (by.role !== "lead") throw new EngineError("forbidden", `only a lead delivers to ${this.owner.name}; threads deliver to their lead (orch_report, orch_output)`);
    const title = oneLine(input.title, 120, "title");
    const summary = (input.summary ?? "").trim();
    if (!summary) throw new EngineError("invalid", "summary is empty");
    if (summary.length > 4000) throw new EngineError("invalid", "summary is over 4000 characters");
    const proof = this.proofItems(input.proof, place);
    const blocks = parseBlocks(input.blocks);
    if (blocks.some((b) => b.kind === "login")) throw new EngineError("invalid", "a deliverable has no sign-in; ask with orch_ask");
    const points = parsePoints(input.points);
    return tx(this.db, () => {
      const t = this.now();
      // scoping: reviewed in the owner's Scope pane, not on Deliverables; no push, a read-only copy to the CoS.
      // A scoping task's too; a revision stays in the task its earlier rev was in while that task is open.
      if (input.board && input.scopeTask) throw new EngineError("invalid", "board and scope_task route a deliverable to different places: give one");
      let task = input.scopeTask ? this.resolveTask(by, input.scopeTask).id : null;
      const workTask = input.task ? this.workTask(by, input.task).id : null;
      let scoping = !input.board && (!!task || this.isScoping(by.project));
      let d: Deliverable;
      let board: Deliverable["board"] = input.board ? { id: input.board.id, ...(input.board.record ? { record: input.board.record } : {}), ...(input.board.flag ? { flag: input.board.flag } : {}) } : undefined;
      if (input.revises) {
        d = this.mustDeliverable(input.revises);
        if (d.lead !== by.address) throw new EngineError("forbidden", `${d.id} is ${d.lead}'s deliverable`);
        // still in review too: a newer deliverable on the same topic replaces it in place, not beside it
        if (d.state !== "changes" && d.state !== "review") throw new EngineError("bad_state", `${d.id} is ${d.state}: revise only a deliverable still in review or one ${this.owner.name} sent back with changes`);
        // an old-schema lead revises without board: the revision stays on its board. Still in review, its flag is
        // unanswered, so it stays and the new revision gets its own Needs you card; sent back, the owner already settled it.
        if (!board && d.board) {
          const flag = d.state === "review" ? d.board.flag : undefined;
          board = { id: d.board.id, ...(d.board.record ? { record: d.board.record } : {}), ...(flag ? { flag } : {}) };
          scoping = false;
        }
        this.closeBoardCard(d, `rev ${d.rev + 1} replaced it`);
        if (!board && !task && d.scope_task && this.task(d.scope_task)?.state === "scoping") {
          task = d.scope_task;
          scoping = true;
        }
        d.rev += 1;
        d.title = title;
        d.summary = summary;
        d.state = "review";
        d.revisions.push({ rev: d.rev, summary, proof, at: iso(t), blocks, ...points });
        this.fileInto(d, proof);
        if (scoping) d.scope = true;
        else delete d.scope;
        if (task) d.scope_task = task;
        else delete d.scope_task;
        if (board) d.board = board;
        else delete d.board;
        if (workTask) d.task = workTask;
        this.saveDeliverable(d);
        // The owner's request is answered by the new revision: its item would otherwise be resent and dead-lettered
        this.closeItems(`recipient = ? AND kind = 'deliverable.changes' AND ref = ?`, [by.address, d.id], "done", `re-delivered as rev ${d.rev}`);
        this.boardAdd("deliverable", by.address, by.project, `Re-delivered: ${title} (rev ${d.rev})`, summary, d.id);
      } else {
        d = {
          id: `v-${hex(6)}`,
          project: by.project,
          lead: by.address,
          title,
          summary,
          state: "review",
          rev: 1,
          createdAt: t,
          updatedAt: t,
          revisions: [{ rev: 1, summary, proof, at: iso(t), blocks, ...points }],
          feedback: [],
          withdrawn: null,
          ...(scoping ? { scope: true } : {}),
          ...(task ? { scope_task: task } : {}),
          ...(board ? { board } : {}),
          ...(workTask ? { task: workTask } : {}),
        };
        this.fileInto(d, proof);
        this.saveDeliverable(d);
        this.boardAdd("deliverable", by.address, by.project, `Delivered: ${title}`, summary, d.id);
      }
      if (d.board?.flag) {
        d.board.card = this.boardCard(d).id;
        this.saveDeliverable(d);
      }
      // a board's review stays quiet on its board; a flag reaches the owner as its Needs you card
      if (!scoping && !d.board) this.ports.delivered?.(d);
      else if (scoping && this.agentByAddress("cos"))
        this.put({
          recipient: "cos",
          sender: by.address,
          kind: "copy",
          ref: d.id,
          body: `${by.address} delivered ${d.id} ${JSON.stringify(d.title)} (rev ${d.rev}) ${this.scopeWhy(d.project, d.scope_task)}: it is in ${this.owner.name}'s Scope pane, not Deliverables. Read-only copy: ${this.owner.name} reviews it there. ${JSON.stringify(summary.slice(0, 300))}`,
          key: `scope-copy:${d.id}:${d.rev}`,
          needsAck: false,
        });
      return d;
    });
  }

  /** A flagged board deliverable's Needs you card: asked by the orchestrator, so no rule settles it and its answer acts on the deliverable. */
  private boardCard(dl: Deliverable): Decision {
    const t = this.now();
    const flag = dl.board?.flag ?? "";
    const options = this.options([{ label: "Approve", detail: "Approves this revision; the lead is told" }, { label: "Send back", detail: "Sends it back to the lead with your note, or the flag" }], 2);
    const question = oneLine(`${flag}: ${dl.title}`.slice(0, 600), 600, "question");
    const context = `${dl.lead} delivered ${dl.id} (rev ${dl.rev}) from a Multiplayer board, flagged: ${flag}. Approve or send it back here, or on the board's review view.`;
    const d: Decision = {
      schema: 1,
      id: decisionId(t),
      rev: 0,
      state: "open",
      kind: "question",
      created_at: iso(t),
      updated_at: iso(t),
      project: dl.project,
      request_key: `board-flag:${dl.id}:${dl.rev}`,
      request: { by: { role: "orchestrator", project: null, thread: null, terminal: null, machine: null, address: "orchestrator" }, title: "Board review needs you", question, context, options },
      reply_to: { labels: { "orchestrator.address": "orchestrator" }, terminal: null, machine: null },
      ask: null,
      answer: null,
      relay: null,
      ack: null,
      cos_notified_at: null,
      owed_from: null,
      merged_into: null,
      merged: [],
      withdrawn: null,
      deferred: null,
      returned: null,
      history: [],
      orchestrator: {
        at_level: "person",
        asker: "orchestrator",
        origin: "orchestrator",
        action: null,
        triage: { filed_at: null, due_at: null, triaged_at: null, by: null, escalated_at: null },
        forwarded_by: null,
        plan: null,
        board_review: { deliverable: dl.id, rev: dl.rev },
      },
    };
    this.save(d, "add", "orchestrator", null, null);
    this.putAsk(d, "orchestrator", d.request.title, question, context, options, true);
    // a flag means the lead couldn't settle it, so neither answer is recommended
    d.ask!.options = d.ask!.options.map((o) => ({ ...o, recommended: false }));
    this.save(d, "ask", "orchestrator", null, null);
    this.ports.cardUp?.(d);
    return this.mustDecision(d.id);
  }

  /** The owner answered a board card: option 1 approves that revision; anything else sends it back. The card then closes. */
  private settleBoardCard(c: Decision): void {
    const br = c.orchestrator.board_review!;
    const dl = this.deliverable(br.deliverable);
    const text = c.answer?.text ?? null;
    if (dl && dl.state === "review" && dl.rev === br.rev) {
      if (c.answer?.option === "1") this.personApprove(dl.id, dl.rev, text);
      else this.personRequestChanges(dl.id, dl.rev, text ?? `Sent back from Needs you: ${dl.board?.flag ?? "flagged"}`);
    }
    this.orchestratorAck(c.id, "done", dl && dl.state === "review" ? null : `${br.deliverable} was already ${dl?.state ?? "gone"}`);
  }

  private closeBoardCard(dl: Deliverable, why: string): void {
    const c = dl.board?.card ? this.decision(dl.board.card) : null;
    if (c && (c.state === "open" || c.state === "asked")) this.mootOne(c, why, "orchestrator");
  }

  /** The lead takes back a deliverable that is in review or sent back (never an approved one). */
  withdrawDeliverable(by: Agent, id: string, reason: string | null): Deliverable {
    if (by.role !== "lead") throw new EngineError("forbidden", "only a lead withdraws its deliverables");
    return tx(this.db, () => {
      const d = this.mustDeliverable(id);
      if (d.lead !== by.address) throw new EngineError("forbidden", `${id} is ${d.lead}'s deliverable`);
      if (d.state !== "review" && d.state !== "changes") throw new EngineError("bad_state", `${id} is ${d.state}`);
      const why = reason?.trim() ? reason.trim().slice(0, 2000) : null;
      d.state = "withdrawn";
      d.withdrawn = { at: iso(this.now()), reason: why };
      this.closeBoardCard(d, "the lead withdrew it");
      this.saveDeliverable(d);
      this.closeItems(`recipient = ? AND kind = 'deliverable.changes' AND ref = ?`, [by.address, id], "superseded", "withdrawn");
      this.boardAdd("deliverable", by.address, by.project, `Withdrawn: ${d.title}`, why ?? "", id);
      return d;
    });
  }

  /** The owner's writes act only on the revision they saw: another rev is a conflict, a deliverable not in review bad_state. */
  private reviewable(id: string, rev: number): Deliverable {
    const d = this.mustDeliverable(id);
    if (d.rev !== rev) throw new EngineError("conflict", `${id} changed (rev ${d.rev}, you saw ${rev})`);
    if (d.state !== "review") throw new EngineError("bad_state", `${id} is ${d.state}, not in review`);
    return d;
  }

  /**
   * The owner approves the revision they saw. Without a next action the lead gets a notice and does nothing further.
   * With one ("forward this to the team") the lead gets it as a needs-ack item instead: they act on it and ack
   * with an outcome and a note, which the deliverable then shows (deliverableNext).
   */
  personApprove(id: string, rev: number, note: string | null, next: string | null = null): Deliverable {
    const action = next?.trim() || null;
    if (action && action.length > 4000) throw new EngineError("invalid", "a next action is at most 4000 characters");
    return tx(this.db, () => {
      const d = this.reviewable(id, rev);
      const text = note?.trim() ? note.trim().slice(0, 4000) : null;
      const at = iso(this.now());
      d.state = "approved";
      d.feedback.push({ rev, by: "person", text, at, outcome: "approved" });
      this.closeBoardCard(d, `${this.owner.name} approved it`);
      if (action) {
        const it = this.put({
          recipient: d.lead,
          sender: "person",
          kind: "deliverable.next",
          ref: id,
          body: `${this.owner.Name} approved ${id} ${JSON.stringify(d.title)} (rev ${rev}) and asks you to do next: ${JSON.stringify(action)}${text ? `\nTheir note: ${JSON.stringify(text)}` : ""}\nDo it, then ack this item with an outcome and a note saying what you did (where it went, a link); ${this.owner.name} sees that note on the deliverable. If you can't, ack it refused or failed with a note saying why.`,
          key: `next:${id}:${rev}`,
          needsAck: true,
        });
        d.next = { text: action, rev, at, item: it.id };
      } else {
        this.put({ recipient: d.lead, sender: "person", kind: "deliverable.approved", ref: id, body: `${this.owner.Name} approved ${id} ${JSON.stringify(d.title)} (rev ${rev})${text ? `: ${JSON.stringify(text)}` : "."}`, key: `approved:${id}:${rev}`, needsAck: false });
      }
      this.saveDeliverable(d);
      this.boardAdd("deliverable", "person", d.project, `Approved: ${d.title}`, action ? `Next: ${action}` : (text ?? ""), id);
      return d;
    });
  }

  /**
   * A deliverable's next action as it stands now, read from its item: however that item is closed (the lead's ack, a
   * reply that acks it, the CoS closing a dead letter), its outcome and note are the ones shown. Null without one.
   */
  deliverableNext(d: Deliverable): DeliverableNext | null {
    if (!d.next) return null;
    const it = this.item(d.next.item);
    const state = it?.state === "closed" ? "closed" : it?.state === "dead" ? "dead" : "open";
    return { ...d.next, state, outcome: state === "closed" ? (it?.outcome ?? null) : null, note: state === "closed" ? (it?.note ?? null) : null, closedAt: state === "closed" ? (it?.closedAt ?? null) : null };
  }

  /** The owner sends the revision they saw back with their words. The lead must act on it and re-deliver (`revises`). */
  personRequestChanges(id: string, rev: number, text: string): Deliverable {
    const words = (text ?? "").trim();
    if (!words) throw new EngineError("invalid", "say what to change");
    if (words.length > 4000) throw new EngineError("invalid", "at most 4000 characters");
    return tx(this.db, () => {
      const d = this.reviewable(id, rev);
      d.state = "changes";
      d.feedback.push({ rev, by: "person", text: words, at: iso(this.now()), outcome: "changes" });
      this.closeBoardCard(d, `${this.owner.name} sent it back`);
      this.saveDeliverable(d);
      this.put({
        recipient: d.lead,
        sender: "person",
        kind: "deliverable.changes",
        ref: id,
        body: `${this.owner.Name} requested changes to ${id} ${JSON.stringify(d.title)} (rev ${rev}): ${JSON.stringify(words)}\nFix it, then re-deliver with orch_deliver(revises=${JSON.stringify(id)}) and new proof; that closes this item. If you can't, ack it with an outcome and a note.`,
        key: `changes:${id}:${rev}`,
        needsAck: true,
      });
      this.boardAdd("deliverable", "person", d.project, `Changes requested: ${d.title}`, words, id);
      return d;
    });
  }

  /**
   * Deliverables as the CoS and the Steward read them (orch_deliverables), per project: the same rows the
   * owner's Deliverables tab shows, so there is no second ledger to drift. Each with its state, the owner's latest note,
   * dates, and the proof of its latest revision (URLs and file paths, with captions).
   */
  deliverablesView(opts: { project?: string | null; state?: Deliverable["state"] | null; since?: number | null; limit?: number }): { text: string; count: number } {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = (
      this.db
        .prepare(`SELECT json FROM deliverables WHERE (? IS NULL OR project = ?) AND (? IS NULL OR state = ?) AND updated_at >= ? ORDER BY updated_at DESC, id DESC LIMIT ?`)
        .all(opts.project ?? null, opts.project ?? null, opts.state ?? null, opts.state ?? null, opts.since ?? 0, limit) as { json: string }[]
    ).map((r) => JSON.parse(r.json) as Deliverable);
    const label: Record<Deliverable["state"], string> = { review: "in review", approved: "approved", changes: "changes requested", withdrawn: "withdrawn" };
    const filters = [opts.project && `project ${opts.project}`, opts.state && label[opts.state], opts.since && `updated since ${iso(opts.since)}`].filter(Boolean).join(", ");
    const lines: string[] = [`Deliverables${filters ? ` (${filters})` : ""}: ${rows.length}${rows.length === limit ? ` (the newest ${limit})` : ""}.`];
    const byProject = new Map<string, Deliverable[]>();
    for (const d of rows) byProject.set(d.project ?? "no project", [...(byProject.get(d.project ?? "no project") ?? []), d]);
    for (const [project, ds] of [...byProject.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`${project} (${ds.length}):`);
      for (const d of ds) {
        const fb = d.feedback.at(-1);
        const note = fb ? `; ${this.owner.name} ${fb.outcome === "approved" ? "approved" : "asked for changes to"} rev ${fb.rev} ${fb.at}${fb.text ? `: ${JSON.stringify(fb.text.slice(0, 400))}` : ""}` : "";
        const withdrawn = d.withdrawn ? `; withdrawn ${d.withdrawn.at}${d.withdrawn.reason ? `: ${JSON.stringify(d.withdrawn.reason.slice(0, 200))}` : ""}` : "";
        lines.push(`- ${d.id} ${JSON.stringify(d.title)} by ${d.lead}, rev ${d.rev}, ${label[d.state]}${d.scope && d.state === "review" ? ` [scoping: in ${this.owner.name}'s Scope pane]` : ""}${d.board ? ` [a board's review: on ${this.owner.name}'s Multiplayer tab]` : ""}; delivered ${iso(d.createdAt)}, updated ${iso(d.updatedAt)}${note}${withdrawn}`);
        const next = this.deliverableNext(d);
        if (next) {
          const how =
            next.state === "closed"
              ? `${next.outcome ?? "closed"}${next.note ? ` · ${JSON.stringify(next.note.slice(0, 400))}` : ""}${next.closedAt ? ` · ${iso(next.closedAt)}` : ""}`
              : next.state === "dead"
                ? `dead letter (${next.item}), never taken`
                : `open, waiting on ${d.lead} (${next.item})`;
          lines.push(`  - next: ${JSON.stringify(next.text.slice(0, 400))} → ${how}`);
        }
        const proof = d.revisions.find((r) => r.rev === d.rev)?.proof ?? [];
        for (const p of proof) lines.push(`  - ${p.kind} ${JSON.stringify(p.caption)}: ${p.url ?? p.path}`);
      }
    }
    return { text: lines.join("\n"), count: rows.length };
  }

  proof(proofId: string): { deliverableId: string; proof: Proof } | null {
    const r = this.db
      .prepare(`SELECT d.id AS did, p.value AS proof FROM deliverables d, json_each(d.json, '$.revisions') r, json_each(r.value, '$.proof') p WHERE json_extract(p.value, '$.id') = ? LIMIT 1`)
      .get(proofId) as { did: string; proof: string } | undefined;
    return r ? { deliverableId: r.did, proof: JSON.parse(r.proof) as Proof } : null;
  }

  /**
   * What the proof route may serve for an id: only a registered image, video or text file, still at the realpath it
   * was registered with (a file since swapped for a symlink is refused), with its content type and, for text, a cap.
   */
  proofFile(proofId: string): { path: string; contentType: string; maxBytes: number | null } {
    const found = this.proof(proofId);
    if (!found) throw new EngineError("not_found", `no proof ${proofId}`);
    const p = found.proof;
    if (!p.path || (p.kind !== "image" && p.kind !== "video" && p.kind !== "text")) throw new EngineError("not_found", `${proofId} is not a file the proof route serves`);
    // the deliverable's own copy, else the original it was copied from; either must still be the file registered
    const real = stillFile(p.path) ?? (p.source ? stillFile(p.source) : null);
    if (!real) throw new EngineError("not_found", existsSync(p.path) ? `${proofId}'s file is no longer the one registered` : `${proofId}'s file is gone`);
    if (p.kind === "text") return { path: real, contentType: TEXT_TYPE, maxBytes: TEXT_PROOF_MAX };
    const type = PROOF_TYPES[p.kind][extname(real).toLowerCase()];
    if (!type) throw new EngineError("not_found", `${proofId} is not a type the proof route serves`);
    return { path: real, contentType: type, maxBytes: null };
  }

  /**
   * What the proof route may serve for a recorded output. The same rules as proofFile: only the output's own recorded
   * path, still at that realpath and a file; an image or video by its extension, or plain text (.txt, .log) capped;
   * never HTML or SVG.
   */
  outputFile(outputId: string): { path: string; contentType: string; maxBytes: number | null } {
    const o = this.output(outputId);
    if (!o) throw new EngineError("not_found", `no output ${outputId}`);
    if (!o.path) throw new EngineError("not_found", `${outputId} is a link, not a file`);
    const real = stillFile(o.path);
    if (!real) throw new EngineError("not_found", existsSync(o.path) ? `${outputId}'s file is no longer the one recorded` : `${outputId}'s file is gone`);
    const ext = extname(real).toLowerCase();
    const type = PROOF_TYPES.image[ext] ?? PROOF_TYPES.video[ext];
    if (type) return { path: real, contentType: type, maxBytes: null };
    if (ext === ".txt" || ext === ".log") return { path: real, contentType: TEXT_TYPE, maxBytes: TEXT_PROOF_MAX };
    throw new EngineError("not_found", `${outputId} is not a type the proof route serves`);
  }

  /** The live state of a PR proof, from pr-watch's readings, when one has this URL. */
  prByUrl(url: string): PrRow | null {
    const bare = url.replace(/\/+$/, "");
    // this URL's own row: its environment may hold a newer PR (prFor), which isn't the one asked about
    return prRow(this.db.prepare(`SELECT * FROM prs WHERE url = ? OR url = ? ORDER BY seen_at DESC LIMIT 1`).get(bare, `${bare}/`) as PrsRow | undefined);
  }


  /** Escalations, deferrals that came due, resends and dead letters. Runs every few seconds; no model involved. */
  tick(): void {
    const t = this.now();
    // 1. a decision the CoS hasn't triaged in time goes to the owner as the asker wrote it
    const overdue = this.db.prepare(`SELECT id FROM decisions WHERE state = 'open' AND at_level = 'cos' AND triage_due_at IS NOT NULL AND triage_due_at <= ?`).all(t) as { id: string }[];
    for (const { id } of overdue) {
      tx(this.db, () => {
        const d = this.mustDecision(id);
        if (d.state !== "open" || d.orchestrator.at_level !== "cos") return;
        this.putAsk(d, "engine", d.request.title, d.request.question, `${d.request.context}\n\n*CoS didn't triage this within ${Math.round(this.settings.escalateMs / 60000)} min; it is as the asker wrote it.*`.trim(), d.request.options, true);
        d.orchestrator.triage.escalated_at = iso(t);
        this.save(d, "ask", "engine", "CoS didn't triage", null);
        this.upOrHold(d);
      });
    }
    // 1b. held cards whose leader is answered (or gone), or whose hold ran out, go up
    this.releaseHeld();
    // 2. deferrals that came due
    const due = this.db.prepare(`SELECT id FROM decisions WHERE deferred_until IS NOT NULL AND deferred_until <= ? AND state = 'asked'`).all(t) as { id: string }[];
    for (const { id } of due) this.personReturn(id, null, "engine");
    // 3. mail to an address no live agent holds (a retired holder's at once; one no agent ever held after a grace)
    this.deadLetterOrphans();
    // 4. unacked items whose recipient has been idle long enough: one resend, then a dead letter
    const open = (this.db.prepare(`SELECT * FROM items WHERE state = 'delivered' AND needs_ack = 1`).all() as ItemRow[]).map(toItem);
    for (const it of open) {
      if (this.settings.batchInbox) continue;
      const external = this.db.prepare(`SELECT source FROM external_mail WHERE item_id = ?`).get(it.id) as { source: string } | undefined;
      if (external && this.ports.externalEnabled?.(external.source, it.recipient) === false) continue;
      const a = this.agentByAddress(it.recipient);
      if (!a || a.status !== "idle" || a.idleAt === null) continue;
      // on hold the owner's direct message waits without expiring: the lead answers it after the resume
      if (it.kind === "owner.message" && a.project && this.project(a.project)?.heldAt) continue;
      // the owner's message to the CoS never goes dead: its feed state says "no reply yet" and offers Resend
      if (it.kind === "owner.cos") continue;
      const since = Math.max(a.idleAt, it.deliveredAt ?? 0);
      if (t - since < this.settings.resendMs) continue;
      // a message whose sender has since sent this recipient newer mail that went out is that sender's old word: close it,
      // don't resend it. The orchestrator's own messages (PR-bound answers coming back) are each their own work, never an
      // older word
      const newer = it.kind === "message" && it.sender !== "orchestrator" ? this.newerMail(it) : null;
      if (newer) {
        this.closeItems(`id = ?`, [it.id], "superseded", `Not resent: ${it.sender} sent ${it.recipient} newer mail since (${newer}), which went out`);
        continue;
      }
      if (it.attempts < 2) this.db.prepare(`UPDATE items SET state = 'pending' WHERE id = ?`).run(it.id);
      else this.dead(it, `unacked after ${it.attempts} deliveries`);
    }
    // 5. the CoS hears about new dead letters, once an hour at most
    this.dlqWake();
    // 6. answers bound to a PR that still isn't there remind their owner, once a day
    this.nudgeWaits();
    // 7. the CoS hears which threads sit idle with nothing to wait on, and which leads never spoke, once a day
    this.staleWake();
    // 8. a lead whose status a live fact contradicts is asked once per status to republish it (read once a minute:
    // it builds every row's summary); that ask also counts as the stale nudge below, so one status never gets both
    if (this.now() - this.outdatedCheckedAt >= 60_000) {
      this.outdatedCheckedAt = this.now();
      this.statusOutOfDateNudges();
    }
    // 9. a lead whose status went stale while it has work going is told once
    this.statusNudges();
    // 10. the work board's column changes since the last settle are logged (task_moves), once a minute
    if (this.now() - this.boardSettledAt >= 60_000) {
      this.boardSettledAt = this.now();
      this.settleBoard();
      this.flagStaleTasks();
    }
  }
  private outdatedCheckedAt = 0;
  private boardSettledAt = 0;

  // A card the orchestrator itself puts to the owner (the nightly dream batch): no agent asks it, so it skips the CoS and goes
  // straight to Needs you. Its asker is "orchestrator": the answer item is never delivered (no thread has that address);
  // the dreams service reads the answer from the decision and closes it with orchestratorAck.

  /** File a card at person level, asked by "orchestrator". The same key returns the first card, in any state. */
  orchestratorAsk(input: { title: string; question: string; context?: string; options: { label: string; detail?: string }[]; key: string; allowText: boolean; blocks?: Block[] }): Decision {
    const options = this.options(input.options, 2);
    return tx(this.db, () => {
      const dup = this.db.prepare(`SELECT id FROM decisions WHERE asker = 'orchestrator' AND json_extract(json, '$.request_key') = ?`).get(input.key) as { id: string } | undefined;
      if (dup) return this.mustDecision(dup.id);
      const t = this.now();
      const title = oneLine(input.title, 60, "title");
      const question = oneLine(input.question, 600, "question");
      const context = (input.context ?? "").slice(0, 8192);
      const d: Decision = {
        schema: 1,
        id: decisionId(t),
        rev: 0,
        state: "open",
        kind: "question",
        created_at: iso(t),
        updated_at: iso(t),
        project: null,
        request_key: input.key,
        request: { by: { role: "orchestrator", project: null, thread: null, terminal: null, machine: null, address: "orchestrator" }, title, question, context, options, blocks: parseBlocks(input.blocks) },
        reply_to: { labels: { "orchestrator.address": "orchestrator" }, terminal: null, machine: null },
        ask: null,
        answer: null,
        relay: null,
        ack: null,
        cos_notified_at: null,
        owed_from: null,
        merged_into: null,
        merged: [],
        withdrawn: null,
        deferred: null,
        returned: null,
        history: [],
        orchestrator: {
          at_level: "person",
          asker: "orchestrator",
          origin: "orchestrator",
          action: null,
          triage: { filed_at: null, due_at: null, triaged_at: null, by: null, escalated_at: null },
          forwarded_by: null,
          plan: null,
        },
      };
      this.save(d, "add", "orchestrator", null, null);
      if (this.ruleSettles(d)) return this.mustDecision(d.id);
      this.putAsk(d, "orchestrator", title, question, context, options, input.allowText);
      this.save(d, "ask", "orchestrator", null, null);
      this.ports.cardUp?.(d);
      return this.mustDecision(d.id);
    });
  }

  /** Close an orchestrator card once acted on, and the items written to "orchestrator" about it (answer, deferrals). */
  orchestratorAck(id: string, outcome: Outcome, note: string | null): string {
    return tx(this.db, () => {
      const out = this.ackDecision({ address: "orchestrator" } as Agent, id, outcome, note);
      this.closeItems(`recipient = 'orchestrator' AND ref = ?`, [id], outcome, note);
      return out;
    });
  }


  /** Full item text is available only to its recipient, including passive imports. Reading is not completion. */
  readItem(a: Agent, id: string): string {
    const it = this.item(id);
    if (!it) throw new EngineError("not_found", `no item ${id}`);
    if (it.recipient !== a.address) throw new EngineError("forbidden", "read only your own inbox items");
    return this.render(it, false);
  }

  /** An agent's recovery view: unread mail, its open asks, what it owes. */
  inbox(a: Agent): { text: string; count: number } {
    const items = (this.db.prepare(`SELECT * FROM items WHERE recipient = ? AND state IN ('pending','queued','delivered') ORDER BY created_at`).all(a.address) as ItemRow[]).map(toItem);
    const mine = (this.db.prepare(`SELECT json FROM decisions WHERE (asker = ? OR origin = ?) AND state IN ('open','asked','answered','merged') ORDER BY id`).all(a.address, a.address) as { json: string }[]).map((r) => JSON.parse(r.json) as Decision);
    const owed: Decision[] =
      a.role === "cos"
        ? (this.db.prepare(`SELECT json FROM decisions WHERE state = 'open' AND at_level = 'cos' ORDER BY id`).all() as { json: string }[]).map((r) => JSON.parse(r.json))
        : a.role === "lead"
          ? (this.db.prepare(`SELECT json FROM decisions WHERE state = 'open' AND at_level = 'lead' AND project = ? ORDER BY id`).all(a.project) as { json: string }[]).map((r) => JSON.parse(r.json))
          : [];
    const lines: string[] = [`You are ${a.address}.`];
    const proj = a.project ? this.project(a.project) : null;
    if (proj && a.role === "lead")
      lines.push(
        `Project ${proj.slug}: priority ${proj.priority}${proj.heldAt ? `, ON HOLD since ${iso(proj.heldAt)} (mail waits; no new threads)` : ""}${proj.mode === "scoping" ? `, SCOPING with ${this.owner.name}: your cards and deliverables go only to ${this.owner.name}'s Scope pane (no CoS triage, no standing rule); ask ${this.owner.name} there, start no build threads (read-only investigation is fine), and when the goal, constraints and first plan are in PROJECT.md, propose the end with orch_ask(scoping_done={summary, project_md})` : ""}.`,
      );
    const tasks = proj && a.role === "lead" ? this.openTasks(proj.slug) : [];
    if (tasks.length)
      lines.push(
        `Open scoping tasks (${tasks.length}): ${tasks
          .map((t) => {
            // its planner, as the owner's Scope tab names it
            const by = this.taskPlanner(t.id);
            return `${t.id} ${JSON.stringify(t.name)} (planned by ${by ? `its scoping thread ${by.address}` : "you"})`;
          })
          .join(", ")}. What you file with scope_task=<id> (orch_ask, orch_forward, orch_deliver) goes only to ${this.owner.name}'s Scope pane under it; orch_ask(scoping_done={summary, doc, task}) proposes closing one.`,
      );
    lines.push(items.length ? `Open items (${items.length}); use orch_inbox(id=<item id>) for full text and references:` : "No open items.");
    for (const it of items) {
      const preview = this.importPreview(it.id, 300) ?? it.body.slice(0, 300);
      lines.push(
        it.kind === "owner.message"
          ? `- direct message ${it.id} from ${this.owner.Name}${it.ref ? ` (a follow-up of ${it.ref})` : ""} [needs ack with a note; not an approval]: ${it.body}`
          : it.kind === "owner.cos"
          ? `- ${this.owner.Name}'s message ${it.id} [answer with orch_reply_owner(ref=${it.id}, text)]: ${it.body}`
          : `- ${it.kind} ${it.ref && it.kind.startsWith("decision") ? it.ref : it.id}${it.ref && !it.kind.startsWith("decision") ? ` (re ${it.ref})` : ""} from ${it.sender}${it.needsAck ? " [needs ack]" : ""}: ${preview}`,
      );
    }
    if (a.role === "lead") {
      const force = this.directInForce(a.address);
      if (force.length) {
        lines.push(`${this.owner.Name}'s direct messages still in force (48 h; each wins on its point over a CoS instruction, earlier or later, until ${this.owner.name}'s own later word changes it; none is an approval) (${force.length}):`);
        for (const it of force)
          lines.push(`- ${it.id}${it.ref ? ` (a follow-up of ${it.ref})` : ""}, ${ago(this.now() - it.createdAt)} ago, ${it.state === "closed" ? `acked ${it.outcome}${it.note ? `: ${JSON.stringify(it.note.slice(0, 200))}` : ""}` : `${it.state}, not acked`}: ${JSON.stringify(it.body)}`); // whole: a restriction past character 300 still binds
      }
    }
    if (owed.length) {
      lines.push(a.role === "cos" ? `Waiting for your triage (${owed.length}):` : `Your threads' questions waiting for you (${owed.length}):`);
      for (const d of owed) lines.push(`- ${d.id} ${JSON.stringify(d.request.title)} from ${d.orchestrator.origin}${d.orchestrator.action === "merge" ? " [merge card]" : ""}${d.orchestrator.triage.due_at ? `, goes to ${this.owner.name} at ${d.orchestrator.triage.due_at}` : ""}`);
    }
    if (a.role === "cos") lines.push(...this.scopeLines());
    if (mine.length) {
      lines.push(`Your own decisions (${mine.length}):`);
      for (const d of mine) lines.push(`- ${d.id} ${JSON.stringify(d.request.title)}: ${d.state}${d.state === "answered" ? ` (${d.answer?.label ?? d.answer?.text})${d.orchestrator.asker === a.address ? " — ack it" : ""}` : ""}`);
    }
    const waits = this.openWaits(a.address);
    if (waits.length) {
      lines.push(`Waiting on PRs (${waits.length}):`);
      for (const w of waits) lines.push(`- ${w.ref}: until ${w.prUrl} is ${WHEN_WORDS[w.when]} (bound ${ago(this.now() - w.createdAt)} ago)`);
    }
    if (a.role === "lead" || a.role === "cos") {
      const rules = this.liveRules(a.project).filter((r) => !isPractice(r));
      if (rules.length) {
        lines.push(`Standing rules you may cite:`);
        for (const r of rules) lines.push(`- ${r.id} (${r.project ?? "all projects"}; ${r.kinds.join("/")}${r.match ? "; settles the cards it matches by itself" : ""}): ${JSON.stringify(r.text)}`);
      }
    }
    if (a.role === "lead" || a.role === "cos" || a.role === "thread") {
      // the CoS reminds every lead of theirs, so it sees every project's practices; a lead or thread sees its project's
      const practices = (a.role === "cos" ? this.allLiveRules() : this.liveRules(a.project)).filter(isPractice);
      if (practices.length) {
        lines.push(`Standing practices from ${this.owner.name} (follow each one that applies to your work; they settle no card):`);
        for (const r of practices) lines.push(`- ${r.id} (${r.project ?? "all projects"}): ${JSON.stringify(r.text)}`);
      }
    }
    return { text: lines.join("\n"), count: items.length + owed.length };
  }

  needsYou(): { cards: Decision[]; deferred: Decision[]; triaging: Decision[]; held: Decision[] } {
    // a scoping project's cards wait in the Scope pane (scopeView), never here
    const all = (this.db.prepare(`SELECT json FROM decisions WHERE state IN ('open','asked') AND at_level != 'lead'`).all() as { json: string }[]).map((r) => JSON.parse(r.json) as Decision).filter((d) => !d.orchestrator.scope);
    const asked = all.filter((d) => d.state === "asked");
    const held = asked.filter((d) => d.orchestrator.held && !d.deferred);
    const cards = asked
      .filter((d) => !d.deferred && !d.orchestrator.held)
      .sort((a, b) => {
        const ra = a.returned?.at ?? "";
        const rb = b.returned?.at ?? "";
        if (ra !== rb) return ra < rb ? 1 : -1;
        return a.id < b.id ? -1 : 1;
      });
    const deferred = asked.filter((d) => d.deferred).sort((a, b) => (a.deferred!.until ?? "~").localeCompare(b.deferred!.until ?? "~"));
    const triaging = all.filter((d) => d.state === "open" && d.orchestrator.at_level === "cos");
    return { cards, deferred, triaging, held };
  }

  /**
   * The owner's Needs you as the CoS and the Steward read it (orch_needs_you): the cards waiting on the owner,
   * deferred ones, ones still with the CoS, and what the owner answered and what went moot since `since`.
   */
  needsYouView(o: { since?: number | null; project?: string | null; limit?: number | null } = {}): { text: string; count: number } {
    const t = this.now();
    const opts = { project: o.project ?? null, since: o.since ?? t - RECENT_DEFAULT.ms };
    const RECENT_MAX = Math.min(Math.max(Math.trunc(o.limit ?? RECENT_DEFAULT.limit), 1), RECENT_DEFAULT.maxLimit);
    const inProject = (d: Decision) => !opts.project || d.project === opts.project;
    const v = this.needsYou();
    const tag = (d: Decision) => `${d.kind === "plan" ? " [plan]" : ""}${d.orchestrator.action === "merge" ? " [merge card]" : ""}`;
    const head = (d: Decision) => {
      const o = d.orchestrator;
      return `${d.id} [${d.project ?? "no project"}] ${JSON.stringify(d.ask?.title ?? d.request.title)} asked by ${o.asker}${o.origin !== o.asker ? ` (from ${o.origin})` : ""}${tag(d)}`;
    };
    const since = (at: string | null | undefined) => (at ? ago(t - Date.parse(at)) : "?");
    const choice = (d: Decision) => {
      const a = d.answer!;
      return `${a.option ? `option ${a.option} ${JSON.stringify(a.label)}` : "no option"}${a.text ? `, note: ${JSON.stringify(a.text.slice(0, 200))}` : ""}`;
    };
    const cards = v.cards.filter(inProject);
    const deferred = v.deferred.filter(inProject);
    const triaging = v.triaging.filter(inProject);
    const recent = (this.db.prepare(`SELECT json FROM decisions WHERE state IN ('answered','acked','withdrawn') AND updated_at >= ? ORDER BY updated_at DESC`).all(opts.since) as { json: string }[])
      .map((r) => JSON.parse(r.json) as Decision)
      .filter(inProject);
    const answered = recent.filter((d) => d.answer?.by === "person" && d.answer.via !== "merged" && Date.parse(d.answer.at) >= opts.since);
    // a card withdrawn while still with its lead was never on the owner's Needs you
    const gone = recent.filter((d) => d.state === "withdrawn" && d.withdrawn && d.orchestrator.at_level !== "lead" && Date.parse(d.withdrawn.at) >= opts.since);
    const lines: string[] = [`${this.owner.Name}'s Needs you${opts.project ? ` (project ${opts.project})` : ""}, ${iso(t)}:`];
    lines.push(cards.length ? `Waiting on ${this.owner.name} (${cards.length}):` : `Nothing waiting on ${this.owner.name}.`);
    for (const d of cards) lines.push(`- ${head(d)}: waiting ${since(d.ask?.at)}${d.returned ? " (back from a deferral)" : ""}`);
    if (deferred.length) lines.push(`Deferred by ${this.owner.name} (${deferred.length}):`);
    for (const d of deferred) lines.push(`- ${head(d)}: deferred ${d.deferred!.until ? `until ${d.deferred!.until}` : "until brought back"}, asked ${since(d.ask?.at)} ago`);
    if (triaging.length) lines.push(`Still with you for triage (${triaging.length}):`);
    for (const d of triaging) lines.push(`- ${head(d)}: filed ${since(d.orchestrator.triage.filed_at)} ago, goes to ${this.owner.name} at ${d.orchestrator.triage.due_at ?? "?"}`);
    const held = v.held.filter(inProject);
    if (held.length) lines.push(`Held behind an earlier card from the same asker (${held.length}):`);
    for (const d of held) lines.push(`- ${head(d)}: behind ${d.orchestrator.held!.behind}, goes up by ${d.orchestrator.held!.until}`);
    lines.push(...this.scopeLines().filter((l) => !opts.project || !l.startsWith("- ") || l.startsWith(`- ${opts.project}:`)));
    lines.push(answered.length ? `Answered by ${this.owner.name} since ${iso(opts.since)} (${answered.length}):` : `No answers from ${this.owner.name} since ${iso(opts.since)}.`);
    const more = (n: number) => (n > RECENT_MAX ? [`- …and ${n - RECENT_MAX} older (widen with since and limit, or narrow with project)`] : []);
    for (const d of answered.slice(0, RECENT_MAX)) lines.push(`- ${head(d)}: answered ${since(d.answer!.at)} ago: ${choice(d)}; ${d.state === "acked" ? `acked by ${d.ack!.by} (${d.ack!.outcome})` : "not acked yet"}`);
    lines.push(...more(answered.length));
    if (gone.length) lines.push(`Moot or withdrawn since ${iso(opts.since)} (${gone.length}):`);
    for (const d of gone.slice(0, RECENT_MAX)) lines.push(`- ${head(d)}: ${d.withdrawn!.moot ? "moot" : "withdrawn"} ${since(d.withdrawn!.at)} ago by ${d.withdrawn!.by}: ${JSON.stringify(d.withdrawn!.reason)}`);
    lines.push(...more(gone.length));
    return { text: lines.join("\n"), count: cards.length + deferred.length + triaging.length + held.length };
  }

  /** Every dead letter; `board`: only those on the owner's board (escalated by the CoS, or from before it managed them). */
  deadLetters(opts: { board?: boolean } = {}): Item[] {
    return (this.db.prepare(`SELECT * FROM items WHERE state = 'dead' ${opts.board ? "AND on_board = 1" : ""} ORDER BY created_at DESC`).all() as ItemRow[]).map(toItem);
  }

  items(limit = 100): Item[] {
    return (this.db.prepare(`SELECT * FROM items ORDER BY created_at DESC LIMIT ?`).all(limit) as ItemRow[]).map(toItem);
  }

  decisions(limit = 100): Decision[] {
    return (this.db.prepare(`SELECT json FROM decisions ORDER BY id DESC LIMIT ?`).all(limit) as { json: string }[]).map((r) => JSON.parse(r.json));
  }

  projectDecisions(slug: string, limit = 5000): Decision[] {
    return (this.db.prepare(`SELECT json FROM decisions WHERE project = ? ORDER BY id DESC LIMIT ?`).all(slug, limit) as { json: string }[]).map((r) => JSON.parse(r.json));
  }

  decisionByRequestKey(asker: string, key: string): Decision | null {
    const row = this.db.prepare(`SELECT json FROM decisions WHERE asker = ? AND json_extract(json, '$.request_key') = ? AND state IN ('open','asked') ORDER BY id DESC LIMIT 1`).get(asker, key) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as Decision : null;
  }
}
