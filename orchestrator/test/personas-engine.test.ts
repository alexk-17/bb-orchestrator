// The personas hook in the engine (scope §3-4): with the pokemon setting on and a pack loaded, the CoS, the
// Steward and the leads are people (a persona), and a lead's Pokémon is hidden, never deleted, and frees its line.
// Threads draw from their lead's persona's lines first. Loading a pack moves each lead's oldest threads onto its
// persona's roster lines (scope answer 4), and nothing else; removing one gives the leads their Pokémon back. Personas and projects here are made up (test/fixtures/personas-pack.json).
import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Engine, type DeliverResult, type Settings } from "../core/engine.ts";
import { BRIEFS, BRIEF_VARS, introSentence, loadBrief } from "../core/start.ts";
import { readPersonaPack, type PersonaPack } from "../personas.ts";
import { baseOf, monByName, tokensForLevel } from "../mons.ts";
import { deliverableRows, deliverableWhole } from "../core/deliverables-view.ts";

const ports = { now: () => Date.parse("2026-11-18T10:00:00Z"), deliver: async (): Promise<DeliverResult> => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} };
const PACK = readPersonaPack(join(import.meta.dirname, "fixtures", "personas-pack.json"));
const BRIEF_DIR = join(import.meta.dirname, "..", "briefs");

function setup(s: Partial<Settings> = { pokemon: true, personas: PACK }, db = new DatabaseSync(":memory:")) {
  return { db, e: new Engine(db as never, ports, s) };
}
type Row = { thread_id: string; role: string; mon: string; mon_stage: number | null; mon_stage_level: number | null };
const rows = (db: DatabaseSync) => db.prepare(`SELECT thread_id, role, mon, mon_stage, mon_stage_level FROM agents WHERE retired_at IS NULL ORDER BY thread_id`).all() as Row[];
const monOf = (db: DatabaseSync, threadId: string) => rows(db).find((r) => r.thread_id === threadId)!.mon;

test("with a pack the CoS, the Steward and the leads are people; threads are Pokémon from their lead's lines first", () => {
  const { db, e } = setup();
  e.register("T-cos", "cos", null);
  e.register("T-st", "steward", null);
  e.register("L-cr", "lead", "code-reviews"); // Dark: the pack's first Dark persona
  for (const n of [1, 2, 3, 4]) e.register(`W-${n}`, "thread", "code-reviews", "L-cr");
  assert.deepEqual(e.personaOf(e.agentByAddress("cos")!), { name: "Orrin", title: "Harbormaster", image: "https://personas.example.test/orrin.png", credit: null, team: ["Rayquaza"], teamDex: [384], roster: [], partner: "Rayquaza", type: null });
  assert.equal(e.personaOf(e.agentByAddress("steward")!)?.partner, "Chansey");
  const lead = e.agentByAddress("lead:code-reviews")!;
  assert.equal(e.personaOf(lead)?.name, "Vesna");
  assert.equal(e.personaOf(lead)?.partner, null, "a lead has no partner: its threads are its Pokémon");
  assert.equal(lead.mon, null, "the lead's Pokémon is hidden");
  assert.equal(monOf(db, "L-cr"), "Deino", "…but kept in the database");
  assert.deepEqual([1, 2, 3, 4].map((n) => e.agentByThread(`W-${n}`)!.mon), ["Feebas", "Budew", "Togepi", "Deino"], "the persona's lines, then the family, whose lead line is free now");
  assert.equal(e.personaOf(e.agentByThread("W-1")!), null, "threads have no persona");
});

test("a live persona's signature line is kept for its own threads: another project skips it", () => {
  const pack: PersonaPack = { ...PACK, personas: { ...PACK.personas, vesna: { ...PACK.personas.vesna!, roster: ["Feebas", "Gible", "Budew"] } } };
  const { e } = setup({ pokemon: true, personas: pack });
  e.register("L-vm", "lead", "vm-storage"); // Ground: Pell, whose signature is Gible
  e.register("L-cr", "lead", "code-reviews");
  e.register("W-1", "thread", "code-reviews", "L-cr");
  e.register("W-2", "thread", "code-reviews", "L-cr");
  assert.equal(e.agentByThread("W-2")!.mon, "Budew", "Gible is Pell's signature while Pell leads a live project");
  e.register("W-3", "thread", "vm-storage", "L-vm");
  assert.equal(e.agentByThread("W-3")!.mon, "Gible");
  e.setStatus("L-vm", "archived");
  e.register("W-4", "thread", "code-reviews", "L-cr");
  assert.notEqual(e.agentByThread("W-4")!.mon, "Gible", "W-3 still holds it: no two live agents share one");
});

test("the persona named in a lead's brief is the one it gets, for a new project and after an archived lead", () => {
  const { e } = setup();
  e.register("L-cr", "lead", "code-reviews");
  const promised = e.personaForStart("lead", "vm-storage");
  assert.equal(promised?.name, "Pell");
  e.registerStarted("L-vm", "lead", "vm-storage");
  assert.deepEqual(e.personaOf(e.agentByAddress("lead:vm-storage")!), promised);
  e.setStatus("L-cr", "archived");
  const again = e.personaForStart("lead", "code-reviews");
  e.registerStarted("L-cr2", "lead", "code-reviews");
  assert.deepEqual(e.personaOf(e.agentByAddress("lead:code-reviews")!), again);
  assert.equal(again?.name, "Vesna");
});

test("a later lead never takes an earlier lead's persona, and the fallback catches the rest", () => {
  const { e } = setup();
  e.register("L-a", "lead", "edge-cli"); // Electric: Brannoc
  e.register("L-b", "lead", "vm-storage"); // Ground: Pell (first), Brannoc is held
  e.register("L-c", "lead", "qa-suite"); // Fighting: no list
  assert.deepEqual(["edge-cli", "vm-storage", "qa-suite"].map((p) => e.personaOf(e.agentByAddress(`lead:${p}`)!)?.name), ["Brannoc", "Pell", "Ysolde"]);
});

test("the briefs say who the agent is instead of its Pokémon", () => {
  const { e } = setup();
  const brief = (role: (typeof BRIEFS)[number], project: string | null) => {
    const known: Record<string, string> = { slug: "code-reviews", address: "lead:code-reviews", pokemon: introSentence(e.monForStart(role, project), e.personaForStart(role, project)) };
    return loadBrief(BRIEF_DIR, role, Object.fromEntries(BRIEF_VARS[role].map((k) => [k, known[k] ?? "x"])));
  };
  assert.match(brief("cos", null), /You are Harbormaster Orrin; your partner is Rayquaza\. Your working folder/);
  assert.match(brief("steward", null), /You are Warden Tamsin; your partner is Chansey\. Your working/);
  const lead = brief("lead", "code-reviews");
  assert.match(lead, /You are Pilot Vesna\. Your working folder/);
  assert.doesNotMatch(lead, /Your Pokémon is/, "a lead gets no Pokémon sentence");
});

test("no evolution rows for a lead with a persona; its threads' still come", () => {
  const { e } = setup();
  e.register("L-cr", "lead", "code-reviews");
  e.register("W-1", "thread", "code-reviews", "L-cr");
  e.gainXp("L-cr", tokensForLevel(64), 1); // Deino would be Hydreigon
  e.gainXp("W-1", tokensForLevel(40), 1); // Feebas → Milotic
  const titles = e.board().map((r) => r.title);
  assert.ok(titles.includes("Feebas evolved into Milotic!"), titles.join(" | "));
  assert.ok(!titles.some((t) => /Deino|Zweilous|Hydreigon/.test(t)), "the lead's hidden Pokémon never shows");
  assert.equal(e.xpOf("lead:code-reviews").level, 64, "the lead still levels");
});

/** An install without a pack: leads, and threads in turn. */
function crowd(db = new DatabaseSync(":memory:")) {
  const { e } = setup({ pokemon: true }, db);
  e.register("T-cos", "cos", null);
  for (const p of ["code-reviews", "vm-storage", "edge-cli"]) e.register(`L-${p}`, "lead", p);
  for (let n = 0; n < 4; n++) for (const p of ["code-reviews", "vm-storage", "edge-cli"]) e.register(`W-${p}-${n}`, "thread", p, `L-${p}`);
  return { db, e };
}

/** An engine whose clock moves a second per read, so "oldest first" is the order agents started, not their ids'. */
function ticking(s: Partial<Settings>, db = new DatabaseSync(":memory:")) {
  let t = Date.parse("2026-11-18T10:00:00Z");
  return { db, e: new Engine(db as never, { ...ports, now: () => (t += 1000) }, s) };
}
/** Set a thread's Pokémon as it was before the pack, by hand: the test then knows exactly what each one holds. */
const put = (db: DatabaseSync, threadId: string, mon: string) => db.prepare(`UPDATE agents SET mon = ?, mon_stage = NULL, mon_stage_level = NULL WHERE thread_id = ?`).run(mon, threadId);

test("loading a pack moves each lead's oldest threads onto its persona's roster lines, in order; the CoS and the Steward stay", () => {
  const { db, e } = ticking({ pokemon: true });
  e.register("T-cos", "cos", null);
  e.register("T-st", "steward", null);
  e.register("L-cr", "lead", "code-reviews"); // Vesna with the pack: Feebas, Budew, Togepi
  // ids that sort the other way round from their age: z-1 is the oldest
  for (const id of ["z-1", "y-2", "x-3", "w-4", "v-5"]) e.register(id, "thread", "code-reviews", "L-cr");
  for (const [id, mon] of [["z-1", "Sandile"], ["y-2", "Axew"], ["x-3", "Duskull"], ["w-4", "Zubat"], ["v-5", "Lillipup"]] as const) put(db, id, mon);
  e.gainXp("z-1", tokensForLevel(40), 1);
  const standing = rows(db).filter((r) => r.role === "cos" || r.role === "steward");
  e.settings = { ...e.settings, personas: PACK };
  assert.deepEqual(["z-1", "y-2", "x-3", "w-4", "v-5"].map((t) => monOf(db, t)), ["Feebas", "Budew", "Togepi", "Zubat", "Lillipup"], "the oldest three take the roster; the rest keep theirs");
  assert.deepEqual(rows(db).filter((r) => r.role === "cos" || r.role === "steward"), standing, "the CoS and the Steward never move");
  const z = e.agentByThread("z-1")!;
  assert.equal(e.xpOf(z.address).level, 40, "a moved thread keeps its level");
  assert.equal(e.formOf(z, 40)?.name, "Milotic", "and shows its new line's form at that level, not a pinned base");
  assert.equal(e.settleMons(), 0, "a second run moves nothing");
  const { e: fresh } = ticking({ pokemon: true, personas: PACK }, db);
  assert.equal(fresh.settleMons(), 0, "nor a plugin restarted with the pack");
});

test("with a pack, no thread holds the Steward's line, even when its trainer's roster names it", () => {
  // a thread on Happiny's line shows Chansey, the Steward's partner
  const pack: PersonaPack = { ...PACK, personas: { ...PACK.personas, vesna: { ...PACK.personas.vesna!, roster: ["Happiny", "Feebas", "Budew"] } } };
  const { db, e } = ticking({ pokemon: true });
  e.register("T-st", "steward", null);
  e.register("L-cr", "lead", "code-reviews");
  e.register("old", "thread", "code-reviews", "L-cr");
  put(db, "old", "Happiny");
  e.settings = { ...e.settings, personas: pack };
  assert.equal(monOf(db, "old"), "Feebas", "the roster's first line the Steward doesn't hold");
  e.register("new", "thread", "code-reviews", "L-cr");
  assert.equal(monOf(db, "new"), "Budew", "a new thread skips Happiny too");
  put(db, "new", "Happiny");
  const { e: fresh } = ticking({ pokemon: true, personas: pack }, db);
  assert.notEqual(monOf(db, "new"), "Happiny", "a restart with the pack moves a thread off it");
  assert.equal(monOf(db, "T-st"), "Chansey", "the Steward never moves");
  assert.equal(fresh.settleMons(), 0, "a second settle moves nothing");
});

test("a plugin started with a pack makes the same moves as loading it, and logs how many moved", () => {
  const db = new DatabaseSync(":memory:");
  const { e } = ticking({ pokemon: true }, db);
  e.register("L-cr", "lead", "code-reviews");
  for (const id of ["a", "b"]) e.register(id, "thread", "code-reviews", "L-cr");
  put(db, "a", "Sandile");
  put(db, "b", "Axew");
  const logs: string[] = [];
  new Engine(db as never, { ...ports, log: (m: string) => logs.push(m) }, { pokemon: true, personas: PACK });
  assert.deepEqual(["a", "b"].map((t) => monOf(db, t)), ["Feebas", "Budew"]);
  assert.ok(logs.some((m) => /pokemon: 2 agent\(s\) moved/.test(m)), logs.join(" | "));
});

test("a roster move never takes another live trainer's signature; a line a thread of another project leaves is free", () => {
  // Vesna's roster names Gible, Pell's signature; and Pell's thread sits on Togepi, one of Vesna's lines, until it
  // takes Pell's own free signature
  const pack: PersonaPack = { ...PACK, personas: { ...PACK.personas, vesna: { ...PACK.personas.vesna!, roster: ["Feebas", "Gible", "Togepi", "Budew"] } } };
  const { db, e } = ticking({ pokemon: true });
  e.register("L-vm", "lead", "vm-storage"); // Pell: Gible, Riolu
  e.register("L-cr", "lead", "code-reviews");
  for (const id of ["vm-1", "vm-2"]) e.register(id, "thread", "vm-storage", "L-vm");
  for (const id of ["cr-1", "cr-2", "cr-3"]) e.register(id, "thread", "code-reviews", "L-cr");
  for (const [id, mon] of [["vm-1", "Gible"], ["vm-2", "Togepi"], ["cr-1", "Sandile"], ["cr-2", "Axew"], ["cr-3", "Duskull"]] as const) put(db, id, mon);
  put(db, "vm-1", "Riolu"); // Pell's own line: kept. Gible is free, and still Pell's
  e.settings = { ...e.settings, personas: pack };
  assert.equal(monOf(db, "vm-2"), "Gible", "Pell's own thread takes its free signature");
  assert.deepEqual(["cr-1", "cr-2", "cr-3"].map((t) => monOf(db, t)), ["Feebas", "Togepi", "Budew"], "Gible skipped; Togepi was free once vm-2 left it");
  assert.equal(e.settleMons(), 0);
});

// A thread's lines while a pack applies: its trainer's roster, then its specialty type's lines, then its good fits, then (rarely) its project's family.
const withPersonas = (over: Record<string, Partial<PersonaPack["personas"][string]>>): PersonaPack => ({
  ...PACK,
  personas: Object.fromEntries(Object.entries(PACK.personas).map(([id, p]) => [id, { ...p, ...(over[id] ?? {}) }])),
});

test("a new thread takes its trainer's roster, then its specialty's lines, then its fits, then its project's family", () => {
  const pack = withPersonas({ vesna: { roster: ["Feebas", "Budew", "Togepi"], type: "ghost", fits: ["Gible", "Happiny", "Dratini", "Riolu"] } });
  const { e } = ticking({ pokemon: true, personas: pack });
  e.register("T-st", "steward", null); // holds Happiny's line (Chansey)
  e.register("L-vm", "lead", "vm-storage"); // Pell, live: Gible is his signature
  e.register("L-cr", "lead", "code-reviews"); // Vesna, on a Dark project
  const got = Array.from({ length: 10 }, (_, n) => (e.register(`W-${n}`, "thread", "code-reviews", "L-cr"), e.agentByThread(`W-${n}`)!.mon));
  assert.deepEqual(got, [
    ...["Feebas", "Budew", "Togepi"], // the roster
    ...["Gastly", "Litwick", "Duskull"], // her specialty, Ghost, not her project's Dark
    ...["Dratini", "Riolu"], // her fits, without Pell's signature or the Steward's line
    ...["Deino", "Sandile"], // the last resort: the project's family
  ]);
});

test("a Champion with no specialty goes from its team straight to its fits", () => {
  const pack = withPersonas({ vesna: { roster: ["Feebas"], fits: ["Larvitar", "Deino"] } });
  const { e } = ticking({ pokemon: true, personas: pack });
  e.register("L-cr", "lead", "code-reviews");
  const got = Array.from({ length: 4 }, (_, n) => (e.register(`W-${n}`, "thread", "code-reviews", "L-cr"), e.agentByThread(`W-${n}`)!.mon));
  assert.deepEqual(got, ["Feebas", "Larvitar", "Deino", "Sandile"], "no Dark lines between the team and the fits: Dark is the project's type, not hers");
});

test("the re-settle goes tier by tier across projects: a line goes back to the thread that ranks it higher", () => {
  // a trainer's team line, held by another project's thread, goes back to that trainer's project
  const pack = withPersonas({
    vesna: { roster: ["Feebas", "Horsea", "Pichu"], type: "ghost" },
    pell: { roster: [], fits: ["Duskull"] }, // no team, no specialty: Duskull is his fits tier
  });
  const { db, e } = ticking({ pokemon: true });
  e.register("T-st", "steward", null);
  e.register("L-vm", "lead", "vm-storage"); // Pell
  e.register("L-cr", "lead", "code-reviews"); // Vesna
  e.register("L-ec", "lead", "edge-cli"); // Brannoc: Shinx, Pichu
  const ids = ["vm-1", "vm-2", "cr-1", "cr-2", "cr-3", "cr-4", "cr-5", "ec-1", "ec-2"];
  for (const id of ids) e.register(id, "thread", id.startsWith("vm") ? "vm-storage" : id.startsWith("cr") ? "code-reviews" : "edge-cli", `L-${id.slice(0, 2)}`);
  const before: Record<string, string> = { "vm-1": "Horsea", "vm-2": "Duskull", "cr-1": "Sandile", "cr-2": "Axew", "cr-3": "Gastly", "cr-4": "Litwick", "cr-5": "Seedot", "ec-1": "Pichu", "ec-2": "Happiny" };
  for (const [id, mon] of Object.entries(before)) put(db, id, mon);
  e.gainXp("vm-1", tokensForLevel(30), 1);
  e.settings = { ...e.settings, personas: pack };
  const after = Object.fromEntries(ids.map((id) => [id, monOf(db, id)]));
  assert.equal(after["cr-1"], "Feebas", "the roster first, oldest first");
  assert.equal(after["cr-2"], "Horsea", "Horsea is on Vesna's roster: it goes back to her project, off vm-1, the older thread that held it as a last resort");
  assert.equal(after["ec-1"], "Pichu", "Brannoc's thread holds Pichu at the same tier, its roster: it stays");
  assert.deepEqual([after["cr-3"], after["cr-4"]], ["Gastly", "Litwick"], "threads already on their specialty's lines keep them");
  assert.equal(after["cr-5"], "Duskull", "Duskull is Vesna's specialty, only Pell's fit: her thread takes it off vm-2");
  assert.equal(after["ec-2"], "Shinx", "a thread on the Steward's line takes its trainer's free signature");
  for (const id of ["vm-1", "vm-2"]) assert.ok(!["Horsea", "Duskull"].includes(after[id]!), `${id} moved off the line it lost (to ${after[id]})`);
  const lines = rows(db).filter((r) => r.role !== "lead").map((r) => baseOf(r.mon)); // a lead's Pokémon is hidden and holds nothing
  assert.equal(new Set(lines).size, lines.length, "no two live agents share a line");
  assert.equal(monOf(db, "T-st"), "Chansey", "the Steward never moves");
  assert.equal(e.xpOf(e.agentByThread("vm-1")!.address).level, 30, "a moved thread keeps its level");
  assert.equal(e.settleMons(), 0, "a second run moves nothing");
  const { e: fresh } = ticking({ pokemon: true, personas: pack }, db);
  assert.equal(fresh.settleMons(), 0, "nor a restart with the pack");
});

test("a line a moved thread leaves is taken in the same run, so the next run moves nothing", () => {
  const pack: PersonaPack = { ...PACK, personas: { ...PACK.personas, vesna: { ...PACK.personas.vesna!, roster: ["Feebas", "Budew"] } } };
  const { db, e } = ticking({ pokemon: true });
  e.register("L-cr", "lead", "code-reviews");
  e.register("L-ed", "lead", "edge-cli"); // Brannoc: Shinx, Pichu
  for (const id of ["cr-1", "cr-2"]) e.register(id, "thread", "code-reviews", "L-cr");
  e.register("ed-1", "thread", "edge-cli", "L-ed"); // younger than both, on Budew: it moves after them
  for (const [id, mon] of [["cr-1", "Sandile"], ["cr-2", "Axew"], ["ed-1", "Budew"]] as const) put(db, id, mon);
  e.settings = { ...e.settings, personas: pack };
  assert.deepEqual(["cr-1", "cr-2", "ed-1"].map((t) => monOf(db, t)), ["Feebas", "Budew", "Shinx"]);
  assert.equal(e.settleMons(), 0);
});

test("an older thread placed in a run takes an earlier roster line a younger one frees later in it: the signature first", () => {
  // modelled on the live audit: one trainer's only thread found its signature held by another project's thread, which
  // moved onto its own trainer's lines later in the same run
  const { db, e } = ticking({ pokemon: true });
  e.register("L-cr", "lead", "code-reviews"); // Vesna: Feebas, Budew, Togepi
  e.register("L-ed", "lead", "edge-cli"); // Brannoc: Shinx, Pichu
  e.register("cr-1", "thread", "code-reviews", "L-cr");
  e.register("ed-1", "thread", "edge-cli", "L-ed");
  put(db, "cr-1", "Sandile");
  put(db, "ed-1", "Feebas");
  e.settings = { ...e.settings, personas: PACK };
  assert.deepEqual(["cr-1", "ed-1"].map((t) => monOf(db, t)), ["Feebas", "Shinx"]);
  assert.equal(e.settleMons(), 0);
});

test("a thread already on its trainer's lines keeps its line, whatever its age", () => {
  const { db, e } = ticking({ pokemon: true });
  e.register("L-cr", "lead", "code-reviews");
  for (const id of ["old", "mid", "new"]) e.register(id, "thread", "code-reviews", "L-cr");
  for (const [id, mon] of [["old", "Sandile"], ["mid", "Duskull"], ["new", "Feebas"]] as const) put(db, id, mon);
  e.settings = { ...e.settings, personas: PACK };
  assert.deepEqual(["old", "mid", "new"].map((t) => monOf(db, t)), ["Budew", "Togepi", "Feebas"]);
});

test("off means off: with the setting off a loaded pack moves no thread; turning it on makes the moves", () => {
  const { db, e } = ticking({ pokemon: false });
  e.register("L-cr", "lead", "code-reviews");
  e.register("a", "thread", "code-reviews", "L-cr");
  put(db, "a", "Sandile");
  e.settings = { ...e.settings, personas: PACK };
  assert.equal(monOf(db, "a"), "Sandile");
  ticking({ pokemon: false, personas: PACK }, db);
  assert.equal(monOf(db, "a"), "Sandile", "nor at startup");
  e.settings = { ...e.settings, pokemon: true };
  assert.equal(monOf(db, "a"), "Feebas");
});

test("a plugin restarted with the pack keeps threads on their persona's lines and on their leads' freed lines", () => {
  const db = new DatabaseSync(":memory:");
  const { e } = setup({ pokemon: true, personas: PACK }, db);
  e.register("L-vm", "lead", "vm-storage"); // hidden Pokémon: Gible
  e.register("L-cr", "lead", "code-reviews");
  e.register("W-vm", "thread", "vm-storage", "L-vm"); // Gible, the lead's own line
  e.register("W-cr1", "thread", "code-reviews", "L-cr"); // Feebas
  e.register("W-cr2", "thread", "code-reviews", "L-cr"); // Budew: outside the Dark family
  e.retire("W-cr1");
  e.register("W-cr3", "thread", "code-reviews", "L-cr"); // Feebas again, the first free line: a re-pick would swap it
  const before = rows(db);
  assert.deepEqual(["W-vm", "W-cr2", "W-cr3"].map((t) => monOf(db, t)), ["Gible", "Budew", "Feebas"]);
  setup({ pokemon: true, personas: PACK }, db);
  assert.deepEqual(rows(db), before);
});

test("removing the pack gives each lead its Pokémon back and moves threads off it and off pack lines, keeping their stage", () => {
  const db = new DatabaseSync(":memory:");
  const { e } = setup({ pokemon: true, personas: PACK }, db);
  e.register("L-vm", "lead", "vm-storage"); // Pell; its hidden Pokémon is Gible
  e.register("L-cr", "lead", "code-reviews"); // Vesna
  e.register("W-vm", "thread", "vm-storage", "L-vm"); // Gible: the lead's line is free while a pack applies
  e.register("W-cr", "thread", "code-reviews", "L-cr"); // Feebas: a pack line
  assert.equal(monOf(db, "L-vm"), "Gible");
  assert.equal(monOf(db, "W-vm"), "Gible");
  e.gainXp("W-vm", tokensForLevel(30), 1); // Gabite: stage 1
  e.gainXp("W-cr", tokensForLevel(40), 1); // Milotic: stage 1
  e.settings = { ...e.settings, personas: null };
  assert.equal(e.agentByAddress("lead:vm-storage")!.mon, "Gible", "the lead has its Pokémon back");
  const vm = rows(db).find((r) => r.thread_id === "W-vm")!;
  const cr = rows(db).find((r) => r.thread_id === "W-cr")!;
  assert.notEqual(vm.mon, "Gible");
  assert.notEqual(cr.mon, "Feebas");
  assert.ok(monByName(cr.mon), "a line the plugin knows without the pack");
  assert.equal(monByName("Feebas"), null, "the pack's lines are gone");
  assert.deepEqual([vm.mon_stage, cr.mon_stage], [1, 1], "each kept its stage");
  assert.equal(e.personaOf(e.agentByAddress("lead:vm-storage")!), null);
  assert.equal(e.settleMons(), 0, "a second run moves nothing");
});

test("a plugin started without the pack it had moves threads off pack lines; with no stage to read it keeps any old pin", () => {
  const db = new DatabaseSync(":memory:");
  const { e } = setup({ pokemon: true, personas: PACK }, db);
  e.register("L-cr", "lead", "code-reviews");
  e.register("W-cr", "thread", "code-reviews", "L-cr");
  e.gainXp("W-cr", tokensForLevel(40), 1);
  const { e: fresh } = setup({ pokemon: true }, db);
  const cr = rows(db).find((r) => r.thread_id === "W-cr")!;
  assert.ok(cr.mon !== "Feebas" && monByName(cr.mon), cr.mon);
  assert.equal(cr.mon_stage, null, "no pin: the new line shows its own stage at the level");
  assert.equal(fresh.agentByAddress("lead:code-reviews")!.mon, "Deino");
  assert.equal(fresh.settleMons(), 0);
});

test("a pack that fails its checks shows nothing and moves nothing", () => {
  const db = new DatabaseSync(":memory:");
  const { e } = setup({ pokemon: true, personas: PACK }, db);
  e.register("L-cr", "lead", "code-reviews");
  e.register("W-cr", "thread", "code-reviews", "L-cr");
  const before = rows(db);
  e.settings = { ...e.settings, personas: { error: "personas pack: 1 problem: fallback: no persona" } };
  assert.deepEqual(rows(db), before, "a typo is not a removal");
  assert.equal(e.personaOf(e.agentByAddress("lead:code-reviews")!), null);
  setup({ pokemon: true, personas: { error: "broken" } }, db);
  assert.deepEqual(rows(db), before, "nor at load");
});

test("Delivered shows a lead's persona, which no XP gain changes: only leads deliver, and a lead has no partner", () => {
  const { e } = setup();
  e.register("T-cos", "cos", null);
  e.register("L-cr", "lead", "code-reviews");
  e.register("W-1", "thread", "code-reviews", "L-cr");
  const lead = e.agentByAddress("lead:code-reviews")!;
  const d = e.deliver(lead, { title: "Made-up report", summary: "Done.", proof: [{ kind: "link", caption: "the report", url: "https://example.test/report" }] }, { roots: [] });
  const rows = () => JSON.stringify([deliverableRows(e), deliverableWhole(e, d.id)]);
  assert.equal(deliverableRows(e)[0]!.leadPersona?.name, "Vesna");
  assert.deepEqual(deliverableWhole(e, d.id)!.leadPersona, e.personaOf(lead), "the same persona the other screens show");
  assert.equal(e.leadPersonaOf(e.agentByAddress("cos")!), null, "the CoS's persona has a partner, from its XP: not on this path");
  const before = rows();
  for (const t of ["L-cr", "T-cos", "W-1"]) e.gainXp(t, tokensForLevel(60), 1);
  assert.equal(e.xpOf("lead:code-reviews").level, 60);
  assert.equal(rows(), before);
});
