import { arcOutboundKeys } from "@osn/db/schema";
import { afterEach, describe, expect, it } from "vitest";

import { _resetOutboundKeyForTests } from "../../src/lib/outbound-arc";
import { createArcJwksRoutes } from "../../src/routes/arc-jwks";
import { createTestLayerWithSqlite } from "../helpers/db";

/**
 * `GET /.well-known/arc-jwks.json` serves exactly the outbound keys osn-api
 * may still sign with, read fresh, as a JWK Set apps can import.
 */

afterEach(() => _resetOutboundKeyForTests());

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
