/**
 * Search, status filtering and sorting for the RSVP list.
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
 * caterer's question, and it has no other home in the portal. So is the line a
 * plus-one's row shows under their name: "plus-one" lists every plus-one, and
 * the inviter's name finds the guest they brought.
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
/** Who gave a reply: the guest, an organiser on their behalf, or — for a
 *  plus-one — the household that brought them. */
export type ConsentSource = "guest" | "organiser_attested" | "inviter_attested";

/** The household member who sent a reply, and whether through a linked musubi
 *  account. */
export interface ReplySubmitter {
  guestId: string;
  firstName: string;
  viaLink: boolean;
}

/** What a plus-one's marker says when the API names no inviter. */
export const UNNAMED_INVITER = "another guest";

/** Who brought a plus-one, in words: what a screen reader hears and the
 *  search reads. */
export function plusOneMarker(row: { plusOneOfName: string | null }): string {
  return `Plus-one of ${row.plusOneOfName ?? UNNAMED_INVITER}`;
}

/** The same, for the eye: "+1 · Kai", the inviter's first name, or a bare
 *  "+1" when the API names no inviter. A plus-one is never written out on
 *  screen (`cire/host/DESIGN.md` §Names and meta lines). */
export function plusOneShort(row: { plusOneOfName: string | null }): string {
  const first = row.plusOneOfName?.trim().split(/\s+/)[0];
  return first ? `+1 · ${first}` : "+1";
}

/**
 * Who brought a guest, when the guest is a plus-one. Optional because the
 * portal can deploy before the API that sends them; absent reads as "not a
 * plus-one".
 */
interface PlusOneLink {
  /** The guest id of the member who brought them. */
  plusOneOf?: string | null;
  /** That member's full name, or null when the API could not name them. */
  plusOneOfName?: string | null;
}

export interface RsvpFilterGuest extends PlusOneLink {
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
  /** Whether a host made the reply's latest write. Absent from an API that
   *  predates it, which reads as "no". */
  statusRecordedByHost?: boolean;
  /** Who sent the reply; absent from an API that predates member attribution. */
  submittedBy?: ReplySubmitter | null;
}

export interface RsvpFilterInvitedGuest extends PlusOneLink {
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
  /** A host made the reply's latest write. False on a row nobody has answered
   *  for. */
  statusRecordedByHost: boolean;
  /** Null on a row nobody has answered for, and on a reply with no member
   *  recorded. */
  submittedBy: ReplySubmitter | null;
  /** Set on a plus-one's row: the guest id of the member who brought them. */
  plusOneOf: string | null;
  /** That member's full name; null when the row is not a plus-one's, or the
   *  API could not name them. */
  plusOneOfName: string | null;
  responded: boolean;
  /** Everything a typed word can land on, lower-cased once at merge time. */
  search: string;
  /** The surname and household name a sort compares, trimmed once at merge
   *  time: a sort compares each row many times, and the names never change
   *  between loads. */
  sortSurname: string;
  sortHousehold: string;
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
function haystack(
  guest: {
    firstName: string;
    lastName: string;
    familyName: string;
    familyCode: string;
    dietary?: string;
    dietaryPresets?: readonly string[];
  },
  link: { plusOneOf: string | null; plusOneOfName: string | null },
): string {
  const presets = presetLabels(guest.dietaryPresets ?? []).join(" ");
  const base = `${guest.firstName} ${guest.lastName} ${guest.familyName} ${guest.familyCode} ${presets} ${guest.dietary ?? ""}`;
  const plusOne = link.plusOneOf === null ? "" : ` ${plusOneMarker(link)}`;
  return `${base}${plusOne}`.toLowerCase();
}

/** A row's plus-one fields, null for anyone who is not one. */
function plusOneLink(guest: PlusOneLink) {
  const plusOneOf = guest.plusOneOf ?? null;
  return { plusOneOf, plusOneOfName: plusOneOf === null ? null : (guest.plusOneOfName ?? null) };
}

/** Replies in the order the API gave them, then the guests who owe one. */
export function mergeRows(event: RsvpFilterEvent): RsvpRow[] {
  const replied: RsvpRow[] = event.guests.map((guest) => {
    const link = plusOneLink(guest);
    return {
      guestId: guest.guestId,
      firstName: guest.firstName,
      lastName: guest.lastName,
      familyName: guest.familyName,
      familyCode: guest.familyCode,
      status: guest.status,
      dietary: guest.dietary,
      dietaryPresets: guest.dietaryPresets,
      consentSource: guest.consentSource,
      statusRecordedByHost: guest.statusRecordedByHost ?? false,
      submittedBy: guest.submittedBy ?? null,
      ...link,
      responded: true,
      search: haystack(guest, link),
      sortSurname: guest.lastName.trim(),
      sortHousehold: guest.familyName.trim(),
    };
  });
  const silent: RsvpRow[] = event.unresponded.map((guest) => {
    const link = plusOneLink(guest);
    return {
      guestId: guest.guestId,
      firstName: guest.firstName,
      lastName: guest.lastName,
      familyName: guest.familyName,
      familyCode: guest.familyCode,
      status: "none",
      dietary: "",
      dietaryPresets: [],
      consentSource: null,
      statusRecordedByHost: false,
      submittedBy: null,
      ...link,
      responded: false,
      search: haystack(guest, link),
      sortSurname: guest.lastName.trim(),
      sortHousehold: guest.familyName.trim(),
    };
  });
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
 * How many rows each chip would show in one event. The chips filter the event
 * on screen, so they count its rows — every one, whatever the search, because
 * they are the way out of the current search rather than a description of it.
 */
export function statusCounts(rows: readonly RsvpRow[]) {
  const counts = {
    all: 0,
    attending: 0,
    declined: 0,
    maybe: 0,
    none: 0,
  } satisfies Record<RsvpFilterKey, number>;
  for (const row of rows) {
    counts.all += 1;
    counts[row.status] += 1;
  }
  return counts;
}

/** The columns a host can sort by. */
export type RsvpSortKey = "guest" | "household";
/** Spelled as `aria-sort` spells it, so the head can carry it as it is. */
export type RsvpSortDirection = "ascending" | "descending";
export interface RsvpSort {
  key: RsvpSortKey;
  direction: RsvpSortDirection;
}

/**
 * The next sort after a click on a column head: a new column sorts ascending,
 * and the column already sorted turns round.
 */
export function nextSort(current: RsvpSort | null, key: RsvpSortKey): RsvpSort {
  if (current?.key === key) {
    return { key, direction: current.direction === "ascending" ? "descending" : "ascending" };
  }
  return { key, direction: "ascending" };
}

// The host's own locale, base sensitivity: "de Vries" and "De Vries" are one
// surname, and "Ó Súilleabháin" files with the Os. One collator for every
// comparison, because building one per call is most of what a sort costs.
const collator = new Intl.Collator(undefined, { sensitivity: "base" });

/** Blank text sorts after any text, whichever way the column runs. Takes the
 *  trimmed sort keys. */
function blankLast(a: string, b: string): number {
  return Number(a === "") - Number(b === "");
}

/**
 * Rows in the order a column head asks for, as a new array; `null` hands the
 * rows back as `mergeRows` built them: replies, then the guests still to
 * answer, each in the API's order.
 *
 * - **Guest** sorts by surname, then first name. A guest with no surname — the
 *   column defaults to empty — comes after every guest with one, in both
 *   directions, ordered among themselves by first name. A plus-one with a
 *   surname of their own leaves their inviter's side; the line under their
 *   name still says who brought them.
 * - **Household** sorts whole households by name, and two households with one
 *   name by their codes so they never interleave. Inside a household the rows
 *   keep the order they came in: the replies, then the guests still to answer,
 *   each in the API's order — the couple's own, with a plus-one after the
 *   guest who brought them when both are on the same side. A household with
 *   no name comes last.
 *
 * The sort is stable, so rows that tie keep the order they came in.
 */
export function sortRows(rows: RsvpRow[], sort: RsvpSort | null): RsvpRow[] {
  if (sort === null) return rows;
  const sign = sort.direction === "ascending" ? 1 : -1;
  const compare =
    sort.key === "guest"
      ? (a: RsvpRow, b: RsvpRow) =>
          blankLast(a.sortSurname, b.sortSurname) ||
          sign *
            (collator.compare(a.sortSurname, b.sortSurname) ||
              collator.compare(a.firstName, b.firstName))
      : (a: RsvpRow, b: RsvpRow) =>
          blankLast(a.sortHousehold, b.sortHousehold) ||
          sign *
            (collator.compare(a.sortHousehold, b.sortHousehold) ||
              collator.compare(a.familyCode, b.familyCode));
  return rows.toSorted(compare);
}
