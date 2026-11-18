// Voice mode's server side (voice/README.md). Off by default: while voiceEnabled is off at load, nothing is
// registered, so the socket path is a 404 and the status read doesn't exist. When on, one WebSocket carries a call, with
// the same guard as the owner's writes: bb's "local" auth plus the page's own Origin (and a same-origin Sec-Fetch-Site).
// The Google credential stays here: never sent to the page, returned by a read, put in an error, or logged.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Engine } from "../core/engine.ts";
import { clientEventSchema, VOICE_SOCKET, voiceContract, type ServerEvent, type VoiceStatus } from "./contract.ts";
import { CredentialError, googleAuth, type CredentialSource } from "./google-auth.ts";
import { nodeSocket, type LiveSocketFactory } from "./gemini.ts";
import { voicePorts } from "./ports.ts";
import { redact } from "./redact.ts";
import { VoiceSession } from "./session.ts";
import { defineVoiceSettings, type VoiceSettings } from "./settings.ts";
import { buildSnapshot } from "./snapshot.ts";

export type VoiceDeps = {
  engine: Engine;
  ownerName: () => string;
  /** Why a request isn't from the app's own page, or null (server.ts writeOriginProblem with the app's URLs). */
  originProblem: (h: { origin: string | undefined; secFetchSite: string | undefined; requestUrl: string }) => string | null;
  /** Tests pass a fake provider socket and auth. */
  socket?: LiveSocketFactory;
  auth?: Parameters<typeof googleAuth>[0];
};

const ZONE = /^[A-Za-z0-9_+\-/]{1,64}$/;

export async function registerVoice(bb: BbPluginApi, deps: VoiceDeps): Promise<{ sessions: () => number } | null> {
  const settings = defineVoiceSettings(bb);
  let cfg = (await settings.get()) as VoiceSettings;
  settings.onChange((next) => {
    const was = cfg.voiceEnabled;
    cfg = next as VoiceSettings;
    if (was !== cfg.voiceEnabled) bb.log.info(`voice: voiceEnabled is now ${cfg.voiceEnabled ? "on" : "off"}; ${cfg.voiceEnabled ? "reload the plugin to start the voice routes" : "calls are refused until then, and the routes go at the next reload"}`);
  });
  if (!cfg.voiceEnabled) return null; // off: no route, no read

  const auth = googleAuth(deps.auth ?? { setting: () => cfg.voiceCredential ?? "", metadata: true });
  const secrets = () => [cfg.voiceCredential ?? "", ...auth.secrets()];
  const log = (level: "info" | "warn", line: string) => bb.log[level](redact(line, secrets()));
  const ports = voicePorts(deps.engine, deps.ownerName);
  const sessions = new Set<VoiceSession>();
  let lastProblem: { message: string; at: number } | null = null;

  const credentialLabel = (): VoiceStatus["credential"] => {
    try {
      const f = auth.locate();
      return (f?.source ?? "none") as CredentialSource as VoiceStatus["credential"];
    } catch {
      return "none";
    }
  };

  /** Why voice can't start now, in words a person can act on; null when it can. Never the credential. */
  async function problem(): Promise<string | null> {
    if (!cfg.voiceEnabled) return "Voice is off: turn on voiceEnabled in the orchestrator's settings, then reload the plugin.";
    if (!cfg.voiceProject.trim()) return "Set voiceProject (your Google Cloud project ID) in the orchestrator's settings.";
    try {
      await auth.token();
    } catch (e) {
      return e instanceof CredentialError ? redact(e.message, secrets()) : "Couldn't get a Google credential on the bb host.";
    }
    if (lastProblem && Date.now() - lastProblem.at < 10 * 60_000) return lastProblem.message;
    return null;
  }

  bb.rpc.register(voiceContract, {
    voiceStatus: async (): Promise<VoiceStatus> => {
      const why = await problem();
      return { enabled: cfg.voiceEnabled, ready: why === null, problem: why, credential: credentialLabel(), model: cfg.voiceModel, voice: cfg.voiceName };
    },
  });

  bb.http.experimental_websocket(
    VOICE_SOCKET,
    (ctx) => {
      const refused = !cfg.voiceEnabled
        ? "voice is off"
        : deps.originProblem({ origin: ctx.headers.get("origin") ?? undefined, secFetchSite: ctx.headers.get("sec-fetch-site") ?? undefined, requestUrl: ctx.url.href });
      const zoneParam = ctx.url.searchParams.get("zone") ?? "";
      const zone = ZONE.test(zoneParam) ? zoneParam : "UTC";
      let session: VoiceSession | null = null;
      const send = (sock: { send(d: string | Uint8Array): void; readyState: number }, e: ServerEvent | Uint8Array) => {
        if (sock.readyState !== 1) return;
        sock.send(e instanceof Uint8Array ? e : JSON.stringify(e));
      };
      return {
        async onOpen(sock) {
          if (refused) {
            log("warn", `voice: refused a call (${refused})`);
            send(sock, { type: "status", state: "error", message: `Refused: ${refused}` });
            sock.close(1008, "refused");
            return;
          }
          const why = await problem();
          if (why) {
            send(sock, { type: "status", state: "error", message: why });
            sock.close(1011, "can't start");
            return;
          }
          const s = new VoiceSession({
            config: { project: cfg.voiceProject.trim(), location: cfg.voiceLocation.trim() || "us-central1", model: cfg.voiceModel.trim(), voice: cfg.voiceName.trim() },
            token: async () => {
              const t = await auth.token();
              return { token: t.token, quotaProject: t.quotaProject };
            },
            socket: deps.socket ?? nodeSocket,
            reads: ports.reads,
            snapshot: () => buildSnapshot(ports.board(Date.now()), Date.now()),
            ownerName: deps.ownerName(),
            zone,
            toPage: (e) => {
              if (!(e instanceof Uint8Array) && e.type === "status" && e.state === "error" && e.message) lastProblem = { message: e.message, at: Date.now() };
              if (!(e instanceof Uint8Array) && e.type === "status" && e.state === "live") lastProblem = null;
              send(sock, e);
              if (!(e instanceof Uint8Array) && e.type === "status" && e.state === "ended") {
                sessions.delete(s);
                if (sock.readyState === 1) sock.close(1000, "ended");
              }
            },
            rates: { inputUsdPerMillion: cfg.voiceInputUsdPerMillion, outputUsdPerMillion: cfg.voiceOutputUsdPerMillion },
            log: (line) => log("info", line),
            secrets,
          });
          session = s;
          sessions.add(s);
          log("info", "voice: a call started");
          await s.start();
        },
        onMessage(_sock, data) {
          if (!session) return;
          if (typeof data !== "string") {
            session.audio(data);
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            return;
          }
          const ev = clientEventSchema.safeParse(parsed);
          if (ev.success) session.fromPage(ev.data);
        },
        onClose() {
          if (session && !session.isEnded) session.end("closed");
          if (session) sessions.delete(session);
          session = null;
        },
        onError(_sock, e) {
          log("warn", `voice: page socket error: ${e.message}`);
        },
      };
    },
    { auth: "local" },
  );

  // The Chief of Staff's answer to a voice question: its last message when its thread goes idle
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (!sessions.size || thread.id !== ports.cosThreadId() || !lastAssistantText) return;
    for (const s of sessions) s.chiefReplied(lastAssistantText);
  });

  bb.onDispose(() => {
    for (const s of sessions) s.end("closed");
    sessions.clear();
  });
  log("info", "voice: on");
  return { sessions: () => sessions.size };
}
