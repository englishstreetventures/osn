import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createServerMac } from "../../../src/services/auth/server-mac";

const SECRET = "s".repeat(32);

/**
 * A probe key stands in for an account id in a store key. It is derived from
 * the identifier a caller typed — often an email address, and often one that
 * names nobody — so it must not be something anyone with a list of addresses
 * can recompute.
 */
describe("createServerMac().probeKey", () => {
  it("is the same for the same identifier under the same secret, and account-id shaped", () => {
    const mac = createServerMac(SECRET);
    const key = mac.probeKey("someone@example.com");
    expect(key).toBe(createServerMac(SECRET).probeKey("someone@example.com"));
    expect(key).toMatch(/^prb_[0-9a-f]{12}$/);
    expect(key).toHaveLength("acc_0123456789ab".length);
    expect(mac.probeKey("someone-else@example.com")).not.toBe(key);
  });

  it("depends on the secret, so a list of addresses does not reverse it", () => {
    const identifier = "someone@example.com";
    const key = createServerMac(SECRET).probeKey(identifier);
    expect(createServerMac("t".repeat(32)).probeKey(identifier)).not.toBe(key);
    // The unkeyed digest a list of addresses could be run through.
    const unkeyed = createHash("sha256").update(`recovery-probe:${identifier}`).digest("hex");
    expect(key).not.toBe(`prb_${unkeyed.slice(0, 12)}`);
  });

  it("with no secret, keys under one made for this process, never a fixed one", () => {
    const a = createServerMac(undefined).probeKey("someone@example.com");
    const b = createServerMac(undefined).probeKey("someone@example.com");
    expect(a).toMatch(/^prb_[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

/**
 * The discoverable passkey challenge carries its own proof: a random nonce,
 * its expiry and a MAC over both, so `begin` stores nothing. Anything the
 * server did not mint, or minted and someone changed, must not open.
 */
describe("createServerMac() discoverable challenges", () => {
  const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
  const decode = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));

  it("opens what it minted, with its nonce and expiry", () => {
    const mac = createServerMac(SECRET);
    const expiresAt = Date.now() + 60_000;
    const challenge = encode(mac.mintChallenge(expiresAt));
    const opened = mac.openChallenge(challenge);
    expect(opened).toEqual({ ok: true, nonce: expect.stringMatching(/^[0-9a-f]{32}$/), expiresAt });
    // A fresh nonce every time.
    const again = mac.openChallenge(encode(mac.mintChallenge(expiresAt)));
    expect(again.ok && opened.ok && again.nonce !== opened.nonce).toBe(true);
  });

  it.each([
    ["the nonce", 0],
    ["the expiry", 20],
    ["the MAC", 40],
  ])("refuses one changed byte in %s", (_part, index) => {
    const mac = createServerMac(SECRET);
    const bytes = mac.mintChallenge(Date.now() + 60_000);
    bytes[index] = bytes[index]! ^ 0x01;
    expect(mac.openChallenge(encode(bytes))).toEqual({ ok: false, reason: "forged" });
  });

  it("refuses a later expiry written over a real one", () => {
    const mac = createServerMac(SECRET);
    const bytes = mac.mintChallenge(Date.now() - 1_000);
    new DataView(bytes.buffer, bytes.byteOffset).setBigUint64(16, BigInt(Date.now() + 600_000));
    expect(mac.openChallenge(encode(bytes))).toEqual({ ok: false, reason: "forged" });
  });

  it("refuses a challenge minted under another secret", () => {
    const challenge = encode(createServerMac("t".repeat(32)).mintChallenge(Date.now() + 60_000));
    expect(createServerMac(SECRET).openChallenge(challenge)).toEqual({
      ok: false,
      reason: "forged",
    });
  });

  it.each([
    ["empty", ""],
    ["too short", encode(new Uint8Array(55))],
    ["too long", encode(new Uint8Array(57))],
    ["not base64url", "!".repeat(75)],
  ])("refuses a malformed challenge (%s)", (_what, challenge) => {
    expect(createServerMac(SECRET).openChallenge(challenge)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("answers an expired challenge as expired, not forged", () => {
    const mac = createServerMac(SECRET);
    const challenge = encode(mac.mintChallenge(Date.now() - 1));
    expect(mac.openChallenge(challenge)).toEqual({ ok: false, reason: "expired" });
    // Round-tripped through the bytes a browser would send back.
    expect(encode(decode(challenge))).toBe(challenge);
  });
});
