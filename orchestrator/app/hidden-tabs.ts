// The page's tab strip under the owner's hiddenTabs setting (2026-11-17) and "hide until used" (2026-11-20), as data, so node --test checks it.

/** Hidden until used (the owner's card, 2026-11-20): each shows while its id is in `on` (a board, set up, or its setting on). */
export const UNTIL_USED: readonly string[] = ["multiplayer", "coderabbit", "gameboy", "cloud"];
/** Views with no tab of their own: shown only while a pane is on them (How it works, opened from the ? sheet). */
export const LINKED_ONLY: readonly string[] = ["how-it-works"];

/** Which of UNTIL_USED are in use, from the server's state and the owner's two Tools settings (config read). */
export function shownUntilUsed(u: { boards: number; queueSetUp: boolean; gameboy: boolean; cloud: boolean }): string[] {
  return [u.boards > 0 && "multiplayer", u.queueSetUp && "coderabbit", u.gameboy && "gameboy", u.cloud && "cloud"].filter((x): x is string => !!x);
}

/** The tabs shown: all but those hiddenTabs names (id or lower-cased label) and the unused; naming every other tab shows them all. */
export function shownTabs<V extends { id: string; label: string }>(views: readonly V[], hidden: ReadonlySet<string>, scopeWaiting: number, onPanes: ReadonlySet<string>, on: ReadonlySet<string> = new Set(), keep: ReadonlySet<string> = new Set()): readonly V[] {
  // `keep`: the four places (Home first, step 2), which hiddenTabs never hides
  const named = (v: V) => !keep.has(v.id) && (hidden.has(v.id) || hidden.has(v.label.toLowerCase()));
  const unused = (v: V) => (UNTIL_USED.includes(v.id) && !on.has(v.id)) || LINKED_ONLY.includes(v.id);
  // a link or a saved pane on an unused tab still opens it, unless the owner also hid it by name
  const reached = (v: V) => onPanes.has(v.id) && !named(v);
  const rest = views.filter((v) => !unused(v));
  if (rest.every(named)) return views.filter((v) => !unused(v) || reached(v));
  // 2026-11-17: a hidden Scope tab still shows while something waits in it (it waits nowhere else) or a pane is on it (a link, the last answer)
  return views.filter((v) => (unused(v) ? reached(v) : !named(v) || (v.id === "scope" && (scopeWaiting > 0 || onPanes.has("scope")))));
}
