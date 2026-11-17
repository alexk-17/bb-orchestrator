import { execFile } from "node:child_process";
import { z } from "zod";
import { redact } from "../cloud/core/mask.ts";
import {
  assess,
  cooldownUntil,
  parsePrUrl,
  replyOutcome,
  TRIGGER,
  type Comment,
  type Facts,
} from "./core.ts";
type Result = { stdout: string; stderr: string; code: number };
export type Run = (args: string[], signal?: AbortSignal) => Promise<Result>;
const clean = (s: string) =>
  redact(
    s.replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})/g,
      "[redacted]",
    ),
  ).slice(0, 800);
const run: Run = (args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      {
        signal,
        timeout: 45_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      },
      (e, stdout, stderr) => {
        if (signal?.aborted) return reject(new Error("GitHub read cancelled"));
        resolve({
          stdout,
          stderr: clean(stderr),
          code: e ? Number(e.code) || 1 : 0,
        });
      },
    );
  });
const user = z.object({ login: z.string(), type: z.string() });
const review = z.object({
  user: user.nullable(),
  state: z.string(),
  commit_id: z.string(),
  submitted_at: z.string().nullable(),
});
const comment = z.object({
  user: user.nullable(),
  body: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  html_url: z.string(),
});
const pull = z.object({
  title: z.string(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  draft: z.boolean(),
  head: z.object({ sha: z.string().min(1) }),
  user,
  mergeable: z.boolean().nullable(),
  mergeable_state: z.string(),
});
const stamp = (s: string | null) => (s ? Date.parse(s) || 0 : 0);
export function makeQueueGitHub(exec: Run = run) {
  async function json(args: string[], signal?: AbortSignal): Promise<unknown> {
    const r = await exec(args, signal);
    if (r.code) throw new Error(`GitHub read failed: ${r.stderr}`);
    return JSON.parse(r.stdout);
  }
  async function pages(path: string, signal?: AbortSignal): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 1; page <= 20; page++) {
      const rows = z
        .array(z.unknown())
        .parse(
          await json(["api", `${path}?per_page=100&page=${page}`], signal),
        );
      all.push(...rows);
      if (rows.length < 100) return all;
    }
    throw new Error(
      "GitHub pagination limit reached; no trigger from incomplete facts",
    );
  }
  async function identity(signal?: AbortSignal) {
    return user.parse(await json(["api", "user"], signal)).login;
  }
  async function comments(
    url: string,
    signal?: AbortSignal,
  ): Promise<Comment[]> {
    const { repo, number } = parsePrUrl(url);
    return z
      .array(comment)
      .parse(await pages(`repos/${repo}/issues/${number}/comments`, signal))
      .map((c) => ({
        author: c.user?.login ?? "",
        body: c.body,
        at: stamp(c.created_at),
        updatedAt: stamp(c.updated_at),
        url: c.html_url,
      }));
  }
  async function inspect(url: string, signal?: AbortSignal): Promise<Facts> {
    const { repo, number, url: canonical } = parsePrUrl(url);
    const login = await identity(signal);
    const p = pull.parse(
      await json(["api", `repos/${repo}/pulls/${number}`], signal),
    );
    const reviews = z
      .array(review)
      .parse(await pages(`repos/${repo}/pulls/${number}/reviews`, signal));
    const cs = await comments(url, signal);
    const checks = await exec(
      [
        "pr",
        "checks",
        String(number),
        "--repo",
        repo,
        "--required",
        "--json",
        "bucket",
      ],
      signal,
    );
    let ci: Facts["ci"] = "unknown";
    if (/no required checks/i.test(checks.stderr + checks.stdout)) ci = "pass";
    else if (checks.code === 0 || checks.code === 1 || checks.code === 8) {
      try {
        const rows = z
          .array(z.object({ bucket: z.string() }))
          .parse(JSON.parse(checks.stdout));
        ci = rows.some((r) => ["fail", "cancel"].includes(r.bucket))
          ? "fail"
          : rows.some((r) => r.bucket === "pending")
            ? "pending"
            : rows.every((r) => ["pass", "skipping"].includes(r.bucket))
              ? "pass"
              : "unknown";
      } catch {
        /* unreadable checks remain unknown */
      }
    }
    const [owner, name] = repo.split("/");
    let threads = 0;
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const query = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}`;
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${number}`,
        ...(after ? ["-f", `after=${after}`] : []),
      ];
      const r = z
        .object({
          data: z.object({
            repository: z.object({
              pullRequest: z.object({
                reviewThreads: z.object({
                  nodes: z.array(z.object({ isResolved: z.boolean() })),
                  pageInfo: z.object({
                    hasNextPage: z.boolean(),
                    endCursor: z.string().nullable(),
                  }),
                }),
              }),
            }),
          }),
          errors: z.array(z.unknown()).optional(),
        })
        .parse(await json(args, signal));
      if (r.errors?.length)
        throw new Error("Incomplete GitHub review threads response");
      const t = r.data.repository.pullRequest.reviewThreads;
      threads += t.nodes.filter((n) => !n.isResolved).length;
      if (!t.pageInfo.hasNextPage) break;
      if (
        page === 19 ||
        !t.pageInfo.endCursor ||
        after === t.pageInfo.endCursor
      )
        throw new Error("Incomplete review threads pagination");
      after = t.pageInfo.endCursor;
    }
    const rabbit = reviews
      .filter(
        (r) => r.user?.login === "coderabbitai[bot]" && r.state !== "PENDING",
      )
      .sort((a, b) => stamp(b.submitted_at) - stamp(a.submitted_at));
    const opinions = new Map<string, (typeof reviews)[number]>();
    for (const r of [...reviews].sort(
      (a, b) => stamp(a.submitted_at) - stamp(b.submitted_at),
    ))
      if (
        r.user?.type === "User" &&
        r.user.login.toLowerCase() !== p.user.login.toLowerCase() &&
        ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)
      )
        opinions.set(r.user.login.toLowerCase(), r);
    const summary = cs
      .filter(
        (c) =>
          c.author === "coderabbitai[bot]" &&
          /summarize by coderabbit.ai/i.test(c.body),
      )
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    const latest = rabbit[0];
    return {
      url: canonical,
      title: p.title.slice(0, 300),
      head: p.head.sha,
      author: p.user.login,
      state: p.merged ? "merged" : p.state,
      draft: p.draft,
      conflict: p.mergeable === false || p.mergeable_state === "dirty",
      ci,
      approvals: [...opinions.values()].filter(
        (r) => r.state === "APPROVED" && r.commit_id === p.head.sha,
      ).length,
      threads,
      reviewedHead: rabbit.some((r) => r.commit_id === p.head.sha),
      lastReview: latest
        ? {
            head: latest.commit_id,
            at: stamp(latest.submitted_at),
            state: latest.state,
          }
        : null,
      inProgressAt:
        summary && /review in progress by coderabbit.ai/i.test(summary.body)
          ? (summary.updatedAt ?? 0)
          : null,
      recentRequestAt:
        cs
          .filter(
            (c) =>
              c.author.toLowerCase() === login.toLowerCase() &&
              c.body.trim() === TRIGGER,
          )
          .sort((a, b) => b.at - a.at)[0]?.at ?? null,
    };
  }
  async function discover(signal?: AbortSignal) {
    const login = await identity(signal);
    const r = z
      .object({
        items: z.array(
          z.object({ pull_request: z.object({ html_url: z.string() }) }),
        ),
      })
      .parse(
        await json(
          [
            "api",
            "-X",
            "GET",
            "search/issues",
            "-f",
            `q=is:pr is:open archived:false author:${login}`,
            "-f",
            "sort=updated",
            "-f",
            "order=desc",
            "-F",
            "per_page=50",
          ],
          signal,
        ),
      );
    return r.items.map((i) => parsePrUrl(i.pull_request.html_url).url);
  }
  async function outcome(url: string, at: number, signal?: AbortSignal) {
    const cs = await comments(url, signal);
    const outcome = replyOutcome(cs, at);
    const summary = cs
      .filter(
        (c) =>
          c.author === "coderabbitai[bot]" &&
          /Next included review available in/i.test(c.body),
      )
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    return {
      outcome,
      cooldownUntil:
        outcome === "rate_limited"
          ? cooldownUntil(
              summary?.body ?? "",
              summary?.updatedAt ?? Date.now(),
              Date.now(),
            )
          : null,
    };
  }
  async function post(
    input: {
      url: string;
      head: string;
      login: string;
      auto: boolean;
      dryRun: boolean;
    },
    signal?: AbortSignal,
  ) {
    // No general command/body endpoint exists. All checks are repeated on the credential-owning host.
    const login = await identity(signal);
    const f = await inspect(input.url, signal);
    const a = assess(
      {
        url: input.url,
        auto: input.auto,
        pinned: false,
        addedAt: Date.now(),
        facts: f,
        error: null,
        fetchedAt: Date.now(),
      },
      null,
      login,
      Date.now(),
    );
    if (
      login.toLowerCase() !== input.login.toLowerCase() ||
      f.head !== input.head ||
      !a.eligible
    )
      return {
        outcome: "post_failed" as const,
        commentUrl: null,
        note: "Identity, head or eligibility changed; nothing posted",
      };
    if (input.dryRun)
      return {
        outcome: "dry_run" as const,
        commentUrl: null,
        note: "Dry-run: would request CodeRabbit review; nothing posted",
      };
    signal?.throwIfAborted();
    const { repo, number } = parsePrUrl(input.url);
    const at = Date.now();
    const r = await exec(
      [
        "api",
        "-X",
        "POST",
        `repos/${repo}/issues/${number}/comments`,
        "-f",
        `body=${TRIGGER}`,
      ],
      signal,
    );
    if (r.code === 0) {
      try {
        const c = comment.parse(JSON.parse(r.stdout));
        return {
          outcome: "posted" as const,
          commentUrl: c.html_url,
          note: "Review requested; waiting for CodeRabbit reply",
        };
      } catch {
        /* reconcile ambiguous success below */
      }
    }
    const cs = await comments(input.url, signal).catch(() => null);
    const landed = cs?.find(
      (c) =>
        c.author.toLowerCase() === login.toLowerCase() &&
        c.body.trim() === TRIGGER &&
        c.at >= at - 5000,
    );
    if (landed)
      return {
        outcome: "posted" as const,
        commentUrl: landed.url ?? null,
        note: "Posted; recovered comment after an ambiguous response",
      };
    const definite =
      cs !== null && /HTTP (400|401|403|404|422)\b/.test(r.stderr);
    return {
      outcome: definite ? ("post_failed" as const) : ("unknown" as const),
      commentUrl: null,
      note: definite
        ? "GitHub rejected the request; no matching comment found"
        : "Uncertain post result; held for 3 hours to avoid duplicates",
    };
  }
  return { identity, inspect, discover, outcome, post };
}
const github = makeQueueGitHub();
type Context = { signal: AbortSignal };
export const queueHandlers = {
  "reviewQueue.identity": (_: null, c: Context) => github.identity(c.signal),
  "reviewQueue.discover": (_: null, c: Context) => github.discover(c.signal),
  "reviewQueue.inspect": (a: { url: string }, c: Context) =>
    github.inspect(a.url, c.signal),
  "reviewQueue.outcome": (a: { url: string; at: number }, c: Context) =>
    github.outcome(a.url, a.at, c.signal),
  "reviewQueue.post": (a: Parameters<typeof github.post>[0], c: Context) =>
    github.post(a, c.signal),
};
