# Review queue

A standalone CodeRabbit queue in Orchestrator. It needs a connected BB host with
`gh` signed in. No fleet checkout, Python script, systemd unit, or fixed model is
required. Open **Orchestrator → Review queue**.

Add GitHub PR URLs, drag rows or use the up/down buttons, and pin one PR to choose
it next. Refresh reads CI, unresolved review threads, human approvals, and the
last CodeRabbit review versus the current head. Closed, merged and reviewed-head
rows remain visible with their reason; remove them when done. Removal never
clears attempt history. Auto may rediscover a removed PR if it is still eligible.

## Scheduling and cutover

Both **Schedule** and **Auto** start off. The interval is 65 minutes by default,
configurable from 60 minutes to one week. A plugin-owned minute schedule checks a
persisted next-run timestamp, so 65 minutes does not reset at hour boundaries.
Missed intervals coalesce into one run, never a burst. **Run now** obeys the same
cooldown, minimum spacing and eligibility checks.

**`reviewQueueDryRun` defaults to true.** Dry-run checks and selects, but never
posts a GitHub comment or consumes live attempt history. It reports the PR it
would select. The tab deliberately has no live-posting switch. To cut over, the
owner must first approve the change and disable their previous scheduler, then
turn off `reviewQueueDryRun` in Orchestrator's plugin settings. This feature never
reads, stops, edits or imports an external scheduler. Keep dry-run on while
another scheduler is active.

Live mode posts exactly `@coderabbitai review`, at most once per tick. A durable
SQLite intent is saved before posting. The host rechecks identity, head and
eligibility before writing. A lost/ambiguous response is reconciled against the
user's recent comments; if uncertain it consumes spacing and the three-hour hold.
Only a definite HTTP rejection with no matching comment is a safe post failure.
There is no automatic retry of the write RPC. A ten-minute cross-generation lease
prevents overlapping runs; an interrupted run can retain that lease until expiry.
The worker has a five-minute deadline and is cancelled on plugin disposal.

The queue checks pending replies each minute, even when the next review isn't due.
Only CodeRabbit's marked automatic replies after the trigger count: accepted,
not completed, or rate limited. After three minutes without a reply the outcome
becomes `no reply`; later replies can still reconcile during the hold. Rate-limit
waits use the bot's summary when present, default to one hour, and cap at six hours.

## Eligibility and priority

- Skip closed/merged PRs, drafts, any head with a completed CodeRabbit review,
  a fresh review-in-progress marker (two hours), and the authenticated user's
  exact review request in the last three hours.
- Hold uncertain/posted attempts for three hours, and stop after three attempts
  on the same head. New commits reset the attempt budget. Rate-limited and
  definitely rejected posts don't consume that budget.
- Auto searches the authenticated user's open PRs across repositories when no
  queued PR is eligible. Auto requires passing required checks and no conflicts,
  and rechecks authorship before posting. It does not trust the Open PRs login
  setting. Pending/unknown checks wait. No required checks is eligible when `gh`
  explicitly confirms that; unreadable checks remain unknown.
- Manual entries may have failing/unknown CI or conflicts. They rank below
  human-ready work unless pinned or carrying exactly one current-head approval.
- Priority is: pinned; exactly one human approval on head; no approvals with
  passing required checks and no conflict; everything else. Queue order breaks
  ties. Only each non-author human's latest opinionated review counts; bot
  approvals and old-head approvals don't count.

These rules intentionally tighten the old fleet script in two places: pending
checks are not green for Auto, and any completed CodeRabbit review on the current
head prevents another request (not just an approval or a post-trigger review).

The dashboard holds at most 50 PRs. Auto examines up to the 50 most recently
updated matching PRs. Reviews, comments and threads paginate fully up to 2,000
records each; a partial/error response is ineligible. Work exceeding the deadline
is cancelled, not triggered using stale facts. Global spacing is at least 60
minutes. Queue state, head attempt history, cooldown and next run live in the
plugin database, independently of the rest of Orchestrator.

## Picker

The default is deterministic and needs no model. Queue settings can select any
installed BB provider, an explicit model ID, a BB project and an existing BB
environment. An unpinned selection starts a short, visible BB picker thread and
archives it afterward. It receives only opaque indexes and bounded facts (CI,
approvals, thread counts and order), never PR titles, bodies, repository URLs,
credentials or a posting tool. Its prompt forbids tools and writes. The provider
still uses its normal BB permissions; use a suitable environment. A provider
thread is advisory, not a sandbox or an authority to trigger GitHub actions.

The picker has 90 seconds to return `{"index":N}`. An unavailable model, invalid
answer or timeout falls back deterministically. Pins bypass it. The plugin
revalidates the selected PR after the model finishes; a model cannot invent a PR,
bypass eligibility, change the comment, or remove the cooldown.

## Validation

`npm test`, `npm run typecheck`, `bb plugin build`. Focused queue tests exercise
eligibility, pagination errors, reply parsing, cooldowns, durable concurrency,
crash intent, stale model answers, pin precedence, the provider adapter, and
zero-write dry runs. Live verification must keep `reviewQueueDryRun=true` until
cutover is approved. Live posting is not part of the development smoke test.
