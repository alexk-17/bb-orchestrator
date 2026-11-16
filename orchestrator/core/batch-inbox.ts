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
    this.db.exec(`      INSERT OR IGNORE INTO inbox_entries(item_id,recipient,severity,needs_reply)
      SELECT id,recipient,CASE WHEN needs_ack=1 OR kind IN ('alarm','decision.new') THEN 'ACTION' ELSE 'INFO' END,needs_ack
      FROM items WHERE state != 'closed' AND NOT EXISTS (SELECT 1 FROM inbox_entries e WHERE e.item_id=items.id) ORDER BY created_at,rowid;`);
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
        `SELECT e.*,i.created_at,i.body,i.sender,i.kind,i.ref FROM inbox_entries e JOIN items i ON i.id=e.item_id
      WHERE e.recipient=? AND e.acked_at IS NULL ORDER BY e.seq`,
      )
      .all(address) as Entry[];
  }

  read(a: Agent): { text: string; cursor: string | null; count: number } {
    this.sync();
    return tx(this.db, () => {
      const rows = this.unread(a.address);
      const cursor = rows.length ? token() : null;
      if (cursor) this.db.prepare(`INSERT INTO inbox_reads VALUES(?,?,?,?)`).run(cursor, a.address, a.threadId, rows.at(-1)!.seq);
      return {
        cursor,
        count: rows.length,
        text: rows.length
          ? `${rows.length} unread items, oldest first. Ack only after handling this digest: orch_ack(through=${JSON.stringify(cursor)}). That marks them read; it closes only what needs no outcome. A message that asks for one stays open until orch_ack(id, outcome) or a reply with ref=<its id>; decisions still use orch_ack(id, outcome).\n` +
            rows
              .map(
                (r) =>
                  `\n[${r.item_id}] ${r.kind} from ${r.sender}; ref=${JSON.stringify(r.ref)}; severity=${r.severity}; needsReply=${!!r.needs_reply}; dueAt=${r.due_at ?? "none"}\n${this.render(r.item_id) ?? r.body}`,
              )
              .join("\n")
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
      // outcome (needs_ack) is only marked delivered: its ack note, relay settlement or reply still has to happen.
      const covered = `(SELECT item_id FROM inbox_entries WHERE recipient=? AND seq<=? AND acked_at IS NULL)`;
      this.db
        .prepare(`UPDATE items SET state='closed',closed_at=?,outcome=COALESCE(outcome,'read') WHERE id IN ${covered} AND needs_ack=0 AND state IN ('pending','queued','delivered','dead')`)
        .run(this.now(), a.address, r.through_seq);
      this.db
        .prepare(`UPDATE items SET state='delivered',delivered_at=COALESCE(delivered_at,?) WHERE id IN ${covered} AND needs_ack=1 AND state='pending'`)
        .run(this.now(), a.address, r.through_seq);
      this.db.prepare(`UPDATE inbox_entries SET acked_at=? WHERE recipient=? AND seq<=? AND acked_at IS NULL`).run(this.now(), a.address, r.through_seq);
      // Do not cancel a queued wake: the same queue row can wake for remaining/new mail.
      this.db.prepare(`DELETE FROM inbox_wakes WHERE recipient=? AND through_seq<=? AND state NOT IN ('queued','sending')`).run(a.address, r.through_seq);
      return rows.length;
    });
  }

  reroute(id: string, recipient: string): void {
    // A moved item is a new arrival: an older cursor issued to the new recipient cannot consume it.
    this.db
      .prepare(`UPDATE inbox_entries SET recipient=?, seq=(SELECT COALESCE(MAX(seq),0)+1 FROM inbox_entries),acked_at=NULL WHERE item_id=?`)
      .run(recipient, id);
  }
  handoff(address: string): void {
    // A predecessor's queued wake cannot wake its successor; any late predecessor wake carries no mail.
    this.db.prepare(`DELETE FROM inbox_wakes WHERE recipient=?`).run(address);
  }

  wakes(): Wake[] {
    return this.db.prepare(`SELECT * FROM inbox_wakes ORDER BY due_at`).all() as Wake[];
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
  cancelled(id: string): void {
    this.db.prepare(`UPDATE inbox_wakes SET state='dead',note='queued wake cancelled; unread mail retained' WHERE queued_id=?`).run(id);
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
    deliver(a: Agent, text: string, token: string): Promise<DeliverResult>;
    log(text: string): void;
  }): Promise<void> {
    this.sync();
    this.clearAcknowledgedWakes();
    const now = this.now();
    const actionable = this.db
      .prepare(
        `SELECT recipient FROM inbox_entries WHERE acked_at IS NULL
      AND (severity!='INFO' OR needs_reply=1 OR (due_at IS NOT NULL AND due_at<=?)) GROUP BY recipient`,
      )
      .all(now) as { recipient: string }[];
    for (const { recipient } of actionable) {
      if (this.inflight.has(recipient)) continue;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO inbox_wakes(recipient,token,state,due_at,through_seq) VALUES(?,?,'pending',?,(SELECT MAX(seq) FROM inbox_entries WHERE recipient=? AND acked_at IS NULL))`,
        )
        .run(recipient, token(), now + o.debounceMs, recipient);
      let w = this.db.prepare(`SELECT * FROM inbox_wakes WHERE recipient=?`).get(recipient) as Wake;
      const a = o.agent(recipient);
      if (!a || o.held(a) || !["idle", "unknown", "error"].includes(a.status)) continue;
      if (["sent", "sending", "uncertain"].includes(w.state) && now - Math.max(w.last_at ?? now, a.idleAt ?? 0) >= o.retryMs) {
        const state = w.attempts >= 2 ? "dead" : "pending";
        this.db
          .prepare(`UPDATE inbox_wakes SET state=?,due_at=?,note=? WHERE recipient=?`)
          .run(state, now, state === "dead" ? "wake unacknowledged after two attempts; unread mail retained" : null, recipient);
        w = this.db.prepare(`SELECT * FROM inbox_wakes WHERE recipient=?`).get(recipient) as Wake;
        if (state === "dead") o.log(`inbox wake dead for ${recipient}; unread retained; CoS may retry through orch_inbox`);
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
        const result = await o.deliver(
          a,
          `[orchestrator] Inbox wake ${w.token}. Actionable unread mail is waiting. Read ALL unread with orch_inbox, handle the digest, then orch_ack(through=<returned cursor>). This wake is not the mail; unread persists until acknowledged.`,
          w.token,
        );
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
