import { it, expect, describe } from "@effect/vitest";
import { sessions } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { beforeAll } from "vitest";

import { createAuthService, hashSessionToken } from "../../src/services/auth";
import { createSessionService } from "../../src/services/session";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;
let svc: ReturnType<typeof createSessionService>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
  svc = createSessionService(auth);
});

function seed(ua: string) {
  return Effect.gen(function* () {
    const profile = yield* auth.registerProfile(
      `${ua}@example.com`,
      ua.replace(/\W/g, "").toLowerCase().slice(0, 20),
    );
    const session = yield* auth.issueTokens(
      profile.id,
      profile.accountId,
      profile.email,
      profile.handle,
      profile.displayName,
      undefined,
      { userAgent: ua, ipHash: "abc123def456" + "0".repeat(52) },
    );
    return { profile, session };
  });
}

describe("listSessions", () => {
  it.effect("returns all non-expired sessions for an account, current first when flagged", () =>
    Effect.gen(function* () {
      const { profile, session: first } = yield* seed("alice-iphone");
      // second session on the same account — simulates a laptop
      const second = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        { userAgent: "alice-laptop", ipHash: "f".repeat(64) },
      );

      const currentHash = svc.hashSessionToken(second.refreshToken);
      const result = yield* svc.listSessions(profile.accountId, currentHash);

      expect(result.sessions).toHaveLength(2);
      // The current session sorts based on lastSeenAt (desc); both rows were
      // just inserted so the ordering is insert-order-dependent. Regardless,
      // only one row should be flagged `is_current: true` and it must match
      // the second session's hash.
      const current = result.sessions.find((s) => s.is_current);
      expect(current).toBeDefined();
      expect(current?.id).toBe(svc.hashSessionToken(second.refreshToken));
      // The other row belongs to the first session and is NOT current.
      const other = result.sessions.find((s) => !s.is_current);
      expect(other?.id).toBe(svc.hashSessionToken(first.refreshToken));
      // ipHashPrefix is truncated to 12 chars.
      expect(current?.ip_hash_prefix).toHaveLength(12);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("omits expired sessions from the result", () =>
    Effect.gen(function* () {
      const { profile, session } = yield* seed("expired");
      // Backdate the row's expiry directly so the filter drops it. Faster +
      // more deterministic than Effect.sleep against a short TTL.
      const { db } = yield* Db;
      yield* Effect.tryPromise(() =>
        db
          .update(sessions)
          .set({ expiresAt: 1 })
          .where(eq(sessions.id, hashSessionToken(session.refreshToken))),
      );
      const result = yield* svc.listSessions(profile.accountId, null);
      expect(result.sessions).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns no `is_current` flag when the caller has no cookie", () =>
    Effect.gen(function* () {
      const { profile } = yield* seed("alice-iphone");
      const result = yield* svc.listSessions(profile.accountId, null);
      expect(result.sessions.every((s) => !s.is_current)).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("revokeSession", () => {
  it.effect("revokes a session that belongs to the caller's account", () =>
    Effect.gen(function* () {
      const { profile, session } = yield* seed("alice");
      const sessionId = svc.hashSessionToken(session.refreshToken);
      const result = yield* svc.revokeSession(profile.accountId, sessionId, null);
      expect(result.wasCurrent).toBe(false);

      // Follow-up list is empty.
      const list = yield* svc.listSessions(profile.accountId, null);
      expect(list.sessions).toHaveLength(0);

      // Refresh with the revoked token fails.
      const err = yield* Effect.flip(auth.refreshTokens(session.refreshToken));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("flags wasCurrent=true when revoking the session matching currentSessionHash", () =>
    Effect.gen(function* () {
      const { profile, session } = yield* seed("bob");
      const sessionId = svc.hashSessionToken(session.refreshToken);
      const result = yield* svc.revokeSession(profile.accountId, sessionId, sessionId);
      expect(result.wasCurrent).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails with SessionNotFoundError for cross-account revoke", () =>
    Effect.gen(function* () {
      const a = yield* seed("carol");
      const b = yield* seed("dave");
      const bSessionId = svc.hashSessionToken(b.session.refreshToken);

      // Carol tries to revoke Dave's session — must 404.
      const err = yield* Effect.flip(svc.revokeSession(a.profile.accountId, bSessionId, null));
      expect(err._tag).toBe("SessionNotFoundError");

      // Dave's session must still be usable.
      const refreshed = yield* auth.refreshTokens(b.session.refreshToken);
      expect(refreshed.accessToken.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails with SessionNotFoundError for non-existent session id", () =>
    Effect.gen(function* () {
      const { profile } = yield* seed("eve");
      const fakeId = "a".repeat(64);
      const err = yield* Effect.flip(svc.revokeSession(profile.accountId, fakeId, null));
      expect(err._tag).toBe("SessionNotFoundError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("revokeOtherSessions", () => {
  it.effect("revokes every session except the current one", () =>
    Effect.gen(function* () {
      const { profile, session: first } = yield* seed("frank");
      const second = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        { userAgent: "frank-laptop" },
      );
      const third = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        { userAgent: "frank-ipad" },
      );

      const currentHash = svc.hashSessionToken(second.refreshToken);
      const result = yield* svc.revokeOtherSessions(profile.accountId, currentHash);
      expect(result.revoked).toBe(2);

      // The current session is still valid; the other two aren't.
      const refreshedCurrent = yield* auth.refreshTokens(second.refreshToken);
      expect(refreshedCurrent.accessToken.length).toBeGreaterThan(0);

      const errFirst = yield* Effect.flip(auth.refreshTokens(first.refreshToken));
      expect(errFirst._tag).toBe("AuthError");
      const errThird = yield* Effect.flip(auth.refreshTokens(third.refreshToken));
      expect(errThird._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("revokes every session when no current hash is supplied", () =>
    Effect.gen(function* () {
      const { profile } = yield* seed("grace");
      yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const result = yield* svc.revokeOtherSessions(profile.accountId, null);
      expect(result.revoked).toBe(2);
      const list = yield* svc.listSessions(profile.accountId, null);
      expect(list.sessions).toHaveLength(0);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns revoked=0 when only the current session exists", () =>
    Effect.gen(function* () {
      const { profile, session } = yield* seed("hank");
      const currentHash = svc.hashSessionToken(session.refreshToken);
      const result = yield* svc.revokeOtherSessions(profile.accountId, currentHash);
      expect(result.revoked).toBe(0);
    }).pipe(Effect.provide(createTestLayer())),
  );
});
