// The Open PRs tab (2026-11-16): every open PR the owner authored, with its project and lead, state and a plain summary;
// a Needs review filter; the running review ask (one block of text, one click copies it); and Post, which shows the
// exact text with a tick per PR, then copies it and opens the code-review channel (with a Slack token: posts it, below).
// The text in all three places is core/open-prs.ts buildPrompt's, so what you see is what is copied.
// Rev 2 (2026-11-16): a repo#n link on every row, coloured state chips (prChips, PR_CHIP_TONES), the summary as a
// bullet, and the review ask drawn as the Slack message it becomes: SlackMessage takes only the copied string and
// draws it through core's slackLines, the same tokens the clipboard's HTML flavour is written from.
// shadcn (2026-11-17): app/ui's parts on bb's tokens and type scale (text-xs/sm/base = 12/13/15, 400 body, 500 controls
// and badges, 600 titles): the filters a ToggleGroup, the chips Badges in
// PR_CHIP_TONES, the ticks Checkboxes, and the Slack preview a Card with an Avatar. Colour only for meaning (CI failing
// red, approved green), no uppercase labels, one column on a phone.
// Cards (2026-11-17, the owner: "each pr in a collapsible card that we can expand to make it look cleaner"): one Card
// per PR that folds (Collapsible), the same cards at every width, and the table's sorts in a Select.
// Fast first paint (2026-11-17): after a restart the server answers with the kept snapshot at once; the line says how old
// it is and that a check runs. A skeleton shows only when there has never been a read. Ages tick on one shared minute
// clock (useMinute), so neither the clock nor a refetch that changes nothing redraws the cards (PrCard is memoised).
// Post really posts (2026-11-17, the owner: "Post as me"): with the slackToken setting, Post sends from the server after a
// preview and a confirm that shows the message exactly as it will appear; without it, Post copies and opens, as before.
// Review states and "since your last copy" (2026-11-18, folded in from a contributor's public PR #4): First review,
// Re-review and Approved on head filters beside Needs review, each card's state chip, and the ask and Post following the
// selected filter (Re-review asks the earlier reviewers). A copy or a post that succeeds keeps what it held as that
// filter's baseline; the next ask lists what changed since, above the copied text unless unticked. The Post confirm
// names who gets pinged.
// Layout (2026-11-18, the owner: "it's still really jank and wonky … it still shows way too much text and when you click
// 'post a code review,' the checkboxes come up … it's just too much to scroll"): the page measures its own width. Wide
// (a full or a stacked pane): one table row per PR, the title on one line, then PR, state, CI, reviewers and age in
// columns. Narrow (a side-by-side pane, a phone): a card with the title on up to two lines and the same few facts under
// it. The summary and the rest open behind the row's or the card's expand. The review ask, its ticks, "since your last
// copy", the pings and Copy and Post moved into one Dialog, so opening Post never moves the list.
// Resizable columns (2026-11-18, the owner: "the columns aren't individually adjustable in width"): every column of the
// wide table has a handle on its header's right edge (column-widths.ts). Drag sizes that column alone, double-click
// resets it, and the widths are kept per viewer. Title fills what the others leave until it is dragged; wider than the
// tab, the table scrolls inside its box.
// The table fills the tab (2026-11-18, the owner: "on a wider screen it fills more of the space, so the columns get more
// room"): the tab is no longer capped at 1024 px. Past today's box every column grows in proportion, and a resize is
// kept as shares of the box, so it holds at any width (column-widths.ts).
// Grouped by project (2026-11-18, the owner: easy to see which project each PR belongs to): one group per project the PR
// already carries, by name, then Unassigned, each with its count and a collapse kept per viewer (pr-groups.ts). In the
// table a group's header is a row spanning the drawn columns, so every group shares the one header and its handles.
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { experimental_useRpcQuery, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { CHANGED_CHANNEL } from "../contract.ts";
import { OPEN_PRS_CHANNEL, OPEN_PRS_COPIED, OPEN_PRS_POST, openPrsContract, type OpenPr, type OpenPrsPosted, type OpenPrsPrepared, type OpenPrsView } from "../open-prs/contract.ts";
import { buildPrompt, initialTicks, mentionHandles, prChips, prRef, slackHtml, slackLines, sortPrs, type Chip, type PrSort, type PromptPr } from "../core/open-prs.ts";
import { changesForSent, changesSince, withChanges, type CopiedPr, type CopyChange, type Section } from "../core/open-prs-copies.ts";
import { PR_CHIP_TONES, SLACK_TONES, css, tint } from "./palette.ts";
import { openInBb } from "./open-proof.ts";
import { useIdentity } from "./identity.ts";
import { ARM_MS } from "./gate.ts";
import { gate, useGate, write } from "./store.ts";
import { ProofLink } from "./proof-link.tsx";
import { Btn, EmptyState, Muted, ReadState, when } from "./ui.tsx";
import { age } from "./lanes.ts";
import { Avatar, AvatarFallback } from "./ui/avatar.tsx";
import { Badge } from "./ui/badge.tsx";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";
import { Card } from "./ui/card.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.tsx";
import { useWidth } from "./panes.tsx";
import { useTouchPhone } from "./phone.ts";
import { ScrollRow } from "./scroll-row.tsx";
import { useColumnWidths, type ColumnSpec, type HandleProps } from "./column-widths.ts";
import { GROUPS_KEY, groupPrs, useCollapsed, type PrGroup } from "./pr-groups.ts";
import { Label } from "./ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";

type Filter = "needs" | "first" | "rereview" | "approved" | "all";
/** The filters, what each one means, and what it says when empty. Needs review, First review and Re-review have an ask. */
const FILTERS: { value: Filter; label: string; means: string; none: string }[] = [
  { value: "needs", label: "Needs review", means: "Needs review: ready, not fully approved, CI not failing.", none: "Nothing needs review." },
  { value: "first", label: "First review", means: "First review: no person has reviewed it yet.", none: "No PR waits for a first review." },
  { value: "rereview", label: "Re-review", means: "Re-review: someone's latest review is on an older commit.", none: "No PR needs a re-review." },
  { value: "approved", label: "Approved on head", means: "Approved on head: a person approved its current commit.", none: "No PR is approved on its current commit." },
  { value: "all", label: "All", means: "All your open PRs.", none: "No open PRs." },
];
const inFilter = (p: OpenPr, f: Filter) => (f === "all" ? true : f === "needs" ? p.needsReview : p.state === f);
const sectionOf = (f: Filter): Section | null => (f === "needs" || f === "first" || f === "rereview" ? f : null);
/** A PR as a baseline keeps it. */
const copiedRow = (p: OpenPr): CopiedPr => ({ url: p.url, repo: p.repo, number: p.number, title: p.title, sha: p.sha, state: p.state, review: p.review, ci: p.ci });
/** The ask's PRs: First review and Re-review ask the state's people (requested, or the earlier reviewers) when it has them. */
const askPrs = (prs: OpenPr[], section: Section): PromptPr[] => prs.map((p) => (section !== "needs" && p.stateWho.length ? { ...p, candidates: p.stateWho } : p));
/** The review ask for a section, with the change header when ticked and there is a baseline. */
const askText = (prs: OpenPr[], section: Section, changes: CopyChange[] | null) => withChanges(buildPrompt(askPrs(prs, section), 5, section === "rereview"), changes);
/** After a successful copy or post: the section's baseline becomes these PRs. False when it couldn't be kept. */
async function keepCopy(section: Section, prs: OpenPr[]): Promise<boolean> {
  const out = await write(OPEN_PRS_COPIED, { section, prs: prs.map(copiedRow) }, { kind: "other", where: "open-prs", after: () => {} });
  return !!out?.ok;
}
const STATE_WHO: Record<string, string> = { first: "Ask", rereview: "Reviewed before", approved: "Approved by" };

/** A note line: small and muted. */
const NOTE = "m-0 text-xs text-muted-foreground";
/** A PR's repo#n link, in the Slack link blue it has in the channel. */
const LINK = { color: css(SLACK_TONES.link) };

/** The read, refetched when a GitHub read lands, on any orchestrator change, and each minute while the tab is shown. */
function useOpenPrs() {
  const q = experimental_useRpcQuery({ contract: openPrsContract, method: "openPrs", input: null });
  const refetch = useRef(q.refetch);
  refetch.current = q.refetch;
  const again = useCallback(() => void refetch.current(), []);
  useRealtime(OPEN_PRS_CHANNEL, again);
  useRealtime(CHANGED_CHANNEL, again);
  useEffect(() => {
    const t = setInterval(again, 60_000);
    return () => clearInterval(t);
  }, [again]);
  return q;
}

/** One clock for every age on the tab: it ticks each minute, and only the components that show an age redraw. */
const minute = { now: Date.now(), subs: new Set<() => void>(), timer: undefined as ReturnType<typeof setInterval> | undefined };
function useMinute(): number {
  return useSyncExternalStore(
    (cb) => {
      minute.subs.add(cb);
      if (!minute.timer)
        minute.timer = setInterval(() => {
          minute.now = Date.now();
          for (const f of minute.subs) f();
        }, 60_000);
      return () => {
        minute.subs.delete(cb);
        if (minute.subs.size === 0) {
          clearInterval(minute.timer);
          minute.timer = undefined;
        }
      };
    },
    // with no age on screen the clock is stopped: the first one shown reads the time afresh when the clock is a minute
    // or more behind (so every read in one render agrees), never the minute the tab was last open
    () => (minute.subs.size || Date.now() - minute.now < 60_000 ? minute.now : (minute.now = Date.now())),
  );
}

/** "5m", "3h": how long ago, on the shared minute clock. */
function Ago({ at }: { at: number }) {
  const now = useMinute();
  return <>{age(at, Math.max(now, at))}</>;
}

/** A state chip: a Badge in its tone's colour (PR_CHIP_TONES), cut short with an ellipsis in a narrow column. */
function PrChip({ c, title }: { c: Chip; title?: string }) {
  const tone = PR_CHIP_TONES[c.tone];
  return (
    <Badge variant="secondary" data-chip={c.key} data-tone={c.tone} title={title} className="max-w-full shrink" style={{ color: css(tone), background: tint(tone) }}>
      <span className="truncate">{c.text}</span>
    </Badge>
  );
}

/** CI as a dot in its chip's colour (a phone's one-line facts); the words stay its accessible name and title. */
function CiDot({ c }: { c: Chip }) {
  return <span role="img" aria-label={c.text} title={c.text} data-chip={c.key} data-tone={c.tone} className="size-2.5 shrink-0 rounded-full" style={{ background: css(PR_CHIP_TONES[c.tone]) }} />;
}

const SORTS: { value: string; key: PrSort; desc: boolean; label: string }[] = [
  { value: "updated-desc", key: "updated", desc: true, label: "Newest update first" },
  { value: "updated-asc", key: "updated", desc: false, label: "Oldest update first" },
  { value: "review-asc", key: "review", desc: false, label: "Review: changes requested first" },
  { value: "ci-asc", key: "ci", desc: false, label: "CI: failing first" },
  { value: "project-asc", key: "project", desc: false, label: "Project A to Z" },
];

/** The one chip a folded PR shows for its state: its review state, else Draft, else how its review stands. */
const stateChip = (chips: Chip[]): Chip => chips.find((c) => c.key === "state") ?? chips.find((c) => c.key === "draft") ?? chips.find((c) => c.key === "review")!;
const ciChip = (chips: Chip[]): Chip => chips.find((c) => c.key === "ci")!;
/** A PR's reviewers in one line: its state's people (to ask, reviewed before, approved by), else the suggested ones. */
const reviewersOf = (pr: OpenPr): string => (pr.stateWho.length ? pr.stateWho : pr.candidates).map((c) => c.say).join(", ");
const samePr = (a: { pr: OpenPr }, b: { pr: OpenPr }) => JSON.stringify(a.pr) === JSON.stringify(b.pr);
const sameRow = (a: { pr: OpenPr; span: number; filler: boolean }, b: { pr: OpenPr; span: number; filler: boolean }) => a.span === b.span && a.filler === b.filler && samePr(a, b);

/** The wide table's columns: Title fills what the others leave until it is dragged; the rest start at their old widths in today's box, and grow past it. */
const PR_COLS: ColumnSpec[] = [
  { id: "title", label: "Title", width: null, min: 160 },
  { id: "pr", label: "PR", width: 128, min: 64 },
  { id: "state", label: "State", width: 176, min: 72 },
  { id: "ci", label: "CI", width: 112, min: 56 },
  { id: "reviewers", label: "Reviewers", width: 160, min: 72 },
  { id: "updated", label: "Updated", width: 96, min: 64 },
];
/** Where the viewer's widths are kept (per browser, never on the server), as shares of the box; v1 kept px, read once. */
const COLS_KEY = "orchestrator.open-prs.columns.v2";
const OLD_COLS_KEY = "orchestrator.open-prs.columns.v1";

/** A column's resize handle: a thin line on the header's right edge, wider to grab, darker on hover, focus or drag. */
function ColHandle(p: HandleProps) {
  return (
    <span
      {...p}
      className="absolute inset-y-0 right-0 z-10 w-3 cursor-col-resize touch-none select-none outline-none after:absolute after:inset-y-2 after:right-0 after:w-px after:bg-border hover:after:w-0.5 hover:after:bg-ring focus-visible:after:w-0.5 focus-visible:after:bg-ring active:after:w-0.5 active:after:bg-ring"
    />
  );
}
/** A click on a row or a card's header toggles it, except on the link (it opens the PR) or the toggle (it toggles itself). */
const toggleOn = (set: (f: (o: boolean) => boolean) => void) => (e: MouseEvent) => {
  if ((e.target as Element).closest("a, button")) return;
  set((o) => !o);
};

/** What a PR's expand holds: the summary, the chips the folded row leaves out, the project and lead, who, and when. */
function PrDetails({ pr }: { pr: OpenPr }) {
  const chips = prChips(pr);
  const shown = stateChip(chips);
  const rest = chips.filter((c) => c !== shown && c.key !== "ci");
  return (
    <>
      <ul className="m-0 list-disc pl-4 text-sm [overflow-wrap:anywhere] marker:text-muted-foreground">
        <li>{pr.summary}</li>
      </ul>
      {rest.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs" data-more-chips="">
          {rest.map((c) => (
            <PrChip key={c.key} c={c} title={c.text} />
          ))}
        </div>
      ) : null}
      <dl className="m-0 mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Project</dt>
        <dd className="m-0 [overflow-wrap:anywhere]">{pr.project ?? "No project"}</dd>
        {pr.project ? (
          <>
            <dt className="text-muted-foreground">Lead</dt>
            <dd className="m-0 [overflow-wrap:anywhere]">{pr.lead ?? "no lead"}</dd>
          </>
        ) : null}
        {pr.state && pr.stateWho.length ? (
          <>
            <dt className="text-muted-foreground">{STATE_WHO[pr.state]}</dt>
            <dd className="m-0 [overflow-wrap:anywhere]" data-state-who="">
              {pr.stateWho.map((c) => c.say).join(", ")}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Updated</dt>
        <dd className="m-0">{when(pr.updatedAt)}</dd>
      </dl>
    </>
  );
}

/**
 * One PR in a narrow pane: a Card that folds (2026-11-17, the owner: "each pr in a collapsible card that we can
 * expand"). Folded (2026-11-18): the title on up to two lines, then the repo#n link, the state, CI, the reviewers and
 * the age; opened, PrDetails. The title is the Collapsible's trigger (a button with aria-expanded, so a keyboard opens
 * it), and a click elsewhere on the header toggles too, except on the link, which opens the PR.
 */
const PrCard = memo(function PrCard({ pr }: { pr: OpenPr }) {
  const [open, setOpen] = useState(false);
  const chips = prChips(pr);
  const state = stateChip(chips);
  const who = reviewersOf(pr);
  // a phone (2026-11-21, the owner: "too much wasted space"): the title on one line and the facts on one line, cut
  // rather than wrapped; the whole title opens on a tap
  const phone = useTouchPhone();
  return (
    <li data-pr={pr.url} data-needs={pr.needsReview ? "true" : "false"} data-open={open ? "true" : "false"}>
      <Collapsible open={open} onOpenChange={setOpen} asChild>
        <Card className="gap-0 rounded-lg py-0 shadow-none">
          <div className={phone ? "grid cursor-pointer gap-0.5 px-3 py-1.5" : "grid cursor-pointer gap-1 px-3 py-2.5"} onClick={toggleOn(setOpen)} data-card-head="">
            <CollapsibleTrigger className="group flex min-h-6 min-w-0 items-start gap-1.5 rounded-sm text-left text-sm font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" data-toggle="" title={pr.title}>
              <ChevronRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
              <span className={phone ? "line-clamp-1 [overflow-wrap:anywhere]" : "line-clamp-2 [overflow-wrap:anywhere]"}>{pr.title}</span>
            </CollapsibleTrigger>
            {/* the facts wrap rather than squeeze a chip to "R…" beside a long repo name (a phone) */}
            <div className={phone ? "flex min-w-0 flex-nowrap items-center gap-x-1.5 overflow-hidden pl-5.5 text-xs" : "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-5.5 text-xs"} data-card-facts="">
              <ProofLink open={{ url: pr.url }} className="inline-flex min-h-6 shrink-0 items-center font-medium underline underline-offset-2" style={LINK} data-pr-link={pr.url} title={pr.url}>
                {prRef(pr)}
              </ProofLink>
              <PrChip c={state} title={state.text} />
              {/* a phone: CI as its colour, its words as the label and title, so the state keeps its words on one line */}
              {phone ? <CiDot c={ciChip(chips)} /> : <PrChip c={ciChip(chips)} />}
              {who ? (
                <span className={phone ? "min-w-0 shrink-[3] truncate text-muted-foreground" : "max-w-full min-w-0 truncate text-muted-foreground"} title={who} data-reviewers="">
                  {who}
                </span>
              ) : null}
              <span className="ml-auto shrink-0 text-muted-foreground" title={pr.updatedAt} data-updated="">
                <Ago at={Date.parse(pr.updatedAt)} />{phone ? null : " ago"}
              </span>
            </div>
          </div>
          <CollapsibleContent className="border-t px-3 py-3 pl-9" data-card-body="">
            <PrDetails pr={pr} />
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </li>
  );
}, samePr);

/**
 * One PR in a wide pane (2026-11-18, the owner: "a landscape view that's a little bit cleaner"): one table row, the
 * title cut to one line, then the repo#n link, the state, CI, the reviewers and the age in their columns; its expand
 * opens a second row with PrDetails under it.
 */
const PrRow = memo(function PrRow({ pr, span, filler }: { pr: OpenPr; span: number; filler: boolean }) {
  const [open, setOpen] = useState(false);
  const chips = prChips(pr);
  const state = stateChip(chips);
  const who = reviewersOf(pr);
  return (
    <>
      <TableRow className="cursor-pointer" onClick={toggleOn(setOpen)} data-pr={pr.url} data-needs={pr.needsReview ? "true" : "false"} data-open={open ? "true" : "false"}>
        <TableCell className="max-w-0">
          <Button variant="ghost" size="xs" aria-expanded={open} data-state={open ? "open" : "closed"} onClick={() => setOpen((o) => !o)} className="group h-auto min-h-6 w-full min-w-0 justify-start gap-1.5 rounded-sm px-0 text-left text-sm font-semibold hover:bg-transparent [&:is(.dark_*)]:hover:bg-transparent" data-toggle="" title={pr.title}>
            <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
            <span className="truncate">{pr.title}</span>
          </Button>
        </TableCell>
        <TableCell className="max-w-0 text-xs">
          <ProofLink open={{ url: pr.url }} className="inline-flex min-h-6 max-w-full items-center truncate font-medium underline underline-offset-2" style={LINK} data-pr-link={pr.url} title={pr.url}>
            {prRef(pr)}
          </ProofLink>
        </TableCell>
        <TableCell className="max-w-0">
          <PrChip c={state} title={state.text} />
        </TableCell>
        <TableCell className="max-w-0">
          <PrChip c={ciChip(chips)} />
        </TableCell>
        <TableCell className="max-w-0 text-xs text-muted-foreground">
          <span className="block truncate" title={who} data-reviewers="">
            {who || "none yet"}
          </span>
        </TableCell>
        <TableCell className="text-xs text-muted-foreground" title={pr.updatedAt} data-updated="">
          <Ago at={Date.parse(pr.updatedAt)} /> ago
        </TableCell>
        {filler ? <TableCell className="p-0" aria-hidden="true" /> : null}
      </TableRow>
      {open ? (
        <TableRow className="hover:bg-transparent" data-row-body={pr.url}>
          <TableCell colSpan={span} className="px-3 pt-1 pb-3 pl-9 whitespace-normal">
            <PrDetails pr={pr} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}, sameRow);

/** A group's collapse: its project's name and how many PRs it holds; a keyboard opens it too (a button with aria-expanded). */
function GroupToggle({ g, open, onToggle }: { g: PrGroup<OpenPr>; open: boolean; onToggle: () => void }) {
  const n = g.prs.length;
  return (
    <Button variant="ghost" size="xs" aria-expanded={open} data-state={open ? "open" : "closed"} onClick={onToggle} className="group h-auto min-h-6 max-w-full min-w-0 justify-start gap-1.5 rounded-sm px-0 text-left text-xs font-semibold hover:bg-transparent [&:is(.dark_*)]:hover:bg-transparent" data-group-toggle="">
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
      <span className="truncate">{g.name}</span>
      <Badge variant="secondary" className="shrink-0 tabular-nums" aria-label={`${n} PR${n === 1 ? "" : "s"}`} data-group-count="">
        {n}
      </Badge>
    </Button>
  );
}
const groupData = (g: PrGroup<OpenPr>, open: boolean) => ({ "data-group": g.key ?? undefined, "data-unassigned": g.key === null ? "" : undefined, "data-group-open": open ? "true" : "false" });

/** A group's header in the table: one row spanning the drawn columns, so the groups share the one header and its handles. */
function GroupRow({ g, open, span, onToggle }: { g: PrGroup<OpenPr>; open: boolean; span: number; onToggle: () => void }) {
  return (
    <TableRow className="cursor-pointer bg-muted/50 hover:bg-muted/50" onClick={(e) => ((e.target as Element).closest("a, button") ? null : onToggle())} data-group-head="" {...groupData(g, open)}>
      <TableCell colSpan={span} className="max-w-0 py-1.5">
        <GroupToggle g={g} open={open} onToggle={onToggle} />
      </TableCell>
    </TableRow>
  );
}

/** A group's header over its cards. */
function GroupHead({ g, open, onToggle }: { g: PrGroup<OpenPr>; open: boolean; onToggle: () => void }) {
  return (
    <h3 className="m-0 flex min-w-0 px-1 text-xs" data-group-head="">
      <GroupToggle g={g} open={open} onToggle={onToggle} />
    </h3>
  );
}

/**
 * The PRs in the sort the Select picks, grouped by project (pr-groups.ts): table rows when the page is wide, folding
 * cards when it is narrow. A collapsed group shows only its header.
 */
function PrList({ prs, wide, action }: { prs: OpenPr[]; wide: boolean; action?: ReactNode }) {
  const [sort, setSort] = useState(SORTS[0]!.value);
  const s = SORTS.find((x) => x.value === sort) ?? SORTS[0]!;
  const rows = useMemo(() => sortPrs(prs, s.key, s.desc), [prs, s.key, s.desc]);
  const groups = useMemo(() => groupPrs(rows), [rows]);
  const { collapsed, toggle } = useCollapsed(GROUPS_KEY);
  const { layout, handle, boxRef } = useColumnWidths(COLS_KEY, PR_COLS, OLD_COLS_KEY);
  const phone = useTouchPhone();
  return (
    <div className={phone ? "grid min-w-0 gap-1" : "grid min-w-0 gap-2"} data-prs-list={wide ? "rows" : "cards"}>
      <div className="flex items-center gap-2">
        <Label htmlFor="open-prs-sort" className="text-xs font-normal text-muted-foreground">
          Sort
        </Label>
        <Select value={sort} onValueChange={setSort}>
          <SelectTrigger id="open-prs-sort" size="sm" className="text-xs" data-sort-select="">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((o) => (
              <SelectItem key={o.value} value={o.value} className="text-xs" data-sort={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {action ? <span className="ml-auto">{action}</span> : null}
      </div>
      {wide ? (
        // min-w-0: a table dragged wider than the tab scrolls inside this box (ui/table.tsx's container), not the page
        <div ref={boxRef} className="min-w-0 overflow-hidden rounded-lg border" data-prs-table="">
          <Table className="table-fixed" style={layout.style}>
            <colgroup>
              {layout.cols.map((w, i) => (
                <col key={PR_COLS[i]!.id} style={w === null ? undefined : { width: w }} data-col={PR_COLS[i]!.id} />
              ))}
              {layout.filler ? <col data-col="filler" /> : null}
            </colgroup>
            <TableHeader>
              <TableRow className="text-xs hover:bg-transparent">
                {PR_COLS.map((c) => (
                  <TableHead key={c.id} className={`relative truncate text-muted-foreground${c.id === "title" ? " pl-9" : ""}`}>
                    {c.label}
                    <ColHandle {...handle(c)} />
                  </TableHead>
                ))}
                {layout.filler ? <TableHead className="p-0" aria-hidden="true" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((g) => {
                const open = !collapsed.has(g.key);
                return (
                  <Fragment key={g.key ?? ""}>
                    <GroupRow g={g} open={open} span={layout.span} onToggle={() => toggle(g.key)} />
                    {open ? g.prs.map((p) => <PrRow key={p.url} pr={p} span={layout.span} filler={layout.filler} />) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className={phone ? "grid min-w-0 gap-1" : "grid min-w-0 gap-3"} data-prs-groups="">
          {groups.map((g) => {
            const open = !collapsed.has(g.key);
            return (
              <section key={g.key ?? ""} className={phone ? "grid min-w-0 gap-1" : "grid min-w-0 gap-2"} {...groupData(g, open)}>
                <GroupHead g={g} open={open} onToggle={() => toggle(g.key)} />
                {open ? (
                  <ul className="m-0 grid min-w-0 list-none gap-2 p-0" data-prs-cards="">
                    {g.prs.map((p) => (
                      <PrCard key={p.url} pr={p} />
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Copy to the clipboard as text/plain (the string itself) and text/html (slackHtml of the same tokens), so a paste
 * into Slack keeps links and bold; plain text alone where the browser has no ClipboardItem. False when the browser
 * refuses (the message stays on screen to copy by hand).
 */
async function copy(text: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
      const html = slackHtml(slackLines(text));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]);
    } else await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}

/** The copied string drawn as Slack draws it in the channel. It takes only that string: nothing else can reach it. */
function SlackMessage({ text, name, ...p }: { text: string; name: string; [data: `data-${string}`]: string | undefined }) {
  return (
    <Card className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-2 gap-y-0 rounded-lg p-3 shadow-none" data-copy-text={text} {...p}>
      <Avatar size="32" aria-hidden="true">
        <AvatarFallback className="font-semibold">{(name.trim()[0] ?? "?").toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 text-sm leading-6 [overflow-wrap:anywhere]">
        <div className="flex items-baseline gap-2">
          <b className="font-semibold">{name}</b>
          <span className="text-xs text-muted-foreground">now</span>
        </div>
        {slackLines(text).map((l, i) => (
          <p key={i} className="m-0 min-h-6 data-[bullet]:pl-3" data-bullet={l.bullet ? "" : undefined}>
            {l.toks.map((t, j) =>
              t.kind === "link" ? (
                <ProofLink key={j} open={{ url: t.raw }} className="no-underline hover:underline" style={LINK}>
                  {t.show}
                </ProofLink>
              ) : t.kind === "bold" ? (
                <b key={j} className="font-semibold">
                  {t.show}
                </b>
              ) : t.kind === "mention" ? (
                <span key={j} className="rounded-sm px-0.5" style={{ color: css(SLACK_TONES.mention), background: tint(SLACK_TONES.mention) }} data-mention="">
                  {t.show}
                </span>
              ) : (
                <span key={j}>{t.show}</span>
              ),
            )}
          </p>
        ))}
      </div>
    </Card>
  );
}

const MENTION_NOTE = "@names may need a tap to become mentions.";

/** A new Post's key (its dedupe key on the server): one per opened preview. */
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Post, in a Dialog over the list (2026-11-18, the owner: "it's just too much to scroll"; before, it opened above the
 * list and pushed it down): the exact text with a tick per PR (the selected filter's PRs; excluded projects start
 * unticked), what changed since the last copy, who it pings, then Copy and Post. Copy copies the ticked PRs' ask and
 * keeps them as the filter's baseline. Without a Slack token, Confirm copies it and opens the channel, as before. With
 * one (2026-11-17, the owner: "Post as me"): "Post to #channel…" asks the server to find the channel and the mentions
 * (nothing is sent), then a confirm draws the message exactly as it will show and only its own Post sends it, once:
 * the key is minted when the dialog opens, the write gate drops a second click while one runs, and the server answers
 * a repeated key with the first outcome. The dialog won't close while a step runs or the confirm is open, so its key
 * and what it posted stay.
 */
function Post({ prs, view, name, section, found, since, onClose }: { prs: OpenPr[]; view: OpenPrsView; name: string; section: Section; found: CopyChange[] | null; since: number | null; onClose: () => void }) {
  const nav = useBbNavigate();
  const rpc = useRpc<typeof openPrsContract>();
  const [ticks, setTicks] = useState<Record<string, boolean>>(() => initialTicks(prs, view.excluded));
  const [withSince, setWithSince] = useState(true);
  const [done, setDone] = useState<string | null>(null);
  const [key] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<OpenPrsPrepared | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [posted, setPosted] = useState<OpenPrsPosted | null>(null);
  useGate(); // redraws when the write gate changes
  const held = busy || !!ready || (!!gate.lock && !gate.lock.done);
  // a PR that appears while the dialog is open starts as its project says
  const ticked = (p: OpenPr) => ticks[p.url] ?? initialTicks([p], view.excluded)[p.url]!;
  const chosen = prs.filter(ticked);
  const changes = withSince ? found : null;
  // the header names only the ticked PRs and those that left the list, never one this message leaves out
  const text = askText(chosen, section, changes && changesForSent(changes, chosen.map((p) => p.url), prs.map((p) => p.url)));
  const pings = mentionHandles(text);
  const channel = view.channel?.name ?? null;
  const doCopy = async () => {
    if (!(await copy(text))) return setDone("Couldn't copy: select the text above and copy it.");
    setDone((await keepCopy(section, chosen)) ? "Copied." : "Copied, but not kept as the last copy.");
  };
  const copyAndOpen = async () => {
    const ok = await copy(text);
    if (!ok) return setDone("Couldn't copy: select the text above and copy it.");
    await keepCopy(section, chosen);
    if (view.channel) {
      if (!openInBb(nav, { url: view.channel.url })) window.open(view.channel.url, "_blank", "noopener,noreferrer");
      setDone(`Copied. Paste it in ${view.channel.name}`);
    } else setDone("Copied. Set reviewChannel to open the channel too.");
  };
  const prepare = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      setReady(await rpc.call("openPrsPrepare", { key, text, copied: { section, prs: chosen.map(copiedRow) } }));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    const out = await write(OPEN_PRS_POST, { key }, { kind: "other", where: "open-prs", after: () => {} });
    if (out === null) return; // another write holds the page: this click is dropped
    if (out.ok) {
      setPosted(out.result as OpenPrsPosted);
      setReady(null);
    } else setErr(out.message);
  };
  return (
    <Dialog open onOpenChange={(open) => (open || held ? null : onClose())}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-3 sm:max-w-2xl" data-post="" data-posted={posted ? "" : undefined}>
        {posted ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-base">Posted to {posted.channel}</DialogTitle>
              <DialogDescription role="status">
                {posted.permalink ? (
                  <ProofLink open={{ url: posted.permalink }} className="underline underline-offset-2" style={LINK} data-permalink={posted.permalink}>
                    Open the message in Slack
                  </ProofLink>
                ) : (
                  "Slack took it, but didn't give its link."
                )}
              </DialogDescription>
            </DialogHeader>
            <div>
              <Btn tone="ghost" onClick={onClose}>
                Close
              </Btn>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-base">Post to code reviews</DialogTitle>
              <DialogDescription className="text-xs">
                {view.canPost
                  ? `Untick a PR to leave it out. Nothing is sent until you confirm, in the next step, to post it to ${channel ?? "reviewChannel (not set)"}.`
                  : `Untick a PR to leave it out. Confirm copies this text and opens ${channel ?? "nothing (no reviewChannel set)"}; it never posts by itself.`}
              </DialogDescription>
            </DialogHeader>
            <ul className="m-0 grid max-h-[24vh] shrink-0 list-none gap-0.5 overflow-y-auto p-0" data-ticks="">
              {prs.map((p) => (
                <li key={p.url}>
                  <label className="flex min-h-6 cursor-pointer items-start gap-2 py-0.5 text-sm">
                    <Checkbox className="mt-0.5" data-tick={p.url} checked={ticked(p)} disabled={held} onCheckedChange={(c) => setTicks((t) => ({ ...t, [p.url]: c === true }))} />
                    <span className="min-w-0">
                      <span className="line-clamp-1 [overflow-wrap:anywhere]" title={p.title}>
                        {p.title}
                      </span>
                      {p.excluded ? <span className="text-xs text-muted-foreground">Project {p.project} is left out by default</span> : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {since !== null && found ? <SinceLastCopy at={since} changes={found} on={withSince} onChange={setWithSince} /> : null}
            <div className="min-h-24 flex-1 overflow-y-auto" data-post-preview="">
              {text ? <SlackMessage text={text} name={name} data-post-text="" /> : <p className={NOTE}>No PR ticked.</p>}
            </div>
            {text ? (
              <p className="m-0 text-sm" data-pings-draft="">
                {pings.length ? `Pings: ${pings.map((h) => `@${h}`).join(", ")}` : "Pings no one."}
                <span className="text-xs text-muted-foreground">{view.canPost ? " (checked against Slack before it posts)" : ` (${MENTION_NOTE})`}</span>
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {view.canPost ? (
                <Btn tone="primary" data-post-prepare="" disabled={!text || busy || !channel} onClick={() => void prepare()}>
                  {busy ? "Getting it ready…" : `Post to ${channel ?? "Slack"}…`}
                </Btn>
              ) : (
                <Btn tone="primary" data-post-confirm="" disabled={!text} onClick={() => void copyAndOpen()}>
                  {view.channel ? `Copy and open ${view.channel.name}` : "Copy"}
                </Btn>
              )}
              {text && (view.canPost || view.channel) ? (
                <Btn tone="ghost" data-copy-post="" disabled={held} onClick={() => void doCopy()}>
                  Copy
                </Btn>
              ) : null}
              <Btn tone="ghost" disabled={held} onClick={onClose}>
                Cancel
              </Btn>
              {done ? (
                <p className="m-0 text-sm font-medium" role="status">
                  {done}
                </p>
              ) : null}
            </div>
            {err && !ready ? (
              <p role="alert" className="m-0 text-sm text-(--destructive-text)" data-post-error="">
                {err}
              </p>
            ) : null}
          </>
        )}
        {ready ? <PostConfirm ready={ready} name={name} err={err} onYes={() => void send()} onCancel={() => (setReady(null), setErr(null))} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The confirm: the message drawn exactly as Slack will show it (the server's `shown`, the posted text before Slack's
 * escaping), and one Post that names the channel. Its Post takes clicks only ARM_MS after it opens, so the second click
 * of a double-click on "Post to #channel…" can't land on it, and it is disabled while the write runs.
 */
function PostConfirm({ ready, name, err, onYes, onCancel }: { ready: OpenPrsPrepared; name: string; err: string | null; onYes: () => void; onCancel: () => void }) {
  const [armed, setArmed] = useState(false);
  useGate(); // redraws when the write gate changes
  const running = !!gate.lock && !gate.lock.done;
  // who the post notifies: the mentions left in the confirmed text (a handle no one in Slack has lost its "@")
  const pings = mentionHandles(ready.shown);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <AlertDialog open onOpenChange={(open) => (open || running ? null : onCancel())}>
      <AlertDialogContent className="sm:max-w-2xl" data-post-dialog="">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-base">Post this to {ready.channel}?</AlertDialogTitle>
          <AlertDialogDescription>It shows in the channel exactly like this, under the token's name.</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="max-h-[50vh] overflow-auto">
          <SlackMessage text={ready.shown} name={name} data-post-shown="" />
        </div>
        <p className="m-0 text-sm" data-pings="">
          {pings.length ? `Pings: ${pings.map((h) => `@${h}`).join(", ")}` : "Pings no one."}
        </p>
        {ready.notes.map((n) => (
          <p key={n} className={NOTE}>
            {n}
          </p>
        ))}
        {err ? (
          <p role="alert" className="m-0 text-sm text-(--destructive-text)" data-post-error="">
            {err}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel size="sm" disabled={running}>
            Cancel
          </AlertDialogCancel>
          <Button size="sm" disabled={!armed || running} data-armed={armed ? "true" : "false"} data-post-send="" onClick={onYes}>
            {running ? "Posting…" : `Post to ${ready.channel}`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** In Post: what changed in this filter's PRs since its last successful copy or post, and whether the text says so. */
function SinceLastCopy({ at, changes, on, onChange }: { at: number; changes: CopyChange[]; on: boolean; onChange: (on: boolean) => void }) {
  const ago = (
    <span className="text-xs font-normal text-muted-foreground" title={when(at)}>
      <Ago at={at} /> ago
    </span>
  );
  if (!changes.length)
    return (
      <p className="m-0 text-sm" data-since="">
        No changes since your last copy {ago}
      </p>
    );
  return (
    <section className="grid shrink-0 gap-1" data-since="">
      <h3 className="m-0 text-sm font-semibold">Since your last copy {ago}</h3>
      <ul className="m-0 grid max-h-[16vh] list-none gap-0.5 overflow-y-auto p-0 text-sm">
        {changes.map((c) => (
          <li key={c.url} data-change={c.url} className="[overflow-wrap:anywhere]">
            <ProofLink open={{ url: c.url }} className="inline-flex min-h-6 items-center font-medium underline underline-offset-2" style={LINK}>
              {prRef(c)}
            </ProofLink>{" "}
            {c.reasons.join(", ")}
          </li>
        ))}
      </ul>
      <label className="flex min-h-6 cursor-pointer items-center gap-2 text-sm">
        <Checkbox data-since-include="" checked={on} onCheckedChange={(c) => onChange(c === true)} />
        Put these changes above the copied text
      </label>
    </section>
  );
}

/** No read has ever landed: the cards' shape, pulsing, and what is happening. */
function CardsSkeleton({ note }: { note?: string }) {
  return (
    <div role="status" className="grid gap-2" data-prs-skeleton="">
      <span className={note ? NOTE : "sr-only"}>{note ?? "Loading…"}</span>
      {[0, 1, 2].map((i) => (
        <Card key={i} className="gap-2 rounded-lg px-3 py-3 shadow-none">
          <Skeleton className="h-4 w-2/3" />
          <div className="flex gap-1.5">
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-5 w-20" />
          </div>
        </Card>
      ))}
    </div>
  );
}

/** From this width the PRs are table rows (a full or stacked pane); below it, cards (a side-by-side pane, a phone). */
const WIDE = 880;

/**
 * The tab. It measures its own width (a pane's, not the window's), so a split pane gets the layout that fits it; it
 * draws nothing until the first measure, so the list never flips from one layout to the other on open.
 */
export function OpenPrsView() {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  return (
    <div ref={ref} data-layout={width === 0 ? "measuring" : width >= WIDE ? "rows" : "cards"}>
      {width > 0 ? <OpenPrsBody wide={width >= WIDE} /> : null}
    </div>
  );
}

function OpenPrsBody({ wide }: { wide: boolean }) {
  const q = useOpenPrs();
  // the Slack preview's sender: the ownerName setting, else a neutral "You"
  const name = useIdentity().ownerName.trim() || "You";
  const [filter, setFilter] = useState<Filter>("needs");
  const [posting, setPosting] = useState(false);
  const phone = useTouchPhone();
  const v = q.data;
  if (!v) return q.error ? <ReadState q={q} what="your open PRs" /> : <CardsSkeleton />;
  if (v.state === "unset")
    return (
      <EmptyState
        title="Set your GitHub login"
        text="Open PRs lists the PRs you authored. Set githubLogin in the orchestrator's plugin settings (bb plugin config orchestrator set githubLogin <login>)."
        icon={null}
      />
    );
  if (v.state === "loading") return <CardsSkeleton note="Reading your open PRs from GitHub for the first time…" />;
  if (v.state === "error") return <EmptyState title="Can't read your open PRs" text={v.error ?? "GitHub didn't answer."} icon={null} action={<Btn onClick={() => void q.refetch()}>Try again</Btn>} />;
  const shown = v.prs.filter((p) => inFilter(p, filter));
  const f = FILTERS.find((x) => x.value === filter)!;
  const section = sectionOf(filter);
  const baseline = section ? v.copied[section] : undefined;
  const changes = section && baseline ? changesSince(baseline, shown.map(copiedRow), v.prs.map(copiedRow), v.departed) : null;
  const asked = section && shown.length > 0 ? section : null;
  const post = (
    <Btn size={phone ? "sm" : "md"} data-post-open="" title="Post to code reviews" onClick={() => setPosting(true)}>
      {phone ? "Post…" : "Post to code reviews…"}
    </Btn>
  );
  return (
    <div className={phone ? "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2" : "grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4"} data-open-prs="">
      {/* the five filters scroll sideways on a phone instead of widening the column (2026-11-18) */}
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* one filter is always on: a click on the pressed one keeps it (Radix sends "" for that) */}
          <ScrollRow>
            <ToggleGroup type="single" variant="outline" size="sm" aria-label="Filter" value={filter} onValueChange={(f) => f && setFilter(f as Filter)}>
              {FILTERS.map((x) => (
                <ToggleGroupItem key={x.value} value={x.value} data-filter={x.value}>
                  {x.label} {v.prs.filter((p) => inFilter(p, x.value)).length}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </ScrollRow>
          {asked && !phone ? post : null}
        </div>
        {/* a phone: one line, the filter's meaning in its title (it wrapped to 3 lines) */}
        <p className={phone ? `${NOTE} truncate` : NOTE} title={phone ? f.means : undefined} data-prs-note="">
          {phone ? null : `${v.login}'s open PRs, checked `}
          {phone ? "Checked " : null}
          {v.fetchedAt === null ? "never" : <span title={when(v.fetchedAt)} data-checked-ago=""><Ago at={v.fetchedAt} /> ago</span>}
          {v.checking ? <span data-checking="">, checking GitHub now</span> : v.pollMinutes > 0 && !phone ? `, again after ${v.pollMinutes} min` : ""}.{phone ? null : ` ${f.means}`}
          {v.more ? " More open PRs than one read lists; the oldest are left out." : ""}
        </p>
        {v.error ? <p className={NOTE}>Last check failed, showing the one before: {v.error}</p> : null}
        {v.notes.map((n) => (
          <p key={n} className={NOTE}>
            {n}
          </p>
        ))}
      </div>
      {shown.length === 0 ? <Muted>{f.none}</Muted> : <PrList prs={shown} wide={wide} action={asked && phone ? post : undefined} />}
      {/* Post is a Dialog over the list (2026-11-18): opening it never moves the list */}
      {posting && asked ? <Post key={asked} prs={shown} view={v} name={name} section={asked} found={changes} since={baseline?.at ?? null} onClose={() => setPosting(false)} /> : null}
    </div>
  );
}
