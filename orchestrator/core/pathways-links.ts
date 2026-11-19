import type { PathwaysPrLinks } from "./pathways-pr.ts";

function canonical(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, "").toLowerCase()}` : null;
  } catch {
    return null;
  }
}

function explicitUrls(text: string): string[] {
  return [...text.matchAll(/https:\/\/[^\s<>()]+/g)].map((match) => canonical(match[0]!.replace(/[),.;]+$/, ""))).filter((url): url is string => !!url);
}

export function explicitCardIds(issue: { url: string; description: string | null }, prLink: PathwaysPrLinks, cards: { id: string; context: string; prUrls?: string[] }[]): string[] {
  const issueUrl = canonical(issue.url);
  const prUrl = prLink.state === "linked" ? canonical(prLink.urls[0] ?? "") : null;
  const named = [...(issue.description ?? "").matchAll(/^Decision card:\s*(d-[\w-]+)\s*$/gim)].map((match) => match[1]!);
  return [...new Set(cards.filter((card) => named.includes(card.id) || issueUrl != null && explicitUrls(card.context).includes(issueUrl) || prUrl != null && (card.prUrls ?? []).some((url) => canonical(url) === prUrl)).map((card) => card.id))];
}
