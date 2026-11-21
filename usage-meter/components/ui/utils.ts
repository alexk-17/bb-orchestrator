// shadcn/ui's cn(): clsx for conditional classes, tailwind-merge so a caller's class wins over a component's default.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 2026-11-20: bb compiles a plugin's Tailwind under [data-bb-plugin="usage-meter"]. The popover lives in body, outside
 * any plugin root, so its node carries the marks bb's own portaled overlays do.
 */
export const PLUGIN_MARKS = { "data-bb-plugin-root": "", "data-bb-plugin": "usage-meter" } as const;
