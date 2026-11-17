// Why it matters: the Cloud tab used to vanish on any machine without a cloud config, so a new install showed no Cloud
// tab and nothing said why (2026-11-16). The tab is now always listed, like Game Boy, and without a config it says what
// to set up: the exact path it looked for, the setting that moves it, the example file and the README.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cloudEmptyState } from "../core/setup.ts";

test("a default install lists the Cloud tab: the orchestrator page never filters it out", () => {
  const src = readFileSync(new URL("../../app.tsx", import.meta.url), "utf8");
  assert.match(src, /\{ id: "cloud", subPath: "cloud", label: "Cloud" \}/, "Cloud is one of the page's tabs");
  // 2026-11-17: the only filter is the owner's hiddenTabs setting, and it is empty by default
  assert.match(src, /VIEWS\.filter\(\(v\) => !isHidden\(v\)\)/, "tabs are hidden only by the owner's choice");
  assert.match(src, /const isHidden = .*=> hiddenTabs\.has\(v\.id\) \|\| hiddenTabs\.has\(v\.label\.toLowerCase\(\)\);/, "nothing but hiddenTabs decides");
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
