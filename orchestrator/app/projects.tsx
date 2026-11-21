// Projects (layout B, 2026-11-16; the components of 2026-11-17, thread orchestrator:40's approved mockups): the list on the
// left, the selected project on the right, the message box under its name, no top strip. A list row is the project's
// lead, its name, one state chip (kit.ts STATE_CHIP), the one number that matters as a chip, and the status's age; quiet
// projects are one dim line. The detail (project-book.tsx) is section cards: Pinned, the goal, Needs | Blocked, then
// Now | PRs + Record, then Timeline, Flow, Dependencies and Pathways (2026-11-20). Under 1200 px the same rows make one
// column and a tapped row opens the project's page, with a Back row. Scoping entries are a group on top (Scope folded in).
// Priority, Hold, Archive and "Pin a document…" are in the ⋯ menu; archived projects sit behind a toggle. Above them, the
// standing agents on one line. The writes go through the page gate (store.ts), like every other.
//
// The Agents tab went on 2026-11-16: what only it showed (unread, level, context window) is on the thread cards now,
// and a live thread's branch on its project's Flow view.
// 2026-11-17 (the shadcn pass): the rows are Items, the filters a ToggleGroup (32 px), the ⋯ app/ui's DropdownMenu with a
// priority submenu, Archive's confirm an AlertDialog, and every button a Button.
import { styleHref } from "./style-href.ts";
import { useElementWidth, usePaneFits } from "./panes.tsx";
import { usePaneId } from "./key-state.ts";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import type { z } from "zod";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { WRITES, type Agents, type Board, type Deliverables, type NeedsYou, type Projects, type Scope, type archiveProjectBody, type directMessageBody, type holdBody, type priorityBody, type projectModeBody, type roleStartBody, type startLeadBody } from "../contract.ts";
import { ASK_STATUS_TEXT, FILTERS, FILTER_WORD, attentionOrder, isQuiet, leadHead, matches, statusStale, waitLine, type Filter } from "./command-center.ts";
import { ccCss } from "./cc-lines.tsx";
import { INLINE_LINK, ProjectRefs, RefsContext, refCss, type SharedRefs } from "./ref-text.tsx";
import { ChatCard, ChatLog, Composer, directCss, markSeen } from "./direct-line.tsx";
import { useHeadFit } from "./head-fit.ts";
import { useMinute } from "./status-bar.tsx";
import { ChevronDown, ChevronLeft, ChevronRight, Crosshair, Ellipsis, Pin } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "./ui/dropdown-menu.tsx";
import { Item } from "./ui/item.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
import { cn } from "./ui/utils.ts";
import { AgentFace, ProfileCard, StandingFace, type Face as FaceOf } from "./face.tsx";
import { partyOf } from "./faces.ts";
import { PRIORITIES, PRIORITY_TONES, css, type Priority } from "./palette.ts";
import { accentText, accentVars } from "./accent.ts";
import { gate, useGate, write } from "./store.ts";
import { Btn, EmptyState, PageError, ReadState, cx, when } from "./ui.tsx";
import { useIdentity } from "./identity.ts";
import { buildLanes, type Lane } from "./lanes.ts";
import { ownerOnScreen } from "../core/owner.ts";
import { PathwaysPart, ProjectDetail, ProjectSections } from "./project-detail.tsx";
import { ScopeView, ScopingRows } from "./scope.tsx";
import { PANEL_PATH } from "./open-proof.ts";
import { useTouchPhone } from "./phone.ts";
import { ProjectBook, bookCss } from "./project-book.tsx";
import { SearchBox, SearchHits, searchCss, useSettled } from "./search.tsx";
import { filterHides, isWide, searchLoaded, searchedProjects } from "./source.ts";
import { listRow, needCount, projectScopeAction, projectState, STATE_CHIP, tasksScoping } from "./kit.ts";
import { Chip, Icon, kitCss } from "./kit-ui.tsx";

import { threadCss } from "./thread-card.tsx";
import { pinsCss } from "./pins.tsx";

type Query = { data: Projects | undefined; error: { message: string } | null; refetch: () => Promise<void> };
type Project = Projects[number];

/** The priority's colour as a small dot (the word is always beside it). */
function PriorityDot({ p }: { p: Priority }) {
  return <span aria-hidden className="inline-block size-2 shrink-0 rounded-full" style={{ background: css(PRIORITY_TONES[p]) }} />;
}

/** Opens Needs you on the owner's card (or an agent's own prompt): the view, then that card scrolled into sight. */
export type OpenCard = (selector: string) => void;

/**
 * A click on the row's own surface opens the project's page; one on its buttons, links, menus or the archive prompt
 * doesn't. A menu's items render in a portal: their clicks bubble here through React but aren't inside the row's DOM.
 */
const onSurface = (e: MouseEvent<HTMLElement>) => {
  const t = e.target as HTMLElement;
  return e.currentTarget.contains(t) && !t.closest("button, a, input, textarea, select, label, [role^=menu], [role=group], [role=dialog], [role=listbox], [role=option], [data-lanes], [data-book]");
};

/** Ask for status (PLAN 1.6): only while the status is missing or old, and not while an earlier ask is unanswered. */
function askStatusFor(project: Project, now: number, refetchAll: () => void): (() => void) | null {
  if (!project.lead || project.heldAt !== null || (project.status && !statusStale(project, now))) return null;
  if (project.direct?.messages.some((m) => m.text === ASK_STATUS_TEXT && m.state !== "closed")) return null;
  return () => {
    const body: z.input<typeof directMessageBody> = { slug: project.slug, text: ASK_STATUS_TEXT, followUp: null };
    void write(WRITES.directMessage, body, { kind: "other", where: `lead:${project.slug}`, after: refetchAll });
  };
}

/**
 * The ⋯ menu: pin a document, start or end scoping, priority, hold and archive. On a narrow panel it also holds what has no button there: Ask for status and
 * Start lead. (Message went on 2026-11-17: the composer is always open under the name of an open project.)
 * Start/End scoping (1.13.0) is the owner's direct switch, with no card: orch_project_mode's own engine path.
 */
function MoreMenu({ project, busy, refetchAll, narrow, onArchive, askStatus, askInMenu = false, onPin }: { project: Project; busy: boolean; refetchAll: () => void; narrow: boolean; onArchive: () => void; askStatus: (() => void) | null; askInMenu?: boolean; onPin?: () => void }) {
  const held = project.heldAt !== null;
  const setPriority = (priority: Priority) => {
    if (priority === project.priority) return;
    const body: z.input<typeof priorityBody> = { slug: project.slug, priority };
    void write(WRITES.priority, body, { kind: "other", where: "projects", after: refetchAll });
  };
  const hold = () => {
    const body: z.input<typeof holdBody> = { slug: project.slug, held: !held };
    void write(WRITES.hold, body, { kind: "other", where: "projects", after: refetchAll });
  };
  const startLead = () => {
    const body: z.input<typeof startLeadBody> = { slug: project.slug };
    void write(WRITES.startLead, body, { kind: "other", where: `lead:${project.slug}`, after: refetchAll });
  };
  const mode = projectScopeAction(project.mode);
  const setMode = () => {
    if (mode.kind !== "project") return;
    const body: z.input<typeof projectModeBody> = { slug: project.slug, mode: mode.mode };
    void write(WRITES.projectMode, body, { kind: "other", where: `lead:${project.slug}`, after: refetchAll });
  };
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Btn tone="ghost" size="sm" icon={<Ellipsis aria-hidden />} data-more={project.slug} title="More: priority, hold, archive" aria-label={`More for ${project.slug}`} disabled={busy} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label={project.slug} className="min-w-48">
        {onPin ? (
          <DropdownMenuItem disabled={busy} data-pin-document={project.slug} onSelect={onPin}>
            <Pin aria-hidden />
            Pin a document…
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem disabled={busy} data-project-mode={mode.kind === "project" ? mode.mode : ""} onSelect={setMode}>
          <Crosshair aria-hidden />
          {mode.label}
        </DropdownMenuItem>
        {narrow && !project.lead ? (
          <DropdownMenuItem disabled={busy || held} data-start-lead={project.slug} onSelect={startLead}>
            Start lead
          </DropdownMenuItem>
        ) : null}
        {(narrow || askInMenu) && askStatus ? (
          <DropdownMenuItem disabled={busy} data-ask-status={project.slug} onSelect={askStatus}>
            Ask for status
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-priority={project.slug}>Priority: {project.priority}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={project.priority} onValueChange={(v) => setPriority(v as Priority)}>
              {PRIORITIES.map((p) => (
                <DropdownMenuRadioItem key={p} value={p} disabled={busy} data-priority-pick={p}>
                  <PriorityDot p={p} />
                  {PRIORITY_TONES[p].label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem disabled={busy} data-hold={project.slug} onSelect={hold}>
          {held ? "Resume" : "Put on hold"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={busy} data-archive-project={project.slug} onSelect={onArchive}>
          Archive…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Archive's confirm (2026-11-17: shadcn's AlertDialog): what goes and what stays, then Cancel or Archive project. */
function ArchiveConfirm({ project, open, busy, refetchAll, onDone }: { project: Project; open: boolean; busy: boolean; refetchAll: () => void; onDone: () => void }) {
  const archive = () => {
    onDone();
    const body: z.input<typeof archiveProjectBody> = { slug: project.slug };
    void write(WRITES.archiveProject, body, { kind: "other", where: `lead:${project.slug}`, after: refetchAll });
  };
  const n = project.summary?.threads.total ?? project.threads;
  return (
    <AlertDialog open={open} onOpenChange={(o) => (o ? undefined : onDone())}>
      <AlertDialogContent size="sm" aria-label={`Archive ${project.slug}`} data-archive-confirm={project.slug}>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {project.slug}?</AlertDialogTitle>
          <AlertDialogDescription>
            {project.lead ? `Its lead and ${n} ${n === 1 ? "thread" : "threads"} are archived` : "Its threads are archived"}, and their open cards withdrawn. Worktrees go after bb's grace period;
            branches, deliverables and outputs stay. Start lead brings it back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-archive-cancel="">Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" data-archive-go={project.slug} disabled={busy} onClick={archive}>
            Archive project
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The lead's Pokémon (shiny, as in the sidebar), or with a personas pack its person (2026-11-18), opening its thread; a
 * neutral avatar with the setting off or no lead.
 */
function Face({ project, size }: { project: Project; size: 24 | 32 }) {
  const navigate = useBbNavigate();
  const h = leadHead(project);
  const lead = project.lead;
  return (
    <span className="face" data-face={h.mon ?? ""}>
      {lead ? (
        <Button variant="ghost" className={cn("p-0", size === 32 ? "size-9" : "size-7")} data-open-thread={lead.threadId} title={`Open lead:${project.slug}`} onClick={() => navigate.toThread(lead.threadId)}>
          <AgentFace face={{ mon: h.mon, persona: h.persona }} address={lead.address} size={size} boost={false} />
        </Button>
      ) : (
        <AgentFace face={null} address={`lead:${project.slug}`} size={size} boost={false} />
      )}
    </span>
  );
}

/** Pathways on the project's page (web: the opened project's head; it no longer sits on the rows, where it covered the name). */
function PathwaysLink({ slug }: { slug: string }) {
  const navigate = useBbNavigate();
  return <Button variant="outline" size="sm" data-open-pathways={slug} onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: `pathways/${encodeURIComponent(slug)}` })}>Pathways →</Button>;
}

/** A page's Back row (card-390): the way back to the list, at the gutter, and the page's ⋯ at the right. */
function BackRow({ onBack, children }: { onBack: () => void; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between" data-page-back="">
      <Button variant="ghost" size="sm" className="-ml-2 gap-1 px-2 font-normal text-muted-foreground has-[>svg]:px-2" data-detail-back="" aria-label="Back to Projects" onClick={onBack}>
        <ChevronLeft aria-hidden />
        Projects
      </Button>
      {children}
    </div>
  );
}

/** An archived project: one line, its name and when it was archived; Start lead brings it back. */
function ArchivedRow({ project, busy, refetchAll, onOpen }: { project: Project; busy: boolean; refetchAll: () => void; onOpen: (slug: string) => void }) {
  const startLead = () => {
    const body: z.input<typeof startLeadBody> = { slug: project.slug };
    void write(WRITES.startLead, body, { kind: "other", where: `lead:${project.slug}`, after: refetchAll });
  };
  return (
    <Item asChild>
    <li className="proj headed" data-project={project.slug} data-held={project.heldAt !== null ? "true" : "false"} data-archived="true" style={accentVars(project.monType)} onClick={(e) => (onSurface(e) ? onOpen(project.slug) : undefined)}>
      <Face project={project} size={24} />
      <div className="body">
        <div className="ln title">
          <span className="tx" title={`${project.slug}: archived ${when(project.archivedAt)}`}>
            <Button variant="link" className={cn("name", INLINE_LINK, "no-underline hover:underline")} data-open-project={project.slug} onClick={() => onOpen(project.slug)}>
              {project.slug}
            </Button>
            <span className="now">archived {when(project.archivedAt)}</span>
          </span>
          <span className="acts">
            {project.lead ? null : (
              <Btn size="sm" data-start-lead={project.slug} disabled={busy || project.heldAt !== null} title={`Bring ${project.slug} back with a new lead`} onClick={startLead}>
                Start lead
              </Btn>
            )}
          </span>
        </div>
        <PageError where={`lead:${project.slug}`} />
      </div>
    </li>
    </Item>
  );
}

const STANDING = [
  { role: "cos", label: null }, // the cosTitle setting
  { role: "steward", label: "Steward" },
] as const;

/** The CoS and the Steward on one line: each with its state, or Start when none is live (an archived one isn't). */
function StandingAgents({ agents, full, busy, refetchAll }: { agents: Board["agents"] | undefined; full: Agents | undefined; busy: boolean; refetchAll: () => void }) {
  const { cosTitle } = useIdentity();
  return (
    <div data-standing="" className="bar standing">
      <span>
        <span data-standing-label="">Standing agents: </span>
        {STANDING.map(({ role, label: fixed }, i) => {
          const label = fixed ?? cosTitle;
          const a = agents?.find((x) => x.address === role && x.status !== "archived");
          const f = a ? full?.find((x) => x.threadId === a.threadId) : undefined;
          const start = () => {
            const body: z.input<typeof roleStartBody> = { role };
            void write(WRITES.roleStart, body, { kind: "other", where: `role:${role}`, after: refetchAll });
          };
          return (
            <span key={role} data-standing-role={role}>
              {i ? " · " : ""}
              {/* 2026-11-18, with a personas pack: the pair, and the name that opens its profile card */}
              <StandingFace face={a} address={role} label={label} level={f?.level ?? null} />{" "}
              {a ? (
                <>
                  {f?.status ?? a.status}
                  {f?.unread ? <i className="unread" title="something new since you last looked" /> : null}
                </>
              ) : agents ? (
                <Button variant="link" size="xs" className="h-6 px-1 align-baseline text-xs text-foreground underline underline-offset-4" data-start-role={role} disabled={busy} onClick={start}>
                  Start
                </Button>
              ) : (
                "…"
              )}
            </span>
          );
        })}
      </span>
      {full ? (
        <span className="right" data-agent-count={full.length}>
          {full.length} live {full.length === 1 ? "agent" : "agents"}
        </span>
      ) : null}
      <PageError where="role:cos" />
      <PageError where="role:steward" />
    </div>
  );
}

/** Layout B: the wide tab's own CSS and the list row (proposal 2). Selection is a tint, never a coloured edge. */
const layoutCss = /* css */ `
[data-orch] .orch-cc .b-body { display: grid; grid-template-columns: minmax(280px, min(480px, 40%)) minmax(0, 1fr); gap: 32px; align-items: start; }
/* the detail beside the list lays its cards out from its own width (a 720 px pane gives it about 400) */
[data-orch] .orch-cc .b-body > .detail { container: orchcc / inline-size; }
[data-orch] .orch-cc .k-plist { display: flex; flex-direction: column; gap: 4px; }
[data-orch] .orch-cc .k-prow { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; column-gap: 12px; align-items: center; min-height: 56px; padding: 8px 12px; border-radius: 8px; cursor: pointer; }
[data-orch] .orch-cc .k-prow:hover { background: var(--accent); }
[data-orch] .orch-cc .k-prow[data-selected="true"] { background: var(--accent); border-color: var(--border); }
[data-orch] .orch-cc .k-prow .face { display: flex; width: 32px; height: 32px; align-items: center; justify-content: center; }
[data-orch] .orch-cc .k-prow .k-main { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
[data-orch] .orch-cc .k-prow .k-name { display: flex; align-items: baseline; gap: 8px; min-width: 0; white-space: nowrap; }
[data-orch] .orch-cc .k-prow .k-name .name { overflow: hidden; text-overflow: ellipsis; min-height: 24px; font-weight: 600; }
[data-orch] .orch-cc .k-prow .k-mon { font-size: 12px; line-height: 16px; color: var(--orch-muted); flex: none; }
[data-orch] .orch-cc .k-prow .k-type { font-size: 12px; line-height: 16px; font-weight: 600; flex: none; }
[data-orch] .orch-cc .k-prow .k-sub { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 16px; color: var(--orch-muted); white-space: nowrap; overflow: hidden; }
[data-orch] .orch-cc .k-prow .k-side { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
[data-orch] .orch-cc .k-prow[data-quiet="true"] { min-height: 40px; padding-top: 4px; padding-bottom: 4px; }
[data-orch] .orch-cc .k-prow[data-quiet="true"] .name { font-weight: 400; color: var(--orch-muted); }
[data-orch] .orch-cc .k-list-h { margin: 12px 0 0; padding: 0 12px; font-size: 12px; line-height: 16px; font-weight: 400; color: var(--orch-muted); }
[data-orch] .orch-cc .k-inplace { padding: 8px 0 24px; cursor: default; }
[data-orch] .orch-cc .detail { min-width: 0; display: flex; flex-direction: column; gap: 16px; }
[data-orch] .orch-cc .k-dhead { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-width: 0; }
[data-orch] .orch-cc .k-dhead .name { font-size: 16px; line-height: 24px; }
[data-orch] .orch-cc .k-dhead .k-mon { color: var(--orch-muted); }
[data-orch] .orch-cc .k-dhead .k-type { font-weight: 600; }
[data-orch] .orch-cc .k-dhead .acts { margin-left: auto; }
[data-orch] .orch-cc .k-dfixed, [data-orch] .orch-cc .k-dcards { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
/* 2026-11-17, the owner: "the left navigation bar should stay in the same locations and also the header card should
   only the cards should scroll". Wide, the tab takes the pane's height (panes.tsx [data-fits-pane]): the list scrolls on its own
   when it is taller, the project's name row and chat card stay put, and only its section cards scroll, from the top
   again for each project (the detail is keyed by project). One column keeps the one scroll of the pane */
[data-orch] [data-fits-pane] > .orch-cc { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; padding-bottom: 0; }
[data-orch] [data-fits-pane] > .orch-cc .hits { flex: none; max-height: 35vh; overflow-y: auto; }
[data-orch] [data-fits-pane] .b-body { flex: 1 1 0; min-height: 0; grid-template-rows: minmax(0, 1fr); align-items: stretch; }
[data-orch] [data-fits-pane] .b-body > .k-listpane { min-height: 0; overflow-y: auto; scrollbar-gutter: stable; padding-bottom: 32px; }
[data-orch] [data-fits-pane] .b-body > .detail { min-height: 0; }
/* the fixed head (2026-11-20, 1.36.1, the lead: "the message box must be whole without scrolling"): it is never cut below
   its own height while the cards keep 48 px, so a closed chat's head shows whole. Nothing in it shrinks (a flex box's
   minimum is its children's flex bases, so a shrinking chat card let its row slide under the message box in 1.36.0).
   An open transcript's height is measured instead (head-fit.ts): what two thirds of the detail leave after the rest of
   the head, so the cards keep at least a third. When even that can't fit (a short window), the head scrolls inside
   itself and the message box stays stuck to the bottom of what shows, over what scrolls under it. It keeps the cards'
   scrollbar room, so its right edge lines up with theirs */
[data-orch] [data-fits-pane] .b-body > .detail > .k-dfixed { flex: none; min-height: 0; max-height: calc(100% - 48px); overflow-y: auto; scrollbar-gutter: stable; margin: -2px; padding: 2px; }
[data-orch] [data-fits-pane] .b-body > .detail > .k-dfixed > .k-chatcard, [data-orch] [data-fits-pane] .b-body > .detail > .k-dfixed .k-chat, [data-orch] [data-fits-pane] .b-body > .detail > .k-dfixed .k-chat > * { flex: none; }
[data-orch] [data-fits-pane] .b-body > .detail > .k-dfixed > .k-chatcard { overflow: clip; }
[data-orch] [data-fits-pane] .b-body > .detail > .k-dfixed .k-composer { position: sticky; bottom: 0; z-index: 1; background: var(--card); }
/* the measured height, in either layout (on its own page the room is the pane's visible height below the head) */
[data-orch] .orch-cc .k-dfixed .k-chat > .k-leadthread { height: var(--k-transcript-h, var(--k-leadthread-h, 480px)); }
[data-orch] .orch-cc .k-dfixed .k-chat > .k-chat__log { max-height: var(--k-transcript-h, 480px); }
[data-orch] [data-fits-pane] .b-body > .detail > .k-dcards { flex: 1 1 0; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; padding-bottom: 32px; }
/* a phone (2026-11-20, the owner: "way too much empty space"): one compact row per project on the 16 px gutter (face,
   name, state, working, one count, age), rows split by a line; the standing agents and the filters one line each. Only in
   bb's phone layout (phone.ts): a narrow desktop pane keeps the web rows */
[data-orch] .orch-cc[data-phone] .k-plist { gap: 0; }
[data-orch] .orch-cc[data-phone] .k-prow { align-items: start; min-height: 0; padding: 10px 0; border-radius: 0; border-width: 0 0 1px; border-color: var(--border); }
[data-orch] .orch-cc[data-phone] .k-prow:hover { background: none; }
[data-orch] .orch-cc[data-phone] .k-prow .face { align-self: center; }
[data-orch] .orch-cc[data-phone] .k-prow .k-main { gap: 2px; }
[data-orch] .orch-cc[data-phone] .k-prow .k-name .name { min-height: 20px; height: 20px; }
[data-orch] .orch-cc[data-phone] .k-prow [data-list-scoping] { display: none; }
/* the working count wraps under the state chip rather than being cut by the side column */
[data-orch] .orch-cc[data-phone] .k-prow .k-sub { flex-wrap: wrap; row-gap: 2px; overflow: visible; }
[data-orch] .orch-cc[data-phone] .k-prow .k-sub > * { white-space: nowrap; }
[data-orch] .orch-cc[data-phone] .k-prow .k-side { gap: 2px; }
[data-orch] .orch-cc[data-phone] .k-prow .k-side .k-age { order: -1; line-height: 20px; }
[data-orch] .orch-cc[data-phone] .k-prow[data-quiet="true"] { padding: 6px 0; }
[data-orch] .orch-cc[data-phone] .k-list-h { padding: 0; margin-top: 16px; }
[data-orch] .orch-cc[data-phone] .standing { flex-wrap: nowrap; white-space: nowrap; margin-bottom: 12px; }
[data-orch] .orch-cc[data-phone] .standing > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
[data-orch] .orch-cc[data-phone] .standing .right { flex: none; flex-basis: auto; margin-left: auto; }
[data-orch] .orch-cc[data-phone] .standing [data-standing-label] { display: none; }
[data-orch] .orch-cc[data-phone] .top { margin-bottom: 8px; }
[data-orch] .orch-cc[data-phone] .top .filters { width: 100%; }
[data-orch] .orch-cc[data-phone] .top .filters > * { flex: 1 1 auto; padding-inline: 6px; }
[data-orch] .orch-cc[data-phone] .k-dhead :is(.k-mon, .k-type) { display: none; }
`;

/**
 * A project in the list: its lead's face, name; one state chip and how many work; the one number, and the status's age.
 * No lead title or type (2026-11-20, the owner: "it doesn't really help and just adds clutter"); the opened project has them.
 */
function ListRow({ project, lanes, now, selected, quiet, onSelect }: { project: Project; lanes: Lane[] | undefined; now: number; selected: boolean; quiet: boolean; onSelect: () => void }) {
  const r = listRow(project, lanes, now, quiet);
  return (
    <Item asChild>
    <li
      className="k-prow"
      data-selected={selected}
      data-project={project.slug}
      data-list-row={project.slug}
      data-state={r.state}
      data-quiet={quiet ? "true" : "false"}
      style={accentVars(project.monType)}
      onClick={(e) => ((e.target as HTMLElement).closest("button, a") ? undefined : onSelect())}
    >
      <Face project={project} size={32} />
      <div className="k-main">
        <div className="k-name">
          {/* a plain list: the name is the control that selects, and says which project the detail shows */}
          <Button variant="link" className={cn("name", INLINE_LINK, "no-underline hover:underline")} data-select-project={project.slug} aria-current={selected ? "true" : undefined} onClick={onSelect}>
            {project.slug}
          </Button>
          {project.direct?.unread ? <i className="unread" role="img" aria-label="a new note from the lead" data-list-unread={project.slug} title="a new note from the lead: select the project to read it" /> : null}
        </div>
        {quiet ? null : (
          <div className="k-sub" data-list-state={r.state}>
            <Chip spec={r.chip} />
            {tasksScoping(project) ? <Chip spec={STATE_CHIP.scoping} data-list-scoping={project.slug} title={tasksScoping(project)!} /> : null}
            {r.working ? <span data-list-working="">{r.working}</span> : null}
          </div>
        )}
      </div>
      <div className="k-side">
        {r.number ? <Chip spec={r.number} data-list-number={r.number.tone} /> : null}
        <span className="k-age" data-old={r.age.old ? "true" : "false"} title={r.age.title}>
          {r.age.old ? <Icon name="wait" label="status old" /> : null}
          {r.age.text}
        </span>
      </div>
    </li>
    </Item>
  );
}

/**
 * The selected project: its head (name, state chip, what is for the owner; ⋯), the one-line message box, then the
 * sections (project-book.tsx), the Pinned strip first, and its history and Pathways. Focusing the message box pins the selection: the list's
 * order can change under a draft, and the default selection (the first project) must not swap while the owner types.
 */
function DetailPanel({ project, lanes, busy, refetchAll, openCard, onOpen, onPick, now, narrow, needs, inPlace = false, onBack }: { project: Project; lanes: Lane[] | undefined; busy: boolean; refetchAll: () => void; openCard: OpenCard; onOpen: (slug: string) => void; onPick: () => void; now: number; narrow: boolean; needs: NeedsYou | undefined; inPlace?: boolean; onBack?: () => void }) {
  const { cosTitle, ownerName } = useIdentity();
  const [confirming, setConfirming] = useState(false);
  const [pinning, setPinning] = useState(false);
  const head = leadHead(project);
  const askStatus = askStatusFor(project, now, refetchAll);
  const st = projectState(project, lanes);
  const forYou = needCount(project, lanes);
  const leadLane = lanes?.find((l) => l.agent.role === "lead");
  const leadLevel = leadLane ? leadLane.agent.level : null;
  const party = partyOf((lanes ?? []).filter((l) => l.state !== "released").map((l) => l.agent), project.slug, head.persona?.roster);
  const startLead = () => {
    const body: z.input<typeof startLeadBody> = { slug: project.slug };
    void write(WRITES.startLead, body, { kind: "other", where: `lead:${project.slug}`, after: refetchAll });
  };
  const held = project.heldAt !== null;
  // the open transcript gets what the head's room leaves (head-fit.ts), so the message box is whole without scrolling
  const headFit = useHeadFit<HTMLDivElement>();
  const more = <MoreMenu project={project} busy={busy} refetchAll={refetchAll} narrow={narrow} onArchive={() => setConfirming(true)} askStatus={askStatus} askInMenu onPin={() => setPinning(true)} />;
  return (
    <div className="detail" data-project={project.slug} data-detail-panel={project.slug} data-held={held ? "true" : "false"} style={accentVars(project.monType)}>
      <ProjectRefs.Provider value={{ project: project.slug, prs: project.prs ?? [] }}>
        {/* the head: stays put above the cards in the wide layout (layoutCss) */}
        <div className="k-dfixed" ref={headFit} data-detail-head={project.slug}>
          {/* a phone's project page: the Back row holds the ⋯, so the head is one line */}
          {onBack ? <BackRow onBack={onBack}>{more}</BackRow> : null}
          <div className="k-dhead">
            {inPlace ? null : (
              <>
                <Face project={project} size={32} />
                <span className="name">{project.slug}</span>
                {head.shown ? <span className="k-mon">{head.name}</span> : null}
                {head.shown && head.type ? (
                  <span className="k-type" data-type={head.accent ?? ""} style={{ color: accentText(head.accent) }}>
                    {head.type}
                  </span>
                ) : null}
              </>
            )}
            <Chip spec={STATE_CHIP[st]} data-detail-state={st} title={held ? `on hold since ${when(project.heldAt)}` : undefined} />
            {tasksScoping(project) ? <Chip spec={{ ...STATE_CHIP.scoping, word: tasksScoping(project)! }} data-detail-scoping={project.slug} /> : null}
            {forYou ? <Chip spec={{ tone: "need", icon: "you", word: `${forYou} for you` }} data-detail-for-you={String(forYou)} /> : null}
            <span className="acts">
              {project.lead ? null : (
                <Btn size="sm" data-start-lead={project.slug} disabled={busy || held} onClick={startLead}>
                  Start lead
                </Btn>
              )}
              {onBack ? null : (
                <>
                  <Btn size="sm" data-open-project={project.slug} title="The timeline, the flow and the dependencies" onClick={() => onOpen(project.slug)}>
                    Timeline
                  </Btn>
                  <PathwaysLink slug={project.slug} />
                  {more}
                </>
              )}
            </span>
          </div>
          {/* 2026-11-18: the lead's profile card, compact, right under the header (with a personas pack only). It holds the
              lead's Lv, party and team, so the header above doesn't repeat them, at any width */}
          {head.persona && project.lead ? <ProfileCard persona={head.persona} address={project.lead.address} project={project.slug} level={leadLevel} party={party} /> : null}
          {project.lead ? (
            <ChatCard slug={project.slug}>
              <ChatLog project={project} now={now} cos={cosTitle} busy={busy} refetchAll={refetchAll} onPick={onPick} />
              <Composer
                compact
                project={project}
                now={now}
                cos={cosTitle}
                busy={busy}
                refetchAll={refetchAll}
                onFocus={() => {
                  onPick();
                  markSeen(project, refetchAll);
                }}
              />
            </ChatCard>
          ) : project.direct?.messages.length ? (
            // no lead running (none started, or archived): the direct-message log so far, read-only until Start lead
            <ChatCard slug={project.slug}>
              <ChatLog project={project} now={now} cos={cosTitle} busy={busy} refetchAll={refetchAll} onPick={onPick} />
            </ChatCard>
          ) : null}
          {held ? <div className="muted small">Mail to this lead is held until the project resumes.</div> : null}
          <PageError where={`lead:${project.slug}`} />
          <ArchiveConfirm project={project} open={confirming} busy={busy} refetchAll={refetchAll} onDone={() => setConfirming(false)} />
        </div>
        {/* the section cards: the one region of the detail that scrolls in the wide layout */}
        <div className="k-dcards" data-cards-scroll={project.slug}>
          <ProjectBook
            project={project}
            lanes={lanes}
            now={now}
            cards={needs?.cards ?? []}
            cos={cosTitle}
            ownerName={ownerOnScreen(ownerName).name}
            openCard={openCard}
            askStatus={askStatus}
            pinning={pinning}
            setPinning={setPinning}
            busy={busy}
            refetchAll={refetchAll}
          />
          {/* a phone's project page holds its history and Pathways; on web they are the Timeline page */}
          {onBack ? <ProjectSections project={project} lanes={lanes} openCard={openCard} ownerName={ownerOnScreen(ownerName).name} /> : null}
          {onBack ? <PathwaysPart slug={project.slug} narrow /> : null}
        </div>
      </ProjectRefs.Provider>
    </div>
  );
}

/** On a phone the filter row fits the screen with the shorter word (2026-11-20: "With waits" ran off the edge). */
const SHORT_FILTER_WORD: Partial<Record<Filter, string>> = { waits: "Waits" };

type ScopeQuery = { data: Scope | undefined; error: { message: string } | null; refetch: () => Promise<void> };

export function ProjectsView({
  q,
  refetchAll,
  agents,
  lanesFrom,
  needs,
  openCard,
  detail,
  onDetail,
  picked,
  onPick,
  refs,
  scope,
  scopeOpen,
  onScope,
  pathwaysOpen = false,
  deliverables,
  mons,
  accents,
}: {
  q: Query;
  refetchAll: () => void;
  agents: Board["agents"] | undefined;
  lanesFrom: Agents | undefined;
  needs: NeedsYou | undefined;
  openCard: OpenCard;
  /** The open project page (projects/<slug>), null for the list. The panel keeps it, so pane focus can't close it. */
  detail: string | null;
  /** The selected project (the pane's route): beside the list when wide, its own page with Back when narrow. */
  picked: string | null;
  onPick: (slug: string | null) => void;
  /** Opening or leaving a project's page: the URL follows, so a link or the browser's back button works. */
  onDetail: (slug: string | null) => void;
  /** What the references in a row's text resolve against (refs.ts); null: plain text. */
  refs: SharedRefs | null;
  /** Scope, folded in as the Scoping group (2026-11-20): its read, the open entry (scope/<key>) and how to open one. */
  scope: ScopeQuery;
  scopeOpen: string | null;
  onScope: (key: string | null) => void;
  /** An old pathways/<slug> link: the project's page opens with Pathways open. */
  pathwaysOpen?: boolean;
  deliverables: Deliverables | undefined;
  mons: ReadonlyMap<string, FaceOf>;
  accents: ReadonlyMap<string, string | null>;
}) {
  useGate();
  const { ownerName, cosTitle } = useIdentity();
  const you = ownerOnScreen(ownerName);
  const [filter, setFilter] = useState<Filter>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  // what the results follow: the box's words once typing pauses (search.tsx useSettled)
  const found = useSettled(query);
  const [width, root] = useElementWidth();
  // this pane's own elements: a second Projects pane must not scroll with this one
  const pane = usePaneId();
  const here = pane ? `[data-pane="${CSS.escape(pane)}"]` : "[data-orch]";
  // bb's phone layout (not a pane width; the lead, 2026-11-20): there a project opens as its own page with a Back row
  const phone = useTouchPhone();
  const narrow = width > 0 && width <= 640;
  const wide = isWide(width);
  usePaneFits(wide);
  const now = useMinute();
  const busy = gate.lock !== null;
  // a page opens from the top, as a new page does
  useEffect(() => {
    if (phone || scopeOpen || (picked && !wide)) document.querySelector(`${here} [data-projects-width]`)?.closest(".orch-pane__scroll")?.scrollTo({ top: 0 });
  }, [detail, scopeOpen, phone, picked]);
  const all = q.data;
  if (!all) return <ReadState q={q} what="the projects" />;
  const lanes = buildLanes(lanesFrom, needs);
  const open = (slug: string | null) => {
    const p = slug ? all.find((x) => x.slug === slug) : undefined;
    if (p && phone) markSeen(p, refetchAll); // a phone's page shows the lead's chat, so its notes are seen
    onDetail(slug);
  };
  const linked = detail ? all.find((p) => p.slug === detail) : undefined;
  // web: a project's page is its history and Pathways, as before the phone pass
  if (linked && !phone) return <ProjectDetail project={linked} lanes={lanes.get(linked.slug)} onBack={() => open(null)} openCard={openCard} ownerName={you.name} pathwaysOpen={pathwaysOpen} />;
  const cards = needs?.cards ?? [];
  const live = all.filter((p) => p.archivedAt === null);
  const count = (f: Filter) => live.filter((p) => matches(f, p, lanes.get(p.slug))).length;
  const hits = found.trim() ? searchLoaded(live, lanes, cards, found, (w) => waitLine(w, now, cosTitle).text) : [];
  const filtered = live.filter((p) => matches(filter, p, lanes.get(p.slug)));
  const shown = searchedProjects(filtered, hits, found).sort(attentionOrder(lanes, now));
  const main = shown.filter((p) => !isQuiet(p, lanes.get(p.slug), now));
  const quiet = shown.filter((p) => isQuiet(p, lanes.get(p.slug), now));
  const archived = filter === "all" && !found.trim() ? all.filter((p) => p.archivedAt !== null).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)) : [];
  // a click in the list: the detail beside it, or its own page in a narrow pane, shows the project's direct line, so its notes are seen
  const pick = (p: Project) => {
    onPick(p.slug);
    markSeen(p, refetchAll);
  };
  // a click on a project's name in the hits: its page on a phone, else select it beside the list or open its row in place
  const reach = (slug: string) => {
    if (filterHides(slug, filtered)) setFilter("all");
    const p = live.find((x) => x.slug === slug);
    if (phone) return open(slug);
    if (p) markSeen(p, refetchAll);
    onPick(slug);
  };
  const ordered = [...main, ...quiet];
  const selected = scopeOpen ? undefined : (ordered.find((p) => p.slug === picked) ?? ordered[0]);
  const pickedPage = picked ? live.find((p) => p.slug === picked) : undefined;
  // `page`: the project is already the page (a phone's projects/<slug>). Picking it there would route to projects/@<slug>,
  // which a phone draws as the list: a tap in the message box threw the owner out of the project (2026-11-20).
  const detailPanel = (p: Project, o: { onBack?: () => void; inPlace?: boolean; page?: boolean } = {}) => <DetailPanel key={p.slug} project={p} lanes={lanes.get(p.slug)} busy={busy} refetchAll={refetchAll} openCard={openCard} onOpen={open} onPick={o.page ? () => {} : () => onPick(p.slug)} now={now} narrow={narrow} needs={needs} onBack={o.onBack} inPlace={o.inPlace} />;
  const scopePage = scopeOpen ? <ScopeView q={scope} projects={all} deliverables={deliverables} refetchAll={refetchAll} mons={mons} accents={accents} focus={scopeOpen} entryOnly fits={wide} /> : null;
  const styles = (
    <>
      {/* a changed block gets a new href: React keeps a style by its href, so a window open across an update would keep the old rules */}
      <style href={styleHref("orch-cc", ccCss)} precedence="default">
        {ccCss}
      </style>
      <style href={styleHref("orch-cc-refs", refCss)} precedence="default">
        {refCss}
      </style>
      <style href={styleHref("orch-cc-direct", directCss)} precedence="default">
        {directCss}
      </style>
      <style href={styleHref("orch-cc-search", searchCss)} precedence="default">
        {searchCss}
      </style>
      <style href={styleHref("orch-kit", kitCss)} precedence="default">
        {kitCss}
      </style>
      <style href={styleHref("orch-kit-thread", threadCss)} precedence="default">
        {threadCss}
      </style>
      <style href={styleHref("orch-kit-pins", pinsCss)} precedence="default">
        {pinsCss}
      </style>
      <style href={styleHref("orch-cc-book", bookCss)} precedence="default">
        {bookCss}
      </style>
      <style href={styleHref("orch-cc-layout", layoutCss)} precedence="default">
        {layoutCss}
      </style>
    </>
  );
  // one column: a scoping entry opens as its own page, with a way back (card-390); on a phone a project does too
  const page = wide ? null : scopePage ? (
    <>
      <BackRow onBack={() => onScope(null)} />
      {scopePage}
    </>
  ) : linked && phone ? (
    detailPanel(linked, { onBack: () => open(null), page: true })
  ) : pickedPage && !phone ? (
    detailPanel(pickedPage, { onBack: () => onPick(null) })
  ) : null;
  const top = (
    <div className="top">
      <ToggleGroup type="single" variant="outline" size="sm" aria-label="Filter" className="filters" data-needs-me-filter={filter} value={filter} onValueChange={(f) => f && setFilter(f as Filter)}>
        {FILTERS.map((f) => (
          <ToggleGroupItem key={f} value={f} data-filter={f}>
            {phone ? (SHORT_FILTER_WORD[f] ?? FILTER_WORD[f]) : FILTER_WORD[f]} <span className="text-muted-foreground tabular-nums">{f === "all" ? live.length : count(f)}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <SearchBox value={query} onChange={setQuery} />
    </div>
  );
  const empty = (
    <>
      {all.length === 0 ? <EmptyState title="No projects yet" text="A project shows up here once a lead registers for it." icon={null} /> : null}
      {filter !== "all" && !found.trim() && shown.length === 0 ? <EmptyState data-needs-me-empty="" title={filter === "you" ? `Nothing waits on ${you.name}` : `No project is ${filter === "blocked" ? "blocked" : "waiting on anything"}`} text="" icon={null} /> : null}
    </>
  );
  const archivedGroup = archived.length ? (
    <div className="quiet" data-group="archived">
      <h3 className="group-h">
        <Btn tone="ghost" size="sm" className="-ml-2 h-7 px-2 text-xs font-normal text-muted-foreground" data-archived-toggle="" aria-expanded={showArchived} onClick={() => setShowArchived((x) => !x)}>
          Archived · {archived.length}
          {showArchived ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
        </Btn>
      </h3>
      {showArchived ? (
        <ul>
          {archived.map((p) => (
            <ArchivedRow key={p.slug} project={p} busy={busy} refetchAll={refetchAll} onOpen={open} />
          ))}
        </ul>
      ) : null}
    </div>
  ) : null;
  const rows = (ps: Project[], isQuietGroup: boolean) =>
    ps.map((p) =>
      wide ? (
        <ListRow key={p.slug} project={p} lanes={lanes.get(p.slug)} now={now} selected={p === selected} quiet={isQuietGroup} onSelect={() => pick(p)} />
      ) : phone ? (
        <ListRow key={p.slug} project={p} lanes={lanes.get(p.slug)} now={now} selected={false} quiet={isQuietGroup} onSelect={() => open(p.slug)} />
      ) : (
        <ListRow key={p.slug} project={p} lanes={lanes.get(p.slug)} now={now} selected={false} quiet={isQuietGroup} onSelect={() => pick(p)} />
      ),
    );
  const list = (
    <div className={wide ? "k-listpane" : undefined} data-projects-list="">
      {filter === "all" && !found.trim() ? <ScopingRows q={scope} projects={all} deliverables={deliverables} mons={mons} selected={wide ? scopeOpen : null} onOpen={(k) => onScope(k)} /> : null}
      {main.length ? (
        <ul className="k-plist" role="list" aria-label="Projects" data-group="led">
          {rows(main, false)}
        </ul>
      ) : null}
      {quiet.length ? (
        <div data-group="quiet">
          <h3 className="k-list-h">Quiet · {quiet.length}</h3>
          <ul className="k-plist" role="list" aria-label="Quiet projects">
            {rows(quiet, true)}
          </ul>
        </div>
      ) : null}
      {archivedGroup}
    </div>
  );
  return (
    <RefsContext.Provider value={refs}>
    {/* measured at the pane's full width; one column keeps the reading column's width (max-w-3xl less its padding) */}
    <div ref={root} data-projects-width={width} data-fits-pane={wide || undefined}>
    <div className={cx("orch-cc tab pb-8", !wide && "narrow-book")} data-phone={phone || undefined} data-projects-tab="" data-layout={wide ? "list-detail" : "column"} data-page={page ? (scopeOpen ? "scope" : "project") : undefined} style={wide ? undefined : { maxWidth: 1000, marginInline: "auto" }}>
      {styles}
      {page ? (
        <div className="flex min-w-0 flex-col gap-2" data-project-page={scopeOpen ?? linked?.slug ?? pickedPage?.slug}>
          {page}
        </div>
      ) : (
        <>
          <StandingAgents agents={agents} full={lanesFrom} busy={busy} refetchAll={refetchAll} />
          {top}
          {found.trim() ? <SearchHits q={found} hits={hits} projects={live} now={now} onOpen={reach} /> : null}
          <ReadState q={q} what="the projects" />
          <PageError where="projects" />
          {empty}
          {wide ? (
            <div className="b-body">
              {list}
              {scopePage ?? (selected ? detailPanel(selected) : <div />)}
            </div>
          ) : (
            list
          )}
        </>
      )}
    </div>
    </div>
    </RefsContext.Provider>
  );
}

