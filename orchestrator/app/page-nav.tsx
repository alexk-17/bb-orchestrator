// The page's navigation (Home first, step 2, 2026-11-20): shadcn's Sidebar on web; on a phone a bottom bar (a plugin part, no shadcn equivalent) and ⚙ Tools.
import type { CSSProperties, MouseEvent, PointerEvent, ReactNode } from "react";
import { Columns2, Ellipsis, FolderKanban, GitPullRequest, GripVertical, House, Inbox, MessageCircle, PackageCheck, PanelLeft, Settings } from "lucide-react";
import type { FeedFilter } from "./feed.tsx";
import { placeOf, type Nav, type NavLink, type NavMain } from "./nav.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Separator } from "./ui/separator.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu.tsx";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider } from "./ui/sidebar.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import { cn } from "./ui/utils.ts";

export const HOME_FILTERS: { id: FeedFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs you" },
  { id: "delivered", label: "Delivered" },
  { id: "alerts", label: "Alerts" },
];
export const ICONS: Record<string, ReactNode> = { home: <House />, chat: <MessageCircle />, projects: <FolderKanban />, "open-prs": <GitPullRequest /> };
type Count = number | string | undefined;
/** Open beside shows on hover with a mouse, and always on touch, where nothing hovers. */
const TOUCH_SHOWN = "[@media(pointer:coarse)]:opacity-100!";
/** A row is a drag source too (feel spec 3.2): no text selection, no touch callout */
const SOURCE = "select-none [-webkit-touch-callout:none]";
const BESIDE_TIP = "Open beside, or drag into a pane";
/** The hover cue that a row drags: a grip in its left padding, open Sidebar only (the rail has no room) */
function RowGrip({ id, group }: { id: string; group: "item" | "sub" }) {
  return (
    <GripVertical
      aria-hidden
      data-nav-grip={id}
      className={cn(
        "pointer-events-none absolute top-1/2 left-0 size-3 -translate-x-1/2 -translate-y-1/2 text-muted-foreground opacity-0 group-data-[collapsible=icon]:hidden [@media(pointer:coarse)]:hidden",
        group === "item" ? "group-hover/menu-item:opacity-100" : "group-hover/menu-sub-item:opacity-100",
      )}
    />
  );
}
/** Ctrl/Cmd+click opens the item in a pane beside (spec §4). */
const besideClick = (e: MouseEvent) => e.metaKey || e.ctrlKey;

function SubLink({ active, count, onClick, onBeside, onDrag, besideLabel, children, ...data }: { active: boolean; count?: Count; onClick: () => void; onBeside?: () => void; onDrag?: (e: PointerEvent) => void; besideLabel?: string; children: ReactNode; [d: `data-${string}`]: string | undefined }) {
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton asChild isActive={active} className="data-[active=true]:font-medium">
        <Button type="button" variant="ghost" className={cn("w-full justify-start font-normal", SOURCE, onBeside && "pr-8")} aria-current={active ? "page" : undefined} onClick={(e) => (onBeside && besideClick(e) ? onBeside() : onClick())} onPointerDown={onDrag} {...data}>
          <span className="min-w-0 flex-1 truncate text-left">{children}</span>
          {count ? <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span> : null}
        </Button>
      </SidebarMenuSubButton>
      {onDrag ? <RowGrip id={data["data-feed-filter"] ? `home/${data["data-feed-filter"]}` : (data["data-nav"] ?? "")} group="sub" /> : null}
      {onBeside ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label={besideLabel} data-beside={data["data-feed-filter"] ? `home/${data["data-feed-filter"]}` : data["data-nav"]} onClick={onBeside} className={cn("absolute top-1/2 right-0.5 size-6 -translate-y-1/2 opacity-0 group-hover/menu-sub-item:opacity-100 focus-visible:opacity-100 [&_svg:not([class*='size-'])]:size-3.5", TOUCH_SHOWN)}>
              <Columns2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{BESIDE_TIP}</TooltipContent>
        </Tooltip>
      ) : null}
    </SidebarMenuSubItem>
  );
}

/** ⚙ Tools: Rules, Activity, Cloud and Game Boy when on, How it works, and the way in to an unused Multiplayer or CodeRabbit. */
export function ToolsMenu({ tools, more, onGo, trigger, side = "top" }: { tools: NavLink[]; more?: NavLink[]; onGo: (id: string) => void; trigger: ReactNode; side?: "top" | "bottom" }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align="start" className="min-w-48" data-tools-menu="">
        {more?.length ? (
          <>
            <DropdownMenuGroup>
              {more.map((t) => (
                <DropdownMenuItem key={t.id} data-tool={t.id} onSelect={() => onGo(t.id)}>
                  {t.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuLabel className="text-xs text-muted-foreground">Tools</DropdownMenuLabel>
        {tools.map((t) => (
          <DropdownMenuItem key={t.id} data-tool={t.id} onSelect={() => onGo(t.id)}>
            {t.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function PageSidebar({ nav, view, filter, filterCounts, counts, rail, onToggle, onGo, onFilter, onBeside, onBesideFilter, onDrag }: {
  nav: Nav;
  /** The focused pane's view */
  view: string;
  filter: FeedFilter;
  filterCounts: Partial<Record<FeedFilter, Count>>;
  counts: Record<string, Count>;
  onGo: (id: string) => void;
  onFilter: (f: FeedFilter) => void;
  onBeside: (id: string) => void;
  onBesideFilter: (f: FeedFilter) => void;
  /** A press on an item that may become a drag onto a pane: a place's id, or "home/<filter>" */
  onDrag: (e: PointerEvent, id: string) => void;
  /** The icon rail (by its toggle, or by itself when panes need the room) */
  rail: boolean;
  onToggle: () => void;
}) {
  // a place's pages, then its sections in use (Reviews: Multiplayer, CodeRabbit), each its own item
  const subsOf = (m: NavMain) => [...m.subs, ...(nav.sections[m.id] ?? [])];
  const homeButton = (m: NavMain) => (
    <SidebarMenuButton type="button" tooltip={rail ? m.label : undefined} isActive={m.id !== "home" ? view === m.id : rail && view === "home"} className={cn(SOURCE, "pr-8")} data-nav={m.id} onPointerDown={(e) => onDrag(e, m.id)} onClick={rail && m.id === "home" ? undefined : (e) => (besideClick(e) ? onBeside(m.id) : m.id === "home" ? onFilter("all") : onGo(m.id))}>
      {ICONS[m.id]}
      <span>{m.label}</span>
    </SidebarMenuButton>
  );
  return (
    <SidebarProvider open={!rail} className="min-h-0 w-auto shrink-0" style={{ "--sidebar-width": "14rem" } as CSSProperties}>
      {/* the rail in the page's flow: shadcn's icon look from data-collapsible, without its fixed, full-height sidebar */}
      <div className="group flex min-h-0" data-collapsible={rail ? "icon" : ""} data-state={rail ? "collapsed" : "expanded"}>
      <Sidebar collapsible="none" aria-label="Orchestrator" className={cn("border-r", rail && "w-(--sidebar-width-icon)")} data-page-sidebar="" data-rail={rail || undefined}>
        <SidebarHeader className="pb-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton type="button" tooltip={rail ? "Expand sidebar" : undefined} aria-label={rail ? "Expand sidebar" : "Collapse sidebar"} data-sidebar-toggle="" onClick={onToggle} className="text-muted-foreground">
                <PanelLeft />
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              {nav.main.map((m) => (
                <SidebarMenuItem key={m.id}>
                  {rail && m.id === "home" ? (
                    // in the rail Home's filters are a small menu; the other places go straight to their page
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>{homeButton(m)}</DropdownMenuTrigger>
                      <DropdownMenuContent side="right" align="start" className="min-w-40" data-rail-menu="home">
                        {HOME_FILTERS.map((f) => (
                          <DropdownMenuItem key={f.id} data-feed-filter={f.id} onSelect={() => onFilter(f.id)}>
                            <span className="flex-1">{f.label}</span>
                            {filterCounts[f.id] ? <span className="text-xs text-muted-foreground tabular-nums">{filterCounts[f.id]}</span> : null}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    homeButton(m)
                  )}
                  {counts[m.id] ? <SidebarMenuBadge className="font-normal text-muted-foreground group-hover/menu-item:opacity-0 [@media(pointer:coarse)]:right-8">{counts[m.id]}</SidebarMenuBadge> : null}
                  <RowGrip id={m.id} group="item" />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SidebarMenuAction showOnHover aria-label={`Open ${m.label} beside`} data-beside={m.id} onClick={() => onBeside(m.id)} className={TOUCH_SHOWN}>
                        <Columns2 />
                      </SidebarMenuAction>
                    </TooltipTrigger>
                    <TooltipContent side="right">{BESIDE_TIP}</TooltipContent>
                  </Tooltip>
                  {m.id === "home" || subsOf(m).length ? (
                    <SidebarMenuSub>
                      {m.id === "home"
                        ? HOME_FILTERS.map((f) => (
                            <SubLink key={f.id} active={view === "home" && filter === f.id} count={filterCounts[f.id]} onClick={() => onFilter(f.id)} onBeside={() => onBesideFilter(f.id)} onDrag={(e) => onDrag(e, `home/${f.id}`)} besideLabel={`Open ${f.label} beside`} data-feed-filter={f.id}>
                              {f.label}
                            </SubLink>
                          ))
                        : null}
                      {m.id === "home" && subsOf(m).length ? (
                        <li aria-hidden className="py-1">
                          <Separator />
                        </li>
                      ) : null}
                      {subsOf(m).map((s) => (
                        <SubLink key={s.id} active={view === s.id} count={counts[s.id]} onClick={() => onGo(s.id)} onBeside={() => onBeside(s.id)} onDrag={(e) => onDrag(e, s.id)} besideLabel={`Open ${s.label} beside`} data-nav={s.id}>
                          {s.label}
                        </SubLink>
                      ))}
                    </SidebarMenuSub>
                  ) : null}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
          {/* the open Sidebar shows Tools as a group, every item in view (the owner, "Left nav only", 2026-11-20) */}
          {!rail ? (
            <SidebarGroup data-tools-group="">
              <SidebarGroupLabel>Tools</SidebarGroupLabel>
              <SidebarMenu>
                {nav.tools.map((t) => (
                  <SidebarMenuItem key={t.id}>
                    <SidebarMenuButton type="button" isActive={view === t.id} data-tool={t.id} onClick={() => onGo(t.id)}>
                      <span>{t.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          ) : null}
        </SidebarContent>
        <SidebarFooter className={rail ? undefined : "hidden"}>
          <SidebarMenu>
            <SidebarMenuItem>
              <ToolsMenu
                tools={nav.tools}
                onGo={onGo}
                trigger={
                  <SidebarMenuButton type="button" tooltip={rail ? "Tools" : undefined} isActive={view !== "" && placeOf(view) === "tools"} data-nav="tools">
                    <Settings />
                    <span>Tools</span>
                  </SidebarMenuButton>
                }
              />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      </div>
    </SidebarProvider>
  );
}

/** What the phone bar's More holds: the feed and Alerts (Home's other filters), Reviews and its sections in use. */
export function phoneMore(nav: Nav): NavLink[] {
  return [{ id: "home/all", label: "Feed" }, { id: "home/alerts", label: "Alerts" }, { id: "open-prs", label: "Reviews" }, ...(nav.sections["open-prs"] ?? [])];
}

/**
 * The phone's bar (2026-11-21, the owner: "mostly you're still living in 'needs you' and 'delivered'", and "the 'needs
 * you' notifications on 'delivered' need to be showing"): Needs you and Delivered first, each with its count, then
 * Projects (its Scope count) and Chat, then More (the feed, Alerts, Reviews and Tools; Tools left bb's title bar for it).
 * The three counts are the parts of the rail badge's number (kit.ts ownerCounts). The icons sit 8 px under the top border
 * (the owner: "there's no padding on top"). Not drawn while an item is open full screen. A standard tab bar: 48 px buttons and a 1 px border, and no safe-area padding of its own:
 * bb's app shell already pads the bottom inset under every page (padding it here too left 34 px inside the bar and 34 px
 * of empty strip under it on an iPhone).
 */
export function BottomBar({ nav, view, filter, counts, onGo, onFilter }: { nav: Nav; view: string; filter: FeedFilter; counts: { needs: number; delivered: number; projects: number }; onGo: (id: string) => void; onFilter: (f: FeedFilter) => void }) {
  const place = placeOf(view);
  const on = (f: FeedFilter) => view === "home" && filter === f;
  const tabs: { id: string; label: string; icon: ReactNode; count: number; active: boolean; go: () => void }[] = [
    { id: "needs", label: "Needs you", icon: <Inbox />, count: counts.needs, active: on("needs"), go: () => onFilter("needs") },
    { id: "delivered", label: "Delivered", icon: <PackageCheck />, count: counts.delivered, active: on("delivered"), go: () => onFilter("delivered") },
    { id: "projects", label: "Projects", icon: ICONS.projects, count: counts.projects, active: place === "projects", go: () => onGo("projects") },
    { id: "chat", label: "Chat", icon: ICONS.chat, count: 0, active: place === "chat", go: () => onGo("chat") },
  ];
  const moreOn = !tabs.some((t) => t.active);
  const pick = (id: string) => (id.startsWith("home/") ? onFilter(id.slice(5) as FeedFilter) : onGo(id));
  const cell = (active: boolean) => `relative h-12 w-full min-w-0 flex-col justify-start gap-0.5 rounded-none px-0 pt-2 pb-0 text-[11px] leading-4 font-normal [&_svg:not([class*='size-'])]:size-5 ${active ? "text-foreground" : "text-muted-foreground"}`;
  return (
    <nav aria-label="Orchestrator" data-bottom-bar="" className="grid shrink-0 grid-cols-5 border-t bg-background">
      {tabs.map((t) => (
        <Button key={t.id} type="button" variant="ghost" data-nav={t.id} aria-current={t.active ? "page" : undefined} onClick={t.go} className={cell(t.active)}>
          <span className="relative">
            {t.icon}
            {t.count > 0 ? (
              <Badge variant={t.id === "needs" ? "destructive" : "default"} className="absolute -top-1.5 -right-2.5 h-4 min-w-4 rounded-full px-1 text-[10px] tabular-nums" data-bottom-count={t.id}>
                {t.count}
              </Badge>
            ) : null}
          </span>
          {t.label}
        </Button>
      ))}
      <ToolsMenu
        tools={nav.tools}
        more={phoneMore(nav)}
        side="top"
        onGo={pick}
        trigger={
          <Button type="button" variant="ghost" data-nav="more" aria-current={moreOn ? "page" : undefined} className={cell(moreOn)}>
            <Ellipsis />
            More
          </Button>
        }
      />
    </nav>
  );
}

/** A phone has no Sidebar: a place's pages (until step 3 folds them in) sit in a row at the top of its page. */
export function PlaceLinks({ nav, view, onGo }: { nav: Nav; view: string; onGo: (id: string) => void }) {
  const place = nav.main.find((m) => m.id === placeOf(view));
  if (!place || !place.subs.length) return null;
  return (
    <nav aria-label={`${place.label} pages`} data-place-links={place.id} className="flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-1 [scrollbar-width:none]">
      {[{ id: place.id, label: place.label }, ...place.subs].map((l) => (
        <Button key={l.id} type="button" variant="ghost" size="sm" data-nav={l.id} aria-current={view === l.id ? "page" : undefined} onClick={() => onGo(l.id)} className={view === l.id ? "bg-muted font-medium" : "font-normal text-muted-foreground"}>
          {l.label}
        </Button>
      ))}
    </nav>
  );
}
