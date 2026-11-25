import { mintArcKid, type ArcKidSecrets } from "@shared/crypto/arc-kid";
import { signArcToken } from "@shared/crypto/jwk";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OSN_ARC_JWKS_PATH, peekArcIssuer, verifyOsnArcToken } from "../src/arc";
import { clearJwksCache } from "../src/jwks-cache";

/**
 * `verifyOsnArcToken` admits a token osn-api signed for this app, with a scope
 * the route needs and this app lets osn-api use, under a key osn-api
 * publishes. Every other token is refused, and one whose kid fails its MAC is
 * refused before anything is fetched.
 */

const ISSUER = "https://id.osn.test";
const JWKS_URL = `${ISSUER}${OSN_ARC_JWKS_PATH}`;
/** `INTERNAL_SERVICE_SECRET`'s stand-in. */
const SECRET = "test-internal-secret-of-32-chars!";
/** `OSN_ARC_KID_SECRET`'s stand-in. */
const KID_SECRET = "kid-secret-kid-secret-kid-secret-kid";
const AUDIENCE = "zap-api";
const SCOPE = "account:erase";
const ALLOWED = new Set(["account:erase", "account:export"]);

/** What osn-api or an app can hold, named by the rollout state table. */
const HOLDS = {
  nothing: { kidSecret: undefined, serviceSecret: undefined },
  "the service secret": { kidSecret: undefined, serviceSecret: SECRET },
  "the kid secret": { kidSecret: KID_SECRET, serviceSecret: undefined },
  "both secrets": { kidSecret: KID_SECRET, serviceSecret: SECRET },
} as const satisfies Record<string, ArcKidSecrets>;

let published: Record<string, unknown>[];
let fetches: number;

async function osnKey(
  expiresAt = Math.floor(Date.now() / 1000) + 3600,
  osnHolds: ArcKidSecrets = HOLDS["the service secret"],
) {
  const pair = await generateKeyPair("ES256");
  const kid = await mintArcKid(osnHolds, expiresAt);
  const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "ES256", use: "sig" };
  return { privateKey: pair.privateKey, kid, jwk };
}

async function token(
  key: { privateKey: CryptoKey; kid: string },
  claims: { iss?: string; aud?: string; scope?: string } = {},
) {
  return `ARC ${await signArcToken(key.privateKey, {
    iss: claims.iss ?? "osn-api",
    aud: claims.aud ?? AUDIENCE,
    scope: claims.scope ?? SCOPE,
    kid: key.kid,
  })}`;
}

const verify = (
  authorization: string | undefined,
  appHolds: ArcKidSecrets = HOLDS["the service secret"],
) =>
  verifyOsnArcToken(
    authorization,
    { osnIssuer: ISSUER, ...appHolds },
    { audience: AUDIENCE, scope: SCOPE, allowedScopes: ALLOWED },
  );

beforeEach(() => {
  clearJwksCache();
  published = [];
  fetches = 0;
  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
    input: Parameters<typeof fetch>[0],
  ) => {
    if (String(input) !== JWKS_URL) return new Response("not found", { status: 404 });
    fetches += 1;
    return Response.json({ keys: published });
  }) as typeof fetch;
});

afterEach(() => {
  clearJwksCache();
});

describe("verifyOsnArcToken", () => {
  it("admits a token osn-api signed with a published key, fetching the set once for its kid", async () => {
    const key = await osnKey();
    published.push(key.jwk);
    const header = await token(key);
    expect(await verify(header)).toEqual({ ok: true });
    expect(await verify(header)).toEqual({ ok: true });
    expect(fetches).toBe(1);
  });

  it.each([
    ["no header", async () => undefined],
    ["a bearer token", async () => "Bearer abc"],
    ["a malformed token", async () => "ARC not.a.token"],
  ])("refuses %s as malformed, with no fetch", async (_label, header) => {
    expect(await verify(await header())).toEqual({ ok: false, reason: "malformed" });
    expect(fetches).toBe(0);
  });

  it("refuses a token another service issued, with no fetch", async () => {
    const key = await osnKey();
    published.push(key.jwk);
    expect(await verify(await token(key, { iss: "cire-api" }))).toEqual({
      ok: false,
      reason: "unknown_issuer",
    });
    expect(fetches).toBe(0);
  });

  it("refuses a scope this app does not let osn-api use, with no fetch", async () => {
    const key = await osnKey();
    published.push(key.jwk);
    const result = await verifyOsnArcToken(
      await token(key, { scope: "chat:c2b" }),
      { osnIssuer: ISSUER, ...HOLDS["the service secret"] },
      { audience: AUDIENCE, scope: "chat:c2b", allowedScopes: ALLOWED },
    );
    expect(result).toEqual({ ok: false, reason: "scope_denied" });
    expect(fetches).toBe(0);
  });

  it("refuses a token whose scope lacks the route's", async () => {
    const key = await osnKey();
    published.push(key.jwk);
    expect(await verify(await token(key, { scope: "account:export" }))).toEqual({
      ok: false,
      reason: "scope_denied",
    });
  });

  it("refuses a token for another audience", async () => {
    const key = await osnKey();
    published.push(key.jwk);
    expect(await verify(await token(key, { aud: "pulse-api" }))).toEqual({
      ok: false,
      reason: "audience_mismatch",
    });
  });

  it("refuses a token signed by a key other than the one its kid names", async () => {
    const key = await osnKey();
    const other = await osnKey();
    published.push({ ...other.jwk, kid: key.kid });
    expect(await verify(await token(key))).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a kid osn-api does not publish", async () => {
    const key = await osnKey();
    expect(await verify(await token(key))).toEqual({ ok: false, reason: "unknown_issuer" });
    expect(fetches).toBe(1);
  });

  it("refuses an expired token", async () => {
    const key = await osnKey();
    published.push(key.jwk);
    const past = Math.floor(Date.now() / 1000) - 3600;
    const jwt = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: "ES256", kid: key.kid })
      .setIssuer("osn-api")
      .setAudience(AUDIENCE)
      .setIssuedAt(past - 300)
      .setExpirationTime(past)
      .sign(key.privateKey);
    expect(await verify(`ARC ${jwt}`)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a token signed with an algorithm other than ES256", async () => {
    const key = await osnKey();
    published.push(key.jwk);
    const secret = new TextEncoder().encode("x".repeat(32));
    const jwt = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: "HS256", kid: key.kid })
      .setIssuer("osn-api")
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret);
    expect(await verify(`ARC ${jwt}`)).toEqual({ ok: false, reason: "malformed" });
    expect(fetches).toBe(0);
  });

  describe("the kid MAC", () => {
    it("refuses kids with no MAC, a wrong MAC or a passed expiry before any fetch", async () => {
      const key = await osnKey();
      published.push(key.jwk);
      const [uuid, expiry] = key.kid.split(".");
      const now = Math.floor(Date.now() / 1000);
      for (const kid of [
        `${uuid}.${expiry}`,
        `${uuid}.${expiry}.${"A".repeat(22)}`,
        crypto.randomUUID(),
        await mintArcKid(HOLDS["the service secret"], now - 1),
        await mintArcKid(
          { kidSecret: undefined, serviceSecret: "another-secret-also-of-32-characters" },
          now + 3600,
        ),
      ]) {
        expect(await verify(await token({ privateKey: key.privateKey, kid }))).toEqual({
          ok: false,
          reason: "unknown_issuer",
        });
      }
      expect(fetches).toBe(0);
    });

    it("refuses a published key whose kid's MAC is keyed with the secret itself, before any fetch", async () => {
      const key = await osnKey();
      const [uuid, expiry] = key.kid.split(".") as [string, string];
      const encoder = new TextEncoder();
      const directKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        directKey,
        encoder.encode(`osn-arc-kid:${uuid}.${expiry}`),
      );
      const directMac = btoa(String.fromCharCode(...new Uint8Array(signature)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
        .slice(0, 22);
      const directKid = `${uuid}.${expiry}.${directMac}`;
      published.push({ ...key.jwk, kid: directKid });
      expect(await verify(await token({ privateKey: key.privateKey, kid: directKid }))).toEqual({
        ok: false,
        reason: "unknown_issuer",
      });
      expect(fetches).toBe(0);

      published.push(key.jwk);
      expect(await verify(await token(key))).toEqual({ ok: true });
      expect(fetches).toBe(1);
    });

    it("admits a kid with no MAC when this app's secrets are too short to key one", async () => {
      const short = "s".repeat(31);
      const pair = await generateKeyPair("ES256");
      const holds = { kidSecret: short, serviceSecret: short };
      const kid = await mintArcKid(holds, Math.floor(Date.now() / 1000) + 3600);
      expect(kid.split(".")).toHaveLength(2);
      published.push({ ...(await exportJWK(pair.publicKey)), kid, alg: "ES256", use: "sig" });
      expect(await verify(await token({ privateKey: pair.privateKey, kid }), holds)).toEqual({
        ok: true,
      });
    });

    it("skips the check when this app holds no secret", async () => {
      const pair = await generateKeyPair("ES256");
      const kid = await mintArcKid(HOLDS.nothing, Math.floor(Date.now() / 1000) + 3600);
      published.push({ ...(await exportJWK(pair.publicKey)), kid, alg: "ES256", use: "sig" });
      expect(
        await verify(await token({ privateKey: pair.privateKey, kid }), HOLDS.nothing),
      ).toEqual({ ok: true });
    });
  });
});

/**
 * The rollout of `OSN_ARC_KID_SECRET`, Worker by Worker. On a deployed tier
 * osn-api holds the service secret, and the kid secret once it is set; Zap
 * and Pulse hold the service secret, and the kid secret once set; cire-api
 * holds no service secret, and the kid secret once set. Each cell: does the
 * app admit osn-api's real key, and does it fetch before deciding?
 */
describe("the rollout of the kid secret", () => {
  type Holds = keyof typeof HOLDS;
  const cells: readonly (readonly [Holds, Holds, boolean])[] = [
    // osn-api holds the service secret alone: as before the kid secret.
    ["the service secret", "nothing", true],
    ["the service secret", "the service secret", true],
    ["the service secret", "the kid secret", false],
    ["the service secret", "both secrets", true],
    // osn-api holds both: every app admits its key, whatever it holds.
    ["both secrets", "nothing", true],
    ["both secrets", "the service secret", true],
    ["both secrets", "the kid secret", true],
    ["both secrets", "both secrets", true],
  ];

  it.each(cells)(
    "osn-api holding %s, an app holding %s: admitted %s",
    async (osnHolds, appHolds, admitted) => {
      const key = await osnKey(undefined, HOLDS[osnHolds]);
      published.push(key.jwk);
      const verdict = await verify(await token(key), HOLDS[appHolds]);
      expect(verdict).toEqual(admitted ? { ok: true } : { ok: false, reason: "unknown_issuer" });
      // Refused before any fetch; admitted after exactly one.
      expect(fetches).toBe(admitted ? 1 : 0);
    },
  );

  it.each(["the service secret", "the kid secret", "both secrets"] as const)(
    "an app holding %s refuses made-up kids, published or not, with no fetch",
    async (appHolds) => {
      const key = await osnKey(undefined, HOLDS["both secrets"]);
      const [, expiry] = key.kid.split(".");
      const mac = "A".repeat(22);
      for (const kid of [
        crypto.randomUUID(),
        `${crypto.randomUUID()}.${expiry}`,
        `${crypto.randomUUID()}.${expiry}.${mac}`,
        `${crypto.randomUUID()}.${expiry}.${mac}.${mac}`,
      ]) {
        published.push({ ...key.jwk, kid });
        expect(
          await verify(await token({ privateKey: key.privateKey, kid }), HOLDS[appHolds]),
        ).toEqual({ ok: false, reason: "unknown_issuer" });
      }
      expect(fetches).toBe(0);
    },
  );

  it("an app holding nothing fetches for a made-up kid, and then refuses it", async () => {
    const key = await osnKey(undefined, HOLDS["both secrets"]);
    const kid = `${crypto.randomUUID()}.${key.kid.split(".")[1]}`;
    expect(await verify(await token({ privateKey: key.privateKey, kid }), HOLDS.nothing)).toEqual({
      ok: false,
      reason: "unknown_issuer",
    });
    expect(fetches).toBe(1);
  });
});

describe("peekArcIssuer", () => {
  it("reads the unverified issuer of an ARC token, and null for anything else", async () => {
    const key = await osnKey();
    expect(peekArcIssuer(await token(key))).toBe("osn-api");
    expect(peekArcIssuer(await token(key, { iss: "cire-api" }))).toBe("cire-api");
    expect(peekArcIssuer(undefined)).toBeNull();
    expect(peekArcIssuer("Bearer x")).toBeNull();
    expect(peekArcIssuer("ARC garbage")).toBeNull();
  });
});
