// The mobile feed (D3-D6): a reply reaches its post's author on today's two lines, tracked, and Resend brings it back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, type DeliverResult } from "../core/engine.ts";
import type { Item } from "../core/model.ts";
import type { FeedPost } from "../core/feed.ts";

const T0 = Date.parse("2026-11-19T09:00:00Z");
const M = 60_000;
const three = [{ label: "Flag it" }, { label: "Wait" }, { label: "Drop it" }];

function setup(batchInbox = false) {
  const clock = { t: T0 };
  const sent: { threadId: string; text: string; item: Item }[] = [];
  const ports = {
    now: () => clock.t,
    async deliver(threadId: string, text: string, item: Item): Promise<DeliverResult> {
      sent.push({ threadId, text, item });
      return { delivery: "sent" };
    },
    mirror: () => {},
    changed: () => {},
    log: () => {},
  };
  const e = new Engine(new DatabaseSync(":memory:") as never, ports as never, { owner: "Robin", batchInbox, inboxDebounceMs: 2000, resendMs: 10 * M });
  const cos = e.register("T-cos", "cos", null);
  const steward = e.register("T-st", "steward", null);
  const lead = e.register("T-lead", "lead", "kite");
  const other = e.register("T-other", "lead", "otter");
  const thread = e.register("T-w1", "thread", "kite", "T-lead");
  for (const a of [cos, steward, lead, other, thread]) e.setStatus(a.threadId, "idle");
  const advance = (ms: number) => (clock.t += ms);
  const step = async (n = 2) => {
    for (let i = 0; i < n; i++) {
      advance(3000);
      await e.flush();
    }
  };
  const deliverable = () => e.deliver(lead, { title: "Onboarding checklist", summary: "Three steps instead of seven.", proof: [{ kind: "link", caption: "preview", url: "https://example.com/preview" }] }, { roots: [] });
  const card = (by = lead, title = "Ship the banner?") => {
    const d = e.ask(by, { title, question: `${title} now?`, options: three });
    e.triageAskPerson(cos, d.id, { question: `${title} now?`, options: three, allowText: true });
    return e.decision(d.id)!;
  };
  const feed = (filter: "all" | "needs" | "delivered" | "alerts" = "all", cursor: string | null = null, limit?: number) => e.feed({ cursor, filter, limit });
  const post = (key: string) => feed().posts.find((p) => p.key === key);
  return { e, cos, steward, lead, other, thread, sent, advance, step, deliverable, card, feed, post, now: () => clock.t };
}

test("a reply under a lead's deliverable is a direct message to that lead, with the post as its about; the CoS gets its copy; the lead's note nests under the post", async () => {
  const s = setup();
  const d = s.deliverable();
  const key = `deliverable:${d.id}`;
  const it = s.e.ownerMessage("kite", "Does the empty state still show?", null, [], key);
  assert.deepEqual([it.kind, it.sender, it.recipient, it.about], ["owner.message", "person", "lead:kite", key]);
  const copy = s.e.items(500).find((x) => x.recipient === "cos" && x.kind === "copy" && x.ref === it.id)!;
  assert.ok(copy, "the CoS holds a read-only copy, as on the Projects tab");
  assert.match(copy.body, new RegExp(`re deliverable ${d.id} "Onboarding checklist"`), "the copy names the post the message is about");
  await s.e.flush();
  const text = s.sent.find((x) => x.item.id === it.id)!.text;
  assert.match(text, new RegExp(`replying in the feed to deliverable ${d.id} "Onboarding checklist" \\(rev 1\\)`), "the lead knows what 'this' is");
  assert.match(text, /orch_ack\(id=/, "it keeps the direct line's rules");
  s.advance(M);
  s.e.ack(s.lead, it.id, "done", "Yes: it shows the invite prompt.");
  const p = s.post(key)!;
  assert.equal(p.replies, 2, "the owner's message and the lead's note");
  assert.deepEqual(p.thread.map((m) => [m.who, m.text]), [["person", "Does the empty state still show?"], ["lead:kite", "Yes: it shows the invite prompt."]]);
  assert.equal(p.thread[0]!.state, "answered");
  assert.equal(p.thread[0]!.rev, 1, "the message says which revision it was about");
  assert.equal(p.line, "lead:kite");
});

test("a lead's post can't take a reply on another line, and a Steward alarm takes none", () => {
  const s = setup();
  const d = s.deliverable();
  assert.throws(() => s.e.ownerMessage("otter", "hi", null, [], `deliverable:${d.id}`), /goes to lead:kite, not lead:otter/);
  assert.throws(() => s.e.ownerCosMessage("hi", [], `deliverable:${d.id}`), /goes to lead:kite, not cos/, "a project's post never goes to the CoS");
  s.e.alarm("warn", { disk: 91 }, "Disk 91% full");
  const alarm = s.feed("alerts").posts.find((p) => p.kind === "alarm")!;
  assert.equal(alarm.line, null);
  assert.throws(() => s.e.ownerCosMessage("why?", [], alarm.key), /goes to nobody/);
  assert.throws(() => s.e.ownerMessage("kite", "hi", null, [], "deliverable:v-nope"), /no post/);
});

test("a reply under a CoS post is a tracked message to the CoS, delivered as the owner's own words with how to answer; orch_reply_owner nests the answer under the post", async () => {
  const s = setup();
  const dead = s.e.send(s.lead, "lead:otter", "Review the search change", null);
  s.e.retire("T-other");
  s.e.tick();
  s.e.escalateDead(s.cos, dead.id, "Its lead was stopped before it read it.");
  const post = s.feed("alerts").posts.find((p) => p.kind === "dead")!;
  assert.equal(post.line, "cos", "the CoS escalated it: replies go to the CoS");
  const it = s.e.ownerCosMessage("Hand it to kite, and tell me when it's reviewed.", [], post.key);
  assert.deepEqual([it.kind, it.recipient, it.sender, it.needsAck, it.about], ["owner.cos", "cos", "person", true, post.key]);
  await s.e.flush();
  const got = s.sent.find((x) => x.item.id === it.id)!;
  assert.equal(got.threadId, "T-cos");
  assert.match(got.text, /^Hand it to kite/, "the owner's words come first, as their own message in the CoS's chat");
  assert.match(got.text, new RegExp(`orch_reply_owner\\(ref=${it.id}, text\\)`), "a running CoS keeps its old role text, so the message says how to answer");
  assert.equal(s.post(post.key)!.thread.at(-1)!.state, "delivered");
  s.e.ack(s.cos, it.id, "done", null);
  assert.equal(s.post(post.key)!.thread.at(-1)!.state, "read", "acked is read, not answered");
  assert.throws(() => s.e.replyOwner(s.lead, it.id, "x"), /only the CoS/);
  assert.throws(() => s.e.replyOwner(s.cos, dead.id, "x"), /isn't Robin's message to you/);
  s.advance(M);
  const reply = s.e.replyOwner(s.cos, it.id, "Done: kite has it.");
  assert.equal(reply.about, post.key);
  const p = s.post(post.key)!;
  assert.deepEqual(p.thread.map((m) => [m.who, m.text, m.state]), [["person", "Hand it to kite, and tell me when it's reviewed.", "answered"], ["cos", "Done: kite has it.", null]]);
  assert.equal(p.replies, 2);
  assert.ok(!s.sent.some((x) => x.item.id === reply.id), "the reply is recorded, never delivered to a thread");
});

test("a reply closes the CoS's unacked message as replied, and the CoS's message with no post is a post of its own", () => {
  const s = setup();
  const it = s.e.ownerCosMessage("Put otter on hold until Monday.");
  assert.equal(it.about, `msg:${it.id}`, "a message with no post starts its own");
  s.e.replyOwner(s.cos, it.id, "Done.");
  assert.equal(s.e.items(500).find((x) => x.id === it.id)!.outcome, "replied");
  const own = s.post(`msg:${it.id}`)!;
  assert.deepEqual([own.kind, own.author, own.to, own.text], ["message", "person", "cos", "Put otter on hold until Monday."]);
  assert.deepEqual([own.self!.state, own.thread.map((m) => m.who), own.replies], ["answered", ["cos"], 1], "the post is the message; the CoS's answer nests under it");
  const last = s.feed().last!;
  assert.deepEqual([last.id, last.to, last.state], [it.id, "cos", "answered"], "the dock's line: the owner's latest message, its recipient and state");
});

test("a second reply in the same conversation is a follow-up of the newest owner message there, on both lines", () => {
  const s = setup();
  const d = s.deliverable();
  const key = `deliverable:${d.id}`;
  const a = s.e.ownerMessage("kite", "First question", null, [], key);
  s.advance(M);
  s.e.ownerMessage("kite", "Unrelated message from the Projects tab");
  s.advance(M);
  const b = s.e.ownerMessage("kite", "Second question", null, [], key);
  s.advance(M);
  const c = s.e.ownerMessage("kite", "Third", null, [], key);
  assert.deepEqual([a.ref, b.ref, c.ref], [null, a.id, b.id], "the lead line's follow-up chain holds, within the conversation");
  const x = s.e.ownerCosMessage("One");
  const y = s.e.ownerCosMessage("Two", [], `msg:${x.id}`);
  const z = s.e.ownerCosMessage("Three", [], `msg:${x.id}`);
  assert.deepEqual([y.ref, z.ref, y.about, z.about], [x.id, y.id, `msg:${x.id}`, `msg:${x.id}`]);
  const f = s.e.ownerMessage("kite", "A follow-up typed on the Projects tab", b.id);
  assert.equal(f.about, key, "a follow-up of a message joins that message's conversation");
});

test("the feed holds the owner's items and leaves the chatter out (D2, D4)", async () => {
  const s = setup();
  const open = s.card();
  const deferred = s.card(s.lead, "Later?");
  s.e.personDefer(deferred.id, deferred.rev, "manual", null, "desktop");
  const triaging = s.e.ask(s.lead, { title: "Still with the CoS?", question: "q", options: three });
  const d = s.deliverable();
  s.e.publishStatus(s.lead, { goal: "Ship onboarding", steps: [{ title: "Build", state: "done" }, { title: "Review", state: "current" }], waitingOn: { kind: "nothing" }, blockers: [], update: { working_on: ["Checklist in review"], at: "review", needs: "" } } as never);
  s.e.publishStatus(s.lead, { goal: "Ship onboarding", steps: [{ title: "Build", state: "done" }, { title: "Review", state: "current" }], waitingOn: { kind: "nothing" }, blockers: [], update: { working_on: ["Checklist approved soon"], at: "review", needs: "" } } as never);
  s.e.alarm("warn", { disk: 91 }, "Disk 91% full");
  s.e.send(s.thread, "lead:kite", "mail between agents", null);
  s.e.setStatus("T-w1", "error");
  s.e.boardAdd("notice", "orchestrator", "kite", "a thread started", "", null);
  s.e.ownerMessage("kite", "Projects tab message");
  const keys = s.feed().posts.map((p) => p.key);
  assert.ok(keys.includes(`decision:${open.id}`), "an open card");
  assert.ok(keys.includes(`deliverable:${d.id}`), "a deliverable in review");
  assert.equal(keys.filter((k) => k === "status:kite").length, 1, "one status post per project, replaced as it updates");
  assert.equal(s.post("status:kite")!.title, "Checklist approved soon");
  assert.ok(keys.some((k) => k.startsWith("board:")), "a host alarm");
  assert.ok(keys.some((k) => k.startsWith("msg:")), "the owner's own message is a post");
  assert.ok(!keys.includes(`decision:${deferred.id}`), "a deferred card waits until it comes back");
  assert.ok(!keys.includes(`decision:${triaging.id}`), "a card still with the CoS isn't the owner's yet");
  assert.equal(keys.length, 5, "no mail, notice, direct row or thread status: those stay on Activity");
  assert.ok(s.e.feedLeftOut(s.feed().leftOutSince) >= 2, "the footer counts what it leaves out");
  s.e.setHold("kite", true);
  assert.ok(!s.feed().posts.some((p) => p.key === `decision:${open.id}`), "a held project's cards aren't shown");
  s.e.setHold("kite", false);
  assert.deepEqual(s.feed("needs").posts.map((p) => p.key), [`decision:${open.id}`]);
  assert.deepEqual(s.feed("delivered").posts.map((p) => p.key), [`deliverable:${d.id}`]);
  assert.deepEqual(s.feed("alerts").posts.map((p) => p.kind), ["alarm"]);
});

test("a Multiplayer board's deliverable stays on its board, out of the feed and its Delivered count, as on the Deliverables tab", () => {
  const s = setup();
  const d = s.deliverable();
  const onBoard = s.e.deliver(s.lead, { title: "Review widgets#41", summary: "Changes requested.", proof: [{ kind: "link", caption: "review", url: "https://example.com/review" }], board: { id: "b-1" } }, { roots: [] });
  assert.ok(onBoard.board, "the board review is recorded as one");
  for (const f of ["all", "delivered"] as const) assert.deepEqual(s.feed(f).posts.filter((p) => p.kind === "deliverable").map((p) => p.key), [`deliverable:${d.id}`], f);
  assert.equal(s.feed().counts.delivered, 1, "the Delivered count leaves a board's review out, as the Deliverables tab does");
  const asked = s.e.ownerMessage("kite", "Is the review right?", null, [], `deliverable:${onBoard.id}`);
  s.advance(M);
  s.e.ack(s.lead, asked.id, "done", "Yes.");
  assert.ok(!s.feed().posts.some((p) => p.key === `deliverable:${onBoard.id}`), "a lead's answer on its key doesn't lift it into the feed");
  // a flagged one asks the owner on a Needs you card, and that card is a feed post like any other
  const flagged = s.e.deliver(s.lead, { title: "Review widgets#38", summary: "CI red.", proof: [{ kind: "link", caption: "review", url: "https://example.com/review/38" }], board: { id: "b-1", flag: "Couldn't verify: CI red" } }, { roots: [] });
  const cardKey = `decision:${flagged.board!.card}`;
  for (const f of ["all", "needs"] as const) assert.ok(s.feed(f).posts.some((p) => p.key === cardKey), `the flag's card is in ${f}`);
  assert.ok(!s.feed().posts.some((p) => p.key === `deliverable:${flagged.id}`), "the flagged deliverable itself stays on its board");
  assert.equal(s.post(cardKey)!.line, "lead:kite", "a reply under it goes to the lead who delivered it");
  const why = s.e.ownerMessage("kite", "What failed in CI?", null, [], cardKey);
  s.advance(M);
  s.e.ack(s.lead, why.id, "done", "The flaky upload test.");
  assert.deepEqual(s.post(cardKey)!.thread.map((m) => m.text), ["What failed in CI?", "The flaky upload test."], "the answer nests under the card");
});

test("posts sort by the latest agent activity: a new answer lifts its post, the owner's own reply doesn't", () => {
  const s = setup();
  const d = s.deliverable();
  s.advance(M);
  const c = s.card();
  s.advance(M);
  const order = () => s.feed().posts.map((p) => p.key);
  assert.deepEqual(order().slice(0, 2), [`decision:${c.id}`, `deliverable:${d.id}`]);
  s.advance(M);
  const m = s.e.ownerMessage("kite", "Question on the checklist", null, [], `deliverable:${d.id}`);
  assert.deepEqual(order().slice(0, 2), [`decision:${c.id}`, `deliverable:${d.id}`], "the owner's reply doesn't move its post");
  s.advance(M);
  s.e.ack(s.lead, m.id, "done", "Answered.");
  assert.deepEqual(order().slice(0, 2), [`deliverable:${d.id}`, `decision:${c.id}`], "the lead's answer lifts it to the top");
});

test("reply counts come from one grouped read and the newest three exchanges ride along; the rest page back", () => {
  const s = setup();
  const d = s.deliverable();
  const key = `deliverable:${d.id}`;
  for (const q of ["One?", "Two?", "Three?"]) {
    s.advance(M);
    const m = s.e.ownerMessage("kite", q, null, [], key);
    if (q !== "Three?") {
      s.advance(M);
      s.e.ack(s.lead, m.id, "done", `Re ${q}`);
    }
  }
  const p = s.post(key)!;
  assert.equal(p.replies, 5, "three messages and two notes");
  assert.deepEqual(p.thread.map((m) => m.text), ["Two?", "Re Two?", "Three?"]);
  assert.equal(p.earlier, 2);
  const back = s.e.feedThread(key, p.thread[0]!.at);
  assert.deepEqual(back.messages.map((m) => m.text), ["One?", "Re One?"]);
});

for (const batchInbox of [false, true]) {
  test(`batchInbox ${batchInbox ? "on" : "off"}: an open conversation is told when its unanswered message turns "no reply yet", and shows it then`, async () => {
    const s = setup(batchInbox);
    const key = `deliverable:${s.deliverable().id}`;
    const m = s.e.ownerMessage("kite", "Is this the final cut?", null, [], key);
    await s.step();
    const mine = () => s.e.feedThread(key, null).messages.find((x) => x.id === m.id)!;
    assert.equal(mine().resend, false, "not before the resend time");
    const { now, turnsAt } = s.e.feedThread(key, null);
    assert.ok(turnsAt !== null && turnsAt > now && turnsAt <= now + 10 * M, "no write marks the resend time: the open conversation is told when to read again");
    s.advance(turnsAt - now);
    assert.match(mine().state!, /no reply yet/);
    assert.equal(mine().resend, true);
  });
}

test("a page that doesn't show an unanswered message isn't told when it turns, so its deadline rereads only the pages showing it", async () => {
  const s = setup(true);
  const m = s.e.ownerMessage("kite", "Is the preview up?");
  await s.step();
  const all = s.feed();
  assert.equal(all.last?.id, m.id, "every page names the newest message to a lead");
  assert.ok(all.posts.some((p) => p.key === `msg:${m.id}`) && all.turnsAt !== null, "the page showing it is told");
  const alerts = s.e.feed({ cursor: null, filter: "alerts" });
  assert.ok(!alerts.posts.some((p) => p.key === `msg:${m.id}`));
  assert.equal(alerts.turnsAt, null);
});

test("the feed pages by activity, so every post shows once", () => {
  const s = setup();
  for (let i = 0; i < 7; i++) {
    s.advance(M);
    s.e.ownerCosMessage(`message ${i}`);
  }
  const first = s.feed("all", null, 3);
  const second = s.feed("all", first.cursor, 3);
  const third = s.feed("all", second.cursor, 3);
  const seen = [...first.posts, ...second.posts, ...third.posts].map((p: FeedPost) => p.text);
  assert.deepEqual(seen, ["message 6", "message 5", "message 4", "message 3", "message 2", "message 1", "message 0"]);
  assert.equal(third.cursor, null);
});

test("the seen line only moves forward; cards that need the owner stay marked until acted on", () => {
  const s = setup();
  const c = s.card();
  s.e.ownerCosMessage("an old post");
  s.advance(M);
  const t = s.now();
  assert.equal(s.e.markFeedSeen(t), t);
  assert.equal(s.e.markFeedSeen(t - 30 * M), t, "never back");
  assert.equal(s.e.markFeedSeen(t + 60 * M), t, "never past now");
  const f = s.feed();
  assert.equal(f.seen, t);
  assert.equal(f.posts.find((p) => p.kind === "message")!.isNew, false);
  assert.equal(f.posts.find((p) => p.key === `decision:${c.id}`)!.isNew, true, "a card that needs the owner stays marked");
  s.e.personAnswer(c.id, c.rev, c.ask!.options[0]!.id, null, "desktop");
  const after = s.post(`decision:${c.id}`)!;
  assert.deepEqual([after.isNew, after.needsOwner, after.card], [false, false, null], "answered: unmarked, read, no buttons");
  assert.match(after.outcome!, /answered: Flag it/);
});

for (const batchInbox of [false, true]) {
  test(`batchInbox ${batchInbox ? "on" : "off"}: an unanswered message on either line reaches "no reply yet", and Resend wakes its recipient again`, async () => {
    const s = setup(batchInbox);
    const wakes = (threadId: string) => s.sent.filter((x) => x.threadId === threadId).length;
    const lead = s.e.ownerMessage("kite", "Is the preview up?");
    const cos = s.e.ownerCosMessage("Is the runner healthy?");
    await s.step();
    if (batchInbox) {
      for (const a of [s.lead, s.cos]) s.e.batch.ack(a, s.e.batch.read(a).cursor!);
    }
    const state = (key: string) => s.post(key)!.self!;
    assert.equal(state(`msg:${lead.id}`).resend, false, "not before the resend time");
    const turnsAt = s.feed().turnsAt;
    assert.ok(turnsAt !== null && turnsAt > s.feed().now && turnsAt <= s.feed().now + 10 * M, "no write marks the resend time: the page is told when to read again");
    s.advance(turnsAt - s.feed().now);
    for (const key of [`msg:${lead.id}`, `msg:${cos.id}`]) assert.equal(state(key).resend, true, `${key}: due at that time, with nothing written`);
    s.advance(11 * M);
    await s.step();
    for (const key of [`msg:${lead.id}`, `msg:${cos.id}`]) {
      assert.match(state(key).state!, /no reply yet/, key);
      assert.equal(state(key).resend, true);
    }
    const before = { lead: wakes("T-lead"), cos: wakes("T-cos") };
    s.e.resendOwner(lead.id);
    s.e.resendOwner(cos.id);
    await s.step();
    for (const key of [`msg:${lead.id}`, `msg:${cos.id}`]) assert.doesNotMatch(state(key).state!, /no reply yet/, `${key}: resent, its clock starts again`);
    assert.ok(wakes("T-lead") > before.lead, "the lead is woken again");
    assert.ok(wakes("T-cos") > before.cos, "the CoS is woken again");
    if (batchInbox) {
      assert.match(s.e.batch.read(s.lead).text, new RegExp(lead.id), "unread again in the lead's digest");
      assert.match(s.e.batch.read(s.cos).text, new RegExp(cos.id));
    } else {
      assert.match(s.sent.filter((x) => x.item.id === lead.id).at(-1)!.text, /\(again\)/);
    }
    s.e.ack(s.lead, lead.id, "done", "Up now.");
    assert.throws(() => s.e.resendOwner(lead.id), /answered/);
  });
}

test("batchInbox on: Resend brings back a recipient whose inbox wake died", async () => {
  const s = setup(true);
  s.e.send(s.thread, "lead:kite", "Other unread mail under the same wake", null);
  const it = s.e.ownerMessage("kite", "Ping?");
  // the lead never acks its wakes: two attempts, then the wake is dead until its re-arm cooldown ends
  const state = () => s.e.batch.wakes().find((w) => w.recipient === "lead:kite")?.state;
  for (let i = 0; i < 6 && state() !== "dead"; i++) {
    await s.step();
    s.advance(11 * M);
  }
  await s.step();
  assert.equal(s.e.batch.wakes().find((w) => w.recipient === "lead:kite")?.state, "dead");
  const n = s.sent.filter((x) => x.threadId === "T-lead").length;
  s.e.resendOwner(it.id);
  await s.step();
  assert.ok(s.sent.filter((x) => x.threadId === "T-lead").length > n, "a real wake goes out again");
});

test("batchInbox off: the owner's message to the CoS never becomes a dead letter the CoS is told about; a lead's still goes to the CoS", async () => {
  const s = setup(false);
  const cos = s.e.ownerCosMessage("Anything stuck?");
  const lead = s.e.ownerMessage("kite", "Status?");
  for (let i = 0; i < 4; i++) {
    await s.e.flush();
    for (const t of ["T-cos", "T-lead"]) (s.e.setStatus(t, "active"), s.e.setStatus(t, "idle"));
    s.advance(24 * 3_600_000);
    s.e.tick();
  }
  const byId = (id: string) => s.e.items(500).find((x) => x.id === id)!;
  assert.equal(byId(cos.id).state, "delivered");
  assert.equal(byId(lead.id).state, "dead");
  assert.equal(s.post(`msg:${lead.id}`)!.self!.state, "no reply · with the CoS");
  s.e.resendOwner(lead.id);
  assert.equal(byId(lead.id).state, "pending", "a dead one is resent as before");
});

test("an owner's message to the CoS approves nothing: an ack bound to a PR is refused", () => {
  const s = setup();
  const it = s.e.ownerCosMessage("Merge it when green");
  assert.throws(() => s.e.ack(s.cos, it.id, "done", null, { pr: "https://github.com/o/r/pull/1", when: "green" }), /not an approval/);
});

test("the migration keys older direct messages to posts of their own", async () => {
  const { MIGRATIONS } = await import("../core/db.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE _migrations (id INTEGER PRIMARY KEY)`);
  // a database from just before the about column (later migrations come after it)
  const at = MIGRATIONS.findIndex((sql) => sql.startsWith("ALTER TABLE items ADD COLUMN about"));
  assert.ok(at > 0);
  MIGRATIONS.slice(0, at).forEach((sql, i) => {
    db.exec(sql);
    db.prepare(`INSERT INTO _migrations (id) VALUES (?)`).run(i);
  });
  db.prepare(`INSERT INTO items (id, recipient, sender, kind, body, needs_ack, state, created_at) VALUES ('i-old', 'lead:kite', 'person', 'owner.message', 'old', 1, 'closed', 1)`).run();
  db.prepare(`INSERT INTO items (id, recipient, sender, kind, body, needs_ack, state, created_at) VALUES ('i-mail', 'cos', 'lead:kite', 'message', 'm', 1, 'closed', 1)`).run();
  new Engine(db as never, { now: () => T0, deliver: async () => ({ delivery: "sent" as const }), mirror: () => {}, changed: () => {}, log: () => {} } as never);
  const about = (id: string) => (db.prepare(`SELECT about FROM items WHERE id = ?`).get(id) as { about: string | null }).about;
  assert.equal(about("i-old"), "msg:i-old");
  assert.equal(about("i-mail"), null, "mail between agents belongs to no post");
  assert.ok((db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'items_about'`).get()), "the conversation index");
});

test("You and the CoS: the owner's messages and the CoS's replies in order, with a chip for the mail to the CoS between two of the owner's messages", () => {
  const s = setup();
  const d = s.deliverable();
  const a = s.e.ownerCosMessage("Put otter on hold.");
  s.advance(M);
  s.e.replyOwner(s.cos, a.id, "Done.");
  s.advance(M);
  s.e.send(s.lead, "cos", "lead mail the CoS handles", null);
  s.e.send(s.steward, "cos", "more mail", null);
  s.advance(M);
  const dead = s.e.send(s.lead, "lead:otter", "x", null);
  s.e.retire("T-other");
  s.e.tick();
  s.e.escalateDead(s.cos, dead.id, "note");
  const post = s.feed("alerts").posts.find((p) => p.kind === "dead")!;
  s.advance(M);
  s.e.ownerCosMessage("Hand it to kite.", [], post.key);
  const line = s.e.cosLine(null);
  assert.deepEqual(line.entries.map((x) => x.kind), ["owner", "cos", "hidden", "owner"]);
  assert.ok(line.entries[2]!.hidden >= 2, "the mail between is counted, not shown");
  assert.match(line.entries[3]!.re!, /Dead letter/, "a reply under a post quotes it");
  assert.equal(line.entries[0]!.msg!.state, "answered");
  assert.ok(d);
});
