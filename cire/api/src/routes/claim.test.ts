import { describe, it, expect, beforeAll } from "bun:test";

import { events } from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { createRateLimiter } from "@shared/rate-limit";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import { eff } from "../test-helpers";

interface FamilyMember {
  guestId: string;
  firstName: string;
  lastName: string;
  eventIds: string[];
}

interface ClaimOk {
  familyId: string;
  publicId: string;
  familyName: string;
  members: FamilyMember[];
  events: unknown[];
}

const db = createDb(":memory:");
const app = createApp(db, {
  claimLimiter: createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 }),
});

beforeAll(() => {
  seedDb(db);
});

// Tests simulate the Cloudflare edge by setting `cf-connecting-ip` — the
// fail-closed limiter (C4) denies requests without a resolvable IP, so every
// rate-limited route needs one in tests.
const post = (body: unknown) =>
  Effect.promise(() =>
    app.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "203.0.113.7",
          Origin: "http://localhost:4321",
        },
        body: JSON.stringify(body),
      }),
    ),
  );

describe("POST /api/claim", () => {
  it(
    "returns 400 when fields are missing",
    eff(
      Effect.gen(function* () {
        const res = yield* post({});
        expect(res.status).toBe(400);
        const data = yield* Effect.promise(() => res.json<{ error: string }>());
        expect(data.error).toBe("Missing or invalid fields");
      }),
    ),
  );

  it(
    "returns 400 when publicId is empty",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ publicId: "" });
        expect(res.status).toBe(400);
      }),
    ),
  );

  it(
    "returns 401 for an unknown publicId",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ publicId: "FAKE-XYZ-9999" });
        expect(res.status).toBe(401);
        const data = yield* Effect.promise(() => res.json<{ error: string }>());
        expect(data.error).toBe("Invalid credentials");
      }),
    ),
  );

  it(
    "returns 200 with family details for valid publicId",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ publicId: "TESTONE-IVY-AA11" });
        expect(res.status).toBe(200);
        const data = yield* Effect.promise(() => res.json<ClaimOk>());
        expect(data.familyName).toBe("Testfamily");
        expect(data.members).toHaveLength(1);
        expect(data.members[0]!.firstName).toBe("Ada");
        expect(typeof data.members[0]!.guestId).toBe("string");
        expect(data.members[0]!.eventIds.toSorted()).toEqual(
          [eventsData.catholic.id, eventsData.reception.id, eventsData.hindu.id].toSorted(),
        );
        expect(data.events).toHaveLength(3);
      }),
    ),
  );

  it(
    "returns all five events for the default demo code TESTFOR-JOY-DD44",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ publicId: "TESTFOR-JOY-DD44" });
        expect(res.status).toBe(200);
        const data = yield* Effect.promise(() => res.json<ClaimOk>());
        expect(data.events.map((e) => e.id).toSorted()).toEqual(
          [
            eventsData.catholic.id,
            eventsData["kitchen-tea"].id,
            eventsData.mehendi.id,
            eventsData.hindu.id,
            eventsData.reception.id,
          ].toSorted(),
        );
        expect(data.events.find((e) => e.id === eventsData["kitchen-tea"].id)?.name).toBe(
          "Kitchen Tea",
        );
      }),
    ),
  );

  it(
    "returns 400 when the body is not valid JSON",
    eff(
      Effect.gen(function* () {
        const res = yield* Effect.promise(() =>
          app.fetch(
            new Request("http://localhost/api/claim", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "cf-connecting-ip": "203.0.113.7",
                Origin: "http://localhost:4321",
              },
              body: "{not-json",
            }),
          ),
        );
        expect(res.status).toBe(400);
        const data = yield* Effect.promise(() => res.json<{ error: string }>());
        expect(data.error).toBe("Missing or invalid fields");
      }),
    ),
  );

  it(
    "uppercases the publicId before lookup",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ publicId: "testone-ivy-aa11" });
        expect(res.status).toBe(200);
        const data = yield* Effect.promise(() => res.json<ClaimOk>());
        expect(data.publicId).toBe("TESTONE-IVY-AA11");
      }),
    ),
  );

  it(
    "sets a Set-Cookie session header on a successful claim",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ publicId: "TESTONE-IVY-AA11" });
        expect(res.status).toBe(200);
        const setCookie = res.headers.get("Set-Cookie");
        expect(setCookie).not.toBeNull();
        expect(setCookie).toContain("cire_session=");
        expect(setCookie).toContain("HttpOnly");
        expect(setCookie).toContain("SameSite=Lax");
        expect(setCookie).toContain("Path=/");
        expect(setCookie!.includes("Domain=")).toBe(false);
      }),
    ),
  );

  it(
    "exposes familyId on the claim response",
    eff(
      Effect.gen(function* () {
        const res = yield* post({ publicId: "TESTONE-IVY-AA11" });
        expect(res.status).toBe(200);
        const data = yield* Effect.promise(() => res.json<ClaimOk>());
        expect(typeof data.familyId).toBe("string");
        expect(data.familyId.length).toBeGreaterThan(0);
      }),
    ),
  );
});

// S-C2: the per-IP limiter must gate the real endpoint, not just exist as a
// plugin — a refactor that drops `.use(rateLimitMiddleware(...))` from
// `createClaimRoutes` should fail here.
describe("POST /api/claim rate limiting (S-C2)", () => {
  it("returns 429 with Retry-After once the per-IP limit is exhausted", async () => {
    const rlApp = createApp(db, {
      claimLimiter: createRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
    });
    const send = () =>
      rlApp.fetch(
        new Request("http://localhost/api/claim", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "cf-connecting-ip": "203.0.113.7",
            Origin: "http://localhost:4321",
          },
          body: JSON.stringify({ publicId: "FAKE-XYZ-9999" }),
        }),
      );

    const first = await send();
    expect(first.status).toBe(401); // unknown code — but it reached the handler

    const second = await send();
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBe("60");
  });
});

// migration 0019: each EventSummary carries imageUrl — the first-party path to
// the event's optional image (or null when none). The path's ?v= is the server-
// derived FNV digest of the R2 key, never the timestamp the wedding-slot images
// use (events have no updated_at).
describe("POST /api/claim event imageUrl (migration 0019)", () => {
  it("populates imageUrl for an event with a key, null for the rest", async () => {
    // Point one seeded event at an R2 key directly (no upload needed — the public
    // claim payload only needs the column populated).
    db.update(events)
      .set({ eventImageKey: "assets/wed_bootstrap/event-1234abcd" })
      .where(eq(events.id, eventsData.catholic.id))
      .run();

    const res = await app.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "203.0.113.7",
          Origin: "http://localhost:4321",
        },
        body: JSON.stringify({ publicId: "TESTFOR-JOY-DD44" }),
      }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      events: { id: string; imageUrl: string | null }[];
    };
    const withImage = data.events.find((e) => e.id === eventsData.catholic.id);
    expect(withImage?.imageUrl).toContain(
      `/api/invite/cire-wedding/event/${eventsData.catholic.id}/image`,
    );
    expect(withImage?.imageUrl).toMatch(/\?v=[0-9a-f]+$/);

    // An event without a key reports null (graceful no-image collapse).
    const noImage = data.events.find((e) => e.id === eventsData.reception.id);
    expect(noImage?.imageUrl).toBeNull();

    // Cleanup so other tests on the shared db see no image.
    db.update(events)
      .set({ eventImageKey: null })
      .where(eq(events.id, eventsData.catholic.id))
      .run();
  });
});
