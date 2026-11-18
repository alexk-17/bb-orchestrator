import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { googleAuth, locate, CredentialError } from "../voice/google-auth.ts";
import { redact } from "../voice/redact.ts";

const user = { type: "authorized_user", client_id: "cid.apps.example", client_secret: "CLIENT-SECRET-123456", refresh_token: "1//REFRESH-TOKEN-abcdefghijklmnopqrstuvwxyz", quota_project_id: "quota-project" };
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const sa = { type: "service_account", client_email: "sa@example.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };

function home(withGcloud: boolean) {
  const h = mkdtempSync(join(tmpdir(), "voice-auth-"));
  if (withGcloud) {
    mkdirSync(join(h, ".config", "gcloud"), { recursive: true });
    writeFileSync(join(h, ".config", "gcloud", "application_default_credentials.json"), JSON.stringify(user));
  }
  return h;
}

test("credential order: the setting, then GOOGLE_APPLICATION_CREDENTIALS, then gcloud's file, then the metadata server", () => {
  const h = home(true);
  const file = join(h, "sa.json");
  writeFileSync(file, JSON.stringify(sa));
  assert.equal(locate({ setting: () => JSON.stringify(sa), env: { GOOGLE_APPLICATION_CREDENTIALS: file }, home: h })?.source, "setting");
  assert.equal(locate({ setting: () => "", env: { GOOGLE_APPLICATION_CREDENTIALS: file }, home: h })?.source, "adc-file");
  assert.equal(locate({ setting: () => "", env: {}, home: h })?.source, "gcloud");
  assert.equal(locate({ setting: () => "", env: {}, home: home(false), metadata: true })?.source, "metadata");
  assert.equal(locate({ setting: () => "", env: {}, home: home(false) }), null);
});

test("an unsupported credential type says what is supported", () => {
  assert.throws(() => locate({ setting: () => JSON.stringify({ type: "external_account" }) }), (e: unknown) => e instanceof CredentialError && /supports a service-account key or `gcloud auth application-default login`/.test(e.message));
});

test("a gcloud login is refreshed for a token, cached, and its quota project kept", async () => {
  let calls = 0;
  let sentBody = "";
  const f = (async (_u: string, init?: RequestInit) => {
    calls++;
    sentBody = String(init?.body);
    return new Response(JSON.stringify({ access_token: "ya29.minted", expires_in: 3600 }), { status: 200 });
  }) as typeof fetch;
  const a = googleAuth({ setting: () => "", env: {}, home: home(true), fetch: f, now: () => 1_000 });
  const t = await a.token();
  assert.equal(t.token, "ya29.minted");
  assert.equal(t.source, "gcloud");
  assert.equal(t.quotaProject, "quota-project");
  assert.match(sentBody, /grant_type=refresh_token/);
  await a.token();
  assert.equal(calls, 1, "cached");
  assert.ok(a.secrets().includes("ya29.minted") && a.secrets().includes(user.refresh_token));
});

test("a service-account key signs a JWT for the cloud-platform scope", async () => {
  let assertion = "";
  const f = (async (_u: string, init?: RequestInit) => {
    assertion = new URLSearchParams(String(init?.body)).get("assertion") ?? "";
    return new Response(JSON.stringify({ access_token: "ya29.sa", expires_in: 3600 }), { status: 200 });
  }) as typeof fetch;
  const t = await googleAuth({ setting: () => JSON.stringify(sa), fetch: f }).token();
  assert.equal(t.token, "ya29.sa");
  const claims = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString()) as { scope: string; iss: string };
  assert.equal(claims.scope, "https://www.googleapis.com/auth/cloud-platform");
  assert.equal(claims.iss, sa.client_email);
});

test("redact cuts keys, tokens, refresh tokens and named secrets", () => {
  const text = `key ${sa.private_key} token ya29.abcDEF123 refresh 1//0abcdefghijklmnopqrstuvwx and "client_secret": "s3cr3t-value" Bearer abc.def and CLIENT-SECRET-123456`;
  const out = redact(text, [user.client_secret]);
  assert.ok(!out.includes("BEGIN PRIVATE KEY"));
  assert.ok(!out.includes("ya29.abcDEF123"));
  assert.ok(!out.includes("1//0abcdefghijklmnopqrstuvwx"));
  assert.ok(!out.includes("s3cr3t-value"));
  assert.ok(!out.includes("Bearer abc.def"));
  assert.ok(!out.includes("CLIENT-SECRET-123456"));
});
