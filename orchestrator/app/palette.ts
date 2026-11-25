// The page's colour code: one colour per role (who) and one per kind (what), each with a light and a dark value.
// Colours are written as CSS `light-dark(light, dark)`: bb sets `color-scheme: light` on `:root, .light` and
// `color-scheme: dark` on `html.dark`, so they follow bb's own theme with no JS. Words are always shown with them.
// test/palette.test.ts checks every value against bb's light and dark surfaces (text ≥ 4.5:1, marks ≥ 3:1).

export type Tone = { light: string; dark: string };

/** Who: the four agent roles, the owner (a person), and the engine itself. */
export const ROLE_TONES = {
  person: { label: "person", light: "#831843", dark: "#f9a8d4" },
  cos: { label: "CoS", light: "#5b21b6", dark: "#c4b5fd" },
  steward: { label: "Steward", light: "#365314", dark: "#a3e635" },
  lead: { label: "lead", light: "#1e40af", dark: "#60a5fa" },
  thread: { label: "thread", light: "#164e63", dark: "#22d3ee" },
  system: { label: "orchestrator · engine", light: "#334155", dark: "#cbd5e1" },
} as const;
export type RoleKey = keyof typeof ROLE_TONES;

/** What: decision states, card and item kinds, board rows and rule states, grouped into one colour per idea. */
export const KIND_TONES = {
  asked: { label: "asked", covers: ["asked", "decision.new"], light: "#831843", dark: "#f9a8d4" },
  triaging: { label: "being triaged", covers: ["open"], light: "#5b21b6", dark: "#c4b5fd" },
  deferred: { label: "deferred", covers: ["deferred", "decision.deferred", "held"], light: "#78350f", dark: "#fbbf24" },
  done: { label: "answered", covers: ["answered", "acked", "decision.answer", "live"], light: "#14532d", dark: "#4ade80" },
  merge: { label: "merge", covers: ["merge", "pr", "prstate"], light: "#3730a3", dark: "#a5b4fc" },
  message: { label: "message", covers: ["message", "direct"], light: "#0c4a6e", dark: "#38bdf8" },
  notice: { label: "notice", covers: ["notice", "import"], light: "#134e4a", dark: "#2dd4bf" },
  report: { label: "report", covers: ["report"], light: "#164e63", dark: "#22d3ee" },
  alarm: { label: "alarm", covers: ["alarm", "escalated"], light: "#991b1b", dark: "#fca5a5" },
  dead: { label: "dead letter", covers: ["dead"], light: "#7c2d12", dark: "#fdba74" },
  resolved: { label: "resolved", covers: ["resolved"], light: "#86198f", dark: "#f0abfc" },
  unplanned: { label: "unplanned", covers: ["unplanned"], light: "#6b3a0b", dark: "#fde047" },
  inactive: { label: "inactive", covers: ["copy", "merged", "withdrawn", "revoked", "expired", "archived"], light: "#334155", dark: "#cbd5e1" },
  // Outputs (phase 3): the Board row, then each artefact kind; an output "report" wears the report colour above.
  output: { label: "output", covers: ["output"], light: "#6b21a8", dark: "#d8b4fe" },
  doc: { label: "doc", covers: ["doc"], light: "#064e3b", dark: "#6ee7b7" },
  video: { label: "video", covers: ["video"], light: "#9f1239", dark: "#fda4af" },
  image: { label: "image", covers: ["image"], light: "#2b4510", dark: "#bef264" },
  link: { label: "link", covers: ["link"], light: "#1e3a8a", dark: "#93c5fd" },
  // Deliverables: the Activity row and a deliverable in review, sent back with changes, or approved.
  deliverable: { label: "deliverable · in review", covers: ["deliverable", "review"], light: "#831843", dark: "#f9a8d4" },
  changes: { label: "changes requested", covers: ["changes"], light: "#78350f", dark: "#fbbf24" },
  approved: { label: "approved", covers: ["approved"], light: "#14532d", dark: "#4ade80" },
} as const;
export type KindKey = keyof typeof KIND_TONES;

/** A project's priority (the owner sets it on the Projects tab): urgent hot, low quiet. */
export const PRIORITY_TONES = {
  urgent: { label: "urgent", light: "#991b1b", dark: "#fca5a5" },
  high: { label: "high", light: "#832c0e", dark: "#fdba74" },
  normal: { label: "normal", light: "#334155", dark: "#cbd5e1" },
  low: { label: "low", light: "#44403c", dark: "#b8b2ad" },
} as const;
export type Priority = keyof typeof PRIORITY_TONES;
export const PRIORITIES = Object.keys(PRIORITY_TONES) as Priority[];

/**
 * A PR's chip colour from bb's GitHub PR status (state open|draft|merged|closed, attention checks_failed|conflicts|…|
 * ready_to_merge|none, checks passing|failing|pending): something to fix is an alarm, ready to merge is done, merged is
 * the merge colour, closed is inactive, anything else (open, waiting on review or checks) the merge colour too.
 */
export function prKind(pr: { state: string | null; attention: string | null; checks: string | null }): KindKey {
  if (pr.state === "merged") return "merge";
  if (pr.state === "closed") return "inactive";
  if (pr.checks === "failing" || ["checks_failed", "conflicts", "changes_requested", "blocked"].includes(pr.attention ?? "")) return "alarm";
  if (pr.attention === "ready_to_merge") return "done";
  return "merge";
}

/** Open PRs (2026-11-16 rev 2): a state chip's colour by core/open-prs.ts prChips' tone, filled at TINT like a pill. */
export const PR_CHIP_TONES = {
  ok: { label: "approved, CI passing", light: "#14532d", dark: "#4ade80" },
  warn: { label: "changes requested, conflicts", light: "#78350f", dark: "#fbbf24" },
  fail: { label: "CI failing", light: "#991b1b", dark: "#fca5a5" },
  pending: { label: "CI running", light: "#52525b", dark: "#a1a1aa" },
  neutral: { label: "review required, blocked by rules", light: "#334155", dark: "#cbd5e1" },
  muted: { label: "draft", light: "#57534e", dark: "#a8a29e" },
} as const;

/** The Slack preview's link and mention colours (Slack's own blues), a mention filled at TINT like Slack's. */
export const SLACK_TONES = {
  link: { label: "link", light: "#1264a3", dark: "#4fb3e8" },
  mention: { label: "mention", light: "#1264a3", dark: "#4fb3e8" },
} as const;

/** How much of a kind's colour fills its pill (over whatever surface the pill sits on). */
export const TINT = 0.12;

/** An address or level → its role: cos, steward, lead:<p>, thread:<p>:<n>, person, orchestrator/engine. */
export function roleOf(address: string | null | undefined): RoleKey | null {
  if (!address) return null;
  const head = address.split(":")[0]!.toLowerCase();
  if (head === "cos" || head === "steward" || head === "lead" || head === "thread") return head;
  if (head === "person") return "person";
  if (head === "orchestrator" || head === "engine") return "system";
  return null;
}

const KIND_OF = new Map<string, KindKey>(Object.entries(KIND_TONES).flatMap(([k, t]) => t.covers.map((c) => [c, k as KindKey] as const)));

/** A raw kind or state string → its colour group; null for one we don't know (shown uncoloured). */
export function kindOf(raw: string | null | undefined): KindKey | null {
  return raw ? (KIND_OF.get(raw) ?? null) : null;
}

/** A rule's state, revoked first. */
export function ruleState(r: { revokedAt: number | null; expiresAt: number | null }, now: number): "revoked" | "expired" | "live" {
  return r.revokedAt !== null ? "revoked" : r.expiresAt !== null && r.expiresAt <= now ? "expired" : "live";
}

/** The CSS colour for a tone, following bb's theme. */
export const css = (t: Tone): string => `light-dark(${t.light}, ${t.dark})`;
/** The pill fill: the tone at TINT over the surface below. */
export const tint = (t: Tone): string => `color-mix(in srgb, ${css(t)} ${TINT * 100}%, transparent)`;

/**
 * Each project's colour for its sidebar section header (2026-11-13: "colour-coded, like a bar"): a stable pick from
 * this set, hashed from the slug, so a project keeps its colour. Light text on dark, dark on light.
 */
export const PROJECT_HUES: readonly Tone[] = [
  { light: "#1d4ed8", dark: "#93c5fd" }, // blue
  { light: "#0f766e", dark: "#5eead4" }, // teal
  { light: "#b45309", dark: "#fcd34d" }, // amber
  { light: "#be123c", dark: "#fda4af" }, // rose
  { light: "#15803d", dark: "#86efac" }, // green
  { light: "#c2410c", dark: "#fdba74" }, // orange
  { light: "#4338ca", dark: "#a5b4fc" }, // indigo
  { light: "#0e7490", dark: "#67e8f9" }, // cyan
  { light: "#a21caf", dark: "#f0abfc" }, // fuchsia
  { light: "#4d7c0f", dark: "#bef264" }, // lime
  { light: "#be185d", dark: "#f9a8d4" }, // pink
];
export function projectTone(slug: string | null): Tone {
  if (!slug) return ROLE_TONES.cos; // the Orchestrator section: the CoS's violet
  return PROJECT_HUES[[...slug].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PROJECT_HUES.length]!;
}
