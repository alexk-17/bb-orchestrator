// The launcher bb's Codex provider runs instead of the bare `codex` binary.
//
// bb's Codex bridge starts `codex app-server` by looking `codex` up on PATH. Plugins cannot change that command:
// the host daemon drops BB_* variables before it spawns the bridge, and a plugin's provider environment may only set
// CODEX_HOME and the Account Pooler's own pair. So this plugin writes one small `codex` script into its data folder,
// and the user puts that folder first on bb's PATH once. Everything else (where codex-lb is, which key variable,
// which codex binary, CODEX_HOME, model) comes from the plugin's settings and is rewritten whenever they change.
//
// Everything here is pure and testable without bb: settings in, script text out.
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export type LauncherSettings = {
  baseUrl: string;
  apiKeyEnv: string;
  codexHome: string;
  model: string;
  codexPath: string;
  extraArgs: string;
  trustedRoots: string;
};

export const DEFAULTS: LauncherSettings = {
  baseUrl: "http://127.0.0.1:2455",
  apiKeyEnv: "CODEX_LB_API_KEY",
  codexHome: "",
  model: "",
  codexPath: "",
  extraArgs: "",
  trustedRoots: "",
};

/** The Codex model-provider id the launcher defines. */
export const PROVIDER_ID = "codex-lb";
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Problems that make a setting unusable. An empty list means the settings can be written as a launcher. */
export function settingsProblems(s: LauncherSettings): string[] {
  const problems: string[] = [];
  try {
    const url = new URL(s.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") problems.push(`baseUrl must be http(s): ${s.baseUrl}`);
  } catch {
    problems.push(`baseUrl is not a URL: ${s.baseUrl}`);
  }
  if (!ENV_NAME.test(s.apiKeyEnv)) problems.push(`apiKeyEnv must be an environment variable name: ${s.apiKeyEnv}`);
  if (s.codexHome && !isAbsolute(s.codexHome)) problems.push(`codexHome must be an absolute path: ${s.codexHome}`);
  if (s.codexPath && !isAbsolute(s.codexPath)) problems.push(`codexPath must be an absolute path: ${s.codexPath}`);
  for (const root of trustedRoots(s.trustedRoots)) {
    if (!isAbsolute(root)) problems.push(`trustedRoots entries must be absolute paths: ${root}`);
  }
  return problems;
}

/** codex-lb's Codex-native endpoint under the configured base URL. */
export function providerBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/backend-api/codex`;
}

export function trustedRoots(raw: string): string[] {
  return raw
    .split(",")
    .map((r) => r.trim().replace(/(.)\/+$/, "$1"))
    .filter(Boolean);
}

/** TOML basic string. JSON's escapes are a subset TOML accepts, for the characters JSON.stringify emits. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The `-c` overrides that point Codex at codex-lb, in Codex's own config syntax. They match codex-lb's documented
 * client setup, with an API key read from `apiKeyEnv` instead of an OpenAI login.
 */
export function codexArgs(s: LauncherSettings): string[] {
  const p = `model_providers.${PROVIDER_ID}`;
  const args = [
    ...s.extraArgs.split(/\s+/).filter(Boolean),
    "-c", `model_provider=${tomlString(PROVIDER_ID)}`,
    // codex-lb's README: the name must be "openai" (lowercase) for remote /responses/compact to work.
    "-c", `${p}.name="openai"`,
    "-c", `${p}.base_url=${tomlString(providerBaseUrl(s.baseUrl))}`,
    "-c", `${p}.wire_api="responses"`,
    "-c", `${p}.env_key=${tomlString(s.apiKeyEnv)}`,
    "-c", `${p}.supports_websockets=true`,
    "-c", `${p}.requires_openai_auth=false`,
  ];
  if (s.model) args.push("-c", `model=${tomlString(s.model)}`);
  return args;
}

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real codex binary: `codexPath` when set, else the first `codex` on PATH that is not this launcher.
 * null when there is none.
 */
export function resolveCodex(s: LauncherSettings, pathEnv: string, launcherDir: string): string | null {
  if (s.codexPath) return executable(s.codexPath) ? s.codexPath : null;
  const own = resolve(launcherDir);
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || !isAbsolute(dir) || resolve(dir) === own) continue;
    const candidate = join(dir, "codex");
    if (executable(candidate)) return candidate;
  }
  return null;
}

/** A single-quoted POSIX shell word. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The launcher script. `codex` is the resolved binary, or null to write a launcher that explains it is missing (bb
 * then reports the provider as unavailable instead of silently using some other codex).
 *
 * The API key never appears in the script: only the name of the variable Codex reads it from.
 */
export function renderLauncher(s: LauncherSettings, codex: string | null, launcherDir: string): string {
  const q = shellQuote;
  const lines = [
    "#!/bin/sh",
    "# Written by the codex-lb bb plugin from its settings. Do not edit: the plugin rewrites it on every load and",
    "# settings change. Inspect with `bb codex-lb status`.",
    "set -eu",
    "",
    "# Leave this folder off PATH for codex and everything it starts, so nothing calls back into the launcher.",
    `launcher_dir=${q(resolve(launcherDir))}`,
    "set -f",
    "kept=",
    "IFS=:",
    'for entry in $PATH; do [ "$entry" = "$launcher_dir" ] || kept="${kept:+$kept:}$entry"; done',
    "unset IFS",
    "set +f",
    'PATH=$kept',
    "export PATH",
    "",
  ];
  if (codex === null) {
    lines.push(
      `echo "codex-lb: no codex binary found${s.codexPath ? ` at ${s.codexPath.replace(/["`$\\]/g, "")}` : " on PATH"}. Install Codex or set the plugin's codexPath." >&2`,
      "exit 127",
      "",
    );
    return lines.join("\n");
  }
  lines.push(
    'if [ "${1:-}" = app-server ]; then',
    // bb's Account Pooler routes Codex with its own -c overrides, appended after ours, so it would win silently.
    '  if [ -n "${CODEX_POOL_AUTH_TOKEN:-}" ]; then',
    '    echo "codex-lb: bb\'s Account Pooler is also routing Codex. Disable one of the two." >&2',
    "    exit 64",
    "  fi",
    `  if [ -z "\${${s.apiKeyEnv}:-}" ]; then`,
    `    echo "codex-lb: ${s.apiKeyEnv} is not set in bb's environment." >&2`,
    "    exit 64",
    "  fi",
    "fi",
    "",
  );
  if (s.codexHome) lines.push(`CODEX_HOME=${q(s.codexHome)}`, "export CODEX_HOME", "");
  const roots = trustedRoots(s.trustedRoots);
  if (roots.length > 0) {
    const patterns = roots.map((r) => `${q(r)}|${q(r)}/*`).join("|");
    lines.push(
      "# Trust the working folder when it is under a configured root. Paths with quotes or backslashes are skipped.",
      'cwd=$(pwd -P)',
      'case "$cwd" in',
      "  *'\"'*|*\\\\*) ;;",
      `  ${patterns}) set -- -c "projects={\\"$cwd\\"={trust_level=\\"trusted\\"}}" "$@" ;;`,
      "esac",
      "",
    );
  }
  lines.push(`exec ${[codex, ...codexArgs(s)].map(q).join(" ")} "$@"`, "");
  return lines.join("\n");
}
