import { it } from "@effect/vitest";
import { arcOutboundKeys } from "@osn/db/schema";
import { Db, type DbService } from "@osn/db/service";
import { checkArcKid } from "@shared/crypto/arc-kid";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect } from "vitest";

import {
  _resetOutboundKeyForTests,
  arcAuthHeader,
  OutboundKeyNotPublishedError,
  publishOutboundKey,
} from "../../src/lib/outbound-arc";
import { createTestLayer } from "../helpers/db";

/**
 * osn-api's outbound ARC key: minted per isolate, written to
 * `arc_outbound_keys` before anything is signed with it, and replaced before
 * its expiry. Apps verify osn-api's tokens against those rows
 * (`GET /.well-known/arc-jwks.json`), so a token signed with a key that is not
 * there would be refused by every app.
 */

const SECRET = "test-internal-secret";
const arc = { kidSecret: SECRET };

const keyRows = Effect.gen(function* () {
  const { db } = yield* Db;
  return yield* Effect.promise(() => db.select().from(arcOutboundKeys));
});

const kidOf = (header: string): string => {
  const [, jwt] = header.split(" ");
  const [protectedHeader] = (jwt ?? "").split(".");
  const json = atob((protectedHeader ?? "").replace(/-/g, "+").replace(/_/g, "/"));
  return (JSON.parse(json) as { kid: string }).kid;
};

/** A database whose every call fails. */
const brokenDb = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error("D1 down");
    },
  },
) as DbService["db"];

beforeEach(() => _resetOutboundKeyForTests());
afterEach(() => _resetOutboundKeyForTests());

describe("outbound ARC key", () => {
  it("refuses to sign before the key is published", async () => {
    await expect(arcAuthHeader("zap-api", "account:erase")).rejects.toBeInstanceOf(
      OutboundKeyNotPublishedError,
    );
  });

  it.effect("publishes the key once, then signs with the kid it published", () =>
    Effect.gen(function* () {
      yield* publishOutboundKey(arc);
      yield* publishOutboundKey(arc);
      const rows = yield* keyRows;
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      const header = yield* Effect.promise(() => arcAuthHeader("zap-api", "account:erase"));
      expect(kidOf(header)).toBe(row.keyId);
      expect(yield* Effect.promise(() => checkArcKid(row.keyId, SECRET, row.createdAt))).toBe(true);
      expect(JSON.parse(row.publicKeyJwk)).toMatchObject({ kty: "EC", crv: "P-256" });
      expect(JSON.parse(row.publicKeyJwk)).not.toHaveProperty("d");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("two first calls at once leave one row", () =>
    Effect.gen(function* () {
      yield* Effect.all([publishOutboundKey(arc), publishOutboundKey(arc)], {
        concurrency: "unbounded",
      });
      expect(yield* keyRows).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("deletes keys that expired more than a day ago when it publishes", () =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const now = Math.floor(Date.now() / 1000);
      yield* Effect.promise(() =>
        db.insert(arcOutboundKeys).values([
          { keyId: "old", publicKeyJwk: "{}", createdAt: 0, expiresAt: now - 86_401 },
          { keyId: "recent", publicKeyJwk: "{}", createdAt: 0, expiresAt: now - 60 },
        ]),
      );
      yield* publishOutboundKey(arc);
      const ids = (yield* keyRows).map((row) => row.keyId);
      expect(ids).not.toContain("old");
      expect(ids).toContain("recent");
      expect(ids).toHaveLength(2);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("replaces a key within two hours of its expiry, and publishes the new one first", () =>
    Effect.gen(function* () {
      yield* publishOutboundKey(arc);
      const first = (yield* keyRows)[0]!;
      const realNow = Date.now;
      try {
        Date.now = () => (first.expiresAt - 3_600) * 1000;
        yield* publishOutboundKey(arc);
        const header = yield* Effect.promise(() => arcAuthHeader("zap-api", "account:erase"));
        const rows = yield* keyRows;
        expect(rows).toHaveLength(2);
        expect(kidOf(header)).not.toBe(first.keyId);
        expect(rows.map((row) => row.keyId)).toContain(kidOf(header));
      } finally {
        Date.now = realNow;
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a failed write leaves the key unpublished, and the next call writes it", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.result(
        publishOutboundKey(arc).pipe(Effect.provideService(Db, { db: brokenDb })),
      );
      expect(failed._tag).toBe("Failure");
      const refused = yield* Effect.promise(() =>
        arcAuthHeader("zap-api", "account:erase").then(
          () => null,
          (error: unknown) => error,
        ),
      );
      expect(refused).toBeInstanceOf(OutboundKeyNotPublishedError);
      yield* publishOutboundKey(arc);
      expect(yield* keyRows).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );
});
