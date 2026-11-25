import { it } from "@effect/vitest";
import { arcOutboundKeys } from "@osn/db/schema";
import { Db, type DbService } from "@osn/db/service";
import { checkArcKid } from "@shared/crypto/arc-kid";
import { Effect, Layer, Logger } from "effect";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";

import {
  _resetOutboundKeyForTests,
  arcAuthHeader,
  arcPostJsonEffect,
  OutboundKeyNotPublishedError,
  PUBLISHED_OUTBOUND_KEYS_BOUND,
  publishedOutboundKeys,
  publishOutboundKey,
  publishOutboundKeyInBackground,
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
const KID_SECRET = "kid-secret-kid-secret-kid-secret-kid";
const arc = { kidSecret: KID_SECRET, serviceSecret: SECRET };

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
      // An app holding either secret alone accepts the kid.
      for (const app of [
        { kidSecret: KID_SECRET, serviceSecret: undefined },
        { kidSecret: undefined, serviceSecret: SECRET },
      ]) {
        expect(yield* Effect.promise(() => checkArcKid(row.keyId, app, row.createdAt))).toBe(true);
      }
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

  it.effect(
    "with secrets shorter than 32 characters, mints a kid with no MAC and warns once for each, naming it",
    () => {
      const lines: { level: string; message: unknown }[] = [];
      const log = Logger.layer([
        Logger.map(Logger.formatStructured, (line) => void lines.push(line)),
      ]);
      return Effect.gen(function* () {
        const key = yield* publishOutboundKey({
          kidSecret: "k".repeat(31),
          serviceSecret: "s".repeat(31),
        });
        expect(key.keyId.split(".")).toHaveLength(2);
        const warnings = lines.filter((line) => JSON.stringify(line.message).includes("no MAC"));
        expect(warnings).toHaveLength(2);
        expect(JSON.stringify(warnings)).toContain("OSN_ARC_KID_SECRET");
        expect(JSON.stringify(warnings)).toContain("INTERNAL_SERVICE_SECRET");
        expect(JSON.stringify(warnings)).not.toContain("s".repeat(31));
        expect(JSON.stringify(warnings)).not.toContain("k".repeat(31));
      }).pipe(Effect.provide(createTestLayer()), Effect.provide(log));
    },
  );
});

/** One structured log line, as `Logger.formatStructured` writes it. */
type LogLine = { level: string; message: unknown; annotations?: unknown };

/** A logger layer that keeps every line in `lines`. */
const keepLines = (lines: LogLine[]) =>
  Logger.layer([Logger.map(Logger.formatStructured, (line) => void lines.push(line as LogLine))]);

/** The lines whose message contains `text`. */
const linesWith = (lines: LogLine[], text: string): LogLine[] =>
  lines.filter((line) => JSON.stringify(line.message).includes(text));

/** The `run` the Worker hands the background publish: the app runtime, here a test layer. */
const runOn =
  (layer: Layer.Layer<Db>, lines: LogLine[] = []) =>
  (effect: Effect.Effect<void, never, Db>): Promise<void> =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(keepLines(lines))));

const inserts = (captured: ReadonlyArray<{ sql: string }>) =>
  captured.filter((statement) => statement.sql.startsWith(`insert into "arc_outbound_keys"`));

/**
 * The Worker publishes the isolate's key on its first request of any kind,
 * after the response, through `ctx.waitUntil` (`src/index.ts`). These pin what
 * that background publish guarantees: one write per key, never a rejection,
 * a pause after a failure, the replacement once the key is due, and the
 * outbound path still writing before it signs.
 */
describe("the background publish on a request", () => {
  it("writes the key once: the first call answers the write, a later call answers null", async () => {
    const { layer, captured } = createCapturingTestLayer();
    const run = runOn(layer);
    const first = publishOutboundKeyInBackground(arc, run);
    expect(first).not.toBeNull();
    // A second request before the write settles shares it.
    const second = publishOutboundKeyInBackground(arc, run);
    await Promise.all([first, second]);
    expect(publishOutboundKeyInBackground(arc, run)).toBeNull();
    expect(inserts(captured)).toHaveLength(1);
  });

  it("a failed write resolves, says why, and the next call to an app still writes the key before it signs", async () => {
    const lines: LogLine[] = [];
    const broken = Layer.succeed(Db, { db: brokenDb });
    const failing = publishOutboundKeyInBackground(arc, runOn(broken, lines));
    await expect(failing).resolves.toBeUndefined();
    const warnings = linesWith(lines, "publish failed");
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain("D1 down");

    const { layer } = createTestLayerWithSqlite();
    const key = await Effect.runPromise(publishOutboundKey(arc).pipe(Effect.provide(layer)));
    const rows = await Effect.runPromise(keyRows.pipe(Effect.provide(layer)));
    expect(rows.map((row) => row.keyId)).toEqual([key.keyId]);
    expect(kidOf(await arcAuthHeader(key, "zap-api", "account:erase"))).toBe(key.keyId);
  });

  it("after a failed write, starts no other for a minute, then writes", async () => {
    const broken = Layer.succeed(Db, { db: brokenDb });
    await publishOutboundKeyInBackground(arc, runOn(broken));
    const { layer, captured } = createCapturingTestLayer();
    expect(publishOutboundKeyInBackground(arc, runOn(layer))).toBeNull();
    const failedAt = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(failedAt + 61_000);
    await publishOutboundKeyInBackground(arc, runOn(layer));
    expect(inserts(captured)).toHaveLength(1);
  });

  it("after a key that failed to mint, starts no other for a minute", async () => {
    vi.spyOn(crypto.subtle, "generateKey").mockRejectedValueOnce(new Error("no key pair"));
    const { layer, captured } = createCapturingTestLayer();
    const lines: LogLine[] = [];
    await expect(publishOutboundKeyInBackground(arc, runOn(layer, lines))).resolves.toBeUndefined();
    expect(linesWith(lines, "publish failed")).toHaveLength(1);
    expect(publishOutboundKeyInBackground(arc, runOn(layer))).toBeNull();
    expect(inserts(captured)).toHaveLength(0);
  });

  it("writes the replacement once the published key is within two hours of its expiry", async () => {
    const { layer } = createTestLayerWithSqlite();
    const run = runOn(layer);
    await publishOutboundKeyInBackground(arc, run);
    const [first] = await Effect.runPromise(keyRows.pipe(Effect.provide(layer)));
    vi.spyOn(Date, "now").mockReturnValue((expiryOf(first!.keyId) - 3_600) * 1000);
    const replacing = publishOutboundKeyInBackground(arc, run);
    expect(replacing).not.toBeNull();
    await replacing;
    const ids = (await Effect.runPromise(keyRows.pipe(Effect.provide(layer)))).map((r) => r.keyId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("a call to an app after it writes no key and signs with the key it wrote", async () => {
    const { layer, captured } = createCapturingTestLayer();
    await publishOutboundKeyInBackground(arc, runOn(layer));
    const [row] = await Effect.runPromise(keyRows.pipe(Effect.provide(layer)));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ ok: true }));
    await Effect.runPromise(
      arcPostJsonEffect(
        "https://zap.test/internal/account-deleted",
        {},
        { audience: "zap-api", scope: "account:erase" },
        arc,
      ).pipe(Effect.provide(layer)),
    );
    expect(inserts(captured)).toHaveLength(1);
    const init = fetchSpy.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(kidOf(init.headers["authorization"]!)).toBe(row!.keyId);
  });
});

/**
 * `GET /.well-known/arc-jwks.json` reads the published keys with a bound:
 * past it, the newest are kept, so a key written a moment ago is always
 * served. A warning says when the set nears the bound and when it passes it,
 * at most once a minute, since anyone may call the route.
 */
describe("the bounded read of the published keys", () => {
  const jwk = JSON.stringify({ kty: "EC", crv: "P-256", x: "xx", y: "yy" });

  /** `count` live keys, `key-0` expiring first and each next one a second later. */
  const seed = async (db: DbService["db"], count: number): Promise<void> => {
    const now = Math.floor(Date.now() / 1000);
    const rows = Array.from({ length: count }, (_, i) => ({
      keyId: `key-${i}`,
      publicKeyJwk: jwk,
      createdAt: now,
      expiresAt: now + 3_600 + i,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      // eslint-disable-next-line no-await-in-loop -- chunks of one seed, in order
      await db.insert(arcOutboundKeys).values(rows.slice(i, i + 200));
    }
  };

  const read = (layer: Layer.Layer<Db>, lines: LogLine[]) =>
    Effect.runPromise(
      publishedOutboundKeys.pipe(Effect.provide(layer), Effect.provide(keepLines(lines))),
    );

  it("past the bound, serves the newest keys up to it and warns once a minute", async () => {
    const { layer, db } = createTestLayerWithSqlite();
    const count = PUBLISHED_OUTBOUND_KEYS_BOUND + 1;
    await seed(db, count);
    const lines: LogLine[] = [];
    const keys = await read(layer, lines);
    const kids = keys.map((key) => key.kid);
    expect(kids).toHaveLength(PUBLISHED_OUTBOUND_KEYS_BOUND);
    expect(kids).toContain(`key-${count - 1}`);
    expect(kids).not.toContain("key-0");
    expect(linesWith(lines, "left out")).toHaveLength(1);
    await read(layer, lines);
    expect(linesWith(lines, "left out")).toHaveLength(1);
    expect(linesWith(lines, "nearing")).toHaveLength(0);
  });

  it("at the bound exactly, serves every key and says none is left out", async () => {
    const { layer, db } = createTestLayerWithSqlite();
    await seed(db, PUBLISHED_OUTBOUND_KEYS_BOUND);
    const lines: LogLine[] = [];
    expect(await read(layer, lines)).toHaveLength(PUBLISHED_OUTBOUND_KEYS_BOUND);
    expect(linesWith(lines, "left out")).toHaveLength(0);
    expect(linesWith(lines, "nearing")).toHaveLength(1);
  });

  it("at half the bound, serves every key and warns that it is near", async () => {
    const { layer, db } = createTestLayerWithSqlite();
    await seed(db, PUBLISHED_OUTBOUND_KEYS_BOUND / 2);
    const lines: LogLine[] = [];
    expect(await read(layer, lines)).toHaveLength(PUBLISHED_OUTBOUND_KEYS_BOUND / 2);
    expect(linesWith(lines, "nearing")).toHaveLength(1);
    expect(linesWith(lines, "left out")).toHaveLength(0);
  });

  it("below half the bound, serves every key and warns of nothing", async () => {
    const { layer, db } = createTestLayerWithSqlite();
    await seed(db, PUBLISHED_OUTBOUND_KEYS_BOUND / 2 - 1);
    const lines: LogLine[] = [];
    expect(await read(layer, lines)).toHaveLength(PUBLISHED_OUTBOUND_KEYS_BOUND / 2 - 1);
    expect(linesWith(lines, "read bound")).toHaveLength(0);
  });
});

/**
 * Past the bound the read serves only the newest keys, so a busy isolate's key
 * can fall out of the list. Before it signs, a call checks its key is still
 * served, and replaces it when it is not: nothing signs with a key the apps
 * cannot find.
 */
describe("a key the published set does not serve", () => {
  const jwk = JSON.stringify({ kty: "EC", crv: "P-256", x: "xx", y: "yy" });

  /** `count` live keys, every one expiring at `expiresAt`. */
  const seedExpiringAt = async (
    db: DbService["db"],
    count: number,
    expiresAt: number,
  ): Promise<void> => {
    const rows = Array.from({ length: count }, (_, i) => ({
      keyId: `other-${i}`,
      publicKeyJwk: jwk,
      createdAt: 0,
      expiresAt,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      // eslint-disable-next-line no-await-in-loop -- chunks of one seed, in order
      await db.insert(arcOutboundKeys).values(rows.slice(i, i + 200));
    }
  };

  const checks = (captured: ReadonlyArray<{ sql: string }>) =>
    captured.filter(
      (statement) =>
        statement.sql.startsWith("select") && statement.sql.includes(`"arc_outbound_keys"`),
    );

  const post = (layer: Layer.Layer<Db>) =>
    Effect.runPromise(
      Effect.result(
        arcPostJsonEffect(
          "https://zap.test/internal/account-deleted",
          {},
          { audience: "zap-api", scope: "account:erase" },
          arc,
        ).pipe(Effect.provide(layer)),
      ),
    );

  it("is replaced before the next call signs, by a key the set serves", async () => {
    const { layer, db } = createTestLayerWithSqlite();
    const first = await Effect.runPromise(publishOutboundKey(arc).pipe(Effect.provide(layer)));
    // A full set of keys that expire after it, and before any key minted now.
    await seedExpiringAt(db, PUBLISHED_OUTBOUND_KEYS_BOUND, expiryOf(first.keyId) + 1);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    const lines: LogLine[] = [];
    const second = await Effect.runPromise(
      publishOutboundKey(arc).pipe(Effect.provide(layer), Effect.provide(keepLines(lines))),
    );
    expect(second.keyId).not.toBe(first.keyId);
    expect(linesWith(lines, "not in the published set")).toHaveLength(1);
    const served = (await Effect.runPromise(publishedOutboundKeys.pipe(Effect.provide(layer)))).map(
      (key) => key.kid,
    );
    expect(served).toContain(second.keyId);
    expect(served).not.toContain(first.keyId);
    expect(kidOf(await arcAuthHeader(second, "zap-api", "account:erase"))).toBe(second.keyId);
  });

  it("checks once for the calls within thirty seconds", async () => {
    const { layer, captured } = createCapturingTestLayer();
    const publish = () => Effect.runPromise(publishOutboundKey(arc).pipe(Effect.provide(layer)));
    await publish();
    await publish();
    expect(checks(captured)).toHaveLength(1);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    await publish();
    expect(checks(captured)).toHaveLength(2);
  });

  it("fails the call, sending nothing, when even a new key would not be served", async () => {
    const { layer, db } = createTestLayerWithSqlite();
    const now = Math.floor(Date.now() / 1000);
    await seedExpiringAt(db, PUBLISHED_OUTBOUND_KEYS_BOUND, now + 10 * 3_600);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await post(layer);
    expect(result._tag).toBe("Failure");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails the call, sending nothing, when the check cannot read the set, and the next call checks again", async () => {
    const { db, layer } = createTestLayerWithSqlite();
    const noReads = new Proxy(db, {
      get: (target, member, receiver) =>
        member === "select"
          ? () => {
              throw new Error("D1 down");
            }
          : Reflect.get(target, member, receiver),
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ ok: true }));
    const result = await post(Layer.succeed(Db, { db: noReads }));
    expect(result._tag).toBe("Failure");
    expect(fetchSpy).not.toHaveBeenCalled();
    // The failed check is not kept: a call on a readable set checks and signs.
    expect((await post(layer))._tag).toBe("Success");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps a key with exactly the bound of live keys at or after its expiry", async () => {
    const { layer, db } = createTestLayerWithSqlite();
    const first = await Effect.runPromise(publishOutboundKey(arc).pipe(Effect.provide(layer)));
    // With the key itself, the bound exactly: the read still serves it.
    await seedExpiringAt(db, PUBLISHED_OUTBOUND_KEYS_BOUND - 1, expiryOf(first.keyId) + 1);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    const again = await Effect.runPromise(publishOutboundKey(arc).pipe(Effect.provide(layer)));
    expect(again.keyId).toBe(first.keyId);
    const served = (await Effect.runPromise(publishedOutboundKeys.pipe(Effect.provide(layer)))).map(
      (key) => key.kid,
    );
    expect(served).toContain(first.keyId);
  });

  it("concurrent calls share one check", async () => {
    const { layer, captured } = createCapturingTestLayer();
    await Effect.runPromise(
      Effect.all([publishOutboundKey(arc), publishOutboundKey(arc), publishOutboundKey(arc)], {
        concurrency: "unbounded",
      }).pipe(Effect.provide(layer)),
    );
    expect(checks(captured)).toHaveLength(1);
  });
});

/** The background publish's own edges: a runtime that rejects, and the reason it logs. */
describe("the background publish's failures", () => {
  it("a run that rejects resolves and pauses background writes", async () => {
    const rejecting = publishOutboundKeyInBackground(arc, () =>
      Promise.reject(new Error("runtime down")),
    );
    await expect(rejecting).resolves.toBeUndefined();
    const { layer } = createTestLayerWithSqlite();
    expect(publishOutboundKeyInBackground(arc, runOn(layer))).toBeNull();
  });

  it("logs the innermost cause, cut to 200 characters, not the outer message", async () => {
    const inner = "d".repeat(300);
    const failing = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("Failed query: insert into arc_outbound_keys params: secret-ish", {
            cause: new Error(inner),
          });
        },
      },
    ) as DbService["db"];
    const lines: LogLine[] = [];
    await publishOutboundKeyInBackground(arc, runOn(Layer.succeed(Db, { db: failing }), lines));
    const [warning] = linesWith(lines, "publish failed");
    const text = JSON.stringify(warning);
    expect(text).toContain("d".repeat(200));
    expect(text).not.toContain("d".repeat(201));
    expect(text).not.toContain("Failed query");
  });
});

/**
 * A key is written, and served, only as the key it is: one whose first write
 * failed is dropped, one whose row was deleted is replaced, and callers that
 * find their key unserved together mint one replacement between them.
 */
describe("which key a call signs with", () => {
  const jwk = JSON.stringify({ kty: "EC", crv: "P-256", x: "xx", y: "yy" });

  it("after a failed write, the next key written expires four hours after that write", async () => {
    await publishOutboundKeyInBackground(arc, runOn(Layer.succeed(Db, { db: brokenDb })));
    const later = Date.now() + 45_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    const { layer } = createTestLayerWithSqlite();
    const key = await Effect.runPromise(publishOutboundKey(arc).pipe(Effect.provide(layer)));
    expect(expiryOf(key.keyId)).toBe(Math.floor(later / 1000) + 4 * 3_600);
  });

  it("replaces a key whose row was deleted, at the next check", async () => {
    const { layer, db } = createTestLayerWithSqlite();
    const first = await Effect.runPromise(publishOutboundKey(arc).pipe(Effect.provide(layer)));
    await db.delete(arcOutboundKeys);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    const lines: LogLine[] = [];
    const second = await Effect.runPromise(
      publishOutboundKey(arc).pipe(Effect.provide(layer), Effect.provide(keepLines(lines))),
    );
    expect(second.keyId).not.toBe(first.keyId);
    expect(
      (await Effect.runPromise(keyRows.pipe(Effect.provide(layer)))).map((r) => r.keyId),
    ).toEqual([second.keyId]);
    expect(linesWith(lines, "not in the published set")).toHaveLength(1);
  });

  it("callers that find the key unserved together mint and write one replacement", async () => {
    const { layer, db, captured } = createCapturingTestLayer();
    const first = await Effect.runPromise(publishOutboundKey(arc).pipe(Effect.provide(layer)));
    const rows = Array.from({ length: PUBLISHED_OUTBOUND_KEYS_BOUND }, (_, i) => ({
      keyId: `other-${i}`,
      publicKeyJwk: jwk,
      createdAt: 0,
      expiresAt: expiryOf(first.keyId) + 1,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      // eslint-disable-next-line no-await-in-loop -- chunks of one seed, in order
      await db.insert(arcOutboundKeys).values(rows.slice(i, i + 200));
    }
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    const insertsBefore = inserts(captured).length;
    const lines: LogLine[] = [];
    const keys = await Effect.runPromise(
      Effect.all([publishOutboundKey(arc), publishOutboundKey(arc), publishOutboundKey(arc)], {
        concurrency: "unbounded",
      }).pipe(Effect.provide(layer), Effect.provide(keepLines(lines))),
    );
    expect(new Set(keys.map((key) => key.keyId)).size).toBe(1);
    expect(keys[0]!.keyId).not.toBe(first.keyId);
    expect(inserts(captured).length - insertsBefore).toBe(1);
    expect(linesWith(lines, "not in the published set")).toHaveLength(1);
  });
});
