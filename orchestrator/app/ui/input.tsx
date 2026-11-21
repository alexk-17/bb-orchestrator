import * as React from "react"
import { cn } from "./utils.ts"

type InputProps = React.ComponentProps<"input">
type Handler = (...args: unknown[]) => unknown

/**
 * An <input> that renders only when its look or attributes change, never on a keystroke (2026-11-20, the owner: "the
 * input bars right now are so slow and laggy"). React resets an <input>'s name and type on every render it gets, and
 * inside bb's page each of those DOM changes sets off bb's own :has() rules, which restyled about 2,000 elements per key.
 * So `value` is written to the field only when it differs from what the field holds (the parent cleared or changed it),
 * and each on* handler reaches the <input> as one stable function that calls the latest one.
 */
function StillInput({ value, ref, ...props }: InputProps) {
  const field = React.useRef<HTMLInputElement | null>(null)
  const latest = React.useRef(props)
  React.useLayoutEffect(() => {
    latest.current = props
  })
  const named = Object.keys(props)
    .filter((k) => /^on[A-Z]/.test(k) && typeof (props as Record<string, unknown>)[k] === "function")
    .sort()
    .join(" ")
  const handlers = React.useMemo(
    () => Object.fromEntries(named.split(" ").filter(Boolean).map((k) => [k, (...a: unknown[]) => ((latest.current as Record<string, unknown>)[k] as Handler | undefined)?.(...a)])),
    [named]
  )
  const text = value == null ? null : String(value)
  React.useLayoutEffect(() => {
    if (text !== null && field.current && field.current.value !== text) field.current.value = text
  }, [text])
  const own = React.useCallback(
    (el: HTMLInputElement | null) => {
      field.current = el
      if (typeof ref === "function") ref(el)
      else if (ref) ref.current = el
    },
    [ref]
  )
  const rest = Object.fromEntries(Object.entries(props).filter(([k]) => !(k in handlers)))
  return <Field {...rest} {...handlers} ref={own} />
}

const Field = React.memo(function Field(props: InputProps) {
  return <input {...props} />
})

// 2026-11-17: `dark:` is written `[&:is(.dark_*)]:`, bb's dark theme (the .dark class; see utils.ts)
function Input({ className, type, ...props }: InputProps) {
  return (
    <StillInput
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm [&:is(.dark_*)]:bg-input/30",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&:is(.dark_*)]:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input, StillInput }
