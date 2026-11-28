# Usage Meter

Claude subscription limits, as two rings around a sidebar footer button — and a
**Usage** page that says where those limits went.

## The rings

- **Outer ring** — the five-hour session, the `Current session` window.
- **Inner ring** — the weekly limit, the `Weekly limit` window. Smaller radius,
  thinner stroke, a visible gap between the two.

Both fill clockwise from twelve o'clock and colour independently by their own
value: muted below 60%, amber from 60%, red from 85%, read off the rounded
figure shown. The popup's bars use the same rule (`toneOf` in `lib/limits.ts`),
so ring and bar always agree.

The per-model limit (`Fable`) gets no third ring: on a 32×32 button it stops
being readable, so it lives as a bar in the popup. Staying silent about it is
not an option either — the moment it passes 60%, a dot lights up in the top
right corner of the button in the same colour the rings take at that value.

- **Hover** — a popup with one bar per limit window: label, % used (number and
  fill) and the reset time in local time ("resets 21:20" today, "resets Tue
  02:00" within the week, a date further out), plus the plan and the account
  email. With two or more Account Pooler accounts, every account follows with
  its own bars, in the pool's routing order (priority, lower first; disabled
  accounts muted at the end). An account the pool reports exhausted says so.
- **Click** — the same popup, pinned: it survives the cursor leaving. Closes on
  a second click, on Escape, or on a click outside.

The outer ring repeats the geometry of the neighbouring
[server-status](../server-status) plugin: same path along the button's edge,
same thickness, same animation. The two buttons sit next to each other in the
footer and should read as one system. The neighbour's colour thresholds are its
own (80% and 90% of RAM usage) — different quantities, under no obligation to
match.

## The Usage page

The rings answer "how much is left". The page answers "what spent it", from the
transcripts Claude Code writes on this machine (`~/.claude/projects`, about two
gigabytes of them here). Two sliding windows, **Day** (last 24h) and **Week**
(last 7d); the choice lives in the URL, so a link to a window survives a reload.

Top half — the same summary the Claude Code extension for VS Code shows, and
deliberately so: the same weighted-cost formula, the same five behaviours, the
same 10% threshold, the same sentences and the same advice. Nothing is
paraphrased and nothing is re-scaled.

Two of the five statements have some give in them, and it is worth naming.
`sessions active for 8+ hours` and `subagent-heavy sessions` are counted per
session, and a session forked or resumed leaves the same calls in two
transcripts under two different session ids — the copy **rewrites** the id, so
which of them is the original is not in the data at all. Both this plugin and
the extension therefore break the tie arbitrarily: the plugin by the timestamp
of each file's first timestamped line and then by byte order of the path, the
extension by whatever order `readdir` returns. On the local history that is
worth up to about four percentage points on those two sentences, so seeing 40%
here and 37% there is the tie-break, not a bug. The other three statements are
counted per call and do not move.

| Statement | When it is shown |
| --- | --- |
| `…% of your usage was at >150k context` | calls whose cache read + cache write + uncached input passed 150k |
| `…% of your usage came from subagent-heavy sessions` | sessions with 3+ sidechain calls, or where sidechains cost more than half |
| `…% of your usage was while 4+ sessions ran in parallel` | five-minute buckets holding 4+ distinct sessions |
| `…% of your usage came from sessions active for 8+ hours` | sessions that touched 8+ distinct hours |
| `…% of your usage hit a >100k-token cache miss` | calls with more than 100k uncached input |
| `…% of your usage came from /skill`, `… subagents under "name"`, `… the plugin "name"`, `… the MCP server "name"` | the top row of each attribution table, once it clears 10% |

The percentage is a share of weighted cost, not of raw tokens: a cache read
counts 1, uncached input 10, a cache write 12.5, an output token 50, and the
call is multiplied by its model tier. Raw tokens would drown everything in
cache reads — they are 97% of the volume here — and every skill would round to
zero. The behaviours are not a breakdown: one call feeds several of them, and
the shares can add up to more than 100%. The page says so above them, in the
extension's own words.

Bottom half is ours, and the extension has no counterpart for it:

- **Skills** — how often each ran (the `Skill` tool, a slash command, or the
  moment its `SKILL.md` was injected), how heavy the injected instructions
  were, and the tokens Claude Code itself attributes to the skill.
- **Processes** — workflow runs and background `/go` runs by usage, each with
  its agent count, duration, status or exit code, taken from the run's own
  metadata.
- **Projects and threads** — tokens by working folder, by model, and by bb
  thread. Sessions map to threads through bb's own events, which do not live
  long, so older sessions honestly stay under `Without a bb thread`.
- **Usage over the window** — a hand-drawn SVG chart, stacked by main session /
  workflow agents / subagents, bucketed by the hour for a day and by six hours
  for a week, on the local clock.

Those figures are counted in **tokens**, and the columns say so: mixing them
silently with the weighted percentages above would make the whole page
untrustworthy.

Two more things the page says out loud rather than leaving to be discovered:

- Each of those tables keeps twelve rows, and a table that had more prints
  `… N more` underneath — the same line the attribution tables use. Twelve rows
  adding up to 97% is a cut list, and it should not have to be guessed at.
- The buckets of the chart sit on the local clock while the window ends at
  "now", so its first and last bar cover only part of their interval. They are
  drawn as narrow as the time they actually cover, and their tooltip says
  `partial interval, 23m of 6h`. Dropping them instead would have been tidier
  to look at and wrong: the bars would no longer add up to the total above.

Ways in: the **Usage** row in the sidebar (with the session percentage beside
it), or `More details →` at the bottom of the rings' popup.

## Install

```sh
bb plugin install git:https://github.com/alexk-17/bb-orchestrator@^1 --plugin usage-meter --tag-prefix usage-meter-v
```

Update with:

```sh
bb plugin update usage-meter
```

## How it works

`server.ts` runs two background services: one polls the limits, one reads the
transcripts.

The limit poll calls `bb.sdk.system.usageLimits()` and keeps the snapshot in
memory; the `state` RPC method serves that same snapshot, so the number of open
tabs adds no load on the API. Realtime does not apply here: the channel subscription lives only in the
`useRealtime` React hook, and the rings are drawn by a content script that
cannot reach hooks. So the snapshot is simply polled — every 60 seconds and when
the tab comes back into view.

| Detail | Handling |
| --- | --- |
| The provider rejects frequent calls ("Claude usage is rate limited right now") | Poll every 5 minutes; after a failure the period doubles up to half an hour |
| A one-off network failure | The previous numbers stay on screen: the rings keep showing them, and a dedicated popup row states their age (`okAt`) and the reason |
| `not_installed` / `unauthenticated` / `expired` | The snapshot is cleared: the old numbers are no longer about this account |
| The same complaint every minute | Only a change of reason reaches the log |

`app.tsx` holds the rings and the popup panel; the panel's body is React
(`components/UsagePopover.tsx`, on shadcn Progress, Separator and Badge in
`components/ui/`) mounted with the host's shared `react-dom/client`. The host renders the
`sidebarFooterAction` slot as an icon only, so the rings come from a content
script: its own `<svg>` goes inside the host button, absolutely positioned over
the icon and transparent to pointer events. Nodes the plugin does not own are
never moved or removed — the application blocks that; everything it does own
(node, listeners, timers, `MutationObserver`) is torn down by a disposer.

| Detail | Handling |
| --- | --- |
| The button does not exist yet when the script starts | A `MutationObserver` waits for it and restores the rings if React re-renders the footer |
| Hidden tab | The 60-second poll stays silent until the tab is visible again; returning from the background refreshes the numbers at once |
| The API returns a different set of windows | A ring is drawn only for a window that was found; the rest simply appear in the popup list |
| A cleared snapshot (`expired` and friends) | Both rings stand grey and empty, and the reason moves into the popup |
| An English provider message | Known ones are translated; an unknown one never reaches the interface — it goes into the row's tooltip |
| A long window label from the API | Truncated with an ellipsis inside the panel; the full text stays available as a tooltip |
| The host button's own tooltip | The popup notices it and moves higher so it does not cover it |
| A zero value | The arc hides entirely: a round stroke cap would leave a dot at twelve o'clock |
| A collapsed sidebar | A ring with no room is skipped rather than drawn as an inside-out path |

### The transcript scan

`usage-scan.ts` walks `~/.claude/projects`, deduplicates the calls and keeps a
cache of its own next to the plugin's database. The `usage` RPC method answers
from that cache, and the page never touches the transcripts itself.

| Detail | Handling |
| --- | --- |
| One API call is written as several lines, each carrying a full copy of `usage` | Deduplicated by `message.id`, globally: the same call in a forked transcript is not counted twice |
| The first pass reads about two gigabytes | It runs in the background, hands control back after every chunk, and the page shows its progress instead of an empty screen |
| Afterwards | Only the tails of files that changed are read — a pass costs about a second |
| A transcript that a fork copied disappears | The cache is rebuilt from scratch, in the background, rather than losing the calls that only lived there |
| Two files hold the same call and neither is the original | The tie goes to the file whose first timestamped line is older, then to byte order of the path — an arbitrary rule, and the only kind available (see above) |
| bb thread names | From `bb.sdk.threads` (thread list, and the session ids on each thread's `thread/identity` and `turn/started` events), never from `bb.db`: a second SQLite library in the server process drops the server's locks on it. An unreachable API only costs the names, not the figures |
| Message bodies | Never read into the summary: counts, names and paths only — from `SKILL.md` just its size, from a workflow run everything but the script |

## Development

```sh
npm install
npx tsc --noEmit
bb plugin build .
bb plugin dev .
```

## Provenance

Forked from [xMinor-1/bb-plugins](https://github.com/xMinor-1/bb-plugins) (usage-meter v0.2.5, MIT). Modifications in this version (0.3.0):

- An "All accounts" section in the rings' tooltip lists every Account Pooler account with each of its limits, and marks the account that matches the current login.
- Short labels for the "five-hour limit" and "weekly · fable" windows.
- A wider tooltip.

## License

MIT — see [LICENSE](LICENSE).
