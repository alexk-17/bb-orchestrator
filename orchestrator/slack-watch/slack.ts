import { z } from "zod";
import { timestamp, type Identity } from "./config.ts";

const message = z.object({
  ts: timestamp,
  thread_ts: timestamp.optional(),
  text: z.string().default(""),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
  reply_count: z.number().optional(),
  edited: z.object({ ts: timestamp }).optional(),
});
export type Message = z.infer<typeof message>;
const page = z.object({
  messages: z.array(message).max(1000),
  has_more: z.boolean().optional(),
  response_metadata: z.object({ next_cursor: z.string().max(4096).optional() }).optional(),
});
export class SlackError extends Error {
  retryMs: number;
  constructor(code: string, retryMs = 60_000) {
    super(code);
    this.retryMs = retryMs;
  }
}
const codes = new Set([
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "not_authed",
  "missing_scope",
  "not_in_channel",
  "channel_not_found",
  "is_archived",
  "thread_not_found",
  "invalid_cursor",
  "ratelimited",
  "message_not_found",
]);
/** Only read methods exist here. Never reflect Slack text, HTTP bodies or credentials into errors. */
export class SlackClient {
  #token: string;
  #fetch: typeof fetch;
  constructor(token: string, fetcher: typeof fetch = fetch) {
    this.#token = token;
    this.#fetch = fetcher;
  }
  async call(
    method: "auth.test" | "conversations.info" | "conversations.history" | "conversations.replies" | "chat.getPermalink",
    params: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await this.#fetch(url, {
        headers: { Authorization: `Bearer ${this.#token}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        redirect: "error",
      });
    } catch {
      throw new SlackError(signal.aborted ? "cancelled" : "Slack read failed");
    }
    if (res.status === 429) {
      const seconds = Number(res.headers.get("retry-after"));
      throw new SlackError("ratelimited", Number.isFinite(seconds) && seconds > 0 ? Math.max(1000, seconds * 1000) : 60000);
    }
    if (!res.ok) throw new SlackError(`Slack HTTP ${res.status}`);
    let data: Record<string, unknown>;
    try {
      data = z.record(z.string(), z.unknown()).parse(await res.json());
    } catch {
      throw new SlackError("Invalid Slack response");
    }
    if (data.ok !== true) throw new SlackError(codes.has(String(data.error)) ? String(data.error) : "Slack API error");
    return data;
  }
  async identity(signal: AbortSignal): Promise<Identity> {
    const r = await this.call("auth.test", {}, signal);
    if (![r.team_id, r.user_id, r.bot_id].every((v) => typeof v === "string" && /^[A-Z0-9]+$/.test(v)))
      throw new SlackError("A workspace bot token is required");
    return { team: r.team_id as string, user: r.user_id as string, bot: r.bot_id as string };
  }
  async info(channel: string, signal: AbortSignal) {
    const r = await this.call("conversations.info", { channel }, signal);
    const c = r.channel as Record<string, unknown> | undefined;
    if (!c || c.id !== channel || c.is_member !== true || c.is_archived === true) throw new SlackError("Invite the bot to an active allow-listed channel");
  }
  async page(channel: string, root: string | null, cursor: string, latest: string, signal: AbortSignal) {
    const data = await this.call(
      root ? "conversations.replies" : "conversations.history",
      { channel, ...(root ? { ts: root } : {}), cursor, latest, inclusive: "true", limit: "100" },
      signal,
    );
    const r = page.safeParse(data);
    if (!r.success) throw new SlackError("Invalid Slack page");
    const next = r.data.response_metadata?.next_cursor ?? "";
    if ((r.data.has_more && !next) || (next && next === cursor)) throw new SlackError("Slack pagination did not advance");
    return { messages: r.data.messages, next };
  }
  async permalink(channel: string, ts: string, signal: AbortSignal) {
    const r = await this.call("chat.getPermalink", { channel, message_ts: ts }, signal);
    try {
      const u = new URL(String(r.permalink));
      if (u.protocol === "https:" && u.hostname.endsWith(".slack.com") && !u.username && !u.password && u.href.length <= 1000) return u.href;
    } catch {
      /* fixed error below */
    }
    throw new SlackError("Invalid Slack permalink");
  }
}
