/**
 * Search and status filtering for the RSVP list.
 *
 * ## Why the merge lives here
 *
 * The API hands each event two lists: `guests`, who replied, and `unresponded`,
 * who were invited and have said nothing. The view shows one list, because the
 * question a host actually asks — "who still hasn't answered?" — spans both, and
 * a silent guest is the row they most want to act on. So the two collapse into
 * one row type with a fourth status, `"none"`, and the filter treats it like any
 * other.
 *
 * ## Why every term must match, not the phrase
 *
 * A host types what they remember, in the order they remember it: "jones cleo".
 * A substring test on the whole phrase fails that; testing each word against the
 * row's text does not. It also makes "sharma gluten" a way to ask a narrower
 * question without any extra controls.
 *
 * Dietary text is part of what a word can match on purpose. "Search nut" is the
 * caterer's question, and it has no other home in the portal.
 */

export type RsvpStatus = "attending" | "declined" | "maybe";
/** A row's status, including the guests who have not replied at all. */
export type RsvpRowStatus = RsvpStatus | "none";
/** What the chips filter by — every status, plus the unfiltered default. */
export type RsvpFilterKey = "all" | RsvpRowStatus;
export type ConsentSource = "guest" | "organiser_attested";

export interface RsvpFilterGuest {
  guestId: string;
  firstName: string;
  lastName: string;
  familyName: string;
  familyCode: string;
  status: RsvpStatus;
  dietary: string;
  consentSource: ConsentSource;
}

export interface RsvpFilterInvitedGuest {
  guestId: string;
  firstName: string;
  lastName: string;
  familyName: string;
  familyCode: string;
}

export interface RsvpFilterEvent {
  guests: RsvpFilterGuest[];
  unresponded: RsvpFilterInvitedGuest[];
}

export interface RsvpRow {
  guestId: string;
  firstName: string;
  lastName: string;
  familyName: string;
  familyCode: string;
  status: RsvpRowStatus;
  dietary: string;
  /** Null on a row nobody has answered for — there is no reply to attribute. */
  consentSource: ConsentSource | null;
  responded: boolean;
}

export const RSVP_FILTERS: readonly { key: RsvpFilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "attending", label: "Attending" },
  { key: "declined", label: "Declined" },
  { key: "maybe", label: "Maybe" },
  { key: "none", label: "No reply" },
];

/** Replies in the order the API gave them, then the guests who owe one. */
export function mergeRows(event: RsvpFilterEvent): RsvpRow[] {
  const replied: RsvpRow[] = event.guests.map((guest) => ({
    guestId: guest.guestId,
    firstName: guest.firstName,
    lastName: guest.lastName,
    familyName: guest.familyName,
    familyCode: guest.familyCode,
    status: guest.status,
    dietary: guest.dietary,
    consentSource: guest.consentSource,
    responded: true,
  }));
  const silent: RsvpRow[] = event.unresponded.map((guest) => ({
    guestId: guest.guestId,
    firstName: guest.firstName,
    lastName: guest.lastName,
    familyName: guest.familyName,
    familyCode: guest.familyCode,
    status: "none",
    dietary: "",
    consentSource: null,
    responded: false,
  }));
  return [...replied, ...silent];
}

/** Everything about a row a word can land on, lower-cased once per test. */
function haystack(row: RsvpRow): string {
  return `${row.firstName} ${row.lastName} ${row.familyName} ${row.familyCode} ${row.dietary}`.toLowerCase();
}

function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Rows matching both the typed words and the chosen status. */
export function filterRows(rows: RsvpRow[], query: string, filter: RsvpFilterKey): RsvpRow[] {
  const words = terms(query);
  return rows.filter((row) => {
    if (filter !== "all" && row.status !== filter) return false;
    if (words.length === 0) return true;
    const text = haystack(row);
    return words.every((word) => text.includes(word));
  });
}

/**
 * How many rows each chip would show, summed over every event. A guest invited
 * to three events counts three times — the chips label rows, and rows are what
 * the list shows.
 */
export function statusCounts(events: RsvpFilterEvent[]): Record<RsvpFilterKey, number> {
  const counts: Record<RsvpFilterKey, number> = {
    all: 0,
    attending: 0,
    declined: 0,
    maybe: 0,
    none: 0,
  };
  for (const event of events) {
    for (const row of mergeRows(event)) {
      counts.all += 1;
      counts[row.status] += 1;
    }
  }
  return counts;
}
