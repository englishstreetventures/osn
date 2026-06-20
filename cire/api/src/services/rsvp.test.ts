import { describe, it, expect } from "bun:test";

import { guests, rsvps as rsvpsTable } from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../db";
import { TestDbLayer } from "../db/test-layer";
import { DIETARY_CONSENT_VERSION } from "../schemas/rsvp";
import { effWith } from "../test-helpers";
import { rsvpService } from "./rsvp";

const withDb = effWith(TestDbLayer);

const HINDU_ID = eventsData.hindu.id;
const RECEPTION_ID = eventsData.reception.id;

// Helper to get a guestId + familyId by first name
function lookupGuest(firstName: string) {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const [row] = db
      .select({ id: guests.id, familyId: guests.familyId })
      .from(guests)
      .where(eq(guests.firstName, firstName))
      .all();
    if (!row) throw new Error(`Guest ${firstName} not found in seed data`);
    return row;
  });
}

// Cross-family rejection lives at the route layer (see routes/rsvp.test.ts);
// the service trusts the caller's ownership validation to avoid duplicate D1
// round-trips per RSVP in a bulk submission.

describe("rsvpService.submitRsvp", () => {
  it(
    "inserts an RSVP for a valid guest+event",
    withDb(
      Effect.gen(function* () {
        const priya = yield* lookupGuest("Ada");
        yield* rsvpService.submitRsvp({
          guestId: priya.id,
          eventId: HINDU_ID,
          status: "attending",
          dietary: "",
          dietaryConsent: false,
        });

        const rsvps = yield* rsvpService.getRsvpsForFamily(priya.familyId);
        expect(rsvps).toHaveLength(1);
        expect(rsvps[0]!.guestId).toBe(priya.id);
        expect(rsvps[0]!.eventId).toBe(HINDU_ID);
        expect(rsvps[0]!.status).toBe("attending");
      }),
    ),
  );

  it(
    "upserts — overwrites status on re-submit for same guest+event",
    withDb(
      Effect.gen(function* () {
        const priya = yield* lookupGuest("Ada");
        yield* rsvpService.submitRsvp({
          guestId: priya.id,
          eventId: HINDU_ID,
          status: "attending",
          dietary: "",
          dietaryConsent: false,
        });
        yield* rsvpService.submitRsvp({
          guestId: priya.id,
          eventId: HINDU_ID,
          status: "declined",
          dietary: "",
          dietaryConsent: false,
        });

        const rsvps = yield* rsvpService.getRsvpsForFamily(priya.familyId);
        const hinduRsvp = rsvps.find((r) => r.eventId === HINDU_ID);
        expect(hinduRsvp?.status).toBe("declined");
        expect(rsvps.filter((r) => r.eventId === HINDU_ID)).toHaveLength(1);
      }),
    ),
  );

  it(
    "persists dietary requirements",
    withDb(
      Effect.gen(function* () {
        const priya = yield* lookupGuest("Ada");
        yield* rsvpService.submitRsvp({
          guestId: priya.id,
          eventId: RECEPTION_ID,
          status: "attending",
          dietary: "Vegetarian, no nuts",
          dietaryConsent: true,
        });

        const rsvps = yield* rsvpService.getRsvpsForFamily(priya.familyId);
        const receptionRsvp = rsvps.find((r) => r.eventId === RECEPTION_ID);
        expect(receptionRsvp?.dietary).toBe("Vegetarian, no nuts");
      }),
    ),
  );

  it(
    "stamps a consent record (timestamp + version) when dietaryConsent is true",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const priya = yield* lookupGuest("Ada");
        // Drizzle `timestamp` mode persists epoch *seconds*, so the round-trip
        // truncates sub-second precision — floor the lower bound to the second.
        const before = Math.floor(Date.now() / 1000) * 1000;
        yield* rsvpService.submitRsvp({
          guestId: priya.id,
          eventId: RECEPTION_ID,
          status: "attending",
          dietary: "Coeliac",
          dietaryConsent: true,
        });

        const [row] = db
          .select({
            at: rsvpsTable.dietaryConsentAt,
            version: rsvpsTable.dietaryConsentVersion,
          })
          .from(rsvpsTable)
          .where(and(eq(rsvpsTable.guestId, priya.id), eq(rsvpsTable.eventId, RECEPTION_ID)))
          .all();
        expect(row?.version).toBe(DIETARY_CONSENT_VERSION);
        expect(row?.at).toBeInstanceOf(Date);
        expect(row!.at!.getTime()).toBeGreaterThanOrEqual(before);
      }),
    ),
  );

  it(
    "leaves the consent record null when dietaryConsent is false, and clears it on re-submit",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const priya = yield* lookupGuest("Ada");

        // No consent → null record.
        yield* rsvpService.submitRsvp({
          guestId: priya.id,
          eventId: RECEPTION_ID,
          status: "declined",
          dietary: "",
          dietaryConsent: false,
        });
        const read = () =>
          db
            .select({ at: rsvpsTable.dietaryConsentAt, version: rsvpsTable.dietaryConsentVersion })
            .from(rsvpsTable)
            .where(and(eq(rsvpsTable.guestId, priya.id), eq(rsvpsTable.eventId, RECEPTION_ID)))
            .all()[0];
        expect(read()?.at).toBeNull();
        expect(read()?.version).toBeNull();

        // Consent given on re-submit → record stamped.
        yield* rsvpService.submitRsvp({
          guestId: priya.id,
          eventId: RECEPTION_ID,
          status: "attending",
          dietary: "Halal",
          dietaryConsent: true,
        });
        expect(read()?.version).toBe(DIETARY_CONSENT_VERSION);

        // Dietary removed → consent record cleared (no special-category data left).
        yield* rsvpService.submitRsvp({
          guestId: priya.id,
          eventId: RECEPTION_ID,
          status: "attending",
          dietary: "",
          dietaryConsent: false,
        });
        expect(read()?.at).toBeNull();
        expect(read()?.version).toBeNull();
      }),
    ),
  );
});

describe("rsvpService.submitRsvps (P-W1 — batched upserts)", () => {
  it(
    "upserts multiple guests × events in one batch, preserving status + dietary",
    withDb(
      Effect.gen(function* () {
        const bo = yield* lookupGuest("Bo");
        const cleo = yield* lookupGuest("Cleo");

        yield* rsvpService.submitRsvps([
          {
            guestId: bo.id,
            eventId: HINDU_ID,
            status: "attending",
            dietary: "",
            dietaryConsent: false,
          },
          {
            guestId: bo.id,
            eventId: RECEPTION_ID,
            status: "declined",
            dietary: "",
            dietaryConsent: false,
          },
          {
            guestId: cleo.id,
            eventId: HINDU_ID,
            status: "maybe",
            dietary: "Vegan, no shellfish",
            dietaryConsent: true,
          },
        ]);

        const rsvps = yield* rsvpService.getRsvpsForFamily(bo.familyId);
        expect(rsvps).toHaveLength(3);

        const byPair = new Map(rsvps.map((r) => [`${r.guestId}::${r.eventId}`, r]));
        expect(byPair.get(`${bo.id}::${HINDU_ID}`)?.status).toBe("attending");
        expect(byPair.get(`${bo.id}::${RECEPTION_ID}`)?.status).toBe("declined");
        const cleoHindu = byPair.get(`${cleo.id}::${HINDU_ID}`);
        expect(cleoHindu?.status).toBe("maybe");
        expect(cleoHindu?.dietary).toBe("Vegan, no shellfish");
      }),
    ),
  );

  it(
    "is upsert-correct within a batch — a (guest,event) pair already present is updated in place, not duplicated",
    withDb(
      Effect.gen(function* () {
        const ada = yield* lookupGuest("Ada");

        // Seed an attending RSVP, then re-submit the SAME pair in a batch as
        // declined alongside a fresh pair.
        yield* rsvpService.submitRsvps([
          {
            guestId: ada.id,
            eventId: HINDU_ID,
            status: "attending",
            dietary: "",
            dietaryConsent: false,
          },
        ]);
        yield* rsvpService.submitRsvps([
          {
            guestId: ada.id,
            eventId: HINDU_ID,
            status: "declined",
            dietary: "",
            dietaryConsent: false,
          },
          {
            guestId: ada.id,
            eventId: RECEPTION_ID,
            status: "attending",
            dietary: "",
            dietaryConsent: false,
          },
        ]);

        const rsvps = yield* rsvpService.getRsvpsForFamily(ada.familyId);
        const hindu = rsvps.filter((r) => r.eventId === HINDU_ID);
        expect(hindu).toHaveLength(1);
        expect(hindu[0]!.status).toBe("declined");
        expect(rsvps).toHaveLength(2);
      }),
    ),
  );

  it(
    "stamps the consent record per-pair within a batch (set for the consented pair, null for the rest)",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const ada = yield* lookupGuest("Ada");

        yield* rsvpService.submitRsvps([
          {
            guestId: ada.id,
            eventId: HINDU_ID,
            status: "attending",
            dietary: "Coeliac",
            dietaryConsent: true,
          },
          {
            guestId: ada.id,
            eventId: RECEPTION_ID,
            status: "attending",
            dietary: "",
            dietaryConsent: false,
          },
        ]);

        const consentFor = (eventId: string) =>
          db
            .select({ at: rsvpsTable.dietaryConsentAt, version: rsvpsTable.dietaryConsentVersion })
            .from(rsvpsTable)
            .where(and(eq(rsvpsTable.guestId, ada.id), eq(rsvpsTable.eventId, eventId)))
            .all()[0];

        expect(consentFor(HINDU_ID)?.version).toBe(DIETARY_CONSENT_VERSION);
        expect(consentFor(HINDU_ID)?.at).toBeInstanceOf(Date);
        expect(consentFor(RECEPTION_ID)?.at).toBeNull();
        expect(consentFor(RECEPTION_ID)?.version).toBeNull();
      }),
    ),
  );

  it(
    "an empty batch is a no-op",
    withDb(
      Effect.gen(function* () {
        const ada = yield* lookupGuest("Ada");
        yield* rsvpService.submitRsvps([]);
        const rsvps = yield* rsvpService.getRsvpsForFamily(ada.familyId);
        expect(rsvps).toHaveLength(0);
      }),
    ),
  );
});

describe("rsvpService.getRsvpsForFamily", () => {
  it(
    "returns all RSVPs across family members",
    withDb(
      Effect.gen(function* () {
        const james = yield* lookupGuest("Bo");
        const emma = yield* lookupGuest("Cleo");

        yield* rsvpService.submitRsvp({
          guestId: james.id,
          eventId: HINDU_ID,
          status: "attending",
          dietary: "",
          dietaryConsent: false,
        });
        yield* rsvpService.submitRsvp({
          guestId: emma.id,
          eventId: HINDU_ID,
          status: "maybe",
          dietary: "Gluten-free",
          dietaryConsent: true,
        });

        const rsvps = yield* rsvpService.getRsvpsForFamily(james.familyId);
        expect(rsvps).toHaveLength(2);
        const guestIds = rsvps.map((r) => r.guestId).toSorted();
        expect(guestIds).toEqual([james.id, emma.id].toSorted());
      }),
    ),
  );
});
