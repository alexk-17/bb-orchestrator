// The since header's count pills (2026-11-24, the owner's list: shipped, new, waiting on you, blocked, dropped, PRs merged,
// releases, and the merges on no task as one pill). Pure, so a test reads exactly what the header draws.
import type { BoardSince as Strip } from "../contract.ts";
import type { SincePick } from "../core/since.ts";

/** One count pill: a figure, its words, and what a click does (filter the board, or open a list). */
export type Pill = { key: SincePick | "dropped" | "releases" | "noTask"; n: number; text: string; does: "filter" | "list"; title: string };

/**
 * The pills for a strip, in the owner's order: shipped, new, waiting on you, blocked, dropped, PRs merged, releases,
 * then "PRs on no task", only when there are some. A filter pill names the tasks it shows; a merge pill whose merges no
 * task holds has nothing to show, so it filters nothing (n stays the merges counted).
 */
export function pillsOf(d: Strip, when: string): Pill[] {
  const tasks = (n: number) => (n === 1 ? "task" : "tasks");
  const c = d.counts;
  const onTasks = d.picks.merged.length;
  const pills: Pill[] = [
    { key: "shipped", n: c.shipped, text: "shipped", does: "filter", title: `Show the ${c.shipped} ${tasks(c.shipped)} shipped since ${when}` },
    { key: "new", n: c.new, text: "new", does: "filter", title: `Show the ${c.new} ${tasks(c.new)} added since ${when}` },
    { key: "waiting", n: c.waiting, text: "waiting on you", does: "filter", title: `Show the ${c.waiting} ${tasks(c.waiting)} that now wait on you` },
    { key: "blocked", n: c.blocked, text: "blocked", does: "filter", title: `Show the ${c.blocked} ${tasks(c.blocked)} that became blocked since ${when}` },
    { key: "dropped", n: c.dropped, text: "dropped", does: "list", title: `The ${c.dropped} ${tasks(c.dropped)} dropped with something attached` },
    { key: "merged", n: d.merged, text: d.merged === 1 ? "PR merged" : "PRs merged", does: onTasks ? "filter" : "list", title: `${d.merged} merged since ${when}: ${onTasks} ${tasks(onTasks)} on the board hold ${d.merged - d.noTask.length}, ${d.noTask.length} on no task` },
    { key: "releases", n: d.releases.length, text: d.releases.length === 1 ? "release" : "releases", does: "list", title: `Releases since ${when}` },
  ];
  if (d.noTask.length) pills.push({ key: "noTask", n: d.noTask.length, text: d.noTask.length === 1 ? "PR on no task" : "PRs on no task", does: "list", title: "Merged PRs no task holds" });
  return pills;
}
