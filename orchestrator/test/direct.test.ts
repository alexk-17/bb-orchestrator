// The owner's direct line to a lead (2026-11-16, PLAN 3): from the Projects row the owner writes to lead:<slug>, the
// lead answers by acking with a note, the CoS gets a read-only copy of both. Each test is one rule of PLAN 3.6 to 3.8 or
// the address rules of 3.1. The rules that matter most are the gates: a quick "merge it" typed on a phone must never
// become the go for a merge, a production change or a public push; those still need a card the owner answers. And
// the CoS, which routes everything else, must not be able to send the owner's word somewhere the owner didn't.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, type DeliverResult } from "../core/engine.ts";
import type { Item } from "../core/model.ts";

const T0 = Date.parse("2026-11-16T10:00:00Z");
const H = 3_600_000;

function setup() {
  const clock = { t: T0 };
  const sent: { threadId: string; text: string; item: Item }[] = [];
  const pushes: string[] = [];
  const db = new DatabaseSync(":memory:");
  const ports = {
    now: () => clock.t,
    async deliver(threadId: string, text: string, item: Item): Promise<DeliverResult> {
      sent.push({ threadId, text, item });
      return { delivery: "sent" };
    },
    mirror: () => {},
    changed: () => {},
    log: () => {},
    cardUp: () => pushes.push("cardUp"),
    delivered: () => pushes.push("delivered"),
  };
  const make = () => new Engine(db as never, ports as never, { batchInbox: false, owner: "Robin" });
  const e = make();
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "kite");
  e.register("T-other", "lead", "otter");
  e.register("T-w1", "thread", "kite", "T-lead");
  return { e, db, cos, lead, sent, pushes, make, advance: (ms: number) => (clock.t += ms), now: () => clock.t };
}
type S = ReturnType<typeof setup>;

/** Let the lead sit idle with the message unacked until the engine gives up on it: one resend, then a dead letter. */
async function ignore(s: S, id: string, rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await s.e.flush();
    s.e.setStatus("T-lead", "active");
    s.e.setStatus("T-lead", "idle");
    s.advance(24 * H);
    s.e.tick();
  }
  await s.e.flush();
  return s.e.items(500).find((x) => x.id === id)!;
}

test("3.1: the owner writes to a project's lead, needs ack, at most 4000 characters; no live lead or an archived project is refused", async () => {
  const s = setup();
  const it = s.e.ownerMessage("kite", "  Please pause the migration until Monday.  ");
  assert.equal(it.recipient, "lead:kite");
  assert.equal(it.sender, "person");
  assert.equal(it.kind, "owner.message");
  assert.equal(it.needsAck, true);
  assert.equal(it.body, "Please pause the migration until Monday.", "trimmed");
  assert.throws(() => s.e.ownerMessage("kite", "x".repeat(4001)), /at most 4000/);
  assert.throws(() => s.e.ownerMessage("kite", "   "), /empty/);
  assert.throws(() => s.e.ownerMessage("nope", "hi"), /no project/);
  s.e.retire("T-other");
  assert.throws(() => s.e.ownerMessage("otter", "hi"), /no live lead/, "nobody would read it: say so instead of queueing it");
  await s.e.flush();
  assert.deepEqual(s.sent.filter((x) => x.item.kind === "owner.message").map((x) => x.threadId), ["T-lead"], "only the lead, never its thread");
});

test("3.2: the message states its own rules, because a running lead keeps the role text it started with", async () => {
  const s = setup();
  const first = s.e.ownerMessage("kite", "Ship the checkout copy today.");
  const next = s.e.ownerMessage("kite", "Actually, wait for the legal review.", first.id);
  await s.e.flush();
  const text = s.sent.find((x) => x.item.id === next.id)!.text;
  assert.match(text, new RegExp(`direct message ${next.id} from Robin`));
  assert.match(text, new RegExp(`a follow-up of ${first.id}`), "the lead sees which message this one changes");
  assert.match(text, /orch_ack\(id=i-[0-9a-f]+, outcome, note\)/, "how to answer");
  assert.match(text, /for 48 h this word wins on its point over a CoS instruction/, "the conflict rule");
  assert.match(text, /this is not an approval/i, "the gates");
  assert.match(text, /needs its own card/);
  assert.throws(() => s.e.ownerMessage("otter", "follow-up to the wrong lead", first.id), /isn't a direct message to lead:otter/);
});

test("3.3 + 3.4: the lead answers by acking with a note; the row shows it, a new note is unread until the owner opens the thread", async () => {
  const s = setup();
  const it = s.e.ownerMessage("kite", "Can you drop the beta flag?");
  await s.e.flush();
  assert.equal(s.e.directLines().get("kite")!.messages[0]!.state, "delivered");
  assert.equal(s.e.directLines().get("kite")!.unread, false, "nothing to read yet");
  s.advance(60_000);
  s.e.ack(s.lead, it.id, "done", "Taken: dropping it in the next PR, about an hour.");
  const line = s.e.directLines().get("kite")!;
  assert.equal(line.messages[0]!.outcome, "done");
  assert.equal(line.messages[0]!.note, "Taken: dropping it in the next PR, about an hour.");
  assert.equal(line.unread, true, "the dot by the project's name");
  s.e.directLines(); // reading the row is not opening it
  assert.equal(s.e.directLines().get("kite")!.unread, true, "a render never marks it seen");
  s.e.markDirectSeen("kite", line.messages[0]!.answeredAt!);
  assert.equal(s.e.directLines().get("kite")!.unread, false);
  assert.equal(s.e.directLines().has("otter"), false, "no direct line before the first message");
});

test("3.4: no phone notification and no card for any of it: not the message, the copy or the note", async () => {
  const s = setup();
  const it = s.e.ownerMessage("kite", "Status?");
  await s.e.flush();
  s.e.ack(s.lead, it.id, "done", "On it.");
  await s.e.flush();
  s.e.tick();
  assert.deepEqual(s.pushes, [], "the push ports never fire");
  assert.equal(s.e.needsYou().cards.length, 0);
  assert.equal(s.e.items(500).filter((x) => x.recipient === "person").length, 0, "nothing is mailed to the owner");
});

test("3.5: the CoS gets a read-only copy of each message and each note; Activity keeps a row of both", async () => {
  const s = setup();
  const it = s.e.ownerMessage("kite", "Use the blue palette.");
  await s.e.flush();
  s.e.ack(s.lead, it.id, "done", "Switched; the screenshots follow.");
  await s.e.flush();
  const copies = s.sent.filter((x) => x.threadId === "T-cos").map((x) => x.item);
  assert.equal(copies.length, 2);
  assert.ok(copies.every((c) => c.kind === "copy" && !c.needsAck && c.ref === it.id));
  assert.match(copies[0]!.body, /Use the blue palette/);
  assert.match(copies[0]!.body, /lead:kite answers it, not you/);
  assert.match(copies[1]!.body, /Switched; the screenshots follow/);
  assert.deepEqual(s.e.board().filter((b) => b.kind === "direct").map((b) => b.ref), [it.id, it.id]);
});

test("3.6: for 48 h orch_inbox lists the message as in force, acked or not, and that survives an engine restart", async () => {
  const s = setup();
  const it = s.e.ownerMessage("kite", "Keep the old API until the partners migrate.");
  await s.e.flush();
  s.e.ack(s.lead, it.id, "done", "Kept; I told the CoS.");
  s.advance(47 * H);
  const again = s.make(); // a restart reads the same DB
  const text = again.inbox(again.agents().find((a) => a.address === "lead:kite")!).text;
  assert.match(text, /direct messages still in force/);
  assert.match(text, new RegExp(`${it.id}.*acked done.*Kept; I told the CoS`));
  s.advance(2 * H);
  assert.doesNotMatch(again.inbox(again.agents().find((a) => a.address === "lead:kite")!).text, /still in force/, "after 48 h the CoS's later word wins as usual");
});

test("3.7: 'merge it' approves nothing: the merge card stays with the owner, and the message id settles no card", async () => {
  const s = setup();
  const card = s.e.ask(s.lead, { title: "Merge #41?", question: "Merge the checkout PR?", options: [{ label: "Merge" }, { label: "Wait" }] });
  s.e.triageAskPerson(s.cos, card.id, { question: "kite: merge the checkout PR?", options: [{ label: "Merge" }, { label: "Wait" }], allowText: true });
  const it = s.e.ownerMessage("kite", "merge it");
  await s.e.flush();
  s.e.ack(s.lead, it.id, "done", "Filed it as a card citing this message.");
  assert.deepEqual(s.e.needsYou().cards.map((c) => c.id), [card.id], "only the owner's answer on the card is the go");
  assert.throws(() => s.e.leadAnswer(s.lead, it.id, null, "1", null));
  assert.throws(() => s.e.triageSettle(s.cos, it.id, "r-x", "1", null));
  assert.throws(() => s.e.approvedPlan(s.lead, it.id));
});

test("3.7: the engine refuses an ack bound to a PR on a direct message, before it closes anything", async () => {
  const s = setup();
  const it = s.e.ownerMessage("kite", "Ship it when CI is green.");
  await s.e.flush();
  assert.throws(() => s.e.ack(s.lead, it.id, "done", "will merge when green", { pr: "https://github.com/o/r/pull/41", when: "green" }), /not an approval: it can't be bound to a PR/);
  assert.equal(s.e.items(500).find((x) => x.id === it.id)!.state, "delivered", "still open: the lead must still answer it");
});

test("3.8: the CoS can resend or escalate a dead direct message, never re-route or close it", async () => {
  const s = setup();
  const it = s.e.ownerMessage("kite", "Rename the project to Falcon.");
  assert.equal((await ignore(s, it.id)).state, "dead", "no ack: sent once more, then with the CoS");
  assert.throws(() => s.e.reroute(s.cos, it.id, "lead:otter", null), /can't be re-routed/);
  assert.throws(() => s.e.reroute(s.cos, it.id, "thread:kite:1", null), /can't be re-routed/);
  assert.throws(() => s.e.closeDead(s.cos, it.id, "done", "handled"), /only that lead closes it/);
  assert.equal(s.e.resend(it.id, "cos").state, "pending");
  assert.equal((await ignore(s, it.id)).state, "dead");
  s.e.escalateDead(s.cos, it.id, "kite's lead isn't answering");
});

test("3.8: on hold a direct message waits without expiring, and the lead answers it after the resume", async () => {
  const s = setup();
  const it = s.e.ownerMessage("kite", "Don't touch billing.");
  await s.e.flush();
  s.e.setHold("kite", true);
  assert.equal((await ignore(s, it.id)).state, "delivered", "a day of hold doesn't turn it into a dead letter");
  s.e.setHold("kite", false);
  s.e.ack(s.lead, it.id, "done", "Noted.");
  assert.equal(s.e.items(500).find((x) => x.id === it.id)!.state, "closed");
});

test("3.8: when the lead retires, its unacked direct message passes to the next lead instead of dying", async () => {
  const s = setup();
  const it = s.e.ownerMessage("kite", "Start on the export feature.");
  await s.e.flush(); // delivered, never acked
  s.e.setHold("kite", true);
  const waiting = s.e.ownerMessage("kite", "And keep the CSV format."); // a held project's mail waits, still pending
  await s.e.flush();
  s.e.retire("T-lead");
  s.advance(48 * H);
  s.e.tick();
  for (const id of [it.id, waiting.id]) assert.notEqual(s.e.items(500).find((x) => x.id === id)!.state, "dead", `${id} is for kite's lead, whoever that is`);
  s.e.setHold("kite", false);
  s.sent.length = 0;
  const next = s.e.register("T-lead2", "lead", "kite");
  await s.e.flush();
  assert.deepEqual(s.sent.filter((x) => x.item.kind === "owner.message").map((x) => [x.item.id, x.threadId]).sort(), [[it.id, "T-lead2"], [waiting.id, "T-lead2"]].sort());
  s.e.ack(next, it.id, "done", "Picked up from the last lead.");
  assert.equal(s.e.directLines().get("kite")!.messages[0]!.note, "Picked up from the last lead.");
});

// ---------------------------------------------------------------- the Codex review's findings (2026-11-16)

test("3.7: no laundering: the CoS's copy and a lead's relay of a direct message can't be bound to a PR either", async () => {
  const s = setup();
  const it = s.e.ownerMessage("kite", "Merge it when CI is green.");
  await s.e.flush();
  const copy = s.e.items(500).find((x) => x.recipient === "cos" && x.ref === it.id)!;
  const wait = { pr: "https://github.com/o/r/pull/41", when: "green" };
  assert.throws(() => s.e.ack(s.cos, copy.id, "done", "will do", wait), /comes from .* not an approval/, "else the CoS gets 'carry it out now' when CI is green");
  const relay = s.e.send(s.lead, "thread:kite:1", "Robin says merge when green.", null, it.id);
  await s.e.flush();
  const worker = s.e.agents().find((a) => a.address === "thread:kite:1")!;
  assert.throws(() => s.e.ack(worker, relay.id, "done", "will merge", wait), /comes from .* not an approval/);
});

test("3.6: the in-force list carries the whole message: a restriction past character 300 still binds a new lead", async () => {
  const s = setup();
  const long = `${"Context on the rollout plan. ".repeat(12)}Do not deploy billing before Monday.`;
  assert.ok(long.length > 300);
  s.e.ownerMessage("kite", long);
  await s.e.flush();
  assert.match(s.e.inbox(s.lead).text, /Do not deploy billing before Monday\..*\n[\s\S]*still in force[\s\S]*Do not deploy billing before Monday/);
});

test("3.4: an answer to an older message is new too, and opening marks seen only up to the newest answer shown", async () => {
  const s = setup();
  const first = s.e.ownerMessage("kite", "First.");
  for (const t of ["Second.", "Third.", "Fourth.", "Fifth."]) (s.advance(60_000), s.e.ownerMessage("kite", t));
  await s.e.flush();
  s.advance(60_000);
  s.e.ack(s.lead, first.id, "done", "Answering the first one late.");
  const line = s.e.directLines().get("kite")!;
  assert.equal(line.unread, true, "beyond the four newest, still a dot");
  assert.equal(line.messages.find((m) => m.id === first.id)?.unread, true, "and the row gets it to show");
  const shownUpTo = line.messages.find((m) => m.id === first.id)!.answeredAt!;
  s.advance(60_000);
  const fifth = s.e.directLines().get("kite")!.messages[0]!;
  s.e.ack(s.lead, fifth.id, "done", "This one came after the page drew.");
  s.e.markDirectSeen("kite", shownUpTo);
  assert.equal(s.e.directLines().get("kite")!.unread, true, "the answer the owner never saw stays new");
  assert.deepEqual(s.e.directLines().get("kite")!.messages.filter((m) => m.unread).map((m) => m.id), [fifth.id]);
});

test("3.4: archiving closes a message but answers nothing: no dot, and an archived project has no direct line", async () => {
  const s = setup();
  s.e.ownerMessage("otter", "Wrap up.");
  await s.e.flush();
  s.e.archiveProject("otter");
  assert.equal(s.e.directLines().has("otter"), false);
  s.e.register("T-other2", "lead", "otter"); // brought back: the archive's closure is still no answer
  assert.equal(s.e.directLines().get("otter")!.unread, false);
});

test("3.8: a dead direct message passes to the next lead too, as a fresh delivery", async () => {
  const s = setup();
  const it = s.e.ownerMessage("kite", "Pick the vendor.");
  assert.equal((await ignore(s, it.id)).state, "dead");
  s.e.retire("T-lead");
  s.sent.length = 0;
  s.e.register("T-lead2", "lead", "kite");
  await s.e.flush();
  assert.deepEqual(s.sent.filter((x) => x.item.id === it.id).map((x) => x.threadId), ["T-lead2"]);
  assert.equal(s.e.items(500).find((x) => x.id === it.id)!.attempts, 1, "a new reader gets its own resend");
});

test("3.1: a lead whose bb thread is archived is no live lead: the message is refused, not held forever", () => {
  const s = setup();
  s.e.setStatus("T-lead", "archived");
  assert.throws(() => s.e.ownerMessage("kite", "Hello?"), /no live lead/);
});

test("3.4: on a live clock the answer's close and its record differ by a moment; opening the thread still clears the dot", async () => {
  const s = setup();
  const it = s.e.ownerMessage("kite", "Ping.");
  await s.e.flush();
  s.e.ack(s.lead, it.id, "done", "Pong.");
  s.db.prepare(`UPDATE items SET closed_at = closed_at - 3 WHERE id = ?`).run(it.id); // closed 3 ms before the event
  const m = s.e.directLines().get("kite")!.messages[0]!;
  s.e.markDirectSeen("kite", m.answeredAt!);
  assert.equal(s.e.directLines().get("kite")!.unread, false);
});

// The chat log reads its own history (1.10.0) so the Projects read stays at a few messages per row: newest first in
// pages, "Older" continues from the oldest shown with nothing skipped or repeated, and only this project's messages.
test("the chat's history pages back through every message with a before-cursor, one project only", () => {
  const s = setup();
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    s.advance(60_000);
    ids.push(s.e.ownerMessage("kite", `m${i}`).id);
  }
  s.e.ownerMessage("otter", "elsewhere");
  const first = s.e.directHistory("kite", null, 3);
  assert.deepEqual(first.messages.map((m) => m.text), ["m4", "m3", "m2"]);
  assert.equal(first.more, true);
  const older = s.e.directHistory("kite", first.messages.at(-1)!.at, 3);
  assert.deepEqual(older.messages.map((m) => m.text), ["m1", "m0"]);
  assert.equal(older.more, false);
  assert.throws(() => s.e.directHistory("nope", null, 3), /no project/);
});
