// The work board's data (2026-11-23, SCOPE st-070570dd piece 1): each project's tasks (core/tasks.ts) with what is
// attached to them, and each task's column, derived from the attachments by the rules and precedence contract.ts states
// above workBoardSchema. No model, no UI: a read over the plugin's own records. readBoard never writes; settleColumns
// (the engine's, after a publish and from the tick) logs each column change in task_moves.
import type { BoardAttachments, BoardColumn, BoardTask, WorkBoard } from "../contract.ts";
import { prWait, reviewOf, threadState } from "./attach-state.ts";
import type { Db } from "./db.ts";
import type { LeadStatus, StepState } from "./status.ts";
import { addressTasks, cardTaskBy, prKey, type TaskRow, type Unfiled } from "./tasks.ts";

/** How far back Shipped tasks reach when the caller gives no `since`. */
export const BOARD_SHIPPED_MS = 7 * 86_400_000;

type Thread = BoardAttachments["threads"][number];
type Pr = BoardAttachments["prs"][number];
type Deliv = BoardAttachments["deliverables"][number];
type Card = BoardAttachments["cards"][number];

const empty = (): BoardAttachments => ({ threads: [], prs: [], deliverables: [], cards: [] });
const prName = (p: Pr) => (p.number ? `PR #${p.number}` : "a PR");
const ms = (s: string | null | undefined) => (s ? Date.parse(s) || null : null);

/** What a task's column is derived from. */
export interface DeriveInput extends BoardAttachments {
  state: TaskRow["state"];
  shippedAt: number | null;
  step: StepState | null;
  /** The step's own blocker (it wins for its task), and the project's blockers (they land on the current step). */
  stepBlocker?: string | null;
  blockers: string[];
  statusAt: number | null;
}

/** A task's column without a hand move, when it entered it (where known), and why. Precedence: contract.ts. */
export function deriveColumn(x: DeriveInput): { column: BoardColumn; since: number | null; why: string } {
  if (x.state === "shipped") return { column: "shipped", since: x.shippedAt, why: "the lead marked it done" };
  // a PR closed unmerged was superseded and counts for nothing; any other PR not merged (open, draft, or a state not
  // known or never read) keeps the task from shipping by itself (the lead's call on the Codex review of b1d9fcb)
  const prs = x.prs.filter((p) => p.state !== "closed");
  const dl = x.deliverables.filter((d) => d.state !== "withdrawn");
  // a merged PR with a live thread on the task is not shipped yet: the thread is still at it until it is resolved
  // (the lead's call); the lead's done ships it whatever is live
  if (prs.length + dl.length > 0 && prs.every((p) => p.state === "merged") && dl.every((d) => d.state === "approved") && !x.threads.some((t) => t.live)) {
    const last = Math.max(...prs.map((p) => p.at), ...dl.map((d) => d.approvedAt ?? d.at));
    const what = [prs.length ? (prs.length === 1 ? `${prName(prs[0]!)} merged` : `${prs.length} PRs merged`) : null, dl.length ? (dl.length === 1 ? "deliverable approved" : `${dl.length} deliverables approved`) : null];
    return { column: "shipped", since: last, why: what.filter(Boolean).join(", ") };
  }
  const waits: { since: number | null; why: string }[] = [
    ...x.cards.filter((c) => c.ownerWaits).map((c) => ({ since: c.askedAt, why: `card ${c.id} waits on the owner` })),
    ...dl.filter((d) => d.state === "review").map((d) => ({ since: d.at, why: `deliverable ${d.id} in review` })),
    ...prs.filter((p) => p.wait === "merge").map((p) => ({ since: p.at, why: `${prName(p)} ready to merge` })),
  ];
  if (waits.length) return { column: "waiting", ...oldest(waits) };
  const failed = x.threads.find((t) => t.live && t.state === "blocked");
  if (x.stepBlocker) return { column: "blocked", since: x.statusAt, why: x.stepBlocker };
  if (x.step === "current" && x.blockers.length) return { column: "blocked", since: x.statusAt, why: x.blockers[0]! };
  if (failed) return { column: "blocked", since: null, why: `${failed.address} failed` };
  const review = prs.filter((p) => p.state === "open" && p.wait !== "blocked");
  if (review.length) {
    const p = review[0]!;
    return { column: "in_review", since: Math.min(...review.map((r) => r.at)), why: `${prName(p)} ${p.wait === "ci" ? "waits on CI" : p.wait === "review" ? "waits on a review" : "is open"}` };
  }
  const working = x.threads.find((t) => t.live && t.state !== "released" && t.state !== "blocked");
  if (working) return { column: "in_progress", since: null, why: `${working.address} ${working.state === "working" ? "working" : "attached"}` };
  if (x.step === "current") return { column: "in_progress", since: x.statusAt, why: "the lead's current step" };
  const fix = prs.find((p) => p.state === "draft" || p.wait === "blocked");
  if (fix) return { column: "in_progress", since: fix.at, why: `${prName(fix)} ${fix.state === "draft" ? "draft" : (fix.attention ?? "").replace(/_/g, " ")}` };
  return { column: "planned", since: null, why: x.step ? "planned" : "no longer in the lead's list" };
}

const oldest = (w: { since: number | null; why: string }[]) => [...w].sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity))[0]!;

/** The attachments' signature: changes whenever anything attached changes state (a hand move holds until it does). */
export function attachmentSig(a: BoardAttachments): string {
  const parts = [
    ...a.threads.map((t) => `t|${t.address}|${t.state}|${t.live}`),
    ...a.prs.map((p) => `p|${p.url}|${p.state}|${p.checks}|${p.review}|${p.attention}`),
    ...a.deliverables.map((d) => `d|${d.id}|${d.state}|${d.rev}`),
    ...a.cards.map((c) => `c|${c.id}|${c.state}|${c.level}`),
  ].sort();
  return hash53(parts.join("\n"));
}

/** A 53-bit string hash as 14 hex digits (cyrb53): pure, so this module stays out of node: imports (core/tasks.ts). */
function hash53(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

interface Gathered {
  projects: string[];
  status: Map<string, LeadStatus>;
  tasks: TaskRow[];
  /** Each task's attachments, and each project's Unfiled ones (live only). */
  attached: Map<string, BoardAttachments>;
  unfiled: Map<string, BoardAttachments>;
}

/**
 * Everything the board draws, for `only` (a project) or every project that isn't archived, and the tasks `pick` keeps.
 * Attachments: a thread address by its latest holder's spawn row; a PR by its task_prs links (its state per URL: the
 * newest of bb's reading, a PR wait's gh reading and the event log); a card by its own task, else its origin's, else
 * its asker's; a deliverable by its own task.
 */
function gather(db: Db, only: string | null, pick: (t: TaskRow) => boolean): Gathered {
  const projects = (db.prepare(`SELECT slug FROM projects WHERE archived_at IS NULL ORDER BY slug`).all() as { slug: string }[]).map((r) => r.slug).filter((s) => !only || s === only);
  const inScope = new Set(projects);
  const status = new Map<string, LeadStatus>();
  for (const r of db.prepare(`SELECT project, json FROM lead_status`).all() as { project: string; json: string }[]) {
    if (!inScope.has(r.project)) continue;
    try {
      status.set(r.project, JSON.parse(r.json) as LeadStatus);
    } catch {
      /* a broken row draws no steps */
    }
  }
  const tasks = (db.prepare(`SELECT * FROM tasks ORDER BY created_at, rowid`).all() as TaskRow[]).filter((t) => inScope.has(t.project) && pick(t));
  const taskIds = new Set(tasks.map((t) => t.id));

  // threads: each address once, as its latest holder; its task by the one address rule (addressTasks, below)
  const rows = db
    .prepare(`SELECT a.thread_id, a.address, a.project, a.status, a.retired_at, a.created_at FROM agents a WHERE a.role = 'thread' ORDER BY a.created_at, a.rowid`)
    .all() as { thread_id: string; address: string; project: string | null; status: string; retired_at: number | null; created_at: number }[];
  const addr = new Map<string, { thread: Thread; project: string | null }>();
  const addressOf = new Map<string, string>();
  for (const r of rows) {
    addressOf.set(r.thread_id, r.address);
    const state = threadState(r.status);
    const live = r.retired_at === null && state !== "released";
    addr.set(r.address, { thread: { address: r.address, threadId: r.thread_id, state, live }, project: r.project });
  }
  const liveHolders = new Set((db.prepare(`SELECT address FROM agents WHERE retired_at IS NULL AND status NOT IN ('stopped', 'archived')`).all() as { address: string }[]).map((r) => r.address));
  const tasksOf = addressTasks(db); // the one address rule the links use too (core/tasks.ts)
  const taskOfAddress = (a: string | null) => (a ? (tasksOf.get(a) ?? null) : null);

  // PR state, per URL: the newest of bb's readings (prs), a PR wait's gh reading (pr_readings) and the PR log (events).
  // `thread` here is who bb or the log last saw hold it, for Unfiled only: a task's PRs are its task_prs links.
  const prs = new Map<string, Pr>();
  const take = (p: Pr) => {
    const cur = prs.get(p.url);
    if (!cur) return void prs.set(p.url, p);
    const newer = p.at >= cur.at ? p : cur;
    const older = newer === p ? cur : p;
    prs.set(p.url, { ...newer, number: newer.number ?? older.number, thread: cur.thread ?? p.thread, checks: newer.checks ?? older.checks, review: newer.review ?? older.review, attention: newer.attention ?? older.attention });
  };
  const projectOf = (address: string | null) => (address?.startsWith("thread:") || address?.startsWith("lead:") ? address.split(":")[1]! : null);
  for (const r of db.prepare(`SELECT p.url, p.number, p.state, p.checks, p.attention, p.sig, p.seen_at, p.thread_id FROM prs p`).all() as {
    url: string;
    number: number | null;
    state: string | null;
    checks: string | null;
    attention: string | null;
    sig: string;
    seen_at: number;
    thread_id: string;
  }[])
    take({ url: prKey(r.url), number: r.number, state: r.state, checks: r.checks, review: reviewOf(r.sig), attention: r.attention, wait: null, at: r.seen_at, thread: addressOf.get(r.thread_id) ?? null, source: "orchestrator" });
  for (const r of db.prepare(`SELECT url, number, state, checks, attention, sig, seen_at FROM pr_readings`).all() as {
    url: string;
    number: number | null;
    state: string | null;
    checks: string | null;
    attention: string | null;
    sig: string;
    seen_at: number;
  }[])
    take({ url: prKey(r.url), number: r.number, state: r.state, checks: r.checks, review: reviewOf(r.sig), attention: r.attention, wait: null, at: r.seen_at, thread: null, source: "orchestrator" });
  // the log's last state per URL (SQLite takes the bare columns from the MAX(at) row)
  for (const r of db.prepare(`SELECT ref AS url, value AS state, note, address, MAX(at) AS at FROM events WHERE kind = 'pr' AND ref IS NOT NULL GROUP BY ref`).all() as {
    url: string;
    state: string | null;
    note: string | null;
    address: string | null;
    at: number;
  }[]) {
    const url = prKey(r.url);
    const cur = prs.get(url);
    // the log has states only; a newer bb or gh reading (checks, review) of the same state wins
    if (cur && (cur.at >= r.at || cur.state === r.state)) continue;
    take({ url, number: r.note ? Number(r.note) || null : null, state: r.state, checks: null, review: null, attention: null, wait: null, at: r.at, thread: r.address, source: "orchestrator" });
  }
  // the PR links (durable, one per PR and task; the tasks migration's seed settles the board before task_prs exists)
  const links = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_prs'`).get()
    ? (db.prepare(`SELECT url, task, project, by, first_at FROM task_prs ORDER BY first_at, rowid`).all() as { url: string; task: string; project: string; by: string | null; first_at: number }[])
    : [];

  const attached = new Map<string, BoardAttachments>(tasks.map((t) => [t.id, empty()]));
  const unfiled = new Map<string, BoardAttachments>(projects.map((p) => [p, empty()]));
  const taskState = new Map((db.prepare(`SELECT id, state FROM tasks`).all() as { id: string; state: string }[]).map((r) => [r.id, r.state]));
  // on a task the board shows; else, with no task (or one that doesn't exist), the project's Unfiled; a task the board
  // doesn't show this time (shipped before `since`) keeps its things off the board
  const put = (task: string | null, project: string | null, add: (a: BoardAttachments) => void) => {
    if (task && taskIds.has(task)) add(attached.get(task)!);
    else if ((!task || !taskState.has(task)) && project && unfiled.has(project)) add(unfiled.get(project)!);
  };
  const filed = (task: string | null) => !!task && taskState.has(task);
  for (const { thread, project } of addr.values()) {
    const task = taskOfAddress(thread.address);
    if (thread.live || filed(task)) put(task, project, (a) => a.threads.push(thread));
  }
  // each link puts its PR on its task, with the URL's one state; none read yet is state null (unknown), which keeps the
  // task off Shipped. Its thread is the address it came through.
  const held = new Set<string>();
  for (const l of links) {
    if (taskState.has(l.task) && taskState.get(l.task) !== "dropped") held.add(l.url);
    const s = prs.get(l.url);
    const pr: Pr = s ? { ...s, thread: l.by } : { url: l.url, number: Number(l.url.split("/").pop()) || null, state: null, checks: null, review: null, attention: null, wait: null, at: l.first_at, thread: l.by, source: "orchestrator" };
    pr.wait = prWait(pr);
    put(l.task, l.project, (a) => a.prs.push(pr));
  }
  // Unfiled holds only what is live: an open or draft PR that no task (still open or shipped) holds, read by a live
  // holder that is on no task (a retired thread's last reading of "open" is stale: nothing reads that PR any more)
  for (const p of prs.values()) {
    if (held.has(p.url) || (p.state !== "open" && p.state !== "draft") || !p.thread || !liveHolders.has(p.thread)) continue;
    const t = taskOfAddress(p.thread);
    if (filed(t) && taskState.get(t!) !== "dropped") continue; // its holder's task links it on bb's next reading
    put(null, projectOf(p.thread), (a) => a.prs.push({ ...p, wait: prWait(p) }));
  }
  for (const r of db.prepare(`SELECT id, project, title, state, rev, updated_at, json FROM deliverables WHERE json_extract(json, '$.task') IS NOT NULL OR state IN ('review', 'changes')`).all() as {
    id: string;
    project: string | null;
    title: string;
    state: string;
    rev: number;
    updated_at: number;
    json: string;
  }[]) {
    const j = JSON.parse(r.json) as { task?: string; feedback?: { outcome: string; at: string }[] };
    const approved = (j.feedback ?? []).filter((f) => f.outcome === "approved").at(-1);
    const d: Deliv = { id: r.id, title: r.title, state: r.state, rev: r.rev, at: r.updated_at, approvedAt: r.state === "approved" ? ms(approved?.at) : null };
    if (!filed(j.task ?? null) && r.state !== "review" && r.state !== "changes") continue;
    put(j.task ?? null, r.project, (a) => a.deliverables.push(d));
  }
  for (const r of db.prepare(`SELECT id, state, at_level, project, json FROM decisions WHERE state IN ('open', 'asked')`).all() as { id: string; state: string; at_level: string; project: string | null; json: string }[]) {
    const j = JSON.parse(r.json) as { request: { title: string }; ask: { title: string; at: string } | null; deferred: unknown; orchestrator: { asker: string; origin: string; task?: string; held?: unknown } };
    const task = cardTaskBy(j.orchestrator, taskOfAddress);
    const c: Card = {
      id: r.id,
      title: j.ask?.title ?? j.request.title,
      level: r.at_level,
      state: r.state,
      askedAt: ms(j.ask?.at),
      ownerWaits: r.state === "asked" && r.at_level === "person",
      deferred: !!j.deferred,
      held: !!j.orchestrator.held,
    };
    put(task, r.project, (a) => a.cards.push(c));
  }
  return { projects, status, tasks, attached, unfiled };
}

/** One task as the board draws it: its place in the lead's list, attachments, column (hand move first), signature. */
function boardTask(t: TaskRow, st: LeadStatus | undefined, a: BoardAttachments): BoardTask {
  const i = st?.steps.findIndex((s) => s.id === t.id) ?? -1;
  const step = i >= 0 ? { n: i + 1, state: st!.steps[i]!.state } : null;
  const d = deriveColumn({ ...a, state: t.state, shippedAt: t.shipped_at, step: step?.state ?? null, stepBlocker: i >= 0 ? (st!.steps[i]!.blocker ?? null) : null, blockers: st?.blockers ?? [], statusAt: st?.updatedAt ?? null });
  const sig = attachmentSig(a);
  // hand_sig is null once a settle saw the attachments change: a released hold never comes back (settleColumns)
  const hand = t.hand_col && t.hand_at !== null ? { column: t.hand_col as BoardColumn, at: t.hand_at, holds: t.hand_sig !== null && t.hand_sig === sig } : null;
  const held = hand?.holds ? hand : null;
  return {
    id: t.id,
    project: t.project,
    title: t.title,
    state: t.state,
    step,
    column: held ? held.column : d.column,
    derived: d.column,
    since: held ? held.at : d.since,
    why: held ? "moved by the owner" : d.why,
    hand,
    sig,
    ...a,
  };
}

/** The board: every project's tasks (open, recently shipped), its Unfiled list and its dropped tasks to confirm. Read-only. */
export function readBoard(db: Db, now: number, opts: { since?: number | null; project?: string | null } = {}): WorkBoard {
  const since = opts.since ?? now - BOARD_SHIPPED_MS;
  const inList = new Set<string>();
  for (const r of db.prepare(`SELECT json FROM lead_status`).all() as { json: string }[]) {
    try {
      for (const s of (JSON.parse(r.json) as LeadStatus).steps ?? []) if (s.id) inList.add(s.id);
    } catch {
      /* skip */
    }
  }
  const g = gather(db, opts.project ?? null, (t) => t.state === "open" || (t.state === "shipped" && (t.shipped_at === null ? inList.has(t.id) : t.shipped_at >= since)) || (t.state === "dropped" && t.unfiled !== null));
  const projects = g.projects.map((slug) => {
    const mine = g.tasks.filter((t) => t.project === slug);
    const order = (t: BoardTask) => (t.step ? t.step.n : 100);
    return {
      slug,
      // Shipped by its attachments (or by hand) is kept to the window too, by when it shipped
      tasks: mine
        .filter((t) => t.state !== "dropped")
        .map((t) => boardTask(t, g.status.get(slug), g.attached.get(t.id)!))
        .filter((t) => t.column !== "shipped" || t.state === "shipped" || t.since === null || t.since >= since)
        .sort((a, b) => order(a) - order(b)),
      unfiled: g.unfiled.get(slug)!,
      dropped: mine
        .filter((t) => t.state === "dropped")
        .map((t) => ({ id: t.id, title: t.title, droppedAt: t.dropped_at, unfiled: JSON.parse(t.unfiled!) as Unfiled })),
    };
  });
  return { now, since, projects };
}

/**
 * Log each task whose column changed since the last settle (task_moves: from, to, when, by, why) and keep the new one
 * (tasks.col). A dropped task's column is "dropped"; a new task's first row has no from. `log: false` (the upgrade)
 * sets the columns without a row, so the first settle after it counts nothing that didn't move. `project`: only its
 * tasks (a lead's publish settles its own project, so another project's move is never put down to that lead).
 */
export function settleColumns(db: Db, now: number, opts: { log: boolean; by?: string; project?: string }): number {
  const g = gather(db, opts.project ?? null, (t) => t.state !== "dropped" || t.col !== "dropped");
  let moved = 0;
  for (const t of g.tasks) {
    const b = t.state === "dropped" ? null : boardTask(t, g.status.get(t.project), g.attached.get(t.id)!);
    // the first change of the attachments releases a hand move for good, even if they later read as they did
    if (b?.hand && !b.hand.holds && t.hand_sig !== null) db.prepare(`UPDATE tasks SET hand_sig = NULL WHERE id = ?`).run(t.id);
    const to = b ? b.column : "dropped";
    if (t.col === to) continue;
    if (opts.log) {
      db.prepare(`INSERT INTO task_moves (task, project, from_col, to_col, at, by, why) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        t.id,
        t.project,
        t.col,
        to,
        now,
        opts.by ?? "engine",
        b ? b.why : t.unfiled ? "dropped with attachments" : "dropped",
      );
      moved++;
    }
    db.prepare(`UPDATE tasks SET col = ?, col_at = ? WHERE id = ?`).run(to, now, t.id);
  }
  return moved;
}
