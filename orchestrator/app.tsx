// Orchestrator, the app: one destination in bb's navigation with views at sub-paths: Home (the default, the feed), Deliverables, Needs you,
// Projects (each project with its own page), Board and Rules. Reads go over RPC (contract.ts); the owner's writes are plain POSTs through one page gate
// (app/store.ts). The server publishes CHANGED_CHANNEL on every change, and the reads refetch on it: Needs you and the
// Board always (the badge, and the Board's agents give Needs you its sprites), Projects only while shown
// (its agents read asks bb about every agent's thread).
import { styleHref } from "./app/style-href.ts";
import { VisualBlocksStyle } from "./app/visual-blocks.tsx";
import { CloudView } from "./cloud/app.tsx";
import { GameView } from "./gameboy/app.tsx";
import { MultiplayerTab, TeamBoards } from "./multiplayer/app.tsx";
import { MULTIPLAYER_CHANNEL } from "./multiplayer/contract.ts";
import { QUEUE_CHANNEL } from "./review-queue/contract.ts";
import { pageContract } from "./cloud/contract.ts";
import { cloudEmptyState } from "./cloud/core/setup.ts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ExperimentalBadge, PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { definePluginApp, experimental_useRpcQuery, useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import { CHANGED_CHANNEL, rpcContract } from "./contract.ts";
import { touches } from "./change-notice.ts";
import { DEFAULT_IDENTITY, IdentityContext } from "./app/identity.ts";
import { CosChat } from "./app/cos-chat.tsx";
import { FeedView, type FeedFilter } from "./app/feed.tsx";
import { ARCHIVE_PROJECT_ICON, ArchiveProjectIcon, archiveProjectAction } from "./app/archive-action.tsx";
import { PRIORITY_ICON, PriorityIcon, priorityAction } from "./app/priority-action.tsx";
import { BoardView, RulesView } from "./app/board.tsx";
import { NeedsYouView, ZONE } from "./app/needs-you.tsx";
import { ProjectsView } from "./app/projects.tsx";
import type { SharedRefs } from "./app/ref-text.tsx";
import { DeliverablesView, inReview, inScope } from "./app/deliverables.tsx";
import { expand } from "./app/deliverable-data.ts";
import { ReviewsView } from "./app/reviews.tsx";
import { ReviewQueueView } from "./app/review-queue.tsx";
import { ownerCounts, ownerCountsLabel, scopeEntryOf } from "./app/kit.ts";
import { pointerPressed } from "./app/store.ts";
import { beside, besideOf, close, dock, dropAt, findPane, fits, fitSizes, land, panes, parse, setRoute, setSizes, single, split, type Edge, type Layout } from "./app/layout.ts";
import { dragFrom } from "./app/drag.ts";
import { fromPath, rootOf, samePlace, toPath, canonical, type Route } from "./app/route.ts";
import { arrive, fresh, push, readJournal, replace, type Journal } from "./app/journal.ts";
import { PaneLayout, focusQuietly, paneCss, useSize, type Settle } from "./app/panes.tsx";
import { Btn, EmptyState, Look, ReadState } from "./app/ui.tsx";
import { RowMeta, useRowData } from "./app/row-meta.tsx";
import { decide, where, type TargetLike } from "./app/keys.ts";
import { dropPane, emitKeys, handlerFor, keyState, say } from "./app/key-state.ts";
import { ShortcutUi } from "./app/shortcut-help.tsx";
import { HowItWorks } from "./app/how-it-works.tsx";
import { TooltipProvider } from "./app/ui/tooltip.tsx";
import { PANEL_PATH } from "./app/open-proof.ts";
import { shownTabs } from "./app/hidden-tabs.ts";
import { MAIN, filterOfPath, navOf, placeOf } from "./app/nav.ts";
import { BottomBar, HOME_FILTERS, ICONS, PageSidebar, PlaceLinks } from "./app/page-nav.tsx";
import { ViewPicker } from "./app/view-picker.tsx";
import { pickerRowsOf } from "./app/picker-rows.ts";
import { Button } from "./app/ui/button.tsx";
import { useTouchPhone } from "./app/phone.ts";
import { Settings } from "lucide-react";
import { useChangeNotice } from "./app/change-listener.ts";
import { DeliverableIndexProvider, DeliverablePrefetch } from "./app/deliverable-prefetch.tsx";

// Deliverables first (what the owner reviews); the Board is "Activity", last (process, for when they want to look). Its id
// and sub-path stay "board", so links keep working.
const VIEWS = [
  // Home first (2026-11-20): the Feed is Home, at the bare page on web and phone; "feed" links redirect (RENAMED_VIEWS)
  { id: "home", subPath: "", label: "Home" },
  { id: "chat", subPath: "chat", label: "Chat" },
  // Scope (its Scoping group) and Pathways (a section of a project's page) are in Projects since 2026-11-20 (RENAMED_VIEWS)
  { id: "projects", subPath: "projects", label: "Projects" },
  // Requested 2026-11-16: the owner's open PRs, which need review, and the review ask to paste in Slack
  { id: "open-prs", subPath: "open-prs", label: "Open PRs" },
  // 2026-11-20 (the owner's card): Multiplayer, CodeRabbit, Cloud and Game Boy are hidden until used (app/hidden-tabs.ts)
  { id: "multiplayer", subPath: "multiplayer", label: "Multiplayer" },
  // 2026-11-18 (the owner's choice): the CodeRabbit review queue, from a contributor's public PR, as a tab of its own
  { id: "coderabbit", subPath: "coderabbit", label: "CodeRabbit" },
  // Requested 2026-11-13: Cloud Switch moved in as a tab; without a cloud config it says what to set up
  { id: "cloud", subPath: "cloud", label: "Cloud" },
  // Requested 2026-11-13: the emulator moved in too
  { id: "gameboy", subPath: "gameboy", label: "Game Boy" },
  { id: "rules", subPath: "rules", label: "Rules" },
  { id: "board", subPath: "board", label: "Activity" },
  { id: "how-it-works", subPath: "how-it-works", label: "How it works" },
] as const;
/** The four places (app/nav.ts): hiddenTabs never hides them */
const PLACES = new Set(MAIN.map((m) => m.id));
type ViewId = (typeof VIEWS)[number]["id"];
/** The feed's refetch waits this long after a change notice, so a burst of notices is one read. */
const FEED_DEBOUNCE_MS = 800;

function viewOf(subPath: string): ViewId {
  return fromPath(subPath, VIEWS).view as ViewId;
}

function useNeedsYou() {
  return experimental_useRpcQuery({ contract: rpcContract, method: "needsYou", input: { zone: ZONE } });
}

function useDeliverables() {
  return experimental_useRpcQuery({ contract: rpcContract, method: "deliverables", input: null });
}

function useScope() {
  return experimental_useRpcQuery({ contract: rpcContract, method: "scope", input: null });
}

// The badge and the page read needsYou, deliverables and scope through bb's one query cache (measured 2026-11-18: one
// fetch of each at load with both mounted). Both refetched them on every change notice, and bb's refetch restarts one in
// flight, so each went to the server twice. While the page is mounted its refetch serves the badge too.
let pagesMounted = 0;

/** The rail badge: only the owner's items (cards + interactions, deliverables in review, and the Scope tab's cards), null at 0. */
function useOrchestratorBadge(): ExperimentalBadge | null {
  const q = useNeedsYou();
  const dq = useDeliverables();
  const sq = useScope();
  const refetch = useRef(q.refetch);
  refetch.current = q.refetch;
  const drefetch = useRef(dq.refetch);
  drefetch.current = dq.refetch;
  const srefetch = useRef(sq.refetch);
  srefetch.current = sq.refetch;
  // live while the page is hidden too: the owner watches this badge from bb's other pages (change-listener.ts)
  useChangeNotice(
    useCallback((n: unknown) => {
      if (pagesMounted > 0) return;
      if (touches(n, "needsYou")) void refetch.current();
      if (touches(n, "deliverables")) void drefetch.current();
      if (touches(n, "scope")) void srefetch.current();
    }, []),
    { whileHidden: true },
  );
  const c = ownerCounts(q.data, expand(dq.data), sq.data);
  return c.total > 0 ? { count: c.total, label: ownerCountsLabel(c) } : null;
}

const LAYOUT_KEY = "orchestrator.layout.v2";
/** Before split panes (2026-11-20) each pane held only its view: read once, as that view's root. */
const LAYOUT_KEY_V1 = "orchestrator.layout.v1";
const JOURNAL_KEY = "orchestrator.journal.v1";
/** The Sidebar open or as its icon rail, per browser. */
const SIDEBAR_KEY = "orchestrator.sidebar.v1";
function loadRail(): boolean {
  try {
    // 2026-11-20 (the owner, "Left nav only"): the Sidebar is the page's navigation, open until the owner collapses it
    return localStorage.getItem(SIDEBAR_KEY) === "rail";
  } catch {
    return false;
  }
}
function saveRail(rail: boolean) {
  try {
    localStorage.setItem(SIDEBAR_KEY, rail ? "rail" : "open");
  } catch {
    // blocked storage: the choice lasts this visit only
  }
}

/** The saved layout (per viewer, in the browser); unreadable or stale gives null, and the page starts with one pane. */
function loadLayout(): Layout | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY) ?? localStorage.getItem(LAYOUT_KEY_V1);
    return raw ? parse(JSON.parse(raw), VIEWS) : null;
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
/** Back/Forward's journal (app/journal.ts): per tab, so it lives as long as the tab's own history. */
function loadJournal(): Journal | null {
  try {
    const raw = sessionStorage.getItem(JOURNAL_KEY);
    return raw ? readJournal(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
function saveJournal(j: Journal) {
  try {
    sessionStorage.setItem(JOURNAL_KEY, JSON.stringify(j));
  } catch {
    // blocked storage: Back still works until a reload
  }
}
/** A pane header's title: the page, or what it holds (Home's filter, the open project). */
const HINT_KEY = "orchestrator.hint.drag.v1";

function titleOf(r: Route): string {
  if (r.view === "home" && r.params.filter) return HOME_FILTERS.find((f) => f.id === r.params.filter)?.label ?? "Home";
  if (r.view === "projects" && r.path[0]) return r.path[0];
  return MAIN.find((m) => m.id === r.view)?.label ?? VIEWS.find((v) => v.id === r.view)?.label ?? r.view;
}

/** The open view picker: a split's new pane (drawn, never saved, until a pick) or a change of a pane's page. */
type Picking = { mode: "split"; from: string; drawn: Layout; id: string; opener: HTMLElement | null } | { mode: "change"; id: string; opener: HTMLElement | null };

/** What a key was pressed on, as keys.ts reads it. */
function targetOf(el: EventTarget | null): TargetLike {
  if (!(el instanceof HTMLElement)) return null;
  return { tagName: el.tagName, type: (el as HTMLInputElement).type, isContentEditable: el.isContentEditable, role: el.getAttribute("role"), insideRole: el.closest("[role=menu],[role=listbox]")?.getAttribute("role") ?? null, leave: (el.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && where({ tagName: "INPUT", type: (el as HTMLInputElement).type }) === "text")) && el.getAttribute("aria-expanded") !== "true" };
}

function OrchestratorPanel({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  // the URL as toPath writes it, so our own URLs, links and old spellings compare equal
  const here = canonical(subPath, VIEWS);
  // a ref, so each change in one event reads the last; a link lands in a pane, the bare page keeps the saved layout
  const lay = useRef<Layout | null>(null);
  if (!lay.current) {
    const saved = loadLayout() ?? single(fromPath(subPath, VIEWS));
    lay.current = subPath === "" ? saved : land(saved, fromPath(subPath, VIEWS), VIEWS).layout;
  }
  const jr = useRef<Journal | null>(null);
  if (!jr.current) {
    const j = loadJournal();
    jr.current = j && arrive(j, here).kind === "same" ? j : fresh(here);
  }
  const [, draw] = useReducer((n: number) => n + 1, 0);
  const commit = useCallback((next: Layout) => {
    if (next === lay.current) return;
    lay.current = next;
    saveLayout(next);
    draw();
  }, []);
  const layout = lay.current;
  // feel spec 1.5: the pending pane lives here beside the layout; storage, the URL and Back see the layout alone
  const [picking, setPicking] = useState<Picking | null>(null);
  const pickRef = useRef(picking);
  pickRef.current = picking;
  const drawn = picking?.mode === "split" ? picking.drawn : layout;
  const hereRef = useRef(here);
  hereRef.current = here;
  // the URLs we asked bb for and have not seen come back yet: their arrival is not a link or a Back
  const expected = useRef<{ url: string; at: number }[]>([]);
  const write = useCallback((url: string, how: "push" | "replace") => {
    if (url === hereRef.current) return;
    expected.current.push({ url, at: Date.now() });
    navigate.toPluginPanel(PANEL_PATH, { subPath: url, replace: how === "replace" });
  }, [navigate]);
  const journal = (j: Journal) => {
    jr.current = j;
    saveJournal(j);
  };
  /** The URL says the focused pane, without a new history entry. */
  const followFocus = () => {
    const f = findPane(lay.current!, lay.current!.focus);
    if (!f) return;
    const url = toPath(f.route, VIEWS);
    journal(replace(jr.current!, url));
    write(url, "replace");
  };
  /** Pane `paneId` goes to `route` and takes the focus. A push is one Back step; a replace (a filter, a correction) is none. */
  const act = (paneId: string, route: Route, how: "push" | "replace") => {
    const from = findPane(lay.current!, paneId)?.route;
    if (!from) return;
    commit(setRoute(lay.current!, paneId, route));
    const url = toPath(route, VIEWS);
    if (how === "push" && url !== hereRef.current && !samePlace(from, route, VIEWS)) {
      journal(push(jr.current!, url, { pane: paneId, from, to: route }));
      write(url, "push");
    } else followFocus();
  };
  const focusPane = (id: string) => {
    if (lay.current!.focus === id || !findPane(lay.current!, id)) return;
    commit({ ...lay.current!, focus: id });
    followFocus();
  };
  // A sub-path we did not write: Back or Forward (the journal says which pane, and which way), else a link
  useEffect(() => {
    const now = Date.now();
    const mine = expected.current.filter((e) => now - e.at < 5000);
    const i = mine.findIndex((e) => e.url === here);
    expected.current = i >= 0 ? mine.slice(i + 1) : mine;
    if (i >= 0) return;
    // Back, Forward or a link: a picker closes first (a pending split is cancelled)
    if (pickRef.current) cancelPick(false);
    const a = arrive(jr.current!, here);
    if (a.kind === "same") return;
    const l = lay.current!;
    if (a.kind !== "link" && findPane(l, a.step.pane)) {
      const r = a.kind === "back" ? a.step.from : a.step.to;
      commit(setRoute(l, a.step.pane, r));
      journal(a.journal);
      if (toPath(r, VIEWS) !== here) followFocus();
      return;
    }
    // a link (bb pushed an entry for it): the bare page keeps the layout; any other place lands in a pane
    if (here === "") journal(push(jr.current!, here, null));
    else {
      const to = fromPath(here, VIEWS);
      const { layout: next, pane } = land(l, to, VIEWS);
      const from = findPane(l, pane)!.route;
      commit(next);
      journal(samePlace(from, to, VIEWS) ? push(jr.current!, here, null) : push(jr.current!, here, { pane, from, to }));
    }
    const f = findPane(lay.current!, lay.current!.focus)!;
    if (toPath(f.route, VIEWS) !== here) followFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [here]);
  // the bare page, or a saved focus elsewhere: the URL says the focused pane from the start
  useEffect(() => {
    const f = findPane(lay.current!, lay.current!.focus);
    if (f && toPath(f.route, VIEWS) !== hereRef.current) followFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const root = useRef<HTMLDivElement>(null);
  const { w: width, h: height } = useSize(root);
  // bb's phone layout: the shared phone spacing (ui.tsx LOOK) keys on it
  const phone = useTouchPhone();
  const compact = width > 0 && width < 720;
  // The fit rule (spec §5, changed 2026-11-20 after the owner's "where did all the other tabs go"): the Sidebar is a rail
  // only by its toggle, never by itself, so its labels, Home's filters and Tools stay in view. Panes that don't fit
  // beside it show one at a time
  const [railChoice, setRailChoice] = useState(loadRail);
  const sideW = useRef({ open: 256, rail: 48 });
  const rail = !compact && railChoice;
  const sideNow = () => sideW.current[rail ? "rail" : "open"];
  const solo = compact || !fits(drawn, width - sideNow(), height);
  // a new pane refused for room: the one line says how to get more while the Sidebar is open
  const noRoom = () => say(rail ? "No room for another pane" : "No room for another pane. Collapse the Sidebar for more");
  useLayoutEffect(() => {
    const w = root.current?.querySelector("[data-page-sidebar]")?.getBoundingClientRect().width;
    if (!w || Math.round(w) === sideW.current[rail ? "rail" : "open"]) return;
    sideW.current = { ...sideW.current, [rail ? "rail" : "open"]: Math.round(w) };
    draw();
  });
  const shown = new Set(solo ? [findPane(layout, layout.focus)?.route.view] : panes(layout.root).map((p) => p.route.view));

  const needs = useNeedsYou();
  useEffect(() => {
    pagesMounted++;
    return () => {
      pagesMounted--;
    };
  }, []);
  const board = experimental_useRpcQuery({ contract: rpcContract, method: "board", input: null });
  const config = experimental_useRpcQuery({ contract: rpcContract, method: "config", input: null });
  // the Scope tab's chat reads its project's direct line from the projects read
  const projects = experimental_useRpcQuery({ contract: rpcContract, method: "projects", input: null, enabled: shown.has("projects") });
  // the Projects tab's lanes read the agents too
  const agents = experimental_useRpcQuery({ contract: rpcContract, method: "agents", input: null, enabled: shown.has("projects") });
  const deliverables = useDeliverables();
  // the list's slim rows as Deliverables (app/deliverable-data.ts): a card opened reads its deliverable whole
  const deliverablesAll = useMemo(() => expand(deliverables.data), [deliverables.data]);
  const scope = useScope();
  // the panes with an item open full screen (a phone): there the bottom bar and the pages row step aside
  const itemOpen = useRef(new Set<string>());
  const itemCbs = useRef(new Map<string, (open: boolean) => void>());
  const onItemOpen = (id: string) => {
    let f = itemCbs.current.get(id);
    if (!f) {
      f = (open: boolean) => {
        if (open === itemOpen.current.has(id)) return;
        if (open) itemOpen.current.add(id);
        else itemOpen.current.delete(id);
        draw();
      };
      itemCbs.current.set(id, f);
    }
    return f;
  };
  // the feed's first page: its own debounced refetch, paused while the page is in the background (scope "Risks")
  const feed = experimental_useRpcQuery({ contract: rpcContract, method: "feed", input: { cursor: null, filter: "all" } });
  const feedRefetch = useRef(feed.refetch);
  feedRefetch.current = feed.refetch;
  const feedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refetchFeed = useCallback(() => {
    clearTimeout(feedTimer.current);
    feedTimer.current = setTimeout(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void feedRefetch.current();
    }, FEED_DEBOUNCE_MS);
  }, []);
  useRealtime(
    CHANGED_CHANNEL,
    useCallback((n: unknown) => void (touches(n, "feed") && refetchFeed()), [refetchFeed]),
  );
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === "visible") void feedRefetch.current();
    };
    document.addEventListener("visibilitychange", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      clearTimeout(feedTimer.current);
    };
  }, []);
  const cloud = experimental_useRpcQuery({ contract: pageContract, method: "cs.available", input: null, enabled: shown.has("cloud") });
  const cloudOn = cloud.data?.available === true;
  // every count the page draws is a part of the rail badge's number (kit.ts ownerCounts), so they add up to it
  const owner = ownerCounts(needs.data, deliverablesAll, scope.data);
  const reviewCount = owner.delivered;
  // what waits in the Scope tab, as it lists it: its open cards and its projects' scoping deliverables to review
  const scopeWaiting = owner.scope;
  const latest = useRef({ needs, board, projects, agents, shown, deliverables, config, scope });
  latest.current = { needs, board, projects, agents, shown, deliverables, config, scope };
  // a change notice refetches the reads it touches (change-notice.ts); a write's own refresh (refetchAll) all of them
  // the badge's reads (ownerCounts: Needs you, Delivered, Scope) stay live while the page is hidden, the rest wait for it
  const refetchBadge = useCallback((n: unknown) => {
    const l = latest.current;
    if (touches(n, "deliverables")) void l.deliverables.refetch();
    if (touches(n, "needsYou")) void l.needs.refetch();
    if (touches(n, "scope")) void l.scope.refetch();
  }, []);
  const refetchRest = useCallback((n: unknown) => {
    const l = latest.current;
    if (touches(n, "config")) void l.config.refetch();
    if (touches(n, "board")) void l.board.refetch();
    if (l.shown.has("projects")) {
      if (touches(n, "projects")) void l.projects.refetch();
      if (touches(n, "agents")) void l.agents.refetch();
    }
  }, []);
  const refetchAll = useCallback(() => {
    refetchBadge(null);
    refetchRest(null);
  }, [refetchBadge, refetchRest]);
  // each agent's face (app/face.tsx): its Pokémon, and with a personas pack its person (2026-11-18)
  const mons = useMemo(() => new Map((board.data?.agents ?? []).map((a) => [a.address, { mon: a.mon, dex: a.dex, persona: a.persona }] as const)), [board.data]);
  // each project's accent type (accent.ts), from its agents: none with the pokemon setting off
  const accents = useMemo(() => new Map((board.data?.agents ?? []).filter((a) => a.project && a.monType).map((a) => [a.project!, a.monType] as const)), [board.data]);
  useChangeNotice(refetchBadge, { whileHidden: true });
  useChangeNotice(refetchRest);
  // a first board or a first CodeRabbit setup shows its tab without a reload
  const refetchConfig = useCallback(() => void latest.current.config.refetch(), []);
  useRealtime(MULTIPLAYER_CHANNEL, refetchConfig);
  useRealtime(QUEUE_CHANNEL, refetchConfig);

  // Keyboard shortcuts (2026-11-16, for a macropad): one listener, only while this page is drawn and has the focus. keys.ts
  // decides what a key is; the focused pane's view says what it does there. A key we act on is swallowed (so Esc closing
  // the cheat sheet does not also go back a page).
  // a Ctrl/Cmd+click inside a pane: the navigation it causes opens in the pane beside (read by render's `to`)
  const besideNext = useRef(0);
  const keyCtx = useRef({ views: [] as { id: string }[], act: (_p: string, _r: Route, _h: "push" | "replace") => {}, onFilter: (_f: FeedFilter) => {}, step: (_d: 1 | -1) => {}, splitKey: (_d: "row" | "col"): boolean => false, cancelPick: (_restore: boolean) => {} });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = root.current;
      if (!el || !el.isConnected || el.getClientRects().length === 0) return;
      // the picker's keys are its own; Esc closes it here, before keys.ts (Esc in a text box: blur) or bb sees it
      const inPicker = e.target instanceof Element && !!e.target.closest("[data-view-picker]");
      const inMenu = e.target instanceof Element && !!e.target.closest("[data-tools-menu], [data-rail-menu]");
      if (pickRef.current && !inMenu && (inPicker || e.key === "Escape")) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopImmediatePropagation();
          keyCtx.current.cancelPick(true);
        }
        return;
      }
      const active = document.activeElement;
      // focus is elsewhere in bb (the cheat sheet is a dialog drawn outside the panel: its keys are still ours)
      if (active && active !== document.body && !el.contains(active) && !active.closest("[data-key-help]")) return;
      const a = decide(e, targetOf(e.target), keyState.help);
      if (!a) return;
      const ctx = keyCtx.current;
      if (a.t !== "approve") keyState.arm = null;
      let done = true;
      if (a.t === "help") keyState.help = !keyState.help;
      else if (a.t === "close") keyState.help = false;
      else if (a.t === "blur") (document.activeElement as HTMLElement | null)?.blur();
      else if (a.t === "tab") {
        const f = filterOfPath(a.view);
        if (f) ctx.onFilter(f);
        else if (ctx.views.some((v) => v.id === a.view)) ctx.act(lay.current!.focus, rootOf(a.view), "push");
      } else if (a.t === "pane") ctx.step(a.dir);
      else if (a.t === "split") done = ctx.splitKey(a.dir);
      else if (a.t === "cos") {
        const box = el.querySelector<HTMLElement>("[data-cos-text]");
        if (box && !(box as HTMLTextAreaElement).disabled) box.focus();
      } else done = handlerFor(lay.current!.focus)?.(a) ?? false; // the focused pane's view, and only it
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
      deliverables: new Set((deliverablesAll ?? []).map((d) => d.id)),
      threads: live,
    };
  }, [board.data, needs.data, projects.data, config.data, deliverablesAll]);
  // Requested 2026-11-17: the hiddenTabs setting drops tabs by id or label (lower-cased by the server); it never hides them all
  const inUse = new Set(config.data?.shown ?? []);
  const visible = shownTabs(VIEWS, new Set(config.data?.hiddenTabs ?? []), scopeWaiting, new Set(panes(layout.root).map((p) => p.route.view)), inUse, PLACES);
  const nav = navOf(visible, inUse);
  // a pane left on a tab that is now hidden moves to the first visible tab
  useEffect(() => {
    const cur = lay.current!;
    const stale = panes(cur.root).filter((p) => !visible.some((v) => v.id === p.route.view));
    if (stale.length) commit({ ...stale.reduce((l, p) => setRoute(l, p.id, rootOf(visible[0]!.id)), cur), focus: cur.focus });
  });
  const views = visible.map((v) => ({ id: v.id, label: v.label }));
  // the nav's counts: Home's filters from the feed read, the rest as the tabs had them
  const newCount = feed.data && feed.data.newCount > 0 ? (feed.data.newCount >= 50 ? "50+" : feed.data.newCount) : undefined;
  const filterCounts = { all: newCount, needs: owner.needs || undefined, delivered: reviewCount || undefined, alerts: feed.data?.counts.alerts || undefined };
  const counts: Record<string, number | string | undefined> = {
    // what waits in its Scoping group (every unanswered card and deliverable to review, whole projects and tasks alike), else
    // a lead's note you haven't opened (PLAN 3.4); never a phone notification
    projects: scopeWaiting || (board.data?.directUnread?.length ? "•" : undefined),
  };
  const focused = findPane(layout, layout.focus) ?? panes(layout.root)[0]!;
  const focusedView = focused.route.view;
  const focusedFilter = (focusedView === "home" ? focused.route.params.filter : undefined) as FeedFilter | undefined;
  // the Sidebar, the bottom bar and Tools: the focused pane goes there; "Open beside" puts it in a second pane
  const go = (view: string) => (pickRef.current?.mode === "split" ? pick(rootOf(view)) : act(lay.current!.focus, rootOf(view), "push"));
  // a new pane only where every pane keeps its minimum beside the Sidebar as drawn; else one line says why
  const grow = (next: Layout): boolean => {
    if (next === lay.current || !fits(next, width - sideNow(), height)) {
      noRoom();
      return false;
    }
    // the shares are fitted to the room the panes will have beside the Sidebar as drawn, so nothing clamps a frame later
    commit(fitSizes(next, width - sideNow(), root.current?.querySelector<HTMLElement>("[data-panes]")?.clientHeight ?? height));
    followFocus();
    return true;
  };
  const roomFor = (next: Layout) => next !== lay.current && fits(next, width - sideNow(), height);
  const settle = useRef<Settle | null>(null);
  // the one-time drag hint (feel spec 3.4): until Got it or the first drop that lands, per browser
  const [hint, setHint] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) === null;
    } catch {
      return false;
    }
  });
  const hintDone = () => {
    setHint(false);
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      /* private mode: it shows again next time */
    }
  };
  // while a split waits for a pick, Open beside fills it: never a second new pane
  const openBeside = (view: string) => (pickRef.current?.mode === "split" ? pick(rootOf(view)) : grow(beside(lay.current!, rootOf(view))));
  // Ctrl/Cmd+click on an item in a pane: the pane to its right takes it, else a new pane there (spec §4)
  const openInBeside = (paneId: string, route: Route) => {
    const b = besideOf(lay.current!, paneId);
    if (b) act(b, route, "push");
    else grow(split(lay.current!, paneId, "row", route));
  };
  // a drop moves no pane off its minimum: a dock that wouldn't fit is refused, as a split is
  const onDock = (paneId: string, target: string, edge: Edge) => {
    settle.current = { ids: edge === "center" ? [paneId, target] : [paneId], kind: "move" };
    if (grow(dock(lay.current!, paneId, target, edge))) hintDone();
    else settle.current = null;
  };
  const canDock = (paneId: string, target: string, edge: Edge) => roomFor(dock(lay.current!, paneId, target, edge));
  const pendingId = () => (pickRef.current?.mode === "split" ? pickRef.current.id : null);
  const routeOfNav = (id: string): Route => (id.startsWith("home/") ? { view: "home", path: [], params: id === "home/all" ? {} : { filter: id.slice(5) } } : id === "home" ? rootOf("home") : rootOf(id));
  const onNavDrag = (e: React.PointerEvent, id: string) => {
    const route = routeOfNav(id);
    const name = titleOf(route);
    const row = e.currentTarget as HTMLElement;
    const here = (t: string) => titleOf(findPane(lay.current!, t)?.route ?? route);
    dragFrom(e, root.current?.querySelector<HTMLElement>("[data-panes]") ?? null, {
      label: name,
      icon: row.querySelector("svg"),
      dim: row.closest("li") ?? row,
      longPress: true,
      whole: (t) => t === pendingId(),
      can: (t, edge) => roomFor(dropAt(lay.current!, route, t, edge)),
      says: (t, edge) => (edge === "center" && t !== pendingId() ? `Replace ${here(t)} with ${name}` : `Open ${name} here`),
      // a Sidebar drag that leaves for another pane cancels a waiting split
      onEnter: (t) => {
        const p = pendingId();
        if (!p || t === p) return false;
        cancelPick(false);
        return true;
      },
      onDrop: (target, edge) => {
        if (target === pendingId()) pick(route);
        else if (edge === "center") act(target, route, "push");
        else {
          const before = new Set(panes(lay.current!.root).map((p) => p.id));
          const next = dropAt(lay.current!, route, target, edge);
          settle.current = { ids: panes(next.root).filter((p) => !before.has(p.id)).map((p) => p.id), kind: "new" };
          if (!grow(next)) return void (settle.current = null);
        }
        hintDone();
      },
    });
  };
  // [ and ]: the focus walks the panes in reading order; \ and -: split the focused pane (web only)
  const step = (d: 1 | -1) => {
    const all = panes(lay.current!.root);
    const i = all.findIndex((p) => p.id === lay.current!.focus);
    if (all.length > 1) focusPane(all[(i + d + all.length) % all.length]!.id);
  };
  const splitKey = (d: "row" | "col") => openSplit(lay.current!.focus, d, null);
  const filterRoute = (f: FeedFilter): Route => ({ view: "home", path: [], params: f === "all" ? {} : { filter: f } });
  const openBesideFilter = (f: FeedFilter) => (pickRef.current?.mode === "split" ? pick(filterRoute(f)) : grow(beside(lay.current!, filterRoute(f))));
  // a Home filter: the focused pane goes to Home with it (a new step only when it was on another page)
  const onFilter = (f: FeedFilter) => {
    if (pickRef.current?.mode === "split") return pick(filterRoute(f));
    const p = findPane(lay.current!, lay.current!.focus)!;
    act(p.id, { view: "home", path: [], params: f === "all" ? {} : { filter: f } }, p.route.view === "home" ? "replace" : "push");
  };
  // a phone opens on Needs you (2026-11-21, the owner: "mostly you're still living in 'needs you' and 'delivered'"); a
  // link names its own place, and the web keeps its saved layout
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !compact) return;
    landed.current = true;
    if (hereRef.current !== "") return;
    const p = findPane(lay.current!, lay.current!.focus);
    if (p && !(p.route.view === "home" && p.route.params.filter === "needs")) act(p.id, filterRoute("needs"), "replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact]);

  // The view picker (feel spec part 1). Its rows are the Sidebar's: nav.main with its icons, then Tools without "Set up"
  const pickerRows = pickerRowsOf(nav, ICONS, HOME_FILTERS);
  /** The row a page is on: its own, else its place's (Multiplayer: Reviews), else none. */
  const rowOf = (view: string): string | null => {
    const ids = [...pickerRows.main, ...pickerRows.tools].map((r) => r.id);
    return ids.includes(view) ? view : ids.includes(placeOf(view)) ? placeOf(view) : null;
  };
  const paneEl = (id: string) => root.current?.querySelector<HTMLElement>(`[data-pane="${CSS.escape(id)}"]`) ?? null;
  // the focus goes into the pane after a pick, unless its page already took it (Chat's box)
  const focusInto = (id: string) =>
    requestAnimationFrame(() => {
      const el = paneEl(id);
      if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    });
  /** Split: the new pane shows at once, empty, with the picker; nothing is saved until a pick. Refused when it can't fit. */
  function openSplit(from: string, dir: "row" | "col", opener: HTMLElement | null): boolean {
    if (compact) return false;
    const src = findPane(lay.current!, from);
    if (!src) return false;
    const next = split(lay.current!, from, dir, src.route);
    if (next === lay.current || !fits(next, width - sideNow(), height)) {
      noRoom();
      return true;
    }
    setPicking({ mode: "split", from, drawn: next, id: next.focus, opener });
    return true;
  }
  /** Esc and ✕ put the focus back where the picker came from; a press outside leaves it where it landed. */
  function cancelPick(restore: boolean) {
    const p = pickRef.current;
    if (!p) return;
    pickRef.current = null;
    setPicking(null);
    if (!restore) return;
    const back = p.opener?.isConnected ? p.opener : paneEl(p.mode === "split" ? p.from : p.id);
    requestAnimationFrame(() => focusQuietly(back));
  }
  /** A pick: the pending pane takes the page (as Open beside does), or the pane changes in place (a Sidebar click on it). */
  function pick(route: Route) {
    const p = pickRef.current;
    if (!p) return;
    pickRef.current = null;
    setPicking(null);
    if (p.mode === "split") {
      commit(setRoute(p.drawn, p.id, route));
      followFocus();
    } else act(p.id, route, "push");
    focusInto(p.id);
  }
  const onView = (paneId: string, from: HTMLElement) => {
    const p = pickRef.current;
    if (p?.mode === "change" && p.id === paneId) return cancelPick(true);
    focusPane(paneId);
    setPicking({ mode: "change", id: paneId, opener: from });
  };
  // a window that no longer fits the pending pane cancels it
  useEffect(() => {
    if (picking?.mode === "split" && width > 0 && (compact || !fits(picking.drawn, width - sideNow(), height))) cancelPick(false);
  });
  // a press outside dismisses it: outside the card and, for a split, outside the new pane and the Sidebar (its menus too)
  useEffect(() => {
    if (!picking) return;
    const down = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element) || t.closest("[data-view-picker]")) return;
      if (picking.mode === "split") {
        if (t.closest(`[data-pane="${CSS.escape(picking.id)}"]`)) {
          requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("[data-picker-input]")?.focus());
          return;
        }
        if (t.closest("[data-page-sidebar], [data-tools-menu], [data-rail-menu]")) return;
      } else if (picking.opener?.contains(t)) return;
      cancelPick(false);
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking]);
  const pickerNode = picking
    ? (() => {
        const view = picking.mode === "split" ? findPane(lay.current!, picking.from)?.route.view : findPane(lay.current!, picking.id)?.route.view;
        const at = view ? rowOf(view) : null;
        return (
          <ViewPicker
            key={`${picking.mode}:${picking.id}`}
            mode={picking.mode}
            rows={pickerRows}
            start={at}
            current={picking.mode === "change" ? at : null}
            onPick={(id) => pick(routeOfNav(id))}
            onCancel={() => cancelPick(true)}
          />
        );
      })()
    : null;

  keyCtx.current = { views, act, onFilter, step, splitKey, cancelPick };
  const phoneNav = compact && !itemOpen.current.has(layout.focus);

  // a lane's "waits on you": Needs you in the focused pane, then that card scrolled into sight once it is drawn. A
  // scoping project's card waits on its scoping entry's page in Projects instead.
  const openCard = (selector: string) => {
    const id = /data-card="([^"]+)"/.exec(selector)?.[1];
    const scoping = id ? scope.data?.projects.find((p) => p.cards.some((c) => c.id === id)) : undefined;
    if (scoping) act(lay.current!.focus, { view: "projects", path: [], params: { scope: scopeEntryOf(scoping, scoping.cards.find((c) => c.id === id)?.scopeTask) } }, "push");
    else act(lay.current!.focus, { view: "home", path: [], params: { filter: "needs" } }, "push");
    let tries = 0;
    const find = () => {
      const el = root.current?.querySelector(`[data-pane="${CSS.escape(lay.current!.focus)}"]`)?.querySelector<HTMLElement>(selector);
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      else if (++tries < 40) setTimeout(find, 100);
    };
    setTimeout(find, 0);
  };

  // each pane's view, from its own route: Home's filter and item, the open project or board are the pane's, not the page's
  const render = ({ id, route, width }: { id: string; route: Route; width: number }) => {
    const to = (r: Route, how: "push" | "replace" = "push") => (how === "push" && besideNext.current && Date.now() - besideNext.current < 1000 ? ((besideNext.current = 0), openInBeside(id, r)) : act(id, r, how));
    switch (route.view) {
      case "home": {
        const filter = (route.params.filter ?? "all") as FeedFilter;
        return (
          <FeedView
            q={feed}
            filter={filter}
            item={route.params.item ?? null}
            onItem={(key) => to({ view: "home", path: [], params: { ...(route.params.filter ? { filter: route.params.filter } : {}), ...(key ? { item: key } : {}) } })}
            body={filter === "needs" ? <NeedsYouView q={needs} refetchAll={refetchAll} mons={mons} threads={threads} accents={accents} /> : filter === "delivered" ? <DeliverablesView q={deliverables} refetchAll={refetchAll} files={route.params.files === "1"} /> : undefined}
            onItemOpen={onItemOpen(id)}
            width={width}
            agents={board.data?.agents}
            needs={needs.data}
            deliverables={deliverablesAll}
            refetch={() => void feed.refetch()}
            refetchAll={refetchAll}
            onOpenProject={(slug) => to({ view: "projects", path: [slug], params: {} })}
            onChat={() => to(rootOf("chat"))}
          />
        );
      }
      case "chat":
        return <CosChat agents={board.data?.agents} width={width} />;
      case "projects":
        return <ProjectsView q={projects} refetchAll={refetchAll} agents={board.data?.agents} lanesFrom={agents.data} needs={needs.data} openCard={openCard} detail={route.path[0] ?? null} picked={route.params.open ?? null} onPick={(slug) => to({ view: "projects", path: [], params: slug ? { open: slug } : {} })} onDetail={(slug) => to({ view: "projects", path: slug ? [slug] : [], params: {} })} refs={refs} scope={scope} scopeOpen={route.params.scope ?? null} onScope={(key) => to({ view: "projects", path: [], params: key ? { scope: key } : {} })} pathwaysOpen={route.params.pathways === "1"} deliverables={deliverablesAll} mons={mons} accents={accents} board={route.params.board ? { project: route.params.in ?? null, task: route.params.task ?? null } : null} onBoard={(b, how) => to({ view: "projects", path: [], params: b ? { board: "1", ...(b.project ? { in: b.project } : {}), ...(b.task ? { task: b.task } : {}) } : {} }, how)} />;
      case "open-prs":
        return <ReviewsView shown={new Set(visible.map((v) => v.id))} multiplayer={() => <TeamBoards onOpen={(board) => to({ view: "multiplayer", path: [board], params: {} })} />} coderabbit={() => <ReviewQueueView />} />;
      case "multiplayer": {
        // a board's own page: multiplayer/<id>, as Reviews' Team boards link it
        const boardLink = route.path[0] ?? null;
        return <MultiplayerTab key={boardLink ?? ""} initial={boardLink} deliverables={deliverablesAll} refetchAll={refetchAll} openCard={(card) => openCard(`[data-card="${CSS.escape(card)}"]`)} />;
      }
      case "coderabbit":
        return <ReviewQueueView />;
      case "board":
        return <BoardView q={board} refetchAll={refetchAll} />;
      case "rules":
        return <RulesView q={board} refetchAll={refetchAll} />;
      case "how-it-works":
        return <HowItWorks />;
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
    {/* one provider for every shadcn Tooltip on the page (2026-11-17) */}
    <TooltipProvider>
    <DeliverableIndexProvider>
    <div ref={root} data-orch="" data-view={focusedView} data-phone={phone || undefined} onPointerDownCapture={pointerPressed} onClickCapture={(e) => (besideNext.current = !compact && (e.metaKey || e.ctrlKey) ? Date.now() : 0)} className="flex h-full min-h-0 flex-1 flex-col">
      <Look />
      <style href={styleHref("orch-panes", paneCss)} precedence="default">
        {paneCss}
      </style>
      <VisualBlocksStyle />
      <ShortcutUi />
      <DeliverablePrefetch />
      <div className="flex min-h-0 flex-1">
        {!compact ? <PageSidebar nav={nav} view={picking?.mode === "split" ? "" : focusedView} filter={focusedFilter ?? "all"} filterCounts={filterCounts} counts={counts} rail={rail} onToggle={() => {
              setRailChoice(!rail);
              saveRail(!rail);
            }} onGo={go} onFilter={onFilter} onBeside={openBeside} onBesideFilter={openBesideFilter} onDrag={onNavDrag} /> : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {phoneNav ? <PlaceLinks nav={nav} view={focusedView} onGo={go} /> : null}
          <div className="flex min-h-0 flex-1">
            <PaneLayout
              layout={drawn}
              solo={solo}
              title={titleOf}
              render={render}
              fill={(v) => v === "home" || v === "chat" || v === "cloud" || v === "gameboy"}
              wide={(v) => v === "projects" || v === "deliverables" || v === "open-prs" || v === "multiplayer" || v === "coderabbit"}
              onFocus={focusPane}
              onClose={(id) => {
                commit(close(lay.current!, id));
                dropPane(id);
                followFocus();
              }}
              onSplit={(id, dir, from) => openSplit(id, dir, from)}
              icon={(r) => {
                const id = rowOf(r.view);
                return (id && ICONS[id]) || <Settings />;
              }}
              onView={onView}
              pending={picking?.mode === "split" ? picking.id : null}
              overlay={picking ? { paneId: picking.id, node: pickerNode } : null}
              onCancelPending={() => cancelPick(true)}
              onSizes={(sid, sizes) => commit(setSizes(lay.current!, sid, sizes))}
              onDock={onDock}
              canDock={canDock}
              onDragStart={() => pendingId() && cancelPick(false)}
              settle={settle}
              hint={hint}
              onHintDone={hintDone}
            />
          </div>
          {phoneNav ? <BottomBar nav={nav} view={focusedView} filter={focusedFilter ?? "all"} counts={{ needs: owner.needs, delivered: owner.delivered, projects: owner.scope }} onGo={go} onFilter={onFilter} /> : null}
        </div>
      </div>
    </div>
    </DeliverableIndexProvider>
    </TooltipProvider>
    </IdentityContext.Provider>
  );
}

/** bb's title bar names the place: "Orchestrator Home" (the SDK's page title). */
function usePageTitle({ subPath }: PluginNavPanelProps) {
  const view = viewOf(subPath);
  return { title: MAIN.find((m) => m.id === view)?.label ?? VIEWS.find((v) => v.id === view)?.label ?? "Home" };
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "orchestrator",
    title: "Orchestrator",
    icon: "Workflow", // Requested 2026-11-14: a neutral icon, even with Pokémon on (a built-in bb glyph)
    path: PANEL_PATH,
    component: OrchestratorPanel,
    experimental_useBadge: useOrchestratorBadge,
    experimental_usePageTitle: usePageTitle,
  });
  // the sidebar: each role agent's Pokémon, role and priority under its thread title
  app.slots.experimental_threadRowMetadata({ id: "agent", order: 0, useData: useRowData, component: RowMeta });
  // Requested 2026-11-13: change a project's priority from its lead's sidebar row (right-click → Priority)
  app.experimental_icons.register({ name: PRIORITY_ICON, component: PriorityIcon });
  app.slots.experimental_threadAction(priorityAction);
  app.experimental_icons.register({ name: ARCHIVE_PROJECT_ICON, component: ArchiveProjectIcon });
  app.slots.experimental_threadAction(archiveProjectAction);
});
