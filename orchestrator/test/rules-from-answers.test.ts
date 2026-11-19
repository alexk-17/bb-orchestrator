// Rules from answers (2026-11-16). The owner answered 115 cards in 2.4 days, and 69% took the recommended option, yet
// no standing rule existed. Now the CoS is offered a rule once the owner has answered 2-3 cards the same way. The owner
// approves it on one "Make this a rule?" card, and later matching cards are settled by it without reaching them. What
// matters: a rule never settles a card it doesn't match (a false match settles something the owner should have seen),
// it never answers a card differently from how the owner did, and merges, sign-ins and production stay with the owner.
// The fixtures are the real candidates from 11-13..11-16, shortened to the caps and neutralised: preview recreate 3/3
// (the third answered with option 2), QA setup fixes (8/8 recommended, two of them a flag override and a sign-in), and
// the nightly memory publish 2/2.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, type AskInput, type DeliverResult } from "../core/engine.ts";
import type { Agent, Decision, Item } from "../core/model.ts";
import { allowFrom, matchRule, shapeOf } from "../core/rules.ts";

function setup() {
  let clock = Date.parse("2026-11-14T03:00:00Z");
  const sent: Item[] = [];
  const up: string[] = [];
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, {
    now: () => clock,
    async deliver(_t, _x, item): Promise<DeliverResult> {
      sent.push(item);
      return { delivery: "sent" };
    },
    mirror: () => {},
    changed: () => {},
    cardUp: (d) => up.push(d.id),
    log: () => {},
  });
  const cos = e.register("T-cos", "cos", null);
  const files = e.register("T-lf", "lead", "files");
  const qa = e.register("T-lq", "lead", "qa");
  const other = e.register("T-lo", "lead", "other");
  const qaThreads = [1, 2, 3, 4, 5].map((n) => e.register(`T-q${n}`, "thread", "qa", "T-lq"));
  return { e, db, cos, files, qa, other, qaThreads, sent, up, advance: (ms: number) => (clock += ms) };
}
type S = ReturnType<typeof setup>;

/** A card from `by` through the CoS to the owner, answered with `option`. A thread's card is filed up by its lead. */
function answered(s: S, by: Agent, input: AskInput, option: string): Decision {
  let d = s.e.ask(by, input);
  if (by.role === "thread") d = s.e.forward(s.qa, d.id, null);
  s.e.triageAskPerson(s.cos, d.id, { question: input.question, options: input.options, allowText: true });
  s.advance(5 * 60_000);
  return s.e.personAnswer(d.id, s.e.decision(d.id)!.rev, option, null, "desktop");
}
const offers = (s: S) => (s.db.prepare(`SELECT body FROM items WHERE recipient = 'cos' AND send_key LIKE 'rule-offer:%'`).all() as { body: string }[]).map((r) => r.body);
const proposalOf = (s: S) => s.e.needsYou().cards.find((c) => c.orchestrator.rule_proposal)!;
const approve = (s: S, d: Decision) => s.e.personAnswer(d.id, d.rev, "1", null, "phone");

const preview: AskInput[] = [
  {
    title: "1100 has no preview branch to repair. Recreate it?",
    question: "1100 has no staging preview branch, so there is nothing to repair. Recreate it? A new branch applies every migration from scratch.",
    options: [{ label: "Recreate 1100's preview (needs your go)" }, { label: "Leave it skipped" }, { label: "Close and reopen the PR to recreate it" }],
  },
  {
    title: "Recreate 1099's staging preview too?",
    question: "1099 is stacked on 1100 and lost its preview branch, so its migration won't be proven on any staging preview. Recreate it too?",
    options: [{ label: "Yes, recreate 1099's preview too", detail: "One more billed preview branch" }, { label: "No, prove it at the pre-merge run" }],
  },
  {
    title: "Fix 1099's red staging Preview check?",
    question: "1099's staging preview database still holds the lock table from its old migration, so the check is red. What should we do with it?",
    options: [{ label: "Leave it red, fix before merge" }, { label: "Recreate 1099's preview database now", detail: "Delete and recreate it, preview only" }, { label: "Drop the empty lock table" }],
  },
];

/** The three preview answers, the offer, the CoS's proposal and the owner's yes: the rule is live. */
function previewRule(s: S) {
  answered(s, s.files, preview[0]!, "1");
  answered(s, s.files, preview[1]!, "1");
  assert.equal(offers(s).length, 0, "two cards that only look alike aren't an offer yet");
  const third = answered(s, s.files, preview[2]!, "2");
  assert.equal(offers(s).length, 1, "the third answered the same way (recreate, though not the recommended option): the CoS is offered a rule");
  assert.match(offers(s)[0]!, /Rule offer ro-\w+: the owner answered 3 cards \(project files\) the same way/);
  assert.match(offers(s)[0]!, /triage\(action=propose_rule, id="d-[^"]+", note=/, "the offer spells the exact call");
  const card = s.e.proposeRule(s.cos, third.id, "files: when a staging preview is gone or broken, recreate it", null);
  assert.equal(card.ask!.title, "Make this a rule?");
  assert.ok(card.ask!.question.length <= 160, "the proposal fits the card caps it is held to");
  assert.deepEqual(card.orchestrator.rule_proposal!.evidence.length, 3, "the card carries its evidence ids");
  assert.deepEqual(s.up.at(-1), card.id, "it went up to the owner");
  approve(s, card);
  const rule = s.e.rules()[0]!;
  assert.ok(rule.match, "the owner's yes added a rule that matches by itself");
  return rule;
}

test("preview recreate 3/3: after the owner's yes, the next recreate card is settled by the rule and never reaches them", async () => {
  const s = setup();
  const rule = previewRule(s);
  s.up.length = 0;
  const next = s.e.ask(s.files, {
    title: "1110 lost its staging preview: recreate it?",
    question: "1110's staging preview branch is gone, so its migration isn't proven. Recreate the preview?",
    options: [{ label: "Recreate 1110's preview" }, { label: "Leave it" }],
  });
  assert.equal(next.state, "answered");
  assert.equal(next.answer!.option, "1");
  assert.equal(next.answer!.source, `rule ${rule.id}`);
  assert.equal(s.up.length, 0, "no card went up");
  assert.equal(s.e.needsYou().cards.length + s.e.needsYou().triaging.length, 0, "not on Needs you, not with the CoS for triage");
  await s.e.flush();
  assert.ok(s.sent.some((i) => i.recipient === "lead:files" && i.kind === "decision.answer" && i.ref === next.id), "the asker gets the answer");
  assert.ok(s.sent.some((i) => i.recipient === "cos" && i.kind === "notice" && i.body.includes(`Standing rule ${rule.id} settled ${next.id}`)), "the CoS hears which rule settled it");
});

test("a rule never settles a card it doesn't match: another answer, production, two fits, another project, a merge", () => {
  const s = setup();
  previewRule(s);
  const misses: [Agent, AskInput][] = [
    // no option says recreate preview
    [s.files, { title: "Drop 1110's staging preview?", question: "1110's staging preview database has a stale migration. Drop the preview database?", options: [{ label: "Drop the preview database" }, { label: "Keep it" }] }],
    // it would approve a production change
    [s.files, { title: "Recreate the prod staging preview?", question: "The prod staging preview lost its migration history. Recreate it?", options: [{ label: "Recreate the prod preview" }, { label: "Leave it" }] }],
    // two options carry the answer's words: which one the owner meant is theirs to say
    [s.files, { title: "When to recreate 1110's staging preview?", question: "1110's staging preview lost its migration. Recreate it now or after the rebase?", options: [{ label: "Recreate the preview now" }, { label: "Recreate the preview after the rebase" }] }],
    // the same words from another project
    [s.other, { title: "Recreate 12's staging preview?", question: "12's staging preview lost its migration. Recreate it?", options: [{ label: "Recreate 12's preview" }, { label: "Leave it" }] }],
  ];
  for (const [by, input] of misses) assert.equal(s.e.ask(by, input).state, "open", input.title);
  const merge = s.e.ask(s.files, { ...misses[0]![1], title: "Merge 1110 and recreate its staging preview?", options: [{ label: "Recreate 1110's preview and merge" }, { label: "Wait" }], action: "merge" });
  assert.equal(merge.state, "open", "a merge card is the owner's alone");
  assert.equal(s.e.needsYou().triaging.length, 5, "all five went to the CoS as usual");
});

// 2026-11-16, the lead's call: the stop list reads the whole card again. "No production change without the owner's go"
// can't hang on whether a word lands in a label or a detail. A stop word passes only in a field where the owner saw it
// on one of the rule's evidence cards, never in the option the rule picks, and never prod or production.
test("the stop list reads the whole card: a detail-only prod is never settled, and a word passes only where the owner saw it", () => {
  const s = setup();
  const rule = previewRule(s);
  const card = (over: Partial<AskInput>, pick = "Recreate 1110's preview"): AskInput => ({
    title: "1110 lost its staging preview: recreate it?",
    question: "1110's staging preview branch is gone, so its migration isn't proven. Recreate the preview?",
    options: [{ label: pick }, { label: "Leave it" }],
    ...over,
  });
  const prodDetail = s.e.ask(s.files, card({ options: [{ label: "Recreate 1110's preview", detail: "It points at the prod project" }, { label: "Leave it" }] }));
  assert.equal(prodDetail.state, "open", "a prod in a detail alone keeps the card from the rule");
  assert.equal(prodDetail.orchestrator.at_level, "cos", "it goes to the CoS as usual");
  assert.match((matchRule(rule.match!, prodDetail) as { miss: string }).miss, /"prod" in the detail/);
  const billed = s.e.ask(s.files, card({ options: [{ label: "Recreate 1110's preview", detail: "One more billed preview branch" }, { label: "Leave it" }] }));
  assert.equal(billed.state, "answered", "billed in a detail: the owner saw it there on an evidence card and answered");
  const billedQuestion = s.e.ask(s.files, card({ question: "1110's billed staging preview branch is gone. Recreate the preview?" }));
  assert.equal(billedQuestion.state, "open", "billed in the question: the owner never saw it there");
  const dropPick = s.e.ask(s.files, card({}, "Recreate 1110's preview and drop the lock table"));
  assert.equal(dropPick.state, "open", "drop was in an evidence label, but never in the option a rule picks");
  // prod is never exempt, even from evidence that had it, or from an allow list that names it
  const proposal = s.e.decision(rule.source.match(/card (d-[\w-]+)/)![1]!)!;
  const ev = s.e.decision(proposal.orchestrator.rule_proposal!.evidence[0]!)!;
  const withProd = { ...ev, request: { ...ev.request, options: ev.request.options.map((o) => ({ ...o, detail: "on prod" })) } };
  assert.ok(!allowFrom([withProd]).some((a) => a.word === "prod"), "an evidence card's prod is no exemption");
  assert.ok("miss" in matchRule({ ...rule.match!, allow: [...(rule.match!.allow ?? []), { word: "prod", field: "detail" }] }, prodDetail), "nor is a stored allow that names it");
});

test("the CoS can't cite a rule from answers on a card it doesn't match, or with another option", () => {
  const s = setup();
  const rule = previewRule(s);
  const drop = s.e.ask(s.files, { title: "Drop 1110's staging preview?", question: "1110's staging preview database has a stale migration. Drop the preview database?", options: [{ label: "Drop the preview database" }, { label: "Keep it" }] });
  assert.throws(() => s.e.triageSettle(s.cos, drop.id, rule.id, "1", null), new RegExp(`rule ${rule.id} doesn't cover ${drop.id}: no option says recreate preview`));
  assert.equal(s.e.decision(drop.id)!.state, "open");
});

const qaCards: AskInput[] = [
  {
    title: "R1 launcher missing dependencies",
    question: "How should QA run R1 resume after the launcher setup fails on missing dependencies?",
    options: [{ label: "Repair the worktree prerequisites (recommended)" }, { label: "Reassign to a prepared worktree" }, { label: "Accept blocked R1 report" }],
  },
  { title: "R3 QA launcher exits before report", question: "How should QA run R3 resume after the launcher exits before any QA report?", options: [{ label: "Repair the launcher, then rerun R3" }, { label: "Accept R3 blocked report for now" }] },
  {
    title: "Unblock 1249 and 1397 in QA?",
    question: "Two QA cases are blocked by setup: 1249 needs a dev SSO login, 1397 a dev flag override. Unblock either, or report both blocked?",
    options: [{ label: "Unblock both" }, { label: "Only the SSO login" }, { label: "Only the flag override" }, { label: "Neither: report both BLOCKED" }],
  },
];
const override: AskInput = {
  title: "Dev override to test 1183 memory?",
  question: "QA case 1183 can't run: the dev gate passes nobody. Allow a temporary dev-only override for the test account, or report it blocked?",
  options: [{ label: "Allow the dev override for the test account" }, { label: "No: report 1183 BLOCKED" }],
};

test("QA setup fixes 8/8 recommended: offered, but no rule can name the answer, so a flag override still reaches the owner", () => {
  const s = setup();
  const done = qaCards.map((c, i) => answered(s, s.qaThreads[i]!, c, "1"));
  assert.equal(offers(s).length, 1, "the same lead's threads, the recommended option over an 'accept it as blocked' each time: an offer");
  assert.match(offers(s)[0]!, /Their answers share no words, so no rule can name the option/);
  // the offer's own rule names no option: refused
  assert.throws(() => s.e.proposeRule(s.cos, done[0]!.id, "qa: fix the setup and rerun", null), /rule\.option names the words of the option/);
  // a rule anchored on the option position in disguise ("the one that isn't 'blocked'") can't be written; one on
  // "blocked" would answer the owner's own cards the other way, and is refused for it
  assert.throws(() => s.e.proposeRule(s.cos, done[0]!.id, "qa: report blocked", { words: ["qa"], option: ["blocked"] }), /would answer d-\S+ "R1 launcher missing dependencies" with option 3, but the owner chose "Repair the worktree prerequisites/);
  // one narrow enough to be safe fits a single card: not enough evidence
  assert.throws(() => s.e.proposeRule(s.cos, done[0]!.id, "qa: rerun", { words: ["qa"], option: ["rerun"] }), /fits 1 of the 3 cards it comes from; it needs 2/);
  assert.equal(s.e.needsYou().cards.length, 0, "no proposal card went up");
  // so the dev flag override, also a recommended "not blocked" answer, is the owner's to give
  const d = s.e.forward(s.qa, s.e.ask(s.qaThreads[3]!, override).id, null);
  assert.equal(d.state, "open");
  assert.equal(d.orchestrator.at_level, "cos");
});

test("dream publish 2/2: the same key and answer twice is an offer; with the rule, the next night's card publishes without a card", () => {
  const s = setup();
  const night = (date: string) => ({
    title: "Publish 5 memory pages?",
    question: `The nightly memory batch (${date}) has 5 memory pages ready for the vault. Publish them?`,
    context: "Pages: deploy notes, merge checklist, alerts watch, preview rules, QA runs.",
    options: [{ label: "Publish the 5 ready pages" }, { label: "Publish none" }],
    key: `memory:dream-${date}`,
    allowText: false,
  });
  for (const date of ["2026-11-14", "2026-11-15"]) {
    const d = s.e.orchestratorAsk(night(date));
    s.e.personAnswer(d.id, d.rev, "1", null, "phone");
    s.advance(86_400_000);
  }
  assert.equal(offers(s).length, 1);
  const evidence = (s.db.prepare(`SELECT evidence FROM rule_offers`).get() as { evidence: string }).evidence;
  s.e.proposeRule(s.cos, JSON.parse(evidence)[0], "Publish the nightly memory pages that are ready", null);
  approve(s, proposalOf(s));
  s.up.length = 0;
  const third = s.e.orchestratorAsk(night("2026-11-16"));
  assert.equal(third.state, "answered", "settled at filing: the dreams service reads option 1 and publishes");
  assert.equal(third.answer!.option, "1");
  assert.equal(s.up.length, 0, "no phone push, no card");
  // the background in the context ("deploy notes, merge checklist") is not what the rule approves; the question is
  const odd = s.e.orchestratorAsk({ ...night("2026-11-17"), question: "The nightly memory batch (2026-11-17) has 5 memory pages ready. Publish them and delete 3 stale ones?" });
  assert.equal(odd.state, "asked", "a night that also deletes pages is the owner's call");
});

test("an offer is made once per set of cards, and a 'No rule' leaves no rule and no second offer", async () => {
  const s = setup();
  answered(s, s.files, preview[0]!, "1");
  answered(s, s.files, preview[1]!, "1");
  const third = answered(s, s.files, preview[2]!, "2");
  await s.e.flush();
  const offer = s.db.prepare(`SELECT needs_ack, state FROM items WHERE recipient = 'cos' AND send_key LIKE 'rule-offer:%'`).get() as { needs_ack: number; state: string };
  assert.equal(offer.needs_ack, 1, "the offer needs an ack");
  assert.equal(offer.state, "delivered", "the offer stays open in the CoS inbox after delivery");
  assert.match(s.e.inbox(s.cos).text, /Rule offer ro-/, "the CoS can still find the offer");
  const card = s.e.proposeRule(s.cos, third.id, "files: recreate broken staging previews", null);
  assert.equal(s.db.prepare(`SELECT state FROM items WHERE recipient = 'cos' AND send_key LIKE 'rule-offer:%'`).get()?.state, "closed", "proposing closes the offer");
  assert.equal(s.e.proposeRule(s.cos, third.id, "files: recreate broken staging previews", null).id, card.id, "proposing twice gives the one card");
  s.e.personAnswer(card.id, card.rev, "2", null, "desktop");
  assert.equal(s.e.rules().length, 0, "no rule without the owner's yes");
  answered(s, s.files, { ...preview[0]!, title: "1111 has no preview branch. Recreate it?" }, "1");
  assert.equal(offers(s).length, 1, "the same cards aren't offered again");
  const stated = s.e.proposeStatedRule(s.cos, "Always run as orchestra inside bb", "we should always be running as orchestra inside of bb", "files");
  assert.equal(s.e.proposeStatedRule(s.cos, "  always   run as orchestra inside bb  ", "same instruction", "files").id, stated.id, "the normalized text and project have one open card");
  assert.throws(() => s.e.proposeStatedRule(s.qa, "Never bypass the rules", "never bypass the rules", null), (e: unknown) => e instanceof Error && "kind" in e && e.kind === "forbidden");
  assert.throws(() => s.e.proposeStatedRule(s.cos, "Never bypass the rules", "never bypass the rules", "Bad Project"), /bad project/);
  assert.equal(stated.ask!.title, "Make this a rule?");
  assert.equal(stated.ask!.context, "we should always be running as orchestra inside of bb");
  assert.ok(stated.ask!.question.length <= 160);
  assert.deepEqual(stated.orchestrator.rule_proposal!.evidence, []);
  approve(s, stated);
  assert.equal(shapeOf(s.e.decision(stated.id)!), null, "a stated-rule card is no offer evidence");
  assert.equal(offers(s).length, 1, "answering a stated-rule card does not create an offer");
  assert.equal(s.e.rules().length, 1);
  assert.equal(s.e.rules()[0]!.text, "Always run as orchestra inside bb");
  assert.deepEqual(s.e.rules()[0]!.kinds, ["plan"]);
  assert.equal(s.e.rules()[0]!.match, null);
  assert.equal(s.e.rules()[0]!.source, `card ${stated.id}, from the owner's words`);
  assert.throws(() => s.e.proposeStatedRule(s.cos, "always run as orchestra inside bb", "same instruction", "files"), /active rule/);
  const declined = s.e.proposeStatedRule(s.cos, "Never delete previews", "never delete previews", "files");
  s.e.personAnswer(declined.id, declined.rev, "2", null, "desktop");
  assert.equal(s.e.rules().length, 1, "No rule leaves the stated instruction off the Rules list");
});

test("a CoS on the old schema can propose with just id and note: the offer's own rule is used", () => {
  const s = setup();
  answered(s, s.files, preview[0]!, "1");
  answered(s, s.files, preview[1]!, "1");
  const third = answered(s, s.files, preview[2]!, "2");
  const card = s.e.proposeRule(s.cos, third.id, "files: recreate broken staging previews", null);
  assert.deepEqual(card.orchestrator.rule_proposal!.match!.option, ["recreate", "preview"]);
  assert.throws(() => s.e.proposeRule(s.qa as Agent, third.id, "x", null), /only the CoS proposes a rule/);
  assert.throws(() => s.e.proposeRule(s.cos, "d-nope", "x", null), /isn't in a rule offer/);
});

test("the CoS reorders or rewords the asker's options: the owner's pick is tied back by its label, not its position", () => {
  const s = setup();
  // the CoS puts the asker's option 2 first; the owner picks the CoS's option 2, which is the asker's "recreate"
  for (const input of preview.slice(0, 2)) {
    const d = s.e.ask(s.files, input);
    const flipped = [input.options[1]!, input.options[0]!, ...input.options.slice(2)];
    s.e.triageAskPerson(s.cos, d.id, { question: input.question, options: flipped, allowText: true });
    s.advance(5 * 60_000);
    s.e.personAnswer(d.id, s.e.decision(d.id)!.rev, "2", null, "desktop");
  }
  const third = answered(s, s.files, preview[2]!, "2");
  const card = s.e.proposeRule(s.cos, third.id, "files: recreate broken staging previews", null);
  assert.deepEqual(card.orchestrator.rule_proposal!.match!.option, ["recreate", "preview"], "the evidence reads the asker's option the owner meant");
  assert.match(card.ask!.context, /It fits 3 of the 3 cards/);
});

test("a card whose pick can't be told is no evidence, and a rule that would match it is refused", () => {
  const s = setup();
  answered(s, s.files, preview[0]!, "1");
  answered(s, s.files, preview[1]!, "1");
  const third = answered(s, s.files, preview[2]!, "2");
  // the CoS rewrote every label: which of the asker's options the owner chose can't be told
  const d = s.e.ask(s.files, { ...preview[0]!, title: "1112 has no preview branch. Recreate it?", question: "1112 has no staging preview branch. Recreate it? A new branch applies every migration from scratch." });
  s.e.triageAskPerson(s.cos, d.id, { question: "1112: start over?", options: [{ label: "Start over" }, { label: "Skip" }, { label: "Reopen" }], allowText: true });
  s.e.personAnswer(d.id, s.e.decision(d.id)!.rev, "2", null, "desktop");
  assert.throws(() => s.e.proposeRule(s.cos, third.id, "files: recreate broken staging previews", null), /matches d-\S+ "1112 has no preview branch\. Recreate it\?", where it can't be told which/);
});

test("the owner's yes works however many answers the rule comes from (a first offer can carry two weeks of them)", () => {
  let clock = Date.parse("2026-11-01T07:00:00Z");
  const e = new Engine(new DatabaseSync(":memory:") as never, { now: () => clock, deliver: async (): Promise<DeliverResult> => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} });
  const night = (n: number) => ({ title: "Publish 5 memory pages?", question: `The nightly memory batch (2026-11-${String(n).padStart(2, "0")}) has 5 memory pages ready for the vault. Publish them?`, options: [{ label: "Publish the 5 ready pages" }, { label: "Publish none" }], key: `memory:dream-2026-11-${String(n).padStart(2, "0")}`, allowText: false });
  for (let n = 1; n <= 7; n++) {
    const d = e.orchestratorAsk(night(n));
    e.personAnswer(d.id, d.rev, "1", null, "phone");
    clock += 86_400_000;
  }
  const cos = e.register("T-cos", "cos", null); // installed now: the next answer sees the week before
  const eighth = e.orchestratorAsk(night(8));
  e.personAnswer(eighth.id, eighth.rev, "1", null, "phone");
  const card = e.proposeRule(cos, eighth.id, "Publish the nightly memory pages that are ready", null);
  assert.equal(card.orchestrator.rule_proposal!.evidence.length, 8);
  e.personAnswer(card.id, card.rev, "1", null, "phone");
  assert.equal(e.rules().length, 1);
});
