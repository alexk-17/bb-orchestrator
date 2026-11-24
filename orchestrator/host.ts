// The orchestrator's host entry: what runs on a machine itself, with that machine's own tools and files: the Cloud tab's
// reads and logins (cloud/host.ts), the Open PRs tab's read-only gh reads (open-prs/host.ts), and the review queue's
// reads and its one revalidated CodeRabbit request (review-queue/host.ts, 2026-11-18).
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import cloud from "./cloud/host.ts";
import { orchHostContract } from "./host-contract.ts";
import { gh, prHandlers } from "./open-prs/host.ts";
import { parseLogin, parseMerged, parseReleases, sinceGhArgs } from "./core/since.ts";
import { queueHandlers } from "./review-queue/host.ts";
import { mpHandlers } from "./multiplayer/host.ts";

// the work board's since lens (2026-11-23, core/since.ts): one repo's merges since a day, and its releases (a repo whose
// releases can't be listed still gives its merges); the login gh is signed in as
const sinceHandlers = {
  "board.repoActivity": async ({ repo, day }: { repo: string; day: string }) => ({
    merged: parseMerged(await gh(sinceGhArgs.merged(repo, day))),
    releases: await gh(sinceGhArgs.releases(repo)).then((r) => parseReleases(r, repo), () => []),
  }),
  "board.ghLogin": async () => {
    const login = parseLogin(await gh(sinceGhArgs.login(), true));
    if (!login) throw new Error("gh api user gave no login");
    return { login };
  },
};

export default experimental_defineHostEntry({ contract: orchHostContract, handlers: { ...cloud.handlers, ...prHandlers, ...queueHandlers, ...mpHandlers, ...sinceHandlers } });
