// Start here (Home first, step 2, 2026-11-20): an empty Home is the guide, three steps; the step marker is plugin-local (shadcn has no stepper).
import type { ReactNode } from "react";
import type { z } from "zod";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Check, MessageCircle, Play } from "lucide-react";
import { WRITES, type Board, type roleStartBody } from "../contract.ts";
import { PANEL_PATH } from "./open-proof.ts";
import { gate, write } from "./store.ts";
import { Button } from "./ui/button.tsx";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty.tsx";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle, WITH_DESCRIPTION } from "./ui/item.tsx";
import { cn } from "./ui/utils.ts";
import { startSteps } from "./start-steps.ts";

function Marker({ n, done }: { n: number; done: boolean }) {
  return (
    <span aria-hidden className={cn("flex size-7 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums", done ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground")} data-step-done={done || undefined}>
      {done ? <Check className="size-3.5" /> : n}
    </span>
  );
}

function Step({ n, done, title, text, action }: { n: number; done: boolean; title: string; text: string; action?: ReactNode }) {
  return (
    <Item variant="outline" size="sm" data-start-step={n}>
      <ItemMedia className={WITH_DESCRIPTION}>
        <Marker n={n} done={done} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className={done ? "text-muted-foreground line-through" : undefined}>
          <span className="sr-only">{done ? "Done: " : `Step ${n}: `}</span>
          {title}
        </ItemTitle>
        <ItemDescription>{text}</ItemDescription>
      </ItemContent>
      {action && !done ? <ItemActions>{action}</ItemActions> : null}
    </Item>
  );
}

export function StartHere({ agents, phone, onChat, refetchAll }: { agents: Board["agents"] | undefined; phone: boolean; onChat: () => void; refetchAll: () => void }) {
  const navigate = useBbNavigate();
  const s = startSteps(agents);
  const start = () => {
    const body: z.input<typeof roleStartBody> = { role: "cos" };
    void write(WRITES.roleStart, body, { kind: "other", where: "role:cos", after: refetchAll });
  };
  const size = phone ? "lg" : "sm";
  return (
    <Empty className="mx-auto max-w-xl border-0 px-4 py-8 md:p-12 md:py-16" data-start-here="">
      <EmptyHeader className="max-w-none items-start self-stretch text-left">
        <EmptyTitle>Start here</EmptyTitle>
        <EmptyDescription>Home fills up as your agents work.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-none items-stretch gap-3 text-left">
        <Step n={1} done={s.cos} title="Start the Chief of Staff" text="It triages questions first" action={<Button size={size} data-start-cos="" disabled={!agents || gate.lock !== null} onClick={start}><Play />Start</Button>} />
        <Step n={2} done={s.project} title="Tell it what to build" text="It makes the project and a lead" action={s.cos ? <Button size={size} data-start-chat="" onClick={onChat}><MessageCircle />Open Chat</Button> : undefined} />
        <Step n={3} done={false} title="Answer and approve here" text="Cards and work land on Home" />
        <Button variant="link" className="h-auto self-start p-0 text-muted-foreground" data-start-how="" onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "how-it-works" })}>
          How it works
        </Button>
      </EmptyContent>
    </Empty>
  );
}
