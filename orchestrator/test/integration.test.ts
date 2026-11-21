import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, type DeliverResult } from "../core/engine.ts";
import { allowImport, integrationRoutes, type ExternalMail } from "../core/integration.ts";

function setup(queued = false) {
  let now = 1000000;
  let enabled = true;
  const db = new DatabaseSync(":memory:");
  const sent: string[] = [];
  const ports = { now: () => now, externalEnabled: () => enabled, deliver: async (_to: string, _text: string, it: { id: string }): Promise<DeliverResult> => { sent.push(it.id); return queued ? { delivery: "queued", queuedMessageId: `q-${it.id}` } : { delivery: "sent" }; }, mirror: () => {}, changed: () => {}, log: () => {} };
  const engine = new Engine(db as never, ports, { batchInbox: false });
  const cos = engine.register("cos", "cos", null);
  const mail: ExternalMail = { source: "fleet", id: "one", originalId: "legacy-one", to: "cos", sender: "worker", task: "task", severity: "NEEDS-COS", summary: "Review", body: "", refs: [], re: null, createdAt: now, dueAt: null, needsReply: true };
  return { engine, cos, mail, sent, disable: () => { enabled = false; }, advance: (ms: number) => { now += ms; }, reload: () => new Engine(db as never, ports, { batchInbox: false }) };
}

test("imports are idempotent across reload, with conflicting payloads rejected and source IDs retained", async () => {
  const s = setup();
  const item = s.engine.importMail(s.mail);
  const e = s.reload();
  assert.equal(e.importMail(s.mail).id, item.id);
  assert.throws(() => e.importMail({ ...s.mail, summary: "Different" }), /different content/);
  await e.flush();
  assert.deepEqual(s.sent, [item.id]);
  assert.equal(e.externalReceipts("fleet")[0]!.externalId, "one");
  assert.equal(e.externalReceipts("fleet")[0]!.readAt, null);
  assert.equal(e.needsYou().cards.length, 0, "NEEDS-COS does not become an owner card");
});

test("INFO stays visible in recovery without waking; deadline and needs-reply wake", async () => {
  const s = setup();
  const quiet = s.engine.importMail({ ...s.mail, severity: "INFO", needsReply: false });
  await s.engine.flush();
  assert.deepEqual(s.sent, []);
  assert.match(s.engine.inbox(s.cos).text, /Review/);
  const due = s.engine.importMail({ ...s.mail, id: "due", severity: "INFO", needsReply: false, dueAt: s.mail.createdAt + 1000 });
  await s.engine.flush();
  assert.deepEqual(s.sent, []);
  s.advance(1000);
  await s.engine.flush();
  assert.deepEqual(s.sent, [due.id]);
  const reply = s.engine.importMail({ ...s.mail, id: "reply", severity: "INFO" });
  await s.engine.flush();
  assert.deepEqual(s.sent, [due.id, reply.id]);
  assert.equal(s.engine.externalReceipts("fleet").find((r) => r.itemId === quiet.id)!.state, "pending");
});

test("newer imported tasks never supersede older tasks; completion requires an explicit outcome", async () => {
  const s = setup();
  const first = s.engine.importMail(s.mail);
  await s.engine.flush();
  s.advance(100);
  const second = s.engine.importMail({ ...s.mail, id: "two", task: "independent" });
  await s.engine.flush();
  s.engine.setStatus("cos", "idle");
  s.advance(11 * 60000);
  s.engine.tick();
  await s.engine.flush();
  for (const id of [first.id, second.id]) assert.equal(s.engine.externalReceipts("fleet").find((r) => r.itemId === id)!.outcome, null);
  s.engine.ack(s.cos, first.id, "done", "handled with proof");
  const rows = s.engine.externalReceipts("fleet");
  assert.equal(rows[0]!.outcome, "done");
  assert.equal(rows[1]!.outcome, null);
});

test("missing queue rows after downtime are unknown, never proof of dispatch; cancellation stays truthful", async () => {
  const s = setup(true);
  const item = s.engine.importMail(s.mail);
  await s.engine.flush();
  const e = s.reload();
  e.reconcileQueued(() => false);
  assert.equal(e.externalReceipts("fleet")[0]!.state, "queued");
  assert.equal(e.externalReceipts("fleet")[0]!.deliveredAt, null);
  e.cancelled(`q-${item.id}`);
  assert.equal(e.externalReceipts("fleet")[0]!.state, "dead");
  assert.equal(e.externalReceipts("fleet")[0]!.deliveredAt, null);
});

test("receipt paging is bounded and routes fail closed", () => {
  const s = setup();
  s.engine.importMail(s.mail);
  s.engine.importMail({ ...s.mail, id: "two" });
  const first = s.engine.externalReceipts("fleet", 0, 1);
  assert.equal(s.engine.externalReceipts("fleet", first[0]!.sequence, 1)[0]!.externalId, "two");
  assert.throws(() => s.engine.externalReceipts("fleet", -1));
  assert.throws(() => s.engine.externalReceipts("fleet", 0, 101));
  assert.throws(() => allowImport(integrationRoutes("{}"), "fleet", "cos"), /not enabled/);
  assert.throws(() => integrationRoutes("broken"));
  assert.throws(() => allowImport(integrationRoutes('{"fleet":["cos"]}'), "fleet", "lead:alpha"));
  allowImport(integrationRoutes('{"fleet":["cos"]}'), "fleet", "cos");
});

test("full passive item text retains provenance and evidence, with recipient isolation", async () => {
  const s = setup();
  const mail = { ...s.mail, severity: "INFO", needsReply: false, summary: "x".repeat(400), refs: ["/approved/full-evidence.md"], re: "legacy-question", dueAt: s.mail.createdAt + 100000 };
  const item = s.engine.importMail(mail);
  await s.engine.flush();
  assert.deepEqual(s.sent, []);
  assert.match(s.engine.inbox(s.cos).text, /orch_inbox\(id=/);
  const text = s.engine.readItem(s.cos, item.id);
  for (const value of [mail.summary, mail.refs[0]!, "legacy-one", "legacy-question", String(mail.createdAt), String(mail.dueAt), "needsReply=false"]) assert.ok(text.includes(value), value);
  const other = s.engine.register("other", "lead", "other");
  assert.throws(() => s.engine.readItem(other, item.id), /own inbox/);
  assert.throws(() => s.engine.ack(other, item.id, "done", null), /not you/);
  assert.equal(s.engine.externalReceipts("fleet")[0]!.outcome, null);
});

test("a no-ref report or reply cannot close imported work", async () => {
  const s = setup();
  const lead = s.engine.register("lead", "lead", "alpha");
  const worker = s.engine.register("worker", "thread", "alpha", "lead");
  const item = s.engine.importMail({ ...s.mail, to: worker.address });
  await s.engine.flush();
  s.engine.setStatus(worker.threadId, "active");
  s.engine.report(worker, "Other work", "Unrelated report", null);
  s.engine.send(worker, lead.address, "Unrelated reply", null);
  assert.throws(() => s.engine.ack(lead, item.id, "done", null), /not you/);
  assert.equal(s.engine.externalReceipts("fleet")[0]!.outcome, null);
  s.engine.ack(worker, item.id, "done", "Proof for this item");
  assert.equal(s.engine.externalReceipts("fleet")[0]!.outcome, "done");
});

test("disabling external routes pauses pending deadlines and retries across restart, retaining receipts", async () => {
  const s = setup();
  const first = s.engine.importMail(s.mail);
  await s.engine.flush();
  s.engine.importMail({ ...s.mail, id: "later", severity: "INFO", needsReply: false, dueAt: s.mail.createdAt + 1000 });
  s.disable();
  s.advance(20 * 60000);
  const e = s.reload();
  e.setStatus("cos", "idle");
  s.advance(20 * 60000);
  e.tick();
  await e.flush();
  assert.deepEqual(s.sent, [first.id]);
  const receipts = e.externalReceipts("fleet");
  assert.ok(receipts.every((r) => r.paused));
  assert.equal(receipts[0]!.outcome, null);
  assert.equal(receipts[1]!.state, "pending");
});
