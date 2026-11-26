// Which tables a change wrote, for the page's change notice: the notice names the tables written since the last one, and
// the page refetches only the reads that read them (change-notice.ts READS). A change it can't name refetches everything.
import type { Db, Stmt } from "./db.ts";
import { DERIVED, type DerivedTable, STATUS } from "../change-notice.ts";

// an upsert's "ON CONFLICT ... DO UPDATE SET" names no table: SET is not one
const WRITE = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(?!SET\b)["`]?([A-Za-z_][A-Za-z0-9_]*)/gi;
const DDL = /\b(?:CREATE|DROP|ALTER)\s+(?:TABLE|INDEX|TRIGGER|VIEW)\b/i;

// A thread's status flips (Engine.setStatus) are most of the change notices; most reads show no status. An update of
// agents that sets only these columns, and an event of kind "status", are STATUS, which only the reads that show a
// status declare.
const STATUS_ONLY = new Set(["status", "idle_at", "last_idle_at"]);
const AGENTS_SET = /\bUPDATE\s+agents\s+SET\s+([\s\S]*?)(?:\bWHERE\b|$)/i;
const EVENTS_INSERT = /^\s*INSERT\s+INTO\s+events\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)\s*$/i;

/** Where an events insert's kind is among its arguments: only when every value is a plain "?"; else -1. */
export function eventKindAt(sql: string): number {
  const m = EVENTS_INSERT.exec(sql);
  if (!m) return -1;
  const cols = m[1]!.split(",").map((c) => c.trim().toLowerCase());
  const vals = m[2]!.split(",").map((v) => v.trim());
  return cols.length === vals.length && vals.every((v) => v === "?") ? cols.indexOf("kind") : -1;
}

/** The tables a statement writes; "*" for schema changes, which no read map can name. */
export function writtenTables(sql: string): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(WRITE)) out.add(m[1]!.toLowerCase());
  if (DDL.test(sql)) out.add("*");
  const set = out.has("agents") && out.size === 1 ? AGENTS_SET.exec(sql) : null;
  if (set) {
    const cols = [...set[1]!.matchAll(/(?:^|,)\s*(\w+)\s*=/g)].map((m) => m[1]!.toLowerCase());
    if (cols.length && cols.every((c) => STATUS_ONLY.has(c))) return [STATUS];
  }
  return [...out];
}

/**
 * The database, with every write reported to `onWrite` as it runs (its tables). Everything else is the database's own,
 * called on the real object (better-sqlite3 refuses a proxied `this`).
 */
export function recordWrites<T extends Db>(db: T, onWrite: (tables: readonly string[]) => void): T {
  let total: Stmt | null = null;
  const changes = () => Number(((total ??= db.prepare("SELECT total_changes() AS n")).get() as { n: number | bigint }).n);
  const wrapStmt = (st: Stmt, tables: readonly string[], kindAt: number): Stmt =>
    new Proxy(st, {
      get(target, k) {
        const v = Reflect.get(target, k, target) as unknown;
        if (typeof v !== "function") return v;
        if (k === "run" || k === "get" || k === "all" || k === "iterate")
          return (...args: unknown[]) => {
            // an iterator writes as it is read, after this returns
            const before = k === "iterate" ? null : changes();
            const r = (v as (...a: unknown[]) => unknown).apply(target, args);
            if (before === null || changes() !== before) onWrite(kindAt >= 0 && args[kindAt] === "status" ? [STATUS] : tables);
            return r;
          };
        return (v as (...a: unknown[]) => unknown).bind(target);
      },
    });
  return new Proxy(db, {
    get(target, k) {
      const v = Reflect.get(target, k, target) as unknown;
      if (k === "prepare")
        return (sql: string, ...rest: unknown[]) => {
          const st = (v as (s: string, ...r: unknown[]) => Stmt).call(target, sql, ...rest);
          const tables = writtenTables(sql);
          return tables.length ? wrapStmt(st, tables, eventKindAt(sql)) : st;
        };
      if (k === "exec")
        return (sql: string) => {
          const tables = writtenTables(sql);
          // total_changes() counts no schema change
          const before = tables.length && !tables.includes("*") ? changes() : null;
          const r = (v as (s: string) => unknown).call(target, sql);
          if (tables.length && (before === null || changes() !== before)) onWrite(tables);
          return r;
        };
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/**
 * The change notice's tables, gathered between notices: every write's, and what a change() call names besides ("*":
 * everything). An unnamed call adds nothing: the engine's changes are all database writes, already gathered, and its
 * flush re-announces writes the last notice may have carried already (Engine.changedSinceFlush). A change outside the
 * database names itself (server.ts: BB for bb's prompts, everything for a settings save or a reload). `take()` is the
 * notice: the tables, or null for everything, and starts over.
 */
export class ChangeTables {
  #tables = new Set<string>();
  #all = false;
  readonly #known: ReadonlySet<string>;
  constructor(known: ReadonlySet<string>) {
    this.#known = known;
  }

  /** A write ran. */
  wrote(tables: readonly string[]): void {
    for (const t of tables) this.#add(t);
  }

  call(tables?: readonly string[]): void {
    if (tables) for (const t of tables) this.#add(t);
  }

  take(): string[] | null {
    const out = this.#all ? null : [...this.#tables].sort();
    this.#tables = new Set();
    this.#all = false;
    return out;
  }

  // a table no read is mapped to (a new one, or "*") refetches everything until it is mapped
  #add(t: string): void {
    if (this.#known.has(t)) this.#tables.add(t);
    else this.#all = true;
  }
}

/**
 * A notice's derived tables (change-notice.ts DERIVED): each named when its print moved since the last notice that
 * wrote one of its tables. A print that fails, or the first, names it.
 */
export class DerivedTables {
  #last = new Map<DerivedTable, string>();
  readonly #prints: Readonly<Record<DerivedTable, () => string>>;
  readonly #failed: (name: DerivedTable, e: unknown) => void;
  constructor(prints: Readonly<Record<DerivedTable, () => string>>, failed: (name: DerivedTable, e: unknown) => void = () => {}) {
    this.#prints = prints;
    this.#failed = failed;
  }

  add(tables: string[] | null): string[] | null {
    for (const name of Object.keys(DERIVED) as DerivedTable[]) {
      if (tables && !Object.keys(DERIVED[name]).some((t) => tables.includes(t))) continue;
      let now: string | null = null;
      try {
        now = this.#prints[name]();
      } catch (e) {
        this.#failed(name, e);
      }
      const moved = now === null || this.#last.get(name) !== now;
      if (now === null) this.#last.delete(name);
      else this.#last.set(name, now);
      if (tables && moved) tables.push(name);
    }
    return tables && [...tables].sort();
  }
}
