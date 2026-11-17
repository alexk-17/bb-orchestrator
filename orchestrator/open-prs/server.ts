// The Open PRs tab's server side. GitHub is read only through the plugin's host entry (open-prs/host.ts: the machine's own
// gh login, read-only queries), and no more often than the board's PR checks (prPollMinutes): the page's read answers from
// what was fetched and starts a new fetch only once that is older than the poll interval. Nothing runs while nobody looks.
//
// Kept in plugin storage (kv): each PR's summary and changed files, by its head sha, so neither is read or recomputed until
// the head changes. CODEOWNERS and a repo's recent reviewers are kept in memory for six hours.
import { mentionsFor, reviewQueue } from "../core/pr-review-queue.ts";
import { readPeopleDirectory } from "./people.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  LOGIN_RE,
  approvalWords,
  dueToFetch,
  candidatesFor,
  channelOf,
  ciOf,
  fullyApproved,
  mergeWords,
  needsReview,
  parseExcluded,
  parseHandleMap,
  pruneCache,
  reviewWords,
  summaryFor,
  type RawPr,
  type RepoArea,
  type SummaryCache,
} from "../core/open-prs.ts";
import type { Engine } from "../core/engine.ts";
import type { Agent } from "../core/model.ts";
import { redact } from "../cloud/core/mask.ts";
import { OPEN_PRS_CHANNEL, openPrsContract, type OpenPrsView } from "./contract.ts";
import { orchHostContract } from "../host-contract.ts";

export interface OpenPrsSettings {
  peopleFilePath?: string;
  githubLogin: string;
  reviewChannel: string;
  reviewExcludedProjects: string;
  slackHandleMap: string;
  prPollMinutes: number;
}

const SUMMARIES = "openPrs.summaries.v1";
const FILES = "openPrs.files.v1";
const AREA_MS = 6 * 3600_000;
const BRANCH_MS = 3600_000;
const MAX_FILE_READS = 30; // per refresh: a first look at many PRs spreads over a few polls

type Files = Record<string, { sha: string; files: string[] }>;
interface Snapshot {
  login: string;
  at: number;
  more: boolean;
  prs: (RawPr & { summary: string; agent: Agent | null })[];
  files: Files;
  areas: Map<string, RepoArea>;
}

export function registerOpenPrs(bb: BbPluginApi, engine: Engine, settings: () => OpenPrsSettings) {
  const host = bb.hosts.experimental_client({ contract: orchHostContract });
  let snap: Snapshot | null = null;
  let error: string | null = null;
  let running: Promise<void> | null = null;
  let attempt: { login: string; at: number } | null = null; // the last read started, failed or not
  let preferred: string | null = null; // the machine whose gh answered last
  const areas = new Map<string, { at: number; area: RepoArea }>();
  const branches = new Map<string, { at: number; branch: string | null }>();

  const hosts = async () =>
    (await bb.sdk.hosts.list()).filter((h) => h.type === "persistent" && h.lifecycle.phase === "active" && h.status === "connected").map((h) => h.id);

  /** One host read: the machine that answered last first, then the others. */
  async function onHost<T>(f: (hostId: string) => Promise<T>): Promise<T> {
    const ids = await hosts();
    const order = preferred && ids.includes(preferred) ? [preferred, ...ids.filter((i) => i !== preferred)] : ids;
    if (order.length === 0) throw new Error("No connected machine to run gh on.");
    let last: unknown = null;
    for (const id of order) {
      try {
        const r = await f(id);
        preferred = id;
        return r;
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }

  /** Each live lead's and thread's branch, from bb (kept an hour): a PR with no pr-watch row maps by its head branch. */
  async function branchAgents(): Promise<Map<string, Agent>> {
    const out = new Map<string, Agent>();
    const now = Date.now();
    for (const a of engine.agents().filter((x) => x.role === "thread" || x.role === "lead")) {
      let b = branches.get(a.threadId);
      if (!b || now - b.at > BRANCH_MS) {
        const t = (await bb.sdk.threads.get({ threadId: a.threadId, include: "environment" } as Parameters<typeof bb.sdk.threads.get>[0]).catch(() => null)) as { environment?: { branchName?: string | null } | null } | null;
        b = { at: now, branch: t?.environment?.branchName ?? null };
        branches.set(a.threadId, b);
      }
      if (b.branch) out.set(b.branch, a);
    }
    return out;
  }

  /** The agent a PR belongs to: the board's pr-watch row for its URL (resolved threads too), else its head branch. */
  const agentOf = (pr: RawPr, byBranch: Map<string, Agent>): Agent | null => {
    const row = engine.prByUrl(pr.url);
    return (row ? engine.agentByThreadEver(row.threadId) : null) ?? byBranch.get(pr.branch) ?? null;
  };

  async function refresh(login: string): Promise<void> {
    const { prs, more } = await onHost((hostId) => host.call("prs.open", { login }, { hostId }));
    // summaries: recomputed only for a new head
    const sums = pruneCache((await bb.storage.kv.get<SummaryCache>(SUMMARIES)) ?? {}, prs.map((p) => p.url));
    let changedSums = false;
    const summed = prs.map((p) => {
      const s = summaryFor(sums, p);
      changedSums ||= s.computed;
      return { ...p, summary: s.summary };
    });
    if (changedSums || Object.keys(sums).length !== prs.length) await bb.storage.kv.set(SUMMARIES, sums);
    const byBranch = await branchAgents();
    const withAgents = summed.map((p) => ({ ...p, agent: agentOf(p, byBranch) }));
    // changed files and repo areas: only for the PRs that need review
    const wanted = withAgents.filter((p) => needsReview(p) || reviewQueue(p).bucket === "needs-review");
    const files = pruneCache((await bb.storage.kv.get<Files>(FILES)) ?? {}, wanted.map((p) => p.url));
    let reads = 0;
    for (const p of wanted) {
      if (files[p.url]?.sha === p.sha || reads >= MAX_FILE_READS) continue;
      reads++;
      const f = await onHost((hostId) => host.call("prs.files", { repo: p.repo, number: p.number }, { hostId })).catch((e: unknown) => {
        bb.log.warn(`open-prs: files of ${p.url}: ${redact(String(e))}`);
        return null;
      });
      if (f) files[p.url] = { sha: f.sha || p.sha, files: f.files };
    }
    await bb.storage.kv.set(FILES, files);
    const now = Date.now();
    for (const repo of new Set(wanted.map((p) => p.repo))) {
      const a = areas.get(repo);
      if (a && now - a.at < AREA_MS) continue;
      const area = await onHost((hostId) => host.call("prs.area", { repo }, { hostId })).catch((e: unknown) => {
        bb.log.warn(`open-prs: area of ${repo}: ${redact(String(e))}`);
        return null;
      });
      if (area) areas.set(repo, { at: now, area });
    }
    snap = { login, at: now, more, prs: withAgents, files, areas: new Map([...areas].map(([k, v]) => [k, v.area])) };
  }

  /** Start a fetch unless one runs; the page hears OPEN_PRS_CHANNEL when it lands. */
  function kick(login: string) {
    if (running) return;
    attempt = { login, at: Date.now() };
    running = refresh(login)
      .then(() => {
        error = null;
      })
      .catch((e: unknown) => {
        error = redact(e instanceof Error ? e.message : String(e));
        bb.log.warn(`open-prs: ${error}`);
      })
      .finally(() => {
        running = null;
        bb.realtime.publish(OPEN_PRS_CHANNEL, {});
      });
  }

  bb.rpc.register(openPrsContract, {
    openPrs: async (): Promise<OpenPrsView> => {
      const s = settings();
      const login = s.githubLogin.trim().replace(/^@/, "");
      const directory = await readPeopleDirectory(s.peopleFilePath ?? "");
      const handles = parseHandleMap(s.slackHandleMap);
      const channel = channelOf(s.reviewChannel);
      const notes = [
        ...(directory.error ? [directory.error] : []),
        ...(handles.error ? [`${handles.error}: no one is tagged until it is fixed.`] : []),
        ...(s.reviewChannel.trim() && !channel ? ["reviewChannel is neither a channel name nor an https link."] : []),
      ];
      const excludedList = parseExcluded(s.reviewExcludedProjects);
      const base = { login, notes, pollMinutes: s.prPollMinutes, channel, excluded: excludedList, more: false, fetchedAt: null, error: null, prs: [] };
      if (!login) return { ...base, state: "unset" };
      if (!LOGIN_RE.test(login)) return { ...base, state: "error", error: "githubLogin is not a GitHub login." };
      const mine = snap && snap.login === login ? snap : null;
      const pollMs = Math.max(0, s.prPollMinutes) * 60_000;
      const last = attempt?.login === login ? attempt.at : null;
      if (dueToFetch({ hasSnapshot: !!mine, lastAttempt: last, now: Date.now(), pollMs })) kick(login);
      const err = attempt?.login === login ? error : null; // another login's failure isn't this one's
      if (!mine) return { ...base, state: err ? "error" : "loading", error: err };
      const incomplete = mine.prs.filter((p) => !p.draft && !p.reviewData?.complete).length;
      if (incomplete) notes.push(`${incomplete} PR(s) have incomplete review history or reviewer requests (limit 100 each); omitted from the PRs sections.`);
      const excluded = new Set(excludedList);
      const leadOf = (project: string | null) => (project ? (engine.agents().find((a) => a.role === "lead" && a.project === project)?.address ?? null) : null);
      return {
        ...base,
        state: "ok",
        error: err,
        fetchedAt: mine.at,
        more: mine.more,
        prs: mine.prs.map((p) => {
          const project = p.agent?.project ?? null;
          const needs = needsReview(p);
          const candidates = candidatesFor(mine.files[p.url]?.sha === p.sha ? mine.files[p.url]!.files : [], mine.areas.get(p.repo) ?? null, login, handles.map);
          const queue = reviewQueue(p, candidates.map((c) => c.name));
          return {
            author: p.reviewData?.author ?? login,
            ...queue,
            mentions: mentionsFor(queue.reviewers, directory.mentions),
            url: p.url,
            number: p.number,
            title: p.title,
            repo: p.repo,
            project,
            lead: p.agent?.role === "lead" ? p.agent.address : leadOf(project),
            agent: p.agent?.address ?? null,
            draft: p.draft,
            review: reviewWords(p),
            approved: fullyApproved(p),
            approvals: approvalWords(p),
            ci: ciOf(p.checks),
            merge: mergeWords(p),
            summary: p.summary,
            needsReview: needs,
            excluded: !!project && excluded.has(project),
            updatedAt: p.updatedAt,
            candidates: needs ? candidates : [],
          };
        }),
      };
    },
  });
}
