import type { BoardSince as Strip } from "../contract.ts";
import type { SincePick } from "../core/since.ts";

export type Pill = { key: SincePick | "dropped" | "releases" | "noTask"; n: number; text: string; does: "filter" | "list"; title: string };

export function pillsOf(d: Strip, when: string, shown: ReadonlySet<string> | null = null): Pill[] {
  const tasks = (n: number) => (n === 1 ? "task" : "tasks");
  const on = (k: SincePick) => (shown ? d.picks[k].filter((id) => shown.has(id)).length : d.picks[k].length);
  const c = { ...d.counts, shipped: on("shipped"), new: on("new"), waiting: on("waiting"), blocked: on("blocked") };
  const onTasks = on("merged");
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
