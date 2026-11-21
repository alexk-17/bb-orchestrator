import { randomBytes } from "node:crypto";
import { tx, type Db } from "../../core/db.ts";
import { parseChannel, type Board } from "./boards.ts";
import { applyRecord, newRecord, type RecordInput, type ReviewRecord } from "./records.ts";
import type { Beat } from "./watch.ts";

type BoardRow = { id: string; channel: string; link: string | null; watcher: string | null; name: string; purpose: string; setup: string | null; created_at: number; removed_at: number | null };
const toBoard = (r: BoardRow): Board => ({ id: r.id, channel: r.channel, link: r.link, watcher: r.watcher, name: r.name, purpose: r.purpose, setup: r.setup, createdAt: r.created_at });
const hex = (n: number) => randomBytes(n).toString("hex");

export class MultiplayerStore {
  private db: Db;
  private now: () => number;
  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  boards(): Board[] {
    return (this.db.prepare(`SELECT * FROM multiplayer_boards WHERE removed_at IS NULL ORDER BY created_at, id`).all() as BoardRow[]).map(toBoard);
  }

  board(id: string): Board | null {
    const r = this.db.prepare(`SELECT * FROM multiplayer_boards WHERE id = ? AND removed_at IS NULL`).get(id) as BoardRow | undefined;
    return r ? toBoard(r) : null;
  }

  /** A board by its id, its channel id or a channel link. */
  resolve(ref: string): Board | null {
    const s = ref.trim();
    const byId = this.board(s);
    if (byId) return byId;
    const ch = parseChannel(s)?.channel;
    const r = ch ? (this.db.prepare(`SELECT * FROM multiplayer_boards WHERE channel = ? AND removed_at IS NULL`).get(ch) as BoardRow | undefined) : undefined;
    return r ? toBoard(r) : null;
  }

  /** Adding a channel that was removed brings its board (and its records) back. */
  addBoard(b: Omit<Board, "id" | "createdAt">): Board {
    return tx(this.db, () => {
      const old = this.db.prepare(`SELECT * FROM multiplayer_boards WHERE channel = ?`).get(b.channel) as BoardRow | undefined;
      if (old && old.removed_at === null) throw new Error("That channel is already a board");
      const id = old?.id ?? `mb-${hex(4)}`;
      if (old)
        this.db.prepare(`UPDATE multiplayer_boards SET link = ?, watcher = ?, name = ?, purpose = ?, setup = ?, removed_at = NULL WHERE id = ?`).run(b.link, b.watcher, b.name, b.purpose, b.setup, id);
      else
        this.db.prepare(`INSERT INTO multiplayer_boards (id, channel, link, watcher, name, purpose, setup, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, b.channel, b.link, b.watcher, b.name, b.purpose, b.setup, this.now());
      return this.board(id)!;
    });
  }

  removeBoard(id: string): void {
    if (!this.board(id)) throw new Error("No such board");
    this.db.prepare(`UPDATE multiplayer_boards SET removed_at = ? WHERE id = ?`).run(this.now(), id);
  }

  records(board: string | null = null, limit = 500): ReviewRecord[] {
    return (this.db.prepare(`SELECT json FROM multiplayer_records WHERE (? IS NULL OR board = ?) ORDER BY created_at DESC, id DESC LIMIT ?`).all(board, board, limit) as { json: string }[]).map((r) => JSON.parse(r.json) as ReviewRecord);
  }

  record(id: string): ReviewRecord | null {
    const r = this.db.prepare(`SELECT json FROM multiplayer_records WHERE id = ?`).get(id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as ReviewRecord) : null;
  }

  private save(r: ReviewRecord): void {
    this.db
      .prepare(
        `INSERT INTO multiplayer_records (id, board, lead, wake, state, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET wake = excluded.wake, state = excluded.state, json = excluded.json, updated_at = excluded.updated_at`,
      )
      .run(r.id, r.board, r.lead, r.wake, r.state, JSON.stringify(r), r.createdAt, r.updatedAt);
  }

  /** A lead files a record (no id) or updates one of its own. Filing again with a wake already recorded updates that record. */
  file(lead: { address: string; project: string | null }, input: RecordInput): { record: ReviewRecord; created: boolean } {
    return tx(this.db, () => {
      const t = this.now();
      let r: ReviewRecord | null = null;
      let created = false;
      if (input.id) {
        r = this.record(input.id);
        if (!r) throw new Error(`No review record ${input.id}`);
        if (input.board && this.resolve(input.board)?.id !== r.board) throw new Error(`${r.id} is on another board: a record never moves`);
      } else {
        if (!input.board) throw new Error("A new record needs board: the board's id (mb-…), its channel id or a channel link");
        const b = this.resolve(input.board);
        if (!b) throw new Error(`No board ${JSON.stringify(input.board)}: the owner adds boards on the Multiplayer tab`);
        const same = input.wake ? (this.db.prepare(`SELECT json FROM multiplayer_records WHERE board = ? AND wake = ?`).get(b.id, input.wake) as { json: string } | undefined) : undefined;
        if (same) r = JSON.parse(same.json) as ReviewRecord;
        else {
          r = newRecord(`rr-${hex(4)}`, b.id, lead.address, lead.project, t);
          created = true;
        }
      }
      if (r.lead !== lead.address) throw new Error(`${r.id} is ${r.lead}'s record`);
      const next = applyRecord(r, input, t);
      this.save(next);
      return { record: next, created };
    });
  }

  linkDeliverable(id: string, lead: string, deliverable: string): ReviewRecord {
    const r = this.record(id);
    if (!r) throw new Error(`No review record ${id}`);
    if (r.lead !== lead) throw new Error(`${id} is ${r.lead}'s record`);
    const next = applyRecord(r, { deliverable }, this.now());
    this.save(next);
    return next;
  }

  beat(source: string, everyMs: number | null): Beat {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO multiplayer_beats (source, last_at, prev_at, every_ms, reads) VALUES (?, ?, NULL, ?, 1)
         ON CONFLICT(source) DO UPDATE SET prev_at = last_at, last_at = excluded.last_at, every_ms = COALESCE(excluded.every_ms, every_ms), reads = reads + 1`,
      )
      .run(source, t, everyMs);
    return this.beatOf(source)!;
  }

  /** When the watcher's latest wake was imported (external_mail). */
  lastWake(source: string): number | null {
    const r = this.db.prepare(`SELECT MAX(i.created_at) AS at FROM external_mail e JOIN items i ON i.id = e.item_id WHERE e.source = ?`).get(source) as { at: number | null } | undefined;
    return r?.at ?? null;
  }

  beatOf(source: string): Beat | null {
    const r = this.db.prepare(`SELECT * FROM multiplayer_beats WHERE source = ?`).get(source) as { source: string; last_at: number; prev_at: number | null; every_ms: number | null; reads: number } | undefined;
    return r ? { source: r.source, lastAt: r.last_at, prevAt: r.prev_at, everyMs: r.every_ms, reads: r.reads } : null;
  }
}
