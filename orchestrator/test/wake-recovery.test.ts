import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, HUNG_MS, STUCK_MS, type DeliverResult } from "../core/engine.ts";
import { INBOX_READ_BUDGET, REARM_CAP, REARM_COOLDOWN_MS, REARM_WINDOW_MS } from "../core/batch-inbox.ts";
import type { Item } from "../core/model.ts";

const inboxResponseBytes = (text: string) => Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text }] }));

const MIN = 60_000;

function setup() {
  const clock = { t: Date.parse("2026-11-20T10:00:00Z") };
  const sent: { threadId: string; text: string; item: Item }[] = [];
  const pushed: string[] = [];
  const failFor = new Set<string>();
  const db = new DatabaseSync(":memory:");
  const e = new Engine(
    db as never,
    {
      now: () => clock.t,
      deliver: async (threadId: string, text: string, item: Item): Promise<DeliverResult> => {
        if (failFor.has(threadId)) throw new Error("bb unreachable");
        sent.push({ threadId, text, item });
        return { delivery: "sent" };
      },
      mirror: () => {},
      changed: () => {},
      log: () => {},
      cardUp: (d) => pushed.push(d.id),
    },
    { batchInbox: true, inboxDebounceMs: 2000, resendMs: 10 * MIN, inboxGapMs: 0 },
  );
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-lead", "lead", "demo");
  for (const a of [cos, lead]) e.setStatus(a.threadId, "idle");
  const wakesTo = (threadId: string) => sent.filter((x) => x.threadId === threadId && x.item.id.startsWith("wake:"));
  const wake = (address: string) => e.batch.wakes().find((w) => w.recipient === address);
  const run = async (n: number, ms = 11 * MIN) => {
    for (let i = 0; i < n; i++) {
      clock.t += ms;
      await e.flush();
    }
  };
  const kill = async (address: string) => {
    for (let i = 0; i < 8 && wake(address)?.state !== "dead"; i++) await run(1);
    assert.equal(wake(address)?.state, "dead");
  };
  const tick = () => {
    clock.t += MIN;
    e.tick();
  };
  const stuckCards = () => e.needsYou().cards.filter((c) => c.request_key?.startsWith("inbox-stuck:"));
  const stuckCosNotices = () => e.items(5000).filter((i) => i.recipient === "cos" && i.sender === "orchestrator" && /no wake got read/.test(i.body));
  const rearmCount = (address: string) => (db.prepare("SELECT COUNT(*) AS n FROM inbox_wake_rearms WHERE recipient=?").get(address) as { n: number }).n;
  return { db, e, clock, sent, pushed, failFor, cos, lead, wakesTo, wake, run, kill, tick, stuckCards, stuckCosNotices, rearmCount };
}

test("a dead wake re-arms by itself after the cooldown, at most REARM_CAP times in the window", async () => {
  const s = setup();
  s.e.send(s.cos, s.lead.address, "please review", null);
  await s.kill(s.lead.address);
  const deaths = () => s.e.items(5000).filter((i) => i.recipient === "cos" && /lead:demo's inbox wake is dead/.test(i.body)).length;
  assert.equal(deaths(), 1);
  let before = s.wakesTo("T-lead").length;
  await s.run(1, REARM_COOLDOWN_MS - 2 * MIN);
  assert.equal(s.wake(s.lead.address)?.state, "dead", "not before the cooldown");
  assert.equal(s.wakesTo("T-lead").length, before);
  await s.run(1, 2 * MIN);
  assert.ok(s.wakesTo("T-lead").length > before, "after the cooldown the lead is woken again, with no one retrying it");
  for (let r = 1; r < REARM_CAP; r++) {
    await s.kill(s.lead.address);
    await s.run(1, REARM_COOLDOWN_MS);
  }
  await s.kill(s.lead.address);
  before = s.wakesTo("T-lead").length;
  await s.run(6, REARM_COOLDOWN_MS);
  assert.equal(s.wakesTo("T-lead").length, before, `no re-arm past ${REARM_CAP} in the window: no wake storm`);
  assert.equal(s.wake(s.lead.address)?.state, "dead");
  assert.equal(deaths(), 1, "the CoS hears of the death once; a re-armed wake dying again is the stuck-inbox alarm's");
  s.e.setStatus(s.lead.threadId, "error");
  s.e.setStatus(s.lead.threadId, "active");
  s.e.setStatus(s.lead.threadId, "idle");
  assert.equal(s.wake(s.lead.address)?.state, "pending", "back from an error it is woken even with the cap spent");
  await s.kill(s.lead.address);
  s.e.setStatus(s.lead.threadId, "error");
  s.e.setStatus(s.lead.threadId, "idle");
  assert.equal(s.wake(s.lead.address)?.state, "dead", "the same unread episode cannot bypass the cap again");
  assert.equal(s.rearmCount(s.lead.address), REARM_CAP + 1);
  before = s.wakesTo("T-lead").length;
  s.clock.t += REARM_WINDOW_MS;
  await s.run(1);
  assert.ok(s.wakesTo("T-lead").length > before, "once the window has passed it re-arms again");
  s.e.batch.retry(s.lead.address);
  await s.kill(s.lead.address);
  assert.equal(deaths(), 2, "a wake the CoS retried by hand that dies again is told again");
  assert.equal(s.e.batch.read(s.lead).count, 1, "the mail was never closed by any of it");
});

test("a dead wake whose agent comes back from an error goes at once; a stopped agent's stays dead", async () => {
  const s = setup();
  const worker = s.e.register("T-w", "thread", "demo", "T-lead");
  s.e.setStatus(worker.threadId, "idle");
  s.e.send(s.lead, worker.address, "do the thing", null);
  s.e.send(s.cos, s.lead.address, "please review", null);
  s.failFor.add("T-w");
  await s.kill(worker.address);
  s.failFor.delete("T-w");
  s.e.setStatus(worker.threadId, "error");
  s.e.setStatus(worker.threadId, "idle");
  assert.equal(s.wake(worker.address)?.state, "pending", "back from its error, it is woken without waiting out the cooldown");
  await s.run(1, 3000);
  assert.ok(s.wakesTo("T-w").length >= 1);

  await s.kill(s.lead.address);
  s.e.setStatus(s.lead.threadId, "stopped");
  const before = s.wakesTo("T-lead").length;
  await s.run(3, REARM_COOLDOWN_MS);
  assert.equal(s.wakesTo("T-lead").length, before);
  assert.equal(s.wake(s.lead.address)?.state, "dead");
  assert.equal(s.rearmCount(s.lead.address), 0);
});

test("when the CoS's own wake dies, the owner gets a Needs-you card at once, never pushed; it closes once the CoS reads again", async () => {
  const s = setup();
  s.failFor.add("T-cos");
  s.e.send(s.lead, "cos", "need a hand", null);
  await s.kill("cos");
  const cards = s.stuckCards();
  assert.equal(cards.length, 1, "on Needs you, not a quiet board row");
  assert.match(cards[0]!.ask!.question, /CoS's inbox wake is failing/);
  assert.equal(s.pushed.length, 0, "never a push");
  assert.equal(s.stuckCosNotices().length, 0, "not into the inbox that can't be woken");
  s.failFor.delete("T-cos");
  await s.run(1, REARM_COOLDOWN_MS);
  const w = s.wakesTo("T-cos").at(-1)!;
  s.e.batch.ack(s.cos, w.text.match(/orch_ack\(through="([0-9a-f]+)"\)/)![1]!);
  s.tick();
  assert.equal(s.stuckCards().length, 0, "it closes itself once the CoS reads its mail");
  assert.equal(s.e.decision(cards[0]!.id)!.state, "withdrawn");
});

test("a 2,000-item backlog pages under the read budget; each cursor covers only its page, and the pages drain it", () => {
  const s = setup();
  const ids = new Set<string>();
  for (let n = 0; n < 2000; n++) ids.add(s.e.send(s.lead, "cos", `report ${n} ${(n % 3 ? "x" : "é✓").repeat(300 + (n % 7) * 100)}`, null).id);
  const seen = new Set<string>();
  let pages = 0;
  for (;;) {
    const r = s.e.batch.read(s.cos);
    if (!r.cursor) break;
    pages++;
    const bytes = inboxResponseBytes(JSON.stringify(r));
    assert.ok(bytes <= INBOX_READ_BUDGET, `page ${pages} is ${bytes} bytes`);
    assert.equal(r.count + r.more, 2000 - seen.size);
    const shown = [...r.text.matchAll(/\[(i-[0-9a-f]+)\]/g)].map((m) => m[1]!);
    assert.equal(shown.length, r.count);
    if (r.more) assert.match(r.text, new RegExp(`${r.more} more unread, not shown here and not covered by this cursor`));
    const again = s.e.batch.read(s.cos);
    assert.deepEqual([...again.text.matchAll(/\[(i-[0-9a-f]+)\]/g)].map((m) => m[1]), shown, "unacked, a read shows the same page");
    assert.equal(s.e.batch.ack(s.cos, r.cursor), r.count, "the ack covers exactly what the page showed");
    for (const id of shown) {
      assert.ok(!seen.has(id), "no item shown twice once acked");
      seen.add(id);
    }
    assert.equal([...ids].filter((id) => s.e.batch.readAt(id) !== null).length, seen.size, "nothing past the page is marked read");
  }
  assert.ok(pages > 10, `${pages} pages`);
  assert.equal(seen.size, 2000);
});

test("many inboxes stuck for an hour: one owner card listing every one, updated in place, an ACTION notice each to the CoS", async () => {
  const s = setup();
  const threads = [1, 2, 3, 4].map((n) => {
    const t = s.e.register(`T-w${n}`, "thread", "demo", "T-lead");
    s.e.setStatus(t.threadId, "error");
    return t;
  });
  for (const t of threads.slice(0, 3)) s.e.send(s.lead, t.address, "do the thing", null);
  s.e.setStatus(s.cos.threadId, "active");
  s.tick();
  assert.equal(s.stuckCards().length, 0, "not before an hour");
  s.clock.t += STUCK_MS;
  s.tick();
  const cards = s.stuckCards();
  assert.equal(cards.length, 1, "one card for the whole burst");
  for (const t of threads.slice(0, 3)) assert.match(cards[0]!.ask!.question, new RegExp(t.address));
  assert.equal(s.stuckCosNotices().length, 3);
  const cosText = s.e.batch.read(s.cos).text;
  for (const n of s.stuckCosNotices()) assert.match(cosText, new RegExp(`\\[${n.id}\\] notice from orchestrator; ACTION`), "an ACTION notice, which wakes the CoS");

  s.e.send(s.lead, threads[3]!.address, "and this", null);
  s.clock.t += STUCK_MS;
  s.tick();
  const now = s.stuckCards();
  assert.equal(now.length, 1, "a newly stuck inbox revises the card, it never files another");
  assert.equal(now[0]!.id, cards[0]!.id);
  assert.match(now[0]!.ask!.question, /4 inboxes/);
  s.tick();
  assert.equal(s.e.decision(cards[0]!.id)!.rev, now[0]!.rev, "an unchanged list leaves the card alone");
  assert.equal(s.stuckCosNotices().length, 4, "the CoS hears once per inbox per episode");
  assert.equal(s.pushed.length, 0);

  for (const t of threads) {
    const r = s.e.batch.read(t);
    s.e.batch.ack(t, r.cursor!);
  }
  s.tick();
  assert.equal(s.stuckCards().length, 0, "it closes once all recover");
});

test("when the only stuck inbox is the CoS's, only the owner hears", () => {
  const s = setup();
  s.e.send(s.lead, "cos", "need a hand", null);
  s.clock.t += STUCK_MS + MIN;
  s.tick();
  assert.equal(s.stuckCards().length, 1);
  assert.match(s.stuckCards()[0]!.ask!.question, /CoS's inbox/);
  assert.equal(s.stuckCosNotices().length, 0);
});

test("an agent mid-turn is not stuck, unless its turn has run past HUNG_MS since it started", () => {
  const s = setup();
  const busy = s.e.register("T-busy", "thread", "demo", "T-lead");
  s.e.setStatus(busy.threadId, "idle");
  s.clock.t += 8 * HUNG_MS;
  s.e.setStatus(busy.threadId, "active");
  s.e.send(s.lead, busy.address, "when you're done", null);
  s.clock.t += STUCK_MS + MIN;
  s.tick();
  assert.equal(s.stuckCards().length, 0, "a long turn is normal: the digest comes when it ends");
  s.clock.t += HUNG_MS - STUCK_MS;
  s.e.setStatus(busy.threadId, "active");
  s.tick();
  assert.equal(s.stuckCards().length, 1, "active for over 3 h since its turn started: likely hung");
  assert.match(s.stuckCards()[0]!.ask!.question, new RegExp(busy.address));
});

test("an agent that reads part of its mail after its wake died is woken again for the rest at once", async () => {
  const s = setup();
  for (let n = 0; n < 60; n++) s.e.notifySupervisor(s.lead, `finished a turn. Last words: ${JSON.stringify(`step ${n} ${"x".repeat(380)}`)}`);
  s.e.send(s.lead, "cos", "the real question", null);
  s.failFor.add("T-cos");
  await s.kill("cos");
  s.failFor.delete("T-cos");
  const page = s.e.batch.read(s.cos, 4000);
  assert.ok(page.more > 0);
  s.e.batch.ack(s.cos, page.cursor!);
  const before = s.wakesTo("T-cos").length;
  await s.run(2, 3000);
  assert.ok(s.wakesTo("T-cos").length > before, "its read showed it is alive: the rest wakes it within the debounce");
});

test("the owner's Retry on the card wakes every listed inbox and closes it", async () => {
  const s = setup();
  const t = s.e.register("T-w1", "thread", "demo", "T-lead");
  s.e.setStatus(t.threadId, "idle");
  s.e.send(s.lead, t.address, "do the thing", null);
  s.failFor.add("T-w1");
  await s.kill(t.address);
  s.failFor.delete("T-w1");
  s.e.batch.ack(s.cos, s.e.batch.read(s.cos).cursor!);
  s.clock.t += STUCK_MS;
  s.tick();
  const card = s.stuckCards()[0]!;
  s.e.personAnswer(card.id, card.rev, "1", null, "desktop");
  s.tick();
  assert.equal(s.wake(t.address)?.state, "pending", "woken at once, as Resend does");
  assert.equal(s.stuckCards().length, 0);
  assert.notEqual(s.e.decision(card.id)!.state, "answered", "closed, not left answered");
});

test("a card the owner answered still lets a newly failing CoS wake reach the owner", async () => {
  const s = setup();
  const t = s.e.register("T-w1", "thread", "demo", "T-lead");
  s.e.setStatus(t.threadId, "stopped");
  s.e.setStatus(t.threadId, "active");
  s.e.setStatus(t.threadId, "error");
  s.e.send(s.lead, t.address, "do the thing", null);
  s.clock.t += STUCK_MS;
  s.tick();
  const first = s.stuckCards()[0]!;
  s.e.personAnswer(first.id, first.rev, "2", null, "desktop");
  s.tick();
  assert.equal(s.stuckCards().length, 0, "answered: the owner chose to leave it");
  s.tick();
  assert.equal(s.stuckCards().length, 0, "the same stuck inbox files no new card");
  s.failFor.add("T-cos");
  s.e.send(s.lead, "cos", "need a hand", null);
  await s.kill("cos");
  const cards = s.stuckCards();
  assert.equal(cards.length, 1, "an inbox the closed card didn't list gets a new card");
  assert.match(cards[0]!.ask!.question, /cos/);
});

test("delivery errors on an automatic re-arm retain its origin and do not send another death notice", async () => {
  const s = setup();
  s.e.send(s.cos, s.lead.address, "please review", null);
  await s.kill(s.lead.address);
  const deaths = () => s.e.items(5000).filter((i) => i.recipient === "cos" && /lead:demo's inbox wake is dead/.test(i.body)).length;
  assert.equal(deaths(), 1);
  s.failFor.add("T-lead");
  await s.run(1, REARM_COOLDOWN_MS);
  assert.equal(s.wake(s.lead.address)?.state, "uncertain");
  assert.match(s.wake(s.lead.address)?.note ?? "", /bb unreachable/);
  await s.kill(s.lead.address);
  assert.equal(s.rearmCount(s.lead.address), 1);
  assert.equal(deaths(), 1);
});

test("a shared outage paces re-arms and carries the remaining wakes forward", async () => {
  const s = setup();
  const workers = Array.from({ length: 5 }, (_, i) => {
    const t = s.e.register(`T-w${i}`, "thread", "demo", s.lead.threadId);
    s.e.setStatus(t.threadId, "idle");
    s.e.send(s.lead, t.address, "please review", null);
    return t;
  });
  await s.run(4);
  assert.ok(workers.every((t) => s.wake(t.address)?.state === "dead"));
  const count = () => workers.reduce((n, t) => n + s.rearmCount(t.address), 0);
  await s.run(1, REARM_COOLDOWN_MS);
  assert.equal(count(), 2);
  await s.e.flush();
  assert.equal(count(), 2);
  await s.run(1, 5_000);
  assert.equal(count(), 4);
  await s.run(1, 5_000);
  assert.equal(count(), 5);
});

test("an inbox keeps its card and notice through an unread retry and a later owner answer", async () => {
  const s = setup();
  const t = s.e.register("T-w", "thread", "demo", s.lead.threadId);
  s.e.setStatus(t.threadId, "error");
  s.e.send(s.lead, t.address, "please review", null);
  s.clock.t += STUCK_MS;
  s.tick();
  const first = s.stuckCards()[0]!;
  assert.equal(s.stuckCosNotices().length, 1);
  s.e.setStatus(t.threadId, "active");
  s.tick();
  assert.equal(s.stuckCards()[0]?.id, first.id);
  s.e.setStatus(t.threadId, "error");
  s.tick();
  assert.equal(s.stuckCards()[0]?.id, first.id);
  s.e.personAnswer(first.id, s.stuckCards()[0]!.rev, "2", null, "desktop");
  s.tick();
  const other = s.e.register("T-other", "thread", "demo", s.lead.threadId);
  s.e.setStatus(other.threadId, "idle");
  s.e.send(s.lead, other.address, "please review too", null);
  s.clock.t += STUCK_MS;
  s.tick();
  const second = s.stuckCards()[0]!;
  assert.ok(second && second.id !== first.id);
  assert.deepEqual(s.stuckCosNotices().map((i) => i.body.split(" ")[0]).sort(), [t.address, other.address].sort());
  assert.equal(s.stuckCards().length, 1);
});

test("a deadline before arrival cannot make an inbox stuck on arrival", () => {
  const s = setup();
  s.e.send(s.cos, s.lead.address, "late arrival", null, null, { severity: "INFO", dueAt: s.clock.t - 2 * STUCK_MS });
  s.tick();
  assert.equal(s.stuckCards().length, 0);
  s.clock.t += STUCK_MS;
  s.tick();
  assert.equal(s.stuckCards().length, 1);
});

test("a wide incident lists every inbox and does not reopen after the owner answers", () => {
  const s = setup();
  const addresses = Array.from({ length: 51 }, (_, i) => {
    const t = s.e.register(`T-w${i}`, "thread", "demo", s.lead.threadId);
    s.e.setStatus(t.threadId, "idle");
    s.e.send(s.lead, t.address, "please review", null);
    return t.address;
  }).sort();
  s.clock.t += STUCK_MS;
  s.tick();
  const card = s.stuckCards()[0]!;
  const items = s.e.decision(card.id)!.request.blocks!.flatMap((b) => b.kind === "list" ? b.items.map((i) => i.label) : []);
  assert.deepEqual([...items].sort(), addresses);
  s.e.personAnswer(card.id, card.rev, "2", null, "desktop");
  s.tick();
  s.tick();
  assert.equal(s.stuckCards().length, 0);
  assert.equal(s.stuckCosNotices().length, addresses.length);
});

test("a failed re-arm ledger insert rolls back the wake reset", async () => {
  const s = setup();
  s.e.send(s.cos, s.lead.address, "please review", null);
  await s.kill(s.lead.address);
  const dead = s.wake(s.lead.address);
  s.db.exec(`CREATE TRIGGER fail_rearm BEFORE INSERT ON inbox_wake_rearms
    BEGIN SELECT RAISE(ABORT, 'ledger write failed'); END`);
  await assert.rejects(s.run(1, REARM_COOLDOWN_MS), /ledger write failed/);
  assert.deepEqual(s.wake(s.lead.address), dead);
  assert.equal(s.rearmCount(s.lead.address), 0);
});

test("simultaneous recovery to idle shares the cooldown pacing budget", async () => {
  const s = setup();
  const workers = Array.from({ length: 4 }, (_, i) => {
    const t = s.e.register(`T-recover${i}`, "thread", "demo", s.lead.threadId);
    s.e.setStatus(t.threadId, "idle");
    s.e.send(s.lead, t.address, "please review", null);
    return t;
  });
  await s.run(4);
  for (const t of workers) assert.equal(s.wake(t.address)?.state, "dead");
  for (const t of workers.slice(0, 3)) {
    s.e.setStatus(t.threadId, "error");
    s.e.setStatus(t.threadId, "active");
    s.e.setStatus(t.threadId, "idle");
  }
  const [first, second, deferred, cooldown] = workers;
  assert.equal(s.wake(first!.address)?.state, "pending");
  assert.equal(s.wake(second!.address)?.state, "pending");
  assert.equal(s.wake(deferred!.address)?.state, "dead");
  assert.equal(s.rearmCount(deferred!.address), 0);
  s.db.prepare("UPDATE inbox_wakes SET due_at=? WHERE recipient=?").run(s.clock.t - REARM_COOLDOWN_MS, cooldown!.address);
  await s.e.flush();
  assert.equal(s.wake(cooldown!.address)?.state, "dead");
  await s.run(1, 5_000);
  assert.equal(s.wake(deferred!.address)?.state, "sent");
  assert.equal(s.wake(cooldown!.address)?.state, "sent");
  assert.equal(s.rearmCount(deferred!.address), 1);
});

test("archiving projects drops their unread mail and revises or closes the stuck card", () => {
  const s = setup();
  const other = s.e.register("T-other", "lead", "other");
  const worker = s.e.register("T-demo-w", "thread", "demo", s.lead.threadId);
  const mail = [
    s.e.send(s.cos, s.lead.address, "demo lead", null),
    s.e.send(s.lead, worker.address, "demo thread", null),
    s.e.send(s.cos, other.address, "other lead", null),
  ];
  s.clock.t += STUCK_MS;
  s.tick();
  const card = s.stuckCards()[0]!;
  assert.match(card.ask!.question, /3 inboxes/);
  s.e.archiveProject("demo");
  assert.deepEqual(s.stuckCards().map((d) => d.id), [card.id]);
  assert.match(s.stuckCards()[0]!.ask!.question, /lead:other/);
  assert.doesNotMatch(s.stuckCards()[0]!.ask!.question, /demo/);
  assert.equal(s.e.batch.read(s.lead).count, 0);
  assert.equal(s.e.batch.read(worker).count, 0);
  assert.equal(s.e.batch.readAt(mail[0]!.id), null);
  s.e.archiveProject("other");
  assert.equal(s.stuckCards().length, 0);
  assert.equal(s.e.decision(card.id)!.state, "withdrawn");
});

test("Retry keeps active, pending and queued inboxes visible and records only a real retry as retried", async () => {
  const s = setup();
  const workers = Array.from({ length: 4 }, (_, i) => {
    const t = s.e.register(`T-w${i}`, "thread", "demo", s.lead.threadId);
    s.e.setStatus(t.threadId, "idle");
    s.e.send(s.lead, t.address, "please review", null);
    return t;
  });
  const [ready, busy, pending, queued] = workers;
  await s.run(4);
  s.e.batch.ack(s.cos, s.e.batch.read(s.cos).cursor!);
  s.e.setStatus(busy!.threadId, "active");
  s.e.setStatus(pending!.threadId, "active");
  s.e.setStatus(queued!.threadId, "active");
  s.db.prepare("UPDATE inbox_wakes SET state='pending' WHERE recipient=?").run(pending!.address);
  s.db.prepare("UPDATE inbox_wakes SET state='queued', queued_id='queue-1' WHERE recipient=?").run(queued!.address);
  s.clock.t += HUNG_MS;
  s.tick();
  const card = s.stuckCards()[0]!;
  s.e.personAnswer(card.id, card.rev, "1", null, "desktop");
  const immediate = s.stuckCards().map((c) => c.id);
  s.tick();
  const note = s.e.decision(card.id)!.ack!.note;
  assert.equal(note, `${ready!.address} retried; ${busy!.address} blocked by an active turn; ${pending!.address} already pending; ${queued!.address} queued`);
  assert.equal(s.wake(ready!.address)?.state, "pending");
  assert.equal(s.wake(busy!.address)?.state, "dead");
  assert.deepEqual(immediate, [s.stuckCards()[0]!.id]);
  for (let check = 0; check < 2; check++) {
    const followup = s.stuckCards()[0]!;
    const items = s.e.decision(followup.id)!.request.blocks!.flatMap((b) => b.kind === "list" ? b.items : []);
    assert.deepEqual(items.map((i) => i.label), [busy!.address, pending!.address, queued!.address]);
    s.tick();
  }
  assert.equal(s.stuckCosNotices().length, 4);
  assert.equal(s.pushed.length, 0);
});
