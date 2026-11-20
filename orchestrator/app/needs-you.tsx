// Needs you: the owner's answerable cards, then what waits on an agent, what the CoS is triaging, and the deferred cards.
//
// The double-tap fix (gate.ts has the rules as pure functions, store.ts the write gate):
// - Arming (useArming): each card's top, measured against this view's own wrapper (so scrolling moves nothing), and its
//   rev are tracked; a card that just appeared, moved or changed takes no write for ARM_MS. Its buttons say so in
//   `data-armed`, and the click itself re-measures before it counts.
// - No reflow (shown below): while a pointer is down on the panel, or a write holds the page, the view keeps drawing
//   the list it last drew. The written card stays in its slot, marked, and every write on the page is off until the
//   request finished and SETTLE_MS passed since both the response and the last release. Then the list moves, and the
//   card that moves into the slot is armed afresh, so the second click of a double-click can't answer it.
// - Arming gates options, "Send my answer" (the Other field) and the defer presets; Bring back answers nothing and is under the page lock only.
// - On shadcn/ui since 2026-11-17: each card is a Card, the defer presets a DropdownMenu (portaled, no animation), and
//   every size is the same in every state (answer-ui.tsx), so arming, pressing and marking move nothing.
import { styleHref } from "./style-href.ts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Markdown, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { WRITES, type Card, type NeedsYou, type Preset, type answerBody, type deferBody, type interactionAnswerBody, type returnBody, type secretBody } from "../contract.ts";
import { Blocks, untickedText } from "./blocks.tsx";
import { QuestionCard, ixKey } from "./question-card.tsx";
import { Details, META, OtherBox, Options, WHEN, answerCss } from "./answer-ui.tsx";
import { cardBlockOrder } from "./less-text.ts";
import type { Answers } from "../interactions.ts";
import type { z } from "zod";
import { ARM_MS, armed, track, type Seen } from "./gate.ts";
import { keyState, emitKeys, say } from "./key-state.ts";
import { useViewKeys } from "./key-view.ts";
import { changed, gate, gone, pruneGone, useGate, write, type Hide, type WriteKind } from "./store.ts";
import { KIND_TONES, css } from "./palette.ts";
import { ACCENT, accentTone, accentVars } from "./accent.ts";
import { ChevronDown, CircleAlert, CircleCheck } from "lucide-react";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { Card as Frame } from "./ui/card.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu.tsx";
import { Item, ItemGroup } from "./ui/item.tsx";
import { cn } from "./ui/utils.ts";
import { AgentFace, type Face } from "./face.tsx";
import { Btn, EmptyState, Kind, ReadState, Section, Tag, Who, when } from "./ui.tsx";
import {
  applyBatchResult,
  canOfferStepper,
  clearDraft,
  cloneUnticked,
  dismissCard,
  droppedNotice,
  isDraftValidForCard,
  isReview,
  openStepper,
  positionLabel,
  reconcileStepper,
  saveDraft,
  stepBack,
  stepNext,
  submitBatch,
  submittableDrafts,
  type StepperDraft,
  type StepperFailure,
  type StepperState,
} from "./answer-stepper.ts";

/** The device's zone, which the server works the defer presets out in. One value, so every read shares a cache entry. */
export const ZONE: string = (() => {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return z && z.length <= 64 ? z : "UTC";
  } catch {
    return "UTC";
  }
})();

export function via(): "phone" | "desktop" {
  try {
    return window.matchMedia("(pointer: coarse)").matches ? "phone" : "desktop";
  } catch {
    return "desktop";
  }
}

export type List = "cards" | "deferred";

function formatDraftNote(card: Card, draft: StepperDraft): string {
  return [draft.note.trim(), untickedText(card.blocks, cloneUnticked(draft.unticked))].filter(Boolean).join("\n\n");
}

/** The view without the cards a write took (this id at this rev), for the lists the write moved them out of. */
function visible(v: NeedsYou): NeedsYou {
  if (gone.size === 0) return v;
  const keep = (list: List) => (c: Card) => {
    const h = gone.get(`${c.id}@${c.rev}`);
    return !h || (h !== "both" && h !== list);
  };
  return { ...v, cards: v.cards.filter(keep("cards")), deferred: v.deferred.filter(keep("deferred")), interactions: v.interactions.filter((i) => !gone.has(`${ixKey(i)}@0`)) };
}

/** Arming: when each card last appeared, moved or changed rev. */
export function useArming(root: RefObject<HTMLDivElement | null>) {
  const seen = useRef(new Map<string, Seen>());
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((t) => t + 1), []);
  /** Measure every card; true when one appeared, moved or changed (its clock restarted). */
  const measure = useCallback((): boolean => {
    const el = root.current;
    if (!el) return false;
    const base = el.getBoundingClientRect().top;
    const now = performance.now();
    const next = new Map<string, Seen>();
    let restarted = false;
    el.querySelectorAll<HTMLElement>("[data-card], [data-arm]").forEach((c) => {
      const id = c.dataset.card ?? c.dataset.arm ?? "";
      const prev = seen.current.get(id);
      const s = track(prev, Number(c.dataset.rev), c.getBoundingClientRect().top - base, now);
      if (s !== prev) restarted = true;
      next.set(id, s);
    });
    seen.current = next;
    return restarted;
  }, [root]);
  // after every render, before paint
  useLayoutEffect(() => {
    if (measure()) rerender();
  });
  // a card above growing or shrinking (a note opened, text wrapping) moves the ones below without a render here
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (measure()) rerender();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, rerender, root]);
  // flip data-armed when the next clock runs out
  useEffect(() => {
    const now = performance.now();
    let next = Number.POSITIVE_INFINITY;
    for (const s of seen.current.values()) if (s.at + ARM_MS > now) next = Math.min(next, s.at + ARM_MS);
    if (next === Number.POSITIVE_INFINITY) return;
    const t = setTimeout(rerender, next - now + 5);
    return () => clearTimeout(t);
  });
  return {
    /** For drawing `data-armed`. */
    isArmed: (id: string, rev: number) => armed(seen.current.get(id), rev, performance.now()),
    /** For a click: measured again first, so a move not yet seen still drops it. */
    check: (id: string, rev: number) => {
      if (measure()) rerender();
      return armed(seen.current.get(id), rev, performance.now());
    },
  };
}

export type Act = {
  answer: (card: Card, list: List, option: string | null, note: string) => void;
  defer: (card: Card, preset: Preset["id"]) => void;
  bringBack: (card: Card) => void;
  /** A code pasted into a login block: it goes to the asker as a file path, never into the decision. */
  secret: (card: Card, list: List, value: string) => void;
};

export type CardDraftProps = {
  value: StepperDraft | null;
  onPick: (draft: StepperDraft) => void;
  onClear?: () => void;
};

/** One card, answerable in place: Needs you's cards, and the Scope tab's (with no defer presets there). */
export function CardView({ card, list, presets, isArmed, act, mon, monType = null, draft }: { card: Card; list: List; presets: Preset[]; isArmed: boolean; act: Act; mon: Face | null; monType?: string | null; draft?: CardDraftProps }) {
  const [note, setNote] = useState(() => draft?.value?.note ?? "");
  const [unticked, setUnticked] = useState<Map<number, Set<number>>>(() => cloneUnticked(draft?.value?.unticked));
  const toggle = (block: number, item: number) =>
    setUnticked((m) => {
      const next = new Map(m);
      const off = new Set(next.get(block) ?? []);
      if (off.has(item)) off.delete(item);
      else off.add(item);
      next.set(block, off);
      return next;
    });
  // an option's answer carries the lists' unticked items along with any note
  const withLists = (n: string) => [n.trim(), untickedText(card.blocks, unticked)].filter(Boolean).join("\n\n");
  const order = cardBlockOrder(card.blocks);
  // the answer a number key picked, waiting for Enter (keys.ts); a card that changed rev starts without one
  const picked = draft ? (draft.value?.option ?? undefined) : keyState.picked.get(`${card.id}@${card.rev}`);

  const lock = gate.lock;
  const busy = lock !== null; // a write anywhere on the page turns every write off
  const mine = lock && lock.cardId === card.id && lock.ok !== false ? lock : null;
  const state = mine?.kind === "answer" ? "answered" : mine?.kind === "defer" || card.deferred ? "deferred" : "open";
  const mark = mine?.kind === "answer" ? "Answered ✓" : mine?.kind === "defer" ? "Deferred" : mine?.kind === "return" ? "Bringing back" : draft?.value ? "Draft saved" : null;
  const markColor = mine ? css(KIND_TONES[mine.kind === "answer" ? "done" : mine.kind === "defer" ? "deferred" : "asked"]) : undefined;
  // notices change the card's height, so they show only while nothing holds the page
  const notice = busy ? null : (changed.get(card.id) ?? (gate.error?.where === card.id ? gate.error.message : null));

  // A shadcn Card (it never folds or glides)
  return (
    <Frame role="article" data-card={card.id} data-rev={card.rev} data-asker={card.asker} data-state={state} data-accent={monType ?? undefined} aria-busy={busy || undefined} className={cn("gap-0 p-4", mine && "opacity-80")} style={accentVars(monType)}>
          <header className="flex items-start gap-3">
            {/* always drawn at its fixed size (the role avatar until the board names the mon), so the card never changes height */}
            <AgentFace face={mon} address={card.origin} size={28} />
            <div className="min-w-0 flex-1">
              <h4 className="m-0 text-sm leading-5 font-semibold [overflow-wrap:anywhere]">{card.title}</h4>
              {/* the quiet line: where it comes from, who asked, and any state */}
              <p className={META}>
                {/* the project in its accent (accent.ts) */}
                <span style={accentTone(monType) ? { color: ACCENT, fontWeight: 600 } : undefined}>{card.project ?? "no project"}</span>
                <span aria-hidden>·</span>
                <span className="orch-mono">{card.origin}</span>
                {card.asker !== card.origin ? (
                  <>
                    <span aria-hidden>via</span>
                    <span className="orch-mono">{card.asker}</span>
                  </>
                ) : null}
                {card.escalated ? (
                  <Kind of="escalated" group="deferred" data-escalated="">
                    CoS didn't triage
                  </Kind>
                ) : null}
                {card.merge ? (
                  <Kind of="merge" data-merge="">
                    Merge
                  </Kind>
                ) : null}
                {card.returnedAt ? <Tag>Back</Tag> : null}
                {card.queued ? <Tag data-queued="">{`+${card.queued} next from ${card.asker}`}</Tag> : null}
                {list === "deferred" ? <Tag>{card.deferredUntil ? `Deferred until ${when(card.deferredUntil)}` : "Deferred until you bring it back"}</Tag> : null}
              </p>
            </div>
            {/* one fixed slot: the mark replaces the time, so marking moves nothing */}
            <span data-mark={mark ? "" : undefined} className={cn(WHEN, mark && "font-medium")} style={{ color: markColor }}>
              {mark ?? when(card.askedAt)}
            </span>
          </header>
          {notice ? (
            <p role="status" data-notice="" className="orch-danger m-0 mt-2 text-xs">
              {notice}
            </p>
          ) : null}
          {/* a PR or merge card leads with its PR: the chip, its live state and the one-line verdict (2026-11-14) */}
          <Blocks blocks={card.blocks} prs={card.prs} only={order.lead} />
          <p data-question-text="" className="m-0 mt-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
            {card.question}
          </p>
          {/* "Scoping done?" (1.11.0): the lead's summary and the PROJECT.md it is written in, above the fixed options */}
          {card.scopingDone ? (
            <div data-scoping-done="" className="mt-2 rounded-md border p-3 text-sm">
              <div className="min-w-0 [overflow-wrap:anywhere]">
                <Markdown content={card.scopingDone.summary} />
              </div>
              <p className="m-0 mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                Written in <span className="orch-mono">{card.scopingDone.projectMd}</span>
              </p>
            </div>
          ) : null}
          {/* no prose on the card (2026-11-14): at most one decision line; the context and the decisions open from More */}
          {order.line ? (
            <p data-card-line="" className="m-0 mt-1 truncate text-sm text-muted-foreground" title={order.line}>
              {order.line}
            </p>
          ) : null}
          {card.context || order.more.length > 0 ? (
            <Details markdown={card.context ?? ""}>
              <Blocks blocks={card.blocks} prs={card.prs} only={order.more} />
            </Details>
          ) : null}
          <Blocks blocks={card.blocks} prs={card.prs} busy={busy} onPaste={(v) => act.secret(card, list, v)} unticked={unticked} onToggle={toggle} only={order.after} />

          <Options
            disabled={busy}
            options={card.options.map((o) => ({
              key: o.id,
              label: o.label,
              detail: o.detail,
              recommended: o.recommended,
              pressed: picked ? picked === o.id : undefined,
              data: { "data-option": o.id, "data-armed": isArmed ? "true" : "false", "data-recommended": o.recommended ? "true" : undefined },
              onPick: () => (draft ? draft.onPick({ option: o.id, note, unticked }) : act.answer(card, list, o.id, withLists(note))),
            }))}
          />

          {/* Requested 2026-11-13: "other should just be an open text box and command enter should send it". Typed text
              also rides along with an option picked above. */}
          {card.allowText ? (
            <OtherBox
              value={note}
              onChange={setNote}
              disabled={busy}
              sendLabel={draft ? "Save" : "Send"}
              onSend={() => (draft ? draft.onPick({ option: null, note, unticked }) : act.answer(card, list, null, withLists(note)))}
              placeholder={draft ? "Other: your own answer, or a note to go with an option. ⌘↵ saves" : "Other: your own answer, or a note to go with an option. ⌘↵ sends"}
            />
          ) : null}

          <footer className="mt-2 flex items-center gap-2">
            <span className="ml-auto" />
            {draft?.value && draft.onClear ? (
              <Btn tone="ghost" size="sm" data-draft-clear="" disabled={busy} onClick={draft.onClear}>
                Clear draft
              </Btn>
            ) : null}
            {list === "deferred" ? (
              <Btn data-return="" disabled={busy} onClick={() => act.bringBack(card)}>
                Bring back
              </Btn>
            ) : presets.length > 0 ? (
              // shadcn's menu, portaled and with no animation: opening it changes no card's height and moves nothing
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Btn tone="ghost" data-defer="" disabled={busy}>
                    Defer
                    <ChevronDown aria-hidden />
                  </Btn>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" aria-label="Defer until">
                  {presets.map((p) => (
                    <DropdownMenuItem key={p.id} disabled={busy} data-preset={p.id} onSelect={() => act.defer(card, p.id)}>
                      {p.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </footer>
    </Frame>
  );
}

function ReviewCard({
  card,
  draft,
  failure,
  editing,
  submitting,
  mon,
  monType,
  onStartEdit,
  onCancelEdit,
  onSave,
  onClear,
  onDismiss,
  onSecret,
}: {
  card: Card;
  draft: StepperDraft | null;
  failure: StepperFailure | null;
  editing: boolean;
  submitting: boolean;
  mon: Face | null;
  monType: string | null;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (draft: StepperDraft) => void;
  onClear: () => void;
  onDismiss: () => void;
  onSecret: (value: string) => void;
}) {
  const [note, setNote] = useState(() => draft?.note ?? "");
  const [unticked, setUnticked] = useState<Map<number, Set<number>>>(() => cloneUnticked(draft?.unticked));

  useEffect(() => {
    if (editing) {
      setNote(draft?.note ?? "");
      setUnticked(cloneUnticked(draft?.unticked));
    }
  }, [editing, draft]);

  const toggle = (block: number, item: number) =>
    setUnticked((m) => {
      const next = new Map(m);
      const off = new Set(next.get(block) ?? []);
      if (off.has(item)) off.delete(item);
      else off.add(item);
      next.set(block, off);
      return next;
    });

  const order = cardBlockOrder(card.blocks);
  const pickedOption = draft?.option ? card.options.find((o) => o.id === draft.option) : null;
  const noteSummary = draft ? formatDraftNote(card, draft) : "";
  const valid = draft ? isDraftValidForCard(card, draft, noteSummary) : true;

  return (
    <Frame role="article" data-review-card={card.id} data-rev={card.rev} data-accent={monType ?? undefined} className="gap-0 p-4" style={accentVars(monType)}>
      <header className="flex items-start gap-3">
        <AgentFace face={mon} address={card.origin} size={28} />
        <div className="min-w-0 flex-1">
          <h4 className="m-0 text-sm leading-5 font-semibold [overflow-wrap:anywhere]">{card.title}</h4>
          <p className={META}>
            <span style={accentTone(monType) ? { color: ACCENT, fontWeight: 600 } : undefined}>{card.project ?? "no project"}</span>
            <span aria-hidden>·</span>
            <span className="orch-mono">{card.origin}</span>
          </p>
        </div>
        <div className="flex-none">
          {failure ? (
            <Kind of="failed" group="alarm" data-review-status="failed">
              Failed
            </Kind>
          ) : draft ? (
            <Tag data-review-status="draft">Draft</Tag>
          ) : (
            <Tag data-review-status="skipped">Skipped</Tag>
          )}
        </div>
      </header>

      <p className="m-0 mt-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{card.question}</p>

      {failure ? (
        <p role="status" data-review-error={card.id} className="orch-danger m-0 mt-2 text-xs">
          {failure.message}
        </p>
      ) : null}

      {!editing ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div data-review-answer={card.id} className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
            {draft ? (
              <div className="flex flex-col gap-0.5">
                {draft.option !== null ? (
                  <span className={cn("font-medium", !pickedOption && "orch-danger")}>
                    {pickedOption ? pickedOption.label : "Picked option is no longer available — edit before sending"}
                  </span>
                ) : null}
                {noteSummary ? <span className="text-muted-foreground whitespace-pre-wrap">{noteSummary}</span> : null}
                {!valid && draft.option === null ? <span className="orch-danger text-xs">Edit this answer before sending</span> : null}
              </div>
            ) : (
              <span className="text-muted-foreground">Skipped — stays open on Needs you</span>
            )}
          </div>
          <div className="flex flex-none flex-wrap items-center gap-1.5">
            {!failure?.gone ? (
              <Btn size="sm" tone="outline" data-review-edit={card.id} disabled={submitting} onClick={onStartEdit}>
                {draft ? "Edit" : "Answer"}
              </Btn>
            ) : null}
            {failure?.gone ? (
              <Btn size="sm" tone="ghost" data-review-dismiss={card.id} disabled={submitting} onClick={onDismiss}>
                Dismiss
              </Btn>
            ) : draft ? (
              <Btn size="sm" tone="ghost" data-review-skip={card.id} disabled={submitting} onClick={onClear}>
                Skip
              </Btn>
            ) : null}
          </div>
        </div>
      ) : (
        <div data-review-editor={card.id} className="mt-2">
          <Blocks blocks={card.blocks} prs={card.prs} busy={submitting} onPaste={onSecret} unticked={unticked} onToggle={toggle} only={order.after} />
          <Options
            disabled={submitting}
            options={card.options.map((o) => ({
              key: o.id,
              label: o.label,
              detail: o.detail,
              recommended: o.recommended,
              pressed: draft?.option ? draft.option === o.id : undefined,
              data: { "data-option": o.id, "data-recommended": o.recommended ? "true" : undefined },
              onPick: () => onSave({ option: o.id, note, unticked }),
            }))}
          />
          {card.allowText ? (
            <OtherBox
              value={note}
              onChange={setNote}
              disabled={submitting}
              sendLabel="Save"
              onSend={() => onSave({ option: null, note, unticked })}
              placeholder="Other: your own answer, or a note to go with an option. ⌘↵ saves"
            />
          ) : null}
          <div className="mt-2 flex items-center justify-end gap-2">
            {draft ? (
              <Btn size="sm" tone="ghost" disabled={submitting} onClick={onClear}>
                Skip
              </Btn>
            ) : null}
            <Btn size="sm" tone="outline" disabled={submitting} onClick={onCancelEdit}>
              Cancel
            </Btn>
          </div>
        </div>
      )}
    </Frame>
  );
}

type Query = { data: NeedsYou | undefined; error: { message: string } | null; refetch: () => Promise<void> };

/** `mons`: address → its face (its Pokémon or person), from the board's agents (for the asker's sprite on each card). */
export function NeedsYouView({ q, refetchAll, mons, threads, accents }: { q: Query; refetchAll: () => void; mons: ReadonlyMap<string, Face>; threads: ReadonlyMap<string, string>; accents?: ReadonlyMap<string, string | null> }) {
  const gateVersion = useGate();
  const navigate = useBbNavigate();
  const live = q.data;
  const liveRef = useRef<NeedsYou | undefined>(live);
  liveRef.current = live;
  // no reflow under a pressed pointer or while a write holds the page: draw what was drawn last
  const frozen = gate.pointerDown || gate.lock !== null;
  const last = useRef<NeedsYou | undefined>(undefined);
  const view = frozen && last.current ? last.current : live ? visible(live) : undefined;
  useLayoutEffect(() => {
    last.current = view;
  });
  useEffect(() => {
    if (live) pruneGone(new Set([...live.cards.map((c) => `${c.id}@${c.rev}`), ...live.interactions.map((i) => `${ixKey(i)}@0`)]), new Set(live.deferred.map((c) => `${c.id}@${c.rev}`)));
  }, [live]);

  const [stepper, setStepper] = useState<StepperState<Card> | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const unlockWaiterRef = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const resolve = unlockWaiterRef.current;
      unlockWaiterRef.current = null;
      resolve?.(false);
    };
  }, []);

  useEffect(() => {
    if (gate.lock === null && unlockWaiterRef.current) {
      const resolve = unlockWaiterRef.current;
      unlockWaiterRef.current = null;
      resolve(true);
    }
  }, [gateVersion]);

  const waitForUnlock = useCallback((): Promise<boolean> => {
    if (!mountedRef.current) return Promise.resolve(false);
    if (gate.lock === null) return Promise.resolve(true);
    return new Promise((resolve) => {
      unlockWaiterRef.current = resolve;
    });
  }, []);

  useEffect(() => {
    if (!live || submitting) return;
    setStepper((cur) => (cur ? reconcileStepper(cur, live.cards) : cur));
  }, [live, submitting]);

  const root = useRef<HTMLDivElement>(null);
  const arming = useArming(root);
  // Keys (2026-11-16): J/K select, 1-4 pick an answer on the selected card, Enter sends it, O opens its asker's thread.
  // Answering goes through the card's own button, so the arming and the page lock apply to the key as to a click.
  useViewKeys("needs-you", root, '[data-list="cards"] [data-card]', (el) => el.dataset.card ?? "", (a, sel) => {
    if (!sel) return false;
    const rev = `${sel.id}@${sel.el.dataset.rev ?? 0}`;
    if (a.t === "pick") {
      const btn = sel.el.querySelectorAll<HTMLElement>("[data-option]")[a.n - 1];
      if (!btn) say(sel.el.hasAttribute("data-question-card") ? "An agent's question: open it with O to answer" : `This card has no answer ${a.n}`);
      else {
        keyState.picked.set(rev, btn.dataset.option ?? "");
        emitKeys();
        say(`Picked ${a.n}: Enter sends it`);
      }
      return true;
    }
    if (a.t === "send") {
      const id = keyState.picked.get(rev);
      if (!id) return false;
      const btn = Array.from(sel.el.querySelectorAll<HTMLButtonElement>("[data-option]")).find((b) => b.dataset.option === id);
      if (!btn || btn.disabled) return false;
      if (btn.dataset.armed !== "true") {
        say("The card just changed: wait a moment");
        return true;
      }
      keyState.picked.delete(rev);
      btn.click();
      return true;
    }
    if (a.t === "open") {
      const thread = sel.el.dataset.thread ?? threads.get(sel.el.dataset.asker ?? "");
      if (thread) navigate.toThread(thread);
      else say("No thread to open for this card");
      return true;
    }
    if (a.t === "approve") {
      say("A closes a deliverable: use it in Deliverables");
      return true;
    }
    return false;
  });

  const send = (card: Card, kind: WriteKind, hide: Hide, path: string, body: unknown) => {
    if (gate.lock) return; // one write at a time, page-wide
    // not sat still for ARM_MS: dropped, no request. Bring back is under the page lock only (it answers nothing).
    if (kind !== "return" && !arming.check(card.id, card.rev)) return;
    void write(path, body, { card: { id: card.id, rev: card.rev, hide }, kind, after: refetchAll });
  };
  // an agent's own question: the same lock and arming as a card, keyed ix:<interaction id> at rev 0
  const answerQuestion = (i: NeedsYou["interactions"][number], answers: Answers) => {
    if (gate.lock) return;
    const key = ixKey(i);
    if (!arming.check(key, 0)) return;
    const body: z.input<typeof interactionAnswerBody> = { threadId: i.threadId, interactionId: i.id, answers };
    void write(WRITES.interactionAnswer, body, { card: { id: key, rev: 0, hide: "both" }, kind: "answer", after: refetchAll });
  };
  const act: Act = {
    answer(card, _list, option, note) {
      const body: z.input<typeof answerBody> = { id: card.id, rev: card.rev, option, text: note.trim() ? note : null, via: via() };
      send(card, "answer", "both", WRITES.answer, body);
    },
    defer(card, preset) {
      const body: z.input<typeof deferBody> = { id: card.id, rev: card.rev, preset, zone: ZONE, via: via() };
      send(card, "defer", "cards", WRITES.defer, body);
    },
    secret(card, _list, value) {
      const body: z.input<typeof secretBody> = { id: card.id, rev: card.rev, value, via: via() };
      send(card, "answer", "both", WRITES.secret, body);
    },
    bringBack(card) {
      const body: z.input<typeof returnBody> = { id: card.id, rev: card.rev };
      send(card, "return", "deferred", WRITES.return, body);
    },
  };

  if (!view) {
    return (
      <div ref={root}>
        <ReadState q={q} what="Needs you" />
      </div>
    );
  }

  const busy = gate.lock !== null;
  const n = view.badge;
  const questions = view.interactions.filter((i) => i.questions.length > 0);
  const prompts = view.interactions.filter((i) => i.questions.length === 0);
  const offerStepper = !stepper && canOfferStepper(view.cards);
  const stepperNotice = stepper ? droppedNotice(stepper) : null;
  const currentCard = stepper && !isReview(stepper) ? stepper.cards[stepper.index] ?? null : null;
  const sendable = stepper ? submittableDrafts(stepper, formatDraftNote) : [];
  const submitArmed = stepper ? arming.isArmed("stepper-submit", stepper.submitEpoch) : false;

  const startStepper = () => {
    if (busy || !canOfferStepper(view.cards)) return;
    setEditingId(null);
    setStepper(openStepper(view.cards));
  };

  const exitStepper = () => {
    if (submittingRef.current) return;
    setEditingId(null);
    setStepper(null);
  };

  const handleSubmit = async () => {
    if (submittingRef.current || gate.lock !== null || !stepper) return;
    if (!arming.check("stepper-submit", stepper.submitEpoch)) return;
    const items = submittableDrafts(stepper, formatDraftNote);
    if (items.length === 0) return;

    submittingRef.current = true;
    setSubmitting(true);
    setEditingId(null);
    setProgress({ index: 0, total: items.length });

    const viaDevice = via();
    const result = await submitBatch(items, {
      waitForUnlock,
      latestCard: (id) => liveRef.current?.cards.find((c) => c.id === id),
      sendOne: async (card, draft) => {
        const noteText = formatDraftNote(card, draft);
        const body: z.input<typeof answerBody> = {
          id: card.id,
          rev: card.rev,
          option: draft.option,
          text: noteText.trim() ? noteText : null,
          via: viaDevice,
        };
        return write(WRITES.answer, body, {
          card: { id: card.id, rev: card.rev, hide: "both" },
          kind: "answer",
          after: refetchAll,
        });
      },
      onProgress: (index, total) => {
        if (mountedRef.current) setProgress({ index, total });
      },
    });

    await waitForUnlock();
    submittingRef.current = false;
    if (!mountedRef.current) return;
    setSubmitting(false);
    setProgress(null);

    if (result.failed.size === 0) {
      setStepper(null);
    } else {
      setStepper((cur) => {
        if (!cur) return null;
        const applied = applyBatchResult(cur, result);
        return liveRef.current ? reconcileStepper(applied, liveRef.current.cards) : applied;
      });
    }
  };

  return (
    <div ref={root} className="flex flex-col gap-4 pb-8">
      <style href={styleHref("orch-answer", answerCss)} precedence="default">
        {answerCss}
      </style>
      {/* the count, then one Card per decision; when none waits, shadcn's empty state */}
      <section className="flex flex-col gap-3" aria-label="Needs you">
        {n > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="m-0 flex items-center gap-2 text-sm font-semibold">
              <CircleAlert className="size-4 text-(--warning-text)" aria-hidden />
              <span data-count={String(n)}>{`${n} ${n === 1 ? "needs" : "need"} your input`}</span>
            </h3>
            {offerStepper ? (
              <Btn size="sm" tone="outline" className="ml-auto" data-stepper-start="" disabled={busy} onClick={startStepper}>
                Answer one at a time
              </Btn>
            ) : null}
            {q.error ? <span className={cn("orch-danger text-xs font-normal", !offerStepper && "ml-auto")}>Stale: {q.error.message}</span> : null}
          </div>
        ) : (
          <EmptyState title={<span data-count="0">All caught up</span>} text="Nothing waiting on you – new decisions show up here." icon={<CircleCheck />} action={q.error ? <span className="orch-danger text-xs">Stale: {q.error.message}</span> : undefined} />
        )}

        {stepper ? (
          <div data-stepper="" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <span data-stepper-pos="">{positionLabel(stepper)}</span>
                {stepper.drafts.size > 0 ? <Tag data-stepper-drafted="">{`${stepper.drafts.size} drafted`}</Tag> : null}
              </div>
              <Btn size="sm" tone="ghost" data-stepper-exit="" disabled={submitting} onClick={exitStepper}>
                Show all
              </Btn>
            </div>

            {stepperNotice ? (
              <Alert data-stepper-notice="">
                <AlertDescription>{stepperNotice}</AlertDescription>
              </Alert>
            ) : null}

            {currentCard ? (
              <>
                <div className="flex flex-col gap-3" data-list="cards">
                  <CardView
                    key={`${currentCard.id}@${currentCard.rev}`}
                    card={currentCard}
                    list="cards"
                    presets={[]}
                    isArmed={arming.isArmed(currentCard.id, currentCard.rev)}
                    act={act}
                    mon={mons.get(currentCard.origin) ?? null}
                    monType={currentCard.project ? (accents?.get(currentCard.project) ?? null) : null}
                    draft={{
                      value: stepper.drafts.get(currentCard.id) ?? null,
                      onPick: (d) => {
                        if (!arming.check(currentCard.id, currentCard.rev)) return;
                        setStepper((cur) => (cur ? saveDraft(cur, currentCard.id, d, true) : cur));
                      },
                      onClear: () => setStepper((cur) => (cur ? clearDraft(cur, currentCard.id) : cur)),
                    }}
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Btn tone="outline" data-stepper-back="" disabled={stepper.index === 0 || submitting} onClick={() => setStepper((cur) => (cur ? stepBack(cur) : cur))}>
                    Back
                  </Btn>
                  <Btn tone="outline" data-stepper-next="" disabled={submitting} onClick={() => setStepper((cur) => (cur ? stepNext(cur) : cur))}>
                    Next
                  </Btn>
                </div>
              </>
            ) : (
              <div data-stepper-review="" className="flex flex-col gap-3">
                {stepper.failures.size > 0 ? (
                  <Alert variant="destructive" data-stepper-errors="">
                    <AlertDescription>
                      {`${stepper.failures.size} ${stepper.failures.size === 1 ? "answer could" : "answers could"} not be sent. Your ${stepper.failures.size === 1 ? "draft is" : "drafts are"} kept below.`}
                    </AlertDescription>
                  </Alert>
                ) : null}

                {stepper.cards.length === 0 ? (
                  <EmptyState
                    title="Nothing left in this batch"
                    text="Every card from this batch was already answered or updated elsewhere."
                    icon={<CircleCheck />}
                    action={
                      <Btn tone="outline" onClick={exitStepper}>
                        Back to Needs you
                      </Btn>
                    }
                  />
                ) : (
                  <>
                    {stepper.cards.map((c) => (
                      <ReviewCard
                        key={`${c.id}@${c.rev}`}
                        card={c}
                        draft={stepper.drafts.get(c.id) ?? null}
                        failure={stepper.failures.get(c.id) ?? null}
                        editing={editingId === c.id}
                        submitting={submitting}
                        mon={mons.get(c.origin) ?? null}
                        monType={c.project ? (accents?.get(c.project) ?? null) : null}
                        onStartEdit={() => setEditingId(c.id)}
                        onCancelEdit={() => setEditingId(null)}
                        onSave={(d) => {
                          setStepper((cur) => (cur ? saveDraft(cur, c.id, d, false) : cur));
                          setEditingId(null);
                        }}
                        onClear={() => {
                          setStepper((cur) => (cur ? clearDraft(cur, c.id) : cur));
                          if (editingId === c.id) setEditingId(null);
                        }}
                        onDismiss={() => {
                          setStepper((cur) => (cur ? dismissCard(cur, c.id) : cur));
                          if (editingId === c.id) setEditingId(null);
                        }}
                        onSecret={(v) => act.secret(c, "cards", v)}
                      />
                    ))}
                    <div data-arm="stepper-submit" data-rev={stepper.submitEpoch} className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <Btn tone="outline" data-stepper-back="" disabled={submitting} onClick={() => { setEditingId(null); setStepper((cur) => (cur ? stepBack(cur) : cur)); }}>
                        Back
                      </Btn>
                      <div className="flex flex-wrap items-center gap-2">
                        {progress ? <span data-stepper-progress="" className="text-xs text-muted-foreground">{`Sending ${progress.index + 1} of ${progress.total}…`}</span> : null}
                        <Btn
                          tone="primary"
                          data-stepper-submit=""
                          data-armed={submitArmed ? "true" : "false"}
                          disabled={submitting || busy || sendable.length === 0}
                          onClick={() => void handleSubmit()}
                        >
                          {submitting
                            ? "Sending…"
                            : stepper.failures.size > 0
                              ? `Retry ${sendable.length} ${sendable.length === 1 ? "answer" : "answers"}`
                              : `Submit ${sendable.length} ${sendable.length === 1 ? "answer" : "answers"}`}
                        </Btn>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3" data-list="cards">
            {view.cards.map((c) => (
              <CardView key={c.id} card={c} list="cards" presets={view.presets} isArmed={arming.isArmed(c.id, c.rev)} act={act} mon={mons.get(c.origin) ?? null} monType={c.project ? (accents?.get(c.project) ?? null) : null} />
            ))}
            {questions.map((i) => (
              <QuestionCard key={i.id} ix={i} isArmed={arming.isArmed(ixKey(i), 0)} mon={mons.get(i.address) ?? null} onSend={(a) => answerQuestion(i, a)} onOpen={() => navigate.toThread(i.threadId)} />
            ))}
            {view.cards.length + questions.length === 0 && n > 0 ? <p className="m-0 text-sm text-muted-foreground">No cards to answer: the threads below wait on you.</p> : null}
          </div>
        )}
      </section>

      {stepper && questions.length > 0 ? (
        <section className="flex flex-col gap-3" aria-label="Agent questions">
          {questions.map((i) => (
            <QuestionCard key={i.id} ix={i} isArmed={arming.isArmed(ixKey(i), 0)} mon={mons.get(i.address) ?? null} onSend={(a) => answerQuestion(i, a)} onOpen={() => navigate.toThread(i.threadId)} />
          ))}
        </section>
      ) : null}

      {prompts.length > 0 ? (
        <Section title="Waiting on an agent" count={prompts.length}>
          <ItemGroup className="divide-y">
            {prompts.map((i) => (
              <div key={i.id} role="listitem" data-interaction={i.threadId}>
                <Btn tone="ghost" className="h-auto min-h-9 w-full flex-wrap justify-start gap-x-3 gap-y-1 px-1 py-2 text-left font-normal" onClick={() => navigate.toThread(i.threadId)} title={i.threadId}>
                  <Who address={i.address} nowrap />
                  <span className="min-w-0 flex-1 truncate">{i.title}</span>
                  <Tag>{i.kind}</Tag>
                  {i.since ? <span className="text-xs text-muted-foreground">{when(i.since)}</span> : null}
                </Btn>
              </div>
            ))}
          </ItemGroup>
        </Section>
      ) : null}

      {view.triaging.length > 0 ? (
        <Section title="Being triaged by the CoS" count={view.triaging.length}>
          <ItemGroup className="divide-y">
            {view.triaging.map((t) => (
              <Item key={t.id} role="listitem" size="sm" data-triaging={t.id} className="gap-x-3 gap-y-1 rounded-none px-0 py-2">
                <Kind of="open">triaging</Kind>
                <span className="min-w-0 flex-1">{t.title}</span>
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  {t.project ?? "no project"} · <Who address={t.origin} nowrap />
                </span>
                <span className="text-xs text-muted-foreground">due {when(t.dueAt)}</span>
              </Item>
            ))}
          </ItemGroup>
        </Section>
      ) : null}

      {view.deferred.length > 0 ? (
        <section className="flex flex-col gap-3" aria-label="Deferred">
          <h3 className="m-0 flex items-center gap-2 text-sm font-semibold">
            Deferred
            <Tag>{view.deferred.length}</Tag>
          </h3>
          <div className="flex flex-col gap-3" data-list="deferred">
            {view.deferred.map((c) => (
              <CardView key={c.id} card={c} list="deferred" presets={view.presets} isArmed={arming.isArmed(c.id, c.rev)} act={act} mon={mons.get(c.origin) ?? null} monType={c.project ? (accents?.get(c.project) ?? null) : null} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
