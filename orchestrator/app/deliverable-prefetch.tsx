// A past card opened by a click was drawn loading for one `deliverable` read (2026-11-24, lag 2: 39-309 ms; main drew
// it at once, from its whole list). Each control that opens one names it (`data-prefetch-deliverable`), and the read
// starts as the owner presses it rather than once the card mounts: on pointer-down for a mouse or pen, on lifting a
// touch (a touch that scrolls is cancelled and reads nothing), on Enter or Space for the keyboard. Never on hover, so a
// pointer passing over rows, or a phone scrolling past them, costs nothing. The read has one owner at the root, the same
// one the card that mounts from the press uses (useCardRead), so the card takes the read under way, or its answer,
// instead of starting another; after a change notice the owner alone reads again (deliverable-reads.ts).
import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { rpcContract, type DeliverableIndex, type Deliverables } from "../contract.ts";
import { touches } from "../change-notice.ts";
import { useChangeNotice } from "./change-listener.ts";
import { PREFETCH_ATTR, isPress, type Press } from "./deliverable-press.ts";
import { NoticeClock, cardClock, indexClock, pressOpen, showCard, wantedStore } from "./deliverable-reads.ts";

// a press wants its card read for a few seconds: the card that mounts from it takes the same owner, so the press and the
// opening are one open and one read; a press that opens nothing lets go
const PRESS_HOLD_MS = 3000;

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

const onPress = (e: PointerEvent | KeyboardEvent) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const press = { type: e.type, pointerType: (e as PointerEvent).pointerType, button: (e as PointerEvent).button, key: (e as KeyboardEvent).key, editable: t.closest(EDITABLE) !== null, onOpener: t.hasAttribute(PREFETCH_ATTR) };
  if (!isPress(press as Press)) return;
  // a key names only the control it is pressed on; a pointer, the post or row it lands in
  const id = press.onOpener ? t.getAttribute(PREFETCH_ATTR) : t.closest(`[${PREFETCH_ATTR}]`)?.getAttribute(PREFETCH_ATTR);
  if (id) pressOpen(id, PRESS_HOLD_MS);
};

const NONE: string[] = [];

/**
 * Mounted once at the app's root: counts the notices that touch a card (deliverable-reads.ts cardClock), listens for
 * presses on openers, and holds one owner for each card whose read is wanted, pressed or shown. Only the owner reads.
 */
export function DeliverablePrefetch() {
  const ids = useSyncExternalStore(wantedStore.subscribe, wantedStore.get, () => NONE);
  useChangeNotice(
    useCallback((n: unknown) => {
      if (touches(n, "deliverable")) cardClock.notice();
    }, []),
  );
  useEffect(() => {
    for (const t of ["pointerdown", "pointerup", "keydown"] as const) document.addEventListener(t, onPress, true);
    return () => {
      for (const t of ["pointerdown", "pointerup", "keydown"] as const) document.removeEventListener(t, onPress, true);
    };
  }, []);
  return (
    <>
      {ids.map((id) => (
        <CardOwner key={id} id={id} />
      ))}
    </>
  );
}

function CardOwner({ id }: { id: string }) {
  const q = experimental_useRpcQuery({ contract: rpcContract, method: "deliverable", input: { id }, enabled: true });
  useOwnedRead(cardClock, id, q, true);
  return null;
}

/**
 * A card's whole read, as a card sees it (useWhole): the owner at the root reads it; the card only wants it while it
 * is shown and takes the answer from the shared cache. Its own query never reads, so it never adds a read on mount or
 * joins one under way.
 */
export function useCardRead(id: string, need: boolean): Deliverables[number] | undefined {
  const q = experimental_useRpcQuery({ contract: rpcContract, method: "deliverable", input: { id }, enabled: false });
  useLayoutEffect(() => (need ? showCard(id) : undefined), [need, id]);
  return q.data ?? undefined;
}

/** The owner's side of NoticeClock: on each render it decides, from that render, whether to read; nothing else does. */
function useOwnedRead(clock: NoticeClock, key: string, q: { isFetching: boolean; error: unknown; refetch: () => Promise<void> }, active: boolean) {
  const version = useSyncExternalStore(clock.subscribe, clock.get, clock.get);
  // the first render as owner is an open: the read it wants is the one its query starts now, or the one it starts
  const was = useRef(false);
  if (active && !was.current) clock.mount(key);
  const refetch = useRef(q.refetch);
  refetch.current = q.refetch;
  // a read that starts and answers between two renders shows no fetching: look again once it has answered
  const [answered, kick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    was.current = active;
    if (!active) return;
    if (clock.step(key, q.isFetching, q.error === null || q.error === undefined)) void refetch.current().finally(kick);
  }, [clock, key, active, q.isFetching, q.error, version, answered]);
  useEffect(
    () => () => {
      if (was.current) clock.unmount(key);
      was.current = false;
    },
    [clock, key],
  );
}

type IndexRead = { data: DeliverableIndex | undefined; error: unknown; isFetching: boolean; refetch: () => Promise<void> };
const IndexContext = createContext<{ read: IndexRead; open: () => void } | null>(null);

/**
 * Delivered's first paint waits for the index of every card's revisions (its search, Files and file counts), so a first
 * visit drew the page loading for about 7 frames (2026-11-24, lag 2; main drew 0). Wrapped around the app's root, this
 * reads the index once the app has painted and the browser is idle, then again on a notice that a deliverable changed
 * (change-notice.ts READS.deliverableIndex), never on the other notices, and on each opening of Delivered unless a read
 * is under way: Delivered draws from the cached index at once, and a change made while the panel was closed, when no
 * notice could be counted, is read behind it. Delivered uses this one read (useDeliverableIndex) rather than mounting
 * its own, so an opening reads it once. Opened in the first instant, before the idle read, Delivered starts it.
 */
export function DeliverableIndexProvider({ children }: { children: ReactNode }) {
  const [warm, setWarm] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // after the first paint (the frame after mount), at the browser's first idle moment, or in 2 s at the latest
    const frame = requestAnimationFrame(() => {
      if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(() => setWarm(true), { timeout: 2000 });
      else timer = setTimeout(() => setWarm(true), 200);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (idle !== undefined) window.cancelIdleCallback(idle);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);
  const q = experimental_useRpcQuery({ contract: rpcContract, method: "deliverableIndex", input: null, enabled: warm });
  useChangeNotice(
    useCallback((n: unknown) => {
      if (touches(n, "deliverableIndex")) indexClock.notice();
    }, []),
  );
  useOwnedRead(indexClock, "index", q, warm);
  // Delivered opened: the index draws from what is cached and is read again behind it, unless a read is under way
  const fetching = useRef(q.isFetching);
  fetching.current = q.isFetching;
  const open = useCallback(() => {
    setWarm(true);
    indexClock.open("index", fetching.current);
  }, []);
  const value = useMemo(() => ({ read: { data: q.data, error: q.error, isFetching: q.isFetching, refetch: q.refetch }, open }), [q.data, q.error, q.isFetching, q.refetch, open]);
  return <IndexContext.Provider value={value}>{children}</IndexContext.Provider>;
}

/** The index read: the app root's (DeliverableIndexProvider), opened now (read again, or started if it is not yet); outside
 *  it, a read of its own. */
export function useDeliverableIndex(): IndexRead {
  const ctx = useContext(IndexContext);
  const own = experimental_useRpcQuery({ contract: rpcContract, method: "deliverableIndex", input: null, enabled: ctx === null });
  const open = ctx?.open;
  useEffect(() => open?.(), [open]);
  return ctx ? ctx.read : own;
}
