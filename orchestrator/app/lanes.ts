// The Projects tab's agent lanes (2026-11-16, slice 1): one lane per live lead or thread of a project, from the reads the
// page already has (agents, needsYou). No JSX, so node --test checks it. What each lane says:
// - its state: waiting on the owner (an open card it asked, or a native prompt), blocked (its turn failed), released
//   (stopped, or its bb thread archived), working, or idle; and since when, where the orchestrator knows (idle, waiting);
// - what it waits on: the owner, CI (its PR's checks are running), a reviewer, or nothing.
// Lanes waiting on the owner come first in a project, and projects with any come first on the page.
import type { Agents, NeedsYou } from "../contract.ts";
import { BUSY_STATUSES, prWait } from "../core/attach-state.ts";

type Agent = Agents[number];
export type LaneState = "waiting" | "blocked" | "released" | "working" | "idle";
export type WaitOn = { on: "owner"; cardId: string | null; threadId: string | null } | { on: "ci" } | { on: "review" } | null;
export interface Lane {
  agent: Agent;
  state: LaneState;
  since: number | null; // ms epoch; null when the orchestrator doesn't track it (working, blocked, released)
  activity: string | null;
  model: string | null;
  wait: WaitOn;
}

/** The model as a word: Opus, Sonnet, Haiku, Fable or Codex; else the provider's family; null when neither is known. */
export function modelLabel(model: string | null, provider: string | null): string | null {
  const m = (model ?? "").toLowerCase();
  for (const [re, word] of [[/opus/, "Opus"], [/sonnet/, "Sonnet"], [/haiku/, "Haiku"], [/fable/, "Fable"], [/gpt|codex|\bo\d/, "Codex"]] as const) if (re.test(m)) return word;
  const p = (provider ?? "").toLowerCase();
  if (p.includes("codex")) return "Codex";
  if (p.includes("claude")) return "Claude";
  return null;
}

/** Who each open owner item is waiting for: the address that asked and the one it first came from. */
function ownerWaits(needs: NeedsYou | undefined): Map<string, { cardId: string | null; threadId: string | null; since: number | null }> {
  const out = new Map<string, { cardId: string | null; threadId: string | null; since: number | null }>();
  const add = (address: string, w: { cardId: string | null; threadId: string | null; since: number | null }) => {
    const cur = out.get(address);
    // the oldest one: the lane has waited since then
    if (!cur || (w.since !== null && (cur.since === null || w.since < cur.since))) out.set(address, w);
  };
  // the cards the owner can answer now (the badge's), not deferred ones: deferring says "not now"
  for (const c of needs?.cards ?? []) {
    const w = { cardId: c.id, threadId: null, since: Date.parse(c.askedAt) || null };
    add(c.asker, w);
    if (c.origin !== c.asker) add(c.origin, w);
  }
  for (const i of needs?.interactions ?? []) add(i.address, { cardId: null, threadId: i.threadId, since: i.since ? Date.parse(i.since) || null : null });
  return out;
}

export function laneFor(a: Agent, owner: { cardId: string | null; threadId: string | null; since: number | null } | undefined): Lane {
  const released = a.engineStatus === "stopped" || a.engineStatus === "archived";
  const state: LaneState = owner && !released ? "waiting" : released ? "released" : a.status === "error" || a.engineStatus === "error" ? "blocked" : BUSY_STATUSES.has(a.status) ? "working" : "idle";
  const since = state === "waiting" ? (owner?.since ?? null) : state === "idle" ? a.idleAt : null;
  const pw = a.pr ? prWait(a.pr) : null;
  const wait: WaitOn =
    state === "waiting" ? { on: "owner", cardId: owner!.cardId, threadId: owner!.threadId } : state === "released" ? null : pw === "ci" ? { on: "ci" } : pw === "review" ? { on: "review" } : null;
  return { agent: a, state, since, activity: a.title ?? a.lastReport, model: modelLabel(a.model, a.provider), wait };
}

/** thread:<project>:<n> → n; a lead (or anything else) sorts before every thread. */
const threadNo = (a: Agent) => (a.role === "lead" ? -1 : Number(a.address.split(":")[2] ?? Number.MAX_SAFE_INTEGER));

/** Each project's lanes: waiting on the owner first, then the lead, then its threads by number. */
export function buildLanes(agents: Agents | undefined, needs: NeedsYou | undefined): Map<string, Lane[]> {
  const owner = ownerWaits(needs);
  const out = new Map<string, Lane[]>();
  for (const a of agents ?? []) {
    if ((a.role !== "lead" && a.role !== "thread") || !a.project) continue;
    const list = out.get(a.project) ?? [];
    list.push(laneFor(a, owner.get(a.address)));
    out.set(a.project, list);
  }
  for (const list of out.values()) list.sort((x, y) => Number(y.state === "waiting") - Number(x.state === "waiting") || threadNo(x.agent) - threadNo(y.agent));
  return out;
}

export const waitsOnOwner = (lanes: Lane[] | undefined) => !!lanes?.some((l) => l.state === "waiting");

/** "<1m", "12m", "3h", "2d": how long a lane has been in its state. */
export function age(since: number | null, now: number): string | null {
  if (since === null) return null;
  const m = Math.floor(Math.max(0, now - since) / 60_000);
  return m < 1 ? "<1m" : m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

const RANK = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

/** Projects with a lane waiting on the owner first, then by the owner's priority, then by name. */
export function projectOrder(lanes: Map<string, Lane[]>) {
  return (a: { slug: string; priority: keyof typeof RANK }, b: { slug: string; priority: keyof typeof RANK }) =>
    Number(waitsOnOwner(lanes.get(b.slug))) - Number(waitsOnOwner(lanes.get(a.slug))) || RANK[a.priority] - RANK[b.priority] || a.slug.localeCompare(b.slug);
}
