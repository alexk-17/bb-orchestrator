// Test-only preload for the disposable bb server. Never imported by the plugin.
import { readFileSync } from "node:fs";
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname !== "slack.com") return original(input, init);
  if ((init?.method ?? "GET") !== "GET") throw new Error("Proof forbids Slack writes");
  const state = JSON.parse(readFileSync(process.env.SLACK_WATCH_PROOF_FIXTURE, "utf8"));
  const method = url.pathname.replace("/api/", "");
  const body =
    method === "auth.test"
      ? { team_id: "TPROOF", user_id: "UPROOF", bot_id: "BPROOF" }
      : method === "conversations.info"
        ? { channel: { id: "CPROOF", is_member: true } }
        : method === "conversations.history"
          ? {
              messages: url.searchParams.get("cursor") ? [{ ts: "1.000001", thread_ts: "1.000001", reply_count: 1 }] : [],
              response_metadata: { next_cursor: url.searchParams.get("cursor") ? "" : "second" },
            }
          : method === "conversations.replies"
            ? { messages: state.ts ? [{ ts: state.ts, thread_ts: "1.000001", text: "Synthetic review request", user: "UTEAMMATE" }] : [] }
            : method === "chat.getPermalink"
              ? { permalink: "https://proof.slack.com/archives/CPROOF/p1000001" }
              : null;
  if (!body) throw new Error("Unexpected Slack method in proof");
  return Response.json({ ok: true, ...body });
};
