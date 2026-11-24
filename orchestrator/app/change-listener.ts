// A screen's change-notice listener, paused while the page is in the background (lag fix, 2026-11-24). A hidden page
// (another bb tab, a minimised window, a phone's app in the background) refetched on every notice like a visible one,
// so each open client cost the server its reads. While hidden, the notices are only gathered; when the page is shown
// again the listener gets them once, as one notice (change-notice.ts mergeNotices). The rail badge's reads are the
// exception (whileHidden): the owner watches that badge from bb's other pages.
import { useCallback, useEffect, useRef } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { CHANGED_CHANNEL } from "../contract.ts";
import { mergeNotices } from "../change-notice.ts";

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * `onNotice` for each change notice while the page is shown; the ones that came while it was hidden, once, when it is
 * shown. `whileHidden`: every notice at once, hidden or not.
 */
export function useChangeNotice(onNotice: (notice: unknown) => void, opts: { whileHidden?: boolean } = {}): void {
  const live = opts.whileHidden === true;
  const latest = useRef(onNotice);
  latest.current = onNotice;
  const missed = useRef<{ notice: unknown } | null>(null);
  useRealtime(
    CHANGED_CHANNEL,
    useCallback((n: unknown) => {
      if (!live && hidden()) missed.current = { notice: missed.current ? mergeNotices(missed.current.notice, n) : n };
      else latest.current(n);
    }, [live]),
  );
  useEffect(() => {
    if (live || typeof document === "undefined") return;
    const back = () => {
      if (hidden() || !missed.current) return;
      const { notice } = missed.current;
      missed.current = null;
      latest.current(notice);
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [live]);
}
