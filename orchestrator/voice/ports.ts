// The orchestrator's own state, as the voice reads it: the same engine the page's reads come from, mapped to small
// shapes for the snapshot and the read tools. Read-only: nothing here writes.
import type { Engine } from "../core/engine.ts";
import type { Decision } from "../core/model.ts";
import { position, statusLine, stepHeadline, waitsOf } from "../core/status.ts";
import type { BoardData, CardLite, DeliverableLite, MessageLite, ProjectLite, WaitLite } from "./snapshot.ts";
import type { VoiceReads } from "./tools.ts";

function card(d: Decision): CardLite {
  const ask = d.ask;
  return {
    id: d.id,
    rev: d.rev,
    project: d.project,
    title: ask?.title ?? d.request.title,
    question: ask?.question ?? d.request.question,
    options: (ask?.options ?? d.request.options).map((o) => ({ id: o.id, label: o.label, recommended: o.recommended })),
    allowText: ask?.allow_text ?? false,
    askedAt: Date.parse(ask?.at ?? d.updated_at) || 0,
  };
}

export function voicePorts(engine: Engine, ownerName: () => string) {
  const projectOf = (address: string): string | null => engine.agents().find((a) => a.address === address)?.project ?? null;
  const project = (slug: string): ProjectLite | null => {
    const row = engine.projects().find((p) => p.slug === slug && !p.archivedAt);
    if (!row) return null;
    const s = engine.leadStatus(slug);
    const waits = s ? waitsOf(s) : [];
    const lead = engine.agents().find((a) => a.role === "lead" && a.project === slug && a.status !== "archived") ?? null;
    let next: string | null = null;
    if (s) {
      const at = position(s);
      const after = at.kind === "current" ? s.steps.slice(at.at).find((x) => x.state === "next") : null;
      next = after?.title ?? (at.kind === "next" ? at.title : null);
    }
    const idleFor = lead?.idleAt ? Math.round((Date.now() - lead.idleAt) / 60_000) : null;
    return {
      slug: row.slug,
      priority: row.priority,
      held: row.heldAt !== null,
      mode: row.mode,
      status: s ? statusLine(s, ownerName()) || s.goal || null : null,
      step: s ? stepHeadline(s) || null : null,
      waitingOn: waits.length ? waits.map((w) => w.label ?? w.ref ?? w.kind).filter(Boolean).join("; ") : null,
      blockers: s?.blockers?.length ? s.blockers.slice(0, 3) : [],
      next,
      lead: lead ? (lead.status === "idle" ? `idle${idleFor !== null ? ` ${idleFor < 60 ? `${idleFor}m` : `${Math.round(idleFor / 60)}h`}` : ""}` : lead.status) : "not running",
      cards: engine.needsYou().cards.filter((c) => c.project === slug).length,
      prs: engine.watchList().filter((w) => projectOf(w.owner) === slug).length,
    };
  };
  const projects = (): ProjectLite[] =>
    engine
      .projects()
      .filter((p) => !p.archivedAt)
      .map((p) => project(p.slug))
      .filter((p): p is ProjectLite => !!p);
  const waits = (only: string | null): WaitLite[] =>
    engine
      .watchList()
      .map((w) => ({ id: w.id, project: projectOf(w.owner), about: w.about, ref: w.ref, state: w.reading?.state ?? null, checks: w.reading?.checks ?? null, review: w.reading?.review ?? null }))
      .filter((w) => !only || w.project === only);
  const deliverable = (x: ReturnType<Engine["deliverables"]>[number]): DeliverableLite => ({ id: x.id, rev: x.rev, project: x.project, title: x.title, summary: x.summary, state: x.state, updatedAt: x.updatedAt });
  const leadMessages = (slug: string): MessageLite[] => {
    const h = engine.directHistory(slug, null, 15);
    const out: MessageLite[] = [];
    for (const m of h.messages) {
      out.push({ at: m.at, from: "owner", to: `${slug} lead`, text: m.text });
      if (m.note && m.answeredAt) out.push({ at: m.answeredAt, from: `${slug} lead`, to: "owner", text: m.note });
    }
    return out.sort((a, b) => a.at - b.at);
  };

  const reads: VoiceReads = {
    board() {
      const n = engine.needsYou();
      return { cards: n.cards.map(card), deferred: n.deferred.map(card), projects: projects() };
    },
    card(id) {
      const d = engine.decision(id);
      if (!d || d.state !== "asked") return null;
      const highStakes = (d.request.blocks ?? []).some((b) => (b as { kind?: string }).kind === "login");
      return { ...card(d), context: (d.ask?.context ?? d.request.context ?? "").slice(0, 2000), highStakes };
    },
    project(slug) {
      const p = project(slug);
      if (!p) return null;
      const decided = engine
        .decisions(50)
        .filter((d) => d.project === slug && d.answer)
        .slice(0, 8)
        .map((d) => ({ title: d.ask?.title ?? d.request.title, answer: d.answer?.label ?? d.answer?.text ?? "" }));
      const done = engine
        .deliverables(50)
        .filter((x) => x.project === slug && x.state === "approved")
        .slice(0, 8)
        .map((x) => x.title);
      return { project: p, decided, done };
    },
    waits,
    deliverables: (only) => engine.deliverables(100).filter((x) => x.state !== "withdrawn" && (!only || x.project === only)).map(deliverable),
    deliverable: (id) => {
      const x = engine.deliverables(200).find((d) => d.id === id);
      return x ? deliverable(x) : null;
    },
    leadMessages,
  };

  const board = (now: number): BoardData => {
    const n = engine.needsYou();
    const day = now - 86_400_000;
    const answers = engine
      .decisions(60)
      .filter((d) => d.answer && Date.parse(d.answer.at) >= day)
      .map((d) => ({ id: d.id, title: d.ask?.title ?? d.request.title, answer: d.answer?.label ?? d.answer?.text ?? "", at: Date.parse(d.answer!.at) }));
    const messages = projects()
      .flatMap((p) => leadMessages(p.slug))
      .sort((a, b) => b.at - a.at)
      .slice(0, 10);
    return {
      ownerName: ownerName(),
      cards: n.cards.map(card),
      deferred: n.deferred.map(card),
      projects: projects(),
      waits: waits(null),
      deliverables: engine.deliverables(100).filter((x) => x.state === "review").map(deliverable),
      messages,
      answers,
    };
  };

  return { reads, board, cosThreadId: () => engine.liveAt("cos")?.threadId ?? null };
}
