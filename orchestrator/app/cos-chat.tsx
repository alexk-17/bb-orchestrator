// The Chat tab: bb's own chat with the CoS, both sides of every exchange; a tracked-only view dropped the CoS's chat answers.
import { ThreadChat } from "@get-bb/plugin-sdk/app";
import type { Board } from "../contract.ts";
import { EmptyState, Muted } from "./ui.tsx";

export function CosChat({ agents, width }: { agents: Board["agents"] | undefined; width: number }) {
  const cos = agents?.find((a) => a.address === "cos") ?? null;
  if (!agents) return <Muted>Loading…</Muted>;
  if (!cos) return <EmptyState title="No Chief of Staff is running" text="Start it from the Projects tab; its chat shows here." />;
  return <ThreadChat threadId={cos.threadId} variant={width >= 720 ? "full" : "compact"} className="min-h-0 flex-1" />;
}
