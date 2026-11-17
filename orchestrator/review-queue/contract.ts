import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { configSchema, stateSchema } from "./core.ts";
export const QUEUE_CHANNEL = "review-queue";
export const queueViewSchema = stateSchema.extend({
  dryRun: z.boolean(),
  busy: z.boolean(),
  spacingUntil: z.number(),
  providers: z.array(z.object({ id: z.string(), name: z.string() })),
  hosts: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type QueueView = z.infer<typeof queueViewSchema>;
export const queueActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), url: z.string().max(500) }).strict(),
  z.object({ action: z.literal("remove"), url: z.string().max(500) }).strict(),
  z.object({ action: z.literal("pin"), url: z.string().max(500) }).strict(),
  z
    .object({
      action: z.literal("reorder"),
      urls: z.array(z.string().max(500)).max(50),
    })
    .strict(),
  z.object({ action: z.literal("configure"), config: configSchema }).strict(),
  z.object({ action: z.enum(["refresh", "run"]) }).strict(),
]);
export const queueContract = defineRpcContract({
  reviewQueue: { input: z.null(), output: queueViewSchema },
  reviewQueueAction: {
    input: queueActionSchema,
    output: z.object({ ok: z.literal(true) }),
  },
});
