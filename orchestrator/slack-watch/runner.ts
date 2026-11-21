import { createHash } from "node:crypto";
import { tx } from "../core/db.ts";
import type { ExternalMail } from "../core/integration.ts";
import { after, stamp, type Route } from "./config.ts";
import { SlackClient, SlackError, type Message } from "./slack.ts";
import { WatchStore, type Profile } from "./store.ts";

export interface WatchDeps {
  client: (profile: string) => SlackClient;
  recipient: (address: string) => boolean;
  routeEnabled?: (source: string, to: string) => boolean;
  importMail: (mail: ExternalMail) => unknown;
  heartbeat: (source: string, everyMs: number) => unknown;
  now?: () => number;
}
const ignored = new Set(["channel_join", "channel_leave", "group_join", "group_leave", "channel_name", "channel_purpose", "channel_topic"]);
/** A step is bounded; SQLite holds the continuation between steps and across service reloads. */
export class WatchRunner {
  store: WatchStore;
  deps: WatchDeps;
  now: () => number;
  constructor(store: WatchStore, deps: WatchDeps) {
    this.store = store;
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }
  stage(p: Profile, route: Route, m: Message) {
    if (m.reply_count && (!m.thread_ts || m.thread_ts === m.ts) && !ignored.has(m.subtype ?? "")) this.store.root(p.config.profile, route.id, m.ts);
    if (ignored.has(m.subtype ?? "") || m.user === p.identity.user || m.bot_id === p.identity.bot) return;
    if (!after(m.edited?.ts ?? m.ts, p.scans[route.id]!.baseline)) return;
    // Metadata such as reply_count changes as a thread grows. Only message content/identity defines a revision.
    const text = m.text.slice(0, 19500) + (m.text.length > 19500 ? "\n[Slack text truncated; open permalink]" : "");
    const sender = m.bot_id ? `slack-bot:${m.bot_id}${m.user ? ` (user ${m.user})` : ""}` : `slack-user:${m.user ?? "unknown"}`;
    const revision = createHash("sha256")
      .update(JSON.stringify([m.edited?.ts ?? "original", sender, text]))
      .digest("hex");
    const id = `${p.identity.team}:${route.id}:${m.ts}:${revision}`;
    const mail: ExternalMail = {
      source: route.source,
      id,
      originalId: `${p.identity.team}:${route.id}:${m.ts}`,
      to: route.to,
      sender: sender.slice(0, 200),
      task: `Slack ${route.id} thread ${m.thread_ts ?? m.ts}`,
      severity: "ACTIONABLE",
      summary: (text || "[Slack message without text; open permalink]").slice(0, 4000),
      body: text,
      refs: [],
      re: null,
      createdAt: Math.floor(Number(m.edited?.ts ?? m.ts) * 1000),
      dueAt: null,
      needsReply: true,
    };
    this.store.stage({ key: `${route.source}:${id}`, profile: p.config.profile, channel: route.id, ts: m.ts, mail, linked: false });
  }
  async step(name: string, signal: AbortSignal, budget = 10): Promise<void> {
    let p = this.store.get(name);
    if (p.config.paused || p.nextAt > this.now() || signal.aborted || !p.config.channels.length) return;
    let client: SlackClient;
    try {
      client = this.deps.client(name);
    } catch {
      p.error = "Credential storage unavailable";
      p.nextAt = this.now() + 60000;
      this.store.save(p);
      return;
    }
    for (let i = 0; i < budget && !signal.aborted; i++) {
      // Round-robin channels, including while a large channel is still paging or draining its outbox.
      const channels = p.config.channels;
      const start = (p.turn ?? 0) % channels.length;
      const route = [...channels.slice(start), ...channels.slice(0, start)].find((c) => p.scans[c.id]!.nextAt <= this.now());
      if (!route) break;
      const turn = (channels.indexOf(route) + 1) % channels.length;
      try {
        const s = p.scans[route.id]!;
        if (this.deps.routeEnabled?.(route.source, route.to) === false)
          throw new SlackError("Source conflicts with integrationRoutes; choose distinct sources");
        if (!this.deps.recipient(route.to)) throw new SlackError("Recipient unavailable; repair route or role");
        const pending = this.store.pending(name, route.id);
        if (pending) {
          if (!pending.linked) {
            try {
              pending.mail.refs = [await client.permalink(pending.channel, pending.ts, signal)];
            } catch (e) {
              if (!(e instanceof SlackError) || e.message !== "message_not_found") throw e;
              pending.mail.summary = `[Message removed before permalink lookup] ${pending.mail.summary}`.slice(0, 4000);
              pending.mail.needsReply = false;
              pending.mail.severity = "INFO";
            }
            if (signal.aborted) return;
            pending.linked = true;
            this.store.link(pending);
          }
          // Saved before import: an interrupted acceptance replays the identical envelope.
          this.deps.importMail(pending.mail);
          this.store.done(pending.key);
        } else {
          if (s.phase === "complete") {
            s.phase = "history";
            s.latest = null;
            s.cursor = "";
            s.root = "";
            s.pages = 0;
          }
          s.latest ??= stamp(this.now());
          const root = s.phase === "replies" ? (s.cursor ? s.root : this.store.nextRoot(name, route.id, s.root)) : null;
          if (s.phase === "replies" && !root) {
            this.deps.heartbeat(route.source, p.config.pollSeconds * 1000);
            s.heartbeat = this.now();
            s.phase = "complete";
            s.nextAt = this.now() + p.config.pollSeconds * 1000;
          } else {
            let result;
            try {
              result = await client.page(route.id, root, s.cursor, s.latest, signal);
            } catch (e) {
              if (e instanceof SlackError && e.message === "thread_not_found" && root) {
                s.root = root;
                s.cursor = "";
                p.turn = turn;
                this.store.save(p);
                continue;
              }
              if (e instanceof SlackError && e.message === "invalid_cursor") {
                // Explicitly persist a restart of this leg, never a page we failed to accept.
                const committed = this.store.get(name);
                committed.scans[route.id]!.cursor = "";
                if (committed.scans[route.id]!.phase === "replies") committed.scans[route.id]!.root = "";
                this.store.save(committed);
              }
              throw e;
            }
            if (signal.aborted) return;
            tx(this.store.db, () => {
              for (const m of result.messages) this.stage(p, route, m);
              s.cursor = result.next;
              if (root) s.root = root;
              else if (!result.next) s.phase = "replies";
              s.lastRead = this.now();
              s.pages++;
              p.turn = turn;
              this.store.save(p);
            });
          }
        }
        s.error = null;
        p.error = null;
        p.turn = turn;
        this.store.save(p);
      } catch (e) {
        if (signal.aborted) return;
        // A page's in-memory checkpoint may have advanced before its transaction rolled back.
        // Error recording MUST start from committed state, never publish that failed checkpoint.
        p = this.store.get(name);
        const error = e instanceof SlackError ? e.message : "Watcher failed; check route and local storage";
        const retryAt = this.now() + (e instanceof SlackError ? e.retryMs : 60000);
        p.scans[route.id]!.error = error;
        p.scans[route.id]!.nextAt = retryAt;
        p.turn = turn;
        if (e instanceof SlackError && ["ratelimited", "invalid_auth", "token_revoked", "account_inactive", "not_authed"].includes(e.message)) {
          p.error = error;
          p.nextAt = retryAt;
          this.store.save(p);
          return;
        }
        this.store.save(p);
      }
    }
  }
}
