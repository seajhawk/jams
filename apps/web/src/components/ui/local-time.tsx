"use client"

import { useSyncExternalStore } from "react"

type Format = "datetime" | "date"

const pad = (n: number) => String(n).padStart(2, "0")

/**
 * The same instant, formatted without ICU or the host timezone, so the server and the first client
 * render always agree. Only used until the component has mounted.
 */
export function stableUtc(date: Date, format: Format): string {
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  return format === "date" ? day : `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

function subscribe() {
  return () => {}
}

/**
 * A timestamp in the viewer's own timezone and locale.
 *
 * Calling toLocaleString() in a component that the server renders breaks hydration: the container
 * runs in UTC while the browser does not, and even with matching zones Node's ICU and the
 * browser's can format differently. Both renders agree on a stable UTC string first, then the
 * client switches to local time once mounted.
 */
export function LocalTime({ value, format = "datetime" }: { value: string | Date; format?: Format }) {
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  )
  const date = typeof value === "string" ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return null

  const text = !mounted
    ? stableUtc(date, format)
    : format === "date"
      ? date.toLocaleDateString()
      : date.toLocaleString()

  return <time dateTime={date.toISOString()}>{text}</time>
}
