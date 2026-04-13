import type { Db } from "@osn/db/service";
import { Effect, Layer } from "effect";
import { describe, it, expect, beforeEach } from "vitest";

import type { RateLimiterBackend } from "../../src/lib/rate-limit";
import { createOrganisationRoutes } from "../../src/routes/organisation";
import { createAuthService } from "../../src/services/auth";
import { createTestLayer } from "../helpers/db";

const config = {
  rpId: "localhost",
  rpName: "OSN Test",
  origin: "http://localhost:5173",
  issuerUrl: "http://localhost:4000",
  jwtSecret: "test-secret-at-least-32-characters-long",
};

describe("organisation routes", () => {
  let layer: ReturnType<typeof createTestLayer>;
  let orgApp: ReturnType<typeof createOrganisationRoutes>;
  let auth: ReturnType<typeof createAuthService>;

  beforeEach(() => {
    layer = createTestLayer();
    orgApp = createOrganisationRoutes(config, layer);
    auth = createAuthService(config);
  });

  const runWithLayer = <A>(eff: Effect.Effect<A, unknown, Db>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(layer)) as Effect.Effect<A, never, never>);

  async function registerAndGetToken(
    email: string,
    handle: string,
  ): Promise<{ profileId: string; token: string }> {
    const user = await runWithLayer(auth.registerUser(email, handle));
    const tokens = await runWithLayer(
      auth.issueTokens(user.id, user.email, user.handle, user.displayName),
    );
    return { profileId: user.id, token: tokens.accessToken };
  }

  // -------------------------------------------------------------------------
  // Auth guard
  // -------------------------------------------------------------------------

  it("returns 401 without token on POST /organisations", async () => {
    const res = await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    const res = await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: {
          Authorization: "Bearer not-a-valid-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Organisation CRUD
  // -------------------------------------------------------------------------

  it("POST /organisations → 201 creates an org", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");

    const res = await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp", description: "A company" }),
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { ok: boolean; organisation: { handle: string } };
    expect(json.ok).toBe(true);
    expect(json.organisation.handle).toBe("acme");
  });

  it("POST /organisations → 400 when handle taken by user", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");

    const res = await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ handle: "alice", name: "Alice Org" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("GET /organisations lists caller's orgs", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");

    await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
      }),
    );

    const res = await orgApp.handle(
      new Request("http://localhost/organisations", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { organisations: { handle: string }[] };
    expect(json.organisations).toHaveLength(1);
    expect(json.organisations[0].handle).toBe("acme");
  });

  it("GET /organisations/:handle returns the org", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");

    await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
      }),
    );

    const res = await orgApp.handle(
      new Request("http://localhost/organisations/acme", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { organisation: { name: string } };
    expect(json.organisation.name).toBe("Acme Corp");
  });

  it("GET /organisations/:handle → 404 for unknown org", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");

    const res = await orgApp.handle(
      new Request("http://localhost/organisations/nonexistent", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("PATCH /organisations/:handle updates the org", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");

    await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
      }),
    );

    const res = await orgApp.handle(
      new Request("http://localhost/organisations/acme", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Acme Inc" }),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; organisation: { name: string } };
    expect(json.organisation.name).toBe("Acme Inc");
  });

  it("PATCH /organisations/:handle → 400 for non-admin", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");

    await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
      }),
    );

    // Add bob as member
    await orgApp.handle(
      new Request("http://localhost/organisations/acme/members/bob", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "member" }),
      }),
    );

    const res = await orgApp.handle(
      new Request("http://localhost/organisations/acme", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${bob.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Hacked" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("DELETE /organisations/:handle → 400 for non-owner admin", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");

    await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
      }),
    );

    // Add bob as admin
    await orgApp.handle(
      new Request("http://localhost/organisations/acme/members/bob", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "admin" }),
      }),
    );

    const res = await orgApp.handle(
      new Request("http://localhost/organisations/acme", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${bob.token}` },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("DELETE /organisations/:handle deletes the org", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");

    await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
      }),
    );

    const res = await orgApp.handle(
      new Request("http://localhost/organisations/acme", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(200);

    // Should be gone
    const getRes = await orgApp.handle(
      new Request("http://localhost/organisations/acme", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(getRes.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Member management
  // -------------------------------------------------------------------------

  it("POST /organisations/:handle/members/:userHandle → 201 adds a member", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");

    await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
      }),
    );

    const res = await orgApp.handle(
      new Request("http://localhost/organisations/acme/members/bob", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "member" }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it("DELETE /organisations/:handle/members/:userHandle removes a member", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");

    await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
      }),
    );

    await orgApp.handle(
      new Request("http://localhost/organisations/acme/members/bob", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "member" }),
      }),
    );

    const res = await orgApp.handle(
      new Request("http://localhost/organisations/acme/members/bob", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("PATCH /organisations/:handle/members/:userHandle updates role", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");

    await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
      }),
    );

    await orgApp.handle(
      new Request("http://localhost/organisations/acme/members/bob", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "member" }),
      }),
    );

    const res = await orgApp.handle(
      new Request("http://localhost/organisations/acme/members/bob", {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "admin" }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("GET /organisations/:handle/members lists members", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await registerAndGetToken("bob@example.com", "bob");

    await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
      }),
    );

    await orgApp.handle(
      new Request("http://localhost/organisations/acme/members/bob", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "member" }),
      }),
    );

    const res = await orgApp.handle(
      new Request("http://localhost/organisations/acme/members", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { members: { handle: string; role: string }[] };
    expect(json.members).toHaveLength(2);
    const aliceMember = json.members.find((m) => m.handle === "alice");
    expect(aliceMember?.role).toBe("admin");
    const bobMember = json.members.find((m) => m.handle === "bob");
    expect(bobMember?.role).toBe("member");
  });

  it("POST /organisations/:handle/members/:userHandle → 404 for unknown user", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");

    await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
      }),
    );

    const res = await orgApp.handle(
      new Request("http://localhost/organisations/acme/members/nobody", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${alice.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role: "member" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Rate limiter dependency injection
  // -------------------------------------------------------------------------

  describe("rate limiter dependency injection", () => {
    it("uses the injected rate limiter on write operations", async () => {
      const rejectAll: RateLimiterBackend = { check: () => false };
      const freshOrg = createOrganisationRoutes(config, layer, Layer.empty, rejectAll);
      const alice = await registerAndGetToken("alice@example.com", "alice");

      const res = await freshOrg.handle(
        new Request("http://localhost/organisations", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${alice.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
        }),
      );
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Too many requests");
    });

    it("does not rate-limit read operations", async () => {
      const rejectAll: RateLimiterBackend = { check: () => false };
      const freshOrg = createOrganisationRoutes(config, layer, Layer.empty, rejectAll);
      const alice = await registerAndGetToken("alice@example.com", "alice");

      const res = await freshOrg.handle(
        new Request("http://localhost/organisations", {
          headers: { Authorization: `Bearer ${alice.token}` },
        }),
      );
      expect(res.status).toBe(200);
    });

    it("fails closed when the backend rejects", async () => {
      const failing: RateLimiterBackend = {
        check: () => Promise.reject(new Error("Redis connection refused")),
      };
      const freshOrg = createOrganisationRoutes(config, layer, Layer.empty, failing);
      const alice = await registerAndGetToken("alice@example.com", "alice");

      const res = await freshOrg.handle(
        new Request("http://localhost/organisations", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${alice.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
        }),
      );
      expect(res.status).toBe(429);
    });
  });
});
