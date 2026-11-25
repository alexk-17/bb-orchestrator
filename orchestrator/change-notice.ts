export type ChangeNotice = { tables: string[] | null };

export const BB = "bb";
export const STATUS = "status";
export const LIVE = "live";

const ITEMS = ["items", "external_mail", "direct_images", "cursors"] as const;

// null: the read also reads the disk, which writes nothing to the database, so it refetches on every change.
export const READS = {
  config: ["multiplayer_boards", "review_queue_state"],
  needsYou: ["agents", STATUS, "decisions", "prs", BB],
  board: ["agents", STATUS, "board", "decisions", "events", "pr_readings", "prs", "projects", "rules", "waits", "xp", ...ITEMS],
  projects: ["agents", STATUS, "board", "decisions", "deliverables", "events", "handed_off_prs", "lead_status", "projects", "prs", "scoping_tasks", "spawns", "waits", "xp", ...ITEMS],
  agents: ["agents", STATUS, "board", "projects", "prs", "scoping_tasks", "spawns", "xp", BB],
  scope: ["agents", STATUS, "board", "decisions", "deliverables", "projects", "prs", "scoping_tasks", "spawns", BB],
  deliverables: ["agents", LIVE, "deliverables", "items", "projects", "prs", "xp"],
  deliverable: ["agents", LIVE, "deliverables", "items", "projects", "prs", "xp"],
  deliverableIndex: ["deliverables"],
  outputs: null,
  projectOrder: ["projects"],
  deliverableFolders: null,
  directHistory: ["events", "projects", ...ITEMS],
  projectBook: null,
  projectHistory: ["agents", STATUS, "decisions", "events", "projects", "prs", "waits", ...ITEMS],
  feed: ["agents", LIVE, "board", "decisions", "deliverables", "events", "inbox_entries", "lead_status", "projects", "scoping_tasks", ...ITEMS, BB],
  workBoard: ["agents", STATUS, "decisions", "deliverables", "events", "lead_status", "pr_readings", "prs", "projects", "spawns", "tasks", "task_pr_owners", "task_prs"],
  boardSince: ["agents", "cursors", "decisions", "deliverables", "events", "lead_status", "pr_readings", "projects", "prs", "spawns", "task_moves", "task_pr_owners", "task_prs", "tasks"],
  viewPrefs: [],
} satisfies Record<string, readonly string[] | null>;

export type ChangeRead = keyof typeof READS;

export const UNREAD_TABLES = [
  "_migrations",
  "inbox_reads", "inbox_wakes", "inbox_wake_log",
  "xp_cursor", "thread_numbers", "alarms", "memchecks", "dream_batches",
  "slack_watch_events", "slack_watch_profiles", "slack_watch_roots",
  "multiplayer_beats", "multiplayer_records", "review_queue_lease",
  "pr_read_requests",
] as const;

export const KNOWN_TABLES: ReadonlySet<string> = new Set([...Object.values(READS).flatMap((t) => t ?? []), ...UNREAD_TABLES]);

export function touches(notice: unknown, read: ChangeRead): boolean {
  const reads: readonly string[] | null = READS[read];
  const tables = (notice as Partial<ChangeNotice> | null | undefined)?.tables;
  if (!reads || !Array.isArray(tables)) return true;
  return tables.some((t) => reads.includes(t));
}

export function mergeNotices(a: unknown, b: unknown): ChangeNotice {
  const ta = (a as Partial<ChangeNotice> | null | undefined)?.tables;
  const tb = (b as Partial<ChangeNotice> | null | undefined)?.tables;
  return { tables: Array.isArray(ta) && Array.isArray(tb) ? [...new Set([...ta, ...tb])].sort() : null };
}
