import { serviceAccounts, serviceAccountKeys } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import {
  clearPublicKeyCache,
  createArcToken,
  exportKeyToJwk,
  generateArcKeyPair,
} from "@shared/crypto";
import { Effect } from "effect";
import { describe, it, expect, beforeEach } from "vitest";

import { requireArc } from "../../src/lib/arc-middleware";
import { createTestLayer } from "../helpers/db";

// ---------------------------------------------------------------------------
// T-S1: requireArc — untrusted-input fast-path and peekClaims edge cases
//
// The route integration tests cover the happy path (valid ARC token) and the
// basic 401 cases (wrong audience, wrong scope, expired). These unit tests
// cover the untrusted-input parse paths that short-circuit before the DB is
// touched, ensuring no 500 leaks implementation details.
// ---------------------------------------------------------------------------

const dbLayer = createTestLayer();
const run = <A>(eff: Effect.Effect<A, unknown, Db>) =>
  Effect.runPromise(eff.pipe(Effect.provide(dbLayer)) as Effect.Effect<A, never, never>);

function makeSet(): { status?: number | string } {
  return {};
}

/** base64url-encode a plain object (no padding). */
function b64u(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

beforeEach(() => {
  clearPublicKeyCache();
});

describe("requireArc — missing / non-ARC authorization", () => {
  it("returns null + 401 when Authorization header is missing", async () => {
    const set = makeSet();
    const result = await requireArc(undefined, set, run, "osn-api", "graph:read");
    expect(result).toBeNull();
    expect(set.status).toBe(401);
  });

  it("returns null + 401 for Bearer scheme (not ARC)", async () => {
    const set = makeSet();
    const result = await requireArc("Bearer some-jwt", set, run, "osn-api", "graph:read");
    expect(result).toBeNull();
    expect(set.status).toBe(401);
  });

  it("returns null + 401 for empty string", async () => {
    const set = makeSet();
    const result = await requireArc("", set, run, "osn-api", "graph:read");
    expect(result).toBeNull();
    expect(set.status).toBe(401);
  });
});

describe("requireArc — malformed ARC token structure", () => {
  it("returns null + 401 for a token with only two segments", async () => {
    const set = makeSet();
    const result = await requireArc("ARC header.payload", set, run, "osn-api", "graph:read");
    expect(result).toBeNull();
    expect(set.status).toBe(401);
  });

  it("returns null + 401 for a token with non-JSON header", async () => {
    const set = makeSet();
    // Raw bytes that decode to non-JSON
    const result = await requireArc(
      "ARC bm90anNvbg.payload.sig",
      set,
      run,
      "osn-api",
      "graph:read",
    );
    expect(result).toBeNull();
    expect(set.status).toBe(401);
  });

  it("returns null + 401 for header missing kid field", async () => {
    const header = b64u({ alg: "ES256" }); // no kid
    const payload = b64u({ iss: "pulse-api", scope: "graph:read" });
    const set = makeSet();
    const result = await requireArc(
      `ARC ${header}.${payload}.fakesig`,
      set,
      run,
      "osn-api",
      "graph:read",
    );
    expect(result).toBeNull();
    expect(set.status).toBe(401);
  });

  it("returns null + 401 for payload missing iss field", async () => {
    const header = b64u({ alg: "ES256", kid: "some-kid" });
    const payload = b64u({ scope: "graph:read" }); // no iss
    const set = makeSet();
    const result = await requireArc(
      `ARC ${header}.${payload}.fakesig`,
      set,
      run,
      "osn-api",
      "graph:read",
    );
    expect(result).toBeNull();
    expect(set.status).toBe(401);
  });
});

describe("requireArc — valid structure but unregistered service", () => {
  it("returns null + 401 when kid is not in the DB", async () => {
    const header = b64u({ alg: "ES256", kid: "no-such-key" });
    const payload = b64u({ iss: "unknown-svc", scope: "graph:read" });
    const set = makeSet();
    const result = await requireArc(
      `ARC ${header}.${payload}.fakesig`,
      set,
      run,
      "osn-api",
      "graph:read",
    );
    expect(result).toBeNull();
    expect(set.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// X1: issuer binding. requireArc passes the peeked `iss` to verifyArcToken as
// expectedIssuer, so the signed `iss` is cryptographically required to match
// the issuer its `kid` is registered under in the DB.
// ---------------------------------------------------------------------------
describe("requireArc — issuer binding (X1)", () => {
  /** Register a service + key under `serviceId`, return a signing key pair + keyId. */
  async function registerKey(serviceId: string, scopes = "graph:read") {
    const kp = await generateArcKeyPair();
    const pubJwk = await exportKeyToJwk(kp.publicKey);
    const keyId = crypto.randomUUID();
    const now = new Date();
    await run(
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.tryPromise({
          try: () =>
            db
              .insert(serviceAccounts)
              .values({ serviceId, allowedScopes: scopes, createdAt: now, updatedAt: now }),
          catch: (e) => e,
        });
        yield* Effect.tryPromise({
          try: () =>
            db.insert(serviceAccountKeys).values({
              keyId,
              serviceId,
              publicKeyJwk: pubJwk,
              registeredAt: now,
              expiresAt: null,
              revokedAt: null,
            }),
          catch: (e) => e,
        });
      }),
    );
    return { keyPair: kp, keyId };
  }

  it("accepts a token whose signed iss matches the kid's registered issuer", async () => {
    const { keyPair, keyId } = await registerKey("pulse-api");
    const token = await createArcToken(keyPair.privateKey, {
      iss: "pulse-api",
      aud: "osn-api",
      scope: "graph:read",
      kid: keyId,
    });
    const set = makeSet();
    const caller = await requireArc(`ARC ${token}`, set, run, "osn-api", "graph:read");
    expect(caller).not.toBeNull();
    expect(caller?.iss).toBe("pulse-api");
    expect(set.status).toBeUndefined();
  });

  it("rejects a token whose signed iss differs from the kid's registered issuer", async () => {
    // Key registered under "pulse-api", but token claims iss "evil-api" while
    // re-using the same kid. The kid→issuer DB binding rejects it at resolve,
    // and even if it resolved, X1's expectedIssuer check would reject it.
    const { keyPair, keyId } = await registerKey("real-svc");
    const forged = await createArcToken(keyPair.privateKey, {
      iss: "evil-api",
      aud: "osn-api",
      scope: "graph:read",
      kid: keyId,
    });
    const set = makeSet();
    const caller = await requireArc(`ARC ${forged}`, set, run, "osn-api", "graph:read");
    expect(caller).toBeNull();
    expect(set.status).toBe(401);
  });
});
