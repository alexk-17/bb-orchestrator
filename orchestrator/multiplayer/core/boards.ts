import { z } from "zod";

export const SLACK_CHANNEL_RE = /^[CG][A-Z0-9]{6,20}$/;
export const SLACK_USER_RE = /^[UW][A-Z0-9]{6,20}$/;
/** A Slack message permalink: https://<workspace>.slack.com/archives/<channel>/p<ts> */
export const SLACK_PERMALINK_RE = /^https:\/\/[a-z0-9-]{1,63}\.slack\.com\/archives\/[CGD][A-Z0-9]{6,20}\/p\d{6,20}(?:\?[\w=&.%-]{0,200})?$/;
export const WATCHER_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export interface Board {
  id: string;
  channel: string;
  /** The workspace's own channel link, when the owner pasted one. */
  link: string | null;
  watcher: string | null;
  name: string;
  purpose: string;
  setup: string | null;
  createdAt: number;
}

export const boardAddBody = z
  .object({
    channel: z.string().trim().min(1).max(500),
    watcher: z.string().max(64).nullable().optional(),
    name: z.string().trim().max(80).optional(),
    purpose: z.string().trim().max(200).optional(),
    setup: z.string().trim().max(500).optional(),
  })
  .strict();
export type BoardAdd = z.infer<typeof boardAddBody>;
export const boardRemoveBody = z.object({ id: z.string().min(1).max(40) }).strict();

export function parseChannel(input: string): { channel: string; link: string | null } | null {
  const s = input.trim();
  if (SLACK_CHANNEL_RE.test(s)) return { channel: s, link: null };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !/(^|\.)slack\.com$/.test(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const at = parts.indexOf("archives");
  const id = at >= 0 ? parts[at + 1] : parts[0] === "client" ? parts[2] : (u.searchParams.get("channel") ?? undefined);
  if (!id || !SLACK_CHANNEL_RE.test(id)) return null;
  const link = at >= 0 && /^[a-z0-9-]+\.slack\.com$/.test(u.hostname) && u.hostname !== "app.slack.com" ? `https://${u.hostname}/archives/${id}` : null;
  return { channel: id, link };
}

export const openLink = (b: Pick<Board, "channel" | "link">): string => b.link ?? `https://slack.com/app_redirect?channel=${b.channel}`;

export function checkBoard(input: BoardAdd, sources: readonly string[]): { channel: string; link: string | null; watcher: string | null; name: string; purpose: string; setup: string | null } {
  const ch = parseChannel(input.channel);
  if (!ch) throw new Error("Paste the channel's link (Copy link in Slack) or its id (C… or G…)");
  const watcher = input.watcher?.trim() || null;
  if (watcher && (!WATCHER_RE.test(watcher) || !sources.includes(watcher))) throw new Error(`No watcher ${JSON.stringify(watcher)}: pick one of integrationRoutes' sources, or none`);
  const setup = input.setup?.trim() || null;
  if (setup && !SLACK_PERMALINK_RE.test(setup)) throw new Error("The setup message is a Slack message link (Copy link on the message)");
  return { ...ch, watcher, name: (input.name ?? "").trim().replace(/^#/, ""), purpose: (input.purpose ?? "").trim(), setup };
}
