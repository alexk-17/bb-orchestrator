import { pathwaysGraph, type PathwaysEdge, type PathwaysMap, type PathwaysState, type PathwaysTicket } from "./pathways.ts";
import { canonicalPrUrl, collectPathwaysProofRecords, reducePathwaysProof, reducePathwaysWaitLane, type PathwaysPr } from "./pathways-pr.ts";
import type { LeadStatus } from "./status.ts";

export type LocalPathwaysThread = {
  address: string;
  threadId: string;
  title: string;
  status: string;
  prUrls?: string[];
};

export type LocalPathwaysPr = {
  url: string;
  number: number;
  state: string;
  checks: string | null;
  review: string | null;
  attention: string | null;
};

export type LocalPathwaysCard = {
  id: string;
  state: string;
  title: string;
  question: string;
  action: "merge" | null;
  createdAt: string;
  prUrls: string[];
};

export type LocalPathwaysWait = {
  prUrl: string;
  when: string;
  owner: string;
  createdAt: number;
};

export type LocalPathwaysDeliverable = {
  id: string;
  revisions: { rev: number; at: string; proof: { kind: string; url: string | null }[] }[];
};

export type LocalPathwaysInput = {
  slug: string;
  status: LeadStatus | null;
  threads: LocalPathwaysThread[];
  decisions: LocalPathwaysCard[];
  prs: LocalPathwaysPr[];
  deliverables: LocalPathwaysDeliverable[];
  waits: LocalPathwaysWait[];
  now: number;
};

function prReason(attention: string | null, state: PathwaysPr["state"], draft: boolean, checks: string, review: string, rawState: string): string {
  if (attention) return attention;
  if (state === "ready") return "Ready to merge";
  if (draft) return "Draft PR";
  if (checks === "failing") return "Checks failing";
  if (review === "changes_requested") return "Changes requested";
  if (review === "review_required") return "Review required";
  if (checks === "pending") return "Checks pending";
  return rawState || "open";
}

function toPathwaysPr(item: LocalPathwaysPr, url: string, now: number): PathwaysPr {
  const rawState = item.state.toLowerCase();
  const draft = rawState === "draft";
  const checks = item.checks ?? "not recorded";
  const review = item.review ?? "not recorded";
  const ready = !draft && item.attention === "ready_to_merge";
  const state: PathwaysPr["state"] = rawState === "merged" ? "merged" : rawState === "closed" ? "closed" : ready ? "ready" : "blocked";
  const reason = prReason(item.attention, state, draft, checks, review, rawState);
  return {
    url,
    state,
    number: item.number,
    title: null,
    draft,
    head: null,
    createdAt: null,
    headCommittedAt: null,
    checksPendingSince: null,
    reviews: [],
    staleReviewDismissal: null,
    requiredApprovals: null,
    review,
    checks,
    mergeability: item.attention === "ready_to_merge" ? "ready_to_merge" : "not recorded",
    reason,
    retrievedAt: now,
  };
}

function emptyTicket(fields: {
  identifier: string;
  title: string;
  state: { type: string; name: string };
  priority: number;
  type: string;
  assignee: string | null;
  displayState: PathwaysState;
  reasons?: string[];
}): PathwaysTicket {
  return {
    identifier: fields.identifier,
    title: fields.title,
    url: "",
    state: fields.state,
    priority: fields.priority,
    estimate: null,
    type: fields.type,
    assignee: fields.assignee,
    unknown: [],
    blockers: [],
    displayState: fields.displayState,
    waitsOnYou: false,
    readiness: { state: "ready", reasons: fields.reasons ?? [], source: "" },
    prLink: { state: "missing", urls: [], source: null },
    prs: [],
    pr: null,
    proof: null,
    waitLane: null,
    decisionDraft: null,
    decision: { state: "missing", cardId: null, cardState: null, title: null, waiting: false, direct: [], transitive: [] },
    preflight: { state: "not planned", environment: null, verifier: null, ownerAction: null, accessTicket: null, gaps: [], source: "" },
  };
}

const isClosed = (type: string) => type === "completed" || type === "canceled";

export function localPathwaysMap(input: LocalPathwaysInput): PathwaysMap {
  const tickets: PathwaysTicket[] = [];
  const edges: PathwaysEdge[] = [];
  const seenEdges = new Set<string>();
  const addEdge = (from: string, to: string, type: PathwaysEdge["type"]) => {
    const key = type === "related" ? `${type}:${[from, to].sort().join(":")}` : `${type}:${from}:${to}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ from, to, type });
  };

  const stepTickets: { ticket: PathwaysTicket; stepState: "done" | "current" | "next" }[] = [];
  let prevStep: PathwaysTicket | null = null;
  for (const [index, step] of (input.status?.steps ?? []).entries()) {
    if (step.state === "skipped") continue;
    const blockedByPrev = !!prevStep && !isClosed(prevStep.state.type);
    const displayState: PathwaysState = step.state === "done" ? "done" : step.state === "current" ? "claimed" : blockedByPrev ? "blocked" : "ready";
    const state = step.state === "done" ? { type: "completed", name: "Done" } : step.state === "current" ? { type: "started", name: "In Progress" } : { type: "unstarted", name: "Next" };
    const ticket = emptyTicket({
      identifier: `STEP-${index + 1}`,
      title: step.title,
      state,
      priority: 2,
      type: "step",
      assignee: step.state === "current" ? input.status?.by || `lead:${input.slug}` : null,
      displayState,
      reasons: step.state === "current" ? (input.status?.blockers ?? []).filter((b) => b.trim().length > 0) : [],
    });
    if (prevStep) {
      addEdge(prevStep.identifier, ticket.identifier, "blocks");
      if (!isClosed(prevStep.state.type) && !isClosed(ticket.state.type)) ticket.blockers.push(prevStep.identifier);
    }
    addEdge(input.slug, ticket.identifier, "sub-issue");
    tickets.push(ticket);
    stepTickets.push({ ticket, stepState: step.state });
    prevStep = ticket;
  }

  const activeAnchor = stepTickets.find((entry) => entry.stepState === "current")?.ticket ?? stepTickets.find((entry) => entry.stepState === "next")?.ticket ?? null;
  const anchorStep = activeAnchor ?? stepTickets.at(-1)?.ticket ?? null;

  const threadByPrUrl = new Map<string, PathwaysTicket[]>();
  const nonDoneThreads: PathwaysTicket[] = [];
  for (const thread of input.threads) {
    if (thread.status === "archived") continue;
    const num = /^thread:[^:]+:(\d+)$/.exec(thread.address)?.[1];
    const statusLabel = thread.status.trim() || "idle";
    const cleanTitle = thread.title.trim() || thread.address;
    const displayState: PathwaysState = statusLabel === "error" ? "blocked" : statusLabel === "stopped" ? "unknown" : "claimed";
    const state = statusLabel === "stopped" ? { type: "unstarted", name: statusLabel } : { type: "started", name: statusLabel };
    const reason = statusLabel === "error" ? "Thread errored — inspect or restart" : statusLabel === "stopped" ? "Thread stopped (not confirmed complete)" : `Thread ${statusLabel}`;
    const ticket = emptyTicket({
      identifier: `THR-${num ?? thread.threadId}`,
      title: `${cleanTitle} · ${statusLabel}`,
      state,
      priority: 3,
      type: "thread",
      assignee: thread.address,
      displayState,
      reasons: [reason],
    });
    addEdge(input.slug, ticket.identifier, "sub-issue");
    if (anchorStep) addEdge(anchorStep.identifier, ticket.identifier, "related");
    tickets.push(ticket);
    if (!isClosed(ticket.state.type)) nonDoneThreads.push(ticket);
    for (const rawUrl of thread.prUrls ?? []) {
      const canonical = canonicalPrUrl(rawUrl);
      if (!canonical) continue;
      const list = threadByPrUrl.get(canonical) ?? [];
      list.push(ticket);
      threadByPrUrl.set(canonical, list);
    }
  }

  const cardTarget = activeAnchor ?? nonDoneThreads[0] ?? null;
  const cardMeta = new Map<string, LocalPathwaysCard>();
  for (const card of input.decisions) {
    if (card.state !== "open" && card.state !== "asked") continue;
    const title = card.title.trim() || card.question.trim() || card.id;
    const question = card.question.trim();
    const ticket = emptyTicket({
      identifier: `CARD-${card.id.slice(-6)}`,
      title,
      state: { type: "started", name: card.state === "asked" ? "Needs you" : "Open" },
      priority: 1,
      type: "decision",
      assignee: null,
      displayState: "needs-you",
      reasons: question && question !== title ? [question] : [],
    });
    addEdge(input.slug, ticket.identifier, "sub-issue");
    if (cardTarget) {
      addEdge(ticket.identifier, cardTarget.identifier, "blocks");
      if (!cardTarget.blockers.includes(ticket.identifier)) cardTarget.blockers.unshift(ticket.identifier);
    }
    tickets.push(ticket);
    cardMeta.set(ticket.identifier, card);
  }

  const openPrsByUrl = new Map<string, LocalPathwaysPr>();
  for (const pr of input.prs) {
    const state = pr.state.toLowerCase();
    if (state !== "open" && state !== "draft") continue;
    const canonical = canonicalPrUrl(pr.url);
    if (canonical && !openPrsByUrl.has(canonical)) openPrsByUrl.set(canonical, pr);
  }

  const attachPr = (ticket: PathwaysTicket, canonical: string, raw: LocalPathwaysPr, computedPr?: PathwaysPr) => {
    if (!ticket.prLink.urls.includes(canonical)) {
      ticket.prLink.urls.push(canonical);
      ticket.prLink.urls.sort();
      ticket.prLink.state = "linked";
      ticket.prLink.source = null;
    }
    const pr = computedPr ?? toPathwaysPr(raw, canonical, input.now);
    const proof = reducePathwaysProof(pr, collectPathwaysProofRecords(canonical, input.deliverables));
    const mergeDecision = input.decisions.find((decision) => decision.action === "merge" && decision.prUrls.some((url) => canonicalPrUrl(url) === canonical));
    const waitLane = reducePathwaysWaitLane(
      pr,
      proof,
      input.waits.filter((wait) => canonicalPrUrl(wait.prUrl) === canonical),
      mergeDecision ? { id: mergeDecision.id, state: mergeDecision.state, createdAt: Date.parse(mergeDecision.createdAt) } : null,
    );
    ticket.prs.push({ pr, proof, waitLane });
  };

  const prNumberCounts = new Map<number, number>();
  for (const raw of openPrsByUrl.values()) prNumberCounts.set(raw.number, (prNumberCounts.get(raw.number) ?? 0) + 1);
  const usedPrIds = new Set<string>();
  const uniquePrId = (canonical: string, num: number): string => {
    const repo = /github\.com\/[^/]+\/([^/]+)\/pull\//i.exec(canonical)?.[1] ?? "";
    let base = (prNumberCounts.get(num) ?? 0) > 1 && repo ? `PR-${repo}-${num}` : `PR-${num}`;
    if (!usedPrIds.has(base)) { usedPrIds.add(base); return base; }
    let suffix = 2;
    while (usedPrIds.has(`${base}-${suffix}`)) suffix++;
    const id = `${base}-${suffix}`;
    usedPrIds.add(id);
    return id;
  };
  for (const [canonical, raw] of openPrsByUrl) {
    const matchedThreads = threadByPrUrl.get(canonical);
    if (matchedThreads?.length) {
      for (const threadTicket of matchedThreads) attachPr(threadTicket, canonical, raw);
      continue;
    }
    if (activeAnchor) {
      attachPr(activeAnchor, canonical, raw);
      continue;
    }
    const prPreview = toPathwaysPr(raw, canonical, input.now);
    const prTicket = emptyTicket({
      identifier: uniquePrId(canonical, raw.number),
      title: `PR #${raw.number} · ${prPreview.reason}`,
      state: { type: "started", name: prPreview.state === "ready" ? "Ready" : "Open" },
      priority: 2,
      type: "pr",
      assignee: null,
      displayState: prPreview.state === "ready" ? "ready" : "blocked",
      reasons: [prPreview.reason],
    });
    prTicket.url = canonical;
    addEdge(input.slug, prTicket.identifier, "sub-issue");
    attachPr(prTicket, canonical, raw, prPreview);
    tickets.push(prTicket);
  }

  const prRank = { unavailable: 0, blocked: 1, ready: 2, merged: 3, closed: 4 };
  for (const ticket of tickets) {
    if (!ticket.prs.length) continue;
    ticket.prs.sort((a, b) => prRank[a.pr.state] - prRank[b.pr.state] || a.pr.url.localeCompare(b.pr.url));
    const primary = ticket.prs[0]!;
    ticket.pr = primary.pr;
    ticket.proof = primary.proof;
    ticket.waitLane = primary.waitLane;
  }

  const { byId, openTargets, ownerActions: buildOwnerActions } = pathwaysGraph(tickets, edges);
  const walkChain = (startId: string): string[] => {
    const chain = [startId];
    const seen = new Set([startId]);
    let current = startId;
    for (;;) {
      const next = openTargets(current).find((id) => !seen.has(id));
      if (!next) return chain;
      seen.add(next);
      chain.push(next);
      current = next;
    }
  };

  const firstPath = activeAnchor ? walkChain(activeAnchor.identifier) : [];
  const ownerActions = buildOwnerActions(firstPath);
  for (const action of ownerActions) {
    const ticket = byId.get(action.identifier);
    const card = cardMeta.get(action.identifier);
    if (!ticket || !card) continue;
    const direct = openTargets(action.identifier);
    const directSet = new Set(direct);
    ticket.decision = {
      state: "linked",
      cardId: card.id,
      cardState: card.state,
      title: ticket.title,
      waiting: true,
      direct,
      transitive: action.affected.filter((id) => !directSet.has(id)),
    };
  }

  const openTickets = tickets.filter((ticket) => !isClosed(ticket.state.type));
  return {
    identifier: input.slug,
    title: input.status?.goal?.trim() || input.slug,
    url: "",
    source: "orchestrator",
    tickets,
    external: [],
    edges,
    fog: (input.status?.blockers ?? []).map((b) => b.trim()).filter(Boolean),
    firstPath,
    frontier: openTickets.filter((ticket) => ticket.displayState === "ready" || ticket.displayState === "unknown").map((ticket) => ticket.identifier),
    claimed: openTickets.filter((ticket) => ticket.displayState === "claimed").map((ticket) => ticket.identifier),
    blocked: openTickets.filter((ticket) => ticket.displayState === "blocked").map((ticket) => ticket.identifier),
    ownerActions,
  };
}
