// An agent's face (2026-11-18, the personas hook's look; faces.ts says who looks like what): one component for every
// place that drew an agent's Pokémon. With a persona, a lead is its person (the Avatar's sprite variant, the persona's
// image) and the CoS and the Steward are a pair, the person with their Pokémon as partner (AvatarPair). Without one it is
// MonSprite, exactly as before, so with the setting off or no pack every screen is unchanged. Also the lead's party (an
// AvatarGroup of its threads' Pokémon) and the profile card (the shared Card). No bb SDK here, so the tests render it.
import { useState } from "react";
import type { AgentPersona } from "../contract.ts";
import { Avatar, AvatarFallback, AvatarGroup, AvatarPair, AvatarPairPartner } from "./ui/avatar.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { cn } from "./ui/utils.ts";
import { MonSprite } from "./mon.tsx";
import { monByName, monSprite } from "../mons.ts";
import { ROLE_TONES, roleOf } from "./palette.ts";
import { boxedText, pairLabel, personaName } from "./faces.ts";

/** What a screen knows of an agent's look: its Pokémon (and the server's dex for a pack's line), and its persona. */
export interface Face {
  mon: string | null;
  dex?: number | null;
  persona?: AgentPersona | null;
}

const SIZES = [16, 20, 24, 32, 40, 48] as const;
const PAIR = [16, 20, 24, 28, 32, 40, 48] as const;
const named = (n: number) => SIZES.find((x) => x === n);

/**
 * A person: the persona's image in the Avatar's sprite variant (contained, pixelated, a fixed box from the first paint).
 * An image that fails falls back to the role's letter, as MonSprite's does.
 */
export function PersonaSprite({ persona, address, size = 32 }: { persona: AgentPersona; address: string; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  const role = roleOf(address);
  const label = `${personaName(persona)} · ${address}`;
  const n = named(size);
  return (
    <Avatar variant="sprite" className="flex-none" size={n ? (String(n) as `${typeof n}`) : "default"} style={{ width: size, height: size }} title={label} data-persona={address}>
      {failed !== persona.image ? (
        <img src={persona.image} alt={personaName(persona)} width={size} height={size} loading="lazy" decoding="async" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(persona.image)} />
      ) : (
        <AvatarFallback aria-label={label} className="font-medium">
          {role ? ROLE_TONES[role].label.slice(0, 1).toUpperCase() : "?"}
        </AvatarFallback>
      )}
    </Avatar>
  );
}

/** The CoS or the Steward: the person, with its Pokémon (`persona.partner`, its form now, shiny) over the corner. */
export function PersonaPair({ persona, address, size = 32 }: { persona: AgentPersona; address: string; size?: number }) {
  const s = PAIR.reduce((best, x) => (Math.abs(x - size) < Math.abs(best - size) ? x : best));
  const label = pairLabel(persona);
  return (
    <AvatarPair size={String(s) as `${typeof s}`} aria-label={label} title={`${label} · ${address}`} data-pair={address}>
      <PersonaSprite persona={persona} address={address} size={s} />
      <AvatarPairPartner>
        <MonSprite mon={persona.partner} address={address} size={Math.round(s * 0.6)} boost={false} />
      </AvatarPairPartner>
    </AvatarPair>
  );
}

/** Any agent's face: the pair, the person, or its Pokémon (MonSprite: the role's letter with the setting off). */
export function AgentFace({ face, address, size = 28, boost = true }: { face: Face | null | undefined; address: string; size?: number; boost?: boolean }) {
  const p = face?.persona ?? null;
  if (p?.partner) return <PersonaPair persona={p} address={address} size={size} />;
  if (p) return <PersonaSprite persona={p} address={address} size={size} />;
  return <MonSprite mon={face?.mon ?? null} dex={face?.dex} address={address} size={size} boost={boost} />;
}

type Member = { address: string; mon: string | null; form: string | null; formDex?: number | null };

/** A lead's party (faces.ts partyOf): up to six of its threads' Pokémon, overlapping, then "+N in the box". */
export function Party({ shown, boxed, size = 24 }: { shown: readonly Member[]; boxed: number; size?: number }) {
  if (!shown.length) return null;
  const names = shown.map((a) => a.form ?? a.mon).join(", ");
  return (
    <div className="inline-flex items-center gap-2" data-party={shown.length}>
      <AvatarGroup className="-space-x-1.5" role="img" aria-label={`Party: ${names}${boxed ? `, and ${boxed} more in the box` : ""}`}>
        {shown.map((a) => (
          <MonSprite key={a.address} mon={a.form ?? a.mon} dex={a.formDex} address={a.address} size={size} boost={false} />
        ))}
      </AvatarGroup>
      {boxed ? (
        <span className="text-xs whitespace-nowrap text-muted-foreground" data-party-boxed={boxed}>
          {boxedText(boxed)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * One member of a persona's team from the games (2026-11-18): its own form, by the pack's National Dex number (else
 * mons.ts's), never shiny and never boosted, the name on hover. Past dex 649 there is no animated sprite, so it is
 * PokeAPI's still one; an image that fails tries the still one, then the name's initial. Never a broken image.
 */
export function TeamSprite({ name, dex, size = 24 }: { name: string; dex?: number | null; size?: number }) {
  const n = dex ?? monByName(name)?.dex ?? null;
  const urls = n ? [...new Set([monSprite({ name, dex: n }, true), monSprite({ name, dex: n }, false)])] : [];
  const [tries, setTries] = useState(0);
  const src = urls[tries];
  const box = named(size);
  return (
    <Avatar variant="sprite" className="flex-none" size={box ? (String(box) as `${typeof box}`) : "default"} style={{ width: size, height: size }} title={name} data-team-member={name}>
      {src ? (
        <img src={src} alt={name} width={size} height={size} loading="lazy" decoding="async" draggable={false} onError={() => setTries((t) => t + 1)} />
      ) : (
        <AvatarFallback aria-label={name} className="font-medium">
          {name.slice(0, 1).toUpperCase()}
        </AvatarFallback>
      )}
    </Avatar>
  );
}

/** A persona's team from the games, as sprites, in team order (repeats stay); labelled so it reads apart from the party. */
export function Team({ persona, size = 24 }: { persona: AgentPersona; size?: number }) {
  if (!persona.team.length) return null;
  return (
    <div className="flex items-center gap-2" data-profile-team={persona.team.length}>
      <span className="w-14 flex-none">Team</span>
      <span role="img" aria-label={`Team: ${persona.team.join(", ")}`} className="inline-flex flex-wrap items-center gap-0.5">
        {persona.team.map((name, i) => (
          <TeamSprite key={i} name={name} dex={persona.teamDex?.[i]} size={size} />
        ))}
      </span>
    </div>
  );
}

const ROLE_WORD: Record<string, string> = { cos: "Chief of Staff", steward: "Steward", lead: "Lead" };

/**
 * A person's profile card (scope §3), compact (2026-11-18, the lead: about the mock-up's height): the picture, the title
 * and name with the level on one line, the role and its project or partner under it, then the team from the games as
 * sprites (members that can't be threads included), the live party under "Threads" (a lead's), and the image's credit,
 * each one muted line.
 */
export function ProfileCard({ persona, address, project, level, party, className }: { persona: AgentPersona; address: string; project: string | null; level: number | null; party?: { shown: readonly Member[]; boxed: number }; className?: string }) {
  const role = roleOf(address);
  const sub = [ROLE_WORD[role ?? ""] ?? role, project, persona.partner ? `partner ${persona.partner}` : null].filter(Boolean).join(" · ");
  return (
    <Card className={cn("gap-2 py-3", className)} data-profile-card={address}>
      <CardHeader className="flex items-center gap-3 px-3">
        {persona.partner ? <PersonaPair persona={persona} address={address} size={40} /> : <PersonaSprite persona={persona} address={address} size={40} />}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <CardTitle role="heading" aria-level={3} className="text-sm leading-5 [overflow-wrap:anywhere]">
              {personaName(persona)}
            </CardTitle>
            {level !== null ? <Badge variant="secondary">Lv {level}</Badge> : null}
          </div>
          <CardDescription className="text-xs [overflow-wrap:anywhere]">{sub}</CardDescription>
        </div>
      </CardHeader>
      {party?.shown.length || persona.team.length || persona.credit ? (
        <CardContent className="flex flex-col gap-1.5 px-3 text-xs text-muted-foreground">
          <Team persona={persona} />
          {party?.shown.length ? (
            <div className="flex items-center gap-2" data-profile-threads="">
              <span className="w-14 flex-none">Threads</span>
              <Party shown={party.shown} boxed={party.boxed} />
            </div>
          ) : null}
          {persona.credit ? <p className="m-0">{persona.credit}</p> : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

/**
 * A standing agent (the CoS, the Steward) in the Projects tab's standing bar. Without a persona: its label alone, exactly
 * as before. With one (2026-11-18, the lead): its pair before the label, and after it its name, which opens its profile
 * card in a Popover, so nothing on the page moves.
 */
export function StandingFace({ face, address, label, level }: { face: Face | null | undefined; address: string; label: string; level: number | null }) {
  const p = face?.persona;
  if (!p) return <>{label}</>;
  return (
    <>
      <AgentFace face={face} address={address} size={20} /> {label}{" "}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="link" size="xs" className="h-6 px-0 align-baseline text-xs text-foreground underline underline-offset-4" data-profile-open={address}>
            {personaName(p)}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">
          <ProfileCard persona={p} address={address} project={null} level={level} className="border-0 shadow-none" />
        </PopoverContent>
      </Popover>
    </>
  );
}
