// Dedicated tables in bb's plugin database: durable state + a cross-generation tick lease.
import type { Db } from "../core/db.ts";
import { initialState, stateSchema, type QueueState } from "./core.ts";
export class QueueStore {
  private db: Db;
  constructor(db: Db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS review_queue_state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS review_queue_lease (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, expires INTEGER NOT NULL);`);
    db.prepare("INSERT OR IGNORE INTO review_queue_state VALUES (1, ?)").run(
      JSON.stringify(initialState()),
    );
  }
  get(): QueueState {
    return stateSchema.parse(
      JSON.parse(
        (
          this.db
            .prepare("SELECT json FROM review_queue_state WHERE id=1")
            .get() as { json: string }
        ).json,
      ),
    );
  }
  mutate(fn: (s: QueueState) => void): QueueState {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const s = this.get();
      fn(s);
      stateSchema.parse(s);
      this.db
        .prepare("UPDATE review_queue_state SET json=? WHERE id=1")
        .run(JSON.stringify(s));
      this.db.exec("COMMIT");
      return s;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  claim(token: string, now: number): boolean {
    this.db
      .prepare(
        "INSERT INTO review_queue_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE review_queue_lease.expires <= ?",
      )
      .run(token, now + 10 * 60_000, now);
    return this.owns(token, now);
  }
  owns(token: string, now: number): boolean {
    const r = this.db
      .prepare("SELECT token,expires FROM review_queue_lease WHERE id=1")
      .get() as { token: string; expires: number } | undefined;
    return r?.token === token && r.expires > now;
  }
  release(token: string) {
    this.db.prepare("DELETE FROM review_queue_lease WHERE token=?").run(token);
  }
}
