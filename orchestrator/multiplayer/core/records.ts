import { z } from "zod";
import { fromJson } from "../../blocks.ts";
import { PR_URL_RE } from "../../core/open-prs.ts";
import { SLACK_PERMALINK_RE, SLACK_USER_RE } from "./boards.ts";

export const RECORD_STATES = ["reviewing", "replying", "waits", "done"] as const;
export type RecordState = (typeof RECORD_STATES)[number];
export const STEPS = ["asked", "thread", "review", "reply", "deliverable", "waits", "done"] as const;
export type Step = (typeof STEPS)[number];
export const REVIEW_URL_RE = /^https:\/\/[A-Za-z0-9.-]{1,253}\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/pull\/\d{1,9}#pullrequestreview-\d{1,15}$/;
export const PR_CLASS_MAX = 24;

export interface ReviewRecord {
  id: string;
  board: string;
  lead: string;
  project: string | null;
  wake: string | null;
  request: { permalink: string | null; at: number | null; asker: string | null };
  prs: { url: string; class: string | null }[];
  thread: string | null;
  reviews: string[];
  reply: string | null;
  deliverable: string | null;
  state: RecordState;
  note: string | null;
  times: Partial<Record<Step, number>>;
  createdAt: number;
  updatedAt: number;
}

const str = (max: number) => z.string().trim().min(1).max(max);
export const recordParams = z.object({
  id: str(40).optional().describe("The record to update (rr-…). Leave it out to file a new one"),
  board: str(500).optional().describe("New record: the board, by its id (mb-…), its channel id or a channel link"),
  wake: str(256).optional().describe("The wake that brought the request (its item id or the source's id); filing again with the same wake updates that record"),
  request: z
    .preprocess(fromJson, z.object({ permalink: str(500).optional(), at: z.union([z.number(), str(40)]).optional(), asker: str(40).optional() }))
    .optional()
    .describe("The request: its Slack permalink, when it was posted (ISO or epoch ms) and the asker's Slack user id (U…). Never its text"),
  prs: z
    .preprocess(fromJson, z.array(z.object({ url: str(300), class: z.string().trim().max(PR_CLASS_MAX).optional() })).max(20))
    .optional()
    .describe("The PRs asked about, each with its class (e.g. simple, review, risky). Added to the record's list; a PR given again gets its new class"),
  thread: str(120).optional().describe("The review thread's address (thread:<project>:<n>) or bb thread id"),
  reviews: z.preprocess(fromJson, z.array(str(500)).max(20)).optional().describe("GitHub review URLs (…/pull/<n>#pullrequestreview-<id>), added to the record's list"),
  reply: str(500).optional().describe("The Slack reply's permalink"),
  deliverable: str(40).optional().describe("The review's deliverable id (orch_deliver with board sets this too)"),
  state: z.enum(RECORD_STATES).optional().describe("reviewing, replying, waits (on the owner) or done"),
  note: z.string().trim().max(120).optional().describe("One short line in your words for the tab (never Slack text)"),
});
export type RecordInput = z.infer<typeof recordParams>;

const atOf = (v: number | string): number => {
  const n = typeof v === "number" ? v : /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`request.at ${JSON.stringify(v)} is not a time (ISO 8601 or epoch ms)`);
  return n;
};

/** `input` applied to `r` (a new record when null): checked, lists merged, each step's time set when it first appears. */
export function applyRecord(r: ReviewRecord, input: RecordInput, now: number): ReviewRecord {
  const out: ReviewRecord = { ...r, request: { ...r.request }, prs: r.prs.map((p) => ({ ...p })), reviews: [...r.reviews], times: { ...r.times }, updatedAt: now };
  const stamp = (s: Step, at = now) => void (out.times[s] ??= at);
  if (input.wake) out.wake = input.wake;
  if (input.request) {
    const q = input.request;
    if (q.permalink !== undefined) {
      if (!SLACK_PERMALINK_RE.test(q.permalink)) throw new Error("request.permalink is a Slack message link (https://<workspace>.slack.com/archives/<channel>/p<ts>)");
      out.request.permalink = q.permalink;
    }
    if (q.asker !== undefined) {
      if (!SLACK_USER_RE.test(q.asker)) throw new Error("request.asker is the asker's Slack user id (U…), never a name");
      out.request.asker = q.asker;
    }
    if (q.at !== undefined) out.request.at = atOf(q.at);
  }
  for (const p of input.prs ?? []) {
    if (!PR_URL_RE.test(p.url)) throw new Error(`${JSON.stringify(p.url)} is not a pull request URL`);
    const cls = p.class?.trim() || null;
    const had = out.prs.find((x) => x.url === p.url);
    if (had) had.class = cls ?? had.class;
    else out.prs.push({ url: p.url, class: cls });
  }
  for (const u of input.reviews ?? []) {
    if (!REVIEW_URL_RE.test(u)) throw new Error(`${JSON.stringify(u)} is not a GitHub review URL (…/pull/<n>#pullrequestreview-<id>)`);
    if (!out.prs.some((p) => u.startsWith(`${p.url}#`))) throw new Error(`${u} reviews a PR the record doesn't list: add it to prs`);
    if (!out.reviews.includes(u)) out.reviews.push(u);
  }
  if (input.thread) out.thread = input.thread;
  if (input.reply !== undefined) {
    if (!SLACK_PERMALINK_RE.test(input.reply)) throw new Error("reply is the Slack reply's message link");
    out.reply = input.reply;
  }
  if (input.deliverable) out.deliverable = input.deliverable;
  if (input.note !== undefined) out.note = input.note || null;
  if (input.state) out.state = input.state;
  if (out.request.at !== null) out.times.asked = out.request.at;
  if (out.thread) stamp("thread");
  if (out.reviews.length) stamp("review");
  if (out.reply) stamp("reply");
  if (out.deliverable) stamp("deliverable");
  if (out.state === "waits") stamp("waits");
  if (out.state === "done") stamp("done");
  return out;
}

export function newRecord(id: string, board: string, lead: string, project: string | null, now: number): ReviewRecord {
  return { id, board, lead, project, wake: null, request: { permalink: null, at: null, asker: null }, prs: [], thread: null, reviews: [], reply: null, deliverable: null, state: "reviewing", note: null, times: {}, createdAt: now, updatedAt: now };
}

export function prName(url: string): string {
  const m = /\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  return m ? `${m[2]}#${m[3]}` : url;
}
