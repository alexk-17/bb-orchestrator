// light-dark() follows bb's theme with no JS: bb sets color-scheme on :root, .light and html.dark.
// Text must stay >= 4.5:1 and marks >= 3:1 against bb's light and dark surfaces.
export type Tone = { light: string; dark: string };

export const ROLE_TONES = {
  person: { label: "person", light: "#831843", dark: "#f9a8d4" },
  cos: { label: "CoS", light: "#5b21b6", dark: "#c4b5fd" },
  steward: { label: "Steward", light: "#365314", dark: "#a3e635" },
  lead: { label: "lead", light: "#1e40af", dark: "#60a5fa" },
  thread: { label: "thread", light: "#164e63", dark: "#22d3ee" },
  system: { label: "orchestrator · engine", light: "#334155", dark: "#cbd5e1" },
} as const;
export type RoleKey = keyof typeof ROLE_TONES;

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
  output: { label: "output", covers: ["output"], light: "#6b21a8", dark: "#d8b4fe" },
  doc: { label: "doc", covers: ["doc"], light: "#064e3b", dark: "#6ee7b7" },
  video: { label: "video", covers: ["video"], light: "#9f1239", dark: "#fda4af" },
  image: { label: "image", covers: ["image"], light: "#2b4510", dark: "#bef264" },
  link: { label: "link", covers: ["link"], light: "#1e3a8a", dark: "#93c5fd" },
  deliverable: { label: "deliverable · in review", covers: ["deliverable", "review"], light: "#831843", dark: "#f9a8d4" },
  changes: { label: "changes requested", covers: ["changes"], light: "#78350f", dark: "#fbbf24" },
  approved: { label: "approved", covers: ["approved"], light: "#14532d", dark: "#4ade80" },
} as const;
export type KindKey = keyof typeof KIND_TONES;

export const PRIORITY_TONES = {
  urgent: { label: "urgent", light: "#991b1b", dark: "#fca5a5" },
  high: { label: "high", light: "#832c0e", dark: "#fdba74" },
  normal: { label: "normal", light: "#334155", dark: "#cbd5e1" },
  low: { label: "low", light: "#44403c", dark: "#b8b2ad" },
} as const;
export type Priority = keyof typeof PRIORITY_TONES;
export const PRIORITIES = Object.keys(PRIORITY_TONES) as Priority[];

export function prKind(pr: { state: string | null; attention: string | null; checks: string | null }): KindKey {
  if (pr.state === "merged") return "merge";
  if (pr.state === "closed") return "inactive";
  if (pr.checks === "failing" || ["checks_failed", "conflicts", "changes_requested", "blocked"].includes(pr.attention ?? "")) return "alarm";
  if (pr.attention === "ready_to_merge") return "done";
  return "merge";
}

export const PR_CHIP_TONES = {
  ok: { label: "approved, CI passing", light: "#14532d", dark: "#4ade80" },
  warn: { label: "changes requested, conflicts", light: "#78350f", dark: "#fbbf24" },
  fail: { label: "CI failing", light: "#991b1b", dark: "#fca5a5" },
  pending: { label: "CI running", light: "#52525b", dark: "#a1a1aa" },
  neutral: { label: "review required, blocked by rules", light: "#334155", dark: "#cbd5e1" },
  muted: { label: "draft", light: "#57534e", dark: "#a8a29e" },
} as const;

export const SLACK_TONES = {
  link: { label: "link", light: "#1264a3", dark: "#4fb3e8" },
  mention: { label: "mention", light: "#1264a3", dark: "#4fb3e8" },
} as const;

export const TINT = 0.12;

export function roleOf(address: string | null | undefined): RoleKey | null {
  if (!address) return null;
  const head = address.split(":")[0]!.toLowerCase();
  if (head === "cos" || head === "steward" || head === "lead" || head === "thread") return head;
  if (head === "person") return "person";
  if (head === "orchestrator" || head === "engine") return "system";
  return null;
}

const KIND_OF = new Map<string, KindKey>(Object.entries(KIND_TONES).flatMap(([k, t]) => t.covers.map((c) => [c, k as KindKey] as const)));

export function kindOf(raw: string | null | undefined): KindKey | null {
  return raw ? (KIND_OF.get(raw) ?? null) : null;
}

export function ruleState(r: { revokedAt: number | null; expiresAt: number | null }, now: number): "revoked" | "expired" | "live" {
  return r.revokedAt !== null ? "revoked" : r.expiresAt !== null && r.expiresAt <= now ? "expired" : "live";
}

export const css = (t: Tone): string => `light-dark(${t.light}, ${t.dark})`;
export const tint = (t: Tone): string => `color-mix(in srgb, ${css(t)} ${TINT * 100}%, transparent)`;

export const PROJECT_HUES: readonly Tone[] = [
  { light: "#1d4ed8", dark: "#93c5fd" },
  { light: "#0f766e", dark: "#5eead4" },
  { light: "#b45309", dark: "#fcd34d" },
  { light: "#be123c", dark: "#fda4af" },
  { light: "#15803d", dark: "#86efac" },
  { light: "#c2410c", dark: "#fdba74" },
  { light: "#4338ca", dark: "#a5b4fc" },
  { light: "#0e7490", dark: "#67e8f9" },
  { light: "#a21caf", dark: "#f0abfc" },
  { light: "#4d7c0f", dark: "#bef264" },
  { light: "#be185d", dark: "#f9a8d4" },
];
export function projectTone(slug: string | null): Tone {
  if (!slug) return ROLE_TONES.cos;
  return PROJECT_HUES[[...slug].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PROJECT_HUES.length]!;
}
