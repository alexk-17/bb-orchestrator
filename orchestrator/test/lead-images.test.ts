// Screenshots in the chat with a lead (2026-11-17, the owner: "in the projects tab the chat with lead input needs to be
// able to take in images i can copy-paste from screenshots and the same thing applies to the scoping input"). The lead
// must get real images it can open, and the message must stay the owner's tracked direct message: the lead acks it, the
// CoS gets a copy that says images came, the log shows them. Each test is one rule; each fails if its rule goes.
// The server tests load the real server entry against a fake bb host, so the routes and the delivery run for real.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import plugin from "../server.ts";
import { Engine, type DeliverResult } from "../core/engine.ts";
import type { Item } from "../core/model.ts";
import { MAX_IMAGE_BYTES, MAX_IMAGES, WRITES, cosMessageBody, directImageBody, directMessageBody } from "../contract.ts";
import { imagesNote, safeName, sniff, withImages, wordsOf } from "../core/direct-images.ts";
import { admit, canSend, imageFiles } from "../app/lead-images.ts";
import { directWrite, imageWrite } from "../app/lead-chat.ts";
import { chatPreview } from "../app/command-center.ts";

const SCRATCH = join(import.meta.dirname, "..", ".scratch-test");
mkdirSync(SCRATCH, { recursive: true });
const roots: string[] = [];
const scratch = (name: string) => {
  const d = mkdtempSync(join(SCRATCH, `${name}-`));
  roots.push(d);
  return d;
};
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// the smallest real files of each type: their signatures are what the server checks, not the type the page claims
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const MB = 1024 * 1024;

// ---------------------------------------------------------------- the composer's rules (app/lead-images.ts)

test("only png, jpeg, gif and webp are taken; anything else is refused with its name", () => {
  const ok = ["image/png", "image/jpeg", "image/gif", "image/webp"].map((type, i) => ({ name: `s${i}`, type, size: 10 }));
  assert.deepEqual(admit(0, ok), { take: [0, 1, 2, 3], refused: null });
  for (const type of ["image/svg+xml", "image/bmp", "image/tiff", "text/plain", "application/pdf", ""]) {
    const r = admit(0, [{ name: "x.file", type, size: 10 }]);
    assert.deepEqual(r.take, [], type);
    assert.match(r.refused ?? "", /x\.file isn't a png, jpeg, gif or webp image/, type);
  }
  // the picker offers the same four
  assert.deepEqual(directImageBody.shape.mime.options, ["image/png", "image/jpeg", "image/gif", "image/webp"]);
});

test("an image over 10 MB is refused, one at the cap is taken", () => {
  assert.equal(MAX_IMAGE_BYTES, 10 * MB);
  assert.deepEqual(admit(0, [{ name: "big.png", type: "image/png", size: 10 * MB }]).take, [0]);
  const r = admit(0, [{ name: "huge.png", type: "image/png", size: 10 * MB + 1 }]);
  assert.deepEqual(r.take, []);
  assert.match(r.refused ?? "", /huge\.png is over 10 MB/);
});

test("at most 6 images a message: the ones past it are refused, counting those already attached", () => {
  assert.equal(MAX_IMAGES, 6);
  const f = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `p${i}.png`, type: "image/png", size: 1 }));
  assert.deepEqual(admit(0, f(6)), { take: [0, 1, 2, 3, 4, 5], refused: null });
  const r = admit(4, f(3));
  assert.deepEqual(r.take, [0, 1], "4 attached: 2 more fit");
  assert.match(r.refused ?? "", /p2\.png is past the 6 images a message takes/);
  // several refusals: the first, and how many more
  assert.match(admit(6, f(3)).refused ?? "", /p0\.png .*, and 2 more not added\./);
  // and the server holds the same cap whatever the page sends
  assert.equal(directMessageBody.safeParse({ slug: "a", text: "x", images: Array.from({ length: 7 }, (_, i) => `img-${i}`) }).success, false);
});

test("a paste with no image in it stays the text box's own; a send needs words or an image", () => {
  assert.deepEqual(imageFiles([{ name: "", type: "text/plain", size: 3 }]), [], "text pasted is not intercepted");
  assert.equal(imageFiles([{ name: "image.png", type: "image/png", size: 3 }, { name: "", type: "text/html", size: 3 }]).length, 1);
  assert.equal(canSend("  ", 0), false);
  assert.equal(canSend("", 1), true, "a bare screenshot is a message");
  assert.equal(directMessageBody.safeParse({ slug: "a", text: " " }).success, false, "no words and no image: refused");
  assert.equal(directMessageBody.safeParse({ slug: "a", text: "", images: ["img-1"] }).success, true);
});

test("a text-only send is the write it always was: no images field", () => {
  assert.deepEqual(directWrite("otter", "Hold the reindex.", "i-1"), { path: WRITES.directMessage, body: { slug: "otter", text: "Hold the reindex.", followUp: "i-1" } });
  assert.deepEqual(directWrite("otter", "Hold.", null, []).body, { slug: "otter", text: "Hold.", followUp: null });
  assert.deepEqual(directWrite("otter", "See.", null, ["img-a", "img-b"]).body, { slug: "otter", text: "See.", followUp: null, images: ["img-a", "img-b"] });
  assert.equal(imageWrite("otter", "s.png", "image/png", "AAAA").path, WRITES.directImage);
});

// ---------------------------------------------------------------- the server's checks (core/direct-images.ts)

test("the server goes by the bytes: each type's signature, and nothing else", () => {
  assert.equal(sniff(PNG), "image/png");
  assert.equal(sniff(JPEG), "image/jpeg");
  assert.equal(sniff(GIF), "image/gif");
  assert.equal(sniff(WEBP), "image/webp");
  assert.equal(sniff(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  assert.equal(sniff(Buffer.from("BM\0\0")), null);
  assert.equal(safeName("../../etc/passwd", "image/png"), "passwd.png", "no path in a name");
  assert.equal(safeName("..", "image/gif"), "image.gif");
  assert.equal(safeName("Screenshot 2026-11-17 at 10.00.00.PNG", "image/png"), "Screenshot-2026-11-17-at-10.00.00.png");
});

test("the body ends with how many images and where; the page's words come back without that line", () => {
  const imgs = [{ path: "/a/one.png" }, { path: "/a/two.png" }];
  const body = withImages("Look at the header.", imgs);
  assert.match(body, /^Look at the header\.\n\n\(2 images attached; open each with your file reader: \/a\/one\.png, \/a\/two\.png\)$/);
  assert.equal(wordsOf(body, imgs), "Look at the header.");
  assert.equal(withImages("", [{ path: "/a/one.png" }]), imagesNote([{ path: "/a/one.png" }]), "an image alone: only its line");
  assert.match(imagesNote([{ path: "/a/one.png" }]), /^\(1 image attached;/);
});

// ---------------------------------------------------------------- the engine

function engine() {
  const sent: { text: string; item: Item }[] = [];
  const db = new DatabaseSync(":memory:");
  const ports = { now: () => Date.parse("2026-11-17T10:00:00Z"), deliver: async (_t: string, text: string, item: Item): Promise<DeliverResult> => (sent.push({ text, item }), { delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} };
  const e = new Engine(db as never, ports, { batchInbox: false });
  e.register("T-cos", "cos", null);
  e.createProject("otter", "normal", "cos", "otter", "Search.");
  e.register("T-lead", "lead", "otter");
  const img = (name: string) => e.addDirectImage("otter", { name, mime: "image/png", size: 10, path: `/kept/${name}`, sourceProject: "bbp-1" });
  return { e, sent, img, db };
}

test("the message carries its images to the lead: their paths in what the lead reads, in the order attached", async () => {
  const { e, sent, img } = engine();
  const a = img("one.png");
  const b = img("two.png");
  const it = e.ownerMessage("otter", "Why is the header cut off?", null, [a, b]);
  await e.flush();
  const got = sent.find((s) => s.item.id === it.id)!;
  assert.match(got.text, /Why is the header cut off\?\n\n\(2 images attached; open each with your file reader: \/kept\/one\.png, \/kept\/two\.png\)/);
  assert.deepEqual(e.directImagesOf(it.id).map((i) => i.path), ["/kept/one.png", "/kept/two.png"]);
  // still the owner's tracked direct message: the lead acks it
  assert.equal(it.kind, "owner.message");
  assert.equal(it.needsAck, true);
  // the log shows the words and the images apart
  const m = e.directHistory("otter", null, 10).messages[0]!;
  assert.equal(m.text, "Why is the header cut off?");
  assert.deepEqual(m.images, [{ name: "one.png" }, { name: "two.png" }]);
});

test("the CoS copy says N images attached, with where they are", () => {
  const { e, img, db } = engine();
  const it = e.ownerMessage("otter", "", null, [img("s.png"), img("t.png"), img("u.png")]);
  const copy = db.prepare(`SELECT body FROM items WHERE recipient = 'cos' AND ref = ?`).get(it.id) as { body: string };
  assert.match(copy.body, /3 images attached; open each with your file reader: \/kept\/s\.png, \/kept\/t\.png, \/kept\/u\.png/);
});

test("an image removed before the send stays off the message; one is never carried twice or to another lead", () => {
  const { e, img } = engine();
  const kept = img("kept.png");
  const removed = img("removed.png");
  const it = e.ownerMessage("otter", "Only the first.", null, [kept]);
  assert.deepEqual(e.directImagesOf(it.id).map((i) => i.name), ["kept.png"]);
  assert.doesNotMatch(it.body, /removed\.png/);
  void removed;
  assert.throws(() => e.ownerMessage("otter", "Again.", null, [kept]), /isn't one sent for this message/, "already on a message");
  e.createProject("lark", "normal", "cos", "lark", "Pricing.");
  e.register("T-lark", "lead", "lark");
  assert.throws(() => e.ownerMessage("lark", "Theirs.", null, [removed]), /isn't one sent for this message/, "sent for otter");
  assert.throws(() => e.ownerMessage("otter", "Made up.", null, ["img-nope"]), /isn't one sent for this message/);
});

test("a text-only message is the body it always was, with no images", () => {
  const { e } = engine();
  const it = e.ownerMessage("otter", "  Hold the reindex.  ");
  assert.equal(it.body, "Hold the reindex.");
  assert.deepEqual(e.directImagesOf(it.id), []);
  assert.equal(e.directHistory("otter", null, 10).messages[0]!.images, undefined);
});

// ---------------------------------------------------------------- the real server, behind a fake bb

type Route = (c: unknown) => Promise<Response>;
async function server(upload: (a: any) => Promise<unknown>, refuseImages = false) {
  const root = scratch("images");
  const db = Object.assign(new DatabaseSync(join(root, "data.db")), { name: join(root, "data.db") });
  const routes = new Map<string, Route>();
  const sends: any[] = [];
  const logs: string[] = [];
  const uploads: any[] = [];
  const noop: any = new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : noop), apply: () => noop });
  const sdk = {
    projects: { list: async () => [], attachments: { upload: async (a: any) => (uploads.push({ ...a, clientFile: `${a.clientFile.length} bytes` }), upload(a)) } },
    threads: {
      send: async (input: any) => {
        if (refuseImages && input.input.some((i: any) => i.type === "localImage")) throw new Error("localImage not allowed");
        sends.push(input);
        return { delivery: "sent" };
      },
      get: async ({ threadId }: { threadId: string }) => ({ id: threadId, projectId: "bbp-1", environmentId: "env-lead", status: "idle", archivedAt: null, parentThreadId: null }),
      queuedMessages: { list: async () => [] },
      list: async () => [],
    },
  };
  const log = (m: unknown) => void logs.push(String(m));
  const bb: any = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "pluginId") return "orchestrator";
        if (k === "settings")
          return {
            define: (schema: Record<string, { default: unknown }>) => {
              const v: any = Object.fromEntries(Object.entries(schema).map(([key, d]) => [key, d.default]));
              Object.assign(v, { batchInbox: false, stateDir: join(root, "state"), projectsDir: join(root, "projects"), memoryConfig: "", diskPath: root });
              return { get: async () => v, onChange: () => {} };
            },
          };
        if (k === "storage") return { database: () => db, kv: noop };
        if (k === "agents") return noop;
        if (k === "cli") return { register: () => {} };
        if (k === "http") return { route: (_m: string, path: string, h: Route) => routes.set(path, h) };
        if (k === "sdk") return new Proxy(sdk, { get: (s: any, n) => s[n] ?? noop });
        if (k === "background") return { service: () => {} };
        if (k === "log") return { info: log, warn: log, error: log };
        return noop;
      },
    },
  );
  await plugin(bb);
  const e = new Engine(db as never, { now: () => Date.now(), deliver: async (): Promise<DeliverResult> => ({ delivery: "sent" }), mirror: () => {}, changed: () => {}, log: () => {} }, { batchInbox: false });
  e.register("T-cos", "cos", null);
  e.createProject("otter", "normal", "cos", "otter", "Search.");
  e.register("T-lead", "lead", "otter");
  const post = async (path: string, body: unknown) => {
    const c = {
      req: { url: "http://app.test/x", header: (n: string) => ({ origin: "http://app.test", "sec-fetch-site": "same-origin" })[n.toLowerCase()], json: async () => body },
      json: (b: unknown, status = 200) => new Response(JSON.stringify(b), { status }),
    };
    const res = await routes.get(path)!(c);
    return (await res.json()) as { ok: boolean; result?: any; error?: { kind: string; message: string } };
  };
  return { root, post, sends, logs, uploads, db };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

test("server: an image goes to bb's attachments for the lead's project, and the lead's thread gets it as an image input", async () => {
  const kept = join(scratch("attach"), "shot-1.png");
  const s = await server(async (a) => ({ type: "localImage", name: a.filename, path: kept, mimeType: a.mimeType, sizeBytes: a.clientFile.length }));
  const up = await s.post(WRITES.directImage, { slug: "otter", name: "Screenshot 1.png", mime: "image/png", data: PNG.toString("base64") });
  assert.equal(up.ok, true, JSON.stringify(up));
  assert.match(up.result, /^img-/, "an id, never a path, goes back to the page");
  assert.deepEqual(s.uploads, [{ projectId: "bbp-1", clientFile: `${PNG.length} bytes`, filename: "Screenshot-1.png", mimeType: "image/png" }]);
  const sent = await s.post(WRITES.directMessage, { slug: "otter", text: "The header is cut off.", followUp: null, images: [up.result] });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  await settle();
  const toLead = s.sends.find((x) => x.threadId === "T-lead")!;
  assert.ok(toLead, "delivered to the lead's thread");
  assert.equal(toLead.input[0].type, "text");
  assert.match(toLead.input[0].text, /1 image attached; open each with your file reader: .*shot-1\.png/);
  assert.deepEqual(toLead.input.slice(1), [{ type: "localImage", path: kept, sourceProjectId: "bbp-1" }]);
});

test("server: when bb's attachments can't take it, the image is kept in the plugin's own folder and its path goes to the lead", async () => {
  const s = await server(async () => {
    throw new Error("no attachments here");
  });
  const up = await s.post(WRITES.directImage, { slug: "otter", name: "s.webp", mime: "image/webp", data: WEBP.toString("base64") });
  assert.equal(up.ok, true, JSON.stringify(up));
  await s.post(WRITES.directMessage, { slug: "otter", text: "", followUp: null, images: [up.result] });
  await settle();
  const toLead = s.sends.find((x) => x.threadId === "T-lead")!;
  const path = toLead.input[1].path as string;
  assert.ok(isAbsolute(path) && path.startsWith(join(s.root, "state", "direct-images")), path);
  assert.deepEqual(readFileSync(path), WEBP, "the very bytes, readable by the lead");
  assert.equal(toLead.input[1].sourceProjectId, undefined);
  assert.match(toLead.input[0].text, /1 image attached/);
});

test("server: a text-only message reaches the lead as one text input, as before", async () => {
  const s = await server(async () => assert.fail("no upload for text"));
  await s.post(WRITES.directMessage, { slug: "otter", text: "Hold the reindex.", followUp: null });
  await settle();
  const toLead = s.sends.find((x) => x.threadId === "T-lead")!;
  assert.equal(toLead.input.length, 1);
  assert.doesNotMatch(toLead.input[0].text, /image/);
});

test("server: bytes that aren't the claimed image, or one too big, are refused, and no log or answer carries image bytes", async () => {
  const s = await server(async () => ({ path: "/never" }));
  const fake = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>x</script></svg>").toString("base64");
  const bad = await s.post(WRITES.directImage, { slug: "otter", name: "x.png", mime: "image/png", data: fake });
  assert.equal(bad.ok, false);
  assert.match(bad.error!.message, /not a png, jpeg, gif or webp/);
  const big = "A".repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4);
  const tooBig = await s.post(WRITES.directImage, { slug: "otter", name: "big.png", mime: "image/png", data: big });
  assert.equal(tooBig.ok, false);
  const good = PNG.toString("base64");
  const ok = await s.post(WRITES.directImage, { slug: "otter", name: "s.png", mime: "image/png", data: good });
  assert.equal(ok.ok, true);
  assert.ok(s.logs.some((l) => /direct image for otter: \d+ bytes/.test(l)), "the upload is logged, by its size");
  const all = [...s.logs, JSON.stringify(bad), JSON.stringify(tooBig), JSON.stringify(ok)].join("\n");
  for (const data of [fake, good, big.slice(0, 64)]) assert.ok(!all.includes(data.slice(0, 40)), "no base64 of an image in a log or an answer");
  // nor in the database: the row has the path and the size, never the bytes
  const rows = JSON.stringify(s.db.prepare(`SELECT * FROM direct_images`).all());
  assert.ok(!rows.includes(good.slice(0, 40)));
  assert.ok(!existsSync("/never"));
});

test("the chat's one-line preview counts a message's images; text alone reads as before", () => {
  const m = { id: "i-1", text: "", at: 1, followUp: null, state: "delivered", outcome: null, note: null, answeredAt: null, images: [{ name: "a.png" }, { name: "b.png" }] };
  assert.equal(chatPreview({ messages: [m], unread: false })!.you, "[2 images]");
  assert.equal(chatPreview({ messages: [{ ...m, text: "See", images: [{ name: "a.png" }] }], unread: false })!.you, "See [1 image]");
  assert.equal(chatPreview({ messages: [{ ...m, text: "Hold.", images: undefined }], unread: false })!.you, "Hold.");
});

// ---------------------------------------------------------------- the CoS bar (cos-composer.tsx), last

test("server: the CoS bar's images reach the CoS's thread as images, their count and paths in the text", async () => {
  const kept = join(scratch("cos"), "bar-1.png");
  const s = await server(async () => ({ type: "localImage", path: kept }));
  const up = await s.post(WRITES.cosImage, { name: "Screenshot.png", mime: "image/png", data: PNG.toString("base64") });
  assert.equal(up.ok, true, JSON.stringify(up));
  assert.match(up.result, /^img-/);
  const sent = await s.post(WRITES.cosMessage, { text: "What is this banner?", images: [up.result] });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  await settle();
  const toCos = s.sends.find((x) => x.threadId === "T-cos")!;
  // tracked (D3): the owner's words and images first, then the one line on how the CoS answers it
  assert.match(toCos.input[0].text, /^What is this banner\?\n\n\(1 image attached; open each with your file reader: .*bar-1\.png\)\n\n\[orchestrator\] .*orch_reply_owner\(ref=i-/);
  assert.deepEqual(toCos.input.slice(1), [{ type: "localImage", path: kept, sourceProjectId: "bbp-1" }]);
  // an id is good for one send
  const again = await s.post(WRITES.cosMessage, { text: "Again", images: [up.result] });
  assert.equal(again.ok, false);
  assert.match(again.error!.message, /attach it again/);
});

test("server: a text-only message from the CoS bar is the one text input it always was", async () => {
  const s = await server(async () => assert.fail("no upload for text"));
  assert.equal((await s.post(WRITES.cosMessage, { text: "Hold the reindex." })).ok, true);
  await settle();
  const toCos = s.sends.find((x) => x.threadId === "T-cos")!;
  assert.equal(toCos.input.length, 1, "one text input");
  assert.equal(toCos.mode, "queue-if-active", "it waits for the CoS's turn to end, as the bar's message always did");
  assert.deepEqual((s.db.prepare(`SELECT kind, sender, recipient FROM items WHERE kind = 'owner.cos'`).all() as object[]).map((r) => ({ ...r })), [{ kind: "owner.cos", sender: "person", recipient: "cos" }], "tracked: one record the feed and the Chat tab read");
  assert.match(toCos.input[0].text, /^Hold the reindex\.\n\n\[orchestrator\] .*'s message i-\w+\. Answer it with orch_reply_owner/);
  assert.equal(cosMessageBody.safeParse({ text: "  " }).success, false, "no words and no image: refused");
  assert.equal(cosMessageBody.safeParse({ text: "", images: Array.from({ length: 7 }, (_, i) => `img-${i}`) }).success, false, "at most 6");
});

test("server: if bb refuses the image inputs, the lead and the CoS still get the text with the images' paths", async () => {
  const kept = join(scratch("refused"), "r.png");
  const s = await server(async () => ({ type: "localImage", path: kept }), true);
  const lead = await s.post(WRITES.directImage, { slug: "otter", name: "r.png", mime: "image/png", data: PNG.toString("base64") });
  await s.post(WRITES.directMessage, { slug: "otter", text: "See this.", followUp: null, images: [lead.result] });
  await settle();
  const toLead = s.sends.find((x) => x.threadId === "T-lead")!;
  assert.ok(toLead, "the message is not stranded");
  assert.equal(toLead.input.length, 1);
  assert.match(toLead.input[0].text, /1 image attached; open each with your file reader: .*r\.png/);
  const bar = await s.post(WRITES.cosImage, { name: "r.png", mime: "image/png", data: PNG.toString("base64") });
  assert.equal((await s.post(WRITES.cosMessage, { text: "And this.", images: [bar.result] })).ok, true);
  assert.match(s.sends.find((x) => x.threadId === "T-cos" && x.input[0].text.startsWith("And this."))!.input[0].text, /1 image attached/);
  assert.ok(s.logs.some((l) => /refused 1 image input\(s\).*paths only/.test(l)));
});
