import { useCallback, useRef, useState } from "react";
import { BOARD_COLUMNS, type BoardColumn } from "../contract.ts";
import { storage } from "./column-widths.ts";
import { foldWord, useViewPrefs } from "./view-pref.ts";

export const boardOf = (project: string | null) => project ?? "-";
export const foldCopyKey = (board: string) => `orchestrator.work-board.folded.v1:${board}`;
export const FOLDED_FIRST: readonly BoardColumn[] = ["shipped"];

export const foldsOf = (v: readonly unknown[]): Set<BoardColumn> => new Set(BOARD_COLUMNS.filter((c) => v.includes(c)));

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

export function saveFoldCopy(board: string, folded: Set<BoardColumn>, store: Pick<Storage, "setItem"> | null = storage()) {
  try {
    store?.setItem(foldCopyKey(board), JSON.stringify(BOARD_COLUMNS.filter((c) => folded.has(c))));
  } catch {
    // blocked storage: the plugin's copy still holds it
  }
}

export function resolveFolds(k: { mine: Set<BoardColumn> | undefined; server: readonly unknown[] | null | undefined; copy: Set<BoardColumn> | null }): Set<BoardColumn> {
  if (k.mine) return k.mine;
  if (k.server) return foldsOf(k.server);
  return k.copy ?? new Set(FOLDED_FIRST);
}

export function drawnFolds(folded: Set<BoardColumn>, cols: readonly { column: BoardColumn; tasks: readonly unknown[] }[], picking: boolean): Set<BoardColumn> {
  if (!picking) return folded;
  return new Set([...folded].filter((c) => !cols.find((x) => x.column === c)?.tasks.length));
}

export function boardRows<T>(cols: readonly T[], layout: "six" | "three"): T[][] {
  return layout === "six" ? [[...cols]] : [cols.slice(0, 3), cols.slice(3)];
}

export function useFolded(project: string | null) {
  const board = boardOf(project);
  const { prefs, own, keep } = useViewPrefs();
  const [mine, setMine] = useState<ReadonlyMap<string, Set<BoardColumn>>>(() => new Map());
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
