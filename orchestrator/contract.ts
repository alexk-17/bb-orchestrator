import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { blockSchema, pointSchema } from "./blocks.ts";
import { LIST_WAIT_KINDS, STEP_STATES, WAIT_KINDS } from "./core/status.ts";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES } from "./core/direct-images.ts";
export { IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES };

export const PLUGIN_ID = "orchestrator";
export const WRITE_BASE = `/api/v1/plugins/${PLUGIN_ID}/http`;
export const CHANGED_CHANNEL = "changed";

const opt = z.object({ id: z.string(), label: z.string(), detail: z.string(), recommended: z.boolean() });

const prSchema = z.object({ url: z.string().nullable(), number: z.number().nullable(), state: z.string().nullable(), attention: z.string().nullable(), checks: z.string().nullable() });

export const cardSchema = z.object({
  id: z.string(),
  rev: z.number(),
  project: z.string().nullable(),
  asker: z.string(),
  origin: z.string(),
  title: z.string(),
  question: z.string(),
  context: z.string(),
  options: z.array(opt),
  allowText: z.boolean(),
  askedAt: z.string(),
  escalated: z.boolean(),
  merge: z.boolean(),
  deferredUntil: z.string().nullable(),
  deferred: z.boolean(),
  returnedAt: z.string().nullable(),
  blocks: z.array(blockSchema),
  prs: z.array(prSchema),
  queued: z.number().optional(),
  scopingDone: z.object({ summary: z.string(), projectMd: z.string() }).nullable().optional(),
  scopeTask: z.string().nullable().optional(),
  revised: z.number().optional(),
});
export type Card = z.infer<typeof cardSchema>;

export const presetSchema = z.object({ id: z.enum(["1h", "evening", "tomorrow", "manual"]), label: z.string(), until: z.string().nullable() });
export type Preset = z.infer<typeof presetSchema>;

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
  id: z.string(),
  threadId: z.string(),
  address: z.string(),
  title: z.string(),
  kind: z.string(),
  since: z.string().nullable(),
  questions: z.array(questionSchema),
});

export const needsYouSchema = z.object({
  cards: z.array(cardSchema),
  deferred: z.array(cardSchema),
  triaging: z.array(z.object({ id: z.string(), title: z.string(), origin: z.string(), project: z.string().nullable(), dueAt: z.string().nullable() })),
  interactions: z.array(interactionSchema),
  presets: z.array(presetSchema),
  badge: z.number(),
});
export type NeedsYou = z.infer<typeof needsYouSchema>;

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

export const personaSchema = z.object({
  name: z.string(),
  title: z.string(),
  image: z.string(),
  credit: z.string().nullable(),
  team: z.array(z.string()),
  teamDex: z.array(z.number().nullable()).optional(),
  roster: z.array(z.string()).optional(),
  partner: z.string().nullable(),
  type: z.string().nullish(),
});
export type AgentPersona = z.infer<typeof personaSchema>;

export const boardSchema = z.object({
  rows: z.array(z.object({ id: z.string(), kind: z.string(), from: z.string().nullable(), project: z.string().nullable(), title: z.string(), body: z.string(), ref: z.string().nullable(), at: z.number() })),
  dead: z.array(z.object({ id: z.string(), recipient: z.string(), sender: z.string(), kind: z.string(), body: z.string(), note: z.string().nullable(), createdAt: z.number() })),
  agents: z.array(z.object({ threadId: z.string(), address: z.string(), role: z.string(), project: z.string().nullable(), status: z.string(), mon: z.string().nullable(), monType: z.string().nullable(), dex: z.number().nullish(), persona: personaSchema.nullish() })),
  rules: z.array(z.object({ id: z.string(), text: z.string(), project: z.string().nullable(), kinds: z.array(z.string()), expiresAt: z.number().nullable(), source: z.string(), createdAt: z.number(), revokedAt: z.number().nullable() })),
  decisions: z.array(z.object({ id: z.string(), state: z.string(), title: z.string(), origin: z.string(), asker: z.string(), level: z.string(), answer: z.string().nullable(), ack: z.string().nullable(), updatedAt: z.string() })),
  directUnread: z.array(z.string()).optional(),
  watchers: watchersSchema.optional(),
});
export type Board = z.infer<typeof boardSchema>;

export const leadStatusSchema = z.object({
  goal: z.string(),
  steps: z.array(z.object({ title: z.string(), state: z.enum(STEP_STATES) })),
  waitingOn: z.object({ kind: z.enum(WAIT_KINDS), ref: z.string().nullable(), label: z.string().nullable() }),
  waits: z.array(z.object({ kind: z.enum(LIST_WAIT_KINDS), ref: z.string().nullable(), label: z.string().nullable(), who: z.string().nullable(), since: z.number() })).optional(),
  blockers: z.array(z.string()),
  update: z.object({ workingOn: z.array(z.string()), at: z.string(), needs: z.string(), updateAt: z.number() }).nullish(),
  updatedAt: z.number(),
  by: z.string(),
});

export const summaryWaitSchema = z.object({
  source: z.enum(["lead", "live"]),
  kind: z.string(),
  ref: z.string().nullable(),
  who: z.string().nullable(),
  label: z.string().nullable(),
  since: z.number().nullable(),
  unchanged: z.boolean(),
  note: z.string().nullable(),
});
export const projectSummarySchema = z.object({
  motion: z.enum(["held", "nolead", "moving", "waiting", "quiet"]),
  threads: z.object({ working: z.number(), total: z.number() }),
  leadWorking: z.boolean(),
  needsYou: z.object({ count: z.number(), id: z.string().nullable(), title: z.string().nullable(), question: z.string().nullable(), since: z.number().nullable() }),
  waits: z.array(summaryWaitSchema),
  blockers: z.array(z.string()),
  statusOutOfDate: z.boolean(),
  done: z.object({ text: z.string(), at: z.number(), kind: z.enum(["deliverable", "merged", "report"]) }).nullable(),
  last: z.object({ text: z.string(), at: z.number() }).nullable(),
  leadIdleSince: z.number().nullable(),
});
export type SummaryWait = z.infer<typeof summaryWaitSchema>;
export const directMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  at: z.number(),
  followUp: z.string().nullable(),
  state: z.string(),
  outcome: z.string().nullable(),
  note: z.string().nullable(),
  answeredAt: z.number().nullable(),
  unread: z.boolean().optional(),
  images: z.array(z.object({ name: z.string() })).optional(),
});
export const directLineSchema = z.object({ messages: z.array(directMessageSchema), unread: z.boolean() });
export type DirectLine = z.infer<typeof directLineSchema>;

export const projectBookSchema = z.object({
  decided: z.array(z.object({ id: z.string(), title: z.string(), answer: z.string(), at: z.number() })),
  done: z.array(z.object({ kind: z.enum(["deliverable", "merged", "report"]), text: z.string(), at: z.number(), ref: z.string().nullable(), state: z.string().nullable() })),
  merged: z.array(z.object({ number: z.number().nullable(), url: z.string().nullable(), at: z.number() })),
  mergedTotal: z.number(),
  since: z.array(z.object({ text: z.string(), since: z.number(), bound: z.boolean() })),
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
  ).optional(),
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
    createdAt: z.number().optional(),
    mode: z.enum(["scoping", "active"]).optional(),
    lead: z.object({ address: z.string(), threadId: z.string(), status: z.string(), mon: z.string().nullable(), persona: personaSchema.nullish() }).nullable(),
    threads: z.number(),
    openPlans: z.number(),
    status: leadStatusSchema.nullable(),
    monType: z.string().nullable(),
    summary: projectSummarySchema.nullish(),
    direct: directLineSchema.nullish(),
    prs: z.array(z.object({ number: z.number(), url: z.string(), state: z.string(), checks: z.string().nullable(), review: z.string().nullable(), attention: z.string().nullable() })).optional(),
    handedOff: z.array(z.object({ pr: z.string(), owner: z.string(), note: z.string().nullable(), at: z.number(), thread: z.string() })).optional(),
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
    monType: z.string().nullable(),
    priority: z.string().nullable(),
    held: z.boolean(),
    status: z.string(),
    engineStatus: z.string(),
    idleAt: z.number().nullable(),
    title: z.string().nullable(),
    lastReport: z.string().nullable(),
    provider: z.string().nullable(),
    mon: z.string().nullable(),
    form: z.string().nullable(),
    formDex: z.number().nullish(),
    persona: personaSchema.nullish(),
    level: z.number(),
    xp: z.number(),
    xpThis: z.number(),
    xpNext: z.number(),
    model: z.string().nullable(),
    usedTokens: z.number().nullable(),
    contextWindow: z.number().nullable(),
    branch: z.string().nullable(),
    pr: prSchema.extend({ review: z.string().nullable() }).nullable(),
    unread: z.boolean(),
    flags: z.array(z.string()),
    scopeTask: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
  }),
);
export type Agents = z.infer<typeof agentsSchema>;

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
    author: z.string(),
    at: z.number(),
    gone: z.boolean(),
  }),
);
export type Outputs = z.infer<typeof outputsSchema>;

export const PROOF_ROUTE = "/proof";
export const proofSchema = z.object({
  id: z.string(),
  kind: z.enum(["image", "video", "text", "doc", "pr", "link"]),
  caption: z.string(),
  path: z.string().nullable(),
  url: z.string().nullable(),
  hostId: z.string().nullable(),
  pr: prSchema.nullable(),
  source: z.string().nullable().optional(),
  stored: z.enum(["copied", "too_big", "missing", "failed"]).optional(),
  bytes: z.number().optional(),
});
const revisionSchema = z.object({ rev: z.number(), summary: z.string(), at: z.string(), proof: z.array(proofSchema), blocks: z.array(blockSchema), points: z.array(pointSchema), prs: z.array(prSchema) });
export const deliverableSchema = z.object({
  id: z.string(),
  project: z.string().nullable(),
  lead: z.string(),
  leadMon: z.string().nullable(),
  leadPersona: personaSchema.nullish(),
  title: z.string(),
  summary: z.string(),
  state: z.enum(["review", "approved", "changes", "withdrawn"]),
  rev: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  revisions: z.array(revisionSchema),
  feedback: z.array(z.object({ rev: z.number(), by: z.string(), text: z.string().nullable(), at: z.string(), outcome: z.enum(["approved", "changes"]) })),
  withdrawn: z.object({ at: z.string(), reason: z.string().nullable() }).nullable(),
  next: z
    .object({ text: z.string(), rev: z.number(), at: z.string(), item: z.string(), state: z.enum(["open", "closed", "dead"]), outcome: z.string().nullable(), note: z.string().nullable(), closedAt: z.number().nullable() })
    .nullable(),
  scope: z.boolean().optional(),
  scopeTask: z.string().optional(),
  folder: z.string().optional(),
  board: z.object({ id: z.string(), record: z.string().nullable(), flag: z.string().nullable() }).optional(),
});
export type Deliverables = z.infer<typeof deliverableSchema>[];
export const deliverableRowSchema = deliverableSchema.omit({ revisions: true }).extend({
  latest: z.object({ rev: z.number(), summary: z.string(), at: z.string(), proofs: z.number(), shot: proofSchema.nullable() }).nullable(),
  revisions: z.array(revisionSchema).nullable(),
});
export const deliverablesSchema = z.array(deliverableRowSchema);
export type DeliverableRows = z.infer<typeof deliverablesSchema>;
export const deliverableIndexSchema = z.array(
  z.object({ id: z.string(), rev: z.number(), updatedAt: z.number(), revisions: z.array(z.object({ rev: z.number(), summary: z.string(), at: z.string(), points: z.array(pointSchema), proof: z.array(proofSchema.omit({ pr: true })) })) }),
);
export type DeliverableIndex = z.infer<typeof deliverableIndexSchema>;

export const folderFileSchema = z.object({ path: z.string(), name: z.string(), kind: z.enum(["images", "videos", "artifacts"]), bytes: z.number(), at: z.number(), dir: z.boolean() });
export const deliverableFoldersSchema = z.object({
  hostId: z.string().nullable(),
  folders: z.record(z.string(), z.object({ folder: z.string(), readme: z.string().nullable(), files: z.array(folderFileSchema) })),
});
export type DeliverableFolders = z.infer<typeof deliverableFoldersSchema>;
export type FolderFile = z.infer<typeof folderFileSchema>;

export const scopeSchema = z.object({
  projects: z.array(
    z.object({
      slug: z.string(),
      cards: z.array(cardSchema),
      whole: z.boolean().optional(),
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

export const projectOrderSchema = z.array(z.object({ slug: z.string(), monType: z.string().nullable() }));
export type ProjectOrder = z.infer<typeof projectOrderSchema>;

export const configSchema = z.object({ ownerName: z.string(), cosTitle: z.string(), linearWorkspace: z.string().optional(), linearTeams: z.array(z.string()).optional(), hiddenTabs: z.array(z.string()).optional(), shown: z.array(z.string()).optional() });
export type Config = z.infer<typeof configSchema>;

export const feedMsgSchema = z.object({
  id: z.string(),
  who: z.string(),
  text: z.string(),
  at: z.number(),
  rev: z.number().nullable(),
  state: z.string().nullable(),
  tone: z.enum(["ok", "warn"]).nullable(),
  resend: z.boolean(),
  images: z.number(),
  isNew: z.boolean(),
});
export type FeedMsg = z.infer<typeof feedMsgSchema>;
export const feedPostSchema = z.object({
  key: z.string(),
  kind: z.enum(["card", "prompt", "deliverable", "status", "merge", "alarm", "dead", "message"]),
  author: z.string(),
  project: z.string().nullable(),
  line: z.string().nullable(),
  lineLive: z.boolean(),
  held: z.boolean(),
  to: z.string().nullable(),
  title: z.string(),
  text: z.string(),
  at: z.number(),
  activity: z.number(),
  scope: z.boolean(),
  needsOwner: z.boolean(),
  isNew: z.boolean(),
  outcome: z.string().nullable(),
  card: z.object({ id: z.string(), rev: z.number(), options: z.array(opt), allowText: z.boolean(), merge: z.boolean() }).nullable(),
  deliverable: z.object({ id: z.string(), rev: z.number(), state: z.string(), shots: z.number(), thumb: z.string().nullable(), thumbFile: z.object({ hostId: z.string().nullable(), path: z.string().nullable() }).nullable().optional() }).nullable(),
  status: z.object({ steps: z.array(z.object({ title: z.string(), state: z.string() })), needs: z.string().nullable() }).nullable(),
  url: z.string().nullable(),
  prompt: z.object({ threadId: z.string(), id: z.string() }).nullable(),
  replies: z.number(),
  thread: z.array(feedMsgSchema),
  earlier: z.number(),
  self: feedMsgSchema.nullable(),
});
export type FeedPost = z.infer<typeof feedPostSchema>;
export const FEED_FILTERS = ["all", "needs", "delivered", "alerts"] as const;
export const feedSchema = z.object({
  posts: z.array(feedPostSchema),
  cursor: z.string().nullable(),
  seen: z.number(),
  newCount: z.number(),
  counts: z.object({ needsYou: z.number(), delivered: z.number(), alerts: z.number() }),
  leftOutSince: z.number(),
  now: z.number(),
  last: feedMsgSchema.extend({ to: z.string(), about: z.string() }).nullable(),
  turnsAt: z.number().nullable(),
});
export type Feed = z.infer<typeof feedSchema>;

export const BOARD_COLUMNS = ["planned", "in_progress", "in_review", "waiting", "blocked", "shipped"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
export const COLUMN_LABEL: Record<BoardColumn, string> = { planned: "Planned", in_progress: "In progress", in_review: "In review", waiting: "Waiting on you", blocked: "Blocked", shipped: "Shipped" };
const boardThreadSchema = z.object({ address: z.string(), threadId: z.string(), state: z.enum(["working", "idle", "blocked", "released", "unknown"]), live: z.boolean() });
const boardPrSchema = z.object({
  url: z.string(),
  number: z.number().nullable(),
  state: z.string().nullable(),
  checks: z.string().nullable(),
  review: z.string().nullable(),
  attention: z.string().nullable(),
  wait: z.enum(["ci", "review", "merge", "blocked"]).nullable(),
  at: z.number(),
  thread: z.string().nullable(),
  source: z.enum(["orchestrator", "github"]),
});
const boardDeliverableSchema = z.object({ id: z.string(), title: z.string(), state: z.string(), rev: z.number(), at: z.number(), approvedAt: z.number().nullable() });
const boardCardSchema = z.object({ id: z.string(), title: z.string(), level: z.string(), state: z.string(), askedAt: z.number().nullable(), ownerWaits: z.boolean(), deferred: z.boolean(), held: z.boolean() });
const boardAttachmentsSchema = z.object({ threads: z.array(boardThreadSchema), prs: z.array(boardPrSchema), deliverables: z.array(boardDeliverableSchema), cards: z.array(boardCardSchema) });
export const boardTaskSchema = boardAttachmentsSchema.extend({
  id: z.string(),
  project: z.string(),
  title: z.string(),
  state: z.enum(["open", "shipped", "dropped"]),
  step: z.object({ n: z.number(), state: z.enum(STEP_STATES) }).nullable(),
  column: z.enum(BOARD_COLUMNS),
  derived: z.enum(BOARD_COLUMNS),
  since: z.number().nullable(),
  why: z.string(),
  hand: z.object({ column: z.enum(BOARD_COLUMNS), at: z.number(), holds: z.boolean() }).nullable(),
  sig: z.string(),
});
export const workBoardSchema = z.object({
  now: z.number(),
  since: z.number(),
  projects: z.array(
    z.object({
      slug: z.string(),
      tasks: z.array(boardTaskSchema),
      unfiled: boardAttachmentsSchema,
      dropped: z.array(z.object({ id: z.string(), title: z.string(), droppedAt: z.number().nullable(), unfiled: z.object({ threads: z.array(z.string()), deliverables: z.array(z.string()), cards: z.array(z.string()) }) })),
    }),
  ),
});
export type BoardTask = z.infer<typeof boardTaskSchema>;
export type BoardAttachments = z.infer<typeof boardAttachmentsSchema>;
export type WorkBoard = z.infer<typeof workBoardSchema>;

const sinceColumn = z.enum([...BOARD_COLUMNS, "dropped"]);
export const boardSinceSchema = z.object({
  since: z.number(),
  now: z.number(),
  looked: z.number().nullable(),
  counts: z.object({ shipped: z.number(), new: z.number(), waiting: z.number(), blocked: z.number(), dropped: z.number() }),
  moved: z.record(z.string(), z.object({ from: sinceColumn.nullable(), to: sinceColumn, at: z.number(), isNew: z.boolean() })),
  merged: z.number(),
  releases: z.array(z.object({ tag: z.string(), name: z.string(), at: z.number(), url: z.string() })),
  approved: z.number(),
  whose: z.discriminatedUnion("by", [z.object({ by: z.enum(["setting", "gh"]), login: z.string() }), z.object({ by: z.literal("tasked"), login: z.null() })]),
  picks: z.object({ shipped: z.array(z.string()), new: z.array(z.string()), waiting: z.array(z.string()), blocked: z.array(z.string()), merged: z.array(z.string()) }),
  dropped: z.array(z.object({ id: z.string(), title: z.string(), project: z.string() })),
  noTask: z.array(z.object({ url: z.string(), number: z.number().nullable(), title: z.string(), mergedAt: z.number() })),
  github: z.object({ at: z.number().nullable(), repos: z.number(), errors: z.array(z.string()), pending: z.number() }),
});
export type BoardSince = z.infer<typeof boardSinceSchema>;

export const PROJECTS_VIEWS = ["list", "board"] as const;
export type ProjectsViewPick = (typeof PROJECTS_VIEWS)[number];
export const viewPrefsSchema = z.object({
  projectsView: z.enum(PROJECTS_VIEWS).nullable().catch(null),
  boardFolds: z.record(z.string(), z.array(z.string())).catch({}),
  rev: z.number().int().nonnegative().catch(0),
});
export type ViewPrefs = z.infer<typeof viewPrefsSchema>;
export const viewPrefBody = z.union([
  z.object({ projectsView: z.enum(PROJECTS_VIEWS) }).strict(),
  z.object({ board: z.string().min(1).max(40), folded: z.array(z.enum(BOARD_COLUMNS)).max(BOARD_COLUMNS.length) }).strict(),
]);
export type ViewPrefBody = z.infer<typeof viewPrefBody>;

export const rpcContract = defineRpcContract({
  config: { input: z.null(), output: configSchema },
  howItWorks: { input: z.null(), output: z.object({ markdown: z.string() }) },
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
  deliverable: { input: z.object({ id: z.string().min(1).max(80) }).strict(), output: deliverableSchema.nullable() },
  deliverableIndex: { input: z.null(), output: deliverableIndexSchema },
  scope: { input: z.null(), output: scopeSchema },
  pathways: { input: z.object({ slug: z.string().min(1).max(40), refresh: z.boolean().optional() }).strict(), output: pathwaysViewSchema },
  projectOrder: { input: z.null(), output: projectOrderSchema },
  directHistory: { input: z.object({ slug: z.string().min(1).max(40), before: z.number().nullable().optional(), limit: z.number().int().min(1).max(100).optional() }).strict(), output: z.object({ messages: z.array(directMessageSchema), more: z.boolean() }) },
  feed: { input: z.object({ cursor: z.string().max(200).nullable(), filter: z.enum(FEED_FILTERS) }).strict(), output: feedSchema },
  cosLine: { input: z.object({ before: z.number().nullable() }).strict(), output: z.object({ entries: z.array(z.object({ kind: z.enum(["owner", "cos", "hidden"]), msg: feedMsgSchema.nullable(), re: z.string().nullable(), hidden: z.number() })), more: z.boolean() }) },
  workBoard: { input: z.object({ since: z.number().nullable().optional(), project: z.string().min(1).max(40).nullable().optional() }).strict(), output: workBoardSchema },
  boardSince: { input: z.object({ since: z.number().nullable(), project: z.string().min(1).max(40).nullable().optional() }).strict(), output: boardSinceSchema },
  viewPrefs: { input: z.null(), output: viewPrefsSchema },
  feedLeftOut: { input: z.object({ since: z.number() }).strict(), output: z.number() },
  feedThread: { input: z.object({ about: z.string().min(1).max(400), before: z.number().nullable() }).strict(), output: z.object({ messages: z.array(feedMsgSchema), more: z.boolean(), now: z.number(), turnsAt: z.number().nullable() }) },
});

export const secretBody = z.object({ id: z.string(), rev: z.number().int(), value: z.string().min(1).max(4000), via: z.enum(["desktop", "phone"]) }).strict();
export const answerBody = z.object({ id: z.string(), rev: z.number().int(), option: z.string().nullable(), text: z.string().max(4000).nullable(), via: z.enum(["desktop", "phone", "voice"]) }).strict();
export const deferBody = z.object({ id: z.string(), rev: z.number().int(), preset: z.enum(["1h", "evening", "tomorrow", "manual"]), zone: z.string().max(64), via: z.enum(["desktop", "phone", "voice"]) }).strict();
export const returnBody = z.object({ id: z.string(), rev: z.number().int() }).strict();
export const ruleAddBody = z.object({ text: z.string().min(1).max(300), project: z.string().nullable(), kinds: z.array(z.enum(["question", "plan", "practice"])).min(1), expiresInDays: z.number().positive().nullable(), source: z.string().min(1).max(200) }).strict();
export const ruleRevokeBody = z.object({ id: z.string() }).strict();
export const resendBody = z.object({ id: z.string() }).strict();
export const priorityBody = z.object({ slug: z.string(), priority: z.enum(["urgent", "high", "normal", "low"]) }).strict();
export const holdBody = z.object({ slug: z.string(), held: z.boolean() }).strict();
export const directMessageBody = z
  .object({ slug: z.string(), text: z.string().max(4000), followUp: z.string().nullable().optional(), images: z.array(z.string().min(1).max(40)).max(MAX_IMAGES).optional(), about: z.string().min(1).max(400).nullable().optional(), task: z.string().min(1).max(40).optional() })
  .strict()
  .refine((b) => b.text.trim().length > 0 || (b.images?.length ?? 0) > 0, { message: "a message needs words or an image" });
export const boardMoveBody = z.object({ task: z.string().min(1).max(40), to: z.enum(BOARD_COLUMNS) }).strict();
export const directImageBody = z
  .object({ slug: z.string().min(1).max(40), name: z.string().min(1).max(200), mime: z.enum(IMAGE_TYPES), data: z.string().min(1).max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4) })
  .strict();
export const directSeenBody = z.object({ slug: z.string(), upTo: z.number() }).strict();
export const archiveBody = z.object({ threadId: z.string() }).strict();
export const archiveProjectBody = z.object({ slug: z.string().min(1).max(40) }).strict();
export const outputRemoveBody = z.object({ id: z.string() }).strict();
export const pinBody = z.object({ slug: z.string().min(1).max(40), target: z.string().trim().min(1).max(4000), title: z.string().max(120).nullable().optional() }).strict();
export const unpinBody = z.object({ id: z.string().min(1).max(40) }).strict();
export const startLeadBody = z.object({ slug: z.string().min(1).max(40) }).strict();
export const cosMessageBody = z
  .object({ text: z.string().trim().max(8000), images: z.array(z.string().min(1).max(40)).max(MAX_IMAGES).optional(), about: z.string().min(1).max(400).nullable().optional() })
  .strict()
  .refine((b) => b.text.length > 0 || (b.images?.length ?? 0) > 0, { message: "a message needs words or an image" });
export const cosImageBody = directImageBody.omit({ slug: true });
export const interactionAnswerBody = z
  .object({
    threadId: z.string(),
    interactionId: z.string(),
    answers: z.record(z.string(), z.object({ selected: z.array(z.string().max(500)).max(50), freeText: z.string().max(4000).optional() }).strict()),
  })
  .strict();
export const feedSeenBody = z.object({ upTo: z.number() }).strict();
export const feedResendBody = z.object({ id: z.string().min(1).max(40) }).strict();
export const roleStartBody = z.object({ role: z.enum(["cos", "steward"]) }).strict();
export const approveBody = z.object({ id: z.string(), rev: z.number().int(), note: z.string().max(4000).nullable(), next: z.string().max(4000).nullable().optional() }).strict();
export const requestChangesBody = z.object({ id: z.string(), rev: z.number().int(), text: z.string().min(1).max(4000) }).strict();
export const projectModeBody = z.object({ slug: z.string().min(1).max(40), mode: z.enum(["scoping", "active"]) }).strict();
export const scopeThreadBody = z.object({ threadId: z.string().min(1), task: z.string().max(80).nullable().optional(), name: z.string().max(200).nullable().optional() }).strict();
export const unscopeThreadBody = z.object({ threadId: z.string().min(1) }).strict();
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
  feedSeen: "/feed/seen",
  feedResend: "/feed/resend",
  boardMove: "/board/move",
  viewPref: "/view-pref",
} as const;
