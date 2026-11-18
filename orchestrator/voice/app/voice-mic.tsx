// The mic beside the Chief of Staff box (voice/README.md). Drawn only while the voice read exists, which is only while
// voiceEnabled is on. The mic is live only after a click (until hang-up) or while Space is held; Esc or a click hangs
// up. Writes are the page's own: when the server says "send", this posts to the owner route the proposal names.
import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { Mic, PhoneOff } from "lucide-react";
import { WRITE_BASE, WRITES } from "../../contract.ts";
import { stage } from "../../app/store.ts";
import { Btn, cx } from "../../app/ui.tsx";
import { VOICE_SOCKET, voiceContract, type Proposal, type ProposalRoute, type ServerEvent } from "../contract.ts";
import { startCapture, startPlayer, type Capture, type Player } from "./audio.ts";
import { micLive, onClick, onKey, type MicAction, type MicState } from "./keys.ts";

const GRACE_MS = 3000;
const BARGE_IN_PEAK = 0.12;
type Line = { who: "you" | "voice"; text: string };
type Pending = { proposal: Proposal; sending: boolean };

function socketUrl(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${WRITE_BASE}${VOICE_SOCKET}?zone=${encodeURIComponent(zone)}`;
}

export function VoiceMic({ disabled = false }: { disabled?: boolean }) {
  const status = experimental_useRpcQuery({ contract: voiceContract, method: "voiceStatus", input: null });
  const [mic, setMic] = useState<MicState>({ call: "off", mode: null, spaceDown: false });
  const [state, setState] = useState<string>("off");
  const [problem, setProblem] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [grace, setGrace] = useState<{ id: string; until: number } | null>(null);
  const [cost, setCost] = useState<{ usd: number; seconds: number }>({ usd: 0, seconds: 0 });
  const ws = useRef<WebSocket | null>(null);
  const cap = useRef<Capture | null>(null);
  const player = useRef<Player | null>(null);
  const micRef = useRef(mic);
  micRef.current = mic;
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendJson = (e: unknown) => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify(e));

  const hangup = useCallback(() => {
    sendJson({ type: "hangup" });
    cap.current?.stop();
    cap.current = null;
    player.current?.close();
    player.current = null;
    setMic({ call: "off", mode: null, spaceDown: false });
    setPending(null);
    setGrace(null);
  }, []);

  /** Post a write the server let through, then tell it how that went. */
  const post = useCallback(async (id: string, route: ProposalRoute, body: Record<string, unknown>) => {
    const out = await stage(WRITES[route], body);
    sendJson({ type: "sent", id, ok: out.ok, message: out.ok ? null : out.message.slice(0, 500) });
  }, []);

  const onEvent = useCallback(
    (e: ServerEvent) => {
      switch (e.type) {
        case "status":
          setState(e.state);
          if (e.message) setProblem(e.message);
          if (e.state === "live") setProblem(null);
          if (e.state === "ended" || e.state === "error") {
            cap.current?.stop();
            cap.current = null;
            setMic({ call: "off", mode: null, spaceDown: false });
          }
          return;
        case "transcript":
          setLines((cur) => {
            const last = cur[cur.length - 1];
            const next = last && last.who === e.who ? [...cur.slice(0, -1), { who: e.who, text: `${last.text}${e.who === "voice" ? "" : " "}${e.text}`.replace(/\s+/g, " ") }] : [...cur, { who: e.who, text: e.text.trim() }];
            return next.slice(-40);
          });
          return;
        case "interrupted":
          player.current?.stop();
          return;
        case "proposal":
          setPending({ proposal: e.proposal, sending: false });
          return;
        case "proposal_gone":
          setPending((p) => (p?.proposal.id === e.id ? null : p));
          return;
        case "send":
          if (!e.grace) {
            void post(e.id, e.route, e.body);
            return;
          }
          setPending((p) => (p?.proposal.id === e.id ? { ...p, sending: true } : p));
          setGrace({ id: e.id, until: Date.now() + GRACE_MS });
          if (graceTimer.current) clearTimeout(graceTimer.current);
          graceTimer.current = setTimeout(() => {
            setGrace(null);
            void post(e.id, e.route, e.body);
          }, GRACE_MS);
          return;
        case "show":
          document.querySelector(`[data-card="${CSS.escape(e.cardId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        case "cost":
          setCost({ usd: e.usd, seconds: e.seconds });
          return;
        case "summary":
          // the call's record, into the Chief of Staff's thread as the owner's own message
          void stage(WRITES.cosMessage, { text: e.text.slice(0, 8000) });
          return;
      }
    },
    [post],
  );

  const start = useCallback(
    async (mode: "open" | "hold") => {
      setProblem(null);
      setLines([]);
      setState("connecting");
      setMic({ call: "on", mode, spaceDown: mode === "hold" });
      player.current = startPlayer();
      const sock = new WebSocket(socketUrl());
      sock.binaryType = "arraybuffer";
      ws.current = sock;
      sock.onmessage = (m) => {
        if (typeof m.data === "string") {
          try {
            onEvent(JSON.parse(m.data) as ServerEvent);
          } catch {
            // not an event: ignored
          }
        } else player.current?.play(m.data as ArrayBuffer);
      };
      sock.onclose = () => {
        cap.current?.stop();
        cap.current = null;
        player.current?.close();
        player.current = null;
        setMic({ call: "off", mode: null, spaceDown: false });
        setState((s) => (s === "error" ? s : "ended"));
      };
      try {
        cap.current = await startCapture((pcm, peak) => {
          if (!micLive(micRef.current)) return;
          // barge-in: talking over the voice silences it at once, before the server hears it
          if (peak > BARGE_IN_PEAK && player.current?.playing) player.current.stop();
          if (sock.readyState === WebSocket.OPEN) sock.send(pcm);
        });
      } catch (e) {
        setProblem(`The microphone isn't available: ${e instanceof Error ? e.message : String(e)}`);
        sock.close();
      }
    },
    [onEvent],
  );

  const act = useCallback(
    (a: MicAction) => {
      if (a === "start-open") void start("open");
      else if (a === "start-hold") void start("hold");
      else if (a === "mic-on") setMic((m) => ({ ...m, spaceDown: true }));
      else if (a === "mic-off") setMic((m) => ({ ...m, spaceDown: false }));
      else if (a === "hangup") hangup();
    },
    [start, hangup],
  );

  const enabled = !!status.data?.enabled;
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      const a = onKey(micRef.current, { type: e.type as "keydown" | "keyup", key: e.key, repeat: e.repeat, target: e.target });
      if (!a) return;
      e.preventDefault();
      act(a);
    };
    window.addEventListener("keydown", h);
    window.addEventListener("keyup", h);
    return () => {
      window.removeEventListener("keydown", h);
      window.removeEventListener("keyup", h);
    };
  }, [enabled, act]);
  useEffect(() => () => hangup(), [hangup]);

  if (!enabled) return null; // off (the read doesn't exist), or not loaded yet
  const ready = status.data?.ready ?? false;
  const why = problem ?? (ready ? null : status.data?.problem ?? null);
  const on = mic.call === "on";
  const live = micLive(mic);
  const mm = `${Math.floor(cost.seconds / 60)}:${String(cost.seconds % 60).padStart(2, "0")}`;

  return (
    <>
      <Btn
        tone={on ? "primary" : "ghost"}
        className={cx("flex-none", live && "ring-2 ring-(--orch-danger)")}
        data-voice-mic=""
        aria-pressed={on}
        aria-label={on ? "Hang up the voice call" : "Talk to the board (or hold Space)"}
        title={why ?? (on ? "Hang up (Esc)" : "Talk (click, or hold Space)")}
        disabled={disabled || (!ready && !on)}
        onClick={() => act(onClick(micRef.current))}
        icon={on ? <PhoneOff size={16} /> : <Mic size={16} />}
      />
      {why && !on ? (
        <span role="status" data-voice-problem="" className="orch-danger max-w-56 self-center text-xs">
          {why}
        </span>
      ) : null}
      {on || lines.length || (why && state === "error") ? (
        <aside data-voice-panel="" aria-live="polite" className="fixed right-4 bottom-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-xl border bg-background p-3 text-sm shadow-lg">
          <header className="flex items-center gap-2">
            <span className={cx("size-2 rounded-full", live ? "bg-(--orch-danger)" : on ? "bg-green-600" : "bg-muted-foreground")} aria-hidden />
            <span className="flex-1">
              {state === "connecting" ? "Connecting…" : state === "swapping" ? "Live" : state === "live" ? (live ? "Listening" : mic.mode === "hold" ? "Hold Space to talk" : "Live") : state === "error" ? "Voice stopped" : "Call ended"}
            </span>
            <span data-voice-cost="" className="orch-muted tabular-nums">
              {mm} · ~${cost.usd.toFixed(2)}
            </span>
            {on ? (
              <Btn tone="danger" size="sm" onClick={hangup} data-voice-hangup="">
                Hang up
              </Btn>
            ) : (
              <Btn tone="ghost" size="sm" onClick={() => setLines([])}>
                Close
              </Btn>
            )}
          </header>
          {why ? <p className="orch-danger m-0 text-xs">{why}</p> : null}
          {pending ? (
            <div data-voice-confirm="" data-tap-only={pending.proposal.tapOnly ? "" : undefined} className="rounded-lg border p-2">
              <p className="m-0">{pending.proposal.readback.replace(/\s*Say yes to send\.$/, "")}</p>
              <div className="mt-2 flex items-center gap-2">
                {grace?.id === pending.proposal.id ? (
                  <>
                    <span className="orch-muted flex-1 text-xs">Sending…</span>
                    <Btn
                      size="sm"
                      onClick={() => {
                        if (graceTimer.current) clearTimeout(graceTimer.current);
                        setGrace(null);
                        sendJson({ type: "sent", id: pending.proposal.id, ok: false, message: "cancelled on the page" });
                      }}
                    >
                      Cancel
                    </Btn>
                  </>
                ) : (
                  <>
                    <span className="orch-muted flex-1 text-xs">{pending.proposal.tapOnly ? "Needs your tap." : 'Say "yes", or tap.'}</span>
                    <Btn size="sm" tone="primary" disabled={pending.sending} onClick={() => sendJson({ type: "tap", id: pending.proposal.id })} data-voice-tap="">
                      Send
                    </Btn>
                    <Btn size="sm" disabled={pending.sending} onClick={() => sendJson({ type: "cancel", id: pending.proposal.id })}>
                      Cancel
                    </Btn>
                  </>
                )}
              </div>
            </div>
          ) : null}
          <ol data-voice-transcript="" className="m-0 flex max-h-64 list-none flex-col gap-1 overflow-y-auto p-0">
            {lines.map((l, i) => (
              <li key={i} className={cx(l.who === "you" ? "text-right" : "orch-muted")}>
                {l.text}
              </li>
            ))}
          </ol>
        </aside>
      ) : null}
    </>
  );
}
