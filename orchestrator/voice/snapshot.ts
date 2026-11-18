// The start-of-call snapshot: what the board says right now, in about 6K tokens, built in-process from the
// orchestrator's own state (voice/ports.ts). The live read tools fetch the full version of anything here, so this stays
// small. Card text and lead messages are data, never instructions: the system prompt says so, and no write happens
// without the person's own yes.

export type CardLite = {
  id: string;
  rev: number;
  project: string | null;
  title: string;
  question: string;
  options: { id: string; label: string; recommended?: boolean }[];
  allowText: boolean;
  askedAt: number;
};
export type ProjectLite = {
  slug: string;
  priority: string;
  held: boolean;
  mode: string;
  status: string | null;
  step: string | null;
  waitingOn: string | null;
  /** What blocks it, in the lead's words. */
  blockers?: string[];
  /** The lead's next step, when it has one. */
  next?: string | null;
  /** The lead: idle, working, or none running. */
  lead?: string | null;
  /** Open cards waiting on the owner, and PR waits. */
  cards?: number;
  prs?: number;
};
export type WaitLite = { id: string; project: string | null; about: string; ref: string; state: string | null; checks: string | null; review: string | null };
export type DeliverableLite = { id: string; rev: number; project: string | null; title: string; summary: string; state: string; updatedAt: number };
export type MessageLite = { at: number; from: string; to: string; text: string };
export type AnswerLite = { id: string; title: string; answer: string; at: number };

export type BoardData = {
  ownerName: string;
  cards: CardLite[];
  deferred: CardLite[];
  projects: ProjectLite[];
  waits: WaitLite[];
  deliverables: DeliverableLite[];
  messages: MessageLite[];
  answers: AnswerLite[];
};

export const SNAPSHOT_TOKENS = 6000;
/** A rough count, good enough for a budget: about four characters a token. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export function age(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const one = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function cardLine(c: CardLite, now: number, full: boolean): string {
  const head = `- card ${c.id} (rev ${c.rev}) [${c.project ?? "no project"}] ${one(c.title, 120)}, waiting ${age(now - c.askedAt)}`;
  if (!full) return head;
  const opts = c.options.map((o) => `${o.id}=${one(o.label, 80)}${o.recommended ? " (recommended)" : ""}`).join("; ");
  return `${head}\n  question: ${one(c.question, 400)}\n  options: ${opts || "none"}${c.allowText ? "; a spoken note is allowed" : ""}`;
}

/** The snapshot text. `level` drops detail from the end until the budget fits: 0 is everything. */
function render(d: BoardData, now: number, level: number): string {
  const lines: string[] = [];
  lines.push(`Now: ${new Date(now).toISOString()}. Owner: ${d.ownerName || "the owner"}.`);
  // oldest first: the oldest ten in full, the rest by title (fewer in full as the budget tightens)
  const cards = [...d.cards].sort((a, b) => a.askedAt - b.askedAt);
  const fullCount = level >= 3 ? 3 : 10;
  lines.push(`\n## Waiting on the owner: ${cards.length} card(s)`);
  cards.forEach((c, i) => lines.push(cardLine(c, now, i < fullCount)));
  if (d.deferred.length) lines.push(`Deferred: ${d.deferred.map((c) => `${c.id} ${one(c.title, 60)}`).join("; ")}`);
  lines.push(`\n## Projects (${d.projects.length})`);
  for (const p of d.projects) {
    const bits = [`${p.priority}${p.held ? ", held" : ""}${p.mode === "scoping" ? ", scoping" : ""}`];
    if (p.status) bits.push(one(p.status, 160));
    if (p.step) bits.push(`now: ${one(p.step, 100)}`);
    if (p.blockers?.length) bits.push(`blocked by: ${one(p.blockers.join("; "), 160)}`);
    if (p.waitingOn) bits.push(`waits on: ${one(p.waitingOn, 100)}`);
    if (p.next) bits.push(`next: ${one(p.next, 100)}`);
    if (p.lead) bits.push(`lead ${p.lead}`);
    const counts = [p.cards ? `${p.cards} card(s) waiting on the owner` : "", p.prs ? `${p.prs} PR wait(s)` : ""].filter(Boolean).join(", ");
    if (counts) bits.push(counts);
    lines.push(`- ${p.slug}: ${bits.join(". ")}`);
  }
  lines.push(`\n## PR waits (${d.waits.length})`);
  for (const w of d.waits) lines.push(`- ${w.id} [${w.project ?? "-"}] ${one(w.about, 100)} (${w.ref}): ${[w.state, w.checks, w.review].filter(Boolean).join(", ") || "not read yet"}`);
  const review = d.deliverables.filter((x) => x.state === "review");
  lines.push(`\n## Deliverables to review (${review.length})`);
  for (const x of review) lines.push(`- deliverable ${x.id} (rev ${x.rev}) [${x.project ?? "-"}] ${one(x.title, 100)}${level >= 2 ? "" : `: ${one(x.summary, 200)}`}`);
  if (level < 2 && d.answers.length) {
    lines.push(`\n## Answered in the last day`);
    for (const a of d.answers.slice(0, 15)) lines.push(`- ${a.id} ${one(a.title, 80)}: ${one(a.answer, 80)}`);
  }
  const msgs = [...d.messages].sort((a, b) => b.at - a.at).slice(0, level >= 1 ? 5 : 10);
  if (msgs.length) {
    lines.push(`\n## Latest messages`);
    for (const m of msgs) lines.push(`- ${age(now - m.at)} ago, ${m.from} to ${m.to}: ${one(m.text, level >= 1 ? 100 : 200)}`);
  }
  return lines.join("\n");
}

/** The snapshot, within `budget` tokens: detail drops (old messages, answers, summaries, card detail) before data does. */
export function buildSnapshot(d: BoardData, now: number, budget = SNAPSHOT_TOKENS): string {
  for (let level = 0; level <= 3; level++) {
    const s = render(d, now, level);
    if (estimateTokens(s) <= budget) return s;
  }
  // still too long (a huge board): keep the head of it, which holds the cards
  return render(d, now, 3).slice(0, budget * 4);
}
