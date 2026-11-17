import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_useRpcQuery,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import { Btn } from "../app/ui.tsx";
import { styleHref } from "../app/style-href.ts";
import { assess, type QueueState } from "./core.ts";
import {
  QUEUE_CHANNEL,
  queueContract,
  type queueActionSchema,
} from "./contract.ts";
const CSS = `
[data-orch] .rq{display:grid;gap:24px;max-width:1280px;margin:auto;color:var(--orch-ink);font-size:14px}
[data-orch] .rq h2{font-size:24px;font-weight:600;letter-spacing:-.5px;margin:0}
[data-orch] .rq h3{font-size:16px;font-weight:600;margin:0}
[data-orch] .rq p{margin:4px 0;line-height:1.5}
[data-orch] .rq small{font-size:12px;color:var(--orch-muted)}
[data-orch] .rq-bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
[data-orch] .rq-spread{justify-content:space-between}
[data-orch] .rq-banner{padding:12px 16px;border:1px solid var(--orch-line);border-radius:8px;background:var(--orch-wash)}
[data-orch] .rq-status{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;padding:18px 0;border-block:1px solid var(--orch-line)}
[data-orch] .rq-status strong{display:block;font-size:14px;margin-top:6px;font-weight:600;overflow-wrap:anywhere}
[data-orch] .rq input:not([type=checkbox]),[data-orch] .rq select{border:1px solid var(--orch-line);border-radius:6px;background:var(--orch-bg);color:var(--orch-ink);font:inherit;padding:8px 10px;min-width:0}
[data-orch] .rq-add input{flex:1;min-width:180px}
[data-orch] .rq label{display:flex;align-items:center;gap:8px}
[data-orch] .rq input[type=checkbox]{accent-color:var(--orch-ink);width:16px;height:16px}
[data-orch] .rq-list{list-style:none;margin:0;padding:0;display:grid}
[data-orch] .rq-row{padding:18px 0;border-bottom:1px solid var(--orch-line);display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:12px;align-items:start}
[data-orch] .rq-row[data-pinned=true]{border-left:3px solid #b79b59;padding-left:12px}
[data-orch] .rq-row[data-dragover=true]{background:var(--orch-wash)}
[data-orch] .rq-title{color:var(--orch-ink);text-decoration:none;font-weight:600;line-height:1.5;overflow-wrap:anywhere}
[data-orch] .rq-title:hover{text-decoration:underline}
[data-orch] .rq-meta{display:flex;gap:6px 14px;flex-wrap:wrap;margin-top:6px;color:var(--orch-muted);font-size:12px}
[data-orch] .rq-chip{border-radius:5px;background:var(--orch-wash);padding:2px 7px;font-size:12px;white-space:nowrap}
[data-orch] .rq-chip[data-tone=pass]{color:light-dark(#287342,#8ccc99);background:light-dark(#eaf4ed,#22382a)}
[data-orch] .rq-chip[data-tone=fail]{color:light-dark(#b33737,#f0a2a2);background:light-dark(#fceeee,#412828)}
[data-orch] .rq-chip[data-tone=pending]{color:light-dark(#8b670c,#dfc57c);background:light-dark(#fbf5df,#3a3422)}
[data-orch] .rq-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap;justify-content:flex-end}
[data-orch] .rq-actions button,[data-orch] .rq-grip{border:0;background:none;color:var(--orch-muted);font:inherit;padding:5px;cursor:pointer;border-radius:4px}
[data-orch] .rq-actions button:hover{background:var(--orch-wash);color:var(--orch-ink)}
[data-orch] .rq-grip{cursor:grab;padding:0;line-height:24px}
[data-orch] .rq-settings{display:grid;gap:14px;margin-top:16px;max-width:700px}
[data-orch] .rq-settings label{display:grid;grid-template-columns:180px minmax(0,1fr)}
[data-orch] .rq-error{color:light-dark(#b33737,#f0a2a2);overflow-wrap:anywhere}
[data-orch] .rq-empty{padding:45px 0;text-align:center}
[data-orch] .rq-history{display:grid;gap:8px;font-size:12px;overflow-wrap:anywhere}
@media(max-width:700px){[data-orch] .rq-status{grid-template-columns:1fr 1fr}[data-orch] .rq-row{grid-template-columns:20px minmax(0,1fr)}[data-orch] .rq-actions{grid-column:2;justify-content:flex-start}[data-orch] .rq-settings label{grid-template-columns:1fr}}
`;
const time = (n: number | null) =>
  n
    ? new Date(n).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
export function ReviewQueueView() {
  const rpc = useRpc<typeof queueContract>();
  const q = experimental_useRpcQuery({
    contract: queueContract,
    method: "reviewQueue",
    input: null,
  });
  const ref = useRef(q.refetch);
  ref.current = q.refetch;
  const reload = useCallback(() => void ref.current(), []);
  useRealtime(QUEUE_CHANNEL, reload);
  useEffect(() => {
    const timer = setInterval(reload, 15_000);
    return () => clearInterval(timer);
  }, [reload]);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [draft, setDraft] = useState<QueueState["config"] | null>(null);
  async function act(a: z.infer<typeof queueActionSchema>) {
    setError("");
    setSaving(true);
    try {
      await rpc.call("reviewQueueAction", a);
      await ref.current();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  }
  const v = q.data;
  if (!v) return <p>{q.error ? String(q.error) : "Loading review queue…"}</p>;
  const config = v.config;
  const now = Date.now();
  const held = v.spacingUntil > now;
  const latest = Object.values(v.history).sort((a, b) => b.at - a.at);
  const reorder = (from: string, to: string) => {
    const urls = v.entries.map((e) => e.url);
    const i = urls.indexOf(from),
      j = urls.indexOf(to);
    if (i < 0 || j < 0 || i === j) return;
    urls.splice(i, 1);
    urls.splice(j, 0, from);
    void act({ action: "reorder", urls });
  };
  return (
    <section className="rq">
      <style href={styleHref("review-queue", CSS)} precedence="default">
        {CSS}
      </style>
      <div className="rq-bar rq-spread">
        <div>
          <h2>Review queue</h2>
          <p>One CodeRabbit review at a time.</p>
        </div>
        <div className="rq-bar">
          <Btn
            disabled={saving || v.busy}
            onClick={() => void act({ action: "refresh" })}
          >
            {v.busy ? "Checking…" : "Refresh"}
          </Btn>
          <Btn
            disabled={saving || v.busy || held}
            onClick={() => void act({ action: "run" })}
          >
            {v.dryRun ? "Run dry-run now" : "Run now"}
          </Btn>
        </div>
      </div>
      {v.dryRun && (
        <div className="rq-banner">
          <strong>Dry-run · nothing is posted to GitHub</strong>
          <p>
            The queue checks and selects a PR. Your existing review scheduler
            stays separate.
          </p>
        </div>
      )}
      <div className="rq-bar rq-spread">
        <div className="rq-bar">
          <label>
            <input
              type="checkbox"
              checked={config.enabled}
              disabled={saving}
              onChange={(e) =>
                void act({
                  action: "configure",
                  config: { ...config, enabled: e.target.checked },
                })
              }
            />
            Schedule {config.enabled ? "on" : "off"}
          </label>
          <label>
            <input
              type="checkbox"
              checked={config.auto}
              disabled={saving}
              onChange={(e) =>
                void act({
                  action: "configure",
                  config: { ...config, auto: e.target.checked },
                })
              }
            />
            Auto {config.auto ? "on" : "off"}
          </label>
        </div>
        <small>
          {v.login
            ? `Signed in as ${v.login}`
            : "Refresh to check GitHub login"}
        </small>
      </div>
      <small>
        Auto finds your own green PRs when nothing queued is eligible. Pins win;
        then approval priority and queue order.
      </small>
      <div className="rq-status">
        <div>
          <small>Next run</small>
          <strong>
            {config.enabled
              ? time(Math.max(v.nextAt ?? now, v.spacingUntil))
              : "Schedule paused"}
          </strong>
        </div>
        <div>
          <small>Interval</small>
          <strong>{config.intervalMinutes} minutes</strong>
        </div>
        <div>
          <small>Cooldown / spacing</small>
          <strong>{held ? `Until ${time(v.spacingUntil)}` : "Ready"}</strong>
        </div>
        <div>
          <small>Last run</small>
          <strong>{time(v.lastAt)}</strong>
        </div>
      </div>
      <div>
        <h3>Last outcome</h3>
        <p>{v.lastMessage}</p>
        {latest[0] && (
          <p>
            <small>
              Last trigger: {time(latest[0].at)} ·{" "}
              {latest[0].outcome.replaceAll("_", " ")} ·{" "}
              <a
                className="rq-title"
                href={latest[0].commentUrl ?? latest[0].url}
                target="_blank"
                rel="noreferrer"
              >
                {latest[0].url.split("github.com/")[1]}
              </a>
            </small>
          </p>
        )}
        <small>Picker: {v.lastPicker}</small>
      </div>
      {(error || v.error) && (
        <p role="alert" className="rq-error">
          {error || v.error}
        </p>
      )}
      <form
        className="rq-bar rq-add"
        onSubmit={(e) => {
          e.preventDefault();
          void act({ action: "add", url }).then((ok) => {
            if (ok) {
              setUrl("");
              void act({ action: "refresh" });
            }
          });
        }}
      >
        <input
          aria-label="Pull request URL"
          placeholder="https://github.com/owner/repo/pull/123"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
        <Btn type="submit" disabled={saving || !url.trim()}>
          Add PR
        </Btn>
      </form>
      <div>
        <div className="rq-bar rq-spread">
          <h3>
            Queued PRs <small>({v.entries.length})</small>
          </h3>
          <small>Drag to reorder · pin to choose next</small>
        </div>
        {!v.entries.length ? (
          <div className="rq-empty">
            <h3>Your queue is empty</h3>
            <p>
              Add a PR, or turn on Auto and run a{" "}
              {v.dryRun ? "dry-run" : "check"}.
            </p>
          </div>
        ) : (
          <ol className="rq-list">
            {v.entries.map((e, i) => {
              const f = e.facts;
              const a = assess(e, v.history[e.url] ?? null, v.login, now);
              return (
                <li
                  key={e.url}
                  className="rq-row"
                  data-pinned={e.pinned}
                  data-dragover={over === e.url}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setOver(e.url);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (dragged) reorder(dragged, e.url);
                    setDragged(null);
                    setOver(null);
                  }}
                >
                  <span
                    className="rq-grip"
                    draggable
                    onDragStart={(event) => {
                      setDragged(e.url);
                      event.dataTransfer.setData("text/plain", e.url);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => {
                      setDragged(null);
                      setOver(null);
                    }}
                    aria-label={`Drag PR ${i + 1}`}
                  >
                    ⠿
                  </span>
                  <div>
                    <a
                      className="rq-title"
                      href={e.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {f?.title ?? e.url.split("github.com/")[1]}
                    </a>
                    <div className="rq-meta">
                      <span>
                        {e.url.split("github.com/")[1]?.replace("/pull/", " #")}
                      </span>
                      {f && <span>by {f.author}</span>}
                      <span>
                        {e.auto ? "Auto-discovered" : "Added manually"}
                      </span>
                      {e.pinned && <strong>Pinned next</strong>}
                    </div>
                    {f && (
                      <>
                        <div className="rq-meta">
                          <span className="rq-chip" data-tone={f.ci}>
                            CI {f.ci}
                          </span>
                          <span className="rq-chip">
                            {f.threads} unresolved threads
                          </span>
                          <span className="rq-chip">
                            {f.approvals} human approvals
                          </span>
                          <span
                            className="rq-chip"
                            data-tone={a.eligible ? "pass" : "pending"}
                          >
                            {a.reason}
                          </span>
                        </div>
                        <div className="rq-meta">
                          <span>Head {f.head.slice(0, 7)}</span>
                          <span>
                            CodeRabbit:{" "}
                            {f.lastReview
                              ? `${f.lastReview.head.slice(0, 7)} · ${time(f.lastReview.at)}${f.reviewedHead ? " · current head" : " · older head"}`
                              : "No review yet"}
                          </span>
                          <span>Checked {time(e.fetchedAt)}</span>
                        </div>
                      </>
                    )}
                    {e.error && <p className="rq-error">{e.error}</p>}
                  </div>
                  <div className="rq-actions">
                    <button
                      aria-label={`Move PR ${i + 1} up`}
                      disabled={saving || i === 0}
                      onClick={() => reorder(e.url, v.entries[i - 1]!.url)}
                    >
                      ↑
                    </button>
                    <button
                      aria-label={`Move PR ${i + 1} down`}
                      disabled={saving || i === v.entries.length - 1}
                      onClick={() => reorder(e.url, v.entries[i + 1]!.url)}
                    >
                      ↓
                    </button>
                    <button
                      disabled={saving}
                      aria-pressed={e.pinned}
                      onClick={() => void act({ action: "pin", url: e.url })}
                    >
                      {e.pinned ? "Unpin" : "Pin next"}
                    </button>
                    <button
                      disabled={saving}
                      onClick={() => void act({ action: "remove", url: e.url })}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <details
        onToggle={(e) => {
          if (e.currentTarget.open) setDraft(config);
        }}
      >
        <summary>Queue settings</summary>
        {draft && (
          <form
            className="rq-settings"
            onSubmit={(e) => {
              e.preventDefault();
              void act({ action: "configure", config: draft });
            }}
          >
            <label>
              Interval (minutes)
              <input
                type="number"
                min={60}
                max={10080}
                value={draft.intervalMinutes}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    intervalMinutes: Number(e.target.value),
                  })
                }
              />
            </label>
            <label>
              GitHub host
              <select
                value={draft.hostId}
                onChange={(e) => setDraft({ ...draft, hostId: e.target.value })}
              >
                <option value="">Use the only connected host</option>
                {v.hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Picker provider
              <select
                value={draft.provider}
                onChange={(e) =>
                  setDraft({ ...draft, provider: e.target.value })
                }
              >
                <option value="">Deterministic · no model</option>
                {v.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {draft.provider && (
              <>
                <label>
                  Model ID
                  <input
                    value={draft.model}
                    onChange={(e) =>
                      setDraft({ ...draft, model: e.target.value })
                    }
                    required
                  />
                </label>
                <label>
                  BB project ID
                  <input
                    value={draft.projectId}
                    onChange={(e) =>
                      setDraft({ ...draft, projectId: e.target.value })
                    }
                    required
                  />
                </label>
                <label>
                  BB environment ID
                  <input
                    value={draft.environmentId}
                    onChange={(e) =>
                      setDraft({ ...draft, environmentId: e.target.value })
                    }
                    required
                  />
                </label>
                <small>
                  The picker runs a short BB thread in this environment. It only
                  chooses among eligible candidates; an unavailable model falls
                  back to queue order and approval priority.
                </small>
              </>
            )}
            <div>
              <Btn type="submit" disabled={saving}>
                Save settings
              </Btn>
            </div>
          </form>
        )}
      </details>
      {!!latest.length && (
        <details>
          <summary>Recent triggers</summary>
          <div className="rq-history">
            {latest.slice(0, 20).map((a) => (
              <p key={a.url}>
                {time(a.at)} · {a.outcome.replaceAll("_", " ")} ·{" "}
                {a.head.slice(0, 7)} ·{" "}
                <a
                  href={a.commentUrl ?? a.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {a.url.split("github.com/")[1]}
                </a>
              </p>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
