// This file stays on the server. Only GitHub logins and mention labels leave it.
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { humanLogin } from "../core/pr-review-queue.ts";

const directory = z.object({ users: z.array(z.object({
  active: z.boolean().optional(),
  github: z.object({ login: z.string().nullable().optional() }).nullable().optional(),
  slack: z.object({ mention: z.string().nullable().optional() }).nullable().optional(),
})) });

export function parsePeopleDirectory(text: string): Record<string, string> {
  const parsed = directory.parse(parse(text, { maxAliasCount: 50 }));
  const entries = parsed.users.flatMap((p) => {
    const login = p.github?.login?.trim();
    const mention = p.slack?.mention?.trim();
    return p.active !== false && login && humanLogin(login) && mention && /^@[^@<>|\r\n]+$/.test(mention)
      ? [[login.toLowerCase(), mention]] : [];
  });
  return Object.fromEntries(entries);
}

export async function readPeopleDirectory(path: string): Promise<{ mentions: Record<string, string>; error: string | null }> {
  if (!path.trim()) return { mentions: {}, error: null };
  try {
    const text = await readFile(path.trim(), "utf8");
    if (text.length > 1024 * 1024) throw new Error("too large");
    return { mentions: parsePeopleDirectory(text), error: null };
  } catch {
    // Parser diagnostics can contain the directory's private contents. Don't return them.
    return { mentions: {}, error: "Could not read peopleFilePath: use a readable YAML file with a users list, github.login and slack.mention. No mentions were added." };
  }
}
