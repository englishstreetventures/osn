import type { EventRow } from "../../src/lib/events-store";
import type { OrganiserGuestRow } from "../../src/lib/guests-store";
import type { OrganiserHouseholdRow } from "../../src/lib/households-store";
import type { RsvpFilterInvitedGuest } from "../../src/lib/rsvp-filter";
import { eventPayload } from "./rsvp-guests";

/**
 * A wedding at the size the Guests module has to hold: 300 households, five
 * events, 900 guests, served the way the API serves it — the guest rows for
 * Households and the editor, the households, the events, and the RSVP read.
 * Plain exports, imported at the top of a browser test: a `vi.mock` factory
 * cannot import from `test-support/` in the browser project.
 *
 * The mix is a real list's: households of one to five, short names and the
 * longest the RSVP fixture carries, a household name that is two surnames, a
 * plus-one in every fourth household, an address on every third guest, some
 * households sent, opened or deactivated, and event names long enough that
 * the editor's narrow columns cut one short.
 */

const SURNAMES = [
  "Sharma",
  "Okonkwo",
  "Nguyen",
  "Fitzgerald-Montgomery",
  "Ó Súilleabháin",
  "Papadopoulos",
  "Van der Berg",
  "Takahashi",
  "Wolfeschlegelsteinhausenbergerdorff",
  "Lindqvist",
  "Haddad",
  "MacLeod",
];
const FIRST = [
  "Ada",
  "Bo",
  "Chiamaka",
  "Dmitri",
  "Elif",
  "Finn",
  "Grace",
  "Hamish",
  "Ines",
  "Jomo",
  "Kai",
  "Maximilian-Alexander",
];

export const EVENT_IDS = [
  "evt_mehndi",
  "evt_sangeet",
  "evt_ceremony",
  "evt_reception",
  "evt_brunch",
];
const EVENT_NAMES = [
  "Mehndi",
  "Sangeet night and welcome dinner",
  "Ceremony",
  "Reception",
  "Farewell brunch",
];

export const EVENTS_300: EventRow[] = EVENT_IDS.map((id, i) => ({
  id,
  name: EVENT_NAMES[i]!,
  slug: id.replace("evt_", ""),
  sortOrder: i,
  startAt: `2026-11-${String(10 + i).padStart(2, "0")}T18:00+11:00`,
  endAt: "",
  timezone: "Australia/Sydney",
  address: null,
  description: "",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  imageUrl: null,
  imageCrop: null,
}));

/** The household at index `h`: its code, its name, its size. */
function household(h: number) {
  const last = SURNAMES[h % SURNAMES.length]!;
  const familyName = h % 9 === 0 ? `${last} & ${SURNAMES[(h + 5) % SURNAMES.length]}` : last;
  return {
    familyId: `fam_${h}`,
    publicId: `${last
      .slice(0, 4)
      .toUpperCase()
      .replace(/[^A-Z]/g, "X")}-KITE-${String(h).padStart(3, "0")}`,
    familyName: `${familyName} ${h}`,
    size: (h % 5) + 1,
  };
}

function build() {
  const guests: OrganiserGuestRow[] = [];
  const households: OrganiserHouseholdRow[] = [];
  for (let h = 0; h < 300; h += 1) {
    const home = household(h);
    const state = {
      codeSharedAt: h % 3 === 1 ? 1_700_000_000_000 : null,
      firstOpenedAt: h % 7 === 2 ? 1_700_100_000_000 : null,
      deactivatedAt: h % 41 === 5 ? 1_700_200_000_000 : null,
    };
    const start = guests.length;
    for (let i = 0; i < home.size; i += 1) {
      const n = guests.length;
      const plusOne = h % 4 === 0 && i === home.size - 1 && home.size > 1;
      guests.push({
        guestId: `g${n}`,
        familyId: home.familyId,
        publicId: home.publicId,
        familyName: home.familyName,
        firstName: FIRST[(n * 7) % FIRST.length]!,
        lastName: SURNAMES[h % SURNAMES.length]!,
        nickname: null,
        events: EVENT_IDS.filter((_, e) => (n + e) % 3 !== 0),
        plusOneAllowed: h % 4 === 0 && i === 0,
        plusOneOf: plusOne ? `g${start}` : null,
        email: n % 3 === 0 ? `guest${n}@example.com` : null,
        emailSource: n % 3 === 0 ? (n % 2 === 0 ? "guest" : "organiser_attested") : null,
        emailOptedOut: false,
        ...state,
      });
    }
    households.push({
      familyId: home.familyId,
      publicId: home.publicId,
      familyName: home.familyName,
      guestCount: home.size,
      ...state,
    });
  }
  return { guests, households };
}

const BUILT = build();
export const GUESTS_300: OrganiserGuestRow[] = BUILT.guests;
export const HOUSEHOLDS_300: OrganiserHouseholdRow[] = BUILT.households;

/** The same guests, as the RSVP read names them. */
const invited: RsvpFilterInvitedGuest[] = GUESTS_300.map((g) => {
  const inviter = g.plusOneOf ? GUESTS_300.find((x) => x.guestId === g.plusOneOf) : undefined;
  return {
    guestId: g.guestId,
    firstName: g.firstName,
    lastName: g.lastName,
    familyName: g.familyName,
    familyCode: g.publicId,
    plusOneOf: g.plusOneOf ?? null,
    plusOneOfName: inviter ? `${inviter.firstName} ${inviter.lastName}` : null,
  };
});

export const RSVPS_300 = {
  events: EVENT_IDS.map((id, i) =>
    eventPayload(
      id,
      EVENT_NAMES[i]!,
      invited.filter((g) => GUESTS_300.find((x) => x.guestId === g.guestId)!.events.includes(id)),
      i,
    ),
  ),
};
