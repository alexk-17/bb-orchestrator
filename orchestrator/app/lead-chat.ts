// The chat with a project's lead (1.13.0), without JSX so node --test checks it. The Scope tab and the Projects detail
// draw the lead's own bb thread as the Chat tab draws the CoS's (the host's ThreadChat, transcript only), and the
// orchestrator's composer stays under it: the owner's words must stay a tracked direct message (the lead acks it, the
// CoS gets a copy, the 48 h rule applies), which ThreadChat's own composer would not send. With no live lead thread
// there is no transcript to draw, so the 1.10.0 log of direct messages shows instead.
import type { z } from "zod";
import { WRITES, type DirectLine, type Projects, type directMessageBody } from "../contract.ts";
import { directState } from "./command-center.ts";

type Project = Projects[number];
type DirectMessage = DirectLine["messages"][number];

/** A lead whose thread bb no longer runs: stopped by the orchestrator, or archived. Its mail is held, not delivered. */
const NOT_LIVE = new Set(["stopped", "archived"]);

/**
 * What the chat area draws for a project's lead: its thread (live: the transcript shows what it reads and does), or the
 * direct-message log, when there is no lead, or its thread is stopped or archived.
 */
export type LeadChatView = { kind: "thread"; threadId: string } | { kind: "log"; why: "no-lead" | "not-live" };
export function leadChatView(lead: Project["lead"]): LeadChatView {
  if (!lead) return { kind: "log", why: "no-lead" };
  if (NOT_LIVE.has(lead.status)) return { kind: "log", why: "not-live" };
  return { kind: "thread", threadId: lead.threadId };
}

/**
 * The write the composer sends, whichever view is above it: always the owner's tracked direct message to the lead
 * (owner.message), never a plain message into the thread. `images` (2026-11-17): the ids the image write returned,
 * in the order attached; a text-only send has no images field, as before. `task` (2026-11-23): the work-board task it is
 * about, from the board's card panel; the lead reads the task's id and title at the top.
 */
export function directWrite(slug: string, text: string, followUp: string | null, images: readonly string[] = [], task?: string): { path: string; body: z.input<typeof directMessageBody> } {
  return { path: WRITES.directMessage, body: { slug, text, followUp, ...(images.length ? { images: [...images] } : {}), ...(task ? { task } : {}) } };
}

/** The write for one image before the message (2026-11-17): its name, its type and its bytes as base64. */
export function imageWrite(slug: string, name: string, mime: string, data: string): { path: string; body: { slug: string; name: string; mime: string; data: string } } {
  return { path: WRITES.directImage, body: { slug, name: name.slice(0, 200) || "image", mime, data } };
}

/**
 * Under the transcript, what the log used to say on each message: where the owner's latest one is (queued, delivered,
 * acked), and each one that died unacked (with Resend). The transcript shows the message once the lead's session
 * reads it, but not whether the lead acked it, nor that one went to the CoS undelivered.
 */
export function messageStates(d: Project["direct"], cos: string): { last: { id: string; at: number; word: string } | null; dead: DirectMessage[] } {
  const ms = d?.messages ?? [];
  const last = ms.reduce<DirectMessage | null>((x, m) => (!x || m.at > x.at ? m : x), null);
  const dead = ms.filter((m) => m.state === "dead");
  if (!last || last.state === "dead") return { last: null, dead };
  const st = directState(last, cos);
  const word = last.state === "closed" ? (st.word === "acked" ? "acked" : `closed: ${st.word}`) : st.word === "delivered" ? "delivered, not acked yet" : "queued for the lead";
  return { last: { id: last.id, at: last.at, word }, dead };
}
