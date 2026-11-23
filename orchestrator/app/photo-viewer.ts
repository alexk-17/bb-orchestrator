// The full-size image viewer (2026-11-21, the owner: "feel like the iOS Photos app"): PhotoSwipe v5 (MIT), so a
// touch screen gets pinch and double-tap zoom, pan when zoomed, and drag down to close with the picture following the
// finger and the backdrop fading (it snaps back when let go short); a mouse gets wheel and click zoom, a click outside
// and Esc to close. It is a dialog (PhotoSwipe's role=dialog, labelled here by the caption) that traps focus and gives
// it back to the picture in the card. bb's own experimental_ImageLightbox was tried first: it pinches, but has no drag
// to close. Loaded on the first click only (image-popout.tsx), so the card's code and its tests never load it.
import PhotoSwipe from "photoswipe";
import "photoswipe/style.css";
import "./photo-viewer.css";
import { PORTAL } from "./ui/utils.ts";
import { takeDown } from "./viewer-lifetime.ts";

export type ViewerOptions = {
  src: string;
  caption: string;
  /** The card's picture: its natural size sizes the slide before the full one loads. */
  thumb: HTMLImageElement | null;
  /** Opens it in bb's side panel; true when bb took it. */
  sidePanel?: () => boolean;
  /** Aborted when the card that opened it goes away: the load stops, and an open viewer is removed. */
  signal: AbortSignal;
  onClosed: () => void;
};

/** The picture's pixel size: the card's copy when it has loaded, else the full one once it loads. */
async function sizeOf(src: string, thumb: HTMLImageElement | null, signal: AbortSignal): Promise<{ width: number; height: number }> {
  if (thumb?.complete && thumb.naturalWidth > 0) return { width: thumb.naturalWidth, height: thumb.naturalHeight };
  const img = new Image();
  // the card went away: stop fetching the picture (decode() then rejects)
  const stop = () => img.removeAttribute("src");
  signal.addEventListener("abort", stop, { once: true });
  img.src = src;
  try {
    await img.decode();
  } catch {
    /* a broken image still opens, at a guessed size */
  } finally {
    signal.removeEventListener("abort", stop);
  }
  return { width: img.naturalWidth || 1600, height: img.naturalHeight || 1000 };
}

/** A toolbar icon in PhotoSwipe's 32px button, drawn as a line icon like bb's own. */
const ICON = (path: string) => `<svg aria-hidden="true" class="pswp__icn pswp__popout-icn" viewBox="0 0 32 32" width="32" height="32"><path d="${path}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** Opens the viewer; false when its card went away first, and nothing opened. */
export async function openViewer(o: ViewerOptions): Promise<boolean> {
  if (o.signal.aborted) return false;
  const { width, height } = await sizeOf(o.src, o.thumb, o.signal);
  if (o.signal.aborted) return false;
  // the host page's portal attributes, as every overlay of this plugin carries (ui/utils.ts PORTAL)
  const host = document.createElement("div");
  for (const [k, v] of Object.entries(PORTAL)) host.setAttribute(k, v);
  host.setAttribute("data-popout-viewer", "");
  document.body.appendChild(host);
  const pswp = new PhotoSwipe({
    dataSource: [{ src: o.src, width, height, alt: o.caption }],
    appendToEl: host,
    bgOpacity: 0.92,
    showHideAnimationType: "fade",
    wheelToZoom: true,
    // a tap on a touch screen would hide the controls, Close with them; keep them up (double-tap still zooms)
    tapAction: false,
    // double-tap or click zooms to 2.5x the fitted size (at least the real pixels, at most 4x them)
    secondaryZoomLevel: (z) => Math.min(Math.max(z.fit * 2.5, 1), 4),
    maxZoomLevel: (z) => Math.max(z.fit * 4, 4),
    counter: false,
    arrowPrev: false,
    arrowNext: false,
    closeTitle: "Close (Esc)",
    zoomTitle: "Zoom",
    errorMsg: "The image couldn't be loaded.",
  });
  pswp.on("uiRegister", () => {
    pswp.ui?.registerElement({
      name: "popout-caption",
      order: 9,
      isButton: false,
      appendTo: "root",
      onInit: (el) => {
        el.className = "pswp__popout-caption";
        el.textContent = o.caption;
        el.setAttribute("data-popout-caption", "");
      },
    });
    if (o.sidePanel)
      pswp.ui?.registerElement({
        name: "popout-side-panel",
        title: "Open in side panel",
        ariaLabel: "Open in side panel",
        order: 8,
        isButton: true,
        html: ICON("M8 8h16v16H8zM18 8v16"),
        onInit: (el) => el.setAttribute("data-popout-side", ""),
        onClick: () => {
          if (o.sidePanel?.()) pswp.close();
          else window.open(o.src, "_blank", "noopener,noreferrer");
        },
      });
    pswp.ui?.registerElement({
      name: "popout-new-tab",
      title: "Open in new tab",
      ariaLabel: "Open in new tab",
      order: 8,
      isButton: true,
      html: ICON("M14 9H9v14h14v-5M17 9h6v6M23 9l-9 9"),
      onInit: (el) => el.setAttribute("data-popout-tab", ""),
      onClick: () => void window.open(o.src, "_blank", "noopener,noreferrer"),
    });
  });
  pswp.on("afterInit", () => {
    pswp.element?.setAttribute("aria-label", o.caption || "Image");
    pswp.element?.setAttribute("data-popout-dialog", "");
  });
  // its card unmounted: take it down at once, with no closing animation, while opening too (viewer-lifetime.ts); the
  // host goes when PhotoSwipe's destroy runs, below
  const gone = () => takeDown(pswp, host);
  o.signal.addEventListener("abort", gone, { once: true });
  pswp.on("destroy", () => {
    o.signal.removeEventListener("abort", gone);
    host.remove();
    o.onClosed();
  });
  pswp.init();
  return true;
}
