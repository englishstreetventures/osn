import { mintArcKid, readArcKeyAsk, type ArcKidSecrets } from "@shared/crypto/arc-kid";
import { signArcToken } from "@shared/crypto/jwk";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OSN_ARC_JWKS_PATH, peekArcIssuer, verifyOsnArcToken } from "../src/arc";
import { clearJwksCache, resolvePublicKeyForKid } from "../src/jwks-cache";

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
/** When set, osn-api's key list answers 429, as its budget does to a caller over it. */
let refuseFetches: boolean;
/** When set, osn-api answers as its code before key-by-id did: the whole list, whatever is asked. */
let wholeList: boolean;
/** The `kid` each fetch asked for, as osn-api received it; null for a fetch that asked for none. */
let asks: (string | null)[];
/** Settles every fetch held while it is set. */
let hold: Promise<void> | null;

/** The longest a kid's expiry may sit ahead, as osn-api reads an ask. */
const MAX_KEY_LIFE_SECONDS = 4 * 3_600 + 300;

/**
 * osn-api's answer to an ask, as its route gives it: the keys published under
 * the ask's `<uuid>.<expiry>`, and none for an ask osn-api cannot read. It
 * checks no MAC here; osn-api's own tests do.
 */
function answer(ask: string | null): Record<string, unknown>[] {
  if (ask === null || wholeList) return published;
  const id = readArcKeyAsk(ask, Math.floor(Date.now() / 1000), MAX_KEY_LIFE_SECONDS);
  if (id === null) return [];
  return published.filter(
    (key) => typeof key.kid === "string" && (key.kid === id || key.kid.startsWith(`${id}.`)),
  );
}

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
  refuseFetches = false;
  wholeList = false;
  asks = [];
  hold = null;
  (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
    input: Parameters<typeof fetch>[0],
  ) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` !== JWKS_URL)
      return new Response("not found", { status: 404 });
    fetches += 1;
    asks.push(url.searchParams.get("kid"));
    if (hold) await hold;
    if (refuseFetches) return new Response("too many requests", { status: 429 });
    return Response.json({ keys: answer(url.searchParams.get("kid")) });
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

  /**
   * A published 4-part kid carries a MAC the app may hold no key for, and
   * anyone can replace that part. Each copy passes the check; none may cost a
   * fetch the real kid would not, or the copies would spend the key-list budget.
   */
  const copies = async (kid: string, index: 2 | 3, count: number) => {
    const signer = await generateKeyPair("ES256");
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const parts = kid.split(".");
      parts[index] = crypto.randomUUID().replace(/-/g, "").slice(0, 22);
      out.push(await token({ privateKey: signer.privateKey, kid: parts.join(".") }));
    }
    return out;
  };

  it.each([
    ["the service secret", 2],
    ["the kid secret", 3],
    ["both secrets", 2],
    ["both secrets", 3],
  ] as const)(
    "an app holding %s refuses ten copies of a published kid with part %i replaced, after one fetch in all",
    async (appHolds, index) => {
      const key = await osnKey(undefined, HOLDS["both secrets"]);
      published.push(key.jwk);
      for (const copy of await copies(key.kid, index, 10)) {
        expect(await verify(copy, HOLDS[appHolds])).toEqual({
          ok: false,
          reason: "bad_signature",
        });
      }
      expect(fetches).toBe(1);
      expect(await verify(await token(key), HOLDS[appHolds])).toEqual({ ok: true });
      expect(fetches).toBe(1);
    },
  );

  it.each([
    ["the service secret", 2, "not published"],
    ["the kid secret", 3, "not published"],
    ["both secrets", 2, "not published"],
    ["both secrets", 3, "not published"],
    ["the service secret", 2, "a refused fetch"],
    ["the kid secret", 3, "a refused fetch"],
    ["both secrets", 3, "a refused fetch"],
  ] as const)(
    "an app holding %s: copies with part %i replaced of a kid it finds %s cost one fetch in all, and the real kid waits on that refusal",
    async (appHolds, index, why) => {
      const key = await osnKey(undefined, HOLDS["both secrets"]);
      if (why === "a refused fetch") {
        published.push(key.jwk);
        refuseFetches = true;
      }
      for (const copy of await copies(key.kid, index, 10)) {
        expect(await verify(copy, HOLDS[appHolds])).toEqual({
          ok: false,
          reason: "unknown_issuer",
        });
      }
      expect(await verify(await token(key), HOLDS[appHolds])).toEqual({
        ok: false,
        reason: "unknown_issuer",
      });
      expect(fetches).toBe(1);
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

/**
 * The app asks osn-api for the one key a token names
 * (`<issuer>/.well-known/arc-jwks.json?kid=<ask>`), never the whole list, and
 * the ask holds no part of the kid the app could not verify unless it is
 * shaped as osn-api writes one: a sender who replaces that part cannot make
 * osn-api refuse the ask, and so cannot mark the real key unknown.
 */
describe("asking osn-api for one key", () => {
  type Holds = keyof typeof HOLDS;

  it.each(["nothing", "the service secret", "the kid secret", "both secrets"] as const)(
    "an app holding %s asks by kid, and admits the key osn-api answers",
    async (appHolds) => {
      const key = await osnKey(undefined, HOLDS["both secrets"]);
      published.push(key.jwk, (await osnKey(undefined, HOLDS["both secrets"])).jwk);
      expect(await verify(await token(key), HOLDS[appHolds])).toEqual({ ok: true });
      expect(asks).toEqual([key.kid]);
    },
  );

  it("an app holding nothing sends the kid as it came, whatever it holds", async () => {
    wholeList = true;
    const pair = await generateKeyPair("ES256");
    const kid = "a&b#c+d/e=f?g h%";
    published.push({ ...(await exportJWK(pair.publicKey)), kid, alg: "ES256", use: "sig" });
    expect(await verify(await token({ privateKey: pair.privateKey, kid }), HOLDS.nothing)).toEqual({
      ok: true,
    });
    expect(asks).toEqual([kid]);
  });

  it("an app holding nothing refuses a kid no URL can carry, before any fetch", async () => {
    const pair = await generateKeyPair("ES256");
    const kid = `${crypto.randomUUID()}.\ud800`;
    expect(await verify(await token({ privateKey: pair.privateKey, kid }), HOLDS.nothing)).toEqual({
      ok: false,
      reason: "unknown_issuer",
    });
    expect(fetches).toBe(0);
  });

  /** A copy of `kid` with part `index` replaced by `junk`, signed by a key that is not osn-api's. */
  const copyOf = async (kid: string, index: 2 | 3, junk: string) => {
    const signer = await generateKeyPair("ES256");
    const parts = kid.split(".");
    parts[index] = junk;
    return token({ privateKey: signer.privateKey, kid: parts.join(".") });
  };
  const JUNK = [
    "~".repeat(22),
    "!".repeat(22),
    `${"A".repeat(21)}\ud800`,
    "0123456789abcdef012345",
  ];

  it.each([
    ["the service secret", 2],
    ["the kid secret", 3],
    ["both secrets", 2],
    ["both secrets", 3],
  ] as const)(
    "an app holding %s still admits the real kid after copies with part %i replaced, asked first, one fetch in all",
    async (appHolds: Holds, index) => {
      const key = await osnKey(undefined, HOLDS["both secrets"]);
      published.push(key.jwk);
      for (const junk of JUNK) {
        expect(await verify(await copyOf(key.kid, index, junk), HOLDS[appHolds])).toEqual({
          ok: false,
          reason: "bad_signature",
        });
      }
      expect(await verify(await token(key), HOLDS[appHolds])).toEqual({ ok: true });
      expect(fetches).toBe(1);
      for (const ask of asks) {
        for (const junk of JUNK.slice(0, 3)) expect(ask).not.toContain(junk);
      }
    },
  );

  it.each([
    ["the service secret", 2],
    ["the kid secret", 3],
    ["both secrets", 3],
  ] as const)(
    "an app holding %s: copies with part %i replaced, in flight with the real kid, share its one fetch",
    async (appHolds: Holds, index) => {
      const key = await osnKey(undefined, HOLDS["both secrets"]);
      published.push(key.jwk);
      let release!: () => void;
      hold = new Promise((resolve) => (release = resolve));
      const copies = await Promise.all(JUNK.map((junk) => copyOf(key.kid, index, junk)));
      const verdicts = Promise.all([
        ...copies.map((copy) => verify(copy, HOLDS[appHolds])),
        verify(await token(key), HOLDS[appHolds]),
      ]);
      await vi.waitFor(() => expect(fetches).toBe(1));
      release();
      const settled = await verdicts;
      expect(settled.at(-1)).toEqual({ ok: true });
      expect(fetches).toBe(1);
    },
  );

  it("an app keeps osn-api's key four minutes, then asks again", async () => {
    const key = await osnKey(undefined, HOLDS["both secrets"]);
    published.push(key.jwk);
    const header = await token(key);
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      expect(await verify(header, HOLDS["the service secret"])).toEqual({ ok: true });
      clock.mockReturnValue(start + 4 * 60_000 - 1_000);
      expect(await verify(header, HOLDS["the service secret"])).toEqual({ ok: true });
      expect(fetches).toBe(1);
      clock.mockReturnValue(start + 4 * 60_000 + 1_000);
      expect(await verify(header, HOLDS["the service secret"])).toEqual({ ok: true });
      expect(fetches).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("counts the four minutes from when the fetch started, however long it took", async () => {
    const key = await osnKey(undefined, HOLDS["both secrets"]);
    published.push(key.jwk);
    const header = await token(key);
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    try {
      const first = verify(header, HOLDS["the service secret"]);
      await vi.waitFor(() => expect(fetches).toBe(1));
      // The answer takes ten seconds to come back.
      clock.mockReturnValue(start + 10_000);
      release();
      expect(await first).toEqual({ ok: true });
      hold = null;
      clock.mockReturnValue(start + 4 * 60_000 - 1);
      expect(await verify(header, HOLDS["the service secret"])).toEqual({ ok: true });
      expect(fetches).toBe(1);
      clock.mockReturnValue(start + 4 * 60_000);
      expect(await verify(header, HOLDS["the service secret"])).toEqual({ ok: true });
      expect(fetches).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("admits from the whole list, as an osn-api on the code before key-by-id answers", async () => {
    wholeList = true;
    const key = await osnKey(undefined, HOLDS["both secrets"]);
    published.push((await osnKey(undefined, HOLDS["both secrets"])).jwk, key.jwk);
    for (const appHolds of [
      "nothing",
      "the service secret",
      "the kid secret",
      "both secrets",
    ] as const) {
      clearJwksCache();
      expect(await verify(await token(key), HOLDS[appHolds])).toEqual({ ok: true });
    }
    expect(asks).toEqual([key.kid, key.kid, key.kid, key.kid]);
  });

  it("shares no fetch with an access-token lookup, whatever kid a sender names", async () => {
    const ACCESS_URL = `${ISSUER}/.well-known/jwks.json`;
    const pair = await generateKeyPair("ES256");
    const accessKey = { ...(await exportJWK(pair.publicKey)), kid: "access", alg: "ES256" };
    const arcFetch = globalThis.fetch;
    let accessFetches = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
      input: Parameters<typeof fetch>[0],
    ) => {
      if (String(input) !== ACCESS_URL) return arcFetch(input);
      accessFetches += 1;
      await gate;
      return Response.json({ keys: [accessKey] });
    }) as typeof fetch;
    hold = gate;
    const access = resolvePublicKeyForKid("access", ACCESS_URL);
    const arc = verify(
      await token({ privateKey: pair.privateKey, kid: ACCESS_URL }),
      HOLDS.nothing,
    );
    await vi.waitFor(() => expect(accessFetches + fetches).toBe(2));
    release();
    expect(await access).not.toBeNull();
    expect(await arc).toEqual({ ok: false, reason: "unknown_issuer" });
  });
});
