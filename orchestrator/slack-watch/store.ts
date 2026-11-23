import { tx, type Db } from "../core/db.ts";
import type { ExternalMail } from "../core/integration.ts";
import type { Config, Identity } from "./config.ts";

export interface Scan {
  baseline: string;
  latest: string | null;
  phase: "history" | "replies" | "complete";
  cursor: string;
  root: string;
  lastRead: number | null;
  heartbeat: number | null;
  pages: number;
  error: string | null;
  nextAt: number;
}
export interface Profile {
  config: Config;
  identity: Identity;
  scans: Record<string, Scan>;
  nextAt: number;
  error: string | null;
  turn?: number;
}
export interface Event {
  key: string;
  profile: string;
  channel: string;
  ts: string;
  mail: ExternalMail;
  linked: boolean;
}
export const newScan = (baseline: string): Scan => ({
  baseline,
  latest: null,
  phase: "history",
  cursor: "",
  root: "",
  lastRead: null,
  heartbeat: null,
  pages: 0,
  error: null,
  nextAt: 0,
});

export class UnknownProfile extends Error {
  constructor() {
    super("Unknown Slack watcher profile; list profiles with slack-watch routes");
  }
}

/** All scan checkpoints and outbox entries use the engine's SQLite database. */
export class WatchStore {
  db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  all(): Profile[] {
    return this.db
      .prepare("SELECT json FROM slack_watch_profiles ORDER BY name")
      .all()
      .map((r) => JSON.parse((r as { json: string }).json));
  }
  get(name: string): Profile {
    const r = this.db.prepare("SELECT json FROM slack_watch_profiles WHERE name=?").get(name) as { json: string } | undefined;
    if (!r) throw new UnknownProfile();
    return JSON.parse(r.json);
  }
  save(p: Profile) {
    this.db.prepare("UPDATE slack_watch_profiles SET json=? WHERE name=?").run(JSON.stringify(p), p.config.profile);
  }
  add(config: Config, identity: Identity, baseline: string) {
    const p: Profile = { config, identity, scans: Object.fromEntries(config.channels.map((c) => [c.id, newScan(baseline)])), nextAt: 0, error: null };
    this.db.prepare("INSERT INTO slack_watch_profiles(name,json) VALUES (?,?)").run(config.profile, JSON.stringify(p));
  }
  routes(): Record<string, string[]> {
    return Object.fromEntries(this.all().flatMap((p) => p.config.channels.map((c) => [c.source, [c.to]])));
  }
  root(profile: string, channel: string, ts: string) {
    this.db.prepare("INSERT OR IGNORE INTO slack_watch_roots(profile,channel,ts) VALUES (?,?,?)").run(profile, channel, ts);
  }
  nextRoot(profile: string, channel: string, after: string): string | null {
    return (
      (
        this.db.prepare("SELECT ts FROM slack_watch_roots WHERE profile=? AND channel=? AND ts>? ORDER BY ts LIMIT 1").get(profile, channel, after) as
          | { ts: string }
          | undefined
      )?.ts ?? null
    );
  }
  roots(profile: string, channel: string): number {
    return (this.db.prepare("SELECT count(*) AS n FROM slack_watch_roots WHERE profile=? AND channel=?").get(profile, channel) as { n: number }).n;
  }
  stage(e: Event) {
    this.db
      .prepare("INSERT OR IGNORE INTO slack_watch_events(key,profile,channel,json,done) VALUES (?,?,?,?,0)")
      .run(e.key, e.profile, e.channel, JSON.stringify(e));
  }
  pending(profile: string, channel?: string): Event | null {
    const r = this.db
      .prepare("SELECT json FROM slack_watch_events WHERE profile=? AND done=0 AND (? IS NULL OR channel=?) ORDER BY rowid LIMIT 1")
      .get(profile, channel ?? null, channel ?? null) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : null;
  }
  link(e: Event) {
    this.db.prepare("UPDATE slack_watch_events SET json=? WHERE key=?").run(JSON.stringify(e), e.key);
  }
  done(key: string) {
    this.db.prepare("UPDATE slack_watch_events SET done=1,json='{}' WHERE key=?").run(key);
  }
  backlog(profile: string): number {
    return (this.db.prepare("SELECT count(*) AS n FROM slack_watch_events WHERE profile=? AND done=0").get(profile) as { n: number }).n;
  }
  removeChannel(p: Profile, channel: string) {
    tx(this.db, () => {
      p.config.channels = p.config.channels.filter((c) => c.id !== channel);
      delete p.scans[channel];
      this.save(p);
      this.db.prepare("DELETE FROM slack_watch_roots WHERE profile=? AND channel=?").run(p.config.profile, channel);
      // Keep delivered dedup receipts. Pending imports on a removed route are explicitly discarded.
      this.db.prepare("DELETE FROM slack_watch_events WHERE profile=? AND channel=? AND done=0").run(p.config.profile, channel);
    });
  }
}
