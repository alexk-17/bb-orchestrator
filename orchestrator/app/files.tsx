// Outputs (orch_output) on the Deliverables tab (2026-11-16, was the Outputs tab): a loose one is a row under the Files
// filter; one that is a deliverable's proof sits folded inside that deliverable. Either opens through the shared opener
// (open-proof.ts): a file in bb's preview pane on its host, a link through bb's link handling. Remove takes an output off
// the record (never the file) through the page's write gate. On shadcn/ui since 2026-11-17: lucide's icons, a link
// button for the title, and the fold is a Collapsible.
// 2026-11-17, every deliverable keeps its own files: FileFull and FileTile show one of them as a full item (an image or
// video inline, else an Item row with its name, kind and size), and OpenFolder opens its folder's README in bb.
import { useState } from "react";
import { FileChartColumn, FileText, FolderOpen, Image, Link, Video, type LucideIcon } from "lucide-react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import { WRITES, type Outputs, type outputRemoveBody } from "../contract.ts";
import { openInBb } from "./open-proof.ts";
import { ProofLink } from "./proof-link.tsx";
import { ImagePopout } from "./image-popout.tsx";
import { gate, write } from "./store.ts";
import { Fold } from "./answer-ui.tsx";
import { Button } from "./ui/button.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle, WITH_DESCRIPTION } from "./ui/item.tsx";
import { cn } from "./ui/utils.ts";
import { Btn, when } from "./ui.tsx";
import { servedBy, sizeText, type FileItem } from "./past.ts";
import { outputSrc, proofSrc } from "./deliverables.tsx";
import { SHOT } from "./visual-blocks.tsx";

type Output = Outputs[number];

/** Where Remove's failure shows. */
export const FILES_WHERE = "outputs";

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const host = (u: string | null) => {
  try {
    return u ? new URL(u).host : "";
  } catch {
    return u ?? "";
  }
};

const KIND_ICONS: Record<Output["kind"], LucideIcon> = { doc: FileText, report: FileChartColumn, image: Image, video: Video, link: Link };
/** The kind as a muted outline icon: the word is in its label; colour is kept for state. */
export const KindIcon = ({ kind, label }: { kind: Output["kind"]; label?: string }) => {
  const Icon = KIND_ICONS[kind];
  return <Icon className="mt-0.5 size-4 flex-none text-muted-foreground" strokeWidth={1.5} role="img" aria-label={label ?? kind} />;
};

/**
 * A file's or proof's name: a link button that opens it (shared with the tree's proof rows). It may shrink below its one-line
 * width (a Button is shrink-0): a long file name ran past a phone's edge in an opened past deliverable (2026-11-21).
 */
export const OPEN = "h-auto min-w-0 max-w-full shrink p-0 text-start text-sm font-normal whitespace-normal text-foreground [overflow-wrap:anywhere]";
/** The quiet line under a file's name, and its note. */
export const META_LINE = "mt-0.5 flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground";
export const NOTE = "m-0 mt-1 text-xs whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]";

/** Remove, as the Board's Archive: a first click asks, inline; the second takes it off the record. */
export function Remove({ id, busy, remove }: { id: string; busy: boolean; remove: (id: string) => Promise<boolean> }) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <Btn tone="ghost" data-remove={id} disabled={busy} onClick={() => setAsking(true)}>
        Remove
      </Btn>
    );
  return (
    <span role="group" aria-label="Confirm remove" className="flex flex-wrap items-center justify-end gap-2">
      <span className="text-xs text-muted-foreground">Off the record; the file stays.</span>
      <Btn tone="ghost" disabled={busy} onClick={() => setAsking(false)}>
        Cancel
      </Btn>
      <Btn tone="danger" data-remove-confirm={id} disabled={busy} onClick={() => void remove(id).then((ok) => ok && setAsking(false))}>
        Remove
      </Btn>
    </span>
  );
}

export function useRemoveOutput(after: () => void) {
  return async (id: string) => {
    const body: z.input<typeof outputRemoveBody> = { id };
    return (await write(WRITES.outputRemove, body, { kind: "other", where: FILES_WHERE, after }))?.ok === true;
  };
}

/** One output: its title opens it; then who recorded it, when, and the file or host; its note; Remove. */
export function FileRow({ o, after, project }: { o: Output; after: () => void; project?: boolean }) {
  const navigate = useBbNavigate();
  const [unopened, setUnopened] = useState(false);
  const remove = useRemoveOutput(after);
  const busy = gate.lock !== null;
  return (
    <div data-output={o.id} className="group/item flex items-start gap-2 px-1 py-2">
      <KindIcon kind={o.kind} />
      <div className="min-w-0 flex-1">
        {o.url ? (
          <ProofLink open={o} data-open="" className="text-sm text-foreground no-underline [overflow-wrap:anywhere] hover:underline" title={o.url}>
            {o.title}
          </ProofLink>
        ) : (
          <Button variant="link" data-open="" className={OPEN} title={o.path ?? ""} onClick={() => setUnopened(!openInBb(navigate, o))}>
            {o.title}
          </Button>
        )}
        <div className={META_LINE}>
          {project ? <span>{o.project ?? "No project"}</span> : null}
          <span>{o.author}</span>
          <span>{when(o.at)}</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">{o.path ? base(o.path) : host(o.url)}</span>
        </div>
        {o.note ? <p className={NOTE}>{o.note}</p> : null}
        {unopened ? (
          <p role="alert" className="orch-danger m-0 mt-1 text-xs">
            bb couldn't open this file here.
          </p>
        ) : null}
      </div>
      <div className={cn("flex-none", END)}>
        <Remove id={o.id} busy={busy} remove={remove} />
      </div>
    </div>
  );
}

/** The outputs that are this deliverable's proof, folded: closed, so the card reads as before. */
export function FoldedOutputs({ outputs, after }: { outputs: Output[]; after: () => void }) {
  if (outputs.length === 0) return null;
  return (
    <Fold label={`Recorded as ${outputs.length} output${outputs.length === 1 ? "" : "s"}`} data-folded-outputs="" className="mt-3">
      <div className="mt-1 grid">
        {outputs.map((o) => (
          <FileRow key={o.id} o={o} after={after} />
        ))}
      </div>
    </Fold>
  );
}

const FILE_ICONS: Record<FileItem["kind"], LucideIcon> = { images: Image, videos: Video, artifacts: FileText };
const KIND_WORD: Record<FileItem["kind"], string> = { images: "image", videos: "video", artifacts: "artifact" };
/** Remove shows on hover or focus (always on a touch screen), and stays while it asks. */
const END = "opacity-0 transition-opacity group-hover/item:opacity-100 focus-within:opacity-100 has-[[data-remove-confirm]]:opacity-100 [@media(hover:none)]:opacity-100";

/** The proof route's address for a file, when it serves it (servedBy decides: its proof, else its recorded output). */
function routeOf(f: FileItem): string | undefined {
  const by = servedBy(f);
  return by ? (by.proof ? proofSrc(by.proof) : outputSrc(by.output!)) : undefined;
}
/** What the proof route can show inline as `kind`: a proof of that kind, or an output's file of it. */
const servable = (f: FileItem, kind: "image" | "video") => !!routeOf(f) && (f.proof ? f.proof.kind === kind : f.kind === `${kind}s`);
/** What a file opens as in bb: the proof's own host, else its output's, else the folders' host. */
const openable = (f: FileItem, host: string | null) => ({ hostId: f.proof?.hostId ?? f.output?.hostId ?? host, path: f.path, url: f.url });

/** A file's name, opening it: in bb's preview first; a proof file bb can't preview falls back to the proof route. */
function FileName({ f, host, onUnopened, className }: { f: FileItem; host: string | null; onUnopened: (v: boolean) => void; className?: string }) {
  const navigate = useBbNavigate();
  const route = routeOf(f);
  if (f.missing) return <span className={cn("text-sm text-muted-foreground [overflow-wrap:anywhere]", className)}>{f.name}</span>;
  if (f.url || route)
    return (
      <ProofLink open={openable(f, host)} fallback={route} data-open="" className={cn("inline-block min-h-6 py-0.5 text-sm text-foreground no-underline [overflow-wrap:anywhere] hover:underline", className)} title={f.path ?? f.url ?? ""}>
        {f.name}
      </ProofLink>
    );
  return (
    <Button variant="link" data-open="" className={cn(OPEN, "min-h-6", className)} title={f.path ?? ""} onClick={() => onUnopened(!openInBb(navigate, openable(f, host)))}>
      {f.name}
    </Button>
  );
}

/**
 * Its deliverable (a link to it), project and date: where a file came from, in the Files view. `noProject` (2026-11-18):
 * the list names the project already (its folder, or the one project picked).
 */
function Whence({ f, onDeliverable, noProject }: { f: FileItem; onDeliverable?: (id: string) => void; noProject?: boolean }) {
  return (
    <span className={META_LINE}>
      {f.d ? (
        onDeliverable ? (
          <Button variant="link" data-file-deliverable={f.d.id} className="h-auto min-h-6 max-w-full min-w-0 shrink p-0 text-start text-xs font-normal whitespace-normal text-muted-foreground [overflow-wrap:anywhere]" onClick={() => onDeliverable(f.d!.id)}>
            {f.d.title}
          </Button>
        ) : (
          <span className="[overflow-wrap:anywhere]">{f.d.title}</span>
        )
      ) : (
        <span>{f.output ? `Output by ${f.output.author}` : "No deliverable"}</span>
      )}
      {noProject ? null : <span>{f.project ?? "No project"}</span>}
      <span>{when(f.at)}</span>
    </span>
  );
}

/**
 * One file as a row: its kind's icon, its name (opens it), then its kind, size and caption; in the Files view
 * (`onDeliverable`) also its deliverable, project and date. A file already gone says so. Remove on a recorded output.
 */
export function FileRow2({ f, host, after, onDeliverable, noProject }: { f: FileItem; host: string | null; after: () => void; onDeliverable?: (id: string) => void; noProject?: boolean }) {
  const [unopened, setUnopened] = useState(false);
  const remove = useRemoveOutput(after);
  const Icon = f.url ? Link : FILE_ICONS[f.kind];
  return (
    <Item size="sm" data-file={f.key} data-file-kind={f.kind} data-missing={f.missing ? "" : undefined} className="items-start gap-3 px-1 py-2">
      <ItemMedia variant="icon" className={WITH_DESCRIPTION}>
        <Icon strokeWidth={1.5} role="img" aria-label={KIND_WORD[f.kind]} className={f.missing ? "text-muted-foreground" : undefined} />
      </ItemMedia>
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="font-normal">
          <FileName f={f} host={host} onUnopened={setUnopened} />
        </ItemTitle>
        <ItemDescription className="m-0 flex flex-wrap gap-x-3 text-xs">
          <span>{f.dir ? "folder" : KIND_WORD[f.kind]}</span>
          {f.bytes !== null && !f.dir ? <span>{sizeText(f.bytes)}</span> : null}
          {f.caption ? <span className="[overflow-wrap:anywhere]">{f.caption}</span> : null}
        </ItemDescription>
        {onDeliverable ? <Whence f={f} onDeliverable={onDeliverable} noProject={noProject} /> : null}
        {f.missing ? <p className="m-0 text-xs text-muted-foreground">Missing: it was gone before it could be copied.</p> : null}
        {unopened ? (
          <p role="alert" className="orch-danger m-0 text-xs">
            bb couldn't open this file here.
          </p>
        ) : null}
      </ItemContent>
      {f.output ? (
        <ItemActions className={END}>
          <Remove id={f.output.id} busy={gate.lock !== null} remove={remove} />
        </ItemActions>
      ) : null}
    </Item>
  );
}

/** A deliverable's file as a full item: an image or a video inline at full width, else its row. */
export function FileFull({ f, host, after }: { f: FileItem; host: string | null; after: () => void }) {
  const [broken, setBroken] = useState(false);
  const navigate = useBbNavigate();
  if (servable(f, "image") && !broken)
    return (
      <figure className="m-0" data-file={f.key} data-file-kind="images">
        <ImagePopout
          src={routeOf(f)!}
          caption={f.caption ?? f.name}
          className={cn(SHOT, "block")}
          sidePanel={() => openInBb(navigate, openable(f, host))}
        >
          <img src={routeOf(f)} alt={f.caption ?? f.name} loading="lazy" decoding="async" onError={() => setBroken(true)} className="block h-auto w-full" />
        </ImagePopout>
        <figcaption className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {f.caption ? `${f.caption} · ` : ""}
          {f.name}
          {f.bytes !== null ? ` · ${sizeText(f.bytes)}` : ""}
        </figcaption>
      </figure>
    );
  if (servable(f, "video"))
    return (
      <figure className="m-0" data-file={f.key} data-file-kind="videos">
        <video src={routeOf(f)} controls preload="metadata" className={cn(SHOT, "block aspect-video w-full")} />
        <figcaption className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {f.caption ? `${f.caption} · ` : ""}
          {f.name}
          {f.bytes !== null ? ` · ${sizeText(f.bytes)}` : ""}
        </figcaption>
      </figure>
    );
  return <FileRow2 f={f} host={host} after={after} />;
}

/** One image in the Files view's grid: the picture (opens it), its name, deliverable and date. */
export function FileTile({ f, host, onDeliverable, noProject }: { f: FileItem; host: string | null; onDeliverable?: (id: string) => void; noProject?: boolean }) {
  const [unopened, setUnopened] = useState(false);
  const [broken, setBroken] = useState(false);
  return (
    <figure className="m-0 min-w-0" data-file={f.key} data-file-kind={f.kind}>
      {servable(f, "image") && !broken ? (
        <ProofLink open={openable(f, host)} fallback={routeOf(f)} data-open="" className={cn(SHOT, "block aspect-video")}>
          <img src={routeOf(f)} alt={f.caption ?? f.name} loading="lazy" decoding="async" onError={() => setBroken(true)} className="block size-full object-cover object-top" />
        </ProofLink>
      ) : (
        <div className={cn(SHOT, "flex aspect-video items-center justify-center text-muted-foreground")}>
          <Image className="size-6" strokeWidth={1.5} aria-hidden />
        </div>
      )}
      <figcaption className="mt-1.5 grid min-w-0 gap-0.5">
        <FileName f={f} host={host} onUnopened={setUnopened} className="text-sm" />
        <Whence f={f} onDeliverable={onDeliverable} noProject={noProject} />
        {f.missing ? <span className="text-xs text-muted-foreground">Missing: it was gone before it could be copied.</span> : null}
        {unopened ? (
          <span role="alert" className="orch-danger text-xs">
            bb couldn't open this file here.
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}

/** Opens a deliverable's folder in bb, at its README (the one file to open first). Off without a folder or a host. */
export function OpenFolder({ folder, host }: { folder: { folder: string; readme: string | null } | undefined; host: string | null }) {
  const navigate = useBbNavigate();
  const [unopened, setUnopened] = useState(false);
  const off = !folder || !host;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Btn
        size="sm"
        data-open-folder=""
        disabled={off}
        title={!folder ? "This deliverable has no folder yet" : !host ? "bb can't tell which host the folder is on" : folder.folder}
        icon={<FolderOpen />}
        onClick={() => folder && setUnopened(!openInBb(navigate, { hostId: host, path: folder.readme ?? folder.folder }))}
      >
        Open folder
      </Btn>
      {unopened ? (
        <span role="alert" className="orch-danger text-xs">
          bb couldn't open the folder here.
        </span>
      ) : null}
    </span>
  );
}
