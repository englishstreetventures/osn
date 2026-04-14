import { Effect } from "effect";
import { describe, it, expect, beforeEach } from "vitest";

import type { RateLimiterBackend } from "../../src/lib/rate-limit";
import { createProfileRoutes } from "../../src/routes/profile";
import { createAuthService } from "../../src/services/auth";
import { createTestLayer } from "../helpers/db";

const config = {
  rpId: "localhost",
  rpName: "OSN Test",
  origin: "http://localhost:5173",
  issuerUrl: "http://localhost:4000",
  jwtSecret: "test-secret-at-least-32-characters-long",
};

describe("profile routes", () => {
  let profileApp: ReturnType<typeof createProfileRoutes>;
  let layer: ReturnType<typeof createTestLayer>;
  let auth: ReturnType<typeof createAuthService>;

  beforeEach(() => {
    layer = createTestLayer();
    profileApp = createProfileRoutes(config, layer);
    auth = createAuthService(config);
  });

  /** Helper: register + get refresh token via service layer. */
  async function getRefreshToken(email: string, handle: string): Promise<string> {
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
    return tokens.refreshToken;
  }

  // -------------------------------------------------------------------------
  // POST /profiles/create
  // -------------------------------------------------------------------------
  describe("POST /profiles/create", () => {
    it("returns 201 on success with profile data", async () => {
      const rt = await getRefreshToken("pc@test.com", "pcuser");
      const res = await profileApp.handle(
        new Request("http://localhost/profiles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: rt, handle: "pc_alt" }),
        }),
      );
      expect(res.status).toBe(201);
      const json = (await res.json()) as { profile: { id: string; handle: string } };
      expect(json.profile.handle).toBe("pc_alt");
      expect(json.profile.id).toMatch(/^usr_/);
    });

    it("returns 400 for invalid handle", async () => {
      const rt = await getRefreshToken("bad@test.com", "baduser");
      const res = await profileApp.handle(
        new Request("http://localhost/profiles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: rt, handle: "BADHANDLE" }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid refresh token", async () => {
      const res = await profileApp.handle(
        new Request("http://localhost/profiles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: "bad-token", handle: "somehandle" }),
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // POST /profiles/delete
  // -------------------------------------------------------------------------
  describe("POST /profiles/delete", () => {
    it("returns 200 on success", async () => {
      const rt = await getRefreshToken("pd@test.com", "pduser");
      // Create a second profile first
      const createRes = await profileApp.handle(
        new Request("http://localhost/profiles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: rt, handle: "pd_alt" }),
        }),
      );
      const { profile: created } = (await createRes.json()) as {
        profile: { id: string };
      };

      const res = await profileApp.handle(
        new Request("http://localhost/profiles/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: rt, profile_id: created.id }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { deleted: boolean };
      expect(json.deleted).toBe(true);
    });

    it("returns 400 for deleting the last profile", async () => {
      const p = await Effect.runPromise(
        auth.registerProfile("lastrd@test.com", "lastrduser").pipe(Effect.provide(layer)),
      );
      const tokens = await Effect.runPromise(
        auth
          .issueTokens(p.id, p.accountId, p.email, p.handle, p.displayName)
          .pipe(Effect.provide(layer)),
      );
      const res = await profileApp.handle(
        new Request("http://localhost/profiles/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: tokens.refreshToken, profile_id: p.id }),
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // POST /profiles/:profileId/default
  // -------------------------------------------------------------------------
  describe("POST /profiles/:profileId/default", () => {
    it("returns 200 on success with profile data", async () => {
      const rt = await getRefreshToken("sd@test.com", "sduser");
      const createRes = await profileApp.handle(
        new Request("http://localhost/profiles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: rt, handle: "sd_alt" }),
        }),
      );
      const { profile: created } = (await createRes.json()) as {
        profile: { id: string; handle: string };
      };

      const res = await profileApp.handle(
        new Request(`http://localhost/profiles/${created.id}/default`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: rt }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { profile: { id: string; handle: string } };
      expect(json.profile.handle).toBe("sd_alt");
    });

    it("returns 400 for invalid refresh token", async () => {
      const res = await profileApp.handle(
        new Request("http://localhost/profiles/usr_000000000000/default", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: "bad-token" }),
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Rate limiting (T-R1)
  // -------------------------------------------------------------------------
  describe("rate limiting", () => {
    it("returns 429 after exceeding rate limit on /profiles/create", async () => {
      const freshApp = createProfileRoutes(config, layer);
      const rt = await getRefreshToken("rl1@test.com", "rl1user");
      // profileCreate allows 5 req/min
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
        await freshApp.handle(
          new Request("http://localhost/profiles/create", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.4" },
            body: JSON.stringify({ refresh_token: rt, handle: `rl1_alt${i}` }),
          }),
        );
      }
      const blocked = await freshApp.handle(
        new Request("http://localhost/profiles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.4" },
          body: JSON.stringify({ refresh_token: rt, handle: "rl1_blocked" }),
        }),
      );
      expect(blocked.status).toBe(429);
      const json = (await blocked.json()) as { error: string };
      expect(json.error).toBe("rate_limited");
    });

    it("returns 429 after exceeding rate limit on /profiles/delete", async () => {
      const freshApp = createProfileRoutes(config, layer);
      const rt = await getRefreshToken("rl2@test.com", "rl2user");
      // profileDelete allows 5 req/min — fire 5 requests (they may fail as 400, that's fine)
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
        await freshApp.handle(
          new Request("http://localhost/profiles/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "2.2.2.2" },
            body: JSON.stringify({ refresh_token: rt, profile_id: `usr_00000000000${i}` }),
          }),
        );
      }
      const blocked = await freshApp.handle(
        new Request("http://localhost/profiles/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "2.2.2.2" },
          body: JSON.stringify({ refresh_token: rt, profile_id: "usr_000000000099" }),
        }),
      );
      expect(blocked.status).toBe(429);
    });

    it("returns 429 after exceeding rate limit on /profiles/:profileId/default", async () => {
      const freshApp = createProfileRoutes(config, layer);
      const rt = await getRefreshToken("rl3@test.com", "rl3user");
      // profileSetDefault allows 10 req/min
      for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
        await freshApp.handle(
          new Request("http://localhost/profiles/usr_000000000000/default", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "3.3.3.3" },
            body: JSON.stringify({ refresh_token: rt }),
          }),
        );
      }
      const blocked = await freshApp.handle(
        new Request("http://localhost/profiles/usr_000000000000/default", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "3.3.3.3" },
          body: JSON.stringify({ refresh_token: rt }),
        }),
      );
      expect(blocked.status).toBe(429);
    });

    it("rate limits are per-IP — different IPs are independent", async () => {
      const freshApp = createProfileRoutes(config, layer);
      const rt = await getRefreshToken("rl4@test.com", "rl4user");
      // Exhaust limit for IP A
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop -- sequential dispatch required for rate-limit correctness
        await freshApp.handle(
          new Request("http://localhost/profiles/create", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-forwarded-for": "10.0.0.1" },
            body: JSON.stringify({ refresh_token: rt, handle: `rl4_a${i}` }),
          }),
        );
      }
      // IP A is blocked
      const blockedA = await freshApp.handle(
        new Request("http://localhost/profiles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "10.0.0.1" },
          body: JSON.stringify({ refresh_token: rt, handle: "rl4_blocked" }),
        }),
      );
      expect(blockedA.status).toBe(429);
      // IP B is not blocked
      const allowedB = await freshApp.handle(
        new Request("http://localhost/profiles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "10.0.0.2" },
          body: JSON.stringify({ refresh_token: rt, handle: "rl4_b" }),
        }),
      );
      expect(allowedB.status).not.toBe(429);
    });

    it("uses injected reject-all rate limiter", async () => {
      const rejectAll: RateLimiterBackend = { check: async () => false };
      const freshApp = createProfileRoutes(config, layer, undefined, {
        profileCreate: rejectAll,
        profileDelete: rejectAll,
        profileSetDefault: rejectAll,
      });
      const rt = await getRefreshToken("rl5@test.com", "rl5user");
      const res = await freshApp.handle(
        new Request("http://localhost/profiles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: rt, handle: "rl5_alt" }),
        }),
      );
      expect(res.status).toBe(429);
    });

    it("fails closed when rate limiter backend throws (S-M1)", async () => {
      const brokenBackend: RateLimiterBackend = {
        check: async () => {
          throw new Error("Redis connection refused");
        },
      };
      const freshApp = createProfileRoutes(config, layer, undefined, {
        profileCreate: brokenBackend,
        profileDelete: brokenBackend,
        profileSetDefault: brokenBackend,
      });
      const rt = await getRefreshToken("rl6@test.com", "rl6user");
      const res = await freshApp.handle(
        new Request("http://localhost/profiles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: rt, handle: "rl6_alt" }),
        }),
      );
      expect(res.status).toBe(429);
    });
  });
});
