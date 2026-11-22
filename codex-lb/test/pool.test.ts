// The pool reads against a local stub that answers like codex-lb: readiness without a key, usage and reset credits
// only with the Bearer key.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { readPool, toCredits, toProviderUsage, toWindows } from "../lib/pool.ts";

const LIMIT = { limit_type: "credits", limit_window: "7d", max_value: 1000, current_value: 250, remaining_value: 750, model_filter: null, reset_at: "2026-12-01T00:00:00Z", source: "aggregate" };

test("windows: a key's own limits win over the pool's; the 7d window is weekly", () => {
  const own = { ...LIMIT, limit_window: "5h", current_value: 100 };
  assert.deepEqual(toWindows({ limits: [own], upstream_limits: [LIMIT] }).map((w) => [w.kind, w.label, w.usedPercent]), [["five-hour", "5-hour credits", 10]]);
  const [w] = toWindows({ limits: [], upstream_limits: [LIMIT] });
  assert.deepEqual(w, { kind: "weekly", id: "credits-7d-all", label: "Weekly credits", usedPercent: 25, resetsAt: "2026-12-01T00:00:00Z", model: null, cost: null });
  assert.equal(toWindows({ limits: [{ ...LIMIT, limit_window: "30d", max_value: 0, model_filter: "gpt-x" }] })[0]!.label, "30d credits (gpt-x)");
});

test("credits: counted per account, with the soonest expiry", () => {
  const c = toCredits([
    { account_id: "a1", email: "b@example.com", redeem_id: "r1", expiredAt: "2026-12-09T00:00:00Z" },
    { account_id: "a1", email: "b@example.com", redeem_id: "r2", expiredAt: "2026-12-02T00:00:00Z" },
    { account_id: "a2", email: "a@example.com", redeem_id: "r3", expiredAt: null },
  ]);
  assert.deepEqual(c, {
    total: 3,
    byAccount: [
      { account: "a@example.com", count: 1, nextExpiry: null },
      { account: "b@example.com", count: 2, nextExpiry: "2026-12-02T00:00:00Z" },
    ],
  });
});

async function stub(handler: (path: string, auth: string | undefined) => [number, unknown]) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ? "auth" : "anon"}`);
    const [status, body] = handler(req.url ?? "", req.headers.authorization);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return { base, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const codexLb = (path: string, auth: string | undefined): [number, unknown] => {
  if (path === "/health/ready") return [200, { status: "ok", checks: { database: "ok" } }];
  if (auth !== "Bearer test-key") return [401, { detail: "Missing API key in Authorization header" }];
  if (path === "/v1/usage") return [200, { request_count: 1, total_tokens: 1, cached_input_tokens: 0, total_cost_usd: 0, limits: [LIMIT], upstream_limits: [LIMIT], account_pool_usage: { primary: null, secondary: 75 } }];
  if (path === "/v1/reset-credit") return [200, [{ account_id: "a1", email: "a@example.com", redeem_id: "r1", expiredAt: null }]];
  return [404, {}];
};

test("readPool: three GETs with the Bearer key; the usage card gets one ok resource", async () => {
  const s = await stub(codexLb);
  try {
    const snap = await readPool(s.base, "test-key");
    assert.deepEqual(s.seen.sort(), ["GET /health/ready anon", "GET /v1/reset-credit auth", "GET /v1/usage auth"]);
    assert.equal(snap.ready, true);
    assert.equal(snap.credits?.total, 1);
    const usage = toProviderUsage(snap, true);
    assert.equal(usage.status, "ok");
    assert.equal(usage.planLabel, "1 reset credit");
    assert.equal(usage.status === "ok" && usage.windows[0]!.usedPercent, 25);
  } finally {
    await s.close();
  }
});

test("readPool: a wrong key fails usage and credits but still reports readiness", async () => {
  const s = await stub(codexLb);
  try {
    const snap = await readPool(s.base, "wrong");
    assert.equal(snap.ready, true);
    assert.equal(snap.windows, null);
    assert.match(snap.usageError!, /\/v1\/usage answered HTTP 401/);
    const usage = toProviderUsage(snap, true);
    assert.equal(usage.status, "error");
  } finally {
    await s.close();
  }
});

test("readPool: no key sends no authenticated request and reads as unauthenticated", async () => {
  const s = await stub(codexLb);
  try {
    const snap = await readPool(s.base, null);
    assert.deepEqual(s.seen, ["GET /health/ready anon"]);
    assert.equal(toProviderUsage(snap, false).status, "unauthenticated");
  } finally {
    await s.close();
  }
});

test("readPool: an unreachable codex-lb is not ready, with the reason", async () => {
  const snap = await readPool("http://127.0.0.1:1", "k", fetch, 2_000);
  assert.equal(snap.ready, false);
  assert.ok(snap.readyDetail.length > 0);
  assert.equal(toProviderUsage(snap, true).status, "error");
});
