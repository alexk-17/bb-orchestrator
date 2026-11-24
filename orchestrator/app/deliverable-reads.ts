// Who reads a card or the index again, and when (2026-11-24, lag 2, after Codex's reviews and the owner's choice).
// Each of the two reads has one owner, and only the owner refetches: a refetch with no data joins the read under way
// (its answer may predate a change) and one with data cancels it. The owner reads:
// - on each open (the owner mounting: a card shown, the index's Delivered opened): the cached copy draws at once and is
//   checked behind it, so a change while the panel was closed, when no notice could be counted, is never missed;
// - after each change notice that touches it: one more read once a read under way settles, however many notices came;
// - again when the page is shown, if a read did not count. A read counts only when it answered with no error while the
//   page stayed shown: a page hidden mid-read may have had its read cancelled, which looks the same as an answer.

/** The page as the reads see it: how many times it was hidden, and whether it is shown now. */
export const page = { hidden: 0, shown: true };
const pageListeners = new Set<() => void>();
export function pageVisibility(shown: boolean) {
  if (shown === page.shown) return;
  if (!shown) page.hidden++;
  page.shown = shown;
  for (const l of pageListeners) l();
}
let watching = false;
function watchPage() {
  if (watching || typeof document === "undefined") return;
  watching = true;
  page.shown = document.visibilityState !== "hidden";
  document.addEventListener("visibilitychange", () => pageVisibility(document.visibilityState !== "hidden"));
}

type Read = { from: number | null; fromHidden: number; at: number; failed: number; idle: number; idleHidden: number; want: number; owned: boolean };

/** The relevant notices and opens so far, as a store (useSyncExternalStore), and each read's stamps. */
export class NoticeClock {
  private seq = 0;
  private lastNotice = 0;
  private version = 0;
  private reads = new Map<string, Read>();
  private listeners = new Set<() => void>();
  private emit = () => {
    this.version++;
    for (const l of this.listeners) l();
  };
  readonly subscribe = (l: () => void) => {
    watchPage();
    if (this.listeners.size === 0) pageListeners.add(this.emit);
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
      if (this.listeners.size === 0) pageListeners.delete(this.emit);
    };
  };
  readonly get = () => this.version;
  /** Entries held: one per owner mounted, plus a read left under way when its owner went (dropped a minute later). */
  get size() {
    return this.reads.size;
  }
  notice() {
    this.lastNotice = ++this.seq;
    this.emit();
  }
  private of(key: string) {
    let r = this.reads.get(key);
    if (!r) this.reads.set(key, (r = { from: null, fromHidden: 0, at: -1, failed: -1, idle: 0, idleHidden: page.hidden, want: 0, owned: false }));
    return r;
  }
  /**
   * The owner's first render: an open. A read is wanted from now; a read its query shows from here on is the one it
   * starts on mount, so it starts now. A read left under way by an earlier owner keeps its older stamp, and one more
   * read follows it.
   */
  mount(key: string) {
    const r = this.of(key);
    r.owned = true;
    r.want = ++this.seq;
    if (r.from === null) {
      r.idle = this.seq;
      r.idleHidden = page.hidden;
    }
  }
  /** The owner went. Its entry goes too, or a minute later if its read is still under way (an open soon after keeps it). */
  unmount(key: string) {
    const r = this.reads.get(key);
    if (!r) return;
    r.owned = false;
    if (r.from === null) this.reads.delete(key);
    else
      setTimeout(() => {
        if (this.reads.get(key) === r && !r.owned) this.reads.delete(key);
      }, 60_000);
  }
  /** An open while the owner stays mounted (Delivered opened under the index's owner): read, unless a read is under way. */
  open(key: string, fetching: boolean) {
    if (fetching) return;
    this.of(key).want = ++this.seq;
    this.emit();
  }
  /**
   * The owner's rule, from what one render saw. True: start one read now. A read under way that the owner did not start
   * (the host's own, on mount) is stamped with the last moment the owner saw the query idle: never later than its real
   * start, so it never passes for newer than it is.
   */
  step(key: string, fetching: boolean, ok: boolean): boolean {
    const r = this.of(key);
    if (fetching) {
      if (r.from === null) {
        r.from = r.idle;
        r.fromHidden = r.idleHidden;
      }
      return false;
    }
    if (r.from !== null) {
      // hidden meanwhile: maybe cancelled, so it does not count (the page shown again reads); a failed read waits for
      // the next open or notice, so an error never loops
      if (r.fromHidden === page.hidden) {
        if (ok) r.at = Math.max(r.at, r.from);
        else r.failed = Math.max(r.failed, r.from);
      }
      r.from = null;
    }
    r.idle = this.seq;
    r.idleHidden = page.hidden;
    if (!page.shown || Math.max(r.want, this.lastNotice) <= Math.max(r.at, r.failed)) return false;
    r.from = ++this.seq;
    r.fromHidden = page.hidden;
    return true;
  }
}

/** The one-card reads (`deliverable`): every notice that touches it (change-notice.ts READS.deliverable). */
export const cardClock = new NoticeClock();
/** The index read (`deliverableIndex`): only the notices that touch it, never compared with the list. */
export const indexClock = new NoticeClock();

/** The cards whose read is wanted now (a press, or a mounted card that needs its whole), counted per id. */
const wanted = new Map<string, number>();
const wantedListeners = new Set<() => void>();
let wantedIds: string[] = [];
function emitWanted() {
  wantedIds = [...wanted.keys()];
  for (const l of wantedListeners) l();
}
export const wantedStore = {
  subscribe: (l: () => void) => {
    wantedListeners.add(l);
    return () => void wantedListeners.delete(l);
  },
  get: () => wantedIds,
};
export function want(id: string): () => void {
  wanted.set(id, (wanted.get(id) ?? 0) + 1);
  if (wanted.get(id) === 1) emitWanted();
  return () => {
    const n = (wanted.get(id) ?? 1) - 1;
    if (n > 0) wanted.set(id, n);
    else {
      wanted.delete(id);
      emitWanted();
    }
  };
}

// An opening of a card: a press on its opener, or a card first shown without one. A press holds the card's owner for a
// while, and the card that mounts from it takes that hold, so the press and the opening are one opening and one read.
const holds = new Map<string, { taken: boolean }>();
const showing = new Map<string, number>();

/** A press on a card's opener: an opening, unless the last press on it is still waiting for its card. */
export function pressOpen(id: string, holdMs: number, clock: NoticeClock = cardClock) {
  // a press on a card already shown (a double click, the picked row clicked again) opens nothing and holds nothing: a
  // hold left untaken would swallow the next real opening
  if (showing.has(id)) return;
  const last = holds.get(id);
  if (last && !last.taken) return;
  const hold = { taken: false };
  holds.set(id, hold);
  // its owner is mounted already (held by an earlier press): this press opens it again
  const again = wanted.has(id);
  const release = want(id);
  if (again) clock.open(id, false);
  setTimeout(() => {
    if (holds.get(id) === hold) holds.delete(id);
    release();
  }, holdMs);
}

/** A card shown: it wants its read while shown. The first card showing it opens it, unless a press already did. */
export function showCard(id: string, clock: NoticeClock = cardClock): () => void {
  const hold = holds.get(id);
  const first = (showing.get(id) ?? 0) === 0;
  showing.set(id, (showing.get(id) ?? 0) + 1);
  if (hold && !hold.taken) hold.taken = true;
  else if (first && wanted.has(id)) clock.open(id, false);
  const release = want(id);
  return () => {
    const n = (showing.get(id) ?? 1) - 1;
    if (n > 0) showing.set(id, n);
    else showing.delete(id);
    release();
  };
}

