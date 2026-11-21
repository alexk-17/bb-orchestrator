// Generative UI blocks on the owner's cards (blocks.ts). What matters: a lead can hand them a sign-in as a link, a code and an
// expiry instead of prose, bad blocks are refused at the engine, and a code he pastes back never lands in the decision
// record (on 2026-11-13 a pasted gcloud code sat in decisions/*.json and data.db).
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Engine, type DeliverResult } from "../core/engine.ts";
import { looksLikeCode } from "../blocks.ts";
import type { Item } from "../core/model.ts";

function setup() {
  const sent: { threadId: string; text: string; item: Item }[] = [];
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, {
    now: () => Date.parse("2026-11-13T20:00:00Z"),
    async deliver(threadId, text, item): Promise<DeliverResult> {
      sent.push({ threadId, text, item });
      return { delivery: "sent" };
    },
    mirror: () => {},
    changed: () => {},
    log: () => {},
  }, { batchInbox: false });
  const cos = e.register("T-cos", "cos", null);
  const lead = e.register("T-la", "lead", "alpha");
  return { e, db, cos, lead, sent };
}

const opts = [{ label: "I signed in" }, { label: "Link expired, mint new" }];
const login = { kind: "login" as const, service: "gcloud (prod)", url: "https://auth.cloud.google/signin?x=1", expires_at: "2026-11-13T20:10:00Z", paste: true };

function toOwner(s: ReturnType<typeof setup>, blocks: unknown[]) {
  const d = s.e.ask(s.lead, { title: "Prod sign-in", question: "Sign in to prod gcloud?", options: opts, blocks: blocks as never });
  s.e.triageAskPerson(s.cos, d.id, { question: "Sign in to prod gcloud?", options: opts, allowText: true });
  return s.e.needsYou().cards.find((c) => c.id === d.id)!;
}

test("a lead's blocks reach the owner's card intact, through the CoS's rewrite", () => {
  const s = setup();
  const steps = { kind: "steps" as const, items: [{ text: "Activate the PIM group", expect: "Active" }, { text: "Open the link" }] };
  const card = toOwner(s, [login, steps]);
  const d = s.e.decision(card.id)!;
  assert.deepEqual(d.request.blocks, [login, steps]);
});

test("a malformed block is refused when asked, not drawn broken on the owner's screen", () => {
  const s = setup();
  assert.throws(() => s.e.ask(s.lead, { title: "t", question: "q", options: opts, blocks: [{ kind: "login", service: "x", url: "javascript:alert(1)" }] as never }), /blocks/);
  assert.throws(() => s.e.ask(s.lead, { title: "t", question: "q", options: opts, blocks: [{ kind: "chart" }] as never }), /blocks/);
});

test("a pasted code answers the card with a file path only, and is refused where no code was asked for", async () => {
  const s = setup();
  const card = toOwner(s, [login]);
  s.e.personSecret(card.id, card.rev, "/state/secrets/x.txt", "desktop");
  await s.e.flush();
  const d = s.e.decision(card.id)!;
  assert.equal(d.state, "answered");
  assert.match(d.answer!.text!, /\/state\/secrets\/x\.txt/, "the asker learns where to read it");
  assert.ok(s.sent.some((x) => x.threadId === "T-la" && x.text.includes("/state/secrets/x.txt")), "the answer reaches the lead");

  const plain = toOwner(s, [{ kind: "facts", items: [{ label: "Usage", value: "97%" }] }]);
  assert.throws(() => s.e.personSecret(plain.id, plain.rev, "/state/secrets/y.txt", "desktop"), /doesn't ask for a code/);
});

test("a code typed into Other is recognised, and ordinary answers are not", () => {
  // the shape of the two gcloud codes that sat in decisions on 2026-11-13 (a made-up value)
  const fake = "4/0ART" + "x9Kq2_Lm-7".repeat(30);
  assert.equal(looksLikeCode(fake), true);
  assert.equal(looksLikeCode(`  ${fake}\n`), true, "a stray newline from the paste");
  assert.equal(looksLikeCode("ghp_" + "a1".repeat(20)), true);
  for (const plain of [
    "Start only thread 1 for now; thread 2 after the security PRs land.",
    "https://github.com/example-org/example-app/pull/1424/files#diff-0123456789abcdef0123",
    "yes",
    "WXYZ-1234",
    "averyveryverylongwordwithoutanydigitsatallbutstillnospaces",
  ])
    assert.equal(looksLikeCode(plain), false, plain);
  assert.equal(looksLikeCode(null), false);
});

test("a typed code answers any card with a file path, even one that asked for no code", async () => {
  const s = setup();
  const plain = toOwner(s, [{ kind: "facts", items: [{ label: "Usage", value: "97%" }] }]);
  s.e.personSecret(plain.id, plain.rev, "/state/secrets/z.txt", "desktop", true);
  await s.e.flush();
  const d = s.e.decision(plain.id)!;
  assert.equal(d.state, "answered");
  assert.match(d.answer!.text!, /\/state\/secrets\/z\.txt/);
});

test("a deliverable carries its checks with each revision, and can't carry a sign-in", () => {
  const s = setup();
  const proof = [{ kind: "link" as const, caption: "the run", url: "https://example.com/run/1" }];
  const checks = { kind: "checks" as const, items: [{ text: "Unit tests", ok: true, how: "133 pass" }, { text: "Phone check", ok: false }] };
  const d = s.e.deliver(s.lead, { title: "Fix", summary: "Done.", proof, blocks: [checks] }, { roots: [] });
  assert.deepEqual(d.revisions[0]!.blocks, [checks], "The owner sees what was proven, per revision");
  assert.throws(() => s.e.deliver(s.lead, { title: "Fix", summary: "Done.", proof, blocks: [login] }, { roots: [] }), /no sign-in/);
});
