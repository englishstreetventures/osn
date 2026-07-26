import { it, expect, describe } from "@effect/vitest";
import { users } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { Effect } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

/**
 * `osn_sid` — the access token's one-way binding to the session it was minted
 * from. It exists so a Bearer-only caller (cross-origin, cookie-stripping
 * proxy, native client) can still name its OWN session; before it existed
 * those callers looked sessionless and the passkey add/remove paths revoked
 * every session on the account.
 *
 * The binding is `sha256(sessionHash + ":" + profileId)` truncated to 128
 * bits, so it is per-profile: two profiles of one account never share a
 * value, which preserves P6 (an access token must not let an observer
 * correlate two profiles of the same account).
 */

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
});

describe("session binding (osn_sid)", () => {
  it.effect("issueTokens mints a binding that resolves back to that session", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("sid-mint@example.com", "sidmint");
      const t1 = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const t2 = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );

      const claims = yield* auth.verifyAccessToken(t1.accessToken);
      expect(claims.sessionBinding).toMatch(/^[0-9a-f]{32}$/);

      const resolved = yield* auth.resolveSessionByBinding(
        profile.accountId,
        profile.id,
        claims.sessionBinding!,
      );
      expect(resolved).toBe(auth.hashSessionToken(t1.refreshToken));
      expect(resolved).not.toBe(auth.hashSessionToken(t2.refreshToken));
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a binding from another profile of the same account does not resolve", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("sid-profile@example.com", "sidprofile");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      // Second profile on the SAME account — the session is account-scoped
      // and shared, but its binding must differ per profile (P6).
      const { db } = yield* Db;
      const secondId = "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      const ts = new Date();
      yield* Effect.promise(() =>
        db.insert(users).values({
          id: secondId,
          accountId: profile.accountId,
          handle: "sidprofile2",
          displayName: "Second",
          avatarUrl: null,
          isDefault: false,
          createdAt: ts,
          updatedAt: ts,
        }),
      );

      const claims = yield* auth.verifyAccessToken(tokens.accessToken);
      const wrongProfile = yield* auth.resolveSessionByBinding(
        profile.accountId,
        secondId,
        claims.sessionBinding!,
      );
      expect(wrongProfile).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("switchProfile re-derives the binding for the target profile", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("sid-switch@example.com", "sidswitch");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const { db } = yield* Db;
      const secondId = "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      const ts = new Date();
      yield* Effect.promise(() =>
        db.insert(users).values({
          id: secondId,
          accountId: profile.accountId,
          handle: "sidswitch2",
          displayName: "Second",
          avatarUrl: null,
          isDefault: false,
          createdAt: ts,
          updatedAt: ts,
        }),
      );

      const claims = yield* auth.verifyAccessToken(tokens.accessToken);
      const switched = yield* auth.switchProfile(profile.accountId, secondId, {
        profileId: profile.id,
        sessionBinding: claims.sessionBinding,
      });
      const switchedClaims = yield* auth.verifyAccessToken(switched.accessToken);

      // Same underlying session, different value on the wire (P6)...
      expect(switchedClaims.sessionBinding).not.toBe(claims.sessionBinding);
      // ...and it resolves to that session under the NEW profile.
      const resolved = yield* auth.resolveSessionByBinding(
        profile.accountId,
        secondId,
        switchedClaims.sessionBinding!,
      );
      expect(resolved).toBe(auth.hashSessionToken(tokens.refreshToken));
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("switchProfile leaves the binding unset when the caller has none", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("sid-unbound@example.com", "sidunbound");
      const switched = yield* auth.switchProfile(profile.accountId, profile.id);
      const claims = yield* auth.verifyAccessToken(switched.accessToken);
      expect(claims.sessionBinding).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("refreshTokens binds the new access token to the rotated-in session", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("sid-rotate@example.com", "sidrotate");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const rotated = yield* auth.refreshTokens(tokens.refreshToken);
      const claims = yield* auth.verifyAccessToken(rotated.accessToken);

      const resolved = yield* auth.resolveSessionByBinding(
        profile.accountId,
        profile.id,
        claims.sessionBinding!,
      );
      // The rotated-in session, not the one that was just consumed.
      expect(resolved).toBe(auth.hashSessionToken(rotated.refreshToken));
      expect(resolved).not.toBe(auth.hashSessionToken(tokens.refreshToken));
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("a binding never resolves against a different account's sessions", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("sid-alice@example.com", "sidalice");
      const bob = yield* auth.registerProfile("sid-bob@example.com", "sidbob");
      const tokens = yield* auth.issueTokens(
        alice.id,
        alice.accountId,
        alice.email,
        alice.handle,
        alice.displayName,
      );
      yield* auth.issueTokens(bob.id, bob.accountId, bob.email, bob.handle, bob.displayName);

      const claims = yield* auth.verifyAccessToken(tokens.accessToken);
      const resolved = yield* auth.resolveSessionByBinding(
        bob.accountId,
        alice.id,
        claims.sessionBinding!,
      );
      expect(resolved).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );
});
