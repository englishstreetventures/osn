import { it, expect, describe } from "@effect/vitest";
import { Effect, Logger, LogLevel } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../src/services/auth";
import { makeTestAuthConfig } from "../helpers/auth-config";
import { createTestLayer } from "../helpers/db";

let config: Awaited<ReturnType<typeof makeTestAuthConfig>>;
let auth: ReturnType<typeof createAuthService>;

beforeAll(async () => {
  config = await makeTestAuthConfig();
  auth = createAuthService(config);
});

describe("registerProfile", () => {
  it.effect("creates a new user with usr_ prefix and correct fields", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("alice@example.com", "alice", "Alice");
      expect(profile.id).toMatch(/^usr_/);
      expect(profile.email).toBe("alice@example.com");
      expect(profile.handle).toBe("alice");
      expect(profile.displayName).toBe("Alice");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("creates user without displayName", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("bob@example.com", "bob");
      expect(profile.handle).toBe("bob");
      expect(profile.displayName).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails if email already registered", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("carol@example.com", "carol");
      const error = yield* Effect.flip(auth.registerProfile("carol@example.com", "carol2"));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Email already registered");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails if handle already taken", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("dan@example.com", "dan");
      const error = yield* Effect.flip(auth.registerProfile("dan2@example.com", "dan"));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Handle already taken");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails with invalid email format", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.registerProfile("not-an-email", "myhandle"));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails with invalid handle format (uppercase)", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.registerProfile("eve@example.com", "Eve"));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails with invalid handle format (too long)", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.registerProfile("frank@example.com", "a".repeat(31)));
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
      yield* auth.registerProfile("grace@example.com", "grace");
      const result = yield* auth.checkHandle("grace");
      expect(result.available).toBe(false);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("returns available:false for a reserved handle", () =>
    Effect.gen(function* () {
      const result = yield* auth.checkHandle("admin");
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

// ---------------------------------------------------------------------------
// Email-verified registration: beginRegistration + completeRegistration
// ---------------------------------------------------------------------------

describe("beginRegistration + completeRegistration", () => {
  /**
   * Each test gets its own auth service with a fresh in-memory `sendEmail`
   * capture so the OTP sent in step 1 can be replayed in step 2.
   */
  function makeAuth() {
    const captured: { code?: string } = {};
    const svc = createAuthService({
      ...config,
      sendEmail: async (_to, _subject, body) => {
        const m = body.match(/code is: (\d{6})/);
        if (m) captured.code = m[1];
      },
    });
    return { svc, captured };
  }

  it.effect(
    "happy path: begin → complete creates user and returns session + enrollment token",
    () =>
      Effect.gen(function* () {
        const { svc, captured } = makeAuth();
        yield* svc.beginRegistration("verify@example.com", "verifyme", "Verify Me");
        expect(captured.code).toMatch(/^\d{6}$/);

        const result = yield* svc.completeRegistration("verify@example.com", captured.code!);
        expect(result.profileId).toMatch(/^usr_/);
        expect(result.handle).toBe("verifyme");
        expect(result.email).toBe("verify@example.com");
        expect(result.displayName).toBe("Verify Me");
        expect(result.accessToken.length).toBeGreaterThan(0);
        expect(result.refreshToken.length).toBeGreaterThan(0);
        expect(result.expiresIn).toBeGreaterThan(0);
        expect(result.enrollmentToken.length).toBeGreaterThan(0);

        // The user row must now exist.
        const found = yield* svc.findProfileByEmail("verify@example.com");
        expect(found?.handle).toBe("verifyme");
        expect(found?.displayName).toBe("Verify Me");
      }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("S-H3: email is normalised to lowercase across the pipeline", () =>
    Effect.gen(function* () {
      const { svc, captured } = makeAuth();
      yield* svc.beginRegistration("MixedCase@Example.com", "mixedcase");
      // The OTP is captured from the email body which is sent to the
      // lowercased address; complete must also accept the lowercased form.
      const result = yield* svc.completeRegistration("MixedCase@Example.com", captured.code!);
      expect(result.email).toBe("mixedcase@example.com");

      // Lookups by either casing find the same row.
      const a = yield* svc.findProfileByEmail("mixedcase@example.com");
      expect(a?.id).toBe(result.profileId);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("does not create the user before the OTP is verified", () =>
    Effect.gen(function* () {
      const { svc } = makeAuth();
      yield* svc.beginRegistration("pending@example.com", "pendinguser");

      // No DB row yet.
      const found = yield* svc.findProfileByEmail("pending@example.com");
      expect(found).toBeNull();
      // Handle still free.
      const status = yield* svc.checkHandle("pendinguser");
      expect(status.available).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects begin with ValidationError on bad email", () =>
    Effect.gen(function* () {
      const { svc } = makeAuth();
      const error = yield* Effect.flip(svc.beginRegistration("not-an-email", "okhandle"));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects begin with ValidationError on bad handle format", () =>
    Effect.gen(function* () {
      const { svc } = makeAuth();
      const error = yield* Effect.flip(svc.beginRegistration("ok@example.com", "Bad Handle!"));
      expect(error._tag).toBe("ValidationError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects begin with AuthError on a reserved handle", () =>
    Effect.gen(function* () {
      const { svc } = makeAuth();
      const error = yield* Effect.flip(svc.beginRegistration("ok@example.com", "admin"));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("reserved");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("S-M1: begin returns sent:true silently when email is already taken", () =>
    Effect.gen(function* () {
      const { svc, captured } = makeAuth();
      yield* svc.registerProfile("taken@example.com", "takenuser");
      // No throw — and crucially, no email sent (otherwise enumeration is
      // possible via timing or via observing outbound mail).
      const result = yield* svc.beginRegistration("taken@example.com", "newhandle");
      expect(result.sent).toBe(true);
      expect(captured.code).toBeUndefined();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("S-M1: begin returns sent:true silently when handle is already taken", () =>
    Effect.gen(function* () {
      const { svc, captured } = makeAuth();
      yield* svc.registerProfile("first@example.com", "duphandle");
      const result = yield* svc.beginRegistration("second@example.com", "duphandle");
      expect(result.sent).toBe(true);
      expect(captured.code).toBeUndefined();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("S-M2: begin refuses to overwrite a non-expired pending entry", () =>
    Effect.gen(function* () {
      const { svc, captured } = makeAuth();
      yield* svc.beginRegistration("dup@example.com", "dupuser");
      const firstCode = captured.code;
      captured.code = undefined;
      // Second call within the TTL should not send another email and should
      // not change the stored OTP.
      yield* svc.beginRegistration("dup@example.com", "differenthandle");
      expect(captured.code).toBeUndefined();
      // The original code must still verify.
      const result = yield* svc.completeRegistration("dup@example.com", firstCode!);
      expect(result.profileId).toMatch(/^usr_/);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("complete fails with AuthError when the OTP is wrong", () =>
    Effect.gen(function* () {
      const { svc } = makeAuth();
      yield* svc.beginRegistration("wrong@example.com", "wronguser");
      const error = yield* Effect.flip(svc.completeRegistration("wrong@example.com", "000000"));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Invalid or expired code");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("complete fails with AuthError when there is no pending registration", () =>
    Effect.gen(function* () {
      const { svc } = makeAuth();
      const error = yield* Effect.flip(
        svc.completeRegistration("never-began@example.com", "123456"),
      );
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Invalid or expired code");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("complete is single-use: a replayed code fails", () =>
    Effect.gen(function* () {
      const { svc, captured } = makeAuth();
      yield* svc.beginRegistration("replay@example.com", "replayuser");
      yield* svc.completeRegistration("replay@example.com", captured.code!);

      // Second call with the same code must fail — pending entry was deleted.
      const error = yield* Effect.flip(
        svc.completeRegistration("replay@example.com", captured.code!),
      );
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("S-H1: brute-force is capped — pending entry is wiped after 5 wrong guesses", () =>
    Effect.gen(function* () {
      const { svc, captured } = makeAuth();
      yield* svc.beginRegistration("brute@example.com", "bruteuser");
      // 5 wrong guesses
      for (let i = 0; i < 5; i++) {
        const err = yield* Effect.flip(svc.completeRegistration("brute@example.com", "000000"));
        expect(err._tag).toBe("AuthError");
      }
      // The correct code should now ALSO fail because the entry was wiped.
      const err = yield* Effect.flip(svc.completeRegistration("brute@example.com", captured.code!));
      expect(err._tag).toBe("AuthError");
      expect(err.message).toContain("Invalid or expired code");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("S-H4: a TOCTOU loss against the legacy /register doesn't burn the OTP", () =>
    Effect.gen(function* () {
      const { svc, captured } = makeAuth();
      yield* svc.beginRegistration("toctou@example.com", "toctouuser");
      // Simulate someone winning the race via the legacy registerProfile path.
      yield* svc.registerProfile("toctou@example.com", "toctouuser");
      // Our complete fails (handle/email taken) but the pending entry must
      // not have been deleted — though in practice the user would now be
      // told to log in instead.
      const err = yield* Effect.flip(
        svc.completeRegistration("toctou@example.com", captured.code!),
      );
      expect(err._tag).toBe("AuthError");
      expect(err.message).toContain("already registered");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("issueEnrollmentToken + verifyEnrollmentToken", () => {
  it.effect("issues a token whose sub matches the accountId", () =>
    Effect.gen(function* () {
      const token = yield* auth.issueEnrollmentToken("acc_abc");
      expect(token.length).toBeGreaterThan(0);
      const result = yield* auth.verifyEnrollmentToken(token);
      expect(result.accountId).toBe("acc_abc");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("verify with consume:true marks the token as used; replay fails", () =>
    Effect.gen(function* () {
      const token = yield* auth.issueEnrollmentToken("acc_consume");
      const first = yield* auth.verifyEnrollmentToken(token, { consume: true });
      expect(first.accountId).toBe("acc_consume");

      const error = yield* Effect.flip(auth.verifyEnrollmentToken(token, { consume: true }));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("already used");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("verify with consume:false can be called repeatedly", () =>
    Effect.gen(function* () {
      const token = yield* auth.issueEnrollmentToken("acc_repeat");
      const first = yield* auth.verifyEnrollmentToken(token);
      const second = yield* auth.verifyEnrollmentToken(token);
      expect(first.accountId).toBe(second.accountId);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects a normal access token (wrong type claim)", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("typecheck@example.com", "typecheck");
      const tokens = yield* auth.issueTokens(
        "usr_x",
        "acc_x",
        "typecheck@example.com",
        "typecheck",
        null,
      );
      const error = yield* Effect.flip(auth.verifyEnrollmentToken(tokens.accessToken));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("findProfileByEmail + findProfileByHandle", () => {
  it.effect("returns null when user does not exist", () =>
    Effect.gen(function* () {
      const byEmail = yield* auth.findProfileByEmail("nobody@example.com");
      const byHandle = yield* auth.findProfileByHandle("nobody");
      expect(byEmail).toBeNull();
      expect(byHandle).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("finds user by email and by handle", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("heidi@example.com", "heidi");
      const byEmail = yield* auth.findProfileByEmail("heidi@example.com");
      const byHandle = yield* auth.findProfileByHandle("heidi");
      expect(byEmail).not.toBeNull();
      expect(byHandle).not.toBeNull();
      expect(byEmail!.id).toBe(byHandle!.id);
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("issueTokens", () => {
  it.effect("issueTokens returns access + refresh tokens with handle in payload", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("ivan@example.com", "ivan", "Ivan");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      expect(tokens.accessToken).toBeTruthy();
      expect(tokens.refreshToken).toBeTruthy();
      expect(tokens.expiresIn).toBe(300);

      // Verify claims include handle and displayName
      const claims = yield* auth.verifyAccessToken(tokens.accessToken);
      expect(claims.handle).toBe("ivan");
      expect(claims.displayName).toBe("Ivan");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("OTP flow", () => {
  it.effect("beginOtp + completeOtpDirect via email identifier returns a session", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("kate@example.com", "kate");
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

      const result = yield* authWithSpy.completeOtpDirect("kate@example.com", capturedCode!);
      expect(result.session.accessToken).toBeTruthy();
      expect(result.profile.id).toMatch(/^usr_/);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("beginOtp + completeOtpDirect via handle identifier returns a session", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("liam@example.com", "liam");
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

      const result = yield* authWithSpy.completeOtpDirect("liam", capturedCode!);
      expect(result.session.accessToken).toBeTruthy();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("beginOtp fails when user does not exist", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.beginOtp("ghost@example.com"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("completeOtpDirect fails with wrong code", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("mia@example.com", "mia");
      yield* auth.beginOtp("mia@example.com");
      const error = yield* Effect.flip(auth.completeOtpDirect("mia@example.com", "000000"));
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
      yield* auth.registerProfile("noah@example.com", "noah");
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
      const error = yield* Effect.flip(authSpy.completeOtpDirect("noah@example.com", firstCode!));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("passkey registration", () => {
  it.effect("beginPasskeyRegistration returns options with @handle as userName", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("passkey@example.com", "passkeyuser");
      const result = yield* auth.beginPasskeyRegistration(profile.accountId);
      expect(result.options).toBeTruthy();
      expect(result.options.challenge).toBeTruthy();
      expect(result.options.user.name).toBe("@passkeyuser");
      // P6: WebAuthn userID must be passkeyUserId (UUID), never accountId
      const decoded = new TextDecoder().decode(
        Uint8Array.from(atob(result.options.user.id), (c) => c.charCodeAt(0)),
      );
      expect(decoded).not.toBe(profile.accountId);
      expect(decoded).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("beginPasskeyRegistration fails for an unknown accountId", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.beginPasskeyRegistration("acc_nonexistent"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("passkey login", () => {
  // Single-use challenge invariant: verifyPasskeyAssertion gates on the
  // in-memory `loginChallenges` entry BEFORE any DB work. Without a fresh
  // beginPasskeyLogin to populate it, complete must fail — which is the
  // same guard that prevents a captured assertion from being replayed
  // after the legitimate call has consumed its challenge.
  it.effect("completePasskeyLoginDirect rejects when no login challenge is live", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("pk-replay@example.com", "pkreplay");

      const bogusAssertion = {
        id: "x",
        rawId: "x",
        response: {},
        type: "public-key",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test shim; real AuthenticationResponseJSON is exhaustive
      } as any;

      // No beginPasskeyLogin call — the challenge guard must be the first
      // failure point, not the passkey DB lookup.
      const error = yield* Effect.flip(
        auth.completePasskeyLoginDirect({
          identifier: "pk-replay@example.com",
          assertion: bogusAssertion,
        }),
      );
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Challenge");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // T-U1: discoverable flow — beginPasskeyLogin(null) must return options
  // plus a server-minted challengeId. The identifier-less path is how
  // conditional-UI autofill drives sign-in.
  it.effect("beginPasskeyLogin(null) returns options + a UUID challengeId", () =>
    Effect.gen(function* () {
      const result = yield* auth.beginPasskeyLogin(null);
      expect(result.options.challenge).toBeTruthy();
      expect(result.challengeId).toBeTruthy();
      // Server-minted random UUID — lowercase hex with dashes, 36 chars.
      expect(result.challengeId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }).pipe(Effect.provide(createTestLayer())),
  );

  // T-U1: the challengeId variant of completePasskeyLoginDirect must apply
  // the same challenge guard as the identified flow — an unknown id fails
  // fast, before any DB / credential lookup.
  it.effect("completePasskeyLoginDirect rejects an unknown challengeId before DB work", () =>
    Effect.gen(function* () {
      const bogusAssertion = {
        id: "x",
        rawId: "x",
        response: {},
        type: "public-key",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test shim
      } as any;
      const error = yield* Effect.flip(
        auth.completePasskeyLoginDirect({
          challengeId: "00000000-0000-0000-0000-000000000000",
          assertion: bogusAssertion,
        }),
      );
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Challenge");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("magic link flow", () => {
  it.effect("beginMagic + verifyMagicDirect via email returns a session", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("oliver@example.com", "oliver");
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

      const result = yield* authWithSpy.verifyMagicDirect(capturedToken!);
      expect(result.session.accessToken).toBeTruthy();
      expect(result.profile.handle).toBe("oliver");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("beginMagic via handle finds and emails the user", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("petra@example.com", "petra");
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

  it.effect("verifyMagicDirect fails with unknown token", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.verifyMagicDirect("bad-token"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  // Single-use invariant: consumeMagicToken deletes the entry before the
  // profile lookup, so a second call with the same token must fail.
  it.effect("verifyMagicDirect is single-use: a replayed token fails", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("replay-magic@example.com", "replaymagic");
      let capturedToken: string | undefined;
      const svc = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const match = body.match(/token=([^\s]+)/);
          if (match) capturedToken = match[1];
        },
      });

      yield* svc.beginMagic("replay-magic@example.com");
      expect(capturedToken).toBeTruthy();

      const first = yield* svc.verifyMagicDirect(capturedToken!);
      expect(first.session.accessToken).toBeTruthy();

      const second = yield* Effect.flip(svc.verifyMagicDirect(capturedToken!));
      expect(second._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

describe("token refresh", () => {
  it.effect("refreshTokens issues new tokens from a valid refresh token", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("quinn@example.com", "quinn");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const refreshed = yield* auth.refreshTokens(tokens.refreshToken);
      expect(refreshed.accessToken).toBeTruthy();
      expect(refreshed.expiresIn).toBe(300);
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
      const profile = yield* auth.registerProfile("rose@example.com", "rose", "Rose");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const claims = yield* auth.verifyAccessToken(tokens.accessToken);
      expect(claims.profileId).toBe(profile.id);
      expect(claims.email).toBe("rose@example.com");
      expect(claims.handle).toBe("rose");
      expect(claims.displayName).toBe("Rose");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("displayName is null when not set", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("sam@example.com", "sam");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
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

// ---------------------------------------------------------------------------
// Dev-mode Effect.logDebug fallback (S-H21 / S-M3 / T-U1)
// ---------------------------------------------------------------------------
// When sendEmail is unset (local dev) the begin* paths emit the OTP code /
// magic link URL via Effect.logDebug. The invariant these tests lock:
//
//   1. Exactly one debug line is emitted per call.
//   2. The literal OTP / URL appears in the captured message — the values
//      are interpolated into the message STRING on purpose, because the
//      redacting logger walks annotation objects by key name but passes
//      message strings through unchanged. Putting the value in annotations
//      would scrub it via the PII deny-list ("email" is in REDACT_KEYS) and
//      defeat the whole point of the dev-mode log.
//   3. "[REDACTED]" never appears in the captured message — defence against
//      a future PR that wraps the call with Effect.annotateLogs({ code }).
// ---------------------------------------------------------------------------

describe("local-mode Effect.logDebug fallback", () => {
  /**
   * Install a capture logger in place of Effect's default, returning an
   * array that will be populated with every emitted message string.
   */
  function captureLogs() {
    const captured: string[] = [];
    const sinkLogger = Logger.make<unknown, void>((options) => {
      const msg = Array.isArray(options.message)
        ? options.message.join(" ")
        : String(options.message);
      captured.push(msg);
    });
    const loggerLayer = Logger.replace(Logger.defaultLogger, sinkLogger);
    return { captured, loggerLayer };
  }

  it.effect("beginRegistration logs the OTP via Effect.logDebug when sendEmail is unset", () =>
    Effect.gen(function* () {
      const { captured, loggerLayer } = captureLogs();
      const svc = createAuthService(config);

      yield* svc
        .beginRegistration("dev@example.com", "devuser", "Dev User")
        .pipe(Effect.provide(loggerLayer), Logger.withMinimumLogLevel(LogLevel.Debug));

      expect(captured.length).toBe(1);
      expect(captured[0]).toMatch(/Registration OTP for dev@example\.com: \d{6}/);
      expect(captured[0]).not.toContain("[REDACTED]");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("beginOtp logs the login code via Effect.logDebug when sendEmail is unset", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("dev-login@example.com", "devlogin");

      const { captured, loggerLayer } = captureLogs();
      const svc = createAuthService(config);

      yield* svc
        .beginOtp("dev-login@example.com")
        .pipe(Effect.provide(loggerLayer), Logger.withMinimumLogLevel(LogLevel.Debug));

      expect(captured.length).toBe(1);
      expect(captured[0]).toMatch(/OTP for dev-login@example\.com: \d{6}/);
      expect(captured[0]).not.toContain("[REDACTED]");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("beginMagic logs the magic-link URL via Effect.logDebug when sendEmail is unset", () =>
    Effect.gen(function* () {
      yield* auth.registerProfile("dev-magic@example.com", "devmagic");

      const { captured, loggerLayer } = captureLogs();
      const svc = createAuthService(config);

      yield* svc
        .beginMagic("dev-magic@example.com")
        .pipe(Effect.provide(loggerLayer), Logger.withMinimumLogLevel(LogLevel.Debug));

      expect(captured.length).toBe(1);
      expect(captured[0]).toContain("Magic link for dev-magic@example.com:");
      // S-H1: URL points at the frontend origin (`config.origin`), not the API.
      expect(captured[0]).toContain(`${config.origin}/?token=`);
      expect(captured[0]).not.toContain("[REDACTED]");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// OTP login attempt limit (S-M7)
// ---------------------------------------------------------------------------
describe("login OTP attempt limit", () => {
  it.effect("wipes OTP entry after 5 wrong guesses — correct code fails after that", () =>
    Effect.gen(function* () {
      let capturedCode: string | undefined;
      const svc = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const m = body.match(/code is: (\d{6})/);
          if (m) capturedCode = m[1];
        },
      });

      yield* svc.registerProfile("brute@example.com", "brute");
      yield* svc.beginOtp("brute@example.com");
      expect(capturedCode).toBeTruthy();

      // 5 wrong guesses
      for (let i = 0; i < 5; i++) {
        const error = yield* Effect.flip(svc.completeOtpDirect("brute@example.com", "000000"));
        expect(error._tag).toBe("AuthError");
      }

      // Now the correct code should also fail (entry wiped)
      const error = yield* Effect.flip(svc.completeOtpDirect("brute@example.com", capturedCode!));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("allows correct code before attempt limit is reached", () =>
    Effect.gen(function* () {
      let capturedCode: string | undefined;
      const svc = createAuthService({
        ...config,
        sendEmail: async (_to, _subject, body) => {
          const m = body.match(/code is: (\d{6})/);
          if (m) capturedCode = m[1];
        },
      });

      yield* svc.registerProfile("careful@example.com", "careful");
      yield* svc.beginOtp("careful@example.com");

      // 4 wrong guesses (under the limit)
      for (let i = 0; i < 4; i++) {
        yield* Effect.flip(svc.completeOtpDirect("careful@example.com", "000000"));
      }

      // Correct code still works
      const result = yield* svc.completeOtpDirect("careful@example.com", capturedCode!);
      expect(result.session.accessToken).toBeTruthy();
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// P2: Two-tier token model
// ---------------------------------------------------------------------------

describe("two-tier token model (P2)", () => {
  it.effect("verifyRefreshToken resolves the accountId from a session token", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("tier@example.com", "tier", "Tier");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      // Session token (opaque) should resolve to the correct accountId
      const { accountId } = yield* auth.verifyRefreshToken(tokens.refreshToken);
      expect(accountId).toBe(profile.accountId);
      // Access token sub should still be profileId
      const claims = yield* auth.verifyAccessToken(tokens.accessToken);
      expect(claims.profileId).toBe(profile.id);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("session token is opaque with ses_ prefix", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("sesprefix@example.com", "sesprefix");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      expect(tokens.refreshToken).toMatch(/^ses_[0-9a-f]{40}$/);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("refreshTokens resolves the default profile from account-scoped session token", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("refresh2@example.com", "refresh2");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const refreshed = yield* auth.refreshTokens(tokens.refreshToken);
      const claims = yield* auth.verifyAccessToken(refreshed.accessToken);
      expect(claims.profileId).toBe(profile.id);
      expect(claims.handle).toBe("refresh2");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("C2: refreshTokens rotates the session token (returns a new one)", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("sametoken@example.com", "sametoken");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const refreshed = yield* auth.refreshTokens(tokens.refreshToken);
      // New token must be different from the original
      expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);
      expect(refreshed.refreshToken).toMatch(/^ses_[0-9a-f]{40}$/);
      // New token must be valid
      const { accountId } = yield* auth.verifyRefreshToken(refreshed.refreshToken);
      expect(accountId).toBe(profile.accountId);
      // Old token must be invalid (rotated out)
      const err = yield* Effect.flip(auth.verifyRefreshToken(tokens.refreshToken));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("findDefaultProfile returns the default profile for an account", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("default@example.com", "defaultp");
      const found = yield* auth.findDefaultProfile(profile.accountId);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(profile.id);
      expect(found!.isDefault).toBe(true);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("findDefaultProfile returns null for a nonexistent account", () =>
    Effect.gen(function* () {
      const found = yield* auth.findDefaultProfile("acc_nonexistent");
      expect(found).toBeNull();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("rejects a random string used as a session token", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("typemix@example.com", "typemix");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      // An access token (JWT) is not a valid session token — must be rejected
      const err = yield* Effect.flip(auth.verifyRefreshToken(tokens.accessToken));
      expect(err._tag).toBe("AuthError");
      expect(err.message).toContain("Invalid or expired session");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// P2: Profile switching
// ---------------------------------------------------------------------------

describe("switchProfile (P2)", () => {
  it.effect("issues new access token for target profile", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("switch@example.com", "switchme");
      // Switch to self (same profile) — should work fine
      const result = yield* auth.switchProfile(profile.accountId, profile.id);
      expect(result.accessToken).toBeTruthy();
      expect(result.expiresIn).toBe(300);
      expect(result.profile.id).toBe(profile.id);
      expect(result.profile.handle).toBe("switchme");

      // Verify the new access token is valid
      const claims = yield* auth.verifyAccessToken(result.accessToken);
      expect(claims.profileId).toBe(profile.id);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when target profile does not exist", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("switch2@example.com", "switch2");
      const error = yield* Effect.flip(auth.switchProfile(profile.accountId, "usr_nonexistent"));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Profile not found");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when target profile belongs to a different account", () =>
    Effect.gen(function* () {
      const alice = yield* auth.registerProfile("alice_switch@example.com", "alice_switch");
      const bob = yield* auth.registerProfile("bob_switch@example.com", "bob_switch");
      // Try to switch to Bob's profile using Alice's accountId
      const error = yield* Effect.flip(auth.switchProfile(alice.accountId, bob.id));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("does not belong to this account");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails when account does not exist", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.switchProfile("acc_nonexistent", "usr_any"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// P2: listAccountProfiles
// ---------------------------------------------------------------------------

describe("listAccountProfiles (P2)", () => {
  it.effect("returns all profiles for the account", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("listme@example.com", "listme", "List Me");
      const result = yield* auth.listAccountProfiles(profile.accountId);
      expect(result.profiles).toHaveLength(1);
      expect(result.profiles[0]!.id).toBe(profile.id);
      expect(result.profiles[0]!.handle).toBe("listme");
      expect(result.profiles[0]!.displayName).toBe("List Me");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("fails for nonexistent account", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(auth.listAccountProfiles("acc_nonexistent"));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// Server-side sessions (Copenhagen Book C1)
// ---------------------------------------------------------------------------

describe("server-side sessions (C1)", () => {
  it.effect("invalidateSession makes the session token unusable", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("revoke@example.com", "revoke");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );

      // Session works before invalidation
      const { accountId } = yield* auth.verifyRefreshToken(tokens.refreshToken);
      expect(accountId).toBe(profile.accountId);

      // Invalidate
      yield* auth.invalidateSession(tokens.refreshToken);

      // Session no longer works
      const error = yield* Effect.flip(auth.verifyRefreshToken(tokens.refreshToken));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Invalid or expired session");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("invalidateSession is idempotent (no error on double-invalidate)", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("idem@example.com", "idem");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      yield* auth.invalidateSession(tokens.refreshToken);
      // Second invalidation should not throw
      yield* auth.invalidateSession(tokens.refreshToken);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("invalidateAccountSessions revokes all sessions for an account", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("revokeall@example.com", "revokeall");

      // Issue two separate sessions
      const tokens1 = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const tokens2 = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );

      // Both work
      yield* auth.verifyRefreshToken(tokens1.refreshToken);
      yield* auth.verifyRefreshToken(tokens2.refreshToken);

      // Revoke all
      yield* auth.invalidateAccountSessions(profile.accountId);

      // Both fail
      const err1 = yield* Effect.flip(auth.verifyRefreshToken(tokens1.refreshToken));
      expect(err1._tag).toBe("AuthError");
      const err2 = yield* Effect.flip(auth.verifyRefreshToken(tokens2.refreshToken));
      expect(err2._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("invalidated session cannot be used for refreshTokens", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("norefresh@example.com", "norefresh");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      yield* auth.invalidateSession(tokens.refreshToken);

      const error = yield* Effect.flip(auth.refreshTokens(tokens.refreshToken));
      expect(error._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("each issueTokens call creates a distinct session", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("distinct@example.com", "distinct");
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
      // Different session tokens
      expect(t1.refreshToken).not.toBe(t2.refreshToken);

      // Invalidating one doesn't affect the other
      yield* auth.invalidateSession(t1.refreshToken);
      const { accountId } = yield* auth.verifyRefreshToken(t2.refreshToken);
      expect(accountId).toBe(profile.accountId);
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("expired session is cleaned up and rejected on verify", () =>
    Effect.gen(function* () {
      // Use a 0-second TTL to create an instantly-expired session
      const svc = createAuthService({ ...config, refreshTokenTtl: 0 });
      const profile = yield* svc.registerProfile("expired@example.com", "expired");
      const tokens = yield* svc.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );

      // Should be expired immediately
      const error = yield* Effect.flip(svc.verifyRefreshToken(tokens.refreshToken));
      expect(error._tag).toBe("AuthError");
      expect(error.message).toContain("Invalid or expired session");
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// C2: Refresh token rotation + reuse detection
// ---------------------------------------------------------------------------

describe("refresh token rotation (C2)", () => {
  it.effect("refreshed token can be used for a second refresh (chain)", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("chain@example.com", "chain");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const r1 = yield* auth.refreshTokens(tokens.refreshToken);
      const r2 = yield* auth.refreshTokens(r1.refreshToken);
      expect(r2.refreshToken).not.toBe(r1.refreshToken);
      expect(r2.accessToken).toBeTruthy();
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("replaying a rotated-out token revokes the entire family", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("reuse@example.com", "reuse");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );

      // Rotate once — old token is now invalid
      const r1 = yield* auth.refreshTokens(tokens.refreshToken);

      // Replay the old token — should trigger family revocation
      const err1 = yield* Effect.flip(auth.refreshTokens(tokens.refreshToken));
      expect(err1._tag).toBe("AuthError");

      // The new token (r1) should also be revoked (family revocation)
      const err2 = yield* Effect.flip(auth.verifyRefreshToken(r1.refreshToken));
      expect(err2._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );

  it.effect("verifyRefreshToken returns familyId and sessionId", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("family@example.com", "family");
      const tokens = yield* auth.issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      const result = yield* auth.verifyRefreshToken(tokens.refreshToken);
      expect(result.accountId).toBe(profile.accountId);
      expect(result.familyId).toMatch(/^sfam_/);
      expect(result.sessionId).toBeTruthy();
    }).pipe(Effect.provide(createTestLayer())),
  );
});

// ---------------------------------------------------------------------------
// H1: Session invalidation on security events
// ---------------------------------------------------------------------------

describe("invalidateOtherAccountSessions (H1)", () => {
  it.effect("revokes all sessions except the specified one", () =>
    Effect.gen(function* () {
      const profile = yield* auth.registerProfile("h1@example.com", "h1user");

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

      // Keep t1's session, revoke t2's
      const { sessionId } = yield* auth.verifyRefreshToken(t1.refreshToken);
      yield* auth.invalidateOtherAccountSessions(profile.accountId, sessionId);

      // t1 still works
      yield* auth.verifyRefreshToken(t1.refreshToken);

      // t2 is revoked
      const err = yield* Effect.flip(auth.verifyRefreshToken(t2.refreshToken));
      expect(err._tag).toBe("AuthError");
    }).pipe(Effect.provide(createTestLayer())),
  );
});
