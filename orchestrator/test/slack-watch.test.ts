import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../core/db.ts";
import { WatchStore } from "../slack-watch/store.ts";
import { SlackClient } from "../slack-watch/slack.ts";
import { WatchRunner } from "../slack-watch/runner.ts";

test("a paginated scan survives reload and imports a new reply on an old root exactly once", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const store = new WatchStore(db);
  store.add(
    { version: 1, profile: "test", paused: false, pollSeconds: 60, startFrom: "now", channels: [{ id: "C123", source: "test-slack", to: "cos" }] },
    { team: "T1", user: "U1", bot: "B1" },
    "100.000000",
  );
  const calls: string[] = [];
  const client = new SlackClient("xoxb-fixture", async (url) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    const method = u.pathname.split("/").pop();
    const cursor = u.searchParams.get("cursor");
    const data =
      method === "conversations.history"
        ? {
            messages: cursor ? [{ ts: "2.000001", reply_count: 1 }] : [{ ts: "1.000001", reply_count: 0 }],
            response_metadata: { next_cursor: cursor ? "" : "page2" },
          }
        : method === "conversations.replies"
          ? {
              messages: [
                { ts: "1.000001", text: "old" },
                { ts: "101.000001", thread_ts: "1.000001", user: "U2", text: "review this" },
              ],
            }
          : { permalink: "https://example.slack.com/archives/C123/p101000001" };
    return new Response(JSON.stringify({ ok: true, ...data }));
  });
  const imported: any[] = [],
    beats: string[] = [];
  const deps = {
    client: () => client,
    recipient: () => true,
    importMail: (m: any) => {
      imported.push(m);
    },
    heartbeat: (s: string) => {
      beats.push(s);
    },
    now: () => 200000,
  };
  await new WatchRunner(store, deps).step("test", new AbortController().signal, 1);
  assert.equal(beats.length, 0);
  const reloaded = new WatchRunner(new WatchStore(db), deps);
  for (let i = 0; i < 10 && beats.length === 0; i++) await reloaded.step("test", new AbortController().signal, 2);
  assert.equal(beats.length, 1);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].body, "review this");
  assert.match(imported[0].refs[0], /slack.com/);
  for (let i = 0; i < 10; i++) await reloaded.step("test", new AbortController().signal, 2);
  assert.equal(imported.length, 1);
  assert.ok(calls.includes("/api/conversations.replies"));
  db.close();
});

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../core/engine.ts";
import { registerSlackWatch } from "../slack-watch/server.ts";
import { Credentials } from "../slack-watch/secrets.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "slack-watch-test-"));
  const db = new DatabaseSync(":memory:");
  let now = 100000;
  const calls: { method: string; params: URLSearchParams }[] = [],
    beats: string[] = [],
    audit: string[] = [];
  let newIdentity = { team_id: "T1", user_id: "U1", bot_id: "B1" };
  const authHeaders: string[] = [];
  let history: any[] = [{ ts: "1.000001", thread_ts: "1.000001", reply_count: 1, text: "old root" }];
  let replies: any[] = [];
  let failure: string | null = null;
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    authHeaders.push(String((init?.headers as Record<string, string>)?.Authorization));
    const u = new URL(String(url));
    const method = u.pathname.split("/").pop()!;
    calls.push({ method, params: u.searchParams });
    if (failure === "network") throw new Error("xoxb-fixture-secret in upstream error");
    if (failure === "rate") return new Response("secret", { status: 429, headers: { "retry-after": "123" } });
    if (failure) return new Response(JSON.stringify({ ok: false, error: failure }));
    const result =
      method === "auth.test"
        ? authHeaders.at(-1) === "Bearer xoxb-new-secret"
          ? newIdentity
          : { team_id: "T1", user_id: "U1", bot_id: "B1" }
        : method === "conversations.info"
          ? { channel: { id: u.searchParams.get("channel"), is_member: true } }
          : method === "conversations.history"
            ? { messages: history }
            : method === "conversations.replies"
              ? { messages: replies }
              : method === "chat.getPermalink"
                ? { permalink: `https://test.slack.com/archives/${u.searchParams.get("channel")}/p${u.searchParams.get("message_ts")!.replace(".", "")}` }
                : assert.fail(`Unexpected Slack write/method ${method}`);
    return new Response(JSON.stringify({ ok: true, ...result }));
  };
  const store = new WatchStore(db);
  const engine = new Engine(
    db as never,
    {
      now: () => now,
      externalEnabled: (source, to) => store.routes()[source]?.includes(to) ?? false,
      deliver: async () => ({ delivery: "sent" }),
      mirror: () => {},
      changed: () => {},
      log: () => {},
    },
    { batchInbox: true },
  );
  engine.register("cos-thread", "cos", null);
  let service: { start(signal: AbortSignal): Promise<void> };
  let dispose: () => Promise<void>;
  const bb: any = {
    background: {
      service: (name: string, s: typeof service) => {
        assert.equal(name, "slack-watch");
        service = s;
      },
    },
    onDispose: (f: typeof dispose) => {
      dispose = f;
    },
  };
  const deps = {
    db,
    dir,
    now: () => now,
    fetch: fetcher,
    legacyRoutes: () => ({}),
    recipient: (to: string) => !!engine.agentByAddress(to),
    importMail: (m: any) => engine.importMail(m),
    heartbeat: (source: string) => {
      beats.push(source);
    },
    audit: (s: string) => audit.push(s),
  };
  const watcher = registerSlackWatch(bb, deps);
  const config = join(dir, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      version: 1,
      profile: "alice",
      paused: false,
      pollSeconds: 30,
      startFrom: "now",
      channels: [{ id: "C123", source: "alice-slack", to: "cos" }],
    }),
  );
  const cli = (args: string[], ctx = {}) => watcher.cli.run(["slack-watch", ...args], ctx);
  const setup = () => cli(["setup", "alice", "--config", config, "--token", "xoxb-fixture-secret"]);
  const runner = () => new WatchRunner(store, { ...deps, client: () => new SlackClient(new Credentials(join(dir, "credentials")).read("alice"), fetcher) });
  return {
    dir,
    db,
    engine,
    store,
    calls,
    beats,
    audit,
    authHeaders,
    deps,
    cli,
    setup,
    runner,
    watcher,
    config,
    advance: (ms: number) => {
      now += ms;
    },
    identity: (v: typeof newIdentity) => {
      newIdentity = v;
    },
    history: (v: any[]) => {
      history = v;
    },
    replies: (v: any[]) => {
      replies = v;
    },
    failure: (v: string | null) => {
      failure = v;
    },
    start: (signal: AbortSignal) => service!.start(signal),
    close: async () => {
      await dispose!();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("operator setup, dry test, rotation, routes and lifecycle keep secrets separate and start paused", async () => {
  const f = fixture();
  try {
    const result = await f.setup();
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(f.store.get("alice").config.paused, true);
    assert.equal(statSync(join(f.dir, "credentials/alice.token")).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.dir, "credentials")).mode & 0o777, 0o700);
    const saved = JSON.stringify(f.store.all());
    assert.ok(!saved.includes("xoxb"));
    assert.equal((await f.cli(["test", "alice"])).exitCode, 0);
    assert.equal(JSON.stringify(f.store.all()), saved, "dry test cannot mutate checkpoints");
    assert.equal(f.beats.length, 0);
    assert.equal(f.engine.externalReceipts("alice-slack").length, 0);
    f.identity({ team_id: "OTHER", user_id: "U1", bot_id: "B1" });
    assert.equal((await f.cli(["token", "rotate", "alice", "--token", "xoxb-new-secret"])).exitCode, 1);
    assert.equal(readFileSync(join(f.dir, "credentials/alice.token"), "utf8"), "xoxb-fixture-secret");
    f.identity({ team_id: "T1", user_id: "U1", bot_id: "B1" });
    assert.equal((await f.cli(["token", "rotate", "alice", "--token", "xoxb-new-secret"])).exitCode, 0);
    assert.equal(readFileSync(join(f.dir, "credentials/alice.token"), "utf8"), "xoxb-new-secret");
    await f.cli(["test", "alice"]);
    assert.equal(f.authHeaders.at(-1), "Bearer xoxb-new-secret");
    assert.equal((await f.cli(["channel", "add", "alice", "C456", "--to", "cos"])).exitCode, 0);
    assert.equal(f.store.get("alice").config.channels.length, 2);
    assert.equal((await f.cli(["channel", "remove", "alice", "C456"])).exitCode, 0);
    const failed = await f.cli(["status", "--oops", "xoxb-fixture-secret"]);
    assert.equal(failed.exitCode, 1);
    assert.ok(!JSON.stringify(failed).includes("xoxb-fixture-secret"));
    assert.equal((await f.cli(["resume", "alice"], { threadId: "cos-thread" })).exitCode, 1);
    const stop = new AbortController();
    const service = f.start(stop.signal);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.beats.length, 0, "service leaves paused profiles alone");
    stop.abort();
    await service;
    assert.ok(!JSON.stringify([result, f.audit, await f.cli(["routes"]), await f.cli(["status", "--json"])]).includes("xoxb"));
  } finally {
    await f.close();
  }
});

test("old-thread replies, other bots and edits reach real untrusted inbox; own bot is suppressed", async () => {
  const f = fixture();
  try {
    await f.setup();
    f.replies([
      { ts: "101.000001", thread_ts: "1.000001", text: "human", user: "U2" },
      { ts: "102.000001", thread_ts: "1.000001", text: "Claude reply", bot_id: "BCLAUDE", user: "UCLAUDE" },
      { ts: "103.000001", thread_ts: "1.000001", text: "own", bot_id: "B1" },
      { ts: "104.000001", thread_ts: "1.000001", text: "own user", user: "U1" },
    ]);
    f.advance(10000);
    assert.equal((await f.cli(["resume", "alice"])).exitCode, 0);
    await f.runner().step("alice", new AbortController().signal, 20);
    assert.equal(f.beats.length, 1);
    assert.equal(f.engine.externalReceipts("alice-slack").length, 2);
    const inbox = f.engine.inbox(f.engine.agentByAddress("cos")!).text;
    assert.match(inbox, /UNTRUSTED/);
    assert.match(inbox, /BCLAUDE/);
    f.advance(31000);
    f.replies([{ ts: "101.000001", thread_ts: "1.000001", text: "edited", user: "U2", edited: { ts: "140.000001" } }]);
    await f.runner().step("alice", new AbortController().signal, 20);
    assert.equal(f.engine.externalReceipts("alice-slack").length, 3);
    f.advance(31000);
    await f.runner().step("alice", new AbortController().signal, 20);
    assert.equal(f.engine.externalReceipts("alice-slack").length, 3);
  } finally {
    await f.close();
  }
});

test("durable outbox replays identical mail after import succeeds but completion checkpoint fails", async () => {
  const f = fixture();
  try {
    await f.setup();
    f.history([{ ts: "101.000001", text: "new", user: "U2" }]);
    f.advance(10000);
    await f.cli(["resume", "alice"]);
    const runner = f.runner();
    const importMail = runner.deps.importMail;
    let crash = true;
    runner.deps.importMail = (mail) => {
      const result = importMail(mail);
      if (crash) {
        crash = false;
        throw new Error("simulated crash");
      }
      return result;
    };
    await runner.step("alice", new AbortController().signal, 20);
    assert.equal(f.beats.length, 0);
    assert.equal(f.store.backlog("alice"), 1);
    assert.equal(f.engine.externalReceipts("alice-slack").length, 1);
    f.advance(61000);
    await f.runner().step("alice", new AbortController().signal, 20);
    assert.equal(f.store.backlog("alice"), 0);
    assert.equal(f.engine.externalReceipts("alice-slack").length, 1);
    assert.equal(f.beats.length, 1);
  } finally {
    await f.close();
  }
});

test("rate limits, network failures and lost access never produce healthy heartbeats or leak errors", async () => {
  for (const failure of ["rate", "network", "not_in_channel", "secret-xoxb-token"]) {
    const f = fixture();
    try {
      await f.setup();
      await f.cli(["resume", "alice"]);
      f.failure(failure);
      await f.runner().step("alice", new AbortController().signal);
      const p = f.store.get("alice");
      assert.equal(f.beats.length, 0);
      assert.ok(p.scans.C123!.error);
      assert.ok(!p.scans.C123!.error!.includes("xoxb"));
      assert.equal(p.scans.C123!.nextAt, 100000 + (failure === "rate" ? 123000 : 60000));
      const before = f.calls.length;
      await f.runner().step("alice", new AbortController().signal);
      assert.equal(f.calls.length, before);
      f.failure(null);
      f.advance(124000);
      f.history([]);
      await f.runner().step("alice", new AbortController().signal);
      assert.equal(f.beats.length, 1, "empty successful scan emits heartbeat");
    } finally {
      await f.close();
    }
  }
});

test("reply pagination and expired cursors resume without dropping pages", async () => {
  const f = fixture();
  try {
    await f.setup();
    await f.cli(["resume", "alice"]);
    f.advance(10000);
    const runner = f.runner();
    let expire = true;
    runner.deps.client = () =>
      new SlackClient("xoxb-fixture", async (url) => {
        const u = new URL(String(url));
        const cursor = u.searchParams.get("cursor");
        const method = u.pathname.split("/").pop();
        if (method === "conversations.history") return Response.json({ ok: true, messages: [{ ts: "1.000001", thread_ts: "1.000001", reply_count: 2 }] });
        if (method === "chat.getPermalink") return Response.json({ ok: true, permalink: "https://test.slack.com/archives/C123/p101000001" });
        if (cursor && expire) {
          expire = false;
          return Response.json({ ok: false, error: "invalid_cursor" });
        }
        return Response.json({
          ok: true,
          messages: [{ ts: cursor ? "102.000001" : "101.000001", user: "U2", text: cursor ? "second" : "first" }],
          response_metadata: { next_cursor: cursor ? "" : "next" },
        });
      });
    await runner.step("alice", new AbortController().signal, 20);
    assert.equal(f.beats.length, 0);
    f.advance(61000);
    await runner.step("alice", new AbortController().signal, 20);
    assert.equal(f.engine.externalReceipts("alice-slack").length, 2);
    assert.equal(f.beats.length, 1);
  } finally {
    await f.close();
  }
});

test("a rolled-back page is reread, not published by error handling", async () => {
  const f = fixture();
  try {
    await f.setup();
    await f.cli(["resume", "alice"]);
    f.advance(10000);
    f.history([{ ts: "101.000001", user: "U2", text: "must survive" }]);
    const save = f.store.save.bind(f.store);
    let fail = true;
    f.store.save = (p) => {
      if (fail && p.scans.C123!.pages === 1) {
        fail = false;
        throw new Error("temporary checkpoint write failure");
      }
      save(p);
    };
    await f.runner().step("alice", new AbortController().signal, 10);
    assert.equal(f.store.get("alice").scans.C123!.phase, "history");
    assert.equal(f.store.get("alice").scans.C123!.pages, 0);
    assert.equal(f.engine.externalReceipts("alice-slack").length, 0);
    f.advance(61000);
    await f.runner().step("alice", new AbortController().signal, 10);
    assert.equal(f.engine.externalReceipts("alice-slack").length, 1);
    assert.equal(f.beats.length, 1);
  } finally {
    await f.close();
  }
});

test("an inaccessible channel cannot starve a healthy route; a removed message cannot block the outbox", async () => {
  const f = fixture();
  try {
    await f.setup();
    await f.cli(["channel", "add", "alice", "C456", "--to", "cos", "--source", "healthy"]);
    await f.cli(["resume", "alice"]);
    f.advance(10000);
    const runner = f.runner();
    runner.deps.client = () =>
      new SlackClient("xoxb-fixture", async (url) => {
        const u = new URL(String(url)),
          method = u.pathname.split("/").pop();
        if (u.searchParams.get("channel") === "C123") return Response.json({ ok: false, error: "not_in_channel" });
        if (method === "conversations.history")
          return Response.json({
            ok: true,
            messages: [
              { ts: "101.000001", text: "deleted later", user: "U2" },
              { ts: "102.000001", text: "survives", user: "U2" },
            ],
          });
        if (u.searchParams.get("message_ts") === "101.000001") return Response.json({ ok: false, error: "message_not_found" });
        return Response.json({ ok: true, permalink: "https://test.slack.com/archives/C456/p102000001" });
      });
    await runner.step("alice", new AbortController().signal, 20);
    assert.deepEqual(f.beats, ["healthy"]);
    assert.equal(f.engine.externalReceipts("healthy").length, 2);
    assert.equal(f.store.get("alice").scans.C123!.error, "not_in_channel");
  } finally {
    await f.close();
  }
});

test("bad config files fail with bounded operator errors, without storing credentials", async () => {
  const f = fixture();
  try {
    for (const [content, expected] of [
      ["{", /valid JSON/],
      ["{}", /Invalid watcher config/],
      [" ".repeat(65537), /64 KiB/],
    ] as const) {
      writeFileSync(f.config, content);
      assert.match((await f.setup()).stderr!, expected);
    }
    assert.match((await f.cli(["setup", "alice", "--config", "/dev/null", "--token", "xoxb-fixture"])).stderr!, /regular JSON file/);
    assert.match((await f.cli(["status", "missing"])).stderr!, /Unknown Slack watcher profile/);
    assert.equal(f.store.all().length, 0);
  } finally {
    await f.close();
  }
});

test("active background service resumes a stopped page from reopened SQLite and emits one completed heartbeat", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-watch-restart-"));
  const path = join(dir, "data.db");
  const secret = new Credentials(join(dir, "credentials"));
  secret.write("alice", "xoxb-fixture");
  let block = true,
    pageReached!: () => void,
    beatReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    pageReached = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    beatReached = resolve;
  });
  const fetcher: typeof fetch = async (url, init) => {
    const u = new URL(String(url)),
      method = u.pathname.split("/").pop();
    if (method === "auth.test") return Response.json({ ok: true, team_id: "T1", user_id: "U1", bot_id: "B1" });
    if (method === "conversations.info") return Response.json({ ok: true, channel: { id: "C123", is_member: true } });
    if (method === "conversations.history") {
      if (!u.searchParams.get("cursor")) return Response.json({ ok: true, messages: [], response_metadata: { next_cursor: "second" } });
      if (block) {
        pageReached();
        await new Promise<void>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
        });
      }
      return Response.json({ ok: true, messages: [{ ts: "101.000001", user: "U2", text: "after restart" }] });
    }
    return Response.json({ ok: true, permalink: "https://test.slack.com/archives/C123/p101000001" });
  };
  function boot() {
    const db = new DatabaseSync(path);
    const store = new WatchStore(db);
    const engine = new Engine(db as never, {
      now: () => 200000,
      externalEnabled: () => true,
      deliver: async () => ({ delivery: "sent" }),
      mirror: () => {},
      changed: () => {},
      log: () => {},
    });
    if (!engine.agentByAddress("cos")) engine.register("cos-thread", "cos", null);
    if (!store.all().length)
      store.add(
        { version: 1, profile: "alice", paused: true, pollSeconds: 30, startFrom: "now", channels: [{ id: "C123", source: "restart", to: "cos" }] },
        { team: "T1", bot: "B1", user: "U1" },
        "100.000000",
      );
    let service!: { start(s: AbortSignal): Promise<void> }, dispose!: () => Promise<void>;
    const watcher = registerSlackWatch(
      {
        background: {
          service: (_name: string, s: typeof service) => {
            service = s;
          },
        },
        onDispose: (f: typeof dispose) => {
          dispose = f;
        },
      } as any,
      {
        db,
        dir,
        now: () => 200000,
        fetch: fetcher,
        legacyRoutes: () => ({}),
        recipient: () => true,
        importMail: (mail) => engine.importMail(mail),
        heartbeat: () => beatReached(),
        audit: () => {},
      },
    );
    const stop = new AbortController();
    return { db, store, engine, watcher, stop, run: () => service.start(stop.signal), dispose: () => dispose() };
  }
  let first = boot();
  assert.equal((await first.watcher.cli.run(["slack-watch", "resume", "alice"], {})).exitCode, 0);
  const running = first.run();
  await reached;
  first.stop.abort();
  await running;
  await first.dispose();
  assert.equal(first.store.get("alice").scans.C123!.cursor, "second");
  assert.equal(first.store.get("alice").scans.C123!.heartbeat, null);
  first.db.close();
  block = false;
  const second = boot(),
    resumed = second.run();
  try {
    await completed;
    assert.equal(second.engine.externalReceipts("restart").length, 1);
    assert.equal(second.store.get("alice").scans.C123!.phase, "complete");
    assert.equal(second.store.backlog("alice"), 0);
  } finally {
    second.stop.abort();
    await resumed;
    await second.dispose();
    second.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pausing a later profile does not cancel another profile or let the target start before pause", { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "slack-watch-pause-")),
    db = new DatabaseSync(":memory:");
  migrate(db);
  const store = new WatchStore(db),
    credentials = new Credentials(join(dir, "credentials"));
  for (const [name, channel] of [
    ["alpha", "CA"],
    ["beta", "CB"],
  ]) {
    credentials.write(name!, "xoxb-fixture");
    store.add(
      { version: 1, profile: name!, paused: false, pollSeconds: 30, startFrom: "now", channels: [{ id: channel!, source: name!, to: "cos" }] },
      { team: "T1", user: "U1", bot: "B1" },
      "100.000000",
    );
  }
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
      entered = r;
    }),
    unblock = new Promise<void>((r) => {
      release = r;
    });
  let alphaAborted = false;
  const calls: string[] = [];
  let service!: { start(s: AbortSignal): Promise<void> }, dispose!: () => Promise<void>;
  const watcher = registerSlackWatch(
    {
      background: {
        service: (_: string, s: typeof service) => {
          service = s;
        },
      },
      onDispose: (f: typeof dispose) => {
        dispose = f;
      },
    } as any,
    {
      db,
      dir,
      now: () => 200000,
      legacyRoutes: () => ({}),
      recipient: () => true,
      importMail: () => {},
      heartbeat: () => {},
      audit: () => {},
      fetch: async (url, init) => {
        const channel = new URL(String(url)).searchParams.get("channel")!;
        calls.push(channel);
        if (channel === "CA") {
          entered();
          init!.signal!.addEventListener("abort", () => {
            alphaAborted = true;
          });
          await unblock;
        }
        return Response.json({ ok: true, messages: [] });
      },
    },
  );
  const stop = new AbortController(),
    run = service.start(stop.signal);
  try {
    await started;
    const pausing = watcher.cli.run(["slack-watch", "pause", "beta"], {});
    assert.equal(alphaAborted, false);
    release();
    assert.equal((await pausing).exitCode, 0);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(store.get("beta").config.paused, true);
    assert.ok(!calls.includes("CB"));
  } finally {
    release();
    stop.abort();
    await run;
    await dispose();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
