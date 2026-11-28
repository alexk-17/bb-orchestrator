export type ChangeNotice = { tables: string[] | null };

export const BB = "bb";
export const STATUS = "status";
export const LIVE = "live";
export const NEXT_MOVES = "next_moves";
export const OWNER_MAIL = "owner_mail";
export const FOLDER_FILES = "folder_files";

// Named only when these tables' rows of these kinds change; a read declaring one reads them only for these kinds.
const OWNER_KINDS = ["owner.message", "owner.cos", "cos.reply"] as const;
export const DERIVED = {
  [NEXT_MOVES]: { items: ["deliverable.next"] },
  [OWNER_MAIL]: { items: OWNER_KINDS, inbox_entries: OWNER_KINDS },
} as const satisfies Record<string, Record<string, readonly string[]>>;
export type DerivedTable = keyof typeof DERIVED;

const ITEMS = ["items", "external_mail", "direct_images", "cursors"] as const;

// null: the read also reads the disk, which no write names, so every notice refetches it.
export const READS = {
  config: ["multiplayer_boards", "review_queue_state"],
  needsYou: ["agents", STATUS, "decisions", "prs", BB],
  board: ["agents", STATUS, "board", "decisions", "events", "pr_readings", "prs", "projects", "rules", "waits", "xp", ...ITEMS],
  projects: ["agents", STATUS, "board", "decisions", "deliverables", "events", "handed_off_prs", "lead_status", "projects", "prs", "scoping_tasks", "spawns", "waits", "xp", ...ITEMS],
  agents: ["agents", STATUS, "board", "projects", "prs", "scoping_tasks", "spawns", "xp", BB],
  scope: ["agents", STATUS, "board", "decisions", "deliverables", "projects", "prs", "scoping_tasks", "spawns", BB],
  deliverables: ["agents", LIVE, "deliverables", NEXT_MOVES, "projects", "prs"],
  deliverable: ["agents", LIVE, "deliverables", NEXT_MOVES, "projects", "prs"],
  deliverableIndex: ["deliverables"],
  outputs: ["outputs"],
  projectOrder: ["projects"],
  deliverableFolders: ["deliverables", FOLDER_FILES],
  directHistory: ["events", "projects", ...ITEMS],
  projectBook: null,
  projectHistory: ["agents", STATUS, "decisions", "events", "projects", "prs", "waits", ...ITEMS],
  feedLeftOut: ["board", "items"],
  feed: ["agents", LIVE, "board", "decisions", "deliverables", "events", "lead_status", OWNER_MAIL, "projects", "scoping_tasks", "direct_images", "cursors", BB],
  feedThread: ["agents", LIVE, "decisions", "deliverables", OWNER_MAIL, "projects", "scoping_tasks", "direct_images", "cursors"],
  workBoard: ["agents", STATUS, "decisions", "deliverables", "events", "lead_status", "pr_readings", "prs", "projects", "spawns", "tasks", "task_pr_owners", "task_prs"],
  boardSince: ["agents", "cursors", "decisions", "deliverables", "events", "lead_status", "pr_readings", "projects", "prs", "spawns", "task_moves", "task_pr_owners", "task_prs", "tasks"],
  viewPrefs: [],
} satisfies Record<string, readonly string[] | null>;

export type ChangeRead = keyof typeof READS;

export const UNREAD_TABLES = [
  "_migrations", "sqlite_sequence",
  "inbox_reads", "inbox_read_parts", "inbox_wakes", "inbox_wake_log", "inbox_wake_rearms", "inbox_stuck_members",
  "xp_cursor", "thread_numbers", "alarms", "memchecks", "dream_batches",
  "slack_watch_events", "slack_watch_profiles", "slack_watch_roots",
  "multiplayer_beats", "multiplayer_records", "review_queue_lease",
  "pr_read_requests",
] as const;

export const KNOWN_TABLES: ReadonlySet<string> = new Set([...Object.values(READS).flatMap((t) => t ?? []), ...Object.values(DERIVED).flatMap((t) => Object.keys(t)), ...UNREAD_TABLES]);

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
