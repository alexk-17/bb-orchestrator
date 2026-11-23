import test from "node:test";
import assert from "node:assert/strict";
import { localPathwaysMap, type LocalPathwaysInput, type LocalPathwaysPr } from "../core/pathways-local.ts";
import type { LeadStatus } from "../core/status.ts";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const status = (steps: { title: string; state: "done" | "current" | "next" }[]) => ({ steps, by: "lead:demo", blockers: [] }) as unknown as LeadStatus;
const pr = (number: number, fields: Partial<LocalPathwaysPr> = {}): LocalPathwaysPr => ({
  url: `https://github.com/example-org/demo-app/pull/${number}`,
  number,
  state: "open",
  checks: "passing",
  review: "approved",
  attention: null,
  ...fields,
});
const input = (fields: Partial<LocalPathwaysInput>): LocalPathwaysInput => ({
  slug: "demo",
  status: null,
  threads: [],
  decisions: [],
  prs: [],
  deliverables: [],
  waits: [],
  now: NOW,
  ...fields,
});
const prState = (map: ReturnType<typeof localPathwaysMap>, number: number) =>
  map.tickets.flatMap((t) => t.prs).find((entry) => entry.pr.number === number)?.pr.state;

// "Ready" tells the owner a PR can merge now. The engine already decides that from GitHub's mergeability, checks,
// review and the merge queue, and stores its word in attention; Pathways must repeat it, never re-derive a looser one.
test("a Pathways PR is ready only when the engine's own reading says ready_to_merge: an approved, passing PR with conflicts is not", () => {
  const map = localPathwaysMap(input({
    prs: [
      pr(1, { attention: "conflicts" }),
      pr(2, { attention: "ready_to_merge" }),
      pr(3, { attention: null }),
      pr(4, { state: "draft", attention: "ready_to_merge" }),
    ],
  }));
  assert.equal(prState(map, 1), "blocked", "conflicts block the merge whatever the review and checks say");
  assert.equal(map.tickets.find((t) => t.identifier === "PR-1")?.displayState, "blocked");
  assert.match(map.tickets.find((t) => t.identifier === "PR-1")?.pr?.reason ?? "", /conflicts/);
  assert.equal(prState(map, 2), "ready", "the engine's ready_to_merge is ready");
  assert.equal(prState(map, 3), "blocked", "approved and passing with no mergeability reading yet is not a guess at ready");
  assert.equal(prState(map, 4), "blocked", "a draft is never ready");
});

// A finished plan with an open PR is not finished: the PR still needs the owner. Hanging it on a done step hides it
// under Hide done, and the page then says everything is done.
test("on a plan whose steps are all done, an open PR no thread owns gets its own open node, not the last done step", () => {
  const map = localPathwaysMap(input({
    status: status([{ title: "Design", state: "done" }, { title: "Build", state: "done" }]),
    prs: [pr(7, { attention: "conflicts" }), pr(8, { attention: "ready_to_merge" })],
  }));
  const steps = map.tickets.filter((t) => t.type === "step");
  assert.ok(steps.every((t) => t.displayState === "done" && t.prs.length === 0), "no PR rides on a done step");
  const open = map.tickets.filter((t) => t.displayState !== "done");
  assert.deepEqual(open.map((t) => t.identifier).sort(), ["PR-7", "PR-8"], "with done hidden, both PRs still show");
  assert.equal(open.find((t) => t.identifier === "PR-8")?.displayState, "ready");
});

test("while a step is still current, an unmatched open PR rides on that step as before", () => {
  const map = localPathwaysMap(input({
    status: status([{ title: "Design", state: "done" }, { title: "Build", state: "current" }]),
    prs: [pr(9, { attention: "ready_to_merge" })],
  }));
  assert.deepEqual(map.tickets.find((t) => t.identifier === "STEP-2")?.prs.map((entry) => entry.pr.number), [9]);
  assert.equal(map.tickets.some((t) => t.type === "pr"), false);
});
