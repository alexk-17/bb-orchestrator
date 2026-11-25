// Each project's colour on the work board (2026-11-24, the owner: "we need more color coding to know what project each
// task is associated with"). It is the project's colour everywhere else in the app: its accent (its Pokémon type's,
// accent.ts) when the setting gives it one and no older project holds that type, else the sidebar's hashed hue
// (palette.ts projectTone). The hash picks from 11 hues, so a handful of projects often share one; on the board a project
// whose hue an older one already holds takes the next free hue, so no two look alike. It is worked out over every
// project the page knows, never the filter's slice, so a card keeps its colour whatever the filter, and oldest project
// first (2026-11-25, Codex's review: in slug order a new project could take an older one's colour), so a new project
// never moves an older one's. It shows as a chip filled in it with the name, a faint tint on the card and a dot on the
// filter's chips (the legend): never a coloured edge or bar.
import type { CSSProperties } from "react";
import { accentTone } from "./accent.ts";
import { PROJECT_HUES, css, projectTone, type Tone } from "./palette.ts";

export const TONE_VAR = "--wb-tone";

/**
 * Each slug's colour, oldest project first (`createdAt`; one the page doesn't know the age of counts as newest, then by
 * slug): its accent while no older project holds it, else its hashed hue while free, else the next free hue.
 */
export function boardTones(projects: Iterable<{ slug: string; monType?: string | null; createdAt?: number | null }>): Map<string, Tone> {
  const known = new Map<string, { type: string | null; made: number }>();
  for (const p of projects) {
    const was = known.get(p.slug);
    known.set(p.slug, { type: was?.type || (p.monType ?? null), made: Math.min(was?.made ?? Infinity, p.createdAt ?? Infinity) });
  }
  const age = (s: string) => known.get(s)!.made;
  const slugs = [...known.keys()].sort((a, b) => (age(a) === age(b) ? (a < b ? -1 : a > b ? 1 : 0) : age(a) - age(b)));
  const out = new Map<string, Tone>();
  // the accents: a project's type is its own (mons.ts pickType) while the 18 types last; past that two share one, and
  // the newer takes a hue as a project with no type does
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
    // more projects than hues: the clash can't be helped, and the chip still names the project
    const t = free ?? own;
    held.add(t);
    out.set(s, t);
  }
  return out;
}

/** The style that carries a tone to an element's CSS (the chip, the card's tint, the filter chip); none without one. */
export const toneVars = (t: Tone | undefined): CSSProperties | undefined => (t ? ({ [TONE_VAR]: css(t) } as CSSProperties) : undefined);
