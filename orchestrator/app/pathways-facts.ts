import type { Pathways } from "../contract.ts";

type PathwaysMapView = NonNullable<Pathways["map"]>;

/**
 * The facts on a blocked ticket's row in What's next, each once. A Linear task with no estimate already carries
 * "No estimate" in its unknowns (core/pathways.ts), so the row's own estimate check must not say it a second time.
 */
export function blockedFact(ticket: PathwaysMapView["tickets"][number], map: Pick<PathwaysMapView, "external" | "source"> | null | undefined, fact: string): string {
  const parts = [
    ticket.waitsOnYou ? "Waits on you" : "",
    ticket.blockers.length ? `Blocked by ${ticket.blockers.join(", ")}` : "",
    ticket.blockers.some((id) => map?.external.some((item) => item.identifier === id)) ? "External blocker" : "",
    map?.source !== "orchestrator" && ticket.estimate == null ? "No estimate" : "",
    ...ticket.unknown,
    fact,
  ];
  return [...new Set(parts.filter(Boolean))].join(" · ");
}
