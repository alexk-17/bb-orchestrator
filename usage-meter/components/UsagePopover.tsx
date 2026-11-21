// components/UsagePopover.tsx — the body of the sidebar footer's "Usage limits" popover.
//
// One bar per account and limit window: label, % used (number and fill) and the
// reset time. The colours are the rings' own (lib/limits.ts toneOf), so they
// need no footnote. The content script in app.tsx owns the panel, its hover,
// pinning and placement; this only draws what is inside it.
import type { MouseEvent, ReactNode } from "react";

import type { UsageState } from "../server";
import { barOf, hasFigures, staleLine, statusLine, type Bar, type Line, type Tone } from "../lib/limits";
import { Badge } from "./ui/badge";
import { Progress } from "./ui/progress";
import { Separator } from "./ui/separator";

type Account = UsageState["accounts"][number];

/** Fill colour by tone. Amber is the ring's own `--warning`, so ring and bar agree in every theme. */
const FILL: Record<Tone, string> = {
  normal: "bg-foreground/50",
  warn: "bg-[var(--warning,#e3a008)]",
  danger: "bg-destructive",
};

const FIGURE: Record<Tone, string> = {
  normal: "text-foreground",
  warn: "text-[var(--warning,#e3a008)]",
  danger: "text-[var(--destructive-text,var(--destructive))]",
};

const HEADING = "text-[0.6875rem] uppercase tracking-wider text-muted-foreground";

function BarRow({ bar, owner }: { bar: Bar; owner: string }): ReactNode {
  return (
    <div
      className="grid grid-cols-[3rem_minmax(0,1fr)_2.25rem_7rem] items-center gap-x-1.5 text-xs"
      title={bar.title}
    >
      <span className="truncate text-muted-foreground">{bar.label}</span>
      <Progress
        value={bar.percent}
        aria-label={`${owner}, ${bar.title}: ${bar.percent}% used`}
        className="h-1.5 bg-foreground/10"
        indicatorClassName={FILL[bar.tone]}
      />
      <span className={`text-right font-medium tabular-nums ${FIGURE[bar.tone]}`}>{bar.percent}%</span>
      <span className="truncate text-right text-[0.6875rem] tabular-nums text-muted-foreground">{bar.reset}</span>
    </div>
  );
}

/** `owner` names the account in each bar's aria-label: several accounts have a "Week" bar. */
function Bars({ windows, owner, now }: { windows: UsageState["windows"]; owner: string; now: Date }): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      {windows.map((w) => (
        <BarRow key={w.label} bar={barOf(w, now)} owner={owner} />
      ))}
    </div>
  );
}

function Note({ line, className = "" }: { line: Line; className?: string }): ReactNode {
  return (
    <div className={`text-xs text-muted-foreground ${className}`} title={line.title ?? undefined}>
      {line.text}
    </div>
  );
}

function AccountBlock({ account, now }: { account: Account; now: Date }): ReactNode {
  const exhausted = account.poolStatus === "exhausted";
  const empty = account.status !== "ok" || account.windows.length === 0;
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${account.enabled ? "" : "opacity-50"}`}>
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <span className={`min-w-0 truncate ${account.current ? "font-semibold" : "font-medium"}`} title={account.label}>
          {account.label}
        </span>
        {account.planLabel ? (
          <Badge variant="secondary" className="px-1.5 py-0 text-[0.625rem] font-normal text-muted-foreground">
            {account.planLabel}
          </Badge>
        ) : null}
        {account.current ? <span className="flex-none text-[0.6875rem] text-primary">this login</span> : null}
        {!account.enabled ? (
          <span className="ml-auto flex-none text-[0.6875rem] text-muted-foreground">disabled</span>
        ) : exhausted ? (
          <span className="ml-auto flex-none text-[0.6875rem] font-medium text-[var(--destructive-text,var(--destructive))]">
            exhausted
          </span>
        ) : null}
      </div>
      {empty ? (
        <div className="text-xs text-muted-foreground">
          {account.status === "ok" ? "No limit windows" : account.status.replace(/_/g, " ")}
        </div>
      ) : (
        <Bars windows={account.windows} owner={account.label} now={now} />
      )}
    </div>
  );
}

export function UsagePopover({
  state,
  detailsHref,
  onDetails,
  now = new Date(),
}: {
  state: UsageState | null;
  detailsHref: string;
  onDetails: (event: MouseEvent<HTMLAnchorElement>) => void;
  now?: Date;
}): ReactNode {
  const heading = <div className={HEADING}>Usage limits</div>;
  // Figures are shown after a failure too: they are old but real.
  if (!state || (state.status !== "ok" && !hasFigures(state))) {
    return (
      <div className="flex flex-col gap-1.5">
        {heading}
        <Note line={statusLine(state)} />
      </div>
    );
  }
  // The pool list already comes in routing order (server.ts); one account is the block above.
  const accounts = state.accounts.length >= 2 ? state.accounts : [];
  return (
    <div className="flex flex-col gap-2">
      {heading}
      {state.planLabel || state.accountEmail ? (
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          {state.accountEmail ? (
            <span className="min-w-0 truncate font-medium" title={state.accountEmail}>
              {state.accountEmail}
            </span>
          ) : null}
          {state.planLabel ? (
            <Badge variant="secondary" className="px-1.5 py-0 text-[0.625rem] font-normal text-muted-foreground">
              {state.planLabel}
            </Badge>
          ) : null}
        </div>
      ) : null}
      {state.windows.length > 0 ? (
        <Bars windows={state.windows} owner={state.accountEmail ?? "This login"} now={now} />
      ) : (
        <div className="text-xs text-muted-foreground">No limit windows</div>
      )}
      {state.status !== "ok" ? <Note line={staleLine(state)} /> : null}
      {accounts.length > 0 ? (
        <>
          <Separator decorative={false} className="my-0.5" />
          <div className={HEADING}>All accounts · {accounts.length}</div>
          <div className="-mr-1.5 flex max-h-[50vh] flex-col gap-3 overflow-y-auto pr-1.5">
            {accounts.map((a) => (
              <AccountBlock key={a.id} account={a} now={now} />
            ))}
          </div>
        </>
      ) : null}
      <a href={detailsHref} onClick={onDetails} className="w-fit text-xs text-primary no-underline hover:underline">
        More details →
      </a>
    </div>
  );
}
