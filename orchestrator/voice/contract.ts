// Voice mode's contract (voice/README.md): one WebSocket for audio and events, and one status read. Everything voice
// changes on the board goes through the page's existing owner writes (WRITES), so "writes come only from the app's
// screens" stays true: the server only proposes, the page sends.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The voice socket, under the plugin's /http/ namespace. Registered only while voice is on. */
export const VOICE_SOCKET = "/voice/socket";

export const voiceStatusSchema = z.object({
  enabled: z.boolean(),
  /** Ready to start a call: a credential was found and the project is set. */
  ready: z.boolean(),
  /** Why voice can't start, in words for the page's status line; null when it can. */
  problem: z.string().nullable(),
  /** Where the credential came from, never the credential itself. */
  credential: z.enum(["adc-file", "gcloud", "metadata", "setting", "none"]),
  model: z.string(),
  voice: z.string(),
});
export type VoiceStatus = z.infer<typeof voiceStatusSchema>;

export const voiceContract = defineRpcContract({
  voiceStatus: { input: z.null(), output: voiceStatusSchema },
});

/** The owner writes a proposal may name (contract.ts WRITES), and only these. */
export const PROPOSAL_ROUTES = ["answer", "defer", "directMessage", "cosMessage", "approve", "requestChanges", "priority", "hold", "startLead"] as const;
export type ProposalRoute = (typeof PROPOSAL_ROUTES)[number];

/** A tap-only write (merge, production, money, secrets): the page shows `readback` on a card, and a tap sends `body` to `route`. */
export const proposalSchema = z.object({
  id: z.string(),
  route: z.enum(PROPOSAL_ROUTES),
  body: z.record(z.string(), z.unknown()),
  /** What the card says it will do. */
  readback: z.string(),
  /** Always true for a card: only a tap sends it. */
  tapOnly: z.boolean(),
  /** The card it acts on, for the page to point at. */
  cardId: z.string().nullable(),
  expiresAt: z.number(),
});
export type Proposal = z.infer<typeof proposalSchema>;

/** Server → page, as JSON text frames. Audio goes as binary frames (PCM16, 24 kHz, mono). */
export type ServerEvent =
  | { type: "status"; state: "connecting" | "live" | "swapping" | "ended" | "error"; message: string | null }
  | { type: "transcript"; who: "you" | "voice"; text: string }
  | { type: "interrupted" }
  | { type: "proposal"; proposal: Proposal }
  | { type: "proposal_gone"; id: string; reason: "sent" | "cancelled" | "expired" | "replaced" }
  /** Send it now: the owner's spoken command, an ask to the Chief, or a tapped card. */
  | { type: "send"; id: string; route: ProposalRoute; body: Record<string, unknown>; grace: boolean }
  | { type: "show"; cardId: string }
  /** An action that just went through, in one past-tense line, for the transcript. */
  | { type: "done"; text: string }
  | { type: "summary"; text: string };

/** Page → server, as JSON text frames. Microphone audio goes as binary frames (PCM16, 16 kHz, mono). */
export const clientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), id: z.string().max(80) }).strict(),
  z.object({ type: z.literal("cancel"), id: z.string().max(80) }).strict(),
  z.object({ type: z.literal("sent"), id: z.string().max(80), ok: z.boolean(), message: z.string().max(500).nullable() }).strict(),
  z.object({ type: z.literal("hangup") }).strict(),
  /** The page's mic, once capture starts: for diagnosis only, no device names. */
  z
    .object({
      type: z.literal("mic"),
      contextRate: z.number(),
      trackRate: z.number().nullable(),
      trackState: z.string().max(20),
      muted: z.boolean(),
      enabled: z.boolean(),
    })
    .strict(),
]);
export type ClientEvent = z.infer<typeof clientEventSchema>;
