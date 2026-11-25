import { z } from "zod";
import type { BoardColumn, WorkBoard } from "../contract.ts";
import type { Db } from "./db.ts";
import { LOGIN_RE } from "./open-prs.ts";
import { readBoard } from "./work-board.ts";

export type SinceChoice = { kind: "24h" } | { kind: "weekday" } | { kind: "looked" } | { kind: "at"; at: number };
export const SINCE_MAX_MS = 14 * 86_400_000;
export const SINCE_STEP_MS = 15 * 60_000;
export const WEEKDAY = { day: 5, hour: 18, label: "Fri 18:00" } as const;

export function lastWeekday(now: number): number {
  const d = new Date(now);
  d.setHours(WEEKDAY.hour, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - WEEKDAY.day + 7) % 7));
  if (d.getTime() >= now) d.setDate(d.getDate() - 7);
  return d.getTime();
}

export function sinceOf(c: SinceChoice, now: number, looked: number | null): number {
  const day = Math.floor(now / SINCE_STEP_MS) * SINCE_STEP_MS - 86_400_000;
  if (c.kind === "weekday") return lastWeekday(now);
  if (c.kind === "looked") return looked && looked > 0 ? looked : day;
  if (c.kind === "at") return Math.min(now, Math.max(now - SINCE_MAX_MS, c.at));
  return day;
}

export function typedSince(value: string, now: number): number | null {
  const at = new Date(value).getTime();
  return Number.isFinite(at) && at >= now - SINCE_MAX_MS && at <= now ? at : null;
}

export function parseChoice(raw: unknown): SinceChoice {
  const c = raw as { kind?: unknown; at?: unknown } | null;
  if (c && (c.kind === "24h" || c.kind === "weekday" || c.kind === "looked")) return { kind: c.kind };
  if (c && c.kind === "at" && typeof c.at === "number" && Number.isFinite(c.at)) return { kind: "at", at: c.at };
  return { kind: "weekday" };
}

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const SINCE_GH_LIMIT = 200;

export const sinceGhArgs = {
  merged(repo: string, day: string): string[] {
    if (!REPO.test(repo)) throw new Error(`not a repo: ${JSON.stringify(repo)}`);
    if (!DAY.test(day)) throw new Error(`not a day: ${JSON.stringify(day)}`);
    return ["pr", "list", "--repo", repo, "--state", "merged", "--search", `merged:>=${day}`, "--limit", String(SINCE_GH_LIMIT), "--json", "number,url,title,mergedAt,author"];
  },
  login(): string[] {
    return ["api", "user", "--jq", ".login"];
  },
  releases(repo: string): string[] {
    if (!REPO.test(repo)) throw new Error(`not a repo: ${JSON.stringify(repo)}`);
    return ["release", "list", "--repo", repo, "--limit", "30", "--json", "tagName,name,publishedAt,isDraft"];
  },
};

const mergeSchema = z.object({ url: z.string(), number: z.number(), title: z.string(), mergedAt: z.number(), author: z.string().nullable() });
const releaseSchema = z.object({ tag: z.string(), name: z.string(), at: z.number(), url: z.string() });
export type GhMerge = z.infer<typeof mergeSchema>;
export type GhRelease = z.infer<typeof releaseSchema>;

export function parseMerged(raw: unknown): GhMerge[] {
  if (!Array.isArray(raw)) throw new Error("gh pr list: not a list");
  const out: GhMerge[] = [];
  for (const r of raw as { url?: unknown; number?: unknown; title?: unknown; mergedAt?: unknown; author?: { login?: unknown } | null }[]) {
    const at = typeof r.mergedAt === "string" ? Date.parse(r.mergedAt) : NaN;
    if (typeof r.url !== "string" || typeof r.number !== "number" || !Number.isFinite(at)) continue;
    out.push({ url: r.url.replace(/\/+$/, ""), number: r.number, title: typeof r.title === "string" ? r.title : "", mergedAt: at, author: typeof r.author?.login === "string" ? r.author.login : null });
  }
  return out;
}

export function parseReleases(raw: unknown, repo: string): GhRelease[] {
  if (!Array.isArray(raw)) throw new Error("gh release list: not a list");
  const out: GhRelease[] = [];
  for (const r of raw as { tagName?: unknown; name?: unknown; publishedAt?: unknown; isDraft?: unknown }[]) {
    const at = typeof r.publishedAt === "string" ? Date.parse(r.publishedAt) : NaN;
    if (typeof r.tagName !== "string" || r.isDraft === true || !Number.isFinite(at)) continue;
    out.push({ tag: r.tagName, name: typeof r.name === "string" && r.name ? r.name : r.tagName, at, url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(r.tagName)}` });
  }
  return out;
}

export function parseLogin(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  return LOGIN_RE.test(s) ? s : null;
}

export const sinceHostDefs = {
  "board.repoActivity": {
    input: z.object({ repo: z.string().regex(REPO), day: z.string().regex(DAY) }).strict(),
    output: z.object({ merged: z.array(mergeSchema), releases: z.array(releaseSchema) }),
    experimental_retryable: true,
  },
  "board.ghLogin": {
    input: z.object({}).strict(),
    output: z.object({ login: z.string().regex(LOGIN_RE) }),
    experimental_retryable: true,
  },
} as const;

export type MergeWhose = { by: "setting" | "gh"; login: string } | { by: "tasked"; login: null };
export function whoseMerges(setting: string, ghLogin: string | null | undefined): MergeWhose {
  const s = setting.trim().replace(/^@/, "");
  if (LOGIN_RE.test(s)) return { by: "setting", login: s };
  if (ghLogin && LOGIN_RE.test(ghLogin)) return { by: "gh", login: ghLogin };
  return { by: "tasked", login: null };
}

export const SINCE_REPO_ACTIVE_MS = 30 * 86_400_000;
export const SINCE_POLL_CAP = 50;

export type BoardPr = { url: string; project: string; resolved?: boolean; at?: number };

// a resolved PR counts only as activity at the time its state was seen: one linked after it merged has no PR event
export function boardPrs(board: WorkBoard): BoardPr[] {
  return board.projects.flatMap((p) => [...p.tasks.flatMap((t) => t.prs), ...p.unfiled.prs].map((x) => ({ url: x.url, project: p.slug, resolved: x.state !== null && /^(merged|closed)$/i.test(x.state), at: x.at })));
}

const repoOf = (url: string) => /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/pull\/\d+/.exec(url)?.[1] ?? null;

export function sinceRepos(db: Db, now: number, onBoard: BoardPr[]): Map<string, string[]> {
  const seen = new Map<string, { last: number; projects: Set<string> }>();
  for (const r of db.prepare(`SELECT ref, project, MAX(at) AS at FROM events WHERE kind = 'pr' AND ref IS NOT NULL GROUP BY ref, project`).all() as { ref: string; project: string | null; at: number }[]) {
    const repo = repoOf(r.ref);
    if (!repo) continue;
    const e = seen.get(repo) ?? { last: 0, projects: new Set<string>() };
    if (r.project) e.projects.add(r.project);
    e.last = Math.max(e.last, r.at);
    seen.set(repo, e);
  }
  const out = new Map<string, Set<string>>();
  for (const [repo, e] of seen) if (e.last >= now - SINCE_REPO_ACTIVE_MS) out.set(repo, e.projects);
  for (const p of onBoard) {
    if (p.resolved && !((p.at ?? 0) >= now - SINCE_REPO_ACTIVE_MS)) continue;
    const repo = repoOf(p.url);
    if (repo) out.set(repo, (out.get(repo) ?? seen.get(repo)?.projects ?? new Set<string>()).add(p.project));
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort()]));
}

export interface SinceCache {
  at: number | null;
  ghLogin?: string | null;
  repos: Record<string, { at: number; tried?: number; projects: string[]; merged: GhMerge[]; releases: GhRelease[]; error: string | null }>;
  pending?: string[];
}
export const emptyCache = (): SinceCache => ({ at: null, repos: {} });

export function sincePoll(repos: Map<string, string[]>, prev: SinceCache): string[] {
  const tried = (r: string) => prev.repos[r]?.tried ?? prev.repos[r]?.at ?? 0;
  return [...repos.keys()].sort((a, b) => tried(a) - tried(b) || a.localeCompare(b)).slice(0, SINCE_POLL_CAP);
}

export type RepoRead = { merged: GhMerge[]; releases: GhRelease[] } | { error: string };

export function sinceKeep(prev: SinceCache, repos: Map<string, string[]>, reads: Map<string, RepoRead>, now: number): Pick<SinceCache, "repos" | "pending"> {
  const from = now - SINCE_MAX_MS;
  type Entry = SinceCache["repos"][string];
  const inWindow = (e: Entry): Entry => ({ ...e, merged: e.merged.filter((m) => m.mergedAt >= from), releases: e.releases.filter((x) => x.at >= from) });
  const out: SinceCache["repos"] = {};
  for (const [repo, old] of Object.entries(prev.repos)) {
    if (repos.has(repo)) continue;
    const e = inWindow(old);
    if (e.merged.length || e.releases.length) out[repo] = e;
  }
  const pending: string[] = [];
  for (const [repo, projects] of repos) {
    const old = prev.repos[repo];
    const r = reads.get(repo);
    const last: Entry = { at: old?.at ?? 0, tried: old?.tried ?? old?.at ?? 0, projects, merged: old?.merged ?? [], releases: old?.releases ?? [], error: old?.error ?? null };
    if (!r) pending.push(repo);
    out[repo] = inWindow(!r ? last : "error" in r ? { ...last, tried: now, error: r.error } : { at: now, tried: now, projects, merged: r.merged, releases: r.releases, error: null });
  }
  return { repos: out, pending };
}

export interface SinceMove {
  from: BoardColumn | "dropped" | null;
  to: BoardColumn | "dropped";
  at: number;
  isNew: boolean;
}
export const SINCE_PICKS = ["shipped", "new", "waiting", "blocked", "merged"] as const;
export type SincePick = (typeof SINCE_PICKS)[number];
export interface SinceStrip {
  since: number;
  now: number;
  looked: number | null;
  counts: { shipped: number; new: number; waiting: number; blocked: number; dropped: number };
  moved: Record<string, SinceMove>;
  merged: number;
  releases: GhRelease[];
  approved: number;
  whose: MergeWhose;
  picks: Record<SincePick, string[]>;
  dropped: { id: string; title: string; project: string }[];
  noTask: { url: string; number: number | null; title: string; mergedAt: number }[];
  github: { at: number | null; repos: number; errors: string[]; pending: number };
}

type MoveRow = { task: string; project: string; from_col: string | null; to_col: string; at: number; why: string | null; seq: number };

const countsAsDrop = (r: MoveRow) => r.why === "dropped with attachments";
const isMove = (r: MoveRow) => r.from_col !== r.to_col;

export function countMoves(rows: MoveRow[], since: number): Pick<SinceStrip, "counts" | "moved"> & { ids: Record<keyof SinceStrip["counts"], string[]> } {
  const byTask = new Map<string, MoveRow[]>();
  for (const r of [...rows].filter(isMove).sort((a, b) => a.seq - b.seq)) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r]);
  const ids: Record<keyof SinceStrip["counts"], string[]> = { shipped: [], new: [], waiting: [], blocked: [], dropped: [] };
  const moved: Record<string, SinceMove> = {};
  for (const [task, all] of byTask) {
    const inWin = all.filter((r) => r.at >= since);
    if (!inWin.length) continue;
    const first = inWin[0]!;
    const last = inWin.at(-1)!;
    const isNew = inWin.some((r) => r.from_col === null);
    moved[task] = { from: first.from_col as SinceMove["from"], to: last.to_col as SinceMove["to"], at: last.at, isNew };
    if (inWin.some((r) => r.to_col === "dropped" && countsAsDrop(r))) ids.dropped.push(task);
    if (all.at(-1)!.to_col === "dropped") continue;
    if (inWin.some((r) => r.to_col === "shipped")) ids.shipped.push(task);
    if (inWin.some((r) => r.to_col === "blocked")) ids.blocked.push(task);
    if (isNew) ids.new.push(task);
    if (all.at(-1) === last && last.to_col === "waiting") ids.waiting.push(task);
  }
  const counts = { shipped: ids.shipped.length, new: ids.new.length, waiting: ids.waiting.length, blocked: ids.blocked.length, dropped: ids.dropped.length };
  return { counts, moved, ids };
}

export function taskedPrs(db: Db, project: string | null): Set<string> {
  const rows = db.prepare(`SELECT p.url FROM task_prs p JOIN tasks t ON t.id = p.task WHERE t.state <> 'dropped' AND (? IS NULL OR p.project = ?)`).all(project, project) as { url: string }[];
  return new Set(rows.map((r) => r.url));
}

export function countApprovals(db: Db, since: number, project: string | null): number {
  let n = 0;
  for (const r of db.prepare(`SELECT project, json FROM deliverables WHERE updated_at >= ?`).all(since) as { project: string | null; json: string }[]) {
    if (project && r.project !== project) continue;
    try {
      for (const f of (JSON.parse(r.json) as { feedback?: { outcome?: string; at?: string }[] }).feedback ?? []) if (f.outcome === "approved" && Date.parse(f.at ?? "") >= since) n++;
    } catch {
    }
  }
  return n;
}

export function sinceStrip(db: Db, o: { since: number; now: number; looked: number | null; project: string | null; cache: SinceCache; attached: Set<string>; whose: MergeWhose }): SinceStrip {
  const rows = (o.project ? db.prepare(`SELECT * FROM task_moves WHERE project = ?`).all(o.project) : db.prepare(`SELECT * FROM task_moves`).all()) as MoveRow[];
  const { moved, ids } = countMoves(rows, o.since);
  const shown = new Set(readBoard(db, o.now, { since: o.since, project: o.project }).projects.flatMap((p) => p.tasks.map((t) => t.id)));
  for (const k of ["shipped", "new", "waiting", "blocked"] as const) ids[k] = ids[k].filter((id) => shown.has(id));
  const counts = { shipped: ids.shipped.length, new: ids.new.length, waiting: ids.waiting.length, blocked: ids.blocked.length, dropped: ids.dropped.length };
  const inProject = (projects: string[]) => !o.project || projects.includes(o.project);
  const merges = new Map<string, { url: string; number: number | null; title: string; mergedAt: number; author: string | null }>();
  const releases: GhRelease[] = [];
  const errors: string[] = [];
  let repos = 0;
  let pending = 0;
  const waiting = new Set(o.cache.pending ?? []);
  for (const [repo, r] of Object.entries(o.cache.repos)) {
    if (!inProject(r.projects)) continue;
    repos++;
    if (waiting.has(repo)) pending++;
    if (r.error) errors.push(`${repo}: ${r.error}`);
    for (const m of r.merged) if (m.mergedAt >= o.since) merges.set(m.url, m);
    for (const x of r.releases) if (x.at >= o.since) releases.push(x);
  }
  for (const r of db.prepare(`SELECT ref, note, project, MIN(at) AS at FROM events WHERE kind = 'pr' AND value = 'merged' AND ref IS NOT NULL GROUP BY ref`).all() as { ref: string; note: string | null; project: string | null; at: number }[]) {
    const url = r.ref.replace(/\/+$/, "");
    if (r.at < o.since || merges.has(url) || (o.project && r.project !== o.project)) continue;
    merges.set(url, { url, number: r.note ? Number(r.note) || null : null, title: "", mergedAt: r.at, author: null });
  }
  const login = o.whose.login?.toLowerCase() ?? null;
  const counted = [...merges.values()].filter((m) => o.attached.has(m.url) || (login !== null && m.author !== null && m.author.toLowerCase() === login));
  const holders = new Set<string>();
  const countedUrls = new Set(counted.map((m) => m.url));
  for (const l of db.prepare(`SELECT p.task, p.url FROM task_prs p JOIN tasks t ON t.id = p.task WHERE t.state <> 'dropped' AND (? IS NULL OR p.project = ?)`).all(o.project, o.project) as { task: string; url: string }[])
    if (countedUrls.has(l.url) && shown.has(l.task)) holders.add(l.task);
  const titled = db.prepare(`SELECT id, title, project FROM tasks WHERE id = ?`);
  const dropped = ids.dropped
    .map((id) => titled.get(id) as { id: string; title: string; project: string } | undefined)
    .filter((t) => t !== undefined)
    .map(({ id, title, project }) => ({ id, title, project }))
    .sort((a, b) => a.title.localeCompare(b.title));
  const noTask = counted
    .filter((m) => !o.attached.has(m.url))
    .sort((a, b) => b.mergedAt - a.mergedAt)
    .map(({ url, number, title, mergedAt }) => ({ url, number, title, mergedAt }));
  return {
    since: o.since,
    now: o.now,
    looked: o.looked,
    counts,
    moved,
    merged: counted.length,
    releases: releases.sort((a, b) => b.at - a.at),
    approved: countApprovals(db, o.since, o.project),
    whose: o.whose,
    picks: { shipped: ids.shipped, new: ids.new, waiting: ids.waiting, blocked: ids.blocked, merged: [...holders] },
    dropped,
    noTask,
    github: { at: o.cache.at, repos, errors, pending },
  };
}

export function fileThemText(noTask: SinceStrip["noTask"], since: number): string {
  const when = new Date(since).toISOString().slice(0, 16).replace("T", " ");
  return [`Merged since ${when} UTC with no task on the work board. Please file each one on its task, with the tidy tool:`, ...noTask.map((m) => `- ${m.url}${m.title ? ` ${m.title}` : ""}`)].join("\n");
}
