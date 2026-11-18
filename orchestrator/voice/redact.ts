// Nothing secret leaves the server: a Google credential, a token or a refresh token is cut out of every log line and
// error message before it is written or sent.

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, "[redacted]"], // a key cut off mid-way
  [/\bya29\.[\w.-]+/g, "[redacted]"], // a Google OAuth access token
  [/\b1\/\/[\w.-]{20,}/g, "[redacted]"], // a Google refresh token
  [/("(?:private_key|private_key_id|client_secret|refresh_token|access_token|id_token)"\s*:\s*")[^"]*(")/g, "$1[redacted]$2"],
  [/\b(Bearer\s+)[\w.~+/=-]+/gi, "$1[redacted]"],
];

/** `text` with every known secret shape, and each of `secrets`, replaced by [redacted]. */
export function redact(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 8) continue;
    out = out.split(s).join("[redacted]");
    // a key's PEM body also appears with its newlines escaped
    const escaped = JSON.stringify(s).slice(1, -1);
    if (escaped !== s) out = out.split(escaped).join("[redacted]");
  }
  for (const [p, to] of PATTERNS) out = out.replace(p, to);
  return out;
}

/** An error's message, redacted. */
export function safeError(e: unknown, secrets: readonly (string | null | undefined)[] = []): string {
  const m = e instanceof Error ? e.message : String(e);
  return redact(m, secrets).slice(0, 500);
}
