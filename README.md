# bb-orchestrator

Two plugins for [bb](https://getbb.app), the agent orchestration app:

- **Orchestrator** (`orchestrator/`) gives bb threads roles and runs them as a team. A Chief of Staff (CoS) triages, a
  Steward watches the host, each project has a lead, and the leads start threads. Questions come to you as cards with
  2-4 options. Finished work comes to you as deliverables with proof (screenshots, test output, a PR). Mail between
  agents, the PR status of every lead and thread, and the rest stay in an Activity log until you want them. It also
  carries two optional tabs: **Cloud** (see and swap the active AWS profile and gcloud configuration, see
  [orchestrator/cloud/README.md](orchestrator/cloud/README.md) and [The Cloud tab](#the-cloud-tab)) and **Game Boy** (play your own ROM beside your work, see
  [orchestrator/gameboy/README.md](orchestrator/gameboy/README.md)).
- **Usage Meter** (`usage-meter/`) shows your Claude subscription limits as two rings on a sidebar button, plus a
  Usage page that breaks down where the usage went. See [usage-meter/README.md](usage-meter/README.md).

Each plugin installs and updates on its own.

## Requirements

- bb 0.49 or newer for the Orchestrator, 0.39 or newer for Usage Meter.
- `git` on the machine running the bb server (bb clones and builds the plugin on install).
- The Orchestrator's agents run on bb's Claude Code provider, so you need a Claude account signed in to bb.

## Install

Add this repository as a bb marketplace, then install either plugin from it:

```sh
bb marketplace add git:github.com/alexk-17/bb-orchestrator@main
bb plugin install orchestrator@bb-orchestrator
bb plugin install usage-meter@bb-orchestrator
```

Or install straight from git, without the marketplace. Each plugin has its own release tags (`orchestrator-vX.Y.Z`,
`usage-meter-vX.Y.Z`), so give the plugin's folder and tag prefix:

```sh
bb plugin install git:https://github.com/alexk-17/bb-orchestrator.git@^1.0.0 --subdirectory orchestrator --tag-prefix orchestrator-
bb plugin install git:https://github.com/alexk-17/bb-orchestrator.git@^0.3.0 --subdirectory usage-meter --tag-prefix usage-meter-
```

bb shows the exact tag and commit it resolved and asks you to confirm. Plugins run with full trust on your machine, so
read what you install.

## Update

Both install forms track a version range, so new releases reach you without reinstalling:

```sh
bb plugin outdated              # list compatible updates
bb plugin update orchestrator   # apply one (or: bb plugin update --all)
```

bb never applies updates on its own. If an update fails to start, bb rolls back to the version you had. A release is
never retagged: a fix ships as a new version.

## Getting started

1. Run `bb orchestrator setup sidebar` once. It turns on bb's thread-row metadata, orders the sidebar sections as
   pinned, projects, threads, and pins the CoS and Steward threads once they exist. It is safe to run again and prints
   what it changed.
2. Open **Orchestrator** in bb's navigation, go to the **Projects** tab and start the CoS and the Steward from the
   "Standing agents" row.
3. Add a project: make a folder in the projects folder (setting `projectsDir`) with a `PROJECT.md` and a project record
   (`project.json`, which can be `{}`). Put the absolute path of the project's repo in backticks under a `## Repos`
   heading in `PROJECT.md`. The project then shows in the Projects tab with a **Start lead** button.

For day-to-day use (answering cards, reviewing deliverables, messaging a lead, standing rules and the settings that
matter), see the usage guide: [orchestrator/USAGE.md](orchestrator/USAGE.md).

## Settings

**Context:** the plugin never clears an agent's context. Claude Code's auto-compaction handles it, tunable with `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in your Claude Code settings. The plugin's own idle compaction (`cosCompactTokens`) is off by default.

Each plugin's settings are in bb under Settings → Installed plugins, or from the CLI:

```sh
bb plugin config orchestrator                    # show every setting with its current value
bb plugin config orchestrator set <key> <value>  # change one; the running plugin picks it up live
```

The Orchestrator's main settings:

| Setting | Default | What it does |
|---|---|---|
| `ownerName` | empty | Your name as agents and screens say it. Empty: agents say "the owner" and screens say "you". |
| `cosTitle` | `Chief of Staff` | The CoS's name on its thread and in the app. |
| `stateDir` | empty | State folder: a copy of each decision, the CoS and Steward folders, dream jobs. Empty: `state/` in the plugin's data folder. |
| `diskPath` | `/` | The disk whose usage the Steward watches. |
| `projectsDir` | empty | Projects folder, one folder per project. Empty: `projects/` in the plugin's data folder. |
| `projectRecord` | `project.json` | The record file in each project folder; a record with `archived_at` set hides the project. |
| `memoryConfig` | empty | Memory is off unless this names a memory config file (JSON with a `memory` block). Then leads and threads get read-only `memory_search` and `memory_page` tools. |
| `memoryConfigEnv` | `MEMORY_CONFIG` | The environment variable through which the memory tools receive the config's path. Empty: the path is not passed. |
| `memoryUnits`, `memoryTimers` | empty | The daily memory check: systemd user units to watch for failures, and `<unit>.timer=<minutes>` pairs that count as stale when they haven't run for that long. |
| `dreamsEnabled` | off | The nightly dream batch and the daily memory check. Needs a memory config with `memory.dreamDir`. |
| `hiddenTabs` | empty | Tabs to hide from the page, comma-separated, by id or label. Empty: every tab shows. |
| `pokemon` | off | Gives each agent a Pokémon that evolves as it levels, and each project a Pokémon type: its lead and threads share the type, and its colour is the project's accent. Off: neutral avatars, no Pokémon name anywhere, and no project accent. See [orchestrator/NOTICE-pokemon.md](orchestrator/NOTICE-pokemon.md). |

Other settings cover how long a question waits before it reaches you, how often PRs are checked, the Steward's host
alarm thresholds, the model and reasoning level of each role, and the Cloud tab's config file. `bb orchestrator --help`
lists the CLI.

### Orchestrator notifications only

`notifyOnlyOrchestrator` (off by default) limits bb's notifications to the orchestrator. Turn it on or off with:

```sh
bb plugin config orchestrator set notifyOnlyOrchestrator true    # or false
```

You can also use the "Orchestrator notifications only" switch under Settings → Installed plugins → Orchestrator.

When it is on:

| Source | Notifies you? |
|---|---|
| A card entering Needs you (a question, plan, merge card or rule offer) | Yes. A click opens the asking agent's thread. |
| A lead's deliverable | Yes. A click opens the lead's thread. |
| The CoS thread (where you talk to the orchestrator) | Yes, at the level it had before you turned the setting on. |
| Leads, threads, the Steward, and every thread outside the orchestrator | No: muted. You follow them through cards and deliverables. |

How it works:

- Turning it on saves the push-notifications plugin's `defaultLevel` and `childLevel`, then sets both to `muted`.
- It gives the CoS thread its own level, so the CoS keeps notifying.
- Cards and deliverables go out through push-notifications' `notifications.send`, which thread levels don't affect.
- A thread you gave its own level (`bb push-notifications thread <id> --level ...`) keeps that level.
- Turning it off puts `defaultLevel` and `childLevel` back exactly as they were, and clears the CoS level the setting
  added. A CoS level you changed yourself in the meantime stays.
- The saved levels survive restarts and reinstalls. While the setting is on, the plugin re-checks every minute and sets
  the two levels back to `muted` if they changed, so change them by turning the setting off.
- Turn the setting off before you disable or remove the plugin. Otherwise the two levels stay `muted`.

Card and deliverable pushes still need `pushNeedsYou` on. They never go to a phone. While the push-notifications
plugin's mobile channel is on (`mobileEnabled`), the orchestrator sends no card or deliverable push at all, and says
so in Activity. Desktop and web then get only the CoS thread's notifications. To get cards on desktop and web, turn mobile push off
(`bb plugin config push-notifications set mobileEnabled false`), then switch `pushNeedsYou` off and on.

### The Cloud tab

The Cloud tab is always on the page. It stays empty until the machine has a config file that says which AWS accounts
and GCP projects are dev or prod. Until then, the tab shows the path it looked for. To turn it on, on the machine bb
runs on:

1. Install the `aws` CLI v2, `gcloud`, or both.
2. Copy the example config to the default path, then list your own accounts and projects in it:

   ```sh
   mkdir -p ~/.config/bb-cloud-switch && chmod 700 ~/.config/bb-cloud-switch
   cp orchestrator/cloud/config.example.json ~/.config/bb-cloud-switch/config.json
   chmod 600 ~/.config/bb-cloud-switch/config.json
   ```

   To keep the file somewhere else, set `cloudConfigPath` ("Cloud tab config file").
3. Click **Check again** on the Cloud tab.

The config is required because the tab must know which targets are prod: prod is never one click. See
[orchestrator/cloud/README.md](orchestrator/cloud/README.md) for the file's format.

### The Open PRs tab

The Open PRs tab lists every open PR your GitHub login authored, across repos. It reads GitHub with the `gh` login on
the machine bb runs on, and only reads: it never comments, reviews, labels or posts.

Each row shows:
- the title, which opens the PR in a bb pane;
- the project and lead, when one of the orchestrator's threads made the PR (matched by its PR or its branch);
- draft or ready, the review state with approvals against what the branch requires, CI and mergeability;
- a 1–2 line summary from the PR body's TL;DR section, else its first paragraph. It's extracted by code, with no model,
  and recomputed only when the PR's head commit changes.

**Needs review** lists the PRs that are ready (not drafts), not yet fully approved, and not failing CI. **All** lists
every open PR. Below the list, **Review ask** is one block of text for every PR that needs review: each PR's full URL
on its own line with a summary bullet under it, then suggested reviewers. **Copy** copies it.

Suggested reviewers are the CODEOWNERS of the changed files, then whoever reviewed the same folders in the repo's recent
merged PRs. A login is tagged `@handle` only if `slackHandleMap` maps it. Anyone else is shown by plain name, never
guessed.

**Post to code reviews** shows the exact text with a tick per PR. PRs from `reviewExcludedProjects` start unticked.
Confirm copies the text and opens `reviewChannel` in Slack, then says "Copied. Paste it in #<channel>". You paste and
send it yourself; the plugin has no Slack token and sends nothing.

The tab checks GitHub no more often than `prPollMinutes`, and only while it is open. Its settings are all empty by
default:

| Setting | What it does |
|---|---|
| `githubLogin` | Your GitHub login. Empty: the tab says to set it. |
| `reviewChannel` | The code-review channel: a name (`team-reviews`) or an https link to it. |
| `reviewExcludedProjects` | Project slugs, separated by commas or spaces, whose PRs start unticked in Post. |
| `slackHandleMap` | A JSON object of GitHub login to Slack handle, e.g. `{"some-login": "slackname"}`. |

```sh
bb plugin config orchestrator set githubLogin <your-login>
bb plugin config orchestrator set reviewChannel <channel-name>
bb plugin config orchestrator set slackHandleMap '{"<github-login>": "<slack-handle>"}'
```

## Development

```sh
(cd orchestrator && npm install && npm test && npm run typecheck)
(cd usage-meter && npm install)
bb plugin install path:$PWD/orchestrator   # run your checkout in bb; bb plugin reload orchestrator after a change
```

## Licenses and third-party notices

- This repository is under the MIT License, see [LICENSE](LICENSE). Usage Meter carries its own MIT license with its
  original author's copyright, see [usage-meter/LICENSE](usage-meter/LICENSE).
- **affectUI** components are vendored in `orchestrator/app/affect/` under the MIT License, see
  [orchestrator/app/affect/LICENSE](orchestrator/app/affect/LICENSE).
- **EmulatorJS** (GPL-3.0) and its **mGBA** core (MPL-2.0) are not part of this repository. The Game Boy tab loads them
  at runtime from the EmulatorJS CDN, and their licenses apply to that code. No game ROM is included: you supply your
  own, legally obtained.
- **Pokémon** are off by default and no Pokémon images are part of this repository. With the `pokemon` setting on,
  sprites load at runtime from the PokeAPI sprites project. See [orchestrator/NOTICE-pokemon.md](orchestrator/NOTICE-pokemon.md).

### Trademarks

Pokémon and the Pokémon character names are trademarks of Nintendo, Creatures Inc. and GAME FREAK inc. Game Boy and
Game Boy Advance are trademarks of Nintendo. Other names belong to their owners. This project is not affiliated with,
sponsored by or endorsed by any of them; the names are used only to identify the things they refer to.
