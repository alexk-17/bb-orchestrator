// A busy orchestrator, made-up data only: a CoS, a Steward, 6 leads and 26 threads (34 agents), open and answered cards,
// mail, reports, lead status, scoping tasks, deliverables, PR readings (one merged, one on a card), rules and the owner's
// direct lines.
// The read map's test (test/change-reads.test.ts) and the lag QA's isolated bb both seed from it.
import type { Engine, PrResult } from "../../core/engine.ts";
import type { Agent } from "../../core/model.ts";
import { statusParams } from "../../core/status.ts";

export const BUSY_PROJECTS = ["kite-app", "fjord-mobile", "pine-api", "mesa-web", "harbor-docs", "otter-cli"] as const;

export const pr = (n: number, state: string, checks = "passing"): PrResult =>
  ({ outcome: "available", pullRequest: { url: `https://github.com/example-org/demo/pull/${n}`, number: n, state, attention: "none", checks: { state: checks }, review: { state: "approved" }, mergeability: { mergeable: "MERGEABLE", state: "clean" } } }) as never;

/** `tick(ms)` moves the engine's clock; `proof` is an image path the deliverables show. Returns the agents by role. */
export function seedBusy(e: Engine, tick: (ms: number) => void, proof: string) {
  const reg = (t: string, role: string, project: string | null, parent: string | null = null): Agent => e.agentByThread(t) ?? e.register(t, role as never, project, parent);
  const cos = reg("thr_busy_cos", "cos", null);
  reg("thr_busy_steward", "steward", null);
  const leads = BUSY_PROJECTS.map((slug) => reg(`thr_busy_lead_${slug}`, "lead", slug));
  const threads: Agent[] = [];
  for (let i = 0; i < 26; i++) {
    const lead = leads[i % leads.length]!;
    threads.push(reg(`thr_busy_t${i}`, "thread", lead.project, lead.threadId));
  }
  const place = { roots: [{ path: proof.slice(0, proof.lastIndexOf("/")), hostId: null }] };
  leads.forEach((lead, i) => {
    tick(60_000);
    e.publishStatus(lead, statusParams.parse({ goal: `Made-up goal ${i + 1}`, steps: [{ title: "Plan", state: "done" }, { title: "Build", state: "current" }, { title: "Ship", state: "next" }], blockers: i === 0 ? ["Waiting on a design call"] : [] }));
  });
  threads.forEach((t, i) => {
    tick(30_000);
    e.setStatus(t.threadId, i % 3 === 0 ? "active" : "idle");
    e.send(t, leads[i % leads.length]!.address, `Made-up progress note ${i}`, null);
    if (i % 4 === 0) e.report(t, `Made-up report ${i}`, `Finished part ${i}.`, null);
    if (i % 5 === 0) e.prSeen(t, `env-busy-${i}`, pr(100 + i, i === 0 ? "merged" : "open"));
  });
  // cards: open ones put to the owner, and answered ones
  const toOwner = (by: Agent, title: string, prUrl?: string) => {
    const d = e.ask(by, { title, question: `${title}?`, options: [{ label: "Go" }, { label: "Wait" }], ...(prUrl ? { blocks: [{ kind: "pr" as const, url: prUrl }] } : {}) });
    return e.triageAskPerson(cos, d.id, { question: `${title}?`, options: [{ label: "Go" }, { label: "Wait" }], allowText: true });
  };
  // one about a PR bb has a reading of: the card shows that reading's checks
  const open = leads.slice(0, 4).map((l, i) => toOwner(l, `Made-up question ${i}`, i === 1 ? "https://github.com/example-org/demo/pull/110" : undefined));
  tick(60_000);
  const answered = toOwner(leads[4]!, "Made-up answered question");
  e.personAnswer(answered.id, answered.rev, answered.ask!.options[0]!.id, null, "desktop");
  // scoping
  e.setMode("harbor-docs", "scoping", "person");
  const task = e.openTask(leads[4]!, "Made-up scoping task");
  // deliverables in review
  const delivered = leads.slice(0, 3).map((l, i) => e.deliver(l, { title: `Made-up deliverable ${i}`, summary: "A made-up result.", proof: [{ kind: "image", caption: "A made-up screen", path: proof }] }, place));
  // decided ones: approved with a next move its lead acked (Delivered shows that item's outcome), with a PR as proof;
  // and one sent back for changes
  const withNext = e.deliver(leads[3]!, { title: "Made-up deliverable with a next move", summary: "A made-up result.", proof: [{ kind: "pr", caption: "The made-up PR", url: "https://github.com/example-org/demo/pull/100" }] }, place);
  const approved = e.personApprove(withNext.id, withNext.rev, null, "Made-up: ship it to the team");
  e.ack(leads[3]!, approved.next!.item, "done", "Made-up: shipped");
  const sentBack = e.deliver(leads[4]!, { title: "Made-up deliverable sent back", summary: "A made-up result.", proof: [{ kind: "image", caption: "A made-up screen", path: proof }] }, place);
  e.personRequestChanges(sentBack.id, sentBack.rev, "Made-up: tighten the copy");
  e.addOutput(leads[0]!, { title: "Made-up output", kind: "image", path: proof }, { roots: place.roots.map((r) => r.path), hostId: null });
  // the owner's direct lines, one answered
  tick(60_000);
  const direct = e.ownerMessage("kite-app", "Made-up direct message");
  e.ack(leads[0]!, direct.id, "done", "Made-up reply");
  const toCos = e.ownerCosMessage("Made-up note to the CoS");
  e.replyOwner(cos, toCos.id, "Made-up CoS reply");
  e.addRule({ text: "Made-up standing rule", project: null, kinds: ["question"], expiresAt: null, source: "owner" });
  // a PR wait with a reading (the Watchers list reads both)
  e.watchAdd(cos, { to: leads[1]!.address, pr: "https://github.com/example-org/demo/pull/105", when: "merged", note: "Made-up wait" });
  e.waitPrSeen(pr(105, "open"));
  e.boardAdd("notice", "orchestrator", "kite-app", "Made-up notice", "", null);
  return { cos, leads, threads, open, task, delivered };
}
