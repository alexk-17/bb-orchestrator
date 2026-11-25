import { createHash } from "node:crypto";
import { z } from "zod";
import type { Role } from "./model.ts";

export const ROLE_TOOLS_KEY = "roleTools";

const baselineSchema = z.record(z.string(), z.object({ tools: z.array(z.string()), gen: z.number().int().nonnegative() }));
export type RoleToolsBaseline = z.infer<typeof baselineSchema>;
export type RoleToolsChange = { role: Role; key: string; body: string };

const sorted = (tools: readonly string[]) => [...new Set(tools)].sort();
const listKey = (tools: readonly string[]) => createHash("sha256").update(tools.join("\n")).digest("hex").slice(0, 12);

function noticeBody(added: string[], removed: string[]): string {
  const what = [added.length ? `added ${added.join(", ")}` : "", removed.length ? `removed ${removed.join(", ")}` : ""].filter(Boolean).join("; ");
  return `Your role's orchestrator tools changed with this install: ${what}. A running session keeps the tools it started with. If your tool list doesn't show this change yet, ack this, finish the turn's work, and run \`bb thread stop --self\` as your last command: your next wake resumes this conversation with the new tools.`;
}

/** No usable baseline is a first run: nothing says which tools the running agents started with, so it tells nobody. */
export function roleToolsChanges(kept: unknown, current: Readonly<Record<Role, readonly string[]>>): { baseline: RoleToolsBaseline; changes: RoleToolsChange[] } {
  const parsed = baselineSchema.safeParse(kept);
  const prev = parsed.success ? parsed.data : {};
  // a role no longer listed keeps its entry: its gen only grows, so a later change never reuses a sent notice's key
  const baseline: RoleToolsBaseline = { ...prev };
  const changes: RoleToolsChange[] = [];
  for (const [role, list] of Object.entries(current) as [Role, readonly string[]][]) {
    const tools = sorted(list);
    const was = prev[role];
    const before = was ? sorted(was.tools) : tools;
    if (!was || listKey(before) === listKey(tools)) {
      baseline[role] = { tools, gen: was?.gen ?? 0 };
      continue;
    }
    const gen = was.gen + 1;
    baseline[role] = { tools, gen };
    const added = tools.filter((t) => !before.includes(t));
    const removed = before.filter((t) => !tools.includes(t));
    changes.push({ role, key: `${role}:${gen}:${listKey(tools)}`, body: noticeBody(added, removed) });
  }
  return { baseline, changes };
}
