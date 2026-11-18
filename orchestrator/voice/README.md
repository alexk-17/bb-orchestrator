# Voice mode

Talk to your orchestrator board. A mic button beside the Chief of Staff box opens a voice call that already knows your
cards, projects, PR waits, deliverables and recent lead messages. It answers questions, and it can act, but only on
your yes. It runs on Gemini Live through Vertex AI, using your own Google Cloud project. **Off by default.**

## Turn it on (about 5 minutes)

1. **Sign in to Google on the bb host.** In a terminal on the machine that runs your bb server, run
   `gcloud auth application-default login`. Each person uses their own Google login, so there is no shared key.
   (Or paste a service-account JSON key, with only the *Vertex AI User* role, into **Voice: service-account key**.)
2. **Check access.** Your Google account needs the *Vertex AI User* role (`roles/aiplatform.user`) on the project,
   and the project needs the Vertex AI API on: `gcloud services enable aiplatform.googleapis.com --project <project>`.
3. **Fill in the settings.** Open the Orchestrator's plugin settings and set **Voice: Google Cloud project ID**. Check
   **Voice: Vertex AI location**, **Voice: Live model** and **Voice: speaking voice** (the defaults are a starting point).
4. **Turn on "Voice mode"** in the same settings, then reload the plugin (or restart bb). It takes a reload: while voice is
   off, its routes don't exist at all.
5. **Open the Orchestrator page and click the mic** beside "Message the Chief of Staff…". Allow the microphone. If
   voice can't start, a status line beside the mic says why: no credential found, permission denied, or the model isn't
   enabled.

## Using it

- **Click the mic** to start a call: the mic is live until you hang up. **Hold Space** (outside a text box) for
  push-to-talk: the mic is live only while it's held. **Esc** or a second click hangs up. The mic is never live
  otherwise.
- It opens with a short briefing, then follows your lead: "what's waiting on me?", "what did the API lead say?", "next
  card", "go back to the billing one". Talk over it to interrupt.
- **Actions need your yes.** The voice can only propose. A confirm card appears, the voice reads it back word for word,
  and it's sent only after you say "yes" (or tap **Send**), after a 3-second "Cancel" window. **Merges, production, money
  and secrets always need a tap**: voice alone never sends them.
- **Anything the Chief of Staff can do** (start a lead, spin up a project, steer a thread, triage, chase CI) is asked of
  the Chief: the voice proposes the instruction, you confirm, the Chief does it, and its reply is read back. A plain
  question to the Chief needs no confirm.
- At hang-up, one short summary (what you decided, what you asked, what's still open) is posted to the Chief of Staff's
  thread.
- The panel shows the transcript, the confirm card, the call's length and a cost estimate (set your rates in
  **Voice: price estimate**).

## How it works

```
Browser (mic, speaker, confirm card)
   │  one WebSocket: PCM16 16 kHz up, 24 kHz down; bb "local" auth + the page's own Origin
bb server: voice/ (holds the Google credential, runs the read tools, gates writes, keeps the call's ledger)
   │  WebSocket to Vertex AI (BidiGenerateContent)
Gemini Live
```

- **Audio is proxied through the bb server.** The Google credential stays on the server: it is never sent to the page,
  returned by a read, put in an error message or logged (log lines and errors are redacted).
- **Context.** Each connection starts with a snapshot of the board, about 6K tokens, built in-process from the
  orchestrator's own state. Live read tools fetch the full version of anything in it.
- **Writes are the page's own.** The server only *proposes*. When you confirm, the server tells the page, and the page
  sends the request through the same owner route as a click (`/answer`, `/defer`, `/projects/message`, `/cos/message`,
  `/deliverables/approve`, `/deliverables/changes`, `/projects/priority`, `/projects/hold`, `/projects/start-lead`),
  recorded `via: "voice"` on answers and defers. "Writes come only from the app's screens" stays true.
- **Long calls.** A Live connection lasts about 10 minutes. Near 8 minutes (or at the provider's `goAway`), at a quiet
  moment with nothing waiting for your yes, the server opens a fresh connection with a new snapshot, a short running
  summary of the call and the last few turns word for word, then cuts over. Your page's connection never drops.

## Data handling (zero data retention, as far as the session controls it)

- **Session resumption is off:** no `sessionResumption` is requested, so Google keeps no session state between
  connections.
- **No Google Search grounding:** the only tools are the voice's own function declarations.
- **Nothing is stored on Google's side by this plugin.** The transcript lives in the page for the call, and the summary goes
  to your Chief of Staff thread.
- **Still your project's call:** whether prompts are logged for abuse monitoring, and whether Vertex AI uses caching
  for your project, are project and account settings outside this plugin. Check them with your Google Cloud admin before
  using voice for sensitive work.

## Security

- The socket and the status read exist only while **Voice mode** is on. Both need bb's own local session (`auth:
  "local"`), and the socket also checks the page's Origin and `Sec-Fetch-Site` exactly as the owner writes do. A
  cross-site or Origin-less connection is refused.
- Text in cards and messages is passed to the model as data, never as instructions, and no write happens without your
  own yes after the read-back (or your tap).

## Files

| File | What it is |
|---|---|
| `server.ts` | `registerVoice`: settings, the socket, the status read, the Chief's replies |
| `session.ts` | one call: audio relay, tool calls, confirm gating, the ledger, the connection swap, the summary |
| `gemini.ts` | the Gemini Live adapter (setup, messages, close reasons); the provider stays swappable |
| `google-auth.ts`, `redact.ts` | Application Default Credentials or a key, minting tokens; redaction |
| `snapshot.ts`, `ports.ts`, `tools.ts`, `confirm.ts` | the board snapshot, the reads, the tools, the confirm rules |
| `app/` | the mic button, the live panel, audio capture and playback, the Space and Esc rules |
