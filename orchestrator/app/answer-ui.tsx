// The answer parts of a Needs you card, on shadcn/ui (app/ui, 2026-11-17; before that affectUI's decision inbox).
// Short answers are buttons in a row, the recommended one the primary button. Answers that explain themselves are tiles:
// one outline button per answer, its words, a quiet line under them and a Recommended badge. Context waits behind a
// quiet "More". "Other" is a text box that is always open; ⌘/Ctrl+Enter in it sends (2026-11-13).
//
// The double-tap guard (2026-11-17): every answer is the shared Btn, whose disabled state still takes the pointer, and no
// state changes an answer's size. A primary and an outline button both carry a 1px border, a tile keeps its badge row
// while any answer is recommended, its Picked badge always laid out, and the Other box is a fixed height, so pressing, arming or picking moves nothing.
import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { Badge } from "./ui/badge.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx";
import { ReplyButton, ReplyComposer, ReplyField } from "./reply-composer.tsx";
import { cn } from "./ui/utils.ts";
import { Btn } from "./ui.tsx";
import { pickedClass, reservesBadgeRow } from "./option-tiles.ts";

/** A card's quiet line under its title, and the fixed slot on its right where the time and the mark take turns. */
export const META = "m-0 mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground [overflow-wrap:anywhere]";
export const WHEN = "w-28 flex-none text-right text-xs leading-5 whitespace-nowrap text-muted-foreground";

export type Opt = {
  key: string;
  label: string;
  detail?: string | null;
  recommended?: boolean;
  /** Multi-pick: whether it is ticked (undefined for an option that answers at once) */
  pressed?: boolean;
  /** data-* attributes for the button (the tests and the arming read them) */
  data: Record<string, string | undefined>;
  onPick: () => void;
};

/** Tiles when any answer explains itself or is long; buttons otherwise. Recommended first. */
export function Options({ options, disabled, label = "Options" }: { options: Opt[]; disabled: boolean; label?: string }) {
  const sorted = [...options].sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)));
  const tiles = sorted.some((o) => (o.detail && o.detail.trim() !== "") || o.label.length > 32);
  if (!tiles) {
    return (
      <div role="group" aria-label={label} className="mt-3 flex flex-wrap gap-2">
        {sorted.map((o) => {
          const primary = o.pressed ?? o.recommended;
          return (
            <Btn key={o.key} tone={primary ? "primary" : "outline"} className={cn("h-auto min-h-9 max-w-full border text-start whitespace-normal [overflow-wrap:anywhere]", primary && "border-transparent")} aria-pressed={o.pressed} disabled={disabled} onClick={o.onPick} {...o.data}>
              {o.label}
            </Btn>
          );
        })}
      </div>
    );
  }
  // Recommended has a row under the words, kept on every tile while any tile has it, so tiles stay equal; none when no tile has one
  const badges = reservesBadgeRow(sorted);
  return (
    <div role="group" aria-label={label} className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-2" data-tiles="">
      {sorted.map((o) => (
        <Btn
          key={o.key}
          tone="outline"
          className={cn("h-auto w-full flex-col items-start justify-start gap-1 p-3 text-start whitespace-normal", o.pressed && "border-primary bg-accent [&:is(.dark_*)]:border-primary [&:is(.dark_*)]:bg-accent")}
          aria-pressed={o.pressed}
          disabled={disabled}
          onClick={o.onPick}
          {...o.data}
        >
          {/* Picked is in the title row, always laid out and only shown by a pick, so a pick moves nothing */}
          <span className="flex w-full items-start justify-between gap-2" data-tile-title="">
            <span className="text-sm font-medium [overflow-wrap:anywhere]">{o.label}</span>
            {o.pressed !== undefined ? (
              <Badge variant="outline" className={pickedClass(o.pressed)}>
                Picked
              </Badge>
            ) : null}
          </span>
          {o.detail ? <span className="text-xs font-normal text-muted-foreground [overflow-wrap:anywhere]">{o.detail}</span> : null}
          {badges ? (
            // under the words, so a narrow tile never squeezes its title beside the badge
            <span className="mt-1 flex h-5 gap-1.5">{o.recommended ? <Badge variant="secondary">Recommended</Badge> : null}</span>
          ) : null}
        </Btn>
      ))}
    </div>
  );
}

/** Context, and the parts that explain rather than act: always closed behind a quiet "More" (2026-11-14, no prose on cards). */
export function Details({ markdown, children }: { markdown: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2" data-context="" data-open={open ? "" : undefined}>
      <Btn tone="ghost" size="sm" className="-ml-2 h-7 gap-1 px-2 text-xs text-muted-foreground" data-more="" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
        {open ? "Less" : "More"}
      </Btn>
      {open ? (
        <div className="orch-md mt-1 text-sm text-foreground [overflow-wrap:anywhere]">
          {markdown ? <Markdown content={markdown} /> : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A closed fold (shadcn's Collapsible) for a deliverable's Details, History and outputs. Its content stays in the page
 * while closed, only hidden, so its order is the same open or closed (the less-text rules read it there).
 */
export function Fold({ label, className, children, ...data }: { label: ReactNode; className?: string; children: ReactNode; [data: `data-${string}`]: string | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={className} {...data}>
      <CollapsibleTrigger asChild>
        {/* the label wraps (2026-11-21): one long "Details: …" line pushed the phone's whole page sideways */}
        <Btn tone="ghost" size="sm" className="-ml-2 h-auto min-h-7 max-w-full items-start justify-start gap-1 px-2 py-1.5 text-start text-xs font-normal whitespace-normal text-muted-foreground" data-fold-toggle="">
          <ChevronRight className={cn("mt-px size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
          <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
        </Btn>
      </CollapsibleTrigger>
      <CollapsibleContent forceMount className="data-[state=closed]:hidden">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * "Other": always open, as the reply box (reply-composer.tsx, 2026-11-20). ⌘/Ctrl+Enter sends from inside it; the
 * Send pill is for phones. It grows with the text now (the owner's model, X's reply box): the fixed height it had so
 * typing never moved the cards below gave way to it.
 */
export function OtherBox({ value, onChange, onSend, disabled, placeholder, sendLabel = "Send" }: { value: string; onChange: (v: string) => void; onSend: () => void; disabled: boolean; placeholder: string; sendLabel?: string }) {
  return (
    <ReplyComposer
      className="mt-3"
      field={
        <ReplyField
          data-note=""
          aria-label="Your own answer"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (!disabled && value.trim() !== "") onSend();
            }
          }}
          maxLength={4000}
          placeholder={placeholder}
        />
      }
      actions={
        <ReplyButton data-note-send="" disabled={disabled || value.trim() === ""} onClick={onSend}>
          {sendLabel}
        </ReplyButton>
      }
    />
  );
}

/**
 * Only what bb's host Markdown needs inside a card: its paragraphs, lists and headings at the card's own size. Scope
 * injects it too (scope.tsx), so the name stays.
 */
export const answerCss = /* css */ `
[data-orch] .orch-md :where(p, li, td, th, blockquote) { font-size: 13px !important; line-height: 20px !important; }
[data-orch] .orch-md :where(p) { margin: 0 0 6px !important; }
[data-orch] .orch-md :where(ul, ol) { margin: 0 0 6px !important; padding-left: 18px !important; }
[data-orch] .orch-md :where(li) { margin: 2px 0 !important; }
[data-orch] .orch-md :where(h1, h2, h3, h4) { margin: 8px 0 4px !important; font-size: 13px !important; line-height: 20px !important; font-weight: 600; }
[data-orch] .orch-md > :last-child, [data-orch] .orch-md > * > :last-child { margin-bottom: 0 !important; }
`;
