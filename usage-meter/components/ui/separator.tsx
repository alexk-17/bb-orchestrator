import type * as React from "react";

import { cn } from "./utils";

// 2026-11-20: Radix's Separator Root is a plain div with the attributes Radix sets (see LICENSE here).
function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<"div"> & { orientation?: "horizontal" | "vertical"; decorative?: boolean }) {
  return (
    <div
      role={decorative ? "none" : "separator"}
      aria-orientation={decorative || orientation === "horizontal" ? undefined : orientation}
      data-orientation={orientation}
      data-slot="separator"
      className={cn(
        "shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
