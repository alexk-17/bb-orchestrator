// Shared shapes: roles and addresses, the decision record (decision schema 1, plus a few fields of our
// own that readers ignore), items, rules.

import type { Block, Point } from "../blocks.ts";
import type { RuleMatch } from "./rules.ts";
export type Role = "cos" | "steward" | "lead" | "thread";
export const ROLES: readonly Role[] = ["cos", "steward", "lead", "thread"];

export interface Agent {
  threadId: string;
  address: string; // cos | steward | lead:<project> | thread:<project>:<n>
  role: Role;
  project: string | null;
  parentThreadId: string | null;
  status: string;
  idleAt: number | null;
  environmentId: string | null;
  mon: string | null; // its Pokémon (mons.ts)
  monPin: { stage: number; level: number } | null; // a stage kept through a change of Pokémon (mons.ts StagePin)
  flags: string; // comma list: "unplanned"
}

export const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function addressFor(role: Role, project: string | null, n?: number): string {
  if (role === "cos" || role === "steward") return role;
  if (!project) throw new EngineError("invalid", `a ${role} needs a project`);
  return role === "lead" ? `lead:${project}` : `thread:${project}:${n}`;
}

export type ErrorKind = "not_found" | "conflict" | "bad_state" | "invalid" | "forbidden";
export class EngineError extends Error {
  kind: ErrorKind;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "EngineError";
  }
}

export interface Opt {
  id: string;
  label: string;
  detail: string;
  recommended?: boolean;
  /** A plan's approving option ("go"): answering with it lets the lead start the plan's threads. */
  go?: boolean;
}

export type Priority = "urgent" | "high" | "normal" | "low";
export const PRIORITIES: readonly Priority[] = ["urgent", "high", "normal", "low"];

/** A project's mode (1.11.0): scoping while the owner and its lead settle what it is; active is the normal flow. */
export type ProjectMode = "scoping" | "active";
export const PROJECT_MODES: readonly ProjectMode[] = ["scoping", "active"];

/**
 * A scoping task (1.12.0): one named part of a project the owner scopes with its lead while the rest goes the normal
 * way. Its cards and deliverables carry its id (scope_task) beside the scope flag; "Scoping done?" with the task closes it.
 */
export type ScopingTaskState = "scoping" | "done" | "dropped";
export interface ScopingTask {
  id: string;
  project: string;
  name: string;
  state: ScopingTaskState;
  openedBy: string;
  openedAt: number;
  closedAt: number | null;
  /** The lead's summary on the "Scoping done?" the owner said yes to. */
  summary: string | null;
  /** The file the lead wrote the task's findings to. */
  doc: string | null;
}

export interface HistoryEntry {
  at: string;
  rev: number;
  event: "add" | "notify" | "ask" | "answer" | "relay" | "ack" | "merge" | "withdraw" | "defer" | "return" | "import" | "revise";
  state: string;
  by: string;
  note: string | null;
}

export type DecisionState = "open" | "asked" | "answered" | "acked" | "merged" | "withdrawn";
export type Level = "lead" | "cos" | "person";
export type Outcome = "done" | "refused" | "failed" | "superseded";
export const OUTCOMES: readonly Outcome[] = ["done", "refused", "failed", "superseded"];
/**
 * What closed an item or a card: an agent's outcome, or "replied" (the engine's own: its recipient answered the sender
 * instead of acking it). "replied" says the item was answered, never that its work is done, so no agent may pick it.
 */
export type Closed = Outcome | "replied";

/** One decision. The fields the earlier schema 1 names keep its meaning; the `orchestrator` block is ours. */
export interface Decision {
  schema: 1;
  id: string;
  rev: number;
  state: DecisionState;
  kind: "question" | "plan";
  created_at: string;
  updated_at: string;
  project: string | null;
  request_key: string | null;
  request: {
    by: { role: string; project: string | null; thread: string | null; terminal: null; machine: null; address: string };
    title: string;
    question: string;
    context: string;
    options: Opt[];
    /** Typed parts the screens draw as components (blocks.ts); absent on decisions from before them. */
    blocks?: Block[];
  };
  reply_to: { labels: Record<string, string>; terminal: null; machine: null };
  ask: {
    by: string;
    at: string;
    title: string;
    question: string;
    context: string;
    options: Opt[];
    allow_text: boolean;
  } | null;
  answer: {
    option: string | null;
    label: string | null;
    text: string | null;
    by: string;
    via: string;
    at: string;
    source: string | null;
  } | null;
  relay: { at: string; ok: boolean; to: string[]; items: string[]; attempts: number; error: null } | null;
  ack: { by: string; at: string; note: string | null; outcome: Closed } | null;
  cos_notified_at: string | null;
  owed_from: null;
  merged_into: string | null;
  merged: string[];
  /** `moot`: the CoS took it off the owner's Needs you as no longer needed (2026-11-15); a later answer is refused. */
  withdrawn: { by: string; at: string; reason: string; moot?: boolean; bounced?: boolean } | null;
  deferred: { until: string | null; preset: string; by: string; via: string; source: string | null; at: string; rev: number; item: string | null } | null;
  returned: { at: string; by: string; why: string; source: string | null } | null;
  history: HistoryEntry[];
  orchestrator: {
    at_level: Level;
    asker: string; // the address the answer goes to (only)
    origin: string; // the address that first asked
    action: "merge" | null; // a merge card: the CoS may never settle it
    triage: { filed_at: string | null; due_at: string | null; triaged_at: string | null; by: string | null; escalated_at: string | null };
    forwarded_by: string | null;
    /** A plan card: the threads its go allows and the go option's id. */
    plan?: { threads: number; go: string } | null;
    /** A "Make this a rule?" card the CoS proposed: option 1 adds the rule (rules.ts). */
    rule_proposal?: { text: string; project: string | null; match: RuleMatch | null; evidence: string[]; kinds?: string[]; rule_id: string | null } | null;
    /** Held off the owner's Needs you behind an earlier card from the same asker and project, until `until` at most. */
    held?: { behind: string; at: string; until: string } | null;
    /** Filed while its project was scoping, or into a scoping task: it waits in the owner's Scope pane, never in triage or Needs you. */
    scope?: boolean;
    /** The scoping task it was filed into (1.12.0): it groups the card in the Scope pane under that task. */
    scope_task?: string | null;
    /**
     * A "Scoping done?" card: the lead's summary and its PROJECT.md. Option 1 (yes) makes the project active. With task
     * (1.12.0): the file is doc, and the yes closes only that task.
     */
    scoping_done?: { summary: string; project_md?: string; doc?: string; task?: string } | null;
    /** The asker revised it while unanswered (orch_ask revises): how many times, the last time, and why. */
    revised?: { count: number; at: string; why: string } | null;
    /** A flagged board deliverable's card: its answer approves or sends back that revision. */
    board_review?: { deliverable: string; rev: number } | null;
  };
}

export type ItemKind =
  | "message"
  | "owner.message" // the owner's direct message to a lead from its Projects row (2026-11-16), answered by an ack note
  | "owner.cos" // the owner's tracked message to the CoS (the feed, the docked bar, the Chat tab), answered with orch_reply_owner
  | "cos.reply" // the CoS's answer to one, recorded closed: it never reaches a thread
  | "copy"
  | "decision.new"
  | "decision.answer"
  | "decision.deferred"
  | "notice"
  | "alarm"
  | "deliverable.changes"
  | "deliverable.approved"
  | "deliverable.next";

export type ItemState = "pending" | "queued" | "delivered" | "closed" | "dead";

export interface Item {
  id: string;
  recipient: string;
  sender: string;
  kind: ItemKind;
  ref: string | null;
  body: string;
  sendKey: string | null;
  needsAck: boolean;
  state: ItemState;
  attempts: number;
  queuedMessageId: string | null;
  createdAt: number;
  deliveredAt: number | null;
  closedAt: number | null;
  outcome: string | null;
  note: string | null;
  /** When it last became a dead letter (null: alive, or dead before 2026-11-15). */
  deadAt: number | null;
  /** A dead letter on the owner's Board: one the CoS escalated, or one from before the CoS managed them. */
  onBoard: boolean;
  /** The feed post the owner's message or its answer belongs to (core/feed.ts keys), else null. */
  about: string | null;
}

export interface Rule {
  id: string;
  text: string;
  project: string | null; // null: every project
  kinds: string[]; // decision kinds it settles: "question", "plan"; never "merge". Or exactly ["practice"]: a standing instruction that settles nothing (isPractice)
  expiresAt: number | null;
  grantedBy: "person";
  source: string;
  createdAt: number;
  revokedAt: number | null;
  /** Set on a rule made from the owner's answers: it settles the cards it matches by itself (rules.ts). */
  match: RuleMatch | null;
}

/** A standing practice (2026-11-19): an instruction from the owner that leads, the CoS and threads follow. It settles no card and is never cited. */
export const isPractice = (r: Pick<Rule, "kinds">): boolean => r.kinds.includes("practice");

export function oneLine(s: string, max: number, what: string): string {
  const t = s.trim();
  if (/[\r\n]/.test(t)) throw new EngineError("invalid", `${what} must be one line`);
  if (t.length === 0) throw new EngineError("invalid", `${what} is empty`);
  if (t.length > max) throw new EngineError("invalid", `${what} is over ${max} characters`);
  return t;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------- deliverables (docs/deliverables-plan.md)

export const PROOF_KINDS = ["image", "video", "text", "doc", "pr", "link"] as const;
export type ProofKind = (typeof PROOF_KINDS)[number];

/** One piece of proof. A file is kept as its realpath and its bb host; a PR or link as its URL. */
export interface Proof {
  id: string; // p-…: the only handle the proof route serves a file by
  kind: ProofKind;
  caption: string;
  path: string | null;
  url: string | null;
  hostId: string | null;
  /** 2026-11-17: a file copied into the deliverable's folder has the copy as `path` and its original here (provenance). */
  source?: string | null;
  /** What filing did with the file: copied, too big to copy (over COPY_MAX), already missing, or a failed copy (retried on start). */
  stored?: "copied" | "too_big" | "missing" | "failed";
  bytes?: number;
}

export type DeliverableState = "review" | "approved" | "changes" | "withdrawn";

export interface Deliverable {
  id: string;
  project: string | null;
  lead: string; // the delivering lead's address
  title: string;
  summary: string;
  state: DeliverableState;
  rev: number; // the revision number: 1, then +1 per re-delivery
  createdAt: number;
  updatedAt: number;
  revisions: { rev: number; summary: string; proof: Proof[]; at: string; blocks?: Block[]; points?: Point[] }[];
  feedback: { rev: number; by: "person"; text: string | null; at: string; outcome: "approved" | "changes" }[];
  withdrawn: { at: string; reason: string | null } | null;
  /** The owner approved it with a next action for the lead: what to do, and the needs-ack item that carries it. */
  next?: { text: string; rev: number; at: string; item: string } | null;
  /** Delivered while its project was scoping, or into a scoping task: reviewed in the owner's Scope pane, not on Deliverables. */
  scope?: boolean;
  /** The scoping task it was delivered into (1.12.0). */
  scope_task?: string;
  /** Its own folder of files (core/deliverable-files.ts, 2026-11-17): images/, videos/, artifacts/ and README.md. */
  folder?: string;
  /** A review a Multiplayer board triggered: reviewed on that board, never on Deliverables. `card`: the flag's Needs you card. */
  board?: DeliverableBoard;
}

export interface DeliverableBoard {
  id: string;
  record?: string;
  flag?: string;
  card?: string;
}

/** A next action as it stands: the lead's item, open until they close it with an outcome and a note. */
export interface DeliverableNext {
  text: string;
  rev: number;
  at: string;
  item: string;
  state: "open" | "closed" | "dead";
  outcome: string | null;
  note: string | null;
  closedAt: number | null;
}

/** A project slug for the owner's eyes (sidebar sections, lead titles): "search-llms" → "Search LLMs". */
const ACRONYMS: Record<string, string> = { llms: "LLMs", llm: "LLM", qa: "QA", fde: "FDE", pr: "PR", prs: "PRs", microvm: "MicroVM", ai: "AI", sdk: "SDK", mcp: "MCP", pii: "PII", dx: "DX", smb: "SMB", api: "API", ui: "UI" };
export const projectTitle = (slug: string): string =>
  slug.split("-").map((w) => ACRONYMS[w] ?? (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");

/** A sidebar section's name: "Search LLMs" (the emoji was dropped, 2026-11-13); the CoS and the Steward sit in "Orchestrator". */
export const sectionTitle = (slug: string | null): string => (slug ? projectTitle(slug) : "Orchestrator");
