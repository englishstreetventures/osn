import type { ClaimResult, FamilyMember, PlusOneSaved, RsvpSummary } from "./types";

// What the plus-one prompt needs and nothing else does: finding a member's
// plus-one, how the page's copy of the household changes when one is named,
// renamed or removed, the refusal wording, and the guard on the API's answer.
// Pure, so the prompt that makes the requests and the pages that own the claim
// result share one answer. Only the lazy prompt imports this module, so it
// loads with the prompt rather than on every invite page.

/** The plus-one `inviterId` brought, if one is named. */
export function plusOneOf(
  members: readonly FamilyMember[],
  inviterId: string,
): FamilyMember | undefined {
  return members.find((m) => m.plusOneOf === inviterId);
}

/**
 * Whether any event this person is invited to still has no reply for them —
 * what the prompt reminds the household of once a plus-one is named, since
 * the Respond button's tick does not wait for a plus-one's reply.
 */
export function hasUnansweredEvents(
  member: Pick<FamilyMember, "guestId" | "eventIds">,
  rsvps: readonly Pick<RsvpSummary, "guestId" | "eventId">[],
): boolean {
  return member.eventIds.some(
    (eventId) => !rsvps.some((r) => r.guestId === member.guestId && r.eventId === eventId),
  );
}

/**
 * The household after a plus-one was named or renamed.
 *
 * A new plus-one sits straight after the member who brought them, as the claim
 * payload lists them. A rename keeps their place. If the server's plus-one is
 * not the one this page shows — another device removed ours and named someone
 * else — ours goes, with their replies, and the server's takes the place. When
 * the server cleared a rename's dietary answers, the page drops its copy too,
 * so the sheet cannot send them back; each reply's status stays.
 */
export function withPlusOneSaved(result: ClaimResult, saved: PlusOneSaved): ClaimResult {
  const { plusOne } = saved;
  const member: FamilyMember = {
    guestId: plusOne.guestId,
    firstName: plusOne.firstName,
    lastName: plusOne.lastName,
    nickname: null,
    eventIds: plusOne.eventIds,
    plusOneAllowed: false,
    plusOneOf: plusOne.plusOneOf,
  };

  const shown = plusOneOf(result.members, plusOne.plusOneOf);
  let members: FamilyMember[];
  if (shown) {
    members = result.members.map((m) => (m === shown ? member : m));
  } else {
    // After the inviter; at the end if this page does not know them.
    const after = result.members.findIndex((m) => m.guestId === plusOne.plusOneOf) + 1;
    const at = after === 0 ? result.members.length : after;
    members = [...result.members.slice(0, at), member, ...result.members.slice(at)];
  }

  const gone = shown && shown.guestId !== plusOne.guestId ? shown.guestId : null;
  const rsvps = result.rsvps
    .filter((r) => r.guestId !== gone)
    .map((r): RsvpSummary =>
      saved.dietaryCleared === true && r.guestId === plusOne.guestId
        ? {
            guestId: r.guestId,
            eventId: r.eventId,
            status: r.status,
            dietary: "",
            dietaryPresets: [],
            dietaryConsentCurrent: false,
          }
        : r,
    );

  return { ...result, members, rsvps };
}

/** The household after the plus-one `inviterId` brought was removed: they go,
 *  with their replies, as the server's cascade takes them. */
export function withPlusOneRemoved(result: ClaimResult, inviterId: string): ClaimResult {
  const gone = plusOneOf(result.members, inviterId);
  if (!gone) return result;
  return {
    ...result,
    members: result.members.filter((m) => m !== gone),
    rsvps: result.rsvps.filter((r) => r.guestId !== gone.guestId),
  };
}

/**
 * What to tell the household when the API refuses a plus-one change. Each
 * says what happened and what to do next; the API's `error` code tells apart
 * the refusals that share a status.
 */
export function plusOneRefusalMessage(status: number, code: string | undefined): string {
  switch (status) {
    case 400:
      return "That name can't be saved. Please check the name — it needs at least one letter — and try again.";
    case 401:
      return "Your session expired. Please re-enter your code.";
    case 403:
      if (code === "rsvp_closed") {
        return "RSVPs have closed, so guests can no longer be changed. Please contact the couple directly.";
      }
      if (code === "plus_one_not_allowed") {
        return "Bringing a guest isn't open to you on this invitation. Please contact the couple.";
      }
      return "This invitation can't change guests any more. Please re-enter your code.";
    case 404:
      return "Your invitation has changed since you opened it. Please reload the page.";
    case 409:
      if (code === "guest_capacity") {
        return "The guest list is full, so a guest can't be added. Please contact the couple.";
      }
      return "A guest can't bring a guest of their own.";
    case 413:
      return "That name is too long. Please use a shorter one.";
    case 429:
      return "Too many requests. Please try again in a moment.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/**
 * The body of a 200 from `PUT /api/plus-one/:guestId`: everything the page
 * needs to place the plus-one beside the member who brought them.
 */
export function isValidPlusOneSaveResponse(data: unknown): data is PlusOneSaved {
  if (typeof data !== "object" || data === null) return false;
  if (!("created" in data) || typeof data.created !== "boolean") return false;
  if ("dietaryCleared" in data && typeof data.dietaryCleared !== "boolean") return false;
  if (!("plusOne" in data)) return false;
  const p = data.plusOne;
  if (typeof p !== "object" || p === null) return false;
  if (!("guestId" in p) || typeof p.guestId !== "string") return false;
  if (!("firstName" in p) || typeof p.firstName !== "string") return false;
  if (!("lastName" in p) || typeof p.lastName !== "string") return false;
  if (!("plusOneOf" in p) || typeof p.plusOneOf !== "string") return false;
  if (!("eventIds" in p) || !Array.isArray(p.eventIds)) return false;
  return p.eventIds.every((id: unknown) => typeof id === "string");
}
