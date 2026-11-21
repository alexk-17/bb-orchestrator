// Start here's steps as data (Home first, step 2), so node --test checks them.
import type { Board } from "../contract.ts";

/** Which steps are done, from the agents read: a live CoS, then a lead (a project). The third is Home filling up. */
export function startSteps(agents: Board["agents"] | undefined): { cos: boolean; project: boolean } {
  const live = (agents ?? []).filter((a) => a.status !== "archived");
  return { cos: live.some((a) => a.address === "cos"), project: live.some((a) => a.address.startsWith("lead:")) };
}
