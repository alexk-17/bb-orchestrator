// A pane's route and its URL (app/route.ts): a reload, a link and Back restore each place, and every old link still lands.
import assert from "node:assert/strict";
import { test } from "node:test";
import { canonical, fromPath, rootOf, toPath, type Route } from "../app/route.ts";

const VIEWS = [
  { id: "home", subPath: "" },
  { id: "chat", subPath: "chat" },
  { id: "projects", subPath: "projects" },
  { id: "multiplayer", subPath: "multiplayer" },
  { id: "board", subPath: "board" },
];
const there = (r: Route) => fromPath(toPath(r, VIEWS), VIEWS);

test("every place a pane can hold survives the URL and back", () => {
  const places: Route[] = [
    rootOf("home"),
    { view: "home", path: [], params: { filter: "needs" } },
    { view: "home", path: [], params: { filter: "alerts", item: "alarm:12" } },
    { view: "home", path: [], params: { item: "card:d-1" } },
    { view: "home", path: [], params: { filter: "delivered", files: "1" } },
    { view: "projects", path: ["ledger-sync"], params: {} },
    { view: "projects", path: ["kite"], params: { pathways: "1" } },
    { view: "projects", path: [], params: { scope: "kite/st-1a2b" } },
    { view: "projects", path: [], params: { open: "kite" } },
    { view: "multiplayer", path: ["b 1"], params: {} },
    rootOf("chat"),
  ];
  for (const r of places) assert.deepEqual(there(r), r, toPath(r, VIEWS));
});

test("Home on All with nothing open is the bare page; its filter and item are in the path", () => {
  assert.equal(toPath(rootOf("home"), VIEWS), "");
  assert.equal(toPath({ view: "home", path: [], params: { filter: "needs", item: "card:x" } }, VIEWS), "home/needs/card%3Ax");
  assert.equal(toPath({ view: "projects", path: ["kite"], params: {} }, VIEWS), "projects/kite");
  assert.equal(toPath({ view: "projects", path: [], params: { open: "kite" } }, VIEWS), "projects/@kite", "a project selected in the list, not its page");
});

test("old links land where they did: Needs you, Deliverables and Outputs are Home's filters; Scope, Pathways and Agents are Projects", () => {
  assert.deepEqual(fromPath("needs-you", VIEWS), { view: "home", path: [], params: { filter: "needs" } });
  assert.deepEqual(fromPath("deliverables", VIEWS), { view: "home", path: [], params: { filter: "delivered" } });
  assert.deepEqual(fromPath("outputs", VIEWS), { view: "home", path: [], params: { filter: "delivered", files: "1" } }, "Outputs opens on its Files filter");
  assert.deepEqual(fromPath("feed", VIEWS), rootOf("home"));
  assert.deepEqual(fromPath("scope/kite%2Fst-1", VIEWS), { view: "projects", path: [], params: { scope: "kite/st-1" } });
  assert.deepEqual(fromPath("pathways/kite", VIEWS), { view: "projects", path: ["kite"], params: { pathways: "1" } });
  assert.deepEqual(fromPath("agents", VIEWS), rootOf("projects"));
  assert.deepEqual(fromPath("no-such-page", VIEWS), rootOf("home"), "anything unknown is Home");
  assert.deepEqual(fromPath("projects/%E0%A4%A", VIEWS), rootOf("projects"), "a broken escape opens the list, not an error");
});

test("the URL bb hands back compares equal to the one we gave it, however often it was encoded", () => {
  // measured 2026-11-20: bb encodes our sub-path once more; "%3A" came back as "%253A" and read as a new link
  const ours = toPath({ view: "home", path: [], params: { item: "board:b-6b45" } }, VIEWS);
  assert.equal(canonical(ours, VIEWS), ours);
  assert.equal(canonical("home/all/board%253Ab-6b45", VIEWS), ours);
  assert.equal(canonical("home/all/board:b-6b45", VIEWS), ours);
  assert.equal(canonical("scope/kite%252Fst-1", VIEWS), "scope/kite%2Fst-1", "a scoping task's key keeps its slash");
});
