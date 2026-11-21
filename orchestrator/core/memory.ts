// The memory engine for the orchestrator's leads and threads (docs/memory-port.md, gaps 1, 3 and 4): which agent gets
// memory_search / memory_page and the memory pointer, and memory-search's command lines. Off unless the memoryConfig
// setting names a memory config file. No bb or zod import, so node --test checks it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ownerWords } from "./owner.ts";

export const TOOL_SEARCH = "memory_search";
export const TOOL_PAGE = "memory_page";
/** A memory project slug, as memlib reads folder names. Anything else never reaches a command line or instructions. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const QUERY_MAX = 2000;
export const REF_MAX = 4096;
export const LIMIT_DEFAULT = 8;
export const LIMIT_MAX = 20;
export const LINES_DEFAULT = 200;
export const LINES_MAX = 1000;
export const OUTPUT_MAX = 64_000;

/** The memory config: where memory-search, the vault and the project folders are. */
export type MemoryLocal = { configPath: string; search: string; vault: string | null; projectRoots: string[] };

const expand = (p: string, home: string) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);

/** The config file the setting names (`~` is the home folder), or null when it is empty: memory is off. */
export function memoryConfigPath(setting: string | undefined, home = homedir()): string | null {
  const s = setting?.trim();
  return s ? expand(s, home) : null;
}

/** An environment variable name the memory tools read the config path from: letters, digits and _, or null. */
export function configEnvName(setting: string | undefined): string | null {
  const s = setting?.trim() ?? "";
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(s) ? s : null;
}

/** The memory config at `path`, or null with the reason. `searchSetting` overrides memory.search (a test build). */
export function loadMemory(path: string | null, searchSetting = "", home = homedir()): { local: MemoryLocal | null; why: string } {
  if (path === null) return { local: null, why: "no memory config set (the memoryConfig setting)" };
  if (!isAbsolute(path)) return { local: null, why: `the memory config path isn't absolute: ${path}` };
  if (!existsSync(path)) return { local: null, why: `no memory config at ${path}` };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { local: null, why: `${path} isn't readable JSON: ${String(e)}` };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { local: null, why: `${path} isn't a JSON object` };
  const c = raw as Record<string, unknown>;
  const m = (c.memory && typeof c.memory === "object" ? c.memory : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? expand(v.trim(), home) : null);
  const roots = Array.isArray(m.projectRoots) ? m.projectRoots.map(str).filter((r): r is string => r !== null) : [];
  return {
    local: {
      configPath: path,
      search: str(searchSetting) ?? str(m.search) ?? "memory-search",
      vault: str(m.vault)?.replace(/\/+$/, "") ?? null,
      projectRoots: roots,
    },
    why: "",
  };
}

/** Every memory project: slug -> its folder (the first root holding <slug>/PROJECT.md wins, memlib's rule). */
export function memoryProjects(local: MemoryLocal): Map<string, string> {
  const out = new Map<string, string>();
  for (const root of local.projectRoots) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const n of names) if (SLUG.test(n) && !out.has(n) && existsSync(join(root, n, "PROJECT.md"))) out.set(n, join(root, n));
  }
  return out;
}

/** The project record a projects folder uses unless the projectRecord setting names another. */
export const PROJECT_RECORD = "project.json";

/**
 * The live projects in the orchestrator's projects folder: each folder with a PROJECT.md and a project record
 * (`record`, a JSON file) that isn't archived (`archived_at` set). Each shows in Projects with its Start lead button.
 * A folder without a record never shows, so a folder that only feeds memory stays out.
 */
export function liveProjects(root: string, record = PROJECT_RECORD): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(record)) return [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names.filter((n) => {
    if (!SLUG.test(n) || !existsSync(join(root, n, "PROJECT.md"))) return false;
    try {
      const rec = JSON.parse(readFileSync(join(root, n, record), "utf8")) as { archived_at?: unknown } | null;
      return rec !== null && typeof rec === "object" && !rec.archived_at;
    } catch {
      return false;
    }
  }).sort();
}

export type MemorySetup = { tools: string[]; instructions?: string; map?: { folder: string; project: string } };

/**
 * What an agent gets from the memory engine. Leads and threads of a known memory project: both tools, the pointer and
 * (when the thread has a folder) a worktree-map row so its sessions count for the project. A thread without a role gets
 * the same when its bb project is named after a memory project. Nothing for the CoS or the Steward, or with memory off.
 */
export function memorySetup(
  a: { role: string | null; project: string | null },
  bbProjectName: string,
  folder: string | null,
  local: MemoryLocal | null,
  projects: ReadonlyMap<string, string>,
  ownerName = "",
): MemorySetup {
  // Any thread whose bb project is a memory project, plus orchestrator leads and threads by their orchestrator project.
  // Never the CoS or the Steward.
  if (!local || a.role === "cos" || a.role === "steward") return { tools: [] };
  const byRole = a.role === "lead" || a.role === "thread" ? a.project : null;
  const slug = byRole ?? (SLUG.test(bbProjectName) && projects.has(bbProjectName) ? bbProjectName : null);
  if (!slug || !SLUG.test(slug) || !projects.has(slug)) return { tools: [] };
  const served: MemorySetup = { tools: [TOOL_SEARCH, TOOL_PAGE], instructions: memoryPointer(slug, local, projects.get(slug)!, ownerName) };
  return folder ? { ...served, map: { folder, project: slug } } : served;
}

/** The pointer in the agent's instructions. Every value in it is a checked slug or the config's own. */
export function memoryPointer(slug: string, local: MemoryLocal, projectFolder: string, ownerName = ""): string {
  const page = local.vault ? `\`${local.vault}/projects/${slug}.md\`` : `the vault's \`projects/${slug}.md\``;
  return [
    "## Memory",
    `Before you re-derive a past decision or a fact about this project, search memory: \`${TOOL_SEARCH}\` with ` +
      `\`project: "${slug}"\` (past sessions too with \`transcripts: true\`). A search stops after 45 s.`,
    `Read a hit, or this project's vault page, with \`${TOOL_PAGE}\` (\`ref: "${slug}"\`, or a hit's \`path:line\`). ` +
      `The page is ${page}: read it, never edit it. Only the memory publisher writes the vault.`,
    `Durable feedback, preferences and lessons for this project (what ${ownerWords(ownerName).name} corrected or confirmed, a rule to keep) go ` +
      `in this project's notes: one Markdown file per fact in \`${projectFolder}/memory/\`, named for the fact. Every ` +
      `thread of the project finds them there through \`${TOOL_SEARCH}\`, and dreams read them. Don't keep them in ` +
      `Claude's own auto-memory: it is per folder, so the next thread never sees it.`,
  ].join("\n");
}

export type SearchInput = { query: string; project?: string; transcripts?: boolean; limit?: number };

/** memory-search's arguments for a search; the query goes after `--`, so a query that looks like a flag is searched for. */
export function searchArgv(i: SearchInput): string[] {
  const query = i.query.trim();
  if (query.length === 0 || query.length > QUERY_MAX) throw new Error(`query: 1-${QUERY_MAX} characters`);
  const argv: string[] = [];
  if (i.project !== undefined) {
    if (!SLUG.test(i.project)) throw new Error(`project: not a project slug: ${JSON.stringify(i.project)}`);
    argv.push("--project", i.project);
  }
  if (i.transcripts === true) argv.push("--transcripts");
  const limit = i.limit ?? LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) throw new Error(`limit: 1-${LIMIT_MAX}`);
  argv.push("-n", String(limit), "--", query);
  return argv;
}

/** memory-search's arguments for a page: `--page=REF` keeps a reference starting with "-" a value. */
export function pageArgv(i: { ref: string; lines?: number }): string[] {
  const ref = i.ref.trim();
  if (ref.length === 0 || ref.length > REF_MAX || /[\0\n\r]/.test(ref)) throw new Error("ref: a slug or a path[:line]");
  const lines = i.lines ?? LINES_DEFAULT;
  if (!Number.isInteger(lines) || lines < 1 || lines > LINES_MAX) throw new Error(`lines: 1-${LINES_MAX}`);
  return [`--page=${ref}`, "--lines", String(lines)];
}

/** memory-search's arguments to record a thread folder's project in the worktree map. */
export function mapArgv(i: { folder: string; project: string }): string[] {
  if (!/^\/[^\0\n\r\t]*$/.test(i.folder) || i.folder.length > REF_MAX) throw new Error("folder: an absolute path");
  if (!SLUG.test(i.project)) throw new Error(`project: not a project slug: ${JSON.stringify(i.project)}`);
  return ["--map-worktree", i.folder, i.project];
}

/** --map-worktree's exits: 0 recorded; 3 refused for good; 4 mapped to another project already; else ask again. */
export function mapOutcome(exitCode: number): "recorded" | "refused" | "taken" | "retry" {
  return exitCode === 0 ? "recorded" : exitCode === 3 ? "refused" : exitCode === 4 ? "taken" : "retry";
}

/** One tool result from a memory-search run: its output, or its error with isError. */
export function toolResult(r: { exitCode: number; stdout: string; stderr: string }): { content: { type: "text"; text: string }[]; isError?: boolean } {
  const cap = (s: string) => (s.length <= OUTPUT_MAX ? s : `${s.slice(0, OUTPUT_MAX)}\n… (cut at ${OUTPUT_MAX} characters)`);
  if (r.exitCode === 0) return { content: [{ type: "text", text: cap(r.stdout.trimEnd() || "(no output)") }] };
  const why = (r.stderr.trim() || r.stdout.trim() || `memory-search exited ${r.exitCode}`).split("\n").slice(-20).join("\n");
  return { content: [{ type: "text", text: cap(why) }], isError: true };
}
