// Folding the work board's columns (2026-11-24, the owner: "I don't need to see everything shipped"). Any column folds
// to its header, its name and count, and a click opens it again; Shipped starts folded. Each board (all projects, or one
// project's) keeps its own folds for the viewer, in the plugin with a copy in this browser for the first paint, as
// Projects keeps List or Board (view-pref.ts): once the plugin's read lands its word wins, unless the viewer changed
// something meanwhile. Every read and write of the copy is wrapped, and blocked or malformed storage means the default.
// A kept list is exactly what is folded, so a viewer who opens Shipped keeps it open. A folded column stays in its row
// and hands its width to the open ones there: one row of six, or three by two. The rules know nothing of the DOM, so
// node --test checks them.
import { useCallback, useRef, useState } from "react";
import { BOARD_COLUMNS, type BoardColumn } from "../contract.ts";
import { storage } from "./column-widths.ts";
import { foldWord, useViewPrefs } from "./view-pref.ts";

/** A board's key among the kept folds: "-" for every project (no slug starts with "-", as in the board's URL), else the slug. */
export const boardOf = (project: string | null) => project ?? "-";
/** Where this browser keeps its copy of a board's folds. */
export const foldCopyKey = (board: string) => `orchestrator.work-board.folded.v1:${board}`;
/** What a board the viewer never folded shows folded. */
export const FOLDED_FIRST: readonly BoardColumn[] = ["shipped"];

/** The columns this build knows in a kept list (an older or newer list may name others), in the board's order. */
export const foldsOf = (v: readonly unknown[]): Set<BoardColumn> => new Set(BOARD_COLUMNS.filter((c) => v.includes(c)));

/** This browser's copy of a board's folds; null when it holds none, or what it holds is malformed or blocked. */
export function loadFoldCopy(board: string, store: Pick<Storage, "getItem"> | null = storage()): Set<BoardColumn> | null {
  try {
    const raw = store?.getItem(foldCopyKey(board));
    if (raw == null) return null;
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? foldsOf(v) : null;
  } catch {
    return null;
  }
}

/** Keep the copy, none folded included: an empty list is the viewer opening them all. Blocked storage: the plugin's holds it. */
export function saveFoldCopy(board: string, folded: Set<BoardColumn>, store: Pick<Storage, "setItem"> | null = storage()) {
  try {
    store?.setItem(foldCopyKey(board), JSON.stringify(BOARD_COLUMNS.filter((c) => folded.has(c))));
  } catch {
    // blocked storage: the plugin's copy still holds it
  }
}

/**
 * A board's folded columns: the viewer's change made on this page; else the plugin's once its read is in (`server`
 * undefined until then, null when it holds none for this board); else this browser's copy; nothing anywhere: Shipped.
 */
export function resolveFolds(k: { mine: Set<BoardColumn> | undefined; server: readonly unknown[] | null | undefined; copy: Set<BoardColumn> | null }): Set<BoardColumn> {
  if (k.mine) return k.mine;
  if (k.server) return foldsOf(k.server);
  return k.copy ?? new Set(FOLDED_FIRST);
}

/**
 * The columns drawn folded: the kept folds, less any holding a picked count pill's cards while it is picked (the owner
 * picked those cards to see them: "7 shipped" with Shipped folded showed nothing). The kept folds don't change.
 */
export function drawnFolds(folded: Set<BoardColumn>, cols: readonly { column: BoardColumn; tasks: readonly unknown[] }[], picking: boolean): Set<BoardColumn> {
  if (!picking) return folded;
  return new Set([...folded].filter((c) => !cols.find((x) => x.column === c)?.tasks.length));
}

/** The columns in their rows: all six in one, or three by two. */
export function boardRows<T>(cols: readonly T[], layout: "six" | "three"): T[][] {
  return layout === "six" ? [[...cols]] : [cols.slice(0, 3), cols.slice(3)];
}

/** This board's folded columns, and a toggle that keeps the change (in the plugin and the copy); another board (the
 *  filter changed) has its own. */
export function useFolded(project: string | null) {
  const board = boardOf(project);
  const { prefs, own, keep } = useViewPrefs();
  const [mine, setMine] = useState<ReadonlyMap<string, Set<BoardColumn>>>(() => new Map());
  // each board's copy, read once
  const copies = useRef(new Map<string, Set<BoardColumn> | null>());
  if (!copies.current.has(board)) copies.current.set(board, loadFoldCopy(board));
  const server = foldWord(prefs, own, board);
  const folded = resolveFolds({ mine: mine.get(board), server, copy: copies.current.get(board) ?? null });
  const toggle = useCallback(
    (c: BoardColumn) => {
      const next = new Set(folded);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      setMine((m) => new Map(m).set(board, next));
      saveFoldCopy(board, next);
      keep({ board, folded: BOARD_COLUMNS.filter((x) => next.has(x)) });
    },
    [board, folded, keep],
  );
  return { folded, toggle };
}
