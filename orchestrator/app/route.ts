// What a pane shows (split panes, 2026-11-20); the focused pane's route is the URL's sub-path, so it links, reloads and undoes.

export type Route = {
  view: string;
  /** below the view: ["ledger-sync"] for projects/ledger-sync */
  path: string[];
  /** what else is worth restoring: Home's filter and item, an open scoping entry */
  params: Record<string, string>;
};
export type ViewPath = { id: string; subPath: string };

export const HOME_FILTERS = ["all", "needs", "delivered", "alerts"] as const;
/** Old tabs that are Home's filters now (their sub-paths stay valid links). */
const FOLDED_IN: Record<string, Record<string, string>> = { "needs-you": { filter: "needs" }, deliverables: { filter: "delivered" }, outputs: { filter: "delivered", files: "1" }, feed: {} };
/** Views that went into another, by old id (links, saved layouts): Agents, Outputs (2026-11-16); the Feed, Needs you and Deliverables are Home, Scope and Pathways are in Projects (2026-11-20). */
export const RENAMED_VIEWS: Record<string, string> = { agents: "projects", outputs: "home", feed: "home", "needs-you": "home", deliverables: "home", scope: "projects", pathways: "projects" };

export const rootOf = (view: string): Route => ({ view, path: [], params: {} });

// bb encodes our sub-path once more ("%3A" came back as "%253A", 2026-11-20), so decode until stable; keys never hold "%".
const dec = (s: string): string | null => {
  try {
    let d = s;
    for (let i = 0; i < 3 && /%[0-9a-fA-F]{2}/.test(d); i++) d = decodeURIComponent(d);
    return d;
  } catch {
    return null;
  }
};
const enc = encodeURIComponent;

/** The sub-path a route puts in the URL. Home on All with nothing open is the bare page. */
export function toPath(r: Route, views: readonly ViewPath[]): string {
  if (r.view === "home") {
    const f = r.params.filter ?? "all";
    if (f === "delivered" && r.params.files && !r.params.item) return "outputs";
    if (f === "all" && !r.params.item) return "";
    return `home/${f}${r.params.item ? `/${enc(r.params.item)}` : ""}`;
  }
  if (r.view === "projects") {
    if (r.params.scope) return `scope/${enc(r.params.scope)}`;
    if (r.params.open) return `projects/@${enc(r.params.open)}`;
    if (r.path[0]) return `${r.params.pathways ? "pathways" : "projects"}/${enc(r.path[0])}`;
  }
  const sub = views.find((v) => v.id === r.view)?.subPath ?? r.view;
  return r.path.length ? [sub, ...r.path.map(enc)].join("/") : sub;
}

/** The route a sub-path opens: its own view, a renamed one's successor, else Home on All. */
export function fromPath(subPath: string, views: readonly ViewPath[]): Route {
  const [head = "", ...rest] = subPath.split("/");
  const first = dec(head) ?? head;
  const one = rest[0] !== undefined && rest[0] !== "" ? dec(rest[0]) : null;
  if (first === "" || first === "home") {
    const f = (HOME_FILTERS as readonly string[]).includes(one ?? "") ? one! : "all";
    const item = rest[1] ? dec(rest[1]) : null;
    return { view: "home", path: [], params: { ...(f !== "all" ? { filter: f } : {}), ...(item ? { item } : {}) } };
  }
  if (Object.hasOwn(FOLDED_IN, first)) return { view: "home", path: [], params: { ...FOLDED_IN[first] } };
  if (first === "scope") {
    const key = rest.length ? dec(rest.join("/")) : null;
    return { view: "projects", path: [], params: key ? { scope: key } : {} };
  }
  if (first === "projects" && one?.startsWith("@")) return { view: "projects", path: [], params: one.length > 1 ? { open: one.slice(1) } : {} };
  if (first === "projects" || first === "pathways") return { view: "projects", path: one ? [one] : [], params: one && first === "pathways" ? { pathways: "1" } : {} };
  if (Object.hasOwn(RENAMED_VIEWS, first)) return rootOf(RENAMED_VIEWS[first]!);
  const v = views.find((x) => x.subPath === first && x.subPath !== "");
  if (!v) return rootOf("home");
  return { view: v.id, path: one ? [one] : [], params: {} };
}

/** Two routes are the same place when they write the same URL. */
export const samePlace = (a: Route, b: Route, views: readonly ViewPath[]) => toPath(a, views) === toPath(b, views);
/** A sub-path in the one spelling toPath writes, so links and our own URLs compare equal however they were encoded. */
export const canonical = (subPath: string, views: readonly ViewPath[]) => toPath(fromPath(subPath, views), views);
