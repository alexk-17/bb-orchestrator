// The Open PRs host handlers: `gh api graphql` with a fixed query from core/open-prs.ts and validated variables. gh's
// errors leave with tokens redacted.
import { execFile } from "node:child_process";
import { OPEN_PRS_QUERY, PR_FILES_QUERY, REPO_AREA_QUERY, openPrsSearch, parseOpenPrsPage, parsePrFiles, parseRepoArea, recentMergedSearch, type RawPr } from "../core/open-prs.ts";
import { redact } from "../cloud/core/mask.ts";

const GH_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})/g;
const clean = (e: unknown) => new Error(redact((e instanceof Error ? e.message : String(e)).replace(GH_TOKEN, "[redacted]")));

/** One read-only GraphQL query through the machine's gh. `-f` passes strings, `-F` typed values (numbers). */
function graphql(query: string, strings: Record<string, string>, typed: Record<string, number> = {}, lists: Record<string, string[]> = {}): Promise<unknown> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(strings)) args.push("-f", `${k}=${v}`);
  for (const [k, v] of Object.entries(typed)) args.push("-F", `${k}=${v}`);
  for (const [k, values] of Object.entries(lists)) for (const v of values) args.push("-f", `${k}[]=${v}`);
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: 60_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } }, (err, stdout, stderr) => {
      if (err) return reject(clean(`gh: ${stderr?.trim() || err.message}`));
      try {
        const out = JSON.parse(stdout) as { data?: unknown; errors?: { message?: string }[] };
        if (!out.data && out.errors?.length) return reject(clean(`GitHub: ${out.errors.map((x) => x.message).join("; ")}`));
        resolve(out.data);
      } catch (e) {
        reject(clean(e));
      }
    });
  });
}

const split = (repo: string) => {
  const [owner, name] = repo.split("/");
  return { owner: owner!, name: name! };
};

export const prHandlers = {
  "prs.states": async ({ ids }: { ids: string[] }) => {
    const states: Record<string, "OPEN" | "CLOSED" | "MERGED"> = {};
    for (let at = 0; at < ids.length; at += 100) {
      const data = await graphql(`query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest { url state } } }`, {}, {}, { ids: ids.slice(at, at + 100) }) as { nodes?: ({ url?: string; state?: string } | null)[] };
      for (const pr of data?.nodes ?? []) {
        if (pr?.url && (pr.state === "OPEN" || pr.state === "CLOSED" || pr.state === "MERGED")) states[pr.url] = pr.state;
      }
    }
    return states;
  },
  "prs.open": async ({ login }: { login: string }) => {
    const prs: RawPr[] = [];
    let after: string | null = null;
    for (let page = 0; page < 5; page++) {
      const r = parseOpenPrsPage((await graphql(OPEN_PRS_QUERY, { q: openPrsSearch(login), ...(after ? { after } : {}) })) as never);
      prs.push(...r.prs);
      after = r.next;
      if (!after) return { prs, more: false };
    }
    return { prs, more: true };
  },
  "prs.files": async ({ repo, number }: { repo: string; number: number }) => parsePrFiles((await graphql(PR_FILES_QUERY, split(repo), { number })) as never),
  "prs.area": async ({ repo }: { repo: string }) => parseRepoArea((await graphql(REPO_AREA_QUERY, { ...split(repo), q: recentMergedSearch(repo) })) as never),
};
