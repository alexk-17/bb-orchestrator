// The Deliverables tab's lower half. 2026-11-17, the owner: the project, deliverable and files tree was "really hard to
// navigate", and each deliverable now keeps its own files (core/deliverable-files.ts). So: the past deliverables, newest
// first, with the filters (state, project) and search as before; selecting one shows it with its files as full items
// (beside the list when wide, under its row when narrow). Under Files, every file across deliverables and the loose
// outputs, by kind (Artifacts, Images as a grid, Videos, All), each naming its deliverable, project and date.
// 2026-11-18, the owner: "we should still solve folders for the different projects". Under All projects, the list and
// Files are grouped by project again, one level only: a folder per project in the sidebar's order, with its count,
// open until the viewer closes it (remembered per viewer, the same in both views; a search opens every folder with a
// match, leaving that state alone). One project picked: no folder. The rows don't repeat the project: the folder, or the
// project picked, names it.
// The rows and their order come from past.ts; the list keeps the tree's keyboard (treeKey).
// On shadcn/ui: ToggleGroups for the filters and kinds, a Select, an Input, Item rows and Kind badges.
import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { DeliverableFolders, Deliverables } from "../contract.ts";
import { projectTitle } from "../core/model.ts";
import { FILES_WHERE, FileRow2, FileTile, META_LINE } from "./files.tsx";
import { ALL_PROJECTS, FILTERS, KINDS, START, allOpen, folderKey, folderOpen, mergeOpen, narrowed, rowOpen, rowsOf, treeKey, trimOpen, type Filter, type KindFilter, type Row, type Tab, type View } from "./past.ts";
import { REVEAL_EVENT, takeDeliverable } from "./reveal.ts";
import { PastDeliverable } from "./deliverables.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
import { cn } from "./ui/utils.ts";
import { Btn, EmptyState, Kind, Muted, PageError, when } from "./ui.tsx";

type Deliverable = Deliverables[number];

export const STATE_WORD: Record<Deliverable["state"], string> = { review: "in review", approved: "approved", changes: "changes requested", withdrawn: "withdrawn" };
const OPEN_KEY = "orchestrator.deliverables.open.v2";
/** The project folders the viewer opened or closed (2026-11-18), by folder key: one store for the list and Files. */
const FOLDERS_KEY = "orchestrator.deliverables.folders.v1";

/** Which past deliverables (narrow), or project folders, the viewer opened, by key; {} when storage is blocked or unreadable. */
function loadOpen(key: string): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, b]) => typeof b === "boolean")) : {};
  } catch {
    return {};
  }
}
function saveOpen(key: string, m: Record<string, boolean>) {
  try {
    localStorage.setItem(key, JSON.stringify(trimOpen(m)));
  } catch {
    // a private window or blocked storage: this visit only
  }
}
/**
 * A store of open rows: its state, a setter that saves it, the newest toggles last so a trim drops the oldest, and one
 * that replaces it whole (Expand all, Collapse all).
 */
function useOpenStore(key: string) {
  const [stored, setStored] = useState<Record<string, boolean>>(() => loadOpen(key));
  const set = (patch: Record<string, boolean>) =>
    setStored((m) => {
      const next = mergeOpen(m, patch);
      saveOpen(key, next);
      return next;
    });
  const replace = (next: Record<string, boolean>) => {
    saveOpen(key, next);
    setStored(next);
  };
  return [stored, set, replace] as const;
}

/** The project select's value for "No project" (shadcn's Select takes no empty value). */
const NO_PROJECT = "(none)";

/** What the folders read says: loaded, its error, and the host the folders are on. */
export type FoldersState = { data: DeliverableFolders | undefined; error: string | null };

/** The filters, the project, the search and, under Files, the kinds. */
/** Delivered's own page shows Decided; Files and withdrawn are a page of their own, with Back (Home first step 3, 2026-11-20). */
export const OFF_PAGE: readonly Filter[] = ["withdrawn", "files"];

export function PastControls({ tab, view, setView }: { tab: Tab; view: View; setView: (f: (v: View) => View) => void }) {
  const off = OFF_PAGE.includes(view.filter);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2" data-past-controls="">
      {off ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" size="sm" data-past-back="" onClick={() => setView((v) => ({ ...v, filter: "decided" }))}>
            <ChevronLeft />
            Delivered
          </Button>
          {/* one row of tabs on the page: Withdrawn or Files */}
          <ToggleGroup type="single" variant="outline" size="sm" aria-label="Show" value={view.filter} onValueChange={(f) => f && setView((v) => ({ ...v, filter: f as Filter }))}>
            {FILTERS.filter((f) => OFF_PAGE.includes(f.id)).map((f) => (
              <ToggleGroupItem key={f.id} value={f.id} data-filter={f.id} className="px-3">
                {f.label} <span className="text-muted-foreground tabular-nums">{tab.counts[f.id]}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      ) : null}
      {view.filter === "files" ? (
        <Select value={view.kind} onValueChange={(k) => setView((v) => ({ ...v, kind: k as KindFilter }))}>
          <SelectTrigger aria-label="Kind of file" data-past-kind="" className="w-56 max-w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KINDS.map((k) => (
              <SelectItem key={k.id} value={k.id} data-kind={k.id}>
                {k.label} ({tab.kinds[k.id]})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Select value={view.project === "" ? NO_PROJECT : view.project} onValueChange={(p) => setView((v) => ({ ...v, project: p === NO_PROJECT ? "" : p }))}>
          <SelectTrigger aria-label="Project" data-past-project="" className="w-56 max-w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
            {tab.projects.map((p) => (
              <SelectItem key={p ?? ""} value={p ?? NO_PROJECT}>
                {p ? projectTitle(p) : "No project"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="search"
          aria-label="Search past deliverables and files"
          data-past-search=""
          placeholder={view.filter === "files" ? "Search files, captions and deliverables" : "Search titles, summaries and points"}
          value={view.query}
          maxLength={200}
          onChange={(e) => setView((v) => ({ ...v, query: e.target.value }))}
          className="w-auto min-w-0 flex-[1_1_14rem]"
        />
      </div>
    </div>
  );
}

/** Under Decided: the way to the Files and withdrawn page, with how many are there. */
export function FilesAndWithdrawn({ tab, setView }: { tab: Tab; setView: (f: (v: View) => View) => void }) {
  return (
    <Button type="button" variant="ghost" className="h-auto w-full justify-between px-2 py-3 font-normal" data-files-withdrawn="" onClick={() => setView((v) => ({ ...v, filter: "files" }))}>
      Files and withdrawn
      <span className="flex items-center gap-1 text-muted-foreground tabular-nums">
        {tab.counts.files + tab.counts.withdrawn}
        <ChevronRight />
      </span>
    </Button>
  );
}

/**
 * A past deliverable's row: its title, then its state, lead, revision, date and how many files it has. Not its project
 * (2026-11-18): its folder, or the project picked, names it.
 */
function DeliverableRowBody({ d, files }: { d: Deliverable; files: number }) {
  const last = d.feedback[d.feedback.length - 1];
  return (
    <div className="min-w-0 flex-1">
      <span className="text-sm leading-5 font-semibold [overflow-wrap:anywhere]" data-toggle="">
        {d.title}
      </span>
      <div className={cn(META_LINE, "items-center")}>
        <Kind of={d.state}>{STATE_WORD[d.state]}</Kind>
        <span>{d.lead}</span>
        {d.rev > 1 ? <span>rev {d.rev}</span> : null}
        <span>{when(d.updatedAt)}</span>
        <span>
          {files} file{files === 1 ? "" : "s"}
        </span>
      </div>
      {last?.text ? (
        <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={last.text}>
          {last.outcome === "changes" ? "Changes: " : "You said: "}
          {last.text}
        </span>
      ) : null}
      {d.next ? (
        <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={d.next.text}>
          Next: {d.next.text} · {d.next.state === "closed" ? (d.next.outcome ?? "closed") : d.next.state === "dead" ? "not delivered" : "with the lead"}
        </span>
      ) : null}
    </div>
  );
}

/** The drawn rows as folders: each project folder's header and its rows, or (one project picked) the rows alone. */
function groupsOf(rows: readonly Row[]): { head: Row | null; kids: Row[] }[] {
  const groups: { head: Row | null; kids: Row[] }[] = [];
  for (const r of rows) {
    if (r.node.t === "project") groups.push({ head: r, kids: [] });
    else if (r.parent && groups.length > 0) groups[groups.length - 1]!.kids.push(r);
    else if (groups.length > 0 && groups[groups.length - 1]!.head === null) groups[groups.length - 1]!.kids.push(r);
    else groups.push({ head: null, kids: [r] });
  }
  return groups;
}

const ROW = "flex min-h-9 items-start gap-2 rounded-md px-2 py-2 outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[picked]:bg-accent";

/**
 * The past deliverables, or under Files every file. `pick` (the wide tab): a row selects its deliverable for the detail
 * beside the list; narrow, a row opens it under itself. `onDeliverable`: a file's deliverable link shows that deliverable.
 */
export function PastRows({
  tab,
  view,
  setView,
  outputs,
  folders,
  outputsAfter,
  refetchAll,
  pick,
  onDeliverable,
}: {
  tab: Tab;
  view: View;
  setView: (f: (v: View) => View) => void;
  outputs: { loaded: boolean; error: string | null };
  folders: FoldersState;
  outputsAfter: () => void;
  refetchAll: () => void;
  pick?: { id: string | null; on: (id: string) => void };
  onDeliverable: (id: string) => void;
}) {
  const [stored, setOpen, replaceOpen] = useOpenStore(OPEN_KEY);
  const [savedFolders, setFolderOpen, replaceFolders] = useOpenStore(FOLDERS_KEY);
  // the folders opened or closed during this search, never saved; a new search starts again with its matches open
  const [searchFolders, setSearchFolders] = useState<Record<string, boolean>>({});
  useEffect(() => setSearchFolders({}), [view.query]);
  const searching = view.query.trim() !== "";
  const isOpen = (d: Deliverable) => (pick ? false : rowOpen(stored)(d));
  const rows = rowsOf(tab, view, isOpen, folderOpen(view, savedFolders, searchFolders));
  const host = folders.data?.hostId ?? null;
  // Expand all or Collapse all: every row and, under All projects, every folder (allOpen)
  const all = (open: boolean) => {
    const next = allOpen({ rows: stored, folders: savedFolders, search: searchFolders }, tab, view, open);
    replaceOpen(next.rows);
    if (next.folders !== savedFolders) replaceFolders(next.folders);
    setSearchFolders(next.search);
  };
  const toggle = (r: Row) => {
    if (r.node.t === "project") {
      // during a search a folder opens or closes for that search only; the saved state waits for the search to clear
      const patch = { [r.node.key]: !r.open };
      if (searching) setSearchFolders((m) => ({ ...m, ...patch }));
      else setFolderOpen(patch);
    } else if (r.node.t !== "deliverable") return;
    else if (pick) pick.on(r.node.d.id);
    else setOpen({ [r.node.key]: !r.open });
  };

  // a link elsewhere asked for a deliverable (reveal.ts): every filter off, its project's folder open, then it is picked
  // (wide) or opened (narrow)
  const want = useRef<string | null>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    want.current = takeDeliverable() ?? want.current;
    // the ask stays pending until a list reveals it (2026-11-18): the wide Files view's list unmounts as the link puts the
    // list back in the nav, and that list must still open the deliverable's folder
    const on = (e: Event) => {
      want.current = (e as CustomEvent<string>).detail;
      setAsked((n) => n + 1);
    };
    window.addEventListener(REVEAL_EVENT, on);
    return () => window.removeEventListener(REVEAL_EVENT, on);
  }, []);
  useEffect(() => {
    const id = want.current;
    if (!id || !tab.filesBy.has(id)) return; // not loaded yet: kept until the list has it
    want.current = null;
    takeDeliverable();
    setView(() => START);
    setFolderOpen({ [folderKey(tab.projectOf.get(id) ?? null)]: true });
    if (pick) pick.on(id);
    else setOpen({ [`d:${id}`]: true });
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-past="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }));
  }, [tab.filesBy, asked]);

  // the roving focus: one row is in the tab order; the arrow keys move it
  const [focus, setFocus] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const focusKey = rows.some((r) => r.node.key === focus) ? focus : (rows[0]?.node.key ?? null);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    listRef.current?.querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(focusKey ?? "")}"]`)?.focus();
  });
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).getAttribute("role") !== "treeitem" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const m = treeKey(rows, focusKey, e.key);
    if (!m) return;
    e.preventDefault();
    if (m.toggle) {
      const r = rows.find((x) => x.node.key === m.toggle);
      if (r) toggle(r);
    }
    if (m.activate) listRef.current?.querySelector<HTMLElement>(`[data-tree-key="${CSS.escape(m.activate)}"] [data-open]`)?.click();
    if (m.focus) {
      moved.current = true;
      setFocus(m.focus);
    }
  };

  // a project's folder: its chevron, title and how many of its rows match (2026-11-18)
  const folderRow = (r: Row) => {
    const n = r.node;
    if (n.t !== "project") return null;
    return (
      <div
        key={n.key}
        role="treeitem"
        aria-level={1}
        aria-expanded={!!r.open}
        data-tree-key={n.key}
        data-tree-project={n.project ?? ""}
        tabIndex={n.key === focusKey ? 0 : -1}
        className={cn(ROW, "cursor-pointer items-center")}
        onFocus={(e) => e.target === e.currentTarget && setFocus(n.key)}
        onClick={() => toggle(r)}
      >
        <ChevronRight className={cn("size-3 flex-none text-muted-foreground transition-transform", r.open && "rotate-90")} aria-hidden />
        <span className="min-w-0 text-sm leading-5 font-semibold [overflow-wrap:anywhere]">{n.project ? projectTitle(n.project) : "No project"}</span>
        {/* the count beside the name, as "Harbour 3" (2026-11-18, the owner) */}
        <span className="flex-none text-xs text-muted-foreground tabular-nums" data-folder-count="">
          {n.count}
        </span>
      </div>
    );
  };
  const itemRow = (r: Row) => {
    const n = r.node;
    const focusable = n.key === focusKey;
    const level = r.level + 1;
    if (n.t === "project") return null;
    if (n.t === "file")
      return (
        <div key={n.key} role="treeitem" aria-level={level} data-tree-key={n.key} data-tree-file={n.f.key} tabIndex={focusable ? 0 : -1} className="min-w-0 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" onFocus={(e) => e.target === e.currentTarget && setFocus(n.key)}>
          {grid ? <FileTile f={n.f} host={host} onDeliverable={onDeliverable} noProject /> : <FileRow2 f={n.f} host={host} after={outputsAfter} onDeliverable={onDeliverable} noProject />}
        </div>
      );
    const picked = pick ? n.d.id === pick.id : undefined;
    return (
      <div key={n.key} className="min-w-0">
        <div
          role="treeitem"
          aria-level={level}
          data-tree-key={n.key}
          data-past={n.d.id}
          data-state={n.d.state}
          aria-expanded={pick ? undefined : !!r.open}
          aria-selected={pick ? picked : undefined}
          data-picked={picked ? "" : undefined}
          tabIndex={focusable ? 0 : -1}
          className={cn(ROW, "cursor-pointer")}
          onFocus={(e) => e.target === e.currentTarget && setFocus(n.key)}
          onClick={(e) => {
            // a click anywhere on the row selects or opens it, except on a control inside it
            if (!(e.target as HTMLElement).closest("a,button,input,select,textarea,summary")) toggle(r);
          }}
        >
          {pick ? null : <ChevronRight className={cn("mt-1 size-3 flex-none text-muted-foreground transition-transform", r.open && "rotate-90")} aria-hidden />}
          <DeliverableRowBody d={n.d} files={tab.filesBy.get(n.d.id)?.length ?? 0} />
        </div>
        {r.open ? (
          <div className="pt-1 pb-3 pl-5" data-past-body={n.d.id}>
            <PastDeliverable d={n.d} files={tab.filesBy.get(n.d.id) ?? []} folders={folders} refetchAll={refetchAll} outputsAfter={outputsAfter} />
          </div>
        ) : null}
      </div>
    );
  };

  const files = view.filter === "files";
  const heading = files ? "Files" : "Past deliverables";
  const grid = files && view.kind === "images";
  const narrow = narrowed(view);
  const loading = files ? !outputs.loaded || !folders.data : false;
  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-3 text-sm" data-past-list="" aria-label={heading}>
      {!pick && !files && rows.length > 0 ? (
        <div className="-ml-3 flex gap-1">
          <Btn tone="ghost" size="sm" className="text-muted-foreground" data-expand-all="" onClick={() => all(true)}>
            Expand all
          </Btn>
          <Btn tone="ghost" size="sm" className="text-muted-foreground" data-collapse-all="" onClick={() => all(false)}>
            Collapse all
          </Btn>
        </div>
      ) : null}
      {outputs.error || folders.error ? (
        <p className="orch-danger m-0 text-xs">
          {outputs.error ? `${outputs.loaded ? "Stale outputs" : "Can't read the outputs"}: ${outputs.error} ` : ""}
          {folders.error ? `${folders.data ? "Stale folders" : "Can't read the deliverables' folders"}: ${folders.error} ` : ""}
          <Btn tone="ghost" onClick={outputsAfter}>
            Retry
          </Btn>
        </p>
      ) : null}
      <PageError where={FILES_WHERE} />
      {rows.length === 0 ? (
        loading && !outputs.error && !folders.error ? (
          <Muted>Loading…</Muted>
        ) : (
          <EmptyState
            bare
            data-past-empty=""
            title={narrow && (view.project !== ALL_PROJECTS || view.query.trim()) ? "Nothing matches" : files ? "No files yet" : "No past deliverables yet"}
            text={narrow && (view.project !== ALL_PROJECTS || view.query.trim()) ? "Try another project or search." : files ? "A deliverable's proof files land here, sorted by kind, as soon as it is filed." : "Approved, sent back and withdrawn deliverables land here."}
          />
        )
      ) : (
        <div ref={listRef} role="tree" aria-label={heading} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1" onKeyDown={onKeyDown}>
          {groupsOf(rows).map((g) => (
            <Fragment key={g.head?.node.key ?? "rows"}>
              {g.head ? folderRow(g.head) : null}
              {g.kids.length > 0 ? (
                <div role={g.head ? "group" : "none"} data-folder-rows={g.head ? g.head.node.key : undefined} className={cn("grid min-w-0", grid ? "grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-4" : "grid-cols-[minmax(0,1fr)]", g.head && "pb-2 pl-5")}>
                  {g.kids.map(itemRow)}
                </div>
              ) : null}
            </Fragment>
          ))}
        </div>
      )}
    </section>
  );
}
