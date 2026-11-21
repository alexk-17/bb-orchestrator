// Voice mode's settings: off by default, and nothing in them points at any account. Each person brings their own
// credential: their own Gemini API key (the simplest: no Cloud project), or their own Google login or service-account
// key on Vertex AI in their own project. The key and the project have no defaults.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const VOICE_SETTINGS = {
  voiceEnabled: {
    type: "boolean",
    label: "Voice mode (off by default)",
    description: "A mic button in Home's header: talk to your board through Gemini Live, with your own Gemini API key or your own Google Cloud project. Turning it on or off takes a plugin reload. See voice/README.md.",
    default: false,
  },
  voiceApiKey: {
    type: "string",
    secret: true,
    label: "Voice: Gemini API key",
    description: "Your own Gemini API key, from Google AI Studio: the simplest setup, no Google Cloud project needed. When set, voice uses the Gemini API with it, and the Vertex AI settings below are ignored. Kept by bb in a 0600 file, read only by the server, never sent to the page or logged.",
  },
  voiceProject: { type: "string", label: "Voice: Google Cloud project ID", description: "Vertex AI only (not needed with a Gemini API key): your own project, with the Vertex AI API on.", default: "" },
  voiceLocation: { type: "string", label: "Voice: Vertex AI location", description: "Vertex AI only: a region such as us-central1, or global.", default: "us-central1" },
  voiceModel: { type: "string", label: "Voice: Live model", description: "A Gemini Live model your key or project can use.", default: "gemini-3.8-live" },
  voiceName: { type: "string", label: "Voice: speaking voice", description: "A prebuilt Gemini voice name. Empty: the model's default voice.", default: "Erinome" },
  voiceLanguage: { type: "string", label: "Voice: language (BCP-47, e.g. en-US)", description: "What the voice listens for and speaks. Default en-US.", default: "en-US" },
  voiceSensitivity: { type: "string", label: "Voice: how easily it hears you start talking (low, medium or high)", description: "Low (the default) ignores more background noise; high catches quiet speech sooner.", default: "low" },
  voiceCredential: {
    type: "string",
    secret: true,
    label: "Voice: service-account key",
    description: "Vertex AI only, and optional: your own service-account JSON key (a service account with only the Vertex AI User role on your project). Kept by bb in a 0600 file, read only by the server, never sent to the page or logged. Empty: your own Google login on the bb host (gcloud auth application-default login) is used instead.",
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
  voiceApiKey?: string;
  voiceCredential?: string;
};

export function defineVoiceSettings(bb: BbPluginApi) {
  return bb.settings.define(VOICE_SETTINGS);
}
