
export interface Beat {
  source: string;
  lastAt: number;
  prevAt: number | null;
  everyMs: number | null;
  reads: number;
}

export type Health = { state: "none" } | { state: "healthy" | "late" | "unknown"; lastAt: number; nextAt: number | null; everyMs: number | null };

/** The interval a beat runs at: the one the watcher gave, else the gap between its last two reads. */
export const intervalOf = (b: Beat): number | null => b.everyMs ?? (b.prevAt !== null && b.lastAt > b.prevAt ? b.lastAt - b.prevAt : null);

/** Overdue by half an interval, and at least a minute: a tick's own read takes a while. */
export const isLate = (nextAt: number, every: number, now: number) => now > nextAt + Math.max(60_000, every / 2);

export function health(b: Beat | null, now: number): Health {
  if (!b) return { state: "none" };
  const every = intervalOf(b);
  if (every === null) return { state: "unknown", lastAt: b.lastAt, nextAt: null, everyMs: null };
  const nextAt = b.lastAt + every;
  return { state: isLate(nextAt, every, now) ? "late" : "healthy", lastAt: b.lastAt, nextAt, everyMs: every };
}

export function everyArg(rest: readonly string[]): number | null {
  const i = rest.indexOf("--every");
  if (i < 0) return null;
  const m = Number(rest[i + 1]);
  if (!Number.isFinite(m) || m <= 0 || m > 24 * 60) throw new Error("--every is the watcher's interval in minutes (more than 0, at most 1440)");
  return Math.round(m * 60_000);
}
