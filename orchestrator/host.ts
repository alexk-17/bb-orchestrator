// The orchestrator's host entry: what runs on a machine itself, with that machine's own tools and files: the Cloud tab's
// reads and logins (cloud/host.ts), the Open PRs tab's read-only gh reads (open-prs/host.ts), and the review queue's
// reads and its one revalidated CodeRabbit request (review-queue/host.ts, 2026-11-18).
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import cloud from "./cloud/host.ts";
import { orchHostContract } from "./host-contract.ts";
import { prHandlers } from "./open-prs/host.ts";
import { queueHandlers } from "./review-queue/host.ts";
import { mpHandlers } from "./multiplayer/host.ts";

export default experimental_defineHostEntry({ contract: orchHostContract, handlers: { ...cloud.handlers, ...prHandlers, ...queueHandlers, ...mpHandlers } });
