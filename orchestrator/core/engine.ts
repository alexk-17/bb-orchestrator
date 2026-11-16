// The orchestrator's engine: who is who, decisions, mail, rules and the board, over one SQLite database.
//
// Every write is a transaction on the store; delivery to a bb thread is a separate step (`flush`) that the server
// runs through bb's SDK. An item is written before it is sent, so a crash between the two re-sends it, marked
// "(again)" — never loses it. Nothing here calls a model: escalation, resends and dead letters are the `tick`.
import { BatchInbox, type MailPolicy } from "./batch-inbox.ts";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, sep } from "node:path";
import { type Db, migrate, tx } from "./db.ts";
import { MON_POOLS, formAt, levelFor, pickMon } from "../mons.ts";
import { blocksSchema, pointsSchema, type Block, type Point } from "../blocks.ts";
import { ownerWords, type OwnerWords } from "./owner.ts";
import type { Verdict } from "./clean.ts";
import { externalBody, externalMailSchema, externalPreview, type ExternalMail } from "./integration.ts";
import type { StartedBy } from "./start.ts";
import { MOOT_MIN_SHARED, MOOT_WINDOW_MS, sharedWords } from "./moot.ts";
import { cardRefusal } from "./caps.ts";
import { type LeadStatus, normalizeStatus, type StatusParams, STATUS_STALE_MS, statusLine } from "./status.ts";
import { backfillEvents, buildHistory, logEvent, logSince, type DecisionLite, type EventIn, type EventRow, type HistoryInput, type ProjectHistory } from "./history.ts";

type HistoryAgent = HistoryInput["agents"][number];
import { type RuleMatch, type Shape, allowFrom, matchRule, offerFor, ownerPick, shapeOf, words } from "./rules.ts";

/** orch_needs_you's answered and moot lists by default: the last day, newest 20 (a week of the owner's answers ran to 121). */
export const RECENT_DEFAULT = { ms: 24 * 3_600_000, limit: 20, maxLimit: 200 } as const;
/** How often the CoS hears about new dead letters at most. */
export const DLQ_WAKE_MS = 60 * 60_000;
/** How long a PR-bound answer waits before its owner is reminded, and then between reminders. */
export const WAIT_NUDGE_MS = 24 * 3_600_000;
/** What a PR-bound answer waits for. Merged satisfies every one; a PR closed unmerged ends the wait unmet. */
export const WAIT_WHEN = ["approved", "green", "ready", "merged"] as const;
export type WaitWhen = (typeof WAIT_WHEN)[number];
/** How often the CoS gets the stale-thread list at most, and how long idle (or silent) counts as stale. */
export const STALE_WAKE_MS = 24 * 3_600_000;
const WHEN_WORDS: Record<WaitWhen, string> = { approved: "approved", green: "green (checks passing)", ready: "ready to merge", merged: "merged" };
/** How far apart a handoff's retire and its successor's start may lie (two clock reads before 1.2.0). */
const HANDOFF_GAP_MS = 1000;
/** How long a pasted sign-in code stays on disk at most (personSecret). */
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
  PROJECT_RE,
  type Proof,
  PROOF_KINDS,
  type ProofKind,
  type Role,
  ROLES,
  type Rule,
} from "./model.ts";

export interface Settings {
  escalateMs: number; // an untriaged decision goes to the owner after this
  resendMs: number; // an unacked item is re-sent after its recipient has been idle this long
  owner: string; // the ownerName setting: how agents' messages name the owner ("" = "the owner")
  // Pokémon are opt-in (requested 2026-11-13). Off: agents still get one in the database, so switching on shows it, but
  // every Agent the engine hands out has mon null, so no name reaches a brief, a board row, the app or the sidebar.
  pokemon: boolean;
  batchInbox: boolean; // off by default, in the server setting and here: per-message delivery until the owner switches it on
  inboxDebounceMs: number;
}
export const DEFAULT_SETTINGS: Settings = { escalateMs: 5 * 60_000, resendMs: 10 * 60_000, owner: "", pokemon: false, batchInbox: false, inboxDebounceMs: 2000 };

export type DeliverResult = { delivery: "sent" } | { delivery: "queued"; queuedMessageId: string } | { delivery: "held"; why: string };

export interface Ports {
  now(): number;
  /** Current operator allow-list: disabling a route pauses unsent external mail and retries. */
  externalEnabled?(source: string, recipient: string): boolean;
  /** Send one item's text to a thread. "held": the thread can't take it now (stopped); try again when it starts. */
  deliver(threadId: string, text: string, item: Item): Promise<DeliverResult>;
  /** A decision changed: mirror it for other readers. */
  mirror(d: Decision): void;
  /** Something the screens show changed. */
  changed(): void;
  /** A card just entered the owner's Needs you (asked, escalated, or back from a deferral by time). */
  cardUp?(d: Decision): void;
  /** A lead delivered (or re-delivered) a deliverable: it is in the owner's review. */
  delivered?(d: Deliverable): void;
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
  flags: r.flags ?? "",
});

export interface ProjectRow {
  slug: string;
  bbProjectId: string | null;
  priority: Priority;
  heldAt: number | null;
  archivedAt: number | null;
  createdAt: number;
}

/** One environment's PR as bb's PR status reports it (bb--github-pr-status `pullRequests`). */
export type PrResult =
  | {
      outcome: "available";
      pullRequest: {
        url: string;
        number?: number;
        state: string;
        attention?: string;
        checks?: { state?: string };
        review?: { state?: string };
        mergeability?: { state?: string; mergeable?: string | null; mergeStateStatus?: string | null };
        inMergeQueue?: boolean | null;
      };
    }
  | { outcome: "absent" }
  | { outcome: "unavailable"; message?: string };

export interface PrRow {
  environmentId: string;
  threadId: string;
  url: string | null;
  number: number | null;
  state: string | null;
  attention: string | null;
  checks: string | null;
  /** The review decision (approved, changes_requested, review_required, none) from a v2 signature; null before 1.3.0's format. */
  review: string | null;
  seenAt: number;
}

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

/** An ask's blocks, checked here too (tests and the engine's own callers skip the tool's schema). */
function parseBlocks(blocks: unknown): Block[] {
  const r = blocksSchema.safeParse(blocks ?? []);
  if (!r.success) throw new EngineError("invalid", `blocks: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return r.data;
}

/** A deliverable's points, checked here too; none given keeps the revision in the old layout. */
function parsePoints(points: unknown): { points?: Point[] } {
  if (points === undefined || points === null) return {};
  const r = pointsSchema.safeParse(points);
  if (!r.success) throw new EngineError("invalid", `points: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return { points: r.data };
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
  /** Typed parts the screens draw as components (blocks.ts). */
  blocks?: Block[];
}

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

// ---------------------------------------------------------------- outputs (phase 3)

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
export function outputPath(p: string, roots: string[]): string {
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
  if (!inside) throw new EngineError("invalid", `${p} is outside your environment folder and the shared folders (${roots.join(", ")})`);
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

// ---------------------------------------------------------------- deliverables (docs/deliverables-plan.md)

/** A text proof is shown from small files only. */
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
  /** Typed parts drawn as components on the deliverable (blocks.ts): checks, facts, steps, PRs, lists, commands. */
  blocks?: Block[];
  /** 2-6 decisions and findings, one line each with a short why, drawn before any prose. Absent: the old layout. */
  points?: Point[];
}
/** The folders a proof file may resolve into, each with the bb host it is on (missing folders are skipped). */
export interface DeliverPlace {
  roots: { path: string; hostId: string | null }[];
}

interface DeliverableDbRow {
  id: string;
  json: string;
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

/** How long a card waits off Needs you behind an earlier one from the same asker and project, at most (batching). */
export const HOLD_MS = 10 * 60_000;
/** How long an answered card's key stays taken: asking it again means the answer wasn't acted on. */
export const KEY_REUSE_MS = 24 * 3_600_000;

/** How far back an offer looks for cards answered the same way. */
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
  settings: Settings;
  readonly batch: BatchInbox;
  private inflight = new Set<string>();

  private db: Db;
  private ports: Ports;

  constructor(db: Db, ports: Ports, settings: Partial<Settings> = {}) {
    this.db = db;
    this.ports = ports;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    migrate(db);
    this.batch = new BatchInbox(db, () => this.now());
    if (this.settings.batchInbox) this.batch.sync();
    this.settleThreadMons();
    this.settleRelayedCards();
    // the project page's history: once, from what the older tables say. It must never stop the plugin from starting.
    try {
      if (backfillEvents(this.db, this.now())) this.ports.log("events: backfilled the project history log");
    } catch (e) {
      this.ports.log(`events: backfill failed, the log starts empty: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** One row of the project history log (history.ts). */
  private event(e: Omit<EventIn, "at"> & { at?: number }): void {
    logEvent(this.db, { ...e, at: e.at ?? this.now() });
  }

  /** The owner as agents' messages name them. */
  private get owner(): OwnerWords {
    return ownerWords(this.settings.owner);
  }

  /**
   * Requested 2026-11-13: no two live threads share a Pokémon, and each is a three-stage line. Oldest first, a live thread
   * whose Pokémon an older live thread holds, or that left the pool, gets the next free one; the others keep theirs.
   * Idempotent.
   */
  private settleThreadMons() {
    const rows = this.db.prepare(`SELECT thread_id, mon FROM agents WHERE role = 'thread' AND retired_at IS NULL ORDER BY created_at, thread_id`).all() as { thread_id: string; mon: string | null }[];
    const pool = new Set(MON_POOLS.thread.map((x) => x.name));
    // first every rightful holder keeps its Pokémon, then only the rest are re-rolled, so no one else's changes
    const held: string[] = [];
    const redo = rows.filter((r) => {
      if (!r.mon || !pool.has(r.mon) || held.includes(r.mon)) return true;
      held.push(r.mon);
      return false;
    });
    for (const r of redo) {
      const next = pickMon("thread", held).name;
      this.db.prepare(`UPDATE agents SET mon = ? WHERE thread_id = ?`).run(next, r.thread_id);
      held.push(next);
    }
  }

  private now() {
    return this.ports.now();
  }

  // ---------------------------------------------------------------- agents

  agentByThread(threadId: string): Agent | null {
    const r = this.db.prepare(`SELECT * FROM agents WHERE thread_id = ? AND retired_at IS NULL`).get(threadId) as AgentRow | undefined;
    return r ? toAgent(r, this.settings.pokemon) : null;
  }

  agentByAddress(address: string): Agent | null {
    const r = this.db.prepare(`SELECT * FROM agents WHERE address = ? AND retired_at IS NULL`).get(address) as AgentRow | undefined;
    return r ? toAgent(r, this.settings.pokemon) : null;
  }

  agents(): Agent[] {
    return (this.db.prepare(`SELECT * FROM agents WHERE retired_at IS NULL ORDER BY created_at`).all() as AgentRow[]).map((r) => toAgent(r, this.settings.pokemon));
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
      // a retired thread may take a new role; its old address stays retired (items keep naming it)
      this.db.prepare(`DELETE FROM agents WHERE thread_id = ? AND retired_at IS NOT NULL`).run(threadId);
      let n: number | undefined;
      if (role === "thread") {
        const c = this.db.prepare(`SELECT COUNT(*) AS c FROM agents WHERE role = 'thread' AND project = ?`).get(proj) as { c: number };
        n = c.c + 1;
      }
      const address = addressFor(role, proj, n);
      if (this.agentByAddress(address)) throw new EngineError("conflict", `${address} is already taken`);
      this.db
        .prepare(`INSERT INTO agents (thread_id, address, role, project, parent_thread_id, status, created_at, mon) VALUES (?, ?, ?, ?, ?, 'unknown', ?, ?)`)
        .run(threadId, address, role, proj, parentThreadId, this.now(), this.nextMon(role, null, proj));
      this.event({ kind: "spawn", project: proj, address, threadId, value: role, ref: parentThreadId, note: startedBy ? `started by ${startedBy}` : null });
      if (role === "lead") {
        this.ensureProject(proj!, null);
        // a lead for an archived project brings it back (Start lead, or a role set by hand)
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

  // ---------------------------------------------------------------- levels and evolution
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
      const was = formAt(a.mon, before.level);
      const now = formAt(a.mon, after.level);
      if (was && now && was.name !== now.name)
        this.boardAdd("notice", a.address, a.project, `${was.name} evolved into ${now.name}!`, `${a.address} reached level ${after.level}.`, threadId);
      if (after.level !== before.level) this.ports.changed();
      return after.level;
    });
  }

  /** The Pokémon the next agent of this role gets: the first of its pool no live agent holds (mons.ts). Picked with the setting off too, so switching it on shows one. */
  nextMon(role: Role, exceptThreadId: string | null = null, project: string | null = null): string {
    const taken = (this.db.prepare(`SELECT mon FROM agents WHERE role = ? AND retired_at IS NULL AND mon IS NOT NULL AND thread_id IS NOT ?`).all(role, exceptThreadId) as { mon: string }[]).map((r) => r.mon);
    return pickMon(role, taken, project).name;
  }

  // ---------------------------------------------------------------- the owner's Start buttons: a lead, the CoS, the Steward

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
    if (!this.settings.pokemon) return null;
    const old = this.agentByAddress(addressFor(role, role === "lead" ? project : null));
    return this.nextMon(role, old?.status === "archived" ? old.threadId : null, project);
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

  /** Retire a thread's role. Its pending mail becomes dead letters (the owner resends them), never the next holder's mail. */
  retire(threadId: string, keepMail = false, at = this.now()): void {
    const a = this.agentByThread(threadId);
    this.db.prepare(`UPDATE agents SET retired_at = ? WHERE thread_id = ? AND retired_at IS NULL`).run(at, threadId);
    if (a) this.event({ at, kind: "retire", project: a.project, address: a.address, threadId });
    if (!keepMail) this.deadLetterOrphans();
    this.ports.changed();
  }

  /**
   * Pending mail to an address whose holder retired and that no live agent holds is a dead letter: else it would wait
   * forever, or reach whoever takes the address next. An address nobody ever held (imported mail for a lead that
   * isn't registered yet) keeps waiting.
   */
  private deadLetterOrphans(): void {
    if (this.settings.batchInbox) return;
    const rows = this.db
      .prepare(
        `SELECT * FROM items i WHERE i.state = 'pending'
           AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.address = i.recipient AND a.retired_at IS NULL)
           AND EXISTS (SELECT 1 FROM agents r WHERE r.address = i.recipient AND r.retired_at IS NOT NULL)`,
      )
      .all() as ItemRow[];
    for (const r of rows) this.dead(toItem(r), `${r.recipient} has no live agent (its holder retired)`);
  }

  /**
   * A thread's runtime state. "stopped" (set by the orchestrator's stop) sticks until the thread runs again. A worker
   * thread bb archived is retired at once: archived by hand (agent-v2's threads 4, 6 and 7, 2026-11-15), its role
   * stayed live for good, so it still counted as an open thread of its lead.
   */
  setStatus(threadId: string, status: string): void {
    const cur = this.agentByThread(threadId);
    if (!cur) return;
    if (cur.status === "stopped" && status !== "active" && status !== "archived") return;
    // idle since it went idle: the startup reconcile re-reports every agent's status, and a repeat isn't a new idle
    const idle = status === "idle" ? (cur.status === "idle" && cur.idleAt !== null ? cur.idleAt : this.now()) : null;
    this.db.prepare(`UPDATE agents SET status = ?, idle_at = ?, last_idle_at = COALESCE(?, last_idle_at) WHERE thread_id = ?`).run(status, idle, idle, threadId);
    // a change only: the startup reconcile re-reports every agent's status
    if (cur.status !== status) this.event({ kind: "status", project: cur.project, address: cur.address, threadId, value: status });
    if (status === "archived" && cur.role === "thread") {
      tx(this.db, () => {
        this.retire(threadId);
        // an "archived" row: the thread is gone already, so the Board offers no Archive button for it
        this.boardAdd("archived", "orchestrator", cur.project, `${cur.address} retired: its thread was archived in bb`, "Its role is retired; mail still waiting for it is a dead letter.", threadId);
      });
    }
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

  // ---------------------------------------------------------------- items

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
      this.db.prepare(`INSERT INTO external_mail (source, external_id, item_id, json, quiet, due_at) VALUES (?, ?, ?, ?, ?, ?)`).run(mail.source, mail.id, item.id, json, quiet ? 1 : 0, mail.dueAt);
      this.ports.changed();
      return item;
    });
  }

  /** Stable import sequence for pagination. Rescan from zero to refresh mutable receipt states. */
  externalReceipts(source: string, after = 0, limit = 100) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new EngineError("invalid", "receipt page needs after >= 0 and limit 1–100");
    const rows = this.db.prepare(`SELECT seq, external_id, item_id FROM external_mail WHERE source = ? AND seq > ? ORDER BY seq LIMIT ?`).all(source, after, limit) as { seq: number; external_id: string; item_id: string }[];
    return rows.map((r) => {
      const it = this.item(r.item_id)!;
      return { sequence: r.seq, externalId: r.external_id, itemId: it.id, state: it.state, queuedMessageId: it.queuedMessageId, paused: this.ports.externalEnabled?.(source, it.recipient) === false, deliveredAt: it.deliveredAt, outcome: it.outcome, note: it.note, readAt: null };
    });
  }

  private item(id: string): Item | null {
    const r = this.db.prepare(`SELECT * FROM items WHERE id = ?`).get(id) as ItemRow | undefined;
    return r ? toItem(r) : null;
  }

  /** Write an item. With a key, writing it again returns the first one (a safe resend). */
  private put(p: { recipient: string; sender: string; kind: ItemKind; ref?: string | null; body: string; key?: string | null; needsAck: boolean }): Item {
    if (p.key) {
      const r = this.db.prepare(`SELECT * FROM items WHERE sender = ? AND send_key = ?`).get(p.sender, p.key) as ItemRow | undefined;
      if (r) return toItem(r);
    }
    const id = `i-${hex(6)}`;
    this.db
      .prepare(
        `INSERT INTO items (id, recipient, sender, kind, ref, body, send_key, needs_ack, state, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .run(id, p.recipient, p.sender, p.kind, p.ref ?? null, p.body, p.key ?? null, p.needsAck ? 1 : 0, this.now());
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
    const head = `[orchestrator] ${it.kind} ${it.ref && it.kind.startsWith("decision") ? it.ref : it.id} from ${it.sender}${again ? " (again)" : ""}:`;
    const close =
      it.kind === "message"
        ? `\n(When handled: ack id=${it.id} with an outcome. A reply to ${it.sender} with ref=${it.id} closes it as replied.)`
        : it.kind === "copy"
          ? "\n(Read-only copy: no ack, no reply needed.)"
          : "";
    return `${head} ${it.body}${close}`;
  }

  /** Send every pending item whose recipient can take it. Safe to call often. */
  async flush(): Promise<void> {
    if (this.settings.batchInbox) {
      await this.batch.flush({
        debounceMs: this.settings.inboxDebounceMs,
        retryMs: this.settings.resendMs,
        agent: (address) => this.agentByAddress(address),
        held: (a) => !!(a.project && this.project(a.project)?.heldAt),
        deliver: (a, text, token) => this.ports.deliver(a.threadId, text, { id: `wake:${token}`, sender: "orchestrator", recipient: a.address, kind: "notice" } as Item),
        log: (text) => this.ports.log(text),
      });
      this.ports.changed();
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
    this.batch.cancelled(queuedMessageId);
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
   * A dead letter goes to the CoS's dead letters (2026-11-15), not the owner's board: the CoS resends, re-routes, closes
   * or escalates it (orch_dead_letters), and the hourly wake tells it about new ones. The supervisor still hears.
   */
  private dead(it: Item, why: string): void {
    tx(this.db, () => {
      const seq = (this.db.prepare(`SELECT COALESCE(MAX(dead_seq), 0) + 1 AS n FROM items`).get() as { n: number }).n;
      this.db.prepare(`UPDATE items SET state = 'dead', note = ?, dead_seq = ?, dead_at = ?, on_board = 0 WHERE id = ?`).run(why, seq, this.now(), it.id);
      const to = this.agentByAddress(it.recipient);
      const sup = to ? this.supervisorOf(to) : null;
      if (sup && this.agentByAddress(sup)) {
        this.put({ recipient: sup, sender: "orchestrator", kind: "notice", ref: it.id, body: `${it.recipient} never acked ${it.kind} ${it.ref ?? it.id} from ${it.sender} (${why}). It is a dead letter; the CoS handles it.`, needsAck: false });
      }
    });
    this.ports.changed();
  }

  /** The owner resends a dead letter from the board, or the CoS from its dead letters (no board row then). */
  resend(itemId: string, by = "person"): Item {
    const it = this.mustDead(itemId);
    if (!this.agentByAddress(it.recipient) && this.db.prepare(`SELECT 1 FROM agents WHERE address = ? AND retired_at IS NOT NULL`).get(it.recipient))
      throw new EngineError("bad_state", `${it.recipient} has no live agent: give the address a role first${by === "person" ? "" : ", or re-route it"}`);
    this.db.prepare(`UPDATE items SET state = 'pending', attempts = 1, queued_message_id = NULL, delivered_at = NULL WHERE id = ?`).run(itemId);
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

  // ---------------------------------------------------------------- the CoS's dead letters (2026-11-15)

  private cosOnly(by: Agent): void {
    if (by.role !== "cos") throw new EngineError("forbidden", "only the CoS manages dead letters");
  }

  /** Every dead letter, oldest death first, for the CoS. */
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
   * The hourly dead-letter wake (from tick; no model): at most once per DLQ_WAKE_MS, one info item to the CoS listing the
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

  // ---------------------------------------------------------------- mail

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
      // imported mail approves nothing: "carry it out when the PR is green" would turn its words into a go
      if (this.db.prepare(`SELECT 1 FROM external_mail WHERE item_id = ?`).get(id))
        throw new EngineError("forbidden", `${id} is untrusted external mail, not an approval: it can't be bound to a PR. Ack it without pr and when`);
      const w = this.waitInput(wait);
      return tx(this.db, () => {
        const out = this.ack(by, id, outcome, note);
        return `${out}; ${this.bindWait(by, id, w.url, w.when)}`;
      });
    }
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
   * A reply counts as the ack (2026-11-16: 99 replies named the message they answered, yet 15 of those messages were
   * resent and three answered ones died as dead letters). Mail from `from` to `to` closes the one message `to` sent
   * `from` that it answers, as "replied" (answered, not done), with the reply as its note:
   * - ref=<that message's id>: always;
   * - no ref: only when it is the only message from `to` that `from` hasn't closed, it arrived since `from` last went
   *   idle (this is the same turn), and this is `from`'s first mail to `to` since. Its note says so, for audits.
   * The sender gets the reply itself, so no ack note goes back.
   */
  private replyCloses(from: Agent, to: string, ref: string | null, reply: { id: string; body: string }): Item | null {
    if (this.settings.batchInbox) return null;
    const open = (r: ItemRow | undefined) => !!r && r.kind === "message" && r.needs_ack === 1 && r.recipient === from.address && r.sender === to && ["pending", "queued", "delivered", "dead"].includes(r.state);
    let it: Item | null = null;
    let how: string;
    if (ref?.startsWith("i-")) {
      const r = this.db.prepare(`SELECT * FROM items WHERE id = ?`).get(ref) as ItemRow | undefined;
      if (!open(r)) return null;
      it = toItem(r!);
      how = `replied in ${reply.id}`;
    } else if (!ref) {
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
   * An ack's note goes back to the agent that sent the item, as an info item (2026-11-15: the CoS asked a lead to do
   * something and never heard how it went). A note item itself never sends one back, so two agents can't bounce notes.
   */
  private ackNote(by: Agent, it: Item, outcome: Closed, note: string | null): void {
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

  // ---------------------------------------------------------------- answers that wait on a PR (2026-11-16)

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

  /** What the acked item or card said, for the wake-up: the card's title and answer, or the message's text. */
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
    const now = this.prByUrl(url);
    const woke = this.checkWaits(url);
    if (woke.includes(wid)) return `bound to ${url}: it is ${WHEN_WORDS[when]} already, so it is back in your inbox now (${wid})`;
    return `bound to ${url} (${wid}): you get it back when the PR is ${WHEN_WORDS[when]}, and a reminder each day until then${now ? "" : ". No thread's environment shows this PR yet, so its notices can't wake you until one does"}`;
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
    const pr = this.prByUrl(url);
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
        body: `${what}: ${pr.url ?? url}. You bound ${w.ref} to it ${ago(this.now() - w.created_at)} ago: ${w.about}. ${met === "never" ? "Decide what happens instead" : "Carry it out now"}, then ack this.`,
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
        const pr = this.prByUrl(w.pr_url);
        const seen = pr ? `unchanged for ${ago(t - pr.seenAt)}: ${pr.state ?? "?"}${pr.checks ? `, checks ${pr.checks}` : ""}${pr.review ? `, review ${pr.review.replace(/_/g, " ")}` : ""}${pr.attention ? `, ${pr.attention.replace(/_/g, " ")}` : ""}` : "no thread's environment shows it, so the plugin can't see it change";
        this.put({
          recipient: w.owner,
          sender: "orchestrator",
          kind: "notice",
          ref: w.ref,
          body: `Still waiting (${ago(t - w.created_at)}): ${w.pr_url} isn't ${WHEN_WORDS[w.cond as WaitWhen]} yet (${seen}). It holds ${w.about}. Chase it, or ack ${w.ref} again with another PR or condition.`,
          key: `wait-nudge:${w.id}:${t}`,
          needsAck: false,
        });
      });
    }
  }

  /** An agent's open waits, for its inbox and the stale-thread check. */
  openWaits(owner: string | null = null): { id: string; owner: string; ref: string; prUrl: string; when: WaitWhen; createdAt: number }[] {
    return (this.db.prepare(`SELECT * FROM waits WHERE closed_at IS NULL AND (? IS NULL OR owner = ?) ORDER BY created_at`).all(owner, owner) as WaitRow[]).map((w) => ({ id: w.id, owner: w.owner, ref: w.ref, prUrl: w.pr_url, when: w.cond as WaitWhen, createdAt: w.created_at }));
  }

  // ---------------------------------------------------------------- stale threads (2026-11-16)

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
   * The daily stale-thread item (from tick; no model): at most once per STALE_WAKE_MS, one info item to the CoS with
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

  // ---------------------------------------------------------------- lead status (2026-11-16, status.ts)

  /** orch_status: a lead publishes where its project is. Missing fields keep the last status's values. */
  publishStatus(a: Agent, p: StatusParams): LeadStatus {
    if (a.role !== "lead" || !a.project) throw new EngineError("forbidden", "only a lead publishes its project's status");
    const project = a.project;
    return tx(this.db, () => {
      const r = normalizeStatus(p, this.leadStatus(project), { now: this.now(), by: a.address, ownerName: this.settings.owner ?? "" });
      if ("refusal" in r) throw new EngineError("invalid", r.refusal);
      const s = r.status;
      const json = JSON.stringify(s);
      this.db
        .prepare(
          `INSERT INTO lead_status (project, address, thread_id, json, updated_at, nudged_at) VALUES (?, ?, ?, ?, ?, NULL)
           ON CONFLICT (project) DO UPDATE SET address = excluded.address, thread_id = excluded.thread_id, json = excluded.json, updated_at = excluded.updated_at, nudged_at = NULL`,
        )
        .run(project, a.address, a.threadId, json, s.updatedAt);
      this.event({ at: s.updatedAt, kind: "lead-status", project, address: a.address, threadId: a.threadId, value: json });
      this.ports.changed();
      return s;
    });
  }

  /** A project's latest status, or null before its lead published one. */
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
   * From the tick (2026-11-16, the lead's rule: a nudge every 2 h on a day-long PR wait is noise, and each one wakes
   * a lead): a status over STATUS_STALE_MS old is nudged only when something changed in its project since the last
   * publish (projectChangedSince), at most once per change, and never twice within STATUS_STALE_MS. One info item to
   * the lead, never a card. Only a lead that published once is nudged (it has the tool); a held project isn't.
   */
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

  // ---------------------------------------------------------------- decisions

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

  /** File a question. A thread's goes to its lead; a lead's or the Steward's to the CoS. Never blocks. */
  ask(by: Agent, input: AskInput): Decision {
    if (by.role === "cos") throw new EngineError("forbidden", `the CoS asks ${this.owner.name} through triage(ask_person)`);
    const t = this.now();
    const options = this.options(input.options, 2);
    const kind = input.kind ?? "question";
    const tooLong = cardRefusal({ question: input.question, context: input.context, options, kind });
    if (tooLong) throw new EngineError("invalid", tooLong);
    let plan: { threads: number; go: string } | null = null;
    if (kind === "plan") {
      if (by.role !== "lead") throw new EngineError("forbidden", "only a lead files a plan card");
      const gos = options.filter((o) => o.go);
      if (gos.length > 1) throw new EngineError("invalid", "a plan has exactly one go option");
      if (gos.length === 0) options[0]!.go = true; // the recommended option is the go unless another is marked
      const threads = input.threads ?? 1;
      if (!Number.isInteger(threads) || threads < 1 || threads > 10) throw new EngineError("invalid", "a plan starts 1 to 10 threads");
      plan = { threads, go: options.find((o) => o.go)!.id };
    } else if (options.some((o) => o.go)) throw new EngineError("invalid", "only a plan has a go option");
    const atCos = by.role !== "thread";
    const asker = by.address;
    return tx(this.db, () => {
      if (input.key) {
        const dup = this.db.prepare(`SELECT id FROM decisions WHERE asker = ? AND json_extract(json, '$.request_key') = ? AND state IN ('open','asked')`).get(asker, input.key) as { id: string } | undefined;
        if (dup) return this.mustDecision(dup.id);
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
        },
      };
      if (atCos) this.gate(d);
      this.save(d, "add", by.address, null, null);
      if (this.ruleSettles(d)) return this.mustDecision(d.id);
      if (atCos) this.fileWithCos(d, by.address);
      else this.put({ recipient: `lead:${by.project}`, sender: by.address, kind: "decision.new", ref: d.id, body: this.describe(d, "lead"), needsAck: false });
      return this.mustDecision(d.id);
    });
  }

  private describe(d: Decision, forWhom: "lead" | "cos"): string {
    const opts = d.request.options.map((o) => `${o.id}) ${JSON.stringify(o.label)}${o.id === "1" ? " (recommended)" : ""}${o.detail ? ` — ${o.detail}` : ""}`).join(" ");
    const what =
      forWhom === "lead"
        ? "Settle it with answer(id, option, rule_id) if a project rule covers it, or answer(id, option, note) as your own call, else forward(id) to file it up."
        : d.orchestrator.action === "merge"
          ? "A merge card: you may not settle or merge it. triage(ask_person)."
          : "triage it: settle (cite a rule id), ask_person, or merge into a duplicate.";
    return `${JSON.stringify(d.request.title)} ${JSON.stringify(d.request.question)} Options: ${opts}. ${what}`;
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

  /** A lead files its thread's question up to the CoS. The lead becomes the asker: the answer comes to it. */
  forward(by: Agent, id: string, note: string | null): Decision {
    return tx(this.db, () => {
      const d = this.mustDecision(id);
      if (by.role !== "lead" || d.orchestrator.at_level !== "lead" || d.project !== by.project) throw new EngineError("forbidden", `${id} isn't your thread's question`);
      if (d.state !== "open") throw new EngineError("bad_state", `${id} is ${d.state}`);
      d.orchestrator.asker = by.address;
      d.orchestrator.forwarded_by = by.address;
      d.reply_to.labels = { "orchestrator.address": by.address };
      if (note) d.request.context = `${d.request.context}\n\nLead's note: ${note}`.trim().slice(0, 8192);
      this.gate(d);
      if (!this.ruleSettles(d)) this.fileWithCos(d, by.address);
      return this.mustDecision(id);
    });
  }

  private ruleFor(ruleId: string, d: Decision, option: string): Rule {
    const r = this.db.prepare(`SELECT * FROM rules WHERE id = ?`).get(ruleId) as RuleRow | undefined;
    if (!r) throw new EngineError("not_found", `no standing rule ${ruleId}${d.orchestrator.at_level === "lead" ? " (to answer as your own call, send an empty rule_id and a note saying why)" : ""}`);
    const rule = toRule(r);
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
    if (d.state !== "open") return false;
    const hits = this.liveRules(d.project).flatMap((r) => {
      if (!r.match || !r.kinds.includes(d.kind)) return [];
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
   * needs a note saying why (the owner approved it, 2026-11-13: leads without standing rules still close their threads' cards).
   */
  leadAnswer(by: Agent, id: string, ruleId: string | null, option: string, note: string | null): Decision {
    return tx(this.db, () => {
      const d = this.mustDecision(id);
      if (by.role !== "lead" || d.orchestrator.at_level !== "lead" || d.project !== by.project) throw new EngineError("forbidden", `${id} isn't your thread's question`);
      if (d.state !== "open") throw new EngineError("bad_state", `${id} is ${d.state}`);
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
   * settles the card, else it stays open for good and the thread can't ack it (agent-v2, 2026-11-13).
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

  triageSettle(by: Agent, id: string, ruleId: string, option: string, note: string | null): Decision {
    return tx(this.db, () => {
      const d = this.cosDecision(by, id);
      return this.settle(d, by, ruleId, option, note);
    });
  }

  private cosDecision(by: Agent, id: string): Decision {
    if (by.role !== "cos") throw new EngineError("forbidden", "only the CoS triages");
    const d = this.mustDecision(id);
    if (d.orchestrator.at_level !== "cos") throw new EngineError("bad_state", `${id} isn't waiting for triage (it is at ${d.orchestrator.at_level})`);
    if (d.state !== "open") throw new EngineError("bad_state", `${id} is ${d.state}`);
    return d;
  }

  triageAskPerson(by: Agent, id: string, p: { title?: string; question: string; context?: string; options: { label: string; detail?: string }[]; allowText: boolean }): Decision {
    return tx(this.db, () => {
      const d = this.cosDecision(by, id);
      // a plan's options are the lead's (the go option must survive); the CoS may reword only the question
      const options = d.kind === "plan" ? d.request.options : this.options(p.options, 2);
      // the owner reads the CoS's wording, so it gets the asker's caps; a context left out is the asker's, already checked
      const tooLong = cardRefusal({ question: p.question, context: p.context ?? "", options: d.kind === "plan" ? [] : options, kind: d.kind });
      if (tooLong) throw new EngineError("invalid", tooLong);
      this.putAsk(d, "cos", p.title ?? d.request.title, p.question, p.context ?? d.request.context, options, d.kind === "plan" ? false : p.allowText);
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

  triageMerge(by: Agent, id: string, into: string): Decision {
    return tx(this.db, () => {
      const d = this.cosDecision(by, id);
      const p = this.mustDecision(into);
      if (p.id === d.id) throw new EngineError("invalid", "a decision can't merge into itself");
      if (!["open", "asked"].includes(p.state) || p.orchestrator.at_level === "lead") throw new EngineError("bad_state", `${into} is ${p.state} at ${p.orchestrator.at_level}`);
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
   * The owner answered a card: the CoS gets a read-only copy with the project, the card's title and what was chosen
   * (2026-11-15: it learned the owner's choices late, from whoever acted on them). Once per card: not for the merged
   * duplicates the answer is copied to, and not when the CoS itself is the asker.
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

  /** The answer goes to the asker (2026-11-13; the CoS gets a copy of the owner's answers); merged duplicates get a copy, each to its own asker. */
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

  // ---------------------------------------------------------------- batching and the quality gate (2026-11-16)

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
            .find((p) => !p.deferred && !p.orchestrator.held && p.ask && t - Date.parse(p.ask.at) < HOLD_MS)
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
  triageBounce(by: Agent, id: string, reason: string): Decision {
    const why = oneLine(reason ?? "", 300, "the reason (note)");
    return tx(this.db, () => {
      const d = this.cosDecision(by, id);
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

  // ---------------------------------------------------------------- moot cards (2026-11-15)

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

  // ---------------------------------------------------------------- the owner's writes (from the screens only)

  personAnswer(id: string, rev: number, option: string | null, text: string | null, via: "desktop" | "phone"): Decision {
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
        const r = this.addRule({ text: proposal.text, project: proposal.project, kinds: ["question"], expiresAt: null, source: `card ${d.id}, from ${proposal.evidence.length} of ${this.owner.name}'s answers`, match: proposal.match });
        proposal.rule_id = r.id;
      }
      this.save(d, "answer", "person", wasDeferred ? "answered while deferred" : proposal?.rule_id ? `rule ${proposal.rule_id} added` : null, rev);
      this.relay(d);
      this.copyAnswerToCos(d, `option ${opt ? `${opt.id} ${JSON.stringify(opt.label)}` : "none"}${t ? `, note: ${JSON.stringify(t)}` : ""}`);
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
  personSecret(id: string, rev: number, file: string, via: "desktop" | "phone", typed = false): Decision {
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

  personDefer(id: string, rev: number, preset: string, until: number | null, via: "desktop" | "phone"): Decision {
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
      if (by === "engine") this.ports.cardUp?.(d);
      return this.mustDecision(id);
    });
  }

  // ---------------------------------------------------------------- rules (rows come only from the owner)

  addRule(p: { text: string; project: string | null; kinds: string[]; expiresAt: number | null; source: string; match?: RuleMatch | null }): Rule {
    const kinds = p.kinds.filter((k) => k === "question" || k === "plan");
    if (kinds.length === 0) throw new EngineError("invalid", "a rule covers questions and/or plans (never merges)");
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
    const t = this.now();
    return this.rules().filter((r) => r.revokedAt === null && (r.expiresAt === null || r.expiresAt > t) && (r.project === null || r.project === project));
  }

  // ---------------------------------------------------------------- rules from answers (2026-11-16)
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
      needsAck: false,
      body:
        `Rule offer ${offerId}: ${this.owner.name} answered ${cards.length} cards (${s.group.startsWith("project:") ? `project ${s.group.slice("project:".length)}` : `from ${s.group.slice("asker:".length)}`}) the same way:\n${lines.join("\n")}\n${how}\n` +
        `If the next ones should be settled without ${this.owner.name}, propose it: triage(action=propose_rule, id=${JSON.stringify(d.id)}, note=<the rule in one line, at most 120 characters>), ` +
        `optionally rule={from, words, without, key_prefix, option} to narrow it. ${this.owner.Name} gets one "Make this a rule?" card. Ignore this if the answers were one-offs.`,
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
      if (dup) return this.mustDecision(dup.id);
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
      return this.mustDecision(d.id);
    });
  }

  // ---------------------------------------------------------------- board, notices, reports

  boardAdd(kind: string, from: string | null, project: string | null, title: string, body: string, ref: string | null): void {
    this.db.prepare(`INSERT INTO board (id, kind, from_address, project, title, body, ref, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(`b-${hex(6)}`, kind, from, project, title.slice(0, 200), body.slice(0, 8000), ref, this.now());
    this.ports.changed();
  }

  board(limit = 200): BoardRow[] {
    return (this.db.prepare(`SELECT * FROM board ORDER BY at DESC LIMIT ?`).all(limit) as { id: string; kind: string; from_address: string | null; project: string | null; title: string; body: string; ref: string | null; at: number }[]).map((r) => ({
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
      const lead = `lead:${by.project}`;
      const it = this.put({ recipient: lead, sender: by.address, kind: "notice", ref: ref?.startsWith("i-") ? ref : null, body: `report: ${JSON.stringify(title)}${pr ? ` (${pr})` : ""}. It is on the board.`, needsAck: false });
      const closed = this.replyCloses(by, lead, ref?.trim() || null, { id: it.id, body: `report ${JSON.stringify(title)}${pr ? ` (${pr})` : ""}: ${body}` });
      return `On the board and sent to your lead.${closed ? ` It closes ${closed.id} as replied.` : ""}`;
    });
  }

  /** Tell an agent's supervisor something (failures, a finished worker). */
  notifySupervisor(a: Agent, body: string): void {
    const sup = this.supervisorOf(a);
    if (!sup || !this.agentByAddress(sup)) return;
    this.put({ recipient: sup, sender: "orchestrator", kind: "notice", ref: null, body: `${a.address}: ${body}`, needsAck: false });
  }

  /** A host alarm for the Steward. */
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


  // ---------------------------------------------------------------- projects (phase 2): priority and hold, from the owner

  ensureProject(slug: string, bbProjectId: string | null): void {
    this.db.prepare(`INSERT OR IGNORE INTO projects (slug, bb_project_id, created_at) VALUES (?, ?, ?)`).run(slug, bbProjectId, this.now());
    if (bbProjectId) this.db.prepare(`UPDATE projects SET bb_project_id = ? WHERE slug = ? AND bb_project_id IS NULL`).run(bbProjectId, slug);
  }

  project(slug: string): ProjectRow | null {
    const r = this.db.prepare(`SELECT * FROM projects WHERE slug = ?`).get(slug) as { slug: string; bb_project_id: string | null; priority: string; held_at: number | null; archived_at: number | null; created_at: number } | undefined;
    return r ? { slug: r.slug, bbProjectId: r.bb_project_id, priority: r.priority as Priority, heldAt: r.held_at, archivedAt: r.archived_at, createdAt: r.created_at } : null;
  }

  projects(): ProjectRow[] {
    const rank = (p: string) => PRIORITIES.indexOf(p as Priority);
    return (this.db.prepare(`SELECT slug FROM projects`).all() as { slug: string }[])
      .map((r) => this.project(r.slug)!)
      .sort((a, b) => rank(a.priority) - rank(b.priority) || a.slug.localeCompare(b.slug));
  }

  /**
   * A new project's row (orch_new_project), with its priority and one board notice. Refused when the slug already has
   * a row, archived or not: a new project never takes over an old one's history.
   */
  createProject(slug: string, priority: Priority, by: string, title: string, body: string): void {
    if (!PROJECT_RE.test(slug)) throw new EngineError("invalid", `bad project slug ${slug}`);
    if (!PRIORITIES.includes(priority)) throw new EngineError("invalid", `priority is one of ${PRIORITIES.join(", ")}`);
    tx(this.db, () => {
      if (this.project(slug)) throw new EngineError("conflict", `${slug} is already a project`);
      this.db.prepare(`INSERT INTO projects (slug, bb_project_id, priority, created_at) VALUES (?, NULL, ?, ?)`).run(slug, priority, this.now());
      this.boardAdd("notice", by, slug, title, body, null);
    });
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
    const decisions: DecisionLite[] = (this.db.prepare(`SELECT json FROM decisions WHERE project = ? OR asker IN (SELECT address FROM agents WHERE project = ?)`).all(slug, slug) as { json: string }[]).map((r) => {
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

  // ---------------------------------------------------------------- plans and spawns (phase 2): the hard plan gate

  /** Plan cards of a project still waiting for a decision. */
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

  /** Reserve one of a plan's thread slots before spawning; confirm with the new thread's id, or release on failure. */
  reserveSpawn(lead: Agent, planId: string): string {
    if (lead.role !== "lead") throw new EngineError("forbidden", "only a lead starts threads");
    return tx(this.db, () => {
      if (this.project(lead.project!)?.heldAt) throw new EngineError("bad_state", `${lead.project} is on hold`);
      const d = this.approvedPlan(lead, planId);
      const used = (this.db.prepare(`SELECT COUNT(*) AS c FROM spawns WHERE plan_id = ?`).get(planId) as { c: number }).c;
      if (used >= d.orchestrator.plan!.threads) throw new EngineError("bad_state", `${planId} allows ${d.orchestrator.plan!.threads} thread(s); all started`);
      const token = `pending:${hex(4)}`;
      this.db.prepare(`INSERT INTO spawns (thread_id, plan_id, via, lead, created_at) VALUES (?, ?, 'plan', ?, ?)`).run(token, planId, lead.address, this.now());
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
      const a = toAgent(r, this.settings.pokemon);
      this.db.prepare(`UPDATE agents SET flags = trim(flags || ',unplanned', ',') WHERE thread_id = ?`).run(a.threadId);
      this.boardAdd("unplanned", "orchestrator", a.project, `${a.address} started without a plan card`, `Thread ${a.threadId} was started outside orch_spawn_thread. It works as usual; this is the record.`, a.threadId);
      if (this.agentByAddress(`lead:${a.project}`)) this.put({ recipient: `lead:${a.project}`, sender: "orchestrator", kind: "notice", ref: a.threadId, body: `${a.address} was started without an approved plan card; it is flagged on the board. Start threads with orch_spawn_thread from an approved plan.`, needsAck: false });
    }
    if (rows.length) this.ports.changed();
    return rows.length;
  }

  // ---------------------------------------------------------------- environments, PRs, resolve, handoff (phase 2)

  setEnvironment(threadId: string, environmentId: string | null): void {
    this.db.prepare(`UPDATE agents SET environment_id = ? WHERE thread_id = ? AND retired_at IS NULL AND environment_id IS NOT ?`).run(environmentId, threadId, environmentId);
  }

  prFor(environmentId: string | null): PrRow | null {
    if (!environmentId) return null;
    const r = this.db.prepare(`SELECT * FROM prs WHERE environment_id = ?`).get(environmentId) as
      | { environment_id: string; thread_id: string; url: string | null; number: number | null; state: string | null; attention: string | null; checks: string | null; sig: string; seen_at: number }
      | undefined;
    // the signature is v2|url|state|checks|review|merge|queued (prSeen)
    const review = r?.sig.startsWith("v2|") ? r.sig.split("|")[4] || null : null;
    return r ? { environmentId: r.environment_id, threadId: r.thread_id, url: r.url, number: r.number, state: r.state, attention: r.attention, checks: r.checks, review, seenAt: r.seen_at } : null;
  }

  /**
   * One PR reading for an agent's environment. Only a change is news: absent/unavailable are never a change (a
   * suspended machine or a restart must not flood anyone). A change goes to the Board and the lead; ready to merge or
   * merged also to the CoS. Returns whether it changed.
   *
   * A change is one of state, checks, review or mergeability. GitHub reads mergeable UNKNOWN while it recomputes after
   * any push to the base, and bb then derives another attention ("review requested", "blocked", none) until the next
   * reading flips back: PR 1100 sent 45 notices at an unchanged head (2026-11-13/14). An unknown mergeability keeps the
   * last known one, and the notice says only what the signature holds, so two notices in a row never read the same.
   */
  prSeen(a: Agent, environmentId: string, res: PrResult, label = ""): boolean {
    if (res.outcome !== "available") return false;
    const pr = res.pullRequest;
    const checks = pr.checks?.state ?? null;
    const attention = pr.attention ?? null;
    const old = this.db.prepare(`SELECT url, state, checks, attention, sig FROM prs WHERE environment_id = ?`).get(environmentId) as
      | { url: string | null; state: string | null; checks: string | null; attention: string | null; sig: string }
      | undefined;
    const legacy = old !== undefined && !old.sig.startsWith("v2|"); // written before 1.3.0: url|state|attention|checks
    const prev = !old || old.url !== pr.url ? null : legacy ? { merge: old.attention === "conflicts" ? "conflicts" : null } : { merge: old.sig.split("|")[5] || null };
    // an injected reading or an older bb has no mergeability or review: its attention stands in for both
    const raw = pr.mergeability ? pr.mergeability.mergeable : undefined;
    const merge = !pr.mergeability ? attention : raw && raw !== "UNKNOWN" ? (pr.mergeability.state ?? null) : (prev?.merge ?? "unknown");
    const review = pr.mergeability || pr.review ? (pr.review?.state ?? null) : null;
    const queued = pr.inMergeQueue === true;
    const sig = ["v2", pr.url, pr.state, checks ?? "", review ?? "", merge ?? "", queued ? "queued" : ""].join("|");
    // ready to merge, by bb's own order, from the signature's fields (bb's attention says "none" mid-recompute)
    const ready = merge === "ready_to_merge" || (pr.state === "open" && merge === "mergeable" && checks === "passing" && !queued && !["changes_requested", "review_requested", "review_required"].includes(review ?? ""));
    // what the lanes and deliverables show: as the notice says it, not bb's word of the moment
    const shown = merge === "conflicts" && pr.state === "open" ? "conflicts" : ready ? "ready_to_merge" : attention;
    if (old?.sig === sig) return false;
    // the first reading after the upgrade only rewrites the signature: a changed format is no news
    const quiet = legacy && old.url === pr.url && old.state === pr.state && old.checks === checks;
    return tx(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO prs (environment_id, thread_id, url, number, state, attention, checks, sig, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(environment_id) DO UPDATE SET thread_id = excluded.thread_id, url = excluded.url, number = excluded.number, state = excluded.state,
             attention = excluded.attention, checks = excluded.checks, sig = excluded.sig, seen_at = excluded.seen_at`,
        )
        .run(environmentId, a.threadId, pr.url, pr.number ?? null, pr.state, shown, checks, sig, this.now());
      // the log keeps the PR's state changes (opened, merged, closed), not its checks or review
      if (!old || old.url !== pr.url || old.state !== pr.state)
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

  /** When the thread last reported finished work (orch_report), or null. */
  lastReportAt(address: string): number | null {
    const r = this.db.prepare(`SELECT MAX(at) AS at FROM board WHERE from_address = ? AND kind IN ('report','pr')`).get(address) as { at: number | null };
    return r.at;
  }

  /**
   * A lead resolves one of its threads: allowed once its worktree is clean (`worktree`: nothing uncommitted, its branch
   * in its base branch or pushed), and its PR is merged, its branch is in its base branch (a local merge, no PR), its
   * PR was closed without merging and it has reported, or the owner has read the thread since its last report. The role is retired; the caller then archives the thread
   * and its handoff predecessors (requested 2026-11-14: resolve = retire + archive).
   */
  resolve(lead: Agent, to: string, facts: { prMerged: boolean; prClosed?: boolean; lastReadAt: number | null; worktree?: Verdict }): string {
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
    } else {
      const rep = this.lastReportAt(to);
      if (rep === null) throw new EngineError("bad_state", `${to} has no merged PR and no report: it reports with orch_report first`);
      if (facts.lastReadAt === null || facts.lastReadAt < rep) throw new EngineError("bad_state", `${to}'s PR isn't merged and ${this.owner.name} hasn't read its last report yet`);
      why = `${this.owner.name} has read its final report`;
    }
    tx(this.db, () => {
      this.retire(t.threadId);
      this.event({ kind: "resolve", project: t.project, address: t.address, threadId: t.threadId, value: why });
      this.boardAdd("resolved", lead.address, lead.project, `${to} resolved: ${why}`, `Its worktree is clean (${w.why}); the thread is archived.`, t.threadId);
    });
    return `Resolved ${to} (${why === w.why ? why : `${why}; worktree clean: ${w.why}`}).`;
  }

  /**
   * The handoff predecessors of a thread, oldest first: takeOver retires the old holder of the address and adds the
   * successor in one step, so a predecessor's retired_at is its successor's created_at (the first holder often has no
   * environment recorded, so the environment can't link them). Before 1.2.0 the two came from two clock reads, so a
   * second's gap is allowed. Resolving the successor archives these first.
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

  /** The thread's Pokémon as stored, whatever the setting (Agent.mon is null with it off). */
  private rawMon(threadId: string): string | null {
    return (this.db.prepare(`SELECT mon FROM agents WHERE thread_id = ?`).get(threadId) as { mon: string | null } | undefined)?.mon ?? null;
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
        .prepare(`INSERT INTO agents (thread_id, address, role, project, parent_thread_id, status, created_at, mon, environment_id) VALUES (?, ?, ?, ?, ?, 'unknown', ?, ?, ?)`)
        .run(newThreadId, old.address, old.role, old.project, old.parentThreadId, at, this.rawMon(oldThreadId), old.environmentId);
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

  // ---------------------------------------------------------------- outputs (phase 3): finished artefacts for the owner

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

  /** Points an output at a kept copy of its file, so the Outputs tab still opens it once the worktree is gone. */
  repointOutput(id: string, path: string): void {
    this.db.prepare(`UPDATE outputs SET path = ? WHERE id = ?`).run(path, id);
    this.ports.changed();
  }

  /** The owner removes one from the record (the file itself is never touched). Only their HTTP write calls this. */
  removeOutput(id: string): void {
    if (!this.output(id)) throw new EngineError("not_found", `no output ${id}`);
    this.db.prepare(`DELETE FROM outputs WHERE id = ?`).run(id);
    this.ports.changed();
  }

  // ---------------------------------------------------------------- deliverables: a lead's finished work, with proof, for the owner

  deliverable(id: string): Deliverable | null {
    const r = this.db.prepare(`SELECT id, json FROM deliverables WHERE id = ?`).get(id) as DeliverableDbRow | undefined;
    return r ? (JSON.parse(r.json) as Deliverable) : null;
  }

  private mustDeliverable(id: string): Deliverable {
    const d = this.deliverable(id);
    if (!d) throw new EngineError("not_found", `no deliverable ${id}`);
    return d;
  }

  /** Newest change first. */
  deliverables(limit = 200): Deliverable[] {
    return (this.db.prepare(`SELECT id, json FROM deliverables ORDER BY updated_at DESC, id DESC LIMIT ?`).all(limit) as DeliverableDbRow[]).map((r) => JSON.parse(r.json));
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
    this.ports.changed();
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
   * into his review, a quiet Activity row records it, and the push hook fires.
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
      let d: Deliverable;
      if (input.revises) {
        d = this.mustDeliverable(input.revises);
        if (d.lead !== by.address) throw new EngineError("forbidden", `${d.id} is ${d.lead}'s deliverable`);
        if (d.state !== "changes") throw new EngineError("bad_state", `${d.id} is ${d.state}: revise only a deliverable ${this.owner.name} sent back with changes`);
        d.rev += 1;
        d.title = title;
        d.summary = summary;
        d.state = "review";
        d.revisions.push({ rev: d.rev, summary, proof, at: iso(t), blocks, ...points });
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
        };
        this.saveDeliverable(d);
        this.boardAdd("deliverable", by.address, by.project, `Delivered: ${title}`, summary, d.id);
      }
      this.ports.delivered?.(d);
      return d;
    });
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
   * With one ("forward this to the team", 2026-11-16) the lead gets it as a needs-ack item instead: they act on it and ack
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
   * Deliverables as the CoS and the Steward read them (orch_deliverables, 2026-11-15), per project: the same rows the
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
        lines.push(`- ${d.id} ${JSON.stringify(d.title)} by ${d.lead}, rev ${d.rev}, ${label[d.state]}; delivered ${iso(d.createdAt)}, updated ${iso(d.updatedAt)}${note}${withdrawn}`);
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

  /** A proof by its id, with the deliverable it is in. */
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
    let real: string;
    try {
      real = realpathSync(p.path);
    } catch {
      throw new EngineError("not_found", `${proofId}'s file is gone`);
    }
    if (real !== p.path || !statSync(real).isFile()) throw new EngineError("not_found", `${proofId}'s file is no longer the one registered`);
    if (p.kind === "text") return { path: real, contentType: TEXT_TYPE, maxBytes: TEXT_PROOF_MAX };
    const type = PROOF_TYPES[p.kind][extname(real).toLowerCase()];
    if (!type) throw new EngineError("not_found", `${proofId} is not a type the proof route serves`);
    return { path: real, contentType: type, maxBytes: null };
  }

  /** The live state of a PR proof, from pr-watch's readings, when one has this URL. */
  prByUrl(url: string): PrRow | null {
    const bare = url.replace(/\/+$/, "");
    const r = this.db.prepare(`SELECT environment_id FROM prs WHERE url = ? OR url = ? ORDER BY seen_at DESC LIMIT 1`).get(bare, `${bare}/`) as { environment_id: string } | undefined;
    return r ? this.prFor(r.environment_id) : null;
  }

  // ---------------------------------------------------------------- the clock

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
        if (d.kind === "plan") d.ask!.allow_text = false;
        this.save(d, "ask", "engine", "CoS didn't triage", null);
        this.upOrHold(d);
      });
    }
    // 1b. held cards whose leader is answered (or gone), or whose hold ran out, go up
    this.releaseHeld();
    // 2. deferrals that came due
    const due = this.db.prepare(`SELECT id FROM decisions WHERE deferred_until IS NOT NULL AND deferred_until <= ? AND state = 'asked'`).all(t) as { id: string }[];
    for (const { id } of due) this.personReturn(id, null, "engine");
    // 3. mail to a retired address nobody holds now
    this.deadLetterOrphans();
    // 4. unacked items whose recipient has been idle long enough: one resend, then a dead letter
    const open = (this.db.prepare(`SELECT * FROM items WHERE state = 'delivered' AND needs_ack = 1`).all() as ItemRow[]).map(toItem);
    for (const it of open) {
      if (this.settings.batchInbox) continue;
      const external = this.db.prepare(`SELECT source FROM external_mail WHERE item_id = ?`).get(it.id) as { source: string } | undefined;
      if (external && this.ports.externalEnabled?.(external.source, it.recipient) === false) continue;
      const a = this.agentByAddress(it.recipient);
      if (!a || a.status !== "idle" || a.idleAt === null) continue;
      const since = Math.max(a.idleAt, it.deliveredAt ?? 0);
      if (t - since < this.settings.resendMs) continue;
      // 2026-11-13: a resend landed thread:agent-v2:9's "squash then QA" 63 min late, after five newer messages from
      // its lead had been acked; the thread closed it as superseded at once. A message whose sender has since sent
      // this recipient newer mail that went out is that sender's old word: close it, don't resend it.
      // the orchestrator's own messages (PR-bound answers coming back) are each their own work, never an older word
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
    // 8. a lead whose status went stale while it has work going is told once
    this.statusNudges();
  }

  // ---------------------------------------------------------------- dreams (phase 3, gap 5): the orchestrator's own cards
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

  // ---------------------------------------------------------------- views

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
    if (proj && a.role === "lead") lines.push(`Project ${proj.slug}: priority ${proj.priority}${proj.heldAt ? `, ON HOLD since ${iso(proj.heldAt)} (mail waits; no new threads)` : ""}.`);
    lines.push(items.length ? `Open items (${items.length}); use orch_inbox(id=<item id>) for full text and references:` : "No open items.");
    for (const it of items) {
      const preview = this.importPreview(it.id, 300) ?? it.body.slice(0, 300);
      lines.push(`- ${it.kind} ${it.ref && it.kind.startsWith("decision") ? it.ref : it.id} from ${it.sender}${it.needsAck ? " [needs ack]" : ""}: ${preview}`);
    }
    if (owed.length) {
      lines.push(a.role === "cos" ? `Waiting for your triage (${owed.length}):` : `Your threads' questions waiting for you (${owed.length}):`);
      for (const d of owed) lines.push(`- ${d.id} ${JSON.stringify(d.request.title)} from ${d.orchestrator.origin}${d.orchestrator.action === "merge" ? " [merge card]" : ""}${d.orchestrator.triage.due_at ? `, goes to ${this.owner.name} at ${d.orchestrator.triage.due_at}` : ""}`);
    }
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
      const rules = this.liveRules(a.project);
      if (rules.length) {
        lines.push(`Standing rules you may cite:`);
        for (const r of rules) lines.push(`- ${r.id} (${r.project ?? "all projects"}; ${r.kinds.join("/")}${r.match ? "; settles the cards it matches by itself" : ""}): ${JSON.stringify(r.text)}`);
      }
    }
    return { text: lines.join("\n"), count: items.length + owed.length };
  }

  /** Needs you: what waits on the owner. */
  needsYou(): { cards: Decision[]; deferred: Decision[]; triaging: Decision[]; held: Decision[] } {
    const all = (this.db.prepare(`SELECT json FROM decisions WHERE state IN ('open','asked') AND at_level != 'lead'`).all() as { json: string }[]).map((r) => JSON.parse(r.json) as Decision);
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
   * The owner's Needs you as the CoS and the Steward read it (orch_needs_you, 2026-11-15): the cards waiting on the owner,
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
}
