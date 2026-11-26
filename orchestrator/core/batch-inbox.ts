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
/** Characters of digest a wake carries before it says "more: read orch_inbox". */
export const WAKE_DIGEST_CAP = 16_000;

/** acked_at of a dead letter's entry: out of the unread, but never read. */
export const DROPPED = -1;
/** A wake's note when the owner's Resend or the CoS's retry_wake restarted it: it goes now, gap or not. */
const RESTARTED = "restarted";
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
      due_at INTEGER, acked_at INTEGER);
      CREATE INDEX IF NOT EXISTS inbox_unread ON inbox_entries(recipient, acked_at, seq);
      -- here, not in MIGRATIONS: this table is made after the migrations run
      CREATE INDEX IF NOT EXISTS inbox_actionable ON inbox_entries(seq) WHERE acked_at IS NULL;
      CREATE TABLE IF NOT EXISTS inbox_reads (
      token TEXT PRIMARY KEY, recipient TEXT NOT NULL, thread_id TEXT NOT NULL, through_seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox_wakes (
      recipient TEXT PRIMARY KEY, token TEXT NOT NULL, state TEXT NOT NULL, due_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, last_at INTEGER, queued_id TEXT, through_seq INTEGER NOT NULL, note TEXT);
      CREATE TABLE IF NOT EXISTS inbox_wake_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT NOT NULL, thread_id TEXT NOT NULL, token TEXT NOT NULL,
      attempt INTEGER NOT NULL, at INTEGER NOT NULL, delivery TEXT NOT NULL, queued_id TEXT, items INTEGER NOT NULL, actionable INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS inbox_wake_log_by ON inbox_wake_log(recipient, at);
`);
  }

  sync(): void {
    // Open states by name so items_state is used. Imported mail keeps its own severity, needs-reply and deadline.
    this.db.exec(`      INSERT OR IGNORE INTO inbox_entries(item_id,recipient,severity,needs_reply,due_at)
      SELECT i.id,i.recipient,
        CASE WHEN x.item_id IS NOT NULL THEN (CASE WHEN json_extract(x.json,'$.severity')='INFO' THEN 'INFO' ELSE 'ACTION' END)
             WHEN i.needs_ack=1 OR i.kind IN ('alarm','decision.new') THEN 'ACTION' ELSE 'INFO' END,
        CASE WHEN x.item_id IS NOT NULL THEN COALESCE(json_extract(x.json,'$.needsReply'),0) ELSE i.needs_ack END,
        x.due_at
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
      // A cursor ack answers the sent wake even past the digest cap: what is left gets a fresh wake after the gap. Leads only.
      if (rows.length && gapped(a.address)) this.db.prepare(`DELETE FROM inbox_wakes WHERE recipient=? AND state='sent'`).run(a.address);
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
   * All of an address's unread is dropped: it is an address nothing reads, the engine's own, whose items its
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
      .prepare(`UPDATE inbox_wakes SET state='pending',attempts=0,due_at=?,queued_id=NULL,note=? WHERE recipient=? AND state IN ('dead','sent','uncertain')`)
      .run(this.now(), RESTARTED, address);
  }
  retry(address: string): void {
    this.db
      .prepare(`UPDATE inbox_wakes SET state='pending',attempts=0,due_at=?,queued_id=NULL,note=? WHERE recipient=? AND state='dead'`)
      .run(this.now(), RESTARTED, address);
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
    this.db.prepare(`UPDATE inbox_wakes SET state='dead',note=? WHERE queued_id=?`).run(note, id);
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
      // A lead's wake goes no sooner than gapMs after its last. The deferral is recomputed each flush from the wake's own
      // debounce, never from an earlier deferral, so urgent unread or a lowered gap pulls it back.
      const gap = o.gapMs ?? 0;
      if (w.state === "pending" && w.attempts === 0 && w.note !== RESTARTED && gapped(recipient)) {
        const base = Math.min(w.due_at, now + o.debounceMs);
        const last = gap > 0 ? this.lastWake(recipient, a.threadId) : null;
        const due = this.urgent(recipient, now, o.paused) || last === null ? base : Math.max(base, last + gap);
        if (due !== w.due_at) {
          this.db.prepare(`UPDATE inbox_wakes SET due_at=? WHERE recipient=? AND token=? AND state='pending'`).run(due, recipient, w.token);
          w = { ...w, due_at: due };
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
        // The digest's cursor covers only what it shows; later mail stays unread and gets its own wake.
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
