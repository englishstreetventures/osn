import { describe, it, expect } from "vitest";

import { base64urlEncode, verifyPkceChallenge } from "../../src/lib/crypto";

describe("base64urlEncode", () => {
  it("encodes an empty buffer to an empty string", () => {
    expect(base64urlEncode(new ArrayBuffer(0))).toBe("");
  });

  it("replaces + with -", () => {
    // 0xfb produces '+' in standard base64
    const buf = new Uint8Array([0xfb]).buffer;
    const result = base64urlEncode(buf);
    expect(result).not.toContain("+");
  });

  it("replaces / with _", () => {
    // 0xff produces '/' in standard base64
    const buf = new Uint8Array([0xff]).buffer;
    const result = base64urlEncode(buf);
    expect(result).not.toContain("/");
  });

  it("strips padding =", () => {
    // Most 1- or 2-byte inputs produce padding
    const buf = new Uint8Array([0x01]).buffer;
    const result = base64urlEncode(buf);
    expect(result).not.toContain("=");
  });

  it("round-trips a known value", () => {
    // "hello" in base64url is "aGVsbG8"
    const buf = new TextEncoder().encode("hello").buffer;
    expect(base64urlEncode(buf as ArrayBuffer)).toBe("aGVsbG8");
  });
});

describe("verifyPkceChallenge", () => {
  async function makeChallenge(verifier: string): Promise<string> {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return base64urlEncode(digest);
  }

  it("returns true when verifier matches the stored challenge", async () => {
    const verifier = "my-test-verifier-value";
    const challenge = await makeChallenge(verifier);
    expect(await verifyPkceChallenge(verifier, challenge)).toBe(true);
  });

  it("returns false when verifier does not match", async () => {
    const verifier = "correct-verifier";
    const challenge = await makeChallenge(verifier);
    expect(await verifyPkceChallenge("wrong-verifier", challenge)).toBe(false);
  });

  it("returns false for an empty verifier against a non-empty challenge", async () => {
    const challenge = await makeChallenge("some-verifier");
    expect(await verifyPkceChallenge("", challenge)).toBe(false);
  });

  it("is case-sensitive", async () => {
    const verifier = "CaseSensitiveVerifier";
    const challenge = await makeChallenge(verifier);
    expect(await verifyPkceChallenge("casesensitiveverifier", challenge)).toBe(false);
  });
});
