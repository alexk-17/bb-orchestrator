// The sidebar's metadata line under each role agent's thread (2026-11-13: "make the sidebar prettier, more
// colors"): a role chip in the role's colour, its Pokémon's name and a lead's
// priority, drawn by app/row-line.tsx; the sprite itself replaces the row's provider icon (useRowIcons). bb draws the line only with the threadRowMetadata experiment on and Organize → Rows → Metadata checked.
// Plain inline styles: the sidebar is outside the app's [data-orch] scope, so the app's CSS doesn't reach it.
import { useCallback, useEffect, useMemo, useRef } from "react";
import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import type { ExperimentalThreadRowMetadataProps } from "@get-bb/plugin-sdk/app";
import { rpcContract, type Agents } from "../contract.ts";
import { touches } from "../change-notice.ts";
import { rowIconCss } from "./faces.ts";
import { sectionCss } from "./accent.ts";
import { RowLine } from "./row-line.tsx";
import { useChangeNotice } from "./change-listener.ts";

type Agent = Agents[number];
export type RowData = Map<string, Agent>;

/** One agents query for the whole sidebar, refreshed when the orchestrator changes. */
export function useRowData(): RowData {
  const q = experimental_useRpcQuery({ contract: rpcContract, method: "agents", input: null });
  const refetch = q.refetch;
  // the agents read asks bb about every agent's thread: at most one refresh per 15 s however busy the orchestrator is
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useChangeNotice(
    useCallback((n: unknown) => {
      if (!touches(n, "agents")) return;
      timer.current ??= setTimeout(() => {
        timer.current = null;
        void refetch();
      }, 15_000);
    }, [refetch]),
  );
  const map = useMemo(() => new Map((q.data ?? []).map((a) => [a.threadId, a])), [q.data]);
  useRowIcons(map);
  return map;
}

/**
 * Requested 2026-11-13: "move the sprites to the claude icons". One stylesheet swaps each role agent's row icon for its
 * picture (faces.ts rowIconCss: its Pokémon, or with a personas pack its person, or the pair), and colours the sections.
 */
function useRowIcons(map: RowData): void {
  useEffect(() => {
    const id = "orch-row-icons";
    const el = (document.getElementById(id) as HTMLStyleElement | null) ?? Object.assign(document.createElement("style"), { id });
    if (!el.isConnected) document.head.appendChild(el);
    el.textContent = rowIconCss(map.values())
      .concat(sectionCss(map.values()))
      .join("\n");
  }, [map]);
  useEffect(() => () => document.getElementById("orch-row-icons")?.remove(), []);
}

export function RowMeta({ thread, data }: ExperimentalThreadRowMetadataProps<RowData>) {
  const a = data?.get(thread.id);
  return a ? <RowLine a={a} /> : null;
}
