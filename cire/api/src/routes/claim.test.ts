import { describe, it, expect, beforeAll } from "bun:test";

import { createRateLimiter } from "@shared/rate-limit";
import { Effect } from "effect";

import { createApp } from "../app";
import eventsData from "../data/events.json";
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

const post = (body: unknown) =>
  Effect.promise(() =>
    app.fetch(
      new Request("http://localhost/api/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
              headers: { "Content-Type": "application/json" },
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
          headers: { "Content-Type": "application/json" },
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
