import { PR_URL_RE, type BbPrReading } from "./open-prs.ts";

export type PathwaysPrLinks = { state: "missing" | "linked" | "ambiguous"; urls: string[]; source: "attachment" | "description" | "both" | null };
export type PathwaysPr = { url: string; state: "unavailable" | "blocked" | "ready" | "merged" | "closed"; number: number | null; title: string | null; draft: boolean | null; head: string | null; createdAt: number | null; headCommittedAt: number | null; checksPendingSince: number | null; reviews: { login: string; state: string; sha: string; submittedAt: number | null }[]; staleReviewDismissal: boolean | null; requiredApprovals: number | null; review: string; checks: string; mergeability: string; reason: string; retrievedAt: number };
export type PathwaysProofRecord = { prUrl: string; verifiedSha: string | null; status: "verified" | "partial" | "blocked"; liveInterface: string | null; qaPacketUrl: string | null; sourceUrl: string | null; sourceLabel: string; observedAt: number };
export type PathwaysProof = { state: "unrecorded" | "stale" | "partial" | "blocked" | "verified"; verifiedSha: string | null; liveInterface: string | null; qaPacketUrl: string | null; missing: string[]; sourceUrl: string | null; sourceLabel: string | null; observedAt: number | null };
export type PathwaysWaitStep = { kind: "check run" | "human review" | "QA" | "draft decision" | "merge go"; state: "done" | "pending" | "blocked" | "unknown"; since: number | null; owner: string | null; note: string };
export type PathwaysWaitLane = { head: string | null; reviewFreshness: "current" | "stale" | "older accepted" | "unknown"; steps: PathwaysWaitStep[] };

export function canonicalPrUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    const url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`;
    return parsed.hostname === "github.com" && PR_URL_RE.test(url) ? url : null;
  } catch {
    return null;
  }
}

export function extractPrLinks(description: string | null, attachments: { url: string }[]): PathwaysPrLinks {
  const urls = new Set<string>();
  const fromAttachments = new Set<string>();
  const fromDescription = new Set<string>();
  for (const attachment of attachments) {
    const url = canonicalPrUrl(attachment.url);
    if (url) { urls.add(url); fromAttachments.add(url); }
  }
  for (const match of description?.matchAll(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d{1,9}(?!\d)/g) ?? []) {
    const url = canonicalPrUrl(match[0]);
    if (url) { urls.add(url); fromDescription.add(url); }
  }
  const values = [...urls].sort();
  const source = !values.length ? null : fromAttachments.size && fromDescription.size ? "both" : fromAttachments.size ? "attachment" : "description";
  return { state: values.length === 0 ? "missing" : "linked", urls: values, source };
}

export function reducePathwaysPr(url: string, reading: BbPrReading, retrievedAt: number): PathwaysPr {
  const source = reading.outcome === "available" && canonicalPrUrl(reading.pullRequest.url) === url ? reading.pullRequest : null;
  const head = source?.sha || null;
  const createdAt = source?.createdAt ?? null;
  const headCommittedAt = source?.headCommittedAt ?? null;
  const checksPendingSince = source?.checksPendingSince ?? null;
  const reviews = source?.reviews ?? [];
  const staleReviewDismissal = source?.staleReviewDismissal ?? null;
  const requiredApprovals = source?.requiredApprovals ?? null;
  const number = source?.number ?? null;
  const title = source?.title ?? null;
  const draft = source?.draft ?? null;
  const review = source?.review?.state ?? "not recorded";
  const checks = source?.checks?.state ?? "not recorded";
  const mergeability = source?.mergeability?.state ?? "not recorded";
  const reason = !source ? "PR reading unavailable" : source.state === "merged" ? "Merged" : source.draft === true || source.state === "draft" ? "Draft PR" : source.state !== "open" ? "PR is closed" : !head ? "Head not recorded" : review !== "approved" ? review === "none" && requiredApprovals ? `Review required (0 of ${requiredApprovals})` : review === "none" || review === "not recorded" ? "Review not recorded" : "Review required" : checks !== "passing" ? checks === "not recorded" ? "Checks not recorded" : `Checks ${checks}` : mergeability !== "ready_to_merge" ? "Mergeability not confirmed" : "Ready at this head";
  const state = !source ? "unavailable" : source.state === "merged" ? "merged" : source.state === "closed" ? "closed" : reason === "Ready at this head" ? "ready" : "blocked";
  return { url, state, number, title, draft, head, createdAt, headCommittedAt, checksPendingSince, reviews, staleReviewDismissal, requiredApprovals, review, checks, mergeability, reason, retrievedAt };
}

export function reducePathwaysWaitLane(pr: PathwaysPr, proof: PathwaysProof, waits: { when: string; owner: string; createdAt: number }[], mergeCard: { id: string; state: string; createdAt: number } | null = null): PathwaysWaitLane {
  const wait = (when: string) => waits.filter((item) => item.when === when).sort((a, b) => a.createdAt - b.createdAt)[0];
  const latestReviews = new Map<string, PathwaysPr["reviews"][number]>();
  for (const review of [...pr.reviews].sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0))) if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED" || review.state === "DISMISSED") latestReviews.set(review.login, review);
  const lastApproval = [...latestReviews.values()].filter((review) => review.state === "APPROVED").sort((a, b) => (b.submittedAt ?? 0) - (a.submittedAt ?? 0))[0];
  const reviewFreshness = !lastApproval || !pr.head || !lastApproval.sha ? "unknown" : lastApproval.sha === pr.head ? "current" : pr.staleReviewDismissal === true ? "stale" : pr.staleReviewDismissal === false ? "older accepted" : "unknown";
  const checksState = pr.checks === "passing" ? "done" : pr.checks === "failing" ? "blocked" : pr.checks === "pending" ? "pending" : "unknown";
  const reviewState = pr.review === "changes_requested" ? "blocked" : reviewFreshness === "stale" ? "pending" : pr.review === "approved" && (reviewFreshness === "current" || reviewFreshness === "older accepted") ? "done" : pr.review === "review_required" || pr.review === "none" && (pr.requiredApprovals ?? 0) > 0 ? "pending" : "unknown";
  const qaState = proof.state === "verified" ? "done" : proof.state === "blocked" ? "blocked" : proof.state === "stale" || proof.state === "partial" ? "pending" : "unknown";
  const draftState = pr.draft === true ? "pending" : pr.draft === false ? "done" : "unknown";
  const mergeState = pr.state === "merged" ? "done" : mergeCard && (mergeCard.state === "open" || mergeCard.state === "asked") ? "pending" : "unknown";
  const steps: PathwaysWaitStep[] = [
    { kind: "check run", state: checksState, since: checksState === "pending" ? pr.checksPendingSince ?? wait("green")?.createdAt ?? null : null, owner: wait("green")?.owner ?? null, note: checksState === "unknown" ? "Check timing not recorded" : pr.checks },
    { kind: "human review", state: reviewState, since: reviewState === "pending" ? pr.headCommittedAt ?? wait("approved")?.createdAt ?? pr.createdAt : null, owner: wait("approved")?.owner ?? null, note: reviewFreshness === "stale" ? "Approval older than head; branch dismisses stale reviews" : reviewFreshness === "older accepted" ? "Approval older than head; branch keeps reviews" : reviewFreshness === "unknown" && pr.review === "approved" ? "Approval head or branch rule not recorded" : pr.review === "none" && pr.requiredApprovals ? `0 of ${pr.requiredApprovals} approvals` : pr.review },
    { kind: "QA", state: qaState, since: qaState === "pending" ? proof.state === "stale" ? pr.headCommittedAt : proof.observedAt : null, owner: null, note: proof.state === "unrecorded" ? "QA proof not recorded" : `Proof ${proof.state}` },
    { kind: "draft decision", state: draftState, since: null, owner: null, note: pr.draft == null ? "Draft state not recorded" : pr.draft ? "Draft decision timing not recorded" : "Not a draft" },
    { kind: "merge go", state: mergeState, since: mergeState === "pending" ? mergeCard?.createdAt ?? wait("merged")?.createdAt ?? null : null, owner: wait("merged")?.owner ?? null, note: pr.state === "merged" ? "Merged" : mergeCard ? `Card ${mergeCard.id} · ${mergeCard.state}` : "Merge authorization not recorded" },
  ];
  return { head: pr.head, reviewFreshness, steps };
}

export function collectPathwaysProofRecords(prUrl: string, deliverables: { id: string; revisions: { rev: number; at: string; proof: { kind: string; url: string | null }[] }[] }[]): PathwaysProofRecord[] {
  return deliverables.flatMap((deliverable) => deliverable.revisions.flatMap((revision) => {
    const observedAt = Date.parse(revision.at);
    if (!Number.isFinite(observedAt) || !revision.proof.some((item) => item.kind === "pr" && item.url && canonicalPrUrl(item.url) === prUrl)) return [];
    return [{ prUrl, verifiedSha: null, status: "partial" as const, liveInterface: null, qaPacketUrl: null, sourceUrl: null, sourceLabel: `Deliverable ${deliverable.id} rev ${revision.rev}`, observedAt }];
  }));
}

export function reducePathwaysProof(pr: PathwaysPr, records: PathwaysProofRecord[]): PathwaysProof {
  const record = records.filter((item) => canonicalPrUrl(item.prUrl) === pr.url).sort((a, b) => b.observedAt - a.observedAt)[0];
  if (!record) return { state: "unrecorded", verifiedSha: null, liveInterface: null, qaPacketUrl: null, missing: ["Proof not recorded", "Live interface not recorded", "QA packet not recorded"], sourceUrl: null, sourceLabel: null, observedAt: null };
  const result = (state: PathwaysProof["state"], missing: string[]): PathwaysProof => ({ state, verifiedSha: record.verifiedSha, liveInterface: record.liveInterface, qaPacketUrl: record.qaPacketUrl, missing, sourceUrl: record.sourceUrl, sourceLabel: record.sourceLabel, observedAt: record.observedAt });
  const gaps = [...(!record.liveInterface ? ["Live interface not recorded"] : []), ...(!record.qaPacketUrl ? ["QA packet not recorded"] : [])];
  if (!pr.head) return result("partial", ["Current PR head not recorded", ...gaps]);
  if (!record.verifiedSha && pr.headCommittedAt != null && record.observedAt < pr.headCommittedAt) return result("stale", ["Proof predates current head", "Verified SHA not recorded", ...gaps]);
  if (record.status === "blocked") return result("blocked", ["Live verification blocked", ...gaps]);
  if (!record.verifiedSha) return result("partial", ["Verified SHA not recorded", ...gaps]);
  if (record.verifiedSha !== pr.head) return result("stale", ["Proof is on another head", ...gaps]);
  if (record.status === "partial" || gaps.length) return result("partial", gaps.length ? gaps : ["Verification incomplete"]);
  return result("verified", []);
}
