import { useCallback, useRef, useState, type ReactNode } from "react";
import { experimental_useRpcQuery, useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import { ChevronRight, ExternalLink, Lock, Plus, Search } from "lucide-react";
import { CHANGED_CHANNEL, type Deliverables } from "../contract.ts";
import { DeliverableCard } from "../app/deliverables.tsx";
import { PR_CHIP_TONES, ROLE_TONES, SLACK_TONES, css, roleOf, tint } from "../app/palette.ts";
import { useElementWidth } from "../app/panes.tsx";
import { useMinute } from "../app/status-bar.tsx";
import { useGate, write } from "../app/store.ts";
import { Btn, EmptyState, PageError, ReadState, Who } from "../app/ui.tsx";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../app/ui/alert-dialog.tsx";
import { Avatar, AvatarFallback } from "../app/ui/avatar.tsx";
import { Badge } from "../app/ui/badge.tsx";
import { Button } from "../app/ui/button.tsx";
import { Card } from "../app/ui/card.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../app/ui/dialog.tsx";
import { Input } from "../app/ui/input.tsx";
import { Label } from "../app/ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../app/ui/select.tsx";
import { ToggleGroup, ToggleGroupItem } from "../app/ui/toggle-group.tsx";
import { MULTIPLAYER_CHANNEL, MULTIPLAYER_WRITES, multiplayerContract, type BoardView, type PrView, type RecordView } from "./contract.ts";
import { FILTERS, ago, byDay, clock, counts, filterCounts, healthAt, open, reviewed, settled, shown, span, took, type Filter } from "./core/views.ts";

const WHERE = "multiplayer";
const NO_WATCHER = "-";
type Tone = { light: string; dark: string };
type View = { t: "now" } | { t: "review"; record: string; pr: string | null };

const VERDICT_TONE: Record<string, Tone> = { APPROVED: PR_CHIP_TONES.ok, CHANGES_REQUESTED: PR_CHIP_TONES.warn, COMMENTED: PR_CHIP_TONES.neutral };
const STATE_WORDS: Record<RecordView["state"], string> = { reviewing: "reviewing", replying: "replying in Slack", waits: "waits on you", done: "done" };

function Chip({ tone, children, ...p }: { tone: Tone; children: ReactNode; [data: `data-${string}`]: string | undefined }) {
  return (
    <Badge variant="secondary" className="max-w-full shrink-0" style={{ color: css(tone), background: tint(tone) }} {...p}>
      {children}
    </Badge>
  );
}

function Face({ address }: { address: string | null }) {
  const role = roleOf(address);
  const tone = role ? ROLE_TONES[role] : PR_CHIP_TONES.muted;
  return (
    <Avatar size="24" aria-hidden>
      <AvatarFallback className="text-xs font-medium" style={{ background: tint(tone), color: css(tone) }}>
        {(role ? tone.label : "?").slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

const Dot = ({ tone }: { tone: Tone }) => <span aria-hidden className="inline-block size-2 shrink-0 rounded-full" style={{ background: css(tone) }} />;

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="outline" size="sm">
      <a href={href} target="_blank" rel="noreferrer">
        {children}
        <ExternalLink className="size-3" />
      </a>
    </Button>
  );
}

const PrLink = ({ p }: { p: { url: string; name: string } }) => (
  <a href={p.url} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2" onClick={(e) => e.stopPropagation()}>
    {p.name}
  </a>
);

function stateChip(r: RecordView): ReactNode {
  if (r.waitsOnYou) return <Chip tone={PR_CHIP_TONES.fail} data-state="waits">waits on you</Chip>;
  if (settled(r)) return null;
  return <Chip tone={SLACK_TONES.link} data-state={r.state}>{STATE_WORDS[r.state]}</Chip>;
}

const asker = (r: RecordView) => r.asker?.name ?? r.asker?.id ?? "Someone";

/** Reviews' Team boards section (Home first step 3, 2026-11-20): a card per board, which opens it on the Multiplayer page. */
export function TeamBoards({ onOpen }: { onOpen: (board: string) => void }) {
  const q = experimental_useRpcQuery({ contract: multiplayerContract, method: "multiplayer", input: null });
  const refetch = useRef(q.refetch);
  refetch.current = q.refetch;
  const again = useCallback(() => void refetch.current(), []);
  useRealtime(MULTIPLAYER_CHANNEL, again);
  const minute = useMinute();
  if (!q.data) return <ReadState q={q} what="the boards" />;
  const now = Math.max(q.data.now, minute);
  const records = q.data.records;
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-team-boards="">
      {q.data.boards.map((b) => {
        const c = counts(records.filter((r) => r.board === b.id), now);
        return (
          <Button key={b.id} type="button" variant="outline" className="h-auto w-full justify-between gap-3 px-4 py-3 text-left font-normal whitespace-normal" data-team-board={b.id} onClick={() => onOpen(b.id)}>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium">#{b.name || b.channel}</span>
              <span className="text-xs text-muted-foreground">
                {c.reviewing} reviewing{c.waits ? ` · ${c.waits} waits on you` : ""}
              </span>
            </span>
            <ChevronRight className="text-muted-foreground" />
          </Button>
        );
      })}
    </div>
  );
}

/** `initial`: the board a link (multiplayer/<id>) opens on. */
export function MultiplayerTab({ deliverables, refetchAll, openCard, initial = null }: { deliverables: Deliverables | undefined; refetchAll: () => void; openCard: (id: string) => void; initial?: string | null }) {
  useGate();
  const q = experimental_useRpcQuery({ contract: multiplayerContract, method: "multiplayer", input: null });
  const refetch = useRef(q.refetch);
  refetch.current = q.refetch;
  const again = useCallback(() => void refetch.current(), []);
  useRealtime(MULTIPLAYER_CHANNEL, again);
  useRealtime(CHANGED_CHANNEL, again);
  const [width, measure] = useElementWidth();
  const [picked, setPicked] = useState<string | null>(initial);
  const [view, setView] = useState<View>({ t: "now" });
  const [adding, setAdding] = useState(false);
  const minute = useMinute();
  const now = Math.max(q.data?.now ?? 0, minute);
  const v = q.data && { ...q.data, now, boards: q.data.boards.map((b) => healthAt(b, now)) };
  const wide = width >= 760;
  const board = v ? (v.boards.find((b) => b.id === picked) ?? v.boards[0] ?? null) : null;
  const pick = (id: string) => {
    setPicked(id);
    setView({ t: "now" });
  };
  const add = <AddBoard open={adding} onClose={() => setAdding(false)} sources={v?.sources ?? []} after={again} />;
  if (!v)
    return (
      <div ref={measure} className="mx-auto w-full max-w-5xl px-4 pt-4">
        <ReadState q={q} what="the boards" />
      </div>
    );
  if (!board)
    return (
      <div ref={measure} className="mx-auto w-full max-w-3xl px-4 pt-4" data-multiplayer="">
        <EmptyState title="No boards yet" text="A board is a Slack channel your agents work in. Paste its link, and pick the watcher of yours that reads it." action={<Btn icon={<Plus />} onClick={() => setAdding(true)} data-add-board="">Add board</Btn>} />
        <PageError where={WHERE} />
        {add}
      </div>
    );
  const records = v.records.filter((r) => r.board === board.id);
  return (
    <div ref={measure} className="mx-auto w-full max-w-6xl px-4 pt-4 pb-8" data-multiplayer="" data-wide={wide ? "" : undefined}>
      <div className={wide ? "grid grid-cols-[280px_minmax(0,1fr)] items-start gap-6" : "flex flex-col gap-4"}>
        {wide ? (
          <Boards boards={v.boards} records={v.records} now={v.now} on={board.id} pick={pick} add={() => setAdding(true)} />
        ) : (
          <div className="flex items-center gap-2">
            <Select value={board.id} onValueChange={pick}>
              <SelectTrigger size="sm" className="min-w-0 flex-1" data-board-select="">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {v.boards.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    #{b.name || b.channel}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Btn size="sm" icon={<Plus />} onClick={() => setAdding(true)} data-add-board="">
              Add board
            </Btn>
          </div>
        )}
        <main className="flex min-w-0 flex-col gap-4">
          <PageError where={WHERE} />
          <Header b={board} slack={v.slack} after={again} />
          {view.t === "now" ? (
            <>
              <Now b={board} records={records} now={v.now} wide={wide} show={(r) => setView({ t: "review", record: r.id, pr: r.prs[0]?.url ?? null })} openCard={openCard} />
              <section aria-label="Timeline" data-board-timeline="" className="flex min-w-0 flex-col gap-2">
                <h3 className="m-0 text-sm font-semibold">Timeline</h3>
                <Timeline records={records} now={v.now} show={(r, p) => setView({ t: "review", record: r.id, pr: p })} />
              </section>
            </>
          ) : (
            <Review r={records.find((r) => r.id === view.record) ?? null} pr={view.pr} now={v.now} back={() => setView({ t: "now" })} pickPr={(p) => setView({ ...view, pr: p })} deliverables={deliverables} refetchAll={refetchAll} openCard={openCard} />
          )}
        </main>
      </div>
      {add}
    </div>
  );
}

function Boards({ boards, records, now, on, pick, add }: { boards: BoardView[]; records: RecordView[]; now: number; on: string; pick: (id: string) => void; add: () => void }) {
  return (
    <nav aria-label="Boards" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 flex items-center gap-2 text-sm font-semibold">
          Boards <Badge variant="secondary">{boards.length}</Badge>
        </h2>
        <Btn size="sm" icon={<Plus />} onClick={add} data-add-board="">
          Add board
        </Btn>
      </div>
      {boards.map((b) => {
        const c = counts(
          records.filter((r) => r.board === b.id),
          now,
        );
        return (
          <Btn key={b.id} tone={b.id === on ? "outline" : "ghost"} className={`h-auto w-full flex-col items-start gap-1 px-3 py-2.5 text-left font-normal whitespace-normal ${b.id === on ? "bg-accent" : "border border-border"}`} onClick={() => pick(b.id)} data-board={b.id} aria-current={b.id === on ? "true" : undefined}>
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              {b.private ? <Lock className="size-3.5 text-muted-foreground" /> : null}#{b.name || b.channel}
            </span>
            {b.purpose ? <span className="text-xs text-muted-foreground">{b.purpose}</span> : null}
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Dot tone={b.watch?.health.state === "healthy" ? PR_CHIP_TONES.ok : b.watch?.health.state === "late" ? PR_CHIP_TONES.warn : PR_CHIP_TONES.muted} />
              {b.watch ? `watched by ${b.watch.agents.map((a) => a.address).join(", ") || b.watch.source}${b.watch.health.lastAt ? ` · read ${ago(b.watch.health.lastAt, now)}` : ""}` : "no watcher of yours yet"}
            </span>
            {c.reviewing || c.waits || c.prsToday ? (
              <span className="flex flex-wrap items-center gap-1.5">
                {c.reviewing ? <Chip tone={SLACK_TONES.link}>{c.reviewing} reviewing</Chip> : null}
                {c.waits ? <Chip tone={PR_CHIP_TONES.fail}>{c.waits} waits on you</Chip> : null}
                {c.prsToday ? <span className="text-xs text-muted-foreground">{c.prsToday} PRs today</span> : null}
              </span>
            ) : null}
          </Btn>
        );
      })}
    </nav>
  );
}

function Header({ b, slack, after }: { b: BoardView; slack: boolean; after: () => void }) {
  const [removing, setRemoving] = useState(false);
  return (
    <div className="flex flex-wrap items-start justify-between gap-3" data-board-header={b.id}>
      <div className="min-w-0">
        <h2 className="m-0 flex flex-wrap items-center gap-2 text-lg font-semibold">
          {b.private ? <Lock className="size-4 text-muted-foreground" /> : null}#{b.name || b.channel}
          {b.private ? <Badge variant="outline">private</Badge> : null}
        </h2>
        {b.purpose ? <p className="m-0 mt-1 text-sm text-muted-foreground">{b.purpose}</p> : null}
        {b.from === "typed" ? (
          <p className="m-0 mt-1 text-xs text-muted-foreground" data-typed="">
            {slack ? (b.note ?? "Reading Slack…") : "No Slack token: the name and purpose are what you typed."}
          </p>
        ) : b.note ? (
          <p className="m-0 mt-1 text-xs text-muted-foreground">{b.note}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {b.setup ? <Ext href={b.setup}>Setup message</Ext> : null}
        <Ext href={b.open}>Open in Slack</Ext>
        <Btn size="sm" tone="ghost" onClick={() => setRemoving(true)} data-remove-board="">
          Remove
        </Btn>
      </div>
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove #{b.name || b.channel}?</AlertDialogTitle>
            <AlertDialogDescription>Its reviews stay recorded. Adding the channel again brings them back.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void write(MULTIPLAYER_WRITES.remove, { id: b.id }, { kind: "other", where: WHERE, after })}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AddBoard({ open: shown, onClose, sources, after }: { open: boolean; onClose: () => void; sources: string[]; after: () => void }) {
  const [f, setF] = useState({ channel: "", watcher: NO_WATCHER, name: "", purpose: "", setup: "" });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    const body = { channel: f.channel, watcher: f.watcher === NO_WATCHER ? null : f.watcher, ...(f.name.trim() ? { name: f.name } : {}), ...(f.purpose.trim() ? { purpose: f.purpose } : {}), ...(f.setup.trim() ? { setup: f.setup } : {}) };
    const out = await write(MULTIPLAYER_WRITES.add, body, { kind: "other", where: "multiplayer-add", after });
    if (!out) return;
    if (!out.ok) return setError(out.message);
    setF({ channel: "", watcher: NO_WATCHER, name: "", purpose: "", setup: "" });
    setError(null);
    onClose();
  };
  return (
    <Dialog open={shown} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="sm:max-w-lg" data-add-dialog="">
        <DialogHeader>
          <DialogTitle>Add a board</DialogTitle>
          <DialogDescription>A Slack channel your agents work in. Nothing is posted to it from here.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="mp-channel">Channel link or id</Label>
            <Input id="mp-channel" required placeholder="https://…slack.com/archives/C…" value={f.channel} onChange={set("channel")} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mp-watcher">Watcher</Label>
            <Select value={f.watcher} onValueChange={(w) => setF({ ...f, watcher: w })}>
              <SelectTrigger id="mp-watcher" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_WATCHER}>None of mine yet</SelectItem>
                {sources.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="m-0 text-xs text-muted-foreground">Without a Slack token, or one without the scopes, the tab shows these instead:</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="mp-name">Name</Label>
              <Input id="mp-name" placeholder="reviews" value={f.name} onChange={set("name")} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="mp-purpose">Purpose</Label>
              <Input id="mp-purpose" placeholder="Code review requests" value={f.purpose} onChange={set("purpose")} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mp-setup">Setup message link</Label>
            <Input id="mp-setup" placeholder="https://…slack.com/archives/C…/p…" value={f.setup} onChange={set("setup")} />
          </div>
          {error ? <p className="m-0 text-sm text-(--orch-danger)">{error}</p> : null}
          <DialogFooter>
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn tone="primary" type="submit" disabled={!f.channel.trim()} data-add-submit="">
              Add board
            </Btn>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, n, children, ...p }: { title: string; n?: number; children: ReactNode; [data: `data-${string}`]: string | undefined }) {
  return (
    <Card className="gap-0 py-0" {...p}>
      <h3 className="m-0 flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
        {title}
        {n !== undefined ? <Badge variant="secondary">{n}</Badge> : null}
      </h3>
      <ul className="m-0 list-none divide-y p-0">{children}</ul>
    </Card>
  );
}

const Row = ({ face, main, meta, end, ...p }: { face: ReactNode; main: ReactNode; meta?: ReactNode; end?: ReactNode; [data: `data-${string}`]: string | undefined }) => (
  <li className="flex flex-wrap items-start gap-3 px-4 py-3" {...p}>
    <span className="pt-0.5">{face}</span>
    <div className="flex min-w-48 flex-1 flex-col gap-1">
      <div className="text-sm [overflow-wrap:anywhere]">{main}</div>
      {meta ? <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">{meta}</div> : null}
    </div>
    {end ? <div className="ml-auto flex flex-wrap items-center gap-2">{end}</div> : null}
  </li>
);

function Stat({ value, label, dot }: { value: ReactNode; label: string; dot?: Tone }) {
  return (
    <Card className="gap-1 px-4 py-3">
      <b className="flex items-center gap-2 text-xl font-semibold tabular-nums">
        {dot ? <Dot tone={dot} /> : null}
        {value}
      </b>
      <span className="text-xs text-muted-foreground">{label}</span>
    </Card>
  );
}

function Now({ b, records, now, wide, show, openCard }: { b: BoardView; records: RecordView[]; now: number; wide: boolean; show: (r: RecordView) => void; openCard: (id: string) => void }) {
  const c = counts(records, now);
  const working = records.filter(open);
  const h = b.watch?.health;
  return (
    <div className="flex flex-col gap-4" data-now="">
      <div className={`grid gap-3 ${wide ? "grid-cols-4" : "grid-cols-2"}`}>
        <Stat value={c.reviewing} label="reviewing now" />
        <Stat value={c.waits} label="waits on you" />
        <Stat value={c.prsToday} label="PRs reviewed today" />
        <Stat value={h?.lastAt ? span(now - h.lastAt) : "—"} label={b.watch ? "since the watcher read" : "no watcher of yours"} dot={h?.state === "healthy" ? PR_CHIP_TONES.ok : h?.state === "late" ? PR_CHIP_TONES.warn : undefined} />
      </div>
      <Section title="Working now" n={working.length} data-working="">
        {working.length ? (
          working.map((r) => (
            <Row
              key={r.id}
              data-record={r.id}
              face={<Face address={r.thread?.address ?? r.lead} />}
              main={
                <>
                  Review ·{" "}
                  {r.prs.map((p, i) => (
                    <span key={p.url}>
                      {i ? ", " : ""}
                      <PrLink p={p} />
                    </span>
                  ))}
                </>
              }
              meta={
                <>
                  <span>
                    {asker(r)} asked {ago(r.askedAt ?? r.createdAt, now)}
                  </span>
                  {r.thread ? (
                    <span data-thread-status={r.thread.status ?? ""}>
                      {r.thread.address ?? r.thread.ref}
                      {r.thread.status && r.thread.status !== "unknown" ? ` is ${r.thread.status}` : ""}
                    </span>
                  ) : null}
                  {[...new Set(r.prs.map((p) => p.class).filter(Boolean))].map((k) => (
                    <Badge key={k} variant="outline">
                      {k}
                    </Badge>
                  ))}
                  {r.deliverable?.flag ? <span>{r.deliverable.flag}</span> : r.note ? <span>{r.note}</span> : null}
                </>
              }
              end={
                <>
                  {r.state === "reviewing" && r.prs.length > 1 ? (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {reviewed(r)} of {r.prs.length}
                    </span>
                  ) : null}
                  {stateChip(r)}
                  {r.deliverable?.card ? (
                    <Btn size="sm" onClick={() => openCard(r.deliverable!.card!)} data-open-card="">
                      Open card
                    </Btn>
                  ) : null}
                  <Btn size="sm" tone="ghost" icon={<ChevronRight />} aria-label="Open the review" onClick={() => show(r)} />
                </>
              }
            />
          ))
        ) : (
          <li className="px-4 py-3 text-sm text-muted-foreground">Nothing running on this board.</li>
        )}
      </Section>
      <Section title="Watching this channel" n={b.watch?.agents.length ?? 0} data-watching="">
        {b.watch ? (
          (b.watch.agents.length ? b.watch.agents : [{ address: b.watch.source, threadId: null, status: null }]).map((a) => (
            <Row
              key={a.address}
              face={<Face address={a.address} />}
              main={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{a.address}</span>
                  <Badge variant="outline">watcher</Badge>
                </span>
              }
              meta={
                h?.lastAt ? (
                  <>
                    {h.everyMs ? <span>Reads new requests every {span(h.everyMs)}</span> : null}
                    <span>last {ago(h.lastAt, now)}</span>
                    {h.nextAt ? <span>{h.nextAt > now ? `next in ${span(h.nextAt - now)}` : `next was due ${ago(h.nextAt, now)}`}</span> : null}
                    {b.watch!.lastWake ? <span>last wake {ago(b.watch!.lastWake, now)}</span> : null}
                  </>
                ) : (
                  <span>
                    No read recorded yet. Its timer calls <code>bb orchestrator integration heartbeat {b.watch!.source}</code> on each tick.
                  </span>
                )
              }
              end={
                h?.state === "healthy" || h?.state === "late" ? (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-health={h.state}>
                    <Dot tone={h.state === "healthy" ? PR_CHIP_TONES.ok : PR_CHIP_TONES.warn} />
                    {h.state}
                  </span>
                ) : null
              }
            />
          ))
        ) : (
          <li className="px-4 py-3 text-sm text-muted-foreground">No watcher of yours reads this channel, so it has no reviews here.</li>
        )}
      </Section>
      {b.tracked.length ? (
        <Section title="Tracked PRs" n={b.tracked.length} data-tracked="">
          {b.tracked.map((t) => (
            <Row
              key={t.id}
              face={<Face address={t.owner} />}
              main={
                <>
                  {t.owner} waits until <PrLink p={{ url: t.url, name: t.url.replace(/^.*\/([^/]+)\/pull\/(\d+)$/, "$1#$2") }} /> is <b>{t.when}</b>
                </>
              }
              meta={[t.state, t.review, t.checks ? `checks ${t.checks}` : null, t.readAt ? `read ${ago(t.readAt, now)}` : null].filter(Boolean).join(" · ")}
            />
          ))}
        </Section>
      ) : null}
    </div>
  );
}

function verdictChip(p: PrView): ReactNode {
  const s = p.review?.state;
  if (!p.review) return null;
  if (!s) return <span className="text-xs text-muted-foreground">reading…</span>;
  return <Chip tone={VERDICT_TONE[s] ?? PR_CHIP_TONES.muted}>{p.review.verdict}</Chip>;
}
const findingWords = (p: PrView) => (p.review?.findings ? (p.review.findings.length ? `${p.review.findings.length} finding${p.review.findings.length === 1 ? "" : "s"}` : "no findings") : null);

function Timeline({ records, now, show }: { records: RecordView[]; now: number; show: (r: RecordView, pr: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const n = filterCounts(records);
  const days = byDay(shown(records, filter, q), now);
  return (
    <div className="flex flex-col gap-4" data-timeline="">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup type="single" variant="outline" size="sm" aria-label="Filter" className="max-w-full overflow-x-auto" value={filter} onValueChange={(f) => f && setFilter(f as Filter)}>
          {FILTERS.map((x) => (
            <ToggleGroupItem key={x.value} value={x.value} data-filter={x.value}>
              {x.label} {n[x.value]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="relative ml-auto min-w-48 flex-1 sm:max-w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search" placeholder="PR, repo or words" className="h-8 pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {days.length === 0 ? <p className="m-0 text-sm text-muted-foreground">{records.length ? "Nothing matches." : "No reviews recorded on this board yet."}</p> : null}
      {days.map((d) => (
        <section key={d.label} className="flex flex-col gap-3" data-day={d.label}>
          <h3 className="m-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{d.label}</h3>
          {d.records.map((r) => {
            const t = took(r);
            return (
              <div key={r.id} className="flex flex-col gap-2" data-record={r.id}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span className="text-xs text-muted-foreground tabular-nums">{clock(r.askedAt ?? r.createdAt)}</span>
                  <b className="font-semibold">{asker(r)}</b>
                  <span className="text-muted-foreground">
                    asked for {r.prs.length} PR{r.prs.length === 1 ? "" : "s"}
                  </span>
                  {r.thread ? <Who address={r.thread.address ?? r.thread.ref} nowrap /> : null}
                  {settled(r) && !r.waitsOnYou ? (t !== null ? <span className="text-xs text-muted-foreground">took {span(t)}</span> : null) : stateChip(r)}
                </div>
                {r.prs.length ? (
                  <Card className="gap-0 py-0">
                    <ul className="m-0 list-none divide-y p-0">
                      {r.prs.map((p) => (
                        <li key={p.url}>
                          <Btn tone="ghost" className="h-auto w-full flex-wrap justify-start gap-x-3 gap-y-1 rounded-none px-4 py-2.5 text-left font-normal whitespace-normal" onClick={() => show(r, p.url)} data-pr={p.url}>
                            <span className="flex min-w-48 flex-1 items-baseline gap-2">
                              <span className="font-medium underline underline-offset-2">{p.name}</span>
                              <span className="min-w-0 [overflow-wrap:anywhere]">{p.title ?? ""}</span>
                            </span>
                            <span className="ml-auto flex flex-wrap items-center gap-2">
                              {p.class ? <Badge variant="outline">{p.class}</Badge> : null}
                              {verdictChip(p)}
                              {findingWords(p) ? <span className="text-xs text-muted-foreground">{findingWords(p)}</span> : null}
                              <ChevronRight className="size-4 text-muted-foreground" />
                            </span>
                          </Btn>
                        </li>
                      ))}
                    </ul>
                  </Card>
                ) : null}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function Review(props: { r: RecordView | null; pr: string | null; now: number; back: () => void; pickPr: (p: string) => void; deliverables: Deliverables | undefined; refetchAll: () => void; openCard: (id: string) => void }) {
  const { r, back } = props;
  const navigate = useBbNavigate();
  if (!r)
    return (
      <EmptyState title="This review isn't on the board any more" action={<Btn onClick={back}>Back to the timeline</Btn>} />
    );
  const p = r.prs.find((x) => x.url === props.pr) ?? r.prs[0] ?? null;
  const t = took(r);
  const d = r.deliverable ? props.deliverables?.find((x) => x.id === r.deliverable!.id) : undefined;
  const steps: [string, number | undefined, string?][] = [
    ["Asked", r.askedAt ?? r.times.asked, r.asker ? asker(r) : undefined],
    ["Thread started", r.times.thread],
    ["GitHub review", r.times.review],
    ["Slack reply", r.times.reply],
    ["Deliverable", r.times.deliverable, r.deliverable ? (r.deliverable.state === "review" ? "in your review" : r.deliverable.state) : undefined],
  ];
  return (
    <div className="flex flex-col gap-4" data-review={r.id}>
      <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground" aria-label="Breadcrumb">
        <Btn size="sm" tone="ghost" className="px-1" onClick={back}>
          Timeline
        </Btn>
        <ChevronRight className="size-3.5" />
        <span>
          {clock(r.askedAt ?? r.createdAt)}, {asker(r)}'s request
        </span>
        {p ? (
          <>
            <ChevronRight className="size-3.5" />
            <span className="font-medium text-foreground">{p.name}</span>
          </>
        ) : null}
      </nav>
      <Card className="gap-4 px-5 py-5">
        {p ? (
          <div className="flex flex-col gap-2">
            <h2 className="m-0 flex flex-wrap items-center gap-2 text-base font-semibold">
              <PrLink p={p} />
              {p.title ? <span>{p.title}</span> : null}
              {verdictChip(p)}
            </h2>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {p.class ? <Badge variant="outline">{p.class}</Badge> : null}
              {p.review?.commit ? <span className="orch-mono">head {p.review.commit.slice(0, 7)}</span> : null}
              {r.thread ? <Who address={r.thread.address ?? r.thread.ref} nowrap /> : null}
              {t !== null ? <span>took {span(t)}</span> : stateChip(r)}
            </div>
          </div>
        ) : null}
        {r.prs.length > 1 ? (
          <ToggleGroup type="single" variant="outline" size="sm" className="w-fit max-w-full overflow-x-auto" value={p?.url ?? ""} onValueChange={(u) => u && props.pickPr(u)}>
            {r.prs.map((x) => (
              <ToggleGroupItem key={x.url} value={x.url}>
                {x.name}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {p ? <Ext href={p.url}>Pull request</Ext> : null}
          {p?.review ? <Ext href={p.review.url}>GitHub review</Ext> : null}
          {r.permalink ? <Ext href={r.permalink}>Request</Ext> : null}
          {r.reply ? <Ext href={r.reply}>Slack reply</Ext> : null}
          {r.thread?.threadId ? (
            <Btn size="sm" onClick={() => navigate.toThread(r.thread!.threadId!)} data-open-thread="">
              Open thread
            </Btn>
          ) : null}
        </div>
        <ol className="m-0 grid list-none gap-3 p-0 sm:grid-cols-5" data-steps="">
          {steps.map(([label, at, sub]) => (
            <li key={label} className="flex flex-col gap-0.5" data-step={label} data-done={at ? "" : undefined}>
              <span className={`text-sm ${at ? "font-medium" : "text-muted-foreground"}`}>{label}</span>
              <span className="text-xs text-muted-foreground">{[at ? clock(at) : "—", sub].filter(Boolean).join(" · ")}</span>
            </li>
          ))}
        </ol>
        {r.deliverable?.flag ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Chip tone={PR_CHIP_TONES.fail}>flagged</Chip>
            <span>{r.deliverable.flag}</span>
            {r.deliverable.card ? (
              <Btn size="sm" onClick={() => props.openCard(r.deliverable!.card!)}>
                Open card
              </Btn>
            ) : null}
          </div>
        ) : null}
        {p ? <Findings p={p} /> : null}
      </Card>
      {d ? (
        <section className="flex flex-col gap-2" data-board-deliverable={d.id}>
          <h3 className="m-0 text-sm font-semibold">Deliverable</h3>
          <DeliverableCard d={d} refetchAll={props.refetchAll} outputs={[]} outputsAfter={() => {}} />
        </section>
      ) : null}
    </div>
  );
}

function Findings({ p }: { p: PrView }) {
  const f = p.review?.findings;
  return (
    <section className="flex flex-col gap-2" data-findings="">
      <h3 className="m-0 flex items-center gap-2 text-sm font-semibold">
        Findings {f ? <Badge variant="secondary">{f.length}</Badge> : null}
      </h3>
      {!p.review ? (
        <p className="m-0 text-sm text-muted-foreground">No GitHub review yet.</p>
      ) : !f ? (
        <p className="m-0 text-sm text-muted-foreground">Reading the review from GitHub…</p>
      ) : !f.length ? (
        <p className="m-0 text-sm text-muted-foreground">No inline comments on this review.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {f.map((x) => (
            <li key={x.url} className="flex flex-wrap items-start gap-3 rounded-md border px-3 py-2.5" data-finding="">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm [overflow-wrap:anywhere]">{x.first || "(no words)"}</span>
                <span className="orch-mono text-muted-foreground [overflow-wrap:anywhere]">
                  {x.path}
                  {x.line !== null ? `:${x.line}` : ""}
                </span>
              </div>
              <Ext href={x.url}>On GitHub</Ext>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
