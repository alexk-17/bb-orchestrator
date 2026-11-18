// The mic beside the Chief of Staff box (voice/README.md). Drawn only while the voice read exists, which is only while
// voiceEnabled is on. The mic is live only after a click (until hang-up) or while Space is held; Esc or a click hangs
// up. Writes are the page's own: when the server says "send", this posts to the owner route the proposal names.
// It is the same plain icon button as the attach button beside it: a spinner while connecting, a small pulsing dot and
// the call's m:ss while live. Its popover (portalled, fixed) opens above it when there's room, else below, and holds
// only what's needed.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { Check, Loader2, Mic, MicOff, X } from "lucide-react";
import { WRITE_BASE, WRITES } from "../../contract.ts";
import { stage } from "../../app/store.ts";
import { Button } from "../../app/ui/button.tsx";
import { cx } from "../../app/ui.tsx";
import { VOICE_SOCKET, voiceContract, type Proposal, type ProposalRoute, type ServerEvent } from "../contract.ts";
import { startCapture, startPlayer, type Capture, type Player } from "./audio.ts";
import { micLive, onClick, onKey, type MicAction, type MicState } from "./keys.ts";

const GRACE_MS = 3000;
const BARGE_IN_PEAK = 0.12;
const SHOWN_LINES = 6;
type Line = { who: "you" | "voice" | "done"; text: string };
type Pending = { proposal: Proposal; sending: boolean };

function socketUrl(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${WRITE_BASE}${VOICE_SOCKET}?zone=${encodeURIComponent(zone)}`;
}

/** m:ss */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function VoiceMic({ disabled = false }: { disabled?: boolean }) {
  const status = experimental_useRpcQuery({ contract: voiceContract, method: "voiceStatus", input: null });
  const [mic, setMic] = useState<MicState>({ call: "off", mode: null, spaceDown: false });
  const [state, setState] = useState<string>("off");
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [grace, setGrace] = useState<string | null>(null);
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const ws = useRef<WebSocket | null>(null);
  const cap = useRef<Capture | null>(null);
  const player = useRef<Player | null>(null);
  const micRef = useRef(mic);
  micRef.current = mic;
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchor = useRef<HTMLSpanElement | null>(null);
  const [place, setPlace] = useState<{ side: "above" | "below"; edge: number; right: number; maxHeight: number } | null>(null);

  const sendJson = (e: unknown) => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify(e));

  const stopAudio = () => {
    cap.current?.stop();
    cap.current = null;
    player.current?.close();
    player.current = null;
  };

  const hangup = useCallback(() => {
    sendJson({ type: "hangup" });
    stopAudio();
    setMic({ call: "off", mode: null, spaceDown: false });
    setPending(null);
    setGrace(null);
    setOpen(false);
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
          if (e.state === "live") {
            setProblem(null);
            setSince((s) => s ?? Date.now());
          }
          if (e.state === "ended" || e.state === "error") {
            stopAudio();
            setMic({ call: "off", mode: null, spaceDown: false });
            setPending(null);
            if (e.state === "ended") setOpen(false);
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
          setOpen(true);
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
          setGrace(e.id);
          if (graceTimer.current) clearTimeout(graceTimer.current);
          graceTimer.current = setTimeout(() => {
            setGrace(null);
            void post(e.id, e.route, e.body);
          }, GRACE_MS);
          return;
        case "show":
          document.querySelector(`[data-card="${CSS.escape(e.cardId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        case "done":
          // an action that went through: one line in the transcript
          setLines((cur) => [...cur, { who: "done" as const, text: e.text }].slice(-40));
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
      setPending(null);
      setSince(null);
      setState("connecting");
      setOpen(true);
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
        stopAudio();
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
        setState("error");
        sock.close();
      }
    },
    [onEvent],
  );

  const ready = status.data?.ready ?? false;
  const act = useCallback(
    (a: MicAction) => {
      if ((a === "start-open" || a === "start-hold") && !ready) {
        // can't start: say why, right above the mic
        setProblem(null);
        setState("off");
        setOpen(true);
        return;
      }
      if (a === "start-open") void start("open");
      else if (a === "start-hold") void start("hold");
      else if (a === "mic-on") setMic((m) => ({ ...m, spaceDown: true }));
      else if (a === "mic-off") setMic((m) => ({ ...m, spaceDown: false }));
      else if (a === "hangup") hangup();
    },
    [start, hangup, ready],
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
  const on = mic.call === "on";
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);

  // Where the popover goes: above the mic when there's room (or more room than below), else below; right-aligned to the
  // composer; never taller than the room it has, scrolling inside instead.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const a = anchor.current;
      if (!a) return;
      const r = a.getBoundingClientRect();
      const box = (a.closest("[data-cos-composer]") ?? a).getBoundingClientRect();
      const gap = 8;
      const above = r.top - gap * 2;
      const below = window.innerHeight - r.bottom - gap * 2;
      const side = above >= 180 || above > below ? "above" : "below";
      setPlace({
        side,
        edge: side === "above" ? window.innerHeight - r.top + gap : r.bottom + gap,
        right: Math.max(gap, window.innerWidth - box.right),
        maxHeight: Math.max(120, Math.min(360, side === "above" ? above : below)),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, on, lines.length, pending, problem]);

  if (!enabled) return null; // off (the read doesn't exist), or not loaded yet
  const live = micLive(mic);
  const connecting = on && state === "connecting";
  const why = problem ?? (!on && !ready ? status.data?.problem ?? null : null);
  const label = connecting ? "Connecting…" : on ? (live ? "Listening" : mic.mode === "hold" ? "Hold Space to talk" : "Live") : why ? "Voice can't start" : "Call ended";
  const shown = lines.slice(-SHOWN_LINES);
  const showPanel = open && !!(on || why || pending || shown.length);
  // The popover is portalled into the plugin's root (its theme and styles) and placed with fixed coordinates, so no
  // scrolling or clipping parent can cut it: above the mic when there's room, else below; right-aligned to the composer.
  const root = anchor.current?.closest<HTMLElement>("[data-orch]") ?? null;

  return (
    <span ref={anchor} className="relative mt-1.5 flex flex-none items-center gap-1" data-voice="" data-state={connecting ? "connecting" : on ? "live" : "idle"}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-voice-mic=""
        aria-pressed={on}
        aria-label={on ? "Hang up the voice call" : "Talk to the board (or hold Space)"}
        title={on ? "Hang up (Esc)" : "Talk (click, or hold Space)"}
        disabled={disabled}
        onClick={() => act(onClick(micRef.current))}
        className="group relative"
      >
        {connecting ? (
          <Loader2 aria-hidden className="animate-spin" />
        ) : on ? (
          <>
            <Mic aria-hidden className="group-hover:hidden" />
            <MicOff aria-hidden className="hidden group-hover:block" />
          </>
        ) : (
          <Mic aria-hidden />
        )}
        {on && !connecting ? <span aria-hidden className={cx("pointer-events-none absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary", live && "animate-pulse")} /> : null}
      </Button>
      {on && !connecting && since !== null ? (
        <span data-voice-timer="" className="text-xs text-muted-foreground tabular-nums">
          {clock(now - since)}
        </span>
      ) : null}
      {showPanel && root && place ? createPortal(
        <div
          data-voice-panel=""
          data-side={place.side}
          role="dialog"
          aria-label="Voice"
          aria-live="polite"
          style={{ position: "fixed", right: place.right, maxHeight: place.maxHeight, ...(place.side === "above" ? { bottom: place.edge } : { top: place.edge }) }}
          className="z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-y-auto rounded-md border bg-popover p-2 text-xs text-popover-foreground shadow-md"
        >
          <div className="flex items-center gap-2">
            <span aria-hidden className={cx("size-1.5 flex-none rounded-full", on && !connecting ? "bg-primary" : "bg-muted-foreground", live && "animate-pulse")} />
            <span className="flex-1 truncate text-muted-foreground">{label}</span>
            {on ? (
              <Button type="button" variant="ghost" size="xs" onClick={hangup} data-voice-hangup="">
                Hang up
              </Button>
            ) : (
              <Button type="button" variant="ghost" size="icon-xs" aria-label="Close" onClick={() => setOpen(false)}>
                <X aria-hidden />
              </Button>
            )}
          </div>
          {why ? (
            <p data-voice-problem="" className="m-0 text-(--orch-danger)">
              {why}
            </p>
          ) : null}
          {pending ? (
            <div data-voice-confirm="" data-tap-only="" className="flex flex-col gap-2 rounded-md border p-2">
              <p className="m-0 text-sm">{pending.proposal.readback}</p>
              <div className="flex items-center gap-2">
                <span className="flex-1 text-muted-foreground">Needs your tap</span>
                <Button type="button" variant="ghost" size="xs" disabled={pending.sending} onClick={() => sendJson({ type: "cancel", id: pending.proposal.id })}>
                  Dismiss
                </Button>
                <Button type="button" size="xs" disabled={pending.sending} onClick={() => sendJson({ type: "tap", id: pending.proposal.id })} data-voice-tap="">
                  Send
                </Button>
              </div>
            </div>
          ) : null}
          {shown.length ? (
            <ol data-voice-transcript="" className="m-0 flex max-h-40 list-none flex-col gap-1 overflow-y-auto p-0">
              {shown.map((l, i) => (
                <li key={i} data-who={l.who} className={l.who === "you" ? "text-foreground" : l.who === "done" ? "flex gap-1 text-foreground" : "text-muted-foreground"}>
                  {l.who === "done" ? (
                    <>
                      <Check aria-hidden className="mt-0.5 size-3 flex-none text-primary" />
                      <span>{l.text}</span>
                    </>
                  ) : (
                    l.text
                  )}
                </li>
              ))}
            </ol>
          ) : null}
        </div>,
        root,
      ) : null}
    </span>
  );
}
