// Small shared pieces, built on shadcn/ui (app/ui, since 2026-11-17): buttons, badges for kinds, avatars for roles,
// card sections, empty, error and loading states, and time formatting. Their props are unchanged, so no call site moved.
// Colours for roles and kinds come from palette.ts; everything else is bb's own tokens.
import { styleHref } from "./style-href.ts";
import type { ButtonHTMLAttributes, ComponentProps, CSSProperties, ReactNode } from "react";
import { FileText } from "lucide-react";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { Avatar, AvatarFallback } from "./ui/avatar.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { cn } from "./ui/utils.ts";
import { gate } from "./store.ts";
import { KIND_TONES, ROLE_TONES, css, kindOf, roleOf, tint, type KindKey } from "./palette.ts";
import { ownerOnScreen } from "../core/owner.ts";
import { useIdentity } from "./identity.ts";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/**
 * The page's own CSS, unlayered, scoped by [data-orch] (the panel).
 * - 2026-11-17: the page's ink, muted text, hairline and danger are bb's tokens, in both themes; its wash is 5% of bb's ink
 *   (bb's own hover wash, 13.8% in dark, would take tinted words on a hovered row under 4.5:1).
 */
const LOOK = `
[data-orch] {
  --orch-ink: var(--foreground);
  --orch-muted: var(--muted-foreground);
  --orch-line: var(--border);
  --orch-wash: color-mix(in srgb, var(--foreground) 5%, transparent);
  --orch-danger: var(--destructive-text, var(--destructive));
  font-family: "Inter", "InterVariable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 20px;
  color: var(--orch-ink);
  -webkit-font-smoothing: antialiased;
}
[data-orch] .orch-muted { color: var(--orch-muted); }
[data-orch] .orch-danger { color: var(--orch-danger); }
[data-orch] .orch-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
/* a phone card is 12 px in, not 24, inside the 16 px gutter; only wide insets (by class token) shrink, web unchanged */
[data-orch][data-phone] [data-slot="card"]:is([class~="py-5"], [class~="py-6"]) { padding-block: 12px; }
[data-orch][data-phone] [data-slot="card"]:is([class~="p-4"], [class~="p-5"], [class~="p-6"]) { padding: 12px; }
[data-orch][data-phone] [data-slot="card"]:is([class~="gap-4"], [class~="gap-5"], [class~="gap-6"]) { gap: 12px; }
[data-orch][data-phone] :is([data-slot="card-header"], [data-slot="card-content"], [data-slot="card-footer"]):is([class~="px-4"], [class~="px-5"], [class~="px-6"]) { padding-inline: 12px; }
[data-orch][data-phone] [data-legend] [data-slot="badge"] { white-space: normal; max-width: 100%; }
[data-orch][data-phone] [data-multiplayer] { padding-inline: 0; padding-top: 0; }
/* a card's asker when it is its project's lead says the project twice (2026-11-20, less text): a phone drops it */
[data-orch][data-phone] [data-origin-lead] { display: none; }
`;
export function Look() {
  return (
    <style href={styleHref("orch-look", LOOK)} precedence="default">
      {LOOK}
    </style>
  );
}

const VARIANT = { primary: "default", outline: "outline", ghost: "ghost", danger: "destructive" } as const;
const SIZE = { sm: "sm", md: "default", lg: "lg" } as const;
const ICON_SIZE = { sm: "icon-sm", md: "icon", lg: "icon-lg" } as const;
/**
 * shadcn's Button. Disabled stays a real `disabled` that still takes the pointer (shadcn's pointer-events-none would let
 * a click on it fall through to the card or row below it). An icon with no words is a square icon button.
 */
export function Btn({ tone = "outline", size = "md", icon, children, className, type = "button", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: keyof typeof VARIANT; size?: "sm" | "md" | "lg"; icon?: ReactNode; ref?: ComponentProps<"button">["ref"]; [data: `data-${string}`]: string | undefined }) {
  const iconOnly = icon != null && (children == null || children === false || children === "");
  return (
    <Button type={type} variant={VARIANT[tone]} size={iconOnly ? ICON_SIZE[size] : SIZE[size]} className={cn("disabled:pointer-events-auto disabled:cursor-default", className)} {...p}>
      {icon}
      {children}
    </Button>
  );
}

/** A plain label (no colour group): shadcn's secondary badge. */
export function Tag({ children, ...p }: { children: ReactNode; [data: `data-${string}`]: string | undefined }) {
  return (
    <Badge variant="secondary" {...p}>
      {children}
    </Badge>
  );
}

/**
 * A kind or state (a raw string from the server) as a badge in its kind's colour (its tint behind its word), with a dot.
 * Unknown kinds stay neutral. `group` picks the colour group directly (a PR chip's colour is worked out from several fields).
 */
export function Kind({ of, group, children, ...p }: { of: string; group?: KindKey; children?: ReactNode; [data: `data-${string}`]: string | undefined }) {
  const kind = group ?? kindOf(of);
  const tone = kind ? KIND_TONES[kind] : null;
  const style = tone ? ({ background: tint(tone), color: css(tone) } as CSSProperties) : undefined;
  return (
    <Badge variant="secondary" style={style} {...p}>
      {tone ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" /> : null}
      {children ?? of}
    </Badge>
  );
}

/** An address (or role or level) in its role's colour: an avatar (the role's initial, the owner's) and the words. */
export function Who({ address, children, nowrap }: { address: string | null | undefined; children?: ReactNode; nowrap?: boolean }) {
  const role = roleOf(address);
  const tone = role ? ROLE_TONES[role] : null;
  const color = tone ? css(tone) : undefined;
  const { ownerName } = useIdentity();
  const initial = role === "person" ? ownerOnScreen(ownerName).Name.slice(0, 1) : tone ? tone.label.slice(0, 1).toUpperCase() : "";
  return (
    <span className={cx("orch-mono inline-flex min-w-0 items-center gap-1.5", nowrap ? "whitespace-nowrap" : "[overflow-wrap:anywhere]")} style={{ color }}>
      {tone ? (
        <Avatar size="20" aria-hidden>
          <AvatarFallback className="font-medium" style={{ background: tint(tone), color }}>
            {initial}
          </AvatarFallback>
        </Avatar>
      ) : null}
      {children ?? address ?? "—"}
    </span>
  );
}

/** A section: a shadcn card with a title, its count, and the content. */
export function Section({ title, count, children, ...p }: { title: string; count?: number; children: ReactNode; [data: `data-${string}`]: string | undefined }) {
  return (
    <Card {...p}>
      <CardHeader>
        <CardTitle role="heading" aria-level={3}>
          {title}
        </CardTitle>
        {count !== undefined ? (
          <CardAction>
            <Tag>{count}</Tag>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/**
 * The empty state (2026-11-17: shadcn's Empty, behind affectUI's props). `icon` defaults to a file and null shows no
 * tile; `bare` drops the frame; `tall` fills the parent's height.
 */
export function EmptyState({ title, text, action, icon = <FileText />, bare, tall, className, ...p }: Omit<ComponentProps<"div">, "title"> & { title: ReactNode; text?: ReactNode; action?: ReactNode; icon?: ReactNode; bare?: boolean; tall?: boolean; [data: `data-${string}`]: string | undefined }) {
  return (
    <Empty className={cn("flex-none gap-4 p-6 md:p-6", !bare && "border", tall && "h-full flex-1", className)} {...p}>
      <EmptyHeader>
        {icon != null && icon !== false ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
        <EmptyTitle className="text-base">{title}</EmptyTitle>
        {text ? <EmptyDescription>{text}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

/** The last failed write's message, where it belongs ("board", "rules", "projects"). Callers re-render on useGate(). */
export function PageError({ where }: { where: string }) {
  return gate.error?.where === where ? (
    <Alert variant="destructive" className="mt-2">
      <AlertDescription>{gate.error.message}</AlertDescription>
    </Alert>
  ) : null;
}

/** A read's state above its view: loading, failed (with Retry), or stale data kept while a refresh failed. */
export function ReadState({ q, what }: { q: { data: unknown; error: { message: string } | null; refetch: () => Promise<void> }; what: string }) {
  if (q.data !== undefined) return q.error ? <p className="m-0 text-xs text-(--orch-danger)">Stale: {q.error.message}</p> : null;
  return q.error ? (
    <EmptyState title={`Can't read ${what}`} text={q.error.message} icon={null} action={<Btn onClick={() => void q.refetch()}>Retry</Btn>} />
  ) : (
    <div role="status" className="flex flex-col gap-2">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-4 w-72 max-w-full" />
    </div>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="m-0 text-sm text-muted-foreground">{children}</p>;
}

/** A time from an ISO string or epoch ms, short and local. */
/** A short age: now, 4m, 3h, 2d. */
export function ago(at: number, now: number): string {
  const s = Math.max(0, now - at) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function when(t: string | number | null | undefined): string {
  if (t === null || t === undefined || t === "") return "—";
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return String(t);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
