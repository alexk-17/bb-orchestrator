# Voice mode

Talk to your orchestrator board. A mic button in Home's header opens a voice call that already knows your
cards, projects, PR waits, deliverables and recent lead messages. It answers questions, and it can act, but only on
your yes. It runs on Gemini Live with your own credential: your own Gemini API key, or your own Google Cloud project on
Vertex AI. Nothing is bundled, and nothing points at anyone else's account. **Off by default.**

## Turn it on (about 5 minutes)

1. **Bring your own key.** Voice uses only a credential you set up yourself. Pick one:
   - **Your own Gemini API key (simplest: no Google Cloud project).** Sign in to Google AI Studio
     (<https://aistudio.google.com/apikey>) with your own Google account, create an API key, and paste it into
     **Voice: Gemini API key** in the Orchestrator's plugin settings. Treat it like a password: keep it out of chat and
     repositories.
   - **Your own Google Cloud project on Vertex AI.** Set **Voice: Google Cloud project ID** to your project (it needs
     the Vertex AI API on: `gcloud services enable aiplatform.googleapis.com --project <your-project>`). Then either
     sign in with your own Google account on the machine that runs your bb server
     (`gcloud auth application-default login`; your account needs the *Vertex AI User* role on the project), or paste
     your own service-account JSON key (a service account with only *Vertex AI User*) into **Voice: service-account
     key**. A pasted key wins over the host's login. Check **Voice: Vertex AI location** too. On a cloud VM, voice
     never uses the VM's own service account: point `GOOGLE_APPLICATION_CREDENTIALS` at your own key file, or paste
     the key.

   A Gemini API key, when set, is used, and the Vertex AI settings are ignored. bb keeps both secret settings in 0600
   files on your bb server; they are never sent to the page or logged.
2. **Check the rest.** **Voice: Live model** and **Voice: speaking voice** (the defaults are a starting point; the model
   must be one your key or project can use). **Voice: language** (default `en-US`) pins what it listens for and
   speaks; **Voice: how easily it hears you start talking** (default `low`) ignores more background noise, and `medium`
   or `high` catch quiet speech sooner.
3. **Turn on "Voice mode"** in the same settings, then reload the plugin (or restart bb). It takes a reload: while voice is
   off, its routes don't exist at all.
4. **Open the Orchestrator page and click the mic** beside "Message the Chief of Staff…". Allow the microphone. With no
   key set, the mic's popover says which setting to fill in. If voice can't start for another reason, it says why: the
   key or login wasn't accepted, permission denied, or the model isn't available.

## Using it

- **Click the mic** to start a call: the mic is live until you hang up. **Hold Space** (outside a text box) for
  push-to-talk: the mic is live only while it's held. **Esc** or a second click hangs up. The mic is never live
  otherwise.
- It says nothing until you speak. It has the board in mind, and answers, acts and gives context only when you ask:
  "what's waiting on me?", "what did the API lead say?", "next card", "go back to the billing one". Talk over it to
  interrupt.
- **Commands run at once.** Say "tell the API lead to push the fix" and it's sent, through the same route as a click;
  the voice says what it did in one line, and the transcript shows it as a done line. **Merges, production, money and
  secrets always need a tap**: the voice says "That one needs a tap" and shows a card that only your tap sends.
- **Anything the Chief of Staff can do** (start a lead, spin up a project, steer a thread, triage, chase CI) is asked of
  the Chief: the Chief does it, and its reply is read back. A question for the Chief works the same way.
- At hang-up, one short summary (what was done, what you asked, what's still open, and what you said) is posted to the
  Chief of Staff's thread.
- While a call is live, the mic shows a small pulsing dot and the call's time (m:ss). Its popover shows the last few
  transcript lines, and a tap card when one is waiting.

## How it works

```
Browser (mic, speaker, tap card)
   │  one WebSocket: PCM16 16 kHz up, 24 kHz down; bb "local" auth + the page's own Origin
bb server: voice/ (holds your own key or login, runs the read tools, gates writes, keeps the call's ledger)
   │  WebSocket to the Gemini API (your API key) or Vertex AI (your project): BidiGenerateContent
Gemini Live
```

- **Audio is proxied through the bb server.** Your key or login stays on the server: it is never sent to the page,
  returned by a read, put in an error message or logged (log lines and errors are redacted). An API key goes to Google
  only in the `x-goog-api-key` header, never in a URL.
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
- **Still your account's call:** on Vertex AI, whether prompts are logged for abuse monitoring, and whether Vertex AI
  uses caching for your project, are project and account settings outside this plugin. On the Gemini API, Google's terms
  for your key's tier apply (on an unpaid key, Google may use what is sent to improve its products). Check them before
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
| `google-auth.ts`, `redact.ts` | Vertex AI: your own login (Application Default Credentials) or key, minting tokens; redaction |
| `snapshot.ts`, `ports.ts`, `tools.ts`, `confirm.ts` | the board snapshot, the reads, the tools, the confirm rules |
| `app/` | the mic button, the live panel, audio capture and playback, the Space and Esc rules |
