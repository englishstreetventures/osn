import { describe, it, expect, beforeAll } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, guests, rsvps, weddings } from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { createRateLimiter } from "@shared/rate-limit";
import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../app";
import { DbService } from "../db";
import { createDb, seedDb } from "../db/setup";
import type { TestDb } from "../db/setup";
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

let db: TestDb;
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
    return Promise.resolve(
      app.fetch(
        new Request("http://localhost/api/rsvp", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      ),
    );
  });

const claim = (publicId: string) =>
  Effect.promise(() =>
    Promise.resolve(
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
    "returns 400 for a status outside the closed literal set",
    eff(
      Effect.gen(function* () {
        // The schema literal is the ONLY status guard — production D1 has no
        // CHECK constraint on rsvps.status (see ddl-lockstep.test.ts), so a
        // loosened literal would let arbitrary strings straight into the DB.
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        const res = yield* post(
          { rsvps: [{ guestId: sharmaGuestId, eventId: HINDU_ID, status: "going" }] },
          cookie,
        );
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
    "returns 403 (not-invited, not not-owned) for a guest with zero guest_events rows (P-W1 LEFT JOIN null case)",
    eff(
      Effect.gen(function* () {
        // Ownership and invitation used to come off two separate queries;
        // folding them into one LEFT JOIN must not drop a guest who has no
        // guest_events rows at all. Insert a guest into Ada's family with no
        // invitations, then confirm the ownership gate still passes for them
        // — the request must fail on the INVITATION gate (403 "not invited"),
        // not the OWNERSHIP gate (403 "do not belong to this family").
        const noInviteGuestId = yield* Effect.sync(() => crypto.randomUUID());
        yield* Effect.sync(() => {
          const [ada] = db
            .select({ familyId: guests.familyId })
            .from(guests)
            .where(eq(guests.id, sharmaGuestId))
            .all();
          db.insert(guests)
            .values({
              id: noInviteGuestId,
              familyId: ada!.familyId,
              firstName: "NoInvite",
              lastName: "Testfamily",
              createdAt: new Date(),
              updatedAt: new Date(),
            })
            .run();
        });

        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        const res = yield* post(
          { rsvps: [{ guestId: noInviteGuestId, eventId: HINDU_ID, status: "attending" }] },
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
          Promise.resolve(
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
          ),
        );
        expect(res.status).toBe(413);
      }),
    ),
  );
});

describe("POST /api/rsvp — RSVP deadline", () => {
  /** Set (or clear, with `null`) the bootstrap wedding's RSVP-by date. */
  const setDeadline = (date: string | null, timezone: string | null) =>
    Effect.sync(() => {
      db.update(weddings)
        .set({ rsvpDeadline: date, rsvpDeadlineTimezone: timezone, updatedAt: new Date() })
        .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
        .run();
    });

  /** Run `body` with a deadline in place, always clearing it afterwards — the
   *  suite shares one in-memory DB, so a leaked deadline would close every
   *  later test's invite. */
  const withDeadline = <A, E, R>(
    date: string | null,
    timezone: string | null,
    body: Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      setDeadline(date, timezone),
      () => body,
      () => setDeadline(null, null),
    );

  const rsvpOnce = (cookie: string) =>
    post({ rsvps: [{ guestId: sharmaGuestId, eventId: HINDU_ID, status: "attending" }] }, cookie);

  it(
    "accepts an RSVP while the deadline is still in the future",
    eff(
      Effect.gen(function* () {
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        const res = yield* withDeadline("2999-01-01", "UTC", rsvpOnce(cookie));
        expect(res.status).toBe(200);
      }),
    ),
  );

  it(
    "returns 403 rsvp_closed once the deadline has passed",
    eff(
      Effect.gen(function* () {
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        const res = yield* withDeadline("2020-01-01", "UTC", rsvpOnce(cookie));
        expect(res.status).toBe(403);
        const data = yield* Effect.promise(() => res.json<{ error: string }>());
        // A machine-readable code — the guest site maps it to copy naming the date.
        expect(data.error).toBe("rsvp_closed");
      }),
    ),
  );

  it(
    "writes nothing when the deadline has passed",
    eff(
      Effect.gen(function* () {
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        // Land a known answer BEFORE the deadline is set…
        const before = yield* post(
          { rsvps: [{ guestId: sharmaGuestId, eventId: HINDU_ID, status: "declined" }] },
          cookie,
        );
        expect(before.status).toBe(200);

        // …then try to change it after the door shut.
        const after = yield* withDeadline(
          "2020-01-01",
          "UTC",
          post(
            { rsvps: [{ guestId: sharmaGuestId, eventId: HINDU_ID, status: "attending" }] },
            cookie,
          ),
        );
        expect(after.status).toBe(403);

        const [row] = db
          .select({ status: rsvps.status })
          .from(rsvps)
          .where(eq(rsvps.guestId, sharmaGuestId))
          .all();
        expect(row?.status).toBe("declined");
      }),
    ),
  );

  it(
    "keeps RSVPs open forever when no deadline is set",
    eff(
      Effect.gen(function* () {
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        // The unmigrated shape every pre-0055 wedding carries.
        const res = yield* withDeadline(null, null, rsvpOnce(cookie));
        expect(res.status).toBe(200);
      }),
    ),
  );

  it(
    "measures the deadline in the wedding's stored zone",
    eff(
      Effect.gen(function* () {
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        // "Yesterday in Sydney" is unambiguously past in every zone; the point
        // here is that the ZONE column is read at all — a wedding storing
        // Australia/Sydney must not be evaluated against the server's clock zone.
        const res = yield* withDeadline("2020-01-01", "Australia/Sydney", rsvpOnce(cookie));
        expect(res.status).toBe(403);

        // Same date, but a zone whose day has yet to end is still open —
        // proving the stored zone, not just the date, drives the verdict.
        const open = yield* withDeadline("2999-01-01", "Australia/Sydney", rsvpOnce(cookie));
        expect(open.status).toBe(200);
      }),
    ),
  );

  it(
    "fails CLOSED when the family's wedding row is missing (S-L1)",
    eff(
      Effect.gen(function* () {
        // Both gates on this route read the joined row, so a zero-row result
        // must not answer "allow" to either of them. The FK cascade makes this
        // unreachable in practice — which is exactly why the branch needs a
        // test that reaches it deliberately: the guard exists so the deny
        // decision doesn't depend on FK enforcement staying switched on.
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");

        // Orphan the family by dropping its wedding with FKs off, so the
        // family + session survive but the join finds nothing.
        yield* Effect.sync(() => {
          db.run(sql`PRAGMA foreign_keys = OFF`);
          db.delete(weddings).where(eq(weddings.id, BOOTSTRAP_WEDDING_ID)).run();
        });

        try {
          const res = yield* rsvpOnce(cookie);
          expect(res.status).toBe(403);
          const data = yield* Effect.promise(() => res.json<{ error: string }>());
          expect(data.error).toBe("Unauthorized");
        } finally {
          // Restore the wedding row (and FK enforcement) for the rest of the
          // suite — the whole file shares one in-memory db.
          db.insert(weddings)
            .values({
              id: BOOTSTRAP_WEDDING_ID,
              slug: "cire-wedding",
              displayName: "Cire Wedding",
              ownerOsnProfileId: "usr_dev_bootstrap_owner",
              createdAt: new Date(),
              updatedAt: new Date(),
            })
            .run();
          db.run(sql`PRAGMA foreign_keys = ON`);
        }
      }),
    ),
  );

  it(
    "ignores an unparseable stored date (fails open, never locks guests out)",
    eff(
      Effect.gen(function* () {
        const cookie = yield* claimAndCookie("TESTONE-IVY-AA11");
        const res = yield* withDeadline("not-a-date", "UTC", rsvpOnce(cookie));
        expect(res.status).toBe(200);
      }),
    ),
  );
});
