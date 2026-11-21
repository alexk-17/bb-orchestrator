// The owner's direct line to a project's lead on its Projects row (2026-11-16, PLAN 3.4): "You:" lines with their
// state, the lead's ack note under each, and the composer. Acked means taken, not finished: the note says which. A
// dead message says it is with the CoS and offers Resend. Never a phone notification: the row's dot is the signal.
// Since 2026-11-17 the composer is always open under the project's name, wherever the project is open (the detail
// beside the list, or a row opened in place); the owner: "the message input bar should just always be there".
// 1.13.0: open, the chat draws the lead's own thread as the Chat tab draws the CoS's (lead-chat.ts says when), and the
// composer under it is a chat input; the 1.10.0 log is what shows while the lead has no live thread.
// 1.16.0: one card: the head, the transcript and the composer are its zones, split by a hairline. Nothing about what a
// send is changed.
// 2026-11-17: the log and the host's transcript open at the newest message, follow it while the owner is there, and offer
// "Jump to latest" once they scroll up (stick-bottom.ts, the one helper for both).
// 2026-11-17, on app/ui (shadcn): the card is app/ui's Card, its head a ghost Button, the composer shadcn's Textarea,
// Checkbox and Label, a dead message's Resend a link Button; bb's tokens for every colour. The screenshot wiring
// (image-attach.tsx) and the stick-bottom wiring are as they were, and nothing about what a send is changed.
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { z } from "zod";
import { Markdown, ThreadChat, experimental_useRpcQuery, useRealtime } from "@get-bb/plugin-sdk/app";
import { CHANGED_CHANNEL, WRITES, rpcContract, type Projects, type directSeenBody, type resendBody } from "../contract.ts";
import { chatOrder, chatPreview, directState, followUpOf, seenUpTo } from "./command-center.ts";
import { directWrite, imageWrite, leadChatView, messageStates } from "./lead-chat.ts";
import { admit, canSend, imageFiles } from "./lead-images.ts";
import { AttachButton, ImageThumbs, attached, base64, useDrop, type Attached } from "./image-attach.tsx";
import { ReplyButton, ReplyComposer, ReplyField, ReplyHint } from "./reply-composer.tsx";
import { age } from "./lanes.ts";
import { INLINE_LINK } from "./ref-text.tsx";
import { firstScroller, useStickBottom } from "./stick-bottom.ts";
import { stage, write } from "./store.ts";
import { Btn, when } from "./ui.tsx";
import { Button } from "./ui/button.tsx";
import { Card } from "./ui/card.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { Label } from "./ui/label.tsx";
import { ChevronRight, Image as ImageIcon } from "lucide-react";

type Project = Projects[number];
const MAX = 4000;

export const directCss = /* css */ `
/* the chat's card: app/ui's Card with no padding or gap of its own; its zones (head, transcript, composer) split by a hairline */
[data-orch] .orch-cc .k-chatcard > * + *, [data-orch] .orch-cc .k-chat > * + * { border-top: 1px solid var(--border); }
[data-orch] .orch-cc .k-chat { display: flex; flex-direction: column; min-width: 0; }
[data-orch] .orch-cc .k-chat__dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--k-need); }
/* a head that is not a button (the Scope tab's): whose chat, and the way to its thread */
[data-orch] .orch-cc .k-chat__bar { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 48px; padding: 8px 16px; }
[data-orch] .orch-cc .k-chat__bar h3 { margin: 0; }
[data-orch] .orch-cc .k-chat__bar .tail { margin-left: auto; }
/* the lead's own thread (1.13.0): the host's transcript in a zone of a fixed height, which it fills and scrolls inside */
[data-orch] .orch-cc .k-leadthread { position: relative; display: flex; flex-direction: column; height: var(--k-leadthread-h, 480px); min-height: 0; overflow: hidden; }
[data-orch] .orch-cc .k-leadthread > * { flex: 1 1 auto; min-height: 0; }
[data-orch] .orch-cc .k-leadthread__note { margin: 0 0 8px; font-size: 12px; line-height: 16px; color: var(--muted-foreground); }
/* the chat log (1.10.0): the owner's messages on the right in a tint, the lead's on the left in a hairline */
[data-orch] .orch-cc .k-chat__log { display: flex; flex-direction: column; gap: 12px; max-height: 480px; overflow-y: auto; padding: 12px 16px; }
[data-orch] .orch-cc .k-chat__pair { display: flex; flex-direction: column; gap: 8px; }
[data-orch] .orch-cc .k-msg { max-width: min(640px, 85%); min-width: 0; padding: 8px 12px; border-radius: var(--radius); overflow-wrap: anywhere; }
[data-orch] .orch-cc .k-msg[data-from="you"] { align-self: flex-end; background: var(--muted); }
[data-orch] .orch-cc .k-msg[data-from="lead"] { align-self: flex-start; box-shadow: inset 0 0 0 1px var(--border); }
[data-orch] .orch-cc .k-msg__b > :first-child { margin-top: 0; }
[data-orch] .orch-cc .k-msg__b > :last-child { margin-bottom: 0; }
[data-orch] .orch-cc .k-msg__who, [data-orch] .orch-cc .k-msg__re { font-size: 12px; line-height: 16px; font-weight: 600; color: var(--muted-foreground); }
[data-orch] .orch-cc .k-msg__re { font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-orch] .orch-cc .k-msg__meta { margin-top: 4px; font-size: 12px; line-height: 16px; color: var(--muted-foreground); }
[data-orch] .orch-cc .k-msg__imgs { display: flex; align-items: center; gap: 4px; margin-top: 4px; font-size: 12px; line-height: 16px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-orch] .orch-cc .k-msg__new { color: var(--k-need); font-weight: 600; }
[data-orch] .orch-cc .k-chat__older { align-self: center; }
/* "Jump to latest" (2026-11-17): shows once the owner scrolls up; shadcn's outline button at its 24 px size over the
   transcript's bottom edge, held in the log's view by sticky, and over the host's transcript (outside its DOM) by the box */
[data-orch] .orch-cc .k-jump { flex: none; align-self: center; height: 24px; }
[data-orch] .orch-cc .k-chat__log > .k-jump { position: sticky; bottom: 0; }
[data-orch] .orch-cc .k-leadthread > .k-jump { position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%); }
[data-orch] .orch-cc .k-chat__empty { margin: 0; font-size: 12px; line-height: 16px; color: var(--muted-foreground); }
/* the composer (2026-11-20): the reply box (reply-composer.tsx) in the card's last zone; the row's quiet line says only
   what changes, and a dead message's warning in the need colour */
[data-orch] .orch-cc .k-composer { padding: 12px 16px; }
[data-orch] .orch-cc .k-composer__hint { min-width: 0; font-size: 12px; line-height: 16px; color: var(--muted-foreground); }
[data-orch] .orch-cc .k-composer__hint .warn { color: var(--k-need); font-weight: 600; }
`;

/**
 * The owner opened the project (a click on it, Details, or the composer focused): the answers it shows are seen (an
 * explicit write, never a render), up to the newest one drawn, so an answer that came in after the page drew stays new.
 */
export function markSeen(project: Project, refetchAll: () => void) {
  const upTo = seenUpTo(project.direct);
  if (upTo === null) return;
  const body: z.input<typeof directSeenBody> = { slug: project.slug, upTo };
  void write(WRITES.directSeen, body, { kind: "other", where: `lead:${project.slug}`, after: refetchAll });
}

/** Chats left open, by project: a new selection or a resize remounts the detail, and the log stays as the owner left it. */
const openChats = new Set<string>();
const PAGE = 30;

/**
 * The direct line as a chat (1.10.0): a collapsible log on the project, the composer under it. Collapsed, one line
 * with the last exchange and a dot while the lead's reply is unread; it starts open while one is. Opening it is the
 * explicit act that marks the replies seen (markSeen), never a render. The log reads its own history (directHistory),
 * so the Projects read stays light; "Older" pages back with a before-cursor.
 */
export function ChatLog({ project, now, cos, busy, refetchAll, onPick, startOpen = false }: { project: Project; now: number; cos: string; busy: boolean; refetchAll: () => void; onPick: () => void; startOpen?: boolean }) {
  const slug = project.slug;
  // starts open while a reply is unread: opening the project (an explicit act, projects.tsx) marks it seen, so it must show.
  // The Scope tab (1.11.0) opens it always: the chat is what the owner came there for.
  const [open, setOpen] = useState(() => startOpen || openChats.has(slug) || !!project.direct?.unread);
  const toggle = () => {
    const next = !open;
    if (next) {
      openChats.add(slug);
      onPick();
      markSeen(project, refetchAll);
    } else openChats.delete(slug);
    setOpen(next);
  };
  const pre = chatPreview(project.direct);
  return (
    <section className="k-chat" data-chat={slug} data-open={open ? "true" : "false"}>
      {/* the whole row opens and closes the chat; the card clips what leaves it, so the keyboard ring is drawn inside */}
      <Button
        type="button"
        variant="ghost"
        className="k-chat__head h-auto min-h-12 w-full justify-start gap-3 rounded-none px-4 py-3 text-left font-normal whitespace-normal focus-visible:ring-inset"
        aria-expanded={open}
        data-chat-toggle={slug}
        onClick={toggle}
      >
        <ChevronRight aria-hidden className={`text-muted-foreground transition-transform${open ? " rotate-90" : ""}`} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-semibold">Chat with lead</span>
          {!open && pre ? (
            <span className="truncate text-xs text-muted-foreground" data-chat-preview="" title={pre.lead ? `You: ${pre.you}\nLead: ${pre.lead}` : `You: ${pre.you}`}>
              You: {pre.you}
              {pre.lead ? ` · Lead: ${pre.lead}` : ""}
            </span>
          ) : null}
        </span>
        {pre?.unread ? <span className="k-chat__dot" data-chat-unread="" role="img" aria-label="New reply from the lead" /> : null}
      </Button>
      {open ? <ChatBody project={project} now={now} cos={cos} busy={busy} refetchAll={refetchAll} /> : null}
    </section>
  );
}

/** The chat's card: app/ui's Card, its children the zones (a head, the transcript, the composer). */
export function ChatCard({ slug, children, ...rest }: { slug: string; children: ReactNode; [data: `data-${string}`]: string | undefined }) {
  return (
    <Card className="k-chatcard gap-0 overflow-hidden py-0" data-direct-line={slug} {...rest}>
      {children}
    </Card>
  );
}

/** The chat itself: the lead's live thread, else the direct-message log (lead-chat.ts leadChatView). */
export function ChatBody({ project, now, cos, busy, refetchAll, height }: { project: Project; now: number; cos: string; busy: boolean; refetchAll: () => void; height?: string }) {
  const view = leadChatView(project.lead);
  if (view.kind === "thread") return <ThreadBox threadId={view.threadId} label={`lead:${project.slug}`} height={height} note={`The ${project.slug} lead's own thread.`} />;
  return <ChatPages project={project} now={now} cos={cos} busy={busy} refetchAll={refetchAll} />;
}

/**
 * One agent's bb thread as the Chat tab draws it, transcript only (the host's ThreadChat, variant timeline), in a box of
 * a fixed height that it fills and scrolls inside. No composer of its own: one there would send untracked.
 */
export function ThreadBox({ threadId, label, height, note }: { threadId: string; label: string; height?: string; note?: ReactNode }) {
  // the host draws the transcript and its scroller (no hook of ours on it, and no follow of its own): found under the box,
  // each message a row of its timeline list. Kept to the bottom from outside, on every mount: a remount resets it to the top
  const stick = useStickBottom<HTMLDivElement>({ items: "[data-timeline-items] > *", find: firstScroller, reset: threadId });
  return (
    <div ref={stick.ref} className="k-leadthread" data-thread-box={threadId} role="region" aria-label={`${label}'s thread`} style={height ? ({ "--k-leadthread-h": height } as CSSProperties) : undefined}>
      <ThreadChat threadId={threadId} variant="timeline" layout="contained" className="min-h-0 flex-1" leadingContent={note ? <p className="k-leadthread__note">{note}</p> : undefined} />
      {stick.away ? <JumpToLatest onJump={stick.jump} /> : null}
    </div>
  );
}

const JUMP = "k-jump bg-background shadow-xs [&:is(.dark_*)]:bg-background [&:is(.dark_*)]:hover:bg-accent";
/** Shows while the owner reads above the newest message: back to it, and following it again. */
function JumpToLatest({ onJump }: { onJump: () => void }) {
  return (
    // opaque in both themes (2026-11-17): it floats over the messages, and the outline variant's dark fill and hover are
    // 30% and 50% see-through, so its label ran into the text under it; bb's background and accent tokens, solid
    <Button type="button" variant="outline" size="xs" className={JUMP} data-jump-latest="" onClick={onJump}>
      Jump to latest
    </Button>
  );
}

/** The pages of the log, oldest at the top: the newest page, then each older one the owner asked for. */
function ChatPages({ project, now, cos, busy, refetchAll }: { project: Project; now: number; cos: string; busy: boolean; refetchAll: () => void }) {
  const [cursors, setCursors] = useState<number[]>([]);
  // the log is the scroller; each exchange a message. An older page loading above keeps the one being read in place
  const stick = useStickBottom<HTMLDivElement>({ items: "[data-chat-msg]", reset: project.slug });
  const pages = [null, ...cursors];
  return (
    <div className="k-chat__log" ref={stick.ref} role="log" aria-label={`Chat with the ${project.slug} lead`}>
      {pages
        .map((before, i) => (
          <ChatPage
            key={before ?? "latest"}
            project={project}
            before={before}
            now={now}
            cos={cos}
            busy={busy}
            refetchAll={refetchAll}
            oldest={i === pages.length - 1}
            onOlder={(at) => setCursors((c) => (c.includes(at) ? c : [...c, at]))}
          />
        ))
        .reverse()}
      {stick.away ? <JumpToLatest onJump={stick.jump} /> : null}
    </div>
  );
}

function ChatPage({ project, before, now, cos, busy, refetchAll, oldest, onOlder }: { project: Project; before: number | null; now: number; cos: string; busy: boolean; refetchAll: () => void; oldest: boolean; onOlder: (at: number) => void }) {
  const q = experimental_useRpcQuery({ contract: rpcContract, method: "directHistory", input: { slug: project.slug, before, limit: PAGE } });
  const again = useRef(q.refetch);
  again.current = q.refetch;
  const latest = before === null;
  // the newest page follows the line live (a send, the lead's ack); older pages don't change
  useRealtime(CHANGED_CHANNEL, () => latest && void again.current());
  const ms = chatOrder(q.data?.messages ?? []);
  // an older page on its way holds the button's place (2026-11-17): the button leaving first, at the top of the log, would
  // shift the message being read up by its height, where no scroll can make up for it
  if (!q.data) return latest ? <p className="k-chat__empty">{q.error ? `Can't read the chat: ${q.error.message}` : "Loading…"}</p> : oldest ? <Btn tone="ghost" size="sm" className="k-chat__older" disabled>Older messages</Btn> : null;
  const texts = new Map(ms.map((m) => [m.id, m.text]));
  return (
    <>
      {oldest && q.data.more && ms[0] ? (
        <Btn tone="ghost" size="sm" className="k-chat__older" data-chat-older="" onClick={() => onOlder(ms[0]!.at)}>
          Older messages
        </Btn>
      ) : null}
      {latest && ms.length === 0 ? <p className="k-chat__empty">No messages yet. Write to the lead below.</p> : null}
      {ms.map((m) => {
        const st = directState(m, cos);
        return (
          <div key={m.id} className="k-chat__pair" data-chat-msg={m.id} data-direct-state={m.state}>
            <div className="k-msg text-sm" data-from="you">
              {m.followUp ? (
                <div className="k-msg__re" title={texts.get(m.followUp) ?? undefined}>
                  ↳ follow-up{texts.has(m.followUp) ? ` of “${(texts.get(m.followUp) ?? "").slice(0, 60)}”` : ""}
                </div>
              ) : null}
              {m.text ? (
                <div className="k-msg__b">
                  <Markdown content={m.text} />
                </div>
              ) : null}
              {m.images?.length ? (
                <div className="k-msg__imgs" data-chat-images={m.images.length} title={m.images.map((i) => i.name).join("\n")}>
                  <ImageIcon aria-hidden className="size-3" /> {m.images.length === 1 ? "1 image" : `${m.images.length} images`}: {m.images.map((i) => i.name).join(", ")}
                </div>
              ) : null}
              <div className="k-msg__meta">
                <span title={when(m.at)}>{age(m.at, now)} ago</span> · {st.dead ? <b className="warn">{st.word}</b> : <span data-chat-state="">{st.word}</span>}
                {st.dead ? (
                  <>
                    {" · "}
                    <Button type="button" variant="link" className={RESEND} data-direct-resend={m.id} disabled={busy} onClick={() => resend(project.slug, m.id, refetchAll)}>
                      Resend
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
            {m.note ? (
              <div className="k-msg text-sm" data-from="lead" data-chat-note={m.id}>
                <div className="k-msg__who">lead:{project.slug}</div>
                <div className="k-msg__b">
                  <Markdown content={m.note} />
                </div>
                {m.answeredAt ? (
                  <div className="k-msg__meta">
                    <span title={when(m.answeredAt)}>{age(m.answeredAt, now)} ago</span>
                    {m.unread ? <b className="k-msg__new"> · new</b> : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/**
 * Each project's draft, outside the rows, shared by every composer drawn for it: a new selection remounts the detail,
 * a resize across the wide layout swaps it for a row, a row moving to or from Quiet remounts, and a send can finish
 * after any of these; whichever composer is on screen shows the one draft, so a sent message never lingers in another.
 * `follow` is the checkbox, kept with the words. `sending` is the words on their way, kept only while what is typed
 * after them only adds to them: on success those words go and the rest stays; a draft cleared or rewritten meanwhile
 * stays whole. `sentLast` is the message just sent: the next follow-up until the page's read lists it, then dropped
 * (the read is the truth after that). Every change bumps one version, the store's snapshot, so a change to either map
 * redraws every composer.
 */
type Draft = { text: string; followUp: { id: string; text: string } | null; follow: boolean; sending: string | null; images: Attached[] };
/**
 * `images` (2026-11-17): the draft's screenshots; a send that failed after staging them sends the same ids again, not
 * the files. `refused`: the line under the field saying why a file stayed out, by project; `staging`: projects whose
 * images are on their way.
 */
const refused = new Map<string, string>();
const staging = new Set<string>();
const drafts = new Map<string, Draft>();
const sentLast = new Map<string, { id: string; text: string }>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  listeners.forEach((f) => f());
};
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};
const setDraft = (slug: string, d: Draft | null) => {
  if (d) drafts.set(slug, d);
  else drafts.delete(slug);
  changed();
};
const setRefused = (slug: string, why: string | null) => {
  if (why) refused.set(slug, why);
  else refused.delete(slug);
  changed();
};
const setStaging = (slug: string, on: boolean) => {
  if (on) staging.add(slug);
  else staging.delete(slug);
  changed();
};


/**
 * Resend in a line of 12 px text: a link, its hit area grown to 24 px tall without moving the line. 2026-11-18: its
 * underline is the text's own colour, as the Start links', not the inline refs' faint border (almost gone in dark).
 */
const RESEND = `${INLINE_LINK} -my-1 py-1 decoration-current`;

/** Send a dead message again (the log's Resend, and the line under the composer while the lead's thread shows). */
function resend(slug: string, id: string, refetchAll: () => void) {
  const body: z.input<typeof resendBody> = { id };
  void write(WRITES.resend, body, { kind: "other", where: `lead:${slug}`, after: refetchAll });
}

/**
 * The composer, always open: the message, an optional follow-up, and what it is not (an approval). While the box is
 * empty the follow-up is the latest message (while in force), so after a send it is the one just sent; the first
 * keystroke fixes it, and a newer message elsewhere never retargets a draft. It never takes focus by itself.
 * Whatever the chat above shows, a send is the owner's tracked direct message (lead-chat.ts directWrite). While the
 * lead's thread shows, the quiet line also says where the latest message is, and offers Resend for a dead one: the
 * transcript doesn't. `via`: where the message goes, when it is not plainly "the lead" (the Scope tab's scoping thread).
 * 2026-11-20 (the owner's model, X's inline reply): the reply box (reply-composer.tsx). The field, then one row: attach
 * and the follow-up switch, one quiet line, Send. The line says only what changes (the last message's state, a dead
 * one's Resend, who passes it on) and "Not an approval", whose detail holds the full rules.
 */
export function Composer({ project, now, cos, busy, refetchAll, onFocus, compact = false, via }: { project: Project; now: number; cos: string; busy: boolean; refetchAll: () => void; onFocus: () => void; compact?: boolean; via?: string }) {
  const slug = project.slug;
  useSyncExternalStore(subscribe, () => version);
  const draft = drafts.get(slug) ?? null;
  const latest = followUpOf(project.direct, now);
  const sent = sentLast.get(slug);
  // the message just sent, until the page's read lists it (typing before that must not fix an older target)
  const listed = !!sent && !!project.direct?.messages.some((m) => m.id === sent.id);
  useEffect(() => {
    if (listed && sentLast.get(slug) === sent) sentLast.delete(slug);
  }, [listed, sent, slug]);
  const live = sent && !listed ? sent : latest ? { id: latest.id, text: latest.text } : null;
  const followUp = draft ? draft.followUp : live;
  const follow = draft ? draft.follow : true;
  const text = draft?.text ?? "";
  const images = draft?.images ?? [];
  const update = (t: string, f = follow) => {
    const sending = draft?.sending && t.startsWith(draft.sending) ? draft.sending : null;
    setDraft(slug, t || !f || images.length ? { text: t, followUp, follow: f, sending, images } : null);
  };
  // screenshots (2026-11-17): a paste, a drop or the picker adds them (lead-images.ts admit says which), the remove
  // button takes one off; either is the draft's, like its words
  const attach = (files: File[]) => {
    const cur = drafts.get(slug) ?? null;
    const have = cur?.images ?? [];
    const { take, refused: why } = admit(have.length, files);
    setRefused(slug, why);
    if (!take.length) return;
    const added = take.map((i) => attached(files[i]!));
    setDraft(slug, { text: cur?.text ?? "", followUp: cur ? cur.followUp : followUp, follow: cur ? cur.follow : follow, sending: cur?.sending ?? null, images: [...have, ...added] });
  };
  const detach = (key: string) => {
    const cur = drafts.get(slug);
    if (!cur) return;
    const gone = cur.images.find((i) => i.key === key);
    if (gone) URL.revokeObjectURL(gone.url);
    const left = cur.images.filter((i) => i.key !== key);
    setRefused(slug, null);
    setDraft(slug, cur.text || !cur.follow || left.length ? { ...cur, images: left } : null);
    box.current?.focus();
  };
  const drop = useDrop(attach);
  const box = useRef<HTMLTextAreaElement>(null);
  const send = async () => {
    const t = text.trim();
    const going = images;
    if (!canSend(t, going.length) || staging.has(slug)) return;
    if (draft) setDraft(slug, { ...draft, sending: text });
    // each image first, on its own write; the message names them by the ids the server gave back
    if (going.some((i) => !i.id)) {
      setStaging(slug, true);
      try {
        for (const img of going) {
          if (img.id) continue;
          const up = await base64(img.file)
            .then((data) => imageWrite(slug, img.file.name, img.file.type, data))
            .then((w) => stage(w.path, w.body))
            .catch((e: unknown) => ({ ok: false as const, message: String(e) }));
          if (!up.ok || typeof up.result !== "string") {
            setRefused(slug, `${img.file.name || "An image"} didn't upload: ${up.ok ? "no id came back" : up.message}`);
            const cur = drafts.get(slug);
            if (cur?.sending !== null && cur) setDraft(slug, { ...cur, sending: null });
            return;
          }
          img.id = up.result;
        }
      } finally {
        setStaging(slug, false);
      }
    }
    const w = directWrite(slug, t, follow && followUp ? followUp.id : null, going.map((i) => i.id!));
    const out = await write(w.path, w.body, { kind: "other", where: `lead:${slug}`, after: refetchAll });
    const cur = drafts.get(slug);
    if (!out?.ok) {
      if (cur?.sending !== null && cur) setDraft(slug, { ...cur, sending: null });
      return;
    }
    const justSent = typeof out.result === "string" ? { id: out.result, text: t || `${going.length} image${going.length === 1 ? "" : "s"}` } : null;
    if (justSent) sentLast.set(slug, justSent);
    // only the words sent go: what was added after them while the send was on its way stays, and a draft cleared or
    // rewritten meanwhile stays whole; either is a new message, following up the one just sent. Likewise only the
    // images sent go: one attached meanwhile stays.
    const sentKeys = new Set(going.map((i) => i.key));
    going.forEach((i) => URL.revokeObjectURL(i.url));
    const left = (cur?.images ?? []).filter((i) => !sentKeys.has(i.key));
    const rest = !cur ? "" : cur.sending === text ? cur.text.slice(text.length).replace(/^\s+/, "") : cur.text;
    setRefused(slug, null);
    setDraft(slug, (rest || left.length) && cur ? { text: rest, followUp: justSent ?? cur.followUp, follow: cur.follow, sending: null, images: left } : null);
    box.current?.focus(); // the Send button it was on is disabled now: back to the box, for the next message
  };
  const left = MAX - text.length;
  const to = via ?? `Goes straight to the ${project.slug} lead`;
  // the rule, once: the hint's detail (its words "Not an approval" are the hint itself)
  const rules = `${to}; the ${cos} gets a copy. Merges, production changes and public pushes still need their card. For 48 h it wins over a ${cos} instruction on its point. No secrets here.`;
  // the message states, while the lead's thread shows instead of the log (which shows them on each message)
  const states = leadChatView(project.lead).kind === "thread" ? messageStates(project.direct, cos) : null;
  // compact (the detail, 2026-11-17): the quiet line shows once typed in, or while a message needs a Resend; the
  // follow-up switch once there is a draft to follow up with
  const quiet = !compact || !!text || !!images.length || !!states?.dead.length;
  const following = !!followUp && (!compact || !!text || !!images.length);
  const why = refused.get(slug) ?? null;
  const uploading = staging.has(slug);
  // idle on one line (2026-11-20, the lead: X's reply collapses until you focus it): compact, empty, nothing attached or
  // refused, and focus nowhere in the box. It saves a row in the project's head, so the whole box shows at 1440x900
  const [within, setWithin] = useState(false);
  const idle = compact && !within && !text && !images.length && !why && !states?.dead.length;
  return (
    // a file dropped anywhere on the box attaches (2026-11-17); what isn't an image is refused under the field
    <ReplyComposer
      role="group"
      aria-label={`Message the ${project.slug} lead`}
      data-composer={project.slug}
      className={compact ? "k-composer compact" : "k-composer"}
      {...drop}
      inline={idle}
      onFocus={() => setWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setWithin(false);
      }}
      field={
        <ReplyField
          ref={box}
          value={text}
          maxLength={MAX}
          // it grows with the text (field-sizing) up to eight lines, then scrolls
          aria-keyshortcuts="Meta+Enter Control+Enter"
          placeholder={`Message Lead · ${project.slug}…`}
          aria-label={`Message to lead:${project.slug}`}
          onFocus={onFocus}
          onChange={(e) => update(e.target.value)}
          // a pasted screenshot attaches (2026-11-17); a paste with no image in it is the text box's own, as before
          onPaste={(e) => {
            const pasted = imageFiles(e.clipboardData.files);
            if (!pasted.length) return;
            e.preventDefault();
            attach(pasted);
          }}
          // ⌘/Ctrl+Enter sends; Esc leaves the text box and keeps the draft (the app's rule for every text box)
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
      }
      tools={
        <>
          <AttachButton onFiles={attach} disabled={uploading} data={{ "data-direct-attach": project.slug }} />
          {following ? (
            // the whole line is the target (24 px), the box and its words
            <Label className="min-h-6 cursor-pointer text-xs font-normal text-muted-foreground" title={`Follow-up of your last message: ${followUp.text}`}>
              <Checkbox checked={follow} onCheckedChange={(c) => update(text, c === true)} data-direct-follow={followUp.id} />
              Follow-up
            </Label>
          ) : null}
        </>
      }
      hint={
        quiet ? (
          <span className="k-composer__hint" data-composer-hint="">
            {states?.dead.map((m) => (
              <span key={m.id} data-direct-dead={m.id}>
                <b className="warn">No ack for your message of {age(m.at, now)} ago</b> ·{" "}
                <Button type="button" variant="link" className={RESEND} data-direct-resend={m.id} disabled={busy} onClick={() => resend(slug, m.id, refetchAll)}>
                  Resend
                </Button>
                {" · "}
              </span>
            ))}
            {states?.last ? (
              <span data-direct-last={states.last.id} data-chat-state="">
                Last message: {states.last.word} ·{" "}
              </span>
            ) : null}
            {left < 500 ? `${left} characters left · ` : ""}
            {via ? `${via} · ` : ""}
            <ReplyHint detail={rules}>Not an approval</ReplyHint>
          </span>
        ) : null
      }
      actions={
        <ReplyButton data-direct-send={project.slug} disabled={busy || uploading || !canSend(text, images.length)} title="Send (⌘/Ctrl+Enter)" onClick={() => void send()}>
          {uploading ? "Sending…" : "Send"}
        </ReplyButton>
      }
    >
      <ImageThumbs images={images} refused={why} onRemove={detach} disabled={uploading} data={project.slug} />
    </ReplyComposer>
  );
}
