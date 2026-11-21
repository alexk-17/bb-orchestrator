// The page's one write gate. Every write (answer, defer, bring back, resend, rules) goes through `write`: one at a time,
// page-wide, and the page holds still after it (gate.ts, releaseAt). Kept at module level so a tab switch mid-write
// loses nothing, and so a pointer released while the panel is gone still counts.
import { useSyncExternalStore } from "react";
import { WRITE_BASE } from "../contract.ts";
import { releaseAt } from "./gate.ts";

export type Outcome = { ok: true; result?: unknown } | { ok: false; kind: string; message: string };
export type WriteKind = "answer" | "defer" | "return" | "other";
/** Which lists a written card (this id at this rev) is hidden from once the page lets go, until the server drops it. */
export type Hide = "both" | "cards" | "deferred";
export type Lock = { cardId: string | null; kind: WriteKind; done: boolean; doneAt: number; ok: boolean | null };

export const gate = {
  lock: null as Lock | null,
  pointerDown: false,
  lastReleaseAt: Number.NEGATIVE_INFINITY,
  /** The last failed write's message and where it belongs (a card id, or "board" / "rules"). */
  error: null as { where: string; message: string } | null,
};
/** `${id}@${rev}` → the lists it is hidden from. */
export const gone = new Map<string, Hide>();
/** Card id → why it is marked (it changed before the write reached it). */
export const changed = new Map<string, string>();

let version = 0;
const listeners = new Set<() => void>();
function emit() {
  version++;
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
/** Re-render on any gate change. */
export function useGate(): number {
  return useSyncExternalStore(subscribe, () => version);
}

// ---- the pointer: down on the panel, released anywhere ----

let pressSeq = 0;
let installed = false;
function onRelease() {
  if (!gate.pointerDown) return;
  gate.lastReleaseAt = performance.now();
  const seq = ++pressSeq;
  // Cleared a task later, so the click that follows this release is handled against the list as it was drawn.
  setTimeout(() => {
    if (seq !== pressSeq) return;
    gate.pointerDown = false;
    emit();
    tryUnlock();
  }, 0);
}
export function pointerPressed() {
  if (!installed && typeof window !== "undefined") {
    window.addEventListener("pointerup", onRelease, true);
    window.addEventListener("pointercancel", onRelease, true);
    installed = true;
  }
  pressSeq++;
  if (!gate.pointerDown) {
    gate.pointerDown = true;
    emit();
  }
}

// ---- the lock ----

let unlockTimer: ReturnType<typeof setTimeout> | undefined;
function tryUnlock() {
  clearTimeout(unlockTimer);
  const lock = gate.lock;
  if (!lock) return;
  const at = releaseAt(lock, gate.pointerDown, gate.lastReleaseAt);
  if (at === null) return; // the response or a pointer release calls again
  const wait = at - performance.now();
  if (wait > 0) {
    unlockTimer = setTimeout(tryUnlock, wait);
    return;
  }
  gate.lock = null;
  emit();
}

const TIMEOUT_MS = 30_000;
async function post(path: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<Outcome> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(WRITE_BASE + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // not JSON: judged below
    }
    if (json && typeof json === "object" && "ok" in json) {
      if ((json as { ok: unknown }).ok === true) return { ok: true, result: (json as { result?: unknown }).result };
      const e = (json as { error?: { kind?: unknown; message?: unknown } }).error;
      return { ok: false, kind: typeof e?.kind === "string" ? e.kind : "error", message: typeof e?.message === "string" ? e.message : `HTTP ${res.status}` };
    }
    return { ok: false, kind: "error", message: `Unexpected answer from the server (HTTP ${res.status})` };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    return { ok: false, kind: "network", message: aborted ? `No answer from the server in ${Math.round(timeoutMs / 1000)} s; reload to check.` : e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A file staged for a write that follows (2026-11-17: a screenshot for a message to a lead), outside the gate: staging
 * changes nothing the page shows, and the message that names it goes through `write` as every write does.
 */
export function stage(path: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<Outcome> {
  return post(path, body, timeoutMs);
}

export type WriteOptions = {
  /** The card written, for its mark while the page holds, and to hide it once the write took. */
  card?: { id: string; rev: number; hide: Hide };
  kind: WriteKind;
  /** Where a failure is shown when there is no card ("board", "rules"). */
  where?: string;
  /** Refetch the reads (the server publishes nothing on a refused write). */
  after: () => void;
};

/** One write. Null when another write holds the page (the caller's click is dropped). */
export async function write(path: string, body: unknown, opts: WriteOptions): Promise<Outcome | null> {
  if (gate.lock) return null;
  const lock: Lock = { cardId: opts.card?.id ?? null, kind: opts.kind, done: false, doneAt: 0, ok: null };
  gate.lock = lock; // set before any await: a second click in the same tick finds it
  gate.error = null;
  emit();
  const out = await post(path, body);
  lock.done = true;
  lock.ok = out.ok;
  lock.doneAt = performance.now();
  const card = opts.card;
  if (out.ok) {
    if (card) {
      gone.set(`${card.id}@${card.rev}`, card.hide);
      changed.delete(card.id);
    }
  } else if (out.kind === "conflict" && card) {
    changed.set(card.id, "This changed before your click reached it. Read it again.");
  } else {
    gate.error = { where: card?.id ?? opts.where ?? "page", message: out.message };
  }
  emit();
  opts.after();
  tryUnlock();
  return out;
}

/** Forget a hidden card once the server no longer lists it (this id at this rev) in the lists it is hidden from. */
export function pruneGone(cards: ReadonlySet<string>, deferred: ReadonlySet<string>) {
  let any = false;
  for (const [key, hide] of gone) {
    const listed = (hide !== "deferred" && cards.has(key)) || (hide !== "cards" && deferred.has(key));
    if (!listed) {
      gone.delete(key);
      any = true;
    }
  }
  if (any) emit();
}
