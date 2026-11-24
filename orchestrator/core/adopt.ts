import type { Engine } from "./engine.ts";
import { EngineError, type Role } from "./model.ts";

export type Adoption = { threadId: string; role: Role; project: string | null; parentThreadId: string | null; approval: string };
export type AdoptThread = { id: string; status: string; archivedAt: number | null; parentThreadId: string | null; parentNotifications?: string; environmentId: string | null; projectId: string };
export type AdoptPorts = {
  engine: Engine;
  get(threadId: string): Promise<AdoptThread>;
  queued(threadId: string): Promise<boolean>;
  /** Sets the bb parent and how bb tells it about the thread ("stuck": failed, interrupted or blocked on a prompt; "auto": every turn end too). */
  parent(threadId: string, parentThreadId: string, notify: "stuck" | "auto"): Promise<void>;
  mirror(threadId: string, address: string, role: Role): Promise<void>;
};

/** Adoption is an owner operation at an idle checkpoint, never a spawn or role takeover. */
export async function adoptThread(p: AdoptPorts, request: Adoption) {
  p.engine.checkAdoption(request);
  const before = await p.get(request.threadId);
  const check = (t: AdoptThread) => {
    if (t.id !== request.threadId || t.status !== "idle" || t.archivedAt !== null) throw new EngineError("bad_state", "adopt only an existing idle, unarchived thread");
    if (!t.environmentId) throw new EngineError("bad_state", "adoption requires the thread's existing environment");
    if (t.parentThreadId !== null && t.parentThreadId !== request.parentThreadId) throw new EngineError("conflict", "bb parent differs from the approved parent");
  };
  check(before);
  if (await p.queued(request.threadId)) throw new EngineError("bad_state", "adoption requires an empty message queue");
  if (request.parentThreadId) {
    const parent = await p.get(request.parentThreadId);
    if (parent.archivedAt !== null) throw new EngineError("bad_state", "the approved parent is archived");
  }
  p.engine.checkAdoption(request);
  // An adopted thread gets the level orch_spawn_thread gives a new one ("stuck"), even when its bb parent is already
  // right: under "auto", bb wakes the lead at every turn end of the thread, outside the plugin's inbox and its wake gap.
  // bb still tells the lead of a failure or a prompt, and reports reach it through the plugin. Other roles keep "auto" on a reparent.
  const notify = request.role === "thread" ? "stuck" : "auto";
  if (request.parentThreadId && (before.parentThreadId !== request.parentThreadId || (notify === "stuck" && before.parentNotifications !== notify)))
    await p.parent(request.threadId, request.parentThreadId, notify);
  // bb and SQLite cannot share a transaction. A retry converges after a failed read or metadata write;
  // a conflict is reported for operator reconciliation, never repaired by stopping or respawning a thread.
  const after = await p.get(request.threadId);
  check(after);
  if (await p.queued(request.threadId)) throw new EngineError("bad_state", "message queued during adoption; reconcile before retrying");
  if (after.parentThreadId !== request.parentThreadId || after.environmentId !== before.environmentId || after.projectId !== before.projectId) throw new EngineError("conflict", "thread changed during adoption; reconcile before retrying");
  const a = p.engine.adopt(request, after.environmentId, after.projectId);
  await p.mirror(a.threadId, a.address, a.role);
  return a;
}
