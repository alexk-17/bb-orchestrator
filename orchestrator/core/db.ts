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
  // Phase 2 (docs/phase2-plan.md): projects with priority and hold, spawns against approved plans, PR state per
  // environment, and each agent's bb environment.
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
  // Phase 3: Outputs, the finished artefacts a lead or thread recorded for the owner (the earlier Docs record). A file is kept
  // as its realpath and the bb host it is on (for bb's preview); a link as its URL. One of path or url, never both.
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
  // Dreams (phase 3, gap 5): one nightly batch per date in the dream zone, its whole state as JSON (so a restart
  // neither re-launches nor files a second card), and one memory check per date.
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
  // Deliverables (docs/deliverables-plan.md): a lead's finished work for the owner, with proof. The row's columns are what
  // the screens sort and filter by; the json holds the revisions (each with its proof) and the owner's feedback.
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
  // Levels (2026-11-13): XP is the tokens an agent's turns processed. It is kept per address, so a restarted
  // lead or a handed-over thread keeps levelling; the cursor is per bb thread (the last usage event counted).
  `CREATE TABLE xp (
     address TEXT PRIMARY KEY,
     tokens INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE xp_cursor (
     thread_id TEXT PRIMARY KEY,
     seq INTEGER NOT NULL
   )`,
  // Requested 2026-11-13: leads evolve too and start at their base form, so each lead's final-form Pokémon becomes its
  // line's base (Heracross, Jolteon and Rotom have no line: the kind's new pick). Its level then sets the form shown.
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
  // An archived project: its agents retired, its open questions withdrawn, kept for the record. Starting its lead again
  // brings it back.
  `ALTER TABLE projects ADD COLUMN archived_at INTEGER`,
  // Dead letters go to the CoS (2026-11-15): each death gets the next sequence number (the hourly wake's cursor, as
  // the clock can repeat) and its time; only the ones the CoS escalates reach the owner's board. Those already dead
  // are on the board today and stay there. `cursors` holds named counters (the wake's last sequence and check time).
  `ALTER TABLE items ADD COLUMN dead_seq INTEGER;
   ALTER TABLE items ADD COLUMN dead_at INTEGER;
   ALTER TABLE items ADD COLUMN on_board INTEGER NOT NULL DEFAULT 0;
   UPDATE items SET on_board = 1 WHERE state = 'dead';
   CREATE TABLE cursors (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
  // A reply counts as the ack (2026-11-16): when an agent last went idle, kept through its next turn (idle_at is
  // cleared when it turns active), so a reply can tell whether a message arrived for the turn it is in.
  `ALTER TABLE agents ADD COLUMN last_idle_at INTEGER`,
  // Answers that wait on a PR (2026-11-16): an ack bound to a PR and a condition. The PR notices wake its owner with
  // the original answer once the condition holds; the tick nudges it each day it doesn't.
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
  // Rules from answers (2026-11-16): a rule made from the owner's answers carries what it matches (rules.ts) and settles
  // those cards by itself. Each offer to the CoS is kept with its evidence, so the same cards are offered once.
  `ALTER TABLE rules ADD COLUMN match TEXT;
   CREATE TABLE rule_offers (
     id TEXT PRIMARY KEY,
     grp TEXT NOT NULL,
     evidence TEXT NOT NULL,
     suggested TEXT NOT NULL,
     at INTEGER NOT NULL
   )`,
  // The project page's history (2026-11-16): an append-only log of what changed and when. kind: spawn (value = role,
  // ref = parent thread), status (value = the new status), pr (value = state, ref = url, note = number), handoff
  // (thread_id = the successor, ref = the predecessor, value/note = new/old provider), retire, resolve (value = why).
  // Rows rebuilt from older tables at the log's start have backfill = 1 (history.ts).
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
  // A lead's structured status (2026-11-16, status.ts): the latest orch_status per project, as JSON. nudged_at: when its
  // lead was told it went stale (once per stale period; a new publish clears it). Each publish is also an event.
  `CREATE TABLE lead_status (
     project TEXT PRIMARY KEY,
     address TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     json TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     nudged_at INTEGER
   )`,
  // Pokémon types per project (2026-11-16, mons.ts TYPES): each project's type, picked once and kept; and a stage kept
  // through a change of Pokémon (the stage and the level it was kept at), so a re-assigned agent keeps its stage.
  // The re-assignment itself is the engine's settleMons (it needs mons.ts), idempotent and run at every start.
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
  // The Projects tab as a source of truth (2026-11-16, core/book.ts): the owner's answers on one project, newest first
  // (Decided), and every answer after a time (the search's window; what can cover a blocker, history.ts). Expression
  // indexes: a query uses them only when it repeats json_extract(json, '$.answer.at') exactly. And the cards by state:
  // the row summaries read the open ones on every refresh (padded to 100k cards, that read halves with it).
  `CREATE INDEX decisions_project_answer ON decisions (project, json_extract(json, '$.answer.at'));
   CREATE INDEX decisions_answer_at ON decisions (json_extract(json, '$.answer.at'));
   CREATE INDEX decisions_state ON decisions (state)`,
  // The book's other reads (core/book.ts, Codex review v3): a project's events of one kind newest first (its
  // lead-status history, its merges), its deliverables and its board by time.
  // Without them a sparse kind walks the project's whole log, the reports scan the board and the deliverables sort.
  // And each merged PR's sightings by its URL: a merge counts at its first sighting, looked up here (only merge rows).
  `CREATE INDEX events_project_kind ON events (project, kind, at);
   CREATE INDEX deliverables_project ON deliverables (project, updated_at);
   CREATE INDEX board_project ON board (project, at);
   CREATE INDEX events_merged_ref ON events (ref, project, at) WHERE kind = 'pr' AND value = 'merged'`,
  // Pinned documents (2026-11-17, core/pins.ts): what a project keeps at hand under its message box. A pin names its
  // target (a file and its host, a URL, or a deliverable), never its content; "updated" is read when the tab loads.
  // Unpinning sets unpinned_at (the row stays, for the record). At most PINS_MAX live per project.
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
  // 1.10.0: a thread resolved while its PR stays open because someone else now owns it (orch_resolve handed_off)
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
  // 1.11.0: a project's mode. While scoping, its lead's cards and deliverables wait in the owner's Scope pane only (no
  // CoS triage, no Needs you, no standing rule); the owner's yes on its "Scoping done?" card makes it active. Every
  // project that exists today is active.
  `ALTER TABLE projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'active'`,
  // 1.12.0: scoping tasks, the named parts of a project scoped with the owner while the rest goes the normal way (a project
  // can have several; a name is unique among its open ones). A card or deliverable names its task in its JSON
  // (scope_task); a thread started for one (orch_spawn_thread scope_task) has it on its spawn row, which a handoff moves.
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
  // 1.13.0: when the owner made a thread a task's scoping thread from the Projects view (null for one started with the
  // task): the newest pick plans the task, whenever the thread itself started.
  `ALTER TABLE spawns ADD COLUMN scoped_at INTEGER`,
  // PR waits read their own PR (2026-11-17): a wait on a PR no live environment shows reads it by URL with gh. Its last
  // reading per URL, in prs' terms (sig as prSeen writes it); seen_at is when it last changed, read_at when it was read.
  // Rows go once no open wait names the URL (pruneWaitReadings), and when bb's own reading covers the PR (prSeen).
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
  // Screenshots in the owner's direct messages (2026-11-17): each image the page sent, kept as a file at `path`; item_id
  // is null until a message to that project's lead carries it (n: its place there). source_project: the bb project
  // whose attachments took it (null: the plugin's own folder). Never the bytes.
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
  // The CodeRabbit review queue (2026-11-18, review-queue/store.ts): its whole state as one JSON row, and the run lease
  // that keeps two runs (or two plugin generations) from overlapping.
  `CREATE TABLE review_queue_state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
   CREATE TABLE review_queue_lease (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, expires INTEGER NOT NULL)`,
  // Speed (2026-11-18): an address's last report (lastReport, lastReportAt) is read once per live agent on every agents
  // and scope read; without this each one scanned the whole board and sorted it.
  `CREATE INDEX board_from ON board (from_address, at)`,
  // Speed (2026-11-18): each project's direct line (directLines: the owner's messages to its lead, newest first) is read on
  // every board and projects read; items_recipient (recipient, state) found them but sorted them in a temp B-tree.
  // Descending, so messages of the same millisecond keep the order that sort gave them (oldest of them first).
  `CREATE INDEX items_recipient_kind ON items (recipient, kind, created_at DESC)`,
  // Speed (2026-11-18): the batched inbox's backfill (BatchInbox.sync) looks for open items on every flush and every
  // inbox read; nearly all items are closed, so by state it reads a few rows instead of scanning them all.
  `CREATE INDEX items_state ON items (state)`,
  // PR links (2026-11-19): an environment can hold more than one PR (a second PR after the first merged, or one the
  // thread reported from another branch: core/pr-links.ts), so a PR's row is keyed by environment and URL. prFor reads the
  // newest open one as the thread's PR; the others stay readable by URL.
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
  // The Multiplayer tab (multiplayer/): the owner's boards, the leads' review records, and each watcher's last read.
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
];

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY)`);
  const done = new Set((db.prepare(`SELECT id FROM _migrations`).all() as { id: number }[]).map((r) => r.id));
  MIGRATIONS.forEach((sql, i) => {
    if (done.has(i)) return;
    tx(db, () => {
      db.exec(sql);
      db.prepare(`INSERT INTO _migrations (id) VALUES (?)`).run(i);
    });
  });
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
