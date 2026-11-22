// Read-only views of a codex-lb instance: readiness, the pool's usage limits and its unredeemed reset credits.
//
// All three are plain GETs. /health/ready needs no key; /v1/usage and /v1/reset-credit take the client API key as a
// Bearer token, the same key Codex sends. Nothing here redeems a credit or changes the pool.
import { z } from "zod";

const limit = z.looseObject({
  limit_type: z.string(),
  limit_window: z.string(),
  max_value: z.number(),
  current_value: z.number(),
  model_filter: z.string().nullable().optional(),
  reset_at: z.string().nullable().optional(),
});
const usageResponse = z.looseObject({
  limits: z.array(limit).default([]),
  upstream_limits: z.array(limit).default([]),
});
const resetCredits = z.array(
  z.looseObject({ account_id: z.string(), email: z.string().nullable().optional(), expiredAt: z.string().nullable().optional() }),
);

export type Limit = z.infer<typeof limit>;
export type UsageWindow = {
  kind: "five-hour" | "daily" | "weekly" | "custom";
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  model: string | null;
  cost: null;
};
export type CreditSummary = { total: number; byAccount: { account: string; count: number; nextExpiry: string | null }[] };

export type PoolSnapshot = {
  ready: boolean;
  readyDetail: string;
  /** null when usage could not be read; `usageError` then says why. */
  windows: UsageWindow[] | null;
  usageError: string | null;
  credits: CreditSummary | null;
  creditsError: string | null;
};

type Fetch = typeof fetch;

const KIND: Record<string, UsageWindow["kind"]> = { "5h": "five-hour", "1d": "daily", "24h": "daily", "7d": "weekly" };
const WINDOW_LABEL: Record<UsageWindow["kind"], string> = { "five-hour": "5-hour", daily: "Daily", weekly: "Weekly", custom: "" };

/** codex-lb limits → provider-usage windows. A key's own limits win; otherwise the pool's upstream limits. */
export function toWindows(body: unknown): UsageWindow[] {
  const usage = usageResponse.parse(body);
  const limits = usage.limits.length > 0 ? usage.limits : usage.upstream_limits;
  return limits.map((l) => {
    const kind = KIND[l.limit_window] ?? "custom";
    const span = WINDOW_LABEL[kind] || l.limit_window;
    const model = l.model_filter ?? null;
    return {
      kind,
      id: `${l.limit_type}-${l.limit_window}-${model ?? "all"}`,
      label: `${span} ${l.limit_type}${model ? ` (${model})` : ""}`,
      usedPercent: l.max_value > 0 ? Math.max(0, (l.current_value / l.max_value) * 100) : 0,
      resetsAt: l.reset_at ?? null,
      model,
      cost: null,
    };
  });
}

/** Unredeemed reset credits per account, soonest expiry first within each account. */
export function toCredits(body: unknown): CreditSummary {
  const byAccount = new Map<string, { count: number; nextExpiry: string | null }>();
  for (const c of resetCredits.parse(body)) {
    const account = c.email || c.account_id;
    const row = byAccount.get(account) ?? { count: 0, nextExpiry: null };
    row.count += 1;
    const exp = c.expiredAt ?? null;
    if (exp && (row.nextExpiry === null || exp < row.nextExpiry)) row.nextExpiry = exp;
    byAccount.set(account, row);
  }
  const rows = [...byAccount].map(([account, r]) => ({ account, ...r })).sort((a, b) => a.account.localeCompare(b.account));
  return { total: rows.reduce((n, r) => n + r.count, 0), byAccount: rows };
}

async function getJson(fetchImpl: Fetch, url: string, key: string | null, timeoutMs: number): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: key ? { Authorization: `Bearer ${key}`, Accept: "application/json" } : { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${new URL(url).pathname} answered HTTP ${res.status}`);
  return res.json();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One read of the pool. Each part fails on its own, so a missing key still reports readiness. */
export async function readPool(baseUrl: string, key: string | null, fetchImpl: Fetch = fetch, timeoutMs = 10_000): Promise<PoolSnapshot> {
  const base = baseUrl.replace(/\/+$/, "");
  const noKey = "no API key: the configured variable is not set in bb's environment";
  const [health, usage, credits] = await Promise.allSettled([
    getJson(fetchImpl, `${base}/health/ready`, null, timeoutMs),
    key ? getJson(fetchImpl, `${base}/v1/usage`, key, timeoutMs) : Promise.reject(new Error(noKey)),
    key ? getJson(fetchImpl, `${base}/v1/reset-credit`, key, timeoutMs) : Promise.reject(new Error(noKey)),
  ]);
  const status = health.status === "fulfilled" ? (health.value as { status?: unknown } | null)?.status : null;
  let windows: UsageWindow[] | null = null;
  let usageError: string | null = null;
  if (usage.status === "fulfilled") {
    try {
      windows = toWindows(usage.value);
    } catch (e) {
      usageError = `unexpected /v1/usage answer: ${message(e)}`;
    }
  } else usageError = message(usage.reason);
  let creditSummary: CreditSummary | null = null;
  let creditsError: string | null = null;
  if (credits.status === "fulfilled") {
    try {
      creditSummary = toCredits(credits.value);
    } catch (e) {
      creditsError = `unexpected /v1/reset-credit answer: ${message(e)}`;
    }
  } else creditsError = message(credits.reason);
  return {
    ready: status === "ok",
    readyDetail: health.status === "fulfilled" ? `status ${String(status)}` : message(health.reason),
    windows,
    usageError,
    credits: creditSummary,
    creditsError,
  };
}

/** The pool as one provider-usage resource, the shape bb's Provider usage card reads. */
export function toProviderUsage(snap: PoolSnapshot, keySet: boolean) {
  const base = { plan: null, accountEmail: null };
  if (!keySet) return { status: "unauthenticated" as const, ...base, planLabel: null };
  if (snap.windows === null) {
    return { status: "error" as const, ...base, planLabel: null, message: snap.usageError ?? (snap.ready ? "usage unavailable" : `codex-lb is not ready: ${snap.readyDetail}`) };
  }
  const credits = snap.credits === null ? null : `${snap.credits.total} reset credit${snap.credits.total === 1 ? "" : "s"}`;
  return { status: "ok" as const, ...base, planLabel: credits, windows: snap.windows };
}
