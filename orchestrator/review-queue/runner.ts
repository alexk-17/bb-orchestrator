import { randomUUID } from "node:crypto";
import {
  assess,
  HOLD,
  pick,
  spacingUntil,
  type Attempt,
  type Entry,
  type Facts,
  type QueueState,
} from "./core.ts";
import { QueueStore } from "./store.ts";
export interface QueuePorts {
  now(): number;
  dryRun(): boolean;
  identity(signal: AbortSignal): Promise<string>;
  inspect(url: string, signal: AbortSignal): Promise<Facts>;
  discover(signal: AbortSignal): Promise<string[]>;
  outcome(
    a: Attempt,
    signal: AbortSignal,
  ): Promise<{
    outcome: Attempt["outcome"] | null;
    cooldownUntil: number | null;
  }>;
  post(
    e: Entry,
    login: string,
    dryRun: boolean,
    signal: AbortSignal,
  ): Promise<{
    outcome: Attempt["outcome"];
    commentUrl: string | null;
    note: string;
  }>;
  choose(
    entries: Entry[],
    config: QueueState["config"],
    signal: AbortSignal,
  ): Promise<{ url: string | null; note: string }>;
  changed(): void;
}
export class QueueRunner {
  private store: QueueStore;
  private ports: QueuePorts;
  constructor(store: QueueStore, ports: QueuePorts) {
    this.store = store;
    this.ports = ports;
  }
  async run(
    kind: "refresh" | "tick" | "now",
    signal: AbortSignal,
  ): Promise<void> {
    const { store, ports: p } = this;
    const token = randomUUID();
    if (!store.claim(token, p.now())) return;
    const alive = () => {
      signal.throwIfAborted();
      if (!store.owns(token, p.now()))
        throw new Error("Queue run lease expired");
    };
    try {
      const config = store.get().config;
      const due =
        kind !== "tick" ||
        (config.enabled && (store.get().nextAt ?? Infinity) <= p.now());
      const outstanding = Object.values(store.get().history).some(
        (a) =>
          ["posting", "posted", "unknown", "no_reply"].includes(a.outcome) &&
          p.now() - a.at <= HOLD,
      );
      if (!due && !outstanding) return;
      const identity = await p.identity(signal);
      alive();
      store.mutate((s) => {
        s.login = identity;
        s.error = null;
      });
      // Reconcile pending requests even after removal from the visible queue.
      for (const a of Object.values(store.get().history).filter(
        (a) =>
          ["posting", "posted", "unknown", "no_reply"].includes(a.outcome) &&
          p.now() - a.at <= HOLD,
      )) {
        const result = await p.outcome(a, signal);
        alive();
        store.mutate((s) => {
          const current = s.history[a.url];
          if (!current || current.at !== a.at) return;
          if (result.outcome) {
            current.outcome = result.outcome;
            if (result.outcome === "rate_limited")
              current.attempts = Math.max(0, current.attempts - 1);
          } else if (p.now() - a.at > 3 * 60_000 && a.outcome === "posted")
            current.outcome = "no_reply";
          if (result.cooldownUntil)
            s.cooldownUntil = Math.max(
              s.cooldownUntil ?? 0,
              result.cooldownUntil,
            );
        });
      }
      if (!due) return;
      // Bounded queue, sequential reads; a cancelled/failed refresh never supplies eligibility from stale facts.
      for (const e of store.get().entries) {
        try {
          const f = await p.inspect(e.url, signal);
          alive();
          store.mutate((s) => {
            const current = s.entries.find((x) => x.url === e.url);
            if (current) {
              current.facts = f;
              current.error = null;
              current.fetchedAt = p.now();
            }
          });
        } catch (err) {
          alive();
          store.mutate((s) => {
            const current = s.entries.find((x) => x.url === e.url);
            if (current)
              current.error = String(
                err instanceof Error ? err.message : err,
              ).slice(0, 800);
          });
        }
      }
      let s = store.get();
      if (
        kind !== "refresh" &&
        s.config.auto &&
        !pick(s.entries, s.history, identity, p.now())
      ) {
        const urls = await p.discover(signal);
        alive();
        for (const url of urls) {
          s = store.get();
          if (s.entries.length >= 50) break;
          if (s.entries.some((e) => e.url === url)) continue;
          try {
            const f = await p.inspect(url, signal);
            alive();
            const e: Entry = {
              url,
              auto: true,
              pinned: false,
              addedAt: p.now(),
              facts: f,
              error: null,
              fetchedAt: p.now(),
            };
            if (assess(e, s.history[url] ?? null, identity, p.now()).eligible)
              store.mutate((state) => {
                if (!state.entries.some((x) => x.url === url))
                  state.entries.push(e);
              });
          } catch {
            alive();
          }
        }
      }
      alive();
      store.mutate((s) => {
        s.fetchedAt = p.now();
      });
      if (kind === "refresh") return;
      s = store.get();
      if (kind === "tick" && !s.config.enabled) return;
      const until = spacingUntil(s);
      if (until > p.now()) {
        store.mutate((s) => {
          s.lastMessage = "Waiting for cooldown / minimum 60-minute spacing";
          s.nextAt = Math.max(s.nextAt ?? 0, until);
        });
        return;
      }
      const defaultPick = pick(s.entries, s.history, identity, p.now());
      let chosen = defaultPick;
      let note = "Deterministic: pin, approval tier, then queue order";
      if (defaultPick && !defaultPick.pinned && s.config.provider) {
        const eligible = s.entries.filter(
          (e) =>
            assess(e, s.history[e.url] ?? null, identity, p.now()).eligible,
        );
        try {
          const selected = await p.choose(eligible, s.config, signal);
          alive();
          chosen = eligible.find((e) => e.url === selected.url) ?? defaultPick;
          note = selected.note;
        } catch {
          alive();
          note = "Model picker unavailable; deterministic fallback";
        }
      }
      alive();
      s = store.get();
      // A user can pause, remove, reorder, pin or change credentials while a model thinks.
      if (JSON.stringify(config) !== JSON.stringify(s.config))
        throw new Error(
          "Queue settings changed during run; run again with the new settings",
        );
      const pinned = pick(s.entries, s.history, identity, p.now());
      if (pinned?.pinned) chosen = pinned;
      const current = chosen && s.entries.find((e) => e.url === chosen!.url);
      if (current) {
        const fresh = await p.inspect(current.url, signal);
        alive();
        store.mutate((s) => {
          const e = s.entries.find((e) => e.url === current.url);
          if (e) {
            e.facts = fresh;
            e.fetchedAt = p.now();
            e.error = null;
          }
        });
        s = store.get();
        const e = s.entries.find((e) => e.url === current.url);
        if (
          !e ||
          JSON.stringify(config) !== JSON.stringify(s.config) ||
          !assess(e, s.history[e.url] ?? null, identity, p.now()).eligible
        )
          throw new Error("Selected PR changed or was removed; nothing posted");
        const dryRun = p.dryRun();
        const at = p.now();
        const previous = s.history[e.url];
        // Durable intent before the only write. Crash/reload after this point consumes spacing and a hold.
        if (!dryRun)
          store.mutate((s) => {
            s.history[e.url] = {
              url: e.url,
              head: fresh.head,
              at,
              outcome: "posting",
              attempts:
                previous?.head === fresh.head ? previous.attempts + 1 : 1,
              commentUrl: null,
            };
          });
        let result: Awaited<ReturnType<QueuePorts["post"]>>;
        try {
          result = await p.post(e, identity, dryRun, signal);
        } catch {
          result = {
            outcome: "unknown",
            commentUrl: null,
            note: dryRun
              ? "Dry-run read interrupted; nothing posted"
              : "Uncertain post result; held for 3 hours to avoid duplicates",
          };
        }
        alive();
        store.mutate((s) => {
          if (!dryRun) {
            const a = s.history[e.url]!;
            a.outcome = result.outcome;
            a.commentUrl = result.commentUrl;
            if (["post_failed", "rate_limited"].includes(result.outcome))
              a.attempts = Math.max(0, a.attempts - 1);
          }
          s.lastMessage = `${result.note}: ${e.url}`;
        });
      } else
        store.mutate((s) => {
          s.lastMessage = "No eligible PRs";
        });
      store.mutate((s) => {
        s.lastAt = p.now();
        s.lastPicker = note;
        s.nextAt = s.config.enabled
          ? p.now() + s.config.intervalMinutes * 60_000
          : null;
      });
    } catch (e) {
      if (!signal.aborted || signal.reason?.name === "TimeoutError")
        store.mutate((s) => {
          s.error = String(e instanceof Error ? e.message : e).slice(0, 800);
          if (kind !== "refresh") {
            s.lastAt = p.now();
            s.lastMessage = "Run stopped; see error";
            s.nextAt = s.config.enabled
              ? p.now() + s.config.intervalMinutes * 60_000
              : null;
          }
        });
    } finally {
      if (!signal.aborted || signal.reason?.name === "TimeoutError") {
        store.release(token);
        p.changed();
      }
    }
  }
}
