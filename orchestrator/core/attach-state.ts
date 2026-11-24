// What a thread and a PR are doing, in one place (2026-11-23, the work board): the Projects lanes (app/lanes.ts), the
// project page's dependencies (core/history.ts) and the work board's columns (core/work-board.ts) read them the same
// way. Each caller keeps its own precedence. Pure and browser-safe.

/** bb thread statuses that mean a turn is running. */
export const BUSY_STATUSES: ReadonlySet<string> = new Set(["active", "pending", "starting", "stopping"]);

export type ThreadState = "working" | "idle" | "blocked" | "released" | "unknown";

/** A thread's state from its status (bb's, or the engine's archived): failed is blocked, stopped or archived is released. */
export function threadState(status: string | null): ThreadState {
  if (!status) return "unknown";
  if (BUSY_STATUSES.has(status)) return "working";
  if (status === "idle") return "idle";
  if (status === "error") return "blocked";
  if (status === "stopped" || status === "archived") return "released";
  return "unknown";
}

/** PR attention words that need the thread's own work (a conflict, failed checks, a blocked merge). */
export const PR_BLOCKED: ReadonlySet<string> = new Set(["conflicts", "blocked", "checks_failed"]);

/**
 * What a live PR waits on: its checks running (ci), a reviewer (review), a merge (merge: ready to merge), its thread's
 * fix (blocked), or nothing. A merged, closed or unknown PR waits on nothing. CI comes first: a PR whose checks run
 * waits on them, whatever its review says.
 */
export function prWait(p: { state: string | null; checks: string | null; review: string | null; attention: string | null }): "ci" | "review" | "merge" | "blocked" | null {
  if (p.state !== "open" && p.state !== "draft") return null;
  if (p.checks === "pending") return "ci";
  if (p.state !== "open") return null;
  if (p.review === "review_required" || p.review === "review_requested" || p.attention === "review_requested") return "review";
  if (p.attention === "ready_to_merge") return "merge";
  if (PR_BLOCKED.has(p.attention ?? "")) return "blocked";
  return null;
}

/** The review decision a PR row's signature holds (v2|url|state|checks|review|merge|queued), else null. */
export const reviewOf = (sig: string): string | null => (sig.startsWith("v2|") ? sig.split("|")[4] || null : null);
