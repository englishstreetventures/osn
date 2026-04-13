import {
  generateArcKeyPair,
  exportKeyToJwk,
  createArcToken,
  clearPublicKeyCache,
} from "@osn/crypto";
import { serviceAccounts } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { Db as DbTag } from "@osn/db/service";
import { Effect } from "effect";
import { describe, it, expect, beforeEach } from "vitest";

import { createInternalOrganisationRoutes } from "../../src/routes/organisation-internal";
import { createAuthService } from "../../src/services/auth";
import { createOrganisationService } from "../../src/services/organisation";
import { createTestLayer } from "../helpers/db";

const config = {
  rpId: "localhost",
  rpName: "OSN Test",
  origin: "http://localhost:5173",
  issuerUrl: "http://localhost:4000",
  jwtSecret: "test-secret-at-least-32-characters-long",
};

describe("internal organisation routes (ARC-protected)", () => {
  let layer: ReturnType<typeof createTestLayer>;
  let app: ReturnType<typeof createInternalOrganisationRoutes>;
  let auth: ReturnType<typeof createAuthService>;
  let org: ReturnType<typeof createOrganisationService>;

  const runWithLayer = <A>(eff: Effect.Effect<A, unknown, DbTag>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>);

  async function setupArcService(
    serviceId: string = "pulse-api",
    scopes: string = "org:read",
    audience: string = "osn-core",
  ): Promise<{ token: string; keyPair: CryptoKeyPair }> {
    const kp = await generateArcKeyPair();
    const pubJwk = await exportKeyToJwk(kp.publicKey);
    const now = new Date();

    await runWithLayer(
      Effect.gen(function* () {
        const { db } = yield* Db;
        yield* Effect.tryPromise({
          try: () =>
            db.insert(serviceAccounts).values({
              serviceId,
              publicKeyJwk: pubJwk,
              allowedScopes: scopes,
              createdAt: now,
              updatedAt: now,
            }),
          catch: (e) => e,
        });
      }),
    );

    const token = await createArcToken(kp.privateKey, {
      iss: serviceId,
      aud: audience,
      scope: scopes,
    });

    return { token, keyPair: kp };
  }

  async function registerUser(email: string, handle: string): Promise<string> {
    const user = await runWithLayer(auth.registerUser(email, handle));
    return user.id;
  }

  beforeEach(() => {
    clearPublicKeyCache();
    layer = createTestLayer();
    app = createInternalOrganisationRoutes(layer);
    auth = createAuthService(config);
    org = createOrganisationService();
  });

  // -------------------------------------------------------------------------
  // ARC auth guard
  // -------------------------------------------------------------------------

  describe("ARC auth guard", () => {
    it("returns 401 without authorization header", async () => {
      const res = await app.handle(
        new Request("http://localhost/organisations/internal/user-orgs?userId=test"),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with Bearer token instead of ARC token", async () => {
      const res = await app.handle(
        new Request("http://localhost/organisations/internal/user-orgs?userId=test", {
          headers: { Authorization: "Bearer some-jwt" },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with invalid ARC token", async () => {
      const res = await app.handle(
        new Request("http://localhost/organisations/internal/user-orgs?userId=test", {
          headers: { Authorization: "ARC not-a-valid-token" },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with wrong scope", async () => {
      const { keyPair: kp } = await setupArcService("pulse-api", "org:read", "osn-core");
      const badToken = await createArcToken(kp.privateKey, {
        iss: "pulse-api",
        aud: "osn-core",
        scope: "graph:read",
      });

      const res = await app.handle(
        new Request("http://localhost/organisations/internal/user-orgs?userId=test", {
          headers: { Authorization: `ARC ${badToken}` },
        }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with wrong audience", async () => {
      const { keyPair: kp } = await setupArcService("pulse-api", "org:read", "osn-core");
      const badToken = await createArcToken(kp.privateKey, {
        iss: "pulse-api",
        aud: "wrong-service",
        scope: "org:read",
      });

      const res = await app.handle(
        new Request("http://localhost/organisations/internal/user-orgs?userId=test", {
          headers: { Authorization: `ARC ${badToken}` },
        }),
      );
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // GET /organisations/internal/user-orgs
  // -------------------------------------------------------------------------

  describe("GET /organisations/internal/user-orgs", () => {
    it("returns org IDs for a user with orgs", async () => {
      const { token } = await setupArcService();
      const userId = await registerUser("alice@example.com", "alice");
      await runWithLayer(org.createOrganisation(userId, "acme", "Acme Corp"));
      await runWithLayer(org.createOrganisation(userId, "globex", "Globex Corp"));

      const res = await app.handle(
        new Request(`http://localhost/organisations/internal/user-orgs?userId=${userId}`, {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { organisationIds: string[] };
      expect(json.organisationIds).toHaveLength(2);
    });

    it("returns empty list for user with no orgs", async () => {
      const { token } = await setupArcService();
      const userId = await registerUser("alice@example.com", "alice");

      const res = await app.handle(
        new Request(`http://localhost/organisations/internal/user-orgs?userId=${userId}`, {
          headers: { Authorization: `ARC ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { organisationIds: string[] };
      expect(json.organisationIds).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // GET /organisations/internal/membership
  // -------------------------------------------------------------------------

  describe("GET /organisations/internal/membership", () => {
    it("returns role for an org member", async () => {
      const { token } = await setupArcService();
      const userId = await registerUser("alice@example.com", "alice");
      const organisation = await runWithLayer(org.createOrganisation(userId, "acme", "Acme Corp"));

      const res = await app.handle(
        new Request(
          `http://localhost/organisations/internal/membership?orgId=${organisation.id}&userId=${userId}`,
          { headers: { Authorization: `ARC ${token}` } },
        ),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { role: string | null };
      expect(json.role).toBe("admin");
    });

    it("returns null for a non-member", async () => {
      const { token } = await setupArcService();
      const alice = await registerUser("alice@example.com", "alice");
      const bob = await registerUser("bob@example.com", "bob");
      const organisation = await runWithLayer(org.createOrganisation(alice, "acme", "Acme Corp"));

      const res = await app.handle(
        new Request(
          `http://localhost/organisations/internal/membership?orgId=${organisation.id}&userId=${bob}`,
          { headers: { Authorization: `ARC ${token}` } },
        ),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { role: string | null };
      expect(json.role).toBeNull();
    });
  });
});
