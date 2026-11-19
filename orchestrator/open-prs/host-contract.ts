// The Open PRs tab's and the PR waits' host methods: fixed, read-only GitHub reads run with the machine's own `gh` login
// (as bb's PR status does). Only these named reads exist: the server and the page can't pass a command, so nothing can
// write.
import { z } from "zod";
import { LOGIN_RE, PR_URL_RE, REPO_RE } from "../core/open-prs.ts";

const rawPr = z.object({
  url: z.string(), number: z.number(), title: z.string(), body: z.string(), repo: z.string(), draft: z.boolean(), updatedAt: z.string(),
  branch: z.string(), sha: z.string(), reviewDecision: z.string().nullable(), mergeable: z.string().nullable(), mergeState: z.string().nullable(),
  checks: z.string().nullable(), approvedBy: z.array(z.string()), required: z.number().nullable(),
  // the review states (2026-11-18): the author, people's reviews with their commit, and the people asked
  author: z.string().default(""), reviews: z.array(z.object({ login: z.string(), state: z.string(), sha: z.string() })).default([]), requested: z.array(z.string()).default([]),
});

// bb's PR-status reading shape (core/open-prs.ts BbPrReading)
const reading = z.union([
  z.object({
    outcome: z.literal("available"),
    pullRequest: z.object({
      url: z.string(),
      title: z.string().optional(),
      draft: z.boolean().optional(),
      sha: z.string().optional(),
      headCommittedAt: z.number().optional(),
      createdAt: z.number().optional(),
      checksPendingSince: z.number().optional(),
      reviews: z.array(z.object({ login: z.string(), state: z.string(), sha: z.string(), submittedAt: z.number().nullable() })).optional(),
      staleReviewDismissal: z.boolean().nullable().optional(),
      requiredApprovals: z.number().nullable().optional(),
      number: z.number().optional(),
      state: z.string(),
      attention: z.string().optional(),
      checks: z.object({ state: z.string().optional() }).optional(),
      review: z.object({ state: z.string().optional() }).optional(),
      mergeability: z.object({ state: z.string().optional(), mergeable: z.string().nullable().optional(), mergeStateStatus: z.string().nullable().optional() }).optional(),
    }),
  }),
  z.object({ outcome: z.literal("absent") }),
  z.object({ outcome: z.literal("unavailable"), message: z.string().optional() }),
]);

export const prHostDefs = {
  // every open PR the login authored, across repos (archived repos left out); at most 250
  "prs.open": { input: z.object({ login: z.string().regex(LOGIN_RE) }).strict(), output: z.object({ prs: z.array(rawPr), more: z.boolean() }), experimental_retryable: true },
  // one PR's changed files at its head
  "prs.files": {
    input: z.object({ url: z.string().regex(PR_URL_RE) }).strict(),
    output: z.object({ sha: z.string(), files: z.array(z.string()) }),
    experimental_retryable: true,
  },
  // a repo's CODEOWNERS and who reviewed its recently merged PRs, by files
  "prs.area": {
    input: z.object({ repo: z.string().regex(REPO_RE) }).strict(),
    output: z.object({ codeowners: z.string().nullable(), recent: z.array(z.object({ files: z.array(z.string()), reviewers: z.array(z.string()) })) }),
    experimental_retryable: true,
  },
  // one PR wait's PR, read by its URL (a PR no live environment shows)
  "prs.wait": { input: z.object({ url: z.string().regex(PR_URL_RE) }).strict(), output: reading, experimental_retryable: true },
  "prs.pathways": { input: z.object({ url: z.string().regex(PR_URL_RE) }).strict(), output: reading, experimental_retryable: true },
} as const;
