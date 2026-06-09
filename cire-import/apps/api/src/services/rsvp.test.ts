import { describe, it, expect } from "bun:test";
import { Effect } from "effect";
import { guests } from "@cire/db";
import { eq } from "drizzle-orm";
import { rsvpService } from "./rsvp";
import { DbService } from "../db";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";
import eventsData from "../data/events.json";

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
        const priya = yield* lookupGuest("Priya");
        yield* rsvpService.submitRsvp({
          guestId: priya.id,
          eventId: HINDU_ID,
          status: "attending",
          dietary: "",
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
        const priya = yield* lookupGuest("Priya");
        yield* rsvpService.submitRsvp({
          guestId: priya.id,
          eventId: HINDU_ID,
          status: "attending",
          dietary: "",
        });
        yield* rsvpService.submitRsvp({
          guestId: priya.id,
          eventId: HINDU_ID,
          status: "declined",
          dietary: "",
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
        const priya = yield* lookupGuest("Priya");
        yield* rsvpService.submitRsvp({
          guestId: priya.id,
          eventId: RECEPTION_ID,
          status: "attending",
          dietary: "Vegetarian, no nuts",
        });

        const rsvps = yield* rsvpService.getRsvpsForFamily(priya.familyId);
        const receptionRsvp = rsvps.find((r) => r.eventId === RECEPTION_ID);
        expect(receptionRsvp?.dietary).toBe("Vegetarian, no nuts");
      }),
    ),
  );
});

describe("rsvpService.getRsvpsForFamily", () => {
  it(
    "returns all RSVPs across family members",
    withDb(
      Effect.gen(function* () {
        const james = yield* lookupGuest("James");
        const emma = yield* lookupGuest("Emma");

        yield* rsvpService.submitRsvp({
          guestId: james.id,
          eventId: HINDU_ID,
          status: "attending",
          dietary: "",
        });
        yield* rsvpService.submitRsvp({
          guestId: emma.id,
          eventId: HINDU_ID,
          status: "maybe",
          dietary: "Gluten-free",
        });

        const rsvps = yield* rsvpService.getRsvpsForFamily(james.familyId);
        expect(rsvps).toHaveLength(2);
        const guestIds = rsvps.map((r) => r.guestId).sort();
        expect(guestIds).toEqual([james.id, emma.id].sort());
      }),
    ),
  );
});
