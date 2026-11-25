// The page's change notice, and which reads each change refetches (lag fix, 2026-11-23). Before this, every change
// made every mounted screen refetch every read, at least 36 reads on one project page. The server's notice now names
// the tables written since the last notice (core/write-log.ts), and each listener refetches only the reads that read
// one of them. test/change-reads.test.ts runs every read below against the real handlers and fails when one reads a
// table, or shows a status, that it doesn't declare here; test/read-map-static.test.ts follows each read's code to every
// table its SQL can reach, including branches the made-up seed never takes.

/** The notice on CHANGED_CHANNEL: the tables written, or null when a change can't be named (every read refetches). */
export type ChangeNotice = { tables: string[] | null };

/** bb's own thread state the reads show: prompts, titles, bb's statuses, context use. */
export const BB = "bb";
/**
 * A thread's status: an agents update of its status columns only, or a "status" event (Engine.setStatus). Most notices
 * are these, and most reads show no status: a read that shows one declares it besides "agents" or "events".
 */
export const STATUS = "status";
/**
 * An agent entered or left "archived" (Engine.setStatus names it): a status flip that changes whether the agent counts
 * as live (Engine.liveAt) or keeps its persona. The reads that show only that declare LIVE, not every status flip.
 */
export const LIVE = "live";

const ITEMS = ["items", "external_mail", "direct_images", "cursors"] as const;

/**
 * What each read the page refetches on a change reads. null: it also reads the disk (a file gone or changed writes
 * nothing to the database), so it refetches on every change, as before.
 */
export const READS = {
  config: ["multiplayer_boards", "review_queue_state"],
  // a card's PR blocks show the PR's latest reading (card(): prByUrl)
  needsYou: ["agents", STATUS, "decisions", "prs", BB],
  // a wait's PR: its own reading, else bb's (Engine.waitPr); a persona's partner evolves with its XP (Engine.personaOf)
  board: ["agents", STATUS, "board", "decisions", "events", "pr_readings", "prs", "projects", "rules", "waits", "xp", ...ITEMS],
  projects: ["agents", STATUS, "board", "decisions", "deliverables", "events", "handed_off_prs", "lead_status", "projects", "prs", "scoping_tasks", "spawns", "waits", "xp", ...ITEMS],
  agents: ["agents", STATUS, "board", "projects", "prs", "scoping_tasks", "spawns", "xp", BB],
  scope: ["agents", STATUS, "board", "decisions", "deliverables", "projects", "prs", "scoping_tasks", "spawns", BB],
  // a next move's state is its item's (the lead's ack); PR proof shows the PR's state; an archived lead shows no persona
  deliverables: ["agents", LIVE, "deliverables", "items", "projects", "prs", "xp"],
  // one card whole, as the list shows it (lag 2: the list sends only the cards in review whole)
  deliverable: ["agents", LIVE, "deliverables", "items", "projects", "prs", "xp"],
  // every card's revisions, for Delivered's search, Files and file counts: kept warm at idle (deliverable-prefetch.tsx)
  deliverableIndex: ["deliverables"],
  outputs: null, // whether each file is still there
  projectOrder: ["projects"],
  deliverableFolders: null,
  directHistory: ["events", "projects", ...ITEMS],
  projectBook: null, // its pins' files, by their mtime
  projectHistory: ["agents", STATUS, "decisions", "events", "projects", "prs", "waits", ...ITEMS],
  // the feed shows the prompts the last needsYou read found (server.ts feedPrompts); a reply goes only to a live line;
  // with the batched inbox on, an item is read when its recipient acks its batch (inbox_entries)
  feed: ["agents", LIVE, "board", "decisions", "deliverables", "events", "inbox_entries", "lead_status", "projects", "scoping_tasks", ...ITEMS, BB],
  // the work board (core/work-board.ts): tasks with their hand moves (a move writes tasks too; task_moves is only its
  // log), durable PR links, and what each card shows
  workBoard: ["agents", STATUS, "decisions", "deliverables", "events", "lead_status", "pr_readings", "prs", "projects", "spawns", "tasks", "task_pr_owners", "task_prs"],
  // the since lens (core/since.ts): the move log, the log's merges, the tasked PRs (task_prs of tasks not dropped), the
  // owner's approvals and the feed's seen line; GitHub's cached read is plugin kv, which board-since.ts announces itself
  boardSince: ["cursors", "deliverables", "events", "task_moves", "task_prs", "tasks"],
} satisfies Record<string, readonly string[] | null>;

export type ChangeRead = keyof typeof READS;

/**
 * Tables no read above reads: a write to one names no read. Any table in neither list (a new one, a schema change)
 * makes the notice null, so everything refetches until it is mapped here.
 */
export const UNREAD_TABLES = [
  "_migrations",
  "inbox_reads", "inbox_wakes", "inbox_wake_log", // the agents' batched inbox (its entries: the feed's read receipts; the wake log: the lead wake gap)
  "xp_cursor", "thread_numbers", "alarms", "memchecks", "dream_batches",
  "slack_watch_events", "slack_watch_profiles", "slack_watch_roots", // read by multiplayer, which refetches on every change
  "multiplayer_beats", "multiplayer_records", "review_queue_lease",
  "pr_read_requests", // the PR pass's own list of PRs to read (core/board-tidy.ts); the reading itself writes pr_readings
] as const;

export const KNOWN_TABLES: ReadonlySet<string> = new Set([...Object.values(READS).flatMap((t) => t ?? []), ...UNREAD_TABLES]);

/** Whether a change notice refetches this read. Anything but a notice with a table list (an older server, a write's own refresh) refetches. */
export function touches(notice: unknown, read: ChangeRead): boolean {
  const reads: readonly string[] | null = READS[read];
  const tables = (notice as Partial<ChangeNotice> | null | undefined)?.tables;
  if (!reads || !Array.isArray(tables)) return true;
  return tables.some((t) => reads.includes(t));
}

/** Two notices as one, for a listener that got neither yet (app/change-listener.ts): the tables of both, or everything. */
export function mergeNotices(a: unknown, b: unknown): ChangeNotice {
  const ta = (a as Partial<ChangeNotice> | null | undefined)?.tables;
  const tb = (b as Partial<ChangeNotice> | null | undefined)?.tables;
  return { tables: Array.isArray(ta) && Array.isArray(tb) ? [...new Set([...ta, ...tb])].sort() : null };
}
