// The orchestrator's host methods (host.ts runs them on a machine; the server calls them): the Cloud tab's and the Open
// PRs tab's and Review queue's, in one contract.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { cloudHostDefs } from "./cloud/host-contract.ts";
import { queueHostDefs } from "./review-queue/host-contract.ts";
import { prHostDefs } from "./open-prs/host-contract.ts";

export const orchHostContract = defineRpcContract({ ...cloudHostDefs, ...prHostDefs, ...queueHostDefs });
