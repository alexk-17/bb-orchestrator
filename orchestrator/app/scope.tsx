// The Scope tab (1.11.0): the projects in scoping mode, where the owner works out a new project with its lead directly.
// One project open at a time: the chat with its lead (the 1.10.0 chat log and composer, direct-line.tsx) beside the
// cards its lead filed and the deliverables it handed over, answerable in place with Needs you's own card and the
// Deliverables tab's own card. While the project scopes these never reach the CoS's triage, Needs you or Deliverables;
// the owner's yes on the lead's "Scoping done?" card makes the project active, and it leaves this tab.
// 1.12.0: an active project is listed too while it has open scoping tasks. The list is grouped project > task: "whole
// project" for one scoping as a whole, "task: <name>" for each open task. Opening one shows the project's chat (the same
// chat for each of its entries) beside that entry's own cards and deliverables.
// 1.13.0: a list grouped by project on the left (each entry with its planner and its count), the entry on the right: its
// header (who plans it and what happens next), its cards, then its chat (beside the cards when the pane is wide, so the
// chat stays in view while the owner answers). Narrow, the list sits above the entry.
// 1.16.0: each list entry is a Card (interactive; the open one, selected) with its count as a Badge (app/ui's since the
// 2026-11-17 shadcn pass); the entry's header is one Card (what, who plans it, what happens next); the routing rule is the Scoping
// chip's tooltip, not a paragraph. The cards column keeps Needs you's and Deliverables' own cards, on this tab's type
// and spacing rules.
// 2026-11-17: while nothing in the entry waits on the owner, one status card stands where the cards would (who is
// scoping, what they are on now, what is done so far, what comes next), in a slim column beside the chat when the pane
// is wide, so no column stands blank. With anything waiting the entry is as before.
import { useEffect, useRef, useState } from "react";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import type { z } from "zod";
import { experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Check, ChevronRight, Hourglass, Minus, Plus, UserRound } from "lucide-react";
import { WRITES, rpcContract, type Card, type Deliverables, type Projects, type Scope, type Pathways, type answerBody, type secretBody } from "../contract.ts";
import { layout } from "./diagram-layout.ts";
import { openInBb, PANEL_PATH } from "./open-proof.ts";
import { ccCss } from "./cc-lines.tsx";
import { ChatBody, ChatCard, Composer, ThreadBox, directCss, markSeen } from "./direct-line.tsx";
import { CardView, useArming, via, type Act } from "./needs-you.tsx";
import { DeliverableCard, inScope } from "./deliverables.tsx";
import { answerCss } from "./answer-ui.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Card as UiCard, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.tsx";
import { Item, ItemGroup } from "./ui/item.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { Separator } from "./ui/separator.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { cn } from "./ui/utils.ts";
import { Chip, kitCss } from "./kit-ui.tsx";
import { STATE_CHIP, inScopeEntry, plannerOf, scopeDone, scopeEntries, scopeNext, scopeQuiet, scopeStatus, type ScopeEntry, type ScopeStatus } from "./kit.ts";
import { entryTitle, plannerName } from "./scope-names.ts";
import { projectTitle } from "../core/model.ts";
import { AgentFace, type Face } from "./face.tsx";
import { personaName } from "./faces.ts";
import { OpenRef } from "./project-book.tsx";
import { panel } from "./refs.ts";
import { age } from "./lanes.ts";
import { isWide } from "./source.ts";
import { useElementWidth } from "./panes.tsx";
import { useMinute } from "./status-bar.tsx";
import { useIdentity } from "./identity.ts";
import { ownerOnScreen } from "../core/owner.ts";
import { gate, gone, useGate, write, type Hide, type WriteKind } from "./store.ts";
import { Btn, EmptyState, ReadState } from "./ui.tsx";
import { styleHref } from "./style-href.ts";

/** Every entry's label this page has shown, by key: the one that leaves the tab (its scoping ended) is named when it goes. */
const labels = new Map<string, string>();

type Query = { data: Scope | undefined; error: { message: string } | null; refetch: () => Promise<void> };
type Project = Projects[number];

/** At this pane width and wider, the list sits beside the entry (the Projects tab's switch, source.ts); narrower, one column. */
const listBeside = isWide;
/** From this pane width the entry's chat sits beside its cards, so it stays in view while the owner answers them. */
const CHAT_BESIDE_MIN = 1440;

const scopeCss = /* css */ `
[data-orch] .orch-scope { padding-bottom: 32px; }
[data-orch] .orch-scope__grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 24px; align-items: start; }
[data-orch] .orch-scope[data-layout="list-detail"] .orch-scope__grid { grid-template-columns: minmax(280px, 340px) minmax(0, 1fr); gap: 32px; }
/* the list: grouped by project, each project under its name and its lead's avatar, each entry one card of one height */
[data-orch] .orch-scope__list { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
/* a pane too narrow for the list beside the entry: the groups sit side by side where two fit, so the entry and its chat come sooner */
[data-orch] .orch-scope[data-layout="column"] .orch-scope__list { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; align-items: start; }
[data-orch] .orch-scope__group { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
/* the entry: its header card, then its cards, then its chat (beside the cards when the pane is wide) */
[data-orch] .orch-scope .orch-scope__entrybox { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
[data-orch] .orch-scope .orch-scope__fixed { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
[data-orch] .orch-scope__body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 24px; align-items: start; }
[data-orch] .orch-scope__body[data-side="true"] { grid-template-columns: minmax(0, 1fr) minmax(360px, 1fr); }
[data-orch] .orch-scope__body[data-side="true"] > [data-scope-chat] { position: sticky; top: 8px; }
/* 2026-11-17, the owner: the list and the header stay put, only what is under the header scrolls (as on Projects). Wide,
   the tab takes the pane's height (panes.tsx [data-fits-pane]): the list scrolls on its own when it is taller, the
   entry's header card stays, and the body (its cards or status card, and the chat) is the one region that scrolls, from
   the top again for each entry (keyed by it). The chat beside the cards stays in view in it (sticky). One column keeps
   the one scroll of the pane */
[data-orch] [data-fits-pane] > .orch-scope { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; padding-bottom: 0; }
[data-orch] [data-fits-pane] .orch-scope__grid { flex: 1 1 0; min-height: 0; grid-template-rows: minmax(0, 1fr); align-items: stretch; }
[data-orch] [data-fits-pane] .orch-scope__list { min-height: 0; overflow-y: auto; scrollbar-gutter: stable; padding-bottom: 32px; }
[data-orch] [data-fits-pane] .orch-scope__entrybox { min-height: 0; }
/* the header keeps the body's scrollbar room (stable gutter), so its right edge lines up with the cards' */
[data-orch] [data-fits-pane] .orch-scope__fixed { flex: none; overflow: hidden; scrollbar-gutter: stable; margin: -2px; padding: 2px; }
[data-orch] [data-fits-pane] .orch-scope__body { flex: 1 1 0; min-height: 200px; overflow-y: auto; scrollbar-gutter: stable; padding-bottom: 32px; }
/* nothing waits (2026-11-17): the status card in a column about the list's width, the chat in all the rest */
[data-orch] .orch-scope__body[data-quiet="true"][data-side="true"] { grid-template-columns: minmax(280px, 340px) minmax(0, 1fr); }
[data-orch] .orch-scope__col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
`;

/** The open cards first the "Scoping done?" one, then oldest first (the order the lead filed them in). */
const ordered = (cards: Card[]) => [...cards].sort((a, b) => Number(!!b.scopingDone) - Number(!!a.scopingDone) || (a.askedAt < b.askedAt ? -1 : 1));

/** What the gone-notice calls an entry: its project's name and its title. */
const entryWord = (e: ScopeEntry) => entryTitle(e).title;

/**
 * Who plans an entry, in one format everywhere (2026-11-17, the owner's Scope ask): the planner's avatar (the lead's or
 * the scoping thread's Pokémon; its letter with Pokémon off) and a short name, then its state and the task's slug, muted.
 * 2026-11-18, the owner: a long thread name ran past the card's edge and under its count. The words are one line now that
 * ends in an ellipsis inside the card; the full line is the tooltip.
 */
function PlannerLine({ e, mon, size = 20, slug = true, ...data }: { e: ScopeEntry; mon: (address: string) => Face | null; size?: 20 | 24; slug?: boolean; [d: `data-${string}`]: string | undefined }) {
  const p = plannerName(e);
  const face = mon(p.address);
  // 2026-11-18: a lead with a persona is named by it ("Vesna"), as a person is
  const name = p.address.startsWith("lead:") && face?.persona ? face.persona.name : p.name;
  const s = slug ? entryTitle(e).slug : null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={`${plannerOf(e).text}${s ? ` · ${s}` : ""}`} {...data}>
      <AgentFace face={face} address={p.address} size={size} boost={false} />
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">{name}</span>
        {p.state ? ` · ${p.state}` : null}
        {s ? <span className="font-mono"> · {s}</span> : null}
      </span>
    </span>
  );
}

/** `focus`: the entry (scopeKey) a link elsewhere (a project's "Answer") asked to open here. */
export function ScopeView({ q, projects, deliverables, refetchAll, mons, accents, focus = null }: { q: Query; projects: Projects | undefined; deliverables: Deliverables | undefined; refetchAll: () => void; mons: ReadonlyMap<string, Face>; accents?: ReadonlyMap<string, string | null>; focus?: string | null }) {
  useGate();
  const { ownerName, cosTitle } = useIdentity();
  const you = ownerOnScreen(ownerName);
  const now = useMinute();
  const [width, measure] = useElementWidth();
  const [picked, setPicked] = useState<string | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const arming = useArming(root);
  useEffect(() => {
    if (focus) setPicked(focus);
  }, [focus]);
  // the first entry, once the data is in, is the one shown: pinned, so when its scoping ends the tab says so and stays in
  // its project, as for an entry the owner picked
  const first = q.data ? (scopeEntries(q.data.projects)[0]?.key ?? null) : null;
  useEffect(() => {
    if (picked === null && first) setPicked(first);
  }, [picked, first]);
  const styles = (
    <>
      <style href={styleHref("orch-cc", ccCss)} precedence="default">
        {ccCss}
      </style>
      <style href={styleHref("orch-cc-direct", directCss)} precedence="default">
        {directCss}
      </style>
      <style href={styleHref("orch-kit", kitCss)} precedence="default">
        {kitCss}
      </style>
      <style href={styleHref("orch-answer", answerCss)} precedence="default">
        {answerCss}
      </style>
      <style href={styleHref("orch-scope", scopeCss)} precedence="default">
        {scopeCss}
      </style>
    </>
  );
  const setRoot = (el: HTMLDivElement | null) => {
    root.current = el;
    measure(el);
  };
  if (!q.data)
    return (
      <div ref={setRoot} data-scope-tab="">
        <ReadState q={q} what="the scoping projects" />
      </div>
    );
  const list = q.data.projects;
  if (list.length === 0)
    return (
      <div ref={setRoot} data-scope-tab="" data-scope-empty="" className="orch-cc orch-scope">
        {styles}
        <EmptyState
          title="Nothing is scoping"
          text={`A project in scoping mode, or one part of an active project that its lead scopes, shows here: its cards and the chat with its lead, before any build thread starts. What it files reaches only ${you.name}.`}
        />
      </div>
    );
  const entries = scopeEntries(list);
  for (const e of entries) labels.set(e.key, `${projectTitle(e.slug)} › ${entryWord(e)}`);
  // the entry picked, else (it left the tab: its scoping ended) another of its project, else the first
  const pickedSlug = picked?.split("/")[0] ?? null;
  const entry = entries.find((e) => e.key === picked) ?? entries.find((e) => e.slug === pickedSlug) ?? entries[0]!;
  const left = picked && !entries.some((e) => e.key === picked) ? labels.get(picked) ?? null : null;
  const open = list.find((p) => p.slug === entry.slug)!;
  const task = entry.task?.id ?? null;
  const project = projects?.find((p) => p.slug === open.slug);
  // an avatar's face: a lead's from its project (as in the sidebar), a scoping thread's from the board
  const monOf = (address: string): Face | null => {
    const lead = projects?.find((x) => `lead:${x.slug}` === address)?.lead;
    return lead && (lead.mon || lead.persona) ? { mon: lead.mon, persona: lead.persona } : (mons.get(address) ?? null);
  };
  const pick = (e: ScopeEntry) => {
    setPicked(e.key);
    const p = projects?.find((x) => x.slug === e.slug);
    if (p) markSeen(p, refetchAll); // choosing the entry shows its project's chat, so the lead's replies there are seen
  };
  const openCount = (e: ScopeEntry) => {
    const p = list.find((x) => x.slug === e.slug)!;
    return p.cards.filter((c) => !gone.has(`${c.id}@${c.rev}`) && inScopeEntry(p, e.task?.id ?? null, c.scopeTask)).length;
  };
  const groups = list.map((p) => ({ p, entries: entries.filter((e) => e.slug === p.slug) })).filter((g) => g.entries.length);

  // the same write as Needs you's, under the same page lock and arming
  const send = (card: Card, kind: WriteKind, hide: Hide, path: string, body: unknown) => {
    if (gate.lock) return;
    if (!arming.check(card.id, card.rev)) return;
    void write(path, body, { card: { id: card.id, rev: card.rev, hide }, kind, after: refetchAll });
  };
  const act: Act = {
    answer(card, _list, option, note) {
      const body: z.input<typeof answerBody> = { id: card.id, rev: card.rev, option, text: note.trim() ? note : null, via: via() };
      send(card, "answer", "both", WRITES.answer, body);
    },
    secret(card, _list, value) {
      const body: z.input<typeof secretBody> = { id: card.id, rev: card.rev, value, via: via() };
      send(card, "answer", "both", WRITES.secret, body);
    },
    // a scoping card is never deferred: it waits here until answered
    defer: () => undefined,
    bringBack: () => undefined,
  };
  const cards = ordered(open.cards.filter((c) => !gone.has(`${c.id}@${c.rev}`) && inScopeEntry(open, task, c.scopeTask)));
  const delivered = (deliverables ?? []).filter((d) => d.project === open.slug && inScope(d) && inScopeEntry(open, task, d.scopeTask)).sort((a, b) => b.updatedAt - a.updatedAt);
  const wide = listBeside(width);
  // nothing waits: the status card in place of the cards, beside the chat whenever the list is beside the entry
  const quiet = scopeQuiet({ cards: cards.length, delivered: delivered.length });
  const side = quiet ? wide : width >= CHAT_BESIDE_MIN;
  const planner = plannerOf(entry);
  const next = scopeNext(entry, { cards, delivered: delivered.length, hasLead: !!project?.lead });
  const routing = `What is filed here reaches only ${you.name}: no CoS triage, no standing rule.${entry.task && open.whole === false ? ` Only this task scopes here; the rest of ${open.slug} goes the normal way.` : ""}`;

  const listNav = (
    <nav className="orch-scope__list" aria-label="Scoping">
      {groups.map(({ p, entries: es }) => (
        <div key={p.slug} className="orch-scope__group" role="group" aria-label={projectTitle(p.slug)} data-scope-group={p.slug}>
          {/* the project as the sidebar names it, beside its lead's avatar */}
          <h3 className="m-0 flex min-w-0 items-center gap-2 px-1 text-sm font-semibold" title={p.slug}>
            <AgentFace face={monOf(`lead:${p.slug}`)} address={`lead:${p.slug}`} size={24} boost={false} />
            <span className="truncate">{projectTitle(p.slug)}</span>
            {p.whole === false ? <span className="shrink-0 text-xs font-normal text-muted-foreground">active</span> : null}
          </h3>
          <ItemGroup className="gap-2">
            {es.map((e) => {
              const n = openCount(e);
              const current = e.key === entry.key;
              return (
                <div key={e.key} role="listitem" data-selected={current ? "true" : undefined}>
                  <Button
                    variant="outline"
                    className={cn("h-auto w-full justify-between gap-3 rounded-lg bg-card px-3 py-2.5 text-left font-normal whitespace-normal shadow-xs", current && "border-ring bg-accent")}
                    data-scope-pick={e.key}
                    aria-current={current ? "true" : undefined}
                    onClick={() => pick(e)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate text-sm font-medium">{entryTitle(e).title}</span>
                      <PlannerLine e={e} mon={monOf} data-planner={plannerOf(e).kind} data-scope-planner={e.key} />
                    </span>
                    {n ? (
                      <Badge className="h-5 min-w-5 shrink-0 rounded-full px-1.5 tabular-nums" data-scope-open={String(n)} role="img" title={`${n} waiting on you`} aria-label={`${n} waiting on you`}>
                        {n}
                      </Badge>
                    ) : null}
                  </Button>
                </div>
              );
            })}
          </ItemGroup>
        </div>
      ))}
    </nav>
  );
  const head = (
    <UiCard role="region" aria-label={`${projectTitle(open.slug)} › ${entryTitle(entry).title}`} className="orch-scope__head gap-3 py-4" data-scope-project={open.slug} data-scope-entry={entry.key}>
      <CardHeader className="px-4">
        <CardTitle role="heading" aria-level={2} className="flex min-w-0 items-center gap-1.5 text-base leading-6">
          <span className="shrink-0">{projectTitle(open.slug)}</span>
          <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-medium" title={entry.task?.name}>
            {entryTitle(entry).title}
          </span>
        </CardTitle>
        {/* min-w-0: the header's grid column can't grow past the card for a long line (2026-11-18, the owner) */}
        <CardDescription className="min-w-0">
          {/* the planner's avatar and name; the full line (and while nothing waits, the status card) say the rest */}
          <PlannerLine e={entry} mon={monOf} size={24} data-planner={planner.kind} data-scope-head-planner="" />
        </CardDescription>
        <CardAction>
          <Chip spec={STATE_CHIP.scoping} title={routing} data-scope-state="" />
        </CardAction>
      </CardHeader>
      {quiet ? null : (
        <CardContent className="px-4">
          <p className="m-0 text-sm" data-scope-next="">
            {next}
          </p>
        </CardContent>
      )}
    </UiCard>
  );
  const cardsCol = (
    <section className="orch-scope__col" data-scope-cards={open.slug} data-scope-cards-task={task ?? ""} aria-label={entry.task ? `${open.slug}'s cards for ${entry.task.name}` : `${open.slug}'s cards`}>
      {cards.length || delivered.length ? (
        <h3 className="m-0 px-1 text-xs font-normal text-muted-foreground" data-scope-waiting="">
          Waiting on you: {cards.length ? `${cards.length} ${cards.length === 1 ? "card" : "cards"}` : ""}
          {cards.length && delivered.length ? ", " : ""}
          {delivered.length ? `${delivered.length} to review` : ""}
        </h3>
      ) : null}
      {/* pass 4's cards, drawn as Needs you draws them: no frame of this tab's around them */}
      {cards.length ? (
        <div className="flex flex-col gap-3" data-list="scope">
          {cards.map((c) => (
            <CardView key={c.id} card={c} list="cards" presets={[]} isArmed={arming.isArmed(c.id, c.rev)} act={act} mon={mons.get(c.origin) ?? null} monType={accents?.get(open.slug) ?? null} />
          ))}
        </div>
      ) : null}
      {delivered.map((d) => (
        <DeliverableCard key={d.id} d={d} refetchAll={refetchAll} outputs={[]} outputsAfter={() => undefined} />
      ))}
    </section>
  );
  const chatCol = (
    <section className="orch-scope__col" data-scope-chat={open.slug} aria-label={`Chat with the ${open.slug} lead`}>
      {project?.lead ? (
        <ScopeChat
          key={entry.key}
          project={project}
          entry={entry}
          now={now}
          cos={cosTitle}
          refetchAll={refetchAll}
          height={side ? "clamp(320px, calc(100vh - 470px), 640px)" : undefined}
          onFocus={() => {
            setPicked(entry.key);
            markSeen(project, refetchAll);
          }}
        />
      ) : (
        <>
          <p className="m-0 text-sm text-muted-foreground" data-scope-no-lead="">
            {project ? `No lead is running for ${open.slug}: start it from Projects, and the chat opens here.` : "Loading the chat…"}
          </p>
          {project?.direct?.messages.length ? (
            <ChatCard slug={project.slug}>
              <ChatBody project={project} now={now} cos={cosTitle} busy={gate.lock !== null} refetchAll={refetchAll} />
            </ChatCard>
          ) : null}
        </>
      )}
    </section>
  );
  return (
    <div ref={setRoot} data-scope-tab="" data-scope-width={width} data-fits-pane={wide || undefined}>
      {styles}
      <div className="orch-cc orch-scope" data-layout={wide ? "list-detail" : "column"} data-chat={side ? "side" : "below"} style={wide ? undefined : { maxWidth: 800, marginInline: "auto" }}>
        <div className="orch-scope__grid">
          {listNav}
          <div className="orch-scope__entrybox">
            <div className="orch-scope__fixed" data-scope-fixed="">
              {left ? (
                <p className="m-0 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground" data-scope-left="">
                  {left} is no longer scoping: it left this tab, and anything still open under it went the normal way.
                </p>
              ) : null}
              {head}
            </div>
            <div key={entry.key} className="orch-scope__body" data-scope-scroll={entry.key} data-side={side ? "true" : "false"} data-quiet={quiet ? "true" : "false"}>
              {quiet ? (
                <StatusCard
                  entry={entry}
                  s={scopeStatus(entry, project)}
                  done={scopeDone(deliverables ?? [], open, task)}
                  next={next}
                  now={now}
                  mon={monOf}
                />
              ) : (
                cardsCol
              )}
              {chatCol}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const pathwaysPathColor = "teal";
const pathwaysColors = { ready: "var(--success)", claimed: "royalblue", blocked: "var(--muted-foreground)", unknown: "blueviolet", "needs-you": "var(--warning-text)", done: "color-mix(in srgb, var(--success) 65%, var(--muted-foreground))" } as const;

function titleLines(title: string, limit = 27, count = 2): string[] {
  const lines: string[] = [];
  for (const word of title.split(/\s+/)) {
    const last = lines.length - 1;
    if (last < 0 || lines[last]!.length + word.length + 1 > limit) lines.push(word);
    else lines[last] += ` ${word}`;
  }
  if (lines.length <= count) return lines;
  return [...lines.slice(0, count - 1), `${lines.slice(count - 1).join(" ").slice(0, limit - 1)}…`];
}

type PathwaysTicketView = NonNullable<Pathways["map"]>["tickets"][number];

function pathwaysAge(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

function PathwaysNodeGlyph({
  label,
  meaning,
}: {
  label: string;
  meaning: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          tabIndex={0}
          className="h-4 bg-card px-1 text-[8px] leading-none"
        >
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{meaning}</TooltipContent>
    </Tooltip>
  );
}

function PathwaysLink({
  href,
  className,
  fallbackClassName,
  fallback,
  children,
  ...rest
}: {
  href?: string | null;
  className?: string;
  fallbackClassName?: string;
  fallback?: React.ReactNode;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLSpanElement>) {
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  ) : (
    <span className={fallbackClassName ?? className} {...rest}>
      {fallback ?? children}
    </span>
  );
}

function PathwaysDecisionPreview({
  ticket,
  tickets,
}: {
  ticket: PathwaysTicketView;
  tickets: Map<string, PathwaysTicketView>;
}) {
  const decision = ticket.decision;
  if (
    decision.state === "missing" &&
    ticket.readiness.state !== "needs decision" &&
    !decision.direct.length &&
    !decision.transitive.length
  )
    return null;
  const links = (ids: string[]) =>
    ids.length
      ? ids.map((id, index) => (
          <span key={id}>
            {index > 0 && ", "}
            <PathwaysLink
              href={tickets.get(id)?.url}
              className="underline underline-offset-2"
              fallbackClassName=""
            >
              {id}
            </PathwaysLink>
          </span>
        ))
      : "none";
  return (
    <div className="mt-2 rounded-md border bg-muted/20 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Decision impact</span>
        <span
          className="rounded border px-1.5 py-0.5"
          style={{
            color: decision.waiting ? "var(--warning-text)" : undefined,
          }}
        >
          {decision.state === "linked"
            ? decision.waiting
              ? "awaiting answer"
              : decision.cardState
            : decision.state === "ambiguous"
              ? "card link ambiguous"
              : "card link missing"}
        </span>
      </div>
      {decision.cardId && (
        <span className="mt-1 block text-muted-foreground">
          <span style={{ color: "var(--foreground)" }}>
            <OpenRef
              open={panel(
                decision.waiting ? "needs-you" : "board",
                decision.waiting
                  ? `[data-card="${decision.cardId}"]`
                  : `[data-decision="${decision.cardId}"]`,
              )}
              title="Open decision card"
              data="card"
              className="font-medium underline underline-offset-2"
            >
              {decision.cardId}
            </OpenRef>
          </span>{" "}
          · {decision.title}
        </span>
      )}
      {ticket.decisionDraft?.question &&
        !ticket.readiness.reasons.some((reason) =>
          reason.includes(ticket.decisionDraft!.question),
        ) && (
          <span className="mt-1 block text-muted-foreground">
            Question: {ticket.decisionDraft.question}
          </span>
        )}
      <span className="mt-1 block text-muted-foreground">
        {decision.waiting ? "Answering unblocks" : "Decision affects"}{" "}
        {links(decision.direct)} (direct) ·{" "}
        {decision.transitive.length ? (
          <>{links(decision.transitive)} (further)</>
        ) : (
          "no further tickets"
        )}
      </span>
      {decision.state === "linked" &&
        !decision.waiting &&
        ticket.state.type !== "completed" &&
        ticket.state.type !== "canceled" && (
          <span className="mt-1 block text-muted-foreground">
            Card answered · Linear ticket remains open
          </span>
        )}
    </div>
  );
}

function PathwaysPreflight({
  ticket,
  tickets,
}: {
  ticket: PathwaysTicketView;
  tickets: Map<string, PathwaysTicketView>;
}) {
  const preflight = ticket.preflight;
  if (preflight.state === "not planned")
    return ticket.prLink.state === "linked" ? (
      <div className="mt-1 text-xs text-muted-foreground">
        Proof preflight · plan not recorded
      </div>
    ) : null;
  return (
    <div className="mt-2 rounded-md border bg-muted/20 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Proof preflight</span>
        <span
          className="rounded border px-1.5 py-0.5"
          style={{
            color:
              preflight.state === "needs access" ||
              preflight.state === "blocked"
                ? "var(--warning-text)"
                : undefined,
          }}
        >
          {preflight.state}
        </span>
      </div>
      <span className="mt-1 block text-muted-foreground">
        Environment: {preflight.environment ?? "not declared"} · Verifier:{" "}
        {preflight.verifier ?? "not declared"}
      </span>
      <span className="mt-1 block text-muted-foreground">
        Owner action: {preflight.ownerAction ?? "not declared"}
      </span>
      {preflight.accessTicket && (
        <span className="mt-1 block text-muted-foreground">
          Access ticket:{" "}
          {tickets.get(preflight.accessTicket) ? (
            <a
              href={tickets.get(preflight.accessTicket)!.url}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              {preflight.accessTicket}
            </a>
          ) : (
            preflight.accessTicket
          )}
        </span>
      )}
      {!!preflight.gaps.length && (
        <span
          className="mt-1 block"
          style={{
            color:
              preflight.state === "needs access" ||
              preflight.state === "blocked"
                ? "var(--warning-text)"
                : undefined,
          }}
        >
          {preflight.gaps.join(" · ")}
        </span>
      )}
      <a
        href={preflight.source}
        target="_blank"
        rel="noreferrer"
        className="mt-1 inline-block text-muted-foreground underline underline-offset-2"
      >
        Source: Linear plan
      </a>
    </div>
  );
}

function PathwaysWaitLaneView({ lane }: { lane: PathwaysTicketView["waitLane"] }) {
  if (!lane) return null;
  const waitingIndex = lane.steps.findIndex(
    (step) => step.state === "pending" || step.state === "blocked",
  );
  const waiting = waitingIndex < 0 ? null : lane.steps[waitingIndex]!;
  return (
    <div className="mt-2 border-t pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {waiting
            ? `Waiting on ${waitingIndex + 1}. ${waiting.kind}`
            : "Review and CI wait lane"}
        </span>
        {waiting?.state === "pending" && (
          <span className="text-muted-foreground">
            {waiting.since == null
              ? "since not recorded"
              : `pending ${age(waiting.since, Date.now())}`}
          </span>
        )}
        <span className="font-mono text-muted-foreground">
          head {lane.head?.slice(0, 8) ?? "not recorded"}
        </span>
      </div>
      <ol className="mb-0 mt-1 grid gap-1 pl-0" style={{ listStyle: "none" }}>
        {lane.steps.map((step, index) => (
          <li
            key={step.kind}
            className="flex flex-wrap items-baseline gap-x-2 border-t pt-1"
          >
            <span className="font-medium">
              {index + 1}. {step.kind}
            </span>
            <span
              className="rounded border px-1.5 py-0.5"
              style={{
                color:
                  step.kind === "human review" &&
                  lane.reviewFreshness === "older accepted"
                    ? "var(--warning-text)"
                    : step.state === "blocked" || step.state === "pending"
                      ? "var(--warning-text)"
                      : step.state === "done"
                        ? "var(--success)"
                        : undefined,
              }}
            >
              {step.kind === "human review" &&
              lane.reviewFreshness === "older accepted"
                ? "accepted on older head"
                : step.state}
            </span>
            {step.state === "pending" && (
              <span className="text-muted-foreground">
                {step.since == null
                  ? "Since not recorded"
                  : `Pending ${age(step.since, Date.now())}`}
              </span>
            )}
            {step.owner && (
              <span className="text-muted-foreground">{step.owner} waits</span>
            )}
            <span className="text-muted-foreground">{step.note}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function PathwaysPrItem({ ticket, entry }: { ticket: PathwaysTicketView; entry: PathwaysTicketView["prs"][number] }) {
  if (ticket.prLink.state === "missing")
    return (
      <span className="mt-1 block text-xs text-muted-foreground">
        PR link missing
      </span>
    );
  const pr = entry.pr;
  if (!pr)
    return (
      <span className="mt-1 block text-xs text-muted-foreground">
        PR reading not recorded
      </span>
    );
  const proof = entry.proof;
  const proofState = proof?.state ?? "unrecorded";
  const proofColor =
    proofState === "verified"
      ? "var(--success)"
      : proofState === "stale" || proofState === "blocked"
        ? "var(--warning-text)"
        : undefined;
  const number =
    pr.number ?? Number(pr.url.match(/\/pull\/(\d+)\/?$/)?.[1] ?? 0);
  const link = (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      className="font-medium underline underline-offset-2"
    >
      {number ? `#${number}` : "Linked PR"}
      {pr.title ? ` · ${pr.title}` : ""}
    </a>
  );
  if (pr.state === "unavailable")
    return (
      <div className="mt-2 rounded-md border bg-muted/20 p-2 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          {link}
          <span className="text-muted-foreground">GitHub unavailable</span>
          <Badge variant="outline">proof {proofState}</Badge>
        </div>
        <PathwaysWaitLaneView lane={entry.waitLane} />
      </div>
    );
  return (
    <div className="mt-2 rounded-md border bg-muted/20 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {link}
        <Badge variant="outline">{pr.state}</Badge>
        <Badge variant="outline" style={{ color: proofColor }}>
          Proof {proofState}
        </Badge>
        {pr.reason !== "Merged" && <span>{pr.reason}</span>}
      </div>
      <div className="mt-1 text-muted-foreground">
        Via {ticket.prLink.source ?? "source not recorded"} · Read{" "}
        {new Date(pr.retrievedAt).toLocaleString()}
      </div>
      {proofState !== "unrecorded" && (
        <div className="mt-2 border-t pt-2">
          {proof?.verifiedSha && (
            <span className="block font-mono">
              {proof.state === "verified" ? "Verified" : "Recorded"}{" "}
              {proof.verifiedSha.slice(0, 8)} · Head{" "}
              {pr.head?.slice(0, 8) ?? "not recorded"}
            </span>
          )}
          <span className="block text-muted-foreground">
            {proof?.missing
              .filter(
                (gap) =>
                  gap !== "Live interface not recorded" &&
                  gap !== "QA packet not recorded",
              )
              .join(" · ") || "Proof details recorded"}
          </span>
          <span className="block text-muted-foreground">
            Live interface: {proof?.liveInterface ?? "not recorded"} · QA
            packet: {proof?.qaPacketUrl ? "recorded" : "not recorded"}
          </span>
          {proof?.sourceLabel && (
            <span className="block text-muted-foreground">
              {proof.sourceLabel} ·{" "}
              {new Date(proof.observedAt!).toLocaleString()}
            </span>
          )}
          {proof?.qaPacketUrl && (
            <a
              href={proof.qaPacketUrl}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              QA packet
            </a>
          )}
        </div>
      )}
      <PathwaysWaitLaneView lane={entry.waitLane} />
    </div>
  );
}

function PathwaysPrBadge({ ticket }: { ticket: PathwaysTicketView }) {
  if (ticket.prLink.state === "missing") return <span className="mt-1 block text-xs text-muted-foreground">PR link missing</span>;
  const active = ticket.prs.filter(({ pr }) => pr.state !== "merged" && pr.state !== "closed");
  return active.length ? <div>{active.map((entry) => <PathwaysPrItem key={entry.pr.url} ticket={ticket} entry={entry} />)}</div> : <span className="mt-1 block text-xs text-muted-foreground">No open linked PRs</span>;
}

function PathwaysDecisionDraftView({
  ticket,
  slug,
  onSubmitted,
}: {
  ticket: PathwaysTicketView;
  slug: string;
  onSubmitted: () => void;
}) {
  const draft = ticket.decisionDraft;
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<{ label: string; detail: string }[]>(
    draft?.options ?? [],
  );
  const [submitted, setSubmitted] = useState<string | null>(null);
  if (
    ticket.decision.state === "linked" &&
    ticket.decision.waiting &&
    ticket.decision.cardId
  )
    return (
      <div
        className="mt-2 text-xs font-medium"
        style={{ color: "var(--foreground)" }}
      >
        Filed {ticket.decision.cardId} · linked to {ticket.identifier} · in
        Needs you
      </div>
    );
  if (!draft) return null;
  const submit = async () => {
    const result = await write(
      WRITES.pathwaysDecision,
      { slug, ticketId: draft.ticketId, question: draft.question, options },
      { kind: "other", where: ticket.identifier, after: onSubmitted },
    );
    if (result?.ok && typeof result.result === "string")
      setSubmitted(result.result);
  };
  return (
    <div className="mt-2 text-xs">
      <Button
        variant="secondary"
        size="sm"
        className="border"
        onClick={() => setOpen(!open)}
      >
        {open ? "Close decision preview" : "Draft decision"}
      </Button>
      {open && (
        <UiCard className="mt-2 gap-2 px-3 py-3">
          <CardTitle className="text-sm">
            Decision preview · {draft.ticketId}
          </CardTitle>
          <div className="mt-1 text-muted-foreground">
            Preview only · no card is filed until Submit
          </div>
          <p className="mb-2 mt-1">{draft.question}</p>
          <div className="text-muted-foreground">
            Would unblock:{" "}
            {draft.affected.length
              ? draft.affected.join(", ")
              : "no downstream tickets recorded"}
          </div>
          <div className="mt-2 grid gap-2">
            {options.map((option, index) => (
              <div key={index} className="grid gap-1">
                <Label htmlFor={`${ticket.identifier}-option-${index}`}>
                  Option {index + 1}
                  {index === 0 ? " · recommended" : ""}
                </Label>
                <Input
                  id={`${ticket.identifier}-option-${index}`}
                  className="w-full"
                  value={option.label}
                  maxLength={80}
                  onChange={(event) =>
                    setOptions(
                      options.map((item, at) =>
                        at === index
                          ? { ...item, label: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
                <Input
                  aria-label={`Option ${index + 1} detail`}
                  className="w-full"
                  placeholder="Why this option"
                  value={option.detail}
                  maxLength={300}
                  onChange={(event) =>
                    setOptions(
                      options.map((item, at) =>
                        at === index
                          ? { ...item, detail: event.target.value }
                          : item,
                      ),
                    )
                  }
                />
                {options.length > 2 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setOptions(options.filter((_, at) => at !== index))
                    }
                  >
                    Remove option
                  </Button>
                )}
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {options.length < 4 && (
              <Button
                variant="ghost"
                size="sm"
                className="border"
                onClick={() =>
                  setOptions([...options, { label: "", detail: "" }])
                }
              >
                Add option
              </Button>
            )}
            <Button
              size="sm"
              disabled={
                !!gate.lock || options.some((option) => !option.label.trim())
              }
              onClick={() => void submit()}
            >
              Submit decision
            </Button>
          </div>
          {submitted && <div className="mt-2">Filed card {submitted}</div>}
        </UiCard>
      )}
    </div>
  );
}

export function PathwaysTab({
  projects,
  linkedSlug,
}: {
  projects: Projects | undefined;
  linkedSlug: string | null;
}) {
  const navigate = useBbNavigate();
  const [picked, setPicked] = useState(
    () =>
      linkedSlug ??
      (() => {
        try {
          return localStorage.getItem("pathways:last-project") ?? "";
        } catch {
          return "";
        }
      })(),
  );
  useEffect(() => {
    if (linkedSlug) setPicked(linkedSlug);
  }, [linkedSlug]);
  const slug = projects?.some((project) => project.slug === picked)
    ? picked
    : (projects?.[0]?.slug ?? "");
  const pick = (value: string) => {
    setPicked(value);
    localStorage.setItem("pathways:last-project", value);
    navigate.toPluginPanel(PANEL_PATH, {
      subPath: `pathways/${encodeURIComponent(value)}`,
    });
  };
  return (
    <div
      className="mx-auto max-w-[1500px] p-4 max-[1100px]:p-1"
      data-pathways-tab=""
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="m-0 text-lg font-semibold">Pathways</h2>
        <label className="text-sm" htmlFor="pathways-project">
          Project
        </label>
        <Select value={slug || undefined} onValueChange={pick}>
          <SelectTrigger
            id="pathways-project"
            size="sm"
            aria-label="Pathways project"
          >
            <SelectValue placeholder="Choose a project" />
          </SelectTrigger>
          <SelectContent>
            {projects?.map((project) => (
              <SelectItem key={project.slug} value={project.slug}>
                {project.slug}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {projects === undefined ? (
        <Skeleton className="h-80 w-full" />
      ) : slug ? (
        <PathwaysSection key={slug} slug={slug} />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No projects recorded</EmptyTitle>
            <EmptyDescription>
              Create a project to see its Pathways map.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}

function PathwaysSection({ slug }: { slug: string }) {
  const graphViewport = useRef<SVGSVGElement>(null);
  const graphContent = useRef<SVGGElement>(null);
  const graphZoom = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const graphFit = useRef<(() => void) | null>(null);
  const [refresh, setRefresh] = useState(false);
  const refreshSeen = useRef(false);
  const [retroOpen, setRetroOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [narrowGraph, setNarrowGraph] = useState(
    () => window.innerWidth < 1100,
  );
  useEffect(() => {
    const resize = () => setNarrowGraph(window.innerWidth < 1100);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const navigate = useBbNavigate();
  const [hideDone, setHideDone] = useState(() => {
    try {
      return localStorage.getItem(`pathways:hide-done:${slug}`) === "true";
    } catch {
      return false;
    }
  });
  const q = experimental_useRpcQuery({
    contract: rpcContract,
    method: "pathways",
    input: { slug, refresh },
  });
  useEffect(() => {
    if (!refresh) refreshSeen.current = false;
    else if (q.isFetching) refreshSeen.current = true;
    else if (refreshSeen.current) setRefresh(false);
  }, [refresh, q.isFetching]);
  const refreshing = q.data?.refreshing === true;
  useEffect(() => {
    if (!refreshing) return;
    const timer = window.setInterval(() => void q.refetch(), 1500);
    return () => window.clearInterval(timer);
  }, [refreshing]);
  const map = q.data?.map;
  const tickets = new Map(
    map?.tickets.map((ticket) => [ticket.identifier, ticket]) ?? [],
  );
  const visible =
    map?.tickets.filter(
      (ticket) => !hideDone || ticket.displayState !== "done",
    ) ?? [];
  const accessGaps = visible.filter(
    (ticket) =>
      ticket.preflight.state === "needs access" &&
      !map?.ownerActions.some(
        (action) => action.identifier === ticket.identifier,
      ),
  );
  const visibleExternal =
    map?.external.filter((item) =>
      map.edges.some(
        (edge) =>
          edge.type === "blocks" &&
          edge.from === item.identifier &&
          visible.some((ticket) => ticket.identifier === edge.to),
      ),
    ) ?? [];
  const visibleIds = new Set([
    ...visible.map((ticket) => ticket.identifier),
    ...visibleExternal.map((item) => item.identifier),
  ]);
  const visibleEdges =
    map?.edges.filter(
      (edge) =>
        edge.type !== "sub-issue" &&
        visibleIds.has(edge.from) &&
        visibleIds.has(edge.to),
    ) ?? [];
  const graphNodes = [
    ...visibleExternal.map((item) => ({
      id: item.identifier,
      label: item.title ?? item.identifier,
      change: "same" as const,
    })),
    ...visible.map((ticket) => ({
      id: ticket.identifier,
      label: ticket.title,
      change: "same" as const,
    })),
  ];
  const graphRank = (id: string) => {
    const ticket = tickets.get(id);
    const pathTarget = visibleEdges.some(
      (edge) => edge.from === id && map?.firstPath.includes(edge.to),
    );
    return map?.firstPath.includes(id)
      ? 0
      : pathTarget
        ? 1
        : ticket?.displayState === "needs-you"
          ? 2
          : ticket?.displayState === "done"
            ? 3
            : 4;
  };
  graphNodes.sort(
    (a, b) => graphRank(a.id) - graphRank(b.id) || a.id.localeCompare(b.id),
  );
  const graph = map
    ? layout(
        graphNodes.length
          ? graphNodes
          : [{ id: map.identifier, label: map.title, change: "same" }],
        visibleEdges.map((edge) => ({
          ...edge,
          label: edge.type,
          change: "same" as const,
        })),
        "right",
        narrowGraph ? 166 : 208,
        narrowGraph ? 110 : 84,
        "orthogonal",
        narrowGraph ? 54 : 100,
      )
    : null;
  const graphIdentity = `${slug}:${hideDone}:${narrowGraph}:${graphNodes.map((node) => node.id).join(",")}:${visibleEdges.map((edge) => `${edge.from}:${edge.to}`).join(",")}`;
  useEffect(() => {
    const svg = graphViewport.current;
    const content = graphContent.current;
    if (!svg || !content || !graph) return;
    const selection = select(svg);
    const behavior = zoom<SVGSVGElement, unknown>()
      .clickDistance(4)
      .translateExtent([[0, 0], [graph.width, graph.height]])
      .on("zoom", (event) => {
        content.setAttribute("transform", event.transform.toString());
      });
    graphZoom.current = behavior;
    const fit = () => {
      const { width, height } = svg.getBoundingClientRect();
      if (!width || !height) return;
      const scale = Math.min(width / graph.width, height / graph.height) * 0.9;
      behavior.extent([[0, 0], [width, height]]).scaleExtent([scale / 2, scale * 4]);
      selection.call(behavior).call(
        behavior.transform,
        zoomIdentity.translate((width - graph.width * scale) / 2, (height - graph.height * scale) / 2).scale(scale),
      );
    };
    const observer = new ResizeObserver(fit);
    graphFit.current = fit;
    observer.observe(svg);
    fit();
    return () => {
      observer.disconnect();
      selection.on(".zoom", null);
      graphZoom.current = null;
      graphFit.current = null;
    };
  }, [graphIdentity, graph?.width, graph?.height]);
  const zoomAtCenter = (factor: number) => {
    const svg = graphViewport.current;
    if (svg && graphZoom.current) {
      const { width, height } = svg.getBoundingClientRect();
      select(svg).call(graphZoom.current.scaleBy, factor, [width / 2, height / 2]);
    }
  };
  const fitGraph = () => {
    graphFit.current?.();
  };
  const rows = (ids: string[]) =>
    ids
      .map((id) => tickets.get(id))
      .filter((ticket): ticket is NonNullable<typeof ticket> => !!ticket);
  const pathIds = new Set(map?.firstPath ?? []);
  const pathHead = tickets.get(map?.firstPath[0] ?? "");
  const needsYouNow = visible.find(
    (ticket) => ticket.displayState === "needs-you",
  );
  const pathEdges = new Set(
    (map?.firstPath ?? [])
      .slice(1)
      .map((id, index) => `${map!.firstPath[index]}:${id}`),
  );
  const selected = tickets.get(selectedId ?? "");
  const ticketRow = (ticket: PathwaysTicketView, detail?: string) => (
    <Item key={ticket.identifier} asChild variant="default" size="sm">
      <Button
        type="button"
        variant="ghost"
        onClick={() => setSelectedId(ticket.identifier)}
        className="flex h-auto min-w-0 w-full items-start gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2"
        data-pathways-row={ticket.identifier}
      >
        {pathIds.has(ticket.identifier) ? (
          <Badge variant="outline" className="shrink-0 px-1">
            {map!.firstPath.indexOf(ticket.identifier) + 1}
          </Badge>
        ) : (
          <span
            className="mt-1 size-2 shrink-0 rounded-full"
            style={{ background: pathwaysColors[ticket.displayState] }}
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-balance">
            <span className="font-mono">{ticket.identifier}</span> ·{" "}
            {ticket.title}
          </span>
          {detail && (
            <span className="mt-0.5 block whitespace-normal text-muted-foreground">
              {detail}
            </span>
          )}
        </span>
      </Button>
    </Item>
  );
  const ticketFact = (ticket: PathwaysTicketView) =>
    [
      ticket.prLink.state === "linked" &&
      ticket.pr &&
      ticket.pr.state !== "unavailable"
        ? `PR #${ticket.pr.number ?? "linked"} ${ticket.pr.state}`
        : "",
      ticket.decision.waiting ? "decision awaiting answer" : "",
      ticket.preflight.state === "needs access" ? "proof needs access" : "",
    ]
      .filter(Boolean)
      .join(" · ");
  const firstPathFact = (ticket: PathwaysTicketView) =>
    [
      ticket.type === "research"
        ? "Investigate this research question first"
        : ticket.blockers.length
          ? `Waits on ${ticket.blockers.join(", ")}`
          : "Ready to start",
      ticketFact(ticket),
    ]
      .filter(Boolean)
      .join(" · ");
  const blockedFact = (ticket: PathwaysTicketView) =>
    [
      ticket.waitsOnYou ? "Waits on you" : "",
      ticket.blockers.length ? `Blocked by ${ticket.blockers.join(", ")}` : "",
      ticket.blockers.some((id) =>
        map?.external.some((item) => item.identifier === id),
      )
        ? "External blocker"
        : "",
      map?.source !== "orchestrator" && ticket.estimate == null ? "No estimate" : "",
      ...ticket.unknown,
      ticketFact(ticket),
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <UiCard
      className="gap-3 px-4 py-4 max-[1100px]:px-2"
      data-pathways={slug}
      aria-label="Pathways"
    >
      <style>{`@keyframes pathways-flow { to { stroke-dashoffset: -20; } } @media (prefers-reduced-motion: no-preference) { [data-pathways] .pathways-flow { animation: pathways-flow 1s linear infinite; } }`}</style>
      <div className="flex items-center justify-between gap-3">
        <div>
          {map && (
            <PathwaysLink
              href={map.source === "orchestrator" ? null : map.url}
              className="text-xs text-muted-foreground"
              data-pathways-source={
                map.source === "orchestrator" ? "orchestrator" : undefined
              }
              fallback={
                <>
                  <span className="font-mono">{map.identifier}</span> · Built
                  from this project's plan, threads and cards
                </>
              }
            >
              <span className="font-mono">{map.identifier}</span> · {map.title}
            </PathwaysLink>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id={`pathways-hide-done-${slug}`}
              checked={hideDone}
              onCheckedChange={(value) => {
                const checked = value === true;
                setHideDone(checked);
                try {
                  localStorage.setItem(
                    `pathways:hide-done:${slug}`,
                    String(checked),
                  );
                } catch {}
              }}
            />
            <Label htmlFor={`pathways-hide-done-${slug}`} className="text-xs">
              Hide done
            </Label>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="text-foreground [&:is(.dark_*)]:text-white"
            onClick={() => {
              setRefresh(true);
            }}
          >
            Refresh
          </Button>
        </div>
      </div>
      {q.data?.fetchedAt != null && (
        <p className="m-0 text-xs text-muted-foreground" data-pathways-freshness="">
          Updated {pathwaysAge(q.data.fetchedAt)}
          {q.data.refreshing ? " · refreshing" : ""}
        </p>
      )}
      {q.error ? (
        <Alert>
          <AlertDescription>
            Pathways failed: {q.error.message}
          </AlertDescription>
        </Alert>
      ) : q.data?.error && !map ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {q.data.error.includes("linearProjectId") ||
              q.data.error.includes("Linear project link")
                ? "No Linear map linked"
                : "Pathways unavailable"}
            </EmptyTitle>
            <EmptyDescription>{q.data.error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : !map || !graph ? (
        <Skeleton className="mt-3 h-80 w-full" />
      ) : map.source === "orchestrator" && !map.tickets.length ? (
        <Empty data-pathways-empty="">
          <EmptyHeader>
            <EmptyTitle>No plan or active work yet</EmptyTitle>
            <EmptyDescription>
              Built from this project's plan, threads and cards. Publish a lead
              status, start a thread, open a PR, or raise a decision card to see
              what&apos;s next here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {q.data?.error && (
            <Alert className="mt-3 py-2 text-xs" data-pathways-refresh-error="">
              <AlertDescription>Refresh failed; showing the last map. {q.data.error}</AlertDescription>
            </Alert>
          )}
          {(pathHead ||
            visible.some((ticket) => ticket.pr?.state === "unavailable")) && (
            <Alert
              className="mt-3 py-2 text-xs"
              data-pathways-github-unavailable={
                visible.some((ticket) => ticket.pr?.state === "unavailable")
                  ? ""
                  : undefined
              }
            >
              <AlertDescription>
                {pathHead && (
                  <>
                    Do now:{" "}
                    {pathHead.type === "decision"
                      ? "answer"
                      : pathHead.type === "research"
                        ? "investigate"
                        : pathHead.readiness.state === "ready"
                          ? "start"
                          : "resolve scope for"}{" "}
                    {pathHead.identifier}.
                    {needsYouNow && (
                      <> In parallel, complete {needsYouNow.identifier}.</>
                    )}
                  </>
                )}
                {visible.some(
                  (ticket) => ticket.pr?.state === "unavailable",
                ) && (
                  <>
                    {" "}
                    · GitHub unavailable · linked PR readiness needs a fresh
                    read
                  </>
                )}
              </AlertDescription>
            </Alert>
          )}
          <div className="mt-3 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(390px,420px)]">
            <div
              className="order-1 min-w-0 self-start rounded-lg border p-2 max-[1100px]:p-1"
              data-pathways-graph=""
            >
              <div
                className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                aria-label="Pathways state legend"
              >
                {(
                  Object.entries(pathwaysColors) as [
                    keyof typeof pathwaysColors,
                    string,
                  ][]
                )
                  .filter(([state]) =>
                    visible.some((ticket) => ticket.displayState === state),
                  )
                  .map(([state, color]) => (
                    <Tooltip key={state}>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="outline"
                          tabIndex={0}
                          className="gap-1 px-1.5 py-0.5"
                        >
                          <span
                            aria-hidden
                            style={{
                              background: color,
                              width: 9,
                              height: 9,
                              borderRadius: 2,
                            }}
                          />
                          {state === "needs-you" && (
                            <UserRound className="size-3" aria-hidden />
                          )}
                          {state === "done" && (
                            <Check className="size-3" aria-hidden />
                          )}
                          {state}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        {state} tickets in this map
                      </TooltipContent>
                    </Tooltip>
                  ))}
                {!!map.firstPath.length && (
                  <span className="flex items-center gap-1">
                    <span
                      aria-hidden
                      className="inline-flex size-3 items-center justify-center rounded-full text-[9px] text-white"
                      style={{ background: pathwaysPathColor }}
                    >
                      1
                    </span>
                    first path step
                  </span>
                )}
                {!!visible.some((ticket) => ticket.waitsOnYou) && (
                  <span className="flex items-center gap-1">
                    <Hourglass className="size-3" aria-hidden />
                    waits on you
                  </span>
                )}
                {!!visibleExternal.length && (
                  <span className="flex items-center gap-1">
                    <span
                      aria-hidden
                      className="inline-block size-2.5 border border-dashed border-muted-foreground"
                    />
                    external blocker
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <span
                    aria-hidden
                    className="inline-block w-3 border-t border-dashed border-muted-foreground"
                  />
                  open blocker
                </span>
                {!!visible.some(
                  (ticket) => ticket.displayState === "needs-you",
                ) && (
                  <span className="flex items-center gap-1">
                    <span
                      aria-hidden
                      className="inline-block w-3 border-t border-dashed"
                      style={{ borderColor: pathwaysColors["needs-you"] }}
                    />
                    needs-you blocker
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <span
                    aria-hidden
                    className="inline-block w-3 border-t border-dotted"
                    style={{ borderColor: pathwaysColors.done }}
                  />
                  done dependency
                </span>
              </div>
              <Separator className="mb-2" />
              <div className="relative">
              <div className="absolute right-2 top-2 z-10 flex gap-1 rounded-md border bg-background/95 p-1 shadow-sm">
                <Button variant="outline" size="icon" aria-label="Zoom in" onClick={() => zoomAtCenter(1.4)}><Plus className="size-4" /></Button>
                <Button variant="outline" size="icon" aria-label="Zoom out" onClick={() => zoomAtCenter(1 / 1.4)}><Minus className="size-4" /></Button>
                <Button variant="outline" size="sm" aria-label="Fit to view" onClick={fitGraph}>Fit</Button>
              </div>
              <svg
                ref={graphViewport}
                className="block w-full min-h-[320px] h-[min(70vh,720px)] cursor-grab active:cursor-grabbing"
                role="img"
                aria-label="Pathways map graph"
              >
                <g ref={graphContent}>
                {graph.lines.map((line, i) => {
                  const blockerTicket = tickets.get(line.from);
                  const blocker =
                    blockerTicket ??
                    map.external.find((item) => item.identifier === line.from);
                  const active =
                    line.label === "blocks" &&
                    blocker?.state.type !== "completed" &&
                    blocker?.state.type !== "canceled";
                  const first = pathEdges.has(`${line.from}:${line.to}`);
                  return (
                    <g key={`${line.from}:${line.to}:${i}`}>
                      <path
                        d={line.path}
                        fill="none"
                        stroke={
                          first
                            ? pathwaysPathColor
                            : blockerTicket
                              ? pathwaysColors[blockerTicket.displayState]
                              : "var(--muted-foreground)"
                        }
                        strokeWidth={first ? 2 : 1.25}
                        strokeDasharray={
                          active && !first ? "6 4" : !active ? "2 5" : undefined
                        }
                        className={
                          active && !first ? "pathways-flow" : undefined
                        }
                        opacity={first ? 1 : active ? 0.75 : 0.5}
                        markerEnd={
                          first
                            ? "url(#pathways-arrow-first)"
                            : "url(#pathways-arrow)"
                        }
                      />
                      {first && active && (
                        <path
                          d={line.path}
                          fill="none"
                          stroke="var(--background)"
                          strokeWidth="1"
                          strokeDasharray="1 16"
                          className="pathways-flow"
                          opacity="0.3"
                        />
                      )}
                    </g>
                  );
                })}
                <defs>
                  <marker
                    id="pathways-arrow"
                    markerWidth="5"
                    markerHeight="5"
                    refX="4"
                    refY="2.5"
                    orient="auto"
                  >
                    <path
                      d="M0 0 L5 2.5 L0 5"
                      fill="none"
                      stroke="currentColor"
                    />
                  </marker>
                  <marker
                    id="pathways-arrow-first"
                    markerWidth="5"
                    markerHeight="5"
                    refX="4"
                    refY="2.5"
                    orient="auto"
                  >
                    <path
                      d="M0 0 L5 2.5 L0 5"
                      fill="none"
                      stroke={pathwaysPathColor}
                    />
                  </marker>
                </defs>
                {graph.boxes.map((box) => {
                  const ticket = tickets.get(box.id);
                  const outside = map.external.find(
                    (item) => item.identifier === box.id,
                  );
                  const title = ticket?.title ?? outside?.title ?? map.title;
                  const color = ticket
                    ? pathwaysColors[ticket.displayState]
                    : outside
                      ? "var(--muted-foreground)"
                      : "currentColor";
                  return (
                    <a
                      key={box.id}
                      href={ticket ? "#" : (outside?.url ?? map.url)}
                      target={ticket ? undefined : "_blank"}
                      rel={ticket ? undefined : "noreferrer"}
                      onClick={
                        ticket
                          ? (event) => {
                              event.preventDefault();
                              setSelectedId(box.id);
                            }
                          : undefined
                      }
                      data-pathways-state={
                        ticket?.displayState ?? (outside ? "external" : "map")
                      }
                    >
                      <rect
                        x={box.x}
                        y={box.y}
                        width={box.w}
                        height={box.h}
                        rx="6"
                        fill={
                          ticket?.displayState === "done"
                            ? "var(--muted)"
                            : "var(--card)"
                        }
                        stroke="var(--border)"
                        strokeWidth={1}
                        strokeDasharray={outside ? "5 4" : undefined}
                        opacity={ticket?.displayState === "done" ? 0.85 : 1}
                      />
                      {ticket && (
                        <rect
                          x={box.x + 1}
                          y={box.y + 5}
                          width="3"
                          height={box.h - 10}
                          rx="1.5"
                          fill={color}
                        />
                      )}
                      <title>{`${box.id}: ${title}`}</title>
                      <text
                        x={box.x + 8}
                        y={box.y + 17}
                        fontSize="11"
                        fontWeight="bold"
                        fill="currentColor"
                      >
                        {box.id}
                      </text>
                      {ticket?.displayState === "done" && (
                        <Check
                          x={box.x + box.w - 24}
                          y={box.y + 5}
                          width={16}
                          height={16}
                          stroke={color}
                        />
                      )}
                      {ticket?.waitsOnYou && (
                        <Hourglass
                          x={box.x + box.w - 22}
                          y={box.y + 7}
                          width={14}
                          height={14}
                          stroke="var(--muted-foreground)"
                          aria-label="Waits on you"
                        />
                      )}
                      {ticket?.displayState === "needs-you" && (
                        <UserRound
                          x={box.x + box.w - (pathIds.has(box.id) ? 42 : 22)}
                          y={box.y + 5}
                          width={16}
                          height={16}
                          stroke={
                            ticket.waitsOnYou
                              ? pathwaysColors["needs-you"]
                              : color
                          }
                        />
                      )}
                      {pathIds.has(box.id) && (
                        <g>
                          <circle
                            cx={box.x + box.w - 16}
                            cy={box.y + 16}
                            r="10"
                            fill={
                              ticket?.blockers.length
                                ? "var(--card)"
                                : pathwaysPathColor
                            }
                            stroke={pathwaysPathColor}
                          />
                          <text
                            x={box.x + box.w - 16}
                            y={box.y + 20}
                            textAnchor="middle"
                            fontSize="11"
                            fontWeight="bold"
                            fill={
                              ticket?.blockers.length
                                ? pathwaysPathColor
                                : "white"
                            }
                          >
                            {map.firstPath.indexOf(box.id) + 1}
                          </text>
                        </g>
                      )}
                      {titleLines(
                        title,
                        narrowGraph ? 20 : 27,
                        narrowGraph ? 3 : 2,
                      ).map((line, i) => (
                        <text
                          key={i}
                          x={box.x + 8}
                          y={box.y + 34 + i * 15}
                          fontSize={narrowGraph ? 13 : 12}
                          fill="currentColor"
                        >
                          {line}
                        </text>
                      ))}
                      {ticket && (
                        <foreignObject
                          x={box.x + 5}
                          y={box.y + box.h - 17}
                          width={box.w - 10}
                          height={16}
                        >
                          <div className="flex h-4 items-center justify-end gap-1">
                            {ticket.prLink.state === "linked" &&
                              ticket.pr && (
                                <PathwaysNodeGlyph
                                  label={ticket.pr.state === "unavailable" ? "GitHub unavailable" : `PR ${ticket.pr.state}`}
                                  meaning={ticket.pr.state === "unavailable" ? "Linked PR state could not be read" : `Linked PR ${ticket.pr.number ?? "number not recorded"} is ${ticket.pr.state}`}
                                />
                              )}
                            {ticket.decision.waiting ? (
                              <PathwaysNodeGlyph
                                label="Decision pending"
                                meaning="Linked decision card is awaiting an answer"
                              />
                            ) : ticket.prLink.state === "linked" &&
                              (ticket.proof?.state === "stale" ||
                                ticket.proof?.state === "unrecorded") ? (
                              <PathwaysNodeGlyph
                                label={
                                  ticket.proof.state === "stale"
                                    ? "Proof stale"
                                    : "Proof needed"
                                }
                                meaning={
                                  ticket.proof.state === "stale"
                                    ? "Proof is older than the PR head"
                                    : "Proof at the PR head is not recorded"
                                }
                              />
                            ) : null}
                          </div>
                        </foreignObject>
                      )}
                      <circle
                        cx={box.x + 10}
                        cy={box.y + box.h - 24}
                        r="3"
                        fill={color}
                      />
                      <text
                        x={box.x + 18}
                        y={box.y + box.h - 20}
                        fontSize="11"
                        fill="currentColor"
                      >
                        {ticket?.displayState ??
                          (outside ? "external blocker" : "map")}
                      </text>
                    </a>
                  );
                })}
                </g>
              </svg>
              </div>
            </div>
            <div
              className="order-2 grid min-w-0 content-start gap-3 overflow-hidden rounded-xl border bg-card p-3"
              data-pathways-next=""
            >
              <div className="flex items-baseline justify-between">
                <h4 className="m-0 text-base font-semibold">What’s next</h4>
                <span className="text-xs text-muted-foreground">
                  {visible.length}{" "}
                  {map.source === "orchestrator" ? "items" : "tickets"}
                </span>
              </div>
              <Separator />
              {!!map.firstPath.length && (
                <div className="rounded-lg bg-muted/30 p-3">
                  <h5 className="m-0 text-sm font-semibold">
                    First path · {map.firstPath.length} steps
                  </h5>
                  <div className="mt-2 grid gap-1">
                    {rows(map.firstPath).map((ticket) =>
                      ticketRow(ticket, firstPathFact(ticket)),
                    )}
                  </div>
                </div>
              )}
              {!!map.ownerActions.length && (
                <div className="rounded-lg p-3">
                  <h5 className="m-0 text-sm font-semibold">
                    Needs you · {map.ownerActions.length}
                  </h5>
                  <div className="mt-2 grid gap-1">
                    {map.ownerActions
                      .map((action) => tickets.get(action.identifier))
                      .filter(
                        (ticket): ticket is PathwaysTicketView => !!ticket,
                      )
                      .map((ticket) =>
                        ticketRow(
                          ticket,
                          map.ownerActions.find(
                            (action) => action.identifier === ticket.identifier,
                          )?.next
                            ? `Unblocks ${map.ownerActions.find((action) => action.identifier === ticket.identifier)!.next}`
                            : "Owner action",
                        ),
                      )}
                  </div>
                </div>
              )}
              {!!map.claimed.length && (
                <details className="rounded-lg border p-3">
                  <summary className="cursor-pointer text-sm font-semibold">
                    Claimed · {map.claimed.length}
                  </summary>
                  <div className="mt-2 grid gap-1">
                    {rows(map.claimed).map((ticket) =>
                      ticketRow(
                        ticket,
                        ticketFact(ticket) || ticket.assignee || "Claimed",
                      ),
                    )}
                  </div>
                </details>
              )}
              {!!map.blocked.length && (
                <details className="rounded-lg border p-3" open>
                  <summary className="cursor-pointer text-sm font-semibold">
                    Blocked on · {map.blocked.length}
                  </summary>
                  <div className="mt-2 grid gap-1">
                    {rows(map.blocked).map((ticket) =>
                      ticketRow(ticket, blockedFact(ticket)),
                    )}
                  </div>
                </details>
              )}
              {!!map.fog.length && (
                <details className="rounded-lg border p-3">
                  <summary className="cursor-pointer text-sm font-semibold">
                    Open questions · {map.fog.length}
                  </summary>
                  <ul className="mb-0 mt-2 list-disc pl-5 text-xs text-muted-foreground">
                    {map.fog.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </div>
          <Collapsible
            open={retroOpen}
            onOpenChange={setRetroOpen}
            data-pathways-retro=""
          >
            <UiCard className="mt-3 gap-2 px-3 py-2 text-sm">
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start px-0 font-semibold"
                >
                  Retro {retroOpen ? "▾" : "▸"}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-3 grid gap-3 text-xs">
                  <div>
                    <strong>
                      What finished · {q.data?.retro?.finished.length ?? 0}
                    </strong>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {q.data?.retro?.finished.length
                        ? q.data.retro.finished.map((item) => (
                            <span key={item.label}>
                              <a
                                href={item.url}
                                target="_blank"
                                rel="noreferrer"
                                className="underline"
                              >
                                {item.label}
                              </a>
                              {item.prUrl && (
                                <>
                                  {" "}
                                  ·{" "}
                                  <a
                                    href={item.prUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="underline"
                                  >
                                    merged PR
                                  </a>
                                </>
                              )}
                            </span>
                          ))
                        : "not recorded"}
                    </div>
                  </div>
                  <div>
                    <strong>Merged PRs · {q.data?.retro?.mergedPrs.length ?? 0}</strong>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {q.data?.retro?.mergedPrs.map((item) => <a key={item.url} href={item.url} target="_blank" rel="noreferrer" className="underline">{item.ticket} · #{item.url.match(/\/pull\/(\d+)$/)?.[1] ?? "PR"}</a>)}
                    </div>
                  </div>
                  <Separator />
                  <div>
                    <strong>
                      Decisions made · {q.data?.retro?.decisions.length ?? 0}
                    </strong>
                    <div className="mt-1">
                      {q.data?.retro?.decisions.length
                        ? q.data.retro.decisions.map((item) => (
                            <div key={item.id}>
                              {item.title} ·{" "}
                              <OpenRef
                                open={panel(
                                  "board",
                                  `[data-decision="${item.id}"]`,
                                )}
                                title="Open decision card"
                                data="card"
                                className="underline"
                              >
                                {item.id}
                              </OpenRef>
                            </div>
                          ))
                        : "not recorded"}
                    </div>
                  </div>
                  <Separator />
                  <div>
                    <strong>Longest recorded waits</strong>
                    <div className="mt-1">
                      {q.data?.retro?.stalled.length
                        ? q.data.retro.stalled.map((item) => (
                            <div key={item.label}>
                              <a
                                href={item.url}
                                target="_blank"
                                rel="noreferrer"
                                className="underline"
                              >
                                {item.label}
                              </a>{" "}
                              · {item.kind} ·{" "}
                              {Math.round(item.durationMs / 3_600_000)}h from
                              recorded start
                            </div>
                          ))
                        : "not recorded"}
                    </div>
                  </div>
                  <div>
                    Retro doc:{" "}
                    {q.data?.retro?.doc && q.data.retro.hostId ? (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0 text-xs underline"
                        onClick={() =>
                          openInBb(navigate, {
                            hostId: q.data!.retro!.hostId,
                            path: q.data!.retro!.doc,
                          })
                        }
                      >
                        {q.data.retro.doc.split("/").at(-1)}
                      </Button>
                    ) : (
                      "not recorded"
                    )}
                  </div>
                </div>
              </CollapsibleContent>
            </UiCard>
          </Collapsible>
          <Dialog
            open={!!selected}
            onOpenChange={(open) => {
              if (!open) setSelectedId(null);
            }}
          >
            <DialogContent
              showCloseButton={false}
              className="fixed inset-y-0 right-0 left-auto top-0 h-dvh w-full max-w-[520px] content-start translate-x-0 translate-y-0 overflow-y-auto rounded-none p-5 sm:max-w-[520px]"
              data-pathways-detail={selected?.identifier}
            >
              {selected && (
                <>
                  <DialogHeader className="flex-row items-start justify-between gap-3 text-left">
                    <div>
                      <PathwaysLink
                        href={selected.url}
                        className="font-mono text-sm underline"
                        fallbackClassName="font-mono text-sm"
                      >
                        {selected.identifier}
                      </PathwaysLink>
                      <DialogTitle className="mt-1 text-lg">
                        {selected.title}
                      </DialogTitle>
                      <DialogDescription>
                        Ticket details and next actions
                      </DialogDescription>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedId(null)}
                    >
                      Close
                    </Button>
                  </DialogHeader>
                  <Separator />
                  <div className="grid gap-3 text-sm">
                    <div>
                      <Badge variant="outline">{selected.displayState}</Badge> ·{" "}
                      {selected.assignee ?? "Owner not recorded"}
                      {selected.blockers.length
                        ? ` · Blocked by ${selected.blockers.join(", ")}`
                        : ""}
                    </div>
                    <UiCard className="gap-1 px-3 py-3">
                      <CardTitle className="text-sm">
                        Readiness · {selected.readiness.state}
                      </CardTitle>
                      <p className="mb-1 mt-2 text-xs">
                        {selected.readiness.reasons.join(" · ") ||
                          "Scope and proof plan recorded"}
                      </p>
                      <PathwaysLink
                        href={selected.readiness.source}
                        className="text-xs underline"
                        fallbackClassName="text-xs text-muted-foreground"
                        fallback="Source: orchestrator"
                      >
                        Source: Linear ticket
                      </PathwaysLink>
                    </UiCard>
                    {map.ownerActions
                      .filter(
                        (action) => action.identifier === selected.identifier,
                      )
                      .map((action) => (
                        <UiCard key={action.action} className="gap-1 px-3 py-3">
                          <CardTitle className="text-sm">
                            Owner action · {action.kind}
                          </CardTitle>
                          <p className="mb-0 mt-1 text-xs">
                            {action.action} ·{" "}
                            {action.next
                              ? `Needed before ${action.next}`
                              : "No downstream step recorded"}
                          </p>
                        </UiCard>
                      ))}
                    <PathwaysPreflight ticket={selected} tickets={tickets} />
                    <PathwaysDecisionPreview
                      ticket={selected}
                      tickets={tickets}
                    />
                    <PathwaysDecisionDraftView
                      ticket={selected}
                      slug={slug}
                      onSubmitted={() => {
                        setRefresh(true);
                        void q.refetch();
                      }}
                    />
                    <PathwaysPrBadge ticket={selected} />
                  </div>
                </>
              )}
            </DialogContent>
          </Dialog>
        </>
      )}
    </UiCard>
  );
}

const NOW_FROM: Record<NonNullable<ScopeStatus["now"]>["from"], string> = { report: "Last report", update: "Status update", step: "Current step" };
const DONE_SHOWN = 3;

/**
 * An entry's status while nothing waits on the owner (2026-11-17): who is scoping and whether they work (their avatar,
 * the Pokémon when that setting is on), what they are on now, the scoping deliverables already reviewed (each a link
 * to it on Deliverables; none: no row), and what comes next. shadcn's Card, Item rows and Badges.
 */
function StatusCard({ entry, s, done, next, now, mon }: { entry: ScopeEntry; s: ScopeStatus; done: Deliverables; next: string; now: number; mon: (address: string) => Face | null }) {
  const address = s.who.address ?? `lead:${entry.slug}`;
  const idle = s.who.idleSince !== null ? age(s.who.idleSince, now) : null;
  const state = s.who.working ? "working" : s.who.state === "idle" && idle ? `idle ${idle}` : s.who.state;
  const label = "m-0 text-xs font-semibold text-muted-foreground";
  return (
    <UiCard role="region" className="orch-scope__status gap-4 py-4" data-scope-status={entry.key} aria-label={`${entry.slug}: who is scoping`}>
      <CardHeader className="flex items-center gap-3 px-4">
        <AgentFace face={mon(address)} address={address} size={32} boost={false} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <CardTitle role="heading" aria-level={3} className="text-sm leading-5 [overflow-wrap:anywhere]">
            {/* 2026-11-18: a lead with a persona is named by it ("Pilot Vesna") */}
            <span data-scope-who={s.who.kind}>{s.who.kind === "lead" && mon(address)?.persona ? personaName(mon(address)!.persona!) : s.who.name}</span>
          </CardTitle>
          <CardDescription className="text-xs [overflow-wrap:anywhere]">{s.who.address ?? `No lead is running for ${entry.slug}`}</CardDescription>
        </div>
        <Badge variant={s.who.state === "stuck on an error" ? "destructive" : "outline"} className="shrink-0 self-start" data-scope-who-state={s.who.working ? "working" : s.who.state}>
          <span aria-hidden className={cn("size-1.5 rounded-full bg-current", s.who.working ? "text-(--success-foreground) motion-safe:animate-pulse" : "text-muted-foreground")} />
          {state}
        </Badge>
      </CardHeader>
      <CardContent className="px-4">
        <ItemGroup className="gap-3">
          <Item role="listitem" size="sm" className="flex-col items-stretch gap-1 p-0" data-scope-on-now={s.now?.from ?? "none"}>
            <h4 className={label}>On now</h4>
            {s.now ? (
              <div className="text-sm [overflow-wrap:anywhere]">
                {s.now.text}
                <span className="block text-xs text-muted-foreground">
                  {NOW_FROM[s.now.from]} · {age(s.now.at, now) ?? "<1m"} ago
                </span>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">{s.who.kind === "thread" ? "No report yet" : "No status yet"}</div>
            )}
          </Item>
          {done.length ? (
            // flex-nowrap: wrapping, a column is as wide as its widest line, so a long title would widen the card
            <Item role="listitem" size="sm" className="flex-col flex-nowrap items-stretch gap-1 p-0" data-scope-done={String(done.length)}>
              <h4 className={label}>Done so far</h4>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {done.slice(0, DONE_SHOWN).map((d) => (
                  <li key={d.id} className="flex min-w-0 items-center gap-2">
                    {/* a long title ends in an ellipsis and the pill stays in the card (2026-11-18, the owner) */}
                    <OpenRef open={panel("deliverables", `[data-deliverable="${d.id}"], [data-tree-key="d:${d.id}"]`, d.id)} title={`Open "${d.title}" on Deliverables`} data="deliverable">
                      {d.title}
                    </OpenRef>
                    {d.state === "approved" ? <Chip spec={{ tone: "good", icon: "check", word: "approved" }} /> : <Chip spec={{ tone: "quiet", icon: "quiet", word: "changes asked" }} />}
                  </li>
                ))}
              </ul>
              {done.length > DONE_SHOWN ? <span className="text-xs text-muted-foreground">{done.length - DONE_SHOWN} more on Deliverables</span> : null}
            </Item>
          ) : null}
          <Item role="listitem" size="sm" className="flex-col items-stretch gap-1 p-0" data-scope-then="">
            <h4 className={label}>Next</h4>
            <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{next}</div>
          </Item>
        </ItemGroup>
      </CardContent>
    </UiCard>
  );
}

/**
 * An entry's chat (1.13.0): the lead's own thread; while a scoping thread plans the task, a switch to watch that
 * thread's own transcript instead ("Lead" | "Scoping thread"). The composer under it always writes to the lead (a
 * tracked direct message): the scoping thread hears from its lead, so the hint says the lead passes it on.
 */
function ScopeChat({ project, entry, now, cos, refetchAll, onFocus, height }: { project: Project; entry: ScopeEntry; now: number; cos: string; refetchAll: () => void; onFocus: () => void; height?: string }) {
  const navigate = useBbNavigate();
  const planner = plannerOf(entry);
  const [view, setView] = useState<"lead" | "thread">("lead");
  const shown = planner.kind === "thread" ? view : "lead";
  const busy = gate.lock !== null;
  return (
    <ChatCard slug={project.slug} data-scope-chat-view={shown}>
      <div className="k-chat__bar">
        {planner.kind === "thread" ? (
          <Tabs value={shown} onValueChange={(v) => setView(v as "lead" | "thread")}>
            <TabsList aria-label="Whose chat">
              <TabsTrigger value="lead" data-scope-view="lead">
                Lead
              </TabsTrigger>
              <TabsTrigger value="thread" data-scope-view="thread" title={planner.text}>
                Scoping thread
              </TabsTrigger>
            </TabsList>
          </Tabs>
        ) : (
          <h3 className="m-0 text-sm font-semibold">Chat with the lead</h3>
        )}
        {shown === "thread" && planner.kind === "thread" ? (
          <Btn tone="ghost" size="sm" className="tail" title={`Open ${planner.address} in bb`} data-open-thread={planner.threadId} onClick={() => navigate.toThread(planner.threadId)}>
            Open in bb
          </Btn>
        ) : null}
      </div>
      {shown === "thread" && planner.kind === "thread" ? (
        <ThreadBox threadId={planner.threadId} label={planner.address} height={height} note={`${planner.name}'s thread. It reports to the ${project.slug} lead.`} />
      ) : (
        <ChatBody project={project} now={now} cos={cos} busy={busy} refetchAll={refetchAll} height={height} />
      )}
      <Composer project={project} now={now} cos={cos} busy={busy} refetchAll={refetchAll} onFocus={onFocus} via={planner.kind === "thread" ? "The lead passes it to the scoping thread" : undefined} />
    </ChatCard>
  );
}
