// The Chat tab's composer keeps the transcript's column (2026-11-17, the owner: "can you fix the chat input bar it
// shouldn't be spread across the whole screen should follow same margins as the chat"). In a plugin pane bb-app 0.49.0's
// ThreadChat caps the transcript at 760px but leaves the composer the pane's full width, so the plugin caps the
// composer's wrapper the same way. This reads the sources, so the rule going, losing its Chat-pane scope or growing a
// fixed width fails here, before a screenshot would catch it; the bad lines are the fixtures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

/** The CSS rules (one per line) that reach bb's composer through its own hooks */
const composerRules = (s: string) => s.split("\n").filter((l) => /\[data-(scroll-footer|app-composer)\][^{]*\{/.test(l) && !/^\s*(\/\/|\/\*|\*)/.test(l));
/** Only the Chat pane's composer: another tab's chat (the lead's, Scope and Projects) has a composer of the plugin's own */
const SCOPED = /^\[data-orch\] \[data-pane-view="chat"\] \[data-scroll-footer\] /;
/** bb's own measure, centred, and nothing else: no width or offset that would fight bb if it centres the composer itself */
const DECLS = /\{ max-width: 760px; margin-inline: auto; \}$/;

test("bb's composer on the Chat tab is capped at the transcript's 760px column and centred", () => {
  const rules = composerRules(src("app/panes.tsx"));
  assert.equal(rules.length, 1, "one rule reaches bb's composer"); // a check that reads nothing must not pass
  assert.match(rules[0]!, SCOPED, "the rule is scoped to the Chat pane's composer footer");
  assert.match(rules[0]!, /:has\(> \[data-app-composer\]\)/, "it caps the composer's own wrapper, which has the column's gutter");
  assert.match(rules[0]!, DECLS);
  // the lines that would spread it again, or break other tabs: unscoped, or a fixed width
  assert.doesNotMatch('[data-orch] [data-scroll-footer] :has(> [data-app-composer]) { max-width: 760px; margin-inline: auto; }', SCOPED);
  assert.doesNotMatch("{ width: 760px; margin-inline: auto; }", DECLS);
});

// The owner (2026-11-20) on the "You and the CoS" sub-view: it showed their messages but not the CoS's answers, because it
// drew only replies made with the reply tool and the CoS mostly answers in its chat. A conversation with one side is a bug,
// and a nested tab was its own complaint. So the Chat tab is bb's own chat with the CoS (both sides, its own input) and
// nothing else: no sub-tabs, no filtered log.
test("the Chat tab is bb's own chat with the CoS, both sides, with no filtered sub-view", () => {
  const app = src("app.tsx");
  assert.match(app, /case "chat":\s*return <CosChat [^>]*width=\{width\}/);
  const chat = src("app/cos-chat.tsx");
  assert.match(chat, /<ThreadChat threadId=\{cos\.threadId\} variant=\{width >= 720 \? "full" : "compact"\}/, "bb's chat with its composer");
  assert.doesNotMatch(chat, /role="tablist"|data-chat-tab/, "no sub-tabs");
  assert.doesNotMatch(chat, /method: "cosLine"/, "no tracked-only log: it drops the CoS's chat answers");
  assert.doesNotMatch(chat, /<CosComposer /, "one input: bb's own");
  // no other source reaches into bb's composer
  for (const f of ["app.tsx", "app/direct-line.tsx", "app/scope.tsx", "app/projects.tsx", "app/cos-chat.tsx"]) assert.deepEqual(composerRules(src(f)), [], f);
});
