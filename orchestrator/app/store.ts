// Module level, so a tab switch mid-write loses nothing and a pointer released while the panel is gone still counts.
import { useSyncExternalStore } from "react";
import { WRITE_BASE } from "../contract.ts";
import { releaseAt } from "./gate.ts";

export type Outcome = { ok: true; result?: unknown } | { ok: false; kind: string; message: string };
export type WriteKind = "answer" | "defer" | "return" | "other";
export type Hide = "both" | "cards" | "deferred";
export type Lock = { cardId: string | null; kind: WriteKind; done: boolean; doneAt: number; ok: boolean | null };

export const gate = {
  lock: null as Lock | null,
  pointerDown: false,
  lastReleaseAt: Number.NEGATIVE_INFINITY,
  error: null as { where: string; message: string } | null,
};
export const gone = new Map<string, Hide>();
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
export function useGate(): number {
  return useSyncExternalStore(subscribe, () => version);
}

let pressSeq = 0;
let installed = false;
function onRelease() {
  if (!gate.pointerDown) return;
  gate.lastReleaseAt = performance.now();
  const seq = ++pressSeq;
  // a task later, so the click that follows this release is handled against the list as it was drawn
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

let unlockTimer: ReturnType<typeof setTimeout> | undefined;
function tryUnlock() {
  clearTimeout(unlockTimer);
  const lock = gate.lock;
  if (!lock) return;
  const at = releaseAt(lock, gate.pointerDown, gate.lastReleaseAt);
  if (at === null) return;
  const wait = at - performance.now();
  if (wait > 0) {
    unlockTimer = setTimeout(tryUnlock, wait);
    return;
  }
  gate.lock = null;
  emit();
}

const TIMEOUT_MS = 30_000;
async function post(path: string, body: unknown): Promise<Outcome> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
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
    }
    if (json && typeof json === "object" && "ok" in json) {
      if ((json as { ok: unknown }).ok === true) return { ok: true, result: (json as { result?: unknown }).result };
      const e = (json as { error?: { kind?: unknown; message?: unknown } }).error;
      return { ok: false, kind: typeof e?.kind === "string" ? e.kind : "error", message: typeof e?.message === "string" ? e.message : `HTTP ${res.status}` };
    }
    return { ok: false, kind: "error", message: `Unexpected answer from the server (HTTP ${res.status})` };
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    return { ok: false, kind: "network", message: aborted ? "No answer from the server in 30 s; reload to check." : e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export function stage(path: string, body: unknown): Promise<Outcome> {
  return post(path, body);
}

export function keepPref(path: string, body: unknown): Promise<Outcome> {
  return post(path, body);
}

export type WriteOptions = {
  card?: { id: string; rev: number; hide: Hide };
  kind: WriteKind;
  where?: string;
  after: () => void;
};

export async function write(path: string, body: unknown, opts: WriteOptions): Promise<Outcome | null> {
  if (gate.lock) return null;
  const lock: Lock = { cardId: opts.card?.id ?? null, kind: opts.kind, done: false, doneAt: 0, ok: null };
  // Set before any await: a second click in the same tick must find it.
  gate.lock = lock;
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
