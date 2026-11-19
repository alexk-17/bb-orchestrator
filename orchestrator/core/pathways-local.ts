import type { PathwaysEdge, PathwaysMap, PathwaysOwnerAction, PathwaysState, PathwaysTicket } from "./pathways.ts";
import { collectPathwaysProofRecords, reducePathwaysProof, reducePathwaysWaitLane, type PathwaysPr } from "./pathways-pr.ts";
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
  seenAt?: number;
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

function canonicalPrUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    const url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`;
    return parsed.hostname === "github.com" && /\/pull\/\d+$/.test(url) ? url : null;
  } catch {
    return null;
  }
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  const next = `${base}-${n}`;
  used.add(next);
  return next;
}

function cardIdentifier(id: string, used: Set<string>): string {
  const stamped = /^d-\d{8}T\d{6}Z-([a-z0-9]+)$/i.exec(id);
  const short = stamped ? stamped[1]! : id.replace(/^d-/, "").slice(0, 12) || id;
  return uniqueId(`CARD-${short}`, used);
}

function threadIdentifier(thread: LocalPathwaysThread, used: Set<string>): string {
  const num = /^thread:[^:]+:(\d+)$/.exec(thread.address)?.[1];
  return uniqueId(num ? `THR-${num}` : `THR-${thread.threadId.slice(0, 8)}`, used);
}

function toPathwaysPr(item: LocalPathwaysPr, url: string, now: number): PathwaysPr {
  const rawState = item.state.toLowerCase();
  const draft = rawState === "draft";
  const checks = item.checks ?? "not recorded";
  const review = item.review ?? "not recorded";
  const mergeability = item.attention === "ready_to_merge" ? "ready_to_merge" : "not recorded";
  const reason = rawState === "merged"
    ? "Merged"
    : rawState === "closed"
      ? "PR is closed"
      : draft
        ? "Draft PR"
        : review === "changes_requested"
          ? "Changes requested"
          : checks === "failing"
            ? "Checks failing"
            : checks === "pending"
              ? "Checks pending"
              : review === "approved" && checks === "passing"
                ? "Ready to merge"
                : review === "review_required" || review === "none"
                  ? "Review required"
                  : item.attention || "Open PR";
  const state: PathwaysPr["state"] = rawState === "merged"
    ? "merged"
    : rawState === "closed"
      ? "closed"
      : reason === "Ready to merge"
        ? "ready"
        : "blocked";
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
    mergeability,
    reason,
    retrievedAt: item.seenAt ?? now,
  };
}

function emptyTicket(fields: {
  identifier: string;
  title: string;
  url: string;
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
    url: fields.url,
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

const PR_STATE_ORDER: Record<PathwaysPr["state"], number> = {
  unavailable: 0,
  blocked: 1,
  ready: 2,
  merged: 3,
  closed: 4,
};

export function localPathwaysMap(input: LocalPathwaysInput): PathwaysMap {
  const usedIds = new Set<string>([input.slug]);
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
  let firstNextSeen = false;
  let prevStep: PathwaysTicket | null = null;
  for (const [index, step] of (input.status?.steps ?? []).entries()) {
    if (step.state === "skipped") continue;
    const identifier = uniqueId(`STEP-${index + 1}`, usedIds);
    const displayState: PathwaysState = step.state === "done"
      ? "done"
      : step.state === "current"
        ? "claimed"
        : firstNextSeen
          ? "blocked"
          : "ready";
    if (step.state === "next") firstNextSeen = true;
    const state = step.state === "done"
      ? { type: "completed", name: "Done" }
      : step.state === "current"
        ? { type: "started", name: "In Progress" }
        : { type: "unstarted", name: "Next" };
    const ticket = emptyTicket({
      identifier,
      title: step.title,
      url: "",
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

  const currentStep = stepTickets.find((entry) => entry.stepState === "current")?.ticket ?? null;
  const firstNextStep = stepTickets.find((entry) => entry.stepState === "next")?.ticket ?? null;
  const activeAnchorStep = currentStep ?? firstNextStep;
  const anchorStep = activeAnchorStep ?? stepTickets.at(-1)?.ticket ?? null;

  const threadByPrUrl = new Map<string, PathwaysTicket[]>();
  const nonDoneThreads: PathwaysTicket[] = [];
  for (const thread of input.threads) {
    if (thread.status === "archived") continue;
    const identifier = threadIdentifier(thread, usedIds);
    const statusLabel = thread.status.trim() || "idle";
    const cleanTitle = thread.title.trim() || thread.address;
    const displayState: PathwaysState = statusLabel === "error"
      ? "blocked"
      : statusLabel === "stopped"
        ? "done"
        : "claimed";
    const state = statusLabel === "stopped"
      ? { type: "completed", name: statusLabel }
      : { type: "started", name: statusLabel };
    const ticket = emptyTicket({
      identifier,
      title: `${cleanTitle} · ${statusLabel}`,
      url: "",
      state,
      priority: 3,
      type: "thread",
      assignee: thread.address,
      displayState,
      reasons: [`Thread ${statusLabel}`],
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

  const cardTarget = activeAnchorStep ?? nonDoneThreads[0] ?? null;
  const cardMeta = new Map<string, LocalPathwaysCard>();
  const openCards = input.decisions.filter((decision) => decision.state === "open" || decision.state === "asked");
  for (const card of openCards) {
    const identifier = cardIdentifier(card.id, usedIds);
    const title = card.title.trim() || card.question.trim() || card.id;
    const question = card.question.trim();
    const ticket = emptyTicket({
      identifier,
      title,
      url: "",
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

  const attachPr = (ticket: PathwaysTicket, canonical: string, raw: LocalPathwaysPr) => {
    if (!ticket.prLink.urls.includes(canonical)) {
      ticket.prLink.urls.push(canonical);
      ticket.prLink.urls.sort();
      ticket.prLink.state = "linked";
      ticket.prLink.source = null;
    }
    const pr = toPathwaysPr(raw, canonical, input.now);
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

  const standalonePrTickets: PathwaysTicket[] = [];
  for (const [canonical, raw] of openPrsByUrl) {
    const matchedThreads = threadByPrUrl.get(canonical);
    if (matchedThreads?.length) {
      for (const threadTicket of matchedThreads) attachPr(threadTicket, canonical, raw);
      continue;
    }
    const matchedStep = stepTickets.find(({ ticket }) => ticket.title.includes(`#${raw.number}`) || ticket.title.toLowerCase().includes(canonical))?.ticket;
    const target = matchedStep ?? anchorStep ?? nonDoneThreads[0] ?? null;
    if (target) {
      attachPr(target, canonical, raw);
      continue;
    }
    const preview = toPathwaysPr(raw, canonical, input.now);
    const prTicket = emptyTicket({
      identifier: uniqueId(`PR-${raw.number}`, usedIds),
      title: `PR #${raw.number}`,
      url: canonical,
      state: { type: "started", name: raw.state },
      priority: 2,
      type: "pr",
      assignee: null,
      displayState: preview.state === "ready" ? "ready" : "blocked",
      reasons: [preview.reason],
    });
    addEdge(input.slug, prTicket.identifier, "sub-issue");
    attachPr(prTicket, canonical, raw);
    tickets.push(prTicket);
    standalonePrTickets.push(prTicket);
  }

  for (const ticket of tickets) {
    if (!ticket.prs.length) continue;
    ticket.prs.sort((a, b) => a.pr.url.localeCompare(b.pr.url));
    const primary = ticket.prs
      .filter(({ pr }) => pr.state !== "merged" && pr.state !== "closed")
      .sort((a, b) => PR_STATE_ORDER[a.pr.state] - PR_STATE_ORDER[b.pr.state])[0];
    ticket.pr = primary?.pr ?? null;
    ticket.proof = primary?.proof ?? null;
    ticket.waitLane = primary?.waitLane ?? null;
  }

  const byId = new Map(tickets.map((ticket) => [ticket.identifier, ticket]));
  const outgoing = new Map(tickets.map((ticket) => [ticket.identifier, edges.filter((edge) => edge.type === "blocks" && edge.from === ticket.identifier).map((edge) => edge.to)]));
  const visit = (id: string, seen: Set<string>, action: (ticket: PathwaysTicket) => void) => {
    for (const next of outgoing.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      const ticket = byId.get(next);
      if (ticket && !isClosed(ticket.state.type)) {
        action(ticket);
        visit(next, seen, action);
      }
    }
  };

  for (const ticket of tickets.filter((item) => item.displayState === "needs-you")) {
    visit(ticket.identifier, new Set([ticket.identifier]), (item) => { item.waitsOnYou = true; });
    const card = cardMeta.get(ticket.identifier);
    if (!card) continue;
    const direct = (outgoing.get(ticket.identifier) ?? []).filter((id) => {
      const target = byId.get(id);
      return !!target && !isClosed(target.state.type);
    });
    const seen = new Set<string>([ticket.identifier, ...direct]);
    const transitive: string[] = [];
    const queue = [...direct];
    while (queue.length) {
      const from = queue.shift()!;
      for (const next of outgoing.get(from) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        const target = byId.get(next);
        if (target && !isClosed(target.state.type)) {
          transitive.push(next);
          queue.push(next);
        }
      }
    }
    ticket.decision = {
      state: "linked",
      cardId: card.id,
      cardState: card.state,
      title: ticket.title,
      waiting: true,
      direct,
      transitive,
    };
  }

  const walkChain = (startId: string): string[] => {
    const chain = [startId];
    const seen = new Set([startId]);
    let current = startId;
    for (;;) {
      const next = (outgoing.get(current) ?? []).find((id) => !seen.has(id) && byId.has(id) && !isClosed(byId.get(id)!.state.type));
      if (!next) return chain;
      seen.add(next);
      chain.push(next);
      current = next;
    }
  };

  const firstOpenCard = tickets.find((ticket) => ticket.displayState === "needs-you") ?? null;
  let firstPath: string[] = [];
  if (activeAnchorStep) {
    const stepChain = walkChain(activeAnchorStep.identifier);
    const blockingCard = tickets.find((ticket) => ticket.displayState === "needs-you" && (outgoing.get(ticket.identifier) ?? []).includes(activeAnchorStep.identifier));
    firstPath = blockingCard ? [blockingCard.identifier, ...stepChain] : stepChain;
  } else if (firstOpenCard) {
    firstPath = walkChain(firstOpenCard.identifier);
  } else if (nonDoneThreads.length) {
    firstPath = [nonDoneThreads[0]!.identifier];
  } else if (standalonePrTickets.length) {
    firstPath = [standalonePrTickets[0]!.identifier];
  }

  const ownerActions = tickets
    .filter((ticket) => ticket.displayState === "needs-you")
    .map((ticket): PathwaysOwnerAction => {
      const affected: string[] = [];
      visit(ticket.identifier, new Set([ticket.identifier]), (item) => affected.push(item.identifier));
      const next = (outgoing.get(ticket.identifier) ?? []).find((id) => byId.has(id) && !isClosed(byId.get(id)!.state.type)) ?? null;
      const position = next ? firstPath.indexOf(next) : -1;
      const card = cardMeta.get(ticket.identifier);
      const kind = card?.action === "merge"
        ? "approval"
        : /\b(sign[ -]?in|log[ -]?in|sso|authenticate)\b/i.test(ticket.title)
          ? "sign-in"
          : /\b(permission|access|grant|authorize)\b/i.test(ticket.title)
            ? "permission"
            : /\b(approval|approve|sign[ -]?off)\b/i.test(ticket.title)
              ? "approval"
              : "other";
      return {
        identifier: ticket.identifier,
        url: ticket.url,
        action: ticket.title,
        kind,
        affected,
        next,
        neededBefore: position < 0 ? null : position + 1,
        onlyOpenBlocker: next ? byId.get(next)?.blockers.length === 1 && byId.get(next)?.blockers[0] === ticket.identifier : false,
      };
    });

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
