import { it, expect, describe } from "@effect/vitest";
import { Effect } from "effect";
import { createTestLayer } from "../helpers/db";
import { createAuthService } from "../../src/services/auth";

const config = {
  rpId: "localhost",
  rpName: "OSN Test",
  origin: "http://localhost:5173",
  issuerUrl: "http://localhost:4000",
  jwtSecret: "test-secret-at-least-32-characters-long",
};

const auth = createAuthService(config);

describe("registerUser", () => {
  it.effect("creates a new user with usr_ prefix and correct fields", () =>
    Effect.gen(function* () {
      const user = yield* auth.registerUser("alice@example.com", "alice", "Alice");
      expect(user.id).toMatch(/^usr_/);
      expect(user.email).toBe("alice@example.com");
      expect(user.handle).toBe("alice");
      expect(user.displayName).toBe("Alice");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("creates user without displayName", () =>
    Effect.gen(function* () {
      const user = yield* auth.registerUser("bob@example.com", "bob");
      expect(user.handle).toBe("bob");
      expect(user.displayName).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails if email already registered", () =>
    Effect.gen(function* () {
      yield* auth.registerUser("carol@example.com", "carol");
      const error = yield* Effect.flip(auth.registerUser("carol@example.com", "carol2"));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Email already registered");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails if handle already taken", () =>
    Effect.gen(function* () {
      yield* auth.registerUser("dan@example.com", "dan");
      const error = yield* Effect.flip(auth.registerUser("dan2@example.com", "dan"));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Handle already taken");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails with invalid email format", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.registerUser("not-an-email", "myhandle"));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails with invalid handle format (uppercase)", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.registerUser("eve@example.com", "Eve"));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails with invalid handle format (too long)", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.registerUser("frank@example.com", "a".repeat(31)));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("checkHandle", () => {
  it.effect("returns available:true for a free handle", () =>
    Effect.gen(function* () {
      const result = yield* auth.checkHandle("freehandle");
      expect(result.available).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns available:false for a taken handle", () =>
    Effect.gen(function* () {
      yield* auth.registerUser("grace@example.com", "grace");
      const result = yield* auth.checkHandle("grace");
      expect(result.available).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails with ValidationError for invalid format", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.checkHandle("INVALID!"));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("findUserByEmail + findUserByHandle", () => {
  it.effect("returns null when user does not exist", () =>
    Effect.gen(function* () {
      const byEmail = yield* auth.findUserByEmail("nobody@example.com");
      const byHandle = yield* auth.findUserByHandle("nobody");
      expect(byEmail).toBeNull();
      expect(byHandle).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("finds user by email and by handle", () =>
    Effect.gen(function* () {
      yield* auth.registerUser("heidi@example.com", "heidi");
      const byEmail = yield* auth.findUserByEmail("heidi@example.com");
      const byHandle = yield* auth.findUserByHandle("heidi");
      expect(byEmail).not.toBeNull();
      expect(byHandle).not.toBeNull();
      expect(byEmail!.id).toBe(byHandle!.id);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("issueTokens + exchangeCode", () => {
  it.effect("issueTokens returns access + refresh tokens with handle in payload", () =>
    Effect.gen(function* () {
      const user = yield* auth.registerUser("ivan@example.com", "ivan", "Ivan");
      const tokens = yield* auth.issueTokens(user.id, user.email, user.handle, user.displayName);
      expect(tokens.accessToken).toBeTruthy();
      expect(tokens.refreshToken).toBeTruthy();
      expect(tokens.expiresIn).toBe(3600);

      // Verify claims include handle and displayName
      const claims = yield* auth.verifyAccessToken(tokens.accessToken);
      expect(claims.handle).toBe("ivan");
      expect(claims.displayName).toBe("Ivan");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("exchangeCode returns tokens for a valid auth code", () =>
    Effect.gen(function* () {
      const user = yield* auth.registerUser("judy@example.com", "judy");
      let capturedCode: string | undefined;
      const authSpy = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const m = body.match(/code is: (\d{6})/);
          if (m) capturedCode = m[1];
        },
      });
      yield* authSpy.beginOtp("judy@example.com");
      const { code } = yield* authSpy.completeOtp("judy@example.com", capturedCode!);
      const tokens = yield* auth.exchangeCode(code);
      expect(tokens.accessToken).toBeTruthy();
      const claims = yield* auth.verifyAccessToken(tokens.accessToken);
      expect(claims.userId).toBe(user.id);
      expect(claims.handle).toBe("judy");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("exchangeCode fails with invalid code", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.exchangeCode("not.a.valid.jwt"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("OTP flow", () => {
  it.effect("beginOtp + completeOtp via email identifier issues a code", () =>
    Effect.gen(function* () {
      yield* auth.registerUser("kate@example.com", "kate");
      let capturedCode: string | undefined;
      const authWithSpy = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const match = body.match(/code is: (\d{6})/);
          if (match) capturedCode = match[1];
        },
      });

      yield* authWithSpy.beginOtp("kate@example.com");
      expect(capturedCode).toMatch(/^\d{6}$/);

      const result = yield* authWithSpy.completeOtp("kate@example.com", capturedCode!);
      expect(result.code).toBeTruthy();
      expect(result.userId).toMatch(/^usr_/);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("beginOtp + completeOtp via handle identifier issues a code", () =>
    Effect.gen(function* () {
      yield* auth.registerUser("liam@example.com", "liam");
      let capturedCode: string | undefined;
      const authWithSpy = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const match = body.match(/code is: (\d{6})/);
          if (match) capturedCode = match[1];
        },
      });

      yield* authWithSpy.beginOtp("liam"); // handle, not email
      expect(capturedCode).toMatch(/^\d{6}$/);

      const result = yield* authWithSpy.completeOtp("liam", capturedCode!);
      expect(result.code).toBeTruthy();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("beginOtp fails when user does not exist", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.beginOtp("ghost@example.com"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("completeOtp fails with wrong code", () =>
    Effect.gen(function* () {
      yield* auth.registerUser("mia@example.com", "mia");
      yield* auth.beginOtp("mia@example.com");
      const error = yield* Effect.flip(auth.completeOtp("mia@example.com", "000000"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("beginOtp fails with invalid email format", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.beginOtp("not-an-email@"));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("beginOtp fails with invalid handle format", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.beginOtp("INVALID!"));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("second beginOtp overwrites the first code", () =>
    Effect.gen(function* () {
      yield* auth.registerUser("noah@example.com", "noah");
      let firstCode: string | undefined;
      let callCount = 0;
      const authSpy = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const m = body.match(/code is: (\d{6})/);
          if (m) {
            callCount++;
            if (callCount === 1) firstCode = m[1];
          }
        },
      });
      yield* authSpy.beginOtp("noah@example.com");
      yield* authSpy.beginOtp("noah@example.com");
      const error = yield* Effect.flip(authSpy.completeOtp("noah@example.com", firstCode!));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("passkey registration", () => {
  it.effect("beginPasskeyRegistration returns options with @handle as userName", () =>
    Effect.gen(function* () {
      const user = yield* auth.registerUser("passkey@example.com", "passkeyuser");
      const result = yield* auth.beginPasskeyRegistration(user.id);
      expect(result.options).toBeTruthy();
      expect(result.options.challenge).toBeTruthy();
      expect(result.options.user.name).toBe("@passkeyuser");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("beginPasskeyRegistration fails for an unknown userId", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.beginPasskeyRegistration("usr_nonexistent"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("magic link flow", () => {
  it.effect("beginMagic + verifyMagic via email redirects correctly", () =>
    Effect.gen(function* () {
      yield* auth.registerUser("oliver@example.com", "oliver");
      let capturedToken: string | undefined;
      const authWithSpy = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const match = body.match(/token=([^\s]+)/);
          if (match) capturedToken = match[1];
        },
      });

      yield* authWithSpy.beginMagic("oliver@example.com");
      expect(capturedToken).toBeTruthy();

      const result = yield* authWithSpy.verifyMagic(
        capturedToken!,
        "http://localhost:5173/callback",
        "some-state",
      );
      expect(result.redirectUrl).toContain("code=");
      expect(result.redirectUrl).toContain("state=some-state");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("beginMagic via handle finds and emails the user", () =>
    Effect.gen(function* () {
      yield* auth.registerUser("petra@example.com", "petra");
      let emailedTo: string | undefined;
      const authWithSpy = createAuthService({
        ...config,
        sendEmail: async (to) => {
          emailedTo = to;
        },
      });

      yield* authWithSpy.beginMagic("petra"); // handle
      expect(emailedTo).toBe("petra@example.com");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("beginMagic fails when user does not exist", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.beginMagic("ghost@example.com"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("verifyMagic fails with unknown token", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        auth.verifyMagic("bad-token", "http://localhost:5173/callback", "state"),
      );
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("token refresh", () => {
  it.effect("refreshTokens issues new tokens from a valid refresh token", () =>
    Effect.gen(function* () {
      const user = yield* auth.registerUser("quinn@example.com", "quinn");
      const tokens = yield* auth.issueTokens(user.id, user.email, user.handle, user.displayName);
      const refreshed = yield* auth.refreshTokens(tokens.refreshToken);
      expect(refreshed.accessToken).toBeTruthy();
      expect(refreshed.expiresIn).toBe(3600);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("refreshTokens fails with an invalid token", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.refreshTokens("not.a.token"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("verifyAccessToken", () => {
  it.effect("verifies a valid access token and returns all claims", () =>
    Effect.gen(function* () {
      const user = yield* auth.registerUser("rose@example.com", "rose", "Rose");
      const tokens = yield* auth.issueTokens(user.id, user.email, user.handle, user.displayName);
      const claims = yield* auth.verifyAccessToken(tokens.accessToken);
      expect(claims.userId).toBe(user.id);
      expect(claims.email).toBe("rose@example.com");
      expect(claims.handle).toBe("rose");
      expect(claims.displayName).toBe("Rose");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("displayName is null when not set", () =>
    Effect.gen(function* () {
      const user = yield* auth.registerUser("sam@example.com", "sam");
      const tokens = yield* auth.issueTokens(user.id, user.email, user.handle, user.displayName);
      const claims = yield* auth.verifyAccessToken(tokens.accessToken);
      expect(claims.displayName).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails on a tampered token", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.verifyAccessToken("not.a.token"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});
