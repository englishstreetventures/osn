import { describe, it, expect } from "bun:test";
import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { sessions, families } from "@cire/db";
import { sessionService, SessionInvalid } from "./session";
import { DbService } from "../db";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";

const withDb = effWith(TestDbLayer);

function pickFamilyId(): Effect.Effect<string, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const [first] = db.select({ id: families.id }).from(families).all();
    if (!first) throw new Error("seed missing families");
    return first.id;
  });
}

describe("sessionService.create", () => {
  it(
    "produces a base64url token of 256 bits (43 chars, no padding)",
    withDb(
      Effect.gen(function* () {
        const familyId = yield* pickFamilyId();
        const { token, expiresAt } = yield* sessionService.create(familyId);
        expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(token).toHaveLength(43);
        expect(token.includes("=")).toBe(false);
        expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
      }),
    ),
  );

  it(
    "persists the row with the requested ttl",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const familyId = yield* pickFamilyId();
        const before = Date.now();
        const { token, expiresAt } = yield* sessionService.create(familyId, 60);
        // Row is keyed by the SHA-256 hash, not the raw token.
        const [row] = db.select().from(sessions).where(eq(sessions.familyId, familyId)).all();
        expect(row).toBeDefined();
        expect(row!.familyId).toBe(familyId);
        expect(row!.token).not.toBe(token);
        expect(row!.token).toMatch(/^[0-9a-f]{64}$/);
        // ttl is 60s — expiresAt should land in [before, before+61s].
        expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(expiresAt.getTime()).toBeLessThanOrEqual(before + 61_000);
      }),
    ),
  );

  it(
    "stores the SHA-256 hash of the token rather than the raw token",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const familyId = yield* pickFamilyId();
        const { token } = yield* sessionService.create(familyId);
        // Raw token must NOT appear in the table.
        const [rawHit] = db.select().from(sessions).where(eq(sessions.token, token)).all();
        expect(rawHit).toBeUndefined();
        // Hashed lookup must hit and the column shape is 64 lowercase hex chars.
        const expectedHash = Array.from(
          new Uint8Array(
            yield* Effect.promise(() =>
              crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
            ),
          ),
        )
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const [hashHit] = db.select().from(sessions).where(eq(sessions.token, expectedHash)).all();
        expect(hashHit).toBeDefined();
        expect(hashHit!.token).toMatch(/^[0-9a-f]{64}$/);
      }),
    ),
  );

  it(
    "creates distinct tokens on successive calls",
    withDb(
      Effect.gen(function* () {
        const familyId = yield* pickFamilyId();
        const a = yield* sessionService.create(familyId);
        const b = yield* sessionService.create(familyId);
        expect(a.token).not.toBe(b.token);
      }),
    ),
  );
});

describe("sessionService.validate", () => {
  it(
    "returns familyId for an active token",
    withDb(
      Effect.gen(function* () {
        const familyId = yield* pickFamilyId();
        const { token } = yield* sessionService.create(familyId);
        const result = yield* sessionService.validate(token);
        expect(result.familyId).toBe(familyId);
      }),
    ),
  );

  it(
    "fails with reason=missing for an unknown token",
    withDb(
      Effect.gen(function* () {
        const error = yield* Effect.flip(sessionService.validate("not-a-real-token"));
        expect(error).toBeInstanceOf(SessionInvalid);
        expect(error.reason).toBe("missing");
      }),
    ),
  );

  it(
    "fails with reason=missing for an empty string",
    withDb(
      Effect.gen(function* () {
        const error = yield* Effect.flip(sessionService.validate(""));
        expect(error.reason).toBe("missing");
      }),
    ),
  );

  it(
    "fails with reason=expired when expiresAt has passed",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const familyId = yield* pickFamilyId();
        const expiredToken = "expired-token-fixture";
        // Mirror the production write path: store the hash, look up by raw token.
        const expiredHash = Array.from(
          new Uint8Array(
            yield* Effect.promise(() =>
              crypto.subtle.digest("SHA-256", new TextEncoder().encode(expiredToken)),
            ),
          ),
        )
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        db.insert(sessions)
          .values({
            id: crypto.randomUUID(),
            familyId,
            token: expiredHash,
            expiresAt: new Date(Date.now() - 1000),
            createdAt: new Date(Date.now() - 60_000),
          })
          .run();
        const error = yield* Effect.flip(sessionService.validate(expiredToken));
        expect(error.reason).toBe("expired");
      }),
    ),
  );
});

describe("sessionService.revoke", () => {
  it(
    "removes the row so subsequent validate returns missing",
    withDb(
      Effect.gen(function* () {
        const familyId = yield* pickFamilyId();
        const { token } = yield* sessionService.create(familyId);
        yield* sessionService.revoke(token);
        const error = yield* Effect.flip(sessionService.validate(token));
        expect(error.reason).toBe("missing");
      }),
    ),
  );

  it(
    "is a no-op for an unknown token",
    withDb(
      Effect.gen(function* () {
        yield* sessionService.revoke("does-not-exist");
        // No throw — success.
        expect(true).toBe(true);
      }),
    ),
  );
});

describe("sessionService.revokeAllForFamily", () => {
  it(
    "drops every session for that family but leaves others alone",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const allFamilies = db.select({ id: families.id }).from(families).all();
        const target = allFamilies[0]!.id;
        const other = allFamilies[1]!.id;
        const a = yield* sessionService.create(target);
        const b = yield* sessionService.create(target);
        const keep = yield* sessionService.create(other);

        yield* sessionService.revokeAllForFamily(target);

        const errA = yield* Effect.flip(sessionService.validate(a.token));
        const errB = yield* Effect.flip(sessionService.validate(b.token));
        expect(errA.reason).toBe("missing");
        expect(errB.reason).toBe("missing");

        const stillThere = yield* sessionService.validate(keep.token);
        expect(stillThere.familyId).toBe(other);
      }),
    ),
  );
});
