import { seedPrOwners, seedTaskPrs, seedTasks } from "./tasks.ts";

// The SQL surface the engine needs. better-sqlite3 (bb.storage.database()) and node:sqlite (tests) both fit it.
export interface Stmt {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface Db {
  exec(sql: string): unknown;
  prepare(sql: string): Stmt;
}

// Append-only: never edit or reorder a shipped statement.
export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS agents (
     thread_id TEXT PRIMARY KEY,
     address TEXT NOT NULL UNIQUE,
     role TEXT NOT NULL,
     project TEXT,
     parent_thread_id TEXT,
     status TEXT NOT NULL DEFAULT 'unknown',
     idle_at INTEGER,
     created_at INTEGER NOT NULL,
     retired_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS decisions (
     id TEXT PRIMARY KEY,
     state TEXT NOT NULL,
     at_level TEXT NOT NULL,
     asker TEXT NOT NULL,
     origin TEXT NOT NULL,
     project TEXT,
     action TEXT,
     triage_due_at INTEGER,
     deferred_until INTEGER,
     deferred_manual INTEGER NOT NULL DEFAULT 0,
     json TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS items (
     id TEXT PRIMARY KEY,
     recipient TEXT NOT NULL,
     sender TEXT NOT NULL,
     kind TEXT NOT NULL,
     ref TEXT,
     body TEXT NOT NULL,
     send_key TEXT,
     needs_ack INTEGER NOT NULL,
     state TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     queued_message_id TEXT,
     created_at INTEGER NOT NULL,
     delivered_at INTEGER,
     closed_at INTEGER,
     outcome TEXT,
     note TEXT,
     UNIQUE (sender, send_key)
   )`,
  `CREATE INDEX IF NOT EXISTS items_recipient ON items (recipient, state)`,
  `CREATE TABLE IF NOT EXISTS rules (
     id TEXT PRIMARY KEY,
     text TEXT NOT NULL,
     project TEXT,
     kinds TEXT NOT NULL,
     expires_at INTEGER,
     granted_by TEXT NOT NULL,
     source TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     revoked_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS board (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     from_address TEXT,
     project TEXT,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     ref TEXT,
     at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS alarms (
     id TEXT PRIMARY KEY,
     level TEXT NOT NULL,
     snapshot TEXT NOT NULL,
     at INTEGER NOT NULL,
     item_id TEXT
   )`,
  // An address is unique among live agents only: a retired CoS must not block the next one.
  `CREATE TABLE agents_v2 (
     thread_id TEXT PRIMARY KEY,
     address TEXT NOT NULL,
     role TEXT NOT NULL,
     project TEXT,
     parent_thread_id TEXT,
     status TEXT NOT NULL DEFAULT 'unknown',
     idle_at INTEGER,
     created_at INTEGER NOT NULL,
     retired_at INTEGER
   );
   INSERT INTO agents_v2 SELECT thread_id, address, role, project, parent_thread_id, status, idle_at, created_at, retired_at FROM agents;
   DROP TABLE agents;
   ALTER TABLE agents_v2 RENAME TO agents;
   CREATE UNIQUE INDEX agents_live_address ON agents (address) WHERE retired_at IS NULL`,
  `CREATE TABLE projects (
     slug TEXT PRIMARY KEY,
     bb_project_id TEXT,
     priority TEXT NOT NULL DEFAULT 'normal',
     held_at INTEGER,
     created_at INTEGER NOT NULL
   );
   INSERT OR IGNORE INTO projects (slug, created_at) SELECT project, MIN(created_at) FROM agents WHERE role = 'lead' AND project IS NOT NULL GROUP BY project;
   CREATE TABLE spawns (
     thread_id TEXT PRIMARY KEY,
     plan_id TEXT,
     via TEXT NOT NULL,
     lead TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE prs (
     environment_id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     url TEXT,
     number INTEGER,
     state TEXT,
     attention TEXT,
     checks TEXT,
     sig TEXT NOT NULL,
     seen_at INTEGER NOT NULL
   );
   ALTER TABLE agents ADD COLUMN environment_id TEXT;
   ALTER TABLE agents ADD COLUMN flags TEXT NOT NULL DEFAULT '';
   ALTER TABLE agents ADD COLUMN mon TEXT`,
  // outputs: a file is its realpath and bb host (for bb's preview), a link its URL; one of path or url, never both.
  `CREATE TABLE outputs (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     kind TEXT NOT NULL,
     path TEXT,
     url TEXT,
     host_id TEXT,
     note TEXT,
     project TEXT,
     author TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     at INTEGER NOT NULL
   );
   CREATE INDEX outputs_project ON outputs (project, at)`,
  // dreams: one batch per date, its whole state as JSON so a restart neither re-launches nor files a second card.
  `CREATE TABLE dream_batches (
     date TEXT PRIMARY KEY,
     run TEXT NOT NULL,
     state TEXT NOT NULL,
     decision_id TEXT,
     json TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE memchecks (
     date TEXT PRIMARY KEY,
     problems TEXT NOT NULL,
     posted INTEGER NOT NULL,
     at INTEGER NOT NULL
   )`,
  // deliverables: the columns are what the screens sort and filter by; json holds the revisions and the owner's feedback.
  `CREATE TABLE deliverables (
     id TEXT PRIMARY KEY,
     project TEXT,
     lead TEXT NOT NULL,
     title TEXT NOT NULL,
     summary TEXT NOT NULL,
     state TEXT NOT NULL,
     rev INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     json TEXT NOT NULL
   );
   CREATE INDEX deliverables_state ON deliverables (state, updated_at)`,
  // XP is per address, so a restarted lead or handed-over thread keeps it; the cursor is per bb thread.
  `CREATE TABLE xp (
     address TEXT PRIMARY KEY,
     tokens INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE xp_cursor (
     thread_id TEXT PRIMARY KEY,
     seq INTEGER NOT NULL
   )`,
  `UPDATE agents SET mon = CASE mon
       WHEN 'Alakazam' THEN 'Abra'
       WHEN 'Espeon' THEN 'Eevee'
       WHEN 'Gardevoir' THEN 'Ralts'
       WHEN 'Metagross' THEN 'Beldum'
       WHEN 'Porygon-Z' THEN 'Porygon'
       WHEN 'Starmie' THEN 'Staryu'
       WHEN 'Scizor' THEN 'Scyther'
       WHEN 'Heracross' THEN 'Venipede'
       WHEN 'Volcarona' THEN 'Larvesta'
       WHEN 'Dragonite' THEN 'Dratini'
       WHEN 'Salamence' THEN 'Bagon'
       WHEN 'Excadrill' THEN 'Drilbur'
       WHEN 'Steelix' THEN 'Onix'
       WHEN 'Aggron' THEN 'Aron'
       WHEN 'Lucario' THEN 'Riolu'
       WHEN 'Jolteon' THEN 'Shinx'
       WHEN 'Magnezone' THEN 'Magnemite'
       WHEN 'Rotom' THEN 'Klink'
       WHEN 'Porygon2' THEN 'Porygon'
       WHEN 'Garchomp' THEN 'Gible'
       WHEN 'Tyranitar' THEN 'Larvitar'
       WHEN 'Gyarados' THEN 'Magikarp'
       WHEN 'Hydreigon' THEN 'Deino'
       WHEN 'Haxorus' THEN 'Axew'
       WHEN 'Gengar' THEN 'Gastly'
       ELSE mon END
   WHERE role = 'lead'`,
  `ALTER TABLE projects ADD COLUMN archived_at INTEGER`,
  // A death's sequence number is the CoS wake's cursor (the clock can repeat). `cursors` holds named counters.
  `ALTER TABLE items ADD COLUMN dead_seq INTEGER;
   ALTER TABLE items ADD COLUMN dead_at INTEGER;
   ALTER TABLE items ADD COLUMN on_board INTEGER NOT NULL DEFAULT 0;
   UPDATE items SET on_board = 1 WHERE state = 'dead';
   CREATE TABLE cursors (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
  // idle_at is kept through the next turn, so a reply can tell whether a message arrived for the turn it is in.
  `ALTER TABLE agents ADD COLUMN last_idle_at INTEGER`,
  `CREATE TABLE waits (
     id TEXT PRIMARY KEY,
     owner TEXT NOT NULL,
     ref TEXT NOT NULL,
     about TEXT NOT NULL,
     pr_url TEXT NOT NULL,
     cond TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     nudged_at INTEGER,
     closed_at INTEGER,
     outcome TEXT,
     item_id TEXT
   );
   CREATE INDEX waits_open ON waits (closed_at, pr_url)`,
  // Each rule offer is kept with its evidence, so the same cards are offered once.
  `ALTER TABLE rules ADD COLUMN match TEXT;
   CREATE TABLE rule_offers (
     id TEXT PRIMARY KEY,
     grp TEXT NOT NULL,
     evidence TEXT NOT NULL,
     suggested TEXT NOT NULL,
     at INTEGER NOT NULL
   )`,
  // events, append-only. kind: spawn (value = role, ref = parent thread), status (value = the new status), pr (value =
  // state, ref = url, note = number), handoff (thread_id = successor, ref = predecessor, value/note = new/old provider),
  // retire, resolve (value = why). backfill = 1: rebuilt from older tables (history.ts).
  `CREATE TABLE events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL,
     project TEXT,
     address TEXT,
     thread_id TEXT,
     value TEXT,
     ref TEXT,
     note TEXT,
     backfill INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX events_project ON events (project, at)`,
  // nudged_at: when the lead was told its status went stale (once per stale period; a new publish clears it).
  `CREATE TABLE lead_status (
     project TEXT PRIMARY KEY,
     address TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     json TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     nudged_at INTEGER
   )`,
  // A project's type is picked once and kept; a kept stage survives a change of Pokémon.
  `ALTER TABLE projects ADD COLUMN mon_type TEXT;
   ALTER TABLE agents ADD COLUMN mon_stage INTEGER;
   ALTER TABLE agents ADD COLUMN mon_stage_level INTEGER`,
  `CREATE TABLE external_mail (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     source TEXT NOT NULL,
     external_id TEXT NOT NULL,
     item_id TEXT NOT NULL UNIQUE,
     json TEXT NOT NULL,
     quiet INTEGER NOT NULL,
     due_at INTEGER,
     UNIQUE(source, external_id)
   )`,
  // Expression indexes: a query uses them only when it repeats json_extract(json, '$.answer.at') exactly.
  `CREATE INDEX decisions_project_answer ON decisions (project, json_extract(json, '$.answer.at'));
   CREATE INDEX decisions_answer_at ON decisions (json_extract(json, '$.answer.at'));
   CREATE INDEX decisions_state ON decisions (state)`,
  `CREATE INDEX events_project_kind ON events (project, kind, at);
   CREATE INDEX deliverables_project ON deliverables (project, updated_at);
   CREATE INDEX board_project ON board (project, at);
   CREATE INDEX events_merged_ref ON events (ref, project, at) WHERE kind = 'pr' AND value = 'merged'`,
  // A pin names its target, never its content. Unpinning sets unpinned_at; the row stays.
  `CREATE TABLE project_pins (
     id TEXT PRIMARY KEY,
     project TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('file', 'link', 'deliverable')),
     path TEXT,
     host_id TEXT,
     url TEXT,
     deliverable TEXT,
     title TEXT NOT NULL,
     icon TEXT NOT NULL,
     pinned_by TEXT NOT NULL,
     pinned_at INTEGER NOT NULL,
     position INTEGER NOT NULL,
     unpinned_at INTEGER
   );
   CREATE INDEX project_pins_live ON project_pins (project, unpinned_at, position)`,
  `CREATE TABLE handed_off_prs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     project TEXT,
     thread_address TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     pr TEXT NOT NULL,
     owner TEXT NOT NULL,
     note TEXT,
     by_address TEXT NOT NULL,
     at INTEGER NOT NULL
   );
   CREATE INDEX handed_off_prs_project ON handed_off_prs (project, at)`,
  `ALTER TABLE projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'active'`,
  // A scoping task's name is unique among its project's open ones. A spawn row's task moves with a handoff.
  `CREATE TABLE scoping_tasks (
     id TEXT PRIMARY KEY,
     project TEXT NOT NULL,
     name TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'scoping',
     opened_by TEXT NOT NULL,
     opened_at INTEGER NOT NULL,
     closed_at INTEGER,
     summary TEXT,
     doc TEXT
   );
   CREATE UNIQUE INDEX scoping_tasks_open_name ON scoping_tasks (project, name COLLATE NOCASE) WHERE state = 'scoping';
   ALTER TABLE spawns ADD COLUMN scope_task TEXT`,
  // null for a thread started with the task; the newest pick plans the task.
  `ALTER TABLE spawns ADD COLUMN scoped_at INTEGER`,
  // pr_readings: sig as prSeen writes it; seen_at is when it last changed, read_at when it was read.
  `CREATE TABLE pr_readings (
     url TEXT PRIMARY KEY,
     number INTEGER,
     state TEXT,
     attention TEXT,
     checks TEXT,
     sig TEXT NOT NULL,
     seen_at INTEGER NOT NULL,
     read_at INTEGER NOT NULL
   )`,
  // item_id is null until a message carries the image (n: its place there). source_project null: the plugin's own folder.
  `CREATE TABLE direct_images (
     id TEXT PRIMARY KEY,
     slug TEXT NOT NULL,
     item_id TEXT,
     n INTEGER,
     name TEXT NOT NULL,
     mime TEXT NOT NULL,
     size INTEGER NOT NULL,
     path TEXT NOT NULL,
     source_project TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX direct_images_item ON direct_images (item_id)`,
  // The run lease keeps two runs, or two plugin generations, from overlapping.
  `CREATE TABLE review_queue_state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
   CREATE TABLE review_queue_lease (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE INDEX board_from ON board (from_address, at)`,
  // Descending, so messages of the same millisecond keep their order (oldest of them first).
  `CREATE INDEX items_recipient_kind ON items (recipient, kind, created_at DESC)`,
  `CREATE INDEX items_state ON items (state)`,
  // An environment can hold more than one PR, so a row is keyed by environment and URL; prFor reads the newest open one.
  `CREATE TABLE prs_v2 (
     environment_id TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     url TEXT NOT NULL,
     number INTEGER,
     state TEXT,
     attention TEXT,
     checks TEXT,
     sig TEXT NOT NULL,
     seen_at INTEGER NOT NULL,
     PRIMARY KEY (environment_id, url)
   );
   INSERT INTO prs_v2 SELECT environment_id, thread_id, url, number, state, attention, checks, sig, seen_at FROM prs WHERE url IS NOT NULL;
   DROP TABLE prs;
   ALTER TABLE prs_v2 RENAME TO prs;
   CREATE INDEX prs_url ON prs (url)`,
  `CREATE TABLE multiplayer_boards (
     id TEXT PRIMARY KEY,
     channel TEXT NOT NULL UNIQUE,
     link TEXT,
     watcher TEXT,
     name TEXT NOT NULL DEFAULT '',
     purpose TEXT NOT NULL DEFAULT '',
     setup TEXT,
     created_at INTEGER NOT NULL,
     removed_at INTEGER
   );
   CREATE TABLE multiplayer_records (
     id TEXT PRIMARY KEY,
     board TEXT NOT NULL,
     lead TEXT NOT NULL,
     wake TEXT,
     state TEXT NOT NULL,
     json TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX multiplayer_records_board ON multiplayer_records (board, created_at);
   CREATE UNIQUE INDEX multiplayer_records_wake ON multiplayer_records (board, wake) WHERE wake IS NOT NULL;
   CREATE TABLE multiplayer_beats (
     source TEXT PRIMARY KEY,
     last_at INTEGER NOT NULL,
     prev_at INTEGER,
     every_ms INTEGER,
     reads INTEGER NOT NULL DEFAULT 0
   )`,
  // The feed: the post an owner's message belongs to (core/feed.ts keys); an older message is a post of its own.
  `ALTER TABLE items ADD COLUMN about TEXT;
   UPDATE items SET about = 'msg:' || id WHERE kind = 'owner.message';
   CREATE INDEX items_about ON items (about, created_at)`,
  // Agent rows and spawn events both age out, so neither alone remembers the highest thread number. Seeded from both.
  `CREATE TABLE thread_numbers (
     project TEXT PRIMARY KEY,
     last INTEGER NOT NULL
   );
   INSERT INTO thread_numbers (project, last)
     SELECT project, MAX(n) FROM (
       SELECT project, CAST(substr(address, length(project) + 9) AS INTEGER) AS n FROM agents
         WHERE role = 'thread' AND project IS NOT NULL AND substr(address, 1, length(project) + 8) = 'thread:' || project || ':'
       UNION ALL
       SELECT project, CAST(substr(address, length(project) + 9) AS INTEGER) AS n FROM events
         WHERE kind = 'spawn' AND project IS NOT NULL AND substr(address, 1, length(project) + 8) = 'thread:' || project || ':'
     ) GROUP BY project`,
  // Slack watcher: durable scan checkpoints, old thread roots and an idempotent import outbox.
  `CREATE TABLE slack_watch_profiles (name TEXT PRIMARY KEY, json TEXT NOT NULL);
   CREATE TABLE slack_watch_roots (profile TEXT NOT NULL, channel TEXT NOT NULL, ts TEXT NOT NULL,
     PRIMARY KEY(profile,channel,ts));
   CREATE TABLE slack_watch_events (key TEXT PRIMARY KEY, profile TEXT NOT NULL, channel TEXT NOT NULL,
     json TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX slack_watch_pending ON slack_watch_events(profile,done)`,
  // board_reports and decisions_feed_answered are read INDEXED BY; decisions_feed_answered repeats feed.ts ANSWERED_AT.
  `CREATE INDEX IF NOT EXISTS board_at ON board (at);
   CREATE INDEX IF NOT EXISTS board_kind_at ON board (kind, at);
   CREATE INDEX IF NOT EXISTS board_reports ON board (project, at, title) WHERE kind IN ('report','pr');
   CREATE INDEX IF NOT EXISTS items_kind_ref ON items (kind, ref);
   CREATE INDEX IF NOT EXISTS items_created ON items (created_at);
   CREATE INDEX IF NOT EXISTS items_sender ON items (sender, created_at);
   CREATE INDEX IF NOT EXISTS events_merged_project ON events (project, at, note) WHERE kind = 'pr' AND value = 'merged';
   CREATE INDEX IF NOT EXISTS events_project_thread ON events (project, thread_id);
   CREATE INDEX IF NOT EXISTS decisions_asker ON decisions (asker);
   CREATE INDEX IF NOT EXISTS decisions_project_state ON decisions (project, state);
   CREATE INDEX IF NOT EXISTS agents_project ON agents (project);
   CREATE INDEX IF NOT EXISTS decisions_feed_answered ON decisions (COALESCE(NULLIF(json_extract(json, '$.returned.at'), ''), NULLIF(json_extract(json, '$.ask.at'), ''), json_extract(json, '$.created_at')))
     WHERE state IN ('answered','acked') AND json_extract(json, '$.answer.by') = 'person';
   CREATE INDEX IF NOT EXISTS deliverables_list ON deliverables (updated_at, id, state, project, created_at, json_extract(json, '$.revisions[#-1].at'))
     WHERE json_extract(json, '$.board') IS NULL;
   CREATE INDEX IF NOT EXISTS deliverables_board_list ON deliverables (updated_at, id) WHERE json_extract(json, '$.board') IS NOT NULL`,
  // tasks: norm is the title as the matcher compares it; unfiled is what a drop moved to Unfiled (JSON, null for a quiet
  // drop); hand_* is the owner's hand move, held while hand_sig matches; col/col_at is the column task_moves last logged.
  `CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     project TEXT NOT NULL,
     title TEXT NOT NULL,
     norm TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('open', 'shipped', 'dropped')),
     created_at INTEGER NOT NULL,
     shipped_at INTEGER,
     dropped_at INTEGER,
     unfiled TEXT,
     hand_col TEXT,
     hand_at INTEGER,
     hand_sig TEXT,
     col TEXT,
     col_at INTEGER
   );
   CREATE INDEX tasks_project ON tasks (project, state);
   CREATE TABLE task_moves (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     task TEXT NOT NULL,
     project TEXT NOT NULL,
     from_col TEXT,
     to_col TEXT NOT NULL,
     at INTEGER NOT NULL,
     by TEXT NOT NULL,
     why TEXT
   );
   CREATE INDEX task_moves_at ON task_moves (at);
   CREATE INDEX task_moves_task ON task_moves (task, seq);
   ALTER TABLE spawns ADD COLUMN task TEXT`,
  `CREATE INDEX events_pr_ref_at ON events (ref, at) WHERE kind = 'pr'`,
  // task_prs: never pruned. by: the address the link came through. A PR with no state read is unknown, off Shipped.
  `CREATE TABLE task_prs (
     url TEXT NOT NULL,
     task TEXT NOT NULL,
     project TEXT NOT NULL,
     via TEXT NOT NULL CHECK (via IN ('bb', 'report', 'wait', 'handoff', 'card', 'deliverable', 'cos', 'upgrade')),
     by TEXT,
     first_at INTEGER NOT NULL,
     PRIMARY KEY (url, task)
   );
   CREATE INDEX task_prs_task ON task_prs (task);
   CREATE INDEX task_prs_by ON task_prs (by)`,
  // addressTask looks up retired holders too, which agents_live_address doesn't cover.
  `CREATE INDEX agents_address_created ON agents (address, created_at)`,
  // merged_into: a merged task stays dropped and its id redirects there. stale_flag_at: at most once a day.
  `ALTER TABLE tasks ADD COLUMN merged_into TEXT;
   ALTER TABLE tasks ADD COLUMN stale_flag_at INTEGER`,
  // One row per reason a link exists (by: '' for none). Stored, not re-derived: the evidence can be pruned. A link goes
  // only when its last owner leaves.
  `CREATE TABLE task_pr_owners (
     url TEXT NOT NULL,
     task TEXT NOT NULL,
     by TEXT NOT NULL,
     via TEXT NOT NULL,
     first_at INTEGER NOT NULL,
     PRIMARY KEY (url, task, by, via)
   );
   CREATE INDEX task_pr_owners_task ON task_pr_owners (task);
   CREATE INDEX task_pr_owners_by ON task_pr_owners (by);
   INSERT OR IGNORE INTO task_pr_owners (url, task, by, via, first_at) SELECT url, task, coalesce(by, ''), via, first_at FROM task_prs`,
  // A request goes once its PR is linked, or after a day.
  `CREATE TABLE pr_read_requests (url TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  `CREATE INDEX outputs_at ON outputs (at, id);
   DROP INDEX handed_off_prs_project;
   DROP INDEX multiplayer_records_board`,
];

/** Per connection, outside any transaction: bb sets WAL, busy_timeout and auto_vacuum; these add to them. */
export function tuneConnection(db: Db): void {
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA cache_size = -32768");
  db.exec("PRAGMA mmap_size = 268435456");
  db.exec("PRAGMA temp_store = MEMORY");
}

/**
 * Data steps that need code, by the index of the migration they follow: each runs right after that statement, in its
 * transaction, once. Append-only like MIGRATIONS.
 */
export const SEEDS: ReadonlyMap<number, (db: Db) => void> = new Map([
  [MIGRATIONS.findIndex((m) => m.startsWith("CREATE TABLE tasks (")), (db: Db) => seedTasks(db, Date.now())],
  [MIGRATIONS.findIndex((m) => m.startsWith("CREATE TABLE task_prs (")), (db: Db) => seedTaskPrs(db, Date.now())],
  [MIGRATIONS.findIndex((m) => m.startsWith("CREATE TABLE task_pr_owners (")), (db: Db) => seedPrOwners(db)],
]);

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY)`);
  const done = new Set((db.prepare(`SELECT id FROM _migrations`).all() as { id: number }[]).map((r) => r.id));
  MIGRATIONS.forEach((sql, i) => {
    if (done.has(i)) return;
    tx(db, () => {
      db.exec(sql);
      SEEDS.get(i)?.(db);
      db.prepare(`INSERT INTO _migrations (id) VALUES (?)`).run(i);
    });
  });
}

/** SQLite refuses INDEXED BY a missing index at prepare; without the index this prepares the query unhinted. */
export function prepareHinted(db: Db, index: string, sql: string): Stmt {
  try {
    return db.prepare(sql);
  } catch (e) {
    if (!String((e as Error)?.message ?? e).includes(`no such index: ${index}`)) throw e;
    return db.prepare(sql.replace(` INDEXED BY ${index}`, ""));
  }
}

let depth = 0;
/** One transaction (nested calls join the outer one). */
export function tx<T>(db: Db, fn: () => T): T {
  if (depth > 0) return fn();
  db.exec("BEGIN IMMEDIATE");
  depth++;
  try {
    const out = fn();
    depth--;
    db.exec("COMMIT");
    return out;
  } catch (e) {
    depth--;
    db.exec("ROLLBACK");
    throw e;
  }
}
