// One log line per RPC read slower than SLOW_READ_MS (lag fix, 2026-11-24). The owner's page lagged by seconds and the
// log said nothing about which read was slow, or whether the server's event loop was blocked (every read waits then)
// or the read itself was slow (bb's SDK, a big query). Each line names the read, its time, and the event loop's delay
// since the last such line.
import { monitorEventLoopDelay } from "node:perf_hooks";

export const SLOW_READ_MS = 500;

/** The event loop's delay, sampled every 20 ms while started: p99 and max since the last take(), in ms. */
export function loopDelay() {
  const h = monitorEventLoopDelay({ resolution: 20 });
  let on = false;
  return {
    start() {
      if (!on) h.enable();
      on = true;
    },
    stop() {
      if (on) h.disable();
      on = false;
    },
    take(): { p99: number; max: number } | null {
      if (!on || h.count === 0) return null;
      const out = { p99: Math.round(h.percentile(99) / 1e6), max: Math.round(h.max / 1e6) };
      h.reset();
      return out;
    },
  };
}

/** The handlers, each reporting a call that took longer than `slowMs` (thrown or not): its name and ms. */
export function timeReads<H extends Record<string, unknown>>(handlers: H, onSlow: (name: string, ms: number) => void, now: () => number = () => performance.now(), slowMs = SLOW_READ_MS): H {
  const out: Record<string, unknown> = { ...handlers };
  for (const [name, f] of Object.entries(handlers)) {
    if (typeof f !== "function") continue;
    out[name] = (...args: unknown[]) => {
      const t0 = now();
      const done = () => {
        const ms = now() - t0;
        if (ms > slowMs) onSlow(name, ms);
      };
      let r: unknown;
      try {
        r = (f as (...a: unknown[]) => unknown)(...args);
      } catch (e) {
        done();
        throw e;
      }
      if (r instanceof Promise) return r.finally(done);
      done();
      return r;
    };
  }
  return out as H;
}
