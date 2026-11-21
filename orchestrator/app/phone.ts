// bb's own phone layout (its touch type scale and bottom bar, spec.md): a touch screen 767 px wide or less. A narrowed
// desktop window is not a phone, so what only a phone does (a project opening as a page) never follows a pane's width.
import { useSyncExternalStore } from "react";

export const PHONE_QUERY = "(max-width: 767px) and (pointer: coarse)";

const media = () => (typeof matchMedia === "function" ? matchMedia(PHONE_QUERY) : null);
const subscribe = (f: () => void) => {
  const m = media();
  m?.addEventListener("change", f);
  return () => m?.removeEventListener("change", f);
};

/** Whether bb draws its phone layout now. */
export function useTouchPhone(): boolean {
  return useSyncExternalStore(subscribe, () => media()?.matches ?? false, () => false);
}

/** The row's mask: a fade only on a side with more to scroll to, so a row that fits shows whole. */
export function fadeOf(more: { left: boolean; right: boolean }): string {
  return `linear-gradient(to right, ${more.left ? "transparent, black 24px" : "black"}, ${more.right ? "black calc(100% - 32px), transparent" : "black"})`;
}
