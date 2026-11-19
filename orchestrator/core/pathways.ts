import { createHash } from "node:crypto";
import { extractPrLinks, type PathwaysPr, type PathwaysPrLinks, type PathwaysProof, type PathwaysWaitLane } from "./pathways-pr.ts";
import { explicitCardIds } from "./pathways-links.ts";

export type PathwaysIssue = {
  identifier: string;
  title: string;
  url: string;
  description: string | null;
  updatedAt?: string;
  state: { type: string; name: string };
  priority: number;
  estimate: number | null;
  assignee: { name: string } | null;
  labels: { nodes: { name: string }[] };
  parent: { identifier: string } | null;
  relations: { nodes: { type: string; relatedIssue: PathwaysRelationIssue }[] };
  inverseRelations: { nodes: { type: string; issue: PathwaysRelationIssue }[] };
  attachments?: { nodes: { id: string; url: string }[] };
};

export type PathwaysRelationIssue = { identifier: string; state: { type: string }; title?: string; url?: string };
export type PathwaysState = "done" | "needs-you" | "blocked" | "claimed" | "unknown" | "ready";

export type PathwaysEdge = { from: string; to: string; type: "blocks" | "sub-issue" | "related" };
export type PathwaysOwnerAction = { identifier: string; url: string; action: string; kind: "sign-in" | "permission" | "approval" | "other"; affected: string[]; next: string | null; neededBefore: number | null; onlyOpenBlocker: boolean };
export type PathwaysReadiness = { state: "ready" | "needs decision" | "needs proof plan"; reasons: string[]; source: string };
export type PathwaysDecision = { state: "missing" | "ambiguous" | "linked"; cardId: string | null; cardState: string | null; title: string | null; waiting: boolean; direct: string[]; transitive: string[] };
export type PathwaysPreflight = { state: "not planned" | "needs access" | "unknown" | "blocked" | "declared"; environment: string | null; verifier: string | null; ownerAction: string | null; accessTicket: string | null; gaps: string[]; source: string };
export type PathwaysCard = { id: string; state: string; title: string; context: string; project: string | null; prUrls?: string[] };
export type PathwaysTicket = Pick<PathwaysIssue, "identifier" | "title" | "url" | "state" | "priority" | "estimate"> & {
  type: string;
  assignee: string | null;
  unknown: string[];
  blockers: string[];
  displayState: PathwaysState;
  waitsOnYou: boolean;
  readiness: PathwaysReadiness;
  prLink: PathwaysPrLinks;
  prs: { pr: PathwaysPr; proof: PathwaysProof; waitLane: PathwaysWaitLane }[];
  pr: PathwaysPr | null;
  proof: PathwaysProof | null;
  waitLane: PathwaysWaitLane | null;
  decisionDraft: PathwaysDecisionDraft | null;
  decision: PathwaysDecision;
  preflight: PathwaysPreflight;
};
export type PathwaysMap = { identifier: string; title: string; url: string; tickets: PathwaysTicket[]; external: PathwaysRelationIssue[]; edges: PathwaysEdge[]; fog: string[]; frontier: string[]; claimed: string[]; blocked: string[]; firstPath: string[]; ownerActions: PathwaysOwnerAction[] };

export function summarizePathwaysRetro(map: PathwaysMap, decisions: { id: string; title: string; state: string }[], now: number) {
  const finished = map.tickets.filter((ticket) => ticket.state.type === "completed").map((ticket) => ({ label: ticket.identifier, url: ticket.url, prUrl: ticket.prs.find((entry) => entry.pr.state === "merged")?.pr.url ?? (ticket.pr?.state === "merged" ? ticket.pr.url : null) }));
  const mergedPrs = map.tickets.flatMap((ticket) => ticket.prs.filter((entry) => entry.pr.state === "merged").map((entry) => ({ ticket: ticket.identifier, url: entry.pr.url })));
  const made = decisions.filter((decision) => decision.state === "answered").map(({ id, title }) => ({ id, title }));
  const stalled = map.tickets.flatMap((ticket) => ticket.waitLane?.steps.filter((step) => (step.state === "pending" || step.state === "blocked") && step.since != null).map((step) => ({ label: ticket.identifier, url: ticket.url, kind: step.kind, durationMs: Math.max(0, now - step.since!) })) ?? []).sort((a, b) => b.durationMs - a.durationMs).slice(0, 3);
  return { finished, mergedPrs, decisions: made, stalled };
}

export async function projectIssues<T>(request: (after: string | null) => Promise<{ project: { issues: { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null }>): Promise<T[] | null> {
  const nodes: T[] = [];
  let after: string | null = null;
  const cursors = new Set<string>();
  for (;;) {
    const page: { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | undefined = (await request(after)).project?.issues;
    if (!page) return null;
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return nodes;
    const cursor: string | null = page.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor)) throw new Error("Invalid Linear page cursor");
    cursors.add(cursor);
    after = cursor;
  }
}

export async function mapPathwaysLimited<T, R>(items: readonly T[], limit: number, read: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      result[index] = await read(items[index]!);
    }
  }));
  return result;
}

const closed = (type: string) => type === "completed" || type === "canceled";
const names = (issue: PathwaysIssue) => issue.labels.nodes.map((label) => label.name.toLowerCase());

export function selectPathwaysMap<T extends { identifier: string; labels: { nodes: { name: string }[] } }>(issues: T[], identifier?: string): T | undefined {
  return identifier ? issues.find((issue) => issue.identifier.toLowerCase() === identifier.toLowerCase()) : issues.find((issue) => issue.labels.nodes.some((label) => label.name.toLowerCase() === "wayfinder:map"));
}

function readiness(issue: PathwaysIssue, labels: string[]): PathwaysReadiness {
  const reasons: string[] = [];
  if (labels.some((label) => ["spike", "question", "open-question", "wayfinder:research"].includes(label))) {
    const question = issue.description?.match(/^##\s+Question\s*\n\s*([^\n#][^\n]*)/im)?.[1]?.trim();
    if (question) reasons.push(`Question: ${question}`);
    else reasons.push("Question not recorded");
    reasons.push("Decision not recorded");
  }
  if (labels.includes("wayfinder:task")) {
    if (issue.estimate == null) reasons.push("Estimate not recorded");
    if (!/##\s+Acceptance criteria\s*\n[^#\s]/im.test(issue.description ?? "")) reasons.push("Acceptance criteria not recorded");
  }
  const needsDecision = reasons.length > 0;
  if (!/##\s+(Verification|Proof plan)\s*\n[^#\s]/im.test(issue.description ?? "")) reasons.push("Verification plan not recorded");
  if (needsDecision) return { state: "needs decision", reasons, source: issue.url };
  if (reasons.length) return { state: "needs proof plan", reasons, source: issue.url };
  return { state: "ready", reasons: [], source: issue.url };
}

export function fogBullets(body: string): string[] {
  const section = body.match(/^##\s+Not yet specified\s*$([\s\S]*?)(?=^##\s+|$(?![\s\S]))/im)?.[1] ?? "";
  return section.split("\n").map((line) => line.match(/^\s*[-*]\s+(.+)$/)?.[1]?.trim()).filter((line): line is string => !!line);
}

export function pathwaysMap(map: PathwaysIssue, children: PathwaysIssue[]): PathwaysMap {
  const ids = new Set(children.map((issue) => issue.identifier));
  const edges: PathwaysEdge[] = children.map((issue) => ({ from: map.identifier, to: issue.identifier, type: "sub-issue" }));
  const seen = new Set<string>();
  const external = new Map<string, PathwaysRelationIssue>();
  const tickets = children.map((issue): PathwaysTicket => {
    const blockers: string[] = [];
    const related = [...issue.relations.nodes.map((relation) => ({ type: relation.type, other: relation.relatedIssue, inverse: false })), ...issue.inverseRelations.nodes.map((relation) => ({ type: relation.type, other: relation.issue, inverse: true }))];
    for (const relation of related) {
      const type = relation.type.toLowerCase();
      const blocksIssue = type === "blocked_by" || type === "blockedby" || (type === "blocks" && relation.inverse);
      const issueBlocks = type === "blocks" && !relation.inverse;
      if (blocksIssue && !closed(relation.other.state.type)) blockers.push(relation.other.identifier);
      if (!ids.has(relation.other.identifier) && blocksIssue) external.set(relation.other.identifier, relation.other);
      if (!ids.has(relation.other.identifier) && !blocksIssue) continue;
      if (blocksIssue || issueBlocks || type === "related") {
        const from = blocksIssue ? relation.other.identifier : issue.identifier;
        const to = blocksIssue ? issue.identifier : relation.other.identifier;
        const edgeType = type === "related" ? "related" : "blocks";
        const key = edgeType === "related" ? `${edgeType}:${[from, to].sort().join(":")}` : `${edgeType}:${from}:${to}`;
        if (!seen.has(key)) { seen.add(key); edges.push({ from, to, type: edgeType }); }
      }
    }
    const labels = names(issue);
    const unknown: string[] = [];
    if (labels.includes("wayfinder:task") && issue.estimate == null) unknown.push("No estimate");
    if (labels.includes("wayfinder:task") && (!issue.description?.trim() || !/acceptance criteria/i.test(issue.description))) unknown.push("No acceptance criteria");
    if (labels.some((label) => ["spike", "question", "open-question", "wayfinder:research"].includes(label))) unknown.push("Research question");
    if (blockers.some((id) => !ids.has(id))) unknown.push("External blocker");
    const displayState: PathwaysState = closed(issue.state.type) ? "done" : labels.includes("wayfinder:needs-you") ? "needs-you" : blockers.length ? "blocked" : issue.assignee ? "claimed" : unknown.length ? "unknown" : "ready";
    return { identifier: issue.identifier, title: issue.title, url: issue.url, state: issue.state, priority: issue.priority, estimate: issue.estimate, type: labels.find((label) => /^wayfinder:(research|prototype|grilling|task)$/.test(label))?.slice(10) ?? "untyped", assignee: issue.assignee?.name ?? null, unknown, blockers, displayState, waitsOnYou: false, readiness: readiness(issue, labels), prLink: extractPrLinks(issue.description, issue.attachments?.nodes ?? []), prs: [], pr: null, proof: null, waitLane: null, decisionDraft: null, decision: { state: "missing", cardId: null, cardState: null, title: null, waiting: false, direct: [], transitive: [] }, preflight: { state: "not planned", environment: null, verifier: null, ownerAction: null, accessTicket: null, gaps: ["Verification plan not recorded"], source: issue.url } };
  });
  const byId = new Map(tickets.map((ticket) => [ticket.identifier, ticket]));
  const outgoing = new Map(tickets.map((ticket) => [ticket.identifier, edges.filter((edge) => edge.type === "blocks" && edge.from === ticket.identifier).map((edge) => edge.to)]));
  const visit = (id: string, seenIds: Set<string>, action: (ticket: PathwaysTicket) => void) => {
    for (const next of outgoing.get(id) ?? []) {
      if (seenIds.has(next)) continue;
      seenIds.add(next);
      const ticket = byId.get(next);
      if (ticket && !closed(ticket.state.type)) { action(ticket); visit(next, seenIds, action); }
    }
  };
  for (const ticket of tickets.filter((item) => item.displayState === "needs-you")) visit(ticket.identifier, new Set([ticket.identifier]), (item) => { item.waitsOnYou = true; });
  const paths: string[][] = [];
  const walk = (id: string, path: string[]) => {
    const next = (outgoing.get(id) ?? []).filter((target) => !path.includes(target) && byId.has(target) && !closed(byId.get(target)!.state.type));
    if (!next.length) { paths.push(path); return; }
    for (const target of next) walk(target, [...path, target]);
  };
  for (const ticket of tickets.filter((item) => !closed(item.state.type) && !item.assignee && !item.blockers.length)) walk(ticket.identifier, [ticket.identifier]);
  paths.sort((a, b) => {
    if (a.length !== b.length) return b.length - a.length;
    for (let index = 0; index < a.length; index++) {
      const priority = (byId.get(a[index])!.priority || 5) - (byId.get(b[index])!.priority || 5);
      if (priority) return priority;
      const identifier = a[index].localeCompare(b[index]);
      if (identifier) return identifier;
    }
    return 0;
  });
  const ordered = tickets.filter((ticket) => !closed(ticket.state.type)).sort((a, b) => (a.priority || 5) - (b.priority || 5) || (a.estimate ?? Infinity) - (b.estimate ?? Infinity) || a.identifier.localeCompare(b.identifier));
  const firstPath = paths[0] ?? [];
  const ownerActions = tickets.filter((ticket) => ticket.displayState === "needs-you").map((ticket): PathwaysOwnerAction => {
    const affected: string[] = [];
    visit(ticket.identifier, new Set([ticket.identifier]), (item) => affected.push(item.identifier));
    const next = (outgoing.get(ticket.identifier) ?? []).find((id) => byId.has(id) && !closed(byId.get(id)!.state.type)) ?? null;
    const position = next ? firstPath.indexOf(next) : -1;
    const kind = /\b(sign[ -]?in|log[ -]?in|sso|authenticate)\b/i.test(ticket.title) ? "sign-in" : /\b(permission|access|grant|authorize)\b/i.test(ticket.title) ? "permission" : /\b(approval|approve|sign[ -]?off)\b/i.test(ticket.title) ? "approval" : "other";
    return { identifier: ticket.identifier, url: ticket.url, action: ticket.title, kind, affected, next, neededBefore: position < 0 ? null : position + 1, onlyOpenBlocker: next ? byId.get(next)?.blockers.length === 1 && byId.get(next)?.blockers[0] === ticket.identifier : false };
  });
  return { identifier: map.identifier, title: map.title, url: map.url, tickets, external: [...external.values()], edges, fog: fogBullets(map.description ?? ""), firstPath, frontier: ordered.filter((ticket) => ticket.displayState === "ready" || ticket.displayState === "unknown").map((ticket) => ticket.identifier), claimed: ordered.filter((ticket) => ticket.displayState === "claimed").map((ticket) => ticket.identifier), blocked: ordered.filter((ticket) => ticket.displayState === "blocked").map((ticket) => ticket.identifier), ownerActions };
}

export function attachPathwaysPreflight(map: PathwaysMap, issues: PathwaysIssue[]): void {
  const byIssue = new Map(issues.map((issue) => [issue.identifier, issue]));
  const known = new Set([...map.tickets.map((ticket) => ticket.identifier), ...map.external.map((issue) => issue.identifier)]);
  for (const ticket of map.tickets) {
    const issue = byIssue.get(ticket.identifier);
    if (!issue) continue;
    const plan = issue.description?.match(/^##\s+(?:Verification|Proof plan)\s*$([\s\S]*?)(?=^##\s+|$(?![\s\S]))/im)?.[1] ?? "";
    const field = (name: string) => plan.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))?.[1]?.trim() || null;
    const environment = field("Environment");
    const verifier = field("Verifier");
    const ownerAction = field("Owner action");
    const declaredAccess = field("Access ticket")?.match(/^[A-Z][A-Z0-9]*-\d+$/)?.[0] ?? null;
    const accessTicket = declaredAccess && known.has(declaredAccess) ? declaredAccess : null;
    const gaps = [...(!plan.trim() ? ["Verification plan not recorded"] : [...(!environment ? ["Environment not declared"] : []), ...(!verifier ? ["Verifier not declared"] : []), ...(!ownerAction ? ["Owner action not declared"] : []), ...(/\bAWS\b/i.test(environment ?? "") && !accessTicket ? ["Access ticket not recorded"] : [])]), ...(ticket.proof?.state === "blocked" ? ["Proof record blocked"] : [])];
    const state = ticket.proof?.state === "blocked" ? "blocked" : !plan.trim() ? "not planned" : gaps.includes("Access ticket not recorded") ? "needs access" : gaps.length ? "unknown" : "declared";
    ticket.preflight = { state, environment, verifier, ownerAction, accessTicket, gaps, source: issue.url };
  }
}

export function linkPathwaysDecisions(map: PathwaysMap, issues: PathwaysIssue[], cards: PathwaysCard[]): void {
  const byIssue = new Map(issues.map((issue) => [issue.identifier, issue]));
  const byCard = new Map(cards.map((card) => [card.id, card]));
  const openTickets = new Set(map.tickets.filter((ticket) => !closed(ticket.state.type)).map((ticket) => ticket.identifier));
  for (const ticket of map.tickets) {
    ticket.readiness.reasons = ticket.readiness.reasons.map((reason) => /^Decision (awaiting answer|answered) \(d-[\w-]+\)$/.test(reason) ? "Decision not recorded" : reason);
    const direct = map.edges.filter((edge) => edge.type === "blocks" && edge.from === ticket.identifier && openTickets.has(edge.to)).map((edge) => edge.to);
    const seen = new Set([ticket.identifier, ...direct]);
    const transitive: string[] = [];
    const queue = [...direct];
    while (queue.length) {
      const from = queue.shift()!;
      for (const edge of map.edges.filter((item) => item.type === "blocks" && item.from === from && openTickets.has(item.to))) {
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        transitive.push(edge.to);
        queue.push(edge.to);
      }
    }
    const issue = byIssue.get(ticket.identifier);
    const ids = explicitCardIds({ url: ticket.url, description: issue?.description ?? null }, ticket.prLink, cards);
    if (ids.length !== 1) {
      ticket.decision = { state: ids.length ? "ambiguous" : "missing", cardId: null, cardState: null, title: null, waiting: false, direct, transitive };
      continue;
    }
    const card = byCard.get(ids[0]!);
    if (!card) {
      ticket.decision = { state: "missing", cardId: null, cardState: null, title: null, waiting: false, direct, transitive };
      continue;
    }
    ticket.decision = { state: "linked", cardId: card.id, cardState: card.state, title: card.title, waiting: card.state === "open" || card.state === "asked", direct, transitive };
    ticket.readiness.reasons = ticket.readiness.reasons.map((reason) => reason === "Decision not recorded" ? `${ticket.decision.waiting ? "Decision awaiting answer" : card.state === "answered" || card.state === "acked" ? "Decision answered" : "Decision withdrawn or merged"} (${card.id})` : reason);
  }
}

export type PathwaysDecisionDraft = { ticketId: string; ticketUrl: string; title: string; question: string; context: string; options: { label: string; detail: string }[]; affected: string[] };

export function draftPathwaysDecision(ticket: PathwaysTicket): PathwaysDecisionDraft {
  const recorded = ticket.readiness.reasons.find((reason) => reason.startsWith("Question: "))?.slice(10).trim();
  const question = recorded || `What decision will unblock ${ticket.identifier}?`;
  const affected = [...new Set([...ticket.decision.direct, ...ticket.decision.transitive])];
  const title = recorded ? recorded.length <= 60 ? recorded : `${recorded.slice(0, 59).replace(/\s+\S*$/, "").trimEnd()}…` : `Decision for ${ticket.identifier}?`;
  return { ticketId: ticket.identifier, ticketUrl: ticket.url, title, question, context: `Ticket: ${ticket.url}
Affected tickets: ${affected.length ? affected.join(", ") : "none recorded"}`, options: [{ label: "Proceed with the proposed answer", detail: "" }, { label: "Gather more evidence first", detail: "" }], affected };
}

export function pathwaysDecisionKey(ticketId: string, question: string): string {
  const digest = createHash("sha256").update(question.trim().toLowerCase()).digest("hex").slice(0, 24);
  return `pathways:${ticketId}:${digest}`;
}

export function submitPathwaysDecision(draft: PathwaysDecisionDraft, deps: { existing: (key: string) => string | null; create: (key: string, draft: PathwaysDecisionDraft) => string }): string {
  if (!draft.question.trim() || draft.options.length < 2 || draft.options.length > 4 || draft.options.some((option) => !option.label.trim())) throw new Error("A question and 2 to 4 named options are required");
  const key = pathwaysDecisionKey(draft.ticketId, draft.question);
  return deps.existing(key) ?? deps.create(key, draft);
}
