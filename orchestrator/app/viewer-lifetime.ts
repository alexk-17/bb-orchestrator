// Taking the image viewer down when the card that opened it goes away (photo-viewer.ts). PhotoSwipe 5.4.4 ignores
// destroy() and close() while it is still opening, then binds its document keydown and focusin listeners when the opening
// ends: a card left during the opening fade kept the arrow keys and Tab captured on the next screen (review of public
// PR #17). No PhotoSwipe import here, so a test can drive it with a stand-in.

/** The parts of a PhotoSwipe instance this needs. */
export type Viewer = {
  opener: { isOpen: boolean };
  isDestroying: boolean;
  on(name: "openingAnimationEnd", fn: () => void): void;
  destroy(): void;
};

/**
 * Take the viewer down now: out of sight at once, then destroyed. Open (or already closing), destroy() works at once. Still
 * opening (or not yet started), it waits for the opening to end and destroys it in the same dispatch, right after
 * PhotoSwipe's own handler binds its listeners, so no key or focus event ever reaches them. PhotoSwipe's own fallback
 * timer ends the opening even while hidden.
 */
export function takeDown(pswp: Viewer, host: HTMLElement): void {
  host.style.display = "none";
  if (pswp.opener.isOpen || pswp.isDestroying) pswp.destroy();
  else pswp.on("openingAnimationEnd", () => pswp.destroy());
}
