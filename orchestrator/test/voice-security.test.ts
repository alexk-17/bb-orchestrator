// Voice mode's guards: off means no routes at all; the socket needs the page's own origin; the Google credential never
// reaches a response, a page event or a log line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { registerVoice } from "../voice/server.ts";
import { writeOriginProblem } from "../server.ts";
import type { LiveSocket } from "../voice/gemini.ts";
import type { Engine } from "../core/engine.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const KEY = JSON.stringify({ type: "service_account", client_email: "voice@example-project.iam.gserviceaccount.com", private_key: PEM, token_uri: "https://oauth2.example.test/token" });
const APP = "http://127.0.0.1:41234";

const engine = {
  agents: () => [],
  projects: () => [],
  leadStatus: () => null,
  watchList: () => [],
  deliverables: () => [],
  needsYou: () => ({ cards: [], deferred: [], triaging: [], held: [] }),
  decision: () => null,
  decisions: () => [],
  directHistory: () => ({ messages: [], more: false }),
  liveAt: () => null,
} as unknown as Engine;

type Handler = (ctx: { request: Request; url: URL; headers: Headers }) => {
  onOpen?(s: FakePage): void | Promise<void>;
  onMessage?(s: FakePage, d: string | Uint8Array): void;
  onClose?(s: FakePage, e: { code: number; reason: string }): void;
};
class FakePage {
  readyState = 1;
  sent: (string | Uint8Array)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(d: string | Uint8Array) {
    this.sent.push(d);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
}

function fakeBb(values: Record<string, unknown>) {
  const logs: string[] = [];
  const routes: { path: string; handler: Handler; auth?: string }[] = [];
  const rpcs: Record<string, (input: unknown) => Promise<unknown>> = {};
  const changes: ((n: Record<string, unknown>) => void)[] = [];
  const bb = {
    settings: {
      define: (d: Record<string, { default?: unknown }>) => {
        const all = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, k in values ? values[k] : v.default]));
        return { get: async () => all, onChange: (fn: (n: Record<string, unknown>) => void) => changes.push((n) => fn({ ...all, ...n })) };
      },
    },
    http: { experimental_websocket: (path: string, handler: Handler, opts?: { auth?: string }) => routes.push({ path, handler, auth: opts?.auth }), route: () => assert.fail("voice registers no plain HTTP route") },
    rpc: { register: (_c: unknown, h: Record<string, (i: unknown) => Promise<unknown>>) => Object.assign(rpcs, h) },
    events: { on: () => {} },
    onDispose: () => {},
    log: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) },
  };
  return { bb: bb as never, logs, routes, rpcs, change: (n: Record<string, unknown>) => changes.forEach((f) => f(n)) };
}

const deps = (extra: Record<string, unknown> = {}) => ({
  engine,
  ownerName: () => "Sam",
  originProblem: (h: { origin: string | undefined; secFetchSite: string | undefined; requestUrl: string }) => writeOriginProblem({ ...h, appUrls: [APP] }),
  socket: () => ({ send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }) as LiveSocket,
  ...extra,
});

function ctx(headers: Record<string, string>) {
  const url = new URL(`${APP}/api/v1/plugins/orchestrator/http/voice/socket?zone=UTC`);
  return { request: new Request(url, { headers }), url, headers: new Headers(headers) };
}

test("off by default: no socket route and no read exist", async () => {
  const f = fakeBb({});
  const out = await registerVoice(f.bb, deps());
  assert.equal(out, null);
  assert.equal(f.routes.length, 0);
  assert.deepEqual(Object.keys(f.rpcs), []);
});

test("on: one socket, local auth only (never token or none)", async () => {
  const f = fakeBb({ voiceEnabled: true, voiceProject: "example-project" });
  await registerVoice(f.bb, deps({ auth: { setting: () => "", env: {}, home: "/nonexistent" } }));
  assert.equal(f.routes.length, 1);
  assert.equal(f.routes[0]!.path, "/voice/socket");
  assert.equal(f.routes[0]!.auth, "local");
});

test("a socket with no Origin, or from another site, is refused before anything starts", async () => {
  const f = fakeBb({ voiceEnabled: true, voiceProject: "example-project" });
  let opened = 0;
  await registerVoice(f.bb, deps({ socket: () => (opened++, { send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }) }));
  const cases: Record<string, string>[] = [{}, { origin: "https://evil.example" }, { origin: APP, "sec-fetch-site": "cross-site" }];
  for (const h of cases) {
    const page = new FakePage();
    await f.routes[0]!.handler(ctx(h)).onOpen?.(page);
    assert.equal(page.closed?.code, 1008, JSON.stringify(h));
    assert.match(String(page.sent[0]), /Refused/);
  }
  assert.equal(opened, 0, "no provider connection was opened");
});

test("voice switched off at runtime refuses new calls", async () => {
  const f = fakeBb({ voiceEnabled: true, voiceProject: "example-project" });
  await registerVoice(f.bb, deps());
  f.change({ voiceEnabled: false });
  const page = new FakePage();
  await f.routes[0]!.handler(ctx({ origin: APP, "sec-fetch-site": "same-origin" })).onOpen?.(page);
  assert.equal(page.closed?.code, 1008);
  assert.match(String(page.sent[0]), /voice is off/);
});

test("the status line names the fix: no project, no credential", async () => {
  const f = fakeBb({ voiceEnabled: true, voiceProject: "" });
  await registerVoice(f.bb, deps({ auth: { setting: () => "", env: {}, home: "/nonexistent" } }));
  const st1 = (await f.rpcs.voiceStatus!(null)) as { ready: boolean; problem: string };
  assert.equal(st1.ready, false);
  assert.match(st1.problem, /Set voiceProject/);
  const g = fakeBb({ voiceEnabled: true, voiceProject: "example-project" });
  await registerVoice(g.bb, deps({ auth: { setting: () => "", env: {}, home: "/nonexistent" } }));
  const st2 = (await g.rpcs.voiceStatus!(null)) as { problem: string; credential: string };
  assert.match(st2.problem, /No Google credential found.*gcloud auth application-default login/);
  assert.equal(st2.credential, "none");
});

test("the credential never appears in a response, a page event or a log line, even when Google echoes it", async () => {
  const f = fakeBb({ voiceEnabled: true, voiceProject: "example-project", voiceCredential: KEY });
  const echo = (async (_u: string, init?: RequestInit) =>
    new Response(JSON.stringify({ error: "invalid_grant", error_description: `bad key ${PEM} for ${String(init?.body)}` }), { status: 400 })) as typeof fetch;
  await registerVoice(f.bb, deps({ auth: { setting: () => KEY, env: {}, home: "/nonexistent", fetch: echo } }));
  const st = (await f.rpcs.voiceStatus!(null)) as { problem: string; credential: string };
  assert.equal(st.credential, "setting");
  assert.match(st.problem, /Google refused the credential \(invalid_grant/);
  const page = new FakePage();
  await f.routes[0]!.handler(ctx({ origin: APP, "sec-fetch-site": "same-origin" })).onOpen?.(page);
  const everything = [JSON.stringify(st), ...page.sent.map(String), ...f.logs].join("\n");
  const body = PEM.split("\n")[1]!; // a line of the key itself
  assert.ok(!everything.includes(body), "no key material");
  assert.ok(!everything.includes("BEGIN PRIVATE KEY"), "no PEM header");
  assert.ok(!/assertion=[\w-]{20}/.test(everything), "no signed assertion");
});
