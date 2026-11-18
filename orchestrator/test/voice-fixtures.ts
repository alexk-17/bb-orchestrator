// Made-up board data for the voice tests: no real projects, people or pull requests.
import type { BoardData, CardLite } from "../voice/snapshot.ts";
import type { VoiceReads } from "../voice/tools.ts";

export const NOW = Date.parse("2030-01-15T12:00:00Z");

export const card = (n: number, over: Partial<CardLite> = {}): CardLite => ({
  id: `D${String(n).padStart(4, "0")}`,
  rev: 1,
  project: n % 2 ? "alpha-api" : "beta-web",
  title: `Pick a cache size for widget ${n}`,
  question: `Which cache size should widget ${n} use?`,
  options: [
    { id: "1", label: "Small", recommended: true },
    { id: "2", label: "Large" },
  ],
  allowText: true,
  askedAt: NOW - n * 60_000,
  ...over,
});

export function board(cards = 3): BoardData {
  return {
    ownerName: "Sam",
    cards: Array.from({ length: cards }, (_, i) => card(i + 1)),
    deferred: [],
    projects: [
      { slug: "alpha-api", priority: "high", held: false, mode: "active", status: "Building the export endpoint", step: "Step 2 of 4: tests", waitingOn: null },
      { slug: "beta-web", priority: "normal", held: true, mode: "active", status: null, step: null, waitingOn: "a design review" },
    ],
    waits: [{ id: "W1", project: "alpha-api", about: "export endpoint", ref: "example/repo#12", state: "open", checks: "passing", review: "approved" }],
    deliverables: [{ id: "X1", rev: 1, project: "beta-web", title: "New settings page", summary: "Screens and a short video", state: "review", updatedAt: NOW - 3_600_000 }],
    messages: [{ at: NOW - 600_000, from: "owner", to: "alpha-api lead", text: "Ship the export behind a flag" }],
    answers: [{ id: "D0900", title: "Choose a logo", answer: "The blue one", at: NOW - 7_200_000 }],
  };
}

export function reads(b: BoardData = board()): VoiceReads & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    board: () => (calls.push("board"), { cards: b.cards, deferred: b.deferred, projects: b.projects }),
    card: (id) => {
      calls.push(`card:${id}`);
      const c = b.cards.find((x) => x.id === id);
      return c ? { ...c, context: "Some context", highStakes: false } : null;
    },
    project: (slug) => {
      calls.push(`project:${slug}`);
      const p = b.projects.find((x) => x.slug === slug);
      return p ? { project: p, decided: [], done: [] } : null;
    },
    waits: (p) => (calls.push(`waits:${p}`), b.waits.filter((w) => !p || w.project === p)),
    deliverables: (p) => (calls.push(`deliverables:${p}`), b.deliverables.filter((d) => !p || d.project === p)),
    deliverable: (id) => b.deliverables.find((d) => d.id === id) ?? null,
    leadMessages: (slug) => (calls.push(`messages:${slug}`), b.messages.filter((m) => m.to.startsWith(slug))),
  };
}
