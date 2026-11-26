// Home, the page's first view (the Feed, D1-D6): posts by latest agent activity, replies nested, from one paged read (core/feed.ts).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import { ArrowLeft, ArrowUp, ArrowUpRight, CheckCheck, ImageIcon, MessageCircle, X } from "lucide-react";
import { WRITES, WRITE_BASE, rpcContract, type Board, type Card, type Deliverables, type Feed, type FeedMsg, type FeedPost, type NeedsYou, type answerBody, type approveBody, type cosMessageBody, type directMessageBody, type directSeenBody, type feedResendBody, type feedSeenBody } from "../contract.ts";
import { AgentFace, type Face } from "./face.tsx";
import { CardView, ZONE, useArming, via, type Act } from "./needs-you.tsx";
import { DeliverableCard, inReview, proofSrc } from "./deliverables.tsx";
import { gate, stage, useGate, write } from "./store.ts";
import { admit, canSend, imageFiles } from "./lead-images.ts";
import { AttachButton, ImageThumbs, attached, base64, useDrop, type Attached } from "./image-attach.tsx";
import { CompactBar, ReplyField, ReplyHint } from "./reply-composer.tsx";
import { useIdentity } from "./identity.ts";
import { Button } from "./ui/button.tsx";
import { Kbd } from "./ui/kbd.tsx";
import { Btn, EmptyState, ReadState, ago, cx } from "./ui.tsx";
import { useTouchPhone } from "./phone.ts";
import { styleHref } from "./style-href.ts";
import { answerCss } from "./answer-ui.tsx";
import { VoiceMic } from "../voice/app/voice-mic.tsx";
import { StartHere } from "./start-here.tsx";
import { ImagePopout } from "./image-popout.tsx";
import { openInBb } from "./open-proof.ts";
import { useFreshRead } from "./fresh-read.ts";

export type FeedFilter = "all" | "needs" | "delivered" | "alerts";
const FILTERS: { id: FeedFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs you" },
  { id: "delivered", label: "Delivered" },
  { id: "alerts", label: "Alerts" },
];
/** Below this a pane is a phone: an opened post takes the whole view. */
const PHONE = 720;

/** Who a post or reply is from, as the feed names it: the role first, then its project or place. */
export function nameOf(address: string, cosTitle: string): { name: string; sub: string | null } {
  if (address === "person") return { name: "You", sub: null };
  if (address === "cos") return { name: cosTitle || "Chief of Staff", sub: null };
  if (address === "steward") return { name: "Steward", sub: "the runner" };
  if (address.startsWith("lead:")) return { name: "Lead", sub: address.slice(5) };
  return { name: address, sub: null };
}

/** The line a reply goes on, as its box names it (D6: every box names its recipient). */
export function recipientLine(line: string, cosTitle: string): string {
  return line === "cos" ? `${cosTitle || "Chief of Staff"} · tracked · answered in the feed` : `Lead · ${line.slice(5)} · direct message · the CoS gets a copy · not an approval`;
}

const CHIP: Record<FeedPost["kind"], string> = { card: "Needs you", prompt: "Waits on you", deliverable: "Delivered", status: "Status", merge: "PR merged", alarm: "Host alarm", dead: "Dead letter", message: "" };
function chipOf(p: FeedPost): string {
  if (p.kind === "card") return p.scope ? "Scope" : p.needsOwner ? "Needs you" : "Answered";
  if (p.kind === "deliverable") return p.deliverable?.state === "review" ? (p.scope ? "Scope · in review" : "Delivered · in review") : p.deliverable?.state === "approved" ? "Approved" : "Changes requested";
  return CHIP[p.kind];
}

/** Post the owner's seen line or a project's seen cursor without the page gate: it is a mark, never an answer. */
function mark(path: string, body: unknown) {
  try {
    void fetch(WRITE_BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true });
  } catch {
    // a page going away: the next visit moves the line
  }
}

const css = /* css */ `
[data-orch] [data-feed] .k-post { position: relative; display: grid; grid-template-columns: 40px minmax(0, 1fr); column-gap: 12px; padding: 14px 16px 10px 20px; border-bottom: 1px solid var(--border); }
[data-orch] [data-feed] .k-post[data-opened] { background: var(--accent); }
[data-orch] [data-feed] .k-post__dot { position: absolute; left: 8px; top: 26px; width: 6px; height: 6px; border-radius: 9999px; background: var(--primary); }
[data-orch] [data-feed] .k-post[data-read] { opacity: 0.88; }
/* a phone: the face on the pane's 16 px gutter, the new dot in it; a 24 px face, one meta line, the title and its text
   clamped, the shot a small square beside the title, and the post opens on a tap */
[data-orch][data-phone] [data-feed] .k-post { grid-template-columns: 24px minmax(0, 1fr); column-gap: 10px; padding: 8px 16px; }
[data-orch][data-phone] [data-feed] .k-post__dot { left: 5px; top: 18px; }
[data-orch][data-phone] [data-feed] .k-thumb { width: 56px; height: 56px; margin-top: 4px; overflow: hidden; border: 1px solid var(--border); border-radius: calc(var(--radius, 8px)); }
[data-orch][data-phone] [data-feed] .k-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
/* Needs you and Delivered drawn in Home: 8 px under the header row and between cards, not 16 and 12 */
[data-orch][data-phone] [data-feed] [data-home-body] { padding-top: 8px; }
[data-orch][data-phone] [data-feed] [data-home-body] [data-list] { gap: 8px; }
[data-orch][data-phone] [data-feed] [data-earlier] { padding: 8px 16px 4px; }
[data-orch][data-phone] [data-feed] .k-newbar { display: flex; width: 100%; min-height: 44px; align-items: center; justify-content: center; gap: 6px; border-bottom: 1px solid var(--border); background: var(--accent); font-size: 13px; }
[data-orch] [data-feed] .k-thread { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }
[data-orch] [data-feed] .k-reply { display: grid; grid-template-columns: 28px minmax(0, 1fr); column-gap: 10px; }
[data-orch] [data-feed] .k-poll { display: flex; width: 100%; min-height: 44px; align-items: center; justify-content: space-between; gap: 8px; border: 1px solid var(--border); border-radius: calc(var(--radius, 8px)); padding: 8px 12px; text-align: left; background: var(--background); }
[data-orch] [data-feed] .k-poll[data-recommended] { border-color: var(--orch-danger); }
[data-orch] [data-feed] .k-poll:disabled { opacity: 0.6; }
[data-orch] [data-feed] .k-media { overflow: hidden; border: 1px solid var(--border); border-radius: calc(var(--radius, 8px) + 4px); margin-top: 10px; }
[data-orch] [data-feed] .k-media img { display: block; width: 100%; max-height: 220px; object-fit: cover; }
[data-orch] [data-feed] .k-pill { position: sticky; top: 8px; z-index: 5; display: flex; justify-content: center; pointer-events: none; height: 0; overflow: visible; }
[data-orch] [data-feed] .k-pill > button { pointer-events: auto; }
[data-orch] [data-feed] .k-overlay { position: absolute; inset: 0; z-index: 20; display: flex; flex-direction: column; background: var(--background); }
`;

type FeedQuery = { data: Feed | undefined; error: { message: string } | null; refetch: () => Promise<void> };

/** The posts the list draws: the order the owner last saw (nothing moves under a finger), each post's content live. */
function useHeldOrder(live: Feed | undefined, filter: FeedFilter) {
  const [held, setHeld] = useState<{ filter: FeedFilter; order: { key: string; activity: number }[] } | null>(null);
  // the owner's own write (a reply, a message): the next read is drawn as it is, so their own post shows at once
  const own = useRef<Feed | undefined>(undefined);
  const adopt = useCallback(() => {
    if (live) setHeld({ filter, order: live.posts.map((p) => ({ key: p.key, activity: p.activity })) });
  }, [live, filter]);
  useEffect(() => {
    if (live && (!held || held.filter !== filter || (own.current && own.current !== live))) {
      own.current = undefined;
      adopt();
    }
  }, [live, held, filter, adopt]);
  const mine = useCallback(() => {
    own.current = live;
  }, [live]);
  if (!live || !held || held.filter !== filter) return { posts: live?.posts ?? [], waiting: 0, adopt, mine };
  const byKey = new Map(live.posts.map((p) => [p.key, p]));
  const was = new Map(held.order.map((o) => [o.key, o.activity]));
  const posts = held.order.map((o) => byKey.get(o.key)).filter((p): p is FeedPost => !!p);
  const waiting = live.posts.filter((p) => !was.has(p.key) || p.activity > was.get(p.key)!).length;
  return { posts, waiting, adopt, mine };
}

export function FeedView({ q, filter, item, onItem, body, onItemOpen, width, agents, needs, deliverables, refetch, refetchAll, onOpenProject, onChat }: {
  q: FeedQuery;
  filter: FeedFilter;
  /** The opened post (its key), from the pane's route, so a reload and Back restore it */
  item: string | null;
  onItem: (key: string | null) => void;
  /** A folded tab's own list drawn in place of the feed's (Needs you, step 3) */
  body?: ReactNode;
  /** An item open full screen on a phone, so the page hides its bottom bar */
  onItemOpen: (open: boolean) => void;
  width: number;
  agents: Board["agents"] | undefined;
  needs: NeedsYou | undefined;
  deliverables: Deliverables | undefined;
  refetch: () => void;
  refetchAll: () => void;
  onOpenProject: (slug: string) => void;
  onChat: () => void;
}) {
  useGate();
  const { cosTitle } = useIdentity();
  const opened = item;
  const [replying, setReplying] = useState<string | null>(null);
  const phone = width > 0 && width < PHONE;
  // bb's touch phone, never a pane's width: what only a phone draws (the new bar) keeps a narrow desktop pane as it was
  const touch = useTouchPhone();
  const filtered = experimental_useRpcQuery({ contract: rpcContract, method: "feed", input: { cursor: null, filter }, enabled: filter !== "all" && !body });
  useFreshRead("feed", filtered, { on: filter !== "all" && !body });
  const live = filter === "all" ? q.data : filtered.data;
  // no reflow under a pressed pointer or while a write holds the page: draw what was drawn last
  const frozen = gate.pointerDown || gate.lock !== null;
  // only this filter's last drawing: a click on another filter is a pressed pointer too, and must not draw the old list as the new one
  const last = useRef<{ filter: FeedFilter; feed: Feed | undefined }>({ filter, feed: undefined });
  const view = frozen && last.current.filter === filter && last.current.feed ? last.current.feed : live;
  useLayoutEffect(() => {
    last.current = { filter, feed: view };
  });
  const { posts, waiting, adopt, mine } = useHeldOrder(view, filter);
  const faces = useMemo(() => new Map((agents ?? []).map((a) => [a.address, { mon: a.mon, dex: a.dex, persona: a.persona } satisfies Face] as const)), [agents]);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const arming = useArming(root);
  const after = useCallback(() => {
    mine();
    refetch();
    void filtered.refetch();
    refetchAll();
  }, [refetch, filtered, refetchAll, mine]);

  // D5: the seen line moves when the owner leaves the feed or the page goes to the background, to the newest activity drawn
  const newest = useRef(0);
  newest.current = Math.max(0, ...(q.data?.posts ?? []).map((p) => p.activity));
  const seen = q.data?.seen ?? 0;
  useEffect(() => {
    const leave = () => {
      if (newest.current > seen) mark(WRITES.feedSeen, { upTo: newest.current } satisfies z.input<typeof feedSeenBody>);
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") leave();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      leave();
    };
  }, [seen]);

  const markAll = () => {
    if (!q.data) return;
    void write(WRITES.feedSeen, { upTo: q.data.now } satisfies z.input<typeof feedSeenBody>, { kind: "other", where: "feed", after });
  };
  const openPost = useCallback((key: string) => onItem(key), [onItem]);
  const allPosts = q.data?.posts ?? [];
  const openedPost = opened ? (posts.find((p) => p.key === opened) ?? allPosts.find((p) => p.key === opened) ?? null) : null;
  const firstRead = posts.findIndex((p) => !p.isNew);

  const count = (f: FeedFilter) => (f === "all" ? q.data?.newCount : f === "needs" ? needs?.badge : f === "delivered" ? inReview(deliverables).length : q.data?.counts.alerts);
  const label = FILTERS.find((f) => f.id === filter)?.label ?? "All";
  const shown = filter === "all" ? (q.data && q.data.newCount > 0 ? `${q.data.newCount >= 50 ? "50+" : q.data.newCount} new` : null) : count(filter) || null;
  // the page header row: where you are and its count; the mic (only while voice mode is on) and Mark all read on the right
  // an empty Home is Start here alone: no filters or Mark all read (start-here mockups); the web keeps its title
  const alone = !body && filter === "all" && !!view && posts.length === 0;
  // the page header row: where you are and its count, then the mic and Mark all read. Home's filters live in the nav on
  // both: the Sidebar on the web, the bar and its More on a phone, so a phone has no filter row repeating them
  const header = alone ? (
    <div className="flex min-h-12 shrink-0 items-center gap-2 border-b px-4 py-2" data-home-header="">
      <h1 className="m-0 text-base font-semibold">Home</h1>
      <span className="ml-auto flex items-center gap-1">
        <VoiceMic />
      </span>
    </div>
  ) : (
    <div className="flex min-h-12 shrink-0 items-center gap-2 border-b px-4 py-2" data-home-header="">
      <h1 className="m-0 text-base font-semibold">{label}</h1>
      {shown ? (
        <span data-feed-new={filter === "all" ? String(q.data?.newCount ?? 0) : undefined} className="text-sm text-muted-foreground tabular-nums">
          {shown}
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-1">
        {filter === "needs" && !phone ? (
          <span className="mr-2 flex items-center gap-1 text-xs text-muted-foreground" data-key-hint="">
            <Kbd>J</Kbd>
            <Kbd>K</Kbd>
            <span className="mr-2">move</span>
            <Kbd>1</Kbd>
            <Kbd>2</Kbd>
            <span>answer</span>
          </span>
        ) : null}
        <VoiceMic />
        {phone ? (
          <Button type="button" variant="ghost" size="icon" className="size-11" aria-label="Mark all read" title="Mark all read" data-mark-all="" onClick={markAll} disabled={gate.lock !== null}>
            <CheckCheck />
          </Button>
        ) : (
          <Btn tone="ghost" size="sm" data-mark-all="" onClick={markAll} disabled={gate.lock !== null}>
            Mark all read
          </Btn>
        )}
      </span>
    </div>
  );
  const list = (
    <div ref={root} className="min-w-0">
      <style href={styleHref("orch-answer", answerCss)} precedence="default">
        {answerCss}
      </style>
      {waiting > 0 && !touch ? (
        <div className="k-pill">
          <Btn
            tone="primary"
            size="sm"
            className="rounded-full shadow"
            data-feed-pill={String(waiting)}
            onClick={() => {
              adopt();
              scroller.current?.scrollTo({ top: 0 });
            }}
            icon={<ArrowUp />}
          >
            {waiting} new
          </Btn>
        </div>
      ) : null}
      {!view ? (
        <div className="px-4">
          <ReadState q={filter === "all" ? q : filtered} what="the feed" />
        </div>
      ) : posts.length === 0 ? (
        filter === "all" ? (
          <StartHere agents={agents} phone={phone} onChat={onChat} refetchAll={refetchAll} />
        ) : (
          <EmptyState title="Nothing here yet" text="What your agents deliver, ask and answer shows up here." />
        )
      ) : (
        <div role="feed" aria-label="Feed">
          {posts.map((p, i) => (
            <div key={p.key}>
              {i === firstRead && firstRead > 0 ? <h3 className="m-0 border-b px-4 pt-4 pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase" data-earlier="">Earlier · read</h3> : null}
              <PostView
                p={p}
                now={view.now}
                faces={faces}
                cosTitle={cosTitle}
                opened={opened === p.key}
                armed={arming.isArmed(p.card?.id ?? p.deliverable?.id ?? p.key, p.card?.rev ?? p.deliverable?.rev ?? 0)}
                check={() => arming.check(p.card?.id ?? p.deliverable?.id ?? p.key, p.card?.rev ?? p.deliverable?.rev ?? 0)}
                after={after}
                onOpen={() => openPost(p.key)}
                onOpenProject={onOpenProject}
                replying={replying === p.key}
                setReplying={(on) => setReplying(on ? p.key : null)}
              />
            </div>
          ))}
          {view.cursor ? <MorePages cursor={view.cursor} filter={filter} now={view.now} faces={faces} cosTitle={cosTitle} after={after} onOpen={openPost} onOpenProject={onOpenProject} /> : null}
          <div className="flex items-center justify-between px-4 py-3 text-xs text-muted-foreground">
            <LeftOut since={view.leftOutSince} />
          </div>
        </div>
      )}
    </div>
  );

  const pane = openedPost && !body ? (
    <ItemPane
      key={openedPost.key}
      p={openedPost}
      now={view?.now ?? Date.now()}
      faces={faces}
      cosTitle={cosTitle}
      needs={needs}
      deliverables={deliverables}
      after={after}
      onClose={() => onItem(null)}
      onOpenProject={onOpenProject}
      phone={phone}
    />
  ) : null;

  const itemOpen = phone && !!pane;
  useEffect(() => onItemOpen(itemOpen), [itemOpen, onItemOpen]);
  useEffect(() => () => onItemOpen(false), [onItemOpen]);

  // the list alone in a reading column; with an item open on web, the list (456 px) and the item beside it
  return (
    <div data-feed="" className="relative flex min-h-0 flex-1 flex-col">
      <style href={styleHref("orch-feed", css)} precedence="default">
        {css}
      </style>
      {header}
      {/* a phone: the new posts' bar sits under the header row, in the flow, so it never covers a post */}
      {touch && waiting > 0 && !body && view ? (
        <Button
          type="button"
          variant="ghost"
          className="k-newbar h-11 rounded-none font-normal"
          data-feed-pill={String(waiting)}
          onClick={() => {
            adopt();
            scroller.current?.scrollTo({ top: 0 });
          }}
        >
          <ArrowUp className="size-4" aria-hidden />
          {waiting} new
        </Button>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {/* never sideways: wide content scrolls in its own box (diagrams, code); the page itself only up and down */}
        <div ref={scroller} className={cx("min-h-0 overflow-x-hidden overflow-y-auto", !phone && pane ? "w-[456px] shrink-0 border-r" : "min-w-0 flex-1")} data-feed-scroll="">
          <div className={!phone && !pane && !body ? "max-w-3xl" : undefined}>{body ? <div className="px-4 pt-4" data-home-body={filter}>{body}</div> : list}</div>
        </div>
        {!phone && pane ? (
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-feed-pane="">
            {pane}
          </div>
        ) : null}
      </div>
      {phone && pane ? <div className="k-overlay">{pane}</div> : null}
    </div>
  );
}

function LeftOut({ since }: { since: number }) {
  const navigate = useBbNavigate();
  const q = experimental_useRpcQuery({ contract: rpcContract, method: "feedLeftOut", input: { since } });
  useFreshRead("feedLeftOut", q, { key: String(since) });
  // a new window reads afresh: the last count stands until it answers
  const last = useRef<number | null>(null);
  if (q.data !== undefined) last.current = q.data;
  const n = last.current;
  if (n === null) return null;
  return (
    <span data-feed-left-out={String(n)}>
      Not shown: {n} inbox messages and acks ·{" "}
      <Button type="button" variant="link" className="h-auto p-0 font-normal whitespace-normal text-xs text-muted-foreground underline" onClick={() => navigate.toPluginPanel("/orchestrator", { subPath: "board" })}>
        Activity
      </Button>
    </span>
  );
}

function Head({ p, now, cosTitle }: { p: { author: string; at: number; to?: string | null; kind?: string }; now: number; cosTitle: string }) {
  const who = nameOf(p.author, cosTitle);
  const to = p.to ? nameOf(p.to, cosTitle) : null;
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm">
      <span className="font-semibold">{who.name}</span>
      {to ? <span className="text-muted-foreground">→ {to.name}{to.sub ? ` · ${to.sub}` : ""}</span> : who.sub ? <span className="text-muted-foreground">{p.kind === "dead" ? "escalated" : who.sub}</span> : null}
      <span className="text-muted-foreground">· {ago(p.at, now)}</span>
    </div>
  );
}

/** Head on a phone's one meta line: the name, then its project or recipient, then the age, cut rather than wrapped. */
function MetaWho({ p, now, cosTitle }: { p: { author: string; at: number; to?: string | null; kind?: string }; now: number; cosTitle: string }) {
  const who = nameOf(p.author, cosTitle);
  const to = p.to ? nameOf(p.to, cosTitle) : null;
  const sub = to ? `→ ${to.name}${to.sub ? ` · ${to.sub}` : ""}` : who.sub ? (p.kind === "dead" ? "escalated" : who.sub) : null;
  // the name and age never cut; the project cuts before them, and the step text after it (shrink 3) cuts first
  return (
    <>
      <span className="shrink-0 font-semibold" data-meta-who="">{who.name}</span>
      {sub ? <span className="min-w-[4ch] truncate text-muted-foreground">{sub}</span> : null}
      <span className="shrink-0 text-muted-foreground">· {ago(p.at, now)}</span>
    </>
  );
}

function PostView({ p, now, faces, cosTitle, opened, armed, check, after, onOpen, onOpenProject, replying, setReplying }: {
  p: FeedPost;
  now: number;
  faces: ReadonlyMap<string, Face>;
  cosTitle: string;
  opened: boolean;
  armed: boolean;
  check: () => boolean;
  after: () => void;
  onOpen: () => void;
  onOpenProject: (slug: string) => void;
  replying: boolean;
  setReplying: (on: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const busy = gate.lock !== null;
  const chip = chipOf(p);
  const phone = useTouchPhone();
  const navigate = useBbNavigate();
  // nothing on the actions row but Open: no reply line, no review, no note
  const onlyOpen = !p.line && p.deliverable?.state !== "review" && !p.held;
  // a phone keeps the actions row only for what can't live on the meta line: review buttons, or a note about the line
  const noLive = !!p.line && !p.lineLive && p.line.startsWith("lead:");
  const phoneRow = p.deliverable?.state === "review" || noLive || (p.held && !!p.line);
  const answer = (option: string) => {
    if (!p.card || busy || !check()) return;
    const body: z.input<typeof answerBody> = { id: p.card.id, rev: p.card.rev, option, text: null, via: via() };
    void write(WRITES.answer, body, { card: { id: p.card.id, rev: p.card.rev, hide: "both" }, kind: "answer", after });
  };
  const approve = () => {
    const d = p.deliverable;
    if (!d || busy || !check()) return;
    const body: z.input<typeof approveBody> = { id: d.id, rev: d.rev, note: null };
    void write(WRITES.approve, body, { card: { id: d.id, rev: d.rev, hide: "both" }, kind: "answer", after });
  };
  // D6: collapsed, a post shows its newest unseen answer, or the owner's own message still waiting for one
  const tail = p.thread.at(-1);
  const collapsedShown = tail && (tail.isNew || tail.who === "person") ? [tail] : [];
  const shown = expanded || replying ? p.thread : collapsedShown;
  const expand = () => {
    const next = !expanded;
    setExpanded(next);
    // expanding a lead's conversation clears that project's dot on the Projects tab, up to the newest answer drawn
    if (next && p.line?.startsWith("lead:")) {
      const answers = p.thread.filter((m) => m.who.startsWith("lead:")).map((m) => m.at);
      if (answers.length) mark(WRITES.directSeen, { slug: p.line.slice(5), upTo: Math.max(...answers) } satisfies z.input<typeof directSeenBody>);
    }
  };
  // on a phone the reply count sits on the meta line (a 44 px target that adds no height) and the post opens on a tap
  const reply = p.line ? (
    <Btn tone="ghost" size="sm" className={phone ? "relative z-10 -mt-2 -mb-4 -mr-2 size-11 shrink-0 gap-1 px-0 text-muted-foreground" : "px-2"} data-reply-count={String(p.replies)} aria-expanded={expanded} aria-label={phone ? "Replies" : undefined} onClick={expand} icon={<MessageCircle />}>
      {p.replies > 0 ? String(p.replies) : ""}
    </Btn>
  ) : null;
  const tone = p.needsOwner || p.kind === "alarm" || p.kind === "dead" ? "border-(--orch-danger)/30 bg-(--orch-danger)/10 text-(--orch-danger)" : "bg-muted text-muted-foreground";
  const title = p.title ? (
    <Button type="button" variant="link" className={phone ? cx("h-auto p-0 font-normal whitespace-normal mt-1 block w-full text-left text-sm leading-snug font-semibold text-foreground", p.text ? "line-clamp-1" : "line-clamp-2") : "h-auto p-0 font-normal whitespace-normal mt-1 block w-full text-left text-[15px] leading-snug font-semibold text-foreground"} onClick={onOpen} data-open-post={p.key} data-prefetch-deliverable={p.kind === "deliverable" ? p.deliverable?.id : undefined}>
      {p.title}
    </Button>
  ) : null;
  // a phone clamps harder, as a mail list does: with a text line, the title and the text one line each; alone, either
  // takes two (a message keeps three); the post opens on a tap
  const clamp = phone ? (p.kind === "message" ? "line-clamp-3" : p.title ? "line-clamp-1" : "line-clamp-2") : p.kind === "message" ? "" : "line-clamp-3";
  const text = p.text ? (
    <p className={cx("m-0 mt-0.5", phone ? "text-sm text-muted-foreground" : "text-[15px]", "leading-snug [overflow-wrap:anywhere]", clamp)} onClick={p.kind === "message" ? undefined : onOpen}>
      {p.kind === "merge" ? <a href={p.url ?? undefined} target="_blank" rel="noreferrer" className="underline">{p.text}</a> : p.text}
    </p>
  ) : null;
  return (
    <article
      className="k-post"
      onClick={phone && (onlyOpen || !phoneRow) ? (e) => ((e.target as HTMLElement).closest("button, a, input, textarea") ? undefined : onOpen()) : undefined}
      data-post={p.key}
      data-kind={p.kind}
      data-card={p.card?.id ?? p.deliverable?.id ?? p.key}
      data-prefetch-deliverable={p.kind === "deliverable" ? p.deliverable?.id : undefined}
      data-rev={String(p.card?.rev ?? p.deliverable?.rev ?? 0)}
      data-read={p.isNew ? undefined : ""}
      data-opened={opened || undefined}
    >
      {p.isNew ? <span className="k-post__dot" aria-label="new" data-new="" /> : null}
      <div className="pt-0.5">
        <AgentFace face={faces.get(p.author) ?? null} address={p.author} size={phone ? 24 : 32} />
      </div>
      <div className="min-w-0">
        {phone ? (
          // one meta line: who, where, when, then the chip and the step; the rest is cut, never wrapped
          // the words clip inside their own box, so the reply button beside it keeps its whole 44 px to the touch
          <div className="flex min-h-5 min-w-0 items-center gap-1.5 text-sm whitespace-nowrap" data-meta-line="">
            <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              <MetaWho p={p} now={now} cosTitle={cosTitle} />
              {chip ? <span className={cx("shrink-0 rounded-full border px-1.5 text-xs leading-4", tone)} data-chip="">{chip}</span> : null}
              {p.deliverable && p.deliverable.rev > 1 ? <span className="shrink-0 text-xs text-muted-foreground">rev {p.deliverable.rev}</span> : null}
              {p.outcome ? <span className="min-w-0 shrink-[3] truncate text-xs text-muted-foreground" data-outcome="">{p.outcome}{p.held ? " · on hold" : ""}</span> : null}
            </span>
            {reply}
          </div>
        ) : (
          <>
            <Head p={p} now={now} cosTitle={cosTitle} />
            {chip || p.outcome || (p.deliverable && p.deliverable.rev > 1) ? (
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                {chip ? <span className={cx("rounded-full border px-2 py-px", tone)} data-chip="">{chip}</span> : null}
                {p.deliverable && p.deliverable.rev > 1 ? <span className="rounded border bg-muted px-1.5 text-muted-foreground">rev {p.deliverable.rev}</span> : null}
                {p.outcome ? <span className="text-muted-foreground" data-outcome="">{p.outcome}{p.held ? " · on hold" : ""}</span> : null}
              </div>
            ) : null}
          </>
        )}
        {/* the step bar: on a phone only when no "step N of M" already says where it is */}
        {p.status && !(phone && p.outcome) ? <Steps steps={p.status.steps} /> : null}
        {phone ? (
          <div className="flex min-w-0 gap-2.5" data-post-body="">
            <div className="min-w-0 flex-1">
              {title}
              {text}
            </div>
            {p.deliverable?.thumb ? (
              // one tap on the shot pops it out full size, as on the web (public PR #17); the title, the text and the
              // rest of the post still open it
              <div className="k-thumb h-14 shrink-0" data-thumb={p.deliverable.thumb}>
                <ImagePopout src={proofSrc(p.deliverable.thumb)} caption={p.title ?? "Screenshot"} className="block size-full" sidePanel={p.deliverable.thumbFile ? () => openInBb(navigate, p.deliverable!.thumbFile!) : undefined}>
                  <img src={proofSrc(p.deliverable.thumb)} alt={p.title ?? "Screenshot"} loading="lazy" decoding="async" />
                </ImagePopout>
              </div>
            ) : null}
          </div>
        ) : (
          <>
            {title}
            {text}
          </>
        )}
        {p.self ? <MsgState m={p.self} after={after} /> : null}
        {p.deliverable?.thumb && !phone ? (
          <div className="k-media" data-thumb={p.deliverable.thumb}>
            {/* the picture pops out full size on one click (image-popout.tsx); the line under it opens the post */}
            <ImagePopout src={proofSrc(p.deliverable.thumb)} caption={p.title ?? "Screenshot"} className="block" sidePanel={p.deliverable.thumbFile ? () => openInBb(navigate, p.deliverable!.thumbFile!) : undefined}>
              <img src={proofSrc(p.deliverable.thumb)} alt={p.title ?? "Screenshot"} loading="lazy" decoding="async" />
            </ImagePopout>
            <Button type="button" variant="ghost" className="flex h-auto w-full items-center justify-start gap-1.5 rounded-none px-3 py-2 text-left text-xs font-normal whitespace-normal text-muted-foreground" onClick={onOpen} data-thumb-open="">
              <ImageIcon className="size-3.5" aria-hidden />1 of {p.deliverable.shots} screenshot{p.deliverable.shots === 1 ? "" : "s"}
            </Button>
          </div>
        ) : null}
        {p.card && p.card.options.length ? (
          <div className="mt-2.5 flex flex-col gap-2" data-poll="">
            {p.card.options.map((o) => (
              <Button key={o.id} type="button" variant="outline" className="k-poll h-auto font-normal whitespace-normal" data-option={o.id} data-recommended={o.recommended || undefined} data-armed={String(armed)} disabled={busy || p.card!.merge} onClick={() => answer(o.id)}>
                <span className="text-[15px]">{o.label}</span>
                {o.recommended ? <span className="text-[11px] font-semibold tracking-wide text-(--orch-danger) uppercase">Recommended</span> : null}
              </Button>
            ))}
            {p.card.allowText ? (
              <Button type="button" variant="link" className="h-auto p-0 font-normal whitespace-normal self-start text-sm text-muted-foreground" onClick={onOpen}>
                or answer in your own words
              </Button>
            ) : null}
          </div>
        ) : null}
        {/* a phone: Open alone on a row of its own is dead space; the post itself opens on a tap */}
        {!(phone && (onlyOpen || !phoneRow)) ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5" data-actions="">
          {phone ? null : reply}
          {p.deliverable?.state === "review" ? (
            <>
              <Btn tone="primary" size="sm" className="rounded-full" data-approve={p.deliverable.id} data-armed={String(armed)} disabled={busy} onClick={approve}>
                Approve
              </Btn>
              <Btn size="sm" className="rounded-full" data-request-changes={p.deliverable.id} onClick={onOpen}>
                Request changes
              </Btn>
            </>
          ) : null}
          {p.line && !p.lineLive && p.line.startsWith("lead:") ? (
            <span className="text-xs text-muted-foreground">
              No live lead to reply to ·{" "}
              <Button type="button" variant="link" className="h-auto p-0 font-normal whitespace-normal text-xs text-muted-foreground underline" onClick={() => onOpenProject(p.line!.slice(5))}>
                Start it in Projects
              </Button>
            </span>
          ) : p.held && p.line ? (
            <span className="text-xs text-muted-foreground">on hold: a reply waits until it resumes</span>
          ) : null}
          {/* a full row (Approve, Request changes) keeps Open to its icon, as the mockup has it */}
          <Btn tone="ghost" size="sm" className="ml-auto text-muted-foreground" data-open={p.key} aria-label="Open" onClick={onOpen} icon={<ArrowUpRight />}>
            {p.deliverable?.state === "review" ? null : "Open"}
          </Btn>
        </div>
        ) : null}
        {shown.length || expanded || replying ? (
          <div className="k-thread" data-thread={p.key}>
            {(expanded || replying) && p.earlier > 0 ? <Earlier about={p.key} before={p.thread[0]?.at ?? now} n={p.earlier} now={now} faces={faces} cosTitle={cosTitle} after={after} /> : null}
            {shown.map((m) => (
              <MsgRow key={m.id} m={m} now={now} faces={faces} cosTitle={cosTitle} after={after} />
            ))}
            {(expanded || replying) && p.line && p.lineLive ? (
              replying ? (
                <ReplyBox p={p} cosTitle={cosTitle} after={after} onDone={() => setReplying(false)} focus />
              ) : (
                // closed, the reply bar looks like the bar's own field: bordered, rounded like the field, no avatar; a 44 px tap target on a phone
                <Button type="button" variant="outline" className="flex h-auto min-h-11 w-full min-w-0 items-center justify-start rounded-md px-3 text-left text-base font-normal text-muted-foreground md:min-h-9 md:text-[15px]" data-reply-open={p.key} onClick={() => setReplying(true)}>
                  <span className="truncate">{replyTo(p.line, cosTitle)}</span>
                </Button>
              )
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function Steps({ steps }: { steps: { title: string; state: string }[] }) {
  if (!steps.length) return null;
  return (
    <div className="mt-1.5 flex gap-1" aria-hidden data-steps="">
      {steps.map((s, i) => (
        <span key={i} title={s.title} className={cx("h-1 flex-1 rounded-full", s.state === "done" ? "bg-(--success)/60" : s.state === "current" ? "bg-primary/70" : "bg-muted")} />
      ))}
    </div>
  );
}

/** One of the owner's messages' state line: what the line says, and Resend once nobody answered in time. */
function MsgState({ m, after }: { m: FeedMsg; after: () => void }) {
  const resend = () => {
    if (gate.lock) return;
    void write(WRITES.feedResend, { id: m.id } satisfies z.input<typeof feedResendBody>, { kind: "other", where: "feed", after });
  };
  return (
    <p className="m-0 mt-1 text-xs text-muted-foreground" data-msg-state={m.state ?? ""} data-msg={m.id}>
      {m.rev ? <>on rev {m.rev} · </> : null}
      <span className={cx(m.tone === "ok" && "text-(--success)", m.tone === "warn" && "text-(--warning-text)")}>
        {m.state}
        {m.tone === "ok" ? " ✓" : ""}
      </span>
      {m.resend ? (
        <>
          {" · "}
          <Button type="button" variant="link" className="h-auto p-0 font-normal whitespace-normal text-xs text-muted-foreground underline" data-resend={m.id} disabled={gate.lock !== null} onClick={resend}>
            Resend
          </Button>
        </>
      ) : null}
    </p>
  );
}

function MsgRow({ m, now, faces, cosTitle, after }: { m: FeedMsg; now: number; faces: ReadonlyMap<string, Face>; cosTitle: string; after: () => void }) {
  const who = nameOf(m.who, cosTitle);
  return (
    <div className="k-reply" data-reply={m.id} data-who={m.who}>
      <AgentFace face={faces.get(m.who) ?? null} address={m.who} size={24} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-1.5 text-sm">
          <span className="font-semibold">{who.name}</span>
          {who.sub ? <span className="text-muted-foreground">{who.sub}</span> : null}
          <span className="text-muted-foreground">· {ago(m.at, now)}</span>
          {m.isNew ? <span className="text-xs text-primary" data-reply-new="">new</span> : null}
        </div>
        <p className="m-0 text-[15px] leading-snug whitespace-pre-wrap [overflow-wrap:anywhere]">{m.text}</p>
        {m.who === "person" ? <MsgState m={m} after={after} /> : null}
      </div>
    </div>
  );
}

/** "Show N earlier replies": read only when asked (feedThread). */
function Earlier({ about, before, n, now, faces, cosTitle, after }: { about: string; before: number; n: number; now: number; faces: ReadonlyMap<string, Face>; cosTitle: string; after: () => void }) {
  const [open, setOpen] = useState(false);
  const t = experimental_useRpcQuery({ contract: rpcContract, method: "feedThread", input: { about, before }, enabled: open });
  useFreshRead("feedThread", t, { on: open, key: String(before) });
  if (!open)
    return (
      <Button type="button" variant="link" className="h-auto p-0 font-normal whitespace-normal self-start text-sm" data-earlier-replies={String(n)} onClick={() => setOpen(true)}>
        Show {n} earlier {n === 1 ? "reply" : "replies"}
      </Button>
    );
  return <>{t.data ? t.data.messages.map((m) => <MsgRow key={m.id} m={m} now={now} faces={faces} cosTitle={cosTitle} after={after} />) : <span className="text-xs text-muted-foreground">Loading…</span>}</>;
}

/** The pages after the first, each its own read, drawn as they come ("Show more"). */
function MorePages({ cursor, filter, now, faces, cosTitle, after, onOpen, onOpenProject }: { cursor: string; filter: FeedFilter; now: number; faces: ReadonlyMap<string, Face>; cosTitle: string; after: () => void; onOpen: (key: string) => void; onOpenProject: (slug: string) => void }) {
  const [shown, setShown] = useState(false);
  const page = experimental_useRpcQuery({ contract: rpcContract, method: "feed", input: { cursor, filter }, enabled: shown });
  useFreshRead("feed", page, { on: shown, key: `${filter} ${cursor}` });
  if (!shown)
    return (
      <Button type="button" variant="ghost" className="block h-auto w-full rounded-none border-b px-4 py-3 text-left text-sm font-normal text-muted-foreground" data-feed-more="" onClick={() => setShown(true)}>
        Show more
      </Button>
    );
  if (!page.data) return <p className="m-0 px-4 py-3 text-sm text-muted-foreground">Loading…</p>;
  return (
    <>
      {page.data.posts.map((p) => (
        <PostView key={p.key} p={p} now={now} faces={faces} cosTitle={cosTitle} opened={false} armed={false} check={() => false} after={after} onOpen={() => onOpen(p.key)} onOpenProject={onOpenProject} replying={false} setReplying={() => onOpen(p.key)} />
      ))}
      {page.data.cursor ? <MorePages cursor={page.data.cursor} filter={filter} now={now} faces={faces} cosTitle={cosTitle} after={after} onOpen={onOpen} onOpenProject={onOpenProject} /> : null}
    </>
  );
}

/** "Reply to Lead · checkout-flow…": the closed reply pill and the open box's placeholder say the same. */
const replyTo = (line: string, cosTitle: string) => {
  const to = nameOf(line, cosTitle);
  return `Reply to ${to.name}${to.sub ? ` · ${to.sub}` : ""}…`;
};

/** A reply's rules, behind its one hint (the 48 h detail is here, not a second line under the box). */
const LEAD_REPLY_RULES = "Goes straight to the lead; the CoS gets a copy. It doesn't answer a card, and merges, production changes and public pushes still need theirs. For 48 h it wins over a CoS instruction on its point.";
const CHIEF_REPLY_RULES = "Tracked: the CoS answers it here, in this conversation.";

/**
 * The reply box under a post (D6): a direct message to its lead (the CoS copied), or a tracked one to the CoS.
 * The compact bar, a bordered field with attach and Reply beside it; under it, one muted line, always mounted: what it is about,
 * the one hint, and Cancel.
 */
function ReplyBox({ p, cosTitle, after, onDone, focus = false }: { p: FeedPost; cosTitle: string; after: () => void; onDone?: () => void; focus?: boolean }) {
  const line = p.line!;
  const toLead = line.startsWith("lead:");
  const [text, setText] = useState("");
  const [images, setImages] = useState<Attached[]>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);
  const busy = gate.lock !== null || staging;
  const attach = (files: File[]) => {
    const { take, refused: why } = admit(images.length, files);
    setRefused(why);
    if (take.length) setImages((cur) => [...cur, ...take.map((i) => attached(files[i]!))]);
  };
  const drop = useDrop(attach);
  const send = async () => {
    const t = text.trim();
    if (!canSend(t, images.length) || busy) return;
    try {
      for (const img of images) {
        if (img.id) continue;
        setStaging(true);
        const data = await base64(img.file);
        const body = { name: img.file.name.slice(0, 200) || "image", mime: img.file.type, data };
        const up = await stage(toLead ? WRITES.directImage : WRITES.cosImage, toLead ? { slug: line.slice(5), ...body } : body).catch((e: unknown) => ({ ok: false as const, message: String(e) }));
        if (!up.ok || typeof up.result !== "string") {
          setRefused(`${img.file.name || "An image"} didn't upload: ${up.ok ? "no id came back" : up.message}`);
          return;
        }
        img.id = up.result;
      }
    } finally {
      setStaging(false);
    }
    const ids = images.map((i) => i.id!);
    const out = toLead
      ? await write(WRITES.directMessage, { slug: line.slice(5), text: t, followUp: null, about: p.key, ...(ids.length ? { images: ids } : {}) } satisfies z.input<typeof directMessageBody>, { kind: "other", where: `feed:${p.key}`, after })
      : await write(WRITES.cosMessage, { text: t, about: p.key, ...(ids.length ? { images: ids } : {}) } satisfies z.input<typeof cosMessageBody>, { kind: "other", where: `feed:${p.key}`, after });
    if (!out) return;
    if (!out.ok) return setError(out.message);
    images.forEach((i) => URL.revokeObjectURL(i.url));
    setText("");
    setImages([]);
    setError(null);
    onDone?.();
  };
  return (
    <CompactBar
      data-reply-box={p.key}
      data-line={line}
      {...drop}
      field={
        <ReplyField
          autoFocus={focus}
          aria-label={replyTo(line, cosTitle).slice(0, -1)}
          placeholder={replyTo(line, cosTitle)}
          value={text}
          maxLength={4000}
          data-reply-text=""
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = imageFiles(e.clipboardData.files);
            if (!pasted.length) return;
            e.preventDefault();
            attach(pasted);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
      }
      actions={
        <>
          <AttachButton onFiles={attach} disabled={staging} data={{ "data-reply-attach": "" }} />
          <Btn tone="primary" data-reply-send={p.key} disabled={busy || !canSend(text, images.length)} title="Reply (⌘/Ctrl+Enter)" onClick={() => void send()}>
            {staging ? "Sending…" : "Reply"}
          </Btn>
        </>
      }
    >
      <ImageThumbs images={images} refused={refused} onRemove={(key) => setImages((cur) => cur.filter((i) => i.key !== key))} disabled={staging} data="feed" />
      {error ? <p className="m-0 text-xs text-(--orch-danger)" role="alert">{error}</p> : null}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-reply-meta="">
        {p.deliverable ? <span className="rounded border bg-muted px-1.5 text-xs text-muted-foreground">about rev {p.deliverable.rev}</span> : null}
        {/* the one hint (D6): what the reply is; the rest of the rule is its detail */}
        <ReplyHint data-reply-hint="" detail={toLead ? LEAD_REPLY_RULES : CHIEF_REPLY_RULES}>
          {toLead ? "Not an approval" : "Tracked"}
        </ReplyHint>
        {onDone ? (
          <Button type="button" variant="ghost" size="xs" className="ml-auto h-6 px-1.5 text-xs font-normal text-muted-foreground" data-reply-cancel="" onClick={onDone}>
            Cancel
          </Button>
        ) : null}
      </div>
    </CompactBar>
  );
}

/** An opened post: full screen on the phone, a pane on desktop; the tab's own card or deliverable, then its replies. */
function ItemPane({ p, now, faces, cosTitle, needs, deliverables, after, onClose, onOpenProject, phone }: {
  p: FeedPost;
  now: number;
  faces: ReadonlyMap<string, Face>;
  cosTitle: string;
  needs: NeedsYou | undefined;
  deliverables: Deliverables | undefined;
  after: () => void;
  onClose: () => void;
  onOpenProject: (slug: string) => void;
  phone: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const touch = useTouchPhone();
  const arming = useArming(root);
  const conversation = !!p.line || p.replies > 0;
  const thread = experimental_useRpcQuery({ contract: rpcContract, method: "feedThread", input: { about: p.key, before: null }, enabled: conversation });
  useFreshRead("feedThread", thread, { on: conversation });
  const card = p.card ? (needs?.cards.find((c) => c.id === p.card!.id) ?? null) : null;
  const d = p.deliverable ? (deliverables?.find((x) => x.id === p.deliverable!.id) ?? null) : null;
  const send = (c: Card, kind: "answer" | "defer", path: string, body: unknown) => {
    if (gate.lock || !arming.check(c.id, c.rev)) return;
    void write(path, body, { card: { id: c.id, rev: c.rev, hide: kind === "defer" ? "cards" : "both" }, kind, after });
  };
  const act: Act = {
    answer: (c, _l, option, note) => send(c, "answer", WRITES.answer, { id: c.id, rev: c.rev, option, text: note.trim() ? note : null, via: via() }),
    defer: (c, preset) => send(c, "defer", WRITES.defer, { id: c.id, rev: c.rev, preset, zone: ZONE, via: via() }),
    secret: (c, _l, value) => send(c, "answer", WRITES.secret, { id: c.id, rev: c.rev, value, via: via() }),
    bringBack: () => {},
  };
  const all = thread.data?.messages ?? [];
  const messages = p.kind === "message" ? all.filter((m) => m.id !== p.key.slice(4)) : all;
  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col" data-item={p.key}>
      <header className="flex shrink-0 items-center gap-2 border-b px-4 py-2.5">
        {phone ? <Btn tone="ghost" size="sm" aria-label="Back to the feed" data-item-back="" onClick={onClose} icon={<ArrowLeft />} /> : null}
        <AgentFace face={faces.get(p.author) ?? null} address={p.author} size={24} />
        <Head p={p} now={now} cosTitle={cosTitle} />
        <span className="shrink-0 rounded-full border px-2 text-xs whitespace-nowrap text-muted-foreground" data-item-chip="">{touch && d ? (p.scope ? "Scope" : "Delivered") : chipOf(p)}</span>
        {!phone ? <Btn tone="ghost" size="sm" className="ml-auto" aria-label="Close" data-item-close="" onClick={onClose} icon={<X />} /> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-6">
        {card ? (
          <CardView card={card} list="cards" presets={needs?.presets ?? []} isArmed={arming.isArmed(card.id, card.rev)} act={act} mon={faces.get(card.origin) ?? null} />
        ) : d ? (
          <DeliverableCard d={d} refetchAll={after} outputs={[]} outputsAfter={() => {}} />
        ) : (
          <div className="flex flex-col gap-1">
            {p.title ? <h2 className="m-0 text-lg font-semibold">{p.title}</h2> : null}
            <p className="m-0 text-[15px] whitespace-pre-wrap [overflow-wrap:anywhere]">{p.text}</p>
            {p.self ? <MsgState m={p.self} after={after} /> : null}
            {p.outcome ? <p className="m-0 text-sm text-muted-foreground">{p.outcome}</p> : null}
            {p.status ? <Steps steps={p.status.steps} /> : null}
            {p.url ? (
              <a href={p.url} target="_blank" rel="noreferrer" className="text-sm underline">
                Open the PR
              </a>
            ) : null}
          </div>
        )}
        {p.project ? (
          <div className="mt-3">
            <Btn size="sm" data-open-project={p.project} onClick={() => onOpenProject(p.project!)}>
              Open project
            </Btn>
          </div>
        ) : null}
        {p.line || messages.length ? (
          <section className="mt-5" aria-label="Conversation" data-conversation={p.key}>
            <h3 className="m-0 mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Conversation · {messages.length}</h3>
            <div className="k-thread">
              {messages.map((m) => (
                <MsgRow key={m.id} m={m} now={now} faces={faces} cosTitle={cosTitle} after={after} />
              ))}
            </div>
            {p.line && p.lineLive ? (
              <div className="mt-3">
                <ReplyBox p={p} cosTitle={cosTitle} after={after} />
              </div>
            ) : p.line ? (
              <p className="m-0 mt-3 text-sm text-muted-foreground">No live {p.line === "cos" ? "Chief of Staff" : "lead"} to reply to.</p>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}
