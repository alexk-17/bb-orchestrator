// Voice mode's settings: off by default, and nothing in them is tied to one person or server. The project, location,
// model and voice are each server's own; the credential is optional (Application Default Credentials come first).
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const VOICE_SETTINGS = {
  voiceEnabled: {
    type: "boolean",
    label: "Voice mode (off by default)",
    description: "A mic button beside the Chief of Staff box: talk to your board through Gemini Live on Vertex AI. Turning it on or off takes a plugin reload. See voice/README.md.",
    default: false,
  },
  voiceProject: { type: "string", label: "Voice: Google Cloud project ID", description: "The project whose Vertex AI the voice uses. Empty: voice can't start.", default: "" },
  voiceLocation: { type: "string", label: "Voice: Vertex AI location", description: "A region such as us-central1, or global.", default: "us-central1" },
  voiceModel: { type: "string", label: "Voice: Live model", description: "A Gemini Live model your project can use.", default: "gemini-3.8-live" },
  voiceName: { type: "string", label: "Voice: speaking voice", description: "A prebuilt Gemini voice name. Empty: the model's default voice.", default: "Erinome" },
  voiceLanguage: { type: "string", label: "Voice: language (BCP-47, e.g. en-US)", description: "What the voice listens for and speaks. Default en-US.", default: "en-US" },
  voiceSensitivity: { type: "string", label: "Voice: how easily it hears you start talking (low, medium or high)", description: "Low (the default) ignores more background noise; high catches quiet speech sooner.", default: "low" },
  voiceCredential: {
    type: "string",
    secret: true,
    label: "Voice: service-account key",
    description: "Paste your team's service-account JSON key (a service account with only the Vertex AI User role). Kept by bb in a 0600 file, read only by the server, never sent to the page or logged. Empty: the bb host's own Application Default Credentials (gcloud auth application-default login) are used instead.",
  },
} as const;

export type VoiceSettings = {
  voiceEnabled: boolean;
  voiceProject: string;
  voiceLocation: string;
  voiceModel: string;
  voiceName: string;
  voiceSensitivity: string;
  voiceLanguage: string;
  voiceCredential?: string;
};

export function defineVoiceSettings(bb: BbPluginApi) {
  return bb.settings.define(VOICE_SETTINGS);
}
