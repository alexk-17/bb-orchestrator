// The owner's Start buttons, the pure parts: which repo a lead's threads get (PROJECT.md's "## Repos"), and the briefs. A
// wrong repo puts every thread of a project in the wrong worktrees; a placeholder left in a brief tells an agent
// nonsense about who it is.
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { BRIEF_VARS, BRIEFS, fillBrief, loadBrief, parseRepos, pokemonSentence, primaryRepo, samePath } from "../core/start.ts";

const BRIEF_DIR = join(import.meta.dirname, "..", "briefs");

test("the usual Repos line: the repo and its base branch", () => {
  const md = "# P\n\n## Goal\nShip it.\n\n## Repos\n- `/srv/repos/app`, base `dev`: the project's repo; threads branch from it.\n\n## How this project runs\n- `/srv/elsewhere` is not a repo of this project.\n";
  assert.deepEqual(primaryRepo(md), { path: "/srv/repos/app", base: "dev" });
  assert.equal(parseRepos(md).length, 1, "the section ends at the next ## heading");
});

test("backticked words that aren't absolute paths are not repos; the first path wins", () => {
  const md = [
    "## Repos",
    "- `/srv/repos/tooling` (tooling), base `main`: threads branch from `origin/main` and open their PR to `main`.",
    "- app and tooling also live on a laptop; nothing here changes them.",
    "- `/srv/second/` base `release`",
  ].join("\n");
  assert.deepEqual(parseRepos(md), [
    { path: "/srv/repos/tooling", base: "main" },
    { path: "/srv/second", base: "release" },
  ]);
});

test("a repo line without a base leaves the base to the repo's default", () => {
  assert.deepEqual(primaryRepo("## Repos\n\n* `/srv/app`\n"), { path: "/srv/app", base: null });
});

test("no repo: no section, a TOML-style [[repos]] table, or a section with no backticked path", () => {
  assert.equal(primaryRepo("# P\n\n## Goal\nx\n"), null);
  assert.equal(primaryRepo('goal = "x"\n[[repos]]\npath = "/srv/repos/app"\n'), null);
  assert.equal(primaryRepo("## Repos\n- app, on a laptop\n- `dev` only\n## Scope\n- `/srv/not-here`\n"), null);
  assert.equal(primaryRepo(""), null);
});

test("Repos is read only under its own heading, even after a ### subheading", () => {
  const md = "## Repository notes\n- `/wrong`\n## Repos\n### main\n- `/right`, base `dev`\n## Repos history\n- `/old`\n";
  assert.deepEqual(parseRepos(md), [{ path: "/right", base: "dev" }]);
});

test("a trailing slash doesn't make a different bb project folder", () => {
  assert.ok(samePath("/srv/repos/app/", "/srv/repos/app"));
  assert.ok(!samePath("/srv/repos/app-2", "/srv/repos/app"));
});

test("fillBrief fills every placeholder in one pass, so a value is never read as a placeholder", () => {
  assert.equal(fillBrief("{a} and {b}", { a: "{b}", b: "x" }), "{b} and x");
  assert.equal(fillBrief("JSON stays: { \"k\": 1 } and {Upper}", {}), "JSON stays: { \"k\": 1 } and {Upper}");
});

test("fillBrief refuses an unknown placeholder rather than send it to an agent", () => {
  assert.throws(() => fillBrief("You are {address}, {mon}.", { address: "lead:x" }), /\{mon\}/);
});

test("each real brief fills with exactly the variables the server passes, and says who the agent is", () => {
  const vars = { slug: "code-reviews", address: "lead:code-reviews", pokemon: pokemonSentence("Garchomp"), folder: "/srv/projects/code-reviews", repo: "/srv/repos/app", base: "dev", owner: "the owner" };
  for (const name of BRIEFS) {
    const given = Object.fromEntries(BRIEF_VARS[name].map((k) => [k, vars[k as keyof typeof vars]]));
    const text = loadBrief(BRIEF_DIR, name, given);
    assert.doesNotMatch(text, /\{[a-z][a-z0-9_]*\}/, `${name}: no placeholder left`);
    assert.match(text, /Garchomp/, `${name}: names its Pokémon`);
    assert.match(text, /\/srv\/projects\/code-reviews/, `${name}: names its folder`);
    assert.match(text, /the owner's orchestrator/, `${name}: names whose orchestrator it is`);
  }
});

test("the lead brief carries the rules a lead can't work without", () => {
  const text = loadBrief(BRIEF_DIR, "lead", { slug: "s", address: "lead:s", pokemon: "", folder: "/f", repo: "/r", base: "dev", owner: "the owner" });
  assert.match(text, /lead:s/);
  for (const must of ["PROJECT.md", "library/plan.md", "orch_ask(kind=plan", "orch_spawn_thread", "base_branch", "orch_deliver", "revises", "proof", "orch_resolve", "orch_handoff", "memory_search", "PROJECT.md win"]) {
    assert.ok(text.includes(must), `the lead brief mentions ${must}`);
  }
  assert.match(text, /worktree of \/r\. Base branch: dev\./);
});

test("the CoS and Steward briefs name only tools their role holds", () => {
  const cos = loadBrief(BRIEF_DIR, "cos", { pokemon: "", folder: "/s/cos", owner: "the owner" });
  assert.ok(!/orch_ask|orch_deliver|memory_search|orch_spawn_thread/.test(cos), "the CoS has no orch_ask, orch_deliver, memory or spawn tool");
  assert.match(cos, /orch_triage/);
  const st = loadBrief(BRIEF_DIR, "steward", { pokemon: "", folder: "/s/steward", owner: "the owner" });
  assert.match(st, /orch_cleanup/);
  assert.ok(!/memory_search|orch_spawn_thread/.test(st));
  // the owner's Go on the Steward's own cleanup card runs that card's commands, never more, and only after the re-checks
  assert.match(st, /answers the Go option on a cleanup card you filed, run exactly the commands that card listed/);
  assert.match(st, /0 processes[\s\S]*0 dirty[\s\S]*0 unpushed/);
  assert.match(st, /Remove a worktree, except as above/);
});

test("a missing brief file is refused with its path", () => {
  assert.throws(() => loadBrief("/nonexistent-briefs", "lead", {}), /\/nonexistent-briefs\/lead\.md/);
});
