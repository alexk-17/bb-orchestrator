// The Open PRs tab's page contract: one read. The page never writes anything: Post copies text and opens Slack.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Published when a GitHub read lands, so an open tab refetches. */
export const OPEN_PRS_CHANNEL = "open-prs";

const candidate = z.object({ name: z.string(), say: z.string(), owner: z.boolean(), recent: z.number() });

export const openPrSchema = z.object({
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
});
export type OpenPrsView = z.infer<typeof openPrsViewSchema>;

export const openPrsContract = defineRpcContract({
  openPrs: { input: z.null(), output: openPrsViewSchema },
});
