// Requested 2026-11-17: opt-in retention. Nothing used to delete mail, cards, PR waits, the Board or the activity log, so
// data.db only grew. Each setting is in days, 0 (the default) keeps everything as before. Only what is finished and old
// goes: anything open, or still pointed at by something open, stays, whatever its age. Agents, projects, deliverables,
// outputs, rules, rule offers, pins, XP, dreams and imported mail (its row is the import's de-duplication) are never pruned.
import type { Db } from "./db.ts";

export const DAY_MS = 86_400_000;

export interface Retention {
  /** Finished mail, settled cards, closed PR waits, old Board rows and Steward alarms; 0 keeps them. */
  retentionDays: number;
  /** The activity log (`events`, the project pages' history); 0 keeps it. */
  activityRetentionDays: number;
}

export type PruneCounts = Record<string, number>;

const LIVE = `(SELECT address FROM agents WHERE retired_at IS NULL)`;
/** A finished card: acked (not by a reply, which still waits on its ack) or withdrawn (moot, bounced, superseded). */
const done = (t: string) => `(${t}.state = 'withdrawn' OR (${t}.state = 'acked' AND COALESCE(json_extract(${t}.json, '$.ack.outcome'), '') <> 'replied'))`;

/** In order: a later statement sees what the earlier ones removed (the alarms go before the mail they point at). Each `?` is the cutoff. */
function statements(hasInbox: boolean): { table: string; sql: string; setting: keyof Retention }[] {
  return [
    { table: "waits", setting: "retentionDays", sql: `DELETE FROM waits WHERE closed_at IS NOT NULL AND closed_at < ?` },
    // the newest alarm stays: the sampler restores its level from it after a restart
    {
      table: "alarms",
      setting: "retentionDays",
      sql: `DELETE FROM alarms WHERE at < ? AND id <> (SELECT id FROM alarms ORDER BY at DESC LIMIT 1)
        AND (item_id IS NULL OR item_id NOT IN (SELECT id FROM items WHERE state <> 'closed'))`,
    },
    // a merged card goes once the card it was merged into is finished (or gone); a live lead's plan stays (its thread slots)
    {
      table: "decisions",
      setting: "retentionDays",
      sql: `DELETE FROM decisions AS d WHERE d.updated_at < ?
        AND (${done("d")} OR (d.state = 'merged' AND NOT EXISTS (SELECT 1 FROM decisions t WHERE t.id = json_extract(d.json, '$.merged_into') AND NOT ${done("t")})))
        AND d.id NOT IN (SELECT ref FROM items WHERE ref IS NOT NULL AND state <> 'closed')
        AND d.id NOT IN (SELECT ref FROM waits WHERE closed_at IS NULL)
        AND d.id NOT IN (SELECT decision_id FROM dream_batches WHERE decision_id IS NOT NULL)
        AND d.id NOT IN (SELECT source FROM rules WHERE revoked_at IS NULL)
        AND NOT (json_extract(d.json, '$.kind') = 'plan' AND d.asker IN ${LIVE})
        RETURNING id`,
    },
    // closed mail only (a dead letter waits on the CoS); kept while an open item, wait, alarm, deliverable or card names it
    {
      table: "items",
      setting: "retentionDays",
      sql: `DELETE FROM items WHERE state = 'closed' AND closed_at < ?
        AND id NOT IN (SELECT item_id FROM external_mail)
        AND id NOT IN (SELECT item_id FROM waits WHERE closed_at IS NULL AND item_id IS NOT NULL)
        AND id NOT IN (SELECT item_id FROM alarms WHERE item_id IS NOT NULL)
        AND id NOT IN (SELECT ref FROM items WHERE ref IS NOT NULL AND state <> 'closed')
        AND id NOT IN (SELECT json_extract(json, '$.next.item') FROM deliverables WHERE json_extract(json, '$.next.item') IS NOT NULL)
        AND id NOT IN (SELECT json_extract(json, '$.deferred.item') FROM decisions WHERE json_extract(json, '$.deferred.item') IS NOT NULL)
        ${hasInbox ? `AND id NOT IN (SELECT item_id FROM inbox_entries WHERE acked_at IS NULL)` : ""}`,
    },
    // the batched inbox's read marks of the mail just deleted
    ...(hasInbox ? [{ table: "inbox_entries", setting: "retentionDays" as const, sql: `DELETE FROM inbox_entries WHERE acked_at IS NOT NULL AND item_id NOT IN (SELECT id FROM items)` }] : []),
    // a resolve or archive row is how a retired thread is known to be resolved; a live agent's rows date its last report
    {
      table: "board",
      setting: "retentionDays",
      sql: `DELETE FROM board WHERE at < ? AND kind NOT IN ('resolved', 'archived') AND (from_address IS NULL OR from_address NOT IN ${LIVE})`,
    },
    // each thread's latest status and every live agent's spawn stay, so its timeline bar keeps a colour and a start
    {
      table: "events",
      setting: "activityRetentionDays",
      sql: `DELETE FROM events WHERE at < ?
        AND seq NOT IN (SELECT MAX(seq) FROM events WHERE kind = 'status' GROUP BY thread_id)
        AND NOT (kind = 'spawn' AND address IN ${LIVE})`,
    },
  ];
}

/**
 * Delete what the settings let go, in one transaction; a dry run rolls it back, so its counts are exactly what a real
 * run would delete. Returns the count per table (only the tables a non-zero setting covers) and the deleted cards' ids
 * (their state-folder mirrors go too). Never inside another transaction (tx): it runs from the clock and the CLI only.
 */
export function prune(db: Db, now: number, r: Retention, dryRun = false): { counts: PruneCounts; decisions: string[] } {
  const counts: PruneCounts = {};
  let decisions: string[] = [];
  const days = (k: keyof Retention) => (Number.isFinite(r[k]) && r[k] > 0 ? r[k] : 0);
  if (!days("retentionDays") && !days("activityRetentionDays")) return { counts, decisions };
  const hasInbox = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inbox_entries'`).get();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const s of statements(hasInbox)) {
      if (!days(s.setting)) continue;
      const args = s.sql.includes("?") ? [now - days(s.setting) * DAY_MS] : [];
      if (s.table === "decisions") {
        decisions = (db.prepare(s.sql).all(...args) as { id: string }[]).map((x) => x.id);
        counts.decisions = decisions.length;
      } else counts[s.table] = Number((db.prepare(s.sql).run(...args) as { changes: number | bigint }).changes);
    }
    db.exec(dryRun ? "ROLLBACK" : "COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { counts, decisions };
}

/** "decisions 12, items 340, …" for the CLI and the log. */
export const pruneSummary = (c: PruneCounts): string =>
  Object.keys(c).length ? Object.entries(c).map(([t, n]) => `${t} ${n}`).join(", ") : "retention is off (retentionDays and activityRetentionDays are 0)";
