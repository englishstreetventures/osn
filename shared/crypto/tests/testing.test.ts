import { decodeProtectedHeader, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";

import { LOCAL_TEST_ISSUER, makeAccessTokenSigner } from "../src/testing";

// The pulse, zap and cire route suites all authenticate through this one
// signer. If it stopped setting `aud`, or put `sub` in the header instead of
// the payload, the failure would surface as a few hundred confusing 401s across
// four packages rather than one named assertion. These tests pin the contract
// those suites assume implicitly.

const AUD = "osn-access";

describe("makeAccessTokenSigner", () => {
  it("mints a token the standard verifier accepts", async () => {
    const signer = await makeAccessTokenSigner();
    const token = await signer.sign("usr_alice");

    const { payload } = await jwtVerify(token, signer.publicKey, { audience: AUD });
    expect(payload.sub).toBe("usr_alice");
    expect(payload.aud).toBe(AUD);
    expect(payload.iat).toEqual(expect.any(Number));
  });

  it("signs ES256 with the default test kid", async () => {
    const signer = await makeAccessTokenSigner();
    const header = decodeProtectedHeader(await signer.sign("usr_alice"));
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe("test-kid");
  });

  it("defaults to a 5-minute expiry, matching production issueAccessToken", async () => {
    const signer = await makeAccessTokenSigner();
    const { payload } = await jwtVerify(await signer.sign("usr_alice"), signer.publicKey, {
      audience: AUD,
    });
    // A test token must never outlive a real one.
    const ttl = (payload.exp as number) - (payload.iat as number);
    expect(ttl).toBe(300);
  });

  it("omits `email` unless asked, and includes it when asked", async () => {
    const signer = await makeAccessTokenSigner();
    const opts = { audience: AUD } as const;

    const bare = await jwtVerify(await signer.sign("usr_alice"), signer.publicKey, opts);
    expect(bare.payload.email).toBeUndefined();

    const withEmail = await jwtVerify(
      await signer.sign("usr_alice", { email: "a@example.com" }),
      signer.publicKey,
      opts,
    );
    expect(withEmail.payload.email).toBe("a@example.com");
  });

  // Assert on jose's `code`, not its message text — the code is stable API.
  const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
      await p;
      return undefined;
    } catch (err) {
      return (err as { code?: string }).code;
    }
  };

  it("rejects an expired token past the verifier's clock tolerance", async () => {
    const signer = await makeAccessTokenSigner();
    // -120s clears the ±30s clockTolerance in @shared/osn-auth-client.
    const stale = await signer.sign("usr_alice", { expiresIn: "-120s" });
    expect(await codeOf(jwtVerify(stale, signer.publicKey, { audience: AUD }))).toBe(
      "ERR_JWT_EXPIRED",
    );
  });

  it("honours an audience override so audience-rejection paths are reachable", async () => {
    const signer = await makeAccessTokenSigner();
    const stepUp = await signer.sign("usr_alice", { audience: "osn-step-up" });
    expect(await codeOf(jwtVerify(stepUp, signer.publicKey, { audience: AUD }))).toBe(
      "ERR_JWT_CLAIM_VALIDATION_FAILED",
    );
  });

  // Every downstream suite's tokens are accepted because of this default —
  // pulse, zap and the sixteen cire suites all mint without naming an issuer
  // and verify against a config expecting the local one. A change to the
  // sentinel below would mint tokens no verifier accepts, and be diagnosed as
  // a route bug in four packages.
  it("stamps the local issuer by default, so downstream verifiers accept it", async () => {
    const signer = await makeAccessTokenSigner();
    const token = await signer.sign("usr_alice");

    const { payload } = await jwtVerify(token, signer.publicKey, {
      audience: AUD,
      issuer: LOCAL_TEST_ISSUER,
    });
    expect(payload.iss).toBe(LOCAL_TEST_ISSUER);
  });

  // `null`, not `undefined`: the pre-enforcement shape, for driving the
  // rejection path a verifier that pins the issuer must take.
  it("mints no iss at all when the issuer is null", async () => {
    const signer = await makeAccessTokenSigner();
    const token = await signer.sign("usr_alice", { issuer: null });

    const { payload } = await jwtVerify(token, signer.publicKey, { audience: AUD });
    expect(payload.iss).toBeUndefined();

    expect(
      await codeOf(
        jwtVerify(token, signer.publicKey, { audience: AUD, issuer: LOCAL_TEST_ISSUER }),
      ),
    ).toBe("ERR_JWT_CLAIM_VALIDATION_FAILED");
  });

  it("honours an issuer override so cire's issuer pinning is reachable", async () => {
    const signer = await makeAccessTokenSigner();
    const token = await signer.sign("usr_alice", { issuer: "https://id.example.test" });

    const { payload } = await jwtVerify(token, signer.publicKey, {
      audience: AUD,
      issuer: "https://id.example.test",
    });
    expect(payload.iss).toBe("https://id.example.test");

    expect(
      await codeOf(
        jwtVerify(token, signer.publicKey, { audience: AUD, issuer: "https://other.test" }),
      ),
    ).toBe("ERR_JWT_CLAIM_VALIDATION_FAILED");
  });

  it("honours a kid override so key-mismatch paths are reachable", async () => {
    const signer = await makeAccessTokenSigner();
    const header = decodeProtectedHeader(await signer.sign("usr_alice", { kid: "other-kid" }));
    expect(header.kid).toBe("other-kid");
  });

  it("gives each signer an independent key pair", async () => {
    const a = await makeAccessTokenSigner();
    const b = await makeAccessTokenSigner();
    // The forgery tests depend on a second signer being genuinely unrelated.
    expect(await codeOf(jwtVerify(await a.sign("usr_alice"), b.publicKey, { audience: AUD }))).toBe(
      "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    );
  });
});
