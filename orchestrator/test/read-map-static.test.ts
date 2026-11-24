// The read map against the code (lag fix, 2026-11-24). change-reads.test.ts runs the reads on a made-up seed, so it only
// sees the tables the seed's data leads them to: it missed a card's PR (no seeded card had a PR block), and the persona
// paths (no pack is loaded there). A screen that misses a change stays stale until some other notice refetches it. Here
// each read's handler in server.ts is followed through every Engine method and module function it can call, and every
// table their SQL names must be in its change-notice.ts READS entry; a declared table no path reaches must be explained.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { BB, LIVE, READS, STATUS, type ChangeRead } from "../change-notice.ts";

const ROOT = join(import.meta.dirname, "..");
const FILES = ["server.ts", "personas.ts", "blocks.ts", ...readdirSync(join(ROOT, "core")).filter((f) => f.endsWith(".ts")).map((f) => `core/${f}`)];
const SQL_TABLE = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi;

/** Declared, though no path from the read's handler reaches a SELECT of it: each with why. */
const DECLARED_UNREACHED: Partial<Record<ChangeRead, Record<string, string>>> = {
  config: { multiplayer_boards: "multiplayer.store, not the engine", review_queue_state: "reviewQueue.store, not the engine" },
  board: { external_mail: "the mail tables go together (ITEMS)" },
  projects: { external_mail: "the mail tables go together (ITEMS)" },
  directHistory: { external_mail: "the mail tables go together (ITEMS)" },
  projectHistory: { external_mail: "the mail tables go together (ITEMS)", direct_images: "the mail tables go together (ITEMS)" },
  feed: { external_mail: "the mail tables go together (ITEMS)" },
};
/** Not tables: what a write's change names besides them (change-notice.ts). */
const PSEUDO = new Set<string>([STATUS, LIVE, BB]);

type Fn = { file: string; tables: Set<string>; calls: Set<string> };

function sqlTables(text: string): string[] {
  return /\bSELECT\b/i.test(text) ? [...text.matchAll(SQL_TABLE)].map((m) => m[1]!.toLowerCase()) : [];
}

/** Every function in the plugin's server and core, by key: "Engine.<method>", "<file>:<name>", "rpc:<read>". */
function index() {
  const sources = FILES.map((f) => [f, ts.createSourceFile(f, readFileSync(join(ROOT, f), "utf8"), ts.ScriptTarget.Latest, true)] as const);
  // module-level SQL strings (a fragment a query interpolates), by file and, when exported, by name alone
  const consts = new Map<string, string[]>();
  const textOf = (n: ts.Node): string | null =>
    ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map((s) => ` ? ${s.literal.text}`).join("") : null;
  for (const [f, sf] of sources)
    for (const st of sf.statements)
      if (ts.isVariableStatement(st))
        for (const d of st.declarationList.declarations) {
          const text = d.initializer && ts.isIdentifier(d.name) ? textOf(d.initializer) : null;
          if (text === null) continue;
          const name = (d.name as ts.Identifier).text;
          consts.set(`${f}:${name}`, sqlTables(text));
          if (st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) consts.set(`*:${name}`, sqlTables(text));
        }
  const fns = new Map<string, Fn>();
  const byName = new Map<string, string[]>();
  // `this.<field>.<method>` in the engine: the fields that read the database, by their class
  const FIELDS: Record<string, string> = { batch: "core/batch-inbox.ts:BatchInbox" };
  const add = (key: string, node: ts.Node, file: string, inEngine: boolean, cls: string | null = null) => {
    const fn: Fn = { file, tables: new Set(), calls: new Set() };
    const visit = (n: ts.Node) => {
      const text = textOf(n);
      if (text !== null) for (const t of sqlTables(text)) fn.tables.add(t);
      if (ts.isIdentifier(n)) for (const t of consts.get(`${file}:${n.text}`) ?? consts.get(`*:${n.text}`) ?? []) fn.tables.add(t);
      if (ts.isPropertyAccessExpression(n)) {
        const obj = n.expression;
        // a call, or a method passed as a value
        if ((obj.kind === ts.SyntaxKind.ThisKeyword && inEngine) || (ts.isIdentifier(obj) && obj.text === "engine")) fn.calls.add(`Engine.${n.name.text}`);
        else if (obj.kind === ts.SyntaxKind.ThisKeyword && cls) fn.calls.add(`${file}:${cls}.${n.name.text}`);
        else if (inEngine && ts.isPropertyAccessExpression(obj) && obj.expression.kind === ts.SyntaxKind.ThisKeyword && FIELDS[obj.name.text]) fn.calls.add(`${FIELDS[obj.name.text]}.${n.name.text}`);
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) fn.calls.add(`@${n.expression.text}`);
      ts.forEachChild(n, visit);
    };
    visit(node);
    fns.set(key, fn);
    if (!key.startsWith("Engine.") && !key.startsWith("rpc:")) {
      const bare = key.slice(key.indexOf(":") + 1);
      byName.set(bare, [...(byName.get(bare) ?? []), key]);
    }
  };
  for (const [f, sf] of sources)
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name) add(`${f}:${st.name.text}`, st, f, false);
      if (ts.isVariableStatement(st))
        for (const d of st.declarationList.declarations)
          if (d.initializer && ts.isIdentifier(d.name) && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) add(`${f}:${d.name.text}`, d.initializer, f, false);
      if (ts.isClassDeclaration(st) && st.name)
        for (const m of st.members)
          if ((ts.isMethodDeclaration(m) || ts.isGetAccessor(m)) && ts.isIdentifier(m.name)) add(st.name.text === "Engine" ? `Engine.${m.name.text}` : `${f}:${st.name.text}.${m.name.text}`, m, f, st.name.text === "Engine", st.name.text);
    }
  // server.ts: the plugin body's own helpers (card, watchersView, ...) and the RPC handlers given to shareReads
  const handlers = new Set<string>();
  const server = sources.find(([f]) => f === "server.ts")![1];
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) && !fns.has(`server.ts:${n.name.text}`))
      add(`server.ts:${n.name.text}`, n.initializer, "server.ts", false);
    if (ts.isFunctionDeclaration(n) && n.name && !fns.has(`server.ts:${n.name.text}`)) add(`server.ts:${n.name.text}`, n, "server.ts", false);
    if (ts.isCallExpression(n) && n.expression.getText() === "shareReads" && n.arguments[2] && ts.isObjectLiteralExpression(n.arguments[2]))
      for (const p of n.arguments[2].properties)
        if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name)) {
          add(`rpc:${p.name.text}`, p, "server.ts", false);
          handlers.add(p.name.text);
        }
    ts.forEachChild(n, visit);
  };
  visit(server);
  return { fns, byName, handlers };
}

/** Each table a read's handler can reach, with the call path to it. */
function reach(ix: ReturnType<typeof index>, read: string): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  const stack: [string, string[]][] = [[`rpc:${read}`, [`rpc:${read}`]]];
  while (stack.length) {
    const [key, path] = stack.pop()!;
    if (seen.has(key)) continue;
    seen.add(key);
    const fn = ix.fns.get(key);
    if (!fn) continue;
    for (const t of fn.tables) if (!out.has(t)) out.set(t, path.join(" > "));
    for (const c of fn.calls) {
      if (!c.startsWith("@")) stack.push([c, [...path, c]]);
      else {
        const local = `${fn.file}:${c.slice(1)}`;
        for (const k of ix.fns.has(local) ? [local] : (ix.byName.get(c.slice(1)) ?? [])) stack.push([k, [...path, k]]);
      }
    }
  }
  return out;
}

test("every table a read's code can SELECT is in its READS entry", () => {
  const ix = index();
  const missing: string[] = [];
  for (const m of Object.keys(READS) as ChangeRead[]) {
    assert.ok(ix.handlers.has(m), `no handler for ${m} in server.ts`);
    const declared = READS[m];
    if (!declared) continue; // refetched on every change
    for (const [t, path] of reach(ix, m)) if (!(declared as readonly string[]).includes(t)) missing.push(`${m} reads ${t} via ${path}`);
  }
  assert.deepEqual(missing, [], "add each to change-notice.ts READS, or the screen misses that change");
});

test("every table a READS entry declares is one its code can reach, or says why", () => {
  const ix = index();
  const extra: string[] = [];
  for (const m of Object.keys(READS) as ChangeRead[]) {
    const declared = READS[m];
    if (!declared) continue;
    const reached = reach(ix, m);
    for (const t of declared) if (!PSEUDO.has(t) && !reached.has(t) && !DECLARED_UNREACHED[m]?.[t]) extra.push(`${m} declares ${t}`);
  }
  assert.deepEqual(extra, [], "each refetches the read for nothing: drop it, or say in DECLARED_UNREACHED why it stays");
});

test("the engine's fields that call into other classes are all followed", () => {
  // a field the walk doesn't follow hides its SQL from both tests above (the batched inbox was one)
  const src = readFileSync(join(ROOT, "core/engine.ts"), "utf8");
  const fields = new Set([...src.matchAll(/this\.([a-zA-Z]+)\.[a-zA-Z]+\(/g)].map((m) => m[1]!));
  for (const f of ["db", "ports", "notFoundAt", "inflight", "batch"]) fields.delete(f); // the database, the server, two Maps/Sets, and batch (followed)
  assert.deepEqual([...fields], [], "follow each in FIELDS, or say here why it reads no table");
  assert.ok(!/^\s+#[a-z]\w*\(/m.test(src), "a #private method: the walk skips those");
});

test("the walk finds what it must: a card's PR, a wait's PR, a persona's XP", () => {
  // the walk itself: these are the paths change-reads.test.ts's seed never took
  const ix = index();
  assert.match(reach(ix, "needsYou").get("prs") ?? "", /server\.ts:card > Engine\.prByUrl/);
  assert.match(reach(ix, "board").get("prs") ?? "", /Engine\.waitPr > Engine\.prByUrl/);
  assert.match(reach(ix, "projects").get("xp") ?? "", /Engine\.personaOf > Engine\.xpOf/);
  assert.ok(reach(ix, "feed").has("lead_status"), "core/feed.ts's own queries");
});
