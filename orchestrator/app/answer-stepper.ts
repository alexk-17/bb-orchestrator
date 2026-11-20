import type { Outcome } from "./store.ts";

export type StepperDraftInput = {
  option: string | null;
  note: string;
  unticked: ReadonlyMap<number, ReadonlySet<number>>;
};

export type StepperDraft = StepperDraftInput & {
  rev: number;
};

export type StepperFailure = {
  kind: string;
  message: string;
};

export type StepperCard = {
  id: string;
  rev: number;
  allowText: boolean;
  options: readonly { id: string }[];
};

export type StepperState<C extends StepperCard = StepperCard> = {
  cards: readonly C[];
  index: number;
  drafts: ReadonlyMap<string, StepperDraft>;
  failures: ReadonlyMap<string, StepperFailure>;
  droppedAnswered: number;
  droppedChanged: number;
};

export type BatchItem<C extends StepperCard> = {
  card: C;
  draft: StepperDraft;
};

export type BatchResult = {
  succeeded: string[];
  failed: Map<string, StepperFailure>;
};

export type BatchDeps<C extends StepperCard> = {
  waitForUnlock: () => Promise<void>;
  latestCard: (id: string) => C | undefined;
  sendOne: (card: C, draft: StepperDraft) => Promise<Outcome | null>;
  onProgress?: (index: number, total: number) => void;
};

const CONFLICT_MESSAGE = "This card changed before your answer reached it. Review and save again to retry.";
const GONE_MESSAGE = "This card was answered elsewhere or closed before sending.";
const BUSY_MESSAGE = "Another write held the page; this answer was not sent.";

export function canOfferStepper(cards: readonly unknown[]): boolean {
  return cards.length >= 2;
}

export function openStepper<C extends StepperCard>(cards: readonly C[]): StepperState<C> {
  return {
    cards: [...cards],
    index: 0,
    drafts: new Map(),
    failures: new Map(),
    droppedAnswered: 0,
    droppedChanged: 0,
  };
}

export function isReview<C extends StepperCard>(state: StepperState<C>): boolean {
  return state.index >= state.cards.length;
}

export function positionLabel<C extends StepperCard>(state: StepperState<C>): string {
  return isReview(state) ? "Review" : `${state.index + 1} of ${state.cards.length}`;
}

export function isStaleDraft(card: StepperCard, draft: StepperDraft): boolean {
  return draft.rev !== card.rev;
}

export function cloneUnticked(source?: ReadonlyMap<number, ReadonlySet<number>>): Map<number, Set<number>> {
  const next = new Map<number, Set<number>>();
  if (!source) return next;
  for (const [block, items] of source) next.set(block, new Set(items));
  return next;
}

export function saveDraft<C extends StepperCard>(
  state: StepperState<C>,
  cardId: string,
  draft: StepperDraftInput,
  advance: boolean,
): StepperState<C> {
  const card = state.cards.find((c) => c.id === cardId);
  if (!card) return state;
  const drafts = new Map(state.drafts);
  drafts.set(cardId, {
    rev: card.rev,
    option: draft.option,
    note: draft.note,
    unticked: cloneUnticked(draft.unticked),
  });
  const failures = new Map(state.failures);
  failures.delete(cardId);
  const index = advance && !isReview(state) ? Math.min(state.cards.length, state.index + 1) : state.index;
  return {
    ...state,
    index,
    drafts,
    failures,
  };
}

export function clearDraft<C extends StepperCard>(state: StepperState<C>, cardId: string): StepperState<C> {
  if (!state.drafts.has(cardId) && !state.failures.has(cardId)) return state;
  const drafts = new Map(state.drafts);
  drafts.delete(cardId);
  const failures = new Map(state.failures);
  failures.delete(cardId);
  return {
    ...state,
    drafts,
    failures,
  };
}

export function clearNotice<C extends StepperCard>(state: StepperState<C>): StepperState<C> {
  if (state.droppedAnswered === 0 && state.droppedChanged === 0) return state;
  return {
    ...state,
    droppedAnswered: 0,
    droppedChanged: 0,
  };
}

export function stepBack<C extends StepperCard>(state: StepperState<C>): StepperState<C> {
  if (state.index <= 0) return state;
  return { ...state, index: state.index - 1 };
}

export function stepNext<C extends StepperCard>(state: StepperState<C>): StepperState<C> {
  if (state.index >= state.cards.length) return state;
  return { ...state, index: state.index + 1 };
}

export function isDraftValidForCard<C extends StepperCard>(
  card: C,
  draft: StepperDraft,
  formattedNote: string,
): boolean {
  if (draft.option !== null) return card.options.some((o) => o.id === draft.option);
  return card.allowText && formattedNote.trim() !== "";
}

export function submittableDrafts<C extends StepperCard>(
  state: StepperState<C>,
  formatNote: (card: C, draft: StepperDraft) => string,
): BatchItem<C>[] {
  const out: BatchItem<C>[] = [];
  for (const card of state.cards) {
    const draft = state.drafts.get(card.id);
    if (!draft) continue;
    if (isStaleDraft(card, draft)) continue;
    if (!isDraftValidForCard(card, draft, formatNote(card, draft))) continue;
    out.push({ card, draft });
  }
  return out;
}

export function reconcileStepper<C extends StepperCard>(
  state: StepperState<C>,
  liveCards: readonly C[],
): StepperState<C> {
  const liveById = new Map<string, C>();
  for (const c of liveCards) liveById.set(c.id, c);

  const nextCards: C[] = [];
  const nextDrafts = new Map(state.drafts);
  const nextFailures = new Map(state.failures);
  let nextIndex = state.index;
  let droppedAnswered = state.droppedAnswered;
  let droppedChanged = state.droppedChanged;
  let changed = false;

  for (let i = 0; i < state.cards.length; i++) {
    const card = state.cards[i]!;
    const fresh = liveById.get(card.id);
    const failed = state.failures.get(card.id);

    if (!fresh) {
      nextDrafts.delete(card.id);
      nextFailures.delete(card.id);
      droppedAnswered += 1;
      if (i < state.index) nextIndex -= 1;
      changed = true;
      continue;
    }

    if (fresh.rev !== card.rev) {
      if (failed) {
        nextCards.push(fresh);
        if (failed.kind !== "conflict" || failed.message !== CONFLICT_MESSAGE) {
          nextFailures.set(card.id, { kind: "conflict", message: CONFLICT_MESSAGE });
        }
        changed = true;
        continue;
      }
      nextDrafts.delete(card.id);
      droppedChanged += 1;
      if (i < state.index) nextIndex -= 1;
      changed = true;
      continue;
    }

    nextCards.push(card);
  }

  if (!changed) return state;

  const clampedIndex = Math.max(0, Math.min(nextCards.length, nextIndex));
  return {
    cards: nextCards,
    index: clampedIndex,
    drafts: nextDrafts,
    failures: nextFailures,
    droppedAnswered,
    droppedChanged,
  };
}

export function droppedNotice<C extends StepperCard>(state: StepperState<C>): string | null {
  const { droppedAnswered: answered, droppedChanged: changed } = state;
  if (answered === 0 && changed === 0) return null;
  const parts: string[] = [];
  if (answered > 0) parts.push(`${answered} ${answered === 1 ? "card was" : "cards were"} answered elsewhere`);
  if (changed > 0) parts.push(`${changed} ${changed === 1 ? "card changed and was" : "cards changed and were"} removed`);
  return `${parts.join("; ")}.`;
}

export async function submitBatch<C extends StepperCard>(
  items: readonly BatchItem<C>[],
  deps: BatchDeps<C>,
): Promise<BatchResult> {
  const succeeded: string[] = [];
  const failed = new Map<string, StepperFailure>();

  for (let i = 0; i < items.length; i++) {
    const { card, draft } = items[i]!;
    deps.onProgress?.(i, items.length);

    await deps.waitForUnlock();

    const current = deps.latestCard(card.id);
    if (!current) {
      failed.set(card.id, { kind: "conflict", message: GONE_MESSAGE });
      continue;
    }
    if (current.rev !== card.rev || isStaleDraft(current, draft)) {
      failed.set(card.id, { kind: "conflict", message: CONFLICT_MESSAGE });
      continue;
    }

    const out = await deps.sendOne(card, draft);
    if (out === null) {
      failed.set(card.id, { kind: "busy", message: BUSY_MESSAGE });
    } else if (out.ok) {
      succeeded.push(card.id);
    } else {
      failed.set(card.id, {
        kind: out.kind,
        message: out.kind === "conflict" ? CONFLICT_MESSAGE : out.message,
      });
    }
  }

  return { succeeded, failed };
}

export function applyBatchResult<C extends StepperCard>(
  state: StepperState<C>,
  result: BatchResult,
): StepperState<C> {
  const done = new Set(result.succeeded);
  const nextCards = state.cards.filter((c) => !done.has(c.id));
  const nextDrafts = new Map(state.drafts);
  const nextFailures = new Map(state.failures);

  for (const id of done) {
    nextDrafts.delete(id);
    nextFailures.delete(id);
  }
  for (const [id, failure] of result.failed) {
    nextFailures.set(id, failure);
  }

  return {
    cards: nextCards,
    index: nextCards.length,
    drafts: nextDrafts,
    failures: nextFailures,
    droppedAnswered: 0,
    droppedChanged: 0,
  };
}
