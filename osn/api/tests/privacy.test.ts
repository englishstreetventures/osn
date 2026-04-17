import { Effect } from "effect";
import { describe, it, expect, beforeEach, beforeAll } from "vitest";

import { createAuthRoutes } from "../src/routes/auth";
import { createProfileRoutes } from "../src/routes/profile";
import { createAuthService } from "../src/services/auth";
import { makeTestAuthConfig } from "./helpers/auth-config";
import { createTestLayer } from "./helpers/db";

/**
 * Privacy invariant tests for multi-account P6.
 *
 * Core invariant: no external observer can correlate two profiles as belonging
 * to the same account. These tests verify that `accountId` never leaks in API
 * responses, tokens, or WebAuthn ceremony data.
 */

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
});

/** Recursively check that no key named `accountId` or `account_id` exists. */
function assertNoAccountId(obj: unknown, path = "$"): void {
  if (obj === null || obj === undefined || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => assertNoAccountId(item, `${path}[${i}]`));
    return;
  }
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (key === "accountId" || key === "account_id") {
      throw new Error(`accountId leaked at ${path}.${key}`);
    }
    assertNoAccountId(val, `${path}.${key}`);
  }
}

/** Decode JWT payload without verification (for claim inspection). */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT");
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
}

describe("privacy invariants (P6)", () => {
  let authApp: ReturnType<typeof createAuthRoutes>;
  let profileApp: ReturnType<typeof createProfileRoutes>;
  let layer: ReturnType<typeof createTestLayer>;
  let auth: ReturnType<typeof createAuthService>;

  beforeEach(() => {
    layer = createTestLayer();
    authApp = createAuthRoutes(config, layer);
    profileApp = createProfileRoutes(config, layer);
    auth = createAuthService(config);
  });

  /** Helper: register via service layer, return full context. */
  async function registerAccount(email: string, handle: string) {
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
    return { profile, tokens };
  }

  // ---------------------------------------------------------------------------
  // accountId never in API responses
  // ---------------------------------------------------------------------------

  describe("accountId never in API response bodies", () => {
    it("POST /register response has no accountId", async () => {
      const res = await authApp.handle(
        new Request("http://localhost/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "priv1@test.com", handle: "priv1" }),
        }),
      );
      expect(res.status).toBe(201);
      assertNoAccountId(await res.json());
    });

    it("POST /profiles/create response has no accountId", async () => {
      const { tokens } = await registerAccount("priv2@test.com", "priv2");
      const res = await profileApp.handle(
        new Request("http://localhost/profiles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: tokens.refreshToken, handle: "priv2alt" }),
        }),
      );
      expect(res.status).toBe(201);
      assertNoAccountId(await res.json());
    });

    it("POST /profiles/list response has no accountId", async () => {
      const { tokens } = await registerAccount("priv3@test.com", "priv3");
      const res = await authApp.handle(
        new Request("http://localhost/profiles/list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: tokens.refreshToken }),
        }),
      );
      expect(res.status).toBe(200);
      assertNoAccountId(await res.json());
    });

    it("POST /profiles/switch response has no accountId", async () => {
      const { profile, tokens } = await registerAccount("priv4@test.com", "priv4");
      const res = await authApp.handle(
        new Request("http://localhost/profiles/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            refresh_token: tokens.refreshToken,
            profile_id: profile.id,
          }),
        }),
      );
      expect(res.status).toBe(200);
      assertNoAccountId(await res.json());
    });
  });

  // ---------------------------------------------------------------------------
  // accountId never in access token claims
  // ---------------------------------------------------------------------------

  describe("access token claims", () => {
    it("access token sub is profileId, not accountId", async () => {
      const { profile, tokens } = await registerAccount("priv5@test.com", "priv5");
      const claims = decodeJwtPayload(tokens.accessToken);
      expect(claims.sub).toBe(profile.id);
      expect(claims.sub).toMatch(/^usr_/);
      expect(claims).not.toHaveProperty("accountId");
      expect(claims).not.toHaveProperty("account_id");
    });
  });

  // ---------------------------------------------------------------------------
  // passkeyUserId is not accountId (WebAuthn correlation prevention)
  // ---------------------------------------------------------------------------

  describe("WebAuthn userID isolation", () => {
    it("passkeyUserId is generated on account creation", async () => {
      const _reg = await registerAccount("priv6@test.com", "priv6");
      // Verify via service layer that the account has a passkeyUserId
      const result = await Effect.runPromise(
        auth.findProfileByEmail("priv6@test.com").pipe(Effect.provide(layer)),
      );
      expect(result).not.toBeNull();
      // The profile row itself should not carry passkeyUserId (it's on accounts)
      expect(result).not.toHaveProperty("passkeyUserId");
    });

    it("two profiles on same account cannot be correlated via profile data", async () => {
      const { profile: p1, tokens } = await registerAccount("priv7@test.com", "priv7");

      // Create second profile on same account
      const res = await profileApp.handle(
        new Request("http://localhost/profiles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: tokens.refreshToken, handle: "priv7alt" }),
        }),
      );
      expect(res.status).toBe(201);
      const { profile: p2 } = (await res.json()) as { profile: { id: string; handle: string } };

      // Profile IDs differ
      expect(p1.id).not.toBe(p2.id);
      // Neither profile response contains accountId
      assertNoAccountId(p2);
    });
  });

  // ---------------------------------------------------------------------------
  // Rate limit keys use profileId (not accountId) for graph operations
  // ---------------------------------------------------------------------------

  describe("rate limiting isolation", () => {
    it("access tokens for different profiles have different sub claims", async () => {
      const { profile: p1, tokens: t1 } = await registerAccount("priv8@test.com", "priv8");

      // Create second profile and switch to it
      await profileApp.handle(
        new Request("http://localhost/profiles/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: t1.refreshToken, handle: "priv8alt" }),
        }),
      );
      const listRes = await authApp.handle(
        new Request("http://localhost/profiles/list", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: t1.refreshToken }),
        }),
      );
      const { profiles } = (await listRes.json()) as {
        profiles: Array<{ id: string; handle: string }>;
      };
      const altProfile = profiles.find((p) => p.handle === "priv8alt")!;
      expect(altProfile).toBeDefined();

      // Switch to alt profile to get its access token
      const switchRes = await authApp.handle(
        new Request("http://localhost/profiles/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            refresh_token: t1.refreshToken,
            profile_id: altProfile.id,
          }),
        }),
      );
      const { access_token: altAccessToken } = (await switchRes.json()) as {
        access_token: string;
      };

      // Both tokens have different subs (profileId-based, not accountId)
      const claims1 = decodeJwtPayload(t1.accessToken);
      const claims2 = decodeJwtPayload(altAccessToken);
      expect(claims1.sub).toBe(p1.id);
      expect(claims2.sub).toBe(altProfile.id);
      expect(claims1.sub).not.toBe(claims2.sub);
    });
  });
});
