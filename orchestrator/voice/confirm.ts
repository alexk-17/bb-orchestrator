// Confirm gating: the voice can only propose a write. A proposal is sent only after its read-back ended and the person
// then said yes (spoken), or tapped its card. Merge, production, money and secrets are tap-only: voice reads them, a
// tap sends them. A new proposal replaces the last one (a change of subject), and one expires 20 s after its read-back.
import { randomUUID } from "node:crypto";
import type { Proposal, ProposalRoute } from "./contract.ts";

export const PROPOSAL_TTL_MS = 20_000;

const HIGH_STAKES =
  /\b(merge[sd]?|merging|deploy(?:s|ed|ing|ment)?|release[sd]?|rollback|roll back|production|prod|live site|billing|invoices?|payments?|pay|refunds?|money|charges?|pricing|price|budget|spend(?:ing)?|purchase|secrets?|passwords?|tokens?|credentials?|api keys?|private keys?|logins?)\b|[$€£]\s?\d/i;

/** Whether a proposal touches merge, production, money or secrets: those are tap-only. */
export function highStakes(...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => !!t && HIGH_STAKES.test(t));
}

const YES = /^\s*(?:yes|yeah|yep|yup|ya|sure|correct|right|confirm(?:ed)?|send(?: it)?|do it|go ahead|go for it|ok(?:ay)?|please do|that's right|affirmative)\b/i;
const NOT_YES = /\b(?:no|nope|not|don't|do not|wait|hold on|cancel|stop|never ?mind|change)\b/i;

/** A spoken yes, and nothing that takes it back. */
export function isYes(text: string): boolean {
  return YES.test(text) && !NOT_YES.test(text);
}

export type Utterance = { text: string; startedAt: number };
export type Gate = { ok: true; proposal: Proposal } | { ok: false; reason: string };

export class ProposalBook {
  private current: (Proposal & { readbackAt: number | null }) | null = null;
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Hold a new proposal; any earlier one is replaced (returned so the page can drop its card). */
  propose(p: { route: ProposalRoute; body: Record<string, unknown>; readback: string; cardId: string | null; stakes: (string | null | undefined)[] }): { proposal: Proposal; replaced: string | null } {
    const replaced = this.current?.id ?? null;
    const proposal: Proposal = {
      id: randomUUID(),
      route: p.route,
      body: p.body,
      readback: p.readback,
      tapOnly: highStakes(p.readback, ...p.stakes),
      cardId: p.cardId,
      expiresAt: this.now() + PROPOSAL_TTL_MS,
    };
    this.current = { ...proposal, readbackAt: null };
    return { proposal, replaced };
  }

  /** The voice finished speaking (its read-back included): a yes must come after this, and the clock starts here. */
  readbackDone(at = this.now()): void {
    if (!this.current || this.current.readbackAt !== null) return;
    this.current.readbackAt = at;
    this.current.expiresAt = at + PROPOSAL_TTL_MS;
  }

  pending(): Proposal | null {
    if (!this.current) return null;
    const { readbackAt: _r, ...p } = this.current;
    return p;
  }

  /** The voice says the person agreed: allowed only after the read-back, for a spoken yes, and never for tap-only. */
  confirmSpoken(id: string, heard: Utterance | null): Gate {
    const c = this.current;
    if (!c || c.id !== id) return { ok: false, reason: "That proposal is gone: propose it again." };
    if (this.now() > c.expiresAt) return { ok: false, reason: "That proposal expired: propose it again and read it back." };
    if (c.tapOnly) return { ok: false, reason: "This one needs a tap on its card: merges, production, money and secrets are never sent by voice alone." };
    if (c.readbackAt === null) return { ok: false, reason: "Read the proposal back first, then wait for the person's yes." };
    if (!heard || heard.startedAt <= c.readbackAt) return { ok: false, reason: "The person hasn't answered since the read-back: wait for them to say yes." };
    if (!isYes(heard.text)) return { ok: false, reason: `That wasn't a clear yes ("${heard.text.slice(0, 60)}"): ask again, or let it go.` };
    this.current = null;
    return { ok: true, proposal: c };
  }

  /** A tap on the card: the person's own click, so no read-back is needed, only a live proposal. */
  tap(id: string): Gate {
    const c = this.current;
    if (!c || c.id !== id) return { ok: false, reason: "That proposal is gone." };
    if (this.now() > c.expiresAt) return { ok: false, reason: "That proposal expired." };
    this.current = null;
    return { ok: true, proposal: c };
  }

  cancel(id: string): boolean {
    if (this.current?.id !== id) return false;
    this.current = null;
    return true;
  }

  /** The id of a proposal whose time ran out, now dropped. */
  expire(): string | null {
    if (this.current && this.now() > this.current.expiresAt) {
      const id = this.current.id;
      this.current = null;
      return id;
    }
    return null;
  }
}
