import { test } from "node:test";
import assert from "node:assert/strict";
import { route, checkBody, TOOL_DECLARATIONS } from "../voice/tools.ts";
import { board, reads } from "./voice-fixtures.ts";

test("reads are answered from the orchestrator's state", () => {
  const r = reads();
  const b = route("board", {}, r, "UTC");
  assert.equal(b.kind, "result");
  assert.equal((b as unknown as { response: { cards: unknown[] } }).response.cards.length, 3);
  assert.equal(route("card", { card_id: "D0002" }, r, "UTC").kind, "result");
  assert.equal(route("prs", { project: "alpha-api" }, r, "UTC").kind, "result");
  assert.equal(route("deliverables", {}, r, "UTC").kind, "result");
  assert.equal(route("lead_messages", { project: "alpha-api" }, r, "UTC").kind, "result");
  assert.deepEqual(r.calls.slice(0, 3), ["board", "card:D0002", "waits:alpha-api"]);
});

test("an unknown card or project is an error the voice can say, never a guess", () => {
  const r = reads();
  const out = route("card", { card_id: "NOPE" }, r, "UTC");
  assert.match(JSON.stringify(out), /no open card NOPE/);
  assert.match(JSON.stringify(route("tell_lead", { project: "gamma", text: "hi" }, r, "UTC")), /no project gamma/);
  assert.match(JSON.stringify(route("no_such_tool", {}, r, "UTC")), /no tool/);
});

test("every write goes to an owner route, with a body that route accepts and a one-line done", () => {
  const r = reads();
  const cases: [string, Record<string, unknown>, string][] = [
    ["answer_card", { card_id: "D0001", option: "2" }, "answer"],
    ["defer_card", { card_id: "D0001", until: "tomorrow" }, "defer"],
    ["tell_lead", { project: "alpha-api", text: "Go ahead" }, "directMessage"],
    ["tell_chief", { text: "Start a lead for beta-web" }, "cosMessage"],
    ["approve", { deliverable_id: "X1", next: "Ship it Friday" }, "approve"],
    ["request_changes", { deliverable_id: "X1", text: "Bigger buttons" }, "requestChanges"],
    ["set_priority", { project: "beta-web", priority: "urgent" }, "priority"],
    ["hold", { project: "beta-web", held: false }, "hold"],
    ["start_lead", { project: "beta-web" }, "startLead"],
  ];
  for (const [name, args, want] of cases) {
    const out = route(name, args, r, "Europe/Paris");
    assert.equal(out.kind, "write", `${name}: ${JSON.stringify(out)}`);
    const p = out as unknown as { route: string; body: Record<string, unknown>; card: string; done: string };
    assert.equal(p.route, want);
    assert.equal(checkBody(p.route as never, p.body), null, `${name} body`);
    assert.ok(p.done.length > 5 && !/say yes/i.test(p.done), `${name} done line: ${p.done}`);
  }
  const lead = route("tell_lead", { project: "alpha-api", text: "push the fix" }, r, "UTC") as unknown as { done: string };
  assert.equal(lead.done, "Sent to the alpha-api lead: push the fix");
});

test("a voice answer and defer carry via voice, the card's rev, and the page's zone", () => {
  const r = reads();
  const a = route("answer_card", { card_id: "D0001", option: "1", note: "keep it small" }, r, "UTC") as unknown as { body: Record<string, unknown>; done: string };
  assert.deepEqual(a.body, { id: "D0001", rev: 1, option: "1", text: "keep it small", via: "voice" });
  assert.match(a.done, /option 1, Small, "keep it small"/);
  const d = route("defer_card", { card_id: "D0001", until: "evening" }, r, "Asia/Tokyo") as { body: Record<string, unknown> };
  assert.equal(d.body.zone, "Asia/Tokyo");
  assert.equal(d.body.via, "voice");
});

test("an answer must name a real option", () => {
  const out = route("answer_card", { card_id: "D0001", option: "9" }, reads(), "UTC");
  assert.match(JSON.stringify(out), /has no option 9.*1=Small, 2=Large/);
});

test("asking the Chief is a question; telling the Chief to act is a write that waits for its reply", () => {
  const r = reads();
  const ask = route("ask_chief", { question: "Why is alpha-api slow?" }, r, "UTC");
  assert.equal(ask.kind, "ask");
  assert.match(JSON.stringify(ask), /\[voice\] Why is alpha-api slow\?/);
  const tell = route("tell_chief", { text: "Chase the CI on alpha-api" }, r, "UTC");
  assert.equal(tell.kind, "write");
  assert.equal((tell as { awaitChief: boolean }).awaitChief, true);
});

test("approve only a deliverable waiting for review", () => {
  const b = board();
  b.deliverables[0]!.state = "approved";
  assert.match(JSON.stringify(route("approve", { deliverable_id: "X1" }, reads(b), "UTC")), /waiting for review/);
});

test("the tool list has no search grounding and every tool has a description", () => {
  for (const t of TOOL_DECLARATIONS) assert.ok(t.description.length > 10, t.name);
  assert.ok(!TOOL_DECLARATIONS.some((t) => /search/i.test(t.name)));
});
