// Unread mail and wake delivery are separate durable records. A wake never acknowledges mail.
import { randomBytes } from "node:crypto";
import { tx, type Db } from "./db.ts";
import { EngineError, type Agent, type Item } from "./model.ts";
import type { DeliverResult } from "./engine.ts";

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
}
const token = () => randomBytes(16).toString("hex");
/** Characters of digest a wake carries before it says "more: read orch_inbox" (live digests ran 1-5k, median 2.8k). */
export const WAKE_DIGEST_CAP = 16_000;

/** acked_at of a dead letter's entry: out of the unread, but never read. */
const DROPPED = -1;

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
    // Named, idempotent schema: independent of the numbered migrations in the external-mail PR.
    db.exec(`CREATE TABLE IF NOT EXISTS inbox_entries (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL UNIQUE,
      recipient TEXT NOT NULL, severity TEXT NOT NULL, needs_reply INTEGER NOT NULL,
      due_at INTEGER, acked_at INTEGER);
      CREATE INDEX IF NOT EXISTS inbox_unread ON inbox_entries(recipient, acked_at, seq);
      CREATE TABLE IF NOT EXISTS inbox_reads (
      token TEXT PRIMARY KEY, recipient TEXT NOT NULL, thread_id TEXT NOT NULL, through_seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox_wakes (
      recipient TEXT PRIMARY KEY, token TEXT NOT NULL, state TEXT NOT NULL, due_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, last_at INTEGER, queued_id TEXT, through_seq INTEGER NOT NULL, note TEXT);
`);
  }

  sync(): void {
    // The open states by name (an item is pending, queued, delivered, closed or dead), so items_state finds the few open
    // ones instead of this scanning every item ever sent: it runs on every flush and every inbox read (2026-11-18, speed).
    // Imported mail (external_mail) keeps its own policy: its severity, needs-reply and deadline, not the item's needs_ack.
    this.db.exec(`      INSERT OR IGNORE INTO inbox_entries(item_id,recipient,severity,needs_reply,due_at)
      SELECT i.id,i.recipient,
        CASE WHEN x.item_id IS NOT NULL THEN (CASE WHEN json_extract(x.json,'$.severity')='INFO' THEN 'INFO' ELSE 'ACTION' END)
             WHEN i.needs_ack=1 OR i.kind IN ('alarm','decision.new') THEN 'ACTION' ELSE 'INFO' END,
        CASE WHEN x.item_id IS NOT NULL THEN COALESCE(json_extract(x.json,'$.needsReply'),0) ELSE i.needs_ack END,
        x.due_at
      FROM items i LEFT JOIN external_mail x ON x.item_id=i.id
      WHERE i.state IN ('pending','queued','delivered') AND NOT EXISTS (SELECT 1 FROM inbox_entries e WHERE e.item_id=i.id) ORDER BY i.created_at,i.rowid;`);
  }

  /** An item's read time (its cursor ack) and its recipient's wake, if one covers it, for receipts. */
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
      .prepare(`INSERT OR IGNORE INTO inbox_entries(item_id,recipient,severity,needs_reply,due_at) VALUES(?,?,?,?,?)`)
      .run(it.id, it.recipient, severity, policy.needsReply === true ? 1 : 0, policy.dueAt ?? null);
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

  /**
   * Every unread item, oldest first, with a cursor that covers exactly what it shows. With a cap (a wake's digest), it
   * stops before the item that would pass it (always showing one) and says how many more are unread: never a silent cut.
   */
  read(a: Agent, cap = Infinity): { text: string; cursor: string | null; count: number; more: number } {
    this.sync();
    return tx(this.db, () => {
      const all = this.unread(a.address);
      const parts: string[] = [];
      let size = 0;
      for (const r of all) {
        const part = `\n[${r.item_id}] ${r.kind} from ${r.sender}${r.ref ? `; ref=${r.ref}` : ""}; ${r.severity}${r.outcome ? "; outcome" : ""}${r.needs_reply ? "; needsReply" : ""}${r.due_at != null ? `; dueAt=${r.due_at}` : ""}\n${this.render(r.item_id) ?? r.body}`;
        if (parts.length && size + part.length > cap) break;
        parts.push(part);
        size += part.length;
      }
      const rows = all.slice(0, parts.length);
      const more = all.length - rows.length;
      const cursor = rows.length ? token() : null;
      if (cursor) this.db.prepare(`INSERT INTO inbox_reads VALUES(?,?,?,?)`).run(cursor, a.address, a.threadId, rows.at(-1)!.seq);
      return {
        cursor,
        count: rows.length,
        more,
        // The rules are said once here, not on every item (2026-11-19, tokens): each item carries only its own flags.
        text: rows.length
          ? `${more ? `${rows.length} of ${all.length}` : rows.length} unread, oldest first. After handling, orch_ack(through=${JSON.stringify(cursor)}) marks them read and closes what needs no outcome. Items marked "outcome" stay open until orch_ack(id, outcome) or a reply with ref=<its id>; decisions still use orch_ack(id, outcome).${rows.some((r) => r.kind === "copy") ? " Copies are read-only: no ack or reply." : ""}\n` +
            parts.join("\n") +
            (more ? `\n\n${more} more unread, not shown here and not covered by this cursor: read them with orch_inbox.` : "")
          : "No unread mail.",
      };
    });
  }

  ack(a: Agent, cursor: string): number {
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
      this.db.prepare(`UPDATE inbox_entries SET acked_at=? WHERE recipient=? AND seq<=? AND acked_at IS NULL`).run(this.now(), a.address, r.through_seq);
      // Do not cancel a queued wake: the same queue row can wake for remaining/new mail.
      this.db.prepare(`DELETE FROM inbox_wakes WHERE recipient=? AND through_seq<=? AND state NOT IN ('queued','sending')`).run(a.address, r.through_seq);
      return rows.length;
    });
  }

  reroute(id: string, recipient: string): void {
    // A moved item is a new arrival: an older cursor issued to the new recipient cannot consume it.
    const moved = this.db
      .prepare(`UPDATE inbox_entries SET recipient=?, seq=(SELECT COALESCE(MAX(seq),0)+1 FROM inbox_entries),acked_at=NULL WHERE item_id=?`)
      .run(recipient, id) as { changes: number | bigint };
    if (Number(moved.changes) === 0) this.sync(); // a dead letter from before batching has no entry: the backfill adds it
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
   * All of an address's unread is dropped (2026-11-17): it is an address nothing reads, the engine's own, whose items its
   * cards' acks close. Its wake goes once no unread is left under it (flush clears it).
   */
  droppedFor(address: string): void {
    this.db.prepare(`UPDATE inbox_entries SET acked_at=? WHERE recipient=? AND acked_at IS NULL`).run(DROPPED, address);
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
  rewake(address: string): void {
    this.db
      .prepare(`UPDATE inbox_wakes SET state='pending',attempts=0,due_at=?,queued_id=NULL,note=NULL WHERE recipient=? AND state IN ('dead','sent','uncertain')`)
      .run(this.now(), address);
  }
  retry(address: string): void {
    this.db
      .prepare(`UPDATE inbox_wakes SET state='pending',attempts=0,due_at=?,queued_id=NULL,note=NULL WHERE recipient=? AND state='dead'`)
      .run(this.now(), address);
  }
  dispatched(id: string): void {
    this.db.prepare(`UPDATE inbox_wakes SET state='sent',last_at=?,queued_id=NULL WHERE queued_id=? AND state='queued'`).run(this.now(), id);
    this.clearAcknowledgedWakes();
  }
  /** A queued wake was removed before it went: it is dead. Returns the wake, for the engine to tell the CoS. */
  cancelled(id: string): { recipient: string; token: string; note: string } | null {
    const w = this.db.prepare(`SELECT recipient, token FROM inbox_wakes WHERE queued_id=? AND state!='dead'`).get(id) as { recipient: string; token: string } | undefined;
    const note = "queued wake cancelled; unread mail retained";
    this.db.prepare(`UPDATE inbox_wakes SET state='dead',note=? WHERE queued_id=?`).run(note, id);
    return w ? { ...w, note } : null;
  }
  missingQueue(id: string): void {
    // Absence after downtime is not proof of dispatch. Retry the wake after the timeout; never close mail.
    this.db
      .prepare(`UPDATE inbox_wakes SET state='uncertain',last_at=?,queued_id=NULL,note='queue absent after downtime' WHERE queued_id=?`)
      .run(this.now(), id);
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
    const rows = this.db
      .prepare(
        `SELECT recipient, item_id FROM inbox_entries WHERE acked_at IS NULL
      AND (severity!='INFO' OR needs_reply=1 OR (due_at IS NOT NULL AND due_at<=?)) ORDER BY seq`,
      )
      .all(now) as { recipient: string; item_id: string }[];
    const actionable = [...new Set(rows.filter((r) => !o.paused?.(r.item_id)).map((r) => r.recipient))].map((recipient) => ({ recipient }));
    for (const { recipient } of actionable) {
      if (this.inflight.has(recipient)) continue;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO inbox_wakes(recipient,token,state,due_at,through_seq) VALUES(?,?,'pending',?,(SELECT MAX(seq) FROM inbox_entries WHERE recipient=? AND acked_at IS NULL))`,
        )
        .run(recipient, token(), now + o.debounceMs, recipient);
      let w = this.db.prepare(`SELECT * FROM inbox_wakes WHERE recipient=?`).get(recipient) as Wake | undefined;
      // Its mail was read and acked while this flush waited on an earlier recipient's delivery: nothing is left to wake
      // for, so no wake row was made. Reading w.state threw and dropped the rest of the flush (and the clock's pass).
      if (!w) continue;
      const a = o.agent(recipient);
      if (!a || o.held(a) || !["idle", "unknown", "error"].includes(a.status)) continue;
      if (["sent", "sending", "uncertain"].includes(w.state) && now - Math.max(w.last_at ?? now, a.idleAt ?? 0) >= o.retryMs) {
        const state = w.attempts >= 2 ? "dead" : "pending";
        this.db
          .prepare(`UPDATE inbox_wakes SET state=?,due_at=?,note=? WHERE recipient=?`)
          .run(state, now, state === "dead" ? "wake unacknowledged after two attempts; unread mail retained" : null, recipient);
        w = this.db.prepare(`SELECT * FROM inbox_wakes WHERE recipient=?`).get(recipient) as Wake;
        if (state === "dead") {
          o.log(`inbox wake dead for ${recipient}; unread retained; CoS may retry through orch_inbox`);
          o.dead?.(recipient, w.token, w.note ?? "wake unacknowledged after two attempts");
        }
      }
      if (w.state !== "pending" || w.due_at > now) continue;
      this.inflight.add(recipient);
      // Persist before the async SDK boundary: crash recovery retries only this wake, never the messages.
      const claim = this.db
        .prepare(`UPDATE inbox_wakes SET state='sending',attempts=attempts+1,last_at=? WHERE recipient=? AND token=? AND state='pending'`)
        .run(now, recipient, w.token) as { changes: number | bigint };
      if (!Number(claim.changes)) {
        this.inflight.delete(recipient);
        continue;
      }
      try {
        // The wake carries the digest (2026-11-19, tokens: the orch_inbox call every wake began with was 4.6% of a
        // host's spend). Its cursor covers only what it shows; later mail stays unread and gets its own wake.
        const bare = `[orchestrator] Inbox wake ${w.token}. Actionable unread mail is waiting. Read ALL unread with orch_inbox, handle the digest, then orch_ack(through=<returned cursor>). This wake is not the mail; unread persists until acknowledged.`;
        const d = this.read(a, WAKE_DIGEST_CAP);
        const text = d.cursor
          ? `[orchestrator] Inbox wake ${w.token}. This is your digest: handle it, then orch_ack with its cursor; no orch_inbox call needed. ${d.text}`
          : bare;
        const result = await o.deliver(a, text, w.token, bare);
        if (result.delivery === "held")
          this.db
            .prepare(`UPDATE inbox_wakes SET state='pending',attempts=attempts-1,due_at=? WHERE recipient=? AND token=?`)
            .run(this.now() + o.debounceMs, recipient, w.token);
        else
          this.db
            .prepare(`UPDATE inbox_wakes SET state=?,queued_id=?,last_at=? WHERE recipient=? AND token=?`)
            .run(
              result.delivery === "queued" ? "queued" : "sent",
              result.delivery === "queued" ? result.queuedMessageId : null,
              this.now(),
              recipient,
              w.token,
            );
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
