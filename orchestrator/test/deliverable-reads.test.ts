// One owner per read (app/deliverable-reads.ts), on TanStack's real query core: the host's queries are TanStack
// queries, where a refetch with no data joins the read under way and one with data cancels it. Each case is a repro
// from Codex's reviews (2026-11-24) or the owner's rules after them: the server's state has a version, each read answers
// the version it started at, and the test counts the reads the server ran and checks the card ends on the newest.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/query-core";
import { NoticeClock, pageVisibility, pressOpen, showCard, wantedStore } from "../app/deliverable-reads.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

type ServerRead = { v: number; answer: () => void; fail: () => void; aborted: boolean; done: boolean };
/** The server: `version` moves on each change; each read is held until answered, and answers the version it started at. */
function server() {
  const s = {
    version: 0,
    reads: [] as ServerRead[],
    fn: ({ signal }: { signal: AbortSignal }) =>
      new Promise<{ v: number }>((resolve, reject) => {
        const read: ServerRead = { v: s.version, answer: () => resolve({ v: read.v }), fail: () => reject(new Error("500")), aborted: false, done: false };
        signal.addEventListener("abort", () => {
          read.aborted = true;
          reject(new Error("aborted"));
        });
        s.reads.push(read);
      }),
    open: () => s.reads.filter((r) => !r.aborted && !r.done),
    async answerAll() {
      for (let i = 0; i < 20; i++) {
        const open = s.open();
        if (open.length === 0) return;
        for (const r of open) {
          r.done = true;
          r.answer();
        }
        await tick();
      }
    },
  };
  return s;
}

/**
 * The owner as React runs useOwnedRead (app/deliverable-prefetch.tsx): its first render is an open (`mount`), each
 * render takes the query's optimistic result, the subscription (the host's read on mount) starts after the first
 * render, and the effect runs after a render whose inputs changed and refetches only when `step` says so.
 */
function owner(client: QueryClient, clock: NoticeClock, key: string, staleTime: number, fn: ReturnType<typeof server>["fn"]) {
  const options = client.defaultQueryOptions({ queryKey: [key], queryFn: fn, staleTime, retry: false });
  const obs = new QueryObserver(client, options);
  let live = true;
  let answered = 0;
  let last = "";
  clock.mount(key);
  const render = () => {
    if (!live) return;
    const r = obs.getOptimisticResult(options);
    const deps = `${r.isFetching}|${r.error === null}|${clock.get()}|${answered}`;
    return () => {
      if (deps === last || !live) return;
      last = deps;
      if (clock.step(key, r.isFetching, r.error === null))
        void obs.refetch().finally(() => {
          answered++;
          render()?.();
        });
    };
  };
  const effect = render()!;
  const stop = obs.subscribe(() => render()?.());
  const stopClock = clock.subscribe(() => render()?.());
  effect();
  return {
    data: () => obs.getCurrentResult().data as { v: number } | undefined,
    unmount() {
      live = false;
      stop();
      stopClock();
      clock.unmount(key);
    },
  };
}

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

test("a notice during a card's first read reads it once more after it answers", async () => {
  const s = server();
  const clock = new NoticeClock();
  const o = owner(client(), clock, "v-pr", 2000, s.fn);
  await tick();
  assert.equal(s.reads.length, 1, "the first read is under way, no data yet");
  s.version = 1; // its PR merged
  clock.notice();
  await tick();
  assert.equal(s.reads.length, 1, "no second read while the first is under way (it would only join it)");
  await s.answerAll();
  assert.equal(s.reads.length, 2, "one more read, started after the first answered");
  assert.equal(s.reads[1]!.v, 1);
  assert.equal(o.data()?.v, 1, "the card shows the merged PR");
  o.unmount();
});

test("notices during a read under way, a card mounted on it: exactly one more read, none cancelled", async () => {
  const s = server();
  const clock = new NoticeClock();
  const c = client();
  const first = owner(c, clock, "v-cached", 0, s.fn);
  await s.answerAll();
  first.unmount();
  // opened again: the host reads the old copy on mount, and that read is this opening's; the card mounts on it and
  // only wants the read (its own query never reads: one owner)
  const pressed = owner(c, clock, "v-cached", 0, s.fn);
  const card = new QueryObserver(c, c.defaultQueryOptions({ queryKey: ["v-cached"], queryFn: s.fn, enabled: false }));
  const stopCard = card.subscribe(() => {});
  await tick();
  assert.equal(s.reads.length, 2, "one read for the opening, none for the card's mount");
  s.version = 1;
  clock.notice();
  s.version = 2;
  clock.notice();
  await tick();
  await s.answerAll();
  assert.equal(s.reads.length, 3, "one read for both notices");
  assert.equal(s.reads.filter((r) => r.aborted).length, 0, "no read cancelled and started again");
  assert.equal((card.getCurrentResult().data as { v: number } | undefined)?.v, 2, "the card shows the newest");
  stopCard();
  pressed.unmount();
});

test("each opening reads the card once behind its cached copy, fresh or old", async () => {
  const s = server();
  const clock = new NoticeClock();
  const c = client();
  for (const [i, staleTime] of [2000, 2000, 0].entries()) {
    const o = owner(c, clock, "v-a", staleTime, s.fn);
    if (i > 0) assert.notEqual(o.data(), undefined, "the cached copy draws at once");
    await tick();
    await s.answerAll();
    assert.equal(s.reads.length, i + 1, `opening ${i + 1}: one read`);
    o.unmount();
  }
});

test("a change while the panel was closed (no notice could be counted) is read on the next opening (Codex round 3, P1)", async () => {
  const s = server();
  const clock = new NoticeClock();
  const index = new NoticeClock();
  const c = client();
  const card = owner(c, clock, "v-away", 2000, s.fn);
  const idx = owner(c, index, "index", 2000, s.fn);
  await s.answerAll();
  card.unmount();
  idx.unmount();
  // away from the panel: its PR merges and nothing hears the notice; back within the host's 2 s freshness
  s.version = 1;
  const card2 = owner(c, clock, "v-away", 2000, s.fn);
  const idx2 = owner(c, index, "index", 2000, s.fn);
  assert.equal(card2.data()?.v, 0, "the cached copy draws at once");
  await tick();
  await s.answerAll();
  assert.equal(card2.data()?.v, 1, "the card is read again behind it");
  assert.equal(idx2.data()?.v, 1, "and so is the index");
  assert.equal(s.reads.length, 4);
  card2.unmount();
  idx2.unmount();
});

test("a read cancelled by hiding the page never counts: shown again, the card is read (Codex round 3, P1)", async () => {
  const s = server();
  const clock = new NoticeClock();
  const c = client();
  const card = owner(c, clock, "v-hide", 2000, s.fn);
  await s.answerAll();
  s.version = 1;
  clock.notice(); // its PR merged: a read starts
  await tick();
  assert.equal(s.open().length, 1);
  pageVisibility(false);
  await c.cancelQueries({ queryKey: ["v-hide"] }); // the host cancels its reads when the page is hidden
  await tick();
  assert.equal(card.data()?.v, 0, "the old copy is all there is");
  assert.equal(s.open().length, 0, "no read while hidden");
  pageVisibility(true);
  await tick();
  await s.answerAll();
  assert.equal(card.data()?.v, 1, "shown again, the card is read");
  // a read that answers while the page is hidden may be one the host cancelled, so it does not count either
  s.version = 2;
  clock.notice();
  await tick();
  pageVisibility(false);
  await s.answerAll();
  pageVisibility(true);
  await tick();
  await s.answerAll();
  assert.equal(card.data()?.v, 2);
  assert.equal(s.reads.length, 5, "the one read again after the hidden one");
  card.unmount();
});

test("a failed read does not count, and does not loop: the next notice reads", async () => {
  const s = server();
  const clock = new NoticeClock();
  const card = owner(client(), clock, "v-fail", 2000, s.fn);
  await tick();
  s.open()[0]!.fail();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(s.reads.length, 1, "no read again on its own");
  clock.notice();
  await tick();
  await s.answerAll();
  assert.equal(s.reads.length, 2);
  assert.equal(card.data()?.v, 0);
  card.unmount();
});

test("the index reads once per notice that touches it, and once per opening of Delivered unless a read is under way", async () => {
  const s = server();
  const clock = new NoticeClock();
  const index = owner(client(), clock, "index", 2000, s.fn);
  await s.answerAll();
  for (let n = 1; n <= 3; n++) {
    s.version = n;
    clock.notice();
    await s.answerAll();
    assert.equal(s.reads.length, 1 + n, `one index read for notice ${n}`);
    assert.equal(index.data()?.v, n);
  }
  clock.open("index", false); // Delivered opened
  await tick();
  await s.answerAll();
  assert.equal(s.reads.length, 5, "an opening reads it once");
  clock.notice();
  await tick();
  clock.open("index", true); // opened while that read is under way
  await s.answerAll();
  assert.equal(s.reads.length, 6, "the read under way serves the opening");
  index.unmount();
  // Delivered never reads the index on its own account: comparing it with a list that answers later marked a newer
  // index old and read it again
  assert.doesNotMatch(readFileSync(join(import.meta.dirname, "..", "app/deliverables.tsx"), "utf8"), /index\.refetch|indexRefetch|indexFresh/);
});

test("10,000 cards opened and closed leave no entries (Codex round 3, P2)", () => {
  const clock = new NoticeClock();
  for (let i = 0; i < 10_000; i++) {
    const key = `v-${i}`;
    clock.mount(key);
    clock.step(key, true, true); // the read on opening
    clock.step(key, false, true); // answered
    clock.unmount(key);
  }
  assert.equal(clock.size, 0);
  // one closed with its read under way waits a minute, in case it is opened again meanwhile
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    clock.mount("v-busy");
    clock.step("v-busy", true, true);
    clock.unmount("v-busy");
    assert.equal(clock.size, 1);
    mock.timers.tick(60_000);
    assert.equal(clock.size, 0);
  } finally {
    mock.timers.reset();
  }
});

test("a press and the card it opens are one opening; picking the card again is another", () => {
  // the owner's mount is an opening of its own (useOwnedRead); these count the openings of an owner already mounted
  class Spy extends NoticeClock {
    opens = 0;
    override open(key: string, fetching: boolean) {
      this.opens++;
      super.open(key, fetching);
    }
  }
  const clock = new Spy();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    pressOpen("v-docs", 3000, clock); // pressed: its owner mounts and reads (the mount's opening)
    assert.deepEqual(wantedStore.get(), ["v-docs"]);
    const docs = showCard("v-docs", clock); // the card from that press: the same opening
    assert.equal(clock.opens, 0);
    pressOpen("v-docs", 3000, clock); // a press on a card already shown opens nothing
    assert.equal(clock.opens, 0);
    const twice = showCard("v-docs", clock); // shown in a second place at once: no new opening
    twice();
    docs(); // another card picked; the first press still holds the owner
    pressOpen("v-docs", 3000, clock); // picked again
    assert.equal(clock.opens, 1, "picked again: read again");
    const again = showCard("v-docs", clock);
    assert.equal(clock.opens, 1, "and the card it opens takes that press");
    // a press on the shown card (a double click), then the card closed and picked again: still one opening
    pressOpen("v-docs", 3000, clock);
    again();
    pressOpen("v-docs", 3000, clock);
    assert.equal(clock.opens, 2, "a press on a shown card holds nothing that swallows the next opening");
    const third = showCard("v-docs", clock);
    assert.equal(clock.opens, 2);
    third();
    mock.timers.tick(3000);
    assert.deepEqual(wantedStore.get(), [], "the presses let go");
    const shown = showCard("v-docs", clock); // shown with no press, no owner: the owner's mount opens it
    assert.equal(clock.opens, 2);
    shown();
  } finally {
    mock.timers.reset();
  }
});

test("only the owners read: no card or listener calls refetch on these two reads", () => {
  const src = (f: string) => readFileSync(join(import.meta.dirname, "..", f), "utf8");
  const prefetch = src("app/deliverable-prefetch.tsx");
  // the card's own query never reads; the root holds one owner per card
  assert.match(prefetch, /method: "deliverable", input: \{ id \}, enabled: false \}/);
  assert.equal(prefetch.match(/refetch\.current\(\)/g)?.length, 1, "one refetch, in useOwnedRead");
  assert.match(prefetch, /if \(touches\(n, "deliverable"\)\) cardClock\.notice\(\);/);
  assert.match(prefetch, /if \(touches\(n, "deliverableIndex"\)\) indexClock\.notice\(\);/);
  assert.doesNotMatch(src("app/deliverables.tsx"), /method: "deliverable"/, "useWhole reads through useCardRead");
});
