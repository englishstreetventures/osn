import { arcOutboundKeys } from "@osn/db/schema";
import { afterEach, describe, expect, it, vi } from "vitest";

import { _resetOutboundKeyForTests } from "../../src/lib/outbound-arc";
import { createArcJwksRoutes as createArcJwksRoutesRaw } from "../../src/routes/arc-jwks";
import { memoryLimiter, MINUTE_MS, OSN_RATE_LIMITS } from "../../src/routes/auth/limiters";
import { createCapturingTestLayer, createTestLayerWithSqlite } from "../helpers/db";
import { createArcJwksRoutes } from "../helpers/routes";

/**
 * `GET /.well-known/arc-jwks.json` serves exactly the outbound keys osn-api
 * may still sign with, read fresh, as a JWK Set apps can import.
 */

afterEach(() => {
  _resetOutboundKeyForTests();
  vi.restoreAllMocks();
});

describe("GET /.well-known/arc-jwks.json", () => {
  it("lists unexpired keys with kid, alg and use, never a private member or a row that is no EC key, and is never cached", async () => {
    const { layer, db } = createTestLayerWithSqlite();
    const now = Math.floor(Date.now() / 1000);
    const jwk = JSON.stringify({ kty: "EC", crv: "P-256", x: "xx", y: "yy", d: "secret" });
    await db.insert(arcOutboundKeys).values([
      { keyId: "live", publicKeyJwk: jwk, createdAt: now, expiresAt: now + 3600 },
      { keyId: "gone", publicKeyJwk: jwk, createdAt: now - 90_000, expiresAt: now - 1 },
      { keyId: "broken", publicKeyJwk: "{not json", createdAt: now, expiresAt: now + 3600 },
    ]);
    const app = createArcJwksRoutes(layer);

    const res = await app.handle(new Request("http://localhost/.well-known/arc-jwks.json"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(body.keys).toEqual([
      { kty: "EC", crv: "P-256", x: "xx", y: "yy", kid: "live", alg: "ES256", use: "sig" },
    ]);
  });

  it("shows a key written a moment ago on the next request", async () => {
    const { layer, db } = createTestLayerWithSqlite();
    const app = createArcJwksRoutes(layer);
    const get = async () =>
      (
        (await (
          await app.handle(new Request("http://localhost/.well-known/arc-jwks.json"))
        ).json()) as {
          keys: unknown[];
        }
      ).keys;
    expect(await get()).toEqual([]);
    const now = Math.floor(Date.now() / 1000);
    await db.insert(arcOutboundKeys).values({
      keyId: "new",
      publicKeyJwk: JSON.stringify({ kty: "EC", crv: "P-256", x: "xx", y: "yy" }),
      createdAt: now,
      expiresAt: now + 3600,
    });
    expect(await get()).toHaveLength(1);
  });
});

/**
 * The route is public, so each caller's address has two budgets: 30 a minute,
 * refused at the edge, and 60 an hour, which bounds the reads one address can
 * cost. An app fetches the list only for a kid it has not cached, so its
 * pattern stays far inside both.
 */
describe("GET /.well-known/arc-jwks.json — the caller's budgets", () => {
  /** The address every Worker's cross-zone subrequest arrives from. */
  const WORKER_ADDRESS = "2a06:98c0:3600::103";

  const limited = (layer: Parameters<typeof createArcJwksRoutesRaw>[0]) =>
    createArcJwksRoutesRaw(
      layer,
      undefined,
      undefined,
      {
        minute: memoryLimiter(OSN_RATE_LIMITS.arcJwksIp),
        hour: memoryLimiter(OSN_RATE_LIMITS.arcJwksIpHour),
      },
      { trustCloudflare: true },
    );

  const get = (app: ReturnType<typeof limited>, address?: string) =>
    app.handle(
      new Request("http://localhost/.well-known/arc-jwks.json", {
        headers: address === undefined ? {} : { "cf-connecting-ip": address },
      }),
    );

  const keyReads = (captured: ReadonlyArray<{ sql: string }>) =>
    captured.filter((statement) => statement.sql.startsWith("select")).length;

  it("never refuses the apps' pattern: a cold start, a fetch every five minutes, a fan-out wave", async () => {
    const { layer } = createTestLayerWithSqlite();
    const app = limited(layer);
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const statuses: number[] = [];
    const burst = async (count: number) => {
      for (let i = 0; i < count; i++) {
        // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
        statuses.push((await get(app, WORKER_ADDRESS)).status);
      }
    };
    await burst(8);
    for (let minute = 5; minute <= 55; minute += 5) {
      clock.mockReturnValue(start + minute * MINUTE_MS);
      // eslint-disable-next-line no-await-in-loop -- one fetch at a time
      await burst(minute === 30 ? 9 : 1);
    }
    expect(statuses).toHaveLength(8 + 10 + 9);
    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  it("refuses the request past 30 in a minute without reading a key, and serves another address", async () => {
    const { layer, captured } = createCapturingTestLayer();
    const app = limited(layer);
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    for (let i = 0; i < OSN_RATE_LIMITS.arcJwksIp.maxRequests; i++) {
      // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
      expect((await get(app, "203.0.113.7")).status).toBe(200);
    }
    const reads = keyReads(captured);
    const over = await get(app, "203.0.113.7");
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate_limited" });
    expect(keyReads(captured)).toBe(reads);
    expect((await get(app, "203.0.113.8")).status).toBe(200);
  });

  it("refuses the request past 60 in an hour, though no minute passed 30", async () => {
    const { layer } = createTestLayerWithSqlite();
    const app = limited(layer);
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    // A window ends strictly after its length, so each minute here is 61 s.
    const minute = MINUTE_MS + 1_000;
    for (let m = 0; m < 3; m++) {
      clock.mockReturnValue(start + m * minute);
      for (let i = 0; i < 20; i++) {
        // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
        expect((await get(app, "203.0.113.9")).status).toBe(200);
      }
    }
    clock.mockReturnValue(start + 3 * minute);
    expect((await get(app, "203.0.113.9")).status).toBe(429);
  });

  it("refuses a request whose address cannot be resolved", async () => {
    const { layer } = createTestLayerWithSqlite();
    const app = createArcJwksRoutesRaw(layer);
    expect((await get(app)).status).toBe(429);
  });
});
