import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { boardTones } from "../app/project-colour.ts";
import { PROJECT_HUES, projectTone, type Tone } from "../app/palette.ts";
import { accentTone } from "../app/accent.ts";
import { TYPES } from "../mons.ts";

const slugs = (n: number, prefix = "proj") => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
const of = (list: string[], monType: (s: string) => string | null = () => null) => list.map((slug) => ({ slug, monType: monType(slug) }));
function clashing(): [string, string] {
  const seen = new Map<Tone, string>();
  for (const s of slugs(200, "clash")) {
    const t = projectTone(s);
    const other = seen.get(t);
    if (other) return [other, s].sort() as [string, string];
    seen.set(t, s);
  }
  throw new Error("no clash in 200 slugs");
}

test("no two projects share a colour while hues go round; the project the hash moved is the later slug", () => {
  const [a, b] = clashing();
  const t = boardTones(of([b, a]));
  assert.notEqual(t.get(a), t.get(b), `${a} and ${b} share a hue in the sidebar, never on the board`);
  assert.equal(t.get(a), projectTone(a), "the first slug keeps its sidebar colour");
  for (const n of [5, 8, PROJECT_HUES.length]) {
    const tones = boardTones(of(slugs(n, `set${n}`)));
    assert.equal(new Set(tones.values()).size, n, `${n} projects, ${n} colours`);
  }
});

test("a project keeps its colour whatever the order, and keeps its sidebar colour when nothing clashes", () => {
  const list = slugs(9, "kite");
  const one = boardTones(of(list));
  const back = boardTones(of([...list].reverse()));
  for (const s of list) assert.equal(back.get(s), one.get(s), `${s}: the order the read lists projects in changes nothing`);
  const held = new Set<Tone>();
  for (const s of [...list].sort()) {
    const own = projectTone(s);
    if (!held.has(own)) assert.equal(one.get(s), own, `${s} keeps the sidebar's colour`);
    held.add(one.get(s)!);
  }
  const extra = slugs(400, "new").find((s) => !held.has(projectTone(s)) && !new Set(one.values()).has(projectTone(s)))!;
  const more = boardTones(of([...list, extra]));
  for (const s of list) assert.equal(more.get(s), one.get(s), `${s} is unchanged by ${extra}`);
  const both = boardTones([{ slug: "kite-0", monType: "water" }, { slug: "kite-0" }]);
  assert.equal(both.get("kite-0"), accentTone("water"));
});

test("with the pokemon setting on, the project's accent is its colour, as on its Projects row and sidebar section", () => {
  const t = boardTones([{ slug: "alpha", monType: "fire" }, { slug: "beta", monType: "water" }, { slug: "gamma", monType: null }]);
  assert.equal(t.get("alpha"), accentTone("fire"));
  assert.equal(t.get("beta"), accentTone("water"));
  assert.equal(t.get("gamma"), projectTone("gamma"), "a project with no type: the sidebar's hue");
  const shared = boardTones([{ slug: "alpha", monType: "fire" }, { slug: "omega", monType: "fire" }]);
  assert.equal(shared.get("alpha"), accentTone("fire"));
  assert.notEqual(shared.get("omega"), shared.get("alpha"), "two projects of one type are told apart");
  assert.equal(shared.get("omega"), projectTone("omega"));
  assert.equal(boardTones([{ slug: "delta", monType: "cosmic" }]).get("delta"), projectTone("delta"));
});

test("adding a project leaves every existing project's colour unchanged, more projects than hues and accents included", () => {
  const made = (list: string[], from = 1) => list.map((slug, i) => ({ slug, monType: null, createdAt: from + i }));
  for (const n of [5, PROJECT_HUES.length + 3]) {
    const old = made(slugs(n, "kite"));
    const before = boardTones(old);
    for (const slug of slugs(40, "aaa")) {
      const after = boardTones([...old, { slug, monType: null, createdAt: 1000 }]);
      for (const p of old) assert.equal(after.get(p.slug), before.get(p.slug), `${n} projects: ${p.slug} unchanged by ${slug}`);
    }
    const shuffled = boardTones([...old].reverse());
    for (const p of old) assert.equal(shuffled.get(p.slug), before.get(p.slug), "the order the read lists them in changes nothing");
  }
  const older = { slug: "zeta", monType: "fire", createdAt: 1 };
  assert.equal(boardTones([older]).get("zeta"), accentTone("fire"));
  const two = boardTones([older, { slug: "alpha", monType: "fire", createdAt: 2 }]);
  assert.equal(two.get("zeta"), accentTone("fire"), "the older keeps the accent");
  assert.equal(two.get("alpha"), projectTone("alpha"), "the newer takes its hue");
  const unknown = boardTones([...made(["kite-0", "kite-1"]), { slug: "aaa-0" }]);
  assert.equal(unknown.get("kite-0"), boardTones(made(["kite-0", "kite-1"])).get("kite-0"));
  const src = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
  assert.match(src, /archivedAt: p\.archivedAt,\n\s+createdAt: p\.createdAt,/, "the projects read carries each project's age");
});

test("more projects than hues: every project still has a colour, and the chip names it", () => {
  const list = slugs(PROJECT_HUES.length + 4, "many");
  const t = boardTones(of(list));
  assert.equal(t.size, list.length);
  assert.equal(new Set(t.values()).size, PROJECT_HUES.length, "every hue is used before any is shared");
});

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const enc = (y: number) => 255 * (y <= 0.0031308 ? 12.92 * y : 1.055 * y ** (1 / 2.4) - 0.055);
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a: Rgb, b: Rgb) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};
const over = (top: Rgb, alpha: number, under: Rgb): Rgb => top.map((c, i) => c * alpha + under[i]! * (1 - alpha)) as Rgb;
const grey = (l: number): Rgb => {
  const c = enc(l ** 3);
  return [c, c, c];
};
const CARD = { light: grey(1), dark: grey(0.195) };
const INK = { light: grey(0.145), dark: grey(0.985) };

test("every project colour reads: the chip's words on it, its dot on the card, the card's words on its tint, in both themes", () => {
  const src = readFileSync(new URL("../app/work-board.tsx", import.meta.url), "utf8");
  assert.match(src, /\.wb-proj\[data-tone\] \{ background: var\(--wb-tone\); color: var\(--background\);/, "the chip is filled with the colour, its words in the page's background");
  const card = Number(src.match(/\.wb-card:where\(\[data-tone\]\) \{ background: color-mix\(in srgb, var\(--wb-tone\) (\d+)%/)?.[1]) / 100;
  assert.ok(card > 0 && card <= 0.08, "a faint card tint, read from the board's CSS");
  const fails: string[] = [];
  for (const [name, tone] of [...PROJECT_HUES.map((t, i) => [`hue ${i}`, t] as const), ...TYPES.map((t) => [t.type, t.tone] as const)])
    for (const theme of ["light", "dark"] as const) {
      const c = hex(tone[theme]);
      const words = contrast(CARD[theme], c);
      if (words < 4.5) fails.push(`${name} ${theme}: chip words ${words.toFixed(2)}`);
      const dot = contrast(c, CARD[theme]);
      if (dot < 3) fails.push(`${name} ${theme}: filter dot ${dot.toFixed(2)}`);
      const title = contrast(INK[theme], over(c, card, CARD[theme]));
      if (title < 7) fails.push(`${name} ${theme}: card title ${title.toFixed(2)}`);
    }
  assert.deepEqual(fails, []);
});

const oklab = (h: string): Rgb => {
  const [r, g, b] = hex(h).map(lin) as Rgb;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const apart = (a: string, b: string) => Math.hypot(...oklab(a).map((v, i) => v - oklab(b)[i]!));

test("no two types' colours read as one: every pair is at least 0.06 apart in OKLab in both themes, each still 4.5:1 as text", () => {
  const close: string[] = [];
  for (const theme of ["light", "dark"] as const)
    for (let i = 0; i < TYPES.length; i++)
      for (let j = i + 1; j < TYPES.length; j++) {
        const d = apart(TYPES[i]!.tone[theme], TYPES[j]!.tone[theme]);
        if (d < 0.06) close.push(`${theme}: ${TYPES[i]!.type} ~ ${TYPES[j]!.type} ${d.toFixed(3)}`);
      }
  assert.deepEqual(close, [], "projects of different types side by side on the board and in the sidebar");
  for (const t of TYPES) for (const theme of ["light", "dark"] as const) assert.ok(contrast(CARD[theme], hex(t.tone[theme])) >= 4.5, `${t.type} ${theme}: its words read`);
  assert.equal(apart("#ffffff", "#000000").toFixed(3), "1.000", "OKLab's lightness runs 0 to 1");
});
