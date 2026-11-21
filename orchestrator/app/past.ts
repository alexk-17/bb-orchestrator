// The Deliverables tab's model, as pure functions (no React), so its promises are tested in node. Requested 2026-11-16:
// "combine the deliverables and outputs tab into one so people can go look back and see past deliverables easily".
// 2026-11-17, the owner: the project, deliverable and files tree was "really hard to navigate"; every deliverable keeps
// its own folder of files (core/deliverable-files.ts), sorted into artifacts, images and videos, to reach "within that
// folder structure as well as alongside the deliverables as full items". So:
// - What waits for the owner (in review) is always first, newest first, as cards; filters and search never touch it.
// - Below, the past deliverables (approved, changes requested, withdrawn), newest first. Selecting one shows it with its
//   files.
// - Files: every file across deliverables (their folders' files, in review too) and the outputs that are no
//   deliverable's file, newest first, by kind: artifacts, images, videos, or all.
// - 2026-11-18, the owner: "we should still solve folders for the different projects". Under All projects, both lists are
//   grouped by project again, one level only: a folder per project, in the sidebar's order, holding its deliverables or
//   files (rowsOf). One project picked: its rows alone, no folder.
// - An output naming a deliverable's file (its copy, or the original it was copied from) is that file's output; every
//   other output is loose, in Files. No output is dropped, none is listed twice.
// - Projects (the filter) come in the sidebar's section order (core/project-order.ts).
import type { DeliverableFolders, Deliverables, Outputs, ProjectOrder } from "../contract.ts";
import { fileKind, type FileKind } from "../core/file-kind.ts";

type Deliverable = Deliverables[number];
type Output = Outputs[number];
type Proof = Deliverable["revisions"][number]["proof"][number];
type Folder = DeliverableFolders["folders"][string];

export type Filter = "all" | "decided" | "approved" | "changes" | "withdrawn" | "files";
export const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "decided", label: "Decided" },
  { id: "approved", label: "Approved" },
  { id: "changes", label: "Changes requested" },
  { id: "withdrawn", label: "Withdrawn" },
  { id: "files", label: "Files" },
];
export type KindFilter = FileKind | "all";
export const KINDS: { id: KindFilter; label: string }[] = [
  { id: "artifacts", label: "Artifacts" },
  { id: "images", label: "Images" },
  { id: "videos", label: "Videos" },
  { id: "all", label: "All" },
];
/** The project filter's "every project"; "" is the no-project group. */
export const ALL_PROJECTS = "*";
const projectKey = (p: string | null) => p ?? "";

/**
 * One file as the tab shows it: a file in a deliverable's folder, a proof file of one outside it (over the copy cap,
 * already missing, or filed before folders), or a loose output. `proof`: what the proof route serves it by; `output`:
 * its record (Remove).
 */
export type FileItem = {
  key: string;
  kind: FileKind;
  name: string;
  path: string | null;
  url: string | null;
  bytes: number | null;
  at: number;
  caption: string | null;
  d: Deliverable | null;
  proof: Proof | null;
  output: Output | null;
  project: string | null;
  missing: boolean;
  dir: boolean;
};

/** The revision a deliverable shows: its current one, else its last. */
export const shownRevision = (d: Deliverable) => d.revisions.find((r) => r.rev === d.rev) ?? d.revisions[d.revisions.length - 1];

const byUpdated = (a: Deliverable, b: Deliverable) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1);
const byAt = (a: FileItem, b: FileItem) => b.at - a.at || (a.key < b.key ? 1 : -1);
const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const atOf = (iso: string | undefined, fallback: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? fallback : t;
};

/**
 * A deliverable's files: its folder's (each with the newest proof that shows it), then the file proof that isn't in the
 * folder (over the copy cap, a failed copy, already missing, or filed before it had one). Links and PRs aren't files.
 */
export function filesOf(d: Deliverable, folder: Folder | undefined): FileItem[] {
  const newestFirst = [...d.revisions].sort((a, b) => b.rev - a.rev);
  const proofAt = new Map<string, { p: Proof; at: number }>();
  for (const r of newestFirst) for (const p of r.proof) if (p.path && !proofAt.has(p.path)) proofAt.set(p.path, { p, at: atOf(r.at, d.updatedAt) });
  const out: FileItem[] = [];
  const seen = new Set<string>();
  // a file's date is when it was delivered, not when it was copied (2026-11-17: the backfill copied every earlier file
  // at once, so the copy time would date them all alike): proof takes its revision's time, any other file the
  // deliverable's, unless it arrived earlier than that
  for (const f of folder?.files ?? []) {
    seen.add(f.path);
    const shows = proofAt.get(f.path);
    out.push(item(d, f.kind, f.name, f.path, f.bytes, shows?.at ?? Math.min(f.at, d.updatedAt), shows?.p ?? null, false, f.dir));
  }
  for (const [path, { p, at }] of proofAt) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(item(d, fileKind(p.source ?? path), base(p.source ?? path), path, p.bytes ?? null, at, p, p.stored === "missing", false));
  }
  // the shown revision's proof first, in the lead's order (the screenshot they put first leads), then the rest by name
  const shown = new Map((shownRevision(d)?.proof ?? []).map((p, i) => [p.path, i] as const));
  const rank = (f: FileItem) => shown.get(f.path) ?? Infinity;
  return out.sort((a, b) => rank(a) - rank(b));
}

/**
 * Which file the proof route serves for an item: its proof's (an image, video or text proof), else (2026-11-17) its
 * recorded output's, when engine.outputFile would serve it: an image or video by extension, never SVG, or .txt/.log.
 * Before, only proof was served, and a third of the Files view's image tiles were blank: they were outputs.
 */
export function servedBy(f: FileItem): { proof?: string; output?: string } | null {
  if (f.missing || !f.path) return null;
  if (f.proof) return f.proof.kind === "image" || f.proof.kind === "video" || f.proof.kind === "text" ? { proof: f.proof.id } : null;
  const path = f.output?.path?.toLowerCase();
  if (!path || path.endsWith(".svg") || (f.kind === "artifacts" && !path.endsWith(".txt") && !path.endsWith(".log"))) return null;
  return { output: f.output!.id };
}

function item(d: Deliverable, kind: FileKind, name: string, path: string, bytes: number | null, at: number, p: Proof | null, missing: boolean, dir: boolean): FileItem {
  return { key: `f:${d.id}:${path}`, kind, name, path, url: null, bytes, at, caption: p?.caption ?? null, d, proof: p, output: null, project: d.project, missing, dir };
}

function looseItem(o: Output): FileItem {
  return {
    key: `o:${o.id}`,
    kind: o.path ? fileKind(o.path) : o.kind === "image" ? "images" : o.kind === "video" ? "videos" : "artifacts",
    name: o.title,
    path: o.path,
    url: o.url,
    bytes: null,
    at: o.at,
    caption: o.note,
    d: null,
    proof: null,
    output: o,
    project: o.project,
    missing: o.gone, // 2026-11-18: a loose output whose file is gone says "Missing", as a proof file does
    dir: false,
  };
}

/**
 * Every deliverable's files, and each output either on the file it names (same project; the file's path, or its
 * proof's copy or original) or loose. An output naming two files goes to the newest deliverable's.
 */
export function fileItems(ds: readonly Deliverable[], os: readonly Output[], folders: DeliverableFolders["folders"] = {}): { items: FileItem[]; loose: FileItem[] } {
  const items = [...ds].sort(byUpdated).flatMap((d) => filesOf(d, folders[d.id]));
  const named = new Map<string, FileItem>();
  for (const it of items)
    for (const where of [it.path, it.proof?.path, it.proof?.source]) {
      const k = `${projectKey(it.project)}\0${where}`;
      if (where && !named.has(k)) named.set(k, it);
    }
  const loose: FileItem[] = [];
  for (const o of os) {
    const where = o.path ?? o.url;
    const hit = where ? named.get(`${projectKey(o.project)}\0${where}`) : undefined;
    if (hit && !hit.output) hit.output = o;
    else loose.push(looseItem(o));
  }
  return { items, loose };
}

/**
 * The in-review cards' outputs: each output that is a proof item on a card's shown revision (same project, same file,
 * its original, or link). Paths are realpaths and links normalised on both sides (engine.ts), so equal strings are one file.
 */
export function fold(ds: readonly Deliverable[], os: readonly Output[]): { byProof: Map<string, Output>; byDeliverable: Map<string, Output[]>; loose: Output[] } {
  const owner = new Map<string, { d: string; proof: string }>();
  for (const d of [...ds].sort(byUpdated)) {
    for (const p of shownRevision(d)?.proof ?? []) {
      // a copied file (2026-11-17) is its output by its original path too
      for (const where of [p.path ?? p.url, p.source]) {
        const k = `${projectKey(d.project)}\0${where}`;
        if (where && !owner.has(k)) owner.set(k, { d: d.id, proof: p.id });
      }
    }
  }
  const byProof = new Map<string, Output>();
  const byDeliverable = new Map<string, Output[]>();
  const loose: Output[] = [];
  for (const o of os) {
    const where = o.path ?? o.url;
    const hit = where ? owner.get(`${projectKey(o.project)}\0${where}`) : undefined;
    if (hit && !byProof.has(hit.proof)) {
      byProof.set(hit.proof, o);
      byDeliverable.set(hit.d, [...(byDeliverable.get(hit.d) ?? []), o]);
    } else loose.push(o);
  }
  return { byProof, byDeliverable, loose };
}

/** Every word of the query, in any order and case, somewhere in the text. */
function matches(text: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = text.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** What search reads on a deliverable: its title, every revision's summary, and its points (headline and why). */
export const deliverableText = (d: Deliverable) =>
  [d.title, d.summary, ...d.revisions.flatMap((r) => [r.summary, ...r.points.flatMap((p) => [p.headline, p.why])])].join("\n");
/** What search reads on a file: its name, caption, its deliverable's title, and its output's title, note and link. */
export const fileText = (f: FileItem) => [f.name, f.caption ?? "", f.d?.title ?? "", f.output?.title ?? "", f.output?.note ?? "", f.path ?? "", f.url ?? ""].join("\n");

export type View = { filter: Filter; project: string; query: string; kind: KindFilter };
export const START: View = { filter: "all", project: ALL_PROJECTS, query: "", kind: "all" };
/** A filter or a search narrows the list. */
export const narrowed = (v: View) => v.filter !== "all" || v.project !== ALL_PROJECTS || v.query.trim() !== "";

export type Tab = {
  /** In review, newest first, with the outputs that are their proof: the cards on top. */
  review: { d: Deliverable; outputs: Output[] }[];
  /** Past deliverables under the filter, project and search, newest first. */
  past: Deliverable[];
  /** Files under the project, search and kind, newest first (filled under any filter, so its counts are always true). */
  files: FileItem[];
  /** Every deliverable's files, by id (each deliverable has an entry): what a selected deliverable shows. */
  filesBy: Map<string, FileItem[]>;
  /** Per filter, how many match the project and search. */
  counts: Record<Filter, number>;
  /** Per kind, how many files match the project and search. */
  kinds: Record<KindFilter, number>;
  /** Every project with a past deliverable or a file, in the sidebar's order; null is "No project". */
  projects: (string | null)[];
  /** Every deliverable's project, by id: the folder a revealed deliverable is in. */
  projectOf: Map<string, string | null>;
};

/**
 * The tab. `order`: the sidebar's project order; a project it doesn't name (a deleted one) comes after, by name, and
 * "No project" last. `folders`: the deliverables' folders as listed (empty while that read loads: proof files then).
 */
export function deliverablesTab(ds: readonly Deliverable[], os: readonly Output[], v: View, order: ProjectOrder = [], folders: DeliverableFolders["folders"] = {}): Tab {
  const { byDeliverable } = fold(ds, os);
  const sorted = [...ds].sort(byUpdated);
  const review = sorted.filter((d) => d.state === "review").map((d) => ({ d, outputs: byDeliverable.get(d.id) ?? [] }));
  const inProject = (p: string | null) => v.project === ALL_PROJECTS || projectKey(p) === v.project;
  const allPast = sorted.filter((d) => d.state !== "review");
  const pastHits = allPast.filter((d) => inProject(d.project) && matches(deliverableText(d), v.query));
  const { items, loose } = fileItems(ds, os, folders);
  const allFiles = [...items, ...loose].sort(byAt);
  const fileHits = allFiles.filter((f) => inProject(f.project) && matches(fileText(f), v.query));
  const counts: Record<Filter, number> = {
    all: pastHits.length,
    decided: pastHits.filter((d) => d.state === "approved" || d.state === "changes").length,
    approved: pastHits.filter((d) => d.state === "approved").length,
    changes: pastHits.filter((d) => d.state === "changes").length,
    withdrawn: pastHits.filter((d) => d.state === "withdrawn").length,
    files: fileHits.length,
  };
  const kinds: Record<KindFilter, number> = { all: fileHits.length, artifacts: 0, images: 0, videos: 0 };
  for (const f of fileHits) kinds[f.kind]++;
  const filesBy = new Map<string, FileItem[]>(ds.map((d) => [d.id, []]));
  for (const f of items) if (f.d) filesBy.get(f.d.id)!.push(f);

  const rank = new Map(order.map((p, i) => [p.slug, i] as const));
  const place = (p: string | null) => (p === null ? [2, 0, ""] : rank.has(p) ? [0, rank.get(p)!, ""] : [1, 0, p]) as [number, number, string];
  const projects = [...new Set([...allPast.map((d) => d.project), ...allFiles.map((f) => f.project)])].sort((a, b) => {
    const [x, y] = [place(a), place(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]);
  });
  return {
    review,
    past: v.filter === "files" ? [] : pastHits.filter((d) => v.filter === "all" || d.state === v.filter || (v.filter === "decided" && (d.state === "approved" || d.state === "changes"))),
    files: fileHits.filter((f) => v.kind === "all" || f.kind === v.kind),
    filesBy,
    counts,
    kinds,
    projects,
    projectOf: new Map(ds.map((d) => [d.id, d.project])),
  };
}

export type Node = { t: "project"; key: string; project: string | null; count: number } | { t: "deliverable"; key: string; d: Deliverable } | { t: "file"; key: string; f: FileItem };
export type Row = { node: Node; level: number; parent: string | null; open: boolean | null };

/** A project folder's key: `p:` and its slug; `p:` alone is No project. */
export const folderKey = (p: string | null) => `p:${projectKey(p)}`;

/**
 * The rows drawn, top to bottom: the Files filter's files, else the past deliverables. Under All projects (2026-11-18),
 * a folder row per project with any (level 0, its count after the filters, in `tab.projects` order), then, while it is
 * open (`isFolderOpen`, open unless the viewer closed it), its rows newest first at level 1. One project picked: its rows
 * at level 0, no folder. `open` is null on a file.
 */
export function rowsOf(tab: Tab, v: View, isOpen: (d: Deliverable) => boolean, isFolderOpen: (key: string) => boolean = () => true): Row[] {
  const items: { node: Node; project: string | null; open: boolean | null }[] =
    v.filter === "files"
      ? tab.files.map((f) => ({ node: { t: "file", key: f.key, f }, project: f.project, open: null }))
      : tab.past.map((d) => ({ node: { t: "deliverable", key: `d:${d.id}`, d }, project: d.project, open: isOpen(d) }));
  if (v.project !== ALL_PROJECTS) return items.map(({ node, open }) => ({ node, level: 0, parent: null, open }));
  const rows: Row[] = [];
  for (const p of tab.projects) {
    const kids = items.filter((it) => it.project === p);
    if (kids.length === 0) continue; // nothing in it matches: no folder
    const key = folderKey(p);
    const open = isFolderOpen(key);
    rows.push({ node: { t: "project", key, project: p, count: kids.length }, level: 0, parent: null, open });
    if (open) for (const { node, open: o } of kids) rows.push({ node, level: 1, parent: key, open: o });
  }
  return rows;
}

/**
 * Whether a project folder shows open (2026-11-18, the owner). While a search is typed, every folder with a match is open
 * unless closed during that search (`session`), and the viewer's saved state is left as it was; with no search, the
 * saved state (`saved`), open unless the viewer closed it. Clearing the search brings the saved state back.
 */
export const folderOpen = (v: View, saved: Record<string, boolean>, session: Record<string, boolean>) => (key: string) =>
  v.query.trim() !== "" ? (session[key] ?? true) : (saved[key] ?? true);

/** How many entries a store of open rows or folders keeps in localStorage, the newest. */
export const OPEN_MAX = 500;
/** The viewer's open rows (`d:<id>`), saved folders and this search's folders. */
export type OpenStores = { rows: Record<string, boolean>; folders: Record<string, boolean>; search: Record<string, boolean> };

/**
 * The rows store's entry for every row it holds no entry for: Expand all's or Collapse all's choice (2026-11-18). One
 * entry, so a list past OPEN_MAX deliverables stays expanded; the trim never drops it.
 */
export const ALL_ROWS = "*";

/** Whether a past deliverable shows open: the viewer's own click on it, else Expand all's or Collapse all's choice, else closed. */
export const rowOpen = (rows: Record<string, boolean>) => (d: Deliverable) => rows[`d:${d.id}`] ?? rows[ALL_ROWS] ?? false;

/** A store with a patch applied, the patched keys moved last so a trim drops the oldest. */
export function mergeOpen(m: Record<string, boolean>, patch: Record<string, boolean>): Record<string, boolean> {
  const next = { ...m };
  for (const [k, v] of Object.entries(patch)) {
    delete next[k];
    next[k] = v;
  }
  return next;
}

/** A store as saved: its newest `max` entries, and always its ALL_ROWS entry. */
export function trimOpen(m: Record<string, boolean>, max = OPEN_MAX): Record<string, boolean> {
  const entries = Object.entries(m).filter(([k]) => k !== ALL_ROWS);
  const kept = Object.fromEntries(entries.slice(Math.max(0, entries.length - max)));
  return ALL_ROWS in m ? { [ALL_ROWS]: m[ALL_ROWS]!, ...kept } : kept;
}

/**
 * Expand all (`open`) or Collapse all (2026-11-18, the owner: they "don't work correctly"): the stores after it. Every
 * row, the rows store replaced by the one choice (so the clicks before it no longer count, and it holds past OPEN_MAX).
 * Under All projects, every project folder too: during a search the search's folders, as a folder click does then,
 * leaving the saved ones for when it clears. One project picked: no folders, the rows only.
 */
export function allOpen(s: OpenStores, tab: Tab, v: View, open: boolean): OpenStores {
  const rows = { [ALL_ROWS]: open };
  if (v.project !== ALL_PROJECTS) return { ...s, rows };
  const folders = Object.fromEntries(tab.projects.map((p) => [folderKey(p), open]));
  return v.query.trim() !== "" ? { ...s, rows, search: mergeOpen(s.search, folders) } : { ...s, rows, folders: mergeOpen(s.folders, folders) };
}

export type TreeMove = { focus?: string; toggle?: string; activate?: string };

/**
 * A key on the list, as a file explorer reads it: Down and Up move; Right opens a closed row, else goes to its first
 * child; Left closes an open row, else goes to the parent; Home and End go to the ends; Enter opens a file and opens or
 * closes a row. Null: not the list's key.
 */
export function treeKey(rows: readonly Row[], focus: string | null, key: string): TreeMove | null {
  if (rows.length === 0) return null;
  const at = Math.max(0, rows.findIndex((r) => r.node.key === focus));
  const row = rows[at]!;
  switch (key) {
    case "ArrowDown":
      return { focus: rows[Math.min(at + 1, rows.length - 1)]!.node.key };
    case "ArrowUp":
      return { focus: rows[Math.max(at - 1, 0)]!.node.key };
    case "Home":
      return { focus: rows[0]!.node.key };
    case "End":
      return { focus: rows[rows.length - 1]!.node.key };
    case "ArrowRight":
      if (row.open === false) return { toggle: row.node.key };
      if (row.open === true && rows[at + 1]?.parent === row.node.key) return { focus: rows[at + 1]!.node.key };
      return {};
    case "ArrowLeft":
      if (row.open === true) return { toggle: row.node.key };
      return row.parent ? { focus: row.parent } : {};
    case "Enter":
      return row.open === null ? { activate: row.node.key } : { toggle: row.node.key };
    default:
      return null;
  }
}

/**
 * The deliverable the wide Deliverables tab shows beside its list: the one picked while it still exists, else the
 * newest in review (what waits for the owner), else the newest of all. null when there are none.
 */
export function shownDeliverable(ds: readonly Deliverable[], picked: string | null): Deliverable | null {
  const hit = picked ? ds.find((d) => d.id === picked) : undefined;
  if (hit) return hit;
  const sorted = [...ds].sort(byUpdated);
  return sorted.find((d) => d.state === "review") ?? sorted[0] ?? null;
}

/** A size as people read it. */
export function sizeText(n: number | null): string {
  if (n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The outputs that are no board deliverable's proof: a board review's report stays on its review, off Files. */
export function offBoards(ds: readonly Deliverable[], os: readonly Output[]): Output[] {
  const key = (project: string | null, where: string | null | undefined) => `${projectKey(project)}\0${where}`;
  const taken = new Set(ds.filter((d) => d.board).flatMap((d) => d.revisions.flatMap((r) => r.proof.flatMap((p) => [p.path, p.source, p.url].filter(Boolean).map((w) => key(d.project, w))))));
  return os.filter((o) => !taken.has(key(o.project, o.path ?? o.url)));
}
