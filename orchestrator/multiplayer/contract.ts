// The board writes go through server.ts's page gate only: no agent tool adds or removes a board.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { findingSchema } from "./core/findings.ts";
import { RECORD_STATES, STEPS } from "./core/records.ts";

/** Published when a board, record, heartbeat, Slack or GitHub read changes, so an open tab refetches. */
export const MULTIPLAYER_CHANNEL = "multiplayer";
export const MULTIPLAYER_WRITES = { add: "/multiplayer/board/add", remove: "/multiplayer/board/remove" } as const;

const agentSchema = z.object({ address: z.string(), threadId: z.string().nullable(), status: z.string().nullable() });
export const healthSchema = z.object({
  state: z.enum(["none", "healthy", "late", "unknown"]),
  lastAt: z.number().nullable(),
  nextAt: z.number().nullable(),
  everyMs: z.number().nullable(),
});

export const boardViewSchema = z.object({
  id: z.string(),
  channel: z.string(),
  open: z.string(),
  name: z.string(),
  private: z.boolean().nullable(),
  purpose: z.string(),
  setup: z.string().nullable(),
  /** Where the name and purpose came from: Slack, or the owner's typed fallback. */
  from: z.enum(["slack", "typed"]),
  note: z.string().nullable(),
  watch: z.object({ source: z.string(), agents: z.array(agentSchema), health: healthSchema, reads: z.number(), lastWake: z.number().nullable() }).nullable(),
  tracked: z.array(z.object({ id: z.string(), owner: z.string(), url: z.string(), when: z.string(), state: z.string().nullable(), checks: z.string().nullable(), review: z.string().nullable(), readAt: z.number().nullable() })),
});
export type BoardView = z.infer<typeof boardViewSchema>;

export const prViewSchema = z.object({
  url: z.string(),
  name: z.string(),
  class: z.string().nullable(),
  title: z.string().nullable(),
  review: z
    .object({ url: z.string(), state: z.string().nullable(), verdict: z.string().nullable(), commit: z.string().nullable(), submittedAt: z.number().nullable(), findings: z.array(findingSchema).nullable() })
    .nullable(),
});
export type PrView = z.infer<typeof prViewSchema>;

export const recordViewSchema = z.object({
  id: z.string(),
  board: z.string(),
  lead: z.string(),
  state: z.enum(RECORD_STATES),
  note: z.string().nullable(),
  asker: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  permalink: z.string().nullable(),
  askedAt: z.number().nullable(),
  times: z.partialRecord(z.enum(STEPS), z.number()),
  thread: z.object({ ref: z.string(), address: z.string().nullable(), threadId: z.string().nullable(), status: z.string().nullable() }).nullable(),
  prs: z.array(prViewSchema),
  reply: z.string().nullable(),
  deliverable: z.object({ id: z.string(), state: z.string(), rev: z.number(), flag: z.string().nullable(), card: z.string().nullable() }).nullable(),
  /** The owner has something to do: its deliverable is in review, or (none yet) the lead set waits. */
  waitsOnYou: z.boolean(),
  createdAt: z.number(),
});
export type RecordView = z.infer<typeof recordViewSchema>;

export const multiplayerViewSchema = z.object({
  boards: z.array(boardViewSchema),
  records: z.array(recordViewSchema),
  /** integrationRoutes' sources: the watchers a board can name. */
  sources: z.array(z.string()),
  slack: z.boolean(),
  now: z.number(),
});
export type MultiplayerView = z.infer<typeof multiplayerViewSchema>;

export const multiplayerContract = defineRpcContract({
  multiplayer: { input: z.null(), output: multiplayerViewSchema },
});
