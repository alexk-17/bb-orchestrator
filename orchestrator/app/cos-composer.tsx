// Requested 2026-11-13: "a way to also from the Orchestrator page to send a message quickly to the CoS". One line under the
// tabs on every view: type, then Send (or ⌘/Ctrl+Enter). It lands in the CoS's chat as the owner's own message.
// 1.16.0: the bar is a text box and its primary button and nothing around them (the grey slab is gone), the same
// field-with-Send as the chat with a lead. The shortcut is Send's tooltip, not words in the box.
// 2026-11-17: shadcn's Textarea and Button. The box grows with the text up to six lines, then scrolls; Send stays beside
// its first line.
// 2026-11-17: screenshots too, as in the chat with a lead (image-attach.tsx): paste, drop or the attach button; each is
// staged on its own write, then the send names them and the CoS's thread gets them as images, their paths in the text.
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import { WRITES, type Board, type cosMessageBody } from "../contract.ts";
import { MonSprite } from "./mon.tsx";
import { stage, useGate, write, gate } from "./store.ts";
import { admit, canSend, imageFiles } from "./lead-images.ts";
import { AttachButton, ImageThumbs, attached, base64, useDrop, type Attached } from "./image-attach.tsx";
import { Kbd } from "./ui/kbd.tsx";
import { Textarea } from "./ui/textarea.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import { Btn, cx } from "./ui.tsx";
import { VoiceMic } from "../voice/app/voice-mic.tsx"; // voice mode (voice/README.md): draws nothing while it is off

/** The box's placeholder: who it reaches on a desktop page, just "Message…" on the phone-width page. */
const PLACEHOLDER = { full: "Message the Chief of Staff…", compact: "Message…" };

export function CosComposer({ agents, refetchAll, compact = false }: { agents: Board["agents"] | undefined; refetchAll: () => void; compact?: boolean }) {
  useGate();
  const navigate = useBbNavigate();
  const cos = agents?.find((a) => a.address === "cos") ?? null;
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ ok: true; queued: boolean } | { ok: false; message: string } | null>(null);
  const [images, setImages] = useState<Attached[]>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);
  const busy = gate.lock !== null;
  const attach = (files: File[]) => {
    const { take, refused: why } = admit(images.length, files);
    setRefused(why);
    if (take.length) setImages((cur) => [...cur, ...take.map((i) => attached(files[i]!))]);
  };
  const detach = (key: string) => {
    setImages((cur) => cur.filter((i) => (i.key === key ? (URL.revokeObjectURL(i.url), false) : true)));
    setRefused(null);
  };
  const drop = useDrop(attach);

  const send = async () => {
    const t = text.trim();
    const going = images;
    if (!canSend(t, going.length) || busy || staging || !cos) return;
    // each image first, on its own write; the send names them by the ids the server gave back
    try {
      for (const img of going) {
        if (img.id) continue;
        setStaging(true);
        const up = await stage(WRITES.cosImage, { name: img.file.name.slice(0, 200) || "image", mime: img.file.type, data: await base64(img.file) }).catch((e: unknown) => ({ ok: false as const, message: String(e) }));
        if (!up.ok || typeof up.result !== "string") {
          setRefused(`${img.file.name || "An image"} didn't upload: ${up.ok ? "no id came back" : up.message}`);
          return;
        }
        img.id = up.result;
      }
    } finally {
      setStaging(false);
    }
    const body: z.input<typeof cosMessageBody> = going.length ? { text: t, images: going.map((i) => i.id!) } : { text: t };
    const out = await write(WRITES.cosMessage, body, { kind: "other", where: "cos", after: refetchAll });
    if (!out) return;
    if (out.ok) {
      setText("");
      const sentKeys = new Set(going.map((i) => i.key));
      going.forEach((i) => URL.revokeObjectURL(i.url));
      setImages((cur) => cur.filter((i) => !sentKeys.has(i.key)));
      setRefused(null);
      // the CoS mid-turn (or waiting on a question to the owner): bb queues it until that turn ends
      setResult({ ok: true, queued: (out.result as { delivery?: string } | null)?.delivery === "queued" });
    } else setResult({ ok: false, message: out.message });
  };

  return (
    // a file dropped anywhere on the bar attaches; what isn't an image is refused under it
    <section data-cos-composer="" className="mb-4 flex flex-col gap-1" {...drop}>
      <div className="flex items-start gap-2">
        <span className="mt-1 flex-none">
          <MonSprite mon={cos?.mon ?? null} address="cos" size={28} />
        </span>
        <Textarea
          data-cos-text=""
          aria-label="Message the Chief of Staff"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          className="max-h-36 min-h-9 min-w-0 flex-1 resize-none"
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (result) setResult(null);
          }}
          // a pasted screenshot attaches; a paste with no image in it is the text box's own, as before
          onPaste={(e) => {
            const pasted = imageFiles(e.clipboardData.files);
            if (!pasted.length) return;
            e.preventDefault();
            attach(pasted);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          maxLength={8000}
          disabled={!cos}
          // the usual hint while the agents load: "No Chief of Staff" only once the read says so (it wrapped to two lines
          // on the phone-width page, so the bar changed height as the page loaded)
          placeholder={cos || !agents ? (compact ? PLACEHOLDER.compact : PLACEHOLDER.full) : "No Chief of Staff is running: start it from the Projects tab"}
        />
        <span className="mt-1.5 flex-none">
          <AttachButton onFiles={attach} disabled={!cos || staging} data={{ "data-cos-attach": "" }} />
        </span>
        <VoiceMic disabled={!cos} />
        <Tooltip>
          <TooltipTrigger asChild>
            <Btn tone="primary" className="flex-none" data-cos-send="" disabled={busy || staging || !cos || !canSend(text, images.length)} onClick={() => void send()}>
              {staging ? "Sending…" : "Send"}
            </Btn>
          </TooltipTrigger>
          <TooltipContent>
            Send <Kbd>⌘/Ctrl+Enter</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="pl-9">
        <ImageThumbs images={images} refused={refused} onRemove={detach} disabled={staging} data="cos" />
      </div>
      {result ? (
        <p role="status" className={cx("m-0 flex flex-wrap items-center gap-x-2 gap-y-1 pl-9 text-xs", result.ok ? "text-muted-foreground" : "text-(--orch-danger)")} data-cos-result={result.ok ? "sent" : "error"} data-queued={result.ok && result.queued ? "" : undefined}>
          {result.ok ? (
            <>
              {result.queued ? "Queued: the CoS is mid-turn and reads it when that turn ends." : "Sent to the CoS."}
              <Btn tone="ghost" size="sm" onClick={() => cos && navigate.toThread(cos.threadId)}>
                Open its chat
              </Btn>
            </>
          ) : (
            result.message
          )}
        </p>
      ) : null}
    </section>
  );
}
