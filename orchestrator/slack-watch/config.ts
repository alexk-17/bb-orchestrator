import { z } from "zod";

export const profileName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
export const channelSchema = z
  .object({
    id: z.string().regex(/^[CG][A-Z0-9]+$/),
    source: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    to: z.string().regex(/^(cos|steward|lead:[a-z0-9_-]+)$/),
  })
  .strict();
export const configSchema = z
  .object({
    version: z.literal(1),
    profile: profileName,
    paused: z.boolean().default(true),
    pollSeconds: z.number().int().min(30).max(86400).default(60),
    startFrom: z.literal("now").default("now"),
    channels: z.array(channelSchema).min(1).max(50),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const key of ["id", "source"] as const)
      if (new Set(c.channels.map((r) => r[key])).size !== c.channels.length) ctx.addIssue({ code: "custom", message: `Duplicate channel ${key}` });
  });
export type Config = z.infer<typeof configSchema>;
export type Route = z.infer<typeof channelSchema>;
export interface Identity {
  team: string;
  user: string;
  bot: string;
}
export const timestamp = z.string().regex(/^\d{1,16}\.\d{6}$/);
export const stamp = (ms: number) => `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")}000`;
export const after = (a: string, b: string) => BigInt(a.replace(".", "")) > BigInt(b.replace(".", ""));
