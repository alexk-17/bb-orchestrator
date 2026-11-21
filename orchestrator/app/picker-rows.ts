// The view picker's rows and sizes (feel spec part 1, 2026-11-20): pure, so tests read them without a browser.
import type { ReactNode } from "react";
import type { Nav, NavLink } from "./nav.ts";

export type PickerRow = {
  /** The Sidebar's id: a view, or `home/<filter>` for one of Home's filters */
  id: string;
  label: string;
  icon?: ReactNode;
  /** What typing matches: the row's own words, and any extra ones (Reviews: "prs") */
  words: string[];
};
export type PickerRows = { main: PickerRow[]; tools: PickerRow[]; filters: PickerRow[] };
export type PickerMode = "split" | "change";

/** The picker's rows are the Sidebar's items, every one, in its order (the owner, 2026-11-20: "the tabs need to show up in
 * the tab view dropdown"): each place, Home's filters under Home, a place's sections in use under it, then all of Tools. */
export function pickerRowsOf(nav: Nav, icons: Record<string, ReactNode>, homeFilters: readonly NavLink[]): PickerRows {
  const main: PickerRow[] = [];
  for (const m of nav.main) {
    main.push({ id: m.id, label: m.label, icon: icons[m.id], words: m.id === "open-prs" ? [m.label, "prs", "open prs"] : [m.label] });
    // Home's own row is All; its other filters follow it, as in the Sidebar
    if (m.id === "home") for (const f of homeFilters.filter((f) => f.id !== "all")) main.push({ id: `home/${f.id}`, label: f.label, icon: icons.home, words: [f.label] });
    for (const s of [...m.subs, ...(nav.sections[m.id] ?? [])]) main.push({ id: s.id, label: s.label, icon: icons[m.id], words: [s.label] });
  }
  return {
    main,
    tools: nav.tools.map((t) => ({ id: t.id, label: t.label, words: t.id === "board" ? [t.label, "board"] : [t.label] })),
    filters: [],
  };
}

/** The rows that match `q`, in the Sidebar's order; Home's filters show only once something is typed. */
export function matching(rows: PickerRows, q: string): PickerRows {
  const s = q.trim().toLowerCase();
  if (!s) return { main: rows.main, tools: rows.tools, filters: [] };
  const hit = (r: PickerRow) => r.words.some((w) => w.toLowerCase().includes(s));
  return { main: rows.main.filter(hit), tools: rows.tools.filter(hit), filters: rows.filters.filter(hit) };
}
