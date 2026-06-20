import { describe, it, expect, beforeAll } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, guests, rsvps } from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../app";
import { DbService } from "../db";
import type { Db } from "../db";
import { createDb, seedDb } from "../db/setup";
import { parseSessionToken } from "../lib/cookie";
import { DIETARY_CONSENT_VERSION } from "../schemas/rsvp";
import { hostCodeService } from "../services/host-code";
import { eff } from "../test-helpers";

const HINDU_ID = eventsData.hindu.id;
// Ada (Testfamily) is invited to catholic + hindu + reception, NOT mehendi.
const MEHENDI_ID = eventsData.mehendi.id;
// A UUID that exists in no wedding — stands in for "another wedding's event".
const FOREIGN_EVENT_ID = "00000000-0000-4000-8000-ffffffffffff";

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

  sharmaGuestId = allGuests.find((g) => g.firstName === "Ada")!.id;
  wilsonJamesGuestId = allGuests.find((g) => g.firstName === "Bo")!.id;
});

const post = (body: unknown, cookie: string | null) =>
  Effect.promise(() => {
    // rsvp POST is state-changing → the origin guard (C5) requires an allowlisted
    // Origin even though /api/rsvp isn't rate-limited.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Origin: "http://localhost:4321",
    };
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
        // `cf-connecting-ip` simulates the CF edge for the fail-closed limiter
        // (C4); `Origin` satisfies the CSRF origin guard (C5).
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "203.0.113.7",
          Origin: "http://localhost:4321",
        },
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
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        const res = yield* post(
          {
            rsvps: [
              {
                guestId: sharmaGuestId,
                eventId: HINDU_ID,
                status: "attending",
                dietary: "Vegetarian",
                dietaryConsent: true,
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
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        const res = yield* post(
          {
            rsvps: [
              {
                guestId: wilsonJamesGuestId,
                eventId: HINDU_ID,
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
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        const res = yield* post({}, cookie);
        expect(res.status).toBe(400);
      }),
    ),
  );

  it(
    "returns 200 when RSVPing to an invited event (S-M1)",
    eff(
      Effect.gen(function* () {
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        const res = yield* post(
          { rsvps: [{ guestId: sharmaGuestId, eventId: HINDU_ID, status: "attending" }] },
          cookie,
        );
        expect(res.status).toBe(200);
      }),
    ),
  );

  it(
    "returns 403 when RSVPing to a valid-but-uninvited event (S-M1)",
    eff(
      Effect.gen(function* () {
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        const res = yield* post(
          { rsvps: [{ guestId: sharmaGuestId, eventId: MEHENDI_ID, status: "attending" }] },
          cookie,
        );
        expect(res.status).toBe(403);
        const data = yield* Effect.promise(() => res.json<{ error: string }>());
        expect(data.error).toBe("One or more guests are not invited to that event");
      }),
    ),
  );

  it(
    "returns 403 when RSVPing to another wedding's event UUID (S-M1)",
    eff(
      Effect.gen(function* () {
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        const res = yield* post(
          { rsvps: [{ guestId: sharmaGuestId, eventId: FOREIGN_EVENT_ID, status: "attending" }] },
          cookie,
        );
        expect(res.status).toBe(403);
      }),
    ),
  );

  it(
    "returns 403 for a host preview session (preview-only, no RSVP)",
    eff(
      Effect.gen(function* () {
        // Provision the wedding's host preview code, then claim it for a cookie.
        const { publicId } = yield* hostCodeService
          .ensureForWedding(BOOTSTRAP_WEDDING_ID)
          .pipe(Effect.provideService(DbService, db));
        const cookie = yield* claimAndCookie(publicId);

        // The host guest is linked to every event, so this pair IS invited —
        // the 403 must come from the host guard, not the invitation check.
        const hostGuestId = db
          .select({ id: guests.id, firstName: guests.firstName })
          .from(guests)
          .all()
          .find((g) => g.firstName === "Wedding")!.id;
        const res = yield* post(
          { rsvps: [{ guestId: hostGuestId, eventId: HINDU_ID, status: "attending" }] },
          cookie,
        );
        expect(res.status).toBe(403);
        const data = yield* Effect.promise(() => res.json<{ error: string }>());
        expect(data.error).toBe("Preview sessions cannot submit RSVPs");
      }),
    ),
  );

  it(
    "returns 400 when dietary text exceeds the 500-char cap (S-L2)",
    eff(
      Effect.gen(function* () {
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        const res = yield* post(
          {
            rsvps: [
              {
                guestId: sharmaGuestId,
                eventId: HINDU_ID,
                status: "attending",
                dietary: "x".repeat(501),
              },
            ],
          },
          cookie,
        );
        expect(res.status).toBe(400);
      }),
    ),
  );

  it(
    "returns 422 when dietary text is submitted without consent (C-H2)",
    eff(
      Effect.gen(function* () {
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        const res = yield* post(
          {
            rsvps: [
              {
                guestId: sharmaGuestId,
                eventId: HINDU_ID,
                status: "attending",
                dietary: "Vegetarian",
                // dietaryConsent omitted → defaults false
              },
            ],
          },
          cookie,
        );
        expect(res.status).toBe(422);
        const data = yield* Effect.promise(() => res.json<{ error: string }>());
        expect(data.error).toBe("Dietary requirements need your consent to store");
      }),
    ),
  );

  it(
    "returns 200 and persists a consent record when dietary is submitted WITH consent (C-H2)",
    eff(
      Effect.gen(function* () {
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        const res = yield* post(
          {
            rsvps: [
              {
                guestId: sharmaGuestId,
                eventId: HINDU_ID,
                status: "attending",
                dietary: "Coeliac",
                dietaryConsent: true,
              },
            ],
          },
          cookie,
        );
        expect(res.status).toBe(200);

        const [row] = db
          .select({
            dietary: rsvps.dietary,
            at: rsvps.dietaryConsentAt,
            version: rsvps.dietaryConsentVersion,
          })
          .from(rsvps)
          .where(eq(rsvps.guestId, sharmaGuestId))
          .all();
        expect(row?.dietary).toBe("Coeliac");
        expect(row?.at).toBeInstanceOf(Date);
        expect(row?.version).toBe(DIETARY_CONSENT_VERSION);
      }),
    ),
  );

  it(
    "returns 200 with no consent needed when dietary is empty (C-H2)",
    eff(
      Effect.gen(function* () {
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        const res = yield* post(
          {
            rsvps: [
              { guestId: sharmaGuestId, eventId: HINDU_ID, status: "attending", dietary: "" },
            ],
          },
          cookie,
        );
        expect(res.status).toBe(200);
      }),
    ),
  );

  it(
    "returns 413 when Content-Length declares an oversized payload (S-L2)",
    eff(
      Effect.gen(function* () {
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        const res = yield* Effect.promise(() =>
          app.fetch(
            new Request("http://localhost/api/rsvp", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Cookie: cookie,
                Origin: "http://localhost:4321",
                "Content-Length": String(512 * 1024),
              },
              body: JSON.stringify({ rsvps: [] }),
            }),
          ),
        );
        expect(res.status).toBe(413);
      }),
    ),
  );
});
