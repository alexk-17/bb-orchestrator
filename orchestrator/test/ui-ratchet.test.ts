// The shadcn ratchet (2026-11-17, the owner: "utilize very standardized ui components and nothing too custom"). Every
// screen moves onto app/ui (shadcn/ui on bb's tokens) one tab at a time, so outside app/ui no file may gain a raw
// <button>, a colour literal (hex, rgb or oklch) or an import from the vendored affectUI (./affect/). Each file's
// count today is in ui-ratchet.allow.json, and the list only goes down: a file above its count fails (use app/ui), and
// a file below it fails too until the list is lowered to match, so a count won back can't be spent again.
// It reads the UI sources only (app.tsx, app/, cloud/, gameboy/, multiplayer/), never core/ or the tests.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const ALLOW: Record<string, Partial<Record<Kind, number>>> = JSON.parse(readFileSync(new URL("./ui-ratchet.allow.json", import.meta.url), "utf8"));

type Kind = "button" | "colour" | "affect";
/** A raw <button> element in JSX or in an HTML string */
const BUTTON = /<button\b/g;
/** #fff, #ffffff, #ffffff80, rgb()/rgba(), oklch(): a colour written into the source instead of a token */
const COLOUR = /(?<![\w&/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\brgba?\(|\boklch\(/g;
/** An import from the vendored affectUI */
const AFFECT = /from\s+["'][^"']*\/affect\//g;
const PATTERNS: Record<Kind, RegExp> = { button: BUTTON, colour: COLOUR, affect: AFFECT };

/** A comment line says nothing on screen */
const isComment = (l: string) => /^\s*(\/\/|\/\*|\*)/.test(l);
export function counts(src: string): Record<Kind, number> {
  const lines = src.split("\n").filter((l) => !isComment(l));
  const n = (re: RegExp) => lines.reduce((s, l) => s + (l.match(re)?.length ?? 0), 0);
  return { button: n(BUTTON), colour: n(COLOUR), affect: n(AFFECT) };
}

/** The UI sources: app.tsx and every .ts/.tsx/.mjs under app/, cloud/, gameboy/ and multiplayer/, except app/ui, tests and dot-dirs */
function sources(): string[] {
  const out = [join(ROOT, "app.tsx")];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e.startsWith(".") || e === "node_modules" || e === "test") continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|mjs)$/.test(e)) out.push(p);
    }
  };
  for (const d of ["app", "cloud", "gameboy", "multiplayer"]) walk(join(ROOT, d));
  return out.map((p) => relative(ROOT, p)).filter((f) => !f.startsWith("app/ui/")).sort();
}

test("the patterns catch what they are for, and leave tokens alone", () => {
  const bad = counts(['<button type="button" onClick={go}>', 'color: "#c4320a",', "background: rgba(0, 0, 0, 0.03);", "--x: oklch(70% .15 155);", 'import { Badge } from "./affect/badge-clean.tsx";', "fill: #fff;"].join("\n"));
  assert.deepEqual(bad, { button: 1, colour: 4, affect: 1 });
  const fine = counts(['<Button variant="outline">', "color: var(--foreground);", "bg-(--success)/10", '<a href="#top">', "// was #c4320a", 'import { Button } from "./ui/button.tsx";', "&#x2715;", "id-#ab-1"].join("\n"));
  assert.deepEqual(fine, { button: 0, colour: 0, affect: 0 });
});

test("no UI file outside app/ui gains a raw <button>, a colour literal or an affectUI import, and the list stays tight", () => {
  const files = sources();
  assert.ok(files.length > 40 && files.includes("app/ui.tsx"), "the UI sources are found"); // a scan that reads nothing must not pass
  const over: string[] = [];
  const under: string[] = [];
  for (const f of files) {
    const c = counts(readFileSync(join(ROOT, f), "utf8"));
    for (const k of Object.keys(PATTERNS) as Kind[]) {
      const allowed = ALLOW[f]?.[k] ?? 0;
      if (c[k] > allowed) over.push(`${f}: ${c[k]} ${k} (allowed ${allowed}): use app/ui`);
      else if (c[k] < allowed) under.push(`${f}: ${c[k]} ${k}: lower its allowance from ${allowed} to ${c[k]}`);
    }
  }
  assert.deepEqual(over, [], "a new raw button, colour literal or affectUI import");
  assert.deepEqual(under, [], "the allowlist only goes down: lower it to the new count");
  // every allowlisted file still exists (a file renamed away must take its allowance with it)
  for (const f of Object.keys(ALLOW)) assert.ok(files.includes(f), `${f} is allowlisted but is not a UI source`);
});

// bb's dark theme is the .dark class on <html>, from bb's own setting; `bb plugin build` compiles Tailwind's plain `dark:`
// to the OS setting, which is wrong whenever the two differ (2026-11-17, app/ui/utils.ts). So no UI source, app/ui
// included, writes a plain `dark:`: it is `[&:is(.dark_*)]:`.
const PLAIN_DARK = /(?<![\w.-])dark:(?=[\w[&!-])/; // a class (dark:bg-…), not a key (dark: "#…")
test("no UI source uses Tailwind's plain dark: (it follows the OS, not bb's theme)", () => {
  // the sample is built, so Tailwind (it scans test/ too) doesn't compile it into app.css
  assert.ok(PLAIN_DARK.test(`"bg-input ${"dark"}:bg-input/30"`) && !PLAIN_DARK.test('dark: "#f9a8d4",') && !PLAIN_DARK.test('"[&:is(.dark_*)]:bg-input/30"') && !PLAIN_DARK.test("color-scheme: dark;"));
  const ui = readdirSync(join(ROOT, "app/ui")).filter((f) => f.endsWith(".tsx")).map((f) => `app/ui/${f}`);
  assert.ok(ui.length > 20, "app/ui is read");
  const found = [...sources(), ...ui].flatMap((f) => readFileSync(join(ROOT, f), "utf8").split("\n").filter((l) => !isComment(l) && PLAIN_DARK.test(l)).map((l) => `${f}: ${l.trim().slice(0, 100)}`));
  assert.deepEqual(found, []);
});
