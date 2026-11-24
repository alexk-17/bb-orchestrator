// The since-T lens's server side (2026-11-23, SCOPE piece 6; core/since.ts). The page's boardSince read never waits on
// GitHub: a background service reads the repos the board's PRs and recent PR events name, at most 50 a pass in turn
// (merges since 14 days back, and releases)
// through the machine's own gh on a connected host (read-only fixed argument lists), every SINCE_REFRESH_MS, and keeps
// the result in plugin kv and in memory. The read takes that cache as it is. While the githubLogin setting is unset, each
// pass also asks gh which login it is signed in as (whose merges count: core/since.ts whoseMerges); a failed ask keeps
// the last login read, and none is ever made up.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BoardSince } from "./contract.ts";
import type { Db } from "./core/db.ts";
import type { Engine } from "./core/engine.ts";
import { boardPrs, emptyCache, SINCE_MAX_MS, sinceKeep, sinceOf, sincePoll, sinceRepos, sinceStrip, taskedPrs, whoseMerges, type RepoRead, type SinceCache } from "./core/since.ts";
import { orchHostContract } from "./host-contract.ts";
import { redact } from "./cloud/core/mask.ts";

export const SINCE_CHANNEL = "board-since";
export const SINCE_REFRESH_MS = 10 * 60_000;
const KV = "board-since.github";

export function registerBoardSince(bb: BbPluginApi, o: { db: Db; engine: Engine; login: () => string; mark: (job: string) => void; sleep: (ms: number, signal: AbortSignal) => Promise<void> }) {
  const host = bb.hosts.experimental_client({ contract: orchHostContract });
  let cache: SinceCache | null = null;
  let loading: Promise<SinceCache> | null = null;
  const load = () => (loading ??= Promise.resolve().then(() => bb.storage.kv.get<SinceCache>(KV)).then((c) => (cache ??= c && typeof c === "object" && c.repos ? c : emptyCache()), () => (cache ??= emptyCache())));

  const hosts = async () => (await bb.sdk.hosts.list()).filter((h) => h.type === "persistent" && h.lifecycle.phase === "active" && h.status === "connected").map((h) => h.id);

  /** One pass over the repos: each repo read on the first host that answers; a failed repo keeps its last read, with the error. */
  async function refresh(signal: AbortSignal): Promise<void> {
    // the latest cache: load() keeps the one read at start-up, and each pass must build on the pass before
    const prev = cache ?? (await load());
    const ids = await hosts();
    const day = new Date(Date.now() - SINCE_MAX_MS).toISOString().slice(0, 10);
    const next: SinceCache = { at: prev.at, ghLogin: prev.ghLogin ?? null, repos: {} };
    let changed = false;
    if (whoseMerges(o.login(), null).by !== "setting") {
      for (const hostId of ids) {
        try {
          next.ghLogin = (await host.call("board.ghLogin", {}, { hostId })).login;
          break;
        } catch (e) {
          bb.log.warn(`board-since: gh login: ${redact(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
        }
      }
      if (next.ghLogin !== (prev.ghLogin ?? null)) changed = true;
    }
    // the repos to read: the board's PRs (a task's, or an open one in Unfiled) and recent PR events; at most
    // SINCE_POLL_CAP a pass, in turn, and the rest keep their last read (core/since.ts sinceKeep)
    const repos = sinceRepos(o.db, Date.now(), boardPrs(o.engine.workBoard({ since: Date.now() - SINCE_MAX_MS, project: null })));
    const reads = new Map<string, RepoRead>();
    for (const repo of sincePoll(repos, prev)) {
      if (signal.aborted) return;
      let read: RepoRead = { error: "no connected machine to run gh on" };
      for (const hostId of ids) {
        try {
          read = await host.call("board.repoActivity", { repo, day }, { hostId });
          break;
        } catch (e) {
          read = { error: redact(e instanceof Error ? e.message : String(e)).slice(0, 200) };
        }
      }
      reads.set(repo, read);
      if ("error" in read) bb.log.warn(`board-since: ${repo}: ${read.error}`);
    }
    Object.assign(next, sinceKeep(prev, repos, reads, Date.now()));
    // a pass that only re-read the same things changes nothing the page shows
    const shown = (c: SinceCache) => JSON.stringify([c.pending ?? [], Object.entries(c.repos).map(([k, v]) => [k, v.projects, v.merged, v.releases, v.error])]);
    if (shown(next) !== shown(prev)) changed = true;
    next.at = Date.now();
    cache = next;
    await bb.storage.kv.set(KV, next).catch((e: unknown) => bb.log.warn(`board-since: keeping the cache: ${redact(String(e))}`));
    if (changed) bb.realtime.publish(SINCE_CHANNEL, {});
  }

  bb.background.service("board-since", {
    async start(signal) {
      await o.sleep(15_000, signal); // after start-up's own reads
      while (!signal.aborted) {
        try {
          await refresh(signal);
          o.mark("board-since");
        } catch (e) {
          bb.log.warn(`board-since: ${redact(e instanceof Error ? e.message : String(e))}`);
        }
        await o.sleep(SINCE_REFRESH_MS, signal);
      }
    },
  });

  return {
    /** The GitHub read the background job keeps (the boardSince read takes it as it is). */
    cache: async (): Promise<SinceCache> => cache ?? (await load()),
    /** The boardSince read. */
    async read(input: { since: number | null; project?: string | null | undefined }): Promise<BoardSince> {
      return sinceRead(o.db, o.engine, cache ?? (await load()), o.login(), input);
    },
  };
}

/**
 * The boardSince read: the log, the allowlist and the GitHub read the job keeps (`c`). Never calls gh. The server's
 * handler calls it directly, so test/read-map-static.test.ts follows it to every table it reads (READS.boardSince).
 */
export function sinceRead(db: Db, engine: Engine, c: SinceCache, login: string, { since: asked, project }: { since: number | null; project?: string | null | undefined }): BoardSince {
  const now = Date.now();
  const looked = engine.feedSeen();
  const since = asked ?? sinceOf({ kind: "looked" }, now, looked || null);
  return sinceStrip(db, { since, now, looked: looked > 0 ? looked : null, project: project ?? null, cache: c, attached: taskedPrs(db, project ?? null), whose: whoseMerges(login, c.ghLogin) });
}
