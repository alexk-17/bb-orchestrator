import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Engine, type DeliverResult } from "../core/engine.ts";
import type { Agent, Item } from "../core/model.ts";
import { statusParams, STATUS_STALE_MS } from "../core/status.ts";

const GAP = 120_000;
const DEBOUNCE = 2000;
const T0 = Date.parse("2026-11-24T10:00:00Z");

function setup(gap = GAP) {
  const clock = { t: T0 };
  const sent: { threadId: string; text: string; at: number }[] = [];
  const ports = {
    now: () => clock.t,
    deliver: async (threadId: string, text: string, _item: Item): Promise<DeliverResult> => {
      sent.push({ threadId, text, at: clock.t });
      return { delivery: "sent" };
    },
    mirror: () => {},
    changed: () => {},
    log: () => {},
  };
  const e = new Engine(new DatabaseSync(":memory:") as never, ports as never, { owner: "Robin", batchInbox: true, inboxDebounceMs: DEBOUNCE, resendMs: 10 * 60_000, inboxGapMs: gap });
  const cos = e.register("T-cos", "cos", null);
  const steward = e.register("T-steward", "steward", null);
  const lead = e.register("T-lead", "lead", "kite");
  const worker = e.register("T-w1", "thread", "kite", "T-lead");
  for (const a of [cos, steward, lead, worker]) e.setStatus(a.threadId, "idle");
  const wakesOf = (a: Agent) => sent.filter((s) => s.threadId === a.threadId);
  /** What the wake timer and turn ends do: flush every second for `ms`. */
  const run = async (ms: number) => {
    for (let i = 0; i < ms / 1000; i++) {
      clock.t += 1000;
      await e.flush();
    }
  };
  /** A recipient handles its digest at once: reads it and acks the cursor, as the wake asks. */
  const handle = (a: Agent) => {
    const r = e.batch.read(a);
    if (r.cursor) e.batch.ack(a, r.cursor);
    return r;
  };
  return { e, clock, sent, cos, steward, lead, worker, wakesOf, run, handle };
}

test("a burst of 5 ACTION items in 30 s, soon after a wake, is one wake carrying all five", async () => {
  const s = setup();
  s.e.send(s.cos, s.lead.address, "earlier work", null);
  await s.run(3000);
  assert.equal(s.wakesOf(s.lead).length, 1);
  s.handle(s.lead);
  const burst: Item[] = [];
  for (let n = 1; n <= 5; n++) {
    burst.push(s.e.send(s.worker, s.lead.address, `question ${n}`, null));
    await s.run(7000); // 5 items over ~30 s, each acked digest would have been a turn before
  }
  await s.run(GAP);
  const after = s.wakesOf(s.lead).slice(1);
  assert.equal(after.length, 1, "the burst is one turn, not five");
  for (const it of burst) assert.ok(after[0]!.text.includes(it.id), `the wake carries ${it.id}`);
});

test("without the gap the same burst is five wakes: the gap is what saves the turns", async () => {
  const s = setup(0);
  s.e.send(s.cos, s.lead.address, "earlier work", null);
  await s.run(3000);
  s.handle(s.lead);
  for (let n = 1; n <= 5; n++) {
    s.e.send(s.worker, s.lead.address, `question ${n}`, null);
    await s.run(7000);
    s.handle(s.lead);
  }
  assert.equal(s.wakesOf(s.lead).length, 6);
});

test("a burst with no wake before it: the first item wakes after the debounce, the other four ride one more wake", async () => {
  const s = setup();
  for (let n = 1; n <= 5; n++) {
    s.e.send(s.worker, s.lead.address, `question ${n}`, null);
    await s.run(7000);
    if (n === 1) s.handle(s.lead); // the lead handles the wake it got
  }
  await s.run(GAP);
  const w = s.wakesOf(s.lead);
  assert.equal(w.length, 2);
  assert.equal(w[0]!.at - T0, 3000, "the first item is not held: a lead with no recent wake is woken after the debounce");
  assert.ok(w[1]!.at - w[0]!.at >= GAP, "the second wake keeps the gap");
});

test("the owner's direct message inside the gap wakes the lead at once", async () => {
  const s = setup();
  s.e.send(s.cos, s.lead.address, "earlier work", null);
  await s.run(3000);
  s.handle(s.lead);
  const first = s.wakesOf(s.lead)[0]!.at;
  await s.run(10_000);
  const it = s.e.ownerMessage("kite", "Stop the deploy.");
  await s.run(3000);
  const w = s.wakesOf(s.lead);
  assert.equal(w.length, 2, "the owner's word doesn't wait out the gap");
  assert.ok(w[1]!.at - first < 20_000);
  assert.ok(w[1]!.text.includes(it.id));
});

test("the owner's answer to a lead's card inside the gap wakes it at once", async () => {
  const s = setup();
  const card = s.e.ask(s.lead, { title: "Go?", question: "Go ahead?", options: [{ label: "Yes" }, { label: "No" }] });
  s.e.triageAskPerson(s.cos, card.id, { question: "Go ahead?", options: [{ label: "Yes" }, { label: "No" }], allowText: true });
  s.e.send(s.cos, s.lead.address, "earlier work", null);
  await s.run(3000);
  s.handle(s.lead);
  const n = s.wakesOf(s.lead).length;
  await s.run(5000);
  s.e.personAnswer(card.id, s.e.decision(card.id)!.rev, "1", null, "desktop");
  await s.run(3000);
  assert.equal(s.wakesOf(s.lead).length, n + 1);
  assert.match(s.wakesOf(s.lead).at(-1)!.text, /decision\.answer from person/);
});

test("an item whose deadline passes inside the gap wakes the lead at its deadline", async () => {
  const s = setup();
  s.e.send(s.cos, s.lead.address, "earlier work", null);
  await s.run(3000);
  s.handle(s.lead);
  const due = s.clock.t + 20_000;
  s.e.send(s.cos, s.lead.address, "answer by the deadline", null, null, { severity: "INFO", dueAt: due });
  await s.run(19_000);
  assert.equal(s.wakesOf(s.lead).length, 1, "an INFO item waits for its deadline");
  await s.run(3000);
  assert.equal(s.wakesOf(s.lead).length, 2, "and once it is due it doesn't wait out the gap");
  assert.ok(s.wakesOf(s.lead)[1]!.at - due <= DEBOUNCE + 1000);
});

test("a gap-held wake is written to its due time, so the wake timer fires for it", async () => {
  const s = setup();
  s.e.send(s.cos, s.lead.address, "earlier work", null);
  await s.run(3000);
  s.handle(s.lead);
  const first = s.wakesOf(s.lead)[0]!.at;
  s.e.send(s.worker, s.lead.address, "a report", null);
  await s.run(5000);
  const w = s.e.batch.wakes().find((x) => x.recipient === s.lead.address)!;
  assert.equal(w.state, "pending");
  assert.equal(w.due_at, first + GAP, "the timer arms for the earliest pending due_at in the future");
});

test("notices alone never wake a lead, even for hours, and ride with its next wake", async () => {
  const s = setup();
  s.e.notifySupervisor(s.worker, `finished a turn. Last words: "parser done"`);
  s.e.ack(s.worker, s.e.send(s.lead, s.worker.address, "do the parser", null).id, "done", "parser done");
  await s.run(5000);
  s.handle(s.worker);
  s.clock.t += 3 * 3_600_000;
  await s.run(5000);
  assert.equal(s.wakesOf(s.lead).length, 0, "a turn end and an ack notice start no turn");
  const real = s.e.send(s.cos, s.lead.address, "next task", null);
  await s.run(3000);
  const w = s.wakesOf(s.lead);
  assert.equal(w.length, 1);
  assert.match(w[0]!.text, /finished a turn/, "the turn end rides with the real wake");
  assert.match(w[0]!.text, /acked your message/, "so does the ack notice");
  assert.ok(w[0]!.text.includes(real.id));
});

test("a status nudge waits for a real turn after the publish, and never wakes the lead itself", async () => {
  const s = setup();
  s.e.publishStatus(s.lead, statusParams.parse({ steps: ["Build", "Ship"], waiting_on: "ci" }));
  s.clock.t += 60_000;
  s.e.setStatus(s.worker.threadId, "active"); // the project changes
  s.e.setStatus(s.worker.threadId, "idle");
  s.clock.t += STATUS_STALE_MS + 60_000;
  s.e.tick();
  const nudges = () => s.e.items(500).filter((i) => i.recipient === s.lead.address && i.body.startsWith("Your status on the project page"));
  assert.equal(nudges().length, 0, "no wake since the publish: the lead can't have moved on, so no nudge");
  await s.run(GAP);
  assert.equal(s.wakesOf(s.lead).length, 0);
  s.e.send(s.cos, s.lead.address, "real work", null);
  await s.run(3000);
  s.handle(s.lead);
  s.e.tick();
  assert.equal(nudges().length, 1, "after a real turn the stale status is nudged");
  await s.run(GAP * 3);
  assert.equal(s.wakesOf(s.lead).length, 1, "the nudge itself wakes no one");
  s.e.send(s.cos, s.lead.address, "more work", null);
  await s.run(3000);
  assert.match(s.wakesOf(s.lead)[1]!.text, /Your status on the project page/, "it rides with the next real wake");
});

test("no actionable item waits more than the gap plus the debounce for an idle lead that handles each wake", async () => {
  const s = setup();
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const items: Item[] = [];
  for (let sec = 0; sec < 30 * 60; sec++) {
    if (rnd() < 0.03) items.push(s.e.send(s.worker, s.lead.address, `item at ${sec}`, null));
    s.clock.t += 1000;
    await s.e.flush();
    if (s.wakesOf(s.lead).at(-1)?.at === s.clock.t) s.handle(s.lead);
  }
  await s.run(GAP + DEBOUNCE);
  assert.ok(items.length > 30, `a real stream: ${items.length} items`);
  const wakes = s.wakesOf(s.lead);
  for (const it of items) {
    const w = wakes.find((x) => x.text.includes(it.id));
    assert.ok(w, `${it.id} reached the lead`);
    assert.ok(w.at - it.createdAt <= GAP + DEBOUNCE + 1000, `${it.id} waited ${w.at - it.createdAt} ms`);
  }
  for (let i = 1; i < wakes.length; i++) assert.ok(wakes[i]!.at - wakes[i - 1]!.at >= GAP, "two wakes are never closer than the gap");
  assert.ok(wakes.length < items.length / 2, `${wakes.length} wakes for ${items.length} items`);
});

test("the CoS, the Steward and threads keep their wakes: the gap is for leads only", async () => {
  const s = setup();
  const lead2 = s.e.register("T-lead2", "lead", "otter");
  s.e.setStatus(lead2.threadId, "idle");
  for (const [to, from] of [
    [s.cos, s.lead],
    [s.worker, s.lead],
  ] as const) {
    for (let n = 1; n <= 3; n++) {
      s.e.send(from, to.address, `note ${n}`, null);
      await s.run(5000);
      s.handle(to);
    }
    assert.equal(s.wakesOf(to).length, 3, `${to.address} is woken for each, as before`);
  }
  for (let n = 1; n <= 3; n++) {
    s.e.alarm("warn", { disk: 90 + n }, `disk ${90 + n}%`);
    await s.run(5000);
    s.handle(s.steward);
  }
  assert.equal(s.wakesOf(s.steward).length, 3, "the Steward too");
});

test("the owner's Resend inside the gap goes at once", async () => {
  const s = setup();
  s.e.send(s.cos, s.lead.address, "work", null);
  await s.run(3000);
  assert.equal(s.wakesOf(s.lead).length, 1);
  s.e.batch.rewake(s.lead.address); // unacked: the owner presses Resend
  await s.run(2000);
  assert.equal(s.wakesOf(s.lead).length, 2);
});

test("a lead's successor after a handoff doesn't wait out its predecessor's gap", async () => {
  const s = setup();
  s.e.send(s.cos, s.lead.address, "work", null);
  await s.run(3000);
  s.handle(s.lead);
  s.e.send(s.cos, s.lead.address, "more work", null);
  const succ = s.e.takeOver(s.lead.threadId, "T-lead-2", "test handoff", { from: null, to: "claude-code" });
  s.e.setStatus(succ.threadId, "idle");
  await s.run(4000);
  assert.equal(s.wakesOf(succ).length, 1);
});

test("many held notices: the wake still says what it couldn't show, and orch_inbox reaches the actionable item", async () => {
  const s = setup();
  for (let n = 0; n < 60; n++) s.e.notifySupervisor(s.worker, `finished a turn. Last words: ${JSON.stringify(`step ${n} ${"x".repeat(380)}`)}`);
  const real = s.e.send(s.cos, s.lead.address, "the real question", null);
  await s.run(3000);
  const w = s.wakesOf(s.lead)[0]!;
  assert.ok(!w.text.includes(real.id), "the oldest notices fill the digest");
  assert.match(w.text, /more unread, not shown here and not covered by this cursor: ack this cursor, then read them with orch_inbox\./);
  const all = s.e.batch.read(s.lead);
  assert.ok(all.text.includes(real.id), "orch_inbox shows everything, the actionable item included");
  s.e.batch.ack(s.lead, all.cursor!);
  await s.run(GAP);
  assert.equal(s.e.batch.read(s.lead).count, 0);
  assert.equal(s.e.batch.wakes().filter((x) => x.recipient === s.lead.address).length, 0, "no wake left behind");
});

test("a lead that acks only a capped digest's cursor is woken again for the rest within the gap, not after the resend", async () => {
  const s = setup();
  for (let n = 0; n < 60; n++) s.e.notifySupervisor(s.worker, `finished a turn. Last words: ${JSON.stringify(`step ${n} ${"x".repeat(380)}`)}`);
  const real = s.e.send(s.cos, s.lead.address, "the real question", null);
  await s.run(3000);
  const first = s.wakesOf(s.lead)[0]!;
  const cursor = first.text.match(/orch_ack\(through="([0-9a-f]+)"\)/)![1]!;
  s.e.batch.ack(s.lead, cursor); // the lead handled what it was shown, and no more
  await s.run(GAP + DEBOUNCE);
  const w = s.wakesOf(s.lead);
  assert.equal(w.length, 2, "the item past the cap gets its own wake");
  assert.ok(w[1]!.at - real.createdAt <= GAP + DEBOUNCE + 1000, `it waited ${w[1]!.at - real.createdAt} ms, not resendMs`);
  assert.ok(w[1]!.text.includes(real.id));
});

test("the owner's approval of a deliverable wakes no one alone, but brings a gap-held wake forward", async () => {
  const s = setup();
  const proof = [{ kind: "link" as const, caption: "the run", url: "https://example.com/run/1" }];
  const d = s.e.deliver(s.lead, { title: "Export", summary: "Done.", proof }, { roots: [] });
  s.e.send(s.cos, s.lead.address, "earlier work", null);
  await s.run(3000);
  s.handle(s.lead);
  s.e.personApprove(d.id, d.rev, "looks good");
  await s.run(GAP + 5000);
  assert.equal(s.wakesOf(s.lead).length, 1, "an approval with no next action is a notice: it starts no turn on its own");
  s.e.send(s.worker, s.lead.address, "a question", null);
  s.e.send(s.cos, s.lead.address, "earlier work again", null);
  await s.run(3000);
  s.handle(s.lead);
  const n = s.wakesOf(s.lead).length;
  s.e.send(s.worker, s.lead.address, "inside the gap", null);
  await s.run(5000);
  assert.equal(s.wakesOf(s.lead).length, n, "mail inside the gap waits");
  const d2 = s.e.deliver(s.lead, { title: "Import", summary: "Done.", proof }, { roots: [] });
  s.e.personApprove(d2.id, d2.rev, null);
  await s.run(3000);
  assert.equal(s.wakesOf(s.lead).length, n + 1, "the owner's approval doesn't wait out the gap");
  assert.match(s.wakesOf(s.lead).at(-1)!.text, /approved/);
});

test("the CoS's partial ack of its capped digest answers its wake: the rest wakes it at once, and the wake never dies of it", async () => {
  const s = setup();
  for (let n = 0; n < 60; n++) s.e.notifySupervisor(s.lead, `finished a turn. Last words: ${JSON.stringify(`step ${n} ${"x".repeat(380)}`)}`);
  s.e.send(s.lead, s.cos.address, "the real question", null);
  await s.run(3000);
  for (let page = 0; page < 6 && s.e.batch.read(s.cos).count; page++) {
    const w = s.wakesOf(s.cos).at(-1)!;
    s.e.batch.ack(s.cos, w.text.match(/orch_ack\(through="([0-9a-f]+)"\)/)![1]!);
    await s.run(DEBOUNCE + 1000);
  }
  assert.ok(s.wakesOf(s.cos).length >= 2, "each page acked brings the next within the debounce, not the 10-minute retry");
  assert.equal(s.e.batch.read(s.cos).count, 0, "every page reached the CoS");
  assert.ok(!s.e.batch.wakes().some((w) => w.recipient === "cos" && w.state === "dead"));
});

// A held wake's deferral is worked out again on every flush, and the urgent check runs with the gap off too: the owner
// turns the gap off to get mail through now.
async function heldWake() {
  const s = setup();
  s.e.send(s.cos, s.lead.address, "earlier work", null);
  await s.run(3000);
  s.handle(s.lead);
  s.e.send(s.worker, s.lead.address, "inside the gap", null);
  await s.run(3000);
  assert.equal(s.wakesOf(s.lead).length, 1, "held by the gap");
  return s;
}

test("turning the gap off releases a wake it already held, after the debounce", async () => {
  const s = await heldWake();
  s.e.settings = { ...s.e.settings, inboxGapMs: 0 };
  await s.run(DEBOUNCE + 1000);
  assert.equal(s.wakesOf(s.lead).length, 2, "not at the old gap's end, ~2 min away");
});

test("a lowered gap shortens a held wake to the new gap, not to nothing", async () => {
  const s = await heldWake();
  s.e.settings = { ...s.e.settings, inboxGapMs: 20_000 };
  await s.run(10_000);
  assert.equal(s.wakesOf(s.lead).length, 1, "still inside the new 20 s gap");
  await s.run(12_000);
  assert.equal(s.wakesOf(s.lead).length, 2, "and goes at its end, not at the old 120 s one");
});

test("with the gap off, the owner's message wakes the lead after the debounce even past a wake the gap held", async () => {
  const s = await heldWake();
  s.e.settings = { ...s.e.settings, inboxGapMs: 0 };
  s.e.ownerMessage("kite", "Stop the deploy.");
  await s.run(DEBOUNCE + 1000);
  assert.equal(s.wakesOf(s.lead).length, 2);
  assert.match(s.wakesOf(s.lead)[1]!.text, /Stop the deploy/);
});

// A pass waits on each delivery, and a wake that came due meanwhile is neither sent by that pass, which read the time
// before it, nor armed for by the wake timer, which leaves out wakes already due. A flush passes again for wakes that
// came due during its last pass, as for deadlines.
test("a wake that comes due while a flush waits on another delivery goes in the same flush", async () => {
  const s = setup();
  const ports = (s.e as unknown as { ports: { deliver: (t: string, x: string, i: Item) => Promise<DeliverResult> } }).ports;
  const fast = ports.deliver;
  ports.deliver = async (threadId, text, item) => {
    if (threadId === s.cos.threadId) s.clock.t += 3000; // the CoS's delivery takes 3 s
    return fast(threadId, text, item);
  };
  s.e.send(s.lead, s.cos.address, "for the CoS", null);
  await s.e.flush(); // makes the CoS's wake, due at +2 s
  s.clock.t += 1500;
  s.e.send(s.worker, s.lead.address, "for the lead", null); // the lead's wake: due at +3.5 s, during the CoS's delivery
  await s.e.flush(); // makes the lead's wake
  s.clock.t += 500;
  await s.e.flush(); // the CoS's wake goes, and its delivery runs past the lead's due time
  assert.equal(s.wakesOf(s.cos).length, 1);
  assert.equal(s.wakesOf(s.lead).length, 1, "the lead's wake went in the same flush, not at a later timer or clock pass");
});

// flushAgain makes the server flush again on a 0 ms timer. A flush that fails must not keep it set from an earlier
// flush, or every failure would arm the next 0 ms retry: a hot loop for as long as the failure lasts.
test("a flush that throws clears flushAgain, so a failure can't spin the 0 ms timer", async () => {
  const s = setup();
  const batch = s.e.batch as unknown as { flush: () => Promise<void> };
  batch.flush = async () => {
    throw new Error("delivery port down");
  };
  s.e.flushAgain = true; // the flush before stopped at its pass limit
  await assert.rejects(s.e.flush(), /delivery port down/);
  assert.equal(s.e.flushAgain, false, "no immediate re-flush is asked for after a failure");
});
