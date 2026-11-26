// bb reads the page's reads make, kept briefly and shared (lag fix, 2026-11-23). A 14.7 s project page fired 36 reads
// and at least 384 bb SDK calls: the agents read asked bb for every live agent's thread and context (2 x 32 calls), and
// needsYou listed every agent's prompts, on every change notice and from each screen that had it mounted.
// - A thread's bb reads are kept ttlMs after they land, and forgotten at once when bb says that thread changed
//   (server.ts: its status, a prompt, an archive, a read, the owner's answer). What bb doesn't announce (a title, the
//   context's token count) is at most ttlMs old when a read starts.
// - Concurrent reads of the same RPC with the same input wait on one computation, unless something changed since it
//   started (a write to the database, a forgotten thread): a read that starts after a change always sees it.

type Kept = { value: Promise<unknown>; until: number | null };

export class ReadCache {
  #gen = 0;
  readonly #kept = new Map<string, Kept>();
  readonly #flight = new Map<string, { gen: number; value: Promise<unknown> }>();

  readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs: number, now: () => number) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** Bumped by every change a read could see; a computation is joined only while it is unchanged. */
  get generation(): number {
    return this.#gen;
  }

  /** Something the reads see changed (a database write). */
  bump(): void {
    this.#gen++;
  }

  /**
   * One bb read of one thread (`what`: "get", "context", "interactions"), kept ttlMs after it lands; callers meanwhile
   * share it. `load` turns a failure into a value (a gone thread answers null, like any answer, and is kept as such); a
   * load that throws anyway is not kept.
   */
  thread<T>(threadId: string, what: string, load: () => Promise<T>): Promise<T> {
    const key = `${threadId}\u0000${what}`;
    const hit = this.#kept.get(key);
    if (hit && (hit.until === null || hit.until > this.now())) return hit.value as Promise<T>;
    const entry: Kept = { value: load(), until: null };
    this.#kept.set(key, entry);
    entry.value.then(
      () => {
        // forgotten while it was on its way: what it read may be older than the change, so it is not kept
        if (this.#kept.get(key) === entry) entry.until = this.now() + this.ttlMs;
      },
      () => {
        if (this.#kept.get(key) === entry) this.#kept.delete(key);
      },
    );
    return entry.value as Promise<T>;
  }

  /** bb said this thread changed: its kept reads go, and no read started before now is joined. */
  forget(threadId: string): void {
    const prefix = `${threadId}\u0000`;
    for (const key of [...this.#kept.keys()]) if (key.startsWith(prefix)) this.#kept.delete(key);
    this.#gen++;
  }

  /**
   * One computation for concurrent reads of the same key, while nothing changed since it started. Nothing is kept once
   * it settles: the next read computes again. The first caller's abort never stops it (bb's refetch aborts a read in
   * flight and starts another, which joins this one).
   */
  share<T>(key: string, run: () => Promise<T>): Promise<T> {
    const f = this.#flight.get(key);
    if (f && f.gen === this.#gen) return f.value as Promise<T>;
    const mine = { gen: this.#gen, value: run() as Promise<unknown> };
    this.#flight.set(key, mine);
    const done = () => {
      if (this.#flight.get(key) === mine) this.#flight.delete(key);
    };
    mine.value.then(done, done);
    return mine.value as Promise<T>;
  }
}

/** Wraps the named async handlers so concurrent calls with the same input share one computation (ReadCache.share). */
export function shareReads<H extends Record<string, unknown>>(cache: ReadCache, names: readonly (keyof H & string)[], handlers: H): H {
  const out: Record<string, unknown> = { ...handlers };
  for (const name of names) {
    const f = handlers[name] as (input: unknown, ctx: unknown) => Promise<unknown>;
    out[name] = (input: unknown, ctx: unknown) => cache.share(`${name}\u0000${JSON.stringify(input ?? null)}`, () => f(input, ctx));
  }
  return out as H;
}
