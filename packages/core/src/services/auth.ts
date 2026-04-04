import { Data, Effect, Schema } from "effect";
import { eq } from "drizzle-orm";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import { SignJWT, jwtVerify } from "jose";
import { users, passkeys } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { User } from "@osn/db/schema";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
}> {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly cause: unknown;
}> {}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AuthConfig {
  /** RP ID for WebAuthn (e.g. "localhost" or "example.com") */
  rpId: string;
  /** Human-readable RP name */
  rpName: string;
  /** Origin for WebAuthn (e.g. "http://localhost:5173") */
  origin: string;
  /** Issuer URL (used as JWT issuer + magic link base) */
  issuerUrl: string;
  /** JWT signing secret (at least 32 chars) */
  jwtSecret: string;
  /** Access token TTL in seconds (default: 3600) */
  accessTokenTtl?: number;
  /** Refresh token TTL in seconds (default: 2592000 = 30 days) */
  refreshTokenTtl?: number;
  /** OTP TTL in seconds (default: 600 = 10 min) */
  otpTtl?: number;
  /** Magic link TTL in seconds (default: 600) */
  magicTtl?: number;
  /** Callback to send email (OTP code or magic link) */
  sendEmail?: (to: string, subject: string, body: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory stores (module-level, single-process)
// ---------------------------------------------------------------------------

interface ChallengeEntry {
  challenge: string;
  expiresAt: number;
}

interface OtpEntry {
  code: string;
  userId: string;
  expiresAt: number;
}

interface MagicEntry {
  token: string;
  userId: string;
  expiresAt: number;
}

// keyed by userId for registration, by email for login
const registrationChallenges = new Map<string, ChallengeEntry>();
const loginChallenges = new Map<string, ChallengeEntry>();
const otpStore = new Map<string, OtpEntry>();
const magicStore = new Map<string, MagicEntry>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId(prefix: string): string {
  return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function now(): Date {
  return new Date();
}

async function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  ttl: number,
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(key);
}

async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown>> {
  const key = new TextEncoder().encode(secret);
  const { payload } = await jwtVerify(token, key);
  return payload as Record<string, unknown>;
}

const EmailSchema = Schema.String.pipe(
  Schema.filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s), {
    message: () => "Invalid email",
  }),
);

const HandleSchema = Schema.String.pipe(
  Schema.filter((s) => /^[a-z0-9_]{1,30}$/.test(s), {
    message: () => "Handle must be 1–30 characters: lowercase letters, numbers, underscores only",
  }),
);

/**
 * Normalises an identifier by stripping a leading @ sigil.
 * Users may type "@alice" meaning handle "alice"; this strips it before dispatch.
 */
function normaliseIdentifier(identifier: string): string {
  return identifier.startsWith("@") ? identifier.slice(1) : identifier;
}

/** Returns true if the (already-normalised) identifier looks like an email address. */
function looksLikeEmail(identifier: string): boolean {
  return identifier.includes("@");
}

const RESERVED_HANDLES = new Set([
  "me",
  "admin",
  "api",
  "support",
  "help",
  "osn",
  "pulse",
  "messaging",
  "auth",
  "login",
  "logout",
  "register",
  "signup",
  "signin",
  "about",
  "terms",
  "privacy",
  "status",
  "null",
  "undefined",
]);

// ---------------------------------------------------------------------------
// Auth service factory
// ---------------------------------------------------------------------------

export function createAuthService(config: AuthConfig) {
  const accessTokenTtl = config.accessTokenTtl ?? 3600;
  const refreshTokenTtl = config.refreshTokenTtl ?? 2592000;
  const otpTtl = config.otpTtl ?? 600;
  const magicTtl = config.magicTtl ?? 600;

  // -------------------------------------------------------------------------
  // User helpers
  // -------------------------------------------------------------------------

  const findUserByEmail = (email: string): Effect.Effect<User | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () => db.select().from(users).where(eq(users.email, email)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return result[0] ?? null;
    });

  const findUserByHandle = (handle: string): Effect.Effect<User | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () => db.select().from(users).where(eq(users.handle, handle)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return result[0] ?? null;
    });

  /**
   * Resolves a (normalised) identifier to a user.
   * Identifiers containing "@" are treated as email addresses; all others as handles.
   */
  const resolveIdentifier = (identifier: string): Effect.Effect<User | null, DatabaseError, Db> =>
    looksLikeEmail(identifier) ? findUserByEmail(identifier) : findUserByHandle(identifier);

  /**
   * Registers a new user. Fails if the email or handle is already taken.
   * This is the only way to create a user — OTP/magic/passkey flows are login-only.
   */
  const registerUser = (
    email: string,
    handle: string,
    displayName?: string,
  ): Effect.Effect<User, AuthError | ValidationError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknown(EmailSchema)(email).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      yield* Schema.decodeUnknown(HandleSchema)(handle).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );

      if (RESERVED_HANDLES.has(handle)) {
        return yield* Effect.fail(new AuthError({ message: "Handle is reserved" }));
      }

      const [existingEmail, existingHandle] = yield* Effect.all(
        [findUserByEmail(email), findUserByHandle(handle)],
        { concurrency: "unbounded" },
      );
      if (existingEmail) {
        return yield* Effect.fail(new AuthError({ message: "Email already registered" }));
      }
      if (existingHandle) {
        return yield* Effect.fail(new AuthError({ message: "Handle already taken" }));
      }

      const { db } = yield* Db;
      const id = genId("usr_");
      const ts = now();
      const dn = displayName ?? null;

      yield* Effect.tryPromise({
        try: () =>
          db
            .insert(users)
            .values({ id, handle, email, displayName: dn, createdAt: ts, updatedAt: ts }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return { id, handle, email, displayName: dn, avatarUrl: null, createdAt: ts, updatedAt: ts };
    });

  /**
   * Checks whether a handle is valid format and not yet taken.
   */
  const checkHandle = (
    handle: string,
  ): Effect.Effect<{ available: boolean }, ValidationError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknown(HandleSchema)(handle).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      if (RESERVED_HANDLES.has(handle)) return { available: false };
      const existing = yield* findUserByHandle(handle);
      return { available: existing === null };
    });

  // -------------------------------------------------------------------------
  // Token issuance
  // -------------------------------------------------------------------------

  const issueTokens = (userId: string, email: string, handle: string, displayName: string | null) =>
    Effect.tryPromise({
      try: async () => {
        const payload: Record<string, unknown> = {
          sub: userId,
          email,
          handle,
          scope: "openid profile",
        };
        if (displayName !== null) payload["displayName"] = displayName;

        const [accessToken, refreshToken] = await Promise.all([
          signJwt(payload, config.jwtSecret, accessTokenTtl),
          signJwt({ sub: userId, type: "refresh" }, config.jwtSecret, refreshTokenTtl),
        ]);
        return { accessToken, refreshToken, expiresIn: accessTokenTtl };
      },
      catch: (cause) => new AuthError({ message: String(cause) }),
    });

  // -------------------------------------------------------------------------
  // Authorization code (short-lived JWT sub=userId, used for PKCE exchange)
  // -------------------------------------------------------------------------

  const issueCode = (userId: string) =>
    Effect.tryPromise({
      try: () => signJwt({ sub: userId, type: "code" }, config.jwtSecret, 120),
      catch: (cause) => new AuthError({ message: String(cause) }),
    });

  // -------------------------------------------------------------------------
  // Token endpoint: exchange code for tokens
  // -------------------------------------------------------------------------

  const exchangeCode = (
    code: string,
  ): Effect.Effect<
    { accessToken: string; refreshToken: string; expiresIn: number },
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const payload = yield* Effect.tryPromise({
        try: () => verifyJwt(code, config.jwtSecret),
        catch: () => new AuthError({ message: "Invalid or expired code" }),
      });
      if (payload["type"] !== "code" || typeof payload["sub"] !== "string") {
        return yield* Effect.fail(new AuthError({ message: "Invalid code type" }));
      }
      const userId = payload["sub"];
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () => db.select().from(users).where(eq(users.id, userId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const user = result[0];
      if (!user) {
        return yield* Effect.fail(new AuthError({ message: "User not found" }));
      }
      return yield* issueTokens(userId, user.email, user.handle, user.displayName);
    });

  // -------------------------------------------------------------------------
  // Token refresh
  // -------------------------------------------------------------------------

  const refreshTokens = (
    refreshToken: string,
  ): Effect.Effect<
    { accessToken: string; refreshToken: string; expiresIn: number },
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const payload = yield* Effect.tryPromise({
        try: () => verifyJwt(refreshToken, config.jwtSecret),
        catch: () => new AuthError({ message: "Invalid or expired refresh token" }),
      });
      if (payload["type"] !== "refresh" || typeof payload["sub"] !== "string") {
        return yield* Effect.fail(new AuthError({ message: "Invalid token type" }));
      }
      const userId = payload["sub"];
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () => db.select().from(users).where(eq(users.id, userId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const user = result[0];
      if (!user) {
        return yield* Effect.fail(new AuthError({ message: "User not found" }));
      }
      return yield* issueTokens(userId, user.email, user.handle, user.displayName);
    });

  // -------------------------------------------------------------------------
  // Verify access token (for protected routes)
  // -------------------------------------------------------------------------

  const verifyAccessToken = (
    token: string,
  ): Effect.Effect<
    { userId: string; email: string; handle: string; displayName: string | null },
    AuthError
  > =>
    Effect.gen(function* () {
      const payload = yield* Effect.tryPromise({
        try: () => verifyJwt(token, config.jwtSecret),
        catch: () => new AuthError({ message: "Invalid or expired access token" }),
      });
      if (
        typeof payload["sub"] !== "string" ||
        typeof payload["email"] !== "string" ||
        typeof payload["handle"] !== "string"
      ) {
        return yield* Effect.fail(new AuthError({ message: "Invalid token claims" }));
      }
      return {
        userId: payload["sub"],
        email: payload["email"],
        handle: payload["handle"],
        displayName: typeof payload["displayName"] === "string" ? payload["displayName"] : null,
      };
    });

  // -------------------------------------------------------------------------
  // Passkey: begin registration
  // -------------------------------------------------------------------------

  const beginPasskeyRegistration = (
    userId: string,
  ): Effect.Effect<
    { options: PublicKeyCredentialCreationOptionsJSON },
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const userResult = yield* Effect.tryPromise({
        try: () => db.select().from(users).where(eq(users.id, userId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const user = userResult[0];
      if (!user) {
        return yield* Effect.fail(new AuthError({ message: "User not found" }));
      }

      const existingPasskeys = yield* Effect.tryPromise({
        try: () => db.select().from(passkeys).where(eq(passkeys.userId, userId)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const options = yield* Effect.tryPromise({
        try: () =>
          generateRegistrationOptions({
            rpName: config.rpName,
            rpID: config.rpId,
            userID: new TextEncoder().encode(userId),
            userName: `@${user.handle}`,
            userDisplayName: user.displayName ?? `@${user.handle}`,
            attestationType: "none",
            excludeCredentials: existingPasskeys.map((pk) => ({
              id: pk.credentialId,
              transports: pk.transports
                ? (JSON.parse(pk.transports) as AuthenticatorTransportFuture[])
                : undefined,
            })),
            authenticatorSelection: {
              residentKey: "preferred",
              userVerification: "preferred",
            },
          }),
        catch: (cause) => new AuthError({ message: String(cause) }),
      });

      registrationChallenges.set(userId, {
        challenge: options.challenge,
        expiresAt: Date.now() + 120_000,
      });

      return { options };
    });

  // -------------------------------------------------------------------------
  // Passkey: complete registration
  // -------------------------------------------------------------------------

  const completePasskeyRegistration = (
    userId: string,
    attestation: RegistrationResponseJSON,
  ): Effect.Effect<{ passkeyId: string }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const entry = registrationChallenges.get(userId);
      if (!entry || Date.now() > entry.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Challenge expired or not found" }));
      }
      registrationChallenges.delete(userId);

      const verification = yield* Effect.tryPromise({
        try: () =>
          verifyRegistrationResponse({
            response: attestation,
            expectedChallenge: entry.challenge,
            expectedOrigin: config.origin,
            expectedRPID: config.rpId,
          }),
        catch: (cause) => new AuthError({ message: String(cause) }),
      });

      if (!verification.verified || !verification.registrationInfo) {
        return yield* Effect.fail(new AuthError({ message: "Passkey registration not verified" }));
      }

      const info = verification.registrationInfo;
      const { db } = yield* Db;
      const id = genId("pk_");
      const ts = now();

      yield* Effect.tryPromise({
        try: () =>
          db.insert(passkeys).values({
            id,
            userId,
            credentialId: info.credential.id,
            publicKey: Buffer.from(info.credential.publicKey).toString("base64"),
            counter: info.credential.counter,
            transports: info.credential.transports
              ? JSON.stringify(info.credential.transports)
              : null,
            createdAt: ts,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return { passkeyId: id };
    });

  // -------------------------------------------------------------------------
  // Passkey: begin login
  // -------------------------------------------------------------------------

  const beginPasskeyLogin = (
    identifier: string,
  ): Effect.Effect<
    { options: PublicKeyCredentialRequestOptionsJSON },
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const normalised = normaliseIdentifier(identifier);
      const user = yield* resolveIdentifier(normalised);
      if (!user) {
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      const { db } = yield* Db;
      const userPasskeys = yield* Effect.tryPromise({
        try: () => db.select().from(passkeys).where(eq(passkeys.userId, user.id)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (userPasskeys.length === 0) {
        return yield* Effect.fail(
          new AuthError({ message: "No passkeys registered for this account" }),
        );
      }

      const options = yield* Effect.tryPromise({
        try: () =>
          generateAuthenticationOptions({
            rpID: config.rpId,
            allowCredentials: userPasskeys.map((pk) => ({
              id: pk.credentialId,
              transports: pk.transports
                ? (JSON.parse(pk.transports) as AuthenticatorTransportFuture[])
                : undefined,
            })),
            userVerification: "preferred",
          }),
        catch: (cause) => new AuthError({ message: String(cause) }),
      });

      // Key challenge by normalised identifier so completePasskeyLogin can
      // check the in-memory guard before touching the DB.
      loginChallenges.set(normalised, {
        challenge: options.challenge,
        expiresAt: Date.now() + 120_000,
      });

      return { options };
    });

  // -------------------------------------------------------------------------
  // Passkey: complete login
  // -------------------------------------------------------------------------

  const completePasskeyLogin = (
    identifier: string,
    assertion: AuthenticationResponseJSON,
  ): Effect.Effect<{ code: string; userId: string }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      // Check in-memory challenge guard before any DB lookup.
      const normalised = normaliseIdentifier(identifier);
      const entry = loginChallenges.get(normalised);
      if (!entry || Date.now() > entry.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Challenge expired or not found" }));
      }
      loginChallenges.delete(normalised);

      const user = yield* resolveIdentifier(normalised);
      if (!user) {
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      const { db } = yield* Db;
      const pkResult = yield* Effect.tryPromise({
        try: () =>
          db.select().from(passkeys).where(eq(passkeys.credentialId, assertion.id)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const pk = pkResult[0];
      if (!pk) {
        return yield* Effect.fail(new AuthError({ message: "Passkey not found" }));
      }

      const verification = yield* Effect.tryPromise({
        try: () =>
          verifyAuthenticationResponse({
            response: assertion,
            expectedChallenge: entry.challenge,
            expectedOrigin: config.origin,
            expectedRPID: config.rpId,
            credential: {
              id: pk.credentialId,
              publicKey: new Uint8Array(Buffer.from(pk.publicKey, "base64")),
              counter: pk.counter,
              transports: pk.transports
                ? (JSON.parse(pk.transports) as AuthenticatorTransportFuture[])
                : undefined,
            },
          }),
        catch: (cause) => new AuthError({ message: String(cause) }),
      });

      if (!verification.verified) {
        return yield* Effect.fail(new AuthError({ message: "Passkey verification failed" }));
      }

      yield* Effect.tryPromise({
        try: () =>
          db
            .update(passkeys)
            .set({ counter: verification.authenticationInfo.newCounter })
            .where(eq(passkeys.id, pk.id)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const code = yield* issueCode(user.id);
      return { code, userId: user.id };
    });

  // -------------------------------------------------------------------------
  // OTP: begin (login only — user must already be registered)
  // -------------------------------------------------------------------------

  const beginOtp = (
    identifier: string,
  ): Effect.Effect<{ sent: boolean }, AuthError | ValidationError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const normalised = normaliseIdentifier(identifier);
      if (looksLikeEmail(normalised)) {
        yield* Schema.decodeUnknown(EmailSchema)(normalised).pipe(
          Effect.mapError((cause) => new ValidationError({ cause })),
        );
      } else {
        yield* Schema.decodeUnknown(HandleSchema)(normalised).pipe(
          Effect.mapError((cause) => new ValidationError({ cause })),
        );
      }

      const user = yield* resolveIdentifier(normalised);
      if (!user) {
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      const code = (100_000 + (buf[0] % 900_000)).toString();

      // Key by normalised identifier so completeOtp can check in-memory first.
      otpStore.set(normalised, {
        code,
        userId: user.id,
        expiresAt: Date.now() + otpTtl * 1000,
      });

      if (config.sendEmail) {
        yield* Effect.tryPromise({
          try: () =>
            config.sendEmail!(
              user.email,
              "Your OSN sign-in code",
              `Your one-time sign-in code is: ${code}\n\nThis code expires in ${otpTtl / 60} minutes.`,
            ),
          catch: (cause) => new AuthError({ message: `Failed to send email: ${String(cause)}` }),
        });
      } else {
        console.log(`[OSN dev] OTP for ${user.email}: ${code}`);
      }

      return { sent: true };
    });

  // -------------------------------------------------------------------------
  // OTP: complete
  // -------------------------------------------------------------------------

  const completeOtp = (
    identifier: string,
    code: string,
  ): Effect.Effect<{ code: string; userId: string }, AuthError, Db> =>
    Effect.gen(function* () {
      // Check in-memory store first — no DB hit on expired/invalid attempts.
      const normalised = normaliseIdentifier(identifier);
      const entry = otpStore.get(normalised);
      if (!entry || Date.now() > entry.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }
      if (entry.code !== code) {
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }
      otpStore.delete(normalised);

      const authCode = yield* issueCode(entry.userId);
      return { code: authCode, userId: entry.userId };
    });

  // -------------------------------------------------------------------------
  // Magic link: begin (login only — user must already be registered)
  // -------------------------------------------------------------------------

  const beginMagic = (
    identifier: string,
  ): Effect.Effect<{ sent: boolean }, AuthError | ValidationError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const normalised = normaliseIdentifier(identifier);
      if (looksLikeEmail(normalised)) {
        yield* Schema.decodeUnknown(EmailSchema)(normalised).pipe(
          Effect.mapError((cause) => new ValidationError({ cause })),
        );
      } else {
        yield* Schema.decodeUnknown(HandleSchema)(normalised).pipe(
          Effect.mapError((cause) => new ValidationError({ cause })),
        );
      }

      const user = yield* resolveIdentifier(normalised);
      if (!user) {
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      const token = genId("mlnk_") + crypto.randomUUID().replace(/-/g, "");

      magicStore.set(token, {
        token,
        userId: user.id,
        expiresAt: Date.now() + magicTtl * 1000,
      });

      const magicUrl = `${config.issuerUrl}/magic/verify?token=${token}`;

      if (config.sendEmail) {
        yield* Effect.tryPromise({
          try: () =>
            config.sendEmail!(
              user.email,
              "Your OSN magic sign-in link",
              `Click this link to sign in: ${magicUrl}\n\nThis link expires in ${magicTtl / 60} minutes.`,
            ),
          catch: (cause) => new AuthError({ message: `Failed to send email: ${String(cause)}` }),
        });
      } else {
        console.log(`[OSN dev] Magic link for ${user.email}: ${magicUrl}`);
      }

      return { sent: true };
    });

  // -------------------------------------------------------------------------
  // Magic link: verify
  // -------------------------------------------------------------------------

  const verifyMagic = (
    token: string,
    redirectUri: string,
    state: string,
  ): Effect.Effect<{ redirectUrl: string }, AuthError, Db> =>
    Effect.gen(function* () {
      const entry = magicStore.get(token);
      if (!entry || Date.now() > entry.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Magic link expired or not found" }));
      }
      magicStore.delete(token);

      const code = yield* issueCode(entry.userId);
      const url = new URL(redirectUri);
      url.searchParams.set("code", code);
      url.searchParams.set("state", state);
      return { redirectUrl: url.toString() };
    });

  return {
    findUserByEmail,
    findUserByHandle,
    resolveIdentifier,
    registerUser,
    checkHandle,
    issueTokens,
    exchangeCode,
    refreshTokens,
    verifyAccessToken,
    beginPasskeyRegistration,
    completePasskeyRegistration,
    beginPasskeyLogin,
    completePasskeyLogin,
    beginOtp,
    completeOtp,
    beginMagic,
    verifyMagic,
  };
}

// Type alias for the service
export type AuthService = ReturnType<typeof createAuthService>;
