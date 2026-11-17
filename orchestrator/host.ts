// The orchestrator's host entry: what runs on a machine itself, with that machine's own tools and files: the Cloud tab's
// reads and logins, read-only Open PR reads, and the Review queue's fixed, revalidated CodeRabbit trigger.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { queueHandlers } from "./review-queue/host.ts";
import cloud from "./cloud/host.ts";
import { orchHostContract } from "./host-contract.ts";
import { prHandlers } from "./open-prs/host.ts";

export default experimental_defineHostEntry({ contract: orchHostContract, handlers: { ...cloud.handlers, ...prHandlers, ...queueHandlers } });
