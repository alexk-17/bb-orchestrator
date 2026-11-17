// Shared PR reads and local copy history. No GitHub or Slack writes.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { LOGIN_RE, REPO_RE } from "../core/open-prs.ts";

/** Published when a GitHub read lands, so an open tab refetches. */
export const OPEN_PRS_CHANNEL = "open-prs";

const candidate = z.object({ name: z.string(), say: z.string(), owner: z.boolean(), recent: z.number() });

export const reviewBucket = z.enum(["needs-review", "needs-rereview", "approved"]);
export const snapshotPrSchema = z.object({
  url: z.string().url().max(2048), nodeId: z.string().max(128), repo: z.string().regex(REPO_RE), number: z.number().int().positive(),
  title: z.string().max(1024), bucket: reviewBucket.nullable(), sha: z.string().max(128), review: z.string().max(256),
  approvers: z.array(z.string().max(40)).max(100), ci: z.enum(["pass", "pending", "fail", "none"]),
}).strict();
const baseline = z.object({ at: z.number().int().nonnegative(), prs: z.array(snapshotPrSchema).max(250) });
export const copyHistorySchema = z.object({ "needs-review": baseline.optional(), "needs-rereview": baseline.optional(), approved: baseline.optional() });
export const rememberPrCopyInput = z.object({ login: z.string().regex(LOGIN_RE), section: reviewBucket.nullable(), prs: z.array(snapshotPrSchema).max(250) }).strict();

export const openPrSchema = z.object({
  nodeId: z.string().default(""),
  sha: z.string().default(""),
  approvers: z.array(z.string()).default([]),
  copySummary: z.string().default(""),
  author: z.string().default(""),
  bucket: z.enum(["needs-review", "needs-rereview", "approved"]).nullable().default(null),
  reviewers: z.array(z.string()).default([]),
  mentions: z.array(z.string()).default([]),
  url: z.string(),
  number: z.number(),
  title: z.string(),
  repo: z.string(),
  project: z.string().nullable(),
  lead: z.string().nullable(), // the project's lead address
  agent: z.string().nullable(), // the agent whose branch it is
  draft: z.boolean(),
  review: z.string(), // in words
  approved: z.boolean(),
  approvals: z.string(), // "1 of 2 approvals"
  ci: z.enum(["pass", "pending", "fail", "none"]),
  merge: z.string(), // in words
  summary: z.string(),
  needsReview: z.boolean(),
  excluded: z.boolean(), // its project is in reviewExcludedProjects
  updatedAt: z.string(),
  candidates: z.array(candidate), // suggested reviewers (needs-review PRs only)
});
export type OpenPr = z.infer<typeof openPrSchema>;

export const openPrsViewSchema = z.object({
  state: z.enum(["unset", "loading", "ok", "error"]),
  login: z.string(),
  error: z.string().nullable(), // the last read's failure (stale data kept)
  notes: z.array(z.string()), // settings that need fixing (bad JSON, bad channel)
  fetchedAt: z.number().nullable(),
  pollMinutes: z.number(),
  more: z.boolean(), // more open PRs than one read lists
  channel: z.object({ url: z.string(), name: z.string() }).nullable(),
  excluded: z.array(z.string()), // reviewExcludedProjects: their PRs start unticked in the Post preview
  prs: z.array(openPrSchema),
  copyHistory: copyHistorySchema.default({}),
  departed: z.record(z.string(), z.enum(["OPEN", "CLOSED", "MERGED"])).default({}),
});
export type OpenPrsView = z.infer<typeof openPrsViewSchema>;

export const openPrsContract = defineRpcContract({
  rememberPrCopy: { input: rememberPrCopyInput, output: copyHistorySchema },
  openPrs: { input: z.null(), output: openPrsViewSchema },
});
