import type { DietaryPreset } from "@cire/dietary";

import type { RsvpFilterGuest, RsvpFilterInvitedGuest } from "../../src/lib/rsvp-filter";

/**
 * A wedding-sized RSVP payload for the browser tier, shared by the layout and
 * event-tab suites so both measure the same list. Plain exports, imported at
 * the top of a test file: the `vi.mock` factory idiom in `mocks.ts` does not
 * resolve in the browser project, but a static import does.
 */

// ── A wedding-sized guest list ───────────────────────────────────────────────
// Three events, the same 300 guests invited to each: 900 rows. Deterministic,
// so a run can be repeated. The mix is what a real list carries: short and long
// names, a name with no break in it, households of one to four, free-text
// dietary notes up to a sentence, preset-only replies, host-entered replies,
// plus-ones marked with their inviter's full name (the longest names included)
// and badged Household-entered, and a third of the list still to answer.

const FIRST = [
  "Ada",
  "Aiko",
  "Amara",
  "Arjun",
  "Beatrix",
  "Bo",
  "Chiamaka",
  "Cleo",
  "Dev",
  "Dmitri",
  "Elif",
  "Emeka",
  "Farah",
  "Finn",
  "Grace",
  "Hamish",
  "Ines",
  "Isla",
  "Jomo",
  "Kai",
  "Leila",
  "Luca",
  "Mei",
  "Mateo",
  "Nadia",
  "Niamh",
  "Oscar",
  "Priya",
  "Quentin",
  "Rosa",
  "Saoirse",
  "Tariq",
  "Uma",
  "Viktor",
  "Wen",
  "Xavier",
  "Yusuf",
  "Zara",
  "Maximilian-Alexander",
  "Anastasia",
];
const LAST = [
  "Sharma",
  "Jones",
  "Rao",
  "Okonkwo",
  "Nguyen",
  "Fitzgerald-Montgomery",
  "Shapiro",
  "Shaw",
  "Sheridan",
  "Schultz",
  "Smith",
  "Ó Súilleabháin",
  "Papadopoulos",
  "Kowalczyk",
  "Van der Berg",
  "Takahashi",
  "Mbeki",
  "Hernández",
  "Lindqvist",
  "Abernathy",
  "Chen",
  "Rossi",
  "Dubois",
  "Haddad",
  "Ivanova",
  "MacLeod",
  "Oyelaran",
  "Park",
  "Silva",
  "Wojciechowski",
  "Wolfeschlegelsteinhausenbergerdorff",
];
const NOTES = [
  "",
  "",
  "",
  "Coeliac — no cross-contamination please",
  "Severe tree nut allergy, carries an EpiPen. Please flag to the caterer before the day.",
  "Low FODMAP",
  "Can eat fish but not shellfish; no raw egg in desserts either",
  "Toddler — high chair and plain pasta",
];
const PRESET_SETS: DietaryPreset[][] = [
  [],
  [],
  ["vegetarian"],
  ["vegan", "gluten"],
  ["halal", "no_alcohol"],
  ["nuts", "sesame", "other"],
  ["pescatarian", "dairy"],
];
const STATUSES = ["attending", "attending", "declined", "maybe"] as const;

export function guestList(count: number): RsvpFilterInvitedGuest[] {
  const guests: RsvpFilterInvitedGuest[] = [];
  let household = 0;
  while (guests.length < count) {
    const size = (household % 4) + 1;
    const last = LAST[household % LAST.length]!;
    const familyName =
      household % 9 === 0 ? `${last} & ${LAST[(household + 7) % LAST.length]}` : last;
    for (let i = 0; i < size && guests.length < count; i += 1) {
      const n = guests.length;
      // Every other household of two or more brings a plus-one, who is the
      // household's last member and names the one before them as inviter.
      const inviter = i === size - 1 && size > 1 && household % 2 === 0 ? guests[n - 1] : undefined;
      guests.push({
        guestId: `g${n}`,
        firstName: FIRST[(n * 7) % FIRST.length]!,
        lastName: last,
        familyName,
        familyCode: `${last.slice(0, 4).toUpperCase()}-${String(household).padStart(3, "0")}`,
        plusOneOf: inviter?.guestId ?? null,
        plusOneOfName: inviter ? `${inviter.firstName} ${inviter.lastName}` : null,
      });
    }
    household += 1;
  }
  return guests;
}

export function eventPayload(
  id: string,
  name: string,
  guests: RsvpFilterInvitedGuest[],
  seed: number,
) {
  const replied: RsvpFilterGuest[] = [];
  const silent: RsvpFilterInvitedGuest[] = [];
  for (const [i, guest] of guests.entries()) {
    const k = i + seed;
    if (k % 3 === 0) {
      silent.push(guest);
      continue;
    }
    const presets = PRESET_SETS[k % PRESET_SETS.length]!;
    replied.push({
      ...guest,
      status: STATUSES[k % STATUSES.length]!,
      dietary: presets.includes("other") || k % 5 === 0 ? NOTES[k % NOTES.length]! : "",
      dietaryPresets: presets,
      consentSource:
        k % 10 === 0 ? "organiser_attested" : guest.plusOneOf ? "inviter_attested" : "guest",
    });
  }
  const count = (s: string) => replied.filter((g) => g.status === s).length;
  return {
    id,
    name,
    invited: guests.length,
    attending: count("attending"),
    declined: count("declined"),
    maybe: count("maybe"),
    responded: replied.length,
    noResponse: silent.length,
    guests: replied,
    unresponded: silent,
  };
}
