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
 *
 * ## Why a row carries its own search text
 *
 * Every keystroke re-tests every row. Building the lower-cased haystack inside
 * the predicate meant one string concatenation per row per keystroke, for text
 * that never changes between loads. `mergeRows` builds it once instead, and
 * `filterRows` only reads it.
 */

import { presetLabels } from "@cire/dietary";

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
  /**
   * Strings rather than `DietaryPreset`: the vocabulary grows on the server
   * first, so a portal build older than the API can receive a key it does not
   * know. `presetLabels` labels such a key from its own words.
   */
  dietaryPresets: readonly string[];
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
  /** Empty on a row nobody has answered for, same as `dietary`. May hold a
   *  key this build does not know; see `RsvpFilterGuest`. */
  dietaryPresets: readonly string[];
  /** Null on a row nobody has answered for — there is no reply to attribute. */
  consentSource: ConsentSource | null;
  responded: boolean;
  /** Everything a typed word can land on, lower-cased once at merge time. */
  search: string;
}

export const RSVP_FILTERS: readonly { key: RsvpFilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "attending", label: "Attending" },
  { key: "declined", label: "Declined" },
  { key: "maybe", label: "Maybe" },
  { key: "none", label: "No reply" },
];

/**
 * Everything about a row a word can land on, lower-cased once.
 *
 * Preset LABELS, not keys: a host searching for a nut allergy types "nut", not
 * "nuts" and certainly not `no_pork`. The labels are also what the row renders
 * and what the caterer's sheet says, so the three agree on the words a search
 * can find. A key this build does not know is labelled from its own words, so
 * it is found by the same words the row shows.
 */
function haystack(guest: {
  firstName: string;
  lastName: string;
  familyName: string;
  familyCode: string;
  dietary?: string;
  dietaryPresets?: readonly string[];
}): string {
  const presets = presetLabels(guest.dietaryPresets ?? []).join(" ");
  return `${guest.firstName} ${guest.lastName} ${guest.familyName} ${guest.familyCode} ${presets} ${guest.dietary ?? ""}`.toLowerCase();
}

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
    dietaryPresets: guest.dietaryPresets,
    consentSource: guest.consentSource,
    responded: true,
    search: haystack(guest),
  }));
  const silent: RsvpRow[] = event.unresponded.map((guest) => ({
    guestId: guest.guestId,
    firstName: guest.firstName,
    lastName: guest.lastName,
    familyName: guest.familyName,
    familyCode: guest.familyCode,
    status: "none",
    dietary: "",
    dietaryPresets: [],
    consentSource: null,
    responded: false,
    search: haystack(guest),
  }));
  return [...replied, ...silent];
}

function terms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Rows matching both the typed words and the chosen status. */
export function filterRows(rows: RsvpRow[], query: string, filter: RsvpFilterKey): RsvpRow[] {
  const words = terms(query);
  if (words.length === 0 && filter === "all") return rows;
  return rows.filter((row) => {
    if (filter !== "all" && row.status !== filter) return false;
    return words.every((word) => row.search.includes(word));
  });
}

/**
 * How many rows each chip would show, summed over every event. A guest invited
 * to three events counts three times — the chips label rows, and rows are what
 * the list shows.
 *
 * Takes the merged rows rather than the raw events so the caller can hand over
 * a merge it already holds; re-merging here would do the same work twice on
 * every load.
 */
export function statusCounts(rowGroups: Iterable<RsvpRow[]>) {
  const counts = {
    all: 0,
    attending: 0,
    declined: 0,
    maybe: 0,
    none: 0,
  } satisfies Record<RsvpFilterKey, number>;
  for (const rows of rowGroups) {
    for (const row of rows) {
      counts.all += 1;
      counts[row.status] += 1;
    }
  }
  return counts;
}
