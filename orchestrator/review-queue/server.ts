import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Db } from "../core/db.ts";
import { orchHostContract } from "../host-contract.ts";
import { parsePrUrl, spacingUntil } from "./core.ts";
import { QUEUE_CHANNEL, queueContract, type QueueView } from "./contract.ts";
import { QueueStore } from "./store.ts";
import { QueueRunner } from "./runner.ts";
import { chooseWithProvider } from "./picker.ts";
export async function registerReviewQueue(bb: BbPluginApi) {
  const setting = bb.settings.define({
    reviewQueueDryRun: {
      type: "boolean",
      label: "Review queue: dry-run (no GitHub posts)",
      description:
        "Keep on while another scheduler is active. Turn off only after approving cutover and disabling the old scheduler yourself.",
      default: true,
    },
  });
  let dryRun = (await setting.get()).reviewQueueDryRun;
  setting.onChange((c) => {
    dryRun = c.reviewQueueDryRun;
  });
  const store = new QueueStore(bb.storage.database() as unknown as Db);
  const host = bb.hosts.experimental_client({ contract: orchHostContract });
  const lifetime = new AbortController();
  let busy: Promise<void> | null = null;
  const changed = () => bb.realtime.publish(QUEUE_CHANNEL, {});
  const hostId = async () => {
    const configured = store.get().config.hostId;
    const hosts = (await bb.sdk.hosts.list()).filter(
      (h) =>
        h.type === "persistent" &&
        h.lifecycle.phase === "active" &&
        h.status === "connected",
    );
    if (configured) {
      if (!hosts.some((h) => h.id === configured))
        throw new Error("Configured GitHub host is not connected");
      return configured;
    }
    if (hosts.length !== 1)
      throw new Error(
        "Select a GitHub host in queue settings (exactly one is required)",
      );
    return hosts[0]!.id;
  };
  let runHost = "";
  const runner = new QueueRunner(store, {
    now: Date.now,
    dryRun: () => dryRun,
    changed,
    identity: async (signal) => {
      runHost = await hostId();
      return host.call("reviewQueue.identity", null, {
        hostId: runHost,
        signal,
      });
    },
    inspect: (url, signal) =>
      host.call("reviewQueue.inspect", { url }, { hostId: runHost, signal }),
    discover: (signal) =>
      host.call("reviewQueue.discover", null, { hostId: runHost, signal }),
    outcome: (a, signal) =>
      host.call(
        "reviewQueue.outcome",
        { url: a.url, at: a.at },
        { hostId: runHost, signal },
      ),
    post: (e, login, preview, signal) =>
      host.call(
        "reviewQueue.post",
        {
          url: e.url,
          head: e.facts!.head,
          login,
          auto: e.auto,
          dryRun: preview || dryRun,
        },
        { hostId: runHost, signal },
      ),
    choose: (entries, config, signal) =>
      chooseWithProvider(bb, entries, config, signal),
  });
  function kick(kind: "refresh" | "tick" | "now") {
    if (busy || lifetime.signal.aborted) return;
    const signal = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(5 * 60_000),
    ]);
    busy = runner
      .run(kind, signal)
      .catch((e) => bb.log.warn(`review-queue: ${String(e)}`))
      .finally(() => {
        busy = null;
        if (!lifetime.signal.aborted) changed();
      });
    changed();
  }
  bb.rpc.register(queueContract, {
    reviewQueue: async (): Promise<QueueView> => {
      const providers = await bb.sdk.providers.catalog();
      const hosts = await bb.sdk.hosts.list();
      return {
        ...store.get(),
        dryRun,
        busy: !!busy,
        spacingUntil: spacingUntil(store.get()),
        providers: providers.map((p) => ({ id: p.id, name: p.displayName })),
        hosts: hosts
          .filter((h) => h.type === "persistent")
          .map((h) => ({ id: h.id, name: h.name })),
      };
    },
    reviewQueueAction: async (a) => {
      if (a.action === "refresh" || a.action === "run")
        kick(a.action === "refresh" ? "refresh" : "now");
      else
        store.mutate((s) => {
          if (a.action === "configure") {
            const old = s.config;
            s.config = a.config;
            if (!a.config.enabled) s.nextAt = null;
            else if (
              !old.enabled ||
              old.intervalMinutes !== a.config.intervalMinutes
            )
              s.nextAt = Date.now() + a.config.intervalMinutes * 60_000;
          }
          if (a.action === "add") {
            const { url } = parsePrUrl(a.url);
            if (
              s.entries.some((e) => e.url.toLowerCase() === url.toLowerCase())
            )
              throw new Error("This PR is already queued");
            if (s.entries.length >= 50)
              throw new Error("Queue is full (50 PRs)");
            s.entries.push({
              url,
              auto: false,
              pinned: false,
              addedAt: Date.now(),
              facts: null,
              error: null,
              fetchedAt: null,
            });
          }
          if (a.action === "remove")
            s.entries = s.entries.filter((e) => e.url !== a.url);
          if (a.action === "pin") {
            const e = s.entries.find((e) => e.url === a.url);
            if (!e) throw new Error("PR is no longer queued");
            const pin = !e.pinned;
            for (const x of s.entries) x.pinned = x === e && pin;
          }
          if (a.action === "reorder") {
            if (
              a.urls.length !== s.entries.length ||
              new Set(a.urls).size !== a.urls.length ||
              a.urls.some((url) => !s.entries.some((e) => e.url === url))
            )
              throw new Error("Queue changed; refresh before reordering");
            s.entries = a.urls.map(
              (url) => s.entries.find((e) => e.url === url)!,
            );
          }
        });
      changed();
      return { ok: true as const };
    },
  });
  // A one-minute wake implements arbitrary intervals without cron's hour-boundary reset. Missed runs coalesce.
  bb.background.schedule("review-queue", "* * * * *", async () => {
    kick("tick");
  });
  bb.onDispose(() => {
    lifetime.abort();
  });
}
