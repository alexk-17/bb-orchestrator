// The frontend contract. Reads go over bb RPC; the owner's writes go to plain HTTP routes that require a browser Origin
// (a guard rail so an agent's `bb plugin rpc call` can't answer as the owner; curl can still fake an Origin).
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { blockSchema, pointSchema } from "./blocks.ts";
import { LIST_WAIT_KINDS, STEP_STATES, WAIT_KINDS } from "./core/status.ts";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES } from "./core/direct-images.ts";
export { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES };

export const PLUGIN_ID = "orchestrator";
/** The owner's writes: POST JSON to `${WRITE_BASE}/<path>`. */
export const WRITE_BASE = `/api/v1/plugins/${PLUGIN_ID}/http`;
export const CHANGED_CHANNEL = "changed";

const opt = z.object({ id: z.string(), label: z.string(), detail: z.string(), recommended: z.boolean() });

const prSchema = z.object({ url: z.string().nullable(), number: z.number().nullable(), state: z.string().nullable(), attention: z.string().nullable(), checks: z.string().nullable() });

export const cardSchema = z.object({
  id: z.string(),
  rev: z.number(),
  project: z.string().nullable(),
  asker: z.string(), // the address the answer goes to
  origin: z.string(), // who first asked
  title: z.string(),
  question: z.string(),
  context: z.string(),
  options: z.array(opt), // recommended first
  allowText: z.boolean(),
  askedAt: z.string(),
  escalated: z.boolean(), // "CoS didn't triage"
  merge: z.boolean(), // a merge card
  deferredUntil: z.string().nullable(), // set on deferred cards; null + deferred=true means "until brought back"
  deferred: z.boolean(),
  returnedAt: z.string().nullable(),
  blocks: z.array(blockSchema), // typed parts drawn as components (blocks.ts)
  prs: z.array(prSchema), // the live state of its PR blocks that pr-watch knows, by url
  queued: z.number().optional(), // cards from the same asker held behind this one (batching); they come up once it is answered
  // a scoping lead's "Scoping done?" card (1.11.0): its summary and PROJECT.md, drawn above its options
  scopingDone: z.object({ summary: z.string(), projectMd: z.string() }).nullable().optional(),
  // the scoping task it waits under in the Scope tab (1.12.0), or none for the whole project
  scopeTask: z.string().nullable().optional(),
});
export type Card = z.infer<typeof cardSchema>;

export const presetSchema = z.object({ id: z.enum(["1h", "evening", "tomorrow", "manual"]), label: z.string(), until: z.string().nullable() });
export type Preset = z.infer<typeof presetSchema>;

// a question an agent asked through its own question tool (interactions.ts): the card draws these as options
export const questionSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  shortLabel: z.string().nullable(),
  allowFreeText: z.boolean(),
  multiSelect: z.boolean(),
  required: z.boolean(),
  options: z.array(z.object({ label: z.string(), value: z.string(), description: z.string().nullable() })),
});

export const interactionSchema = z.object({
  id: z.string(), // bb's interaction id
  threadId: z.string(),
  address: z.string(),
  title: z.string(), // the thread's title
  kind: z.string(), // what the thread waits for
  since: z.string().nullable(),
  questions: z.array(questionSchema), // a user_question's questions; empty for other prompts (answered in the thread)
});

export const needsYouSchema = z.object({
  cards: z.array(cardSchema), // answerable, in order
  deferred: z.array(cardSchema),
  triaging: z.array(z.object({ id: z.string(), title: z.string(), origin: z.string(), project: z.string().nullable(), dueAt: z.string().nullable() })),
  interactions: z.array(interactionSchema), // threads with an orchestrator role waiting on a native prompt
  presets: z.array(presetSchema),
  badge: z.number(), // only the owner's items: cards + interactions
});
export type NeedsYou = z.infer<typeof needsYouSchema>;

// The Watchers list on the Board (2026-11-17, core/watchers.ts): every open PR wait and every timed job
export const watchWaitSchema = z.object({
  id: z.string(),
  owner: z.string(),
  ownerLive: z.boolean(),
  ref: z.string(),
  about: z.string(),
  prUrl: z.string(),
  when: z.string(),
  createdAt: z.number(),
  reading: z.object({ state: z.string().nullable(), checks: z.string().nullable(), review: z.string().nullable(), attention: z.string().nullable(), source: z.enum(["bb", "gh"]), changedAt: z.number(), readAt: z.number().nullable() }).nullable(),
});
export const watchJobSchema = z.object({
  id: z.string(),
  what: z.string(),
  kind: z.enum(["every", "after"]),
  interval: z.string(),
  setting: z.string().nullable(),
  value: z.number().nullable(),
  unit: z.enum(["min", "s"]).nullable(),
  off: z.boolean(),
  last: z.number().nullable(),
  next: z.number().nullable(),
  command: z.string().nullable(),
});
export const watchersSchema = z.object({ waits: z.array(watchWaitSchema), jobs: z.array(watchJobSchema), conditions: z.array(z.string()) });
export type Watchers = z.infer<typeof watchersSchema>;

// The personas hook (personas.ts, 2026-11-18): an agent's persona, with the pokemon setting on and a pack loaded.
export const personaSchema = z.object({
  name: z.string(),
  title: z.string(),
  image: z.string(), // https, safe in a CSS url()
  credit: z.string().nullable(),
  team: z.array(z.string()), // names for a profile card only
  teamDex: z.array(z.number().nullable()).optional(), // each team member's National Dex number, for its sprite (2026-11-18)
  roster: z.array(z.string()).optional(), // a lead's roster lines: its party lists the threads on them first
  partner: z.string().nullable(), // the CoS's and the Steward's own Pokémon (its form now); null for a lead
  type: z.string().nullish(), // the pack's specialty type (2026-11-18): the Projects label names it; none: the project's
});
export type AgentPersona = z.infer<typeof personaSchema>;

export const boardSchema = z.object({
  rows: z.array(z.object({ id: z.string(), kind: z.string(), from: z.string().nullable(), project: z.string().nullable(), title: z.string(), body: z.string(), ref: z.string().nullable(), at: z.number() })),
  dead: z.array(z.object({ id: z.string(), recipient: z.string(), sender: z.string(), kind: z.string(), body: z.string(), note: z.string().nullable(), createdAt: z.number() })),
  agents: z.array(z.object({ threadId: z.string(), address: z.string(), role: z.string(), project: z.string().nullable(), status: z.string(), mon: z.string().nullable(), monType: z.string().nullable(), dex: z.number().nullish(), persona: personaSchema.nullish() })), // dex and persona (2026-11-18): engine.faceOf
  rules: z.array(z.object({ id: z.string(), text: z.string(), project: z.string().nullable(), kinds: z.array(z.string()), expiresAt: z.number().nullable(), source: z.string(), createdAt: z.number(), revokedAt: z.number().nullable() })),
  decisions: z.array(z.object({ id: z.string(), state: z.string(), title: z.string(), origin: z.string(), asker: z.string(), level: z.string(), answer: z.string().nullable(), ack: z.string().nullable(), updatedAt: z.string() })),
  directUnread: z.array(z.string()).optional(), // projects with a lead's note the owner hasn't opened: the Projects tab's dot
  watchers: watchersSchema.optional(), // the Watchers list (core/watchers.ts): open PR waits and timed jobs
});
export type Board = z.infer<typeof boardSchema>;


// A lead's structured status (core/status.ts): the project page's step bar and the Projects line.
export const leadStatusSchema = z.object({
  goal: z.string(),
  steps: z.array(z.object({ title: z.string(), state: z.enum(STEP_STATES) })),
  waitingOn: z.object({ kind: z.enum(WAIT_KINDS), ref: z.string().nullable(), label: z.string().nullable() }),
  // up to three waits, newer kinds only here (status.ts); absent in statuses stored before it: waitsOf
  waits: z.array(z.object({ kind: z.enum(LIST_WAIT_KINDS), ref: z.string().nullable(), label: z.string().nullable(), who: z.string().nullable(), since: z.number() })).optional(),
  blockers: z.array(z.string()),
  // the Lead status card (2026-11-17); absent until the lead's first update
  update: z.object({ workingOn: z.array(z.string()), at: z.string(), needs: z.string(), updateAt: z.number() }).nullish(),
  updatedAt: z.number(),
  by: z.string(),
});

// The Projects row (2026-11-16, core/history.ts buildSummary): one batched read, no bb calls. Optional: an older server
// sends none, and the row then falls back to the status line.
export const summaryWaitSchema = z.object({
  source: z.enum(["lead", "live"]),
  kind: z.string(),
  ref: z.string().nullable(),
  who: z.string().nullable(),
  label: z.string().nullable(),
  since: z.number().nullable(),
  unchanged: z.boolean(),
  note: z.string().nullable(), // what a live fact adds to a wait that still stands ("the thread failed")
});
export const projectSummarySchema = z.object({
  motion: z.enum(["held", "nolead", "moving", "waiting", "quiet"]),
  threads: z.object({ working: z.number(), total: z.number() }),
  leadWorking: z.boolean(),
  needsYou: z.object({ count: z.number(), id: z.string().nullable(), title: z.string().nullable(), question: z.string().nullable(), since: z.number().nullable() }),
  waits: z.array(summaryWaitSchema), // each once; none a live fact shows is over
  blockers: z.array(z.string()), // the lead's, minus those a later answer covers
  statusOutOfDate: z.boolean(), // a live fact contradicts the status: the row says so, the lead was asked to republish
  done: z.object({ text: z.string(), at: z.number(), kind: z.enum(["deliverable", "merged", "report"]) }).nullable(),
  last: z.object({ text: z.string(), at: z.number() }).nullable(), // the latest finished thing at any age (quiet rows)
  leadIdleSince: z.number().nullable(),
});
export type SummaryWait = z.infer<typeof summaryWaitSchema>;
// The owner's direct line to a project's lead (2026-11-16, PLAN 3): the latest messages, newest first, each with the
// lead's ack note once it acks. unread: a note came in since the owner last opened the composer.
export const directMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  at: z.number(),
  followUp: z.string().nullable(),
  state: z.string(),
  outcome: z.string().nullable(),
  note: z.string().nullable(),
  answeredAt: z.number().nullable(),
  unread: z.boolean().optional(), // the lead's answer came after the owner last opened the thread
  images: z.array(z.object({ name: z.string() })).optional(), // 2026-11-17: the screenshots it carried (text is without their line)
});
export const directLineSchema = z.object({ messages: z.array(directMessageSchema), unread: z.boolean() });
export type DirectLine = z.infer<typeof directLineSchema>;

// Phase 2: the Projects tab (the owner sets priority and hold) and each agent's live state (its lanes; the Agents tab
// it fed went into Projects on 2026-11-16).
// The Projects tab as a source of truth (core/book.ts): one project's Decided, Done, latest merges and blockers' start,
// read only for the project opened; older answered cards for the search.
export const projectBookSchema = z.object({
  decided: z.array(z.object({ id: z.string(), title: z.string(), answer: z.string(), at: z.number() })),
  done: z.array(z.object({ kind: z.enum(["deliverable", "merged", "report"]), text: z.string(), at: z.number(), ref: z.string().nullable(), state: z.string().nullable() })),
  merged: z.array(z.object({ number: z.number().nullable(), url: z.string().nullable(), at: z.number() })),
  mergedTotal: z.number(),
  since: z.array(z.object({ text: z.string(), since: z.number(), bound: z.boolean() })),
  // pinned documents (core/pins.ts): the live pins, "updated" read at this read
  pins: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["file", "link", "deliverable"]),
      title: z.string(),
      icon: z.enum(["page", "doc", "link", "box"]),
      path: z.string().nullable(),
      hostId: z.string().nullable(),
      url: z.string().nullable(),
      deliverable: z.string().nullable(),
      updatedAt: z.number().nullable(),
      rev: z.number().nullable(),
      missing: z.boolean(),
    }),
  ).optional(), // optional: a page served by an older plugin process during an update draws no strip
});
export type ProjectBook = z.infer<typeof projectBookSchema>;
export const cardHitsSchema = z.array(z.object({ id: z.string(), project: z.string().nullable(), title: z.string(), answer: z.string(), at: z.number() }));
export type CardHits = z.infer<typeof cardHitsSchema>;


export const projectsSchema = z.array(
  z.object({
    slug: z.string(),
    priority: z.enum(["urgent", "high", "normal", "low"]),
    heldAt: z.number().nullable(),
    archivedAt: z.number().nullable(),
    // scoping (1.11.0): the owner settles its scope with the lead in the Scope tab; optional for an older plugin process
    mode: z.enum(["scoping", "active"]).optional(),
    lead: z.object({ address: z.string(), threadId: z.string(), status: z.string(), mon: z.string().nullable(), persona: personaSchema.nullish() }).nullable(),
    threads: z.number(),
    openPlans: z.number(), // plan cards not yet decided
    status: leadStatusSchema.nullable(), // the lead's latest orch_status (core/status.ts)
    monType: z.string().nullable(), // the project's Pokémon type (mons.ts TYPES): its accent; null with the setting off
    summary: projectSummarySchema.nullish(), // the row's summary; none for an archived project
    direct: directLineSchema.nullish(), // the owner's direct messages to its lead; none before the first
    // the PRs the plugin has read for this project's threads: a PR number in its text links only to one of these
    prs: z.array(z.object({ number: z.number(), url: z.string(), state: z.string(), checks: z.string().nullable(), review: z.string().nullable(), attention: z.string().nullable() })).optional(),
    // open PRs whose threads were resolved as handed off (orch_resolve handed_off), newest first
    handedOff: z.array(z.object({ pr: z.string(), owner: z.string(), note: z.string().nullable(), at: z.number(), thread: z.string() })).optional(),
    // its open scoping tasks (1.13.0), oldest first, each with its live scoping thread's address (none: the lead plans it)
    tasks: z.array(z.object({ id: z.string(), name: z.string(), planner: z.string().nullable() })).optional(),
  }),
);
export type Projects = z.infer<typeof projectsSchema>;

export const agentsSchema = z.array(
  z.object({
    threadId: z.string(),
    address: z.string(),
    role: z.string(),
    project: z.string().nullable(),
    monType: z.string().nullable(), // its project's Pokémon type (the project accent); null with the setting off
    priority: z.string().nullable(),
    held: z.boolean(),
    status: z.string(),
    // the orchestrator's own status: "stopped" and "archived" live only here (bb's status says idle)
    engineStatus: z.string(),
    idleAt: z.number().nullable(), // when it went idle, while it is
    title: z.string().nullable(),
    lastReport: z.string().nullable(), // the title of its last orch_report
    provider: z.string().nullable(), // bb's provider id, when there is no model yet
    mon: z.string().nullable(), // the base Pokémon (what was picked)
    form: z.string().nullable(), // what it is now, after any evolution
    formDex: z.number().nullish(), // its National Dex number (a pack's lines are unknown to the browser's mons.ts)
    persona: personaSchema.nullish(), // a person instead of a Pokémon: the CoS, the Steward, a lead (personas.ts)
    level: z.number(), // from XP, uncapped
    xp: z.number(), // tokens processed by this address's turns
    xpThis: z.number(), // XP where this level started
    xpNext: z.number(), // XP for the next level
    model: z.string().nullable(),
    usedTokens: z.number().nullable(),
    contextWindow: z.number().nullable(),
    branch: z.string().nullable(),
    pr: prSchema.extend({ review: z.string().nullable() }).nullable(),
    unread: z.boolean(), // something happened since the owner last looked at the thread
    flags: z.array(z.string()), // "unplanned"
    scopeTask: z.object({ id: z.string(), name: z.string() }).nullable().optional(), // the open task it is the scoping thread of (1.13.0)
  }),
);
export type Agents = z.infer<typeof agentsSchema>;

// The project page (2026-11-16): one project's history from the events log (core/history.ts), for its Timeline, Agent
// flow and Dependencies views. Times are ms epoch; a segment's "nolog" is before the log started (start and end only).
export const projectHistorySchema = z.object({
  slug: z.string(),
  now: z.number(),
  start: z.number(),
  logSince: z.number().nullable(),
  rows: z.array(
    z.object({
      address: z.string(),
      role: z.string(),
      live: z.boolean(),
      parent: z.string().nullable(),
      holders: z.array(
        z.object({
          threadId: z.string(),
          from: z.number(),
          to: z.number().nullable(),
          provider: z.string().nullable(),
          segments: z.array(z.object({ from: z.number(), to: z.number(), state: z.enum(["working", "idle", "blocked", "released", "unknown", "nolog"]) })),
        }),
      ),
      marks: z.array(z.object({ at: z.number(), kind: z.enum(["pr-open", "pr-draft", "pr-merged", "pr-closed", "handoff", "resolve", "mode"]), label: z.string(), url: z.string().nullable() })),
      asks: z.array(z.object({ id: z.string(), title: z.string(), from: z.number(), to: z.number().nullable() })),
      prs: z.array(z.object({ url: z.string(), number: z.number().nullable(), state: z.string() })),
    }),
  ),
  deps: z.array(
    z.object({
      from: z.string(),
      on: z.string(),
      kind: z.enum(["card", "held", "deferred", "hold", "dead", "reply", "pr", "ci", "review"]),
      label: z.string(),
      since: z.number().nullable(),
      ref: z.string().nullable(),
      block: z.boolean(),
    }),
  ),
});
export type ProjectHistory = z.infer<typeof projectHistorySchema>;

// Phase 3: Outputs, the finished artefacts leads and threads recorded for the owner. A file opens in bb's preview on its
// host (hostId + path), a link in a new tab.
export const outputsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    kind: z.enum(["doc", "video", "image", "report", "link"]),
    path: z.string().nullable(),
    url: z.string().nullable(),
    hostId: z.string().nullable(),
    note: z.string().nullable(),
    project: z.string().nullable(),
    author: z.string(), // the recording agent's address
    at: z.number(),
    gone: z.boolean(), // a file output whose file no longer exists (2026-11-18: the Files view says "Missing")
  }),
);
export type Outputs = z.infer<typeof outputsSchema>;

// Deliverables (docs/deliverables-plan.md): a lead's finished work with proof, for the owner to approve or send back. A proof
// file is shown through the proof route (GET `${WRITE_BASE}${PROOF_ROUTE}?id=<proof id>`, or `?output=<output id>` for a
// recorded output's file), or opened in bb's preview.
export const PROOF_ROUTE = "/proof";
export const proofSchema = z.object({
  id: z.string(),
  kind: z.enum(["image", "video", "text", "doc", "pr", "link"]),
  caption: z.string(),
  path: z.string().nullable(),
  url: z.string().nullable(),
  hostId: z.string().nullable(),
  pr: prSchema.nullable(), // a PR proof's live state, when pr-watch saw the same URL
  // 2026-11-17: a file copied into its deliverable's folder: `path` is the copy, `source` the original
  source: z.string().nullable().optional(),
  stored: z.enum(["copied", "too_big", "missing", "failed"]).optional(),
  bytes: z.number().optional(),
});
export const deliverablesSchema = z.array(
  z.object({
    id: z.string(),
    project: z.string().nullable(),
    lead: z.string(), // the delivering lead's address
    leadMon: z.string().nullable(),
    leadPersona: personaSchema.nullish(), // the lead's person (2026-11-18): null with the setting off, no pack, or the lead gone
    title: z.string(),
    summary: z.string(),
    state: z.enum(["review", "approved", "changes", "withdrawn"]),
    rev: z.number(), // the revision the owner's writes must carry
    createdAt: z.number(),
    updatedAt: z.number(),
    revisions: z.array(z.object({ rev: z.number(), summary: z.string(), at: z.string(), proof: z.array(proofSchema), blocks: z.array(blockSchema), points: z.array(pointSchema), prs: z.array(prSchema) })),
    feedback: z.array(z.object({ rev: z.number(), by: z.string(), text: z.string().nullable(), at: z.string(), outcome: z.enum(["approved", "changes"]) })),
    withdrawn: z.object({ at: z.string(), reason: z.string().nullable() }).nullable(),
    // the owner's next action for the lead, and the outcome and note the lead closed it with (state closed)
    next: z
      .object({ text: z.string(), rev: z.number(), at: z.string(), item: z.string(), state: z.enum(["open", "closed", "dead"]), outcome: z.string().nullable(), note: z.string().nullable(), closedAt: z.number().nullable() })
      .nullable(),
    // delivered while its project was scoping: reviewed in the Scope tab, not on Deliverables (1.11.0)
    scope: z.boolean().optional(),
    scopeTask: z.string().optional(), // the scoping task it is reviewed under (1.12.0)
    folder: z.string().optional(), // its own folder of files and README.md (2026-11-17)
  }),
);
export type Deliverables = z.infer<typeof deliverablesSchema>;

// Each deliverable's own folder (2026-11-17), listed for the Deliverables tab: its files by kind, proof copies and the
// rest (a thread's notes and outputs), and its README. `hostId`: the bb host the folders are on, for bb's preview.
export const folderFileSchema = z.object({ path: z.string(), name: z.string(), kind: z.enum(["images", "videos", "artifacts"]), bytes: z.number(), at: z.number(), dir: z.boolean() });
export const deliverableFoldersSchema = z.object({
  hostId: z.string().nullable(),
  folders: z.record(z.string(), z.object({ folder: z.string(), readme: z.string().nullable(), files: z.array(folderFileSchema) })),
});
export type DeliverableFolders = z.infer<typeof deliverableFoldersSchema>;
export type FolderFile = z.infer<typeof folderFileSchema>;

// The Scope tab (1.11.0): each scoping project and the cards waiting on the owner there; badge: those cards. Its
// deliverables come from the deliverables read (scope: true).
// 1.12.0: an active project is listed too while it has open scoping tasks; whole says it scopes as a whole, and its tasks
// group the cards (by scopeTask). Both optional for an older plugin process (every listed project scoped as a whole).
export const scopeSchema = z.object({
  projects: z.array(
    z.object({
      slug: z.string(),
      cards: z.array(cardSchema),
      whole: z.boolean().optional(),
      // planner (1.13.0): the task's live scoping thread (bb's title, the engine's status), none while the lead plans it.
      // idleAt and report (2026-11-17): since when it is idle, and the title and time of its last orch_report, for the
      // status card the entry shows while nothing waits; optional for an older plugin process
      tasks: z
        .array(
          z.object({
            id: z.string(),
            name: z.string(),
            openedAt: z.number(),
            planner: z
              .object({ address: z.string(), threadId: z.string(), title: z.string().nullable(), status: z.string(), idleAt: z.number().nullable().optional(), report: z.object({ text: z.string(), at: z.number() }).nullable().optional() })
              .nullable()
              .optional(),
          }),
        )
        .optional(),
    }),
  ),
  badge: z.number(),
});
export type Scope = z.infer<typeof scopeSchema>;

export const pathwaysErrorKindSchema = z.enum([
  "invalid-record",
  "auth",
  "rate-limit",
  "timeout",
  "server",
  "graphql",
  "map-missing",
  "project-missing",
  "network",
]);
export type PathwaysErrorKind = z.infer<typeof pathwaysErrorKindSchema>;

export const pathwaysSchema = z.object({
  error: z.string().nullable(),
  errorKind: pathwaysErrorKindSchema.nullable().optional(),
  notice: z.string().nullable().optional(),
  map: z.object({
    identifier: z.string(), title: z.string(), url: z.string(),
    source: z.enum(["linear", "orchestrator"]).optional(),
    tickets: z.array(z.object({ identifier: z.string(), title: z.string(), url: z.string(), state: z.object({ type: z.string(), name: z.string() }), priority: z.number(), estimate: z.number().nullable(), type: z.string(), assignee: z.string().nullable(), unknown: z.array(z.string()), blockers: z.array(z.string()), displayState: z.enum(["done", "needs-you", "blocked", "claimed", "unknown", "ready"]), waitsOnYou: z.boolean(), readiness: z.object({ state: z.enum(["ready", "needs decision", "needs proof plan"]), reasons: z.array(z.string()), source: z.string() }), prLink: z.object({ state: z.enum(["missing", "linked", "ambiguous"]), urls: z.array(z.string()), source: z.enum(["attachment", "description", "both"]).nullable() }), prs: z.array(z.object({ pr: z.object({ url: z.string(), state: z.enum(["unavailable", "blocked", "ready", "merged", "closed"]), number: z.number().nullable(), title: z.string().nullable(), draft: z.boolean().nullable(), head: z.string().nullable(), createdAt: z.number().nullable(), headCommittedAt: z.number().nullable(), checksPendingSince: z.number().nullable(), reviews: z.array(z.object({ login: z.string(), state: z.string(), sha: z.string(), submittedAt: z.number().nullable() })), staleReviewDismissal: z.boolean().nullable(), requiredApprovals: z.number().nullable(), review: z.string(), checks: z.string(), mergeability: z.string(), reason: z.string(), retrievedAt: z.number() }), proof: z.object({ state: z.enum(["unrecorded", "stale", "partial", "blocked", "verified"]), verifiedSha: z.string().nullable(), liveInterface: z.string().nullable(), qaPacketUrl: z.string().nullable(), missing: z.array(z.string()), sourceUrl: z.string().nullable(), sourceLabel: z.string().nullable(), observedAt: z.number().nullable() }), waitLane: z.object({ head: z.string().nullable(), reviewFreshness: z.enum(["current", "stale", "older accepted", "unknown"]), steps: z.array(z.object({ kind: z.enum(["check run", "human review", "QA", "draft decision", "merge go"]), state: z.enum(["done", "pending", "blocked", "unknown"]), since: z.number().nullable(), owner: z.string().nullable(), note: z.string() })) }) })), pr: z.object({ url: z.string(), state: z.enum(["unavailable", "blocked", "ready", "merged", "closed"]), number: z.number().nullable(), title: z.string().nullable(), draft: z.boolean().nullable(), head: z.string().nullable(), createdAt: z.number().nullable(), headCommittedAt: z.number().nullable(), checksPendingSince: z.number().nullable(), reviews: z.array(z.object({ login: z.string(), state: z.string(), sha: z.string(), submittedAt: z.number().nullable() })), staleReviewDismissal: z.boolean().nullable(), requiredApprovals: z.number().nullable(), review: z.string(), checks: z.string(), mergeability: z.string(), reason: z.string(), retrievedAt: z.number() }).nullable(), proof: z.object({ state: z.enum(["unrecorded", "stale", "partial", "blocked", "verified"]), verifiedSha: z.string().nullable(), liveInterface: z.string().nullable(), qaPacketUrl: z.string().nullable(), missing: z.array(z.string()), sourceUrl: z.string().nullable(), sourceLabel: z.string().nullable(), observedAt: z.number().nullable() }).nullable(), waitLane: z.object({ head: z.string().nullable(), reviewFreshness: z.enum(["current", "stale", "older accepted", "unknown"]), steps: z.array(z.object({ kind: z.enum(["check run", "human review", "QA", "draft decision", "merge go"]), state: z.enum(["done", "pending", "blocked", "unknown"]), since: z.number().nullable(), owner: z.string().nullable(), note: z.string() })) }).nullable(), decisionDraft: z.object({ ticketId: z.string(), ticketUrl: z.string(), title: z.string(), question: z.string(), context: z.string(), options: z.array(z.object({ label: z.string(), detail: z.string() })), affected: z.array(z.string()) }).nullable(), decision: z.object({ state: z.enum(["missing", "ambiguous", "linked"]), cardId: z.string().nullable(), cardState: z.string().nullable(), title: z.string().nullable(), waiting: z.boolean(), direct: z.array(z.string()), transitive: z.array(z.string()) }), preflight: z.object({ state: z.enum(["not planned", "needs access", "unknown", "blocked", "declared"]), environment: z.string().nullable(), verifier: z.string().nullable(), ownerAction: z.string().nullable(), accessTicket: z.string().nullable(), gaps: z.array(z.string()), source: z.string() }) })),
    external: z.array(z.object({ identifier: z.string(), title: z.string().optional(), url: z.string().optional(), state: z.object({ type: z.string() }) })),
    edges: z.array(z.object({ from: z.string(), to: z.string(), type: z.enum(["blocks", "sub-issue", "related"]) })),
    fog: z.array(z.string()), frontier: z.array(z.string()), claimed: z.array(z.string()), blocked: z.array(z.string()), firstPath: z.array(z.string()),
    ownerActions: z.array(z.object({ identifier: z.string(), url: z.string(), action: z.string(), kind: z.enum(["sign-in", "permission", "approval", "other"]), affected: z.array(z.string()), next: z.string().nullable(), neededBefore: z.number().nullable(), onlyOpenBlocker: z.boolean() })),
    cycles: z.array(z.array(z.string())).optional(),
  }).nullable(),
  retro: z.object({ finished: z.array(z.object({ label: z.string(), url: z.string(), prUrl: z.string().nullable() })), mergedPrs: z.array(z.object({ ticket: z.string(), url: z.string() })), decisions: z.array(z.object({ id: z.string(), title: z.string() })), stalled: z.array(z.object({ label: z.string(), url: z.string(), kind: z.string(), durationMs: z.number() })), doc: z.string().nullable(), hostId: z.string().nullable() }).nullable(),
});
export type Pathways = z.infer<typeof pathwaysSchema>;
export const pathwaysViewSchema = pathwaysSchema.extend({ fetchedAt: z.number().nullable(), refreshing: z.boolean() });

// Every project in the sidebar's placing order (engine.projects()), with its accent type (none with pokemon off); the page
// puts it in the viewer's own section order (core/project-order.ts).
export const projectOrderSchema = z.array(z.object({ slug: z.string(), monType: z.string().nullable() }));
export type ProjectOrder = z.infer<typeof projectOrderSchema>;

/** Who the page is for: the ownerName setting ("" = the page says "you") and the CoS's name. */
// linearWorkspace / linearTeams: where a Linear id in the command center links (app/refs.ts); empty: no link
export const configSchema = z.object({ ownerName: z.string(), cosTitle: z.string(), linearWorkspace: z.string().optional(), linearTeams: z.array(z.string()).optional(), hiddenTabs: z.array(z.string()).optional() });
export type Config = z.infer<typeof configSchema>;

export const rpcContract = defineRpcContract({
  config: { input: z.null(), output: configSchema },
  needsYou: { input: z.object({ zone: z.string().max(64) }).strict(), output: needsYouSchema },
  board: { input: z.null(), output: boardSchema },
  projects: { input: z.null(), output: projectsSchema },
  agents: { input: z.null(), output: agentsSchema },
  projectHistory: { input: z.object({ slug: z.string().min(1).max(40) }).strict(), output: projectHistorySchema },
  projectBook: { input: z.object({ slug: z.string().min(1).max(40), dayStart: z.number().optional() }).strict(), output: projectBookSchema },
  searchCards: { input: z.object({ q: z.string().max(80) }).strict(), output: cardHitsSchema },
  outputs: { input: z.null(), output: outputsSchema },
  deliverableFolders: { input: z.null(), output: deliverableFoldersSchema },
  deliverables: { input: z.null(), output: deliverablesSchema },
  scope: { input: z.null(), output: scopeSchema },
  pathways: { input: z.object({ slug: z.string().min(1).max(40), refresh: z.boolean().optional() }).strict(), output: pathwaysViewSchema },
  projectOrder: { input: z.null(), output: projectOrderSchema },
  // the chat log's read (1.10.0): one project's direct messages, newest first, only when the chat is open
  directHistory: { input: z.object({ slug: z.string().min(1).max(40), before: z.number().nullable().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(), output: z.object({ messages: z.array(directMessageSchema), more: z.boolean() }) },
});

// ---- the write routes (POST, JSON body). Each answers { ok: true } or { ok: false, error: { kind, message } }.
export const secretBody = z.object({ id: z.string(), rev: z.number().int(), value: z.string().min(1).max(4000), via: z.enum(["desktop", "phone"]) }).strict();
export const answerBody = z.object({ id: z.string(), rev: z.number().int(), option: z.string().nullable(), text: z.string().max(4000).nullable(), via: z.enum(["desktop", "phone", "voice"]) }).strict();
export const deferBody = z.object({ id: z.string(), rev: z.number().int(), preset: z.enum(["1h", "evening", "tomorrow", "manual"]), zone: z.string().max(64), via: z.enum(["desktop", "phone", "voice"]) }).strict();
export const returnBody = z.object({ id: z.string(), rev: z.number().int() }).strict();
export const ruleAddBody = z.object({ text: z.string().min(1).max(300), project: z.string().nullable(), kinds: z.array(z.enum(["question", "plan", "practice"])).min(1), expiresInDays: z.number().positive().nullable(), source: z.string().min(1).max(200) }).strict();
export const ruleRevokeBody = z.object({ id: z.string() }).strict();
export const resendBody = z.object({ id: z.string() }).strict();
export const priorityBody = z.object({ slug: z.string(), priority: z.enum(["urgent", "high", "normal", "low"]) }).strict();
export const holdBody = z.object({ slug: z.string(), held: z.boolean() }).strict();
// the owner's direct message to a project's lead (PLAN 3); followUp names an earlier one to the same lead.
// 2026-11-17: `images` are ids the image write returned for this lead (never paths: a page can't attach a file of its
// choosing), at most MAX_IMAGES; a message with images may have no words.
export const directMessageBody = z
  .object({ slug: z.string(), text: z.string().max(4000), followUp: z.string().nullable().optional(), images: z.array(z.string().min(1).max(40)).max(MAX_IMAGES).optional() })
  .strict()
  .refine((b) => b.text.trim().length > 0 || (b.images?.length ?? 0) > 0, { message: "a message needs words or an image" });
// one image per write, as base64 (bb's local routes take JSON only); the length cap is checked before anything decodes
export const directImageBody = z
  .object({ slug: z.string().min(1).max(40), name: z.string().min(1).max(200), mime: z.enum(IMAGE_TYPES), data: z.string().min(1).max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4) })
  .strict();
// upTo: the newest answer the row showed; the seen cursor never passes it
export const directSeenBody = z.object({ slug: z.string(), upTo: z.number() }).strict();
export const archiveBody = z.object({ threadId: z.string() }).strict();
export const archiveProjectBody = z.object({ slug: z.string().min(1).max(40) }).strict();
export const outputRemoveBody = z.object({ id: z.string() }).strict();
// pinned documents: target is a pasted path or URL, or a deliverable id of the project; title is optional
export const pinBody = z.object({ slug: z.string().min(1).max(40), target: z.string().trim().min(1).max(4000), title: z.string().max(120).nullable().optional() }).strict();
export const unpinBody = z.object({ id: z.string().min(1).max(40) }).strict();
export const startLeadBody = z.object({ slug: z.string().min(1).max(40) }).strict();
// 2026-11-17: with images the bar staged (cosImage), by id; then the words may be empty
export const cosMessageBody = z
  .object({ text: z.string().trim().max(8000), images: z.array(z.string().min(1).max(40)).max(MAX_IMAGES).optional() })
  .strict()
  .refine((b) => b.text.length > 0 || (b.images?.length ?? 0) > 0, { message: "a message needs words or an image" });
// one image for the CoS bar's next send, as directImageBody without the project
export const cosImageBody = directImageBody.omit({ slug: true });
export const interactionAnswerBody = z
  .object({
    threadId: z.string(),
    interactionId: z.string(),
    answers: z.record(z.string(), z.object({ selected: z.array(z.string().max(500)).max(50), freeText: z.string().max(4000).optional() }).strict()),
  })
  .strict();
export const roleStartBody = z.object({ role: z.enum(["cos", "steward"]) }).strict();
// next: what the lead does with it next ("forward this to the team"); it reaches the lead as an item they must ack
export const approveBody = z.object({ id: z.string(), rev: z.number().int(), note: z.string().max(4000).nullable(), next: z.string().max(4000).nullable().optional() }).strict();
export const requestChangesBody = z.object({ id: z.string(), rev: z.number().int(), text: z.string().min(1).max(4000) }).strict();
// the owner's scoping switches in the Projects view (1.13.0): a project's mode, as orch_project_mode sets it; a thread made
// the scoping thread of an open task (task: its id or name) or of a new one (name), or stopped
export const projectModeBody = z.object({ slug: z.string().min(1).max(40), mode: z.enum(["scoping", "active"]) }).strict();
export const scopeThreadBody = z.object({ threadId: z.string().min(1), task: z.string().max(80).nullable().optional(), name: z.string().max(200).nullable().optional() }).strict();
export const unscopeThreadBody = z.object({ threadId: z.string().min(1) }).strict();
// the owner's PR-wait changes from the Watchers list (the CoS's are orch_watch): any wait, for any live agent
const waitWhen = z.enum(["approved", "green", "ready", "merged"]);
export const watchAddBody = z.object({ to: z.string().min(1).max(120), pr: z.string().trim().min(1).max(300), when: waitWhen, note: z.string().trim().min(1).max(600) }).strict();
export const watchRetargetBody = z.object({ id: z.string().min(1).max(40), pr: z.string().trim().max(300).nullable().optional(), when: waitWhen.nullable().optional() }).strict();
export const watchMoveBody = z.object({ id: z.string().min(1).max(40), to: z.string().min(1).max(120) }).strict();
export const watchDropBody = z.object({ id: z.string().min(1).max(40) }).strict();

export const pathwaysDecisionSubmitBody = z.object({ slug: z.string().min(1).max(40), ticketId: z.string().min(1).max(40), question: z.string().min(1).max(600), options: z.array(z.object({ label: z.string().min(1).max(80), detail: z.string().max(300) }).strict()).min(2).max(4) }).strict();

export const WRITES = {
  answer: "/answer",
  pathwaysDecision: "/pathways/decision",
  secret: "/secret",
  defer: "/defer",
  return: "/return",
  ruleAdd: "/rules/add",
  ruleRevoke: "/rules/revoke",
  resend: "/resend",
  priority: "/projects/priority",
  hold: "/projects/hold",
  directMessage: "/projects/message",
  directImage: "/projects/message/image",
  cosImage: "/cos/message/image",
  directSeen: "/projects/message-seen",
  archive: "/archive",
  archiveProject: "/projects/archive",
  outputRemove: "/outputs/remove",
  pin: "/projects/pin",
  unpin: "/projects/unpin",
  startLead: "/projects/start-lead",
  roleStart: "/roles/start",
  cosMessage: "/cos/message",
  interactionAnswer: "/interactions/answer",
  approve: "/deliverables/approve",
  requestChanges: "/deliverables/changes",
  projectMode: "/projects/mode",
  scopeThread: "/threads/scope",
  unscopeThread: "/threads/unscope",
  watchAdd: "/watchers/add",
  watchRetarget: "/watchers/retarget",
  watchMove: "/watchers/move",
  watchDrop: "/watchers/drop",
} as const;
