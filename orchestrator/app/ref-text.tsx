// A line of the command center's text with its references as links (refs.ts): a plain click opens each as a bb pane
// through openInBb (a PR, a Linear issue or any URL in bb's link handling, a thread in bb, a card or a deliverable in
// this plugin's own view); a modifier click on a URL keeps the browser's own behaviour. A PR carries its state chip.
import { createContext, useContext, type MouseEvent, type ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { openInBb, plainClick } from "./open-proof.ts";
import { exactCtx, prChip, saysState, tokenize, type PrRef, type RefContext, type Token } from "./refs.ts";
import { Button } from "./ui/button.tsx";

/**
 * A link-styled control inside a line of text (2026-11-17, the shadcn pass): shadcn's link Button, sized and coloured by
 * the words around it, underlined in the hairline colour until hovered. Projects' and Scope's in-text links share it.
 */
export const INLINE_LINK = "h-auto min-h-0 gap-1 p-0 align-baseline text-[length:inherit] leading-[inherit] font-[inherit] text-current whitespace-normal underline decoration-border underline-offset-4 hover:decoration-current has-[>svg]:px-0";

/** What every row shares (the project and its PRs are added per row): set once by the Projects tab. */
export type SharedRefs = Omit<RefContext, "project" | "projectPrs">;
export const RefsContext = createContext<SharedRefs | null>(null);
/** The project a line belongs to, with its PRs. */
export const ProjectRefs = createContext<{ project: string; prs: PrRef[] } | null>(null);

export const refCss = /* css */ `
[data-orch] .orch-cc .ref { color: inherit; text-decoration: underline; text-underline-offset: 4px; text-decoration-color: var(--cc-edge); cursor: pointer; }
[data-orch] .orch-cc .ref:hover { text-decoration-color: currentColor; }
[data-orch] .orch-cc .chip { font-size: 12px; line-height: 16px; color: var(--orch-muted); white-space: nowrap; margin-left: 4px; }
[data-orch] .orch-cc .chip .bad { color: var(--orch-ink); font-weight: 600; }
`;

/** The PR's state after its number: "ready · approved · CI passing", merged or closed alone. */
export function PrChip({ pr }: { pr: PrRef }) {
  const c = prChip(pr);
  const parts = [c.stage, c.review, c.ci].filter((x): x is string => !!x);
  return (
    <span className="chip" data-pr-chip={pr.number} data-pr-tone={c.tone}>
      {parts.map((p, i) => (
        <span key={p} className={(p === c.ci && pr.checks === "failing") || (p === c.review && pr.review === "changes_requested") ? "bad" : undefined}>
          {i ? " · " : ""}
          {p}
        </span>
      ))}
    </span>
  );
}

function RefLink({ t, chip = true }: { t: Exclude<Token, { kind: "text" }>; chip?: boolean }) {
  const nav = useBbNavigate();
  const href = t.open.url ?? undefined;
  const open = (e: MouseEvent) => {
    if (plainClick(e) && openInBb(nav, t.open)) e.preventDefault();
  };
  const link = href ? (
    <a className="ref" href={href} target="_blank" rel="noopener noreferrer" data-ref={t.kind} data-open-in-bb="" title={href} onClick={open}>
      {t.text}
    </a>
  ) : (
    <Button variant="link" className={`ref ${INLINE_LINK}`} data-ref={t.kind} data-open-in-bb="" data-prefetch-deliverable={t.kind === "deliverable" ? t.open.panel?.deliverable : undefined} title={t.kind === "card" ? (t.answered ? "Open the answered card in Activity" : "Open the card in Needs you") : t.kind === "deliverable" ? "Open in Deliverables" : "Open the thread"} onClick={open}>
      {t.text}
    </Button>
  );
  return t.kind === "pr" && chip ? (
    <>
      {link}
      <PrChip pr={t.pr} />
    </>
  ) : (
    link
  );
}

/**
 * The text with its references linked; plain text where the page has no context (or nothing resolves). `exact`: the
 * thing a structured wait names (its ref). A wait's words shorten it ("PR #41", "thread 17"), so a number there links
 * only to that PR, and a thread number reads in that thread's project: never the same number elsewhere.
 */
export function RefText({ text, exact }: { text: string; exact?: string | null }): ReactNode {
  const shared = useContext(RefsContext);
  const project = useContext(ProjectRefs);
  if (!shared || !text) return text;
  const tokens = tokenize(text, exactCtx({ ...shared, project: project?.project ?? "", projectPrs: project?.prs ?? [] }, exact));
  if (tokens.every((t) => t.kind === "text")) return text;
  return tokens.map((t, i) => (t.kind === "text" ? <span key={i}>{t.text}</span> : <RefLink key={i} t={t} chip={!saysState(t, tokens[i + 1])} />));
}
