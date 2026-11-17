import { test } from "node:test";
import assert from "node:assert/strict";
import { makeQueueGitHub, type Run } from "../review-queue/host.ts";
const url = "https://github.com/acme/app/pull/1";
const user = { login: "owner", type: "User" };
const bot = { login: "coderabbitai[bot]", type: "Bot" };
const input = { url, head: "abc", login: "owner", auto: false, dryRun: true };
const response = (value: unknown) => ({
  stdout: JSON.stringify(value),
  stderr: "",
  code: 0,
});
function fake(
  opts: {
    post?: "fail" | "unknown" | "landed";
    reviews?: unknown[];
    checks?: string[];
    threadError?: boolean;
  } = {},
) {
  let writes = 0;
  let written = false;
  const run: Run = async (args) => {
    if (args.includes("POST")) {
      writes++;
      written = true;
      return opts.post === "fail"
        ? { stdout: "", stderr: "HTTP 403 Forbidden", code: 1 }
        : { stdout: "", stderr: "connection reset", code: 1 };
    }
    if (args[0] === "pr")
      return response((opts.checks ?? ["pass"]).map((bucket) => ({ bucket })));
    if (args.includes("graphql"))
      return response({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{ isResolved: false }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
        ...(opts.threadError ? { errors: [{ message: "incomplete" }] } : {}),
      });
    const path = args[1]!;
    if (path === "user") return response(user);
    if (path === "repos/acme/app/pulls/1")
      return response({
        title: "A PR",
        head: { sha: "abc" },
        user,
        state: "open",
        merged: false,
        draft: false,
        mergeable: true,
        mergeable_state: "clean",
      });
    if (path.includes("/reviews?")) return response(opts.reviews ?? []);
    if (path.includes("/comments?"))
      return response(
        written && opts.post === "landed"
          ? [
              {
                user,
                body: "@coderabbitai review",
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                html_url: url + "#issuecomment-123",
              },
            ]
          : [],
      );
    throw new Error(`Unexpected command ${args.join(" ")}`);
  };
  return { github: makeQueueGitHub(run), writes: () => writes };
}
test("host dry-run revalidates but performs zero GitHub writes", async () => {
  const t = fake();
  assert.equal((await t.github.post(input)).outcome, "dry_run");
  assert.equal(t.writes(), 0);
});
test("host refuses changed identity or head even when live was requested", async () => {
  const t = fake();
  assert.equal(
    (await t.github.post({ ...input, dryRun: false, head: "old" })).outcome,
    "post_failed",
  );
  assert.equal(
    (await t.github.post({ ...input, dryRun: false, login: "other" })).outcome,
    "post_failed",
  );
  assert.equal(t.writes(), 0);
});
test("host skips a CodeRabbit COMMENTED review on current head", async () => {
  const t = fake({
    reviews: [
      {
        user: bot,
        state: "COMMENTED",
        commit_id: "abc",
        submitted_at: new Date().toISOString(),
      },
    ],
  });
  assert.equal(
    (await t.github.post({ ...input, dryRun: false })).outcome,
    "post_failed",
  );
  assert.equal(t.writes(), 0);
});
test("host auto mode waits for pending required checks", async () => {
  const t = fake({ checks: ["pending"] });
  assert.equal(
    (await t.github.post({ ...input, auto: true, dryRun: false })).outcome,
    "post_failed",
  );
  assert.equal(t.writes(), 0);
});
test("partial GraphQL responses refuse a trigger", async () => {
  const t = fake({ threadError: true });
  await assert.rejects(
    t.github.post({ ...input, dryRun: false }),
    /Incomplete/,
  );
  assert.equal(t.writes(), 0);
});
test("ambiguous write is reconciled once and never reposted", async () => {
  for (const post of ["fail", "unknown", "landed"] as const) {
    const t = fake({ post });
    assert.equal(
      (await t.github.post({ ...input, dryRun: false })).outcome,
      post === "fail"
        ? "post_failed"
        : post === "landed"
          ? "posted"
          : "unknown",
    );
    assert.equal(t.writes(), 1);
  }
});
test("latest human opinion wins, author and bot approvals never count", async () => {
  const t = fake({
    reviews: [
      {
        user: { login: "peer", type: "User" },
        state: "APPROVED",
        commit_id: "abc",
        submitted_at: "2026-01-01",
      },
      {
        user: { login: "peer", type: "User" },
        state: "DISMISSED",
        commit_id: "abc",
        submitted_at: "2026-01-02",
      },
      { user, state: "APPROVED", commit_id: "abc", submitted_at: "2026-01-03" },
      {
        user: bot,
        state: "APPROVED",
        commit_id: "old",
        submitted_at: "2026-01-03",
      },
    ],
  });
  assert.equal((await t.github.inspect(url)).approvals, 0);
});
