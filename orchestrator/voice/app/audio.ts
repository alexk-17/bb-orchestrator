// The page's audio: the mic as PCM16 at 16 kHz (an AudioWorklet, with the browser's echo cancellation and noise
// suppression on), and the voice's PCM16 at 24 kHz played gaplessly, cut at once on barge-in.

const WORKLET = `
class Pcm16 extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(640); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let peak = 0;
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      if (Math.abs(v) > peak) peak = Math.abs(v);
      this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === this.buf.length) {
        this.port.postMessage({ pcm: this.buf.buffer.slice(0), peak });
        this.n = 0; peak = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm16-capture", Pcm16);
`;

export type Capture = { stop(): void; info: () => { contextRate: number; trackRate: number | null; trackState: string; muted: boolean; enabled: boolean } };

/** Start the mic. `onFrame` gets 40 ms of PCM16 and its peak level (0..1). */
export async function startCapture(onFrame: (pcm: ArrayBuffer, peak: number) => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  const ctx = new AudioContext({ sampleRate: 16_000 });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm16-capture");
  node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; peak: number }>) => onFrame(e.data.pcm, e.data.peak);
  src.connect(node);
  // a node with no path to the destination may never be run: route it out through a muted gain
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);
  const track = stream.getAudioTracks()[0];
  return {
    info: () => ({
      contextRate: ctx.sampleRate,
      trackRate: track?.getSettings().sampleRate ?? null,
      trackState: track?.readyState ?? "none",
      muted: track?.muted ?? true,
      enabled: track?.enabled ?? false,
    }),
    stop() {
      node.port.onmessage = null;
      src.disconnect();
      node.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

export type Player = { play(pcm: ArrayBuffer): void; stop(): void; close(): void; readonly playing: boolean };

/** The voice's speaker: frames are queued back to back; stop() drops everything queued (barge-in). */
export function startPlayer(): Player {
  const ctx = new AudioContext({ sampleRate: 24_000 });
  let next = 0;
  const live = new Set<AudioBufferSourceNode>();
  return {
    play(pcm) {
      const i16 = new Int16Array(pcm);
      if (!i16.length) return;
      const buf = ctx.createBuffer(1, i16.length, 24_000);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < i16.length; i++) ch[i] = i16[i]! / 0x8000;
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(ctx.destination);
      const at = Math.max(next, ctx.currentTime + 0.02);
      node.start(at);
      next = at + buf.duration;
      live.add(node);
      node.onended = () => live.delete(node);
    },
    stop() {
      for (const n of live) {
        try {
          n.stop();
        } catch {
          // already ended
        }
      }
      live.clear();
      next = 0;
    },
    close() {
      this.stop();
      void ctx.close();
    },
    get playing() {
      return live.size > 0;
    },
  };
}
