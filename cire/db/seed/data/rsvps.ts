// Hand-written replies for the four canonical families. Consumed only by
// cire/db/seed/generate.ts — the in-memory API test seed leaves `rsvps` empty
// so route tests keep starting from "nobody has replied".
//
// The live wedding is ~30% replied by now; a dev tier with an empty `rsvps`
// table renders every organiser dashboard, export and summary at zero, which is
// the one state that looks fine no matter how badly the aggregation is broken.
// These ten rows deliberately cover EVERY axis the read paths branch on:
// all three statuses, dietary text present and absent, and both consent
// sources.
//
// The Placeholder family (`TESTFOR-JOY-DD44`, Eli) is left reply-free on
// purpose: it is the code used for manual smoke tests, so its invite must still
// open on a blank RSVP form.

// Matches DIETARY_CONSENT_VERSION in cire/api/src/schemas/rsvp.ts. Stamped only
// on rows that carry dietary text — Art. 9(2)(a) consent authorises the health
// data, so a row with no dietary text has nothing to consent to and the columns
// stay NULL, exactly as the live write path leaves them.
export const DIETARY_CONSENT_VERSION = "2026-06-17";

export type SeedRsvp = {
  readonly id: string;
  readonly guestId: string;
  readonly eventId: string;
  readonly status: "attending" | "declined" | "maybe";
  // "" ⇒ no dietary note, and therefore no consent stamp.
  readonly dietary: string;
  readonly consentSource: "guest" | "organiser_attested";
  // How long ago the reply came in. Emitted as `unixepoch() - 86400 * N` so
  // seeded replies always look recent, however long ago the seed was written.
  readonly daysAgo: number;
};

const CATHOLIC = "9f7a2c14-1b3d-4e5f-8a01-000000000001";
const HINDU = "9f7a2c14-1b3d-4e5f-8a01-000000000003";
const RECEPTION = "9f7a2c14-1b3d-4e5f-8a01-000000000004";

export const rsvps = [
  // Testfamily — Ada. Replied to all three of her invitations, one with a
  // dietary note (so this is the row that carries a consent stamp).
  {
    id: "c0000000-0000-4000-8000-000000000001",
    guestId: "b0000000-0000-4000-8000-000000000001",
    eventId: CATHOLIC,
    status: "attending",
    dietary: "Coeliac — strictly gluten free, including sauces.",
    consentSource: "guest",
    daysAgo: 21,
  },
  {
    id: "c0000000-0000-4000-8000-000000000002",
    guestId: "b0000000-0000-4000-8000-000000000001",
    eventId: HINDU,
    status: "attending",
    dietary: "",
    consentSource: "guest",
    daysAgo: 21,
  },
  {
    id: "c0000000-0000-4000-8000-000000000003",
    guestId: "b0000000-0000-4000-8000-000000000001",
    eventId: RECEPTION,
    status: "maybe",
    dietary: "",
    consentSource: "guest",
    daysAgo: 21,
  },
  // Sampleton — a partly-replied household, which is what most of the list
  // looks like in practice. Bo's reply was phoned in and typed up by an
  // organiser, so it is the `organiser_attested` row.
  {
    id: "c0000000-0000-4000-8000-000000000004",
    guestId: "b0000000-0000-4000-8000-000000000002",
    eventId: HINDU,
    status: "attending",
    dietary: "Vegetarian, no egg.",
    consentSource: "organiser_attested",
    daysAgo: 14,
  },
  {
    id: "c0000000-0000-4000-8000-000000000005",
    guestId: "b0000000-0000-4000-8000-000000000002",
    eventId: RECEPTION,
    status: "declined",
    dietary: "",
    consentSource: "organiser_attested",
    daysAgo: 14,
  },
  {
    id: "c0000000-0000-4000-8000-000000000006",
    guestId: "b0000000-0000-4000-8000-000000000003",
    eventId: HINDU,
    status: "declined",
    dietary: "",
    consentSource: "guest",
    daysAgo: 9,
  },
  {
    id: "c0000000-0000-4000-8000-000000000007",
    guestId: "b0000000-0000-4000-8000-000000000003",
    eventId: RECEPTION,
    status: "attending",
    dietary: "",
    consentSource: "guest",
    daysAgo: 9,
  },
  // Dot has one invitation and is undecided — the household is therefore
  // neither fully replied nor untouched, which is the state most "outstanding
  // replies" counters get wrong.
  {
    id: "c0000000-0000-4000-8000-000000000008",
    guestId: "b0000000-0000-4000-8000-000000000004",
    eventId: HINDU,
    status: "maybe",
    dietary: "",
    consentSource: "guest",
    daysAgo: 3,
  },
  // Exampleton — Nori, fully replied, allergy noted.
  {
    id: "c0000000-0000-4000-8000-000000000009",
    guestId: "b0000000-0000-4000-8000-000000000005",
    eventId: CATHOLIC,
    status: "attending",
    dietary: "Severe nut allergy — please keep preparation separate.",
    consentSource: "guest",
    daysAgo: 6,
  },
  {
    id: "c0000000-0000-4000-8000-000000000010",
    guestId: "b0000000-0000-4000-8000-000000000005",
    eventId: HINDU,
    status: "attending",
    dietary: "",
    consentSource: "guest",
    daysAgo: 6,
  },
] as const satisfies readonly SeedRsvp[];
