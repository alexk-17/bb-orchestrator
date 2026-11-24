// A project's own page (2026-11-16: "almost like a gantt chart, also like agent flow and dependency diagram"), opened
// from its row on the Projects tab. Three sections on one scroll, pictures first and few words:
// - Timeline: one bar per lead and thread address, coloured by state, with PR, handoff and resolve marks and the owner's
//   cards as a band from asked to answered;
// - Flow: the lead, the threads it started, each one's providers in order (handoffs) and its PRs;
// - Dependencies: what waits on what, blockers first.
// The history comes from the events log (core/history.ts); the lanes (live state, model, branch, context) from the
// Projects tab's own reads. 2026-11-17 (the shadcn pass): the Range is a ToggleGroup, the chips Badges in the
// palette's tones; the diagrams keep their own geometry.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { rpcContract, type ProjectHistory, type Projects } from "../contract.ts";
import { touches } from "../change-notice.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
import { AgentFace } from "./face.tsx";
import { KIND_TONES, ROLE_TONES, css, roleOf, tint, type Tone } from "./palette.ts";
import { ACCENT, accentTone, accentVars } from "./accent.ts";
import { useWidth } from "./panes.tsx";
import { ProofLink } from "./proof-link.tsx";
import { Btn, EmptyState, Kind, ReadState } from "./ui.tsx";
import { age, type Lane } from "./lanes.ts";
import { DEP_ROW, NARROW, placeDeps, rowName, rowsIn, scale, span, ticks, type Range, type Scale } from "./timeline.ts";
import { providerWord } from "../core/history.ts";
import type { OpenCard } from "./projects.tsx";
import { StatusBar, useMinute } from "./status-bar.tsx";
import { AllWaits } from "./cc-lines.tsx";
import { useIdentity } from "./identity.ts";
import { PathwaysSection } from "./scope.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useChangeNotice } from "./change-listener.ts";

type Hist = ProjectHistory;
type Row = Hist["rows"][number];
type Dep = Hist["deps"][number];

const SEG_TONE: Record<string, Tone> = {
  working: KIND_TONES.done,
  idle: KIND_TONES.inactive,
  blocked: KIND_TONES.alarm,
  released: KIND_TONES.inactive,
  unknown: KIND_TONES.inactive,
};
const ASK = KIND_TONES.asked;
const PR = KIND_TONES.merge;
const HANDOFF = ROLE_TONES.cos;
const RESOLVED = KIND_TONES.resolved;
const fill = (t: Tone, a = 1): CSSProperties => ({ fill: a === 1 ? css(t) : `color-mix(in srgb, ${css(t)} ${a * 100}%, transparent)` });
/** A segment's colour mixed over the page, so short segments side by side never blend into a third colour. */
const solid = (t: Tone, a: number): CSSProperties => ({ fill: `color-mix(in srgb, ${css(t)} ${a * 100}%, Canvas)` });
const segStyle = (state: string): CSSProperties =>
  state === "nolog" ? { fill: "url(#orch-nolog)", stroke: "var(--orch-line)" } : solid(SEG_TONE[state]!, state === "working" || state === "blocked" ? 0.9 : 0.45);
const stroke = (t: Tone): CSSProperties => ({ stroke: css(t) });

const day = (t: number) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const stamp = (t: number) => `${day(t)} ${clock(t)}`;

// ---------------------------------------------------------------- Timeline

const BAR = 10;

function Timeline({ h, width, lanes }: { h: Hist; width: number; lanes: Map<string, Lane> }) {
  const navigate = useBbNavigate();
  const [range, setRange] = useState<Range>("all");
  const narrow = width < NARROW;
  const s = scale(h.start, h.now, range, width, narrow);
  const rows = rowsIn(h.rows, s, h.now);
  const rowH = narrow ? 32 : 26;
  const top = 20;
  const height = top + rows.length * rowH + 4;
  const long = h.now - h.start > 36 * 3_600_000;
  return (
    <div data-timeline="" className="flex flex-col gap-2">
      {long ? (
        <div className="flex">
          <ToggleGroup type="single" variant="outline" size="sm" aria-label="Range" value={range} onValueChange={(v) => v && setRange(v as Range)}>
            <ToggleGroupItem value="all">All</ToggleGroupItem>
            <ToggleGroupItem value="week">7 days</ToggleGroupItem>
            <ToggleGroupItem value="day">24 h</ToggleGroupItem>
          </ToggleGroup>
        </div>
      ) : null}
      <svg width={width} height={height} role="img" aria-label={`Timeline of ${h.slug}`} className="block" style={{ overflow: "hidden" }}>
        <defs>
          <pattern id="orch-nolog" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="5" height="5" style={fill(KIND_TONES.inactive, 0.1)} />
            <line x1="0" y1="0" x2="0" y2="5" strokeWidth="2" style={{ stroke: `color-mix(in srgb, ${css(KIND_TONES.inactive)} 35%, transparent)` }} />
          </pattern>
        </defs>
        <Axis s={s} height={height} top={top} />
        {h.logSince !== null && h.logSince > s.t0 ? (
          <line data-log-since="" x1={s.x(h.logSince)} x2={s.x(h.logSince)} y1={top - 4} y2={height} strokeDasharray="2 3" strokeWidth={1} style={{ stroke: "var(--orch-muted)" }} />
        ) : null}
        {rows.map((r, i) => (
          <TimelineRow key={r.address} r={r} s={s} y={top + i * rowH} rowH={rowH} narrow={narrow} lane={lanes.get(r.address)} now={h.now} onOpen={() => navigate.toThread(r.holders[r.holders.length - 1]!.threadId)} />
        ))}
      </svg>
      <Legend />
      {h.logSince !== null && rows.some((r) => r.holders.some((x) => x.from < h.logSince!)) ? (
        <p data-log-note="" className="orch-muted m-0 text-xs">
          Before {stamp(h.logSince)}, bars show start and end only.
        </p>
      ) : null}
    </div>
  );
}

function Axis({ s, height, top }: { s: Scale; height: number; top: number }) {
  const ts = ticks(s);
  const span = s.t1 - s.t0;
  return (
    <g data-axis="" style={{ fontSize: 10 }}>
      {ts.map((t) => {
        const label = t.day || span > 3 * 86_400_000 ? day(t.t) : clock(t.t);
        // the last label must not run off the edge
        const anchor = t.x > s.x1 - 24 ? "end" : t.x < s.x0 + 12 ? "start" : "middle";
        return (
          <g key={t.t}>
            <line x1={t.x} x2={t.x} y1={top - 2} y2={height} strokeWidth={t.day ? 1 : 0.5} style={{ stroke: "var(--orch-line)" }} />
            <text x={t.x} y={10} textAnchor={anchor} style={{ fill: "var(--orch-muted)" }}>
              {label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function TimelineRow({ r, s, y, rowH, narrow, lane, now, onOpen }: { r: Row; s: Scale; y: number; rowH: number; narrow: boolean; lane: Lane | undefined; now: number; onOpen: () => void }) {
  const role = roleOf(r.address);
  const by = narrow ? y + 18 : y + (rowH - BAR) / 2;
  const last = r.holders[r.holders.length - 1]!;
  const provider = last.provider ? providerWord(last.provider) : lane?.model ?? null;
  const name = (
    <text
      x={narrow ? 0 : 4}
      y={narrow ? y + 10 : by + BAR - 1}
      onClick={onOpen}
      className="cursor-pointer"
      style={{ fontSize: 11, fill: role ? css(ROLE_TONES[role]) : "currentColor", fontWeight: r.live ? 600 : 400, opacity: r.live ? 1 : 0.75 }}
    >
      {rowName(r.address)}
      {provider ? <tspan style={{ fill: "var(--orch-muted)", fontWeight: 400 }}> · {provider}</tspan> : null}
    </text>
  );
  return (
    <g data-row={r.address} data-live={r.live ? "true" : "false"}>
      <title>{`${r.address}${r.live ? "" : " (finished)"}`}</title>
      {name}
      {r.holders.map((hd) => {
        const end = hd.to ?? now;
        if (end < s.t0 || hd.segments.length === 0) return null;
        // the holder's whole bar gets the minimum width (a 90-second thread still shows); its segments sit on it at
        // their true widths
        const whole = span(s, hd.from, end);
        const lastSeg = hd.segments[hd.segments.length - 1]!;
        return (
          <g key={hd.threadId} data-holder={hd.threadId}>
            <rect x={whole.x} y={by} width={whole.w} height={BAR} rx={2} style={segStyle(lastSeg.state)} />
            {hd.segments.map((g, k) => {
              if (g.to < s.t0) return null;
              const x = s.x(g.from);
              const w = s.x(g.to) - x;
              if (w < 0.5) return null;
              return (
                <rect key={k} data-seg={g.state} x={x} y={by} width={w} height={BAR} style={segStyle(g.state)}>
                  <title>{`${g.state === "nolog" ? "before the log" : g.state} · ${stamp(g.from)} → ${g.to >= now ? "now" : stamp(g.to)}`}</title>
                </rect>
              );
            })}
          </g>
        );
      })}
      {r.asks.map((a) => {
        if ((a.to ?? now) < s.t0) return null;
        const { x, w } = span(s, a.from, a.to ?? now);
        return (
          <rect key={a.id} data-ask={a.id} x={x} y={by - 4} width={w} height={3} rx={1.5} style={fill(ASK)}>
            <title>{`Needs you: ${a.title} · ${a.to ? age(a.from, a.to) : "open"}`}</title>
          </rect>
        );
      })}
      {r.marks.map((m, k) => (m.at < s.t0 ? null : <Mark key={k} m={m} x={s.x(m.at)} cy={by + BAR / 2} />))}
    </g>
  );
}

function Mark({ m, x, cy }: { m: Row["marks"][number]; x: number; cy: number }) {
  const t = `${m.label} · ${stamp(m.at)}`;
  const body =
    m.kind === "pr-merged" ? (
      <path d={`M ${x} ${cy - 5} L ${x + 5} ${cy} L ${x} ${cy + 5} L ${x - 5} ${cy} Z`} style={{ ...fill(PR), stroke: "var(--orch-bg, Canvas)", strokeWidth: 1 }} />
    ) : m.kind === "pr-open" || m.kind === "pr-draft" ? (
      <circle cx={x} cy={cy} r={3.5} strokeWidth={1.75} strokeDasharray={m.kind === "pr-draft" ? "2 1.5" : undefined} style={{ ...stroke(PR), fill: "Canvas" }} />
    ) : m.kind === "pr-closed" ? (
      <path d={`M ${x - 3.5} ${cy - 3.5} L ${x + 3.5} ${cy + 3.5} M ${x + 3.5} ${cy - 3.5} L ${x - 3.5} ${cy + 3.5}`} strokeWidth={2} style={stroke(KIND_TONES.inactive)} />
    ) : m.kind === "handoff" ? (
      <path d={`M ${x} ${cy - 7} L ${x} ${cy + 7} M ${x - 3} ${cy - 4} L ${x} ${cy - 7} L ${x + 3} ${cy - 4}`} strokeWidth={2} fill="none" style={stroke(HANDOFF)} />
    ) : m.kind === "mode" ? (
      // scoping started or ended (1.11.0): a ring, filled once the project is active
      <circle cx={x} cy={cy} r={4} strokeWidth={1.75} style={{ ...stroke(HANDOFF), ...(m.label.startsWith("scoping done") ? fill(HANDOFF) : { fill: "Canvas" }) }} />
    ) : (
      <path d={`M ${x - 4} ${cy} L ${x - 1} ${cy + 3} L ${x + 4} ${cy - 3}`} strokeWidth={2} fill="none" style={stroke(RESOLVED)} />
    );
  const g = (
    <g data-mark={m.kind}>
      <title>{t}</title>
      {body}
    </g>
  );
  return m.url ? (
    <ProofLink open={{ url: m.url }}>{g}</ProofLink>
  ) : (
    g
  );
}

function Swatch({ children, label }: { children: ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <svg width={14} height={12} aria-hidden className="block">
        {children}
      </svg>
      {label}
    </span>
  );
}

function Legend() {
  const bar = (t: Tone, a: number) => <rect x={0} y={2} width={14} height={8} rx={2} style={solid(t, a)} />;
  return (
    <div data-legend="" className="orch-muted flex flex-wrap gap-x-3 gap-y-1 text-xs">
      <Swatch label="working">{bar(KIND_TONES.done, 0.9)}</Swatch>
      <Swatch label="idle">{bar(KIND_TONES.inactive, 0.45)}</Swatch>
      <Swatch label="blocked">{bar(KIND_TONES.alarm, 0.9)}</Swatch>
      <Swatch label="needs you">
        <rect x={0} y={4} width={14} height={3} rx={1.5} style={fill(ASK)} />
      </Swatch>
      <Swatch label="no log">
        <rect x={0} y={2} width={14} height={8} rx={2} style={{ fill: "url(#orch-nolog)", stroke: "var(--orch-line)" }} />
      </Swatch>
      <Swatch label="PR opened">
        <circle cx={7} cy={6} r={3.5} strokeWidth={1.75} style={{ ...stroke(PR), fill: "Canvas" }} />
      </Swatch>
      <Swatch label="merged">
        <path d="M 7 1 L 12 6 L 7 11 L 2 6 Z" style={fill(PR)} />
      </Swatch>
      <Swatch label="handoff">
        <path d="M 7 0 L 7 12 M 4 3 L 7 0 L 10 3" strokeWidth={2} fill="none" style={stroke(HANDOFF)} />
      </Swatch>
      <Swatch label="resolved">
        <path d="M 3 6 L 6 9 L 11 3" strokeWidth={2} fill="none" style={stroke(RESOLVED)} />
      </Swatch>
    </div>
  );
}

// ---------------------------------------------------------------- Flow

const prTone = (state: string): Tone => (state === "closed" ? KIND_TONES.inactive : PR);

/** A flow chip: shadcn's Badge in a palette tone (its tint behind its word), solid for a merged PR. */
function Chip({ tone, children, title, solid, ...p }: { tone: Tone; children: ReactNode; title?: string; solid?: boolean; [data: `data-${string}`]: string | undefined }) {
  return (
    <Badge variant="secondary" {...p} title={title} style={solid ? { background: css(tone), color: "Canvas" } : { background: tint(tone), color: css(tone) }}>
      {children}
    </Badge>
  );
}

const Arrow = () => (
  <span aria-hidden className="orch-muted text-xs">
    →
  </span>
);

function FlowNode({ r, lane, depth }: { r: Row; lane: Lane | undefined; depth: number }) {
  const navigate = useBbNavigate();
  const role = roleOf(r.address);
  const tone = role ? ROLE_TONES[role] : KIND_TONES.inactive;
  const last = r.holders[r.holders.length - 1]!;
  const resolved = r.marks.some((m) => m.kind === "resolve");
  return (
    <li data-flow={r.address} data-live={r.live ? "true" : "false"} className={r.live ? "" : "opacity-60"} style={{ position: "relative", paddingLeft: depth ? 18 : 0, paddingTop: 4, paddingBottom: 4 }}>
      {depth ? <span aria-hidden style={{ position: "absolute", left: 0, top: 15, width: 12, borderTop: "1.5px solid var(--orch-line)" }} /> : null}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Button variant="ghost" size="xs" onClick={() => navigate.toThread(last.threadId)} title={`Open ${r.address}`} className="h-7 gap-1.5 px-1">
          {lane ? <AgentFace face={{ mon: lane.agent.form ?? lane.agent.mon, dex: lane.agent.formDex, persona: lane.agent.persona }} address={r.address} size={24} /> : null}
          <span className="orch-mono font-medium" style={{ color: css(tone) }}>
            {rowName(r.address)}
          </span>
        </Button>
        {r.holders.map((hd, i) => (
          <span key={hd.threadId} className="inline-flex items-center gap-1.5">
            {i > 0 ? (
              <span aria-label="handed over" style={{ color: css(HANDOFF) }} className="text-xs font-semibold">
                ⇄
              </span>
            ) : null}
            <Chip tone={hd.provider?.includes("codex") ? KIND_TONES.deferred : ROLE_TONES.lead} data-provider={hd.provider ?? ""} title={`${hd.threadId} · ${stamp(hd.from)}`}>
              {hd.provider ? providerWord(hd.provider) : hd.to === null ? (lane?.model ?? "agent") : "agent"}
              {hd.to === null && lane?.agent.model ? (
                <span data-flow-model="" className="orch-mono font-normal opacity-80">
                  {lane.agent.model}
                </span>
              ) : null}
            </Chip>
          </span>
        ))}
        {r.prs.length ? <Arrow /> : null}
        {r.prs.map((p) => (
          <ProofLink key={p.url} open={p} className="no-underline">
            <Chip tone={prTone(p.state)} solid={p.state === "merged"} data-flow-pr={p.state}>
              #{p.number ?? "?"} {p.state}
            </Chip>
          </ProofLink>
        ))}
        {resolved ? (
          <Chip tone={RESOLVED} data-flow-resolved="">
            ✓
          </Chip>
        ) : null}
      </div>
      {lane?.agent.branch && r.live ? (
        <div className="orch-mono orch-muted mt-0.5 truncate text-xs" title="branch" style={{ paddingLeft: lane ? 30 : 0 }}>
          {lane.agent.branch}
        </div>
      ) : null}
    </li>
  );
}

function Flow({ h, lanes }: { h: Hist; lanes: Map<string, Lane> }) {
  const lead = h.rows.find((r) => r.role === "lead");
  const kids = h.rows.filter((r) => r !== lead);
  // threads its lead started hang under it; any started elsewhere (by the owner, by hand) are listed apart
  const mine = kids.filter((r) => !lead || r.parent === lead.address);
  const others = kids.filter((r) => lead && r.parent !== lead.address);
  const live = mine.filter((r) => r.live);
  const done = mine.filter((r) => !r.live).reverse();
  const [all, setAll] = useState(false);
  const shownDone = all ? done : done.slice(0, 6);
  return (
    <div data-flow-view="" className="flex flex-col gap-1">
      {lead ? (
        <ul className="m-0 list-none p-0">
          <FlowNode r={lead} lane={lanes.get(lead.address)} depth={0} />
        </ul>
      ) : null}
      {/* the threads sit indented under their lead, with no rail: no vertical bars on Projects (2026-11-16, the owner) */}
      <ul className="m-0 list-none p-0" style={{ marginLeft: 24 }}>
        {[...live, ...shownDone].map((r) => (
          <FlowNode key={r.address} r={r} lane={lanes.get(r.address)} depth={1} />
        ))}
      </ul>
      {others.length ? (
        <>
          <p className="orch-muted m-0 mt-2 text-xs">Started elsewhere</p>
          <ul className="m-0 list-none p-0">
            {others.map((r) => (
              <FlowNode key={r.address} r={r} lane={lanes.get(r.address)} depth={0} />
            ))}
          </ul>
        </>
      ) : null}
      {done.length > shownDone.length ? (
        <div>
          <Btn tone="ghost" data-flow-more="" onClick={() => setAll(true)}>
            {done.length - shownDone.length} more finished
          </Btn>
        </div>
      ) : null}
      {kids.length === 0 ? <p className="orch-muted m-0 text-xs">No threads yet.</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------- Dependencies

const DEP_TONE: Record<Dep["kind"], Tone> = {
  hold: KIND_TONES.alarm,
  card: ASK,
  held: KIND_TONES.deferred,
  deferred: KIND_TONES.deferred,
  dead: KIND_TONES.dead,
  reply: KIND_TONES.message,
  pr: PR,
  ci: PR,
  review: PR,
};
const DEP_VERB: Record<Dep["kind"], string> = { hold: "on hold", card: "card", held: "queued card", deferred: "deferred", dead: "undelivered", reply: "reply", pr: "PR", ci: "CI", review: "review" };

function onName(on: string, ownerName: string): string {
  if (on === "owner") return ownerName;
  if (on === "pr") return "PR";
  if (on === "ci") return "CI";
  if (on === "review") return "Review";
  if (on === "cos") return "CoS";
  return rowName(on);
}
const onTone = (on: string): Tone => (on === "owner" ? ROLE_TONES.person : on === "pr" || on === "ci" || on === "review" ? PR : (ROLE_TONES[roleOf(on) ?? "system"] ?? ROLE_TONES.system));

function Dependencies({ deps, width, now, ownerName, openCard }: { deps: Dep[]; width: number; now: number; ownerName: string; openCard: OpenCard }) {
  if (deps.length === 0) return <EmptyState data-deps-empty="" title="Nothing waits" text="No card, reply, PR or hold is holding anyone up." icon={null} />;
  const p = placeDeps(deps, width);
  const nodeH = 36;
  const blockers = deps.filter((d) => d.block).length;
  return (
    <div data-deps="" className="flex flex-col gap-2">
      <svg width={width} height={p.height} role="img" aria-label="What waits on what" className="block">
        {p.left.map(({ dep, y }, i) => {
          const r = p.right.find((x) => x.on === dep.on)!;
          const x1 = p.leftW;
          const y1 = y + nodeH / 2;
          const x2 = p.rightX;
          const y2 = r.y + nodeH / 2;
          const mx = (x1 + x2) / 2;
          return (
            <path
              key={i}
              data-edge={dep.kind}
              d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2 - 6} ${y2} M ${x2 - 11} ${y2 - 4} L ${x2 - 5} ${y2} L ${x2 - 11} ${y2 + 4}`}
              fill="none"
              strokeWidth={dep.block ? 2 : 1.25}
              strokeDasharray={dep.kind === "deferred" || dep.kind === "held" ? "4 3" : undefined}
              style={stroke(DEP_TONE[dep.kind])}
            />
          );
        })}
        {p.left.map(({ dep, y }, i) => {
          const role = roleOf(dep.from);
          const tone = role ? ROLE_TONES[role] : ROLE_TONES.system;
          // a held card isn't on Needs you yet (it waits behind another): nothing to scroll to
          const clickable = dep.on === "owner" && dep.ref && (dep.kind === "card" || dep.kind === "deferred");
          const body = (
            <g data-dep={dep.kind} data-dep-block={dep.block ? "true" : "false"} className={clickable ? "cursor-pointer" : undefined} onClick={clickable ? () => openCard(`[data-card="${dep.ref}"]`) : undefined}>
              <title>{`${dep.from} waits on ${onName(dep.on, ownerName)}: ${dep.label}`}</title>
              <rect x={0.5} y={y + 0.5} width={p.leftW - 1} height={nodeH} rx={8} style={{ fill: tint(DEP_TONE[dep.kind]), stroke: `color-mix(in srgb, ${css(DEP_TONE[dep.kind])} ${dep.block ? 70 : 30}%, transparent)` }} />
              <text x={10} y={y + 14} style={{ fontSize: 11, fontWeight: 600, fill: css(tone) }}>
                {dep.kind === "hold" ? "project" : dep.from === "owner" ? ownerName : rowName(dep.from)}
                <tspan style={{ fill: css(DEP_TONE[dep.kind]), fontWeight: 500 }}> · {DEP_VERB[dep.kind]}</tspan>
                {dep.since ? <tspan style={{ fill: "var(--orch-muted)", fontWeight: 400 }}> · {age(dep.since, now)}</tspan> : null}
              </text>
              <text x={10} y={y + 28} style={{ fontSize: 11, fill: "currentColor" }}>
                {fit(dep.label, p.leftW - 20)}
              </text>
            </g>
          );
          return <g key={i}>{body}</g>;
        })}
        {p.right.map((r) => {
          const t = onTone(r.on);
          return (
            <g key={r.on} data-dep-on={r.on}>
              <rect x={p.rightX + 0.5} y={r.y + 0.5} width={p.rightW - 1} height={nodeH} rx={nodeH / 2} style={{ fill: css(t) }} />
              <text x={p.rightX + p.rightW / 2} y={r.y + nodeH / 2 + 4} textAnchor="middle" style={{ fontSize: 12, fontWeight: 600, fill: "Canvas" }}>
                {fit(onName(r.on, ownerName), p.rightW - 16)}
                {r.n > 1 ? ` ×${r.n}` : ""}
              </text>
            </g>
          );
        })}
      </svg>
      {blockers ? (
        <p className="orch-muted m-0 text-xs">
          {blockers} {blockers === 1 ? "blocker" : "blockers"} at the top{deps.some((d) => d.on === "owner" && d.kind === "card") ? `; tap a card to answer it` : ""}.
        </p>
      ) : null}
    </div>
  );
}

/** Cut text to about `px` at 11px type (6px a character), with an ellipsis. */
function fit(s: string, px: number): string {
  const n = Math.max(4, Math.floor(px / 6));
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/** The lanes' waits the history can't see: an agent waiting on a bb prompt (answered in its thread). */
function withPrompts(deps: Dep[], lanes: Lane[]): Dep[] {
  const extra: Dep[] = lanes
    .filter((l) => l.wait?.on === "owner" && !l.wait.cardId)
    .map((l) => ({ from: l.agent.address, on: "owner", kind: "card" as const, label: "a prompt in its thread", since: l.since, ref: null, block: true }));
  return extra.length ? [...extra, ...deps] : deps;
}

/** One part of the project's page, on the same scroll (no view switch since 2026-11-20). */
function DetailSection({ name, title, count, children }: { name: string; title: string; count?: number; children: ReactNode }) {
  return (
    <section data-detail-view={name} aria-label={title} className="flex min-w-0 flex-col gap-2">
      <h3 className="m-0 flex items-center gap-2 text-sm font-semibold">
        {title}
        {count ? <Badge variant="secondary" className="h-5 min-w-5 rounded-full px-1.5 tabular-nums">{count}</Badge> : null}
      </h3>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------- the page

/** Pathways, a section of the project's page (2026-11-20): closed until opened, since it reads Linear; a Pathways link opens it. */
export function PathwaysPart({ slug, narrow, open: first = false }: { slug: string; narrow?: boolean; open?: boolean }) {
  const [open, setOpen] = useState(first);
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    if (first) box.current?.scrollIntoView({ block: "start" });
  }, [first]);
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section ref={box} data-detail-view="pathways" aria-label="Pathways" className="flex min-w-0 flex-col gap-2">
        <h3 className="m-0 text-sm font-semibold">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="-ml-2 h-7 gap-1 px-2 text-sm font-semibold has-[>svg]:px-2" data-pathways-toggle={slug}>
              Pathways
              {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
            </Button>
          </CollapsibleTrigger>
        </h3>
        <CollapsibleContent>{open ? <PathwaysSection slug={slug} narrow={narrow} /> : null}</CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/** Timeline, Flow and Dependencies: on the project's page (web), and under the book on a phone's project page. */
export function ProjectSections({ project, lanes, openCard, ownerName }: { project: Projects[number]; lanes: Lane[] | undefined; openCard: OpenCard; ownerName: string }) {
  const q = experimental_useRpcQuery({ contract: rpcContract, method: "projectHistory", input: { slug: project.slug } });
  const refetch = useRef(q.refetch);
  refetch.current = q.refetch;
  useChangeNotice(
    useCallback((n: unknown) => void (touches(n, "projectHistory") && refetch.current()), []),
  );
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const laneOf = new Map((lanes ?? []).map((l) => [l.agent.address, l] as const));
  const h = q.data;
  const deps = h ? withPrompts(h.deps, lanes ?? []) : [];
  const blocking = deps.filter((d) => d.block).length;
  return (
    <div ref={box} className="flex min-w-0 flex-col gap-6" data-project-sections={project.slug}>
      {!h ? (
        <ReadState q={q} what="the history" />
      ) : (
        <>
          <DetailSection name="timeline" title="Timeline">
            {width === 0 ? null : <Timeline h={h} width={width} lanes={laneOf} />}
          </DetailSection>
          <DetailSection name="flow" title="Flow">
            <Flow h={h} lanes={laneOf} />
          </DetailSection>
          <DetailSection name="deps" title="Dependencies" count={blocking}>
            {width === 0 ? null : <Dependencies deps={deps} width={width} now={h.now} ownerName={ownerName} openCard={openCard} />}
          </DetailSection>
        </>
      )}
    </div>
  );
}

/** The project's page on web (projects/<slug>, or an old pathways/<slug> with Pathways open): its history, then Pathways. */
export function ProjectDetail({ project, lanes, onBack, openCard, ownerName, pathwaysOpen = false }: { project: Projects[number]; lanes: Lane[] | undefined; onBack: () => void; openCard: OpenCard; ownerName: string; pathwaysOpen?: boolean }) {
  const now = useMinute();
  const { cosTitle } = useIdentity();
  const lead = project.lead;
  return (
    <div data-project-detail={project.slug} data-accent={project.monType ?? undefined} className="flex min-w-0 flex-col gap-3 pb-8" style={accentVars(project.monType)}>
      {/* 2026-11-17: no accent bar under the head (the kept rule); the project's colour stays on its name */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Btn tone="ghost" data-detail-back="" onClick={onBack} aria-label="Back to Projects">
          ← Projects
        </Btn>
        {lead ? <AgentFace face={lead} address={lead.address} size={28} /> : null}
        <span className="min-w-0 font-semibold [overflow-wrap:anywhere]" style={accentTone(project.monType) ? { color: ACCENT } : undefined}>
          {project.slug}
        </span>
        {project.heldAt !== null ? <Kind of="held">On hold</Kind> : null}
      </div>
      <StatusBar status={project.status} ownerName={ownerName} lanes={lanes} openCard={openCard} />
      <AllWaits waits={project.summary?.waits ?? []} now={now} cos={cosTitle} />
      <ProjectSections project={project} lanes={lanes} openCard={openCard} ownerName={ownerName} />
      <PathwaysPart slug={project.slug} open={pathwaysOpen} />
    </div>
  );
}
