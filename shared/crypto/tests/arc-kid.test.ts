import { afterEach, describe, expect, it, vi } from "vitest";

import { checkArcKid, mintArcKid } from "../src/arc-kid";

const SECRET = "test-internal-secret-of-32-chars!";

afterEach(() => vi.restoreAllMocks());
const NOW = 1_900_000_000;

describe("ARC key ids that carry their expiry and a MAC", () => {
  it("a minted kid passes the check under the same secret until its expiry", async () => {
    const kid = await mintArcKid(SECRET, NOW + 60);
    expect(kid.split(".")).toHaveLength(3);
    expect(await checkArcKid(kid, SECRET, NOW)).toBe(true);
    expect(await checkArcKid(kid, SECRET, NOW + 59)).toBe(true);
  });

  it("refuses a kid whose expiry has passed", async () => {
    const kid = await mintArcKid(SECRET, NOW + 60);
    expect(await checkArcKid(kid, SECRET, NOW + 60)).toBe(false);
  });

  it("refuses a kid minted under another secret", async () => {
    const kid = await mintArcKid("another-secret", NOW + 60);
    expect(await checkArcKid(kid, SECRET, NOW)).toBe(false);
  });

  it("refuses a kid whose expiry was raised after minting", async () => {
    const kid = await mintArcKid(SECRET, NOW + 60);
    const [uuid, , mac] = kid.split(".");
    expect(await checkArcKid(`${uuid}.${NOW + 6000}.${mac}`, SECRET, NOW)).toBe(false);
  });

  it.each([
    ["no MAC", (kid: string) => kid.split(".").slice(0, 2).join(".")],
    ["a random kid", () => crypto.randomUUID()],
    ["an empty kid", () => ""],
    ["a non-numeric expiry", (kid: string) => kid.replace(/\.\d+\./, ".soon.")],
    ["four parts", (kid: string) => `${kid}.x`],
  ])("refuses %s", async (_label, alter) => {
    const kid = await mintArcKid(SECRET, NOW + 60);
    expect(await checkArcKid(alter(kid), SECRET, NOW)).toBe(false);
  });

  it("mints a kid with no MAC when there is no secret, and the check then passes anything unexpired", async () => {
    const kid = await mintArcKid(undefined, NOW + 60);
    expect(kid.split(".")).toHaveLength(2);
    expect(await checkArcKid(kid, undefined, NOW)).toBe(true);
    expect(await checkArcKid("anything", undefined, NOW)).toBe(true);
  });

  it("a checker holding the secret refuses a kid minted without one", async () => {
    const kid = await mintArcKid(undefined, NOW + 60);
    expect(await checkArcKid(kid, SECRET, NOW)).toBe(false);
  });

  it("never keys the MAC with a secret shorter than 32 characters, on either side", async () => {
    const short = "s".repeat(31);
    const kid = await mintArcKid(short, NOW + 60);
    expect(kid.split(".")).toHaveLength(2);
    expect(await checkArcKid(kid, short, NOW)).toBe(true);
    expect(await checkArcKid("anything", short, NOW)).toBe(true);
    expect((await mintArcKid("s".repeat(32), NOW + 60)).split(".")).toHaveLength(3);
  });

  describe("the MAC key", () => {
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
    // The derivation is a contract between osn-api and every app that checks
    // its kids, so these values are written out here rather than imported.
    const derivedKey = async (secret: string) =>
      crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: encoder.encode("osn-arc-kid-salt"),
          info: encoder.encode("osn-arc-kid-mac-v1"),
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

    it("is derived from the secret by HKDF-SHA-256, never the secret itself", async () => {
      const kid = await mintArcKid(SECRET, NOW + 60);
      const [uuid, expiry, mac] = kid.split(".") as [string, string, string];
      expect(mac).toBe(await macUnder(await derivedKey(SECRET), uuid, expiry));
      expect(mac).not.toBe(await macUnder(await directKey(SECRET), uuid, expiry));
    });

    it("refuses a kid whose MAC is keyed with the secret itself", async () => {
      const uuid = crypto.randomUUID();
      const expiry = String(NOW + 60);
      const direct = await macUnder(await directKey(SECRET), uuid, expiry);
      expect(await checkArcKid(`${uuid}.${expiry}.${direct}`, SECRET, NOW)).toBe(false);
      const derived = await macUnder(await derivedKey(SECRET), uuid, expiry);
      expect(await checkArcKid(`${uuid}.${expiry}.${derived}`, SECRET, NOW)).toBe(true);
    });
  });

  it("drops a MAC key whose import failed, so the next kid imports it again", async () => {
    const secret = "a-secret-whose-first-import-fails";
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    importKey.mockRejectedValueOnce(new Error("import failed"));
    await expect(mintArcKid(secret, NOW + 60)).rejects.toThrow("import failed");
    const kid = await mintArcKid(secret, NOW + 60);
    expect(await checkArcKid(kid, secret, NOW)).toBe(true);
  });
});
