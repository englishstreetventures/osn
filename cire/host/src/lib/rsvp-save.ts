/**
 * Folding one saved organiser reply into the RSVP view, so a save costs one
 * request instead of a PUT followed by a reload of the whole wedding.
 *
 * The PUT answers with the row as stored. The guest's names, household and
 * plus-one link are already on the page, in `guests` when they had replied and
 * in `unresponded` when they had not, so the reply's own fields are all that
 * change. The event's tallies come from the API and the header prints them
 * as they are, so they move here too: one count from the old status to the new,
 * and, for a first reply, one guest from "no response" to "responded".
 *
 * What it does not do is pick up anyone else's writes since the page loaded;
 * the next visit does that.
 */

import type { ConsentSource, RsvpFilterEvent, RsvpFilterGuest, RsvpStatus } from "./rsvp-filter";

/** The counts the event header prints. */
export interface RsvpTallies {
  attending: number;
  declined: number;
  maybe: number;
  responded: number;
  noResponse: number;
}

/** The stored row the organiser PUT answers with. */
export interface SavedReply {
  guestId: string;
  status: RsvpStatus;
  dietary: string;
  dietaryPresets: readonly string[];
  consentSource: ConsentSource;
}

const STATUSES: ReadonlySet<unknown> = new Set(["attending", "declined", "maybe"]);
const SOURCES: ReadonlySet<unknown> = new Set(["guest", "organiser_attested", "inviter_attested"]);

/** Whether a PUT body's `rsvp` is a stored row this page can fold in. */
export function isSavedReply(value: unknown): value is SavedReply {
  return (
    typeof value === "object" &&
    value !== null &&
    "guestId" in value &&
    typeof value.guestId === "string" &&
    "status" in value &&
    STATUSES.has(value.status) &&
    "dietary" in value &&
    typeof value.dietary === "string" &&
    "dietaryPresets" in value &&
    Array.isArray(value.dietaryPresets) &&
    value.dietaryPresets.every((key) => typeof key === "string") &&
    "consentSource" in value &&
    SOURCES.has(value.consentSource)
  );
}

/**
 * Where a guest's first reply goes in `guests`: after the last reply from the
 * same household, else before the first household whose code sorts after
 * theirs. The API orders replies by household code, so this is where a reload
 * would put it.
 */
function insertionIndex(guests: readonly RsvpFilterGuest[], familyCode: string): number {
  let lastOfHousehold = -1;
  for (let i = 0; i < guests.length; i += 1) {
    if (guests[i]!.familyCode === familyCode) lastOfHousehold = i;
  }
  if (lastOfHousehold >= 0) return lastOfHousehold + 1;
  const after = guests.findIndex((guest) => guest.familyCode > familyCode);
  return after === -1 ? guests.length : after;
}

/**
 * The event with `saved` folded in, or null when the guest is in neither list
 * (the page is out of step with the API, and the caller should reload).
 */
export function applySavedReply<E extends RsvpFilterEvent & RsvpTallies>(
  event: E,
  saved: SavedReply,
): E | null {
  const fields = {
    status: saved.status,
    dietary: saved.dietary,
    dietaryPresets: saved.dietaryPresets,
    consentSource: saved.consentSource,
    // The organiser who saved it wrote it, so no household member did.
    statusRecordedByHost: true,
    submittedBy: null,
  };

  const at = event.guests.findIndex((guest) => guest.guestId === saved.guestId);
  if (at >= 0) {
    const prior = event.guests[at]!;
    const guests = [...event.guests];
    guests[at] = { ...prior, ...fields };
    const tallies = { attending: event.attending, declined: event.declined, maybe: event.maybe };
    tallies[prior.status] = Math.max(0, tallies[prior.status] - 1);
    tallies[saved.status] += 1;
    return { ...event, ...tallies, guests };
  }

  const was = event.unresponded.findIndex((guest) => guest.guestId === saved.guestId);
  if (was < 0) return null;
  const invited = event.unresponded[was]!;
  const guests = [...event.guests];
  guests.splice(insertionIndex(guests, invited.familyCode), 0, { ...invited, ...fields });
  return {
    ...event,
    [saved.status]: event[saved.status] + 1,
    responded: event.responded + 1,
    noResponse: Math.max(0, event.noResponse - 1),
    guests,
    unresponded: event.unresponded.filter((_, i) => i !== was),
  };
}
