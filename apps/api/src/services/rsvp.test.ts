import { describe, it, expect } from "bun:test";
import { Effect } from "effect";
import { guests } from "@cire/db";
import { eq } from "drizzle-orm";
import { rsvpService, RsvpError } from "./rsvp";
import { DbService } from "../db";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";

const withDb = effWith(TestDbLayer);

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

describe("rsvpService.submitRsvp", () => {
  it(
    "inserts an RSVP for a valid guest+event",
    withDb(
      Effect.gen(function* () {
        const priya = yield* lookupGuest("Priya");
        yield* rsvpService.submitRsvp({
          guestId: priya.id,
          eventId: "wedding",
          status: "attending",
          dietary: "",
          familyId: priya.familyId,
        });

        const rsvps = yield* rsvpService.getRsvpsForFamily(priya.familyId);
        expect(rsvps).toHaveLength(1);
        expect(rsvps[0]!.guestId).toBe(priya.id);
        expect(rsvps[0]!.eventId).toBe("wedding");
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
          eventId: "wedding",
          status: "attending",
          dietary: "",
          familyId: priya.familyId,
        });
        yield* rsvpService.submitRsvp({
          guestId: priya.id,
          eventId: "wedding",
          status: "declined",
          dietary: "",
          familyId: priya.familyId,
        });

        const rsvps = yield* rsvpService.getRsvpsForFamily(priya.familyId);
        const weddingRsvp = rsvps.find((r) => r.eventId === "wedding");
        expect(weddingRsvp?.status).toBe("declined");
        // Should still be only one row for this guest+event
        expect(rsvps.filter((r) => r.eventId === "wedding")).toHaveLength(1);
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
          eventId: "reception",
          status: "attending",
          dietary: "Vegetarian, no nuts",
          familyId: priya.familyId,
        });

        const rsvps = yield* rsvpService.getRsvpsForFamily(priya.familyId);
        const receptionRsvp = rsvps.find((r) => r.eventId === "reception");
        expect(receptionRsvp?.dietary).toBe("Vegetarian, no nuts");
      }),
    ),
  );

  it(
    "rejects RSVP for a guest not in the specified family",
    withDb(
      Effect.gen(function* () {
        const priya = yield* lookupGuest("Priya");
        const james = yield* lookupGuest("James");

        // Try to submit RSVP for Priya using James's familyId
        const error = yield* Effect.flip(
          rsvpService.submitRsvp({
            guestId: priya.id,
            eventId: "wedding",
            status: "attending",
            dietary: "",
            familyId: james.familyId,
          }),
        );
        expect(error._tag).toBe("RsvpError");
        expect(error).toBeInstanceOf(RsvpError);
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
          eventId: "wedding",
          status: "attending",
          dietary: "",
          familyId: james.familyId,
        });
        yield* rsvpService.submitRsvp({
          guestId: emma.id,
          eventId: "wedding",
          status: "maybe",
          dietary: "Gluten-free",
          familyId: emma.familyId,
        });

        const rsvps = yield* rsvpService.getRsvpsForFamily(james.familyId);
        expect(rsvps).toHaveLength(2);
        const guestIds = rsvps.map((r) => r.guestId).sort();
        expect(guestIds).toEqual([james.id, emma.id].sort());
      }),
    ),
  );
});
