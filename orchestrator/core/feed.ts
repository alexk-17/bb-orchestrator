// The Feed tab's read (D2-D6): one paged list of posts by latest agent activity, reply counts from one grouped query.
import type { Db } from "./db.ts";
import type { Decision, Deliverable } from "./model.ts";
import type { LeadStatus } from "./status.ts";

export const FEED_PAGE = 50;
/** Newest exchanges a post carries; "Show N earlier replies" reads the rest (feedThread). */
export const FEED_SHOWN = 3;

export type FeedFilter = "all" | "needs" | "delivered" | "alerts";
export type FeedKind = "card" | "prompt" | "deliverable" | "status" | "merge" | "alarm" | "dead" | "message";

export interface FeedMsg {
  id: string;
  who: string; // "person", or the answering agent's address
  text: string;
  at: number;
  rev: number | null; // a deliverable's revision when it was written ("on rev 2")
  state: string | null; // the owner's message's state, as the feed words it
  tone: "ok" | "warn" | null;
  resend: boolean;
  images: number;
  isNew: boolean;
}

export interface FeedPost {
  key: string;
  kind: FeedKind;
  author: string;
  project: string | null;
  line: string | null; // where a reply goes; null: the post only opens
  lineLive: boolean;
  held: boolean;
  to: string | null; // the owner's own post: whom it went to
  title: string;
  text: string;
  at: number;
  activity: number;
  scope: boolean;
  needsOwner: boolean;
  isNew: boolean;
  outcome: string | null;
  card: { id: string; rev: number; options: { id: string; label: string; detail: string; recommended: boolean }[]; allowText: boolean; merge: boolean } | null;
  deliverable: { id: string; rev: number; state: string; shots: number; thumb: string | null } | null;
  status: { steps: { title: string; state: string }[]; needs: string | null } | null;
  url: string | null;
  prompt: { threadId: string; id: string } | null;
  replies: number;
  thread: FeedMsg[];
  earlier: number;
  self: FeedMsg | null; // the owner's own post: its message, with its state (not in thread)
}

export interface FeedPage {
  posts: FeedPost[];
  cursor: string | null;
  seen: number;
  newCount: number;
  counts: { needsYou: number; delivered: number; alerts: number };
  leftOut: number;
  now: number;
  last: (FeedMsg & { to: string; about: string }) | null; // the owner's latest message on either line, for the dock's state line
}

/** A pending bb prompt from the CoS, the Steward or a lead (worker threads' stay on Needs you, D2). */
export interface FeedPrompt {
  id: string;
  threadId: string;
  address: string;
  title: string;
  since: string | null;
}

/** What the read needs from the engine: its own reads, so the rules (deferral, holds, scope) stay in one place. */
export interface FeedSource {
  db: Db;
  now: number;
  seen: number;
  resendMs: number;
  batched: boolean;
  batchReadAt: (itemId: string) => number | null;
  openCards: Decision[];
  scopeCards: Decision[];
  live: (address: string) => boolean;
  heldProjects: ReadonlySet<string>;
  prompts: FeedPrompt[];
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : 0);
const one = (s: string, n = 280) => s.replace(/\s+/g, " ").trim().slice(0, n);

// A lead's answer is its ack note on the owner's message; the engine's own closures (archive, dead letter) aren't.
const LEAD_ANSWER = `(kind = 'owner.message' AND state = 'closed' AND note IS NOT NULL AND TRIM(note) != '' AND NOT (outcome = 'superseded' AND note = 'project archived') AND note NOT LIKE 'closed by %')`;
const ANSWER_AT = `CASE WHEN kind = 'cos.reply' THEN created_at WHEN ${LEAD_ANSWER} THEN closed_at END`;

interface ItemRow {
  id: string;
  recipient: string;
  sender: string;
  kind: string;
  ref: string | null;
  body: string;
  state: string;
  created_at: number;
  delivered_at: number | null;
  closed_at: number | null;
  outcome: string | null;
  note: string | null;
  about: string;
}

/** Each conversation's entry count and newest answer, from one grouped query on items_about. */
function conversations(db: Db): Map<string, { n: number; answered: number | null }> {
  const rows = db
    .prepare(`SELECT about, COUNT(*) + SUM(CASE WHEN ${LEAD_ANSWER} THEN 1 ELSE 0 END) AS n, MAX(${ANSWER_AT}) AS answered FROM items WHERE about IS NOT NULL AND kind IN ('owner.message','owner.cos','cos.reply') GROUP BY about`)
    .all() as { about: string; n: number; answered: number | null }[];
  return new Map(rows.map((r) => [r.about, { n: r.n, answered: r.answered }]));
}

/** The owner's message's state on its line (D6): what the dot line under it says, and whether Resend shows. */
function stateOf(row: ItemRow, src: FeedSource, answered: boolean): { state: string; tone: "ok" | "warn" | null; resend: boolean } {
  // batched, a message stays pending until its recipient's digest is acked: it went out with the wake
  const r = src.batched && row.state === "pending" ? { ...row, state: "delivered", delivered_at: row.delivered_at ?? row.created_at } : row;
  const late = (since: number | null) => src.now - (since ?? r.created_at) >= src.resendMs;
  if (r.kind === "owner.cos") {
    if (answered) return { state: "answered", tone: "ok", resend: false };
    if (r.state === "dead") return { state: "no reply yet", tone: "warn", resend: true };
    if (r.state === "pending") return { state: "sent", tone: null, resend: false };
    if (r.state === "queued") return { state: "queued", tone: null, resend: false };
    const read = r.state === "closed" || src.batchReadAt(r.id) !== null;
    if (late(r.delivered_at ?? r.closed_at)) return { state: read ? "read · no reply yet" : "no reply yet", tone: "warn", resend: true };
    return { state: read ? "read" : "delivered", tone: null, resend: false };
  }
  const held = src.heldProjects.has(r.recipient.slice("lead:".length));
  if (r.state === "closed") return answered ? { state: "answered", tone: "ok", resend: false } : { state: `acked: ${r.outcome ?? "done"}`, tone: null, resend: false };
  if (r.state === "dead") return { state: "no reply · with the CoS", tone: "warn", resend: true };
  if (held) return { state: "waits · on hold", tone: null, resend: false };
  if (r.state === "pending" || r.state === "queued") return { state: "sent", tone: null, resend: false };
  if (late(r.delivered_at)) return { state: "no reply yet", tone: "warn", resend: true };
  return { state: "delivered", tone: null, resend: false };
}

/** A deliverable's revision at a time: the newest delivered by then. */
function revAt(revs: { rev: number; at: number }[] | undefined, at: number): number | null {
  if (!revs?.length) return null;
  let r = revs[0]!.rev;
  for (const x of revs) if (x.at <= at) r = x.rev;
  return r;
}

/** One conversation's entries, oldest first: each owner message, then the answer it got. */
function entries(rows: ItemRow[], src: FeedSource, revs: Map<string, { rev: number; at: number }[]>, images: Map<string, number>): FeedMsg[] {
  const replied = new Set(rows.filter((r) => r.kind === "cos.reply" && r.ref).map((r) => r.ref!));
  const out: FeedMsg[] = [];
  for (const r of rows) {
    const rv = revAt(revs.get(r.about), r.created_at);
    if (r.kind === "cos.reply") {
      out.push({ id: r.id, who: r.sender, text: r.body, at: r.created_at, rev: rv, state: null, tone: null, resend: false, images: 0, isNew: r.created_at > src.seen });
      continue;
    }
    const leadAnswer = r.kind === "owner.message" && r.state === "closed" && !!r.note?.trim() && !(r.outcome === "superseded" && r.note === "project archived") && !r.note.startsWith("closed by ");
    const st = stateOf(r, src, r.kind === "owner.cos" ? replied.has(r.id) : leadAnswer);
    out.push({ id: r.id, who: "person", text: r.body, at: r.created_at, rev: rv, ...st, images: images.get(r.id) ?? 0, isNew: false });
    if (leadAnswer) out.push({ id: `${r.id}:a`, who: r.recipient, text: r.note!, at: r.closed_at ?? r.created_at, rev: revAt(revs.get(r.about), r.closed_at ?? r.created_at), state: null, tone: null, resend: false, images: 0, isNew: (r.closed_at ?? 0) > src.seen });
  }
  return out.sort((a, b) => a.at - b.at || (a.who === "person" ? -1 : 1));
}

const ITEM_COLS = `id, recipient, sender, kind, ref, body, state, created_at, delivered_at, closed_at, outcome, note, about`;

function imagesOf(db: Db, ids: string[]): Map<string, number> {
  if (!ids.length) return new Map();
  const rows = db.prepare(`SELECT item_id, COUNT(*) AS n FROM direct_images WHERE item_id IN (${ids.map(() => "?").join(",")}) GROUP BY item_id`).all(...ids) as { item_id: string; n: number }[];
  return new Map(rows.map((r) => [r.item_id, r.n]));
}

/** The newest FEED_SHOWN items of each conversation on the page, in one windowed query. */
function newest(db: Db, keys: string[]): Map<string, ItemRow[]> {
  const out = new Map<string, ItemRow[]>();
  if (!keys.length) return out;
  const rows = db
    .prepare(
      `SELECT ${ITEM_COLS} FROM (SELECT ${ITEM_COLS}, rowid AS rid, ROW_NUMBER() OVER (PARTITION BY about ORDER BY created_at DESC, rowid DESC) AS rn FROM items WHERE about IN (${keys.map(() => "?").join(",")}) AND kind IN ('owner.message','owner.cos','cos.reply')) WHERE rn <= ? ORDER BY created_at, rid`,
    )
    .all(...keys, FEED_SHOWN) as ItemRow[];
  for (const r of rows) out.set(r.about, [...(out.get(r.about) ?? []), r]);
  return out;
}

interface Cand {
  key: string;
  at: number;
  build: () => Omit<FeedPost, "activity" | "replies" | "thread" | "earlier" | "isNew" | "lineLive" | "held" | "self">;
}

const cardOf = (d: Decision): FeedPost["card"] => ({
  id: d.id,
  rev: d.rev,
  options: (d.ask?.options ?? d.request.options).map((o) => ({ id: o.id, label: o.label, detail: o.detail ?? "", recommended: !!o.recommended })),
  allowText: d.ask?.allow_text ?? true,
  merge: d.orchestrator.action === "merge",
});
const lineOfCard = (d: Decision) => (d.orchestrator.origin === "cos" ? "cos" : d.orchestrator.origin === "steward" || !d.project ? null : `lead:${d.project}`);
const authorOfCard = (d: Decision) => (d.orchestrator.origin === "cos" || d.orchestrator.origin === "steward" ? d.orchestrator.origin : d.project ? `lead:${d.project}` : d.orchestrator.origin);
const blank = { outcome: null, card: null, deliverable: null, status: null, url: null, prompt: null, to: null, scope: false, needsOwner: false } as const;

function cardCand(d: Decision, open: boolean, scope: boolean): Cand {
  return {
    key: `decision:${d.id}`,
    at: ms(d.returned?.at) || ms(d.ask?.at) || ms(d.created_at),
    build: () => ({
      ...blank,
      key: `decision:${d.id}`,
      kind: "card",
      author: authorOfCard(d),
      project: d.project,
      line: lineOfCard(d),
      title: d.ask?.title ?? d.request.title,
      text: one(d.ask?.question ?? d.request.question),
      at: ms(d.returned?.at) || ms(d.ask?.at) || ms(d.created_at),
      scope,
      needsOwner: open,
      card: open ? cardOf(d) : null,
      outcome: open ? null : d.answer ? `answered: ${d.answer.label ?? one(d.answer.text ?? "", 80)}` : d.state,
    }),
  };
}

function deliverableCand(d: Deliverable): Cand {
  const last = d.revisions.at(-1);
  const at = ms(last?.at) || d.createdAt;
  const shots = (last?.proof ?? []).filter((p) => p.kind === "image");
  return {
    key: `deliverable:${d.id}`,
    at,
    build: () => ({
      ...blank,
      key: `deliverable:${d.id}`,
      kind: "deliverable",
      author: d.lead,
      project: d.project,
      line: d.lead,
      title: d.title,
      text: one(last?.summary ?? d.summary),
      at,
      scope: !!d.scope,
      needsOwner: d.state === "review",
      outcome: d.state === "approved" ? `approved rev ${d.feedback.filter((f) => f.outcome === "approved").at(-1)?.rev ?? d.rev}` : d.state === "changes" ? "changes requested" : null,
      deliverable: { id: d.id, rev: d.rev, state: d.state, shots: shots.length, thumb: shots[0]?.id ?? null },
    }),
  };
}

/** One page, newest activity first: each source's newest posts plus each post a later answer lifted. */
export function feedPage(src: FeedSource, opts: { cursor: string | null; filter: FeedFilter; limit?: number }): FeedPage {
  const { db } = src;
  const limit = Math.max(1, Math.min(FEED_PAGE, opts.limit ?? FEED_PAGE));
  const [curAt, curKey] = opts.cursor ? [Number(opts.cursor.slice(0, opts.cursor.indexOf("|"))), opts.cursor.slice(opts.cursor.indexOf("|") + 1)] : [Number.POSITIVE_INFINITY, ""];
  const before = (at: number, key: string) => at < curAt || (at === curAt && key < curKey);
  const f = opts.filter;
  const want = (k: FeedKind) => f === "all" || (f === "needs" && (k === "card" || k === "prompt")) || (f === "delivered" && k === "deliverable") || (f === "alerts" && (k === "alarm" || k === "dead"));
  const held = (p: string | null) => !!p && src.heldProjects.has(p);
  const cands = new Map<string, Cand>();
  const add = (c: Cand) => cands.set(c.key, c);
  const top = Number.isFinite(curAt) ? curAt : Number.MAX_SAFE_INTEGER;

  // cards: the open ones as Needs you has them, the Scope tab's, and those the owner answered
  const openIds = new Set<string>();
  if (want("card")) {
    for (const d of src.openCards) if (!held(d.project)) (openIds.add(d.id), add(cardCand(d, true, false)));
    for (const d of src.scopeCards) if (!held(d.project)) (openIds.add(d.id), add(cardCand(d, true, true)));
    if (f === "all") {
      const rows = db.prepare(`SELECT json FROM decisions WHERE state IN ('answered','acked') AND json_extract(json, '$.answer.by') = 'person'`).all() as { json: string }[];
      const acted = rows.map((r) => JSON.parse(r.json) as Decision).filter((d) => !held(d.project) && !openIds.has(d.id)).map((d) => cardCand(d, false, !!d.orchestrator.scope));
      for (const c of acted.filter((c) => c.at < top).sort((a, b) => b.at - a.at).slice(0, limit + 1)) add(c);
    }
  }
  if (want("prompt"))
    for (const p of src.prompts)
      add({ key: `prompt:${p.id}`, at: ms(p.since), build: () => ({ ...blank, key: `prompt:${p.id}`, kind: "prompt", author: p.address, project: p.address.startsWith("lead:") ? p.address.slice(5) : null, line: null, title: p.title, text: "Waits on your answer in its thread.", at: ms(p.since), needsOwner: true, prompt: { threadId: p.threadId, id: p.id } }) });
  const revs = new Map<string, { rev: number; at: number }[]>();
  if (want("deliverable")) {
    const rows = db.prepare(`SELECT json FROM deliverables WHERE state != 'withdrawn' AND json_extract(json, '$.board') IS NULL ORDER BY updated_at DESC LIMIT 500`).all() as { json: string }[];
    for (const r of rows) {
      const d = JSON.parse(r.json) as Deliverable;
      if (held(d.project) || (d.state !== "review" && f !== "all" && f !== "delivered")) continue;
      revs.set(`deliverable:${d.id}`, d.revisions.map((x) => ({ rev: x.rev, at: ms(x.at) })));
      const c = deliverableCand(d);
      if (c.at < top || d.state === "review") add(c);
    }
  }
  if (f === "all") {
    // the Lead status card: one post per project, replaced as the lead updates it
    const rows = db.prepare(`SELECT s.project, s.address, s.json, s.updated_at FROM lead_status s JOIN projects p ON p.slug = s.project WHERE p.archived_at IS NULL`).all() as { project: string; address: string; json: string; updated_at: number }[];
    for (const r of rows) {
      const s = JSON.parse(r.json) as LeadStatus;
      if (!s.update) continue;
      const at = s.update.updateAt ?? r.updated_at;
      const cur = s.steps.findIndex((x) => x.state === "current");
      add({
        key: `status:${r.project}`,
        at,
        build: () => ({ ...blank, key: `status:${r.project}`, kind: "status", author: `lead:${r.project}`, project: r.project, line: `lead:${r.project}`, title: s.update!.workingOn[0] ?? s.goal, text: s.update!.workingOn.slice(1).join(" · "), at, outcome: s.steps.length ? (cur >= 0 ? `step ${cur + 1} of ${s.steps.length}` : `all ${s.steps.length} steps done`) : null, status: { steps: s.steps.map((x) => ({ title: x.title, state: x.state })), needs: s.update!.needs || null } }),
      });
    }
    const merges = db.prepare(`SELECT ref, project, note, MAX(at) AS at FROM events WHERE kind = 'pr' AND value = 'merged' AND ref IS NOT NULL AND at < ? GROUP BY ref ORDER BY at DESC LIMIT ?`).all(top, limit + 1) as { ref: string; project: string | null; note: string | null; at: number }[];
    for (const m of merges) {
      if (held(m.project)) continue;
      add({ key: `merge:${m.ref}`, at: m.at, build: () => ({ ...blank, key: `merge:${m.ref}`, kind: "merge", author: m.project ? `lead:${m.project}` : "orchestrator", project: m.project, line: m.project ? `lead:${m.project}` : null, title: `PR ${m.note ? `#${m.note} ` : ""}merged`, text: m.ref, at: m.at, url: m.ref }) });
    }
  }
  if (want("alarm")) {
    const rows = db.prepare(`SELECT id, kind, from_address, project, title, body, ref, at FROM board WHERE kind IN ('alarm','dead') AND at < ? ORDER BY at DESC LIMIT ?`).all(top, limit + 1) as { id: string; kind: string; from_address: string | null; project: string | null; title: string; body: string; at: number }[];
    for (const b of rows)
      add({ key: `board:${b.id}`, at: b.at, build: () => ({ ...blank, key: `board:${b.id}`, kind: b.kind === "dead" ? "dead" : "alarm", author: b.kind === "dead" ? (b.from_address ?? "cos") : "steward", project: b.project, line: b.kind === "dead" ? "cos" : null, title: b.title, text: one(b.kind === "alarm" ? "" : b.body.split("\n")[0] ?? ""), at: b.at }) });
  }
  if (f === "all") {
    // the owner's own posts: a message written with no post (the Projects tab, the docked bar, the Chat tab)
    const rows = db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE about >= 'msg:' AND about < 'msg;' AND about = 'msg:' || id AND created_at < ? ORDER BY created_at DESC LIMIT ?`).all(top, limit + 1) as ItemRow[];
    for (const r of rows) add(ownCand(r));
  }

  // every conversation answered before the cursor lifts its post onto the page, whatever the post's own time
  const conv = conversations(db);
  for (const [key, c] of conv) {
    if (!c.answered || cands.has(key) || !before(c.answered, key)) continue;
    const lifted = candFor(db, src, key);
    if (lifted && want(lifted.build().kind)) {
      add(lifted);
      if (key.startsWith("deliverable:") && !revs.has(key)) revs.set(key, []);
    }
  }

  const activityOf = (c: Cand) => Math.max(c.at, conv.get(c.key)?.answered ?? 0);
  const sorted = [...cands.values()].map((c) => ({ c, activity: activityOf(c) })).filter((x) => before(x.activity, x.c.key));
  sorted.sort((a, b) => b.activity - a.activity || (a.c.key < b.c.key ? 1 : -1));
  const page = sorted.slice(0, limit);
  const more = sorted.length > limit;

  const keys = page.map((x) => x.c.key);
  for (const k of keys) if (k.startsWith("deliverable:") && !revs.get(k)?.length) revs.set(k, revsOf(db, k.slice("deliverable:".length)));
  const thread = newest(db, keys);
  const imgs = imagesOf(db, [...thread.values()].flat().filter((r) => r.kind !== "cos.reply").map((r) => r.id));
  const posts: FeedPost[] = page.map(({ c, activity }) => {
    const p = c.build();
    const conversation = conv.get(c.key);
    const rootId = p.kind === "message" ? p.key.slice(4) : null;
    const rows = thread.get(c.key) ?? [];
    const rootRow = rootId ? (rows.find((r) => r.id === rootId) ?? (db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`).get(rootId) as ItemRow | undefined)) : undefined;
    const all = entries(rootRow && !rows.includes(rootRow) ? [rootRow, ...rows] : rows, src, revs, imgs);
    const self = rootId ? (all.find((m) => m.id === rootId) ?? null) : null;
    const rest = all.filter((m) => m !== self);
    const shown = rest.slice(-FEED_SHOWN);
    const n = Math.max(0, (conversation?.n ?? 0) - (self ? 1 : 0));
    return { ...p, activity, isNew: p.needsOwner || activity > src.seen, held: held(p.project), lineLive: !!p.line && src.live(p.line), replies: n, thread: shown, earlier: Math.max(0, n - shown.length), self };
  });
  const lastRow = db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE sender = 'person' AND kind IN ('owner.message','owner.cos') ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as ItemRow | undefined;
  const lastMsg = lastRow ? entries([lastRow, ...(db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE kind = 'cos.reply' AND ref = ?`).all(lastRow.id) as ItemRow[])], src, new Map(), new Map())[0]! : null;

  const last = page.at(-1);
  const oldest = last ? last.activity : src.now;
  const leftOut =
    (db.prepare(`SELECT COUNT(*) AS n FROM items WHERE created_at >= ? AND kind NOT IN ('owner.message','owner.cos','cos.reply')`).get(oldest) as { n: number }).n +
    (db.prepare(`SELECT COUNT(*) AS n FROM board WHERE at >= ? AND kind NOT IN ('alarm','dead')`).get(oldest) as { n: number }).n;
  const reviewCount = (db.prepare(`SELECT COUNT(*) AS n FROM deliverables WHERE state = 'review' AND json_extract(json, '$.board') IS NULL`).get() as { n: number }).n;
  return {
    posts,
    cursor: more && last ? `${last.activity}|${last.c.key}` : null,
    seen: src.seen,
    newCount: opts.cursor ? 0 : sorted.filter((x) => x.activity > src.seen).length,
    counts: {
      needsYou: src.openCards.filter((d) => !held(d.project)).length + src.scopeCards.filter((d) => !held(d.project)).length + src.prompts.length,
      delivered: reviewCount,
      alerts: (db.prepare(`SELECT COUNT(*) AS n FROM board WHERE kind IN ('alarm','dead') AND at > ?`).get(src.seen) as { n: number }).n,
    },
    leftOut,
    now: src.now,
    last: lastRow && lastMsg ? { ...lastMsg, to: lastRow.recipient, about: lastRow.about } : null,
  };
}

function revsOf(db: Db, id: string): { rev: number; at: number }[] {
  const r = db.prepare(`SELECT json FROM deliverables WHERE id = ?`).get(id) as { json: string } | undefined;
  return r ? (JSON.parse(r.json) as Deliverable).revisions.map((x) => ({ rev: x.rev, at: ms(x.at) })) : [];
}

function ownCand(r: ItemRow): Cand {
  const cos = r.kind === "owner.cos";
  return {
    key: r.about,
    at: r.created_at,
    build: () => ({ ...blank, key: r.about, kind: "message", author: "person", project: cos ? null : r.recipient.slice(5), line: r.recipient, to: r.recipient, title: "", text: r.body, at: r.created_at }),
  };
}

/** A post by its key, for a conversation answered after its own time pushed it off its source's window. */
function candFor(db: Db, src: FeedSource, key: string): Cand | null {
  const id = key.slice(key.indexOf(":") + 1);
  if (key.startsWith("decision:")) {
    const r = db.prepare(`SELECT json FROM decisions WHERE id = ?`).get(id) as { json: string } | undefined;
    if (!r) return null;
    const d = JSON.parse(r.json) as Decision;
    const open = d.state === "asked" && !d.deferred;
    if (src.heldProjects.has(d.project ?? "") || (d.state !== "asked" && d.answer?.by !== "person") || (d.state === "asked" && !open)) return null;
    return cardCand(d, open, !!d.orchestrator.scope);
  }
  if (key.startsWith("deliverable:")) {
    const r = db.prepare(`SELECT json FROM deliverables WHERE id = ? AND state != 'withdrawn' AND json_extract(json, '$.board') IS NULL`).get(id) as { json: string } | undefined;
    return r ? deliverableCand(JSON.parse(r.json) as Deliverable) : null;
  }
  if (key.startsWith("msg:")) {
    const r = db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE id = ?`).get(id) as ItemRow | undefined;
    return r && r.about === key ? ownCand(r) : null;
  }
  if (key.startsWith("board:")) {
    const b = db.prepare(`SELECT id, kind, from_address, project, title, body, at FROM board WHERE id = ? AND kind IN ('alarm','dead')`).get(id) as { id: string; kind: string; from_address: string | null; project: string | null; title: string; body: string; at: number } | undefined;
    return b ? { key, at: b.at, build: () => ({ ...blank, key, kind: b.kind === "dead" ? "dead" : "alarm", author: b.kind === "dead" ? (b.from_address ?? "cos") : "steward", project: b.project, line: b.kind === "dead" ? "cos" : null, title: b.title, text: one(b.body.split("\n")[0] ?? ""), at: b.at }) } : null;
  }
  if (key.startsWith("merge:")) {
    const m = db.prepare(`SELECT ref, project, note, MAX(at) AS at FROM events WHERE kind = 'pr' AND value = 'merged' AND ref = ?`).get(id) as { ref: string | null; project: string | null; note: string | null; at: number | null } | undefined;
    return m?.ref ? { key, at: m.at!, build: () => ({ ...blank, key, kind: "merge", author: m.project ? `lead:${m.project}` : "orchestrator", project: m.project, line: m.project ? `lead:${m.project}` : null, title: `PR ${m.note ? `#${m.note} ` : ""}merged`, text: m.ref!, at: m.at!, url: m.ref }) } : null;
  }
  if (key.startsWith("status:")) {
    const r = db.prepare(`SELECT s.json, s.updated_at FROM lead_status s JOIN projects p ON p.slug = s.project WHERE s.project = ? AND p.archived_at IS NULL`).get(id) as { json: string; updated_at: number } | undefined;
    const s = r ? (JSON.parse(r.json) as LeadStatus) : null;
    if (!r || !s?.update) return null;
    const at = s.update.updateAt ?? r.updated_at;
    return { key, at, build: () => ({ ...blank, key, kind: "status", author: `lead:${id}`, project: id, line: `lead:${id}`, title: s.update!.workingOn[0] ?? s.goal, text: s.update!.workingOn.slice(1).join(" · "), at, status: { steps: s.steps.map((x) => ({ title: x.title, state: x.state })), needs: s.update!.needs || null } }) };
  }
  return null;
}

/** A post's conversation before `before` (null: all of it), oldest first, at most the newest `limit` entries. */
export function feedThread(src: FeedSource, about: string, before: number | null, limit = 100): { messages: FeedMsg[]; more: boolean } {
  const rows = src.db.prepare(`SELECT ${ITEM_COLS} FROM items WHERE about = ? AND kind IN ('owner.message','owner.cos','cos.reply') ORDER BY created_at, rowid`).all(about) as ItemRow[];
  const revs = new Map<string, { rev: number; at: number }[]>();
  if (about.startsWith("deliverable:")) revs.set(about, revsOf(src.db, about.slice("deliverable:".length)));
  const all = entries(rows, src, revs, imagesOf(src.db, rows.map((r) => r.id))).filter((m) => before === null || m.at < before);
  return { messages: all.slice(-limit), more: all.length > limit };
}

export interface CosLineEntry {
  kind: "owner" | "cos" | "hidden";
  msg: FeedMsg | null;
  re: string | null; // the post the owner's message quotes ("Re: …"), none for a post of its own
  hidden: number; // kind hidden: the orchestrator's mail to the CoS between two of the owner's messages
}

/** "You and the CoS": the owner's tracked messages and the CoS's replies, oldest first, with counts of mail between. */
export function cosLine(src: FeedSource, before: number | null, limit: number, titleOf: (about: string) => string | null): { entries: CosLineEntry[]; more: boolean } {
  const { db } = src;
  const rows = db
    .prepare(`SELECT ${ITEM_COLS} FROM items WHERE ((recipient = 'cos' AND kind = 'owner.cos') OR kind = 'cos.reply') AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(before ?? Number.MAX_SAFE_INTEGER, limit + 1) as ItemRow[];
  const page = rows.slice(0, limit).reverse();
  const msgs = entries(page, src, new Map(), imagesOf(db, page.map((r) => r.id)));
  const count = db.prepare(`SELECT COUNT(*) AS n FROM items WHERE recipient = 'cos' AND kind NOT IN ('owner.cos') AND created_at > ? AND created_at < ?`);
  const out: CosLineEntry[] = [];
  let prevOwner: number | null = null;
  for (const m of msgs) {
    const row = page.find((r) => r.id === m.id)!;
    if (m.who === "person") {
      if (prevOwner !== null) {
        const n = (count.get(prevOwner, m.at) as { n: number }).n;
        if (n) out.push({ kind: "hidden", msg: null, re: null, hidden: n });
      }
      prevOwner = m.at;
    }
    out.push({ kind: m.who === "person" ? "owner" : "cos", msg: m, re: m.who === "person" && !row.about.startsWith("msg:") ? titleOf(row.about) : null, hidden: 0 });
  }
  return { entries: out, more: rows.length > limit };
}
