// Work-board tasks: a task is a lead's status step with a stable id, so the board
// keeps one card per step through rewording. orch_status steps carry an optional id; a step without one matches, by its
// normalised title (status.ts normTitle), the task the lead's stored list holds under that title, then an open task of
// the project, then one dropped in the last 14 days (a re-added title finds its old id; REVIVE_DROPPED_MS), else a new t-xxxxxx is made. A step that leaves the list is never deleted: done is Shipped, anything else is
// Dropped, quietly when nothing is attached, and with its attachments moved to the project's Unfiled list (recorded in
// tasks.unfiled, for the CoS) when something is.
//
// Attachments: a thread through its spawn row's task (a plan card's task is copied there at spawn); a PR through its
// task_prs links (linkPr: written when the PR is first seen through a thread or a wait, never pruned); a card or
// deliverable through its own task, else (read time) its thread's. The tables are
// MIGRATIONS' (core/db.ts). Only types come from db.ts: it imports seedTasks from here. No node: imports either, since
// db.ts reaches the app's bundle (through core/history.ts).
import type { Db } from "./db.ts";
import { type LeadStatus, normTitle, type StepState, waitsOf } from "./status.ts";
import { PR_URL_RE } from "./open-prs.ts";
import { settleColumns } from "./work-board.ts";

export const TASK_ID_RE = /^t-[0-9a-f]{6}$/;
/**
 * How long a dropped task can come back by its title: the board's since picker reaches 14 days. A title dropped longer
 * ago starts a new task, so a generic title ("QA", "Release") never brings back a stale task and its old attachments.
 * An undated drop (the upgrade's) counts as old. An explicit id still brings back a dropped task of any age.
 */
export const REVIVE_DROPPED_MS = 14 * 24 * 60 * 60_000;
export type TaskState = "open" | "shipped" | "dropped";
export interface TaskRow {
  id: string;
  project: string;
  title: string;
  norm: string;
  state: TaskState;
  created_at: number;
  shipped_at: number | null;
  dropped_at: number | null;
  unfiled: string | null;
  hand_col: string | null;
  hand_at: number | null;
  hand_sig: string | null;
  col: string | null;
  col_at: number | null;
  /** The task the CoS merged this one into (core/board-tidy.ts): its id redirects there. */
  merged_into?: string | null;
  stale_flag_at?: number | null;
}
/** What a drop moved to Unfiled: bb thread ids, deliverable ids and card ids. */
export interface Unfiled {
  threads: string[];
  deliverables: string[];
  cards: string[];
}

export class TaskError extends Error {}

export function newTaskId(db: Db): string {
  for (;;) {
    const id = `t-${[...globalThis.crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    if (!db.prepare(`SELECT 1 FROM tasks WHERE id = ?`).get(id)) return id;
  }
}

export const taskRow = (db: Db, id: string): TaskRow | null => (db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined) ?? null;

/** A task the CoS merged away stands for the task it was merged into (followed to the end of the chain). */
export function followMerge(db: Db, t: TaskRow): TaskRow {
  for (let i = 0; t.merged_into && i < 20; i++) {
    const next = taskRow(db, t.merged_into);
    if (!next) break;
    t = next;
  }
  return t;
}

/** The state a step's state puts its task in: done ships it, skipped drops it, current and next keep it open. */
const stateOf = (s: StepState): TaskState => (s === "done" ? "shipped" : s === "skipped" ? "dropped" : "open");

/**
 * The tasks for one publish of a project's steps (in the engine's transaction, after normalizeStatus accepted them):
 * each step gets its task id, titles follow rewording, states follow the steps, and open tasks no step names are
 * dropped. Refuses an id that isn't one of this project's tasks. Returns the steps with their ids.
 */
export function assignTasks(db: Db, project: string, steps: LeadStatus["steps"], now: number): LeadStatus["steps"] {
  const rows = db.prepare(`SELECT * FROM tasks WHERE project = ?`).all(project) as TaskRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const claimed = new Set<string>();
  const out: (TaskRow | null)[] = steps.map(() => null);
  const viaMerge = new Map<string, string>(); // a task claimed through an id the CoS merged into it: that old id
  // explicit ids first, so a title match never takes a task a later step names by id
  for (const [i, s] of steps.entries()) {
    if (!s.id) continue;
    const t = byId.get(s.id);
    if (!t) {
      const other = db.prepare(`SELECT project FROM tasks WHERE id = ?`).get(s.id) as { project: string } | undefined;
      throw new TaskError(`step ${i + 1}'s id ${s.id} ${other ? `is a task of ${other.project}, not ${project}` : `is no task of ${project}`}: leave id out to match by title, or use an id a reply gave you`);
    }
    const to = followMerge(db, t);
    if (claimed.has(to.id)) {
      const via = viaMerge.get(to.id);
      throw new TaskError(
        to !== t || via
          ? `steps ${via ?? to.id} and ${to !== t ? s.id : to.id} are one task: the CoS merged ${to !== t ? s.id : via} into ${to.id}. Send that task once, with id ${to.id}`
          : `step ${i + 1}'s id ${s.id} is another step's too: send each task once`,
      );
    }
    if (to !== t) viaMerge.set(to.id, t.id);
    claimed.add(to.id);
    out[i] = to;
  }
  // then the task the stored list already holds under that title, in any state (a done step sent again without its id
  // is the same Shipped task, and a done step marked current again reopens it); a task that shipped and left the list
  // is never matched, so a recurring title doesn't reopen an old ship
  const stored = new Map<string, string>();
  const prev = db.prepare(`SELECT json FROM lead_status WHERE project = ?`).get(project) as { json: string } | undefined;
  try {
    for (const st of prev ? ((JSON.parse(prev.json) as LeadStatus).steps ?? []) : []) if (st.id && byId.has(st.id) && !stored.has(normTitle(st.title))) stored.set(normTitle(st.title), st.id);
  } catch {
    /* a broken stored status matches nothing */
  }
  const newest = (a: TaskRow, b: TaskRow) => (b.dropped_at ?? 0) - (a.dropped_at ?? 0);
  // a title match brings a dropped task back only within REVIVE_DROPPED_MS, on every path (a skipped step left in the
  // list too); a step still skipped revives nothing, so it keeps its task at any age
  const matches = (t: TaskRow | undefined, s: LeadStatus["steps"][number]) => !!t && (t.state !== "dropped" || stateOf(s.state) === "dropped" || now - (t.dropped_at ?? 0) <= REVIVE_DROPPED_MS);
  for (const [i, s] of steps.entries()) {
    if (out[i]) continue;
    const n = normTitle(s.title);
    const kept = stored.get(n);
    const k = kept && !claimed.has(kept) ? byId.get(kept) : undefined;
    const t =
      (matches(k, s) ? k : undefined) ??
      rows.find((r) => r.state === "open" && r.norm === n && !claimed.has(r.id)) ??
      rows.filter((r) => r.state === "dropped" && r.norm === n && !claimed.has(r.id) && matches(r, s)).sort(newest)[0];
    // a task the CoS merged away stands for the one it was merged into: a re-sent old title never un-merges it
    const to = t ? followMerge(db, t) : undefined;
    if (to && to !== t && claimed.has(to.id)) throw new TaskError(`step ${i + 1} ${JSON.stringify(s.title)} was merged into ${to.id} ${JSON.stringify(to.title)}, which another step already is: send that task once, with id ${to.id}`);
    if (to) {
      claimed.add(to.id);
      out[i] = to;
    }
  }
  const result: LeadStatus["steps"] = [];
  for (const [i, s] of steps.entries()) {
    let t = out[i];
    const norm = normTitle(s.title);
    if (!t) {
      const id = newTaskId(db);
      const state = stateOf(s.state);
      db.prepare(`INSERT INTO tasks (id, project, title, norm, state, created_at, shipped_at, dropped_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id,
        project,
        s.title,
        norm,
        state,
        now,
        state === "shipped" ? now : null,
        state === "dropped" ? now : null,
      );
      result.push({ ...s, id });
      continue;
    }
    if (t.title !== s.title) db.prepare(`UPDATE tasks SET title = ?, norm = ? WHERE id = ?`).run(s.title, norm, t.id);
    const to = stateOf(s.state);
    if (to !== t.state) {
      if (to === "shipped") db.prepare(`UPDATE tasks SET state = 'shipped', shipped_at = ?, dropped_at = NULL WHERE id = ?`).run(now, t.id);
      else if (to === "dropped") dropTask(db, t, now);
      else {
        if (t.state === "dropped" && t.unfiled) refile(db, t);
        db.prepare(`UPDATE tasks SET state = 'open', shipped_at = NULL, dropped_at = NULL, unfiled = NULL WHERE id = ?`).run(t.id);
      }
    }
    result.push({ ...s, id: t.id });
  }
  // an open task no step names left the list before it was done
  for (const r of rows) if (r.state === "open" && !claimed.has(r.id)) dropTask(db, r, now);
  return result;
}

/** A thread's task, by its bb thread id: its spawn row's (null: none, or Unfiled). */
export const threadTask = (db: Db, threadId: string): string | null => (db.prepare(`SELECT task FROM spawns WHERE thread_id = ?`).get(threadId) as { task: string | null } | undefined)?.task ?? null;

/**
 * The one rule for an address's task, which the board's placement, every live link and the seed all use: only a
 * thread's address has one, the spawn row's of its latest holder that has one (a handoff successor has no spawn row
 * and works on its predecessor's task). A lead, the CoS, or a thread that took another role, has none: a spawn row
 * that outlives its thread's role names no task for the new address.
 */
const ADDRESS_TASK = `SELECT a.address, s.task FROM agents a JOIN spawns s ON s.thread_id = a.thread_id WHERE a.role = 'thread'`;

/** Every thread address's task by the rule above, for the board's one read. */
export function addressTasks(db: Db): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const r of db.prepare(`${ADDRESS_TASK} ORDER BY a.created_at, a.rowid`).all() as { address: string; task: string | null }[]) out.set(r.address, r.task);
  return out;
}

/** One address's lookup by the rule above (agents_address_created serves it, retired holders too). */
export const ADDRESS_TASK_ONE = `${ADDRESS_TASK} AND a.address = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`;

/** One address's task by the rule above. Null: none, Unfiled, or not a thread. */
export const addressTask = (db: Db, address: string): string | null => (db.prepare(ADDRESS_TASK_ONE).get(address) as { task: string | null } | undefined)?.task ?? null;

/** A PR URL as every task_prs write and every board read keys it: trimmed, no trailing slash. */
export const prKey = (url: string): string => url.trim().replace(/\/+$/, "");

export type PrVia = "bb" | "report" | "wait" | "handoff" | "card" | "deliverable" | "cos" | "upgrade";

/**
 * Link a PR to a task, once (task_prs, keyed by URL and task: a PR two tasks share is two rows). The first sight
 * wins: later ones change nothing, and nothing prunes the row, so the board never loses a PR that blocks Shipped.
 * No task, or not a PR URL: nothing.
 */
export function linkPr(db: Db, url: string, task: string | null, via: PrVia, by: string | null, at: number): void {
  const key = prKey(url);
  if (!task || !PR_URL_RE.test(key)) return;
  db.prepare(`INSERT OR IGNORE INTO task_prs (url, task, project, via, by, first_at) SELECT ?, id, project, ?, ?, ? FROM tasks WHERE id = ?`).run(key, via, by, at, task);
  // and its owner, every one (task_pr_owners): a link shared by two threads, or a thread and the CoS, keeps both, so
  // one leaving never takes the link from the other. The upgrade's own seed runs before that table exists.
  if (hasOwners(db)) db.prepare(`INSERT OR IGNORE INTO task_pr_owners (url, task, by, via, first_at) SELECT ?, id, ?, ?, ? FROM tasks WHERE id = ?`).run(key, by ?? "", via, at, task);
}

const withOwners = new WeakSet<Db>();
/** Whether task_pr_owners exists yet (only the upgrade's task_prs seed runs before it; once there, it stays). */
function hasOwners(db: Db): boolean {
  if (withOwners.has(db)) return true;
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_pr_owners'`).get()) return false;
  withOwners.add(db);
  return true;
}

/**
 * A PR wait's task: a thread's own (its address's), or, for anyone else's wait (a lead's), the task of the card it
 * was bound to, as the board reads a card's (its own, else its origin's, else its asker's). A wait on a message: none.
 */
export function waitTask(db: Db, owner: string, ref: string, taskOf: (address: string) => string | null = (a) => addressTask(db, a)): string | null {
  if (owner.startsWith("thread:")) return taskOf(owner);
  if (!ref.startsWith("d-")) return null;
  const r = db.prepare(`SELECT json_extract(json, '$.orchestrator.task') AS task, json_extract(json, '$.orchestrator.origin') AS origin, json_extract(json, '$.orchestrator.asker') AS asker FROM decisions WHERE id = ?`).get(ref) as
    | { task: string | null; origin: string | null; asker: string | null }
    | undefined;
  return r ? cardTaskBy(r, taskOf) : null;
}

type CardRefs = { task?: string | null; origin?: string | null; asker?: string | null };

/** A card's work task, the board's and the links' one rule: its own, else its origin's, else its asker's (addresses by `taskOf`). */
export function cardTaskBy(o: CardRefs, taskOf: (address: string) => string | null): string | null {
  return o.task ?? (o.origin ? taskOf(o.origin) : null) ?? (o.asker ? taskOf(o.asker) : null);
}

export const cardTask = (db: Db, o: CardRefs): string | null => cardTaskBy(o, (a) => addressTask(db, a));

/** The URLs of a block list's PR blocks (`kind: "pr"`). Other blocks' URLs (lists, review verdicts) name no PR of the task's own. */
const prBlockUrls = (blocks: unknown): string[] =>
  Array.isArray(blocks) ? blocks.flatMap((b) => (b && typeof b === "object" && (b as { kind?: unknown }).kind === "pr" && typeof (b as { url?: unknown }).url === "string" ? [(b as { url: string }).url] : [])) : [];

/** A card's PR blocks join its work task (via 'card'), on each save: ask, revise, forward, answer. */
export function linkCardPrs(db: Db, card: { request?: { blocks?: unknown } | null; orchestrator?: { task?: string | null; origin?: string | null; asker?: string | null } | null }, at: number): void {
  const urls = prBlockUrls(card.request?.blocks);
  if (!urls.length || !card.orchestrator) return;
  const task = cardTask(db, card.orchestrator);
  for (const url of urls) linkPr(db, url, task, "card", card.orchestrator.origin ?? card.orchestrator.asker ?? null, at);
}

/** A deliverable's PR blocks and PR proof, in every revision, join its task (via 'deliverable'), on each save. */
export function linkDeliverablePrs(db: Db, d: { task?: string | null; lead?: string | null; revisions?: { blocks?: unknown; proof?: { kind?: string; url?: string | null }[] }[] }, at: number): void {
  if (!d.task) return;
  for (const r of d.revisions ?? [])
    for (const url of [...prBlockUrls(r.blocks), ...(r.proof ?? []).flatMap((p) => (p.kind === "pr" && p.url ? [p.url] : []))]) linkPr(db, url, d.task, "deliverable", d.lead ?? null, at);
}

type Evidence = { url: string; by: string; via: PrVia; at: number; ref: string | null };

/**
 * What the DB keeps that ties a PR to a thread's address or a card (all of it, or only `addresses`' and `cards`'):
 * its PR log entries and bb's readings (via 'bb'), its PR reports ('report'), the PR waits it owns or that are bound
 * to one of the cards, open or completed ('wait'), and the PRs handed off when it was resolved ('handoff').
 */
function prEvidence(db: Db, addresses: string[] | null, cards: string[] | null): Evidence[] {
  const a = JSON.stringify(addresses ?? []);
  const c = JSON.stringify(cards ?? []);
  const IN = (col: string) => `${col} IN (SELECT value FROM json_each(?))`;
  const all = (sql: string, col: string) => db.prepare(sql.replace("@ONE", addresses ? `AND ${IN(col)}` : "")).all(...(addresses ? [a] : [])) as { url: string; by: string; at: number; ref?: string }[];
  const out: Evidence[] = [];
  const add = (via: PrVia, rows: { url: string; by: string; at: number; ref?: string }[]) => rows.forEach((r) => out.push({ url: r.url, by: r.by, via, at: r.at, ref: r.ref ?? null }));
  add("bb", all(`SELECT ref AS url, address AS by, MIN(at) AS at FROM events WHERE kind = 'pr' AND ref IS NOT NULL AND address LIKE 'thread:%' @ONE GROUP BY ref, address`, "address"));
  add("bb", all(`SELECT p.url, a.address AS by, MIN(p.seen_at) AS at FROM prs p JOIN agents a ON a.thread_id = p.thread_id WHERE a.address LIKE 'thread:%' @ONE GROUP BY p.url, a.address`, "a.address"));
  add("report", all(`SELECT ref AS url, from_address AS by, MIN(at) AS at FROM board WHERE kind = 'pr' AND ref IS NOT NULL AND from_address LIKE 'thread:%' @ONE GROUP BY ref, from_address`, "from_address"));
  const waits = `SELECT pr_url AS url, owner AS by, created_at AS at, ref FROM waits`;
  add("wait", (addresses ? db.prepare(`${waits} WHERE ${IN("owner")} OR ${IN("ref")}`).all(a, c) : db.prepare(waits).all()) as { url: string; by: string; at: number; ref: string }[]);
  add("handoff", all(`SELECT pr AS url, thread_address AS by, at FROM handed_off_prs WHERE 1 @ONE`, "thread_address"));
  return out;
}

/** Link evidence earliest first (so first_at is the earliest), each on its address's task now (a wait: its own task). */
function linkEvidence(db: Db, ev: Evidence[]): void {
  const tasks = new Map<string, string | null>();
  const taskOf = (address: string) => {
    if (!tasks.has(address)) tasks.set(address, addressTask(db, address));
    return tasks.get(address) ?? null;
  };
  for (const x of ev.sort((a, b) => a.at - b.at)) linkPr(db, x.url, x.via === "wait" ? waitTask(db, x.by, x.ref ?? "", taskOf) : taskOf(x.by), x.via, x.by, x.at);
}

/** Link the PR blocks of the cards `where` picks, each on its task now (the card rule), as each save does. */
function linkCards(db: Db, where: string, params: string[]): void {
  for (const r of db.prepare(`SELECT json, updated_at FROM decisions WHERE json LIKE '%"kind":"pr"%' AND (${where})`).all(...params) as { json: string; updated_at: number }[]) linkCardPrs(db, JSON.parse(r.json), r.updated_at);
}

/** Link the PR blocks and PR proof of the deliverables `where` picks, on their own task, as each save does. */
function linkDeliverables(db: Db, where: string, params: string[]): void {
  for (const r of db.prepare(`SELECT json, created_at FROM deliverables WHERE ${where}`).all(...params) as { json: string; created_at: number }[]) linkDeliverablePrs(db, JSON.parse(r.json), r.created_at);
}

/**
 * The upgrade's backfill of task_prs (with its migration, in its transaction), from what the DB still holds: each
 * PR log entry and bb reading by a thread (via 'bb'), each PR a thread reported (via 'report'), each PR wait it keeps,
 * open or completed (via 'wait'), each PR handed off at resolve (via 'handoff'), on the task its address (or card) has
 * now, and the PR blocks and PR proof of cards and deliverables (via 'card', 'deliverable'), on their own task.
 * Earliest sight first, so first_at is the earliest. Then
 * each task's column is set as the board now derives it, with no move logged (the upgrade logs none).
 */
export function seedTaskPrs(db: Db, now: number): void {
  linkRetained(db, null);
  settleColumns(db, now, { log: false });
}

/**
 * The owners migration's backfill (with it, in its transaction): each link's own owner is copied by the migration;
 * then every owner the DB can still recover (two threads' reports of one PR, a card's and a deliverable's) is added
 * through the same pass, onto the links already there only. Retention may prune that evidence later, so it is
 * stored now, while it can be read. No link is added or removed.
 */
export function seedPrOwners(db: Db): void {
  db.exec(`CREATE TEMP TABLE seed_links AS SELECT url, task FROM task_prs`);
  linkRetained(db, null);
  db.exec(`DELETE FROM task_prs WHERE NOT EXISTS (SELECT 1 FROM temp.seed_links k WHERE k.url = task_prs.url AND k.task = task_prs.task)`);
  db.exec(`DELETE FROM task_pr_owners WHERE NOT EXISTS (SELECT 1 FROM task_prs k WHERE k.url = task_pr_owners.url AND k.task = task_pr_owners.task)`);
  db.exec(`DROP TABLE temp.seed_links`);
}

export function linkRetained(db: Db, scope: { task: string; addresses: string[] } | null): void {
  const list = JSON.stringify(scope?.addresses ?? []);
  const cardWhere = scope
    ? `json_extract(json, '$.orchestrator.task') = ? OR json_extract(json, '$.orchestrator.origin') IN (SELECT value FROM json_each(?)) OR json_extract(json, '$.orchestrator.asker') IN (SELECT value FROM json_each(?))`
    : `1`;
  const cardParams = scope ? [scope.task, list, list] : [];
  const cards = scope ? (db.prepare(`SELECT id FROM decisions WHERE ${cardWhere}`).all(...cardParams) as { id: string }[]).map((r) => r.id) : null;
  linkEvidence(db, prEvidence(db, scope ? scope.addresses : null, cards));
  linkCards(db, cardWhere, cardParams);
  linkDeliverables(db, scope ? `json_extract(json, '$.task') = ?` : `json_extract(json, '$.task') IS NOT NULL`, scope ? [scope.task] : []);
}

/**
 * Drop a task: quietly when nothing names it, else its threads, deliverables and cards lose it (they show in Unfiled)
 * and tasks.unfiled records them, which is what the CoS is shown. Only what names the task directly moves: a card or
 * PR that follows its thread moves with the thread.
 */
export function dropTask(db: Db, t: Pick<TaskRow, "id">, now: number): void {
  const threads = (db.prepare(`SELECT thread_id FROM spawns WHERE task = ?`).all(t.id) as { thread_id: string }[]).map((r) => r.thread_id);
  // an answered card or a withdrawn deliverable is history, not something hanging on the task: it keeps the task
  const deliverables = (db.prepare(`SELECT id FROM deliverables WHERE json_extract(json, '$.task') = ? AND state <> 'withdrawn'`).all(t.id) as { id: string }[]).map((r) => r.id);
  const cards = (db.prepare(`SELECT id FROM decisions WHERE json_extract(json, '$.orchestrator.task') = ? AND state IN ('open', 'asked')`).all(t.id) as { id: string }[]).map((r) => r.id);
  const moved: Unfiled = { threads, deliverables, cards };
  const any = threads.length + deliverables.length + cards.length > 0;
  if (any) {
    db.prepare(`UPDATE spawns SET task = NULL WHERE task = ?`).run(t.id);
    for (const id of deliverables) db.prepare(`UPDATE deliverables SET json = json_remove(json, '$.task') WHERE id = ?`).run(id);
    for (const id of cards) db.prepare(`UPDATE decisions SET json = json_remove(json, '$.orchestrator.task') WHERE id = ?`).run(id);
  }
  db.prepare(`UPDATE tasks SET state = 'dropped', dropped_at = ?, shipped_at = NULL, unfiled = ? WHERE id = ?`).run(now, any ? JSON.stringify(moved) : null, t.id);
}

/** A dropped task comes back (its title re-added, or the CoS restores it): what its drop moved to Unfiled and is still there comes back with it. */
export function refile(db: Db, t: TaskRow): void {
  let u: Unfiled;
  try {
    u = JSON.parse(t.unfiled!) as Unfiled;
  } catch {
    return;
  }
  for (const id of u.threads) db.prepare(`UPDATE spawns SET task = ? WHERE thread_id = ? AND task IS NULL`).run(t.id, successor(db, id));
  for (const id of u.deliverables) db.prepare(`UPDATE deliverables SET json = json_set(json, '$.task', ?) WHERE id = ? AND json_extract(json, '$.task') IS NULL`).run(t.id, id);
  for (const id of u.cards) db.prepare(`UPDATE decisions SET json = json_set(json, '$.orchestrator.task', ?) WHERE id = ? AND json_extract(json, '$.orchestrator.task') IS NULL`).run(t.id, id);
  // what came back brings the PRs it gained while Unfiled (those links were never written: it had no task then),
  // through the pass the upgrade uses, scoped to the task and its threads
  const addresses = u.threads.flatMap((id) => (db.prepare(`SELECT address FROM agents WHERE thread_id = ? AND role = 'thread'`).all(successor(db, id)) as { address: string }[]).map((r) => r.address));
  linkRetained(db, { task: t.id, addresses: [...new Set(addresses)] });
}

/** The thread that holds `threadId`'s spawn row now: itself, or the last of its handoff successors (events: handoff). */
function successor(db: Db, threadId: string): string {
  let id = threadId;
  for (let i = 0; i < 50 && !db.prepare(`SELECT 1 FROM spawns WHERE thread_id = ?`).get(id); i++) {
    const next = db.prepare(`SELECT thread_id FROM events WHERE kind = 'handoff' AND ref = ? ORDER BY seq DESC LIMIT 1`).get(id) as { thread_id: string | null } | undefined;
    if (!next?.thread_id) break;
    id = next.thread_id;
  }
  return id;
}

/**
 * The task a plan card, card or deliverable names (`task`: its id, or the title of an open task of the project as the
 * matcher compares it). Refuses an unknown or dropped one, naming the open tasks.
 */
export function resolveTaskRef(db: Db, project: string | null, ref: string): TaskRow {
  const key = ref.trim();
  if (!project) throw new TaskError("only a project's lead and threads have tasks");
  const byId = TASK_ID_RE.test(key) ? taskRow(db, key) : null;
  const found = byId ?? (db.prepare(`SELECT * FROM tasks WHERE project = ? AND state = 'open' AND norm = ?`).get(project, normTitle(key)) as TaskRow | undefined) ?? null;
  const t = found ? followMerge(db, found) : null;
  const open = () => {
    const rows = db.prepare(`SELECT id, title FROM tasks WHERE project = ? AND state = 'open' ORDER BY created_at`).all(project) as { id: string; title: string }[];
    return rows.length ? `its open tasks: ${rows.map((r) => `${r.id} ${JSON.stringify(r.title)}`).join(", ")}` : "it has no open tasks (publish steps with orch_status first)";
  };
  if (!t || t.project !== project) throw new TaskError(`${project} has no task ${JSON.stringify(key)}; ${open()}`);
  if (t.state === "dropped") throw new TaskError(`task ${t.id} ${JSON.stringify(t.title)} was dropped; ${open()}`);
  return t;
}

/**
 * The upgrade (MIGRATIONS' tasks step, core/db.ts SEEDS): each project's current steps become tasks, done steps Shipped
 * with no date, skipped ones Dropped quietly. History is not replayed. A live thread the lead's waits name (by its
 * address, or as the holder of a PR they name) attaches to the step the lead is on (its current step, else the first
 * next one); every other thread stays Unfiled. Each task's column is set as the board derives it, with no move logged.
 */
export function seedTasks(db: Db, now: number): void {
  const statuses = db.prepare(`SELECT project, json FROM lead_status`).all() as { project: string; json: string }[];
  for (const r of statuses) {
    let s: LeadStatus;
    try {
      s = JSON.parse(r.json) as LeadStatus;
    } catch {
      continue;
    }
    if (!Array.isArray(s.steps) || !s.steps.length) continue;
    const seen = new Set<string>();
    s.steps = s.steps.map((st) => {
      const state = stateOf(st.state);
      const id = newTaskId(db);
      let norm = normTitle(st.title ?? "");
      // two equal titles in an old status: the second keeps its own card (the matcher only ever finds the first)
      if (seen.has(norm)) norm = `${norm} ${id}`;
      seen.add(norm);
      db.prepare(`INSERT INTO tasks (id, project, title, norm, state, created_at, shipped_at, dropped_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`).run(id, r.project, st.title, norm, state, now);
      return { ...st, id };
    });
    db.prepare(`UPDATE lead_status SET json = ? WHERE project = ?`).run(JSON.stringify(s), r.project);
    const on = s.steps.find((x) => x.state === "current") ?? s.steps.find((x) => x.state === "next");
    if (!on) continue;
    for (const w of waitsOf(s)) {
      const addresses: string[] = [];
      if (w.kind === "thread" && w.ref) addresses.push(w.ref);
      if (w.kind === "pr" && w.ref) {
        const url = w.ref.replace(/\/+$/, "");
        for (const p of db.prepare(`SELECT a.address FROM prs p JOIN agents a ON a.thread_id = p.thread_id WHERE p.url = ?`).all(url) as { address: string }[]) addresses.push(p.address);
      }
      for (const address of addresses) {
        const live = db
          .prepare(`SELECT thread_id FROM agents WHERE address = ? AND role = 'thread' AND project = ? AND retired_at IS NULL AND status NOT IN ('stopped', 'archived')`)
          .get(address, r.project) as { thread_id: string } | undefined;
        if (!live) continue;
        db.prepare(`INSERT OR IGNORE INTO spawns (thread_id, plan_id, via, lead, created_at) VALUES (?, NULL, 'board', NULL, ?)`).run(live.thread_id, now);
        db.prepare(`UPDATE spawns SET task = ? WHERE thread_id = ?`).run(on.id, live.thread_id);
      }
    }
  }
  settleColumns(db, now, { log: false });
}
