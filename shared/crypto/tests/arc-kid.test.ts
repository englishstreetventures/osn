import { describe, expect, it } from "vitest";

import { checkArcKid, mintArcKid } from "../src/arc-kid";

const SECRET = "test-internal-secret";
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
});
