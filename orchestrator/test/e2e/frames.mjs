// A frame recorder for the "smooth" lines (feel spec 4.2), shared by dock.mjs and dividers.mjs. It takes a Playwright page.

/** Animation-frame gaps over `ms` with nothing happening: the run's idle baseline. */
export async function idle(page, ms = 2000) {
  const gaps = await page.evaluate(async (ms) => {
    const g = [];
    let last = performance.now();
    const end = last + ms;
    await new Promise((done) => {
      const tick = (t) => {
        g.push(t - last);
        last = t;
        if (t < end) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    return g.slice(1);
  }, ms);
  return summary(gaps);
}

/** Start recording, each frame: its time, every drawn pane's layout box and scrollTop, the preview, the ghost, running animations and the selection; and pointer moves, releases and long tasks. */
export async function start(page) {
  await page.evaluate(() => {
    const rec = { frames: [], moves: [], ups: [], long: [], on: true };
    window.__rec = rec;
    const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => rec.long.push({ t: e.startTime, ms: Math.round(e.duration) })));
    po.observe({ type: "longtask" });
    rec.po = po;
    const mv = (e) => rec.moves.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    window.addEventListener("pointermove", mv, true);
    rec.mv = mv;
    const up = (e) => rec.ups.push(e.timeStamp);
    window.addEventListener("pointerup", up, true);
    rec.up = up;
    const SKIP = new Set(["offset", "easing", "composite", "computedOffset"]);
    // what an animation runs on: a pane, the drag's own layer, the Sidebar, or something else (a hover's colour)
    const on = (el) => (!el ? null : el.matches("[data-pane]") ? "pane" : el.closest("[data-drag-cover]") ? "drag" : el.closest("[data-page-sidebar]") ? "sidebar" : el.closest("[data-pane]") ? "in-pane" : el.tagName.toLowerCase());
    const box = (el) => (el ? { l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null);
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
    };
    const tick = (t) => {
      if (!rec.on) return;
      const prev = document.querySelector("[data-dock-preview]");
      const ghost = document.querySelector("[data-dock-ghost]");
      rec.frames.push({
        t,
        panes: [...document.querySelectorAll("[data-pane]")].filter((p) => p.offsetWidth > 0).map((p) => ({ id: p.getAttribute("data-pane"), view: p.getAttribute("data-pane-view"), box: box(p), rect: rect(p), scroll: p.querySelector(".orch-pane__scroll")?.scrollTop ?? 0, opacity: getComputedStyle(p).opacity })),
        preview: prev && getComputedStyle(prev).display !== "none" ? { at: prev.getAttribute("data-dock-preview"), rect: rect(prev), label: prev.textContent, opacity: getComputedStyle(prev).opacity, transition: getComputedStyle(prev).transitionProperty, duration: getComputedStyle(prev).transitionDuration } : null,
        ghost: ghost ? { rect: rect(ghost), text: ghost.textContent, opacity: getComputedStyle(ghost).opacity } : null,
        drag: document.documentElement.getAttribute("data-orch-drag"),
        cursor: (() => {
          const c = document.querySelector("[data-drag-cover]");
          return c && getComputedStyle(c).pointerEvents !== "none" ? getComputedStyle(c).cursor : null;
        })(),
        anims: document.getAnimations().filter((a) => a.playState === "running").map((a) => ({ props: [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((x) => !SKIP.has(x))))], prop: a.transitionProperty ?? a.animationName ?? null, on: on(a.effect?.target) })),
        selection: String(getSelection()),
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Stop recording; the frames, moves and long tasks since start. */
export async function stop(page) {
  return page.evaluate(() => {
    const rec = window.__rec;
    rec.on = false;
    rec.po.takeRecords().forEach((e) => rec.long.push({ t: e.startTime, ms: Math.round(e.duration) }));
    rec.po.disconnect();
    window.removeEventListener("pointermove", rec.mv, true);
    window.removeEventListener("pointerup", rec.up, true);
    return { frames: rec.frames, moves: rec.moves, ups: rec.ups, long: rec.long };
  });
}

/** Gaps between consecutive frames in [from, to]. */
export function gapsOf(frames, from = -Infinity, to = Infinity) {
  const fs = frames.filter((f) => f.t >= from && f.t <= to);
  return fs.slice(1).map((f, i) => f.t - fs[i].t);
}

export function summary(gaps) {
  const s = [...gaps].sort((a, b) => a - b);
  const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
  return { n: s.length, p50: round(q(0.5)), p95: round(q(0.95)), max: round(s.at(-1) ?? 0) };
}

const round = (x) => Math.round(x * 10) / 10;

/** Drag the mouse along `points` at about 60 moves a second. */
export async function path(page, points, { hz = 60 } = {}) {
  for (const [x, y] of points) {
    await page.mouse.move(x, y);
    await page.waitForTimeout(Math.round(1000 / hz));
  }
}

/** Straight segments between waypoints, `steps` moves each. */
export function through(waypoints, steps = 12) {
  const out = [];
  for (let i = 1; i < waypoints.length; i++) {
    const [ax, ay] = waypoints[i - 1];
    const [bx, by] = waypoints[i];
    for (let k = 1; k <= steps; k++) out.push([ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps]);
  }
  return out;
}

/** CSS properties that move or resize a box: none of them may animate in a settle */
export const LAYOUT_PROPS = /^(width|height|(min|max)(Width|Height)|left|right|top|bottom|inset.*|margin.*|padding.*|flex.*|gridTemplate.*|gap)$/;

/**
 * The settle after a release (S7): the panes' and the drag layer's animations, plus any animation of a layout property
 * anywhere. A hover's colour transition on whatever is under the pointer once the drag's cover lifts is listed, not counted.
 */
export function settleOf(frames, up) {
  const after = frames.filter((f) => f.t > up);
  const counted = (a) => a.on === "pane" || a.on === "drag" || a.props.some((p) => LAYOUT_PROPS.test(p));
  const anim = after.filter((f) => f.anims.some(counted));
  const props = [...new Set(anim.flatMap((f) => f.anims.filter(counted).flatMap((a) => a.props)))];
  const layout = [...new Set(after.flatMap((f) => f.anims.flatMap((a) => a.props.filter((p) => LAYOUT_PROPS.test(p)).map((p) => `${p} on ${a.on}`))))];
  const other = [...new Set(after.flatMap((f) => f.anims.filter((a) => !counted(a)).map((a) => `${a.props.join("+")} on ${a.on}`)))];
  return { props, layout, lastAt: anim.length ? Math.round(anim.at(-1).t - up) : 0, frames: anim.length, other };
}
