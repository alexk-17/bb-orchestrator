// The view picker (feel spec part 1, 2026-11-20): one shadcn Command card, centred in its pane's body, drawn inline.
import { cloneElement, isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "./ui/command.tsx";
import { Kbd } from "./ui/kbd.tsx";
import { cn } from "./ui/utils.ts";
import { matching, type PickerMode, type PickerRow, type PickerRows } from "./picker-rows.ts";

const TITLE: Record<PickerMode, string> = { split: "Pick a view for the new pane", change: "Change this pane's view" };

export function ViewPicker({ mode, rows, start, current, onPick, onCancel }: {
  mode: PickerMode;
  rows: PickerRows;
  /** The row selected when it opens */
  start: string | null;
  /** Change mode: the pane's page, which gets a check */
  current: string | null;
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const shown = useMemo(() => matching(rows, q), [rows, q]);
  const order = [...shown.main, ...shown.tools, ...shown.filters];
  const [value, setValue] = useState(() => (start && order.some((r) => r.id === start) ? start : (order[0]?.id ?? "")));
  // CSS centres it in the first frame; the top edge is pinned after that frame (no forced layout), so typing never moves it
  const [top, setTop] = useState<number | null>(null);
  // cmdk scrolls the selected row into view as it opens, a forced layout; every row is in view unless the list overflows,
  // so that scroll waits for the first frame and runs only then
  useLayoutEffect(() => {
    box.current?.querySelectorAll<HTMLElement>("[cmdk-item]").forEach((el) => (el.scrollIntoView = () => {}));
  }, []);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const b = box.current?.getBoundingClientRect();
      const c = card.current?.getBoundingClientRect();
      if (b && c) setTop(Math.round(c.top - b.top));
      box.current?.querySelectorAll<HTMLElement>("[cmdk-item]").forEach((el) => Reflect.deleteProperty(el, "scrollIntoView"));
      const list = box.current?.querySelector<HTMLElement>("[cmdk-list]");
      if (list && list.scrollHeight > list.clientHeight) list.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(id);
  }, []);
  const type = (next: string) => {
    setQ(next);
    const m = matching(rows, next);
    setValue([...m.main, ...m.tools, ...m.filters][0]?.id ?? "");
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Tab") e.preventDefault();
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };
  // every row stays in the DOM; one that doesn't match is hidden and skipped by the arrows (2026-11-20, typing lag): each
  // key used to add and remove rows, and inside bb's page one element added or removed restyles about 2,700 elements
  const on = new Set([...shown.main, ...shown.tools, ...shown.filters].map((r) => r.id));
  const off = { display: "none" } as const;
  const row = (r: PickerRow) => (
    <CommandItem key={r.id} value={r.id} onSelect={() => onPick(r.id)} disabled={!on.has(r.id)} style={on.has(r.id) ? undefined : off} className="group/row h-8 py-0 data-[selected=true]:font-medium" data-picker-row={r.id}>
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground group-data-[selected=true]/row:text-foreground">{iconOf(r.icon)}</span>
      <span className="min-w-0 flex-1 truncate">{r.label}</span>
      {mode === "change" && r.id === current ? <Check className="size-4 text-current" data-picker-current="" /> : null}
      <Kbd className="hidden border bg-background group-data-[selected=true]/row:inline-flex" data-picker-enter="">↵</Kbd>
    </CommandItem>
  );
  return (
    // a size container: width, height and footer follow the pane body in CSS (16 px clear, at most 320 × 560, so every row shows at 900 px tall: the owner wants every page in it, 2026-11-20)
    <div ref={box} className="absolute inset-0" style={{ containerType: "size" }} data-view-picker-layer={mode}>
      {/* the card's box; the drag line hangs under it, so the card is centred alone */}
      <div
        ref={card}
        className={cn("absolute left-1/2 flex -translate-x-1/2 flex-col", top === null && "top-1/2 -translate-y-1/2")}
        style={{ width: "min(320px, calc(100% - 32px))", maxHeight: "min(560px, calc(100% - 32px))", ...(top === null ? {} : { top }) }}
      >
        <Command
          shouldFilter={false}
          loop
          value={value}
          onValueChange={setValue}
          onKeyDown={keys}
          label={TITLE[mode]}
          data-view-picker={mode}
          className="h-auto min-h-0 rounded-lg border bg-popover text-popover-foreground shadow-md"
        >
          <CommandInput autoFocus value={q} onValueChange={type} placeholder={TITLE[mode]} data-picker-input="" />
          <CommandList className="max-h-none min-h-0 flex-1">
            {on.size ? null : <div className="py-6 text-center text-sm" data-picker-empty="">No views match.</div>}
            {rows.main.length ? <CommandGroup style={shown.main.length ? undefined : off}>{rows.main.map(row)}</CommandGroup> : null}
            {rows.main.length && rows.tools.length ? <CommandSeparator style={shown.main.length && shown.tools.length ? undefined : off} /> : null}
            {rows.tools.length ? <CommandGroup heading="Tools" style={shown.tools.length ? undefined : off}>{rows.tools.map(row)}</CommandGroup> : null}
            {(rows.main.length || rows.tools.length) && rows.filters.length ? <CommandSeparator style={(shown.main.length || shown.tools.length) && shown.filters.length ? undefined : off} /> : null}
            {rows.filters.length ? <CommandGroup style={shown.filters.length ? undefined : off}>{rows.filters.map(row)}</CommandGroup> : null}
          </CommandList>
          <div className="flex h-8 shrink-0 items-center gap-1.5 border-t px-3 text-xs text-muted-foreground [@container_(height<272px)]:hidden" data-picker-footer="">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <span className="mr-2">Move</span>
              <Kbd>Esc</Kbd>
              <span>{mode === "split" ? "Cancel" : "Close"}</span>
          </div>
        </Command>
        {mode === "split" ? (
          <p className="absolute top-full right-0 left-0 mt-2 text-center text-xs text-muted-foreground [@container_(height<480px)]:hidden" data-picker-drag-line="">
            Or drag a page here from the sidebar.
          </p>
        ) : null}
      </div>
    </div>
  );
}

// the icon draws in its slot's colour, so the selected row's icon can turn to the foreground
function iconOf(icon: ReactNode): ReactNode {
  return isValidElement(icon) ? cloneElement(icon as ReactElement<{ className?: string }>, { className: "size-4 text-current" }) : null;
}
