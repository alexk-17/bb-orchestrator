# codex-lb

Run bb's Codex threads through [codex-lb](https://github.com/Soju06/codex-lb), a local load balancer that spreads
Codex traffic across several ChatGPT accounts. The connection is set in plugin settings, not in wrapper scripts and
service environment.

The plugin does three things:

- **A `codex` launcher.** The plugin writes a small `codex` script into its data folder. It rewrites the script on
  every load and every settings change. bb's Codex provider starts `codex app-server` from `PATH`, so you put that
  folder first on bb's `PATH` once. The launcher then runs your real codex with codex-lb's provider settings.
- **`bb codex-lb status`** shows the launcher, the codex binary it runs, codex-lb's readiness, the pool's usage limits
  and its unredeemed reset credits per account. `bb codex-lb path` prints the folder to put on `PATH`.
- **Pool usage in bb's Provider usage card.** The plugin is a `provider-usage.v1` source, so the built-in
  Provider usage plugin lists the pool's limits and reset-credit count next to your other providers.

## Why a launcher on PATH

bb's Codex provider has no plugin hook for its launch command:

- The host daemon drops every `BB_*` variable before it starts provider bridges. This includes
  `BB_CODEX_BRIDGE_APP_SERVER_COMMAND`, so setting it in a service file has no effect.
- A plugin's provider environment (`providers.experimental_contributeEnv`) can set only `CODEX_HOME` and the
  Account Pooler's own variables.

The one thing every install can change is which `codex` the provider finds on `PATH`. The launcher is generated from
settings, holds no secret and removes itself from `PATH` before it starts codex. Nothing codex starts can call back
into it.

## Setup

1. Run codex-lb and create a client API key in its dashboard.
2. Put the key in bb's environment under a name of your choice, `CODEX_LB_API_KEY` by default. With a systemd unit,
   use an `EnvironmentFile=` that only your user can read. The plugin reads only the variable's name. It never stores
   the key or writes it into the launcher.
3. Install the plugin:

   ```sh
   bb plugin install codex-lb@bb-orchestrator
   ```

4. Adjust settings if the defaults don't fit (`bb plugin config codex-lb set <key> <value>`):

   | Setting | Default | Meaning |
   | --- | --- | --- |
   | `baseUrl` | `http://127.0.0.1:2455` | Where codex-lb listens. Codex uses `<baseUrl>/backend-api/codex`. |
   | `apiKeyEnv` | `CODEX_LB_API_KEY` | Variable in bb's environment that holds the client key. |
   | `codexHome` | empty | `CODEX_HOME` for Codex threads. Empty keeps Codex's default (or what bb's environment sets). |
   | `model` | empty | Default model when bb doesn't name one. bb's per-thread model still wins. |
   | `codexPath` | empty | Absolute path of the real codex. Empty means the first `codex` on bb's `PATH` after the launcher. |
   | `extraArgs` | empty | Extra codex arguments placed before the subcommand, space-separated, no quoting (for example `--enable hooks`). |
   | `trustedRoots` | empty | Comma-separated absolute folders. A thread working in one of them, or below it, runs as a trusted Codex project. |

5. Put the launcher folder first on bb's `PATH`, then restart bb so the provider picks it up:

   ```sh
   bb codex-lb path        # <bb data dir>/plugins/codex-lb/bin
   ```

   With a systemd unit, that means `Environment=PATH=<that folder>:<the rest of PATH>`.

6. Check it:

   ```sh
   bb codex-lb status
   ```

   The command exits 0 only when Codex threads will really route through codex-lb: the settings are valid, the
   launcher is current and is the first `codex` on bb's `PATH` (with no empty or relative entry ahead of it), the
   codex binary it runs is still there and executable, the key variable is set and codex-lb accepts the key, codex-lb
   is ready, and bb's Account Pooler is not routing Codex as well. Otherwise it exits 1 and ends with `status FAILING` and
   one line per reason. `--json` gives the same report as JSON, with `ok` and `problems`. Then start a Codex thread. Its requests show up in codex-lb's
   dashboard.

The launcher writes these overrides on codex's command line, matching codex-lb's documented client setup with an API
key in place of an OpenAI login:

```toml
model_provider = "codex-lb"
[model_providers.codex-lb]
name = "openai"                      # codex-lb: required for remote /responses/compact
base_url = "http://127.0.0.1:2455/backend-api/codex"
wire_api = "responses"
env_key = "CODEX_LB_API_KEY"
supports_websockets = true
requires_openai_auth = false
```

Your `config.toml` keeps everything else (MCP servers, hooks, project trust).

## What it reads from codex-lb

All three calls are GETs. Nothing in this plugin redeems a reset credit or changes the pool.

| Endpoint | Key | Used for |
| --- | --- | --- |
| `/health/ready` | none | Readiness in `status`. |
| `/v1/usage` | Bearer | The limits shown in `status` and the usage card. The key's own limits are used if it has any, otherwise the pool's. |
| `/v1/reset-credit` | Bearer | Unredeemed reset credits per account, with the soonest expiry. These don't show in the account usage views. |

The usage card caches a reading for a minute. `status` always reads fresh.

## Limits

- **Server machine only.** The launcher is written on the machine running the bb server. Codex threads on other
  enrolled machines keep their own `codex`.
- **Don't combine with Account Pooler for Codex.** bb's Account Pooler routes Codex with its own overrides, which
  would take precedence. The launcher refuses to start an app-server while the Pooler's token is present.
- **No redeeming.** Spending a reset credit stays a deliberate action in codex-lb's dashboard or API.
- A setting that fails validation is logged and not applied. The last good launcher stays in place.

## Development

```sh
npm install
npm test           # launcher and pool tests: runs the generated script against a fake codex and a stub codex-lb
npm run typecheck
bb plugin build
bb plugin install path:$PWD   # bb plugin reload codex-lb after a change
```
