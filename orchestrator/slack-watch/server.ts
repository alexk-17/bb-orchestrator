import { constants, openSync, closeSync, existsSync, fstatSync, mkdirSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { channelSchema, configSchema, profileName, stamp, type Route, type Identity } from "./config.ts";
import { Credentials } from "./secrets.ts";
import { SlackClient, SlackError } from "./slack.ts";
import { WatchRunner, type WatchDeps } from "./runner.ts";
import { newScan, WatchStore, UnknownProfile } from "./store.ts";
import type { Db } from "../core/db.ts";

export interface ServerDeps extends Omit<WatchDeps, "client"> {
  db: Db;
  dir: string;
  legacyRoutes: () => Record<string, string[]>;
  fetch?: typeof fetch;
  audit: (action: string) => void;
}
const sameIdentity = (a: Identity, b: Identity) => a.team === b.team && a.user === b.user && a.bot === b.bot;
class OperatorError extends Error {}
function readConfig(path: string) {
  // O_NONBLOCK prevents a FIFO open from stalling the server before we can reject it.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let data: unknown;
  try {
    if (!fstatSync(fd).isFile()) throw new OperatorError("Config must be a regular JSON file");
    const bytes = Buffer.alloc(65537);
    let size = 0,
      read = 0;
    while (size < bytes.length && (read = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += read;
    if (size > 65536) throw new OperatorError("Config exceeds 64 KiB");
    try {
      data = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    } catch {
      throw new OperatorError("Config is not valid JSON");
    }
  } finally {
    closeSync(fd);
  }
  const parsed = configSchema.safeParse(data);
  if (!parsed.success)
    throw new OperatorError("Invalid watcher config; check version, profile, interval and channel/source/recipient fields against the guide");
  return parsed.data;
}
const profile = [{ name: "profile", description: "Local watcher profile", required: true }] as const;
const token = { type: "string", description: "Read bot token with --token-stdin; never put it in shell arguments", stdin: true, required: true } as const;
const output = (data: unknown) => ({ exitCode: 0, stdout: `${JSON.stringify(data, null, 2)}\n` });

export function registerSlackWatch(bb: BbPluginApi, deps: ServerDeps) {
  const store = new WatchStore(deps.db),
    credentials = new Credentials(join(deps.dir, "credentials"));
  // The service sleeps on this instead of a timer while no profile is enabled: resume wakes it, unload settles it.
  let kicked = false,
    wake: (() => void) | null = null;
  const kick = () => {
    kicked = true;
    wake?.();
  };
  const idle = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (kicked || signal.aborted) return resolve();
      const done = () => {
        signal.removeEventListener("abort", done);
        wake = null;
        resolve();
      };
      wake = done;
      signal.addEventListener("abort", done, { once: true });
    });
  // A file that exists exactly while some profile is enabled (not paused). The service checks it before touching
  // SQLite, so an install with no watcher, or only paused ones, reads nothing at startup or ever after.
  const marker = join(deps.dir, "enabled");
  const syncEnabled = () => {
    if (store.all().some((p) => !p.config.paused)) {
      mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
      writeFileSync(marker, "");
    } else rmSync(marker, { force: true });
  };
  /** Profiles to step. */
  const enabled = () => (existsSync(marker) ? store.all().filter((p) => !p.config.paused).map((p) => p.config.profile) : []);
  const now = deps.now ?? Date.now;
  const lifetime = new AbortController();
  let active: { name: string; controller: AbortController } | null = null;
  const pausing = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(f: () => Promise<T>): Promise<T> => {
    const job = queue.then(f);
    queue = job.catch(() => {});
    return job;
  };
  const client = (name: string) => new SlackClient(credentials.read(name), deps.fetch);
  const runner = new WatchRunner(store, { ...deps, client });
  const available = (r: Route) => {
    if (!deps.recipient(r.to)) throw new OperatorError("Recipient role does not exist or is stopped; fix it before enabling this route");
    if (Object.hasOwn(deps.legacyRoutes(), r.source) || Object.hasOwn(store.routes(), r.source))
      throw new OperatorError("Source already exists; use a unique watcher source (leave legacy integrationRoutes unchanged)");
    if (store.all().some((p) => p.config.channels.some((c) => c.id === r.id))) throw new OperatorError("Channel already watched by another profile");
  };
  async function probe(c: SlackClient, channels: Route[], signal: AbortSignal) {
    const identity = await c.identity(signal);
    const checks = [];
    for (const route of channels) {
      if (!deps.recipient(route.to)) throw new OperatorError("Recipient role is unavailable");
      await c.info(route.id, signal);
      const page = await c.page(route.id, null, "", stamp(now()), signal);
      const root = page.messages.find((m) => !m.subtype || m.subtype === "bot_message");
      if (root) await c.page(route.id, root.ts, "", stamp(now()), signal);
      checks.push({ channel: route.id, history: "ok", replies: root ? "ok" : "unverified: no eligible root on the sampled page" });
    }
    return { identity, checks };
  }
  const guard = (f: (signal: AbortSignal) => Promise<unknown>, ctx: { threadId?: string; signal?: AbortSignal }, action?: string) => {
    if (ctx.threadId) throw new OperatorError("slack-watch is operator-only; run it from your terminal");
    return exclusive(async () => {
      const signal = AbortSignal.any([lifetime.signal, ctx.signal ?? new AbortController().signal, AbortSignal.timeout(120000)]);
      signal.throwIfAborted();
      let result: unknown;
      try {
        result = await f(signal);
      } finally {
        if (action) {
          syncEnabled(); // every command that can change a profile keeps the marker true to SQLite
          kick(); // and an idle service rechecks it at once
        }
      }
      if (action) deps.audit(action); // fixed action only, never argv or imported content
      return output(result);
    });
  };
  const declared = defineCli({
    name: "orchestrator",
    summary: "Manage inbound Slack bot watchers",
    commands: {
      "slack-watch setup": cliCommand({
        summary: "Validate and save a paused watcher",
        positionals: profile,
        options: { config: { type: "string", required: true, description: "JSON file on the bb server" }, token },
        run: ({ positionals: p, options: o }, ctx) =>
          guard(
            async (signal) => {
              if (store.all().length >= 20) throw new OperatorError("At most 20 watcher profiles are supported");
              const config = readConfig(o.config);
              if (config.profile !== p.profile || store.all().some((p) => p.config.profile === config.profile))
                throw new OperatorError("Profile must match config and must be new");
              for (const c of config.channels) available(c);
              const baseline = stamp(now());
              const result = await probe(new SlackClient(o.token, deps.fetch), config.channels, signal);
              signal.throwIfAborted();
              config.paused = true;
              credentials.write(config.profile, o.token);
              store.add(config, result.identity, baseline);
              return {
                ...result,
                config,
                next: "Create a Multiplayer board in the owner UI for each channel, choose its source, then test and resume. Setup emits no heartbeat.",
              };
            },
            ctx,
            "slack-watch setup",
          ),
      }),
      "slack-watch channel add": cliCommand({
        summary: "Allow a channel and exact inbox route",
        positionals: [...profile, { name: "channel", description: "Slack channel ID", required: true }],
        options: {
          to: { type: "string", required: true, description: "cos, steward or lead:<slug>" },
          source: { type: "string", description: "Unique Multiplayer source; default sw-<profile>-<channel>" },
        },
        run: ({ positionals: p, options: o }, ctx) =>
          guard(
            async (signal) => {
              const s = store.get(profileName.parse(p.profile));
              if (!s.config.paused) throw new OperatorError("Pause the profile before changing routes");
              const route = channelSchema.parse({ id: p.channel, to: o.to, source: o.source ?? `sw-${p.profile}-${p.channel.toLowerCase()}` });
              available(route);
              configSchema.parse({ ...s.config, channels: [...s.config.channels, route] });
              const baseline = stamp(now());
              const result = await probe(client(p.profile), [route], signal);
              signal.throwIfAborted();
              if (!sameIdentity(result.identity, s.identity)) throw new OperatorError("Stored bot identity changed; rotate its token first");
              s.config.channels.push(route);
              s.scans[route.id] = newScan(baseline);
              s.nextAt = 0;
              store.save(s);
              return { route, checks: result.checks };
            },
            ctx,
            "slack-watch channel add",
          ),
      }),
      "slack-watch channel remove": cliCommand({
        summary: "Remove a route and discard its pending imports; existing inbox mail remains",
        positionals: [...profile, { name: "channel", description: "Slack channel ID", required: true }],
        run: ({ positionals: p }, ctx) =>
          guard(
            async () => {
              const s = store.get(profileName.parse(p.profile));
              if (!s.config.paused) throw new OperatorError("Pause the profile before changing routes");
              if (!s.config.channels.some((c) => c.id === p.channel)) throw new OperatorError("Channel is not configured");
              store.removeChannel(s, p.channel);
              return { removed: p.channel };
            },
            ctx,
            "slack-watch channel remove",
          ),
      }),
      "slack-watch routes": cliCommand({
        summary: "Export routes without credentials",
        positionals: [{ ...profile[0], required: false }],
        run: ({ positionals: p }, ctx) => guard(async () => (p.profile ? [store.get(profileName.parse(p.profile))] : store.all()).map((s) => s.config), ctx),
      }),
      "slack-watch status": cliCommand({
        summary: "Health, last read, full-scan heartbeat, errors and backlog",
        positionals: [{ ...profile[0], required: false }],
        options: { json: { type: "boolean", description: "JSON output (also the default)" } },
        run: ({ positionals: p }, ctx) =>
          guard(
            async () => {
              // A marker lost while bb ran (deleted, or a restored database) would leave an enabled profile unpolled
              // with nothing saying so: status already reads SQLite, so it puts the marker back and wakes the service.
              if (store.all().some((s) => !s.config.paused) !== existsSync(marker)) {
                syncEnabled();
                kick();
              }
              return (p.profile ? [store.get(profileName.parse(p.profile))] : store.all()).map((s) => ({
                profile: s.config.profile,
                paused: s.config.paused,
                identity: s.identity,
                nextAt: s.nextAt,
                error: s.error,
                pendingImports: store.backlog(s.config.profile),
                channels: s.config.channels.map((c) => ({ ...c, ...s.scans[c.id], roots: store.roots(s.config.profile, c.id) })),
              }));
            },
            ctx,
          ),
      }),
      "slack-watch test": cliCommand({
        summary: "Bounded dry read; no imports, checkpoints, posts or heartbeat",
        positionals: profile,
        run: ({ positionals: p }, ctx) =>
          guard(async (signal) => {
            const s = store.get(profileName.parse(p.profile));
            const result = await probe(client(p.profile), s.config.channels, signal);
            if (!sameIdentity(result.identity, s.identity)) throw new OperatorError("Bot identity differs from setup");
            return { ...result, dryRead: true };
          }, ctx),
      }),
      "slack-watch pause": cliCommand({
        summary: "Stop reads/imports; retain backlog and existing inbox work",
        positionals: profile,
        run: ({ positionals: p }, ctx) => {
          if (!ctx.threadId && profileName.safeParse(p.profile).success) {
            pausing.add(p.profile);
            if (active?.name === p.profile) active.controller.abort();
          }
          return guard(
            async () => {
              const s = store.get(profileName.parse(p.profile));
              s.config.paused = true;
              store.save(s);
              return { paused: true };
            },
            ctx,
            "slack-watch pause",
          ).finally(() => pausing.delete(p.profile));
        },
      }),
      "slack-watch resume": cliCommand({
        summary: "Resume from durable checkpoints after a dry read",
        positionals: profile,
        run: ({ positionals: p }, ctx) =>
          guard(
            async (signal) => {
              const s = store.get(profileName.parse(p.profile));
              if (!s.config.channels.length) throw new OperatorError("Add at least one channel first");
              const result = await probe(client(p.profile), s.config.channels, signal);
              if (!sameIdentity(result.identity, s.identity)) throw new OperatorError("Bot identity differs from setup");
              signal.throwIfAborted();
              s.config.paused = false;
              s.error = null;
              s.nextAt = 0;
              for (const scan of Object.values(s.scans)) scan.nextAt = 0;
              store.save(s);
              kick();
              return { paused: false, checks: result.checks };
            },
            ctx,
            "slack-watch resume",
          ),
      }),
      "slack-watch token rotate": cliCommand({
        summary: "Validate the same bot and workspace before atomically replacing its token",
        positionals: profile,
        options: { token },
        run: ({ positionals: p, options: o }, ctx) =>
          guard(
            async (signal) => {
              const s = store.get(profileName.parse(p.profile));
              const result = await probe(new SlackClient(o.token, deps.fetch), s.config.channels, signal);
              if (!sameIdentity(result.identity, s.identity)) throw new OperatorError("Rotation must preserve workspace, bot and user identity");
              signal.throwIfAborted();
              credentials.write(p.profile, o.token);
              return { rotated: true, identity: s.identity };
            },
            ctx,
            "slack-watch token rotate",
          ),
      }),
    },
  });
  // defineCli's parse errors can echo offending argv. Keep ALL watcher failures out of the legacy raw-argv audit.
  const cli = {
    ...declared,
    async run(argv: string[], ctx: Parameters<typeof declared.run>[1]) {
      try {
        const result = await declared.run(argv, ctx);
        return result.exitCode === 0
          ? result
          : { exitCode: 1, stderr: "Invalid slack-watch arguments; use bb orchestrator slack-watch --help. Pass secrets with --token-stdin.\n" };
      } catch (e) {
        return {
          exitCode: 1,
          stderr: `${e instanceof OperatorError || e instanceof SlackError || e instanceof UnknownProfile ? e.message : "Watcher command failed; check config, protected credential storage and Slack access"}\n`,
        };
      }
    },
  };
  bb.background.service("slack-watch", {
    async start(signal) {
      const stopping = AbortSignal.any([signal, lifetime.signal]);
      // Once a watcher has been set up (its credentials folder exists), check the marker against SQLite once per
      // start: a crash between a save and the marker write, a restored database or a deleted marker must not leave an
      // enabled profile silently unpolled. A fresh install has no such folder, so it still reads nothing.
      if (existsSync(credentials.dir))
        await exclusive(async () => {
          try {
            syncEnabled();
          } catch {
            // the marker stays as it was; status repairs it
          }
        });
      while (!stopping.aborted) {
        kicked = false;
        const names = await exclusive(async () => (stopping.aborted ? [] : enabled()));
        // Nothing enabled (a fresh install, or every profile paused): no timer and no reads until a resume.
        if (!names.length) {
          await idle(stopping);
          continue;
        }
        for (const name of names) {
          if (stopping.aborted) break;
          await exclusive(async () => {
            if (stopping.aborted || pausing.has(name)) return;
            const controller = new AbortController();
            active = { name, controller };
            try {
              await runner.step(name, AbortSignal.any([stopping, controller.signal]), 2);
            } finally {
              active = null;
            }
          });
        }
        try {
          await sleep(1000, undefined, { signal: stopping });
        } catch {
          break;
        }
      }
    },
  });
  bb.onDispose(async () => {
    lifetime.abort();
    active?.controller.abort();
    await queue;
  });
  return { cli, routes: () => store.routes() };
}
