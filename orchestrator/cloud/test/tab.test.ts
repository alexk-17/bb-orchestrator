// Why: Cloud once vanished with no reason on a machine without a config; since 2026-11-20 it is a Tool the owner turns on, never machine-hidden.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudEmptyState } from "../core/setup.ts";

test("the Cloud tab is the owner's choice: listed, shown by the showCloud setting, never hidden by a machine check", () => {
  const src = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
  const server = readFileSync(new URL("../../server.ts", import.meta.url), "utf8");
  assert.match(src, /\{ id: "cloud", subPath: "cloud", label: "Cloud" \}/, "Cloud is one of the page's tabs");
  assert.match(server, /showCloud: \{ type: "boolean", label: "Tools: Cloud", default: false \}/, "off until the owner turns it on");
  assert.match(server, /cloud: cfg\.showCloud === true/);
  assert.doesNotMatch(src, /cs\.available[^\n]*filter|filter[^\n]*cs\.available/, "no tab is hidden by a machine check");
});

test("without a config file the Cloud tab says what to create and where", () => {
  const path = "/home/someone/.config/bb-cloud-switch/config.json";
  const s = cloudEmptyState({ state: "missing", path });
  assert.equal(s.title, "No cloud config on this machine");
  assert.ok(s.text.includes(path), "names the path it looked for");
  assert.match(s.text, /Cloud tab config file/, "names the setting that moves it");
  assert.match(s.text, /config\.example\.json/, "points at the example to copy");
  assert.match(s.text, /cloud\/README\.md/, "points at the README");
  assert.match(s.text, /aws CLI v2|gcloud/, "says what else the machine needs");
});

test("no machine or a failed check is not reported as a missing config", () => {
  assert.equal(cloudEmptyState({ state: "no-machine", path: null }).title, "No connected machine");
  assert.equal(cloudEmptyState({ state: "error", path: null }).title, "Couldn't check this machine");
});
