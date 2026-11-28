// Unread mail and wake delivery are separate durable records. A wake never acknowledges mail.
import { createHash, randomBytes } from "node:crypto";
import { addColumn, tx, type Db } from "./db.ts";
import { EngineError, type Agent, type Item } from "./model.ts";
import type { DeliverResult } from "./engine.ts";
import { UNTRUSTED_LABEL } from "./integration.ts";

export interface MailPolicy {
  severity?: "INFO" | "ACTION";
  needsReply?: boolean;
  dueAt?: number | null;
}
interface Entry {
  seq: number;
  item_id: string;
  recipient: string;
  severity: string;
  needs_reply: number;
  due_at: number | null;
  created_at: number;
  body: string;
  sender: string;
  kind: string;
  ref: string | null;
  /** 1 when only orch_ack(id, outcome) or a ref'd reply closes it (needs_ack, or imported) */
  outcome: number;
}
interface Wake {
  recipient: string;
  token: string;
  state: string;
  due_at: number;
  attempts: number;
  last_at: number | null;
  queued_id: string | null;
  through_seq: number;
  note: string | null;
  recover_on_idle: number;
}
interface InboxPage {
  text: string;
  cursor: string | null;
  count: number;
  more: number;
}

export const inboxToolResult = (text: string) => ({ content: [{ type: "text" as const, text }] });
export const inboxResponseBytes = (text: string) => Buffer.byteLength(JSON.stringify(inboxToolResult(text)));

const ACTIONABLE_SINCE = `MAX(COALESCE(e.arrived_at,i.created_at), COALESCE(e.due_at,0))`;
const token = () => randomBytes(16).toString("hex");
export const WAKE_DIGEST_CAP = 16_000;
// Codex may cut the middle of tool output past 10,000 estimated tokens.
export const INBOX_READ_BUDGET = 32_000;
/** A dead wake re-arms by itself once this long has passed, at most REARM_CAP times per thread in REARM_WINDOW_MS. */
export const REARM_COOLDOWN_MS = 15 * 60_000;
export const REARM_CAP = 3;
export const REARM_WINDOW_MS = 6 * 3_600_000;

/** acked_at of a dead letter's entry: out of the unread, but never read. */
export const DROPPED = -1;
const RESTARTED = "restarted";
const REARMS_PER_TICK = 2;
const REARM_PACE_MS = 5_000;
/** Who the wake gap holds: leads only. */
const gapped = (recipient: string) => recipient.startsWith("lead:");

export class BatchInbox {
  private inflight = new Set<string>();
  private db: Db;
  private now: () => number;
  /** An item's text as its recipient reads it (the engine's render): its own ack/reply line and any label. */
  private render: (itemId: string) => string | null;
  constructor(db: Db, now: () => number, render: (itemId: string) => string | null = () => null) {
    this.db = db;
    this.now = now;
    this.render = render;
    // Named, idempotent schema, outside the numbered migrations.
    db.exec(`CREATE TABLE IF NOT EXISTS inbox_entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL UNIQUE,
      recipient TEXT NOT NULL, severity TEXT NOT NULL, needs_reply INTEGER NOT NULL,
      due_at INTEGER, acked_at INTEGER, arrived_at INTEGER);
      CREATE INDEX IF NOT EXISTS inbox_unread ON inbox_entries(recipient, acked_at, seq);
      -- here, not in MIGRATIONS: this table is made after the migrations run
      CREATE INDEX IF NOT EXISTS inbox_actionable ON inbox_entries(seq) WHERE acked_at IS NULL;
      CREATE TABLE IF NOT EXISTS inbox_reads (
      token TEXT PRIMARY KEY, recipient TEXT NOT NULL, thread_id TEXT NOT NULL, through_seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox_read_parts (
      seq INTEGER NOT NULL, thread_id TEXT NOT NULL, body_hash TEXT NOT NULL, part INTEGER NOT NULL,
      PRIMARY KEY(seq, thread_id, body_hash, part));
      CREATE TABLE IF NOT EXISTS inbox_wakes (
      recipient TEXT PRIMARY KEY, token TEXT NOT NULL, state TEXT NOT NULL, due_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, last_at INTEGER, queued_id TEXT, through_seq INTEGER NOT NULL, note TEXT, recover_on_idle INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS inbox_wake_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT NOT NULL, thread_id TEXT NOT NULL, token TEXT NOT NULL,
      attempt INTEGER NOT NULL, at INTEGER NOT NULL, delivery TEXT NOT NULL, queued_id TEXT, items INTEGER NOT NULL, actionable INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS inbox_wake_log_by ON inbox_wake_log(recipient, at);
      CREATE TABLE IF NOT EXISTS inbox_wake_rearms (
        recipient TEXT NOT NULL, thread_id TEXT NOT NULL, at INTEGER NOT NULL, token TEXT, immediate_through_seq INTEGER);
      CREATE INDEX IF NOT EXISTS inbox_wake_rearms_by ON inbox_wake_rearms(recipient, thread_id, at);
`);
    tx(db, () => {
      addColumn(db, "inbox_entries", "arrived_at", "INTEGER");
      addColumn(db, "inbox_wakes", "recover_on_idle", "INTEGER NOT NULL DEFAULT 0");
      db.exec(`INSERT INTO sqlite_sequence(name,seq) SELECT 'inbox_entries',0
        WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='inbox_entries');
        UPDATE sqlite_sequence SET seq=MAX(seq,
          COALESCE((SELECT MAX(seq) FROM inbox_entries),0),
          COALESCE((SELECT MAX(through_seq) FROM inbox_reads),0),
          COALESCE((SELECT MAX(through_seq) FROM inbox_wakes),0))
        WHERE name='inbox_entries'`);
      addColumn(db, "inbox_wake_rearms", "token", "TEXT");
      addColumn(db, "inbox_wake_rearms", "immediate_through_seq", "INTEGER");
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS inbox_wake_rearms_token ON inbox_wake_rearms(token) WHERE token IS NOT NULL;
        CREATE INDEX IF NOT EXISTS inbox_wake_rearms_at ON inbox_wake_rearms(at)`);
    });
  }

  sync(): void {
    // Open states by name so items_state is used. Imported mail keeps its own severity, needs-reply and deadline.
    this.db.exec(`      INSERT OR IGNORE INTO inbox_entries(item_id,recipient,severity,needs_reply,due_at,arrived_at)
      SELECT i.id,i.recipient,
        CASE WHEN x.item_id IS NOT NULL THEN (CASE WHEN json_extract(x.json,'$.severity')='INFO' THEN 'INFO' ELSE 'ACTION' END)
             WHEN i.needs_ack=1 OR i.kind IN ('alarm','decision.new') THEN 'ACTION' ELSE 'INFO' END,
        CASE WHEN x.item_id IS NOT NULL THEN COALESCE(json_extract(x.json,'$.needsReply'),0) ELSE i.needs_ack END,
        x.due_at,i.created_at
      FROM items i LEFT JOIN external_mail x ON x.item_id=i.id
      WHERE i.state IN ('pending','queued','delivered') AND NOT EXISTS (SELECT 1 FROM inbox_entries e WHERE e.item_id=i.id) ORDER BY i.created_at,i.rowid;`);
  }

  /** When the recipient read an item (acked it in a batch), null if not yet or dropped: receipt's readAt, without the wake. */
  readAt(itemId: string): number | null {
    const e = this.db.prepare(`SELECT acked_at FROM inbox_entries WHERE item_id=?`).get(itemId) as { acked_at: number | null } | undefined;
    return !e || e.acked_at === DROPPED ? null : e.acked_at;
  }

  receipt(itemId: string): { readAt: number | null; wake: string | null } {
    const e = this.db.prepare(`SELECT recipient, seq, acked_at FROM inbox_entries WHERE item_id=?`).get(itemId) as { recipient: string; seq: number; acked_at: number | null } | undefined;
    if (!e) return { readAt: null, wake: null };
    const w = e.acked_at === null ? (this.db.prepare(`SELECT state FROM inbox_wakes WHERE recipient=? AND through_seq>=?`).get(e.recipient, e.seq) as { state: string } | undefined) : undefined;
    return { readAt: e.acked_at === DROPPED ? null : e.acked_at, wake: w?.state ?? null };
  }

  record(it: Item, policy: MailPolicy = {}): void {
    const severity = policy.severity ?? (it.needsAck || it.kind === "alarm" || it.kind === "decision.new" ? "ACTION" : "INFO");
    if (!["ACTION", "INFO"].includes(severity) || (policy.dueAt != null && (!Number.isSafeInteger(policy.dueAt) || policy.dueAt < 0)))
      throw new EngineError("invalid", "invalid severity or due time");
    this.db
      .prepare(`INSERT OR IGNORE INTO inbox_entries(item_id,recipient,severity,needs_reply,due_at,arrived_at) VALUES(?,?,?,?,?,?)`)
      .run(it.id, it.recipient, severity, policy.needsReply === true ? 1 : 0, policy.dueAt ?? null, this.now());
  }

  policy(id: string, policy: MailPolicy): void {
    if (policy.severity !== undefined && !["INFO", "ACTION"].includes(policy.severity)) throw new EngineError("invalid", "invalid severity");
    if (policy.dueAt != null && (!Number.isSafeInteger(policy.dueAt) || policy.dueAt < 0)) throw new EngineError("invalid", "invalid due time");
    this.db
      .prepare(`UPDATE inbox_entries SET severity=?,needs_reply=?,due_at=? WHERE item_id=?`)
      .run(policy.severity ?? "ACTION", policy.needsReply === true ? 1 : 0, policy.dueAt ?? null, id);
  }

  private unread(address: string): Entry[] {
    return this.db
      .prepare(
        `SELECT e.*,i.created_at,i.body,i.sender,i.kind,i.ref,(i.needs_ack=1 OR EXISTS (SELECT 1 FROM external_mail x WHERE x.item_id=i.id)) AS outcome FROM inbox_entries e JOIN items i ON i.id=e.item_id
      WHERE e.recipient=? AND e.acked_at IS NULL ORDER BY e.seq`,
      )
      .all(address) as Entry[];
  }

  private chunks(body: string): string[] {
    return body.match(/[\s\S]{1,4096}/gu) ?? [""];
  }

  private stub(id: string, body: string): string {
    const preview = body.match(/^[\s\S]{0,320}/u)![0];
    return `${preview}…\nRead all ${this.chunks(body).length} parts with orch_inbox(id="${id}", part=1), then read the inbox again for a cursor.`;
  }

  private partKey(a: Agent, seq: number, id: string, body: string): [number, string, string] {
    return [seq, a.threadId, createHash("sha256").update(id).update(body, "utf16le").digest("hex")];
  }

  readItem(a: Agent, item: Item, body: string, rendered: string, part?: number): string {
    const id = item.id;
    if (part === undefined) return inboxResponseBytes(rendered) <= INBOX_READ_BUDGET
      ? rendered : `[${id}] ${item.kind} from ${item.sender}\n${this.stub(id, body)}`;
    const chunks = this.chunks(body);
    const chunk = chunks[part - 1];
    if (chunk === undefined) throw new EngineError("invalid", `part must be between 1 and ${chunks.length}`);
    const external = item.sender.startsWith("external:");
    const label = external && part > 1 ? `[${UNTRUSTED_LABEL}]\n` : "";
    const quote = external && part > 1 && !chunks[part - 2]!.endsWith("\n") ? "> " : "";
    const text = `[${id}] Part ${part} of ${chunks.length} from ${item.sender}\n${label}${quote}${chunk}`;
    this.sync();
    const row = this.db.prepare(`SELECT seq FROM inbox_entries WHERE item_id=? AND recipient=? AND acked_at IS NULL`).get(id, a.address) as { seq: number } | undefined;
    if (row) this.db.prepare(`INSERT OR IGNORE INTO inbox_read_parts VALUES(?,?,?,?)`).run(...this.partKey(a, row.seq, id, body), part);
    return text;
  }

  read(a: Agent, cap = INBOX_READ_BUDGET, size = (page: InboxPage) => inboxResponseBytes(JSON.stringify(page))): InboxPage {
    this.sync();
    return tx(this.db, () => {
      const all = this.unread(a.address);
      const cursor = randomBytes(32).toString("hex");
      const parts: string[] = [];
      const page = (count: number, lines: string[], stubbed = false): InboxPage => {
        const more = all.length - count;
        const summary = count
          ? `${more ? `${count} of ${all.length}` : count} unread, oldest first. After handling, orch_ack(through=${JSON.stringify(cursor)}) marks them read and closes what needs no outcome. Items marked "outcome" stay open until orch_ack(id, outcome) or a reply with ref=<its id>; decisions still use orch_ack(id, outcome).${all.slice(0, count).some((r) => r.kind === "copy") ? " Copies are read-only: no ack or reply." : ""}\n`
          : all.length ? `${all.length} unread. No ack cursor yet.\n` : "No unread mail.";
        return {
          cursor: count ? cursor : null,
          count,
          more,
          text: summary + lines.join("\n") + (more && count && !stubbed ? `\n\n${more} more unread, not shown here and not covered by this cursor: ack this cursor, then read them with orch_inbox.` : ""),
        };
      };
      let result = page(0, []);
      for (const r of all) {
        const ref = r.ref && r.ref.length > 96 ? `${r.ref.slice(0, 96)}…` : r.ref;
        const head = `\n[${r.item_id}] ${r.kind} from ${r.sender}${ref ? `; ref=${ref}` : ""}; ${r.severity}${r.outcome ? "; outcome" : ""}${r.needs_reply ? "; needsReply" : ""}${r.due_at != null ? `; dueAt=${r.due_at}` : ""}\n`;
        const body = this.render(r.item_id) ?? r.body;
        let part = head + body;
        if (size(page(parts.length + 1, [...parts, part])) > cap) {
          const read = this.db.prepare(`SELECT COUNT(*) AS n FROM inbox_read_parts WHERE seq=? AND thread_id=? AND body_hash=?`).get(...this.partKey(a, r.seq, r.item_id, body)) as { n: number };
          if (read.n !== this.chunks(body).length) {
            if (!parts.length) {
              const stub = page(0, [head + this.stub(r.item_id, body)], true);
              if (size(stub) <= cap) result = stub;
            }
            break;
          }
          part = head + "All parts read with orch_inbox.";
          if (size(page(parts.length + 1, [...parts, part])) > cap) break;
        }
        parts.push(part);
        result = page(parts.length, parts);
      }
      if (size(result) > cap || (!result.count && all.length && result.text === page(0, []).text))
        throw new EngineError("invalid", "inbox budget is too small for the first item header");
      if (result.cursor)
        this.db.prepare(`INSERT INTO inbox_reads VALUES(?,?,?,?)`).run(result.cursor, a.address, a.threadId, all[result.count - 1]!.seq);
      return result;
    });
  }

  ack(a: Agent, cursor: string): number {
    if (!/^[0-9a-f]{64}$/.test(cursor)) throw new EngineError("forbidden", "ack-through requires a new cursor from orch_inbox");
    return tx(this.db, () => {
      const r = this.db.prepare(`SELECT * FROM inbox_reads WHERE token=? AND recipient=? AND thread_id=?`).get(cursor, a.address, a.threadId) as
        | { through_seq: number }
        | undefined;
      if (!r) throw new EngineError("forbidden", "ack-through requires a cursor issued to this thread's inbox read");
      const rows = this.db.prepare(`SELECT item_id FROM inbox_entries WHERE recipient=? AND seq<=? AND acked_at IS NULL`).all(a.address, r.through_seq) as {
        item_id: string;
      }[];
      // Read is not handled. What needs no outcome closes, as delivery closes it in per-message mode. What asks for an
      // outcome (needs_ack, and every imported item, which only an explicit ack completes) is only marked delivered: its
      // ack note, relay settlement, reply or receipt outcome still has to happen.
      const covered = `(SELECT item_id FROM inbox_entries WHERE recipient=? AND seq<=? AND acked_at IS NULL)`;
      const outcome = `(needs_ack=1 OR id IN (SELECT item_id FROM external_mail))`;
      this.db
        .prepare(`UPDATE items SET state='closed',closed_at=?,outcome=COALESCE(outcome,'read') WHERE id IN ${covered} AND NOT ${outcome} AND state IN ('pending','queued','delivered','dead')`)
        .run(this.now(), a.address, r.through_seq);
      this.db
        .prepare(`UPDATE items SET state='delivered',delivered_at=COALESCE(delivered_at,?) WHERE id IN ${covered} AND ${outcome} AND state='pending'`)
        .run(this.now(), a.address, r.through_seq);
      this.db.prepare(`DELETE FROM inbox_read_parts WHERE seq IN (SELECT seq FROM inbox_entries WHERE recipient=? AND seq<=? AND acked_at IS NULL)`).run(a.address, r.through_seq);
      this.db.prepare(`UPDATE inbox_entries SET acked_at=? WHERE recipient=? AND seq<=? AND acked_at IS NULL`).run(this.now(), a.address, r.through_seq);
      // Do not cancel a queued wake: the same queue row can wake for remaining/new mail.
      this.db.prepare(`DELETE FROM inbox_wakes WHERE recipient=? AND through_seq<=? AND state NOT IN ('queued','sending')`).run(a.address, r.through_seq);
      // A cursor ack that reads something answers the wake, even past the digest cap or after it died: what is left gets a fresh one.
      if (rows.length) this.db.prepare(`DELETE FROM inbox_wakes WHERE recipient=? AND state IN ('sent','uncertain','dead')`).run(a.address);
      return rows.length;
    });
  }

  reroute(id: string, recipient: string): void {
    tx(this.db, () => {
      const moved = this.db
        .prepare(`UPDATE inbox_entries SET recipient=?, seq=(SELECT seq+1 FROM sqlite_sequence WHERE name='inbox_entries'),
          acked_at=NULL,arrived_at=? WHERE item_id=?`)
        .run(recipient, this.now(), id) as { changes: number | bigint };
      if (Number(moved.changes)) this.db.exec(`UPDATE sqlite_sequence SET seq=seq+1 WHERE name='inbox_entries'`);
      else this.sync();
    });
  }
  /**
   * A dead letter leaves its address's unread: the CoS handles it, and the next holder never gets it. Its entry stays,
   * with its policy and its place in the sequence, but marked DROPPED rather than read, so a receipt never reports
   * unread mail as read. A resend or re-route makes it unread again; a dead item is never backfilled.
   */
  dropped(id: string): void {
    this.db.prepare(`UPDATE inbox_entries SET acked_at=? WHERE item_id=? AND acked_at IS NULL`).run(DROPPED, id);
  }
  /**
   * All of an address's unread is dropped: it is an address nothing reads, the engine's own, whose items its
   * cards' acks close. Its wake goes once no unread is left under it (flush clears it).
   */
  droppedFor(address: string): void {
    this.db.prepare(`UPDATE inbox_entries SET acked_at=? WHERE recipient=? AND acked_at IS NULL`).run(DROPPED, address);
  }
  dropProject(slug: string): void {
    const worker = `thread:${slug}:`;
    this.db.prepare(`UPDATE inbox_entries SET acked_at=? WHERE acked_at IS NULL AND (recipient=? OR substr(recipient,1,?)=?)`)
      .run(DROPPED, `lead:${slug}`, worker.length, worker);
  }

  handoff(address: string): void {
    // A predecessor's queued wake cannot wake its successor; any late predecessor wake carries no mail.
    this.db.prepare(`DELETE FROM inbox_wakes WHERE recipient=?`).run(address);
  }

  wakes(): Wake[] {
    return this.db.prepare(`SELECT * FROM inbox_wakes ORDER BY due_at`).all() as Wake[];
  }
  /** One item read without a digest (the CoS answered it with its reply tool). */
  readOne(id: string): void {
    this.db.prepare(`UPDATE inbox_entries SET acked_at=? WHERE item_id=? AND acked_at IS NULL`).run(this.now(), id);
  }
  /** The owner's Resend: a wake that went out, is unsure or died starts again now, so the recipient is woken for its unread. */
  rewake(address: string): boolean {
    const updated = this.db
      .prepare(`UPDATE inbox_wakes SET state='pending',token=?,attempts=0,due_at=?,queued_id=NULL,note=?,recover_on_idle=0 WHERE recipient=? AND state IN ('dead','sent','uncertain')`)
      .run(token(), this.now(), RESTARTED, address) as { changes: number | bigint };
    return Number(updated.changes) > 0;
  }
  /** The CoS's retry_wake: as the owner's Resend, for a wake that died or went out unanswered. */
  retry(address: string): void {
    this.rewake(address);
  }

  private rearm(w: Wake, a: Agent, now: number, immediate = false, paused?: (itemId: string) => boolean): boolean {
    return tx(this.db, () => {
      let through: number | null = null;
      if (immediate) {
        const unread = this.actionable(now, a.address).filter((r) => !paused?.(r.item_id));
        if (!unread.length) return false;
        through = unread.at(-1)!.seq;
        const used = this.db.prepare(`SELECT 1 FROM inbox_wake_rearms WHERE recipient=? AND immediate_through_seq>=?`).get(a.address, unread[0]!.seq);
        if (used) return false;
      } else {
        const used = this.db
          .prepare(`SELECT COUNT(*) AS n FROM inbox_wake_rearms WHERE recipient=? AND thread_id=? AND at>?`)
          .get(a.address, a.threadId, now - REARM_WINDOW_MS) as { n: number };
        if (used.n >= REARM_CAP) return false;
      }
      const recent = this.db.prepare(`SELECT COUNT(*) AS n FROM inbox_wake_rearms WHERE at>?`).get(now - REARM_PACE_MS) as { n: number };
      if (recent.n >= REARMS_PER_TICK) {
        if (immediate && !w.recover_on_idle)
          this.db.prepare(`UPDATE inbox_wakes SET recover_on_idle=1 WHERE recipient=? AND token=? AND state='dead'`).run(a.address, w.token);
        return false;
      }
      const next = token();
      const r = this.db
        .prepare(`UPDATE inbox_wakes SET state='pending',token=?,attempts=0,due_at=?,queued_id=NULL,note=NULL,recover_on_idle=0 WHERE recipient=? AND token=? AND state='dead'`)
        .run(next, now, a.address, w.token) as { changes: number | bigint };
      if (!Number(r.changes)) return false;
      this.db.prepare(`INSERT INTO inbox_wake_rearms(recipient,thread_id,at,token,immediate_through_seq) VALUES(?,?,?,?,?)`).run(a.address, a.threadId, now, next, through);
      return true;
    });
  }

  rearmOnIdle(a: Agent, paused: (itemId: string) => boolean): boolean {
    const w = this.db.prepare(`SELECT * FROM inbox_wakes WHERE recipient=? AND state='dead'`).get(a.address) as Wake | undefined;
    return !!w && this.rearm(w, a, this.now(), true, paused);
  }

  wasRearmed(token: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM inbox_wake_rearms WHERE token=?`).get(token);
  }

  private actionable(now: number, address?: string): { recipient: string; item_id: string; seq: number; since: number }[] {
    return this.db
      .prepare(
        `SELECT e.recipient, e.item_id, e.seq, ${ACTIONABLE_SINCE} AS since FROM inbox_entries e JOIN items i ON i.id=e.item_id
      WHERE e.acked_at IS NULL AND (e.severity!='INFO' OR e.needs_reply=1 OR e.due_at<=?) ${address === undefined ? "" : "AND e.recipient=?"} ORDER BY e.seq`,
      )
      .all(...(address === undefined ? [now] : [now, address])) as { recipient: string; item_id: string; seq: number; since: number }[];
  }

  waiting(now: number, paused: (itemId: string) => boolean): Map<string, { since: number; sequences: Set<number> }> {
    const out = new Map<string, { since: number; sequences: Set<number> }>();
    for (const r of this.actionable(now)) {
      if (paused(r.item_id)) continue;
      const cur = out.get(r.recipient);
      if (cur) {
        cur.since = Math.min(cur.since, r.since);
        cur.sequences.add(r.seq);
      } else out.set(r.recipient, { since: r.since, sequences: new Set([r.seq]) });
    }
    return out;
  }

  /** The last time the recipient read mail (a cursor ack, or one item answered), or null. */
  lastRead(address: string): number | null {
    const r = this.db.prepare(`SELECT MAX(acked_at) AS at FROM inbox_entries WHERE recipient=? AND acked_at>0`).get(address) as { at: number | null };
    return r.at;
  }

  /** Whether the recipient's wake is dead, or was re-armed in the window and nothing has been read since. */
  wakeFailing(address: string, now: number): boolean {
    if (this.db.prepare(`SELECT 1 FROM inbox_wakes WHERE recipient=? AND state='dead'`).get(address)) return true;
    const r = this.db.prepare(`SELECT MAX(at) AS at FROM inbox_wake_rearms WHERE recipient=? AND at>?`).get(address, now - REARM_WINDOW_MS) as { at: number | null };
    return r.at !== null && (this.lastRead(address) ?? 0) < r.at;
  }

  wakeState(address: string): string | null {
    return (this.db.prepare(`SELECT state FROM inbox_wakes WHERE recipient=?`).get(address) as { state: string } | undefined)?.state ?? null;
  }
  dispatched(id: string): void {
    this.db.prepare(`UPDATE inbox_wakes SET state='sent',last_at=?,queued_id=NULL WHERE queued_id=? AND state='queued'`).run(this.now(), id);
    // a queued wake starts its turn when bb dispatches it: that is the wake's time for the gap and the counts
    this.db.prepare(`UPDATE inbox_wake_log SET delivery='dispatched',at=? WHERE queued_id=? AND delivery='queued'`).run(this.now(), id);
    this.clearAcknowledgedWakes();
  }
  /** A queued wake was removed before it went: it is dead. Returns the wake, for the engine to tell the CoS. */
  cancelled(id: string): { recipient: string; token: string; note: string } | null {
    const w = this.db.prepare(`SELECT recipient, token FROM inbox_wakes WHERE queued_id=? AND state!='dead'`).get(id) as { recipient: string; token: string } | undefined;
    const note = "queued wake cancelled; unread mail retained";
    this.db.prepare(`UPDATE inbox_wakes SET state='dead',due_at=?,note=? WHERE queued_id=?`).run(this.now(), note, id);
    this.db.prepare(`UPDATE inbox_wake_log SET delivery='cancelled' WHERE queued_id=? AND delivery='queued'`).run(id);
    return w ? { ...w, note } : null;
  }
  missingQueue(id: string): void {
    // Absence after downtime is not proof of dispatch. Retry the wake after the timeout; never close mail.
    this.db
      .prepare(`UPDATE inbox_wakes SET state='uncertain',last_at=?,queued_id=NULL,note='queue absent after downtime' WHERE queued_id=?`)
      .run(this.now(), id);
  }

  /**
   * The last wake that went to this address's current thread (sent, queued or dispatched), or null. Per thread, so a
   * successor after a handoff starts with no gap to wait out.
   */
  lastWake(address: string, threadId: string): number | null {
    const r = this.db.prepare(`SELECT MAX(at) AS at FROM inbox_wake_log WHERE recipient=? AND thread_id=? AND delivery!='cancelled'`).get(address, threadId) as { at: number | null };
    return r.at;
  }

  /** Whether a wake started a turn for this address after `since` (a real turn: wakes only go for actionable mail). */
  wokenSince(address: string, since: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM inbox_wake_log WHERE recipient=? AND at>? AND delivery IN ('sent','dispatched') LIMIT 1`).get(address, since);
  }

  /**
   * Unread that skips the wake gap: anything from the owner (a direct message, a card answer, a deliverable approved,
   * changes asked or a next action) and anything whose deadline has passed. An INFO item from the owner (an approval
   * with no next action) still wakes no one alone, since flush only wakes for actionable mail, but it brings a held
   * wake forward.
   */
  private urgent(address: string, now: number, paused?: (itemId: string) => boolean): boolean {
    const rows = this.db
      .prepare(
        `SELECT e.item_id FROM inbox_entries e JOIN items i ON i.id=e.item_id WHERE e.recipient=? AND e.acked_at IS NULL
      AND (i.sender='person' OR (e.due_at IS NOT NULL AND e.due_at<=?))`,
      )
      .all(address, now) as { item_id: string }[];
    return rows.some((r) => !paused?.(r.item_id));
  }

  /**
   * When the wake timer must next run a flush: the earliest pending wake still to come due, or the earliest unread
   * deadline still to come (an item whose deadline passes makes its wake urgent, or actionable when it is INFO), or
   * null. Without the deadlines, an item due inside a lead's wake gap waited for the gap's end or a clock pass.
   */
  nextDue(now: number, paused?: (itemId: string) => boolean): number | null {
    const wake = this.db.prepare(`SELECT MIN(due_at) AS at FROM inbox_wakes WHERE state='pending' AND due_at>?`).get(now) as { at: number | null };
    let next = wake.at;
    for (const r of this.db.prepare(`SELECT item_id, due_at FROM inbox_entries WHERE acked_at IS NULL AND due_at IS NOT NULL AND due_at>? ORDER BY due_at`).all(now) as { item_id: string; due_at: number }[]) {
      if (paused?.(r.item_id)) continue;
      if (next === null || r.due_at < next) next = r.due_at;
      break;
    }
    return next;
  }

  /**
   * Whether something came due in (since, now], while a flush waited on a delivery: an unread, unpaused deadline, or a
   * pending wake. That flush judged it with the time from before, and nextDue leaves out what is already due.
   */
  cameDue(since: number, now: number, paused?: (itemId: string) => boolean): boolean {
    if (this.db.prepare(`SELECT 1 FROM inbox_wakes WHERE state='pending' AND due_at>? AND due_at<=? LIMIT 1`).get(since, now)) return true;
    const rows = this.db
      .prepare(`SELECT item_id FROM inbox_entries WHERE acked_at IS NULL AND due_at IS NOT NULL AND due_at>? AND due_at<=?`)
      .all(since, now) as { item_id: string }[];
    return rows.some((r) => !paused?.(r.item_id));
  }

  private clearAcknowledgedWakes(): void {
    this.db
      .prepare(
        `DELETE FROM inbox_wakes WHERE state NOT IN ('sending','queued') AND NOT EXISTS
      (SELECT 1 FROM inbox_entries e WHERE e.recipient=inbox_wakes.recipient AND e.seq<=inbox_wakes.through_seq AND e.acked_at IS NULL)`,
      )
      .run();
  }

  async flush(o: {
    debounceMs: number;
    retryMs: number;
    /** A lead's least time between two wakes; 0 is off. Urgent unread, restarts and retries of the same wake skip it. */
    gapMs?: number;
    agent(address: string): Agent | null;
    held(a: Agent): boolean;
    /** bare: the wake without its digest, for a recipient bb will queue it behind (a turn under way) */
    deliver(a: Agent, text: string, token: string, bare: string): Promise<DeliverResult>;
    log(text: string): void;
    /** An item that must not wake anyone now (an imported item whose route is off): it stays unread. */
    paused?(itemId: string): boolean;
    /** A wake just died (once per death): the engine surfaces it to the CoS. */
    dead?(recipient: string, token: string, note: string): void;
  }): Promise<void> {
    this.sync();
    this.clearAcknowledgedWakes();
    const now = this.now();
    // only imported mail can be paused
    const rows = this.db
      .prepare(
        `SELECT e.recipient, e.item_id, x.item_id IS NOT NULL AS ext FROM inbox_entries e LEFT JOIN external_mail x ON x.item_id=e.item_id
      WHERE e.acked_at IS NULL AND (e.severity!='INFO' OR e.needs_reply=1 OR (e.due_at IS NOT NULL AND e.due_at<=?)) ORDER BY e.seq`,
      )
      .all(now) as { recipient: string; item_id: string; ext: number }[];
    const actionable = [...new Set(rows.filter((r) => !(r.ext && o.paused?.(r.item_id))).map((r) => r.recipient))].map((recipient) => ({ recipient }));
    for (const { recipient } of actionable) {
      if (this.inflight.has(recipient)) continue;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO inbox_wakes(recipient,token,state,due_at,through_seq) VALUES(?,?,'pending',?,(SELECT MAX(seq) FROM inbox_entries WHERE recipient=? AND acked_at IS NULL))`,
        )
        .run(recipient, token(), now + o.debounceMs, recipient);
      let w = this.db.prepare(`SELECT * FROM inbox_wakes WHERE recipient=?`).get(recipient) as Wake | undefined;
      // Acked while this flush awaited an earlier delivery: no wake row was made.
      if (!w) continue;
      const a = o.agent(recipient);
      if (!a || o.held(a) || !["idle", "unknown", "error"].includes(a.status)) continue;
      const recovering = w.recover_on_idle === 1 && a.status === "idle";
      const rearmed = w.state === "dead" && (recovering || now - w.due_at >= REARM_COOLDOWN_MS)
        && this.rearm(w, a, this.now(), recovering, o.paused);
      if (rearmed) {
        o.log(`inbox wake re-armed for ${recipient}`);
        w = this.db.prepare(`SELECT * FROM inbox_wakes WHERE recipient=?`).get(recipient) as Wake;
      }
      if (["sent", "sending", "uncertain"].includes(w.state) && now - Math.max(w.last_at ?? now, a.idleAt ?? 0) >= o.retryMs) {
        const state = w.attempts >= 2 ? "dead" : "pending";
        this.db
          .prepare(`UPDATE inbox_wakes SET state=?,due_at=?,note=? WHERE recipient=?`)
          .run(state, now, state === "dead" ? "wake unacknowledged after two attempts; unread mail retained" : w.note, recipient);
        w = this.db.prepare(`SELECT * FROM inbox_wakes WHERE recipient=?`).get(recipient) as Wake;
        if (state === "dead") {
          o.log(`inbox wake dead for ${recipient}; unread retained; CoS may retry through orch_inbox`);
          o.dead?.(recipient, w.token, w.note ?? "wake unacknowledged after two attempts");
        }
      }
      // A lead's wake goes no sooner than gapMs after its last. The deferral is recomputed each flush from the wake's own
      // debounce, never from an earlier deferral, so urgent unread or a lowered gap pulls it back.
      const gap = o.gapMs ?? 0;
      if (w.state === "pending" && w.attempts === 0 && w.note !== RESTARTED && gapped(recipient) && !this.wasRearmed(w.token)) {
        const base = Math.min(w.due_at, now + o.debounceMs);
        const last = gap > 0 ? this.lastWake(recipient, a.threadId) : null;
        const due = this.urgent(recipient, now, o.paused) || last === null ? base : Math.max(base, last + gap);
        if (due !== w.due_at) {
          this.db.prepare(`UPDATE inbox_wakes SET due_at=? WHERE recipient=? AND token=? AND state='pending'`).run(due, recipient, w.token);
          w = { ...w, due_at: due };
        }
      }
      if (w.state !== "pending" || (!rearmed && w.due_at > now)) continue;
      this.inflight.add(recipient);
      // Persist before the async SDK boundary: crash recovery retries only this wake, never the messages.
      const claim = this.db
        .prepare(`UPDATE inbox_wakes SET state='sending',attempts=attempts+1,last_at=? WHERE recipient=? AND token=? AND state='pending'`)
        .run(rearmed ? w.due_at : now, recipient, w.token) as { changes: number | bigint };
      if (!Number(claim.changes)) {
        this.inflight.delete(recipient);
        continue;
      }
      try {
        const bare = `[orchestrator] Inbox wake ${w.token}. Actionable unread mail is waiting. Read unread with orch_inbox a page at a time: handle each page, then orch_ack(through=<its cursor>). This wake is not the mail; unread persists until acknowledged.`;
        const digest = (page: InboxPage) => `[orchestrator] Inbox wake ${w.token}. This is your digest: ${page.cursor
          ? "handle it, then orch_ack with its cursor; no orch_inbox call needed."
          : "follow the reading instructions below."} ${page.text}`;
        const d = this.read(a, WAKE_DIGEST_CAP, (page) => inboxResponseBytes(digest(page)));
        const text = d.count || d.more ? digest(d) : bare;
        const result = await o.deliver(a, text, w.token, bare);
        if (result.delivery === "held")
          this.db
            .prepare(`UPDATE inbox_wakes SET state='pending',attempts=attempts-1,due_at=? WHERE recipient=? AND token=?`)
            .run(this.now() + o.debounceMs, recipient, w.token);
        else {
          const queuedId = result.delivery === "queued" ? result.queuedMessageId : null;
          this.db
            .prepare(`UPDATE inbox_wakes SET state=?,queued_id=?,last_at=? WHERE recipient=? AND token=?`)
            .run(queuedId ? "queued" : "sent", queuedId, this.now(), recipient, w.token);
          // The wake's durable record (inbox_wakes rows go on ack): the gap, the status nudges and count-wakes read it.
          const actionable = this.db
            .prepare(`SELECT COUNT(*) AS n FROM inbox_entries WHERE recipient=? AND acked_at IS NULL AND (severity!='INFO' OR needs_reply=1 OR (due_at IS NOT NULL AND due_at<=?))`)
            .get(recipient, now) as { n: number };
          this.db
            .prepare(`INSERT INTO inbox_wake_log(recipient,thread_id,token,attempt,at,delivery,queued_id,items,actionable) VALUES(?,?,?,?,?,?,?,?,?)`)
            .run(recipient, a.threadId, w.token, w.attempts + 1, this.now(), queuedId ? "queued" : "sent", queuedId, d.count, actionable.n);
        }
      } catch (e) {
        this.db.prepare(`UPDATE inbox_wakes SET state='uncertain',note=? WHERE recipient=? AND token=?`).run(String(e), recipient, w.token);
        o.log(`inbox wake failed for ${recipient}; unread retained`);
      } finally {
        this.inflight.delete(recipient);
        this.clearAcknowledgedWakes();
      }
    }
  }
}
