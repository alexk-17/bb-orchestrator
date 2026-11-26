// The project page's history (2026-11-16): the append-only events log (db.ts), its one-time backfill from the older
// tables, and the pure builder that turns one project's rows into what the page draws: a Gantt row per address (its
// holders end to end, coloured by status, with PR, handoff and resolve marks and the owner's cards), the flow (who
// started it, its providers, its PRs) and what waits on what.
import { type Db, tx } from "./db.ts";
import { MOOT_MIN_SHARED, sharedWords } from "./moot.ts";
import { BUSY_STATUSES, PR_BLOCKED, prWait, reviewOf, threadState } from "./attach-state.ts";

// lead-status: an orch_status publish (value = the status as JSON); the history builder doesn't draw it.
// mode (1.11.0): the project's mode changed (value = the new mode, address = its lead's, note = who, ref = the card).
// scope-task (1.12.0): a scoping task opened or closed (value = its state, address = its lead's, note = its name, ref =
// the "Scoping done?" card, else the task)
// scope-thread (1.13.0): the owner made a thread a task's scoping thread, or stopped it (value = scoping | stopped,
// address and thread = the thread's, note = the task's name, ref = the task)
export type EventKind = "spawn" | "status" | "pr" | "handoff" | "retire" | "resolve" | "lead-status" | "direct-answer" | "mode" | "scope-task" | "scope-thread";
export interface EventIn {
  at: number;
  kind: EventKind;
  project: string | null;
  address: string | null;
  threadId: string | null;
  value?: string | null;
  ref?: string | null;
  note?: string | null;
}
export interface EventRow {
  seq: number;
  at: number;
  kind: EventKind;
  project: string | null;
  address: string | null;
  thread_id: string | null;
  value: string | null;
  ref: string | null;
  note: string | null;
  backfill: number;
}

export function logEvent(db: Db, e: EventIn, backfill = false): void {
  db.prepare(`INSERT INTO events (at, kind, project, address, thread_id, value, ref, note, backfill) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    e.at,
    e.kind,
    e.project,
    e.address,
    e.threadId,
    e.value ?? null,
    e.ref ?? null,
    e.note ?? null,
    backfill ? 1 : 0,
  );
}

/** When the log started (the backfill's instant), or null before it ran. */
export function logSince(db: Db): number | null {
  return (db.prepare(`SELECT value FROM cursors WHERE name = 'events.since'`).get() as { value: number } | undefined)?.value ?? null;
}

const PR_TITLE = /^(\S+): PR(?: #(\d+))? (open|draft|merged|closed)\b/;
const HANDOFF_BODY = /^(\S+) → (\S+)\. ([^\s;]+)/;
const RESOLVED_TITLE = /^(\S+) resolved: (.*)$/;

/**
 * Once: what the older tables already say, as backfill rows. Each agent's start and retirement, each resolve and
 * handoff the Board recorded, and each PR state change from the Board's PR notices. Then one status row per live agent
 * at the log's start, so its bar has a colour from there. Status before the log isn't known: those bars show only
 * their start and end. Returns false when it had run already.
 */
export function backfillEvents(db: Db, now: number): boolean {
  return tx(db, () => {
    if (logSince(db) !== null) return false;
    const agents = db.prepare(`SELECT thread_id, address, role, project, parent_thread_id, status, created_at, retired_at FROM agents`).all() as {
      thread_id: string;
      address: string;
      role: string;
      project: string | null;
      parent_thread_id: string | null;
      status: string;
      created_at: number;
      retired_at: number | null;
    }[];
    for (const a of agents) {
      const base = { project: a.project, address: a.address, threadId: a.thread_id };
      logEvent(db, { ...base, at: a.created_at, kind: "spawn", value: a.role, ref: a.parent_thread_id }, true);
      if (a.retired_at !== null) logEvent(db, { ...base, at: a.retired_at, kind: "retire" }, true);
    }
    const board = db.prepare(`SELECT kind, from_address, project, title, body, ref, at FROM board WHERE kind IN ('resolved','notice','prstate') ORDER BY at, rowid`).all() as {
      kind: string;
      from_address: string | null;
      project: string | null;
      title: string;
      body: string;
      ref: string | null;
      at: number;
    }[];
    const lastPr = new Map<string, string>();
    for (const r of board) {
      if (r.kind === "resolved") {
        const m = RESOLVED_TITLE.exec(r.title);
        if (m && r.ref) logEvent(db, { at: r.at, kind: "resolve", project: r.project, address: m[1]!, threadId: r.ref, value: m[2]! }, true);
      } else if (r.kind === "notice" && r.title.endsWith(" handed over")) {
        const m = HANDOFF_BODY.exec(r.body);
        if (m) logEvent(db, { at: r.at, kind: "handoff", project: r.project, address: r.title.slice(0, -" handed over".length), threadId: m[2]!, ref: m[1]!, value: m[3]!, note: null }, true);
      } else if (r.kind === "prstate") {
        const m = PR_TITLE.exec(r.title);
        if (!m || !r.ref) continue;
        const key = `${m[1]}|${r.ref}`;
        if (lastPr.get(key) === m[3]) continue; // a checks or review change: not a state change
        lastPr.set(key, m[3]!);
        logEvent(db, { at: r.at, kind: "pr", project: r.project, address: m[1]!, threadId: null, value: m[3]!, ref: r.ref, note: m[2] ?? null }, true);
      }
    }
    for (const a of agents) if (a.retired_at === null) logEvent(db, { at: now, kind: "status", project: a.project, address: a.address, threadId: a.thread_id, value: a.status });
    db.prepare(`INSERT INTO cursors (name, value) VALUES ('events.since', ?)`).run(now);
    return true;
  });
}

// ---------------------------------------------------------------- the page's shape

export type SegState = "working" | "idle" | "blocked" | "released" | "unknown" | "nolog";
export type MarkKind = "pr-open" | "pr-draft" | "pr-merged" | "pr-closed" | "handoff" | "resolve" | "mode";
export type DepKind = "card" | "held" | "deferred" | "hold" | "dead" | "reply" | "pr" | "ci" | "review";
export interface Holder {
  threadId: string;
  from: number;
  to: number | null;
  provider: string | null;
  segments: { from: number; to: number; state: SegState }[];
}
export interface HistoryRow {
  address: string;
  role: string;
  live: boolean;
  parent: string | null;
  holders: Holder[];
  marks: { at: number; kind: MarkKind; label: string; url: string | null }[];
  asks: { id: string; title: string; from: number; to: number | null }[];
  prs: { url: string; number: number | null; state: string }[];
}
export interface Dep {
  from: string; // an address, or the project's slug (a hold)
  on: string; // "owner", an address, or "pr" / "ci" / "review"
  kind: DepKind;
  label: string;
  since: number | null;
  ref: string | null; // a card id, PR url or item id
  block: boolean; // nothing moves until it is settled
}
export interface ProjectHistory {
  slug: string;
  now: number;
  start: number;
  logSince: number | null;
  rows: HistoryRow[];
  deps: Dep[];
}

export interface HistoryInput {
  slug: string;
  now: number;
  logSince: number | null;
  heldAt: number | null;
  agents: { thread_id: string; address: string; role: string; parent_thread_id: string | null; status: string; created_at: number; retired_at: number | null }[];
  /** The project's events; a thread that later took a new role (register deletes its old row) is known only here. */
  events: EventRow[];
  decisions: DecisionLite[];
  waits: { id: string; owner: string; pr_url: string; cond: string; created_at: number }[];
  items: { id: string; sender: string; recipient: string; kind: string; state: string; body: string; created_at: number }[];
  prs: { thread_id: string; url: string | null; number: number | null; state: string | null; checks: string | null; sig: string; attention: string | null }[];
  providers: Map<string, string | null>;
}
export interface DecisionLite {
  id: string;
  state: string;
  level: string;
  asker: string;
  origin: string;
  title: string;
  createdAt: number;
  askedAt: number;
  endedAt: number | null;
  deferred: boolean;
  heldBehind: string | null;
  /** The question the owner's card asks (its ask, else its request); absent where nothing reads it. */
  question?: string;
}

export function segState(status: string | null): SegState {
  return threadState(status);
}

/** thread:<p>:<n> → n; a lead sorts first. */
const rank = (address: string) => (address.startsWith("lead:") ? -1 : Number(address.split(":")[2] ?? Number.MAX_SAFE_INTEGER));

function segments(threadId: string, from: number, to: number, since: number | null, events: EventRow[]): Holder["segments"] {
  const out: Holder["segments"] = [];
  const push = (a: number, b: number, state: SegState) => {
    if (b <= a) return;
    const last = out[out.length - 1];
    if (last && last.state === state && last.to === a) last.to = b;
    else out.push({ from: a, to: b, state });
  };
  let at = from;
  let state: SegState = "unknown";
  if (since === null || from < since) {
    const cut = since === null ? to : Math.min(since, to);
    push(from, cut, "nolog");
    at = cut;
  }
  for (const e of events) {
    if (e.kind !== "status" || e.thread_id !== threadId || e.at < at || e.at > to) continue;
    push(at, e.at, state);
    state = segState(e.value);
    at = e.at;
  }
  push(at, to, state);
  return out;
}

export function buildHistory(x: HistoryInput): ProjectHistory {
  const { now, logSince: since } = x;
  // holders by address: the agents rows, plus those only the events know (a thread that later took a new role)
  const holders = new Map<string, { threadId: string; role: string; parent: string | null; from: number; to: number | null; live: boolean }[]>();
  const held = new Set<string>(); // every thread id some address's holders list has
  const add = (address: string, h: { threadId: string; role: string; parent: string | null; from: number; to: number | null; live: boolean }) => {
    const list = holders.get(address) ?? [];
    if (!list.some((y) => y.threadId === h.threadId)) list.push(h);
    holders.set(address, list);
    held.add(h.threadId);
  };
  // the log grouped once, in log order, by address and by thread (2026-11-23, lag: each address filtered the whole log,
  // 140 ms on a busy project); an event with both lands in both lists, and a row's own events are their union
  const byAddress = new Map<string, number[]>();
  const byThread = new Map<string, number[]>();
  const at = (m: Map<string, number[]>, k: string, i: number) => {
    const l = m.get(k);
    if (l) l.push(i);
    else m.set(k, [i]);
  };
  x.events.forEach((e, i) => {
    if (e.address != null) at(byAddress, e.address, i);
    if (e.thread_id !== null) at(byThread, e.thread_id, i);
  });
  for (const a of x.agents) add(a.address, { threadId: a.thread_id, role: a.role, parent: a.parent_thread_id, from: a.created_at, to: a.retired_at, live: a.retired_at === null });
  for (const e of x.events) {
    if (e.kind !== "spawn" || !e.address || !e.thread_id) continue;
    if (held.has(e.thread_id)) continue;
    const end = (byThread.get(e.thread_id) ?? []).map((i) => x.events[i]!).find((r) => r.kind === "retire" && r.at >= e.at);
    add(e.address, { threadId: e.thread_id, role: e.value ?? "thread", parent: e.ref, from: e.at, to: end?.at ?? e.at, live: false });
  }
  const asksOf = new Map<string, DecisionLite[]>();
  for (const d of x.decisions) {
    if (d.level !== "person") continue;
    const l = asksOf.get(d.origin);
    if (l) l.push(d);
    else asksOf.set(d.origin, [d]);
  }
  const addressOfThread = new Map<string, string>();
  for (const [address, list] of holders) for (const h of list) addressOfThread.set(h.threadId, address);
  // providers: bb's word for the thread, else what a handoff recorded (value: the successor's, note: the predecessor's)
  const provider = new Map<string, string | null>();
  for (const e of x.events) {
    if (e.kind !== "handoff") continue;
    if (e.thread_id && e.value) provider.set(e.thread_id, e.value);
    if (e.ref && e.note) provider.set(e.ref, e.note);
  }
  for (const [id, p] of x.providers) if (p) provider.set(id, p);

  const rows: HistoryRow[] = [];
  for (const [address, list] of holders) {
    list.sort((a, b) => a.from - b.from);
    const own = new Set(list.map((h) => h.threadId));
    const mine = new Set(byAddress.get(address));
    for (const id of own) for (const i of byThread.get(id) ?? []) mine.add(i);
    const evs = [...mine].sort((a, b) => a - b).map((i) => x.events[i]!);
    const marks: HistoryRow["marks"] = [];
    const prState = new Map<string, { number: number | null; state: string }>();
    for (const e of evs) {
      if (e.kind === "pr" && e.ref && e.value) {
        const prev = prState.get(e.ref);
        const number = e.note ? Number(e.note) || null : (prev?.number ?? null);
        prState.set(e.ref, { number, state: e.value });
        if (prev?.state === e.value) continue;
        const kind = (`pr-${e.value}` as MarkKind);
        if (!["pr-open", "pr-draft", "pr-merged", "pr-closed"].includes(kind)) continue;
        marks.push({ at: e.at, kind, label: `#${number ?? "?"} ${e.value}`, url: e.ref });
      } else if (e.kind === "handoff") {
        marks.push({ at: e.at, kind: "handoff", label: `→ ${providerWord(e.value)}`, url: null });
      } else if (e.kind === "resolve") {
        marks.push(e.ref && e.note ? { at: e.at, kind: "resolve", label: `resolved: PR handed off to ${e.note}`, url: e.ref } : { at: e.at, kind: "resolve", label: "resolved", url: null });
      } else if (e.kind === "mode") {
        marks.push({ at: e.at, kind: "mode", label: e.value === "active" ? "scoping done: active" : "scoping", url: null });
      } else if (e.kind === "scope-task") {
        // drawn as the mode mark: a ring, filled once the task is done
        marks.push({ at: e.at, kind: "mode", label: `${e.value === "done" ? "scoping done" : e.value === "dropped" ? "scoping dropped" : "scoping"}: ${e.note ?? "a task"}`, url: null });
      } else if (e.kind === "scope-thread") {
        // on the thread's own row: when the owner made it a task's scoping thread, and when they stopped it
        marks.push({ at: e.at, kind: "mode", label: `${e.value === "stopped" ? "scoping stopped" : "scoping thread"}: ${e.note ?? "a task"}`, url: null });
      }
    }
    // the current PR rows of its holders (a reading older than the log, or a draft that never changed)
    for (const p of x.prs) {
      if (!own.has(p.thread_id) || !p.url || !p.state) continue;
      prState.set(p.url, { number: p.number ?? prState.get(p.url)?.number ?? null, state: p.state });
    }
    marks.sort((a, b) => a.at - b.at);
    const asks = (asksOf.get(address) ?? [])
      .map((d) => ({ id: d.id, title: d.title, from: d.askedAt, to: d.endedAt }))
      .sort((a, b) => a.from - b.from);
    const first = list[0]!;
    rows.push({
      address,
      role: first.role,
      live: list.some((h) => h.live),
      parent: first.parent ? (addressOfThread.get(first.parent) ?? null) : null,
      holders: list.map((h) => ({
        threadId: h.threadId,
        from: h.from,
        to: h.to,
        provider: provider.get(h.threadId) ?? null,
        segments: segments(h.threadId, h.from, h.to ?? now, since, evs),
      })),
      marks,
      asks,
      prs: [...prState].map(([url, p]) => ({ url, number: p.number, state: p.state })),
    });
  }
  rows.sort((a, b) => rank(a.address) - rank(b.address) || a.address.localeCompare(b.address));
  const start = Math.min(now, ...rows.flatMap((r) => r.holders.map((h) => h.from)));
  return { slug: x.slug, now, start, logSince: since, rows, deps: buildDeps(x, rows) };
}

/** "claude-code" → "Claude", "codex" → "Codex"; anything else as it is. */
export function providerWord(p: string | null): string {
  if (!p) return "?";
  const s = p.toLowerCase();
  if (s.includes("codex")) return "Codex";
  if (s.includes("claude")) return "Claude";
  return p;
}

const DEP_RANK: Record<DepKind, number> = { hold: 0, card: 1, held: 1, dead: 1, deferred: 2, reply: 3, review: 4, ci: 4, pr: 5 };
const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const who = (address: string) => (address === "person" ? "owner" : address);

function buildDeps(x: HistoryInput, rows: HistoryRow[]): Dep[] {
  const live = new Set(rows.filter((r) => r.live).map((r) => r.address));
  const ours = new Set(rows.map((r) => r.address));
  const prThreads = new Map<string, Set<string>>();
  for (const r of rows) if (r.live) prThreads.set(r.address, new Set(r.holders.filter((h) => h.to === null).map((h) => h.threadId)));
  return depRules(x, ours, live, prThreads);
}

/** What the dependency rules read: one project's open cards, mail, PR-bound answers and PR readings. */
type DepInput = Pick<HistoryInput, "slug" | "heldAt" | "decisions" | "items" | "waits" | "prs">;

/**
 * The dependency rules, shared by the project page (buildDeps) and the Projects row (buildSummary). `ours`: every
 * address the project ever had; `live`: those held now; `prThreads`: each live address's current bb threads, in order.
 */
function depRules(x: DepInput, ours: Set<string>, live: Set<string>, prThreads: Map<string, Set<string>>): Dep[] {
  const out: Dep[] = [];
  if (x.heldAt !== null) out.push({ from: x.slug, on: "owner", kind: "hold", label: "on hold", since: x.heldAt, ref: null, block: true });
  for (const d of x.decisions) {
    if (d.state !== "open" && d.state !== "asked") continue;
    if (!ours.has(d.origin) && !ours.has(d.asker)) continue;
    const from = ours.has(d.origin) ? d.origin : d.asker;
    if (d.level === "person") {
      const kind: DepKind = d.heldBehind ? "held" : d.deferred ? "deferred" : "card";
      out.push({ from, on: "owner", kind, label: short(d.title), since: d.askedAt, ref: d.id, block: kind !== "deferred" });
    } else {
      out.push({ from, on: d.level === "cos" ? "cos" : `lead:${x.slug}`, kind: "card", label: short(d.title), since: d.createdAt, ref: d.id, block: true });
    }
  }
  for (const it of x.items) {
    const from = who(it.sender);
    const on = who(it.recipient);
    if (!ours.has(it.sender) && !ours.has(it.recipient)) continue;
    // a reply owed by an agent that has since retired never comes: only the dead letters say so
    if (it.state !== "dead" && ours.has(it.recipient) && !live.has(it.recipient)) continue;
    if (it.state === "dead") out.push({ from, on, kind: "dead", label: `undelivered ${it.kind}`, since: it.created_at, ref: it.id, block: true });
    else out.push({ from, on, kind: "reply", label: short(it.body.split("\n")[0] ?? it.kind, 50), since: it.created_at, ref: it.id, block: false });
  }
  for (const w of x.waits) {
    if (!ours.has(w.owner)) continue;
    const n = x.prs.find((p) => p.url === w.pr_url)?.number ?? null;
    out.push({ from: w.owner, on: "pr", kind: "pr", label: `#${n ?? "?"} ${w.cond}`, since: w.created_at, ref: w.pr_url, block: false });
  }
  for (const [address, ids] of prThreads) {
    if (!live.has(address)) continue;
    for (const p of x.prs) {
      if (!ids.has(p.thread_id) || !p.url || (p.state !== "open" && p.state !== "draft")) continue;
      const w = prWait({ ...p, review: reviewOf(p.sig) });
      if (w === "ci") out.push({ from: address, on: "ci", kind: "ci", label: `PR #${p.number ?? "?"}`, since: null, ref: p.url, block: false });
      else if (w === "review")
        out.push({ from: address, on: "review", kind: "review", label: `PR #${p.number ?? "?"}`, since: null, ref: p.url, block: false });
    }
  }
  return out.sort((a, b) => Number(b.block) - Number(a.block) || DEP_RANK[a.kind] - DEP_RANK[b.kind] || (a.since ?? Infinity) - (b.since ?? Infinity));
}


// ---------------------------------------------------------------- the Projects row (2026-11-16, the command center)

/**
 * One wait on a project's row. `source`: "lead" (the lead's own status, matched with a live fact when one says the same
 * kind and ref) or "live" (read from cards, mail and PRs). `kind` is the lead's kind, or for a live wait what it is: an
 * owner card (card, deferred, held), a CoS card, a dead letter, a reply owed by someone outside, an answer bound to a
 * PR (pr-bound), ci, review, a PR ready to merge (merge) or blocked (pr-blocked), a deliverable in review.
 * `unchanged`: `since` is when the PR's recorded state last changed (prs.seen_at), drawn "unchanged 15h", never
 * "waiting 15h": the reading can't prove the condition held all along. `note`: what a live fact adds to the lead's word
 * that still stands (its thread failed). A lead's wait a live fact shows is over (answered, merged, resolved) is not
 * a wait at all: buildSummary drops it and says the status is out of date.
 */
export interface SummaryWait {
  source: "lead" | "live";
  kind: string;
  ref: string | null;
  who: string | null;
  label: string | null;
  since: number | null;
  unchanged: boolean;
  note: string | null;
}
export interface ProjectSummary {
  /** The motion word before the client adds Needs you and Blocked: held, no lead, moving, waiting, quiet. */
  motion: "held" | "nolead" | "moving" | "waiting" | "quiet";
  threads: { working: number; total: number };
  leadWorking: boolean;
  /** The owner's open cards from this project (answerable now: not deferred, not held), and the oldest one's title. */
  needsYou: { count: number; id: string | null; title: string | null; question: string | null; since: number | null };
  /** The waits, each once: no lead wait a live fact shows is over, no two with the same kind and ref or the same words. */
  waits: SummaryWait[];
  /** The lead's blockers, minus those a card answered after the status covers. */
  blockers: string[];
  /** A live fact contradicts the lead's status (a wait it names is over, or an answer covers a blocker). */
  statusOutOfDate: boolean;
  /** For a quiet row: the latest finished thing at any age, and since when the lead has been idle. */
  last: { text: string; at: number } | null;
  leadIdleSince: number | null;
  /** The latest finished thing in the last 24 h: an approved deliverable, a merged PR or a thread's report. */
  done: { text: string; at: number; kind: "deliverable" | "merged" | "report" } | null;
}

export interface SummaryInput extends DepInput {
  now: number;
  hasLead: boolean;
  status: { waits: { kind: string; ref: string | null; label: string | null; who: string | null; since: number }[]; blockers: string[]; updatedAt: number } | null;
  /** The project's agents, live and retired (retired ones only name their addresses, for `ours`). */
  agents: { thread_id: string; address: string; role: string; status: string; idle_at: number | null; retired_at: number | null }[];
  prs: (DepInput["prs"][number] & { seen_at: number })[];
  deliverables: { id: string; title: string; state: string; updated_at: number }[];
  /** For the lead's own waits that name a card: its state now and when it was answered. */
  cards: Map<string, { state: string; answeredAt: number | null }>;
  /**
   * PRs and addresses anywhere in the plugin, for a lead's wait that names one outside the project (its PR merged, its
   * thread resolved). refAgents: whether the address has a live holder now (false: known, and every holder is gone).
   */
  refPrs?: Map<string, { state: string | null; seen_at: number }>;
  refAgents?: Map<string, boolean>;
  /** The project's cards answered after its status was published: what can cover a lead's blocker. */
  answered: { id: string; text: string; answeredAt: number }[];
  done: { text: string; at: number; kind: "deliverable" | "merged" | "report" }[];
  /** The latest finished thing at any age (for a quiet row). */
  last: { text: string; at: number } | null;
}

const WORKING = BUSY_STATUSES;
export const SUMMARY_DONE_MS = 24 * 3_600_000;
/** A wait on the lead's own thread is part of the title until that thread has been idle this long (or failed). */
export const OWN_THREAD_IDLE_MS = 30 * 60_000;

/**
 * One project's row, from the dependency rules kept in one place (depRules), filtered to waits by the project on
 * something outside it: no mail waiting for its own agents to act, no card a thread put to its own lead, and a PR's
 * waits only while that PR's thread isn't working. Then the lead's own waits, each merged with a live fact that has
 * the same kind and ref, and dropped when a live fact shows it is over (its PR merged, its card answered, its thread
 * resolved); a failed thread stays, with a note.
 */
export function buildSummary(x: SummaryInput): ProjectSummary {
  const liveAgents = x.agents.filter((a) => a.retired_at === null && a.status !== "archived");
  const ours = new Set(x.agents.map((a) => a.address));
  const live = new Set(liveAgents.map((a) => a.address));
  // a PR belongs to the address, not the thread that first read it: after a handoff the successor holds it
  const addressOf = new Map(x.agents.map((a) => [a.thread_id, a.address]));
  const workingAt = new Set(liveAgents.filter((a) => WORKING.has(a.status)).map((a) => a.address));
  const prWorked = (threadId: string) => workingAt.has(addressOf.get(threadId) ?? "");
  const prThreads = new Map<string, Set<string>>();
  for (const a of x.agents) prThreads.set(a.address, new Set([...(prThreads.get(a.address) ?? []), a.thread_id]));
  const prByUrl = new Map(x.prs.filter((p) => p.url).map((p) => [p.url!, p]));
  // a PR wait counts only while the thread that owns the PR isn't working on it
  const prIdle = (url: string | null) => {
    const p = url ? prByUrl.get(url) : undefined;
    return !p || !prWorked(p.thread_id);
  };
  const liveWaits: SummaryWait[] = [];
  const add = (w: Omit<SummaryWait, "source" | "note" | "unchanged" | "who"> & { unchanged?: boolean; who?: string | null }) =>
    liveWaits.push({ source: "live", who: null, unchanged: false, note: null, ...w });
  for (const d of depRules(x, ours, live, prThreads)) {
    if (d.kind === "hold") continue; // the state word says it
    // inside the project: mail to its own agents is theirs to act on, a thread's card to its own lead is the lead's
    if (ours.has(d.on)) continue;
    if (d.kind === "card") add({ kind: d.on === "owner" ? "card" : "cos-card", ref: d.ref, label: d.label, since: d.since });
    else if (d.kind === "held" || d.kind === "deferred") add({ kind: d.kind, ref: d.ref, label: d.label, since: d.since });
    else if (d.kind === "dead" || d.kind === "reply") add({ kind: d.kind, ref: d.ref, who: d.on, label: d.label, since: d.since });
    else if (d.kind === "pr") {
      if (prIdle(d.ref)) add({ kind: "pr-bound", ref: d.ref, label: d.label, since: d.since });
    } else if ((d.kind === "ci" || d.kind === "review") && prIdle(d.ref)) {
      const p = d.ref ? prByUrl.get(d.ref) : undefined;
      add({ kind: d.kind, ref: d.ref, who: p?.number ? `PR #${p.number}` : null, label: null, since: p?.seen_at ?? null, unchanged: true });
    }
  }
  // the added live waits: a live PR ready to merge or blocked, and a deliverable in review
  for (const [address, ids] of prThreads) {
    if (!live.has(address)) continue;
    for (const p of x.prs) {
      if (!ids.has(p.thread_id) || !p.url || p.state !== "open" || prWorked(p.thread_id)) continue;
      const who = p.number ? `PR #${p.number}` : null;
      if (p.attention === "ready_to_merge") add({ kind: "merge", ref: p.url, who, label: "ready to merge", since: p.seen_at, unchanged: true });
      else if (PR_BLOCKED.has(p.attention ?? "")) add({ kind: "pr-blocked", ref: p.url, who, label: (p.attention ?? "").replace(/_/g, " "), since: p.seen_at, unchanged: true });
    }
  }
  for (const d of x.deliverables) if (d.state === "review") add({ kind: "deliverable", ref: d.id, label: d.title, since: d.updated_at });

  // the lead's word, matched to a live fact by kind and ref: CI is its own dependency, so a lead's "the PR" (a review,
  // a merge) never hides a live CI line, and a lead's "CI" matches only CI
  const key = (w: { kind: string; ref: string | null }): string[] => {
    if (!w.ref) return [];
    if (["card", "held", "deferred", "deliverable"].includes(w.kind) || w.kind === "owner") return [`owner|${w.ref}`];
    if (["pr", "review", "merge", "pr-blocked", "pr-bound"].includes(w.kind)) return [`pr|${w.ref}`];
    return [`${w.kind}|${w.ref}`];
  };
  const lead: SummaryWait[] = [];
  const matched = new Set<SummaryWait>();
  const agentAt = new Map(x.agents.map((a) => [a.address, a]));
  // a wait a live fact shows is over is not drawn at all (2026-11-16, the owner: no struck lines); the row says once
  // that the status is out of date, and the tick asks the lead to republish (Engine.statusOutOfDateNudges)
  let over = false;
  for (const w of x.status?.waits ?? []) {
    let note: string | null = null;
    const pr = w.ref ? (prByUrl.get(w.ref) ?? x.refPrs?.get(w.ref)) : undefined;
    const k = new Set(key(w));
    const same = liveWaits.filter((l) => !matched.has(l) && key(l).some((y) => k.has(y)));
    let ended = (w.kind === "pr" || w.kind === "ci") && !!pr && (pr.state === "merged" || pr.state === "closed");
    if (w.kind === "thread" && w.ref) {
      const a = agentAt.get(w.ref);
      if (a && w.ref.startsWith(`thread:${x.slug}:`)) {
        // its own thread: part of the title, a line only once that thread sits idle, failed or is gone
        if (a.retired_at !== null || a.status === "archived") ended = true;
        else if (a.status === "error") note = "the thread failed";
        else if (!(a.status === "idle" && a.idle_at !== null && x.now - a.idle_at > OWN_THREAD_IDLE_MS)) continue;
      } else if (!w.ref.startsWith(`thread:${x.slug}:`) && x.refAgents?.get(w.ref) === false) ended = true; // another project's thread, resolved
    }
    if (w.kind === "owner" && w.ref?.startsWith("d-")) {
      const c = x.cards.get(w.ref);
      // over only once answered (a merged card counts when the card it went into was), or withdrawn: nothing is asked
      if (c && (c.answeredAt !== null || c.state === "withdrawn")) ended = true;
    }
    if (ended) {
      over = true;
      for (const l of same) matched.add(l); // the live fact about the same thing is over too
      continue;
    }
    for (const l of same) matched.add(l);
    // the lead's own since: a live reading's age is "unchanged", not how long this wait has been named
    lead.push({ source: "lead", kind: w.kind, ref: w.ref, who: w.who, label: w.label, since: w.since, unchanged: false, note });
  }
  const waits = dedupeWaits([...lead, ...liveWaits.filter((l) => !matched.has(l)).sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity))]);
  const blockers = (x.status?.blockers ?? []).filter((b) => !blockerCovered(b, x.status!.updatedAt, x.answered, x.cards));
  if (blockers.length < (x.status?.blockers.length ?? 0)) over = true;

  const threads = liveAgents.filter((a) => a.role === "thread");
  const leadAgent = liveAgents.find((a) => a.role === "lead");
  const leadWorking = !!leadAgent && WORKING.has(leadAgent.status);
  const threadsWorking = threads.filter((a) => WORKING.has(a.status)).length;
  const cards = x.decisions.filter((d) => d.state === "asked" && d.level === "person" && !d.deferred && !d.heldBehind && (ours.has(d.origin) || ours.has(d.asker)));
  const oldest = [...cards].sort((a, b) => a.askedAt - b.askedAt)[0];
  const motion: ProjectSummary["motion"] = x.heldAt !== null ? "held" : !x.hasLead ? "nolead" : leadWorking || threadsWorking > 0 ? "moving" : waits.length ? "waiting" : "quiet";
  const done = x.done.filter((d) => x.now - d.at <= SUMMARY_DONE_MS).sort((a, b) => b.at - a.at)[0] ?? null;
  return {
    motion,
    threads: { working: threadsWorking, total: threads.length },
    leadWorking,
    needsYou: { count: cards.length, id: oldest?.id ?? null, title: oldest?.title ?? null, question: oldest?.question ?? null, since: oldest?.askedAt ?? null },
    waits,
    blockers,
    statusOutOfDate: over,
    done,
    last: x.last,
    leadIdleSince: leadAgent && leadAgent.status === "idle" ? leadAgent.idle_at : null,
  };
}

/** A wait's words for comparing: lower case, punctuation and spacing folded. */
const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim();

/**
 * Each wait once (2026-11-16: one PR's "an answer waits until it is merged" showed twice): the first of those with the
 * same kind and ref, then the first of those saying the same words (kind, who and label, folded). The lead's own come
 * first, so its word is the one kept.
 */
export function dedupeWaits(waits: SummaryWait[]): SummaryWait[] {
  const seen = new Set<string>();
  return waits.filter((w) => {
    const keys = [w.ref ? `ref|${w.kind}|${w.ref}` : null, w.label ? `text|${w.kind}|${norm(w.who)}|${norm(w.label)}` : null].filter((k): k is string => !!k);
    if (keys.some((k) => seen.has(k))) return false;
    for (const k of keys) seen.add(k);
    return true;
  });
}

/**
 * Whether an answer covers a lead's blocker (2026-11-16, kept conservative): the blocker names a card that has been
 * answered, or a card from the project answered after the status was published shares at least MOOT_MIN_SHARED content
 * words with it (moot.ts, the rule the auto-moot check uses). "Staging cloud login expired" is covered by an answer to "Dev
 * GCP sign-in again (rig login expired)"; a card about something else, answered later, covers nothing.
 */
export function blockerCovered(blocker: string, statusAt: number, answered: SummaryInput["answered"], cards: SummaryInput["cards"]): boolean {
  for (const id of blocker.match(/\bd-[0-9A-Za-z-]+/g) ?? []) {
    if (cards.get(id)?.answeredAt != null) return true; // answered, not merged into an open card or withdrawn
  }
  return answered.some((a) => a.answeredAt > statusAt && sharedWords(blocker, a.text).length >= MOOT_MIN_SHARED);
}
