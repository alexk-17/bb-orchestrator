// Gemini Live on Vertex AI (the BidiGenerateContent WebSocket), behind one small interface so the provider stays
// swappable. Zero data retention as far as the session can choose it: no sessionResumption (Google keeps no session
// state between connections), and the only tools are our own function declarations (no Google Search grounding).
export type LiveConfig = { project: string; location: string; model: string; voice: string };

export type FunctionDeclaration = { name: string; description: string; parameters?: Record<string, unknown> };

/** The provider's events, already decoded. */
export type LiveEvent =
  | { type: "ready" }
  | { type: "audio"; pcm: Uint8Array } // PCM16 mono, 24 kHz
  | { type: "input_text"; text: string } // what the person said, as Google heard it
  | { type: "output_text"; text: string } // what the voice is saying
  | { type: "interrupted" }
  | { type: "turn_complete" }
  | { type: "tool_call"; calls: { id: string; name: string; args: Record<string, unknown> }[] }
  | { type: "tool_cancel"; ids: string[] }
  | { type: "go_away"; timeLeftMs: number | null }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string }
  | { type: "closed"; code: number; reason: string };

/** The minimal WebSocket the adapter needs; the real one is the runtime's, a test passes a fake. */
export interface LiveSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
  onerror: ((message: string) => void) | null;
}
export type LiveSocketFactory = (url: string, headers: Record<string, string>) => LiveSocket;

export function liveUrl(location: string): string {
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return `wss://${host}/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`;
}

export function modelPath(c: LiveConfig): string {
  return `projects/${c.project}/locations/${c.location}/publishers/google/models/${c.model}`;
}

/** The first message on a connection. Deliberately absent: sessionResumption and any googleSearch tool. */
export function setupMessage(c: LiveConfig, systemText: string, tools: FunctionDeclaration[]): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = { responseModalities: ["AUDIO"] };
  if (c.voice.trim()) generationConfig.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: c.voice.trim() } } };
  return {
    setup: {
      model: modelPath(c),
      generationConfig,
      systemInstruction: { parts: [{ text: systemText }] },
      tools: tools.length ? [{ functionDeclarations: tools }] : [],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

function parseDuration(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+(?:\.\d+)?)s$/.exec(v);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

/** One provider message → its events (several can arrive in one message). Unknown fields are ignored. */
export function decode(text: string): LiveEvent[] {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [{ type: "error", message: "the model sent something that isn't JSON" }];
  }
  const out: LiveEvent[] = [];
  if (m.setupComplete !== undefined) out.push({ type: "ready" });
  const sc = m.serverContent as Record<string, unknown> | undefined;
  if (sc) {
    const parts = ((sc.modelTurn as { parts?: unknown[] } | undefined)?.parts ?? []) as { inlineData?: { mimeType?: string; data?: string } }[];
    for (const p of parts) if (p.inlineData?.data && (p.inlineData.mimeType ?? "").startsWith("audio/")) out.push({ type: "audio", pcm: new Uint8Array(Buffer.from(p.inlineData.data, "base64")) });
    const inT = (sc.inputTranscription as { text?: unknown } | undefined)?.text;
    if (typeof inT === "string" && inT) out.push({ type: "input_text", text: inT });
    const outT = (sc.outputTranscription as { text?: unknown } | undefined)?.text;
    if (typeof outT === "string" && outT) out.push({ type: "output_text", text: outT });
    if (sc.interrupted === true) out.push({ type: "interrupted" });
    if (sc.turnComplete === true) out.push({ type: "turn_complete" });
  }
  const tc = m.toolCall as { functionCalls?: { id?: unknown; name?: unknown; args?: unknown }[] } | undefined;
  if (tc?.functionCalls?.length)
    out.push({
      type: "tool_call",
      calls: tc.functionCalls.map((c) => ({ id: String(c.id ?? ""), name: String(c.name ?? ""), args: c.args && typeof c.args === "object" ? (c.args as Record<string, unknown>) : {} })),
    });
  const cancel = m.toolCallCancellation as { ids?: unknown[] } | undefined;
  if (cancel?.ids?.length) out.push({ type: "tool_cancel", ids: cancel.ids.map(String) });
  if (m.goAway !== undefined) out.push({ type: "go_away", timeLeftMs: parseDuration((m.goAway as { timeLeft?: unknown } | null)?.timeLeft) });
  const u = m.usageMetadata as { promptTokenCount?: unknown; responseTokenCount?: unknown } | undefined;
  if (u) out.push({ type: "usage", inputTokens: Number(u.promptTokenCount ?? 0) || 0, outputTokens: Number(u.responseTokenCount ?? 0) || 0 });
  return out;
}

/** Client messages. */
export const audioIn = (pcm16k: Uint8Array) => JSON.stringify({ realtimeInput: { audio: { data: Buffer.from(pcm16k).toString("base64"), mimeType: "audio/pcm;rate=16000" } } });
export const textIn = (text: string) => JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } });
export const toolResponse = (id: string, name: string, response: Record<string, unknown>) => JSON.stringify({ toolResponse: { functionResponses: [{ id, name, response }] } });

/** A short, safe status line for a provider failure: no credential text, and the three cases a person can fix named. */
export function explainClose(code: number, reason: string, c: LiveConfig): string {
  const r = reason.toLowerCase();
  if (code === 1008 && /permission|denied|forbidden|403/.test(r)) return `Vertex AI refused: permission denied. The Google account needs the Vertex AI User role on project ${c.project}.`;
  if (/not found|404|not supported|is not enabled|unsupported model|model/.test(r) && /model|not found|404/.test(r)) return `Model not enabled: ${c.model} isn't available to project ${c.project} in ${c.location}. Check the model name and location in settings.`;
  if (/unauthenticated|401|invalid authentication|credential/.test(r)) return "Vertex AI didn't accept the Google credential: sign in again with `gcloud auth application-default login` on the bb host.";
  if (/api has not been used|disabled|service_disabled/.test(r)) return `The Vertex AI API is off for project ${c.project}: enable aiplatform.googleapis.com.`;
  return `The voice connection closed (${code}${reason ? `: ${reason.slice(0, 160)}` : ""}).`;
}

/** The runtime's own WebSocket client (Node 22's), with the auth headers. */
export const nodeSocket: LiveSocketFactory = (url, headers) => {
  const WS = (globalThis as unknown as { WebSocket: new (u: string, o?: unknown) => WebSocket }).WebSocket;
  const ws = new WS(url, { headers });
  const s: LiveSocket = {
    send: (d) => ws.send(d),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => s.onopen?.();
  ws.onmessage = (ev: MessageEvent) => {
    const d = ev.data as unknown;
    if (typeof d === "string") s.onmessage?.(d);
    else if (d instanceof ArrayBuffer) s.onmessage?.(Buffer.from(d).toString("utf8"));
    else if (d && typeof (d as Blob).text === "function") void (d as Blob).text().then((t) => s.onmessage?.(t));
  };
  ws.onclose = (ev: CloseEvent) => s.onclose?.(ev.code, ev.reason);
  ws.onerror = () => s.onerror?.("the voice connection failed");
  return s;
};
