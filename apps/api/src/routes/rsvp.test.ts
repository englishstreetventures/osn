import { describe, it, expect, beforeAll } from "bun:test";
import { Effect } from "effect";
import { guests } from "@cire/db";
import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import { createRateLimiter } from "../services/rate-limit";
import { parseSessionToken } from "../lib/cookie";
import { eff } from "../test-helpers";
import eventsData from "../data/events.json";
import type { Db } from "../db";

const WEDDING_ID = eventsData.wedding.id;

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

const post = (body: unknown, cookie: string | null) =>
  Effect.promise(() => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cookie) headers["Cookie"] = cookie;
    return app.fetch(
      new Request("http://localhost/api/rsvp", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
  });

const claim = (publicId: string) =>
  Effect.promise(() =>
    app.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicId }),
      }),
    ),
  );

const claimAndCookie = (publicId: string) =>
  Effect.gen(function* () {
    const res = yield* claim(publicId);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    const token = parseSessionToken(setCookie);
    expect(token).not.toBeNull();
    return `cire_session=${token}`;
  });

describe("POST /api/rsvp", () => {
  it(
    "returns 200 with valid session and RSVPs",
    eff(
      Effect.gen(function* () {
        const cookie = yield* claimAndCookie("SHARMA-IVY-QM42");
        const res = yield* post(
          {
            rsvps: [
              {
                guestId: sharmaGuestId,
                eventId: WEDDING_ID,
                status: "attending",
                dietary: "Vegetarian",
              },
            ],
          },
          cookie,
        );
        expect(res.status).toBe(200);
        const data = yield* Effect.promise(() => res.json<RsvpOk>());
        expect(data.rsvps).toHaveLength(1);
        expect(data.rsvps[0]!.status).toBe("attending");
        expect(data.rsvps[0]!.dietary).toBe("Vegetarian");
      }),
    ),
  );

  it(
    "returns 401 when no cookie is sent",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ rsvps: [] }, null);
        expect(res.status).toBe(401);
      }),
    ),
  );

  it(
    "returns 401 when the cookie token is unknown",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ rsvps: [] }, "cire_session=not-a-real-token");
        expect(res.status).toBe(401);
      }),
    ),
  );

  it(
    "returns 403 when guestId belongs to a different family",
    eff(
      Effect.gen(function* () {
        const cookie = yield* claimAndCookie("SHARMA-IVY-QM42");
        const res = yield* post(
          {
            rsvps: [
              {
                guestId: wilsonJamesGuestId,
                eventId: WEDDING_ID,
                status: "attending",
              },
            ],
          },
          cookie,
        );
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
        const cookie = yield* claimAndCookie("SHARMA-IVY-QM42");
        const res = yield* post({}, cookie);
        expect(res.status).toBe(400);
      }),
    ),
  );
});
