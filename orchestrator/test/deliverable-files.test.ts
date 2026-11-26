// A deliverable keeps its own files: one folder, its files sorted into images, videos and artifacts, with a README to
// open first. Filing copies the proof into that folder and shows the copy, so the proof outlives the thread worktree bb
// removes after archiving; a revision adds only what is new, big files stay references, and a backfill files older
// deliverables once.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { Engine, type DeliverResult, type ProofInput } from "../core/engine.ts";
import { FOLDER_FILES, touches } from "../change-notice.ts";
import { fileKind, folderFor, keepFile, readmeText, slugOf } from "../core/deliverable-files.ts";
import type { Deliverable } from "../core/model.ts";

// No /tmp: a scratch folder beside the tests (.scratch/ is git-ignored), removed afterwards.
const scratchRoot = join(import.meta.dirname, ".scratch");
mkdirSync(scratchRoot, { recursive: true });
const scratch = realpathSync(mkdtempSync(join(scratchRoot, "deliverable-files-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
/** A fresh lead worktree with its own files, so a test may delete them. */
function worktree(at?: string) {
  const env = at ?? join(scratch, `env-${++n}`);
  const file = (rel: string, body: string | Buffer = `${rel} ${n}`) => {
    const p = join(env, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
    return p;
  };
  return { env, file };
}

function setup(opts: { files?: boolean; maxBytes?: number; env?: string } = {}) {
  let clock = Date.parse("2026-11-17T18:00:00Z");
  const state = join(scratch, `state-${++n}`);
  let filesOn = opts.files ?? true;
  const changes: (readonly string[] | null)[] = [];
  const db = new DatabaseSync(":memory:");
  const e = new Engine(db as never, {
    now: () => clock,
    deliver: async (): Promise<DeliverResult> => ({ delivery: "sent" }),
    mirror: () => {},
    changed: (t?: readonly string[]) => void changes.push(t ?? null),
    log: () => {},
    files: () => (filesOn ? { dir: join(state, "deliverables"), kept: join(state, "threads"), ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}) } : null),
  });
  const lead = e.register("T-la", "lead", "alpha");
  const thread = e.register("T-w1", "thread", "alpha", "T-la");
  const w = worktree(opts.env);
  const place = { roots: [{ path: w.env, hostId: "host-1" }] };
  const deliver = (proof: ProofInput[], extra: { revises?: string; title?: string; points?: { kind: "decision" | "finding"; headline: string; why: string }[] } = {}) =>
    e.deliver(lead, { title: extra.title ?? "Checkout redesign", summary: "Shipped the new flow.", proof, revises: extra.revises ?? null, ...(extra.points ? { points: extra.points } : {}) }, place);
  return { e, db, lead, thread, w, place, state, deliver, changes, filesOn: (v: boolean) => (filesOn = v), advance: (ms: number) => (clock += ms) };
}

const under = (folder: string, kind: string) => (existsSync(join(folder, kind)) ? readdirSync(join(folder, kind)).sort() : []);

test("files sort into images, videos and artifacts by extension: markdown, text, html, pdf and json are artifacts", () => {
  for (const f of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.avif", "g.svg"]) assert.equal(fileKind(f), "images", f);
  for (const f of ["a.mp4", "b.webm", "c.MOV", "d.m4v"]) assert.equal(fileKind(f), "videos", f);
  for (const f of ["report.md", "out.txt", "page.html", "spec.pdf", "data.json", "run.log", "noext"]) assert.equal(fileKind(f), "artifacts", f);

  const s = setup();
  const d = s.deliver([
    { kind: "image", caption: "after", path: s.w.file("shots/after.png") },
    { kind: "video", caption: "walkthrough", path: s.w.file("shots/demo.webm") },
    { kind: "text", caption: "tests", path: s.w.file("out/test.txt") },
    { kind: "doc", caption: "plan", path: s.w.file("plan.md") },
  ]);
  assert.deepEqual(under(d.folder!, "images"), ["after.png"]);
  assert.deepEqual(under(d.folder!, "videos"), ["demo.webm"]);
  assert.deepEqual(under(d.folder!, "artifacts"), ["plan.md", "test.txt"]);
});

test("filing copies each proof file into the deliverable's own folder: the copy is shown, the original kept as provenance", () => {
  const s = setup();
  const shot = s.w.file("shots/after.png");
  const d = s.deliver([
    { kind: "image", caption: "after", path: shot },
    { kind: "pr", caption: "the PR", url: "https://github.com/o/r/pull/7" },
  ]);
  assert.equal(d.folder, realpathSync(folderFor(join(s.state, "deliverables"), d)));
  assert.match(d.folder!, /\/deliverables\/alpha\/2026-11-17-checkout-redesign-v-[0-9a-f]+$/, "<project>/<day>-<title slug>-<id>");
  const [img, pr] = d.revisions[0]!.proof;
  assert.equal(img!.path, join(d.folder!, "images", "after.png"), "the copy is what the page shows and opens");
  assert.equal(img!.source, shot, "the original path stays on the proof");
  assert.equal(img!.stored, "copied");
  assert.equal(readFileSync(img!.path!, "utf8"), readFileSync(shot, "utf8"));
  assert.equal(pr!.path, null, "a link isn't copied");
  assert.equal(pr!.stored, undefined);
  assert.equal(s.e.deliverable(d.id)!.revisions[0]!.proof[0]!.path, img!.path, "the copy is what is stored");
  assert.ok(existsSync(join(d.folder!, "README.md")));
  assert.equal(slugOf("../../etc"), "etc", "a title can't climb out of the folder");
  assert.equal(slugOf("   "), "untitled");
});

test("a revision adds its new files and reuses unchanged ones; a changed file with the same name never overwrites the first", () => {
  const s = setup();
  const shot = s.w.file("shots/after.png", "one");
  const log = s.w.file("out/run.log", "pass");
  const d1 = s.deliver([
    { kind: "image", caption: "after", path: shot },
    { kind: "text", caption: "run", path: log },
  ]);
  s.e.personRequestChanges(d1.id, 1, "show the error state too");
  const other = s.w.file("other/after.png", "two"); // same name, other bytes
  const d2 = s.deliver(
    [
      { kind: "image", caption: "after", path: shot }, // unchanged
      { kind: "image", caption: "error state", path: other },
      { kind: "text", caption: "run", path: log }, // unchanged
    ],
    { revises: d1.id },
  );
  assert.equal(d2.folder, d1.folder, "one folder for every revision");
  assert.deepEqual(under(d2.folder!, "images"), ["after-2.png", "after.png"], "nothing duplicated, nothing overwritten");
  assert.deepEqual(under(d2.folder!, "artifacts"), ["run.log"]);
  const [a, b, c] = d2.revisions[1]!.proof;
  assert.equal(a!.path, d1.revisions[0]!.proof[0]!.path, "the unchanged screenshot is the first revision's copy");
  assert.equal(readFileSync(b!.path!, "utf8"), "two");
  assert.equal(readFileSync(d1.revisions[0]!.proof[0]!.path!, "utf8"), "one", "rev 1's copy is still rev 1's file");
  assert.equal(c!.path, d1.revisions[0]!.proof[1]!.path);
});

test("proof survives its original's deletion (the worktree bb removed); with the copy gone, the original still serves", () => {
  const s = setup();
  const shot = s.w.file("shots/after.png", "the bytes");
  const d = s.deliver([{ kind: "image", caption: "after", path: shot }]);
  const p = d.revisions[0]!.proof[0]!;
  rmSync(s.w.env, { recursive: true, force: true }); // bb removed the thread's worktree
  const served = s.e.proofFile(p.id);
  assert.deepEqual(served, { path: p.path, contentType: "image/png", maxBytes: null });
  assert.equal(readFileSync(served.path, "utf8"), "the bytes");

  const t = setup();
  const kept = t.w.file("shots/kept.png");
  const p2 = t.deliver([{ kind: "image", caption: "kept", path: kept }]).revisions[0]!.proof[0]!;
  unlinkSync(p2.path!); // the copy is gone (a cleared state folder)
  assert.equal(t.e.proofFile(p2.id).path, kept, "it falls back to the original path");
  unlinkSync(kept);
  assert.throws(() => t.e.proofFile(p2.id), /is gone/, "both gone: not found, as before");
});

test("over the size cap a file stays a reference, served from where it is and named in the README", () => {
  const s = setup({ maxBytes: 10 });
  const big = s.w.file("out/huge.mp4", Buffer.alloc(11, 1));
  const small = s.w.file("out/ok.png", Buffer.alloc(10, 1));
  const d = s.deliver([
    { kind: "video", caption: "long demo", path: big },
    { kind: "image", caption: "small", path: small },
  ]);
  const [v, i] = d.revisions[0]!.proof;
  assert.equal(v!.stored, "too_big");
  assert.equal(v!.path, big, "not copied: the proof keeps the original");
  assert.equal(v!.bytes, 11);
  assert.deepEqual(under(d.folder!, "videos"), []);
  assert.equal(i!.stored, "copied", "a file at the cap is copied");
  assert.equal(s.e.proofFile(v!.id).path, big);
  assert.match(readFileSync(join(d.folder!, "README.md"), "utf8"), /## Kept as a reference\n\n- long demo \(rev 1, 11 B, over the 200\.0 MB copy cap\): .*huge\.mp4/);
});

test("the README is the one file to open: title, summary, points, state, its files by kind with links, links, what's missing", () => {
  const s = setup();
  const d = s.deliver(
    [
      { kind: "image", caption: "the new checkout", path: s.w.file("shots/after.png") },
      { kind: "doc", caption: "the plan", path: s.w.file("docs/plan.md") },
      { kind: "pr", caption: "the PR", url: "https://github.com/o/r/pull/7" },
    ],
    { points: [{ kind: "decision", headline: "Checkout is one page", why: "fewer drop-offs" }, { kind: "finding", headline: "Tests cover the error state", why: "it broke twice" }] },
  );
  const text = () => readFileSync(join(d.folder!, "README.md"), "utf8");
  const r = text();
  assert.match(r, /^# Checkout redesign\n\nShipped the new flow\.\n/);
  assert.match(r, /- State: in review\n- Project: alpha\n- Lead: lead:alpha\n/);
  assert.match(r, /## Points\n\n- \*\*Checkout is one page\*\*: fewer drop-offs\n- \*\*Tests cover the error state\*\*: it broke twice\n/);
  assert.match(r, /## Images\n\n- \[the new checkout\]\(<images\/after\.png>\) after\.png, \d+ B\n/);
  assert.match(r, /## Artifacts\n\n- \[the plan\]\(<artifacts\/plan\.md>\) plan\.md, \d+ B\n/);
  assert.match(r, /## Links\n\n- \[the PR\]\(https:\/\/github\.com\/o\/r\/pull\/7\)\n/);
  assert.doesNotMatch(r, /## Missing/);
  s.e.personApprove(d.id, 1, "ship it");
  assert.match(text(), /- State: approved: ship it\n/, "the README follows the state");
  const gone = structuredClone(d) as Deliverable;
  gone.revisions[0]!.proof.push({ id: "p-x", kind: "image", caption: "old shot", path: "/gone/worktree/a.png", url: null, hostId: null, stored: "missing" });
  assert.match(readmeText(gone, d.folder!), /## Missing\n\n.*can't be recovered\.\n\n- old shot \(rev 1\): \/gone\/worktree\/a\.png\n/);
});

test("the backfill files earlier deliverables once: survivors copied, missing ones recorded, nothing re-sorted as new", () => {
  const s = setup({ files: false }); // filed before deliverables kept their files
  const shot = s.w.file("shots/a.png");
  const gone = s.w.file("shots/gone.png");
  const d = s.deliver([
    { kind: "image", caption: "survivor", path: shot },
    { kind: "image", caption: "lost", path: gone },
    { kind: "link", caption: "doc", url: "https://example.com/doc" },
  ]);
  const links = s.deliver([{ kind: "link", caption: "only a link", url: "https://example.com/x" }], { title: "Links only" });
  assert.equal(d.folder, undefined);
  unlinkSync(gone); // its worktree went
  const updated = (id: string) => (s.db.prepare(`SELECT updated_at FROM deliverables WHERE id = ?`).get(id) as { updated_at: number }).updated_at;
  const before = updated(d.id);
  const board = s.e.board().length;
  s.advance(60_000);
  s.filesOn(true);

  const first = s.e.backfillFiles();
  assert.equal(first.deliverables, 2, "every deliverable gets its folder, a links-only one too");
  assert.equal(first.copied, 1);
  assert.deepEqual(first.missing, [{ id: d.id, title: d.title, path: gone }]);
  const got = s.e.deliverable(d.id)!;
  const [a, b] = got.revisions[0]!.proof;
  assert.equal(a!.source, shot);
  assert.ok(a!.path!.startsWith(got.folder! + sep));
  assert.equal(b!.stored, "missing");
  assert.match(readFileSync(join(got.folder!, "README.md"), "utf8"), /## Missing\n[\s\S]*- lost \(rev 1\): .*gone\.png/);
  assert.ok(existsSync(join(s.e.deliverable(links.id)!.folder!, "README.md")));
  assert.equal(updated(d.id), before, "not activity: the list order stays");
  assert.equal(s.e.board().length, board, "and nothing on the Board");

  const listing = readdirSync(got.folder!, { recursive: true }).sort();
  const json = JSON.stringify(s.e.deliverables());
  const second = s.e.backfillFiles();
  assert.deepEqual(second, { deliverables: 0, copied: 0, reused: 0, tooBig: 0, failed: 0, missing: [] }, "a second run does nothing");
  assert.deepEqual(readdirSync(got.folder!, { recursive: true }).sort(), listing, "no copies of copies");
  assert.equal(JSON.stringify(s.e.deliverables()), json);
});

test("a resolving thread's notes go to the newest deliverable that shows its work, not one of another thread", () => {
  const s = setup();
  const theirs = worktree();
  const place = { roots: [...s.place.roots, { path: theirs.env, hostId: "host-1" }] };
  const own = s.e.deliver(s.lead, { title: "Lead's own", summary: "s", proof: [{ kind: "image", caption: "c", path: s.w.file("a.png") }] }, place);
  s.advance(1000);
  const shows = s.e.deliver(s.lead, { title: "Thread's work", summary: "s", proof: [{ kind: "text", caption: "c", path: theirs.file("out/t.txt") }] }, place);
  s.advance(1000);
  s.e.deliver(s.lead, { title: "Later, unrelated", summary: "s", proof: [{ kind: "image", caption: "c", path: s.w.file("b.png") }] }, place);
  assert.equal(s.e.deliverableForThread(s.thread.threadId, theirs.env)?.id, shows.id, "matched by its proof's original path in the worktree");
  assert.equal(s.e.deliverableForThread("T-none", theirs.env), null, "an unknown thread has none");
  const k = s.e.keepInDeliverable(shows.id, theirs.file("report.md", "# done"));
  assert.equal(k.stored === "copied" && k.path, join(shows.folder!, "artifacts", "report.md"));
  assert.match(readFileSync(join(shows.folder!, "README.md"), "utf8"), /\[report\.md\]\(<artifacts\/report\.md>\)/, "the README lists it");
  assert.equal(own.folder !== shows.folder, true);
});

test("a thread's file kept in a deliverable's folder is named in the change notice, so an open Delivered lists it", () => {
  const s = setup();
  const theirs = worktree();
  const d = s.e.deliver(s.lead, { title: "Thread's work", summary: "s", proof: [{ kind: "text", caption: "c", path: theirs.file("out/t.txt") }] }, { roots: [...s.place.roots, { path: theirs.env, hostId: "host-1" }] });
  s.changes.length = 0;
  s.e.keepInDeliverable(d.id, theirs.file("handoff.md", "# handoff"));
  assert.deepEqual(s.changes, [[FOLDER_FILES]], "no table names a file on disk");
  assert.ok(touches({ tables: [FOLDER_FILES] }, "deliverableFolders"));
  assert.ok(!touches({ tables: [FOLDER_FILES] }, "deliverables"), "only the file list reads it again");
});

test("keepFile never throws: a missing source is reported, not copied", () => {
  const folder = join(scratch, "kf");
  assert.deepEqual(keepFile(folder, join(scratch, "nope.png")), { stored: "missing" });
  assert.ok(statSync(scratch).isDirectory());
});

test("the backfill refuses an original since swapped for a symlink, as the proof route does: it is not copied in", () => {
  const s = setup({ files: false });
  const shot = s.w.file("shots/a.png", "registered");
  const d = s.deliver([{ kind: "image", caption: "c", path: shot }]);
  const secret = s.w.file("../secret-elsewhere.txt", "not proof");
  unlinkSync(shot);
  symlinkSync(secret, shot);
  s.filesOn(true);
  s.e.backfillFiles();
  const p = s.e.deliverable(d.id)!.revisions[0]!.proof[0]!;
  assert.equal(p.stored, "missing");
  assert.deepEqual(under(s.e.deliverable(d.id)!.folder!, "images"), [], "the link's target never lands in the folder");
  assert.throws(() => s.e.proofFile(p.id), /no longer the one registered/);
});

test("a proof gone from its worktree that the archive kept as a thread output is recovered from that copy", () => {
  const env = join(scratch, "host-data", "worktrees", "thr_abc123-1", "repo");
  const s = setup({ files: false, env });
  const shot = s.w.file("qa/evidence/after.png", "the shot");
  const lost = s.w.file("qa/evidence/never-kept.png", "gone for good");
  const d = s.deliver([
    { kind: "image", caption: "after", path: shot },
    { kind: "image", caption: "lost", path: lost },
  ]);
  // the archive kept it at <state>/threads/<thread id>/outputs/<path in the worktree>, then bb removed the worktree
  const kept = join(s.state, "threads", "thr_abc123", "outputs", "qa", "evidence", "after.png");
  mkdirSync(join(kept, ".."), { recursive: true });
  writeFileSync(kept, "the shot");
  rmSync(env, { recursive: true, force: true });
  s.filesOn(true);
  const r = s.e.backfillFiles();
  assert.equal(r.copied, 1);
  assert.deepEqual(r.missing.map((m) => m.path), [lost], "only what was never kept is missing");
  const [a] = s.e.deliverable(d.id)!.revisions[0]!.proof;
  assert.equal(a!.source, shot, "the source stays the path the lead filed");
  assert.equal(readFileSync(s.e.proofFile(a!.id).path, "utf8"), "the shot");
});

test("a resolving thread's archive keeps every output inside its worktree, whoever recorded it, and its own elsewhere", () => {
  const s = setup();
  const theirs = worktree();
  const outsidePlace = worktree();
  const other = s.e.register("T-w2", "thread", "alpha", "T-la");
  const placeOut = { roots: [theirs.env, outsidePlace.env], hostId: "host-1" };
  const byLead = s.e.addOutput(s.lead, { title: "lead's", kind: "doc", path: theirs.file("lead.md") }, placeOut).output;
  const own = s.e.addOutput(s.thread, { title: "own", kind: "doc", path: outsidePlace.file("own.md") }, placeOut).output;
  const others = s.e.addOutput(other, { title: "other", kind: "doc", path: outsidePlace.file("other.md") }, placeOut).output;
  const ids = s.e.threadOutputs(s.thread.threadId, theirs.env).map((o) => o.id).sort();
  assert.deepEqual(ids, [byLead.id, own.id].sort(), "the lead's output in the worktree goes too; another thread's elsewhere doesn't");
  assert.ok(!ids.includes(others.id));
});

test("the page lists each deliverable's folder by kind, with the host its copies live on; a folder gone is left out", () => {
  const s = setup();
  const d = s.deliver([
    { kind: "image", caption: "after", path: s.w.file("shots/after.png") },
    { kind: "doc", caption: "plan", path: s.w.file("plan.md") },
  ]);
  const gone = s.deliver([{ kind: "image", caption: "x", path: s.w.file("shots/x.png") }], { title: "Gone later" });
  rmSync(gone.folder!, { recursive: true });
  const { hostId, folders } = s.e.deliverableFolders();
  assert.equal(hostId, "host-1", "folder files open on the host the copies were made on");
  assert.deepEqual(Object.keys(folders), [d.id], "a removed folder lists nothing rather than failing the page");
  const f = folders[d.id]!;
  assert.equal(f.readme, join(d.folder!, "README.md"));
  assert.deepEqual(f.files.map((x) => [x.kind, x.name]), [["images", "after.png"], ["artifacts", "plan.md"]]);
  assert.ok(f.files.every((x) => x.bytes > 0 && !x.dir && x.path.startsWith(d.folder! + sep)));
});
