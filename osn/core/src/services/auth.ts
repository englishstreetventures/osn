import { Data, Effect, Schema } from "effect";
import { eq } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
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
import {
  metricAuthHandleCheck,
  metricAuthMagicLinkSent,
  metricAuthOtpSent,
  withAuthLogin,
  withAuthRegister,
  withAuthTokenRefresh,
} from "../metrics";

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

interface PendingRegistration {
  email: string;
  handle: string;
  displayName: string | null;
  code: string;
  attempts: number;
  expiresAt: number;
}

// Bound on in-memory pending registrations to cap memory under abuse.
const MAX_PENDING_REGISTRATIONS = 10_000;
// Max OTP guesses against a single pending entry before it is wiped.
const MAX_OTP_ATTEMPTS = 5;

// keyed by userId for registration, by email for login
const registrationChallenges = new Map<string, ChallengeEntry>();
const loginChallenges = new Map<string, ChallengeEntry>();
const otpStore = new Map<string, OtpEntry>();
const magicStore = new Map<string, MagicEntry>();
// Pending email-verification registrations, keyed by lowercased email.
const pendingRegistrations = new Map<string, PendingRegistration>();
// Single-use enrollment tokens that have already been consumed by a passkey
// register/complete call. Cleared opportunistically by sweepEnrollmentTokens.
const consumedEnrollmentTokens = new Map<string, number>();

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

/**
 * Generates a uniformly distributed 6-digit OTP via rejection sampling.
 * `crypto.getRandomValues` returns a 32-bit value; naive `% 900_000` is biased
 * because 2^32 is not a multiple of 900_000. We discard draws that fall in the
 * tail and resample.
 */
function genOtpCode(): string {
  const buf = new Uint32Array(1);
  // 2^32 = 4_294_967_296. Largest multiple of 900_000 not exceeding it.
  const ceil = Math.floor(0x1_0000_0000 / 900_000) * 900_000;
  do {
    crypto.getRandomValues(buf);
  } while (buf[0]! >= ceil);
  return (100_000 + (buf[0]! % 900_000)).toString();
}

/**
 * Constant-time string comparison. Falls back to `false` for length mismatch.
 * Used for comparing user-supplied OTP codes against expected values to remove
 * the (already small) timing side channel that JS string `===` exposes.
 */
function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Drops expired entries from a TTL-keyed map. Called opportunistically on
 * insert paths to bound memory growth without needing a background sweeper.
 * O(n) but n is capped (MAX_PENDING_REGISTRATIONS for that store).
 */
function sweepExpired<T extends { expiresAt: number }>(map: Map<string, T>): void {
  const nowMs = Date.now();
  for (const [key, entry] of map) {
    if (entry.expiresAt <= nowMs) map.delete(key);
  }
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

/**
 * A session token envelope — the shape returned by `issueTokens` and consumed
 * by clients. Exposed as a named type so the first-party `/login/*` endpoints
 * can type their return shapes precisely.
 */
export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * The publicly-safe subset of `User` returned alongside a fresh session on
 * first-party login. Strips timestamps so clients don't accidentally depend
 * on them for anything display-related.
 */
export interface PublicUser {
  id: string;
  handle: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}

function toPublicUser(u: User): PublicUser {
  return {
    id: u.id,
    handle: u.handle,
    email: u.email,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
  };
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
   * Step 1 of email-verified registration. Validates input, normalises the
   * email to lowercase, generates an unbiased 6-digit OTP, stores a pending
   * registration entry, and emails the code. No DB row is created yet.
   *
   * Security properties:
   *  - Always returns `{ sent: true }` regardless of whether the email or
   *    handle is already taken (S-M1: removes the user-enumeration oracle).
   *    The "is this handle free?" question is answered separately by the
   *    public `/handle/:handle` endpoint, which is the appropriate channel
   *    and can be rate-limited independently.
   *  - The pending-registrations map is bounded (MAX_PENDING_REGISTRATIONS)
   *    and swept of expired entries on every insert, so unauthenticated
   *    abuse can't grow it without bound (S-M2 / P-W1).
   *  - Refuses to overwrite a non-expired pending entry, preventing an
   *    attacker from resetting a victim's in-progress OTP (S-M2).
   *  - The dev-only `console.log` of the OTP is gated on
   *    `NODE_ENV !== "production"` (S-M3).
   *
   * Validation errors (bad email format, bad handle format, reserved handle)
   * are still surfaced as ValidationError / AuthError because they're not
   * enumeration leaks — the same input would fail client-side too.
   */
  const beginRegistration = (
    email: string,
    handle: string,
    displayName?: string,
  ): Effect.Effect<{ sent: boolean }, AuthError | ValidationError | DatabaseError, Db> =>
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

      // Normalise email to lowercase (S-H3) — the canonical form is what we
      // persist and what we key the pending-registrations map by.
      const normalisedEmail = email.toLowerCase();

      // Sweep expired entries first so we don't refuse a legitimate retry
      // simply because the user's previous OTP timed out.
      sweepExpired(pendingRegistrations);

      // Refuse to grow the map past its cap. Returning the same generic
      // success keeps the response shape uniform under abuse.
      if (pendingRegistrations.size >= MAX_PENDING_REGISTRATIONS) {
        return { sent: true };
      }

      const [existingEmail, existingHandle] = yield* Effect.all(
        [findUserByEmail(normalisedEmail), findUserByHandle(handle)],
        { concurrency: "unbounded" },
      );

      // S-M1: silently no-op when the email/handle already exists. The user
      // can use the login flow if they already have an account; we don't
      // confirm or deny their existence over an unauthenticated channel.
      if (existingEmail || existingHandle) {
        return { sent: true };
      }

      // S-M2: don't let an attacker reset a victim's in-progress OTP by
      // re-posting begin with the same email.
      const existingPending = pendingRegistrations.get(normalisedEmail);
      if (existingPending && existingPending.expiresAt > Date.now()) {
        return { sent: true };
      }

      const code = genOtpCode();
      pendingRegistrations.set(normalisedEmail, {
        email: normalisedEmail,
        handle,
        displayName: displayName ?? null,
        code,
        attempts: 0,
        expiresAt: Date.now() + otpTtl * 1000,
      });

      if (config.sendEmail) {
        yield* Effect.tryPromise({
          try: () =>
            config.sendEmail!(
              normalisedEmail,
              "Verify your OSN email",
              `Your OSN verification code is: ${code}\n\nThis code expires in ${otpTtl / 60} minutes.`,
            ),
          catch: (cause) => new AuthError({ message: `Failed to send email: ${String(cause)}` }),
        });
      } else if (process.env["NODE_ENV"] !== "production") {
        // S-M3: only print the OTP to logs in non-production environments.
        console.log(`[OSN dev] Registration OTP for ${normalisedEmail}: ${code}`);
      }

      metricAuthOtpSent("registration");
      return { sent: true };
    }).pipe(withAuthRegister("begin"));

  /**
   * Step 2 of email-verified registration. Verifies the OTP against the
   * pending registration and, if valid, creates the user row, then returns a
   * full Session (access + refresh tokens) AND a short-lived single-use
   * enrollment token the client can use to add a passkey via the
   * Authorization-gated `/passkey/register/*` routes.
   *
   * Security properties:
   *  - Constant-time OTP comparison (S-M4 / `timingSafeEqualString`).
   *  - Per-entry attempt counter; after MAX_OTP_ATTEMPTS the entry is wiped,
   *    capping brute-force probability at ~5/1_000_000 per registration (S-H1
   *    partial; full rate-limit fix is tracked in the security backlog).
   *  - The pending entry is only deleted AFTER a successful insert. A losing
   *    race against another insert (TOCTOU) leaves the pending entry intact
   *    so the user can retry without burning their OTP (S-H4).
   *  - Insert relies on the DB-level UNIQUE constraint on email/handle as
   *    the source of truth, mapping constraint violations to a clean
   *    AuthError instead of leaking driver text (S-H4 / S-H5).
   *  - Returns access + refresh tokens directly. The legacy `/token` PKCE
   *    bypass (tracked separately as a security-backlog item) is therefore
   *    not on the registration code path at all.
   */
  const completeRegistration = (
    email: string,
    code: string,
  ): Effect.Effect<
    {
      userId: string;
      handle: string;
      email: string;
      displayName: string | null;
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
      enrollmentToken: string;
    },
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const key = email.toLowerCase();
      const pending = pendingRegistrations.get(key);
      if (!pending || Date.now() > pending.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }

      if (!timingSafeEqualString(pending.code, code)) {
        // Increment the attempt counter; wipe after too many guesses.
        pending.attempts += 1;
        if (pending.attempts >= MAX_OTP_ATTEMPTS) {
          pendingRegistrations.delete(key);
        }
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }

      const { db } = yield* Db;
      const id = genId("usr_");
      const ts = now();

      // Insert directly. The DB-level UNIQUE constraints on `email` and
      // `handle` are the source of truth for race-free uniqueness; a
      // constraint violation here means another registration won the race
      // (or the legacy `/register` endpoint was called concurrently). We
      // surface that as a clean AuthError without leaking driver text.
      const inserted = yield* Effect.tryPromise({
        try: async () => {
          try {
            await db.insert(users).values({
              id,
              handle: pending.handle,
              email: pending.email,
              displayName: pending.displayName,
              createdAt: ts,
              updatedAt: ts,
            });
            return { ok: true as const };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/UNIQUE|constraint/i.test(msg)) {
              return { ok: false as const, reason: "conflict" };
            }
            throw e;
          }
        },
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (!inserted.ok) {
        // Don't burn the pending entry — the user can still retry if the
        // conflicting insert is rolled back. The collision is rare in
        // practice (race window is microseconds).
        return yield* Effect.fail(new AuthError({ message: "Email or handle already registered" }));
      }

      // Success: only NOW delete the pending entry.
      pendingRegistrations.delete(key);

      const tokens = yield* issueTokens(id, pending.email, pending.handle, pending.displayName);
      const enrollmentToken = yield* issueEnrollmentToken(id);

      return {
        userId: id,
        handle: pending.handle,
        email: pending.email,
        displayName: pending.displayName,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        enrollmentToken,
      };
    }).pipe(withAuthRegister("complete"));

  /**
   * Checks whether a handle is valid format and not yet taken.
   */
  const checkHandle = (
    handle: string,
  ): Effect.Effect<{ available: boolean }, ValidationError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknown(HandleSchema)(handle).pipe(
        Effect.tapError(() => Effect.sync(() => metricAuthHandleCheck("invalid"))),
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      if (RESERVED_HANDLES.has(handle)) {
        metricAuthHandleCheck("taken");
        return { available: false };
      }
      const existing = yield* findUserByHandle(handle);
      metricAuthHandleCheck(existing === null ? "available" : "taken");
      return { available: existing === null };
    }).pipe(Effect.withSpan("auth.handle.check"));

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
  // Enrollment tokens
  //
  // Short-lived (5 min) single-use bearer tokens minted by completeRegistration
  // (and only by completeRegistration) so that the new user can prove the
  // server-side identity it just received over the same channel when it calls
  // /passkey/register/{begin,complete}. The token's `sub` is the userId of the
  // user being enrolled. Calls to /passkey/register/* compare the token's sub
  // against the request body's userId; a mismatch is rejected.
  //
  // The "consumed" set tracks the JWT IDs (`jti`) of tokens that have already
  // been used by /passkey/register/complete. /passkey/register/begin does NOT
  // consume the token (the user may need to retry the WebAuthn ceremony).
  // -------------------------------------------------------------------------

  const enrollmentTokenTtl = 5 * 60; // seconds

  const issueEnrollmentToken = (userId: string) =>
    Effect.tryPromise({
      try: () => {
        const jti = crypto.randomUUID();
        return signJwt(
          { sub: userId, type: "passkey-enroll", jti },
          config.jwtSecret,
          enrollmentTokenTtl,
        );
      },
      catch: (cause) => new AuthError({ message: String(cause) }),
    });

  /**
   * Verifies an enrollment token. Returns the userId on success.
   * If `consume` is true (used by /passkey/register/complete) the token's jti
   * is recorded in `consumedEnrollmentTokens` and any subsequent verification
   * with the same jti will fail.
   */
  const verifyEnrollmentToken = (
    token: string,
    options: { consume: boolean } = { consume: false },
  ): Effect.Effect<{ userId: string }, AuthError> =>
    Effect.gen(function* () {
      const payload = yield* Effect.tryPromise({
        try: () => verifyJwt(token, config.jwtSecret),
        catch: () => new AuthError({ message: "Invalid or expired enrollment token" }),
      });
      if (
        payload["type"] !== "passkey-enroll" ||
        typeof payload["sub"] !== "string" ||
        typeof payload["jti"] !== "string"
      ) {
        return yield* Effect.fail(new AuthError({ message: "Invalid enrollment token" }));
      }

      // Sweep consumed tokens whose original TTL has elapsed (Date.now() ms).
      const cutoff = Date.now() - enrollmentTokenTtl * 1000;
      for (const [jti, ts] of consumedEnrollmentTokens) {
        if (ts < cutoff) consumedEnrollmentTokens.delete(jti);
      }

      const jti = payload["jti"] as string;
      if (consumedEnrollmentTokens.has(jti)) {
        return yield* Effect.fail(new AuthError({ message: "Enrollment token already used" }));
      }
      if (options.consume) {
        consumedEnrollmentTokens.set(jti, Date.now());
      }
      return { userId: payload["sub"] as string };
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
    }).pipe(withAuthTokenRefresh);

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
    }).pipe(Effect.withSpan("auth.login.passkey.begin"));

  // -------------------------------------------------------------------------
  // Passkey: verify assertion (extracted so both the code-issuing and
  // direct-session completion paths can share the same WebAuthn verification
  // logic without duplication).
  // -------------------------------------------------------------------------

  const verifyPasskeyAssertion = (
    identifier: string,
    assertion: AuthenticationResponseJSON,
  ): Effect.Effect<User, AuthError | DatabaseError, Db> =>
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

      return user;
    });

  // -------------------------------------------------------------------------
  // Passkey: complete login (PKCE — returns an authorization code, exchanged
  // at /token). Kept for the hosted HTML third-party flow.
  // -------------------------------------------------------------------------

  const completePasskeyLogin = (
    identifier: string,
    assertion: AuthenticationResponseJSON,
  ): Effect.Effect<{ code: string; userId: string }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const user = yield* verifyPasskeyAssertion(identifier, assertion);
      const code = yield* issueCode(user.id);
      return { code, userId: user.id };
    }).pipe(withAuthLogin("passkey"));

  // -------------------------------------------------------------------------
  // Passkey: complete login — direct session (first-party path, bypasses
  // PKCE and returns a Session + PublicUser directly).
  // -------------------------------------------------------------------------

  const completePasskeyLoginDirect = (
    identifier: string,
    assertion: AuthenticationResponseJSON,
  ): Effect.Effect<{ session: TokenSet; user: PublicUser }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const user = yield* verifyPasskeyAssertion(identifier, assertion);
      const session = yield* issueTokens(user.id, user.email, user.handle, user.displayName);
      return { session, user: toPublicUser(user) };
    }).pipe(withAuthLogin("passkey"));

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

      metricAuthOtpSent("login");
      return { sent: true };
    }).pipe(Effect.withSpan("auth.otp.begin"));

  // -------------------------------------------------------------------------
  // OTP: verify code (extracted). Returns the full User row so both the
  // code-issuing and direct-session completion paths can read email/handle/
  // displayName off it.
  // -------------------------------------------------------------------------

  const verifyOtpCode = (
    identifier: string,
    code: string,
  ): Effect.Effect<User, AuthError | DatabaseError, Db> =>
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

      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () => db.select().from(users).where(eq(users.id, entry.userId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const user = result[0];
      if (!user) {
        return yield* Effect.fail(new AuthError({ message: "User not found" }));
      }
      return user;
    });

  // -------------------------------------------------------------------------
  // OTP: complete (PKCE — returns an authorization code)
  // -------------------------------------------------------------------------

  const completeOtp = (
    identifier: string,
    code: string,
  ): Effect.Effect<{ code: string; userId: string }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const user = yield* verifyOtpCode(identifier, code);
      const authCode = yield* issueCode(user.id);
      return { code: authCode, userId: user.id };
    }).pipe(withAuthLogin("otp"));

  // -------------------------------------------------------------------------
  // OTP: complete direct (first-party — returns a Session + PublicUser)
  // -------------------------------------------------------------------------

  const completeOtpDirect = (
    identifier: string,
    code: string,
  ): Effect.Effect<{ session: TokenSet; user: PublicUser }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const user = yield* verifyOtpCode(identifier, code);
      const session = yield* issueTokens(user.id, user.email, user.handle, user.displayName);
      return { session, user: toPublicUser(user) };
    }).pipe(withAuthLogin("otp"));

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

      metricAuthMagicLinkSent("ok");
      return { sent: true };
    }).pipe(Effect.withSpan("auth.magic_link.begin"));

  // -------------------------------------------------------------------------
  // Magic link: consume token (extracted). Atomically removes the entry and
  // returns the User. Shared by both the PKCE redirect path and the first-
  // party direct-session path.
  // -------------------------------------------------------------------------

  const consumeMagicToken = (token: string): Effect.Effect<User, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const entry = magicStore.get(token);
      if (!entry || Date.now() > entry.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Magic link expired or not found" }));
      }
      magicStore.delete(token);

      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () => db.select().from(users).where(eq(users.id, entry.userId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const user = result[0];
      if (!user) {
        return yield* Effect.fail(new AuthError({ message: "User not found" }));
      }
      return user;
    });

  // -------------------------------------------------------------------------
  // Magic link: verify (PKCE — returns a redirectUrl with an auth code)
  // -------------------------------------------------------------------------

  const verifyMagic = (
    token: string,
    redirectUri: string,
    state: string,
  ): Effect.Effect<{ redirectUrl: string }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const user = yield* consumeMagicToken(token);
      const code = yield* issueCode(user.id);
      const url = new URL(redirectUri);
      url.searchParams.set("code", code);
      url.searchParams.set("state", state);
      return { redirectUrl: url.toString() };
    }).pipe(withAuthLogin("magic_link"));

  // -------------------------------------------------------------------------
  // Magic link: verify direct (first-party — returns a Session + PublicUser)
  // -------------------------------------------------------------------------

  const verifyMagicDirect = (
    token: string,
  ): Effect.Effect<{ session: TokenSet; user: PublicUser }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const user = yield* consumeMagicToken(token);
      const session = yield* issueTokens(user.id, user.email, user.handle, user.displayName);
      return { session, user: toPublicUser(user) };
    }).pipe(withAuthLogin("magic_link"));

  return {
    findUserByEmail,
    findUserByHandle,
    resolveIdentifier,
    registerUser,
    beginRegistration,
    completeRegistration,
    issueEnrollmentToken,
    verifyEnrollmentToken,
    checkHandle,
    issueTokens,
    exchangeCode,
    refreshTokens,
    verifyAccessToken,
    beginPasskeyRegistration,
    completePasskeyRegistration,
    beginPasskeyLogin,
    completePasskeyLogin,
    completePasskeyLoginDirect,
    beginOtp,
    completeOtp,
    completeOtpDirect,
    beginMagic,
    verifyMagic,
    verifyMagicDirect,
  };
}

// Type alias for the service
export type AuthService = ReturnType<typeof createAuthService>;
