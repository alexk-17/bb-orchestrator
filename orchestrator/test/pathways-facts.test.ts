import test from "node:test";
import assert from "node:assert/strict";
import { pathwaysMap, type PathwaysIssue } from "../core/pathways.ts";
import { blockedFact } from "../app/pathways-facts.ts";

const issue = (identifier: string, change: Partial<PathwaysIssue> = {}): PathwaysIssue => ({ identifier, title: identifier, url: `https://linear.app/test/issue/${identifier}`, description: "## Question\nChoose.", state: { type: "started", name: "In Progress" }, priority: 3, estimate: 2, assignee: null, labels: { nodes: [{ name: "wayfinder:task" }] }, parent: { identifier: "MAP-1" }, relations: { nodes: [] }, inverseRelations: { nodes: [] }, ...change });

// A row in What's next is read at a glance: a fact said twice reads as two problems. A blocked Linear task with no
// estimate showed "Blocked by T-1 · No estimate · No estimate · No acceptance criteria", once from the row's own
// estimate check and once from the ticket's unknowns.
test("a blocked Linear task with no estimate says 'No estimate' once on its What's next row", () => {
  const map = pathwaysMap(issue("MAP-1", { parent: null }), [
    issue("T-1"),
    issue("T-2", { estimate: null, inverseRelations: { nodes: [{ type: "blocks", issue: { identifier: "T-1", state: { type: "started" } } }] } as PathwaysIssue["inverseRelations"] }),
  ]);
  const ticket = map.tickets.find((t) => t.identifier === "T-2")!;
  assert.ok(ticket.unknown.includes("No estimate"), "the core already names the missing estimate");
  const row = blockedFact(ticket, map, "");
  assert.match(row, /^Blocked by T-1/);
  assert.equal(row.split(" · ").filter((part) => part === "No estimate").length, 1, row);
  assert.equal(new Set(row.split(" · ")).size, row.split(" · ").length, `each fact once: ${row}`);
});

test("a blocked task whose unknowns don't name the estimate still gets 'No estimate' from the row's own check", () => {
  const map = pathwaysMap(issue("MAP-1", { parent: null }), [issue("T-1")]);
  const ticket = { ...map.tickets[0]!, estimate: null, unknown: [], blockers: ["T-9"] };
  assert.equal(blockedFact(ticket, map, ""), "Blocked by T-9 · No estimate");
});
