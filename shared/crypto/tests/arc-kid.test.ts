import { afterEach, describe, expect, it, vi } from "vitest";

import { checkArcKid, mintArcKid, type ArcKidSecrets } from "../src/arc-kid";

/** `INTERNAL_SERVICE_SECRET`'s stand-in: the derivation every Worker holds today. */
const SERVICE = "test-internal-secret-of-32-chars!";
/** `OSN_ARC_KID_SECRET`'s stand-in: the secret held for the key-id MAC alone. */
const KID = "kid-secret-kid-secret-kid-secret-kid";

/** What osn-api and each app can hold, named by the rollout state table. */
const NONE: ArcKidSecrets = { kidSecret: undefined, serviceSecret: undefined };
const SERVICE_ONLY: ArcKidSecrets = { kidSecret: undefined, serviceSecret: SERVICE };
const KID_ONLY: ArcKidSecrets = { kidSecret: KID, serviceSecret: undefined };
const BOTH: ArcKidSecrets = { kidSecret: KID, serviceSecret: SERVICE };

afterEach(() => vi.restoreAllMocks());
const NOW = 1_900_000_000;

/** Whether `kid` passes the check, whatever the app then looks it up by. */
const passes = async (kid: string, secrets: ArcKidSecrets, nowSec: number): Promise<boolean> =>
  (await checkArcKid(kid, secrets, nowSec)) !== null;

describe("ARC key ids that carry their expiry and a MAC", () => {
  it.each([
    ["the service secret", SERVICE_ONLY, 3],
    ["the kid secret", KID_ONLY, 3],
    ["both secrets", BOTH, 4],
  ] as const)(
    "a kid minted under %s passes the same holder's check until its expiry",
    async (_label, secrets, parts) => {
      const kid = await mintArcKid(secrets, NOW + 60);
      expect(kid.split(".")).toHaveLength(parts);
      expect(await passes(kid, secrets, NOW)).toBe(true);
      expect(await passes(kid, secrets, NOW + 59)).toBe(true);
    },
  );

  it.each([
    ["the service secret", SERVICE_ONLY],
    ["the kid secret", KID_ONLY],
    ["both secrets", BOTH],
  ] as const)("refuses a kid whose expiry has passed, under %s", async (_label, secrets) => {
    const kid = await mintArcKid(secrets, NOW + 60);
    expect(await passes(kid, secrets, NOW + 60)).toBe(false);
  });

  it("refuses a kid minted under another value of the same secret", async () => {
    const other = "another-secret-also-of-32-characters";
    expect(
      await passes(
        await mintArcKid({ kidSecret: undefined, serviceSecret: other }, NOW + 60),
        SERVICE_ONLY,
        NOW,
      ),
    ).toBe(false);
    expect(
      await passes(
        await mintArcKid({ kidSecret: other, serviceSecret: undefined }, NOW + 60),
        KID_ONLY,
        NOW,
      ),
    ).toBe(false);
  });

  it.each([
    ["the service secret", SERVICE_ONLY],
    ["the kid secret", KID_ONLY],
    ["both secrets", BOTH],
  ] as const)(
    "refuses a kid whose expiry was raised after minting, under %s",
    async (_label, secrets) => {
      const [uuid, , ...macs] = (await mintArcKid(secrets, NOW + 60)).split(".");
      expect(await passes([uuid, NOW + 6000, ...macs].join("."), secrets, NOW)).toBe(false);
    },
  );

  it.each([
    ["no MAC", (kid: string) => kid.split(".").slice(0, 2).join(".")],
    ["a random kid", () => crypto.randomUUID()],
    ["an empty kid", () => ""],
    ["a non-numeric expiry", (kid: string) => kid.replace(/\.\d+\./, ".soon.")],
    ["a MAC part of the wrong length", (kid: string) => `${kid}.x`],
    [
      "a MAC part one character short beside a valid one",
      (kid: string) => `${kid}.${"A".repeat(21)}`,
    ],
    [
      "five parts built from valid ones",
      (kid: string) => {
        const mac = kid.split(".")[2];
        return `${kid}.${mac}.${mac}`;
      },
    ],
  ])("refuses %s", async (_label, alter) => {
    for (const secrets of [SERVICE_ONLY, KID_ONLY, BOTH]) {
      const kid = await mintArcKid(secrets, NOW + 60);
      expect(await passes(alter(kid), secrets, NOW)).toBe(false);
    }
  });

  it("mints a kid with no MAC when there is no secret, and the check then passes anything", async () => {
    const kid = await mintArcKid(NONE, NOW + 60);
    expect(kid.split(".")).toHaveLength(2);
    expect(await passes(kid, NONE, NOW)).toBe(true);
    expect(await passes("anything", NONE, NOW)).toBe(true);
  });

  it("a checker holding either secret refuses a kid minted without one", async () => {
    const kid = await mintArcKid(NONE, NOW + 60);
    for (const secrets of [SERVICE_ONLY, KID_ONLY, BOTH]) {
      expect(await passes(kid, secrets, NOW)).toBe(false);
    }
  });

  it("never keys the MAC with a service secret shorter than 32 characters, on either side", async () => {
    const short = { kidSecret: undefined, serviceSecret: "s".repeat(31) };
    const kid = await mintArcKid(short, NOW + 60);
    expect(kid.split(".")).toHaveLength(2);
    expect(await passes(kid, short, NOW)).toBe(true);
    expect(await passes("anything", short, NOW)).toBe(true);
    const long = { kidSecret: undefined, serviceSecret: "s".repeat(32) };
    expect((await mintArcKid(long, NOW + 60)).split(".")).toHaveLength(3);
  });

  it("ignores a kid secret shorter than 32 characters, on either side, leaving the service secret", async () => {
    const short = "k".repeat(31);
    const minted = await mintArcKid({ kidSecret: short, serviceSecret: SERVICE }, NOW + 60);
    expect(minted.split(".")).toHaveLength(3);
    expect(await passes(minted, SERVICE_ONLY, NOW)).toBe(true);
    expect(await passes(minted, KID_ONLY, NOW)).toBe(false);

    expect(await passes("anything", { kidSecret: short, serviceSecret: undefined }, NOW)).toBe(
      true,
    );

    const shortAndService = { kidSecret: short, serviceSecret: SERVICE };
    expect(await passes(minted, shortAndService, NOW)).toBe(true);
    expect(await passes(await mintArcKid(NONE, NOW + 60), shortAndService, NOW)).toBe(false);
    const long = { kidSecret: "k".repeat(32), serviceSecret: SERVICE };
    expect((await mintArcKid(long, NOW + 60)).split(".")).toHaveLength(4);
  });
});

describe("the rollout: osn-api and each app holding the kid secret, the service secret or both", () => {
  it("osn-api holding both mints a kid that an app holding either secret, or both, accepts", async () => {
    const kid = await mintArcKid(BOTH, NOW + 60);
    expect(kid.split(".")).toHaveLength(4);
    expect(await passes(kid, SERVICE_ONLY, NOW)).toBe(true);
    expect(await passes(kid, KID_ONLY, NOW)).toBe(true);
    expect(await passes(kid, BOTH, NOW)).toBe(true);
  });

  it("an app holding both accepts a kid osn-api minted under the service secret alone", async () => {
    expect(await passes(await mintArcKid(SERVICE_ONLY, NOW + 60), BOTH, NOW)).toBe(true);
  });

  it("an app holding the kid secret alone refuses a kid minted under the service secret alone", async () => {
    expect(await passes(await mintArcKid(SERVICE_ONLY, NOW + 60), KID_ONLY, NOW)).toBe(false);
  });

  it("an app holding the service secret alone refuses a kid minted under the kid secret alone", async () => {
    const kid = await mintArcKid(KID_ONLY, NOW + 60);
    expect(await passes(kid, SERVICE_ONLY, NOW)).toBe(false);
    expect(await passes(kid, BOTH, NOW)).toBe(true);
  });

  it("one value set as both secrets still gives two MACs, neither passing for the other", async () => {
    const value = "one-value-set-as-both-secrets-32-chars";
    const asService = await mintArcKid({ kidSecret: undefined, serviceSecret: value }, NOW + 60);
    expect(await passes(asService, { kidSecret: value, serviceSecret: undefined }, NOW)).toBe(
      false,
    );
    const asKid = await mintArcKid({ kidSecret: value, serviceSecret: undefined }, NOW + 60);
    expect(await passes(asKid, { kidSecret: undefined, serviceSecret: value }, NOW)).toBe(false);
    const [, , first, second] = (
      await mintArcKid({ kidSecret: value, serviceSecret: value }, NOW + 60)
    ).split(".");
    expect(first).not.toBe(second);
  });
});

/**
 * What a key id that passes may be looked up by. A 4-part kid carries a MAC
 * the app may hold no key for, and anyone can replace that part; the lookup
 * must not depend on it, or every altered copy would be a new fetch.
 */
describe("what a kid that passes is looked up by", () => {
  const swap = (kid: string, index: 2 | 3) => {
    const parts = kid.split(".");
    parts[index] = "Z".repeat(22);
    return parts.join(".");
  };

  it.each([
    ["the service secret", SERVICE_ONLY, 2],
    ["the kid secret", KID_ONLY, 3],
    ["both secrets", BOTH, 2],
    ["both secrets", BOTH, 3],
  ] as const)(
    "an app holding %s looks a copy with part %i replaced up by the uuid and expiry, as the real kid",
    async (_label, secrets, index) => {
      const kid = await mintArcKid(BOTH, NOW + 60);
      const [uuid, expiry] = kid.split(".");
      const real = await checkArcKid(kid, secrets, NOW);
      const copy = await checkArcKid(swap(kid, index), secrets, NOW);
      expect(real?.id).toBe(`${uuid}.${expiry}`);
      expect(copy?.id).toBe(`${uuid}.${expiry}`);
    },
  );

  it("a checked lookup names every published kid of that uuid and expiry, and no other", async () => {
    const kid = await mintArcKid(BOTH, NOW + 60);
    const [uuid, expiry, v2, v1] = kid.split(".") as [string, string, string, string];
    const lookup = await checkArcKid(kid, KID_ONLY, NOW);
    expect(lookup).not.toBeNull();
    for (const published of [kid, `${uuid}.${expiry}.${v1}`, `${uuid}.${expiry}.${v2}`]) {
      expect({ published, names: lookup?.names(published) }).toEqual({ published, names: true });
    }
    for (const published of [
      `${uuid}.${expiry}`,
      `${uuid}.${Number(expiry) + 1}.${v2}`,
      `${uuid}.${expiry}0.${v2}`,
      `${uuid}.${expiry.slice(0, -1)}.${v2}`,
      `${crypto.randomUUID()}.${expiry}.${v2}`,
      `${uuid}.${expiry}.${v2}.${v1}.${v1}`,
      `${uuid}${expiry}.${v2}`,
      `x${uuid}.${expiry}.${v2}`,
    ]) {
      expect({ published, names: lookup?.names(published) }).toEqual({ published, names: false });
    }
  });

  it("an app holding no secret checks nothing and looks the kid up exactly as sent", async () => {
    const kid = await mintArcKid(BOTH, NOW + 60);
    const lookup = await checkArcKid(kid, NONE, NOW);
    expect(lookup?.id).toBe(kid);
    expect(lookup?.names(kid)).toBe(true);
    expect(lookup?.names(swap(kid, 3))).toBe(false);
    expect((await checkArcKid("anything", NONE, NOW))?.id).toBe("anything");
  });
});

describe("the MAC keys", () => {
  const encoder = new TextEncoder();
  const base64url = (bytes: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const macUnder = async (key: CryptoKey, uuid: string, expiry: string) =>
    base64url(
      await crypto.subtle.sign("HMAC", key, encoder.encode(`osn-arc-kid:${uuid}.${expiry}`)),
    ).slice(0, 22);
  // The derivations are a contract between osn-api and every app that checks
  // its kids, so these values are written out here rather than imported.
  const derivedKey = async (secret: string, info: string) =>
    crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode("osn-arc-kid-salt"),
        info: encoder.encode(info),
      },
      await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]),
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign"],
    );
  const directKey = (secret: string) =>
    crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

  it("the service secret's is derived by HKDF-SHA-256 under info osn-arc-kid-mac-v1, never the secret itself", async () => {
    const kid = await mintArcKid(SERVICE_ONLY, NOW + 60);
    const [uuid, expiry, mac] = kid.split(".") as [string, string, string];
    expect(mac).toBe(await macUnder(await derivedKey(SERVICE, "osn-arc-kid-mac-v1"), uuid, expiry));
    expect(mac).not.toBe(await macUnder(await directKey(SERVICE), uuid, expiry));
  });

  it("the kid secret's is derived by HKDF-SHA-256 under info osn-arc-kid-mac-v2, and comes first", async () => {
    const kid = await mintArcKid(BOTH, NOW + 60);
    const [uuid, expiry, first, second] = kid.split(".") as [string, string, string, string];
    expect(first).toBe(await macUnder(await derivedKey(KID, "osn-arc-kid-mac-v2"), uuid, expiry));
    expect(second).toBe(
      await macUnder(await derivedKey(SERVICE, "osn-arc-kid-mac-v1"), uuid, expiry),
    );
  });

  it("refuses a kid whose MAC is keyed with either secret itself", async () => {
    const uuid = crypto.randomUUID();
    const expiry = String(NOW + 60);
    for (const [secret, secrets, info] of [
      [SERVICE, SERVICE_ONLY, "osn-arc-kid-mac-v1"],
      [KID, KID_ONLY, "osn-arc-kid-mac-v2"],
    ] as const) {
      const direct = await macUnder(await directKey(secret), uuid, expiry);
      expect(await passes(`${uuid}.${expiry}.${direct}`, secrets, NOW)).toBe(false);
      const derived = await macUnder(await derivedKey(secret, info), uuid, expiry);
      expect(await passes(`${uuid}.${expiry}.${derived}`, secrets, NOW)).toBe(true);
    }
  });

  it("drops a MAC key whose import failed, so the next kid imports it again", async () => {
    const secret = "a-secret-whose-first-import-fails";
    const secrets = { kidSecret: undefined, serviceSecret: secret };
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    importKey.mockRejectedValueOnce(new Error("import failed"));
    await expect(mintArcKid(secrets, NOW + 60)).rejects.toThrow("import failed");
    const kid = await mintArcKid(secrets, NOW + 60);
    expect(await passes(kid, secrets, NOW)).toBe(true);
  });
});
