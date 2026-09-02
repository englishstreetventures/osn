// Synthetic guest list at production scale — ~195 extra households on top of the
// four canonical ones, plus the replies they have sent in.
//
// WHY THIS EXISTS. The live wedding carries 199 families / 558 guests / 1282
// invitations / 181 replies. The four canonical families are six guests between
// them, and at six guests EVERYTHING looks fine: pagination never paginates, the
// guest table never scrolls, an export is one screen, a summary that counts
// wrong is off by one instead of by ninety, and an N+1 query costs nothing. A
// dev tier that only holds the canonical fixture cannot show you the problems
// production has. So the dev seed gets a list the same size as the real one.
//
// WHY IT IS SEPARATE from guests.ts. The canonical four are consumed by BOTH
// the SQL seed and cire/api/src/db/setup.ts#seedDb (the in-memory test seed),
// and dozens of route tests assert against their exact ids and counts. This
// module is imported ONLY by cire/db/seed/generate.ts, so the API test fixture
// stays six guests and stays fast.
//
// WHY IT IS DETERMINISTIC. tests/seed/seed.test.ts re-runs the generator and compares
// the output byte-for-byte against the committed SQL, so anything random makes
// CI fail on every unrelated run. Every value below comes from a fixed-seed
// mulberry32 PRNG drawn in a fixed order: same input, same 200 KB of SQL,
// forever. Never reach for Math.random or Date.now in this file.
//
// THE PEOPLE ARE INVENTED. Not one row is copied or derived from a real guest
// list — names come from the pools below and are combined by the PRNG. A dev
// tier is not the place for anyone's real name, address or dietary requirement.

import { events } from "./events";
import { guests as canonicalFamilies, type SeedFamily, type SeedGuest } from "./guests";
import type { SeedRsvp } from "./rsvps";

// Bump this and every id, name, code and reply below changes together. There is
// nothing special about the value — it is a fixed arbitrary constant so the
// output is reproducible.
const SEED = 0x0c1_7e5;

/** Households to synthesise. 195 + the canonical 4 ≈ the live wedding's 199. */
const HOUSEHOLD_COUNT = 195;

/**
 * mulberry32 — a small, fast, fully deterministic PRNG. Not cryptographic and
 * doesn't need to be: nothing here is a secret. The claim codes it mints are
 * dev-only and the tier is a throwaway.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const rng = mulberry32(SEED);

/** Uniform pick from a non-empty list. */
function pick<T>(list: readonly T[]): T {
  return list[Math.floor(rng() * list.length)]!;
}

/** Integer in `[min, max]`. */
function intBetween(min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * Pick by weight. Weights need not sum to 1 — they are normalised here — but
 * the ORDER of entries is part of the determinism contract, so append rather
 * than reorder if you change these.
 */
function weighted<T>(entries: readonly (readonly [T, number])[]): T {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [value, w] of entries) {
    roll -= w;
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1]![0];
}

const FIRST_NAMES = [
  "Aarav",
  "Adam",
  "Aisha",
  "Alice",
  "Amara",
  "Ananya",
  "Andrew",
  "Anita",
  "Arjun",
  "Beatrix",
  "Ben",
  "Cassie",
  "Charlotte",
  "Chloe",
  "Daniel",
  "Deepa",
  "Divya",
  "Eleanor",
  "Elias",
  "Emma",
  "Farah",
  "Felix",
  "Fiona",
  "Gabriel",
  "Georgia",
  "Grace",
  "Hannah",
  "Harold",
  "Hugo",
  "Imogen",
  "Isabel",
  "Ishaan",
  "Jacob",
  "Jasmine",
  "Joseph",
  "Julia",
  "Kavya",
  "Kiran",
  "Laila",
  "Leo",
  "Lucas",
  "Maeve",
  "Marco",
  "Maya",
  "Meera",
  "Nadia",
  "Nathan",
  "Neha",
  "Nikhil",
  "Oliver",
  "Olivia",
  "Omar",
  "Patrick",
  "Priya",
  "Rachel",
  "Rahul",
  "Ravi",
  "Rosa",
  "Ruby",
  "Samir",
  "Sarah",
  "Simon",
  "Sofia",
  "Tara",
  "Theo",
  "Thomas",
  "Uma",
  "Vikram",
  "Vivian",
  "Wren",
  "Yusuf",
  "Zara",
] as const;

const SURNAMES = [
  "Abbott",
  "Ahuja",
  "Aleman",
  "Bhandari",
  "Blackwood",
  "Bose",
  "Caldwell",
  "Chandra",
  "Chatterjee",
  "Conway",
  "Dalgleish",
  "Desai",
  "Doyle",
  "Duggan",
  "Ellery",
  "Fairbanks",
  "Ferreira",
  "Gallagher",
  "Ghosh",
  "Grimshaw",
  "Halloran",
  "Hartley",
  "Iyer",
  "Jayaram",
  "Kapadia",
  "Keating",
  "Khatri",
  "Lachlan",
  "Lombardi",
  "Mahajan",
  "Mansfield",
  "Menon",
  "Mistry",
  "Moriarty",
  "Nadkarni",
  "Nolan",
  "Oakley",
  "Pemberton",
  "Pillai",
  "Prescott",
  "Quinlan",
  "Raghavan",
  "Ranganathan",
  "Redmond",
  "Sandoval",
  "Sattler",
  "Sengupta",
  "Shackleton",
  "Sinclair",
  "Sridhar",
  "Stanhope",
  "Tandon",
  "Thackeray",
  "Trivedi",
  "Ulster",
  "Vasquez",
  "Venkatesh",
  "Wadsworth",
  "Whitlock",
  "Yardley",
] as const;

/**
 * Word segment for the claim code. A short stand-in for the API's 369-word
 * pleasant list — cire/db must not import from cire/api, and 44 words is ample
 * for readability on a dev tier where the codes protect nothing real.
 */
const CODE_WORDS = [
  "AMBER",
  "ANCHOR",
  "ASPEN",
  "BEACON",
  "BIRCH",
  "BLOSSOM",
  "BRIGHT",
  "CANDLE",
  "CEDAR",
  "CLOVER",
  "COMET",
  "CORAL",
  "DAISY",
  "DAWN",
  "DELTA",
  "EMBER",
  "FABLE",
  "FEATHER",
  "FERN",
  "GARLAND",
  "HALO",
  "HARBOUR",
  "HAZEL",
  "INDIGO",
  "IVORY",
  "JASPER",
  "JUNIPER",
  "KESTREL",
  "LANTERN",
  "LAUREL",
  "LINDEN",
  "MARBLE",
  "MEADOW",
  "NECTAR",
  "OPAL",
  "ORCHARD",
  "PEBBLE",
  "QUILL",
  "RIBBON",
  "SAFFRON",
  "TANSY",
  "THISTLE",
  "VELVET",
  "WILLOW",
] as const;

/** Crockford base32, same alphabet the real generator uses (no I/L/O/U). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const DIETARY_NOTES = [
  "Vegetarian.",
  "Vegetarian, no onion or garlic.",
  "Vegan.",
  "Gluten free.",
  "Coeliac — needs a separately prepared plate.",
  "No pork.",
  "Halal, please.",
  "Nut allergy — airborne is fine, contact is not.",
  "Shellfish allergy.",
  "Dairy free.",
  "Lactose intolerant, a little butter is fine.",
  "Pescatarian.",
  "Low salt, on doctor's orders.",
  "No alcohol in the food, please.",
  "Two toddler meals if that is possible.",
] as const;

/**
 * Household invitation patterns, weighted roughly the way a real list falls out:
 * a small inner circle across the whole week, a big middle invited to the main
 * ceremony and the party, and a tail with one invitation each. Mean ≈ 2.4
 * events per household, which lands the total near the live wedding's 1282.
 */
const INVITE_PATTERNS: readonly (readonly [readonly (keyof typeof events)[], number])[] = [
  // The whole week — family and the wedding party.
  [["catholic", "kitchen-tea", "mehendi", "hindu", "reception"], 10],
  [["catholic", "hindu", "reception"], 22],
  [["hindu", "reception"], 28],
  [["mehendi", "hindu", "reception"], 8],
  [["catholic", "hindu"], 10],
  [["reception"], 12],
  [["hindu"], 10],
];

/**
 * Household sizes. Couples are the mode; the tail up to six covers the
 * multi-generation households that break table layouts. Mean ≈ 2.7, which puts
 * the guest total near the live wedding's 558.
 */
const HOUSEHOLD_SIZES: readonly (readonly [number, number])[] = [
  [1, 22],
  [2, 30],
  [3, 20],
  [4, 16],
  [5, 8],
  [6, 4],
];

/** Share of households that have replied. The live wedding sits near 14%. */
const REPLY_RATE = 0.14;
/** Of replying households, the share whose replies an organiser typed up. */
const ORGANISER_ATTESTED_RATE = 0.05;
/** Of attending replies, the share that carry a dietary note. */
const DIETARY_RATE = 0.25;

const STATUSES: readonly (readonly [SeedRsvp["status"], number])[] = [
  ["attending", 80],
  ["declined", 12],
  ["maybe", 8],
];

/**
 * Distinct id namespaces from the canonical rows (`a0000000…`/`b0000000…`/
 * `c0000000…` there, `a1000000…`/`b1000000…`/`c1000000…` here) so the two sets
 * can never collide however either grows. The suffix is a plain counter, which
 * also makes a row easy to find by eye when debugging the SQL.
 */
function synthId(prefix: string, n: number): string {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const usedCodes = new Set<string>(canonicalFamilies.map((f) => f.publicId));

/**
 * Mint a claim code in the real `secure` shape — `SURNAME-WORD-XXXXX-XXXXX`,
 * the 10 Crockford chars grouped 5-5 exactly as generateFamilyCode does — so
 * the dev tier exercises the same code length the guest site has to lay out and
 * guests have to type. Redraws on collision, which keeps `families.public_id`'s
 * unique index satisfied without changing the shape.
 */
function mintCode(surname: string): string {
  for (;;) {
    const word = pick(CODE_WORDS);
    let hash = "";
    for (let i = 0; i < 10; i++) hash += CROCKFORD[Math.floor(rng() * CROCKFORD.length)];
    const code = `${surname.toUpperCase()}-${word}-${hash.slice(0, 5)}-${hash.slice(5)}`;
    if (!usedCodes.has(code)) {
      usedCodes.add(code);
      return code;
    }
  }
}

const families: SeedFamily[] = [];
const replies: SeedRsvp[] = [];

let guestCounter = 0;
let rsvpCounter = 0;

for (let familyIndex = 1; familyIndex <= HOUSEHOLD_COUNT; familyIndex++) {
  const surname = pick(SURNAMES);
  const pattern = weighted(INVITE_PATTERNS);
  const householdEvents = pattern.map((slug) => events[slug].id);

  const size = weighted(HOUSEHOLD_SIZES);

  // Whether this household has replied at all, and by which route. Decided per
  // HOUSEHOLD, not per guest: one person fills in the form for everyone, which
  // is why "partly replied" households are rare and "silent" ones are common.
  const hasReplied = rng() < REPLY_RATE;
  const consentSource: SeedRsvp["consentSource"] =
    rng() < ORGANISER_ATTESTED_RATE ? "organiser_attested" : "guest";
  const repliedDaysAgo = intBetween(1, 45);

  const householdGuests: SeedGuest[] = [];

  for (let i = 0; i < size; i++) {
    guestCounter++;
    const guestId = synthId("b1000000", guestCounter);

    // Most of the household shares the invitation; roughly one in eight is
    // dropped from the last event (the under-18s who skip the reception), so
    // per-guest invitations are not simply a copy of the household's.
    const guestEvents =
      householdEvents.length > 1 && rng() < 0.12 ? householdEvents.slice(0, -1) : householdEvents;

    householdGuests.push({
      id: guestId,
      firstName: pick(FIRST_NAMES),
      lastName: surname,
      events: guestEvents,
    });

    if (!hasReplied) continue;

    for (const eventId of guestEvents) {
      const status = weighted(STATUSES);
      // Consent is stamped by the generator iff there is dietary text, matching
      // cire/api/src/services/rsvp.ts. Only an attending guest is asked.
      const dietary = status === "attending" && rng() < DIETARY_RATE ? pick(DIETARY_NOTES) : "";
      rsvpCounter++;
      replies.push({
        id: synthId("c1000000", rsvpCounter),
        guestId,
        eventId,
        status,
        dietary,
        consentSource,
        daysAgo: repliedDaysAgo,
      });
    }
  }

  families.push({
    id: synthId("a1000000", familyIndex),
    publicId: mintCode(surname),
    familyName: surname,
    guests: householdGuests,
  });
}

/** ~195 invented households, in generation order. */
export const syntheticFamilies: readonly SeedFamily[] = families;

/** Their replies. Households that have not replied contribute no rows at all. */
export const syntheticRsvps: readonly SeedRsvp[] = replies;
