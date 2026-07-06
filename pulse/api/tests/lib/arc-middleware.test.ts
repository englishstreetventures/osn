import { describe, it, expect, beforeEach, vi } from "vitest";

// Spy ONLY the middleware-level metric helper. `verifyArcToken`'s internal
// emissions go through arc.ts's own module-scope import of arc-metrics, so
// they are NOT captured by this spy — which is exactly what lets these tests
// assert the S-L6 no-double-count rule: the middleware records early exits,
// verifyArcToken records everything that reaches it.
vi.mock("@shared/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/crypto")>();
  return { ...actual, metricArcTokenVerification: vi.fn() };
});

import {
  createArcToken,
  exportKeyToJwk,
  generateArcKeyPair,
  metricArcTokenVerification,
} from "@shared/crypto";

import {
  _resetServiceKeysForTests,
  registerServiceKey,
  requireArc,
  revokeServiceKey,
} from "../../src/lib/arc-middleware";

const AUDIENCE = "pulse-api";
const SCOPE = "account:erase";

const metricSpy = vi.mocked(metricArcTokenVerification);

/** Registers a key for `serviceId` and returns a token minter bound to it. */
async function setupKey(
  serviceId: string,
  opts: { keyId?: string; allowedScopes?: string; expiresAt?: number } = {},
) {
  const pair = await generateArcKeyPair();
  const keyId = opts.keyId ?? crypto.randomUUID();
  await registerServiceKey({
    serviceId,
    keyId,
    publicKeyJwk: await exportKeyToJwk(pair.publicKey),
    allowedScopes: opts.allowedScopes ?? SCOPE,
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
  });
  const mint = (scope: string = SCOPE) =>
    createArcToken(pair.privateKey, { iss: serviceId, aud: AUDIENCE, scope, kid: keyId });
  return { keyId, pair, mint };
}

describe("pulse requireArc (T-M1 — branch behaviour + S-L6 metric emission)", () => {
  beforeEach(() => {
    _resetServiceKeysForTests();
    metricSpy.mockClear();
  });

  it("accepts a valid token from a registered key (no middleware-level metric — verifyArcToken self-reports)", async () => {
    const { mint } = await setupKey("osn-api");
    const set: { status?: number | string } = {};

    const caller = await requireArc(`ARC ${await mint()}`, set, AUDIENCE, SCOPE);

    expect(caller).toEqual({ iss: "osn-api", aud: AUDIENCE, scope: SCOPE });
    expect(set.status).toBeUndefined();
    expect(metricSpy).not.toHaveBeenCalled();
  });

  it("rejects a missing Authorization header → 401 + (unknown, malformed)", async () => {
    const set: { status?: number | string } = {};
    expect(await requireArc(undefined, set, AUDIENCE, SCOPE)).toBeNull();
    expect(set.status).toBe(401);
    expect(metricSpy).toHaveBeenCalledExactlyOnceWith("unknown", "malformed");
  });

  it("rejects a non-ARC scheme → 401 + (unknown, malformed)", async () => {
    const set: { status?: number | string } = {};
    expect(await requireArc("Bearer some-jwt", set, AUDIENCE, SCOPE)).toBeNull();
    expect(set.status).toBe(401);
    expect(metricSpy).toHaveBeenCalledExactlyOnceWith("unknown", "malformed");
  });

  it("rejects a token whose kid has no header → 401 + (unknown, malformed)", async () => {
    const set: { status?: number | string } = {};
    expect(await requireArc("ARC not.a.jwt-at-all", set, AUDIENCE, SCOPE)).toBeNull();
    expect(set.status).toBe(401);
    expect(metricSpy).toHaveBeenCalledExactlyOnceWith("unknown", "malformed");
  });

  it("rejects an unregistered kid → 401 + (unknown, unknown_issuer)", async () => {
    // Key pair is real but never registered with the middleware.
    const pair = await generateArcKeyPair();
    const token = await createArcToken(pair.privateKey, {
      iss: "osn-api",
      aud: AUDIENCE,
      scope: SCOPE,
      kid: "kid-never-registered",
    });
    const set: { status?: number | string } = {};

    expect(await requireArc(`ARC ${token}`, set, AUDIENCE, SCOPE)).toBeNull();
    expect(set.status).toBe(401);
    // The kid never resolved, so the issuer label must NOT come from the
    // (attacker-controlled) token — it collapses to "unknown".
    expect(metricSpy).toHaveBeenCalledExactlyOnceWith("unknown", "unknown_issuer");
  });

  it("rejects a revoked kid → 401 + (issuer, revoked_key)", async () => {
    const { keyId, mint } = await setupKey("osn-api");
    const token = await mint();
    revokeServiceKey(keyId);
    const set: { status?: number | string } = {};

    expect(await requireArc(`ARC ${token}`, set, AUDIENCE, SCOPE)).toBeNull();
    expect(set.status).toBe(401);
    expect(metricSpy).toHaveBeenCalledExactlyOnceWith("osn-api", "revoked_key");
  });

  it("rejects an expired key registration → 401 + (issuer, revoked_key)", async () => {
    const { mint } = await setupKey("osn-api", {
      expiresAt: Math.floor(Date.now() / 1_000) - 10,
    });
    const set: { status?: number | string } = {};

    expect(await requireArc(`ARC ${await mint()}`, set, AUDIENCE, SCOPE)).toBeNull();
    expect(set.status).toBe(401);
    expect(metricSpy).toHaveBeenCalledExactlyOnceWith("osn-api", "revoked_key");
  });

  it("rejects a scope outside the key's registration → 401 + (issuer, scope_denied)", async () => {
    const { mint } = await setupKey("osn-api", { allowedScopes: "graph:read" });
    const set: { status?: number | string } = {};

    // Token CLAIMS account:erase but the registration only granted graph:read.
    expect(await requireArc(`ARC ${await mint("account:erase")}`, set, AUDIENCE, SCOPE)).toBeNull();
    expect(set.status).toBe(401);
    expect(metricSpy).toHaveBeenCalledExactlyOnceWith("osn-api", "scope_denied");
  });

  it("rejects a token signed by a different key than the registered one → 401, no middleware-level metric (verifyArcToken self-reports)", async () => {
    const { keyId } = await setupKey("osn-api");
    // Sign with a DIFFERENT key pair but reuse the registered kid — passes
    // every registry early-exit, fails cryptographic verification.
    const rogue = await generateArcKeyPair();
    const token = await createArcToken(rogue.privateKey, {
      iss: "osn-api",
      aud: AUDIENCE,
      scope: SCOPE,
      kid: keyId,
    });
    const set: { status?: number | string } = {};

    expect(await requireArc(`ARC ${token}`, set, AUDIENCE, SCOPE)).toBeNull();
    expect(set.status).toBe(401);
    expect(metricSpy).not.toHaveBeenCalled();
  });
});
