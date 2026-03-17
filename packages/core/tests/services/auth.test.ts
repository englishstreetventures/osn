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

describe("upsertUser", () => {
  it.effect("creates a new user with usr_ prefix", () =>
    Effect.gen(function* () {
      const user = yield* auth.upsertUser("alice@example.com");
      expect(user.id).toMatch(/^usr_/);
      expect(user.email).toBe("alice@example.com");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns the existing user on subsequent calls", () =>
    Effect.gen(function* () {
      const first = yield* auth.upsertUser("bob@example.com");
      const second = yield* auth.upsertUser("bob@example.com");
      expect(first.id).toBe(second.id);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("findUserByEmail", () => {
  it.effect("returns null when user does not exist", () =>
    Effect.gen(function* () {
      const result = yield* auth.findUserByEmail("nobody@example.com");
      expect(result).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns the user after insertion", () =>
    Effect.gen(function* () {
      yield* auth.upsertUser("carol@example.com");
      const result = yield* auth.findUserByEmail("carol@example.com");
      expect(result).not.toBeNull();
      expect(result!.email).toBe("carol@example.com");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("issueTokens + exchangeCode", () => {
  it.effect("issueTokens returns access + refresh tokens with correct shape", () =>
    Effect.gen(function* () {
      const user = yield* auth.upsertUser("dan@example.com");
      const tokens = yield* auth.issueTokens(user.id, user.email);
      expect(tokens.accessToken).toBeTruthy();
      expect(tokens.refreshToken).toBeTruthy();
      expect(tokens.expiresIn).toBe(3600);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("exchangeCode returns tokens for a valid auth code", () =>
    Effect.gen(function* () {
      const user = yield* auth.upsertUser("dan-exchange@example.com");
      // Get a real code via completeOtp
      let capturedCode: string | undefined;
      const authSpy = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const m = body.match(/code is: (\d{6})/);
          if (m) capturedCode = m[1];
        },
      });
      yield* authSpy.beginOtp("dan-exchange@example.com");
      const { code } = yield* authSpy.completeOtp("dan-exchange@example.com", capturedCode!);
      const tokens = yield* auth.exchangeCode(code);
      expect(tokens.accessToken).toBeTruthy();
      expect(tokens.refreshToken).toBeTruthy();
      expect(tokens.expiresIn).toBe(3600);
      // Access token should be verifiable
      const claims = yield* auth.verifyAccessToken(tokens.accessToken);
      expect(claims.userId).toBe(user.id);
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
  it.effect("beginOtp + completeOtp issues a code", () =>
    Effect.gen(function* () {
      let capturedCode: string | undefined;
      const authWithSpy = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const match = body.match(/code is: (\d{6})/);
          if (match) capturedCode = match[1];
        },
      });

      yield* authWithSpy.beginOtp("eve@example.com");
      expect(capturedCode).toMatch(/^\d{6}$/);

      const result = yield* authWithSpy.completeOtp("eve@example.com", capturedCode!);
      expect(result.code).toBeTruthy();
      expect(result.userId).toMatch(/^usr_/);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("completeOtp fails with wrong code", () =>
    Effect.gen(function* () {
      yield* auth.beginOtp("frank@example.com");
      const error = yield* Effect.flip(auth.completeOtp("frank@example.com", "000000"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("beginOtp fails with invalid email", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.beginOtp("not-an-email"));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("second beginOtp overwrites the first code", () =>
    Effect.gen(function* () {
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
      yield* authSpy.beginOtp("overwrite@example.com");
      yield* authSpy.beginOtp("overwrite@example.com");
      // The first code is no longer valid — the store was overwritten
      const error = yield* Effect.flip(authSpy.completeOtp("overwrite@example.com", firstCode!));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("passkey registration", () => {
  it.effect("beginPasskeyRegistration returns options for an existing user", () =>
    Effect.gen(function* () {
      const user = yield* auth.upsertUser("passkey-reg@example.com");
      const result = yield* auth.beginPasskeyRegistration(user.id);
      expect(result.options).toBeTruthy();
      expect(result.options.challenge).toBeTruthy();
      expect(result.options.user.name).toBe("passkey-reg@example.com");
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
  it.effect("beginMagic + verifyMagic redirects correctly", () =>
    Effect.gen(function* () {
      let capturedToken: string | undefined;
      const authWithSpy = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const match = body.match(/token=([^\s]+)/);
          if (match) capturedToken = match[1];
        },
      });

      yield* authWithSpy.beginMagic("grace@example.com");
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

  it.effect("verifyMagic fails with unknown token", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        auth.verifyMagic("bad-token", "http://localhost:5173/callback", "state"),
      );
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("beginMagic fails with invalid email", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.beginMagic("not-an-email"));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("token refresh", () => {
  it.effect("refreshTokens issues new tokens from a valid refresh token", () =>
    Effect.gen(function* () {
      const user = yield* auth.upsertUser("heidi@example.com");
      const tokens = yield* auth.issueTokens(user.id, user.email);
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
  it.effect("verifies a valid access token", () =>
    Effect.gen(function* () {
      const user = yield* auth.upsertUser("ivan@example.com");
      const tokens = yield* auth.issueTokens(user.id, user.email);
      const claims = yield* auth.verifyAccessToken(tokens.accessToken);
      expect(claims.userId).toBe(user.id);
      expect(claims.email).toBe("ivan@example.com");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails on a tampered token", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.verifyAccessToken("not.a.token"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});
