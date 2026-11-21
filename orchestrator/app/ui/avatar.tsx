import * as React from "react"
import { cn } from "./utils.ts"
import { Avatar as AvatarPrimitive } from "radix-ui"
import { styleHref } from "../style-href.ts"

// 2026-11-17: the sprite variant's idle bob, 2 px (keyframes can't be a utility class); off under reduced motion
const SPRITE_CSS = "@keyframes avatar-sprite-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }"

/**
 * 2026-11-17, two additions to shadcn's Avatar:
 * - sizes 16, 20, 24, 32, 40 and 48 px;
 * - variant "sprite" for pixel art (a Pokémon): no round crop and no fill, the image (an AvatarImage or a <picture>'s
 *   img) contained, pixelated and bobbing; the box is fixed from the first paint, so a late sprite moves nothing.
 */
function Avatar({
  className,
  size = "default",
  variant = "default",
  children,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Root> & {
  size?: "default" | "sm" | "lg" | "16" | "20" | "24" | "32" | "40" | "48"
  variant?: "default" | "sprite"
}) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      data-variant={variant}
      className={cn(
        "group/avatar relative flex size-8 shrink-0 overflow-hidden rounded-full select-none data-[size=lg]:size-10 data-[size=sm]:size-6 data-[size=16]:size-4 data-[size=20]:size-5 data-[size=24]:size-6 data-[size=32]:size-8 data-[size=40]:size-10 data-[size=48]:size-12",
        "data-[variant=sprite]:items-center data-[variant=sprite]:justify-center data-[variant=sprite]:overflow-visible data-[variant=sprite]:rounded-none data-[variant=sprite]:bg-transparent data-[variant=sprite]:[&_picture]:contents data-[variant=sprite]:[&_img]:size-full data-[variant=sprite]:[&_img]:object-contain data-[variant=sprite]:[&_img]:[image-rendering:pixelated] motion-safe:data-[variant=sprite]:[&_img]:animate-[avatar-sprite-bob_3s_ease-in-out_infinite]",
        className
      )}
      {...props}
    >
      {variant === "sprite" ? (
        <style href={styleHref("avatar-sprite", SPRITE_CSS)} precedence="default">
          {SPRITE_CSS}
        </style>
      ) : null}
      {children}
    </AvatarPrimitive.Root>
  )
}

function AvatarImage({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("aspect-square size-full", className)}
      {...props}
    />
  )
}

function AvatarFallback({
  className,
  ...props
}: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground group-data-[size=sm]/avatar:text-xs group-data-[size=16]/avatar:text-xs group-data-[size=20]/avatar:text-xs group-data-[size=24]/avatar:text-xs",
        className
      )}
      {...props}
    />
  )
}

function AvatarBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        "absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-background select-none",
        "group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden",
        "group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>svg]:size-2",
        "group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2",
        className
      )}
      {...props}
    />
  )
}

/**
 * 2026-11-18: sprites (a party of Pokémon) take a 1 px outline in --background around their own shape in place of the
 * ring (a ring would draw the transparent box), so a sprite over another still reads as two; they overlap a little less.
 */
function AvatarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        "group/avatar-group flex -space-x-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:ring-background",
        "*:data-[variant=sprite]:ring-0 *:data-[variant=sprite]:[filter:drop-shadow(1px_0_0_var(--background))_drop-shadow(-1px_0_0_var(--background))_drop-shadow(0_1px_0_var(--background))_drop-shadow(0_-1px_0_var(--background))]",
        className
      )}
      {...props}
    />
  )
}

const PAIR_SIZES = {
  "16": "h-4 w-5",
  "20": "h-5 w-[25px]",
  "24": "h-6 w-[30px]",
  "28": "h-7 w-[35px]",
  "32": "h-8 w-10",
  "40": "h-10 w-[50px]",
  "48": "h-12 w-15",
} as const

/**
 * 2026-11-18: a person with their partner, for the two standing agents (the CoS and the Steward). The person's Avatar
 * comes first, at the pair's `size`; AvatarPairPartner holds the partner's, at 60% of that, over the person's
 * bottom-right corner with a 1 px --background outline around its shape. The box is a quarter wider than the person, so
 * the partner never covers a neighbour. The pair is one image to assistive tech: give it an aria-label ("Warden Tamsin
 * with Chansey").
 */
function AvatarPair({
  className,
  size = "32",
  ...props
}: React.ComponentProps<"span"> & { size?: keyof typeof PAIR_SIZES }) {
  return (
    <span
      role="img"
      data-slot="avatar-pair"
      data-size={size}
      className={cn("relative inline-flex shrink-0 items-start align-middle", PAIR_SIZES[size], className)}
      {...props}
    />
  )
}

function AvatarPairPartner({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="avatar-pair-partner"
      aria-hidden="true"
      className={cn(
        "absolute right-0 bottom-0 flex aspect-square h-3/5 items-center justify-center *:data-[slot=avatar]:size-full",
        "[filter:drop-shadow(1px_0_0_var(--background))_drop-shadow(-1px_0_0_var(--background))_drop-shadow(0_1px_0_var(--background))_drop-shadow(0_-1px_0_var(--background))]",
        className
      )}
      {...props}
    />
  )
}

function AvatarGroupCount({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm text-muted-foreground ring-2 ring-background [&>svg]:size-4",
        className
      )}
      {...props}
    />
  )
}

export {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarBadge,
  AvatarGroup,
  AvatarGroupCount,
  AvatarPair,
  AvatarPairPartner,
}
