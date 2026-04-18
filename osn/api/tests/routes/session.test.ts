import { Effect } from "effect";
import { describe, it, expect, beforeEach, beforeAll } from "vitest";

import { createSessionRoutes } from "../../src/routes/session";
import { createAuthService } from "../../src/services/auth";
import { createSessionService } from "../../src/services/session";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

describe("session routes", () => {
  let app: ReturnType<typeof createSessionRoutes>;
  let layer: ReturnType<typeof createTestLayer>;
  let auth: ReturnType<typeof createAuthService>;
  let svc: ReturnType<typeof createSessionService>;

  /**
   * Create a session via `issueTokens` directly, then return the access
   * token + the raw session token + the hash of the session token (which
   * is the `sessions.id` / URL path parameter).
   */
  async function seedSession(email: string, handle: string) {
    const profile = await Effect.runPromise(
      auth.registerProfile(email, handle).pipe(Effect.provide(layer)),
    );
    const tokens = await Effect.runPromise(
      auth
        .issueTokens(
          profile.id,
          profile.accountId,
          profile.email,
          profile.handle,
          profile.displayName,
        )
        .pipe(Effect.provide(layer)),
    );
    return {
      accountId: profile.accountId,
      profileId: profile.id,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      sessionId: svc.hashSessionToken(tokens.refreshToken),
    };
  }

  beforeEach(() => {
    layer = createTestLayer();
    auth = createAuthService(config);
    svc = createSessionService(auth);
    app = createSessionRoutes(config, layer);
  });

  describe("GET /sessions", () => {
    it("returns 401 without Bearer token", async () => {
      const res = await app.handle(new Request("http://localhost/sessions"));
      expect(res.status).toBe(401);
    });

    it("lists the current session and flags is_current", async () => {
      const seeded = await seedSession("alice@example.com", "alice");
      const res = await app.handle(
        new Request("http://localhost/sessions", {
          headers: {
            authorization: `Bearer ${seeded.accessToken}`,
            cookie: `osn_session=${seeded.refreshToken}`,
          },
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        sessions: Array<{ id: string; is_current: boolean; user_agent: string | null }>;
      };
      expect(json.sessions).toHaveLength(1);
      expect(json.sessions[0]!.id).toBe(seeded.sessionId);
      expect(json.sessions[0]!.is_current).toBe(true);
    });

    it("does NOT flag is_current when no cookie is presented", async () => {
      const seeded = await seedSession("bob@example.com", "bob");
      const res = await app.handle(
        new Request("http://localhost/sessions", {
          headers: { authorization: `Bearer ${seeded.accessToken}` },
        }),
      );
      const json = (await res.json()) as {
        sessions: Array<{ is_current: boolean }>;
      };
      expect(json.sessions[0]!.is_current).toBe(false);
    });
  });

  describe("DELETE /sessions/:id", () => {
    it("returns 401 without Bearer token", async () => {
      const res = await app.handle(
        new Request("http://localhost/sessions/" + "a".repeat(64), { method: "DELETE" }),
      );
      expect(res.status).toBe(401);
    });

    it("returns 422 for a malformed session id (schema rejects non-hex)", async () => {
      const seeded = await seedSession("carol@example.com", "carol");
      const res = await app.handle(
        new Request("http://localhost/sessions/not-a-hex-id", {
          method: "DELETE",
          headers: { authorization: `Bearer ${seeded.accessToken}` },
        }),
      );
      expect(res.status).toBe(422);
    });

    it("revokes the caller's session and reports wasCurrent correctly", async () => {
      const seeded = await seedSession("dan@example.com", "dan");
      const res = await app.handle(
        new Request(`http://localhost/sessions/${seeded.sessionId}`, {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${seeded.accessToken}`,
            cookie: `osn_session=${seeded.refreshToken}`,
          },
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; was_current: boolean };
      expect(json.success).toBe(true);
      expect(json.was_current).toBe(true);

      // Refresh now fails.
      const err = await Effect.runPromise(
        Effect.either(auth.refreshTokens(seeded.refreshToken)).pipe(Effect.provide(layer)),
      );
      expect(err._tag).toBe("Left");
    });

    it("returns 404 for a session id belonging to another account", async () => {
      const alice = await seedSession("cross-a@example.com", "crossa");
      const bob = await seedSession("cross-b@example.com", "crossb");
      const res = await app.handle(
        new Request(`http://localhost/sessions/${bob.sessionId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${alice.accessToken}` },
        }),
      );
      expect(res.status).toBe(404);
      // Bob's session still works.
      const still = await Effect.runPromise(
        auth.refreshTokens(bob.refreshToken).pipe(Effect.provide(layer)),
      );
      expect(still.accessToken.length).toBeGreaterThan(0);
    });
  });

  describe("POST /sessions/revoke-others", () => {
    it("returns 401 without Bearer token", async () => {
      const res = await app.handle(
        new Request("http://localhost/sessions/revoke-others", { method: "POST" }),
      );
      expect(res.status).toBe(401);
    });

    it("revokes every session except the caller's cookie", async () => {
      const profile = await Effect.runPromise(
        auth.registerProfile("nuke@example.com", "nuke").pipe(Effect.provide(layer)),
      );
      const a = await Effect.runPromise(
        auth
          .issueTokens(
            profile.id,
            profile.accountId,
            profile.email,
            profile.handle,
            profile.displayName,
          )
          .pipe(Effect.provide(layer)),
      );
      const b = await Effect.runPromise(
        auth
          .issueTokens(
            profile.id,
            profile.accountId,
            profile.email,
            profile.handle,
            profile.displayName,
          )
          .pipe(Effect.provide(layer)),
      );
      const c = await Effect.runPromise(
        auth
          .issueTokens(
            profile.id,
            profile.accountId,
            profile.email,
            profile.handle,
            profile.displayName,
          )
          .pipe(Effect.provide(layer)),
      );

      const res = await app.handle(
        new Request("http://localhost/sessions/revoke-others", {
          method: "POST",
          headers: {
            authorization: `Bearer ${a.accessToken}`,
            cookie: `osn_session=${b.refreshToken}`,
          },
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; revoked: number };
      expect(json.success).toBe(true);
      expect(json.revoked).toBe(2);

      // b survives; a and c don't.
      const bStill = await Effect.runPromise(
        auth.refreshTokens(b.refreshToken).pipe(Effect.provide(layer)),
      );
      expect(bStill.accessToken.length).toBeGreaterThan(0);
      const aErr = await Effect.runPromise(
        Effect.either(auth.refreshTokens(a.refreshToken)).pipe(Effect.provide(layer)),
      );
      expect(aErr._tag).toBe("Left");
      const cErr = await Effect.runPromise(
        Effect.either(auth.refreshTokens(c.refreshToken)).pipe(Effect.provide(layer)),
      );
      expect(cErr._tag).toBe("Left");
    });
  });

  describe("issueTokens threads SessionContext", () => {
    it("stores user-agent + ipHash on the row so the list surfaces them", async () => {
      const profile = await Effect.runPromise(
        auth.registerProfile("ctx@example.com", "ctxuser").pipe(Effect.provide(layer)),
      );
      await Effect.runPromise(
        auth
          .issueTokens(
            profile.id,
            profile.accountId,
            profile.email,
            profile.handle,
            profile.displayName,
            undefined,
            { userAgent: "UnitTest/1.0", ipHash: "deadbeef".repeat(8) },
          )
          .pipe(Effect.provide(layer)),
      );
      const access = (
        await Effect.runPromise(
          auth
            .issueTokens(
              profile.id,
              profile.accountId,
              profile.email,
              profile.handle,
              profile.displayName,
            )
            .pipe(Effect.provide(layer)),
        )
      ).accessToken;
      const res = await app.handle(
        new Request("http://localhost/sessions", {
          headers: { authorization: `Bearer ${access}` },
        }),
      );
      const json = (await res.json()) as {
        sessions: Array<{ user_agent: string | null; ip_hash_prefix: string | null }>;
      };
      const withUa = json.sessions.find((s) => s.user_agent === "UnitTest/1.0");
      expect(withUa).toBeDefined();
      expect(withUa!.ip_hash_prefix).toBe("deadbeefdead");
    });
  });
});
