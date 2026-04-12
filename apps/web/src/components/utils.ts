import type { ClaimResult } from "./types"

export function formatDate(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00`)
  return date.toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
}

export function parseMembers(guestName: string): string[] {
  if (guestName.includes("&")) {
    return guestName
      .split("&")
      .map((n) => n.trim())
      .filter(Boolean)
  }
  return [guestName]
}

export function isValidClaimResponse(data: unknown): data is ClaimResult {
  if (typeof data !== "object" || data === null) return false
  const obj = data as Record<string, unknown>
  if (typeof obj.guestName !== "string") return false
  if (!Array.isArray(obj.events)) return false
  return obj.events.every(
    (e: unknown) =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as Record<string, unknown>).id === "string" &&
      typeof (e as Record<string, unknown>).name === "string" &&
      typeof (e as Record<string, unknown>).date === "string" &&
      typeof (e as Record<string, unknown>).location === "string",
  )
}
