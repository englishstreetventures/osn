import type { ClaimResult } from "./types";

export function formatDate(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function isDressSwatch(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === "string" && typeof v.color === "string";
}

export function isValidClaimResponse(data: unknown): data is ClaimResult {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (typeof obj.publicId !== "string") return false;
  if (typeof obj.familyName !== "string") return false;
  if (!Array.isArray(obj.members)) return false;
  if (!Array.isArray(obj.events)) return false;
  if (!Array.isArray(obj.rsvps)) return false;
  const membersValid = obj.members.every((m: unknown) => {
    if (typeof m !== "object" || m === null) return false;
    const mm = m as Record<string, unknown>;
    return (
      typeof mm.guestId === "string" &&
      typeof mm.firstName === "string" &&
      typeof mm.lastName === "string" &&
      Array.isArray(mm.eventIds)
    );
  });
  if (!membersValid) return false;
  const rsvpsValid = obj.rsvps.every((r: unknown) => {
    if (typeof r !== "object" || r === null) return false;
    const rr = r as Record<string, unknown>;
    return (
      typeof rr.guestId === "string" &&
      typeof rr.eventId === "string" &&
      (rr.status === "attending" || rr.status === "declined" || rr.status === "maybe") &&
      typeof rr.dietary === "string"
    );
  });
  if (!rsvpsValid) return false;
  return obj.events.every((e: unknown) => {
    if (typeof e !== "object" || e === null) return false;
    const ev = e as Record<string, unknown>;
    if (typeof ev.id !== "string") return false;
    if (typeof ev.name !== "string") return false;
    if (typeof ev.date !== "string") return false;
    if (typeof ev.location !== "string") return false;
    if (typeof ev.startAt !== "string") return false;
    if (typeof ev.endAt !== "string") return false;
    if (typeof ev.timezone !== "string") return false;
    if (ev.address !== null && typeof ev.address !== "string") return false;
    if (ev.dressCodeDescription !== null && typeof ev.dressCodeDescription !== "string")
      return false;
    if (ev.dressCodePalette !== null) {
      if (!Array.isArray(ev.dressCodePalette)) return false;
      if (!ev.dressCodePalette.every(isDressSwatch)) return false;
    }
    if (ev.pinterestUrl !== null && typeof ev.pinterestUrl !== "string") return false;
    if (ev.mapsUrl !== null && typeof ev.mapsUrl !== "string") return false;
    if (typeof ev.sortOrder !== "number") return false;
    return true;
  });
}
