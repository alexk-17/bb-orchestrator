// Deterministic, body-derived context for the PRs tab and clipboard. No model or network calls.
import { cut } from "./open-prs.ts";

function words(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[?\b[A-Z][A-Z0-9]{1,9}-\d+\b\]?/g, " ")
    .replace(/(^|\s)#\d+\b/g, "$1")
    .replace(/(?:^|\s)(?:closes?|fixes|resolves?|refs?|tickets?|issues?)\s*:?\s*[.,;:]?\s*$/gi, " ")
    .replace(/[`*~]/g, "")
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1$2")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/^\s*TL\s*;?\s*DR[.:]?\s*/i, "")
    .replace(/\s+/g, " ").replace(/^[\s.,;:—–-]+|[\s,;:—–-]+$/g, "").trim();
}

export function copySummary(body: string, title: string): string {
  const paragraphs: { heading: string; text: string }[] = [];
  let heading = "", lines: string[] = [], fence: string | null = null;
  const flush = () => {
    const text = words(lines.join(" "));
    if (text && !/^(?:todo|tbd|n\/a|none|[-.\s]+)$/i.test(text)) paragraphs.push({ heading, text });
    lines = [];
  };
  for (const line of body.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]?.[0];
    if (marker) { flush(); if (!fence) fence = marker; else if (fence === marker) fence = null; continue; }
    if (fence) continue;
    const inline = /^\s*\*\*([^*]{1,60})\*\*\s*(.*)$/.exec(line);
    if (inline && (/[.:]$/.test(inline[1]!) || /^(?:summary|what(?: changes?| changed)?)$/i.test(inline[1]!))) {
      flush(); heading = words(inline[1]!).replace(/[.:]$/, "").toLowerCase();
      if (inline[2]) lines.push(inline[2]);
      continue;
    }
    const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line) ?? /^\s*\*\*(Summary|What(?: changed)?)\*\*\s*:?\s*$/i.exec(line);
    if (h) { flush(); heading = words(h[1]!).toLowerCase(); continue; }
    if (!line.trim() || /^\s*(\||[-*_]{3,}\s*$)/.test(line)) { flush(); continue; }
    const cleaned = line.replace(/^\s*(?:[-*+] |\d+[.)] |>)\s*/, "").replace(/^\[[ xX]\]\s*/, "");
    if (/^(?:bug fixes|new features|improvements|documentation|tl;?dr)[.:]?$/i.test(words(cleaned))) { flush(); continue; }
    if (!words(cleaned) || /^(?:todo|tbd|n\/a|none)$/i.test(words(cleaned))) { flush(); continue; }
    lines.push(cleaned);
  }
  flush();
  const preferred = paragraphs.find((p) => /^(summary|what(?: changed| changes| this does)?)\b/.test(p.heading));
  const prose = paragraphs.find((p) => !/^(?:tests?|validation|tickets?|issues?|checklist|screenshots?)\b/.test(p.heading));
  const paragraph = preferred?.text ?? prose?.text ?? "";
  const fallback = words(title.replace(/^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^)]*\))?!?:\s*/i, ""));
  const text = paragraph || fallback;
  return cut(text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text, 140);
}
