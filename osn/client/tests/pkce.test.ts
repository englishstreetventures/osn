import { describe, it, expect } from "vitest";
import { generateCodeVerifier, generateCodeChallenge } from "../src/pkce";

describe("PKCE helpers", () => {
  it("generates a code verifier that is base64url-safe", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes → 43 base64url chars (no padding)
    expect(verifier.length).toBeGreaterThanOrEqual(40);
  });

  it("generates a code challenge from a verifier", async () => {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toBe(verifier);
  });

  it("produces the same challenge for the same verifier (deterministic)", async () => {
    const verifier = "test_verifier_deterministic";
    const c1 = await generateCodeChallenge(verifier);
    const c2 = await generateCodeChallenge(verifier);
    expect(c1).toBe(c2);
  });

  it("produces different verifiers on each call", () => {
    const v1 = generateCodeVerifier();
    const v2 = generateCodeVerifier();
    expect(v1).not.toBe(v2);
  });
});
