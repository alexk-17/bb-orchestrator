// The orchestrator's host methods (host.ts runs them on a machine; the server calls them): the Cloud tab's, the Open
// PRs tab's, the review queue's (2026-11-18) and the Multiplayer tab's, in one contract.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { cloudHostDefs } from "./cloud/host-contract.ts";
import { prHostDefs } from "./open-prs/host-contract.ts";
import { queueHostDefs } from "./review-queue/host-contract.ts";
import { mpHostDefs } from "./multiplayer/host-contract.ts";

export const orchHostContract = defineRpcContract({ ...cloudHostDefs, ...prHostDefs, ...queueHostDefs, ...mpHostDefs });
