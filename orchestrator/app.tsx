// Orchestrator, the app: one destination in bb's navigation with views at sub-paths: Deliverables (the default, with the outputs), Needs you,
// Projects (each project with its own page), Board and Rules. Reads go over RPC (contract.ts); the owner's writes are plain POSTs through one page gate
// (app/store.ts). The server publishes CHANGED_CHANNEL on every change, and the reads refetch on it: Needs you and the
// Board always (the badge, and the Board's agents give Needs you its sprites), Projects only while shown
// (its agents read asks bb about every agent's thread).
import { styleHref } from "./app/style-href.ts";
import { VisualBlocksStyle } from "./app/visual-blocks.tsx";
import { CloudView } from "./cloud/app.tsx";
import { GameView } from "./gameboy/app.tsx";
import { pageContract } from "./cloud/contract.ts";
import { cloudEmptyState } from "./cloud/core/setup.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExperimentalBadge, PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { ThreadChat, definePluginApp, experimental_useRpcQuery, useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import { CHANGED_CHANNEL, rpcContract, type Board } from "./contract.ts";
import { DEFAULT_IDENTITY, IdentityContext } from "./app/identity.ts";
import { CosComposer } from "./app/cos-composer.tsx";
import { ARCHIVE_PROJECT_ICON, ArchiveProjectIcon, archiveProjectAction } from "./app/archive-action.tsx";
import { PRIORITY_ICON, PriorityIcon, priorityAction } from "./app/priority-action.tsx";
import { BoardView, RulesView } from "./app/board.tsx";
import { NeedsYouView, ZONE } from "./app/needs-you.tsx";
import { ProjectsView } from "./app/projects.tsx";
import type { SharedRefs } from "./app/ref-text.tsx";
import { DeliverablesView, inReview } from "./app/deliverables.tsx";
import { OpenPrsView } from "./app/open-prs.tsx";
import { pointerPressed } from "./app/store.ts";
import { EmptyState } from "./app/affect/empty-state-clean.tsx";
import { RENAMED_VIEWS, close, detailOf, findPane, panes, parse, pathFor, resize, setView, single, split, type Layout } from "./app/layout.ts";
import { PaneLayout, paneCss, useWidth } from "./app/panes.tsx";
import { Btn, Look, Muted, ReadState } from "./app/ui.tsx";
import { RowMeta, useRowData } from "./app/row-meta.tsx";
import { decide, where, type TargetLike } from "./app/keys.ts";
import { emitKeys, handlerFor, keyState } from "./app/key-state.ts";
import { ShortcutUi } from "./app/shortcut-help.tsx";
import { PANEL_PATH } from "./app/open-proof.ts";

// Deliverables first (what the owner reviews); the Board is "Activity", last (process, for when they want to look). Its id
// and sub-path stay "board", so links keep working.
const VIEWS = [
  { id: "deliverables", subPath: "", label: "Deliverables" },
  { id: "needs-you", subPath: "needs-you", label: "Needs you" },
  { id: "chat", subPath: "chat", label: "Chat" },
  { id: "projects", subPath: "projects", label: "Projects" },
  // Requested 2026-11-16: the owner's open PRs, which need review, and the review ask to paste in Slack
  { id: "open-prs", subPath: "open-prs", label: "Open PRs" },
  // Requested 2026-11-13: Cloud Switch moved in as a tab. Always listed (2026-11-16): without a cloud config it says what to
  // set up, instead of vanishing with no reason.
  { id: "cloud", subPath: "cloud", label: "Cloud" },
  // Requested 2026-11-13: the emulator moved in too
  { id: "gameboy", subPath: "gameboy", label: "Game Boy" },
  { id: "rules", subPath: "rules", label: "Rules" },
  { id: "board", subPath: "board", label: "Activity" },
] as const;
type ViewId = (typeof VIEWS)[number]["id"];

function viewOf(subPath: string): ViewId {
  let first = subPath.split("/")[0] ?? "";
  try {
    first = decodeURIComponent(first);
  } catch {
    // keep it as it is
  }
  if (first === "deliverables") return "deliverables"; // the old sub-path still works
  // a tab that went into another (Agents into Projects, Outputs into Deliverables, 2026-11-16) opens its successor
  if (Object.hasOwn(RENAMED_VIEWS, first)) return RENAMED_VIEWS[first] as ViewId;
  return VIEWS.find((v) => v.subPath === first && first !== "")?.id ?? "deliverables";
}

function useNeedsYou() {
  return experimental_useRpcQuery({ contract: rpcContract, method: "needsYou", input: { zone: ZONE } });
}

function useDeliverables() {
  return experimental_useRpcQuery({ contract: rpcContract, method: "deliverables", input: null });
}

/** The rail badge: only the owner's items (cards + interactions, and deliverables in review), null at 0. */
function useOrchestratorBadge(): ExperimentalBadge | null {
  const q = useNeedsYou();
  const dq = useDeliverables();
  const refetch = useRef(q.refetch);
  refetch.current = q.refetch;
  const drefetch = useRef(dq.refetch);
  drefetch.current = dq.refetch;
  useRealtime(
    CHANGED_CHANNEL,
    useCallback(() => {
      void refetch.current();
      void drefetch.current();
    }, []),
  );
  const n = (q.data?.badge ?? 0) + inReview(dq.data).length;
  return n > 0 ? { count: n, label: `${n} ${n === 1 ? "item needs" : "items need"} you` } : null;
}

const LAYOUT_KEY = "orchestrator.layout.v1";
const VIEW_IDS = VIEWS.map((v) => v.id) as string[];

/** The saved layout (per viewer, in the browser); unreadable or stale gives null, and the page starts with one pane. */
function loadLayout(): Layout | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? parse(JSON.parse(raw), VIEW_IDS, RENAMED_VIEWS) : null;
  } catch {
    return null;
  }
}
function saveLayout(l: Layout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
  } catch {
    // a private window or blocked storage: the layout lasts this visit only
  }
}

/** Requested 2026-11-13: "I do want to have a chat tab for the Chief of Staff": bb's own chat with the CoS, in a pane. */
function CosChat({ agents, width }: { agents: Board["agents"] | undefined; width: number }) {
  const cos = agents?.find((a) => a.address === "cos") ?? null;
  if (!agents) return <Muted>Loading…</Muted>;
  if (!cos) return <EmptyState title="No Chief of Staff is running" text="Start it from the Projects tab; its chat shows here." />;
  return <ThreadChat threadId={cos.threadId} variant={width >= 720 ? "full" : "compact"} className="min-h-0 flex-1" />;
}

/** What a key was pressed on, as keys.ts reads it. */
function targetOf(el: EventTarget | null): TargetLike {
  if (!(el instanceof HTMLElement)) return null;
  return { tagName: el.tagName, type: (el as HTMLInputElement).type, isContentEditable: el.isContentEditable, role: el.getAttribute("role"), insideRole: el.closest("[role=menu],[role=listbox]")?.getAttribute("role") ?? null, leave: (el.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && where({ tagName: "INPUT", type: (el as HTMLInputElement).type }) === "text")) && el.getAttribute("aria-expanded") !== "true" };
}

function OrchestratorPanel({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const [layout, setLayoutState] = useState<Layout>(() => loadLayout() ?? single(viewOf(subPath)));
  const setLayout = useCallback((f: (l: Layout) => Layout) => {
    setLayoutState((l) => {
      const next = f(l);
      if (next !== l) saveLayout(next);
      return next;
    });
  }, []);
  // a link to a view (a sub-path) opens it in the focused pane; the bare page keeps the saved layout as it was
  const explicit = (subPath.split("/")[0] ?? "") !== "";
  // an old Outputs link opens Deliverables on its Files filter
  const fromOutputs = (subPath.split("/")[0] ?? "") === "outputs";
  const linked = viewOf(subPath);
  // the open project page (projects/<slug>). Kept here, not in the URL alone: a pane's focus rewrites the URL, and the
  // page must stay open when the owner clicks another pane and comes back.
  const [detail, setDetail] = useState<string | null>(() => detailOf(subPath));
  useEffect(() => {
    // a link or the browser's back/forward to a projects URL says which page (or the list)
    if (linked === "projects") setDetail(detailOf(subPath));
  }, [linked, subPath]);
  const onDetail = (slug: string | null) => {
    setDetail(slug);
    navigate.toPluginPanel(PANEL_PATH, { subPath: pathFor("projects", "projects", slug) });
  };
  useEffect(() => {
    if (!explicit) return;
    setLayout((l) => (findPane(l, l.focus)?.view === linked ? l : setView(l, l.focus, linked)));
  }, [explicit, linked, setLayout]);

  const root = useRef<HTMLDivElement>(null);
  const width = useWidth(root);
  const compact = width > 0 && width < 720;
  const shown = new Set(compact ? [findPane(layout, layout.focus)?.view] : panes(layout.root).map((p) => p.view));

  const needs = useNeedsYou();
  const board = experimental_useRpcQuery({ contract: rpcContract, method: "board", input: null });
  const config = experimental_useRpcQuery({ contract: rpcContract, method: "config", input: null });
  const projects = experimental_useRpcQuery({ contract: rpcContract, method: "projects", input: null, enabled: shown.has("projects") });
  // the Projects tab's lanes read the agents too
  const agents = experimental_useRpcQuery({ contract: rpcContract, method: "agents", input: null, enabled: shown.has("projects") });
  const deliverables = useDeliverables();
  const cloud = experimental_useRpcQuery({ contract: pageContract, method: "cs.available", input: null });
  const cloudOn = cloud.data?.available === true;
  const reviewCount = inReview(deliverables.data).length;
  const latest = useRef({ needs, board, projects, agents, shown, deliverables, config });
  latest.current = { needs, board, projects, agents, shown, deliverables, config };
  const refetchAll = useCallback(() => {
    const l = latest.current;
    void l.config.refetch();
    void l.deliverables.refetch();
    void l.needs.refetch();
    void l.board.refetch();
    if (l.shown.has("projects")) {
      void l.projects.refetch();
      void l.agents.refetch();
    }
  }, []);
  const mons = useMemo(() => new Map((board.data?.agents ?? []).map((a) => [a.address, a.mon] as const)), [board.data]);
  // each project's accent type (accent.ts), from its agents: none with the pokemon setting off
  const accents = useMemo(() => new Map((board.data?.agents ?? []).filter((a) => a.project && a.monType).map((a) => [a.project!, a.monType] as const)), [board.data]);
  useRealtime(CHANGED_CHANNEL, refetchAll);

  // Keyboard shortcuts (2026-11-16, for a macropad): one listener, only while this page is drawn and has the focus. keys.ts
  // decides what a key is; the focused pane's view says what it does there. A key we act on is swallowed (so Esc closing
  // the cheat sheet does not also go back a page).
  const keyCtx = useRef({ layout, views: [] as { id: string }[], setLayout, follow: (_v: string) => {} });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = root.current;
      if (!el || !el.isConnected || el.getClientRects().length === 0) return;
      const active = document.activeElement;
      if (active && active !== document.body && !el.contains(active)) return; // focus is elsewhere in bb
      const a = decide(e, targetOf(e.target), keyState.help);
      if (!a) return;
      const ctx = keyCtx.current;
      if (a.t !== "approve") keyState.arm = null;
      let done = true;
      if (a.t === "help") keyState.help = !keyState.help;
      else if (a.t === "close") keyState.help = false;
      else if (a.t === "blur") (document.activeElement as HTMLElement | null)?.blur();
      else if (a.t === "tab") {
        if (ctx.views.some((v) => v.id === a.view)) {
          ctx.setLayout((l) => setView(l, l.focus, a.view));
          ctx.follow(a.view);
        }
      } else if (a.t === "cos") {
        const box = el.querySelector<HTMLElement>("[data-cos-text]");
        if (box && !(box as HTMLTextAreaElement).disabled) box.focus();
      } else done = handlerFor(findPane(ctx.layout, ctx.layout.focus)?.view)?.(a) ?? false;
      if (!done) return;
      e.preventDefault();
      e.stopPropagation();
      emitKeys();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const threads = useMemo(() => new Map((board.data?.agents ?? []).map((a) => [a.address, a.threadId] as const)), [board.data]);
  // what references in the Projects rows resolve against (app/refs.ts): known PRs, loaded cards and deliverables, live
  // threads, the Linear settings; anything else stays plain text
  const refs = useMemo((): SharedRefs => {
    const cards = new Map<string, "open" | "answered">();
    for (const d of board.data?.decisions ?? []) cards.set(d.id, d.state === "open" || d.state === "asked" ? "open" : "answered");
    for (const c of needs.data?.cards ?? []) cards.set(c.id, "open");
    const live = new Map((board.data?.agents ?? []).filter((a) => a.status !== "archived").map((a) => [a.address, a.threadId] as const));
    return {
      allPrs: (projects.data ?? []).flatMap((p) => p.prs ?? []),
      linearWorkspace: config.data?.linearWorkspace ?? "",
      linearTeams: config.data?.linearTeams ?? [],
      cards,
      deliverables: new Set((deliverables.data ?? []).map((d) => d.id)),
      threads: live,
    };
  }, [board.data, needs.data, projects.data, config.data, deliverables.data]);
  // Requested 2026-11-17: the hiddenTabs setting drops tabs by id or label (lower-cased by the server); it never hides them all
  const hiddenTabs = new Set(config.data?.hiddenTabs ?? []);
  const isHidden = (v: (typeof VIEWS)[number]) => hiddenTabs.has(v.id) || hiddenTabs.has(v.label.toLowerCase());
  const visible = VIEWS.some((v) => !isHidden(v)) ? VIEWS.filter((v) => !isHidden(v)) : VIEWS;
  // a pane left on a tab that is now hidden moves to the first visible tab
  useEffect(() => {
    const stale = panes(layout.root).filter((p) => !visible.some((v) => v.id === p.view));
    if (stale.length) setLayout((cur) => stale.reduce((l, p) => setView(l, p.id, visible[0]!.id), cur));
  });
  const views = visible.map((v) => ({
    id: v.id,
    label: v.label,
    count:
      v.id === "needs-you" && needs.data && needs.data.badge > 0
        ? needs.data.badge
        : v.id === "deliverables" && reviewCount > 0
          ? reviewCount
          : v.id === "projects" && board.data?.directUnread?.length
            ? "•" // a lead's note you haven't opened (PLAN 3.4); never a phone notification
            : undefined,
  }));
  // the URL follows the focused pane, so back/forward and links keep working
  const follow = (view: string) => {
    const v = VIEWS.find((x) => x.id === view);
    if (v) navigate.toPluginPanel(PANEL_PATH, { subPath: pathFor(v.subPath, v.id, detail), replace: true });
  };

  keyCtx.current = { layout, views, setLayout, follow };

  // a lane's "waits on you": Needs you in the focused pane, then that card scrolled into sight once it is drawn
  const openCard = (selector: string) => {
    navigate.toPluginPanel(PANEL_PATH, { subPath: "needs-you" });
    let tries = 0;
    const find = () => {
      const el = root.current?.querySelector<HTMLElement>(selector);
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      else if (++tries < 40) setTimeout(find, 100);
    };
    setTimeout(find, 0);
  };

  const render = (view: string, pane: { width: number }) => {
    switch (view) {
      case "deliverables":
        return <DeliverablesView q={deliverables} refetchAll={refetchAll} files={fromOutputs} />;
      case "needs-you":
        return <NeedsYouView q={needs} refetchAll={refetchAll} mons={mons} threads={threads} accents={accents} />;
      case "chat":
        return <CosChat agents={board.data?.agents} width={pane.width} />;
      case "projects":
        return <ProjectsView q={projects} refetchAll={refetchAll} agents={board.data?.agents} lanesFrom={agents.data} needs={needs.data} openCard={openCard} detail={detail} onDetail={onDetail} refs={refs} />;
      case "open-prs":
        return <OpenPrsView />;
      case "board":
        return <BoardView q={board} refetchAll={refetchAll} />;
      case "rules":
        return <RulesView q={board} refetchAll={refetchAll} />;
      case "gameboy":
        return <GameView />;
      case "cloud":
        return cloudOn ? (
          <CloudView />
        ) : (
          <div className="mx-auto w-full max-w-3xl px-4 pt-4">
            {cloud.data ? (
              <EmptyState {...cloudEmptyState(cloud.data)} action={<Btn onClick={() => void cloud.refetch()}>Check again</Btn>} />
            ) : (
              <ReadState q={cloud} what="whether this machine has a cloud config" />
            )}
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <IdentityContext.Provider value={config.data ?? DEFAULT_IDENTITY}>
    <div ref={root} data-orch="" data-view={findPane(layout, layout.focus)?.view} onPointerDownCapture={pointerPressed} className="flex h-full min-h-0 flex-1 flex-col">
      <Look />
      <style href={styleHref("orch-panes", paneCss)} precedence="default">
        {paneCss}
      </style>
      <VisualBlocksStyle />
      <ShortcutUi />
      {/* the quick line to the CoS, once above the panes; not while its full chat is open */}
      {shown.has("chat") ? null : (
        <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-4">
          <CosComposer agents={board.data?.agents} refetchAll={refetchAll} compact={compact} />
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <PaneLayout
          layout={layout}
          views={views}
          compact={compact}
          render={render}
          fill={(v) => v === "chat" || v === "cloud" || v === "gameboy"}
          wide={(v) => v === "projects" || v === "deliverables" || v === "open-prs"}
          onView={(id, v) => {
            setLayout((l) => setView(l, id, v));
            follow(v);
          }}
          onFocus={(id) => {
            setLayout((l) => ({ ...l, focus: id }));
            const p = findPane(layout, id);
            if (p) follow(p.view);
          }}
          onSplit={(id, dir) => {
            // the new pane opens on a view not already on screen
            const free = views.find((v) => !panes(layout.root).some((p) => p.view === v.id))?.id ?? "needs-you";
            setLayout((l) => split(l, id, dir, free));
            follow(free);
          }}
          onClose={(id) => setLayout((l) => close(l, id))}
          onResize={(sid, i, d) => setLayout((l) => resize(l, sid, i, d))}
        />
      </div>
    </div>
    </IdentityContext.Provider>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "orchestrator",
    title: "Orchestrator",
    icon: "Workflow", // Requested 2026-11-14: a neutral icon, even with Pokémon on (a built-in bb glyph)
    path: PANEL_PATH,
    component: OrchestratorPanel,
    experimental_useBadge: useOrchestratorBadge,
  });
  // the sidebar: each role agent's Pokémon, role and priority under its thread title
  app.slots.experimental_threadRowMetadata({ id: "agent", order: 0, useData: useRowData, component: RowMeta });
  // Requested 2026-11-13: change a project's priority from its lead's sidebar row (right-click → Priority)
  app.experimental_icons.register({ name: PRIORITY_ICON, component: PriorityIcon });
  app.slots.experimental_threadAction(priorityAction);
  app.experimental_icons.register({ name: ARCHIVE_PROJECT_ICON, component: ArchiveProjectIcon });
  app.slots.experimental_threadAction(archiveProjectAction);
});
