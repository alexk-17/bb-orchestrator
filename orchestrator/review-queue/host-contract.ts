import { z } from "zod";
import { factsSchema, outcomeSchema } from "./core.ts";
const url = z.string().max(500);
export const queueHostDefs = {
  "reviewQueue.identity": {
    input: z.null(),
    output: z.string().min(1),
    experimental_retryable: true,
  },
  "reviewQueue.discover": {
    input: z.null(),
    output: z.array(url).max(50),
    experimental_retryable: true,
  },
  "reviewQueue.inspect": {
    input: z.object({ url }).strict(),
    output: factsSchema,
    experimental_retryable: true,
  },
  "reviewQueue.outcome": {
    input: z.object({ url, at: z.number() }).strict(),
    output: z.object({
      outcome: outcomeSchema.nullable(),
      cooldownUntil: z.number().nullable(),
    }),
    experimental_retryable: true,
  },
  // Deliberately NOT retryable. An interrupted response is an unknown write, never permission to repeat it.
  "reviewQueue.post": {
    input: z
      .object({
        url,
        head: z.string().min(1),
        login: z.string().min(1),
        auto: z.boolean(),
        dryRun: z.boolean(),
      })
      .strict(),
    output: z.object({
      outcome: outcomeSchema,
      commentUrl: z.string().nullable(),
      note: z.string(),
    }),
  },
} as const;
