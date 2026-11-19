// The Open PRs tab's server side. GitHub is read only through the plugin's host entry (open-prs/host.ts: the machine's own
// gh login, read-only gh commands), and no more often than the board's PR checks (prPollMinutes): the page's read answers from
// what was fetched and starts a new fetch only once that is older than the poll interval. Nothing runs while nobody looks.
//
// Kept in plugin storage (kv): each PR's summary and changed files, by its head sha, so neither is read or recomputed until
// the head changes. CODEOWNERS and a repo's recent reviewers are kept in memory for six hours.
// Fast first paint (2026-11-17): the last good read is kept in kv too (core's KeptSnapshot), loaded once at start and
// served at once, marked with when it was checked, while a new read runs; the read never waits on GitHub.
// Post (2026-11-17): with a Slack token, openPrsPrepare finds the channel and the mentions and keeps the exact message
// under the page's key; post(key) sends that message once (open-prs/slack.ts). The token stays here.
// Review states and "since your last copy" (2026-11-18, from a contributor's public PR #4): each PR's state is judged at
// refresh (core's reviewState) and kept in the snapshot; each section's baseline is kept in kv (open-prs/copies.ts) and
// moves only after a successful copy (copied) or post. A baseline PR that left the open list is looked up once a
// refresh (the PR-wait read, at most 20), so the page says merged or closed only when GitHub does.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  LOGIN_RE,
  approvalWords,
  dueToFetch,
  candidatesFor,
  channelOf,
  keptCands,
  mentionHandles,
  parseKept,
  sayCands,
  slackPost,
  ciOf,
  fullyApproved,
  mergeWords,
  needsReview,
  parseExcluded,
  parseHandleMap,
  pruneCache,
  reviewState,
  reviewWords,
  summaryFor,
  tag,
  type BbPrReading,
  type KeptPr,
  type KeptSnapshot,
  type RawPr,
  type RepoArea,
  type SummaryCache,
} from "../core/open-prs.ts";
import type { Engine } from "../core/engine.ts";
import type { Agent } from "../core/model.ts";
import { redact } from "../cloud/core/mask.ts";
import { OPEN_PRS_CHANNEL, openPrsContract, type OpenPrsPosted, type OpenPrsView } from "./contract.ts";
import { SlackError, slackPoster, type SlackFetch } from "./slack.ts";
import { copyStore } from "./copies.ts";
import { departedUrls, type CopiedPr, type Departed, type Section } from "../core/open-prs-copies.ts";
import { orchHostContract } from "../host-contract.ts";

export interface OpenPrsSettings {
  githubLogin: string;
  reviewChannel: string;
  reviewExcludedProjects: string;
  slackHandleMap: string;
  prPollMinutes: number;
  slackToken?: string | undefined; // secret: read here only, never sent to the page
}

/** How long a prepared message and a post's outcome are kept (a resend with the same key within it never posts again). */
const POST_KEEP_MS = 3600_000;

const SUMMARIES = "openPrs.summaries.v1";
const FILES = "openPrs.files.v1";
const KEPT = "openPrs.snapshot.v1";
const AREA_MS = 6 * 3600_000;
const BRANCH_MS = 3600_000;
const MAX_FILE_READS = 30; // per refresh: a first look at many PRs spreads over a few polls
// the list is a search and then one `gh pr view` per PR (4 at a time): more than the host call's 30 s default for many PRs
const OPEN_PRS_TIMEOUT_MS = 5 * 60_000;

type Files = Record<string, { sha: string; files: string[] }>;

export function registerOpenPrs(bb: BbPluginApi, engine: Engine, settings: () => OpenPrsSettings, fetchImpl: SlackFetch = fetch as unknown as SlackFetch) {
  const host = bb.hosts.experimental_client({ contract: orchHostContract });
  let snap: KeptSnapshot | null = null;
  // the kept snapshot, read once: the first page read waits for this (a local read), never for GitHub
  let kept: Promise<unknown> | null = null;
  const keptSnapshot = () => (kept ??= bb.storage.kv.get<unknown>(KEPT).catch(() => null));
  let error: string | null = null;
  let running: Promise<void> | null = null;
  let attempt: { login: string; at: number } | null = null; // the last read started, failed or not
  let preferred: string | null = null; // the machine whose gh answered last
  const areas = new Map<string, { at: number; area: RepoArea }>();
  const copies = copyStore(bb.storage.kv);
  let departed: { login: string; states: Departed } = { login: "", states: {} };
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
    const { prs, more } = await onHost((hostId) => host.call("prs.open", { login }, { hostId, timeoutMs: OPEN_PRS_TIMEOUT_MS }));
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
    // changed files and repo areas: only for the PRs that need review, or a first review or a re-review
    const asks = (p: RawPr) => needsReview(p) || reviewState(p).state === "first" || reviewState(p).state === "rereview";
    const wanted = withAgents.filter(asks);
    const files = pruneCache((await bb.storage.kv.get<Files>(FILES)) ?? {}, wanted.map((p) => p.url));
    let reads = 0;
    for (const p of wanted) {
      if (files[p.url]?.sha === p.sha || reads >= MAX_FILE_READS) continue;
      reads++;
      const f = await onHost((hostId) => host.call("prs.files", { url: p.url }, { hostId })).catch((e: unknown) => {
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
    const shown: KeptPr[] = withAgents.map(({ body: _b, branch: _br, author: _a, reviews: _r, requested: _q, agent, ...p }) => {
      const raw = withAgents.find((x) => x.url === p.url)!;
      const cands = asks(raw) ? keptCands(candidatesFor(files[p.url]?.files ?? [], areas.get(p.repo)?.area ?? null, login, {})) : [];
      return { ...p, agent: agent ? { address: agent.address, role: agent.role, project: agent.project } : null, cands, queue: reviewState(raw, cands.map((c) => c.name)) };
    });
    snap = { v: 1, login, at: now, more, prs: shown };
    // baseline PRs no longer open: merged, closed, or still open but missed by the search. A failed read is unconfirmed.
    const states: Departed = {};
    for (const url of departedUrls(await copies.read(login), prs.map((p) => p.url))) {
      const r = await readWait(url).catch(() => null);
      if (r?.outcome === "available") states[url] = r.pullRequest.state === "merged" ? "MERGED" : r.pullRequest.state === "closed" ? "CLOSED" : "OPEN";
    }
    departed = { login, states };
    await bb.storage.kv.set(KEPT, snap).catch((e: unknown) => bb.log.warn(`open-prs: keeping the snapshot: ${redact(String(e))}`));
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

  /**
   * One PR wait's own reading (gh pr view on a connected machine), for a PR no live environment's bb reading covers.
   * Throws when no machine answers: the caller then writes nothing and closes nothing.
   */
  const readWait = (url: string, signal?: AbortSignal): Promise<BbPrReading> => onHost((hostId) => host.call("prs.wait", { url }, { hostId, ...(signal ? { signal } : {}) }));
  const readPathways = (url: string): Promise<BbPrReading> => onHost((hostId) => host.call("prs.pathways", { url }, { hostId }));

  // ---------------------------------------------------------------- Post (Slack)
  const poster = slackPoster(fetchImpl);
  const token = () => (settings().slackToken ?? "").trim();
  const prepared = new Map<string, { at: number; channel: { id: string; name: string }; posted: string; copied: { login: string; section: Section; prs: CopiedPr[] } | null }>();
  const sends = new Map<string, { at: number; result: Promise<OpenPrsPosted> }>();
  const prune = () => {
    const old = Date.now() - POST_KEEP_MS;
    for (const m of [prepared, sends] as Map<string, { at: number }>[]) for (const [k, v] of m) if (v.at < old) m.delete(k);
  };

  /** The confirm's write: the message prepared under this key, posted once. A second call with the key gets the first's outcome. */
  function post(key: string): Promise<OpenPrsPosted> {
    prune();
    const had = sends.get(key);
    if (had) return had.result;
    const p = prepared.get(key);
    if (!p) return Promise.reject(new Error("Nothing is ready to post under this preview: open Post again."));
    const t = token();
    if (!t) return Promise.reject(new Error("No Slack token: set slackToken to post."));
    const result = poster.post(t, p.channel, p.posted).then(
      async (r) => {
        // posted: this section's baseline becomes what the message held (a failed or unanswered post never moves it)
        if (p.copied) await remember(p.copied.login, p.copied.section, p.copied.prs).catch((e: unknown) => bb.log.warn(`open-prs: keeping the post as the last copy: ${redact(String(e))}`));
        return { channel: p.channel.name, permalink: r.permalink };
      },
      (e: unknown) => {
        // Slack said no: nothing went out, so the same preview may try again. No answer: it may have gone out, so never again.
        if (!(e instanceof SlackError && e.maybe)) sends.delete(key);
        bb.log.warn(`open-prs: post: ${redact(e instanceof Error ? e.message : String(e))}`);
        throw e instanceof SlackError && e.maybe ? new Error(`Slack didn't answer, so it may have posted. Look in ${p.channel.name} before posting again.`) : e;
      },
    );
    sends.set(key, { at: Date.now(), result }); // before any await: a second click finds it
    return result;
  }

  bb.rpc.register(openPrsContract, {
    openPrs: async (): Promise<OpenPrsView> => {
      const s = settings();
      const login = s.githubLogin.trim().replace(/^@/, "");
      const handles = parseHandleMap(s.slackHandleMap);
      const channel = channelOf(s.reviewChannel);
      const notes = [
        ...(handles.error ? [`${handles.error}: no one is tagged until it is fixed.`] : []),
        ...(s.reviewChannel.trim() && !channel ? ["reviewChannel is neither a channel name nor an https link."] : []),
      ];
      const excludedList = parseExcluded(s.reviewExcludedProjects);
      const copied = LOGIN_RE.test(login) ? await copies.read(login) : {};
      const gone = departed.login === login ? departed.states : {};
      const base = { login, notes, pollMinutes: s.prPollMinutes, channel, excluded: excludedList, canPost: !!token(), more: false, fetchedAt: null, error: null, checking: false, prs: [], copied, departed: gone };
      if (!login) return { ...base, state: "unset" };
      if (!LOGIN_RE.test(login)) return { ...base, state: "error", error: "githubLogin is not a GitHub login." };
      if (!snap || snap.login !== login) snap = parseKept(await keptSnapshot(), login) ?? snap;
      const mine = snap && snap.login === login ? snap : null;
      const pollMs = Math.max(0, s.prPollMinutes) * 60_000;
      const last = attempt?.login === login ? attempt.at : null;
      if (dueToFetch({ hasSnapshot: !!mine, lastAttempt: last, now: Date.now(), pollMs })) kick(login);
      const err = attempt?.login === login ? error : null; // another login's failure isn't this one's
      const checking = running !== null;
      if (!mine) return { ...base, state: err ? "error" : "loading", error: err, checking };
      const excluded = new Set(excludedList);
      const leadOf = (project: string | null) => (project ? (engine.agents().find((a) => a.role === "lead" && a.project === project)?.address ?? null) : null);
      return {
        ...base,
        state: "ok",
        error: err,
        checking,
        fetchedAt: mine.at,
        more: mine.more,
        prs: mine.prs.map((p) => {
          const project = p.agent?.project ?? null;
          const needs = needsReview(p);
          const state = p.queue?.state ?? null;
          return {
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
            candidates: needs || state === "first" || state === "rereview" ? sayCands(p.cands, handles.map) : [],
            sha: p.sha ?? "",
            state,
            stateWho: (p.queue?.who ?? []).map((name) => ({ name, say: tag(name, handles.map), owner: true, recent: 0 })),
          };
        }),
      };
    },
    /** Post's second step, a read: the channel, the mentions, and the exact message, kept under the page's key. */
    openPrsPrepare: async ({ key, text, copied: held }) => {
      prune();
      const t = token();
      if (!t) throw new Error("No Slack token: set slackToken to post, or use Copy.");
      if (sends.has(key)) throw new Error("This preview was already posted. Open Post again for a new message.");
      const channel = await poster.channel(t, settings().reviewChannel);
      const { ids, note } = await poster.mentions(t, mentionHandles(text));
      const m = slackPost(text, ids);
      const login = settings().githubLogin.trim().replace(/^@/, "");
      prepared.set(key, { at: Date.now(), channel, posted: m.posted, copied: held && LOGIN_RE.test(login) ? { login, ...held } : null });
      const notes = note ? [note] : m.unresolved.length ? [`Not found in Slack: ${m.unresolved.map((h) => `@${h}`).join(", ")}, so named in plain words.`] : [];
      return { channel: channel.name, shown: m.shown, notes };
    },
  });
  /** A baseline write, then the page hears it. */
  const remember = async (login: string, section: Section, prs: CopiedPr[]) => {
    const h = await copies.remember(login, section, prs);
    bb.realtime.publish(OPEN_PRS_CHANNEL, {});
    return h;
  };
  /** A successful Copy's write (OPEN_PRS_COPIED): the section's baseline becomes exactly the copied PRs. */
  const copied = async ({ section, prs }: { section: Section; prs: CopiedPr[] }) => {
    const login = settings().githubLogin.trim().replace(/^@/, "");
    if (!LOGIN_RE.test(login)) throw new Error("githubLogin is not set, so there is nothing to keep the copy under.");
    await remember(login, section, prs);
    return null;
  };
  return { readWait, readPathways, post, copied };
}
