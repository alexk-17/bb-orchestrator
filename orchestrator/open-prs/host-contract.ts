// The Open PRs tab's host methods: fixed, read-only GitHub reads run with the machine's own `gh` login (as bb's PR
// status does). Only these named reads exist: the server and the page can't pass a query, so nothing can write.
import { z } from "zod";
import { LOGIN_RE, REPO_RE } from "../core/open-prs.ts";

const rawPr = z.object({
  nodeId: z.string().optional(),
  reviewData: z.object({ author: z.string(), complete: z.boolean(), requested: z.array(z.string()), reviews: z.array(z.object({ login: z.string(), state: z.string(), sha: z.string() })) }).optional(),
  url: z.string(), number: z.number(), title: z.string(), body: z.string(), repo: z.string(), draft: z.boolean(), updatedAt: z.string(),
  branch: z.string(), sha: z.string(), reviewDecision: z.string().nullable(), mergeable: z.string().nullable(), mergeState: z.string().nullable(),
  checks: z.string().nullable(), approvedBy: z.array(z.string()), required: z.number().nullable(),
});

export const prHostDefs = {
  "prs.states": {
    input: z.object({ ids: z.array(z.string().min(1).max(128)).max(750) }).strict(),
    output: z.record(z.string(), z.enum(["OPEN", "CLOSED", "MERGED"])), experimental_retryable: true,
  },
  // every open PR the login authored, across repos (archived repos left out); paged, at most 250
  "prs.open": { input: z.object({ login: z.string().regex(LOGIN_RE) }).strict(), output: z.object({ prs: z.array(rawPr), more: z.boolean() }), experimental_retryable: true },
  // one PR's changed files at its head
  "prs.files": {
    input: z.object({ repo: z.string().regex(REPO_RE), number: z.number().int().positive() }).strict(),
    output: z.object({ sha: z.string(), files: z.array(z.string()) }),
    experimental_retryable: true,
  },
  // a repo's CODEOWNERS and who reviewed its recently merged PRs, by files
  "prs.area": {
    input: z.object({ repo: z.string().regex(REPO_RE) }).strict(),
    output: z.object({ codeowners: z.string().nullable(), recent: z.array(z.object({ files: z.array(z.string()), reviewers: z.array(z.string()) })) }),
    experimental_retryable: true,
  },
} as const;
