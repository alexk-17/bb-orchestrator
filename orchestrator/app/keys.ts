// The orchestrator page's keyboard shortcuts, as pure functions (no React, no DOM), so the rules are tested in node.
// Requested 2026-11-16 for a macropad that can only send key combos. The rules:
// - single keys do nothing while a text box, textarea, menu or select has focus (⌘/Ctrl+Enter stays with the boxes);
// - a key with ⌘, Ctrl or Alt held is never ours;
// - a key held down (repeat) never acts, so a held A cannot approve;
// - A approves only on a second press, on the same deliverable, within APPROVE_MS.

export const APPROVE_MS = 2000;

export type Action =
  | { t: "move"; dir: 1 | -1 }
  | { t: "pick"; n: number }
  | { t: "send" }
  | { t: "open" }
  | { t: "approve" }
  | { t: "cos" }
  | { t: "tab"; view: string }
  | { t: "pane"; dir: 1 | -1 }
  | { t: "split"; dir: "row" | "col" }
  | { t: "help" }
  | { t: "close" }
  | { t: "blur" };

export type KeyLike = { key: string; code?: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; repeat?: boolean; isComposing?: boolean };
/** What the key was pressed on: the bits `where` reads, so a test can pass a plain object. */
export type TargetLike = { tagName?: string; type?: string; isContentEditable?: boolean; role?: string | null; insideRole?: string | null; leave?: boolean } | null;

/** The shift+letter tab keys, by physical key so Caps Lock and layouts don't matter. */
export const TAB_KEYS: Record<string, string> = { KeyN: "needs-you", KeyP: "projects", KeyD: "deliverables", KeyH: "chat" };

export type Where = "text" | "control" | "menu" | "other";

/** `text`: typing goes here, so single keys are not ours. `menu`: a menu or listbox with its own keys. `control`: a button or link, which Enter activates itself. */
export function where(t: TargetLike): Where {
  if (!t) return "other";
  const tag = (t.tagName ?? "").toUpperCase();
  const role = t.role ?? "";
  if (t.isContentEditable || tag === "TEXTAREA" || tag === "SELECT" || role === "textbox" || role === "combobox" || role === "searchbox") return "text";
  if (tag === "INPUT") return ["button", "submit", "reset", "checkbox", "radio", "image"].includes((t.type ?? "text").toLowerCase()) ? "control" : "text";
  const inside = t.insideRole ?? "";
  if (role === "menu" || role === "menuitem" || role === "listbox" || role === "option" || inside === "menu" || inside === "listbox") return "menu";
  if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY" || role === "button" || role === "link") return "control";
  return "other";
}

/** The action for a key press, or null when it isn't ours. `helpOpen`: only Esc and ? work then. */
export function decide(e: KeyLike, target: TargetLike, helpOpen = false): Action | null {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key === "Escape") {
    if (helpOpen) return { t: "close" };
    return target?.leave ? { t: "blur" } : null; // Esc leaves a text box (the text stays), so the pad's keys work again; bb's own chat box takes focus on the Chat tab
  }
  const at = where(target);
  if (at === "text" || at === "menu") return null;
  if (e.repeat) return null;
  if (e.key === "?") return { t: "help" };
  if (helpOpen) return null;
  if (e.shiftKey) {
    const view = e.code ? TAB_KEYS[e.code] : undefined;
    return view ? { t: "tab", view } : null;
  }
  switch (e.key.toLowerCase()) {
    case "j":
      return { t: "move", dir: 1 };
    case "k":
      return { t: "move", dir: -1 };
    case "1":
    case "2":
    case "3":
    case "4":
      return { t: "pick", n: Number(e.key) };
    case "enter":
      return at === "control" ? null : { t: "send" };
    case "o":
      return { t: "open" };
    case "a":
      return { t: "approve" };
    case "c":
      return { t: "cos" };
    // the panes (split panes, 2026-11-20): bare keys like J/K; bb's own pane commands take a modifier
    case "[":
      return { t: "pane", dir: -1 };
    case "]":
      return { t: "pane", dir: 1 };
    case "\\":
      return { t: "split", dir: "row" };
    case "-":
      return { t: "split", dir: "col" };
    default:
      return null;
  }
}

/**
 * The selection after the list changes: the same id when it is still drawn; else the slot it was in (an answered card
 * is replaced by the next one, so the next key press lands on that); else nothing.
 */
export function resolveSelection(ids: readonly string[], id: string | null, index: number): { id: string | null; index: number } {
  if (ids.length === 0) return { id: null, index: 0 };
  if (id === null) return { id: null, index: 0 };
  const at = ids.indexOf(id);
  if (at >= 0) return { id, index: at };
  const slot = Math.min(Math.max(index, 0), ids.length - 1);
  return { id: ids[slot]!, index: slot };
}

/** J/K from the selection: nothing selected → first (J) or last (K); the ends hold, they don't wrap. */
export function step(ids: readonly string[], id: string | null, dir: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const at = id === null ? -1 : ids.indexOf(id);
  if (at < 0) return dir === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[Math.min(Math.max(at + dir, 0), ids.length - 1)]!;
}

export type Arm = { id: string; at: number } | null;
/** A press of A on `id` at `now`: fire only when the same id was armed less than APPROVE_MS ago. */
export function pressApprove(arm: Arm, id: string, now: number): { fire: boolean; arm: Arm } {
  if (arm && arm.id === id && now - arm.at <= APPROVE_MS) return { fire: true, arm: null };
  return { fire: false, arm: { id, at: now } };
}

/** The cheat sheet, also the source for KEYMAP.md. `view`: where it works. */
export const KEYMAP: { keys: string; does: string; where: string }[] = [
  { keys: "J / K", does: "Next / previous card", where: "Home: Needs you, Delivered" },
  { keys: "1 – 4", does: "Pick answer N on the selected card (Enter sends it)", where: "Home: Needs you" },
  { keys: "Enter", does: "Send the picked answer", where: "Home: Needs you" },
  { keys: "O", does: "Open the selected card's asker thread", where: "Home: Needs you" },
  { keys: "A  A", does: "Done, nothing more: press twice within 2 s", where: "Home: Delivered" },
  { keys: "C", does: "Focus the Chief of Staff box", where: "anywhere" },
  { keys: "Shift+N / P / D / H", does: "Needs you / Projects / Delivered / Chat", where: "anywhere" },
  { keys: "[ / ]", does: "Previous / next pane", where: "two panes or more" },
  { keys: "\\ / -", does: "Split the pane right / down, then pick its view", where: "web" },
  { keys: "?", does: "This cheat sheet", where: "anywhere" },
  { keys: "Esc", does: "Close the cheat sheet; in a text box, leave it (text kept)", where: "cheat sheet, text boxes" },
];
