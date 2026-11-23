// The owner's text boxes. 2026-11-21, the owner: "we need to fix the text bars for like the 'other' option or request
// changes back to the same one that's there for the talk directly to lead". So every box the owner writes a message in is
// the one compact bar, the box to a lead's (direct-line.tsx, 1.16.0 and again since 2026-11-21): a bordered field that
// grows as you type, with the action buttons inline beside it at its last line, and under them, across the whole bar,
// what goes with it (thumbnails, one quiet line, an error). The box to a lead, a card's "Other", the feed's reply and a
// deliverable's "Request changes" all draw CompactBar. No avatar, no divider between the field and its buttons, a
// disabled primary dimmed (never a grey block), and a notice said once.
// Only layout lives here: each box keeps its own state, writes and data-* hooks. It imports only app/ui, lucide and react,
// so a test can render it in node (test/reply-composer.test.ts).
import { useCallback, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { Info } from "lucide-react";
import { Button } from "./ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { cn } from "./ui/utils.ts";

/**
 * The field's look (2026-11-21, the owner's compact bars): shadcn's Textarea as it is, bordered and rounded, its dark
 * fill and focus ring kept; one 36 px line when empty (h-9: a 22 px line, 6 px above and below, the border), growing with
 * the text (field-sizing) to about eight lines, then scrolling. 16 px on a phone (no zoom on focus), 15 px from md.
 * min-w-0: in a grid or flex cell it never widens its column past a phone's width.
 * Empty, it stays one line whatever the placeholder (the field sizes to its placeholder too, and a long one, "Reply to
 * Lead · project…" beside a phone's buttons, made the empty box two or three lines tall): the placeholder keeps to one
 * line, cut at the edge. Typing ends :placeholder-shown, one style change on this element only.
 */
export const BOXED_FIELD =
  "min-h-9 max-h-44 min-w-0 resize-none py-1.5 leading-[22px] md:text-[15px] placeholder-shown:h-9 placeholder-shown:overflow-hidden placeholder-shown:text-ellipsis placeholder-shown:whitespace-nowrap";

/**
 * The text area of a message box (shadcn's Textarea, bordered); every other prop, ref included, goes to it.
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
  return <Textarea rows={1} {...p} ref={own} className={cn(BOXED_FIELD, className)} />;
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

type Bar = Omit<ComponentProps<"div">, "children"> & {
  /** the field: a ReplyField with the box's own handlers */
  field: ReactNode;
  /** beside the field, at its last line: small ghost icon buttons (attach, cancel), then the primary action last */
  actions: ReactNode;
  /** under the bar, each across its whole width: attached thumbnails, the quiet line, an error */
  children?: ReactNode;
  [data: `data-${string}`]: unknown;
};

/**
 * The compact bar: the field | its actions (a grid, `minmax(0,1fr) auto`, gap 8, bottom-aligned, so the buttons stay
 * at the field's last line as it grows), then the children under it, 8 px apart. A child that shows only once text is
 * typed stays mounted and hides (the `hidden` attribute, or a class): a hidden child takes no row and no gap, and a
 * keystroke adds no element.
 */
export function CompactBar({ field, actions, children, className, ...rest }: Bar) {
  return (
    <div data-compact-bar="" className={cn("flex min-w-0 flex-col gap-2", className)} {...rest}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2" data-bar-row="">
        <div className="min-w-0" data-bar-field="">
          {field}
        </div>
        <div className="flex items-center gap-1" data-bar-actions="">
          {actions}
        </div>
      </div>
      {children}
    </div>
  );
}
