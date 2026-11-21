// The one reply box (2026-11-20). The owner called the box to a lead broken; their model is X's
// inline reply. Every box the owner writes in is drawn by this: the feed's reply, the message box to a lead, a card's
// "Other" and a deliverable's next move and change request. It is:
// - the owner's avatar on the left, and beside it a borderless text area that grows with the text (field-sizing), whose
//   placeholder names who it goes to;
// - under it, one thin row: small icon tools (attach) on the left, then at most one tiny muted hint, then the actions on
//   the right, the main one a rounded pill (dimmed while it can't send). Where the row is narrow (a phone) the hint
//   takes its own line under it instead, so the buttons stay together;
// - no box around the field, no divider, and no notice said twice. A rule's detail is behind the hint (a popover on a
//   tap or click, the title on hover), never a second line.
// Only layout lives here: each box keeps its own state, writes and data-* hooks. It imports only app/ui, lucide and
// face.tsx, so a test can render it in node (test/reply-composer.test.ts).
import { useCallback, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { Info } from "lucide-react";
import { AgentFace } from "./face.tsx";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { cn } from "./ui/utils.ts";

/**
 * The field: shadcn's Textarea with its border, fill, shadow, ring and inset taken off (dark too: the base fills it with
 * bg-input/30, which is what made the old box look boxed). Focused, a 2 px bar in the ring colour runs down its left
 * edge, beside the text, never between the text and the row. 16 px on a phone (no zoom on focus), 15 px from md.
 */
export const REPLY_FIELD =
  "min-h-9 max-h-44 resize-none rounded-none border-0 bg-transparent px-0 py-1.5 pl-2 text-base leading-[22px] shadow-none focus-visible:ring-0 focus-visible:shadow-[inset_2px_0_0_var(--ring)] md:text-[15px] [&:is(.dark_*)]:bg-transparent";

/**
 * The text area of a reply box (shadcn's Textarea, borderless); every prop, ref included, goes to it.
 * 2026-11-20 (the owner: "the input bars right now are so slow and laggy"): `value` is written to the box only when it
 * differs from what the box holds (a draft restored, the box cleared after Send), never as a React-controlled value.
 * React rewrites a controlled textarea's text child on every keystroke, and inside bb's page that one DOM change set off
 * bb's own :has() rules, which restyled about 3,500 elements per key.
 */
export function ReplyField({ className, value, ref, ...p }: ComponentProps<typeof Textarea>) {
  const box = useRef<HTMLTextAreaElement | null>(null);
  const text = value == null ? "" : String(value);
  useLayoutEffect(() => {
    if (box.current && box.current.value !== text) box.current.value = text;
  }, [text]);
  const own = useCallback(
    (el: HTMLTextAreaElement | null) => {
      box.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  return <Textarea rows={1} {...p} ref={own} className={cn(REPLY_FIELD, className)} />;
}

/** The box's main action: a small primary pill. Disabled it stays the primary colour, dimmed (and keeps its title). */
export function ReplyButton({ className, type = "button", ...p }: ComponentProps<typeof Button>) {
  return <Button type={type} size="sm" className={cn("h-8 rounded-full px-4 font-semibold disabled:pointer-events-auto disabled:cursor-default", className)} {...p} />;
}

/** Another action in the row (Cancel, Request changes): the same pill, ghost unless told otherwise. */
export function ReplyAction({ className, type = "button", variant = "ghost", ...p }: ComponentProps<typeof Button>) {
  return <Button type={type} variant={variant} size="sm" className={cn("h-8 rounded-full px-3 disabled:pointer-events-auto disabled:cursor-default", className)} {...p} />;
}

/** The one muted hint: a few words and an info icon; the rule's detail opens on a tap or click, and is the hover title. */
export function ReplyHint({ children, detail, ...data }: { children: ReactNode; detail: string; [data: `data-${string}`]: string | undefined }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="xs" className="h-6 gap-1 px-1.5 text-xs font-normal text-muted-foreground" title={detail} {...data}>
          {children}
          <Info aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 text-xs leading-5" data-reply-detail="">
        {detail}
      </PopoverContent>
    </Popover>
  );
}

type Props = Omit<ComponentProps<"div">, "children"> & {
  /** the field (a ReplyField with the box's own handlers) */
  field: ReactNode;
  /** small ghost icon buttons on the left of the row (attach), and anything as quiet beside them */
  tools?: ReactNode;
  /** at most one tiny muted line, between the tools and the actions */
  hint?: ReactNode;
  /** the row's right end: the main pill last */
  actions: ReactNode;
  /** under the field, above the row: attached thumbnails, an error */
  children?: ReactNode;
  /** the writer's face; the owner's by default, null for none */
  avatar?: ReactNode;
  /**
   * Idle on one line, as X's reply collapses until you focus it (2026-11-20, the lead): the field, then the tools and
   * the actions beside it, no hint. The box decides when (empty, not focused); the field stays the same element, so a
   * click in it keeps its focus while the box opens to two rows.
   */
  inline?: boolean;
  [data: `data-${string}`]: unknown;
};

/** A reply box: the avatar, then the field and, under it, the one row (tools, hint, actions); `inline`, all on one line. */
export function ReplyComposer({ field, tools, hint, actions, children, avatar, inline = false, className, ...rest }: Props) {
  const face = avatar === undefined ? <AgentFace face={null} address="person" size={32} /> : avatar;
  return (
    <div data-reply-composer="" data-inline={inline ? "" : undefined} className={cn("flex gap-3", inline ? "items-center" : "items-start", className)} {...rest}>
      {face ? <div className={cn("shrink-0", !inline && "pt-0.5")}>{face}</div> : null}
      {/* the row lays out by its own width (a phone, a narrow pane): with room, the hint sits between the tools and the
          actions and wraps inside its space; without, it takes its own line under them, so the buttons never split */}
      <div className={cn("@container/reply min-w-0 flex-1", inline && "flex items-center gap-2 [&>textarea]:min-w-0 [&>textarea]:flex-1 [&>textarea]:overflow-hidden [&>textarea]:whitespace-nowrap [&>textarea]:[mask-image:linear-gradient(to_right,black_calc(100%_-_24px),transparent)]")}>
        {field}
        {children}
        <div data-composer-row="" className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", inline ? "flex-none" : "mt-1")}>
          {tools ? (
            <div className="flex shrink-0 flex-wrap items-center gap-1" data-composer-tools="">
              {tools}
            </div>
          ) : null}
          {hint && !inline ? (
            <div className="order-last flex min-w-0 basis-full justify-end text-right @sm/reply:order-none @sm/reply:flex-1 @sm/reply:basis-0" data-composer-hint-slot="">
              {hint}
            </div>
          ) : null}
          <div className={cn("flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1", !inline && "ml-auto")} data-composer-actions="">
            {actions}
          </div>
        </div>
      </div>
    </div>
  );
}
