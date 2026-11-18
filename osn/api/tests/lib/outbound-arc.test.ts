import { it } from "@effect/vitest";
import { arcOutboundKeys } from "@osn/db/schema";
import { Db, type DbService } from "@osn/db/service";
import { checkArcKid } from "@shared/crypto/arc-kid";
import { Effect, Layer, Logger } from "effect";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";

import {
  _resetOutboundKeyForTests,
  arcAuthHeader,
  OutboundKeyNotPublishedError,
  publishOutboundKey,
} from "../../src/lib/outbound-arc";
import {
  createCapturingTestLayer,
  createTestLayer,
  createTestLayerWithSqlite,
} from "../helpers/db";
import { holdQueries } from "../helpers/held-query";

/**
 * osn-api's outbound ARC key: minted per isolate, written to
 * `arc_outbound_keys` before anything is signed with it, and replaced before
 * its expiry. Apps verify osn-api's tokens against those rows
 * (`GET /.well-known/arc-jwks.json`), so a token signed with a key that is not
 * there would be refused by every app.
 */

const SECRET = "test-internal-secret-of-32-chars!";
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

/** The expiry, unix seconds, a kid carries. */
const expiryOf = (keyId: string): number => Number(keyId.split(".")[1]);

beforeEach(() => _resetOutboundKeyForTests());
afterEach(() => {
  _resetOutboundKeyForTests();
  vi.restoreAllMocks();
});

describe("outbound ARC key", () => {
  it("refuses to sign with a key publishOutboundKey did not answer", async () => {
    await expect(
      arcAuthHeader({ keyId: "made-up" }, "zap-api", "account:erase"),
    ).rejects.toBeInstanceOf(OutboundKeyNotPublishedError);
  });

  it.effect("publishes the key once, then signs with the kid it published", () =>
    Effect.gen(function* () {
      const key = yield* publishOutboundKey(arc);
      expect(yield* publishOutboundKey(arc)).toBe(key);
      const rows = yield* keyRows;
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      const header = yield* Effect.promise(() => arcAuthHeader(key, "zap-api", "account:erase"));
      expect(kidOf(header)).toBe(row.keyId);
      expect(yield* Effect.promise(() => checkArcKid(row.keyId, SECRET, row.createdAt))).toBe(true);
      expect(JSON.parse(row.publicKeyJwk)).toMatchObject({ kty: "EC", crv: "P-256" });
      expect(JSON.parse(row.publicKeyJwk)).not.toHaveProperty("d");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it("four first calls at once share one write", async () => {
    const { layer, captured } = createCapturingTestLayer();
    const keys = await Effect.runPromise(
      Effect.all(
        [
          publishOutboundKey(arc),
          publishOutboundKey(arc),
          publishOutboundKey(arc),
          publishOutboundKey(arc),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.provide(layer)),
    );
    expect(new Set(keys.map((key) => key.keyId)).size).toBe(1);
    expect(
      captured.filter((statement) => statement.sql.startsWith(`insert into "arc_outbound_keys"`)),
    ).toHaveLength(1);
  });

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
      const first = yield* publishOutboundKey(arc);
      const realNow = Date.now;
      try {
        Date.now = () => (expiryOf(first.keyId) - 3_600) * 1000;
        const second = yield* publishOutboundKey(arc);
        const header = yield* Effect.promise(() =>
          arcAuthHeader(second, "zap-api", "account:erase"),
        );
        const rows = yield* keyRows;
        expect(rows).toHaveLength(2);
        expect(kidOf(header)).not.toBe(first.keyId);
        expect(rows.map((row) => row.keyId)).toContain(kidOf(header));
      } finally {
        Date.now = realNow;
      }
    }).pipe(Effect.provide(createTestLayer())),
  );

  it("a call signs with the key it published while another call publishes its replacement", async () => {
    const { db } = createTestLayerWithSqlite();
    const held = holdQueries(db);
    const layer = Layer.succeed(Db, { db: held.db });
    const publish = () => Effect.runPromise(publishOutboundKey(arc).pipe(Effect.provide(layer)));
    const first = await publish();
    const realNow = Date.now;
    try {
      Date.now = () => (expiryOf(first.keyId) - 3_600) * 1000;
      const hold = held.hold(/^insert into "arc_outbound_keys"/);
      const replacing = publish();
      await hold.reached;
      const header = await arcAuthHeader(first, "zap-api", "account:erase");
      expect(kidOf(header)).toBe(first.keyId);
      hold.release();
      expect((await replacing).keyId).not.toBe(first.keyId);
    } finally {
      Date.now = realNow;
    }
  });

  it.effect("a failed write leaves the key unpublished, and the next call writes it", () =>
    Effect.gen(function* () {
      const failed = yield* Effect.result(
        publishOutboundKey(arc).pipe(Effect.provideService(Db, { db: brokenDb })),
      );
      expect(failed._tag).toBe("Failure");
      expect(yield* keyRows).toHaveLength(0);
      const key = yield* publishOutboundKey(arc);
      expect((yield* keyRows).map((row) => row.keyId)).toEqual([key.keyId]);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect(
    "a key that failed to mint is dropped, and the next call mints and publishes another",
    () =>
      Effect.gen(function* () {
        vi.spyOn(crypto.subtle, "generateKey").mockRejectedValueOnce(new Error("no key pair"));
        const failed = yield* Effect.result(publishOutboundKey(arc));
        expect(failed._tag).toBe("Failure");
        const key = yield* publishOutboundKey(arc);
        expect((yield* keyRows).map((row) => row.keyId)).toEqual([key.keyId]);
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("with a secret shorter than 32 characters, mints a kid with no MAC and warns", () => {
    const lines: { level: string; message: unknown }[] = [];
    const log = Logger.layer([
      Logger.map(Logger.formatStructured, (line) => void lines.push(line)),
    ]);
    return Effect.gen(function* () {
      const key = yield* publishOutboundKey({ kidSecret: "s".repeat(31) });
      expect(key.keyId.split(".")).toHaveLength(2);
      const warnings = lines.filter((line) => JSON.stringify(line.message).includes("no MAC"));
      expect(warnings).toHaveLength(1);
      expect(JSON.stringify(warnings)).not.toContain("s".repeat(31));
    }).pipe(Effect.provide(createTestLayer()), Effect.provide(log));
  });
});
