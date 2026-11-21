// Deliverables' promises (docs/deliverables-plan.md): a lead reaches the owner with finished work only, always with proof they
// can see; the proof is a file the lead may show them or a safe link; the owner's approve or send-back acts on the revision they
// looked at and reaches the lead; and the proof route serves only files that were registered as proof.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Engine, TEXT_PROOF_MAX, type DeliverResult, type ProofInput } from "../core/engine.ts";
import type { Deliverable, Item } from "../core/model.ts";
import { approveBody, deliverablesSchema } from "../contract.ts";

// No /tmp: a scratch folder beside the tests (.scratch/ is git-ignored), removed afterwards.
const scratchRoot = join(import.meta.dirname, ".scratch");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "deliverables-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function file(rel: string, text: string | Buffer = "x"): string {
  const p = join(scratch, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
}

const leadEnv = join(scratch, "lead-env");
const threadEnv = join(scratch, "thread-env");
const shared = join(scratch, "state");
const shot = file("lead-env/shots/after.png");
const testOut = file("thread-env/out/test.txt", "# pass 12\n# fail 0\n");
const report = file("state/reports/r.md");
const outside = file("elsewhere/secret.txt");
const svg = file("lead-env/shots/evil.svg", "<svg onload=alert(1)/>");
const html = file("lead-env/shots/page.html", "<script>alert(1)</script>");
const big = file("lead-env/out/huge.log", Buffer.alloc(TEXT_PROOF_MAX + 1, 97));
symlinkSync(outside, join(leadEnv, "sneaky.png"));
const place = {
  roots: [
    { path: leadEnv, hostId: "host-lead" },
    { path: threadEnv, hostId: "host-thread" },
    { path: shared, hostId: "host-lead" },
  ],
};

function setup(owner = "") {
  let clock = Date.parse("2026-11-13T18:00:00Z");
  const sent: { threadId: string; text: string; item: Item }[] = [];
  const pushed: Deliverable[] = [];
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, {
    now: () => clock,
    async deliver(threadId, text, item): Promise<DeliverResult> {
      sent.push({ threadId, text, item });
      return { delivery: "sent" };
    },
    mirror: () => {},
    changed: () => {},
    log: () => {},
    delivered: (d) => pushed.push(structuredClone(d)),
  }, { batchInbox: false, owner });
  const cos = e.register("T-cos", "cos", null);
  const steward = e.register("T-st", "steward", null);
  const lead = e.register("T-la", "lead", "alpha");
  const thread = e.register("T-w1", "thread", "alpha", "T-la");
  return { e, db, cos, steward, lead, thread, sent, pushed, advance: (ms: number) => (clock += ms) };
}

const proof: ProofInput[] = [{ kind: "image", caption: "the new checkout", path: shot }];
const deliver = (s: ReturnType<typeof setup>, p: ProofInput[] = proof, revises: string | null = null) =>
  s.e.deliver(s.lead, { title: "Checkout redesign", summary: "Shipped the new flow.", proof: p, revises }, place);

test("only a lead delivers to the owner: threads deliver to their lead, and the CoS and the Steward only ask", () => {
  const s = setup();
  for (const a of [s.thread, s.cos, s.steward]) {
    assert.throws(() => s.e.deliver(a, { title: "t", summary: "s", proof }, place), (err: Error & { kind?: string }) => err.kind === "forbidden", a.address);
  }
  assert.equal(s.e.deliverables().length, 0);
  assert.equal(s.pushed.length, 0, "nothing refused reaches the owner's push");
});

test("a deliverable without proof is refused, so the owner never reviews narration instead of evidence", () => {
  const s = setup();
  assert.throws(() => deliver(s, []), /needs proof/);
  assert.equal(s.e.deliverables().length, 0);
  assert.equal(s.e.board().filter((r) => r.kind === "deliverable").length, 0);
});

test("a proof file must be inside the lead's or its threads' folders or the shared ones, however it is reached", () => {
  const s = setup();
  for (const [why, path] of [
    ["a plain outside path", outside],
    ["a symlink inside the lead's folder pointing out", join(leadEnv, "sneaky.png")],
    ["a path climbing out with ..", join(leadEnv, "..", "elsewhere", "secret.txt")],
  ] as const) {
    assert.throws(() => deliver(s, [{ kind: "text", caption: "c", path }]), /outside your environment folder/, why);
  }
  assert.throws(() => deliver(s, [{ kind: "text", caption: "c", path: "out/test.txt" }]), /must be absolute/);
  const d = deliver(s, [
    { kind: "image", caption: "after", path: shot },
    { kind: "text", caption: "tests", path: testOut },
    { kind: "doc", caption: "notes", path: report },
  ]);
  const [a, b, c] = d.revisions[0]!.proof;
  assert.deepEqual([a!.hostId, b!.hostId, c!.hostId], ["host-lead", "host-thread", "host-lead"], "each file keeps the host of the folder it is in, for bb's preview");
});

test("proof the screen can't show safely is refused when delivered: no SVG or HTML as an image, no huge text, no unsafe links", () => {
  const s = setup();
  assert.throws(() => deliver(s, [{ kind: "image", caption: "c", path: svg }]), /image proof is one of/);
  assert.throws(() => deliver(s, [{ kind: "video", caption: "c", path: html }]), /video proof is one of/);
  assert.throws(() => deliver(s, [{ kind: "text", caption: "c", path: big }]), /at most 256 KB/);
  assert.throws(() => deliver(s, [{ kind: "link", caption: "c", url: "javascript:alert(1)" }]), /only http\(s\)/);
  assert.throws(() => deliver(s, [{ kind: "pr", caption: "c", path: testOut }]), /pr proof is a url/);
  assert.throws(() => deliver(s, [{ kind: "image", caption: "c", url: "https://x.example/a.png" }]), /image proof is a file path/);
  const hostless = { roots: [{ path: leadEnv, hostId: null }] };
  assert.throws(() => s.e.deliver(s.lead, { title: "t", summary: "s", proof: [{ kind: "doc", caption: "c", path: shot }] }, hostless), /which bb host/, "a doc the owner couldn't open in bb's preview");
  assert.equal(s.e.deliverables().length, 0);
});

test("a new deliverable is in review at rev 1, pushed once as delivered, and recorded quietly in Activity", () => {
  const s = setup();
  const d = deliver(s);
  assert.equal(d.state, "review");
  assert.equal(d.rev, 1);
  assert.deepEqual(s.pushed.map((p) => [p.id, p.rev]), [[d.id, 1]], "the push hook fires for a new deliverable");
  const rows = s.e.board().filter((r) => r.kind === "deliverable");
  assert.deepEqual(rows.map((r) => [r.title, r.from, r.project, r.ref]), [["Delivered: Checkout redesign", "lead:alpha", "alpha", d.id]]);
  assert.equal(s.e.items().length, 0, "delivering mails no agent: it waits for the owner");
});

test("The owner's request for changes reaches the lead in their words and needs an ack, so the lead can't miss it", async () => {
  const s = setup();
  const d = deliver(s);
  s.e.personRequestChanges(d.id, 1, "The button is off-centre on mobile.");
  assert.equal(s.e.deliverable(d.id)!.state, "changes");
  await s.e.flush();
  assert.equal(s.sent.length, 1);
  const { threadId, text, item } = s.sent[0]!;
  assert.equal(threadId, "T-la");
  assert.equal(item.kind, "deliverable.changes");
  assert.equal(item.needsAck, true);
  assert.match(text, /The button is off-centre on mobile\./);
  assert.match(text, new RegExp(`orch_deliver\\(revises="${d.id}"\\)`), "it tells the lead how to re-deliver");
  assert.throws(() => s.e.personRequestChanges(d.id, 1, "again"), /not in review/, "a deliverable already sent back can't be sent back twice");
  assert.throws(() => s.e.personRequestChanges(deliver(s).id, 1, "   "), /say what to change/);
});

test("only a deliverable the owner sent back can be revised; the revision bumps rev, goes back to review, and closes their request", async () => {
  const s = setup();
  const d = deliver(s);
  assert.throws(() => deliver(s, proof, d.id), /revise only a deliverable the owner sent back/, "a deliverable in review can't be swapped under the owner");
  s.e.personRequestChanges(d.id, 1, "Centre the button.");
  const other = s.e.register("T-lb", "lead", "beta");
  assert.throws(() => s.e.deliver(other, { title: "t", summary: "s", proof, revises: d.id }, place), /lead:alpha's deliverable/);

  const r = s.e.deliver(s.lead, { title: "Checkout redesign", summary: "Centred.", proof: [{ kind: "text", caption: "tests", path: testOut }], revises: d.id }, place);
  assert.equal(r.id, d.id, "a revision is the same deliverable");
  assert.equal(r.rev, 2);
  assert.equal(r.state, "review");
  assert.deepEqual(r.revisions.map((v) => v.rev), [1, 2], "the earlier revision stays in the history");
  assert.equal(s.pushed.length, 2, "the re-delivery is pushed too");
  const changes = s.e.items().filter((i) => i.kind === "deliverable.changes");
  assert.deepEqual(changes.map((i) => i.state), ["closed"], "the request is answered by the revision, so it is never resent or dead-lettered");

  s.e.personApprove(d.id, 2, null);
  assert.throws(() => deliver(s, proof, d.id), /is approved/, "an approved deliverable is final");
});

test("The owner's write on a revision they no longer see is refused, so a second tab can't approve rev 2 from rev 1", () => {
  const s = setup();
  const d = deliver(s);
  s.e.personRequestChanges(d.id, 1, "Centre the button.");
  deliver(s, proof, d.id); // the lead re-delivers: rev 2
  assert.throws(() => s.e.personApprove(d.id, 1, null), (err: Error & { kind?: string }) => err.kind === "conflict" && /rev 2, you saw 1/.test(err.message));
  assert.throws(() => s.e.personRequestChanges(d.id, 1, "x"), (err: Error & { kind?: string }) => err.kind === "conflict");
  assert.equal(s.e.deliverable(d.id)!.state, "review", "nothing changed");
  s.e.personApprove(d.id, 2, "Ship it");
  assert.throws(() => s.e.personApprove(d.id, 2, null), (err: Error & { kind?: string }) => err.kind === "bad_state", "a double click doesn't approve twice");
});

test("approval reaches the lead as a notice (no ack) and is recorded in Activity and the feedback", async () => {
  const s = setup();
  const d = deliver(s);
  const a = s.e.personApprove(d.id, 1, "Looks great");
  assert.equal(a.state, "approved");
  assert.deepEqual(a.feedback.map((f) => [f.rev, f.by, f.outcome, f.text]), [[1, "person", "approved", "Looks great"]]);
  await s.e.flush();
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0]!.item.kind, "deliverable.approved");
  assert.equal(s.sent[0]!.item.needsAck, false);
  assert.match(s.sent[0]!.text, /: The owner approved .*Looks great/, "no ownerName: the lead reads \"The owner\"");
  assert.equal(s.e.items()[0]!.state, "closed", "a notice closes once delivered");
  assert.deepEqual(s.e.board().filter((r) => r.kind === "deliverable").map((r) => r.title).sort(), ["Approved: Checkout redesign", "Delivered: Checkout redesign"]);
  assert.equal(s.pushed.length, 1, "The owner's own writes are not pushed back to them");
});

test("a lead withdraws only its own open deliverable, which leaves the owner's review and closes any open request", () => {
  const s = setup();
  const d = deliver(s);
  const other = s.e.register("T-lb", "lead", "beta");
  assert.throws(() => s.e.withdrawDeliverable(other, d.id, null), /lead:alpha's deliverable/);
  s.e.personRequestChanges(d.id, 1, "Centre it.");
  const w = s.e.withdrawDeliverable(s.lead, d.id, "superseded by the v2 plan");
  assert.equal(w.state, "withdrawn");
  assert.deepEqual(s.e.items().filter((i) => i.kind === "deliverable.changes").map((i) => [i.state, i.outcome]), [["closed", "superseded"]]);
  assert.throws(() => s.e.personApprove(d.id, 1, null), /not in review/);
  const done = deliver(s);
  s.e.personApprove(done.id, 1, null);
  assert.throws(() => s.e.withdrawDeliverable(s.lead, done.id, null), /approved/, "approved work can't be taken back");
});

test("the proof route serves only registered image, video and text files, never an unknown id, a link, or a swapped file", () => {
  const s = setup();
  const swap = file("lead-env/shots/swap.png");
  const d = deliver(s, [
    { kind: "image", caption: "after", path: shot },
    { kind: "text", caption: "tests", path: testOut },
    { kind: "doc", caption: "notes", path: report },
    { kind: "pr", caption: "the PR", url: "https://github.com/acme/app/pull/7" },
    { kind: "image", caption: "will be swapped", path: swap },
  ]);
  const [img, txt, doc, pr, swapped] = d.revisions[0]!.proof;
  assert.deepEqual(s.e.proofFile(img!.id), { path: shot, contentType: "image/png", maxBytes: null });
  assert.deepEqual(s.e.proofFile(txt!.id), { path: testOut, contentType: "text/plain; charset=utf-8", maxBytes: TEXT_PROOF_MAX }, "text is plain text, capped");

  const notFound = (err: Error & { kind?: string }) => err.kind === "not_found";
  assert.throws(() => s.e.proofFile("p-000000"), notFound, "an id never registered");
  assert.throws(() => s.e.proofFile(d.id), notFound, "a deliverable id is not a proof id");
  assert.throws(() => s.e.proofFile(pr!.id), notFound, "a PR is a link, not a file");
  assert.throws(() => s.e.proofFile(doc!.id), notFound, "a doc opens in bb's preview, not through this route");
  unlinkSync(swap);
  symlinkSync(outside, swap);
  assert.throws(() => s.e.proofFile(swapped!.id), notFound, "a registered file later swapped for a symlink out is refused");
});

test("PR proof shows the live state pr-watch last saw for the same URL", () => {
  const s = setup();
  s.e.prSeen(s.thread, "env-1", { outcome: "available", pullRequest: { url: "https://github.com/acme/app/pull/7", number: 7, state: "open", attention: "ready_to_merge", checks: { state: "passing" } } });
  assert.equal(s.e.prByUrl("https://github.com/acme/app/pull/7")?.attention, "ready_to_merge");
  assert.equal(s.e.prByUrl("https://github.com/acme/app/pull/7/")?.number, 7, "a trailing slash is the same PR");
  assert.equal(s.e.prByUrl("https://github.com/acme/app/pull/8"), null);
});

test("with ownerName set, the lead's notices name the owner, so a named setup reads as it did before the setting existed", async () => {
  const s = setup("Sam");
  const d = deliver(s);
  s.e.personApprove(d.id, 1, "Looks great");
  s.e.personRequestChanges(deliver(s).id, 1, "Bigger font");
  await s.e.flush();
  assert.match(s.sent[0]!.text, /: Sam approved .*Looks great/);
  assert.match(s.sent[1]!.text, /: Sam requested changes to /);
  assert.ok(!s.sent.some((m) => /the owner/i.test(m.text)), "never the generic words once a name is set");
});

// The next-action box (2026-11-16): the owner's usual reply to a deliverable is "now send it to someone". That must reach
// the lead as work they can't miss, and what the lead did with it must come back onto the deliverable.
test("a next action approves the deliverable and reaches its lead as one item they must ack, in the owner's words", async () => {
  const s = setup();
  const d = deliver(s);
  const a = s.e.personApprove(d.id, 1, null, "  Forward this to the team  ");
  assert.equal(a.state, "approved", "Send to lead approves it too: the owner reviews once");
  await s.e.flush();
  assert.equal(s.sent.length, 1, "one item, not a notice and an instruction");
  const { threadId, text, item } = s.sent[0]!;
  assert.equal(threadId, "T-la", "it goes to the lead that delivered it");
  assert.equal(item.kind, "deliverable.next");
  assert.equal(item.needsAck, true, "an instruction stays open until the lead reports back");
  assert.equal(item.ref, d.id);
  assert.match(text, /asks you to do next: "Forward this to the team"/);
  assert.match(text, /ack this item with an outcome and a note/, "a lead running an old brief still learns how to report back");
  assert.equal(s.e.items().filter((i) => i.state !== "closed").length, 1, "it is not closed on delivery like a notice");
  assert.deepEqual(s.e.board().filter((r) => r.title.startsWith("Approved")).map((r) => r.body), ["Next: Forward this to the team"]);
});

test("the lead's ack outcome and note show on the deliverable, in the owner's view and the CoS's, so the owner never asks how it went", async () => {
  const s = setup();
  const d = deliver(s);
  s.e.personApprove(d.id, 1, null, "Forward this to the team");
  await s.e.flush();
  const open = s.e.deliverableNext(s.e.deliverable(d.id)!)!;
  assert.deepEqual([open.text, open.state, open.outcome, open.note], ["Forward this to the team", "open", null, null]);
  assert.match(s.e.deliverablesView({}).text, /next: "Forward this to the team" → open, waiting on lead:alpha/);

  s.advance(12 * 60_000);
  s.e.ack(s.lead, s.sent[0]!.item.id, "done", "posted in #launch");
  const n = s.e.deliverableNext(s.e.deliverable(d.id)!)!;
  assert.deepEqual([n.state, n.outcome, n.note], ["closed", "done", "posted in #launch"]);
  assert.equal(n.closedAt, Date.parse("2026-11-13T18:12:00Z"), "when the lead closed it, for the page's \"12m\"");
  assert.match(s.e.deliverablesView({}).text, /next: "Forward this to the team" → done · "posted in #launch" · 2026-11-13T18:12:00/);
});

test("Done, nothing more stays a plain approval: a notice, no ack, no next action, even with only spaces in the box", async () => {
  const s = setup();
  const d = deliver(s);
  const a = s.e.personApprove(d.id, 1, null, "   ");
  await s.e.flush();
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0]!.item.kind, "deliverable.approved");
  assert.equal(s.sent[0]!.item.needsAck, false, "the lead does nothing further");
  assert.equal(s.e.deliverableNext(a), null);
  assert.doesNotMatch(s.e.deliverablesView({}).text, /next:/);
});

test("a next action on a revision the owner no longer sees is refused, and sends the lead nothing", async () => {
  const s = setup();
  const d = deliver(s);
  s.e.personRequestChanges(d.id, 1, "Centre the button.");
  deliver(s, proof, d.id); // rev 2
  await s.e.flush();
  const before = s.e.items().length;
  assert.throws(() => s.e.personApprove(d.id, 1, null, "Send this to Robin"), (err: Error & { kind?: string }) => err.kind === "conflict");
  assert.equal(s.e.items().length, before, "no instruction for a revision nobody approved");
  assert.equal(s.e.deliverable(d.id)!.next, undefined);
});

test("the page's approve body takes the next action as optional, so a page loaded before this change still approves", () => {
  assert.equal(approveBody.safeParse({ id: "v-1", rev: 1, note: null }).success, true, "an old page's body");
  assert.equal(approveBody.safeParse({ id: "v-1", rev: 1, note: null, next: "Forward this to the team" }).success, true);
  assert.equal(approveBody.safeParse({ id: "v-1", rev: 1, note: null, next: "x".repeat(4001) }).success, false);
});

test("the next action as the engine reads it fits the page's schema, open and closed, so the Deliverables tab keeps loading", async () => {
  const s = setup();
  const d = deliver(s);
  s.e.personApprove(d.id, 1, null, "Turn this into a ticket for Robin");
  await s.e.flush();
  const schema = deliverablesSchema.element.shape.next;
  assert.equal(schema.safeParse(s.e.deliverableNext(s.e.deliverable(d.id)!)).success, true, "open");
  s.e.ack(s.lead, s.sent[0]!.item.id, "refused", null);
  const closed = schema.parse(s.e.deliverableNext(s.e.deliverable(d.id)!));
  assert.deepEqual([closed?.state, closed?.outcome, closed?.note], ["closed", "refused", null]);
  assert.equal(schema.safeParse(s.e.deliverableNext(deliver(s))).success, true, "none: null");
});

test("a next action closed by the lead's reply (outcome replied) shows as such, so how the lead reported back doesn't matter", async () => {
  const s = setup();
  const d = deliver(s);
  s.e.personApprove(d.id, 1, null, "Forward this to the team");
  await s.e.flush();
  // a reply that names the item closes it as "replied" with the reply's words; written here as that path leaves the row
  s.db.prepare(`UPDATE items SET state = 'closed', closed_at = ?, outcome = 'replied', note = ? WHERE id = ?`).run(Date.parse("2026-11-13T18:05:00Z"), "sent to the team by email", s.sent[0]!.item.id);
  const n = s.e.deliverableNext(s.e.deliverable(d.id)!)!;
  assert.deepEqual([n.state, n.outcome, n.note], ["closed", "replied", "sent to the team by email"]);
  assert.match(s.e.deliverablesView({}).text, /next: "Forward this to the team" → replied · "sent to the team by email"/);
  assert.equal(deliverablesSchema.element.shape.next.safeParse(n).success, true);
});
