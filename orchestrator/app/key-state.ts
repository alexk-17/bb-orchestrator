// What the keyboard shortcuts keep between key presses (module level, like store.ts: a tab switch loses nothing), and the
// views' handlers. app.tsx owns the one listener; each view registers what J/K/1-4/Enter/O/A mean in it.
import { createContext, useContext, useSyncExternalStore } from "react";
import type { Action, Arm } from "./keys.ts";

type Slice = { id: string | null; index: number };
export const keyState = {
  /** The selected card per pane and list, by selKey (each remembers its slot, so an answered card's slot is next). */
  sel: {} as Record<string, Slice>,
  /** Needs you: card id → the answer picked with a number key, waiting for Enter. */
  picked: new Map<string, string>(),
  arm: null as Arm,
  /** The line shown at the bottom of the page: the A hint, or why a key did nothing. */
  note: null as string | null,
  help: false,
};

let version = 0;
const listeners = new Set<() => void>();
export function emitKeys() {
  version++;
  for (const l of listeners) l();
}
export function useKeys(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => version,
  );
}

/** The pane a view is drawn in (its id), so its keys and selection are its own. */
export const PaneContext = createContext("");
export const usePaneId = () => useContext(PaneContext);
export const selKey = (pane: string, view: string) => `${pane}/${view}`;
export const selOf = (pane: string, view: string): Slice => (keyState.sel[selKey(pane, view)] ??= { id: null, index: 0 });

/** A view's answer to an action; true when it acted (the key is then swallowed). */
export type KeyHandler = (a: Action) => boolean;
const handlers = new Map<string, KeyHandler>();
export function registerKeys(pane: string, h: KeyHandler): () => void {
  handlers.set(pane, h);
  return () => {
    if (handlers.get(pane) === h) handlers.delete(pane);
  };
}
/** The focused pane's handler. */
export const handlerFor = (pane: string | undefined): KeyHandler | undefined => (pane ? handlers.get(pane) : undefined);

let noteTimer: ReturnType<typeof setTimeout> | undefined;
/** Say something at the bottom of the page for `ms`. */
export function say(text: string, ms = 2500) {
  keyState.note = text;
  emitKeys();
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    keyState.note = null;
    emitKeys();
  }, ms);
}

/** A closed pane's selections go with it. */
export function dropPane(pane: string) {
  for (const k of Object.keys(keyState.sel)) if (k.startsWith(`${pane}/`)) delete keyState.sel[k];
}
