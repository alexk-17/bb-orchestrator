// Threads that bb still tells their lead about at every turn end (2026-11-24, the lead's ask). orch_spawn_thread has
// set parentNotifications "stuck" since 2026-11-20, and handoff successors and adopted threads get it too from this
// release. Threads made before either kept bb's "auto": bb woke the lead with "… completed" at every turn end of
// them, outside the plugin's inbox and its wake gap. The startup reconcile sets those to "stuck", once each; a thread
// already at "stuck" is never touched again, so a restart changes nothing.
import type { Engine } from "./engine.ts";
import type { Agent } from "./model.ts";

/** What bb says about a thread's parent and notify level (fields of its thread object). */
export type BbNotify = { parentThreadId?: string | null; parentNotifications?: string; archivedAt?: number | null };

/**
 * Live thread agents whose bb thread is still at "auto" under their own lead's thread. Only these move to "stuck":
 * a thread with another bb parent, or none, gets no bb notice from the lead's side anyway, and leads, stewards and
 * the CoS keep their level.
 */
export function autoUnderLead(engine: Engine, threads: Map<string, BbNotify>): { agent: Agent; leadThreadId: string }[] {
  const out: { agent: Agent; leadThreadId: string }[] = [];
  for (const agent of engine.agents()) {
    if (agent.role !== "thread") continue;
    const t = threads.get(agent.threadId);
    if (!t || t.archivedAt || t.parentNotifications !== "auto") continue;
    const sup = engine.supervisorOf(agent);
    const lead = sup ? engine.agentByAddress(sup) : null;
    if (!lead || lead.role !== "lead" || !t.parentThreadId || t.parentThreadId !== lead.threadId) continue;
    out.push({ agent, leadThreadId: lead.threadId });
  }
  return out;
}
