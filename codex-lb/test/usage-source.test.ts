// The pool's limits reach bb's Provider usage card only if that plugin discovers this source. It lists only RPC
// registrations marked discoverable whose input and output schemas convert to JSON Schema, so both are checked here,
// the conversion with zod's own converter as bb's publisher uses it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { rpcContract, rpcOptions } from "../server.ts";

test("usage source: registered discoverable, with a description", () => {
  assert.equal(rpcOptions.experimental_discoverable, true);
  assert.ok(rpcOptions.experimental_description.length > 0);
});

test("usage source: every input and output schema converts to JSON Schema", () => {
  for (const [method, contract] of Object.entries(rpcContract)) {
    for (const part of ["input", "output"] as const) {
      assert.doesNotThrow(() => z.toJSONSchema(contract[part] as z.ZodType), `${method} ${part}`);
    }
  }
});

test("usage source: outputs still accept the shapes the usage card reads", () => {
  const list = { label: "codex-lb", resources: [{ accountKey: null, id: "pool", providerId: "codex", label: "codex-lb pool", scope: { kind: "shared" } }] };
  assert.deepEqual(rpcContract["provider-usage.v1.listResources"].output.parse(list), list);
  const one = { accountKey: null, observedAt: 1, usage: { status: "unauthenticated", plan: null, accountEmail: null, planLabel: null } };
  assert.deepEqual(rpcContract["provider-usage.v1.getResource"].output.parse(one), one);
});
