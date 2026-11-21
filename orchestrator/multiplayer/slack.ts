// No message history is read, and nothing from a message is kept but a pinned message's permalink.
import { SlackError, slackClient, type SlackFetch } from "../open-prs/slack.ts";

export const SLACK_READS = ["conversations.info", "pins.list", "users.info"] as const;

export interface Header {
  name: string | null;
  private: boolean | null;
  purpose: string | null;
  setup: string | null;
  /** Why some or all of it couldn't be read; the typed fields stand in. */
  note: string | null;
}

const HEADER_MS = 10 * 60_000;
const USER_MS = 6 * 3600_000;
const FAILED_MS = 2 * 60_000;

type Entry<T> = { at: number; ttl: number; value: T };

/** A cache that never waits: a miss starts one read and answers undefined; the read's landing calls `landed`. */
function lazy<T>(now: () => number, landed: () => void) {
  const kept = new Map<string, Entry<T>>();
  const running = new Set<string>();
  return (key: string, read: () => Promise<{ value: T; ttl: number }>): T | undefined => {
    const e = kept.get(key);
    if ((!e || now() - e.at > e.ttl) && !running.has(key)) {
      running.add(key);
      void read()
        .then((r) => kept.set(key, { at: now(), ttl: r.ttl, value: r.value }))
        .finally(() => {
          running.delete(key);
          landed();
        });
    }
    return e?.value;
  };
}

const why = (e: unknown) => (e instanceof SlackError ? e.message : "Slack didn't answer");

export function boardSlack(fetchImpl: SlackFetch, landed: () => void, now: () => number = Date.now) {
  const headers = lazy<Header>(now, landed);
  const users = lazy<string | null>(now, landed);

  async function readHeader(token: string, channel: string): Promise<{ value: Header; ttl: number }> {
    const c = slackClient(token, fetchImpl);
    const h: Header = { name: null, private: null, purpose: null, setup: null, note: null };
    const notes: string[] = [];
    try {
      const j = await c.call("conversations.info", { channel });
      const ch = (j.channel ?? {}) as { name?: string; is_private?: boolean; purpose?: { value?: string } };
      h.name = ch.name ?? null;
      h.private = typeof ch.is_private === "boolean" ? ch.is_private : null;
      h.purpose = ch.purpose?.value?.trim() || null;
    } catch (e) {
      notes.push(why(e));
    }
    try {
      const j = await c.call("pins.list", { channel });
      const pins = ((j.items ?? []) as { type?: string; created?: number; message?: { permalink?: string } }[]).filter((p) => p.message?.permalink);
      pins.sort((a, b) => (a.created ?? 0) - (b.created ?? 0));
      h.setup = pins[0]?.message?.permalink ?? null; // the oldest pin is the setup message
    } catch (e) {
      notes.push(why(e));
    }
    h.note = notes.length ? notes.join(" ") : null;
    return { value: h, ttl: notes.length ? FAILED_MS : HEADER_MS };
  }

  async function readUser(token: string, id: string): Promise<{ value: string | null; ttl: number }> {
    try {
      const j = await slackClient(token, fetchImpl).call("users.info", { user: id });
      const u = (j.user ?? {}) as { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };
      const name = u.profile?.display_name?.trim() || u.profile?.real_name?.trim() || u.real_name?.trim() || u.name?.trim() || null;
      return { value: name, ttl: USER_MS };
    } catch {
      return { value: null, ttl: FAILED_MS };
    }
  }

  return {
    /** The header as last read (undefined until the first read lands). */
    header: (token: string, channel: string) => headers(`${token.slice(-8)}\n${channel}`, () => readHeader(token, channel)),
    /** The asker's Slack name as last read (undefined until read, null when Slack wouldn't say). */
    user: (token: string, id: string) => users(`${token.slice(-8)}\n${id}`, () => readUser(token, id)),
  };
}
