import { styleHref } from "./style-href.ts";
import { useElementWidth, usePaneFits } from "./panes.tsx";
import { usePaneId } from "./key-state.ts";
import { Fragment, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import type { z } from "zod";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { WRITES, type Agents, type Board, type Deliverables, type NeedsYou, type Projects, type Scope, type archiveProjectBody, type directMessageBody, type holdBody, type priorityBody, type projectModeBody, type roleStartBody, type startLeadBody } from "../contract.ts";
import { ASK_STATUS_TEXT, FILTERS, FILTER_WORD, attentionOrder, isQuiet, leadHead, matches, statusStale, waitLine, type Filter } from "./command-center.ts";
import { ccCss } from "./cc-lines.tsx";
import { INLINE_LINK, ProjectRefs, RefsContext, refCss, type SharedRefs } from "./ref-text.tsx";
import { ChatCard, ChatLog, Composer, directCss, markSeen } from "./direct-line.tsx";
import { useHeadFit } from "./head-fit.ts";
import { useMinute } from "./status-bar.tsx";
import { ChevronDown, ChevronLeft, ChevronRight, Crosshair, Ellipsis, Pin, Search } from "lucide-react";
import { ScrollRow } from "./scroll-row.tsx";
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
import { ScopeView, scopeDeliveredIn, scopeWaitingIn } from "./scope.tsx";
import { entryTitle } from "./scope-names.ts";
import { PANEL_PATH } from "./open-proof.ts";
import { useTouchPhone } from "./phone.ts";
import { ProjectBook, bookCss } from "./project-book.tsx";
import { SearchBox, SearchHits, searchCss, useSettled } from "./search.tsx";
import { filterHides, isWide, searchLoaded, searchedProjects } from "./source.ts";
import { childHits, childrenOpen, scopeExtra, listRow, plannerStuck, matchesWithScope, needCount, projectScopeAction, projectState, quietWithScope, scopeEntries, STATE_CHIP, tasksScoping, leftEntry, type FoldPress, type ScopeChild, type TaskHit } from "./kit.ts";
import { Chip, Icon, kitCss } from "./kit-ui.tsx";

import { threadCss } from "./thread-card.tsx";
import { pinsCss } from "./pins.tsx";
import { BoardView, type BoardPlace } from "./work-board.tsx";
import { BoardSince, MovedChip } from "./board-since.tsx";
import { openStep, saveViewCopy, useProjectsView, type OpenAt, type Opening } from "./view-pref.ts";

type Query = { data: Projects | undefined; error: { message: string } | null; refetch: () => Promise<void> };
type Project = Projects[number];

function PriorityDot({ p }: { p: Priority }) {
  return <span aria-hidden className="inline-block size-2 shrink-0 rounded-full" style={{ background: css(PRIORITY_TONES[p]) }} />;
}

export type OpenCard = (selector: string) => void;

/** A menu's items render in a portal: their clicks bubble here through React but aren't inside the row's DOM. */
const onSurface = (e: MouseEvent<HTMLElement>) => {
  const t = e.target as HTMLElement;
  return e.currentTarget.contains(t) && !t.closest("button, a, input, textarea, select, label, [role^=menu], [role=group], [role=dialog], [role=listbox], [role=option], [data-lanes], [data-book]");
};

function askStatusFor(project: Project, now: number, refetchAll: () => void): (() => void) | null {
  if (!project.lead || project.heldAt !== null || (project.status && !statusStale(project, now))) return null;
  if (project.direct?.messages.some((m) => m.text === ASK_STATUS_TEXT && m.state !== "closed")) return null;
  return () => {
    const body: z.input<typeof directMessageBody> = { slug: project.slug, text: ASK_STATUS_TEXT, followUp: null };
    void write(WRITES.directMessage, body, { kind: "other", where: `lead:${project.slug}`, after: refetchAll });
  };
}

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

function PathwaysLink({ slug }: { slug: string }) {
  const navigate = useBbNavigate();
  return <Button variant="outline" size="sm" data-open-pathways={slug} onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: `pathways/${encodeURIComponent(slug)}` })}>Pathways →</Button>;
}

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
  { role: "cos", label: null },
  { role: "steward", label: "Steward" },
] as const;

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

const layoutCss = /* css */ `
[data-orch] .orch-cc .b-body { display: grid; grid-template-columns: minmax(280px, min(480px, 40%)) minmax(0, 1fr); gap: 32px; align-items: start; }
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
[data-orch] .orch-cc .k-prow .k-sub { display: flex; flex-wrap: wrap; row-gap: 4px; align-items: center; gap: 8px; font-size: 12px; line-height: 16px; color: var(--orch-muted); white-space: nowrap; overflow: visible; }
[data-orch] .orch-cc .k-prow .k-sub > * { white-space: nowrap; }
[data-orch] .orch-cc .k-prow .k-side { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
[data-orch] .orch-cc .k-prow[data-quiet="true"] { min-height: 40px; padding-top: 4px; padding-bottom: 4px; }
[data-orch] .orch-cc .k-prow[data-quiet="true"] .name { font-weight: 400; color: var(--orch-muted); }
/* the list says it holds a chevron (data-folds) rather than a :has() asking: an ancestor :has() restyles the page on every insert */
[data-orch] .orch-cc .k-plist[data-folds] > .k-prow { grid-template-columns: 32px minmax(0, 1fr) auto 32px; }
[data-orch] .orch-cc .k-kids { margin-top: -2px; }
/* React never removes a hoisted <style>: an older bundle's sheet stays, so every property it sets is set again here */
[data-orch] .orch-cc .k-kids > ul { position: relative; display: flex; flex-direction: column; gap: 1px; margin: 0 0 4px; padding: 0; border: 0; list-style: none; }
[data-orch] .orch-cc .k-kids > ul::before { content: ""; position: absolute; top: 0; bottom: 0; left: 28px; z-index: 1; pointer-events: none; border-left: 1px solid var(--border); opacity: 0.7; }
[data-orch] .orch-cc .k-krow { position: static; display: grid; grid-template-columns: 28px minmax(0, 1fr); column-gap: 6px; flex-direction: row; flex-wrap: nowrap; align-items: center; justify-content: stretch; gap: 0 6px; min-height: 28px; margin: 0; padding: 5px 8px 5px 44px; border: 0; border-radius: 6px; cursor: pointer; }
[data-orch] .orch-cc .k-krow::before { content: none; }
[data-orch] .orch-cc .k-krow:hover, [data-orch] .orch-cc .k-krow[data-selected="true"] { background: var(--accent); }
[data-orch] .orch-cc .k-krow .k-main { display: flex; flex-direction: column; align-items: flex-start; gap: 0; min-width: 0; max-width: 100%; line-height: 16px; }
[data-orch] .orch-cc .k-krow .name { display: block; max-width: 100%; height: 16px; text-align: left; padding: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 16px; font-weight: 400; color: var(--foreground); }
[data-orch] .orch-cc .k-krow .k-sub { display: flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0; font-size: 11px; line-height: 18px; color: var(--orch-muted); white-space: nowrap; }
[data-orch] .orch-cc .k-ktile { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 999px; color: var(--orch-muted); background: color-mix(in srgb, var(--foreground) 8%, transparent); }
[data-orch] .orch-cc .k-ktile .k-i { width: 14px; height: 14px; }
[data-orch] .orch-cc .k-list-h { margin: 12px 0 0; padding: 0 12px; font-size: 12px; line-height: 16px; font-weight: 400; color: var(--orch-muted); }
[data-orch] .orch-cc .k-inplace { padding: 8px 0 24px; cursor: default; }
[data-orch] .orch-cc .detail { min-width: 0; display: flex; flex-direction: column; gap: 16px; }
[data-orch] .orch-cc .k-dhead { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-width: 0; }
[data-orch] .orch-cc .k-dhead .name { font-size: 16px; line-height: 24px; }
[data-orch] .orch-cc .k-dhead .k-mon { color: var(--orch-muted); }
[data-orch] .orch-cc .k-dhead .k-type { font-weight: 600; }
[data-orch] .orch-cc .k-dhead .acts { margin-left: auto; }
[data-orch] .orch-cc .k-dfixed, [data-orch] .orch-cc .k-dcards { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
[data-orch] [data-fits-pane] > .orch-cc { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; padding-bottom: 0; }
[data-orch] [data-fits-pane] > .orch-cc .hits { flex: none; max-height: 35vh; overflow-y: auto; }
[data-orch] [data-fits-pane] .b-body { flex: 1 1 0; min-height: 0; grid-template-rows: minmax(0, 1fr); align-items: stretch; }
[data-orch] [data-fits-pane] .b-body > .k-listpane { min-height: 0; overflow-y: auto; scrollbar-gutter: stable; padding-bottom: 32px; }
[data-orch] [data-fits-pane] .b-body > .detail { min-height: 0; }
/* nothing in the fixed head shrinks: a flex box's minimum is its children's flex bases, so a shrinking chat card slides its row under the message box */
[data-orch] [data-fits-pane] .b-body > .detail > .k-dfixed { flex: none; min-height: 0; max-height: calc(100% - 48px); overflow-y: auto; scrollbar-gutter: stable; margin: -2px; padding: 2px; }
[data-orch] [data-fits-pane] .b-body > .detail > .k-dfixed > .k-chatcard, [data-orch] [data-fits-pane] .b-body > .detail > .k-dfixed .k-chat, [data-orch] [data-fits-pane] .b-body > .detail > .k-dfixed .k-chat > * { flex: none; }
[data-orch] [data-fits-pane] .b-body > .detail > .k-dfixed > .k-chatcard { overflow: clip; }
[data-orch] [data-fits-pane] .b-body > .detail > .k-dfixed .k-composer { position: sticky; bottom: 0; z-index: 1; background: var(--card); }
[data-orch] .orch-cc .k-dfixed .k-chat > .k-leadthread { height: var(--k-transcript-h, var(--k-leadthread-h, 480px)); }
[data-orch] .orch-cc .k-dfixed .k-chat > .k-chat__log { max-height: var(--k-transcript-h, 480px); }
[data-orch] [data-fits-pane] .b-body > .detail > .k-dcards { flex: 1 1 0; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; padding-bottom: 32px; }
[data-orch] .orch-cc[data-phone] .k-plist { gap: 0; }
[data-orch] .orch-cc[data-phone] .k-prow { align-items: start; min-height: 44px; padding: 4px 0; border-radius: 0; border-width: 0 0 1px; border-color: var(--border); }
[data-orch] .orch-cc[data-phone] .k-prow:hover { background: none; }
[data-orch] .orch-cc[data-phone] .k-prow .face { align-self: center; }
[data-orch] .orch-cc[data-phone] .k-prow .k-main { gap: 2px; }
[data-orch] .orch-cc[data-phone] .k-prow .k-name .name { min-height: 20px; height: 20px; }
[data-orch] .orch-cc[data-phone] .k-prow [data-list-scoping] { display: none; }
[data-orch] .orch-cc[data-phone] .k-prow .k-sub { flex-wrap: wrap; row-gap: 2px; overflow: visible; }
[data-orch] .orch-cc[data-phone] .k-prow .k-sub > * { white-space: nowrap; }
[data-orch] .orch-cc[data-phone] .k-prow .k-side { gap: 2px; }
[data-orch] .orch-cc[data-phone] .k-prow .k-side .k-age { order: -1; line-height: 18px; }
[data-orch] .orch-cc[data-phone] .k-prow[data-quiet="true"] { padding: 6px 0; }
[data-orch] .orch-cc[data-phone] .k-prow .k-chip { height: 18px; padding-inline: 6px; font-size: 12px; line-height: 16px; }
[data-orch] .orch-cc[data-phone] .k-kids { border-bottom: 1px solid var(--border); padding: 0 0 6px; }
[data-orch] .orch-cc[data-phone] .k-prow[data-fold="open"] { border-bottom-width: 0; }
[data-orch] .orch-cc[data-phone] .k-kids > ul { margin: 0; padding: 0; border: 0; }
[data-orch] .orch-cc[data-phone] .k-kids > ul::before { left: 16px; }
[data-orch] .orch-cc[data-phone] .k-krow { min-height: 44px; padding: 5px 8px 5px 32px; border-radius: 6px; }
[data-orch] .orch-cc[data-phone] .k-krow:hover { background: none; }
[data-orch] .orch-cc[data-phone] .k-krow[data-selected="true"] { background: var(--accent); }
[data-orch] .orch-cc[data-phone] .k-plist[data-folds] > .k-prow { grid-template-columns: 32px minmax(0, 1fr) auto 44px; }
[data-orch] .orch-cc[data-phone] .k-prow .k-fold { width: 44px; height: 44px; margin-block: -4px; align-self: center; }
[data-orch] .orch-cc[data-phone] .k-list-h { padding: 0; margin-top: 16px; }
[data-orch] .orch-cc[data-phone] .standing { flex-wrap: nowrap; white-space: nowrap; margin-bottom: 12px; }
[data-orch] .orch-cc[data-phone] .standing > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
[data-orch] .orch-cc[data-phone] .standing .right { flex: none; flex-basis: auto; margin-left: auto; }
[data-orch] .orch-cc[data-phone] .standing [data-standing-label] { display: none; }
[data-orch] .orch-cc[data-phone] .top { margin-bottom: 8px; }
[data-orch] .orch-cc[data-phone] .top { flex-wrap: wrap; gap: 8px; }
[data-orch] .orch-cc[data-phone] .top .filters > * { flex: none; padding-inline: 8px; }
[data-orch] .orch-cc[data-phone] .top [data-search] { flex: 1 0 100%; }
[data-orch] .orch-cc[data-phone] .standing { margin: 16px 0 0; }
[data-orch] .orch-cc[data-phone] .k-dhead :is(.k-mon, .k-type) { display: none; }
`;

function ListRow({ project, lanes, now, selected, quiet, kids, onSelect }: { project: Project; lanes: Lane[] | undefined; now: number; selected: boolean; quiet: boolean; kids?: Kids | null; onSelect: () => void }) {
  const r = listRow(project, lanes, now, quiet, kids ? scopeExtra(kids.list) : 0);
  return (
    <Item asChild>
    <li
      className="k-prow"
      data-selected={selected}
      data-project={project.slug}
      data-list-row={project.slug}
      data-state={r.state}
      data-quiet={quiet ? "true" : "false"}
      data-fold={kids ? (kids.open ? "open" : "closed") : undefined}
      style={accentVars(project.monType)}
      onClick={(e) => ((e.target as HTMLElement).closest("button, a") ? undefined : onSelect())}
    >
      <Face project={project} size={32} />
      <div className="k-main">
        <div className="k-name">
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
      {kids ? (
        <Button variant="ghost" size="icon-sm" className="k-fold" data-scope-fold={project.slug} aria-expanded={kids.open} aria-label={`${kids.open ? "Hide" : "Show"} scoping under ${project.slug}`} title={kids.open ? "Hide scoping" : "Show scoping"} onClick={kids.toggle}>
          {kids.open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
        </Button>
      ) : null}
    </li>
    </Item>
  );
}

type Kids = { list: ScopeChild[]; shown: ScopeChild[]; open: boolean; toggle: () => void };

const FOLD_KEY = (slug: string) => `orch:projects:scope-open:${slug}`;
function storedFold(slug: string): boolean | null {
  try {
    const v = localStorage.getItem(FOLD_KEY(slug));
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}
function storeFold(slug: string, open: boolean) {
  try {
    localStorage.setItem(FOLD_KEY(slug), open ? "1" : "0");
  } catch {
    // private window or blocked storage: the choice lasts for this view only
  }
}

function ScopeKids({ slug, kids, selected, onOpen }: { slug: string; kids: ScopeChild[]; selected: string | null; onOpen: (key: string) => void }) {
  return (
    <li className="k-kids" data-scope-children={slug}>
      <ul role="list" aria-label={`Scoping in ${slug}`}>
        {kids.map(({ entry: e, waiting: n }) => {
          const stuck = plannerStuck(e);
          const on = selected === e.key;
          return (
            <Item key={e.key} asChild size="sm">
              <li className="k-krow" data-scope-row={e.key} data-selected={on} onClick={(ev) => ((ev.target as HTMLElement).closest("button, a") ? undefined : onOpen(e.key))}>
                <span className="k-ktile" data-scope-tile="">
                  <Icon name="scope" />
                </span>
                <span className="k-main">
                  <Button variant="link" className={cn("name", INLINE_LINK, "no-underline hover:underline")} data-scope-pick={e.key} aria-current={on ? "true" : undefined} onClick={() => onOpen(e.key)}>
                    {entryTitle(e).title}
                  </Button>
                  <span className="k-sub">
                    <span className="truncate" data-scope-row-waiting={String(n)}>
                      {n ? `${n} ${n === 1 ? "waits" : "wait"} on you` : "nothing waits"}
                      {stuck ? ` · ${stuck}` : ""}
                    </span>
                  </span>
                </span>
              </li>
            </Item>
          );
        })}
      </ul>
    </li>
  );
}

function DetailPanel({ project, lanes, busy, refetchAll, openCard, onOpen, onPick, now, narrow, needs, scoping = 0, inPlace = false, onBack }: { project: Project; lanes: Lane[] | undefined; busy: boolean; refetchAll: () => void; openCard: OpenCard; onOpen: (slug: string) => void; onPick: () => void; now: number; narrow: boolean; needs: NeedsYou | undefined; scoping?: number; inPlace?: boolean; onBack?: () => void }) {
  const { cosTitle, ownerName } = useIdentity();
  const [confirming, setConfirming] = useState(false);
  const [pinning, setPinning] = useState(false);
  const head = leadHead(project);
  const askStatus = askStatusFor(project, now, refetchAll);
  const st = projectState(project, lanes);
  const forYou = needCount(project, lanes) + scoping;
  const leadLane = lanes?.find((l) => l.agent.role === "lead");
  const leadLevel = leadLane ? leadLane.agent.level : null;
  const party = partyOf((lanes ?? []).filter((l) => l.state !== "released").map((l) => l.agent), project.slug, head.persona?.roster);
  const startLead = () => {
    const body: z.input<typeof startLeadBody> = { slug: project.slug };
    void write(WRITES.startLead, body, { kind: "other", where: `lead:${project.slug}`, after: refetchAll });
  };
  const held = project.heldAt !== null;
  const headFit = useHeadFit<HTMLDivElement>();
  const more = <MoreMenu project={project} busy={busy} refetchAll={refetchAll} narrow={narrow} onArchive={() => setConfirming(true)} askStatus={askStatus} askInMenu onPin={() => setPinning(true)} />;
  return (
    <div className="detail" data-project={project.slug} data-detail-panel={project.slug} data-held={held ? "true" : "false"} style={accentVars(project.monType)}>
      <ProjectRefs.Provider value={{ project: project.slug, prs: project.prs ?? [] }}>
        <div className="k-dfixed" ref={headFit} data-detail-head={project.slug}>
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
            <ChatCard slug={project.slug}>
              <ChatLog project={project} now={now} cos={cosTitle} busy={busy} refetchAll={refetchAll} onPick={onPick} />
            </ChatCard>
          ) : null}
          {held ? <div className="muted small">Mail to this lead is held until the project resumes.</div> : null}
          <PageError where={`lead:${project.slug}`} />
          <ArchiveConfirm project={project} open={confirming} busy={busy} refetchAll={refetchAll} onDone={() => setConfirming(false)} />
        </div>
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
          {onBack ? <ProjectSections project={project} lanes={lanes} openCard={openCard} ownerName={ownerOnScreen(ownerName).name} /> : null}
          {onBack ? <PathwaysPart slug={project.slug} narrow /> : null}
        </div>
      </ProjectRefs.Provider>
    </div>
  );
}

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
  board = null,
  onBoard = () => {},
}: {
  q: Query;
  refetchAll: () => void;
  agents: Board["agents"] | undefined;
  lanesFrom: Agents | undefined;
  needs: NeedsYou | undefined;
  openCard: OpenCard;
  detail: string | null;
  picked: string | null;
  onPick: (slug: string | null) => void;
  onDetail: (slug: string | null) => void;
  refs: SharedRefs | null;
  scope: ScopeQuery;
  scopeOpen: string | null;
  onScope: (key: string | null) => void;
  pathwaysOpen?: boolean;
  deliverables: Deliverables | undefined;
  mons: ReadonlyMap<string, FaceOf>;
  accents: ReadonlyMap<string, string | null>;
  board?: BoardPlace | null;
  onBoard?: (place: BoardPlace | null, how?: "push" | "replace") => void;
}) {
  useGate();
  const { ownerName, cosTitle } = useIdentity();
  const you = ownerOnScreen(ownerName);
  const [filter, setFilter] = useState<Filter>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [toggled, setToggled] = useState<Record<string, FoldPress>>({});
  const found = useSettled(query);
  useEffect(() => {
    if (!found.trim()) setToggled((t) => (Object.values(t).some((x) => x.q.trim()) ? Object.fromEntries(Object.entries(t).filter(([, x]) => !x.q.trim())) : t));
  }, [found]);
  useEffect(() => {
    setToggled((t) => leftEntry(t, scopeOpen));
  }, [scopeOpen]);
  const [width, root] = useElementWidth();
  // a second Projects pane must not scroll with this one
  const pane = usePaneId();
  const here = pane ? `[data-pane="${CSS.escape(pane)}"]` : "[data-orch]";
  const phone = useTouchPhone();
  const narrow = width > 0 && width <= 640;
  const wide = isWide(width);
  const kept = useProjectsView();
  const [opening, setOpening] = useState<Opening>("waiting");
  const at: OpenAt = board ? (board.project === null && board.task === null ? "board" : "other") : !detail && !picked && !scopeOpen && !pathwaysOpen ? "list" : "other";
  const step = openStep(opening, kept, at);
  const toBoard = step.move === "board" && at === "list";
  // after this mount's effects: the app's own, in a parent, settles the URL first, and a move made before it would be undone
  useEffect(() => {
    if (step.next === opening && !step.move) return;
    const t = setTimeout(() => {
      setOpening(step.next);
      if (step.next === "done" && kept.server && kept.server !== kept.copy) saveViewCopy(kept.server);
      if (step.move) onBoard(step.move === "board" ? { project: null, task: null } : null, "replace");
    });
    return () => clearTimeout(t);
  }, [opening, step.next, step.move]);
  // only the list's root fits the pane ([data-fits-pane]): the board and web project page return before it
  const listShown = !toBoard && !board && !!q.data && !(detail && !phone && q.data.some((p) => p.slug === detail));
  usePaneFits(wide && listShown);
  const now = useMinute();
  const busy = gate.lock !== null;
  useEffect(() => {
    if (phone || scopeOpen || (picked && !wide)) document.querySelector(`${here} [data-projects-width]`)?.closest(".orch-pane__scroll")?.scrollTo({ top: 0 });
  }, [detail, scopeOpen, phone, picked]);
  const switcher = (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      aria-label="View"
      data-projects-view={board ? "board" : "list"}
      value={board ? "board" : "list"}
      onValueChange={(v) => {
        const to = v === "board" || v === "list" ? v : board ? "board" : "list";
        setOpening("done");
        kept.pick(to);
        if ((to === "board") !== !!board) onBoard(to === "board" ? { project: null, task: null } : null);
      }}
    >
      <ToggleGroupItem value="list" data-view-pick="list">
        List
      </ToggleGroupItem>
      <ToggleGroupItem value="board" data-view-pick="board">
        Board
      </ToggleGroupItem>
    </ToggleGroup>
  );
  if (toBoard) return null;
  if (board)
    return (
      <div className="orch-cc tab pb-8" data-phone={phone || undefined} data-projects-tab="" data-layout="board">
        <BoardView place={board} onPlace={(p, how) => onBoard(p, how)} switcher={switcher}
          since={(project, onLens, shown) => <BoardSince project={project} onLens={onLens} shown={shown} />}
          movedChip={(move, now) => <MovedChip move={move} now={now} />}
          reads={{ needs, scope: scope.data, deliverables, projects: q.data, refetchAll }}
        />
      </div>
    );
  const all = q.data;
  if (!all) return <ReadState q={q} what="the projects" />;
  const lanes = buildLanes(lanesFrom, needs);
  const open = (slug: string | null) => {
    const p = slug ? all.find((x) => x.slug === slug) : undefined;
    if (p && phone) markSeen(p, refetchAll);
    onDetail(slug);
  };
  const linked = detail ? all.find((p) => p.slug === detail) : undefined;
  if (linked && !phone) return <ProjectDetail project={linked} lanes={lanes.get(linked.slug)} onBack={() => open(null)} openCard={openCard} ownerName={you.name} pathwaysOpen={pathwaysOpen} />;
  const cards = needs?.cards ?? [];
  const live = all.filter((p) => p.archivedAt === null);
  const scoping = scope.data?.projects ?? [];
  const entries = scopeEntries(scoping);
  const kidsBy = new Map<string, ScopeChild[]>();
  for (const sp of scoping) kidsBy.set(sp.slug, entries.filter((e) => e.slug === sp.slug).map((entry) => ({ entry, waiting: scopeWaitingIn(sp, entry, deliverables), deliverables: scopeDeliveredIn(sp, entry, deliverables) })));
  const kidsOf = (p: Project) => kidsBy.get(p.slug) ?? [];
  const fits = (f: Filter, p: Project) => matchesWithScope(f, matches(f, p, lanes.get(p.slug)), kidsOf(p));
  const count = (f: Filter) => live.filter((p) => fits(f, p)).length;
  const hits = found.trim() ? searchLoaded(live, lanes, cards, found, (w) => waitLine(w, now, cosTitle).text) : [];
  const filtered = live.filter((p) => fits(filter, p));
  const searched = new Set(searchedProjects(filtered, hits, found).map((p) => p.slug));
  const shown = filtered.filter((p) => searched.has(p.slug) || childHits(kidsOf(p), found).length > 0).sort(attentionOrder(lanes, now, (p) => needCount(p, lanes.get(p.slug)) + scopeExtra(kidsOf(p))));
  const taskHits: TaskHit[] = found.trim() ? shown.flatMap((p) => childHits(kidsOf(p), found).map((k) => ({ project: p.slug, key: k.entry.key, name: k.entry.task!.name }))) : [];
  const quietOne = (p: Project) => quietWithScope(isQuiet(p, lanes.get(p.slug), now), kidsOf(p));
  const main = shown.filter((p) => !quietOne(p));
  const quiet = shown.filter(quietOne);
  const kidsFor = (p: Project): Kids | null => {
    const list = kidsOf(p);
    if (!list.length) return null;
    const hit = found.trim() ? childHits(list, found) : [];
    const held = scopeOpen && list.some((k) => k.entry.key === scopeOpen) ? scopeOpen : null;
    const isOpen = childrenOpen({ kids: list, toggled: toggled[p.slug], q: found, stored: storedFold(p.slug), held, searchHit: hit.length > 0 });
    const toggle = () => {
      setToggled((t) => ({ ...t, [p.slug]: { open: !isOpen, q: found, held } }));
      storeFold(p.slug, !isOpen);
    };
    return { list, shown: hit.length ? hit : list, open: isOpen, toggle };
  };
  const archived = filter === "all" && !found.trim() ? all.filter((p) => p.archivedAt !== null).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)) : [];
  const pick = (p: Project) => {
    onPick(p.slug);
    markSeen(p, refetchAll);
  };
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
  // `page`: picking the project there would route to projects/@<slug>, which a phone draws as the list
  const detailPanel = (p: Project, o: { onBack?: () => void; inPlace?: boolean; page?: boolean } = {}) => <DetailPanel key={p.slug} project={p} lanes={lanes.get(p.slug)} busy={busy} refetchAll={refetchAll} openCard={openCard} onOpen={open} onPick={o.page ? () => {} : () => onPick(p.slug)} now={now} narrow={narrow} needs={needs} scoping={scopeExtra(kidsOf(p))} onBack={o.onBack} inPlace={o.inPlace} />;
  const scopePage = scopeOpen ? <ScopeView q={scope} projects={all} deliverables={deliverables} refetchAll={refetchAll} mons={mons} accents={accents} focus={scopeOpen} entryOnly fits={wide} /> : null;
  const styles = (
    <>
      {/* a changed block gets a new href: React keeps a style by its href */}
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
  const filters = (
    <ToggleGroup type="single" variant="outline" size="sm" aria-label="Filter" className="filters" data-needs-me-filter={filter} value={filter} onValueChange={(f) => f && setFilter(f as Filter)}>
      {FILTERS.map((f) => (
        <ToggleGroupItem key={f} value={f} data-filter={f}>
          {phone ? (SHORT_FILTER_WORD[f] ?? FILTER_WORD[f]) : FILTER_WORD[f]} <span className="text-muted-foreground tabular-nums">{f === "all" ? live.length : count(f)}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
  const searchShown = !phone || searching || query !== "";
  const top = phone ? (
    <div className="top" data-top-row="">
      {switcher}
      <ScrollRow className="flex-1">{filters}</ScrollRow>
      {searchShown ? null : <Btn tone="ghost" className="size-11 shrink-0" icon={<Search aria-hidden />} aria-label="Search the projects" title="Search" data-search-open="" onClick={() => setSearching(true)} />}
      {searchShown ? <SearchBox value={query} onChange={setQuery} autoFocus={searching} /> : null}
    </div>
  ) : (
    <div className="top">
      {switcher}
      {filters}
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
    ps.map((p) => {
      const kids = kidsFor(p);
      return (
        <Fragment key={p.slug}>
          {wide ? (
            <ListRow project={p} lanes={lanes.get(p.slug)} now={now} selected={p === selected} quiet={isQuietGroup} kids={kids} onSelect={() => pick(p)} />
          ) : phone ? (
            <ListRow project={p} lanes={lanes.get(p.slug)} now={now} selected={false} quiet={isQuietGroup} kids={kids} onSelect={() => open(p.slug)} />
          ) : (
            <ListRow project={p} lanes={lanes.get(p.slug)} now={now} selected={false} quiet={isQuietGroup} kids={kids} onSelect={() => pick(p)} />
          )}
          {kids?.open ? <ScopeKids slug={p.slug} kids={kids.shown} selected={wide ? scopeOpen : null} onOpen={(k) => onScope(k)} /> : null}
        </Fragment>
      );
    });
  const folds = (ps: Project[]) => (ps.some((p) => kidsOf(p).length > 0) ? "" : undefined);
  const list = (
    <div className={wide ? "k-listpane" : undefined} data-projects-list="">
      {main.length ? (
        <ul className="k-plist" role="list" aria-label="Projects" data-group="led" data-folds={folds(main)}>
          {rows(main, false)}
        </ul>
      ) : null}
      {quiet.length ? (
        <div data-group="quiet">
          <h3 className="k-list-h">Quiet · {quiet.length}</h3>
          <ul className="k-plist" role="list" aria-label="Quiet projects" data-folds={folds(quiet)}>
            {rows(quiet, true)}
          </ul>
        </div>
      ) : null}
      {archivedGroup}
    </div>
  );
  return (
    <RefsContext.Provider value={refs}>
    <div ref={root} data-projects-width={width} data-fits-pane={wide || undefined}>
    <div className={cx("orch-cc tab pb-8", !wide && "narrow-book")} data-phone={phone || undefined} data-projects-tab="" data-layout={wide ? "list-detail" : "column"} data-page={page ? (scopeOpen ? "scope" : "project") : undefined} style={wide ? undefined : { maxWidth: 1000, marginInline: "auto" }}>
      {styles}
      {page ? (
        <div className="flex min-w-0 flex-col gap-2" data-project-page={scopeOpen ?? linked?.slug ?? pickedPage?.slug}>
          {page}
        </div>
      ) : (
        <>
          {phone ? null : <StandingAgents agents={agents} full={lanesFrom} busy={busy} refetchAll={refetchAll} />}
          {top}
          {found.trim() ? <SearchHits q={found} hits={hits} tasks={taskHits} projects={live} now={now} onOpen={reach} /> : null}
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
          {phone ? <StandingAgents agents={agents} full={lanesFrom} busy={busy} refetchAll={refetchAll} /> : null}
        </>
      )}
    </div>
    </div>
    </RefsContext.Provider>
  );
}

