"use client"

import * as React from "react"

import { Input } from "@/components/ui/input"

type NumberInputProps = Omit<React.ComponentProps<"input">, "type" | "value" | "defaultValue" | "onChange" | "min" | "max"> & {
  value: number
  onValueChange: (value: number) => void
  min?: number
  max?: number
  /** Whole numbers only (the default). Set false for fields that take decimals. */
  integer?: boolean
}

/**
 * A numeric field that can be cleared while typing.
 *
 * A plain `<input type="number" value={n} onChange={(e) => set(Number(e.target.value))}>`
 * turns an emptied field into 0 (or its clamp), so the 0 can't be deleted and the next
 * digit lands after it ("02"). This keeps what the user typed as text, reports a number
 * only when the text is one, and applies `min`/`max` when the field loses focus, so a
 * value on its way to the minimum (typing "2" toward "25") isn't clamped mid-edit.
 */
export function NumberInput({ value, onValueChange, min, max, integer = true, onBlur, ...props }: NumberInputProps) {
  const [draft, setDraft] = React.useState(() => String(value))

  const [shown, setShown] = React.useState(value)

  // Follow changes made outside the field (a size preset, a reset), but leave the
  // draft alone when it already reads as the current value ("02" mid-edit). Done
  // during render rather than in an effect, so there's no extra render pass.
  if (value !== shown) {
    setShown(value)
    if (!(draft.trim() !== "" && Number(draft) === value)) setDraft(String(value))
  }

  const clamp = (n: number) => {
    let v = integer ? Math.trunc(n) : n
    if (min !== undefined) v = Math.max(min, v)
    if (max !== undefined) v = Math.min(max, v)
    return v
  }

  return (
    <Input
      {...props}
      type="number"
      inputMode={integer ? "numeric" : "decimal"}
      min={min}
      max={max}
      value={draft}
      onChange={(e) => {
        const text = e.target.value
        setDraft(text)
        if (text.trim() === "") return
        const n = Number(text)
        if (Number.isFinite(n)) onValueChange(integer ? Math.trunc(n) : n)
      }}
      onBlur={(e) => {
        const n = Number(draft)
        const next = draft.trim() === "" || !Number.isFinite(n) ? clamp(value) : clamp(n)
        setDraft(String(next))
        if (next !== value) onValueChange(next)
        onBlur?.(e)
      }}
    />
  )
}
