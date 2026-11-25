// The viewer's view choices, kept by the plugin (2026-11-24, the owner: "The Projects view should remember whether you
// last picked Board or List", and the board's folded columns kept per viewer). Both live in the plugin's kv on the
// server, so a reload, another pane, a new window or another device on this bb opens on them; bb runs the plugin for one
// person, so that kv is the viewer's own. A copy in this browser's localStorage paints the first frame before the read
// lands; once it lands the plugin's word wins, unless the viewer changed something meanwhile. The plugin is written only
// when the viewer changes something. Every read and write of the copy is wrapped, and blocked storage only means waiting
// for the read. Nothing kept anywhere: List, and Shipped folded (board-fold.ts).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { PROJECTS_VIEWS, WRITES, rpcContract, type ProjectsViewPick, type ViewPrefBody, type ViewPrefs } from "../contract.ts";
import { storage } from "./column-widths.ts";
import { keepPref, type Outcome } from "./store.ts";

/** Which choice a save keeps: the List or Board pick, or one board's folds. */
export const prefKey = (b: ViewPrefBody) => ("projectsView" in b ? "view" : `folds:${b.board}`);

/**
 * The page's saves of view choices (2026-11-25, Codex's review):
 * - sent one after another in the order the viewer made them, so the server keeps them in that order and a later change
 *   never lands before an earlier one; a save that fails doesn't hold up the next;
 * - each is the page's own word for its choice until the plugin's shared read holds it. Once the server kept a save,
 *   a mounted read is refreshed, and the save then leaves the page's own words; with no read mounted (the viewer went
 *   elsewhere), the next read to mount is refreshed. So Projects left and opened again opens on the pick just made, not
 *   on a read from before it, and a change made elsewhere since still shows once the read is refreshed.
 */
export class PrefWrites {
  #chain: Promise<unknown> = Promise.resolve();
  readonly #post: (b: ViewPrefBody) => Promise<Outcome>;
  #own: ReadonlyMap<string, ViewPrefBody> = new Map();
  readonly #kept = new Set<ViewPrefBody>();
  readonly #heard = new Set<() => void>();
  readonly #reads = new Set<() => Promise<void>>();
  #rereads = 0;
  constructor(post: (b: ViewPrefBody) => Promise<Outcome>) {
    this.#post = post;
  }
  /** The page's own latest save of each choice the plugin's read doesn't hold yet. */
  own = (): ReadonlyMap<string, ViewPrefBody> => this.#own;
  subscribe = (heard: () => void): (() => void) => {
    this.#heard.add(heard);
    return () => void this.#heard.delete(heard);
  };
  keep(b: ViewPrefBody): Promise<Outcome> {
    this.#set(new Map(this.#own).set(prefKey(b), b));
    const sent = this.#chain.then(() => this.#post(b));
    this.#chain = sent.catch(() => undefined);
    void sent.then(
      (o) => this.#landed(b, o.ok),
      () => this.#landed(b, false),
    );
    return sent;
  }
  /** A mounted read of the choices, refreshed after each save the server kept; returns the way to unmount it. */
  mount(refetch: () => Promise<void>): () => void {
    this.#reads.add(refetch);
    if (this.#kept.size) void this.#reread();
    return () => void this.#reads.delete(refetch);
  }
  #landed(b: ViewPrefBody, ok: boolean) {
    if (ok) {
      this.#kept.add(b);
      void this.#reread();
    } else if (this.#own.get(prefKey(b)) === b) {
      const next = new Map(this.#own);
      next.delete(prefKey(b));
      this.#set(next);
    }
  }
  /**
   * Refresh the shared read, then leave to it the saves kept before the refresh began; a change made since stays. A
   * refresh begun later cancels this one's fetch, which then ends before the read holds anything new: only the latest
   * hands saves over, and it holds every save this one did.
   */
  async #reread() {
    const read = this.#reads.values().next().value;
    if (!read) return;
    const n = ++this.#rereads;
    const held = [...this.#kept];
    await read().catch(() => undefined);
    if (n !== this.#rereads) return;
    for (const b of held) this.#kept.delete(b);
    const next = new Map([...this.#own].filter(([, b]) => !held.includes(b)));
    if (next.size !== this.#own.size) this.#set(next);
  }
  #set(own: ReadonlyMap<string, ViewPrefBody>) {
    this.#own = own;
    for (const heard of this.#heard) heard();
  }
}
const writes = new PrefWrites((b) => keepPref(WRITES.viewPref, b));

/**
 * The kept List or Board Projects opens on: the page's own latest pick until the plugin's read holds it, else the
 * plugin's word, but never from a read that is being refreshed, as Projects opening again finds it: it may be from before
 * a pick made since. Undefined while there is no word yet; null when none is kept.
 */
export function viewWord(prefs: ViewPrefs | undefined, own: ReadonlyMap<string, ViewPrefBody>, fetching: boolean): ProjectsViewPick | null | undefined {
  const mine = own.get("view");
  if (mine && "projectsView" in mine) return mine.projectsView;
  return fetching || prefs === undefined ? undefined : prefs.projectsView;
}

/** One board's kept folds: the page's own latest until the plugin's read holds them, else the plugin's (undefined until
 *  its read lands, null when it holds none for this board). */
export function foldWord(prefs: ViewPrefs | undefined, own: ReadonlyMap<string, ViewPrefBody>, board: string): readonly string[] | null | undefined {
  const mine = own.get(`folds:${board}`);
  if (mine && "folded" in mine) return mine.folded;
  return prefs === undefined ? undefined : (prefs.boardFolds[board] ?? null);
}

/** The plugin's kept choices (undefined until the read lands; a read that failed is none kept), the page's own saves
 *  it doesn't hold yet, whether it is being refreshed, and the way to keep a change. Each change is sent once, as the
 *  viewer makes it, outside the write gate. */
export function useViewPrefs(): { prefs: ViewPrefs | undefined; own: ReadonlyMap<string, ViewPrefBody>; fetching: boolean; keep: (b: ViewPrefBody) => void } {
  const q = experimental_useRpcQuery({ contract: rpcContract, method: "viewPrefs", input: null });
  const own = useSyncExternalStore(writes.subscribe, writes.own, writes.own);
  const refetch = useRef(q.refetch);
  useEffect(() => {
    refetch.current = q.refetch;
  });
  useEffect(() => writes.mount(() => refetch.current()), []);
  const prefs = q.data ?? (q.error ? { projectsView: null, boardFolds: {} } : undefined);
  const keep = useCallback((b: ViewPrefBody) => void writes.keep(b), []);
  return { prefs, own, fetching: q.isFetching, keep };
}

/** This browser's copy of the List or Board pick. */
export const VIEW_COPY_KEY = "orchestrator.projects.view.v1";

const isPick = (v: unknown): v is ProjectsViewPick => typeof v === "string" && (PROJECTS_VIEWS as readonly string[]).includes(v);

export function loadViewCopy(store: Pick<Storage, "getItem"> | null = storage()): ProjectsViewPick | null {
  try {
    const v = store?.getItem(VIEW_COPY_KEY);
    return isPick(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveViewCopy(v: ProjectsViewPick, store: Pick<Storage, "setItem"> | null = storage()) {
  try {
    store?.setItem(VIEW_COPY_KEY, v);
  } catch {
    // blocked storage: the plugin's copy still holds it
  }
}

/**
 * Projects opening on the kept view: waiting for a word; opened on this browser's copy (and on which view); or done.
 * Done is for good: once the page settled, or the viewer picked, it never moves by itself again.
 */
export type Opening = "waiting" | "copy:list" | "copy:board" | "done";
/** Where the page is: the bare list, the board with no project filter and no card open, or anywhere else. */
export type OpenAt = "list" | "board" | "other";

/**
 * One step of opening: the next phase, and where to move, if anywhere. Only the bare list moves; a link that opened the
 * board, a project or an entry stays where it put the page. The first word decides: the plugin's once its read is in
 * (`server` undefined until then, null when it holds none), else this browser's copy; nothing anywhere is List. Opened
 * on the copy, the plugin's word wins when it lands, while the page is still where the copy put it.
 */
export function openStep(o: Opening, k: { server: ProjectsViewPick | null | undefined; copy: ProjectsViewPick | null }, at: OpenAt): { next: Opening; move: ProjectsViewPick | null } {
  if (o === "done") return { next: o, move: null };
  const settled = k.server !== undefined;
  const word = settled ? (k.server ?? k.copy ?? "list") : k.copy;
  if (o === "waiting") {
    if (at !== "list") return { next: "done", move: null };
    if (word === null) return { next: o, move: null };
    return { next: settled ? "done" : `copy:${word}`, move: word === "board" ? "board" : null };
  }
  if (!settled) return { next: o, move: null };
  const put = o === "copy:board" ? "board" : "list";
  return { next: "done", move: at === put && word !== put ? word : null };
}

/** The save a pick needs: none when it is the kept word already, the page's own pick still pending or the plugin's
 *  (2026-11-25, Codex's review: a click on the view already kept wrote it again). */
export function pickSave(v: ProjectsViewPick, word: ProjectsViewPick | null | undefined): ViewPrefBody | null {
  return word === v ? null : { projectsView: v };
}

/** Projects' kept view: the plugin's word and this browser's copy, and the toggle's way to keep a pick (both). */
export function useProjectsView() {
  const { prefs, own, fetching, keep } = useViewPrefs();
  const [copy] = useState(loadViewCopy);
  const server = viewWord(prefs, own, fetching);
  const pick = useCallback(
    (v: ProjectsViewPick) => {
      saveViewCopy(v);
      const save = pickSave(v, server);
      if (save) keep(save);
    },
    [keep, server],
  );
  return { server, copy, pick };
}
