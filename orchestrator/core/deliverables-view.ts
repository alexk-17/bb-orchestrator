// The Deliverables read's rows (2026-11-23, lag: moved out of server.ts). One read looks each lead and each PR up once:
// before, every deliverable asked for its lead twice and for each PR it named, 400 agent and ~90 PR lookups a read.
import type { DeliverableIndex, DeliverableRows, Deliverables } from "../contract.ts";
import type { Engine } from "./engine.ts";
import type { Agent, Deliverable } from "./model.ts";

type Row = Deliverables[number];
type Slim = DeliverableRows[number];
type Pr = NonNullable<ReturnType<Engine["prByUrl"]>>;

/** The lookups one read shares: each address and each PR URL is read once. */
export function lookups(engine: Engine) {
  const assigned = engine.personaAssignments();
  const agents = new Map<string, Agent | null>();
  const prs = new Map<string, Pr | null>();
  const agent = (address: string) => {
    if (!agents.has(address)) agents.set(address, engine.agentByAddress(address));
    return agents.get(address)!;
  };
  const pr = (url: string) => {
    if (!prs.has(url)) prs.set(url, engine.prByUrl(url));
    return prs.get(url)!;
  };
  return { agent, pr, persona: (a: Agent) => engine.personaOf(a, assigned) };
}

/** One deliverable whole, as a card draws it: every revision with its proof and the PRs' live state. */
export function deliverableRow(engine: Engine, d: Deliverable, look: ReturnType<typeof lookups> = lookups(engine)): Row {
  const lead = look.agent(d.lead);
  return {
    id: d.id,
    project: d.project,
    lead: d.lead,
    leadMon: lead?.mon ?? null,
    leadPersona: lead ? look.persona(lead) : null, // 2026-11-18: the lead's person
    title: d.title,
    summary: d.summary,
    state: d.state,
    rev: d.rev,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    revisions: d.revisions.map((r) => ({
      rev: r.rev,
      summary: r.summary,
      at: r.at,
      blocks: r.blocks ?? [],
      points: r.points ?? [],
      prs: (r.blocks ?? []).flatMap((b) => {
        if (b.kind !== "pr") return [];
        const pr = look.pr(b.url);
        return pr ? [{ ...pr, url: b.url }] : [];
      }),
      proof: r.proof.map((x) => {
        const pr = x.kind === "pr" && x.url ? look.pr(x.url) : null;
        return { ...x, pr: pr ? { url: pr.url, number: pr.number, state: pr.state, attention: pr.attention, checks: pr.checks } : null };
      }),
    })),
    feedback: d.feedback,
    withdrawn: d.withdrawn,
    next: engine.deliverableNext(d),
    ...(d.scope ? { scope: true } : {}),
    ...(d.scope_task ? { scopeTask: d.scope_task } : {}),
    ...(d.folder ? { folder: d.folder } : {}),
    ...(d.board ? { board: { id: d.board.id, record: d.board.record ?? null, flag: d.board.flag ?? null } } : {}),
  };
}

/** The revision a card shows: the current one, else the newest (app/past.ts shownRevision). */
const shown = (d: Deliverable) => d.revisions.find((r) => r.rev === d.rev) ?? d.revisions[d.revisions.length - 1];

/**
 * A list row (contract.ts deliverableRowSchema): the whole row without its revisions, plus what a closed card shows of
 * its shown revision. In review it keeps its revisions: those cards are drawn open. So does `whole`, the card Delivered
 * shows on its own (shownWhole).
 */
export function slimRow(engine: Engine, d: Deliverable, look: ReturnType<typeof lookups>, whole = d.state === "review"): Slim {
  const { revisions, ...row } = deliverableRow(engine, whole ? d : { ...d, revisions: [] }, look);
  const r = shown(d);
  const shot = r?.proof.find((p) => p.kind === "image");
  return {
    ...row,
    latest: r ? { rev: r.rev, summary: r.summary, at: r.at, proofs: r.proof.length, shot: shot ? { ...shot, pr: null } : null } : null,
    revisions: whole ? revisions : null,
  };
}

/** The listed deliverables, newest first (app/past.ts byUpdated): each its own 200, so a busy board never pushes past deliverables off the tab. */
const listed = (engine: Engine) => [...engine.deliverables(200, false), ...engine.deliverables(200, true)].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));

/**
 * The card Delivered shows before one is picked when nothing there is in review: its newest (app/past.ts
 * shownDeliverable over app/kit.ts onDeliverablesTab). A card in review is whole already, so then none.
 */
export function shownWhole(ds: readonly Deliverable[]): string | null {
  const tab = ds.filter((d) => !d.board && !(d.state === "review" && d.scope));
  return tab.some((d) => d.state === "review") ? null : (tab[0]?.id ?? null);
}

/** The Deliverables tab's list, slim (the `deliverables` read). */
export function deliverableRows(engine: Engine): Slim[] {
  const look = lookups(engine);
  const ds = listed(engine);
  const whole = shownWhole(ds);
  return ds.map((d) => slimRow(engine, d, look, d.state === "review" || d.id === whole));
}

/** One deliverable whole, when it is opened (the `deliverable` read); null when there is none. */
export function deliverableWhole(engine: Engine, id: string): Row | null {
  const d = engine.deliverable(id);
  return d ? deliverableRow(engine, d) : null;
}

/** Every listed deliverable's revisions as search and Files read them: summaries, points and proof, no PR state. */
export function deliverableIndex(engine: Engine): DeliverableIndex {
  return listed(engine).map((d) => ({ id: d.id, rev: d.rev, updatedAt: d.updatedAt, revisions: d.revisions.map((r) => ({ rev: r.rev, summary: r.summary, at: r.at, points: r.points ?? [], proof: r.proof })) }));
}
