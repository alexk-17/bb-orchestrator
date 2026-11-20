export type StepperDraft = {
  option: string | null;
  note: string;
  unticked: ReadonlyMap<number, ReadonlySet<number>>;
};

export type StepperFailure = {
  kind: string;
  message: string;
  gone?: boolean;
};

export type StepperCard = {
  id: string;
  rev: number;
  allowText: boolean;
  options: readonly { id: string; label: string }[];
};

export type StepperState<C extends StepperCard = StepperCard> = {
  cards: readonly C[];
  index: number;
  drafts: ReadonlyMap<string, StepperDraft>;
  failures: ReadonlyMap<string, StepperFailure>;
  droppedAnswered: number;
  droppedChanged: number;
  submitEpoch: number;
};

export type BatchItem<C extends StepperCard> = {
  card: C;
  draft: StepperDraft;
};

export type BatchOutcome =
  | { ok: true }
  | { ok: false; kind: string; message: string }
  | null;

export type BatchResult = {
  succeeded: string[];
  failed: Map<string, StepperFailure>;
};

export type BatchDeps<C extends StepperCard> = {
  waitForUnlock: () => Promise<boolean>;
  latestCard: (id: string) => C | undefined;
  sendOne: (card: C, draft: StepperDraft) => Promise<BatchOutcome>;
  onProgress?: (index: number, total: number, cardId: string) => void;
};

const CONFLICT_MESSAGE = "This card changed before your answer reached it. Read it again.";
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
    submitEpoch: 0,
  };
}

export function isReview<C extends StepperCard>(state: StepperState<C>): boolean {
  return state.index >= state.cards.length;
}

export function positionLabel<C extends StepperCard>(state: StepperState<C>): string {
  return isReview(state) ? "Review" : `${state.index + 1} of ${state.cards.length}`;
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
  draft: StepperDraft,
  advance: boolean,
): StepperState<C> {
  const drafts = new Map(state.drafts);
  drafts.set(cardId, {
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
    submitEpoch: state.submitEpoch + 1,
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
    submitEpoch: state.submitEpoch + 1,
  };
}

export function dismissCard<C extends StepperCard>(state: StepperState<C>, cardId: string): StepperState<C> {
  const idx = state.cards.findIndex((c) => c.id === cardId);
  if (idx < 0) return state;
  const nextCards = state.cards.filter((c) => c.id !== cardId);
  const drafts = new Map(state.drafts);
  drafts.delete(cardId);
  const failures = new Map(state.failures);
  failures.delete(cardId);
  const nextIndex = idx < state.index ? state.index - 1 : state.index;
  return {
    ...state,
    cards: nextCards,
    index: Math.max(0, Math.min(nextCards.length, nextIndex)),
    drafts,
    failures,
    submitEpoch: state.submitEpoch + 1,
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
  formattedNote?: string,
): boolean {
  if (draft.option !== null) return card.options.some((o) => o.id === draft.option);
  return card.allowText && (formattedNote ?? draft.note).trim() !== "";
}

export function submittableDrafts<C extends StepperCard>(
  state: StepperState<C>,
  formatNote?: (card: C, draft: StepperDraft) => string,
): BatchItem<C>[] {
  const out: BatchItem<C>[] = [];
  for (const card of state.cards) {
    const draft = state.drafts.get(card.id);
    if (!draft) continue;
    const failure = state.failures.get(card.id);
    if (failure?.gone) continue;
    const text = formatNote ? formatNote(card, draft) : draft.note;
    if (!isDraftValidForCard(card, draft, text)) continue;
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
  let epochBump = false;

  for (let i = 0; i < state.cards.length; i++) {
    const card = state.cards[i]!;
    const fresh = liveById.get(card.id);
    const failed = state.failures.get(card.id);

    if (failed) {
      if (!fresh) {
        nextCards.push(card);
        if (!failed.gone) {
          nextFailures.set(card.id, { ...failed, gone: true });
          changed = true;
          epochBump = true;
        }
      } else if (fresh.rev !== card.rev) {
        nextCards.push(fresh);
        changed = true;
        epochBump = true;
      } else {
        nextCards.push(card);
      }
      continue;
    }

    if (!fresh) {
      if (nextDrafts.delete(card.id)) epochBump = true;
      droppedAnswered += 1;
      if (i < state.index) nextIndex -= 1;
      changed = true;
      continue;
    }

    if (fresh.rev !== card.rev) {
      if (nextDrafts.delete(card.id)) epochBump = true;
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
    submitEpoch: epochBump ? state.submitEpoch + 1 : state.submitEpoch,
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
    deps.onProgress?.(i, items.length, card.id);

    const unlocked = await deps.waitForUnlock();
    if (!unlocked) break;

    const current = deps.latestCard(card.id);
    if (!current) {
      failed.set(card.id, { kind: "conflict", message: GONE_MESSAGE, gone: true });
      continue;
    }
    if (current.rev !== card.rev) {
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
    ...state,
    cards: nextCards,
    index: nextCards.length,
    drafts: nextDrafts,
    failures: nextFailures,
    submitEpoch: state.submitEpoch + 1,
  };
}
