// An image in a card pops out full-size on one click (2026-11-20, the owner: one click on the screenshot itself, no side
// panel step first); a cmd, ctrl, shift or middle click keeps the browser's own behaviour on the anchor's href.
// 2026-11-21 (the owner, after trying it): a right-click (a long-press on touch) on the card's picture offers "Open in
// side panel" (bb's pane, docked beside the chat) and "Open in new tab"; the viewer has the same two as toolbar buttons.
// Later that day: the viewer should feel like iOS Photos (pinch, double-tap, drag down to close with the picture
// following the finger), so it is PhotoSwipe now (photo-viewer.ts), loaded on the first click. No bb SDK here, so tests
// can render it: the caller passes how to open the side panel.
import { useEffect, useRef, type ReactNode } from "react";
import { ContextMenu as MenuPrimitive } from "radix-ui";
import { ExternalLink, PanelRight, XIcon } from "lucide-react";
import { plainClick } from "./open-proof.ts";
import { PORTAL, cn } from "./ui/utils.ts";

type Props = {
  /** The full-size picture (also the anchor's href, for a modifier or middle click). */
  src: string;
  /** Names the dialog and sits under the picture. */
  caption: string;
  /** The picture as the card draws it. */
  children: ReactNode;
  /** The anchor's classes (the card's frame). */
  className?: string;
  /** Opens it in bb's side panel; true when bb took it. Without it the menu offers only a new tab. */
  sidePanel?: () => boolean;
};

/** True when the click is ours to take: a plain left click; anything else keeps the browser's own behaviour. */
export const popsOut = plainClick;

const ITEM = "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

/** The right-click (long-press) menu on the picture. */
function ImageMenu({ src, sidePanel, onPicked, children }: { src: string; sidePanel?: () => boolean; onPicked?: () => void; children: ReactNode }) {
  return (
    <MenuPrimitive.Root modal={false}>
      <MenuPrimitive.Trigger asChild>{children}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content {...PORTAL} data-popout-menu="" className="z-[60] min-w-[11rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          {sidePanel ? (
            <MenuPrimitive.Item
              className={ITEM}
              data-popout-side=""
              onSelect={() => {
                if (sidePanel()) onPicked?.();
                else window.open(src, "_blank", "noopener,noreferrer");
              }}
            >
              <PanelRight aria-hidden />
              Open in side panel
            </MenuPrimitive.Item>
          ) : null}
          <MenuPrimitive.Item className={ITEM} data-popout-tab="" onSelect={() => void window.open(src, "_blank", "noopener,noreferrer")}>
            <ExternalLink aria-hidden />
            Open in new tab
          </MenuPrimitive.Item>
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

export function ImagePopout({ src, caption, children, className, sidePanel }: Props) {
  const trigger = useRef<HTMLAnchorElement>(null);
  // the open viewer (or the one loading) belongs to this card: leaving the card cancels the load and closes it, so it
  // can never open over the next screen or outlive the card it came from (review of public PR #17)
  const viewer = useRef<AbortController | null>(null);
  useEffect(() => () => viewer.current?.abort(), []);
  const open = async () => {
    if (viewer.current) return;
    const live = new AbortController();
    viewer.current = live;
    const done = () => {
      if (viewer.current === live) viewer.current = null;
    };
    try {
      const { openViewer } = await import("./photo-viewer.ts");
      if (live.signal.aborted) return;
      const shown = await openViewer({
        src,
        caption,
        thumb: trigger.current?.querySelector("img") ?? null,
        sidePanel,
        signal: live.signal,
        onClosed: () => {
          done();
          trigger.current?.focus();
        },
      });
      if (!shown) done();
    } catch (e) {
      done();
      throw e;
    }
  };
  return (
    <ImageMenu src={src} sidePanel={sidePanel}>
      <a
        ref={trigger}
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        data-popout=""
        aria-haspopup="dialog"
        className={cn("cursor-zoom-in [-webkit-touch-callout:none]", className)}
        onClick={(e) => {
          if (!popsOut(e)) return;
          e.preventDefault();
          // the viewer lives outside the card: keep this click from reaching it (a phone's post opens on a tap)
          e.stopPropagation();
          void open();
        }}
      >
        {children}
      </a>
    </ImageMenu>
  );
}
