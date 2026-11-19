// A made-up machine for the tests: temp HOME, AWS config, gcloud config, login config and cloud-switch config (at its
// default path in that HOME), with the fake aws and gcloud first on PATH. Every id and name is a placeholder. Every path is checked to be inside the sandbox, so no test can touch the live runner's files.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FAKE_BIN = join(PKG, "test/fake");
const ROOT = join(PKG, ".scratch");

// A typical SSO config (sso-session plus four profiles over a dev and a prod account), with a made-up start URL.
export const AWS_CONFIG = `[sso-session acme]
sso_start_url = https://example.awsapps.com/start
sso_region = us-east-1
sso_registration_scopes = sso:account:access

[profile Engineers-111111111111]
sso_session = acme
sso_account_id = 111111111111
sso_role_name = Engineers
region = us-east-1


[profile app-dev]
sso_session = acme
sso_account_id = 111111111111
sso_role_name = Engineers
region = us-east-1

[profile reports-prod]
sso_session = acme
sso_account_id = 222222222222
sso_role_name = Reports
region = us-east-1

[profile app-prod]
sso_session = acme
sso_account_id = 222222222222
sso_role_name = Engineers-Prod
region = us-east-1
`;

// The cloud-switch config the tests run with: 111111111111 and acme-dev are dev, 222222222222 and acme-prod are prod.
export const CONFIG = {
  aws: {
    accounts: [
      { id: "111111111111", env: "dev", pim: {
        Engineers: [{ group: "Example Dev Engineers", assignment: "active", permissions: "Dev services" }],
        Reports: [{ group: "Example Dev Reports", assignment: "active", inferred: true }],
      } },
      { id: "222222222222", env: "prod", pim: {
        Reports: [{ group: "Example Prod Reports", assignment: "eligible", maxDuration: "8 hours" }],
        "Engineers-Prod": [{ group: "Example Prod Engineers", assignment: "eligible", approval: true, maxDuration: "2 hours", inferred: true }],
      } },
    ],
  },
  gcp: {
    projects: [
      { id: "acme-dev", env: "dev", configuration: "dev", pim: [
        { group: "Example GCP Dev Viewers", assignment: "active", permissions: "Viewer" },
        { group: "Example GCP Dev Editors", assignment: "eligible", maxDuration: "8 hours", permissions: "Editor" },
      ] },
      { id: "acme-prod", env: "prod", configuration: "prod", pim: [
        { group: "Example GCP Prod Viewers", assignment: "eligible", approval: true, maxDuration: "8 hours", permissions: "Viewer" },
        { group: "Example GCP Prod Editors", assignment: "eligible", approval: true, maxDuration: "2 hours", permissions: "Editor" },
      ] },
    ],
  },
  links: [{ label: "Example PIM", url: "https://pim.example.com/activate" }],
};

export const FAKE_STATE = {
  aws: {
    "Engineers-111111111111": { Account: "111111111111", Arn: "arn:aws:sts::111111111111:assumed-role/AWSReservedSSO_Engineers_0a1b2c3d/user@example.com" },
    "app-dev": { Account: "111111111111", Arn: "arn:aws:sts::111111111111:assumed-role/AWSReservedSSO_Engineers_0a1b2c3d/user@example.com" },
    "reports-prod": { error: "An error occurred (ForbiddenException) when calling the GetRoleCredentials operation: No access" },
    "app-prod": {
      error: "Error when retrieving token from sso: Token has expired and refresh failed",
      afterLogin: { Account: "222222222222", Arn: "arn:aws:sts::222222222222:assumed-role/AWSReservedSSO_Engineers-Prod_9f8e7d6c/user@example.com" },
    },
  },
};

export type Box = { root: string; env: Record<string, string>; awsConfig: string; gcloudDir: string; log: string; loginConfig: string; configFile: string; done: () => void };

export function sandbox(): Box {
  mkdirSync(ROOT, { recursive: true });
  const root = mkdtempSync(join(ROOT, "t-"));
  const home = join(root, "home"), awsConfig = join(root, "aws/config"), gcloudDir = join(root, "gcloud"), loginConfig = join(root, "gcp-login-config.json");
  const configFile = join(home, ".config/bb-cloud-switch/config.json");
  for (const d of [home, dirname(awsConfig), gcloudDir, dirname(configFile)]) mkdirSync(d, { recursive: true });
  writeFileSync(configFile, JSON.stringify(CONFIG, null, 2));
  writeFileSync(awsConfig, AWS_CONFIG, { mode: 0o664 });
  writeFileSync(join(root, "state.json"), JSON.stringify(FAKE_STATE, null, 2));
  writeFileSync(loginConfig, JSON.stringify({ type: "external_account_authorized_user_login_config", audience: "made-up" }));
  const env: Record<string, string> = {
    PATH: `${FAKE_BIN}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home, USER: "cloud-switch-test",
    AWS_CONFIG_FILE: awsConfig, AWS_SHARED_CREDENTIALS_FILE: join(root, "aws/credentials"),
    CLOUDSDK_CONFIG: gcloudDir, CLOUD_SWITCH_GCP_LOGIN_CONFIG: loginConfig,
    CLOUD_SWITCH_FAKE_STATE: join(root, "state.json"), CLOUD_SWITCH_FAKE_LOG: join(root, "calls.log"), CLOUD_SWITCH_FAKE_LOGIN_MS: "50",
  };
  for (const [k, v] of Object.entries(env)) {
    if (k === "PATH") continue;
    if (v !== root && !v.startsWith(root + "/")) {
      if (k !== "USER" && k !== "CLOUD_SWITCH_FAKE_LOGIN_MS") throw new Error(`sandbox path ${k}=${v} escapes the sandbox`);
    }
  }
  return { root, env, awsConfig, gcloudDir, log: env.CLOUD_SWITCH_FAKE_LOG, loginConfig, configFile, done: () => rmSync(root, { recursive: true, force: true }) };
}
