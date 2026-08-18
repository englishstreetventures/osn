import type { ClaimResult } from "./types";

// These guards read an untrusted payload one field at a time. Each field is
// proven with `key in value` before it is read, which is what lets the checks
// narrow the value on the spot — no bag-of-unknown stand-in type, and nothing
// is assumed about a field until the check beside it has passed.

function isDressSwatch(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (!("name" in value) || typeof value.name !== "string") return false;
  return "color" in value && typeof value.color === "string";
}

export function isValidClaimResponse(data: unknown): data is ClaimResult {
  if (typeof data !== "object" || data === null) return false;
  if (!("publicId" in data) || typeof data.publicId !== "string") return false;
  if (!("familyName" in data) || typeof data.familyName !== "string") return false;
  if (!("members" in data) || !Array.isArray(data.members)) return false;
  if (!("events" in data) || !Array.isArray(data.events)) return false;
  if (!("rsvps" in data) || !Array.isArray(data.rsvps)) return false;
  const membersValid = data.members.every((m: unknown) => {
    if (typeof m !== "object" || m === null) return false;
    if (!("guestId" in m) || typeof m.guestId !== "string") return false;
    if (!("firstName" in m) || typeof m.firstName !== "string") return false;
    if (!("lastName" in m) || typeof m.lastName !== "string") return false;
    return "eventIds" in m && Array.isArray(m.eventIds);
  });
  if (!membersValid) return false;
  const rsvpsValid = data.rsvps.every((r: unknown) => {
    if (typeof r !== "object" || r === null) return false;
    if (!("guestId" in r) || typeof r.guestId !== "string") return false;
    if (!("eventId" in r) || typeof r.eventId !== "string") return false;
    if (!("status" in r)) return false;
    if (r.status !== "attending" && r.status !== "declined" && r.status !== "maybe") return false;
    return "dietary" in r && typeof r.dietary === "string";
  });
  if (!rsvpsValid) return false;
  return data.events.every((e: unknown) => {
    if (typeof e !== "object" || e === null) return false;
    if (!("id" in e) || typeof e.id !== "string") return false;
    if (!("name" in e) || typeof e.name !== "string") return false;
    if (!("startAt" in e) || typeof e.startAt !== "string") return false;
    if (!("endAt" in e) || typeof e.endAt !== "string") return false;
    if (!("timezone" in e) || typeof e.timezone !== "string") return false;
    if (!("address" in e) || (e.address !== null && typeof e.address !== "string")) return false;
    if (!("dressCodeDescription" in e)) return false;
    if (e.dressCodeDescription !== null && typeof e.dressCodeDescription !== "string") return false;
    if (!("dressCodePalette" in e)) return false;
    if (e.dressCodePalette !== null) {
      if (!Array.isArray(e.dressCodePalette)) return false;
      if (!e.dressCodePalette.every(isDressSwatch)) return false;
    }
    if (!("pinterestUrl" in e) || (e.pinterestUrl !== null && typeof e.pinterestUrl !== "string")) {
      return false;
    }
    if (!("mapsUrl" in e) || (e.mapsUrl !== null && typeof e.mapsUrl !== "string")) return false;
    if (!("sortOrder" in e) || typeof e.sortOrder !== "number") return false;
    return true;
  });
}
