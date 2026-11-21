// Slack and GitHub reads never hold up the read: a miss starts one in the background, and the tab refetches when it lands.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Db } from "../core/db.ts";
import type { Engine } from "../core/engine.ts";
import { integrationRoutes } from "../core/integration.ts";
import { orchHostContract } from "../host-contract.ts";
import type { SlackFetch } from "../open-prs/slack.ts";
import { checkBoard, openLink, type BoardAdd } from "./core/boards.ts";
import { reviewParts, reviewReadSchema, VERDICT, type ReviewRead } from "./core/findings.ts";
import { prName, type RecordInput, type ReviewRecord } from "./core/records.ts";
import { MultiplayerStore } from "./core/store.ts";
import { health } from "./core/watch.ts";
import { MULTIPLAYER_CHANNEL, multiplayerContract, type BoardView, type MultiplayerView, type RecordView } from "./contract.ts";
import { boardSlack } from "./slack.ts";

export interface MultiplayerSettings {
  integrationRoutes: string;
  slackToken?: string | undefined; // secret: read here only, never sent to the page
}

const READS_AT_ONCE = 3;
const RETRY_MS = 5 * 60_000;

export function registerMultiplayer(
  bb: BbPluginApi,
  deps: { db: Db; engine: Engine; dir: string; settings: () => MultiplayerSettings; routes?: () => Record<string, string[]>; fetch?: SlackFetch; now?: () => number },
) {
  const now = deps.now ?? Date.now;
  const store = new MultiplayerStore(deps.db, now);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      bb.realtime.publish(MULTIPLAYER_CHANNEL, {});
    }, 150);
  };
  bb.onDispose?.(() => {
    if (timer) clearTimeout(timer);
  });
  const slack = boardSlack(deps.fetch ?? (fetch as unknown as SlackFetch), changed, now);
  const routes = (): Record<string, string[]> => {
    try {
      return deps.routes ? deps.routes() : integrationRoutes(deps.settings().integrationRoutes);
    } catch {
      return {};
    }
  };
  const token = () => deps.settings().slackToken?.trim() || "";

  // a submitted review doesn't change, so each is read from GitHub once
  const reviewDir = join(deps.dir, "reviews");
  const reviews = new Map<string, ReviewRead>();
  const failed = new Map<string, number>();
  const reading = new Set<string>();
  const host = bb.hosts.experimental_client({ contract: orchHostContract });
  async function onHost<T>(f: (hostId: string) => Promise<T>): Promise<T> {
    const ids = (await bb.sdk.hosts.list()).filter((h) => h.type === "persistent" && h.lifecycle.phase === "active" && h.status === "connected").map((h) => h.id);
    if (!ids.length) throw new Error("No connected machine to run gh on.");
    let last: unknown = null;
    for (const id of ids) {
      try {
        return await f(id);
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }
  function reviewOf(url: string): ReviewRead | null {
    const id = reviewParts(url).id;
    const memo = reviews.get(id);
    if (memo) return memo;
    const file = join(reviewDir, `${id}.json`);
    if (existsSync(file)) {
      try {
        const r = reviewReadSchema.parse(JSON.parse(readFileSync(file, "utf8")));
        reviews.set(id, r);
        return r;
      } catch {
        // a damaged file is read again from GitHub
      }
    }
    if (reading.has(id) || reading.size >= READS_AT_ONCE || now() - (failed.get(id) ?? 0) < RETRY_MS) return null;
    reading.add(id);
    void onHost((hostId) => host.call("multiplayer.review", { url }, { hostId }))
      .then((r) => {
        failed.delete(id);
        if (r.state === "PENDING") return;
        reviews.set(id, r);
        mkdirSync(reviewDir, { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(r), { mode: 0o600 });
        renameSync(tmp, file);
      })
      .catch((e: unknown) => {
        failed.set(id, now());
        bb.log.warn(`multiplayer: review ${id} not read (${e instanceof Error ? e.message.slice(0, 200) : "error"})`);
      })
      .finally(() => {
        reading.delete(id);
        changed();
      });
    return null;
  }

  const agentRow = (address: string) => {
    const a = deps.engine.agentByAddress(address);
    return { address, threadId: a?.threadId ?? null, status: a?.status ?? null };
  };

  function boardView(b: ReturnType<MultiplayerStore["boards"]>[number], rs: Record<string, string[]>, t: number): BoardView {
    const tk = token();
    const h = tk ? slack.header(tk, b.channel) : undefined;
    const addresses = b.watcher ? (rs[b.watcher] ?? []) : [];
    const hb = b.watcher ? store.beatOf(b.watcher) : null;
    const hl = health(hb, t);
    return {
      id: b.id,
      channel: b.channel,
      open: openLink(b),
      name: h?.name ?? b.name,
      private: h?.private ?? null,
      purpose: h?.purpose ?? b.purpose,
      setup: h?.setup ?? b.setup,
      from: h?.name ? "slack" : "typed",
      note: h?.note ?? null,
      watch: b.watcher
        ? {
            source: b.watcher,
            agents: addresses.map(agentRow),
            health: hl.state === "none" ? { state: "none", lastAt: null, nextAt: null, everyMs: null } : { state: hl.state, lastAt: hl.lastAt, nextAt: hl.nextAt, everyMs: hl.everyMs },
            reads: hb?.reads ?? 0,
            lastWake: store.lastWake(b.watcher),
          }
        : null,
      tracked: addresses.length
        ? deps.engine
            .watchList()
            .filter((w) => addresses.includes(w.owner))
            .map((w) => ({ id: w.id, owner: w.owner, url: w.prUrl, when: w.when, state: w.reading?.state ?? null, checks: w.reading?.checks ?? null, review: w.reading?.review ?? null, readAt: w.reading?.readAt ?? w.reading?.changedAt ?? null }))
        : [],
    };
  }

  function recordView(r: ReviewRecord): RecordView {
    const tk = token();
    const dl = r.deliverable ? deps.engine.deliverable(r.deliverable) : null;
    const card = dl?.board?.card ? deps.engine.decision(dl.board.card) : null;
    const who = r.thread ? (r.thread.includes(":") ? deps.engine.agentByAddress(r.thread) : deps.engine.agentByThread(r.thread)) : null;
    return {
      id: r.id,
      board: r.board,
      lead: r.lead,
      state: r.state,
      note: r.note,
      asker: r.request.asker ? { id: r.request.asker, name: tk ? (slack.user(tk, r.request.asker) ?? null) : null } : null,
      permalink: r.request.permalink,
      askedAt: r.request.at,
      times: r.times as Record<string, number>,
      thread: r.thread ? { ref: r.thread, address: who?.address ?? null, threadId: who?.threadId ?? null, status: who?.status ?? null } : null,
      prs: r.prs.map((p) => {
        const url = [...r.reviews].reverse().find((u) => u.startsWith(`${p.url}#`)) ?? null;
        const rd = url ? reviewOf(url) : null;
        return {
          url: p.url,
          name: prName(p.url),
          class: p.class,
          title: rd?.title ?? null,
          review: url ? { url, state: rd?.state ?? null, verdict: rd ? (VERDICT[rd.state] ?? rd.state) : null, commit: rd?.commit || null, submittedAt: rd?.submittedAt ?? null, findings: rd?.findings ?? null } : null,
        };
      }),
      reply: r.reply,
      deliverable: dl ? { id: dl.id, state: dl.state, rev: dl.rev, flag: dl.board?.flag ?? null, card: card && (card.state === "open" || card.state === "asked") ? card.id : null } : null,
      // a decided deliverable leaves the owner nothing to do, whatever state the lead last set
      waitsOnYou: dl ? dl.state === "review" : r.state === "waits",
      createdAt: r.createdAt,
    };
  }

  function view(): MultiplayerView {
    const t = now();
    const rs = routes();
    const boards = store.boards();
    const ids = new Set(boards.map((b) => b.id));
    return {
      boards: boards.map((b) => boardView(b, rs, t)),
      records: store.records().filter((r) => ids.has(r.board)).map(recordView),
      sources: Object.keys(rs),
      slack: !!token(),
      now: t,
    };
  }

  bb.rpc.register(multiplayerContract, { multiplayer: async () => view() });

  return {
    store,
    view,
    changed,
    addBoard(b: BoardAdd) {
      const out = store.addBoard(checkBoard(b, Object.keys(routes())));
      changed();
      return out.id;
    },
    /** The owner's Remove; refused while a review is in review or sent back, as its revision keeps the board. */
    removeBoard(id: string) {
      const open = deps.engine.deliverables(1000, true).filter((d) => d.board?.id === id && (d.state === "review" || d.state === "changes"));
      if (open.length) throw new Error(`${open.length} of this board's reviews are still open: decide those in review, and have the lead revise or withdraw those sent back`);
      store.removeBoard(id);
      changed();
      return id;
    },
    file(lead: { address: string; project: string | null }, input: RecordInput) {
      if (input.deliverable) {
        const d = deps.engine.deliverable(input.deliverable);
        if (!d || d.lead !== lead.address) throw new Error(`${input.deliverable} is not one of your deliverables`);
      }
      const r = store.file(lead, input);
      changed();
      return r;
    },
    heartbeat(source: string, everyMs: number | null) {
      if (!Object.hasOwn(routes(), source)) throw new Error(`${source} is not one of integrationRoutes' sources`);
      const b = store.beat(source, everyMs);
      changed();
      return b;
    },
  };
}
