import { organisationMembers } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Layer, Logger } from "effect";
import { describe, it, expect, beforeEach, beforeAll } from "vitest";

import { createOrganisationRoutes } from "../../src/routes/organisation";
import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer, makeLogEmailLive } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

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
    const user = await runWithLayer(auth.registerProfile(email, handle));
    const tokens = await runWithLayer(
      auth.issueTokens(user.id, user.accountId, user.email, user.handle, user.displayName),
    );
    return { profileId: user.id, token: tokens.accessToken };
  }

  /** The members of `acme` as `token`'s owner reads them. */
  async function acmeMembers(token: string): Promise<{ handle: string; role: string }[]> {
    const res = await orgApp.handle(
      new Request("http://localhost/organisations/acme/members", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { members: { handle: string; role: string }[] }).members;
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

  // The page shows Edit, Delete and Remove by the reader's standing, so the
  // read says what that standing is — the reader's own, never anyone else's.
  it("GET /organisations/:handle says the caller's own standing", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const bob = await registerAndGetToken("bob@example.com", "bob");
    const mallory = await registerAndGetToken("mallory@example.com", "mallory");
    await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
      }),
    );
    await orgApp.handle(
      new Request("http://localhost/organisations/acme/members/bob", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "member" }),
      }),
    );

    const callerOf = async (token: string) => {
      const res = await orgApp.handle(
        new Request("http://localhost/organisations/acme", {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { caller: unknown }).caller;
    };
    expect(await callerOf(alice.token)).toEqual({ role: "admin", owner: true });
    expect(await callerOf(bob.token)).toEqual({ role: "member", owner: false });
    // Not a member: the organisation is public, the standing is none.
    expect(await callerOf(mallory.token)).toBeNull();

    // Made an admin by the owner: an admin, still not the owner.
    await orgApp.handle(
      new Request("http://localhost/organisations/acme/members/bob", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      }),
    );
    expect(await callerOf(bob.token)).toEqual({ role: "admin", owner: false });
  });

  // A failed read of the standing costs the caller the actions, never the
  // organisation: the page still loads, offering nothing, and the failure is
  // logged, a defect as well as a typed failure.
  async function readWithFailingStanding(members: "throw" | "malformed") {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
      }),
    );

    // The same database, except for reads of the members table: they throw
    // inside the query, which the service types as a database error, or
    // answer a row that is not a row, which fails the service as a defect.
    // The organisation itself still resolves.
    const live = await runWithLayer(
      Effect.gen(function* () {
        return (yield* Db).db;
      }),
    );
    const malformedRows = { where: () => ({ limit: () => Promise.resolve([null]) }) };
    const failingMembers = new Proxy(live, {
      get(target, prop, receiver) {
        if (prop !== "select") return Reflect.get(target, prop, receiver);
        return (...fields: Parameters<typeof live.select>) => {
          const builder = target.select(...fields);
          return new Proxy(builder, {
            get(inner, key, innerReceiver) {
              if (key !== "from") return Reflect.get(inner, key, innerReceiver);
              return (table: Parameters<typeof builder.from>[0]) => {
                if (table !== organisationMembers) return inner.from(table);
                if (members === "throw") throw new Error("members table unreachable");
                return malformedRows;
              };
            },
          });
        };
      },
    });
    const logs: { level: string; message: unknown }[] = [];
    const failing = createOrganisationRoutes(
      config,
      Layer.merge(Layer.succeed(Db, { db: failingMembers }), makeLogEmailLive().layer),
      Logger.layer([
        Logger.map(Logger.formatStructured, (line) => {
          logs.push(line);
        }),
      ]),
    );

    const res = await failing.handle(
      new Request("http://localhost/organisations/acme", {
        headers: { Authorization: `Bearer ${alice.token}` },
      }),
    );
    return {
      status: res.status,
      json: (await res.json()) as {
        organisation: { handle: string; name: string };
        caller: unknown;
      },
      errors: logs.filter((line) => /^error$/i.test(line.level)).map((line) => line.message),
    };
  }

  /** One error line: the message, then the failure's tag and message alone. */
  const standingNotRead = [["organisation caller standing not read", expect.any(Object)]];

  it("GET /organisations/:handle answers a failed standing read with the organisation and no standing", async () => {
    const { status, json, errors } = await readWithFailingStanding("throw");
    expect(status).toBe(200);
    expect(json.organisation).toMatchObject({ handle: "acme", name: "Acme Corp" });
    expect(json.caller).toBeNull();
    expect(errors).toEqual(standingNotRead);
  });

  it("GET /organisations/:handle answers a standing read that dies with the organisation and no standing", async () => {
    const { status, json, errors } = await readWithFailingStanding("malformed");
    expect(status).toBe(200);
    expect(json.organisation).toMatchObject({ handle: "acme", name: "Acme Corp" });
    expect(json.caller).toBeNull();
    expect(errors).toEqual(standingNotRead);
  });

  it("GET /organisations/:handle → 401 with no token, and says no standing", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
      }),
    );

    const res = await orgApp.handle(new Request("http://localhost/organisations/acme"));
    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty("caller");
  });

  it("GET /organisations/:handle → 401 with a token that does not verify, and says no standing", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    await orgApp.handle(
      new Request("http://localhost/organisations", {
        method: "POST",
        headers: { Authorization: `Bearer ${alice.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "acme", name: "Acme Corp" }),
      }),
    );

    const res = await orgApp.handle(
      new Request("http://localhost/organisations/acme", {
        headers: { Authorization: "Bearer not-a-valid-token" },
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty("caller");
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

  it("POST /organisations/:handle/members/:profileHandle → 201 adds a member", async () => {
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

  it("DELETE /organisations/:handle/members/:profileHandle removes a member", async () => {
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
    expect((await acmeMembers(alice.token)).map((m) => m.handle)).toEqual(["alice"]);
  });

  it("PATCH /organisations/:handle/members/:profileHandle updates role", async () => {
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
    const bob = (await acmeMembers(alice.token)).find((m) => m.handle === "bob");
    expect(bob?.role).toBe("admin");
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

  it("GET /organisations/:handle/members → 403 for a non-member", async () => {
    const alice = await registerAndGetToken("alice@example.com", "alice");
    const mallory = await registerAndGetToken("mallory@example.com", "mallory");

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

    // Mallory is authenticated but not a member — the roster must not leak.
    const res = await orgApp.handle(
      new Request("http://localhost/organisations/acme/members", {
        headers: { Authorization: `Bearer ${mallory.token}` },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("POST /organisations/:handle/members/:profileHandle → 404 for unknown profile", async () => {
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
        check: () => Promise.reject(new Error("store unreachable")),
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
