# Batched inbox

Batching is opt-in: `batchInbox` defaults to `false`, in the plugin setting and in
the embedded Engine, so an existing install keeps per-message delivery on upgrade.
Set `batchInbox=true` to batch for every registered recipient (CoS, Steward, leads
and worker threads). No installed plugin or live thread is changed by building
this source.

Mail is written before delivery. `inbox_entries` gives each arrival a durable
sequence and explicit unread state, separate from the existing item/decision
lifecycle. No automatic reply matching, per-item resend or newer-message
supersession runs in batch mode. Existing pending/queued/delivered/dead mail is
backfilled when batch mode is used; previously closed mail is not resurrected.
Semantic card resolution may close an item, but its unread ledger entry stays
until acknowledged. Reading alone never changes unread state.

`orch_inbox` returns one digest of all unread bodies, ids, sender, kind, ref,
severity, needs-reply and due timestamp, oldest arrival first. There is no preview
truncation or hidden pagination: a large backlog produces a large digest. The
opaque cursor comes from a durable read snapshot. `orch_ack(through=cursor)`
acknowledges only that thread/address's prefix atomically; later arrivals survive.
Retrying a cursor cannot reset a newer wake. Cursor ack records mail as read; it
does not approve/answer a decision, grant a plan or merge anything. Those actions
retain their existing tools and approval gates. The instruction recovery view and
`inbox --hook` remain previews, not cursor-bearing reads.

One durable `inbox_wakes` row per recipient coalesces arrivals. INFO never wakes
alone; ACTION (the send default), needs-reply or a due deadline does. Full message
bodies never appear in a wake. `inboxDebounceMs` defaults to 2000 and is checked by
the existing 5-second clock. Busy/stopped/archived recipients and held projects
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

This PR is independent of compatibility PR #1 and based on upstream main. Named,
idempotent batch tables avoid a collision with #1's appended external-mail
migration. `BatchInbox.record`/`policy` accepts severity, needs-reply and deadline
policy. Combining #1's external importer requires wiring that policy and its
integration-route pause checks into batching, plus receipt semantics for
wake-vs-item delivery. Do not infer external integration compatibility from both
patches applying: that combination needs its own tests. No external imports,
providers or adoption behavior are added here.
