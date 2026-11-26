import type { CSSProperties } from "react";
import { accentTone } from "./accent.ts";
import { PROJECT_HUES, css, projectTone, type Tone } from "./palette.ts";

export const TONE_VAR = "--wb-tone";

export function boardTones(projects: Iterable<{ slug: string; monType?: string | null; createdAt?: number | null }>): Map<string, Tone> {
  const known = new Map<string, { type: string | null; made: number }>();
  for (const p of projects) {
    const was = known.get(p.slug);
    known.set(p.slug, { type: was?.type || (p.monType ?? null), made: Math.min(was?.made ?? Infinity, p.createdAt ?? Infinity) });
  }
  const age = (s: string) => known.get(s)!.made;
  const slugs = [...known.keys()].sort((a, b) => (age(a) === age(b) ? (a < b ? -1 : a > b ? 1 : 0) : age(a) - age(b)));
  const out = new Map<string, Tone>();
  const accents = new Set<Tone>();
  const held = new Set<Tone>();
  for (const s of slugs) {
    const a = accentTone(known.get(s)!.type);
    if (a && !accents.has(a)) {
      accents.add(a);
      out.set(s, a);
      continue;
    }
    const own = projectTone(s);
    const start = PROJECT_HUES.indexOf(own);
    const free = PROJECT_HUES.map((_, k) => PROJECT_HUES[(start + k) % PROJECT_HUES.length]!).find((t) => !held.has(t));
    const t = free ?? own;
    held.add(t);
    out.set(s, t);
  }
  return out;
}

export const toneVars = (t: Tone | undefined): CSSProperties | undefined => (t ? ({ [TONE_VAR]: css(t) } as CSSProperties) : undefined);
