// Spoken commands run at once. The exception is merge, production, money and secrets: those become a card, and only the
// owner's tap sends it (the voice says "That one needs a tap"). A new card replaces the last one, and one lapses after a
// minute untouched.
import { randomUUID } from "node:crypto";
import type { Proposal, ProposalRoute } from "./contract.ts";

export const CARD_TTL_MS = 60_000;

const HIGH_STAKES =
  /\b(merge[sd]?|merging|deploy(?:s|ed|ing|ment)?|release[sd]?|rollback|roll back|production|prod|live site|billing|invoices?|payments?|pay|refunds?|money|charges?|pricing|price|budget|spend(?:ing)?|purchase|secrets?|passwords?|tokens?|credentials?|api keys?|private keys?|logins?)\b|[$€£]\s?\d/i;

/** Whether an action touches merge, production, money or secrets: those need a tap. */
export function highStakes(...texts: (string | null | undefined)[]): boolean {
  return texts.some((t) => !!t && HIGH_STAKES.test(t));
}

export type Gate = { ok: true; proposal: Proposal } | { ok: false; reason: string };

export class ProposalBook {
  private current: Proposal | null = null;
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Hold a tap card; any earlier one is replaced (returned so the page can drop it). */
  propose(p: { route: ProposalRoute; body: Record<string, unknown>; readback: string; cardId: string | null }): { proposal: Proposal; replaced: string | null } {
    const replaced = this.current?.id ?? null;
    const proposal: Proposal = { id: randomUUID(), route: p.route, body: p.body, readback: p.readback, tapOnly: true, cardId: p.cardId, expiresAt: this.now() + CARD_TTL_MS };
    this.current = proposal;
    return { proposal, replaced };
  }

  pending(): Proposal | null {
    return this.current;
  }

  /** The owner's tap: the only way a card is sent. */
  tap(id: string): Gate {
    const c = this.current;
    if (!c || c.id !== id) return { ok: false, reason: "That card is gone." };
    if (this.now() > c.expiresAt) return { ok: false, reason: "That card expired." };
    this.current = null;
    return { ok: true, proposal: c };
  }

  cancel(id: string): boolean {
    if (this.current?.id !== id) return false;
    this.current = null;
    return true;
  }

  /** The id of a card whose time ran out, now dropped. */
  expire(): string | null {
    if (this.current && this.now() > this.current.expiresAt) {
      const id = this.current.id;
      this.current = null;
      return id;
    }
    return null;
  }
}
