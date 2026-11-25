// The CoS's board tidy (2026-11-23, the work board scope): the CoS keeps the work board's tasks honest with one
// tool, orch_board_tidy. It reads the board (list), folds a duplicate task into another (merge: the attachments move
// and the merged id redirects, core/tasks.ts followMerge), brings a dropped task back with what its drop moved to
// Unfiled (restore), attaches an Unfiled thread, PR, deliverable or card to a task (file), and accepts a drop so it
// leaves the CoS's list (confirm). Each action writes one task_moves row by "cos" whose why starts "cos: <action>";
// a row whose from_col equals to_col is a record of the tidy, not a move. The engine (Engine.boardTidy) checks the
// caller is the CoS, runs it in one transaction, settles the project's knock-on column changes (by "cos") and gives
// the lead an INFO notice.
//
// staleTasks: a task whose attached PRs are all merged and deliverables all approved, held off Shipped only by live
// threads that have all been idle for over a day (the owner, 2026-11-23): the engine flags it to its
// lead at most once a day. No model, no UI.
import type { BoardColumn, BoardTask, WorkBoard } from "../contract.ts";
import type { Db } from "./db.ts";
import { PR_URL_RE } from "./open-prs.ts";
import { addressTask, followMerge, linkPr, linkRetained, prKey, refile, type TaskRow, taskRow, TaskError, type Unfiled } from "./tasks.ts";
import { deriveColumn, readBoard } from "./work-board.ts";

export const TIDY_ACTIONS = ["list", "merge", "restore", "file", "confirm"] as const;
export type TidyAction = (typeof TIDY_ACTIONS)[number];
export const FILE_KINDS = ["thread", "pr", "deliverable", "card"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** What a tidy did: the reply for the CoS, and the notice for the project's lead (null: nothing to tell). */
export interface TidyResult {
  text: string;
  project: string | null;
  notice: string | null;
}

/** A live thread must have been idle this long before its otherwise finished task is flagged. */
export const STALE_IDLE_MS = 24 * 3_600_000;
/** A task is flagged to its lead at most this often. */
export const STALE_FLAG_EVERY_MS = 24 * 3_600_000;

const q = (s: string) => JSON.stringify(s);
const named = (t: Pick<TaskRow, "id" | "title">) => `${t.id} ${q(t.title)}`;

/** A refusal for unfinished work; `readFirst`: PRs not read merged or closed yet, which the engine queues for the next PR pass (pr_read_requests). */
export class TidyRefusal extends TaskError {
  readonly readFirst: string[];
  constructor(readFirst: string[], message: string) {
    super(message);
    this.readFirst = readFirst;
  }
}

/** A task by id, or a refusal naming it. */
function mustTask(db: Db, id: string, what: string): TaskRow {
  const t = taskRow(db, id.trim());
  if (!t) throw new TaskError(`${what} ${q(id)} is no task: use an id from orch_board_tidy(action=list)`);
  return t;
}

/** Where a task sits on the board now: dropped, or the column the board draws (hand move included). */
function columnNow(db: Db, now: number, t: TaskRow): string {
  const cur = taskRow(db, t.id)!;
  if (cur.state === "dropped") return "dropped";
  const b = readBoard(db, now, { project: cur.project, since: 0 }).projects[0]?.tasks.find((x) => x.id === cur.id);
  return b?.column ?? cur.col ?? (cur.state === "shipped" ? "shipped" : "planned");
}

/** The tidy's own task_moves row (by cos), and the task's logged column, so the next settle doesn't log it again. */
function logTidy(db: Db, now: number, t: TaskRow, to: string, why: string): void {
  db.prepare(`INSERT INTO task_moves (task, project, from_col, to_col, at, by, why) VALUES (?, ?, ?, ?, ?, 'cos', ?)`).run(t.id, t.project, t.col, to, now, `cos: ${why}`);
  db.prepare(`UPDATE tasks SET col = ?, col_at = ? WHERE id = ?`).run(to, now, t.id);
}

/** A target for merge and file: an open or shipped task (a merged one stands for its merge target). */
function target(db: Db, id: string): TaskRow {
  const t = followMerge(db, mustTask(db, id, "task"));
  if (t.state === "dropped") throw new TaskError(`task ${named(t)} was dropped: restore it first (action=restore), or pick an open task`);
  return t;
}

/** merge: fold `from` into `into`. Everything that names `from`, in any state, names `into`; `from` is dropped with merged_into set. */
export function mergeTask(db: Db, now: number, fromId: string, intoId: string): TidyResult {
  const from = mustTask(db, fromId, "task");
  const into = target(db, intoId);
  if (from.merged_into) throw new TaskError(`task ${named(from)} was already merged into ${from.merged_into}`);
  if (from.id === into.id) throw new TaskError(`a task can't be merged into itself`);
  if (from.project !== into.project) throw new TaskError(`${from.id} is a task of ${from.project} and ${into.id} of ${into.project}: only tasks of one project merge`);
  if (from.state === "shipped") throw new TaskError(`task ${named(from)} has shipped: there is nothing left to merge`);
  // a dropped task's Unfiled things come back to it first, so they move with it
  if (from.state === "dropped" && from.unfiled) refile(db, from);
  // what `from` brings, before it moves: a shipped target is the lead's done, which no attachment overrides
  const incoming = into.state === "shipped" ? { threads: taskThreads(db, from.id), prs: linkedUrls(db, from.id), deliverables: taskDeliverables(db, from.id), cards: openCards(db, from.id) } : null;
  // every state: an approved plan card still naming the old id would put its next thread on a dropped task
  const threads = Number((db.prepare(`UPDATE spawns SET task = ? WHERE task = ?`).run(into.id, from.id) as { changes: number | bigint }).changes);
  const deliverables = Number((db.prepare(`UPDATE deliverables SET json = json_set(json, '$.task', ?) WHERE json_extract(json, '$.task') = ?`).run(into.id, from.id) as { changes: number | bigint }).changes);
  const cards = Number((db.prepare(`UPDATE decisions SET json = json_set(json, '$.orchestrator.task', ?) WHERE json_extract(json, '$.orchestrator.task') = ?`).run(into.id, from.id) as { changes: number | bigint }).changes);
  moveLinks(db, from.id, into.id);
  if (incoming) {
    const { left, unread } = unfinished(db, now, into, incoming, "merge");
    // thrown inside the tidy's transaction, which rolls back: the refusal writes nothing
    if (left.length) throw new TidyRefusal(unread, `task ${named(into)} has shipped (its lead marked it done), and ${named(from)} still has unfinished work: ${left.join(", ")}. Merging would hide it under a done task: merge into an open task, or wait until that work is done`);
  }
  db.prepare(`UPDATE tasks SET merged_into = ? WHERE merged_into = ?`).run(into.id, from.id);
  db.prepare(`UPDATE tasks SET state = 'dropped', dropped_at = ?, shipped_at = NULL, unfiled = NULL, merged_into = ?, hand_col = NULL, hand_at = NULL, hand_sig = NULL WHERE id = ?`).run(now, into.id, from.id);
  logTidy(db, now, from, "dropped", `merge into ${into.id}`);
  logTidy(db, now, into, columnNow(db, now, into), `merge ${from.id} ${q(from.title)} in`);
  const moved = `${threads} thread${threads === 1 ? "" : "s"}, ${deliverables} deliverable${deliverables === 1 ? "" : "s"}, ${cards} card${cards === 1 ? "" : "s"}`;
  return {
    text: `Merged ${named(from)} into ${named(into)} (${into.project}); moved ${moved}. ${from.id} now stands for ${into.id}.`,
    project: into.project,
    notice: `The CoS merged task ${named(from)} into ${named(into)}: its threads, deliverables and cards are on ${into.id} now (${moved}). Send ${into.id} in your steps from now on; ${from.id} redirects to it, and a step list naming both is refused.`,
  };
}

/** restore: a dropped task opens again, with what its drop moved to Unfiled and is still there. */
export function restoreTask(db: Db, now: number, id: string): TidyResult {
  const t = mustTask(db, id, "task");
  if (t.merged_into) throw new TaskError(`task ${named(t)} was merged into ${t.merged_into}: that task is where its things are`);
  if (t.state !== "dropped") throw new TaskError(`task ${named(t)} is ${t.state === "open" ? "open" : "shipped"}, not dropped`);
  if (t.unfiled) refile(db, t);
  db.prepare(`UPDATE tasks SET state = 'open', dropped_at = NULL, shipped_at = NULL, unfiled = NULL WHERE id = ?`).run(t.id);
  logTidy(db, now, t, columnNow(db, now, t), "restore");
  const u = parseUnfiled(t.unfiled);
  const back = u ? `${u.threads.length + u.deliverables.length + u.cards.length} attachment(s) came back with it` : "it had nothing attached";
  return {
    text: `Restored ${named(t)} (${t.project}); ${back}. Its lead is told to put it back in its steps.`,
    project: t.project,
    notice: `The CoS restored task ${named(t)}, which left your steps before it was done; ${back}. Put it back in your next orch_status with id ${t.id}, or it drops again.`,
  };
}

/** confirm: the CoS accepts a drop with attachments; the task leaves its list (dropped[]) and its things stay Unfiled. */
export function confirmDrop(db: Db, now: number, id: string): TidyResult {
  const t = mustTask(db, id, "task");
  if (t.state !== "dropped" || !t.unfiled) throw new TaskError(`task ${named(t)} is not a drop waiting to be confirmed`);
  db.prepare(`UPDATE tasks SET unfiled = NULL WHERE id = ?`).run(t.id);
  logTidy(db, now, t, "dropped", "confirm drop");
  return { text: `Confirmed the drop of ${named(t)} (${t.project}); what it had stays in Unfiled until filed.`, project: t.project, notice: null };
}

/** The thread addresses on a task now (its spawn rows' holders). */
function taskThreads(db: Db, task: string): string[] {
  return (db.prepare(`SELECT DISTINCT a.address FROM spawns s JOIN agents a ON a.thread_id = s.thread_id WHERE s.task = ? AND a.role = 'thread'`).all(task) as { address: string }[]).map((r) => r.address);
}
const linkedUrls = (db: Db, task: string): string[] => (db.prepare(`SELECT url FROM task_prs WHERE task = ?`).all(task) as { url: string }[]).map((r) => r.url);
const taskDeliverables = (db: Db, task: string): string[] => (db.prepare(`SELECT id FROM deliverables WHERE json_extract(json, '$.task') = ?`).all(task) as { id: string }[]).map((r) => r.id);

/** The unresolved cards (open, or asked of the owner) on a task as the board places them: its own, or a thread's of it that names no task. */
function openCards(db: Db, task: string): string[] {
  const threads = JSON.stringify(taskThreads(db, task));
  const rows = db
    .prepare(
      `SELECT id, state, json_extract(json, '$.request.title') AS title FROM decisions WHERE state IN ('open', 'asked') AND (json_extract(json, '$.orchestrator.task') = ?
         OR (json_extract(json, '$.orchestrator.task') IS NULL AND (json_extract(json, '$.orchestrator.origin') IN (SELECT value FROM json_each(?)) OR json_extract(json, '$.orchestrator.asker') IN (SELECT value FROM json_each(?)))))
       ORDER BY id`,
    )
    .all(task, threads, threads) as CardRow[];
  return rows.map(cardLabel);
}

type CardRow = { id: string; state: string; title: string | null };
const cardLabel = (r: CardRow) => `card ${r.id}${r.title ? ` ${q(r.title)}` : ""} (${r.state === "asked" ? "waiting on the owner" : "open"})`;

/** A thread's own unresolved cards: those it asked that name no task, so they follow it (the board's card rule). */
const threadCards = (db: Db, address: string): string[] =>
  (
    db
      .prepare(`SELECT id, state, json_extract(json, '$.request.title') AS title FROM decisions WHERE state IN ('open', 'asked') AND json_extract(json, '$.orchestrator.task') IS NULL AND (json_extract(json, '$.orchestrator.origin') = ? OR json_extract(json, '$.orchestrator.asker') = ?) ORDER BY id`)
      .all(address, address) as CardRow[]
  ).map(cardLabel);

/** What of `incoming`, now on `into`, is unfinished as the board reads it: a live thread, a PR open or not known, a deliverable not approved. */
type Incoming = { threads: string[]; prs: string[]; deliverables: string[]; cards: string[] };
function unfinished(db: Db, now: number, into: TaskRow, incoming: Incoming, again: string): { left: string[]; unread: string[] } {
  const b = readBoard(db, now, { project: into.project, since: 0 }).projects[0]?.tasks.find((x) => x.id === into.id);
  const out: string[] = [];
  const unread: string[] = [];
  for (const a of incoming.threads) if (!b || b.threads.some((t) => t.address === a && t.live)) out.push(`live thread ${a}`);
  for (const u of incoming.prs) {
    const p = b?.prs.find((x) => x.url === u);
    // never read: the next PR pass reads it (queued by the engine), never a GitHub call here
    // not merged or closed by its newest state (none, or a reading nobody polls any more, such as a resolved thread's
    // last "open"): the next PR pass reads it again (queued by the engine), never a GitHub call here
    if (!p || (p.state !== "merged" && p.state !== "closed")) {
      unread.push(u);
      out.push(`PR ${u} (${p?.state ? `${p.state} when last read: queued to be read again by the next PR pass; ${again} again after it` : `not read yet: queued for the next PR pass; ${again} again after it`})`);
    }
  }
  for (const id of incoming.deliverables) {
    const d = b?.deliverables.find((x) => x.id === id);
    if (!d || (d.state !== "approved" && d.state !== "withdrawn")) out.push(`deliverable ${id} (${d?.state ?? "not approved"})`);
  }
  // a card not yet resolved is work left, whatever it asks (a question waiting on the owner most of all)
  out.push(...incoming.cards);
  return { left: out, unread };
}

type Owner = { url: string; by: string; via: string };

/**
 * After a card or deliverable left `from`, the owner rows it gave its PR links there go (task_pr_owners), the shared
 * retained-evidence pass (the one restore and the upgrade use) gives back those that what is still on `from` carries
 * (another card or deliverable naming the same PR), and a link goes only when its last owner has.
 */
function dropOwners(db: Db, from: string, owners: Owner[]): void {
  if (!owners.length) return;
  const del = db.prepare(`DELETE FROM task_pr_owners WHERE task = ? AND url = ? AND by = ? AND via = ?`);
  for (const o of owners) del.run(from, o.url, o.by, o.via);
  linkRetained(db, { task: from, addresses: taskThreads(db, from) });
  unlinkOwnerless(db, from, owners.map((o) => o.url));
}

/** A link on `task` to each of `urls` goes once nothing owns it there. */
function unlinkOwnerless(db: Db, task: string, urls: string[]): void {
  const del = db.prepare(`DELETE FROM task_prs WHERE task = ? AND url = ? AND NOT EXISTS (SELECT 1 FROM task_pr_owners o WHERE o.task = ? AND o.url = ?)`);
  for (const u of new Set(urls)) del.run(task, u, task, u);
}

/** Link what a filed thread, card or deliverable carries onto its task `to` (the same pass, scoped to `to`). */
const linkCarried = (db: Db, to: string, address: string | null) => linkRetained(db, { task: to, addresses: [...new Set([...taskThreads(db, to), ...(address ? [address] : [])])] });

/** The PR URLs a deliverable's blocks and proof carry, every revision (linkDeliverablePrs's sources). */
function deliverableUrls(json: string): string[] {
  const urls: string[] = [];
  const pr = (b: unknown) => (b && typeof b === "object" && (b as { kind?: unknown }).kind === "pr" && typeof (b as { url?: unknown }).url === "string" ? [prKey((b as { url: string }).url)] : []);
  try {
    const d = JSON.parse(json) as { revisions?: { blocks?: unknown[]; proof?: unknown[] }[] };
    for (const r of d.revisions ?? []) for (const b of [...(r.blocks ?? []), ...(r.proof ?? [])]) urls.push(...pr(b));
  } catch {
    /* unreadable: carries none */
  }
  return urls;
}

/** The PR URLs a card's blocks carry (linkCardPrs's sources). */
function cardUrls(json: string): string[] {
  try {
    const blocks = (JSON.parse(json) as { request?: { blocks?: unknown } }).request?.blocks;
    return Array.isArray(blocks) ? blocks.flatMap((b) => (b && typeof b === "object" && (b as { kind?: unknown }).kind === "pr" && typeof (b as { url?: unknown }).url === "string" ? [prKey((b as { url: string }).url)] : [])) : [];
  } catch {
    return [];
  }
}

/** The bb thread id a thread address (or thread id) is held by now: its latest row. */
function latestThread(db: Db, ref: string): { thread_id: string; address: string; project: string | null } | null {
  const r = db.prepare(`SELECT thread_id, address, project FROM agents WHERE role = 'thread' AND (thread_id = ? OR address = ?) ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(ref, ref) as
    | { thread_id: string; address: string; project: string | null }
    | undefined;
  if (!r) return null;
  return (db.prepare(`SELECT thread_id, address, project FROM agents WHERE role = 'thread' AND address = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(r.address) as typeof r | undefined) ?? r;
}

/**
 * Move PR links from one task to another with their owners (task_pr_owners). `by` undefined (a merge): every link
 * and owner moves and `from` keeps none. `by` an address (a thread that moves): only that address's owner rows move,
 * each bringing its link to `to`, and a link on `from` goes only when its last owner has; another thread, card or the
 * CoS that still owns it there keeps it. A link already on `to` stays as it was, and gains the owners.
 */
function moveLinks(db: Db, from: string, to: string, by?: string): void {
  const only = by === undefined ? "" : " AND o.by = ?";
  const args = by === undefined ? [from] : [from, by];
  const urls = (db.prepare(`SELECT DISTINCT o.url FROM task_pr_owners o WHERE o.task = ?${only}`).all(...args) as { url: string }[]).map((r) => r.url);
  db.prepare(`INSERT OR IGNORE INTO task_prs (url, task, project, via, by, first_at) SELECT o.url, t.id, t.project, o.via, nullif(o.by, ''), o.first_at FROM task_pr_owners o JOIN tasks t ON t.id = ? WHERE o.task = ?${only} ORDER BY o.first_at`).run(to, ...args);
  db.prepare(`INSERT OR IGNORE INTO task_pr_owners (url, task, by, via, first_at) SELECT o.url, ?, o.by, o.via, o.first_at FROM task_pr_owners o WHERE o.task = ?${only}`).run(to, ...args);
  db.prepare(`DELETE FROM task_pr_owners WHERE rowid IN (SELECT o.rowid FROM task_pr_owners o WHERE o.task = ?${only})`).run(...args);
  if (by !== undefined) return unlinkOwnerless(db, from, urls);
  // a merge: the links themselves too (one with no owner row moves as it is), and nothing stays on `from`
  db.prepare(`INSERT OR IGNORE INTO task_prs (url, task, project, via, by, first_at) SELECT url, ?, project, via, by, first_at FROM task_prs WHERE task = ?`).run(to, from);
  db.prepare(`DELETE FROM task_prs WHERE task = ?`).run(from);
}

/** The address that holds a PR: bb's reading's thread, else the last log entry's. */
function prHolder(db: Db, url: string): string | null {
  const bb = db.prepare(`SELECT a.address FROM prs p JOIN agents a ON a.thread_id = p.thread_id WHERE rtrim(p.url, '/') = ? ORDER BY p.seen_at DESC LIMIT 1`).get(url) as { address: string } | undefined;
  if (bb) return bb.address;
  const ev = db.prepare(`SELECT address FROM events WHERE kind = 'pr' AND rtrim(ref, '/') = ? AND address LIKE 'thread:%' ORDER BY at DESC LIMIT 1`).get(url) as { address: string } | undefined;
  return ev?.address ?? null;
}

/**
 * file: attach a thread (address or bb thread id), a PR (URL: it follows the thread that holds it, so that thread is
 * filed; a PR no thread holds is linked itself, via cos), a deliverable (dl-…) or a card (d-…) to a task of the same project. Something already on another task moves.
 */
export function fileItem(db: Db, now: number, kind: FileKind, ref: string, taskId: string): TidyResult {
  const t = target(db, taskId);
  const key = ref.trim();
  const other = (prev: string | null) => (prev && prev !== t.id ? ` (it was on ${prev})` : "");
  const wrongProject = (p: string | null, what: string) => {
    if (p !== t.project) throw new TaskError(`${what} is ${p ? `in ${p}` : "in no project"}, and ${t.id} is a task of ${t.project}: file things only under their own project's tasks`);
  };
  let what: string;
  // what the filing brings, for a task its lead marked done (checked once it is in place, as a merge's is)
  let incoming: Incoming = { threads: [], prs: [], deliverables: [], cards: [] };
  // the target's owner rows before the filing: every PR that gains one is incoming, whoever owns it (a lead's wait
  // bound to a card the filed thread asked comes with it through the shared pass)
  const ownerRows = () => new Set((db.prepare(`SELECT url, by, via FROM task_pr_owners WHERE task = ?`).all(t.id) as Owner[]).map((o) => JSON.stringify([o.url, o.by, o.via])));
  const before = ownerRows();
  const url = prKey(key);
  const holder = kind === "pr" ? prHolder(db, url) : null;
  if (kind === "pr" && !holder) {
    // no thread holds it: link the PR itself (via cos); its state is read per URL from GitHub by the wait pass, never
    // taken from the caller, and none yet is unknown. Filed again elsewhere, the CoS's own link moves; links that came
    // through a thread or wait stay (a PR two tasks share is two links).
    if (!PR_URL_RE.test(url)) throw new TaskError(`${q(key)} is not a GitHub pull request URL (https://<host>/<owner>/<repo>/pull/<n>)`);
    const olds = (db.prepare(`SELECT task FROM task_pr_owners WHERE url = ? AND via = 'cos' AND by = '' AND task <> ? ORDER BY first_at DESC`).all(url, t.id) as { task: string }[]).map((r) => r.task);
    const prev = olds[0] ?? null;
    db.prepare(`DELETE FROM task_pr_owners WHERE url = ? AND via = 'cos' AND by = '' AND task <> ?`).run(url, t.id);
    for (const o of olds) unlinkOwnerless(db, o, [url]);
    linkPr(db, url, t.id, "cos", null, now);
    incoming = { ...incoming, prs: [url] };
    what = `PR ${url} (no thread holds it; the next PR pass reads its state from GitHub${other(prev)})`;
  } else if (kind === "thread" || kind === "pr") {
    const address = holder ?? key;
    const th = latestThread(db, address);
    if (!th) throw new TaskError(`${q(key)} is no thread: give its address (thread:<project>:<n>) or bb thread id`);
    wrongProject(th.project, th.address);
    const prev = addressTask(db, th.address);
    db.prepare(`INSERT OR IGNORE INTO spawns (thread_id, plan_id, via, lead, created_at) VALUES (?, NULL, 'board', NULL, ?)`).run(th.thread_id, now);
    db.prepare(`UPDATE spawns SET task = ? WHERE thread_id = ?`).run(t.id, th.thread_id);
    // the thread's PR links move with it, in this transaction: its owner rows, from its task and from any task it
    // left before (a dropped one: Unfiled, it has none). An old task keeps a link another owner still has there; a
    // card there that names the thread as its origin keeps its own (the shared pass gives it back).
    const olds = new Set([...(db.prepare(`SELECT DISTINCT task FROM task_pr_owners WHERE by = ? AND task <> ?`).all(th.address, t.id) as { task: string }[]).map((r) => r.task), ...(prev && prev !== t.id ? [prev] : [])]);
    for (const o of olds) {
      const urls = (db.prepare(`SELECT url FROM task_pr_owners WHERE task = ? AND by = ?`).all(o, th.address) as { url: string }[]).map((r) => r.url);
      moveLinks(db, o, t.id, th.address);
      linkRetained(db, { task: o, addresses: taskThreads(db, o) });
      unlinkOwnerless(db, o, urls);
    }
    // and whatever it gained while Unfiled (never linked: it had no task then), by the shared evidence pass
    linkCarried(db, t.id, th.address);
    // a PR filed through its holder is linked now (via cos, by the holder, so it moves with the thread), not on bb's next reading
    if (kind === "pr") linkPr(db, url, t.id, "cos", th.address, now);
    const owned = (db.prepare(`SELECT DISTINCT url FROM task_pr_owners WHERE task = ? AND by = ?`).all(t.id, th.address) as { url: string }[]).map((r) => r.url);
    incoming = { threads: [th.address], prs: owned, deliverables: [], cards: threadCards(db, th.address) };
    what = kind === "pr" ? `PR ${url} (with ${th.address}, the thread that holds it${other(prev)})` : `thread ${th.address}${other(prev)}`;
  } else if (kind === "deliverable") {
    const d = db.prepare(`SELECT id, project, title, json, json_extract(json, '$.task') AS task FROM deliverables WHERE id = ?`).get(key) as { id: string; project: string | null; title: string; json: string; task: string | null } | undefined;
    if (!d) throw new TaskError(`${q(key)} is no deliverable`);
    wrongProject(d.project, `deliverable ${d.id}`);
    db.prepare(`UPDATE deliverables SET json = json_set(json, '$.task', ?) WHERE id = ?`).run(t.id, d.id);
    // its PRs come with it (an approved deliverable with an open PR is not done), and leave its old task unless needed there
    linkCarried(db, t.id, null);
    const lead = (JSON.parse(d.json) as { lead?: string | null }).lead ?? "";
    if (d.task && d.task !== t.id) dropOwners(db, d.task, deliverableUrls(d.json).map((url) => ({ url, by: lead, via: "deliverable" })));
    incoming = { ...incoming, prs: deliverableUrls(d.json), deliverables: [d.id] };
    what = `deliverable ${d.id} ${q(d.title)}${other(d.task)}`;
  } else {
    const d = db.prepare(`SELECT id, project, json, json_extract(json, '$.request.title') AS title, json_extract(json, '$.orchestrator.task') AS task FROM decisions WHERE id = ?`).get(key) as
      | { id: string; project: string | null; json: string; title: string | null; task: string | null }
      | undefined;
    if (!d) throw new TaskError(`${q(key)} is no card`);
    wrongProject(d.project, `card ${d.id}`);
    db.prepare(`UPDATE decisions SET json = json_set(json, '$.orchestrator.task', ?) WHERE id = ?`).run(t.id, d.id);
    // its PR blocks (and the PR waits bound to it) come with it, and leave its old task unless needed there
    linkCarried(db, t.id, null);
    if (d.task && d.task !== t.id) {
      const o = (JSON.parse(d.json) as { orchestrator?: { origin?: string | null; asker?: string | null } }).orchestrator;
      const by = o?.origin ?? o?.asker ?? "";
      const waits = db.prepare(`SELECT pr_url AS url, owner FROM waits WHERE ref = ? AND pr_url IS NOT NULL`).all(d.id) as { url: string; owner: string }[];
      dropOwners(db, d.task, [...cardUrls(d.json).map((url) => ({ url, by, via: "card" })), ...waits.map((w) => ({ url: prKey(w.url), by: w.owner, via: "wait" }))]);
    }
    const c = db.prepare(`SELECT id, state, json_extract(json, '$.request.title') AS title FROM decisions WHERE id = ? AND state IN ('open', 'asked')`).get(d.id) as CardRow | undefined;
    const waits = (db.prepare(`SELECT pr_url AS url FROM waits WHERE ref = ? AND pr_url IS NOT NULL`).all(d.id) as { url: string }[]).map((r) => prKey(r.url));
    incoming = { ...incoming, prs: [...cardUrls(d.json), ...waits], cards: c ? [cardLabel(c)] : [] };
    what = `card ${d.id}${d.title ? ` ${q(d.title)}` : ""}${other(d.task)}`;
  }
  if (t.state === "shipped") {
    const gained = [...ownerRows()].filter((k) => !before.has(k)).map((k) => (JSON.parse(k) as [string])[0]);
    const { left, unread } = unfinished(db, now, t, { ...incoming, prs: [...new Set([...incoming.prs, ...gained])] }, "file");
    // thrown inside the tidy's transaction, which rolls back: the refusal writes nothing
    if (left.length) throw new TidyRefusal(unread, `task ${named(t)} has shipped (its lead marked it done), and ${what.replace(/ \(.*$/, "")} brings unfinished work: ${left.join(", ")}. Filing it there would hide it under a done task: file it under an open task, or wait until that work is done`);
  }
  logTidy(db, now, t, columnNow(db, now, t), `file ${kind} ${kind === "pr" ? url : key}`);
  return { text: `Filed ${what} under ${named(t)} (${t.project}).`, project: t.project, notice: `The CoS filed ${what} under your task ${named(t)}.` };
}

const parseUnfiled = (s: string | null): Unfiled | null => {
  if (!s) return null;
  try {
    return JSON.parse(s) as Unfiled;
  } catch {
    return null;
  }
};

const COL: Record<BoardColumn, string> = { planned: "Planned", in_progress: "In progress", in_review: "In review", waiting: "Waiting on you", blocked: "Blocked", shipped: "Shipped" };

/** list: what the CoS tidies, per project (only projects with something): drops to confirm or restore, Unfiled things, and the tasks to file them under. */
export function tidyList(db: Db, now: number, project: string | null): string {
  const board: WorkBoard = readBoard(db, now, { project });
  const out: string[] = [];
  for (const p of board.projects) {
    const u = p.unfiled;
    const unfiled = u.threads.length + u.prs.length + u.deliverables.length + u.cards.length;
    if (!p.dropped.length && !unfiled && !project) continue;
    out.push(`## ${p.slug}`);
    if (p.dropped.length) {
      out.push(`Dropped with attachments (restore, merge into another task, or confirm):`);
      for (const d of p.dropped) out.push(`- ${d.id} ${q(d.title)}: ${[...d.unfiled.threads.map((x) => `thread ${x}`), ...d.unfiled.deliverables.map((x) => `deliverable ${x}`), ...d.unfiled.cards.map((x) => `card ${x}`)].join(", ")}`);
    }
    if (unfiled) {
      out.push(`Unfiled (file under a task when it's obvious where it belongs, else ask the lead):`);
      for (const t of u.threads) out.push(`- thread ${t.address} (${t.state})`);
      for (const r of u.prs) out.push(`- pr ${r.url} (${r.state ?? "?"}, held by ${r.thread ?? "?"})`);
      for (const d of u.deliverables) out.push(`- deliverable ${d.id} ${q(d.title)} (${d.state})`);
      for (const c of u.cards) out.push(`- card ${c.id} ${q(c.title)} (${c.state})`);
    }
    const open = p.tasks.filter((t: BoardTask) => t.state === "open");
    out.push(open.length ? `Open tasks: ${open.map((t) => `${t.id} ${q(t.title)} [${COL[t.column]}]`).join("; ")}` : "No open tasks.");
  }
  return out.length ? out.join("\n") : "The board is tidy: no drops to confirm and nothing Unfiled.";
}

/** A task held off Shipped only by live threads idle over a day; `threads`: their addresses. */
export interface StaleTask {
  id: string;
  project: string;
  title: string;
  threads: string[];
}

/** The tasks to flag to their leads now (staleness as above, and not flagged in the last day). Read-only. */
export function staleTasks(db: Db, now: number): StaleTask[] {
  const idle = new Map((db.prepare(`SELECT thread_id, idle_at FROM agents WHERE role = 'thread'`).all() as { thread_id: string; idle_at: number | null }[]).map((r) => [r.thread_id, r.idle_at]));
  const flagged = new Map((db.prepare(`SELECT id, stale_flag_at FROM tasks WHERE state = 'open'`).all() as { id: string; stale_flag_at: number | null }[]).map((r) => [r.id, r.stale_flag_at]));
  const out: StaleTask[] = [];
  for (const p of readBoard(db, now).projects) {
    for (const t of p.tasks) {
      if (t.state !== "open" || t.column === "shipped") continue;
      const live = t.threads.filter((x) => x.live);
      if (!live.length) continue;
      // the board's own Shipped rule, without the threads: if that ships it, only the live threads hold it back
      const d = deriveColumn({ threads: [], prs: t.prs, deliverables: t.deliverables, cards: t.cards, state: "open", shippedAt: null, step: t.step?.state ?? null, blockers: [], statusAt: null });
      if (d.column !== "shipped") continue;
      if (!live.every((x) => x.state === "idle" && (idle.get(x.threadId) ?? null) !== null && now - idle.get(x.threadId)! > STALE_IDLE_MS)) continue;
      const last = flagged.get(t.id) ?? null;
      if (last !== null && now - last < STALE_FLAG_EVERY_MS) continue;
      out.push({ id: t.id, project: t.project, title: t.title, threads: live.map((x) => x.address) });
    }
  }
  return out;
}

/** Stamp a flagged task, so it is flagged again only after a day. */
export function markStaleFlagged(db: Db, now: number, ids: string[]): void {
  for (const id of ids) db.prepare(`UPDATE tasks SET stale_flag_at = ? WHERE id = ?`).run(now, id);
}

/** The lead's notice for its stale tasks. */
export function staleNotice(tasks: StaleTask[]): string {
  const lines = tasks.map((t) => `- ${named(t)}: ${t.threads.join(", ")} idle over a day`);
  return `Looks finished but not Shipped: every PR on ${tasks.length === 1 ? "this task" : "these tasks"} is merged and every deliverable approved, but a live thread is still attached.\n${lines.join("\n")}\nResolve each thread (orch_resolve) if its work is done, or mark the step done in orch_status. You hear about each task at most once a day.`;
}
