// The visual blocks of a deliverable (and a card), on shadcn/ui (2026-11-17; before that affectUI's Change Summary).
// Each block is a Card: a heading row (icon, title, a quiet note on the right), then its rows as Items under hairlines,
// or a Table for label and value pairs. A row's mark is a small tinted square and a status is a Badge, both in the kind
// colours of palette.ts. The diagram keeps its own geometry (a plan exception); only its frame and colours changed.
import { styleHref } from "./style-href.ts";
import type { CSSProperties, ReactNode } from "react";
import { BarChart3, CheckCheck, CircleCheck, GitPullRequest, Minus, PencilLine, Search, Check, Workflow, X } from "lucide-react";
import type { Block, Point } from "../blocks.ts";
import { BOX_W, BOX_W_MAX, layout } from "./diagram-layout.ts";
import { ProofLink } from "./proof-link.tsx";
import { KIND_TONES, css, tint, type KindKey } from "./palette.ts";
import { Card } from "./ui/card.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle, WITH_DESCRIPTION } from "./ui/item.tsx";
import { Table, TableBody, TableCell, TableRow } from "./ui/table.tsx";
import { cn } from "./ui/utils.ts";
import { Kind, Tag } from "./ui.tsx";

type B<K extends Block["kind"]> = Extract<Block, { kind: K }>;

/** A screenshot, a video or a verdict tile: the same bordered card as the blocks (deliverables.tsx uses it too). */
export const SHOT = "overflow-hidden rounded-lg border bg-card shadow-xs";
/** Two or more screenshots side by side, as wide as they fit. */
export const GALLERY = "grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] items-start";

const ICONS = { decisions: CheckCheck, changes: PencilLine, checks: CircleCheck, verdicts: GitPullRequest, facts: BarChart3, rca: Search, diagram: Workflow };

const MARK = { good: { tone: KIND_TONES.done, Icon: Check }, bad: { tone: KIND_TONES.alarm, Icon: X }, neutral: { tone: KIND_TONES.inactive, Icon: Minus } } as const;
function Mark({ tone, hidden }: { tone: "good" | "bad" | "neutral"; hidden?: boolean }) {
  const { tone: t, Icon } = MARK[tone];
  return (
    <span data-mark-tone={tone} aria-hidden="true" className={cn("inline-flex size-5 flex-none items-center justify-center rounded-md", hidden && "invisible")} style={{ background: tint(t), color: css(t) }}>
      <Icon className="size-3" strokeWidth={2.25} />
    </span>
  );
}

/** A status: a kind-coloured Badge (palette.ts); info and neutral are bb's plain badge (bb has no info colour). */
type Tone = "success" | "warning" | "danger" | "info" | "neutral";
const TONE_KIND: Partial<Record<Tone, KindKey>> = { success: "done", warning: "deferred", danger: "alarm" };
function Status({ tone, children }: { tone: Tone; children: string }) {
  const k = TONE_KIND[tone];
  return k ? (
    <Kind of={children} group={k}>
      {children}
    </Kind>
  ) : (
    <Tag>{children}</Tag>
  );
}

/** A block's Card: the heading row, then the rows under a hairline. */
function Panel({ kind, title, note, children }: { kind: keyof typeof ICONS; title: string; note?: ReactNode; children: ReactNode }) {
  const Icon = ICONS[kind];
  return (
    <Card role="region" aria-label={title} data-block={kind} className="gap-0 overflow-hidden py-0">
      {/* a note that doesn't fit beside the title takes its own row (2026-11-21: a diagram's legend ran past a phone's card) */}
      <div className="flex min-h-11 flex-wrap items-center gap-2 px-4 py-2">
        <Icon className="size-4 flex-none text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 basis-32 text-sm font-semibold [overflow-wrap:anywhere]">{title}</span>
        {note ? <span className="ml-auto inline-flex max-w-full flex-wrap items-center justify-end gap-1.5 text-xs text-muted-foreground">{note}</span> : null}
      </div>
      <div className="divide-y border-t">{children}</div>
    </Card>
  );
}

/** A row: what (wrapping, medium), a quiet second line, and a badge or mark at the end. */
function Row({ lead, text, sub, end, data }: { lead?: ReactNode; text: ReactNode; sub?: ReactNode; end?: ReactNode; data?: Record<string, string> }) {
  return (
    <Item size="sm" className="min-h-12 flex-nowrap rounded-none px-4 py-2.5" {...data}>
      {lead ? <ItemMedia className={sub ? WITH_DESCRIPTION : undefined}>{lead}</ItemMedia> : null}
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="w-auto font-medium [overflow-wrap:anywhere]">{text}</ItemTitle>
        {sub ? <ItemDescription className="line-clamp-none text-xs text-pretty [overflow-wrap:anywhere]">{sub}</ItemDescription> : null}
      </ItemContent>
      {end ? <ItemActions>{end}</ItemActions> : null}
    </Item>
  );
}

/** Label and value pairs: a Table. */
function Pairs({ rows }: { rows: { key: string | number; label: string; value: ReactNode; data?: Record<string, string> }[] }) {
  return (
    <Table>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key} className="hover:bg-transparent" {...r.data}>
            <TableCell className="w-2/5 px-4 py-2.5 align-top whitespace-normal text-muted-foreground [overflow-wrap:anywhere]">{r.label}</TableCell>
            <TableCell className="px-4 py-2.5 align-top whitespace-normal [overflow-wrap:anywhere]">{r.value}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const DECIDED = { made: { label: "Decided", tone: "success" }, proposed: { label: "Proposed", tone: "info" }, needs_you: { label: "Needs you", tone: "warning" } } as const;

export function Decisions({ b }: { b: B<"decisions"> }) {
  return (
    <Panel kind="decisions" title={b.title ?? "Decisions"}>
      {b.items.map((d, i) => (
        <Row key={i} data={{ "data-decision": d.status }} text={d.text} sub={d.why} end={<Status tone={DECIDED[d.status].tone}>{DECIDED[d.status].label}</Status>} />
      ))}
    </Panel>
  );
}

const LEVEL = { must: { label: "Must", tone: "danger" }, should: { label: "Should", tone: "warning" }, nit: { label: "Nit", tone: "neutral" } } as const;

export function Changes({ b }: { b: B<"changes"> }) {
  const order = { must: 0, should: 1, nit: 2 } as const;
  const items = [...b.items].sort((x, y) => order[x.level] - order[y.level]);
  const counts = (["must", "should", "nit"] as const).map((l) => [l, b.items.filter((c) => c.level === l).length] as const).filter(([, n]) => n > 0);
  return (
    <Panel kind="changes" title={b.title ?? "What to change"} note={counts.map(([l, n]) => `${n} ${l}`).join(" · ")}>
      {items.map((c, i) => (
        <Row key={i} data={{ "data-change-level": c.level }} text={c.text} sub={c.where ? <span className="orch-mono">{c.where}</span> : undefined} end={<Status tone={LEVEL[c.level].tone}>{LEVEL[c.level].label}</Status>} />
      ))}
    </Panel>
  );
}

export function Checks({ b }: { b: B<"checks"> }) {
  const passed = b.items.filter((c) => c.ok).length;
  return (
    <Panel kind="checks" title={b.title ?? "Checks"} note={`${passed} of ${b.items.length} passed`}>
      {b.items.map((c, i) => (
        <Row key={i} data={{ "data-check": c.ok ? "ok" : "fail" }} lead={<Mark tone={c.ok ? "good" : "bad"} />} text={c.text} sub={c.how} />
      ))}
    </Panel>
  );
}

const FACT = { good: "good", bad: "bad", warn: "neutral" } as const;

export function Facts({ b }: { b: B<"facts"> }) {
  // when some values carry a mark, the others keep its space so the values line up
  const toned = b.items.some((f) => f.tone);
  return (
    <Panel kind="facts" title={b.title ?? "Facts"}>
      <Pairs
        rows={b.items.map((f, i) => ({
          key: i,
          label: f.label,
          value: (
            <span className="flex items-start gap-2">
              {f.tone ? <Mark tone={FACT[f.tone]} /> : toned ? <Mark tone="neutral" hidden /> : null}
              <span className="min-w-0">{f.value}</span>
            </span>
          ),
        }))}
      />
    </Panel>
  );
}

export function Rca({ b }: { b: B<"rca"> }) {
  const rows = [
    { key: "symptom", label: "Symptom", text: b.symptom, tone: "bad" as const },
    { key: "cause", label: "Root cause", text: b.cause, sub: b.evidence ? `Evidence: ${b.evidence}` : undefined, tone: "neutral" as const },
    { key: "fix", label: "Fix", text: b.fix, tone: "good" as const },
  ];
  return (
    <Panel kind="rca" title="Root cause" note={<Status tone={b.status === "fixed" ? "success" : "info"}>{b.status === "fixed" ? "Fixed" : "Fix proposed"}</Status>}>
      <Pairs
        rows={rows.map((r) => ({
          key: r.key,
          label: r.label,
          data: { "data-rca": r.key },
          value: (
            <span className="flex items-start gap-2">
              <Mark tone={r.tone} />
              <span className="min-w-0">
                <span className="block font-medium">{r.text}</span>
                {r.sub ? <span className="block text-xs text-muted-foreground">{r.sub}</span> : null}
              </span>
            </span>
          ),
        }))}
      />
    </Panel>
  );
}

/* ---------- Less text (2026-11-14): a PR review as tiles, then each decision and finding in one line ---------- */

const VERDICT = { good: "success", warn: "warning", bad: "danger" } as const;
const BAR = { good: "bg-(--success)", warn: "bg-(--warning)", bad: "bg-destructive", none: "bg-muted-foreground" } as const;
const prNo = (url: string) => url.match(/\/pull\/(\d+)/)?.[1] ?? null;

/** The picture first: one bar of the verdict mix, then a tile per PR with its verdict. */
export function Verdicts({ b }: { b: B<"verdicts"> }) {
  const ready = b.items.filter((v) => v.tone === "good").length;
  return (
    <Panel kind="verdicts" title={b.title ?? `${b.items.length} PR${b.items.length === 1 ? "" : "s"}`} note={`${ready} ready`}>
      <div className="px-4 pt-3 pb-4">
        <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" data-verdict-bar="">
          {b.items.map((v, i) => (
            <span key={i} data-tone={v.tone ?? "none"} className={cn("flex-1", BAR[v.tone ?? "none"])} title={`${prNo(v.url) ? `#${prNo(v.url)} · ` : ""}${v.verdict}`} />
          ))}
        </div>
        <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
          {b.items.map((v, i) => (
            <ProofLink key={i} open={{ url: v.url }} data-verdict={prNo(v.url) ?? i} className={cn(SHOT, "grid gap-1.5 px-3 py-2.5 text-inherit no-underline hover:bg-accent")}>
              <span className="font-semibold tabular-nums">{prNo(v.url) ? `#${prNo(v.url)}` : "PR"}</span>
              <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{v.name}</span>
              <span>
                <Status tone={v.tone ? VERDICT[v.tone] : "neutral"}>{v.verdict}</Status>
              </span>
            </ProofLink>
          ))}
        </div>
      </div>
    </Panel>
  );
}

const POINT_MARK = { good: "good", warn: "neutral", bad: "bad" } as const;

/** A deliverable's points: Decisions, then Findings, each one plain line with its why under it. */
export function Points({ points }: { points: readonly Point[] }) {
  const decisions = points.filter((p) => p.kind === "decision");
  const findings = points.filter((p) => p.kind === "finding");
  return (
    <div data-points="" className="grid gap-3">
      {decisions.length > 0 ? (
        <Panel kind="decisions" title="Decisions">
          {decisions.map((p, i) => (
            <Row key={i} data={{ "data-point": "decision" }} lead={p.tone ? <Mark tone={POINT_MARK[p.tone]} /> : undefined} text={p.headline} sub={p.why} />
          ))}
        </Panel>
      ) : null}
      {findings.length > 0 ? (
        <Panel kind="rca" title="Findings">
          {findings.map((p, i) => (
            <Row key={i} data={{ "data-point": "finding" }} lead={<Mark tone={p.tone ? POINT_MARK[p.tone] : "neutral"} />} text={p.headline} sub={p.why} />
          ))}
        </Panel>
      ) : null}
    </div>
  );
}

/* ---------- Diagram: its own geometry (a plan exception); the boxes are small cards in bb's colours ---------- */

const CHANGE = { added: { label: "Added", tone: "success", glyph: "M4 8h8M8 4v8" }, changed: { label: "Changed", tone: "info", glyph: "M4 6.5h8M4 9.5h8" }, removed: { label: "Removed", tone: "danger", glyph: "M4 8h8" }, same: { label: "Unchanged", tone: "neutral", glyph: "" } } as const;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// a 13px label runs about 6.8px a character (measured: 134px for 20); a box keeps 34px in front for its mark, 12 behind
const LABEL_PX = 6.8;
const fits = (w: number, marked: boolean, px: number) => Math.floor((w - (marked ? 34 : 12) - 12) / px + 0.05);

export function Diagram({ b }: { b: B<"diagram"> }) {
  const want = Math.max(...b.nodes.map((n) => n.label.length * LABEL_PX + (n.change !== "same" ? 34 : 12) + 12));
  const boxW = Math.ceil(Math.min(BOX_W_MAX, Math.max(BOX_W, want)));
  const { boxes, lines, width, height } = layout(b.nodes, b.edges, b.direction, boxW);
  const used = (["added", "changed", "removed"] as const).filter((c) => b.nodes.some((n) => n.change === c) || b.edges.some((e) => e.change === c));
  const mid = `orch-dg-${b.nodes.map((n) => n.id).join("-").slice(0, 40)}`;
  return (
    <Panel
      kind="diagram"
      title={b.title ?? "Diagram"}
      note={
        used.length ? (
          <span className="inline-flex flex-wrap justify-end gap-1.5">
            {used.map((c) => (
              <Status key={c} tone={CHANGE[c].tone}>
                {CHANGE[c].label}
              </Status>
            ))}
          </span>
        ) : undefined
      }
    >
      <div className="orch-dg" style={DG}>
        {/* fits the pane down to 3/4 size, then scrolls sideways rather than shrink the text further */}
        <svg role="img" aria-label={b.title ?? "Diagram"} viewBox={`0 0 ${width} ${height}`} className="block h-auto" style={{ width: "100%", maxWidth: width, minWidth: Math.round(width * 0.75) }}>
          <defs>
            {(Object.keys(CHANGE) as (keyof typeof CHANGE)[]).map((c) => (
              <marker key={c} id={`${mid}-${c}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="orch-dg__head" data-change={c} />
              </marker>
            ))}
          </defs>
          {lines.map((l, i) => (
            <g key={i} data-edge={`${l.from}->${l.to}`}>
              <path d={l.path} className="orch-dg__edge" data-change={l.change} markerEnd={`url(#${mid}-${l.change})`} />
              {l.label ? (
                <text x={l.lx} y={l.ly - 5} textAnchor="middle" className="orch-dg__edge-label">
                  {clip(l.label, 20)}
                </text>
              ) : null}
            </g>
          ))}
          {boxes.map((n) => (
            <g key={n.id} data-node={n.id} data-change={n.change}>
              <rect x={n.x} y={n.y} width={n.w} height={n.h} rx="8" className="orch-dg__box" data-change={n.change} />
              {n.change !== "same" ? (
                <g transform={`translate(${n.x + 10}, ${n.y + (n.h - 16) / 2})`}>
                  <rect width="16" height="16" rx="4" className="orch-dg__mark" data-change={n.change} />
                  <path d={CHANGE[n.change].glyph} transform="scale(1)" className="orch-dg__glyph" data-change={n.change} />
                </g>
              ) : null}
              <text x={n.x + (n.change !== "same" ? 34 : 12)} y={n.y + (n.note ? 22 : 30)} className="orch-dg__label" data-change={n.change}>
                {clip(n.label, fits(n.w, n.change !== "same", LABEL_PX))}
              </text>
              {n.note ? (
                <text x={n.x + (n.change !== "same" ? 34 : 12)} y={n.y + 38} className="orch-dg__note">
                  {clip(n.note, fits(n.w, n.change !== "same", 6.2))}
                </text>
              ) : null}
              <title>{`${n.label}${n.note ? `: ${n.note}` : ""} (${CHANGE[n.change].label.toLowerCase()})`}</title>
            </g>
          ))}
        </svg>
      </div>
    </Panel>
  );
}

/** The diagram's colours: the kind colours of palette.ts (added is "answered" green, changed "link" blue, removed "alarm" red). */
const DG = {
  "--orch-dg-added": css(KIND_TONES.done),
  "--orch-dg-added-bg": tint(KIND_TONES.done),
  "--orch-dg-changed": css(KIND_TONES.link),
  "--orch-dg-changed-bg": tint(KIND_TONES.link),
  "--orch-dg-removed": css(KIND_TONES.alarm),
  "--orch-dg-removed-bg": tint(KIND_TONES.alarm),
} as CSSProperties;

/** The diagram's styles (mounted once by app.tsx): everything else in these blocks is Tailwind on app/ui. */
export function VisualBlocksStyle() {
  return (
    <style href={styleHref("orch-visual-blocks", visualCss)} precedence="default">
      {visualCss}
    </style>
  );
}

const visualCss = /* css */ `
[data-orch] .orch-dg { --orch-dg-line: color-mix(in srgb, var(--foreground) 28%, transparent); overflow-x: auto; padding: 14px 16px 16px; }
[data-orch] .orch-dg__box { fill: var(--card); stroke: var(--border); stroke-width: 1; }
[data-orch] .orch-dg__box[data-change="added"] { stroke: var(--orch-dg-added); }
[data-orch] .orch-dg__box[data-change="changed"] { stroke: var(--orch-dg-changed); }
[data-orch] .orch-dg__box[data-change="removed"] { stroke: var(--orch-dg-removed); stroke-dasharray: 4 3; }
[data-orch] .orch-dg__mark[data-change="added"] { fill: var(--orch-dg-added-bg); }
[data-orch] .orch-dg__mark[data-change="changed"] { fill: var(--orch-dg-changed-bg); }
[data-orch] .orch-dg__mark[data-change="removed"] { fill: var(--orch-dg-removed-bg); }
[data-orch] .orch-dg__glyph { fill: none; stroke-width: 1.4; stroke-linecap: round; }
[data-orch] .orch-dg__glyph[data-change="added"] { stroke: var(--orch-dg-added); }
[data-orch] .orch-dg__glyph[data-change="changed"] { stroke: var(--orch-dg-changed); }
[data-orch] .orch-dg__glyph[data-change="removed"] { stroke: var(--orch-dg-removed); }
[data-orch] .orch-dg__label { font-size: 13px; font-weight: 500; fill: var(--foreground); }
[data-orch] .orch-dg__label[data-change="removed"] { text-decoration: line-through; fill: var(--muted-foreground); }
[data-orch] .orch-dg__note { font-size: 12px; fill: var(--muted-foreground); }
[data-orch] .orch-dg__edge { fill: none; stroke: var(--orch-dg-line); stroke-width: 1; }
[data-orch] .orch-dg__edge[data-change="added"] { stroke: var(--orch-dg-added); }
[data-orch] .orch-dg__edge[data-change="changed"] { stroke: var(--orch-dg-changed); }
[data-orch] .orch-dg__edge[data-change="removed"] { stroke: var(--orch-dg-removed); stroke-dasharray: 4 3; }
[data-orch] .orch-dg__head { fill: var(--orch-dg-line); }
[data-orch] .orch-dg__head[data-change="added"] { fill: var(--orch-dg-added); }
[data-orch] .orch-dg__head[data-change="changed"] { fill: var(--orch-dg-changed); }
[data-orch] .orch-dg__head[data-change="removed"] { fill: var(--orch-dg-removed); }
[data-orch] .orch-dg__edge-label { font-size: 11px; fill: var(--muted-foreground); paint-order: stroke; stroke: var(--card); stroke-width: 4px; }
`;
