import { accounts, serviceAccounts, serviceAccountKeys } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { Db as DbTag } from "@osn/db/service";
import {
  generateArcKeyPair,
  exportKeyToJwk,
  createArcToken,
  clearPublicKeyCache,
} from "@shared/crypto";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { describe, it, expect, beforeEach, beforeAll } from "vitest";

import { createInternalAccountRoutes } from "../../src/routes/internal-account";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

/**
 * Tests for POST /internal/accounts/emails — the organiser-address lookup
 * cire-api's retention sweep calls before it deletes a wedding's gift detail.
 *
 * The privacy tests matter more than the happy path here: the route hands out
 * email addresses, so the scope gate and the absence of an existence oracle
 * are the behaviour under test.
 */
describe("internal account emails", () => {
  let layer: ReturnType<typeof createTestLayer>;
  let app: ReturnType<typeof createInternalAccountRoutes>;
  let auth: ReturnType<typeof createAuthService>;

  const runWithLayer = <A>(eff: Effect.Effect<A, unknown, DbTag>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>);

  /**
   * Registers a service account holding `scopes` and returns a signed ARC token.
   * The issuer is a parameter because the route pins it: a correctly
   * scoped, correctly signed token from any service other than cire-api is
   * still refused, so a test needs to be able to issue one.
   */
  async function setupArcToken(scopes: string, serviceId = "cire-api"): Promise<string> {
    const kp = await generateArcKeyPair();
    const pubJwk = await exportKeyToJwk(kp.publicKey);
    const now = new Date();
    const keyId = crypto.randomUUID();

    await runWithLayer(
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.promise(() =>
          db
            .insert(serviceAccounts)
            .values({
              serviceId,
              allowedScopes: scopes,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: serviceAccounts.serviceId,
              set: { allowedScopes: scopes },
            }),
        );
        yield* Effect.promise(() =>
          db.insert(serviceAccountKeys).values({
            keyId,
            serviceId,
            publicKeyJwk: pubJwk,
            registeredAt: now,
            expiresAt: null,
            revokedAt: null,
          }),
        );
      }),
    );

    return createArcToken(kp.privateKey, {
      iss: serviceId,
      aud: "osn-api",
      scope: scopes,
      kid: keyId,
    });
  }

  async function post(token: string | null, profileIds: string[]): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.Authorization = `ARC ${token}`;
    return app.handle(
      new Request("http://localhost/internal/accounts/emails", {
        method: "POST",
        headers,
        body: JSON.stringify({ profile_ids: profileIds }),
      }),
    );
  }

  beforeEach(() => {
    clearPublicKeyCache();
    layer = createTestLayer();
    app = createInternalAccountRoutes(config, layer);
    auth = createAuthService(config);
  });

  it("returns 401 without an authorization header", async () => {
    const res = await post(null, ["usr_anything"]);
    expect(res.status).toBe(401);
  });

  it("returns 401 for a token carrying a different scope", async () => {
    const token = await setupArcToken("graph:read");
    const res = await post(token, ["usr_anything"]);
    expect(res.status).toBe(401);
  });

  it("returns 401 for a correctly scoped token issued by another service", async () => {
    // PERMITTED_SCOPES is one flat allowlist governing what
    // /graph/internal/register-service will grant to ANY service, so holding
    // INTERNAL_SERVICE_SECRET is enough to register a key asking for
    // account:email-read. The restriction to cire-api is enforced here instead,
    // at the point of use, where the issuer is signature-verified.
    const user = await runWithLayer(auth.registerProfile("couple@example.com", "couple"));
    const token = await setupArcToken("account:email-read", "pulse-api");

    const res = await post(token, [user.id]);
    expect(res.status).toBe(401);
    // Same body as a missing or wrong-scoped token: the refused service learns
    // nothing from the difference.
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns the address of the account owning a known profile", async () => {
    const user = await runWithLayer(auth.registerProfile("couple@example.com", "couple"));
    const token = await setupArcToken("account:email-read");

    const res = await post(token, [user.id]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      emails: [{ profile_id: user.id, email: "couple@example.com" }],
    });
  });

  it("answers an unknown id exactly as it answers a tombstoned one", async () => {
    const user = await runWithLayer(auth.registerProfile("gone@example.com", "gone"));
    await runWithLayer(
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.promise(() =>
          db
            .update(accounts)
            .set({ deletedAt: Math.floor(Date.now() / 1000) })
            .where(eq(accounts.email, "gone@example.com")),
        );
      }),
    );
    const token = await setupArcToken("account:email-read");

    const tombstoned = await post(token, [user.id]);
    const unknown = await post(token, ["usr_neverexisted"]);

    expect(tombstoned.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await tombstoned.json()).toEqual({ emails: [] });
    expect(await unknown.json()).toEqual({ emails: [] });
  });

  it("rejects a request over the id cap before reading anything", async () => {
    const token = await setupArcToken("account:email-read");
    const res = await post(
      token,
      Array.from({ length: 101 }, (_, i) => `usr_${i}`),
    );
    expect(res.status).toBe(422);
  });
});
