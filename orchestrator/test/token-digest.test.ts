// A digest says its ack rules once, in its header, not on every item (2026-11-19, tokens: the per-item ack lines and
// default-valued fields were about a fifth of each digest, and a digest is re-read on every later call of the turn).
// Each item must still carry what is its own: whether it needs an outcome, its ref, and a direct message's rules.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, type DeliverResult } from "../core/engine.ts";

function setup() {
  const clock = { t: Date.parse("2026-11-19T10:00:00Z") };
  const e = new Engine(
    new DatabaseSync(":memory:") as never,
    { now: () => clock.t, deliver: async (): Promise<DeliverResult> => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} },
    { batchInbox: true, inboxDebounceMs: 2000, resendMs: 10_000, owner: "Robin" },
  );
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-la", "lead", "kite");
  const other = e.register("T-lb", "lead", "wren");
  const worker = e.register("T-w1", "thread", "kite", "T-la");
  return { e, cos, lead, other, worker };
}

test("the ack rules are said once per digest, however many messages it holds", () => {
  const s = setup();
  for (let i = 0; i < 6; i++) s.e.send(s.worker, s.lead.address, `finding ${i}`, null);
  const { text, count } = s.e.batch.read(s.lead);
  assert.equal(count, 6);
  assert.equal(text.match(/stay open until orch_ack\(id, outcome\)/g)?.length, 1, "once, in the header");
  assert.doesNotMatch(text, /When handled/, "no per-item ack line");
  assert.doesNotMatch(text, /ref=null|dueAt=none|needsReply=false/, "no default-valued fields");
});

test("each message that needs an outcome is still marked, and a notice is not", () => {
  const s = setup();
  const m = s.e.send(s.worker, s.lead.address, "please review", null);
  s.e.ack(s.lead, m.id, "done", "looked"); // the worker gets a notice back
  const lead = s.e.batch.read(s.lead).text;
  assert.match(lead, new RegExp(`\\[${m.id}\\] message from ${s.worker.address}; ACTION; outcome\\n`));
  const worker = s.e.batch.read(s.worker).text;
  const note = worker.split("\n").find((l) => l.includes("] notice from"))!;
  assert.ok(note, "the ack note is in the worker's digest");
  assert.doesNotMatch(note, /outcome$/, "a notice needs no outcome: the cursor ack closes it");
  assert.match(note, new RegExp(`ref=${m.id}`), "it names the message it is about");
});

test("a copy is read-only, said once in the header only when the digest has one", () => {
  const s = setup();
  s.e.send(s.lead, s.other.address, "shared plan", null); // lead-to-lead is copied to the CoS
  const cos = s.e.batch.read(s.cos).text;
  assert.match(cos, /\] copy from lead:kite/);
  assert.match(cos, /Copies are read-only: no ack or reply\./);
  assert.doesNotMatch(s.e.batch.read(s.other).text, /Copies are read-only/);
});

test("the owner's message to the CoS keeps its reply rule inside the digest", () => {
  const s = setup();
  const it = s.e.ownerCosMessage("Is the kite release on track?");
  const { text } = s.e.batch.read(s.cos);
  assert.match(text, new RegExp(`\\[${it.id}\\] owner\\.cos from person; ACTION; outcome; needsReply\\n`));
  assert.match(text, new RegExp(`Answer it with orch_reply_owner\\(ref=${it.id}, text\\)`), "the CoS still learns how to answer it");
  assert.match(text, /It approves nothing\./);
});

test("a direct message keeps its own rules inside the digest", () => {
  const s = setup();
  const it = s.e.ownerMessage("kite", "Hold the release.");
  const { text } = s.e.batch.read(s.lead);
  assert.match(text, new RegExp(`direct message ${it.id} from Robin`));
  assert.match(text, /How to answer: orch_ack/);
  assert.match(text, /this is not an approval/i);
});
