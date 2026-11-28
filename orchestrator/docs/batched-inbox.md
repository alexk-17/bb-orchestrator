# Batched inbox

Batching is on by default (2026-11-20, tokens): `batchInbox` defaults to `true`, in
the plugin setting and in the embedded Engine. An install that never set it
switches to batching on the update; one that saved `false` keeps per-message
delivery. It applies to every registered recipient (CoS, Steward, leads and worker
threads).

Mail is written before delivery. `inbox_entries` gives each arrival a durable
sequence and explicit unread state, separate from the existing item/decision
lifecycle. No no-ref reply matching, per-item resend or newer-message
supersession runs in batch mode; a reply that names a message with `ref` still
closes it as replied. Existing pending/queued/delivered/dead mail is
backfilled when batch mode is used; previously closed mail is not resurrected.
Semantic card resolution may close an item, but its unread ledger entry stays
until acknowledged. Reading alone never changes unread state.

`orch_inbox` pages unread mail oldest first within a 32,000-byte serialized
response budget. A large item shows a preview and `orch_inbox(id, part)`
instructions. After fetching every part, read the inbox for a cursor. Part
reads belong to the current holder and arrival of the item. The opaque cursor
comes from a durable read snapshot. `orch_ack(through=cursor)` acknowledges that
thread and address's prefix atomically. At upgrade, fetch a new cursor for any
unacknowledged page issued by the old version.
Retrying a cursor cannot reset a newer wake. Cursor ack records mail as read; it
does not approve/answer a decision, grant a plan or merge anything. It closes only
items that need no outcome (copies, notices), as per-message delivery does. An item
that asks for an outcome (`needs_ack`: messages, relays, imported tasks) is only
marked delivered: it stays open until `orch_ack(id, outcome)` or a reply with its
ref, so the sender's ack note and any relay settlement still happen. The digest
header says the ack rules once; each entry is one line (id, kind, sender, ref when
set, severity, `outcome` when only an explicit ack or a ref'd reply closes it,
needsReply and dueAt when set), then its body. A direct message keeps its own rules. Those actions
retain their existing tools and approval gates. The instruction recovery view and
`inbox --hook` remain previews, not cursor-bearing reads.

One durable `inbox_wakes` row per recipient coalesces arrivals. INFO never wakes
alone; ACTION (the send default), needs-reply or a due deadline does. The wake
carries the first digest page within a 16,000-byte serialized budget. Later
arrivals remain unread. A wake to a thread bb reports busy goes bare because bb
queues it behind the turn. `inboxDebounceMs` defaults to 2000 and is checked by
the existing 5-second clock. A lead gets at least `inboxGapMs` (default 120000, 0 = off)
between two wakes (2026-11-24): mail inside the gap joins the next wake, whose
`due_at` moves to the gap's end; the owner's items, overdue items, the owner's Resend
and the CoS's `retry_wake` skip it. The wake timer also fires at each unread deadline still to come, so an item due inside the gap goes at its deadline, not at the gap's end. The CoS, the Steward and threads have no gap. A held wake's `due_at` is worked out again at each flush from its own debounce, and a change to `inboxGapMs` runs a flush, so lowering the gap or turning it off shortens a wake it already held. Each
wake that goes is kept in `inbox_wake_log`, and a status nudge waits for one after the
lead's last status. Busy/stopped/archived recipients and held projects
wait. Delivery uses `queue-if-active`, so a status race cannot steer an active
turn. A queued wake is not retried while it remains queued.

The wake reservation is persisted before the SDK call. Crashing after that call
but before recording its result can repeat the wake, not lose or acknowledge
mail. This is at-least-once notification, not an exactly-once SDK promise. Missing
queue rows after downtime are uncertain, not proof of reading. After the idle
retry timeout (`resendMinutes`), one retry is allowed; further failure dead-letters
the wake. CoS inspects `orch_inbox(wakes=true)` and retries a dead wake using
`retry_wake=<recipient>`. Unread remains readable even when a wake is dead. An
explicit handoff transfers unread and refuses predecessor cursors; predecessor
queued wakes may still arrive but carry no mail and grant no authority.

Switching modes does not recall SDK queues. Reconcile queued/in-flight messages
and wakes and acknowledge batch unread before opting out. Legacy mode keeps its
previous steering, reply-ack, resend and supersession behavior. Returning to batch
mode retains its unread ledger; no migration deletes that history.

External mail (`bb orchestrator integration import`) goes through the same
ledger. Each import keeps its own policy: INFO without needs-reply wakes nobody
until its `dueAt`, or never without one; anything else wakes its recipient. That
holds for mail imported before batching was switched on too: the backfill reads
the import's policy, not the item's needs-ack. A source/recipient pair removed
from `integrationRoutes` pauses the import's wake and its retries, as it pauses
per-message delivery; the import still shows in a digest read for other mail.
Receipts add `readAt` (the digest ack) and `wake` (the recipient's wake that
covers an unread import) beside `state` and `outcome`, so woken, read and
handled stay apart. An import asks for an outcome, so a cursor ack leaves it open
until `orch_ack(id, outcome)`.
