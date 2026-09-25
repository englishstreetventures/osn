import type { ClaimResult, RsvpSummary } from "./types";

// These guards read an untrusted payload one field at a time. Each field is
// proven with `key in value` before it is read, which is what lets the checks
// narrow the value on the spot — no bag-of-unknown stand-in type, and nothing
// is assumed about a field until the check beside it has passed.

function isDressSwatch(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (!("name" in value) || typeof value.name !== "string") return false;
  return "color" in value && typeof value.color === "string";
}

/**
 * One RSVP row, as both the claim response and the save response carry it.
 *
 * Both read the same way downstream — the rows replace the page's copy and seed
 * the next sheet — so one check covers both.
 */
function isRsvpSummary(r: unknown): r is RsvpSummary {
  if (typeof r !== "object" || r === null) return false;
  if (!("guestId" in r) || typeof r.guestId !== "string") return false;
  if (!("eventId" in r) || typeof r.eventId !== "string") return false;
  if (!("status" in r)) return false;
  if (r.status !== "attending" && r.status !== "declined" && r.status !== "maybe") return false;
  if (!("dietary" in r) || typeof r.dietary !== "string") return false;
  // The sheet re-lights its picker from `dietaryPresets` and decides whether
  // the consent box may open ticked from `dietaryConsentCurrent`. Each is
  // proven here when present and may be absent.
  //
  // Absent, not rejected, because both callers of `isValidClaimResponse`
  // read `false` as "no session" and nothing orders this site's production
  // deploy after the API's: a field required here sends every signed-in
  // household back to the code form whenever the site ships first. Absence fails closed at the reader —
  // no presets lit, and a consent box that opens unticked (`=== true`). An
  // API that omits `dietaryPresets` also predates the column, so it stores
  // no presets for the empty picker to overwrite; nor does it store any the
  // guest ticks, which is the price of letting the household in.
  //
  // The keys are checked as strings rather than against the vocabulary on
  // purpose. A key added server-side is a normal, additive change; measured
  // against a closed list here it would make the whole claim response invalid
  // on a site that had not redeployed yet. The picker renders no pill for
  // such a key and hands it back with every change, so an edit never
  // shortens the stored answer.
  if ("dietaryPresets" in r) {
    if (!Array.isArray(r.dietaryPresets)) return false;
    if (!r.dietaryPresets.every((preset: unknown) => typeof preset === "string")) return false;
  }
  return !("dietaryConsentCurrent" in r) || typeof r.dietaryConsentCurrent === "boolean";
}

/** The body of a 200 from `POST /api/rsvp`: the household's rows after the write. */
export function isValidRsvpSaveResponse(data: unknown): data is { rsvps: RsvpSummary[] } {
  if (typeof data !== "object" || data === null) return false;
  return "rsvps" in data && Array.isArray(data.rsvps) && data.rsvps.every(isRsvpSummary);
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
  if (!data.rsvps.every(isRsvpSummary)) return false;
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
