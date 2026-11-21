import type * as React from "react";

import { cn } from "./utils";

// 2026-11-20: Radix's Progress Root and Indicator are plain divs with the attributes Radix sets (see LICENSE here).
// indicatorClassName is added so the popover can colour the fill by tone.
function Progress({
  className,
  indicatorClassName,
  value,
  max = 100,
  ...props
}: React.ComponentProps<"div"> & { value?: number | null; max?: number; indicatorClassName?: string }) {
  const state = value == null ? "indeterminate" : value >= max ? "complete" : "loading";
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value ?? undefined}
      data-state={state}
      data-value={value ?? undefined}
      data-max={max}
      data-slot="progress"
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-primary/20", className)}
      {...props}
    >
      <div
        data-state={state}
        data-value={value ?? undefined}
        data-max={max}
        data-slot="progress-indicator"
        className={cn("h-full w-full flex-1 bg-primary transition-all", indicatorClassName)}
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </div>
  );
}

export { Progress };
