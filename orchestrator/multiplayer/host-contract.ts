// The Multiplayer tab's one host method: a GitHub review and its inline comments, read with the machine's own gh login.
import { z } from "zod";
import { reviewReadSchema } from "./core/findings.ts";
import { REVIEW_URL_RE } from "./core/records.ts";

export const mpHostDefs = {
  "multiplayer.review": { input: z.object({ url: z.string().regex(REVIEW_URL_RE) }).strict(), output: reviewReadSchema, experimental_retryable: true },
} as const;
