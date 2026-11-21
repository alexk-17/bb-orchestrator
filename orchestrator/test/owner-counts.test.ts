// The owner, 2026-11-21: "mine says 6 on the plugin on the side (the far-left sidebar) but when i click into the app,
// 'needs you' 'delivered' or anything doesn't say anything." The rail badge and the page counted separately: the rail
// added Scope's cards, the page drew Scope's cards plus its scoping deliverables on Projects, and the phone bar drew no
// Projects count at all. Now one function makes the parts and the rail draws their sum, so the counts in the page
// always add up to the rail's number, and the rail's words say where the items are.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ownerCounts, ownerCountsLabel } from "../app/kit.ts";

const d = (id: string, over: Record<string, unknown>) => ({ id, project: "example", state: "review", scope: false, board: null, updatedAt: 1, ...over });
const scope = (badge: number, slugs: string[]) => ({ badge, projects: slugs.map((slug) => ({ slug })) });

test("the parts add up to the total, and each item is in exactly one part", () => {
  const all = [
    d("a", {}),
    d("b", {}),
    d("c", { scope: true, project: "scoping-one" }), // a scoping deliverable: Scope's, not Delivered's
    d("e", { board: "mb-1" }), // a board's review lives on Multiplayer: in neither
    d("f", { state: "approved" }), // decided: in neither
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = ownerCounts({ badge: 2 }, all as any, scope(1, ["scoping-one"]) as any);
  assert.deepEqual(c, { needs: 2, delivered: 2, scope: 2, total: 6 });
  assert.equal(c.needs + c.delivered + c.scope, c.total);
});

test("the owner's repro: 0 waiting, 5 in review, 1 scope card makes 6, and the page shows 5 and 1", () => {
  const all = ["1", "2", "3", "4", "5"].map((id) => d(id, {}));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = ownerCounts({ badge: 0 }, all as any, scope(1, ["harness"]) as any);
  assert.deepEqual(c, { needs: 0, delivered: 5, scope: 1, total: 6 });
  assert.equal(ownerCountsLabel(c), "5 in Delivered, 1 in Projects (Scope)", "the rail's words name where the 6 are");
});

test("the rail badge, the Sidebar and the phone bar all read ownerCounts", () => {
  const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
  const badge = app.slice(app.indexOf("function useOrchestratorBadge("), app.indexOf("const LAYOUT_KEY ="));
  assert.match(badge, /const c = ownerCounts\(q\.data, dq\.data, sq\.data\);/);
  assert.match(badge, /count: c\.total, label: ownerCountsLabel\(c\)/);
  assert.match(app, /const owner = ownerCounts\(needs\.data, deliverables\.data, scope\.data\);/);
  assert.match(app, /counts=\{\{ needs: owner\.needs, delivered: owner\.delivered, projects: owner\.scope \}\}/);
  assert.match(readFileSync(new URL("../app/page-nav.tsx", import.meta.url), "utf8"), /count: counts\.projects, active: place === "projects"/, "the phone's Projects shows Scope's count");
});
