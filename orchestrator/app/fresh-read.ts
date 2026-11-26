import { useCallback, useEffect, useRef, useState } from "react";
import { touches, type ChangeRead } from "../change-notice.ts";
import { useChangeNotice } from "./change-listener.ts";

/** A read waits this long after the notice that queued it, so a burst of notices is one read. */
export const FRESH_DEBOUNCE_MS = 800;
// setTimeout runs a longer delay at once
const MAX_TIMER_MS = 2 ** 31 - 1;

type Timer = ReturnType<typeof setTimeout>;
type Timed = { now: number; turnsAt: number | null };

/** How long a timer waits before an answer turns by the clock alone ("no reply yet"); null when it never does. */
export function turnDelay(data: Timed | undefined): number | null {
  if (data?.turnsAt == null) return null;
  return Math.min(MAX_TIMER_MS, Math.max(0, data.turnsAt - data.now));
}

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
const timedOf = (d: unknown): Timed | undefined => (typeof d === "object" && d !== null && "turnsAt" in d ? (d as Timed) : undefined);

/** A notice queues a read FRESH_DEBOUNCE_MS later that later notices join; a deadline or a cached opening reads at once. */
export function freshRead(read: () => Promise<unknown>, isHidden: () => boolean = hidden) {
  let queued: Timer | undefined;
  let deadline: Timer | undefined;
  let due = false;
  let busy = false;
  let again = false;
  let current = 0;
  // bb's refetch cancels the read in flight: one runs at a time, and a call meanwhile reads once more when it settles
  const now = (): void => {
    if (isHidden()) {
      due = true;
      return;
    }
    due = false;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    const mine = ++current;
    const settle = () => {
      if (mine !== current) return;
      busy = false;
      if (!again) return;
      again = false;
      now();
    };
    let p: Promise<unknown>;
    try {
      p = read();
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(settle, settle);
  };
  return {
    notice() {
      queued ??= setTimeout(() => {
        queued = undefined;
        now();
      }, FRESH_DEBOUNCE_MS);
    },
    turnsIn(ms: number | null) {
      clearTimeout(deadline);
      deadline = ms === null ? undefined : setTimeout(now, ms);
    },
    opened(cached: boolean) {
      if (cached) now();
    },
    now,
    shown() {
      if (due) now();
    },
    stop() {
      clearTimeout(queued);
      clearTimeout(deadline);
      queued = deadline = undefined;
      due = again = busy = false;
      current++;
    },
  };
}

/** `run` at once, then at most once per `gapMs`: calls inside the gap run it once when the gap ends. */
export function spaced(run: () => void, gapMs: number) {
  let last = -Infinity;
  let trailing: Timer | undefined;
  const fire = () => {
    trailing = undefined;
    last = Date.now();
    run();
  };
  return {
    call() {
      if (trailing !== undefined) return;
      const wait = last + gapMs - Date.now();
      if (wait <= 0) fire();
      else trailing = setTimeout(fire, wait);
    },
    stop() {
      clearTimeout(trailing);
      trailing = undefined;
    },
  };
}

/** A shown read reads again on each opening, after each notice that touches it, and when its answer turns by the clock. */
export function useFreshRead(read: ChangeRead, refetch: () => unknown, opts: { on?: boolean; data?: unknown; key?: string } = {}): void {
  const on = opts.on ?? true;
  const key = opts.key;
  const latest = useRef(refetch);
  latest.current = refetch;
  const [schedule] = useState(() => freshRead(async () => latest.current()));
  const cached = useRef(false);
  cached.current = opts.data !== undefined;
  useEffect(() => {
    if (!on) return;
    schedule.opened(cached.current);
    const back = () => schedule.shown();
    document.addEventListener("visibilitychange", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      schedule.stop();
    };
  }, [on, key, schedule]);
  useChangeNotice(useCallback((n: unknown) => void (on && touches(n, read) && schedule.notice()), [on, read, schedule]));
  const wait = on ? turnDelay(timedOf(opts.data)) : null;
  useEffect(() => {
    schedule.turnsIn(wait);
  }, [opts.data, wait, schedule]);
}
