// Reviews (Home first step 3, 2026-11-20): your open PRs, then Team boards and the CodeRabbit queue as sections, each drawn (and read) only once it is used.
import type { ReactNode } from "react";
import { OpenPrsView } from "./open-prs.tsx";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-label={title} data-review-section={id} className="flex min-w-0 flex-col gap-3">
      <h2 className="m-0 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** `shown`: the pages the page may show (shownTabs: hidden until used, and hiddenTabs). A section not shown is not mounted. */
export function ReviewsView({ shown, multiplayer, coderabbit }: { shown: ReadonlySet<string>; multiplayer: () => ReactNode; coderabbit: () => ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-8" data-reviews="">
      <Section id="open-prs" title="Your PRs">
        <OpenPrsView />
      </Section>
      {shown.has("multiplayer") ? (
        <Section id="multiplayer" title="Team boards">
          {multiplayer()}
        </Section>
      ) : null}
      {shown.has("coderabbit") ? (
        <Section id="coderabbit" title="CodeRabbit queue">
          {coderabbit()}
        </Section>
      ) : null}
    </div>
  );
}
