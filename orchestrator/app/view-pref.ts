import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { PROJECTS_VIEWS, WRITES, rpcContract, type ProjectsViewPick, type ViewPrefBody, type ViewPrefs } from "../contract.ts";
import { storage } from "./column-widths.ts";
import { keepPref, type Outcome } from "./store.ts";

export const prefKey = (b: ViewPrefBody) => ("projectsView" in b ? "view" : `folds:${b.board}`);

const revOf = (result: unknown): number | null => {
  const rev = (result as { rev?: unknown } | null | undefined)?.rev;
  return typeof rev === "number" ? rev : null;
};

/** Saves are sent one after another in the order made, so a later change never lands before an earlier one. */
export class PrefWrites {
  #chain: Promise<unknown> = Promise.resolve();
  readonly #post: (b: ViewPrefBody) => Promise<Outcome>;
  #own: ReadonlyMap<string, ViewPrefBody> = new Map();
  readonly #landed = new Map<ViewPrefBody, number>();
  #rev = 0;
  #top = 0;
  readonly #heard = new Set<() => void>();
  readonly #reads = new Set<() => Promise<void>>();
  constructor(post: (b: ViewPrefBody) => Promise<Outcome>) {
    this.#post = post;
  }
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
      (o) => this.#answered(b, o),
      () => this.#answered(b, null),
    );
    return sent;
  }
  mount(refetch: () => Promise<void>): () => void {
    this.#reads.add(refetch);
    if (this.#landed.size) void refetch().catch(() => undefined);
    return () => void this.#reads.delete(refetch);
  }
  // a pick stays the page's own until a read holds its save's revision (none answered: one past the newest the page has read)
  read(rev: number | undefined) {
    this.#rev = rev ?? 0;
    this.#top = Math.max(this.#top, this.#rev);
    const next = new Map(this.#own);
    for (const [b, saved] of this.#landed) {
      if (this.#rev < saved) continue;
      this.#landed.delete(b);
      if (next.get(prefKey(b)) === b) next.delete(prefKey(b));
    }
    if (next.size !== this.#own.size) this.#set(next);
  }
  #answered(b: ViewPrefBody, o: Outcome | null) {
    if (o?.ok) {
      this.#landed.set(b, revOf(o.result) ?? this.#top + 1);
      this.read(this.#rev);
      const refetch = this.#reads.values().next().value;
      if (refetch) void refetch().catch(() => undefined);
    } else if (this.#own.get(prefKey(b)) === b) {
      const next = new Map(this.#own);
      next.delete(prefKey(b));
      this.#set(next);
    }
  }
  #set(own: ReadonlyMap<string, ViewPrefBody>) {
    this.#own = own;
    for (const heard of this.#heard) heard();
  }
}
const writes = new PrefWrites((b) => keepPref(WRITES.viewPref, b));

/** Never from a read being refreshed: it may predate a pick made since. */
export function viewWord(prefs: ViewPrefs | undefined, own: ReadonlyMap<string, ViewPrefBody>, fetching: boolean): ProjectsViewPick | null | undefined {
  const mine = own.get("view");
  if (mine && "projectsView" in mine) return mine.projectsView;
  return fetching || prefs === undefined ? undefined : prefs.projectsView;
}

export function foldWord(prefs: ViewPrefs | undefined, own: ReadonlyMap<string, ViewPrefBody>, board: string): readonly string[] | null | undefined {
  const mine = own.get(`folds:${board}`);
  if (mine && "folded" in mine) return mine.folded;
  return prefs === undefined ? undefined : (prefs.boardFolds[board] ?? null);
}

export function useViewPrefs(): { prefs: ViewPrefs | undefined; own: ReadonlyMap<string, ViewPrefBody>; fetching: boolean; keep: (b: ViewPrefBody) => void } {
  const q = experimental_useRpcQuery({ contract: rpcContract, method: "viewPrefs", input: null });
  const own = useSyncExternalStore(writes.subscribe, writes.own, writes.own);
  const refetch = useRef(q.refetch);
  useEffect(() => {
    refetch.current = q.refetch;
  });
  useEffect(() => writes.mount(() => refetch.current()), []);
  useEffect(() => {
    // the SDK hands the read over unparsed: a server that stamps no revision sends none
    if (q.data) writes.read(q.data.rev);
  }, [q.data]);
  const prefs = q.data ?? (q.error ? { projectsView: null, boardFolds: {}, rev: 0 } : undefined);
  const keep = useCallback((b: ViewPrefBody) => void writes.keep(b), []);
  return { prefs, own, fetching: q.isFetching, keep };
}

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

export type Opening = "waiting" | "copy:list" | "copy:board" | "done";
export type OpenAt = "list" | "board" | "other";

/** Only the bare list moves; a link that opened the board, a project or an entry stays where it put the page. */
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

export function pickSave(v: ProjectsViewPick, word: ProjectsViewPick | null | undefined): ViewPrefBody | null {
  return word === v ? null : { projectsView: v };
}

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
