// The page's navigation as data (Home first, step 2, 2026-11-20): the Sidebar on web, the bottom bar and ⚙ Tools on a phone.
import type { FeedFilter } from "./feed.tsx";
import { UNTIL_USED } from "./hidden-tabs.ts";

export type NavLink = { id: string; label: string };
export type NavMain = NavLink & { subs: NavLink[] };
export type Nav = { main: NavMain[]; tools: NavLink[]; sections: Record<string, NavLink[]> };

/** The four places: never hidden by hiddenTabs, and the phone's bottom bar. */
export const MAIN: readonly NavLink[] = [
  { id: "home", label: "Home" },
  { id: "chat", label: "Chat" },
  { id: "projects", label: "Projects" },
  { id: "open-prs", label: "Reviews" },
];
/** Pages that sit under a place until step 3 folds them in: none left (Scope and Pathways are in Projects' page). */
export const SUBS: Readonly<Record<string, readonly string[]>> = {};
/** Pages drawn as a section of a place (step 3): its own page stays, for links and Set up, but the nav doesn't list it. */
export const SECTIONS: Readonly<Record<string, string>> = { multiplayer: "open-prs", coderabbit: "open-prs" };
export const TOOLS: readonly string[] = ["rules", "board", "cloud", "gameboy"];
export const HOW_IT_WORKS: NavLink = { id: "how-it-works", label: "How it works" };
export const SET_UP: Readonly<Record<string, string>> = { multiplayer: "Set up Multiplayer", coderabbit: "Set up CodeRabbit" };

/** The nav the page draws, from the views it may show (shownTabs) and which hidden-until-used ones are in use. */
export function navOf(visible: readonly NavLink[], inUse: ReadonlySet<string>): Nav {
  const label = new Map(visible.map((v) => [v.id, v.label] as const));
  const shown = (id: string) => label.has(id) && (!UNTIL_USED.includes(id) || inUse.has(id));
  const main = MAIN.map((m) => ({ ...m, subs: (SUBS[m.id] ?? []).filter(shown).map((id) => ({ id, label: label.get(id)! })) }));
  const setUp = Object.keys(SET_UP).filter((id) => !inUse.has(id)).map((id) => ({ id, label: SET_UP[id]! }));
  const tools = [...TOOLS.filter(shown).map((id) => ({ id, label: label.get(id)! })), HOW_IT_WORKS, ...setUp];
  // 2026-11-20 (the owner, "Left nav only"): a section in use is also its own item under its place in the web Sidebar
  const sections: Record<string, NavLink[]> = {};
  for (const [id, place] of Object.entries(SECTIONS)) if (shown(id)) (sections[place] ??= []).push({ id, label: label.get(id)! });
  return { main, tools, sections };
}

/** The place a view belongs to, for the bottom bar's and the sidebar's active item. */
export function placeOf(view: string): string {
  if (MAIN.some((m) => m.id === view)) return view;
  if (Object.values(FOLDED).includes(view)) return "home";
  if (Object.hasOwn(SECTIONS, view)) return SECTIONS[view]!;
  return Object.entries(SUBS).find(([, subs]) => subs.includes(view))?.[0] ?? "tools";
}

/** Home's filters that took over a whole tab (step 3): the old tab's sub-path, whose keys and links they keep. */
export const FOLDED: Readonly<Partial<Record<FeedFilter, string>>> = { needs: "needs-you", delivered: "deliverables" };
const FOLDED_PATHS: Readonly<Record<string, FeedFilter>> = { ...Object.fromEntries(Object.entries(FOLDED).map(([f, path]) => [path, f as FeedFilter])), outputs: "delivered" };

/** The Home filter an old tab's sub-path (or a Shift key's tab) now opens, else null. */
export function filterOfPath(subPath: string): FeedFilter | null {
  return FOLDED_PATHS[subPath.split("/")[0] ?? ""] ?? null;
}
