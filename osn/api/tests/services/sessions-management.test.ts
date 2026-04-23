import { it, expect, describe } from "@effect/vitest";
import { Effect } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

/**
 * Session list/revoke behaviour:
 *   • Listing returns sessions scoped to the caller's account only; other
 *     accounts' rows never leak across the join.
 *   • Revoke uses the short public handle (first 16 hex of the hash) and
 *     refuses handles that don't belong to the caller's account.
 *   • revokeAllOther keeps the caller's current session alive and kills
 *     the rest — the Settings "sign out everywhere else" surface.
 */

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
});

describe("listAccountSessions", () => {
  it.effect("returns all sessions for the account and flags the caller's current one", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("list-s@example.com", "lists");
      const t1 = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        { uaLabel: "Firefox on macOS" },
      );
      const t2 = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        { uaLabel: "Safari on iOS" },
      );

      const currentHash = auth.hashSessionToken(t1.refreshToken);
      const { sessions } = yield* auth.listAccountSessions(profile.accountId, currentHash);
      expect(sessions).toHaveLength(2);
      expect(sessions.some((s) => s.isCurrent)).toBe(true);
      expect(sessions.every((s) => /^[0-9a-f]{16}$/.test(s.id))).toBe(true);
      // Metadata surfaced.
      expect(sessions.map((s) => s.uaLabel).toSorted()).toEqual([
        "Firefox on macOS",
        "Safari on iOS",
      ]);
      void t2;
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("does not expose sessions from other accounts", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("list-a@example.com", "lista");
      const bob = yield* auth.registerProfile("list-b@example.com", "listb");
      yield* auth.issueTokens(
        alice.id,
        alice.accountId,
        alice.email,
        alice.handle,
        alice.displayName,
      );
      yield* auth.issueTokens(bob.id, bob.accountId, bob.email, bob.handle, bob.displayName);

      const { sessions } = yield* auth.listAccountSessions(alice.accountId, null);
      expect(sessions).toHaveLength(1);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("revokeAccountSession", () => {
  it.effect("revokes a non-current session and leaves the current one intact", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("rev-s@example.com", "revs");
      const me = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const other = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const meHash = auth.hashSessionToken(me.refreshToken);
      const otherHash = auth.hashSessionToken(other.refreshToken);

      const result = yield* auth.revokeAccountSession(
        profile.accountId,
        otherHash.slice(0, 16),
        meHash,
      );
      expect(result.revokedSelf).toBe(false);

      // Our session is still valid.
      yield* auth.verifyRefreshToken(me.refreshToken);
      // Theirs isn't.
      const err = yield* Effect.flip(auth.verifyRefreshToken(other.refreshToken));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("revoking your own session reports revokedSelf=true", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("rev-me@example.com", "revme");
      const me = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const meHash = auth.hashSessionToken(me.refreshToken);
      const result = yield* auth.revokeAccountSession(
        profile.accountId,
        meHash.slice(0, 16),
        meHash,
      );
      expect(result.revokedSelf).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  // S-M4: idempotent — a handle from another account (or a made-up one)
  // returns { revokedSelf: false } rather than surfacing "Session not
  // found", so revoke can't be weaponised as a handle-existence oracle.
  it.effect("silently ignores a handle that doesn't belong to the caller's account", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("rev-a@example.com", "reva");
      const bob = yield* auth.registerProfile("rev-b@example.com", "revb");
      const bobSess = yield* auth.issueTokens(
        bob.id,
        bob.accountId,
        bob.email,
        bob.handle,
        bob.displayName,
      );
      const bobHandle = auth.hashSessionToken(bobSess.refreshToken).slice(0, 16);
      const result = yield* auth.revokeAccountSession(alice.accountId, bobHandle, null);
      expect(result.revokedSelf).toBe(false);
      // Bob's session must still be alive.
      yield* auth.verifyRefreshToken(bobSess.refreshToken);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// T-S2: session rotation (C2) must preserve the uaLabel / ipHash it was
// issued with. Otherwise the Settings "Firefox on macOS" device flips to
// "Unknown device" on every refresh — a subtle UX regression that doesn't
// fail any existing assertion.
describe("session metadata carry-through on rotation", () => {
  it.effect("refreshTokens copies uaLabel to the rotated session row", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("rot-meta@example.com", "rotmeta");
      const original = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        { uaLabel: "Firefox on macOS" },
      );

      const rotated = yield* auth.refreshTokens(original.refreshToken);

      const { sessions } = yield* auth.listAccountSessions(
        profile.accountId,
        auth.hashSessionToken(rotated.refreshToken),
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.uaLabel).toBe("Firefox on macOS");
      expect(sessions[0]!.isCurrent).toBe(true);
      // lastUsedAt must be populated on the fresh row (rotation timestamp).
      expect(sessions[0]!.lastUsedAt).not.toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("revokeAllOtherAccountSessions", () => {
  it.effect("keeps the current session and kills the rest", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("revall@example.com", "revall");
      const me = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const other1 = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const other2 = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );

      yield* auth.revokeAllOtherAccountSessions(
        profile.accountId,
        auth.hashSessionToken(me.refreshToken),
      );
      yield* auth.verifyRefreshToken(me.refreshToken);
      const e1 = yield* Effect.flip(auth.verifyRefreshToken(other1.refreshToken));
      const e2 = yield* Effect.flip(auth.verifyRefreshToken(other2.refreshToken));
      expect(e1._tag).toBe("AuthError");
      expect(e2._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});
