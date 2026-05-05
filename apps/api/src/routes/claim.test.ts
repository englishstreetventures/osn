import { describe, it, expect, beforeAll } from "bun:test";
import { Effect } from "effect";
import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import { createRateLimiter } from "../services/rate-limit";
import { eff } from "../test-helpers";

interface FamilyMember {
  firstName: string;
  lastName: string;
  eventIds: string[];
}

interface ClaimOk {
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
        const res = yield* post({ publicId: "SHARMA-IVY-QM42" });
        expect(res.status).toBe(200);
        const data = yield* Effect.promise(() => res.json<ClaimOk>());
        expect(data.familyName).toBe("Sharma");
        expect(data.members).toHaveLength(1);
        expect(data.members[0]!.firstName).toBe("Priya");
        expect(data.members[0]!.eventIds.sort()).toEqual(["mehndi", "reception", "wedding"]);
        expect(data.events).toHaveLength(3);
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
        const res = yield* post({ publicId: "sharma-ivy-qm42" });
        expect(res.status).toBe(200);
        const data = yield* Effect.promise(() => res.json<ClaimOk>());
        expect(data.publicId).toBe("SHARMA-IVY-QM42");
      }),
    ),
  );
});
