// A Google access token for Vertex AI, minted on the bb server and never sent anywhere but Google.
// Where the credential comes from, first match wins:
//   1. the voiceCredential setting (a service-account JSON key), when someone pasted one;
//   2. Application Default Credentials on the bb host: GOOGLE_APPLICATION_CREDENTIALS, then gcloud's well-known file
//      (`gcloud auth application-default login`), then the metadata server of a Google Cloud VM.
// No dependency: node:crypto signs the service-account JWT and fetch talks to Google's token endpoint.
import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "./redact.ts";

export const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const METADATA_TOKEN = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

export type CredentialSource = "setting" | "adc-file" | "gcloud" | "metadata" | "none";

export class CredentialError extends Error {
  readonly kind: "none" | "unsupported" | "refused";
  constructor(kind: "none" | "unsupported" | "refused", message: string) {
    super(message);
    this.kind = kind;
  }
}

type ServiceAccount = { type: "service_account"; client_email: string; private_key: string; token_uri?: string };
type AuthorizedUser = { type: "authorized_user"; client_id: string; client_secret: string; refresh_token: string; quota_project_id?: string };
type Found =
  | { source: "setting" | "adc-file" | "gcloud"; json: ServiceAccount | AuthorizedUser; secrets: string[] }
  | { source: "metadata"; secrets: string[] };

export type AuthDeps = {
  /** The voiceCredential setting, or empty. */
  setting: () => string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Probe the metadata server (off in tests and off by default outside Google Cloud: the probe is fast either way). */
  metadata?: boolean;
};

function gcloudFile(env: NodeJS.ProcessEnv, home: string): string {
  if (env.CLOUDSDK_CONFIG) return join(env.CLOUDSDK_CONFIG, "application_default_credentials.json");
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "gcloud", "application_default_credentials.json");
  return join(home, ".config", "gcloud", "application_default_credentials.json");
}

function parseCredential(text: string, where: string): ServiceAccount | AuthorizedUser {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CredentialError("unsupported", `${where} isn't JSON`);
  }
  if (j.type === "service_account" && typeof j.client_email === "string" && typeof j.private_key === "string") return j as unknown as ServiceAccount;
  if (j.type === "authorized_user" && typeof j.client_id === "string" && typeof j.client_secret === "string" && typeof j.refresh_token === "string") return j as unknown as AuthorizedUser;
  throw new CredentialError("unsupported", `${where} is a ${typeof j.type === "string" ? j.type : "unknown"} credential; voice supports a service-account key or \`gcloud auth application-default login\``);
}

const secretsOf = (j: ServiceAccount | AuthorizedUser): string[] => (j.type === "service_account" ? [j.private_key] : [j.client_secret, j.refresh_token]);

/** Where a credential would come from, without minting a token (the status line's cheap check). */
export function locate(deps: AuthDeps): Found | null {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const setting = deps.setting().trim();
  if (setting) {
    const json = parseCredential(setting, "The voiceCredential setting");
    return { source: "setting", json, secrets: [setting, ...secretsOf(json)] };
  }
  const file = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (file) {
    if (!existsSync(file)) throw new CredentialError("none", "GOOGLE_APPLICATION_CREDENTIALS names a file that doesn't exist on the bb host");
    const json = parseCredential(readFileSync(file, "utf8"), "The GOOGLE_APPLICATION_CREDENTIALS file");
    return { source: "adc-file", json, secrets: secretsOf(json) };
  }
  const well = gcloudFile(env, home);
  if (existsSync(well)) {
    const json = parseCredential(readFileSync(well, "utf8"), "gcloud's application-default credentials");
    return { source: "gcloud", json, secrets: secretsOf(json) };
  }
  if (deps.metadata) return { source: "metadata", secrets: [] };
  return null;
}

function b64url(s: string | Buffer): string {
  return Buffer.from(s).toString("base64url");
}

/** A signed JWT asking for a cloud-platform token (a service-account key's flow). */
export function serviceAccountAssertion(sa: ServiceAccount, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: CLOUD_PLATFORM_SCOPE, aud: sa.token_uri ?? TOKEN_URI, iat, exp: iat + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${claims}`);
  return `${head}.${claims}.${signer.sign(sa.private_key).toString("base64url")}`;
}

export type Token = { token: string; expiresAt: number; source: CredentialSource; quotaProject: string | null };

/** Mints (and caches until a minute before expiry) a Vertex AI access token. Errors never carry the credential. */
export function googleAuth(deps: AuthDeps) {
  const f = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let cached: Token | null = null;
  let cachedFor = "";

  async function tokenFrom(res: Response, secrets: string[]): Promise<{ token: string; expiresIn: number }> {
    const text = await res.text();
    if (!res.ok) {
      let why = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text) as { error?: unknown; error_description?: unknown };
        if (typeof j.error === "string") why = `${j.error}${typeof j.error_description === "string" ? `: ${j.error_description}` : ""}`;
      } catch {
        // not JSON: the status is enough
      }
      throw new CredentialError("refused", redact(`Google refused the credential (${why})`, secrets));
    }
    const j = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };
    if (typeof j.access_token !== "string") throw new CredentialError("refused", "Google's token answer had no access token");
    return { token: j.access_token, expiresIn: typeof j.expires_in === "number" ? j.expires_in : 3600 };
  }

  return {
    locate: () => locate(deps),
    async token(): Promise<Token> {
      const found = locate(deps);
      if (!found) throw new CredentialError("none", "No Google credential found on the bb host: run `gcloud auth application-default login` there, or paste a service-account key in the voiceCredential setting");
      const key = found.source + ":" + (found.secrets[0]?.length ?? 0);
      if (cached && cachedFor === key && cached.expiresAt - 60_000 > now()) return cached;
      let got: { token: string; expiresIn: number };
      let quotaProject: string | null = null;
      try {
        if (found.source === "metadata") {
          const res = await f(METADATA_TOKEN, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(1500) });
          got = await tokenFrom(res, []);
        } else if (found.json.type === "service_account") {
          const assertion = serviceAccountAssertion(found.json, now());
          const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
          const res = await f(found.json.token_uri ?? TOKEN_URI, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(10_000) });
          got = await tokenFrom(res, [...found.secrets, assertion]);
        } else {
          const u = found.json;
          quotaProject = u.quota_project_id ?? null;
          const body = new URLSearchParams({ grant_type: "refresh_token", client_id: u.client_id, client_secret: u.client_secret, refresh_token: u.refresh_token });
          const res = await f(TOKEN_URI, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(10_000) });
          got = await tokenFrom(res, found.secrets);
        }
      } catch (e) {
        if (e instanceof CredentialError) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        if (found.source === "metadata") throw new CredentialError("none", "No Google credential found on the bb host: run `gcloud auth application-default login` there, or paste a service-account key in the voiceCredential setting");
        throw new CredentialError("refused", redact(`Couldn't reach Google's token endpoint: ${msg}`, found.secrets));
      }
      cached = { token: got.token, expiresAt: now() + got.expiresIn * 1000, source: found.source, quotaProject };
      cachedFor = key;
      return cached;
    },
    /** The secrets to cut from any text: the credential's own, and the live token. */
    secrets(): string[] {
      let s: string[] = [];
      try {
        s = locate(deps)?.secrets ?? [];
      } catch {
        // an unreadable credential has nothing to cut
      }
      return cached ? [...s, cached.token] : s;
    },
  };
}
export type GoogleAuth = ReturnType<typeof googleAuth>;
