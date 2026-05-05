import { describe, it, expect, beforeAll } from "bun:test";
import { Effect } from "effect";
import { guests } from "@cire/db";
import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import { createRateLimiter } from "../services/rate-limit";
import { eff } from "../test-helpers";
import type { Db } from "../db";

interface RsvpOk {
  rsvps: Array<{
    guestId: string;
    eventId: string;
    status: string;
    dietary: string;
  }>;
}

let db: Db;
let app: ReturnType<typeof createApp>;
let sharmaGuestId: string;
let wilsonJamesGuestId: string;

beforeAll(() => {
  db = createDb(":memory:");
  app = createApp(db, {
    claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
  });
  seedDb(db);

  const allGuests = db.select({ id: guests.id, firstName: guests.firstName }).from(guests).all();

  sharmaGuestId = allGuests.find((g) => g.firstName === "Priya")!.id;
  wilsonJamesGuestId = allGuests.find((g) => g.firstName === "James")!.id;
});

const post = (body: unknown) =>
  Effect.promise(() =>
    app.fetch(
      new Request("http://localhost/api/rsvp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );

describe("POST /api/rsvp", () => {
  it(
    "returns 200 with valid publicId and RSVPs",
    eff(
      Effect.gen(function* () {
        const res = yield* post({
          familyPublicId: "SHARMA-IVY-QM42",
          rsvps: [
            {
              guestId: sharmaGuestId,
              eventId: "wedding",
              status: "attending",
              dietary: "Vegetarian",
            },
          ],
        });
        expect(res.status).toBe(200);
        const data = yield* Effect.promise(() => res.json<RsvpOk>());
        expect(data.rsvps).toHaveLength(1);
        expect(data.rsvps[0]!.status).toBe("attending");
        expect(data.rsvps[0]!.dietary).toBe("Vegetarian");
      }),
    ),
  );

  it(
    "returns 401 for unknown publicId",
    eff(
      Effect.gen(function* () {
        const res = yield* post({
          familyPublicId: "FAKE-XYZ-9999",
          rsvps: [],
        });
        expect(res.status).toBe(401);
        const data = yield* Effect.promise(() => res.json<{ error: string }>());
        expect(data.error).toBe("Invalid credentials");
      }),
    ),
  );

  it(
    "returns 403 when guestId belongs to a different family",
    eff(
      Effect.gen(function* () {
        const res = yield* post({
          familyPublicId: "SHARMA-IVY-QM42",
          rsvps: [
            {
              guestId: wilsonJamesGuestId,
              eventId: "wedding",
              status: "attending",
            },
          ],
        });
        expect(res.status).toBe(403);
        const data = yield* Effect.promise(() => res.json<{ error: string }>());
        expect(data.error).toBe("One or more guests do not belong to this family");
      }),
    ),
  );

  it(
    "returns 400 with missing fields",
    eff(
      Effect.gen(function* () {
        const res = yield* post({});
        expect(res.status).toBe(400);
      }),
    ),
  );
});
