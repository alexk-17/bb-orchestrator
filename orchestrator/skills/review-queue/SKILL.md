---
name: review-queue
description: Inspect or configure Orchestrator's standalone CodeRabbit review queue.
---

Open Orchestrator's **Review queue** view. It owns manual PR ordering/pinning,
Auto discovery, a configurable interval and provider/model selection. The backend
is documented in `review-queue/README.md` in the plugin source.

Read state with `bb plugin rpc call orchestrator reviewQueue --json`. The
`reviewQueueAction` RPC accepts add/remove/pin/reorder/configure/refresh/run
operations; inspect its schema with `bb plugin rpc` help before writes.

`reviewQueueDryRun` defaults to true. Keep it enabled during development and while
another scheduler is active. A request to inspect or run a dry-run does not
approve live posting or stopping an existing scheduler. After the owner approves
cutover and has disabled the old scheduler, they can turn off this plugin setting.
Never alter the systemd/fleet scheduler as part of ordinary queue operation.

Default picker: deterministic. A model picker must use an explicit BB provider,
model, project and existing environment. It chooses only among validated
candidates; the plugin owns GitHub writes and rechecks eligibility and cooldown.
