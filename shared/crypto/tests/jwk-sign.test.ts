import { describe, it, expect } from "vitest";

// Imported from the `/jwk` subpath ON PURPOSE: this is the DB-free,
// metric-free surface that Cloudflare Worker consumers (cire/api) use to mint
// ARC tokens without dragging @osn/db (bun:sqlite) or the OpenTelemetry SDK
// into the Worker bundle. `verifyArcToken` is only used to assert round-trip.
import { verifyArcToken } from "../src/arc";
import { ArcTokenError, generateArcKeyPair, signArcToken } from "../src/jwk";

describe("signArcToken (Worker-safe ARC signer)", () => {
  it("mints a token that verifyArcToken accepts (round-trip)", async () => {
    const { privateKey, publicKey } = await generateArcKeyPair();
    const token = await signArcToken(privateKey, {
      iss: "cire-api",
      aud: "osn-api",
      scope: "graph:read",
      kid: "kid-1",
    });

    const payload = await verifyArcToken(token, publicKey, "osn-api", "graph:read");
    expect(payload.iss).toBe("cire-api");
    expect(payload.aud).toBe("osn-api");
    expect(payload.scope).toBe("graph:read");
    expect(payload.exp - payload.iat).toBe(300); // default 5-minute TTL
  });

  it("carries the kid in the JWT header", async () => {
    const { privateKey } = await generateArcKeyPair();
    const token = await signArcToken(privateKey, {
      iss: "cire-api",
      aud: "osn-api",
      scope: "graph:read",
      kid: "my-kid",
    });
    const header = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString());
    expect(header.kid).toBe("my-kid");
    expect(header.alg).toBe("ES256");
  });

  it("rejects an out-of-range TTL", async () => {
    const { privateKey } = await generateArcKeyPair();
    await expect(
      signArcToken(privateKey, { iss: "a", aud: "b", scope: "graph:read", kid: "k" }, 0),
    ).rejects.toBeInstanceOf(ArcTokenError);
    await expect(
      signArcToken(privateKey, { iss: "a", aud: "b", scope: "graph:read", kid: "k" }, 700),
    ).rejects.toBeInstanceOf(ArcTokenError);
  });

  it("rejects a malformed scope", async () => {
    const { privateKey } = await generateArcKeyPair();
    await expect(
      signArcToken(privateKey, { iss: "a", aud: "b", scope: "bad scope!", kid: "k" }),
    ).rejects.toBeInstanceOf(ArcTokenError);
  });

  // Regression: hyphenated scopes are part of the deployed taxonomy
  // (osn-api PERMITTED_SCOPES: step-up:verify, app-enrollment:write,
  // graph:resolve-account). SCOPE_PATTERN once rejected `-`, which made
  // every Flow B leave-app token mint throw at runtime.
  it("accepts the hyphenated scopes in the deployed taxonomy (round-trip)", async () => {
    const { privateKey, publicKey } = await generateArcKeyPair();
    const scope = "step-up:verify,app-enrollment:write,graph:resolve-account";
    const token = await signArcToken(privateKey, {
      iss: "pulse-api",
      aud: "osn-api",
      scope,
      kid: "kid-hyphen",
    });
    const payload = await verifyArcToken(token, publicKey, "osn-api", "app-enrollment:write");
    expect(payload.scope).toBe(scope);
  });
});
