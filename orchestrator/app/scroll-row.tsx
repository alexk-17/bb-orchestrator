// a sideways-scrolling row with a fade on the side with more; no shadcn ScrollArea is vendored here
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "./ui/utils.ts";
import { fadeOf } from "./phone.ts";

export function ScrollRow({ children, className }: { children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => {
      el.removeEventListener("scroll", read);
      ro.disconnect();
    };
  }, []);
  const fade = fadeOf(more);
  return (
    <div ref={box} data-scroll-row="" data-more={more.right ? "right" : more.left ? "left" : undefined} className={cn("max-w-full min-w-0 overflow-x-auto [scrollbar-width:none]", className)} style={{ maskImage: fade, WebkitMaskImage: fade }}>
      {children}
    </div>
  );
}
