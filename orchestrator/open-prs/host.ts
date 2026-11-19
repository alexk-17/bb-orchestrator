// The Open PRs and PR-wait host handlers: plain read-only gh commands, each a fixed argument list from core/open-prs.ts
// (ghArgs) run with execFile, never a shell. gh's errors leave with tokens redacted.
//
// They run here, in the plugin's host entry on a connected machine, not in the server: gh and its login live on the
// machine (the owner's own `gh auth`, as bb's PR status uses), and the server has neither.
import { execFile } from "node:child_process";
import {
  CODEOWNERS_PATHS,
  OPEN_PRS_MAX,
  ghArgs,
  parsePrFiles,
  parsePrView,
  parseRepoArea,
  parseRequired,
  parseSearch,
  parseWaitReading,
  rawPr,
  type BbPrReading,
  type RawPr,
} from "../core/open-prs.ts";
import { redact } from "../cloud/core/mask.ts";

const GH_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})/g;
const clean = (e: unknown) => new Error(redact((e instanceof Error ? e.message : String(e)).replace(GH_TOKEN, "[redacted]")));

/** gh's answer when the thing isn't there (a CODEOWNERS place that has none). */
class NotFound extends Error {}

/** One read-only gh command: its stdout as JSON, or the raw text for a raw REST read. */
export function gh(args: string[], raw = false): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: 60_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (err, stdout, stderr) => {
      if (err) {
        const why = stderr?.trim() || err.message;
        return reject(/\bHTTP 404\b/.test(why) ? new NotFound(why) : clean(`gh: ${why}`));
      }
      if (raw) return resolve(stdout);
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(clean(e));
      }
    });
  });
}

/** `f` over `items`, at most `n` at a time, in order. */
async function pool<T, R>(items: readonly T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await f(items[i]!);
      }
    }),
  );
  return out;
}

/** CODEOWNERS from the first of its three places that has one. Only "not found" moves on; any other failure throws. */
async function codeowners(repo: string): Promise<string | null> {
  for (const path of CODEOWNERS_PATHS) {
    try {
      return String(await gh(ghArgs.codeowners(repo, path), true));
    } catch (e) {
      if (!(e instanceof NotFound)) throw e;
    }
  }
  return null;
}

export const prHandlers = {
  // the list from the search, then each PR's view (4 at a time), then each base branch's required approvals once
  "prs.open": async ({ login }: { login: string }): Promise<{ prs: RawPr[]; more: boolean }> => {
    const hits = parseSearch(await gh(ghArgs.openPrs(login)));
    const more = hits.length > OPEN_PRS_MAX;
    const shown = hits.slice(0, OPEN_PRS_MAX);
    const views = await pool(shown, 4, async (h) => parsePrView(await gh(ghArgs.view(h.url))));
    const required = new Map<string, Promise<number | null>>();
    const requiredOf = (repo: string, base: string | null) => {
      if (!base) return Promise.resolve(null);
      const k = `${repo}\n${base}`;
      // a failed rules read is no count, not a failed list: the count only refines "1 of 2 approvals"
      if (!required.has(k)) required.set(k, gh(ghArgs.rules(repo, base)).then(parseRequired, () => null));
      return required.get(k)!;
    };
    const prs = await Promise.all(shown.map(async (h, i) => rawPr(h, views[i]!, await requiredOf(h.repo, views[i]!.base))));
    return { prs, more };
  },
  "prs.files": async ({ url }: { url: string }) => parsePrFiles(await gh(ghArgs.files(url))),
  "prs.area": async ({ repo }: { repo: string }) => parseRepoArea(await codeowners(repo), await gh(ghArgs.merged(repo))),
  // one PR wait's own reading, by URL
  "prs.wait": async ({ url }: { url: string }): Promise<BbPrReading> => parseWaitReading(await gh(ghArgs.wait(url))),
  "prs.pathways": async ({ url }: { url: string }): Promise<BbPrReading> => {
    const data = await gh(ghArgs.pathwaysWait(url));
    const base = data && typeof data === "object" && "baseRefName" in data && typeof data.baseRefName === "string" ? data.baseRefName : null;
    const repo = new URL(url).pathname.split("/").slice(1, 3).join("/");
    const rules = base ? await gh(ghArgs.rules(repo, base)).catch(() => null) : null;
    return parseWaitReading(data, rules);
  },
};
