---
name: orchestrator
description: How agents with an orchestrator role (CoS, Steward, lead, thread) ask, answer, message and ack in the bb orchestrator. Use when an [orchestrator] message arrives or you hold an orch_* tool.
---

# Orchestrator

Every agent with a role gets `orch_*` tools and a live inbox in its instructions. Messages from the orchestrator
start with `[orchestrator] <kind> <id> from <sender>:`.

## Batched inbox (default)

Sending accumulates unread mail; it does not send each item into a turn. A burst gets
one debounced wake per recipient. On wake, call `orch_inbox` to read **all unread**
items oldest first, including full bodies, ids and refs. Handle the digest, then
`orch_ack(through=<returned cursor>)`. Reads do not ack. A cursor covers only that
snapshot and is bound to your current thread/address; later arrivals stay unread.
Cursor ack records mail as read, not a decision outcome. Still use `orch_ack(id,
outcome)` for decision outcomes or PR waits; then acknowledge the digest.

`orch_send` defaults to actionable (`severity: ACTION`). Use `severity: INFO` for
passive information: it never wakes by itself. `needs_reply: true` or a `due_at`
epoch-millisecond deadline makes INFO actionable. Copies and informational notices
are quiet; decisions/alarms remain actionable. Replies and newer messages never
implicitly acknowledge unread in batch mode.

Active recipients are left alone until idle. The wake uses `queue-if-active` if a
turn starts during delivery, never steering or interrupting that turn. The default
2-second debounce is checked by the existing 5-second clock. Unread remains until
cursor acknowledgement, including after restart, failed wake or dead-lettering.
Only wakes retry (one retry after `resendMinutes`, then dead), not message bodies.
CoS inspects `orch_inbox(wakes=true)` and retries a dead recipient wake with
`orch_inbox(retry_wake="lead:project")`. These calls do not acknowledge any mail.

Set `batchInbox=false` only to retain legacy per-message delivery for existing
workflows. The per-item retry/reply-ack descriptions below apply to that legacy
mode. Before changing modes, reconcile queued wakes/messages: changing settings
cannot recall a queued or in-flight dispatch. Batch unread/cursors remain stored;
read and acknowledge them before opting into legacy mode. See
`docs/batched-inbox.md` for crash and migration semantics.

## Addresses

`cos`, `steward`, `lead:<project>`, `thread:<project>:<n>`. The owner (the person the orchestrator works for) is not an address: they answer only
from the app's Needs you page.

## Rules of the road

- **Ask, don't block.** `orch_ask` (2 to 4 options, recommended FIRST) returns a decision id at once. End your turn or
  carry on; the answer arrives as a `decision.answer` message.
- **A thread talks only to its lead.** A lead talks to the CoS, other leads (the CoS gets a read-only copy) and its
  own threads.
- **The answer goes to the asker only.** A lead that filed a thread's question up (`orch_forward`) gets the answer and
  relays it with `orch_send(to=<thread>, ref=<decision id>)`, or withholds it. The CoS gets a read-only copy of each
  answer the owner gives (no ack).
- **Close what you handle** with `orch_ack(id, outcome, note)`, outcome `done | refused | failed | superseded`. An
  unacked item is sent once more after you go idle, then becomes a dead letter for the CoS. A note goes
  back to the agent that sent the item, as info. Acking an info item (no ack needed) just returns ok.
- **The CoS settles only by citing a standing rule id** (`orch_inbox` lists them) and never settles a merge card.
- **The CoS sees the owner's Needs you** with `orch_needs_you(since?, limit?, project?)` (the Steward too): waiting cards with
  their age, deferred ones, ones still in triage, and what the owner answered or what went moot lately. A card that no
  longer needs an answer comes off with `orch_moot(id, reason)`: never an answer, the asker is told why, and a later
  answer from the owner is refused.
- **The CoS sees the deliverables** with `orch_deliverables(project?, state?, since?)` (the Steward too): each lead's
  deliverables with their review state, the owner's note, and the latest revision's proof.
- **The CoS manages the dead letters.** An hourly notice lists the new ones; `orch_dead_letters` lists them all and
  resends, re-routes (`to`), closes (`outcome`, the sender is told) or escalates one (`note`) to the owner's board.
  Only escalated ones reach the board.
- **The CoS can create projects and start leads.** `orch_new_project(brief)` writes the project folder (PROJECT.md and
  the project record) and its row; the brief needs `slug`, `title`, `repo` (an existing absolute path; a URL alone is
  refused, nothing is cloned) and `goal`, with optional `repo_url`, `base`, `constraints`, `priority`. It refuses a
  taken slug or folder and never starts the lead. `orch_start_lead(slug)` runs the owner's Start lead checks (project
  folder, a repo under `## Repos` that exists here, not on hold, no live lead) and the board shows "cos started
  lead:<slug>".
- **A lead publishes its status** with `orch_status` when it starts, at each step change and whenever what it waits on
  changes: goal, numbered steps (at most one `current`), `waiting_on` and blockers. It is the step bar on the project
  page; after 2 h without one it shows as stale, and the lead is reminded once per change in its project since then.
- **Context is never cleared.** The plugin never clears an agent's context; Claude Code's auto-compaction handles it (`cosCompactTokens` is an opt-in, off by default, and it sends `/compact`). One deliberate exception that is not a clear: `orch_handoff` (the Claude↔Codex swap) starts a fresh successor session from the handoff file, in the same worktree, on purpose. Don't change it, and don't use it to shed context.
- **Recovery:** after a compaction or restart, `orch_inbox` (or `bb orchestrator inbox`) lists everything open.

## CLI (for the owner and operators, not agents with a role)

```
bb orchestrator status
bb orchestrator role set <threadId> <cos|steward|lead|thread> [<project>]
bb orchestrator inbox [--thread <id>] [--hook]
bb orchestrator stop|start <address>
bb orchestrator compact-cos [--force]
bb orchestrator host
bb orchestrator decision <id>
```

Settings (`bb plugin config orchestrator set <key> <value>`): `batchInbox` (true), `inboxDebounceMs` (2000, capped at 60000), `escalateMinutes` (5), `resendMinutes` (10),
`diskPct` (85), `swapPct` (50), `memPct` (90), `cpuPct` (95), `sustainSeconds` (300), `sampleSeconds` (60),
`diskPath` (/), `cosCompactTokens` (0 = off, the default: Claude Code compacts on its own; a token count opts in), `stateDir` (empty: state/ in the plugin's data folder),
`ownerName` (empty: agents say "the owner"), `cosTitle` (Chief of Staff), `projectsDir`, `projectRecord` (project.json),
`memoryConfig` (empty: memory off), `memoryConfigEnv` (MEMORY_CONFIG), `memoryUnits`, `memoryTimers`, `dreamsEnabled` (false).
