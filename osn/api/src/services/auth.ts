import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  accounts,
  emailChanges,
  recoveryCodes,
  securityEvents,
  sessions,
  users,
  passkeys,
} from "@osn/db/schema";
import type { Profile } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import {
  generateRecoveryCodes as cryptoGenerateRecoveryCodes,
  hashRecoveryCode,
  RECOVERY_CODE_COUNT,
} from "@shared/crypto";
import type {
  SecurityEventKind,
  StepUpFactor,
  StepUpVerifyResult,
} from "@shared/observability/metrics";
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
import { and, count as countFn, desc, eq, gte, isNull, like, ne } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";
import { SignJWT, jwtVerify } from "jose";

import {
  createInMemoryRotatedSessionStore,
  type RotatedSessionStore,
} from "../lib/rotated-session-store";
import {
  metricAuthHandleCheck,
  metricAuthMagicLinkSent,
  metricAuthOtpSent,
  metricRecoveryCodeConsumed,
  metricRecoveryCodesGenerated,
  metricRotatedStoreDuration,
  metricRotatedStoreOp,
  metricSecurityEventAcknowledged,
  metricSecurityEventNotified,
  metricSecurityEventNotifyDuration,
  metricSecurityEventRecorded,
  metricSessionReuseDetected,
  metricSessionFamilyRevoked,
  metricSessionSecurityInvalidation,
  metricStepUpIssued,
  metricStepUpVerified,
  withAuthLogin,
  withAuthRecovery,
  withAuthRegister,
  withAuthTokenRefresh,
  withEmailChange,
  withSessionOp,
  withSessionRotation,
  withProfileSwitch,
  withStepUp,
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
  /** ES256 private key for signing access, refresh, enrollment, and code tokens */
  jwtPrivateKey: CryptoKey;
  /** ES256 public key for verifying the above */
  jwtPublicKey: CryptoKey;
  /** Key ID (RFC 7638 thumbprint) — included in JWT headers and JWKS */
  jwtKid: string;
  /** Public key as JWK object — served at /.well-known/jwks.json */
  jwtPublicKeyJwk: Record<string, unknown>;
  /**
   * Access token TTL in seconds. Default: 300 (5 minutes).
   *
   * Short TTL caps the XSS blast radius on the access token — the one
   * auth secret that still lives in localStorage after C3. The refresh
   * token is in an HttpOnly cookie so transparent silent-refresh works
   * without the user noticing the rotation.
   */
  accessTokenTtl?: number;
  /** Refresh token TTL in seconds (default: 2592000 = 30 days) */
  refreshTokenTtl?: number;
  /** OTP TTL in seconds (default: 600 = 10 min) */
  otpTtl?: number;
  /** Magic link TTL in seconds (default: 600) */
  magicTtl?: number;
  /** Callback to send email (OTP code or magic link) */
  sendEmail?: (to: string, subject: string, body: string) => Promise<void>;
  /**
   * Allowed redirect URI origins for OAuth flows (validated at /authorize,
   * /magic/verify, and /token). When set, the origin of any caller-supplied
   * redirect_uri must match one of these entries exactly. When omitted or
   * empty, all redirect URIs are accepted (development mode only).
   */
  allowedRedirectUris?: string[];
  /**
   * Step-up (sudo) token TTL in seconds. Default: 300 (5 min). Short enough
   * that a stolen step-up JWT grants only a narrow window for sensitive
   * actions — same ceiling as an access token, same threat model.
   */
  stepUpTokenTtl?: number;
  /**
   * HMAC pepper used to hash session-issuing IP addresses into
   * `sessions.ip_hash`. Must be at least 32 bytes of unguessable material
   * in non-local envs — rotating it invalidates the display "same-subnet"
   * signal, but has no effect on session validity. When unset, IP hashes
   * are not recorded (dev mode).
   */
  sessionIpPepper?: string;
  /**
   * Permitted AMR ("authentication method reference") values for
   * `/recovery/generate` step-up. The user explicitly wanted both passkey
   * and OTP flows allowed; set narrower in production if desired.
   */
  recoveryGenerateAllowedAmr?: readonly ("webauthn" | "otp")[];
  /**
   * Cluster-wide single-use guard for step-up token jtis (S-H1). Inject a
   * Redis-backed store in multi-pod deployments; otherwise the default
   * in-memory map means a captured token replays successfully once per pod.
   */
  stepUpJtiStore?: StepUpJtiStore;
  /**
   * Cluster-safe record of rotated-out session hashes for C2 reuse detection
   * (S-H1 session). Single-process deployments get the in-memory default;
   * multi-pod deployments inject a Redis-backed store so a rotation recorded
   * on one pod is visible to every other pod on subsequent /token calls.
   */
  rotatedSessionStore?: RotatedSessionStore;
}

// ---------------------------------------------------------------------------
// In-memory stores (module-level, single-process)
// ---------------------------------------------------------------------------

interface ChallengeEntry {
  challenge: string;
  expiresAt: number;
}

interface OtpEntry {
  codeHash: string;
  profileId: string;
  attempts: number;
  expiresAt: number;
}

interface MagicEntry {
  profileId: string;
  expiresAt: number;
}

interface PendingRegistration {
  email: string;
  handle: string;
  displayName: string | null;
  codeHash: string;
  attempts: number;
  expiresAt: number;
}

// Bound on in-memory pending registrations to cap memory under abuse.
const MAX_PENDING_REGISTRATIONS = 10_000;
// Max OTP guesses against a single pending entry before it is wiped.
const MAX_OTP_ATTEMPTS = 5;

// Per-account profile-switch rate limiting (S-M3). Fixed window:
// max 20 switches per hour per account. Module-level so it survives
// across request boundaries (same as OTP / challenge stores).
const PROFILE_SWITCH_MAX = 20;
const PROFILE_SWITCH_WINDOW_MS = 3_600_000; // 1 hour
const profileSwitchCounts = new Map<string, { count: number; resetAt: number }>();

function checkProfileSwitchLimit(accountId: string): boolean {
  const currentMs = Date.now();
  const entry = profileSwitchCounts.get(accountId);
  if (!entry || currentMs >= entry.resetAt) {
    profileSwitchCounts.set(accountId, {
      count: 1,
      resetAt: currentMs + PROFILE_SWITCH_WINDOW_MS,
    });
    return true;
  }
  if (entry.count >= PROFILE_SWITCH_MAX) return false;
  entry.count++;
  return true;
}

// keyed by accountId for registration, by email for login
const registrationChallenges = new Map<string, ChallengeEntry>();
const loginChallenges = new Map<string, ChallengeEntry>();
const otpStore = new Map<string, OtpEntry>();
const magicStore = new Map<string, MagicEntry>();
// Pending email-verification registrations, keyed by lowercased email.
const pendingRegistrations = new Map<string, PendingRegistration>();
// Single-use enrollment tokens that have already been consumed by a passkey
// register/complete call. Cleared opportunistically by sweepEnrollmentTokens.
const consumedEnrollmentTokens = new Map<string, number>();

// Step-up passkey challenges — keyed by accountId (caller is already
// authenticated, so identifier resolution is unnecessary and would risk
// cross-account step-up abuse if omitted).
const stepUpPasskeyChallenges = new Map<string, ChallengeEntry>();

// Step-up OTP codes — keyed by accountId. Separate from loginOtp store so
// a login OTP cannot be replayed to authorise a sensitive action, and vice
// versa. Structure matches OtpEntry but without profileId (accountId is the key).
interface StepUpOtpEntry {
  codeHash: string;
  attempts: number;
  expiresAt: number;
}
const stepUpOtpStore = new Map<string, StepUpOtpEntry>();

// Pending email-change OTPs — keyed by accountId. The new email sits in the
// entry rather than the key so the service can reject attempts that belong
// to a stale "begin" call.
interface PendingEmailChange {
  newEmail: string;
  codeHash: string;
  attempts: number;
  expiresAt: number;
}
const pendingEmailChanges = new Map<string, PendingEmailChange>();

// Consumed step-up token jtis (replay guard). Swept opportunistically.
const consumedStepUpTokens = new Map<string, number>();

/**
 * Single-flight guard interface for step-up token `jti` consumption.
 *
 * The default implementation (`createInMemoryJtiStore`) is a per-process
 * `Map` — correct for single-node dev and test, but breaks the "single-use"
 * advertised property in a multi-pod deployment (a captured token could be
 * replayed once per instance before any one pod has seen the jti).
 *
 * In non-local deployments, inject a Redis-backed implementation
 * (`createRedisJtiStore` in `lib/step-up-jti-store.ts`) so the guard is
 * cluster-wide atomic.
 */
export interface StepUpJtiStore {
  /**
   * Returns `true` if the jti was consumed for the FIRST time (allow the
   * step-up verification to proceed). Returns `false` on replay (deny).
   * `ttlMs` must be at least as long as the step-up token TTL so replay
   * entries survive the token's own lifetime.
   */
  consume(jti: string, ttlMs: number): Promise<boolean>;
}

/** Default in-memory jti store — single-process only (S-H1). */
export function createInMemoryJtiStore(): StepUpJtiStore {
  return {
    async consume(jti, ttlMs) {
      const cutoff = Date.now() - ttlMs;
      for (const [k, ts] of consumedStepUpTokens) {
        if (ts < cutoff) consumedStepUpTokens.delete(k);
      }
      if (consumedStepUpTokens.has(jti)) return false;
      consumedStepUpTokens.set(jti, Date.now());
      return true;
    },
  };
}

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
  privateKey: CryptoKey,
  kid: string,
  ttl: number,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(privateKey);
}

async function verifyJwt(token: string, publicKey: CryptoKey): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(token, publicKey, { algorithms: ["ES256"] });
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

// ---------------------------------------------------------------------------
// Session token helpers (Copenhagen Book C1)
// ---------------------------------------------------------------------------

/**
 * Generates an opaque session token: 20 random bytes (160-bit entropy),
 * hex-encoded with a `ses_` prefix for developer ergonomics.
 * The raw token is held by the client; the server stores only its SHA-256 hash.
 */
function generateSessionToken(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return "ses_" + Buffer.from(bytes).toString("hex");
}

/**
 * SHA-256 hash of the raw session token. This is what gets stored in the
 * sessions table as the primary key. A DB leak does not expose valid tokens
 * because the token has 160 bits of entropy — brute-forcing the preimage
 * of SHA-256 is infeasible.
 */
function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Public revocation handle for a session — first 16 hex chars of the
 * SHA-256 hash. 64 bits of collision resistance within a single account's
 * session list is more than enough; exposing the full hash would let a
 * log-capturing attacker DELETE sessions by guessing the URL.
 */
function sessionHandleFromHash(sessionHash: string): string {
  return sessionHash.slice(0, 16);
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
 * Per-session metadata captured at issuance. `uaLabel` is a coarse
 * "Firefox on macOS"-style string — never the raw User-Agent. `ip` is
 * the caller's IP; it is immediately hashed via HMAC-peppered SHA-256
 * before leaving this service, never stored raw.
 */
export interface SessionMeta {
  uaLabel?: string | null;
  ip?: string | null;
}

/**
 * Public shape returned by `listAccountSessions`. The revocation handle
 * (`id`) is the first 16 hex chars of the session-token SHA-256 — enough
 * to uniquely identify a row in practice (well below any collision risk
 * for a single account) without exposing the full token hash.
 */
export interface SessionSummary {
  id: string;
  uaLabel: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
  isCurrent: boolean;
}

/**
 * Public shape returned by `listUnacknowledgedSecurityEvents`. Surfaces the
 * kind, when it happened, and the coarse device context so the client banner
 * can render "your recovery codes were regenerated on Firefox on macOS —
 * was this you?" without ever exposing the raw IP or User-Agent.
 */
export interface SecurityEventSummary {
  id: string;
  kind: SecurityEventKind;
  createdAt: number;
  uaLabel: string | null;
  ipHash: string | null;
}

/**
 * A profile row enriched with the `email` from the linked `accounts` row.
 * Used throughout the auth service since the profiles table no longer carries email.
 */
export type ProfileWithEmail = Profile & { email: string };

/**
 * The publicly-safe subset of a profile returned alongside a fresh session on
 * first-party login. Strips timestamps so clients don't accidentally depend
 * on them for anything display-related.
 */
export interface PublicProfile {
  id: string;
  handle: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}

function toPublicProfile(u: Profile, email: string): PublicProfile {
  return {
    id: u.id,
    handle: u.handle,
    email,
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

/**
 * Hard cap on concurrent sessions per account (S-M1). An attacker who
 * compromises an account cannot inflate the revocation / list surface
 * beyond this limit; new sessions LRU-evict the oldest rather than
 * rejecting the legitimate login. Typical users have <10 sessions
 * across all their devices, so 50 is conservative.
 */
const MAX_SESSIONS_PER_ACCOUNT = 50;
/**
 * Minimum gap between `last_used_at` writes on the hot-path (P-W4).
 * The Sessions UI doesn't need sub-second accuracy; coalescing to 60s
 * cuts per-refresh DB writes by ~60× at typical 5-min refresh cadence.
 */
const LAST_USED_AT_COALESCE_MS = 60_000;
/**
 * Per-account cap on `/account/email/begin` (S-H3). Complements the
 * per-IP rate limit and prevents an authenticated attacker pooling
 * their allowance across rotating IPs to spam the OSN sending domain.
 * Window is 24h to match the 2-per-7-days hard cap on complete.
 */
const EMAIL_CHANGE_BEGIN_PER_ACCOUNT_WINDOW_MS = 24 * 60 * 60 * 1000;
const EMAIL_CHANGE_BEGIN_PER_ACCOUNT_MAX = 3;
const emailChangeBeginCounts = new Map<string, { count: number; resetAt: number }>();

export function createAuthService(config: AuthConfig) {
  const accessTokenTtl = config.accessTokenTtl ?? 300;
  const refreshTokenTtl = config.refreshTokenTtl ?? 2592000;
  const otpTtl = config.otpTtl ?? 600;
  const magicTtl = config.magicTtl ?? 600;
  const stepUpTokenTtl = config.stepUpTokenTtl ?? 300;
  const recoveryGenerateAllowedAmr = new Set<string>(
    config.recoveryGenerateAllowedAmr ?? ["webauthn", "otp"],
  );
  const jtiStore = config.stepUpJtiStore ?? createInMemoryJtiStore();
  const rotatedSessionStore = config.rotatedSessionStore ?? createInMemoryRotatedSessionStore();
  const rotatedSessionStoreBackend = rotatedSessionStore.backend;
  /**
   * HMAC-SHA256 pepper for IP hashing. Only applied when the caller has
   * configured one — in dev we leave ip_hash NULL so local Docker IPs
   * don't turn into stable "same device" signals by accident.
   */
  const hashIp = (ip: string): string | null => {
    const pepper = config.sessionIpPepper;
    if (!pepper) return null;
    return createHmac("sha256", pepper).update(ip).digest("hex");
  };

  // -------------------------------------------------------------------------
  // Redirect URI validation (S-H3)
  // Pre-computed origin set avoids re-parsing the static allowlist per request (P-W17).
  // -------------------------------------------------------------------------

  const allowedOrigins = new Set(
    (config.allowedRedirectUris ?? [])
      .map((u) => URL.parse(u)?.origin)
      .filter((o): o is string => o != null),
  );

  const validateRedirectUri = (uri: string): Effect.Effect<void, AuthError> => {
    if (allowedOrigins.size === 0) {
      // No allowlist configured — allow all (development mode).
      return Effect.void;
    }
    const parsed = URL.parse(uri);
    if (!parsed) {
      return Effect.fail(new AuthError({ message: "Invalid redirect_uri" }));
    }
    if (!allowedOrigins.has(parsed.origin)) {
      return Effect.fail(new AuthError({ message: "redirect_uri not allowed" }));
    }
    return Effect.void;
  };

  // -------------------------------------------------------------------------
  // Profile helpers
  // -------------------------------------------------------------------------

  const findProfileByEmail = (
    email: string,
  ): Effect.Effect<ProfileWithEmail | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ profile: users, account: accounts })
            .from(users)
            .innerJoin(accounts, eq(users.accountId, accounts.id))
            .where(eq(accounts.email, email))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = result[0];
      if (!row) return null;
      return { ...row.profile, email: row.account.email };
    });

  const findProfileByHandle = (
    handle: string,
  ): Effect.Effect<ProfileWithEmail | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ profile: users, account: accounts })
            .from(users)
            .innerJoin(accounts, eq(users.accountId, accounts.id))
            .where(eq(users.handle, handle))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = result[0];
      if (!row) return null;
      return { ...row.profile, email: row.account.email };
    });

  const findProfileById = (
    profileId: string,
  ): Effect.Effect<ProfileWithEmail | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ profile: users, account: accounts })
            .from(users)
            .innerJoin(accounts, eq(users.accountId, accounts.id))
            .where(eq(users.id, profileId))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = result[0];
      if (!row) return null;
      return { ...row.profile, email: row.account.email };
    });

  /**
   * Resolves a (normalised) identifier to a profile.
   * Identifiers containing "@" are treated as email addresses; all others as handles.
   */
  const resolveIdentifier = (
    identifier: string,
  ): Effect.Effect<ProfileWithEmail | null, DatabaseError, Db> =>
    looksLikeEmail(identifier) ? findProfileByEmail(identifier) : findProfileByHandle(identifier);

  /**
   * Registers a new profile (and its owning account). Fails if the email or handle is already taken.
   * This is the only way to create a profile — OTP/magic/passkey flows are login-only.
   */
  const registerProfile = (
    email: string,
    handle: string,
    displayName?: string,
  ): Effect.Effect<ProfileWithEmail, AuthError | ValidationError | DatabaseError, Db> =>
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
        [findProfileByEmail(email), findProfileByHandle(handle)],
        { concurrency: "unbounded" },
      );
      if (existingEmail) {
        return yield* Effect.fail(new AuthError({ message: "Email already registered" }));
      }
      if (existingHandle) {
        return yield* Effect.fail(new AuthError({ message: "Handle already taken" }));
      }

      const { db } = yield* Db;
      const accountId = genId("acc_");
      const id = genId("usr_");
      const ts = now();
      const dn = displayName ?? null;

      yield* Effect.tryPromise({
        try: () =>
          db.transaction(async (tx) => {
            await tx.insert(accounts).values({
              id: accountId,
              email,
              passkeyUserId: crypto.randomUUID(),
              maxProfiles: 5,
              createdAt: ts,
              updatedAt: ts,
            });
            await tx.insert(users).values({
              id,
              accountId,
              handle,
              displayName: dn,
              isDefault: true,
              createdAt: ts,
              updatedAt: ts,
            });
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return {
        id,
        accountId,
        handle,
        email,
        displayName: dn,
        avatarUrl: null,
        isDefault: true,
        createdAt: ts,
        updatedAt: ts,
      };
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
   *  - The local-only `Effect.logDebug` of the OTP is gated on
   *    `OSN_ENV` being unset or `"local"` (S-M3 / S-L2).
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
        [findProfileByEmail(normalisedEmail), findProfileByHandle(handle)],
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
        codeHash: hashSessionToken(code),
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
      } else if (!process.env["OSN_ENV"] || process.env["OSN_ENV"] === "local") {
        // S-M3: only print the OTP to logs in local environments. The guard
        // uses OSN_ENV (not NODE_ENV) so dev/staging/prod are excluded — defence in
        // depth alongside the log-level minimum (S-L2). Values are
        // interpolated into the message string (not annotations) so the
        // redacting logger doesn't scrub them.
        yield* Effect.logDebug(`[OSN local] Registration OTP for ${normalisedEmail}: ${code}`);
      }

      metricAuthOtpSent("registration");
      return { sent: true };
    }).pipe(withAuthRegister("begin"));

  /**
   * Step 2 of email-verified registration. Verifies the OTP against the
   * pending registration and, if valid, creates the account + profile rows, then returns a
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
    sessionMeta?: SessionMeta,
  ): Effect.Effect<
    {
      profileId: string;
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

      if (!timingSafeEqualString(pending.codeHash, hashSessionToken(code))) {
        // Increment the attempt counter; wipe after too many guesses.
        pending.attempts += 1;
        if (pending.attempts >= MAX_OTP_ATTEMPTS) {
          pendingRegistrations.delete(key);
        }
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }

      const { db } = yield* Db;
      const accountId = genId("acc_");
      const id = genId("usr_");
      const ts = now();

      // Insert account + profile. The DB-level UNIQUE constraints on `email`
      // and `handle` are the source of truth for race-free uniqueness; a
      // constraint violation here means another registration won the race
      // (or the legacy `/register` endpoint was called concurrently). We
      // surface that as a clean AuthError without leaking driver text.
      const inserted = yield* Effect.tryPromise({
        try: async () => {
          try {
            await db.transaction(async (tx) => {
              await tx.insert(accounts).values({
                id: accountId,
                email: pending.email,
                passkeyUserId: crypto.randomUUID(),
                maxProfiles: 5,
                createdAt: ts,
                updatedAt: ts,
              });
              await tx.insert(users).values({
                id,
                accountId,
                handle: pending.handle,
                displayName: pending.displayName,
                isDefault: true,
                createdAt: ts,
                updatedAt: ts,
              });
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

      const tokens = yield* issueTokens(
        id,
        accountId,
        pending.email,
        pending.handle,
        pending.displayName,
        undefined,
        sessionMeta,
      );
      const enrollmentToken = yield* issueEnrollmentToken(accountId);

      return {
        profileId: id,
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
      const existing = yield* findProfileByHandle(handle);
      metricAuthHandleCheck(existing === null ? "available" : "taken");
      return { available: existing === null };
    }).pipe(Effect.withSpan("auth.handle.check"));

  // -------------------------------------------------------------------------
  // Token issuance
  // -------------------------------------------------------------------------

  /**
   * Signs a short-lived ES256 access token JWT. Used by both initial login
   * (via `issueTokens`) and token refresh / profile switch (standalone).
   */
  const issueAccessToken = (
    profileId: string,
    email: string,
    handle: string,
    displayName: string | null,
  ) =>
    Effect.tryPromise({
      try: () => {
        const payload: Record<string, unknown> = {
          sub: profileId,
          email,
          handle,
          scope: "openid profile",
        };
        if (displayName !== null) payload["displayName"] = displayName;
        return signJwt(payload, config.jwtPrivateKey, config.jwtKid, accessTokenTtl);
      },
      catch: (cause) => new AuthError({ message: String(cause) }),
    });

  /**
   * Full token issuance: creates a server-side session row and returns an
   * opaque session token (the "refresh token") alongside a short-lived
   * access token JWT. The session token is what the client persists; the
   * server only stores its SHA-256 hash (Copenhagen Book C1).
   *
   * `familyId` groups all rotated tokens in a single refresh chain.
   * On initial login it is generated fresh; on rotation it is propagated
   * from the previous session so reuse detection can revoke the entire family.
   */
  const issueTokens = (
    profileId: string,
    accountId: string,
    email: string,
    handle: string,
    displayName: string | null,
    familyId?: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<TokenSet, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const accessToken = yield* issueAccessToken(profileId, email, handle, displayName);

      // Generate opaque session token + store SHA-256 hash in DB
      const sessionToken = generateSessionToken();
      const sessionId = hashSessionToken(sessionToken);
      const nowSec = Math.floor(Date.now() / 1000);
      const fam = familyId ?? genId("sfam_");

      const { db } = yield* Db;

      // S-M1: LRU-evict the oldest sessions once the per-account cap is
      // exceeded. An attacker with a stolen credential can't inflate the
      // revocation surface beyond MAX_SESSIONS_PER_ACCOUNT; legitimate
      // users with genuinely many devices see their least-recently-used
      // sessions drop off rather than their new login failing.
      yield* Effect.tryPromise({
        try: async () => {
          const rows = await db
            .select({ id: sessions.id, lastUsedAt: sessions.lastUsedAt })
            .from(sessions)
            .where(eq(sessions.accountId, accountId))
            .orderBy(desc(sessions.lastUsedAt))
            .limit(MAX_SESSIONS_PER_ACCOUNT + 1);
          if (rows.length >= MAX_SESSIONS_PER_ACCOUNT) {
            const evictIds = rows.slice(MAX_SESSIONS_PER_ACCOUNT - 1).map((r) => r.id);
            for (const id of evictIds) {
              await db.delete(sessions).where(eq(sessions.id, id));
            }
          }
        },
        catch: (cause) => new DatabaseError({ cause }),
      });

      yield* Effect.tryPromise({
        try: () =>
          db.insert(sessions).values({
            id: sessionId,
            accountId,
            familyId: fam,
            expiresAt: nowSec + refreshTokenTtl,
            createdAt: nowSec,
            uaLabel: sessionMeta?.uaLabel ?? null,
            ipHash: sessionMeta?.ip ? hashIp(sessionMeta.ip) : null,
            lastUsedAt: nowSec,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return { accessToken, refreshToken: sessionToken, expiresIn: accessTokenTtl };
    });

  // -------------------------------------------------------------------------
  // Authorization code (short-lived JWT sub=profileId, used for PKCE exchange)
  // -------------------------------------------------------------------------

  const issueCode = (profileId: string) =>
    Effect.tryPromise({
      try: () =>
        signJwt({ sub: profileId, type: "code" }, config.jwtPrivateKey, config.jwtKid, 120),
      catch: (cause) => new AuthError({ message: String(cause) }),
    });

  // -------------------------------------------------------------------------
  // Enrollment tokens
  //
  // Short-lived (5 min) single-use bearer tokens minted by completeRegistration
  // (and only by completeRegistration) so that the new user can prove the
  // server-side identity it just received over the same channel when it calls
  // /passkey/register/{begin,complete}. The token's `sub` is the accountId of the
  // account being enrolled. Calls to /passkey/register/* compare the token's sub
  // against the request body's accountId; a mismatch is rejected.
  //
  // The "consumed" set tracks the JWT IDs (`jti`) of tokens that have already
  // been used by /passkey/register/complete. /passkey/register/begin does NOT
  // consume the token (the user may need to retry the WebAuthn ceremony).
  // -------------------------------------------------------------------------

  const enrollmentTokenTtl = 5 * 60; // seconds

  const issueEnrollmentToken = (accountId: string) =>
    Effect.tryPromise({
      try: () => {
        const jti = crypto.randomUUID();
        return signJwt(
          { sub: accountId, type: "passkey-enroll", jti },
          config.jwtPrivateKey,
          config.jwtKid,
          enrollmentTokenTtl,
        );
      },
      catch: (cause) => new AuthError({ message: String(cause) }),
    });

  /**
   * Verifies an enrollment token. Returns the accountId on success.
   * If `consume` is true (used by /passkey/register/complete) the token's jti
   * is recorded in `consumedEnrollmentTokens` and any subsequent verification
   * with the same jti will fail.
   */
  const verifyEnrollmentToken = (
    token: string,
    options: { consume: boolean } = { consume: false },
  ): Effect.Effect<{ accountId: string }, AuthError> =>
    Effect.gen(function* () {
      const payload = yield* Effect.tryPromise({
        try: () => verifyJwt(token, config.jwtPublicKey),
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
      return { accountId: payload["sub"] as string };
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
        try: () => verifyJwt(code, config.jwtPublicKey),
        catch: () => new AuthError({ message: "Invalid or expired code" }),
      });
      if (payload["type"] !== "code" || typeof payload["sub"] !== "string") {
        return yield* Effect.fail(new AuthError({ message: "Invalid code type" }));
      }
      const profileId = payload["sub"];
      const profile = yield* findProfileById(profileId);
      if (!profile) {
        return yield* Effect.fail(new AuthError({ message: "Profile not found" }));
      }
      return yield* issueTokens(
        profileId,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
      );
    });

  // -------------------------------------------------------------------------
  // Token refresh (server-side sessions — Copenhagen Book C1)
  // -------------------------------------------------------------------------

  /**
   * Verifies a session token by looking up its SHA-256 hash in the sessions
   * table. Implements sliding-window expiry: when less than half the TTL
   * remains, `expiresAt` is extended by the full TTL from now.
   *
   * Returns `accountId`, `familyId`, and `sessionId` (the hash). The
   * `familyId` is needed by `refreshTokens` for rotation; `sessionId` is
   * needed by `invalidateOtherAccountSessions` (H1).
   *
   * Shared by `refreshTokens`, `switchProfile`, and `listAccountProfiles`.
   */
  const verifyRefreshToken = (
    token: string,
  ): Effect.Effect<
    { accountId: string; familyId: string; sessionId: string },
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const sessionId = hashSessionToken(token);
      const { db } = yield* Db;

      const result = yield* Effect.tryPromise({
        try: () => db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const session = result[0];

      if (!session) {
        // Reuse detection (C2): the token was not found — it may have been
        // rotated out. If so, revoke the entire session family.
        yield* detectReuse(sessionId);
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired session" }));
      }

      const nowSec = Math.floor(Date.now() / 1000);

      // Expired — clean up lazily
      if (nowSec >= session.expiresAt) {
        yield* Effect.tryPromise({
          try: () => db.delete(sessions).where(eq(sessions.id, sessionId)),
          catch: (cause) => new DatabaseError({ cause }),
        });
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired session" }));
      }

      // Sliding window: extend when less than half the TTL remains.
      // `last_used_at` is coalesced (P-W4) — writing it on every verify
      // would add a DB round-trip per refresh. The Sessions UI doesn't
      // need sub-second accuracy; 60 s granularity shrinks writes by
      // roughly the refresh cadence.
      const halfTtl = Math.floor(refreshTokenTtl / 2);
      const shouldExtend = session.expiresAt - nowSec < halfTtl;
      const lastUsedMs = (session.lastUsedAt ?? session.createdAt) * 1000;
      const shouldTouchLastUsed = Date.now() - lastUsedMs >= LAST_USED_AT_COALESCE_MS;

      if (shouldExtend || shouldTouchLastUsed) {
        const updates: Record<string, number> = {};
        if (shouldExtend) updates["expiresAt"] = nowSec + refreshTokenTtl;
        if (shouldTouchLastUsed) updates["lastUsedAt"] = nowSec;
        yield* Effect.tryPromise({
          try: () => db.update(sessions).set(updates).where(eq(sessions.id, sessionId)),
          catch: (cause) => new DatabaseError({ cause }),
        });
      }

      return { accountId: session.accountId, familyId: session.familyId, sessionId };
    });

  // -------------------------------------------------------------------------
  // Reuse detection (Copenhagen Book C2)
  //
  // When a session hash is not found in the DB, it may have been rotated
  // out (deleted during a prior refresh). `rotatedSessionStore` tracks
  // recently-rotated hashes (keyed by hash → familyId) so a replayed
  // old token triggers full family revocation. S-H1 session: the store
  // abstraction lets the memory default (single-process dev/test) swap for
  // a Redis-backed cluster-safe implementation in production.
  // -------------------------------------------------------------------------

  const rotatedSessionStoreTtlMs = refreshTokenTtl * 1000;

  /**
   * Record a rotated-out hash. Wraps the async store call with the standard
   * observability trio: span + duration histogram + bounded-attrs counter.
   * Fail-open on store errors — rotation itself has already committed at
   * the DB layer and aborting the refresh on a Redis blip is a worse UX
   * than a temporary gap in reuse detection.
   */
  const trackRotatedSession = (
    sessionHash: string,
    familyId: string,
  ): Effect.Effect<void, never, never> =>
    Effect.suspend(() => {
      const start = Date.now();
      return Effect.tryPromise({
        try: () => rotatedSessionStore.track(sessionHash, familyId, rotatedSessionStoreTtlMs),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            metricRotatedStoreOp({
              action: "track",
              result: "ok",
              backend: rotatedSessionStoreBackend,
            });
            metricRotatedStoreDuration((Date.now() - start) / 1000, {
              action: "track",
              backend: rotatedSessionStoreBackend,
            });
          }),
        ),
        Effect.catchAll(() =>
          Effect.gen(function* () {
            metricRotatedStoreOp({
              action: "track",
              result: "error",
              backend: rotatedSessionStoreBackend,
            });
            metricRotatedStoreDuration((Date.now() - start) / 1000, {
              action: "track",
              backend: rotatedSessionStoreBackend,
            });
            yield* Effect.logWarning("Rotated-session store unreachable — fail-open on track");
          }),
        ),
        Effect.withSpan("auth.session.rotated_store.track"),
      );
    });

  /**
   * Checks if a missing session hash was recently rotated. If so, revokes
   * the entire family — both the legitimate holder and the attacker are
   * logged out, which is the correct security response per the Copenhagen
   * Book.
   */
  const detectReuse = (sessionHash: string): Effect.Effect<void, DatabaseError, Db> =>
    Effect.gen(function* () {
      const start = Date.now();
      const familyId = yield* Effect.tryPromise({
        try: () => rotatedSessionStore.check(sessionHash),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            metricRotatedStoreOp({
              action: "check",
              result: result ? "hit" : "miss",
              backend: rotatedSessionStoreBackend,
            });
            metricRotatedStoreDuration((Date.now() - start) / 1000, {
              action: "check",
              backend: rotatedSessionStoreBackend,
            });
          }),
        ),
        Effect.catchAll(() =>
          Effect.gen(function* () {
            metricRotatedStoreOp({
              action: "check",
              result: "error",
              backend: rotatedSessionStoreBackend,
            });
            metricRotatedStoreDuration((Date.now() - start) / 1000, {
              action: "check",
              backend: rotatedSessionStoreBackend,
            });
            yield* Effect.logWarning("Rotated-session store unreachable — fail-open on check");
            // Fail-open: return null so a Redis outage cannot manufacture
            // false-positive family revocations that log legitimate users out.
            return null as string | null;
          }),
        ),
        Effect.withSpan("auth.session.rotated_store.check"),
      );
      if (!familyId) return;

      // Replayed rotated-out token — revoke the entire family.
      metricSessionReuseDetected();
      yield* Effect.logWarning("Session token reuse detected — revoking family");
      const { db } = yield* Db;
      yield* Effect.tryPromise({
        try: () => db.delete(sessions).where(eq(sessions.familyId, familyId)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      // S-M1: clear every tracking record for this family so observability
      // stays consistent if an attacker replays multiple exfiltrated tokens
      // from the same chain. Store-level fail-open — leaving stale keys
      // behind is harmless (they expire with the refresh TTL).
      const revokeStart = Date.now();
      yield* Effect.tryPromise({
        try: () => rotatedSessionStore.revokeFamily(familyId),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            metricRotatedStoreOp({
              action: "revoke_family",
              result: "ok",
              backend: rotatedSessionStoreBackend,
            });
            metricRotatedStoreDuration((Date.now() - revokeStart) / 1000, {
              action: "revoke_family",
              backend: rotatedSessionStoreBackend,
            });
          }),
        ),
        Effect.catchAll(() =>
          Effect.gen(function* () {
            metricRotatedStoreOp({
              action: "revoke_family",
              result: "error",
              backend: rotatedSessionStoreBackend,
            });
            metricRotatedStoreDuration((Date.now() - revokeStart) / 1000, {
              action: "revoke_family",
              backend: rotatedSessionStoreBackend,
            });
            yield* Effect.logWarning(
              "Rotated-session store unreachable — fail-open on revoke_family",
            );
          }),
        ),
        Effect.withSpan("auth.session.rotated_store.revoke_family"),
      );
      metricSessionFamilyRevoked();
    }).pipe(Effect.withSpan("auth.session.reuse_detect"));

  /**
   * Finds the default profile for an account. Uses DESC ordering on isDefault
   * so the default profile sorts first (true=1 before false=0), then takes
   * limit(1). Falls back to the first profile if none has isDefault=true.
   */
  const findDefaultProfile = (
    accountId: string,
  ): Effect.Effect<ProfileWithEmail | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ profile: users, account: accounts })
            .from(users)
            .innerJoin(accounts, eq(users.accountId, accounts.id))
            .where(eq(users.accountId, accountId))
            .orderBy(desc(users.isDefault))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = result[0];
      if (!row) return null;
      return { ...row.profile, email: row.account.email };
    });

  /**
   * Refreshes a session: verifies the session token, finds the default
   * profile, issues a new access token, and **rotates** the session token
   * (Copenhagen Book C2). The old session row is deleted and a new one is
   * inserted in the same family. The old hash is tracked in-memory so that
   * a replayed old token triggers full family revocation (reuse detection).
   */
  const refreshTokens = (
    sessionToken: string,
  ): Effect.Effect<
    { accessToken: string; refreshToken: string; expiresIn: number },
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const {
        accountId,
        familyId,
        sessionId: oldSessionId,
      } = yield* verifyRefreshToken(sessionToken);
      const profile = yield* findDefaultProfile(accountId);
      if (!profile) {
        return yield* Effect.fail(new AuthError({ message: "Profile not found" }));
      }

      const accessToken = yield* issueAccessToken(
        profile.id,
        profile.email,
        profile.handle,
        profile.displayName,
      );

      // Rotate: delete old session, insert new one in the same family,
      // preserving the old session's metadata (UA label + IP hash) so the
      // device keeps its identity across rotations.
      const newSessionToken = generateSessionToken();
      const newSessionId = hashSessionToken(newSessionToken);
      const nowSec = Math.floor(Date.now() / 1000);

      const { db } = yield* Db;
      yield* Effect.tryPromise({
        try: () =>
          db.transaction(async (tx) => {
            const existing = await tx
              .select()
              .from(sessions)
              .where(eq(sessions.id, oldSessionId))
              .limit(1);
            const old = existing[0];
            await tx.delete(sessions).where(eq(sessions.id, oldSessionId));
            await tx.insert(sessions).values({
              id: newSessionId,
              accountId,
              familyId,
              expiresAt: nowSec + refreshTokenTtl,
              createdAt: nowSec,
              uaLabel: old?.uaLabel ?? null,
              ipHash: old?.ipHash ?? null,
              lastUsedAt: nowSec,
            });
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      // Track the rotated-out hash for reuse detection
      yield* trackRotatedSession(oldSessionId, familyId);

      return { accessToken, refreshToken: newSessionToken, expiresIn: accessTokenTtl };
    }).pipe(withSessionRotation, withAuthTokenRefresh);

  // -------------------------------------------------------------------------
  // Verify access token (for protected routes)
  // -------------------------------------------------------------------------

  const verifyAccessToken = (
    token: string,
  ): Effect.Effect<
    { profileId: string; email: string; handle: string; displayName: string | null },
    AuthError
  > =>
    Effect.gen(function* () {
      const payload = yield* Effect.tryPromise({
        try: () => verifyJwt(token, config.jwtPublicKey),
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
        profileId: payload["sub"],
        email: payload["email"],
        handle: payload["handle"],
        displayName: typeof payload["displayName"] === "string" ? payload["displayName"] : null,
      };
    });

  // -------------------------------------------------------------------------
  // Passkey: begin registration
  // -------------------------------------------------------------------------

  const beginPasskeyRegistration = (
    accountId: string,
  ): Effect.Effect<
    { options: PublicKeyCredentialCreationOptionsJSON },
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      // Look up the account row (for passkeyUserId) and default profile (for display name)
      const [accountResult, profileResult, existingPasskeys] = yield* Effect.all(
        [
          Effect.tryPromise({
            try: () => db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
            catch: (cause) => new DatabaseError({ cause }),
          }),
          Effect.tryPromise({
            try: () => db.select().from(users).where(eq(users.accountId, accountId)).limit(1),
            catch: (cause) => new DatabaseError({ cause }),
          }),
          Effect.tryPromise({
            try: () => db.select().from(passkeys).where(eq(passkeys.accountId, accountId)),
            catch: (cause) => new DatabaseError({ cause }),
          }),
        ],
        { concurrency: "unbounded" },
      );
      const account = accountResult[0];
      const profile = profileResult[0];
      if (!account || !profile) {
        return yield* Effect.fail(new AuthError({ message: "Account not found" }));
      }

      const options = yield* Effect.tryPromise({
        try: () =>
          generateRegistrationOptions({
            rpName: config.rpName,
            rpID: config.rpId,
            userID: new TextEncoder().encode(account.passkeyUserId),
            userName: `@${profile.handle}`,
            userDisplayName: profile.displayName ?? `@${profile.handle}`,
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

      registrationChallenges.set(accountId, {
        challenge: options.challenge,
        expiresAt: Date.now() + 120_000,
      });

      return { options };
    });

  // -------------------------------------------------------------------------
  // Passkey: complete registration
  // -------------------------------------------------------------------------

  const completePasskeyRegistration = (
    accountId: string,
    attestation: RegistrationResponseJSON,
    /** Raw session token of the caller. When provided, hashed internally
     *  and all OTHER sessions for this account are revoked (H1). Keeps
     *  the raw-token → hash boundary inside the service (S-H2). */
    currentSessionToken?: string,
  ): Effect.Effect<{ passkeyId: string }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const entry = registrationChallenges.get(accountId);
      if (!entry || Date.now() > entry.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Challenge expired or not found" }));
      }
      registrationChallenges.delete(accountId);

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
            accountId,
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

      // H1: Invalidate all other sessions on passkey registration.
      // An attacker who stole a session token cannot persist after the
      // legitimate user adds a passkey.
      if (currentSessionToken) {
        yield* invalidateOtherAccountSessions(accountId, hashSessionToken(currentSessionToken));
      }

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
      const profile = yield* resolveIdentifier(normalised);
      if (!profile) {
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      const { db } = yield* Db;
      const profilePasskeys = yield* Effect.tryPromise({
        try: () => db.select().from(passkeys).where(eq(passkeys.accountId, profile.accountId)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (profilePasskeys.length === 0) {
        return yield* Effect.fail(
          new AuthError({ message: "No passkeys registered for this account" }),
        );
      }

      const options = yield* Effect.tryPromise({
        try: () =>
          generateAuthenticationOptions({
            rpID: config.rpId,
            allowCredentials: profilePasskeys.map((pk) => ({
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
  ): Effect.Effect<ProfileWithEmail, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      // Check in-memory challenge guard before any DB lookup.
      const normalised = normaliseIdentifier(identifier);
      const entry = loginChallenges.get(normalised);
      if (!entry || Date.now() > entry.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Challenge expired or not found" }));
      }
      loginChallenges.delete(normalised);

      const profile = yield* resolveIdentifier(normalised);
      if (!profile) {
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

      return profile;
    });

  // -------------------------------------------------------------------------
  // Passkey: complete login (PKCE — returns an authorization code, exchanged
  // at /token). Kept for the hosted HTML third-party flow.
  // -------------------------------------------------------------------------

  const completePasskeyLogin = (
    identifier: string,
    assertion: AuthenticationResponseJSON,
  ): Effect.Effect<{ code: string; profileId: string }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const profile = yield* verifyPasskeyAssertion(identifier, assertion);
      const code = yield* issueCode(profile.id);
      return { code, profileId: profile.id };
    }).pipe(withAuthLogin("passkey"));

  // -------------------------------------------------------------------------
  // Passkey: complete login — direct session (first-party path, bypasses
  // PKCE and returns a Session + PublicProfile directly).
  // -------------------------------------------------------------------------

  const completePasskeyLoginDirect = (
    identifier: string,
    assertion: AuthenticationResponseJSON,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<{ session: TokenSet; profile: PublicProfile }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const profile = yield* verifyPasskeyAssertion(identifier, assertion);
      const session = yield* issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        sessionMeta,
      );
      return { session, profile: toPublicProfile(profile, profile.email) };
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

      const profile = yield* resolveIdentifier(normalised);
      if (!profile) {
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      const code = genOtpCode();

      // Key by normalised identifier so completeOtp can check in-memory first.
      otpStore.set(normalised, {
        codeHash: hashSessionToken(code),
        profileId: profile.id,
        attempts: 0,
        expiresAt: Date.now() + otpTtl * 1000,
      });

      if (config.sendEmail) {
        yield* Effect.tryPromise({
          try: () =>
            config.sendEmail!(
              profile.email,
              "Your OSN sign-in code",
              `Your one-time sign-in code is: ${code}\n\nThis code expires in ${otpTtl / 60} minutes.`,
            ),
          catch: (cause) => new AuthError({ message: `Failed to send email: ${String(cause)}` }),
        });
      } else if (!process.env["OSN_ENV"] || process.env["OSN_ENV"] === "local") {
        // Local-only fallback when no email sender is configured. Guard uses
        // OSN_ENV (not NODE_ENV) so dev/staging/prod are excluded (S-L2). See
        // the matching block in beginRegistration for the interpolation rationale.
        yield* Effect.logDebug(`[OSN local] OTP for ${profile.email}: ${code}`);
      }

      metricAuthOtpSent("login");
      return { sent: true };
    }).pipe(Effect.withSpan("auth.otp.begin"));

  // -------------------------------------------------------------------------
  // OTP: verify code (extracted). Returns the full profile row so both the
  // code-issuing and direct-session completion paths can read email/handle/
  // displayName off it.
  // -------------------------------------------------------------------------

  const verifyOtpCode = (
    identifier: string,
    code: string,
  ): Effect.Effect<ProfileWithEmail, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      // Check in-memory store first — no DB hit on expired/invalid attempts.
      const normalised = normaliseIdentifier(identifier);
      const entry = otpStore.get(normalised);
      if (!entry || Date.now() > entry.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }
      if (!timingSafeEqualString(entry.codeHash, hashSessionToken(code))) {
        entry.attempts++;
        if (entry.attempts >= MAX_OTP_ATTEMPTS) {
          otpStore.delete(normalised);
        }
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }
      otpStore.delete(normalised);

      const profile = yield* findProfileById(entry.profileId);
      if (!profile) {
        return yield* Effect.fail(new AuthError({ message: "Profile not found" }));
      }
      return profile;
    });

  // -------------------------------------------------------------------------
  // OTP: complete (PKCE — returns an authorization code)
  // -------------------------------------------------------------------------

  const completeOtp = (
    identifier: string,
    code: string,
  ): Effect.Effect<{ code: string; profileId: string }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const profile = yield* verifyOtpCode(identifier, code);
      const authCode = yield* issueCode(profile.id);
      return { code: authCode, profileId: profile.id };
    }).pipe(withAuthLogin("otp"));

  // -------------------------------------------------------------------------
  // OTP: complete direct (first-party — returns a Session + PublicProfile)
  // -------------------------------------------------------------------------

  const completeOtpDirect = (
    identifier: string,
    code: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<{ session: TokenSet; profile: PublicProfile }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const profile = yield* verifyOtpCode(identifier, code);
      const session = yield* issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        sessionMeta,
      );
      return { session, profile: toPublicProfile(profile, profile.email) };
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

      const profile = yield* resolveIdentifier(normalised);
      if (!profile) {
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      const token = genId("mlnk_") + crypto.randomUUID().replace(/-/g, "");
      const hashedToken = hashSessionToken(token);

      magicStore.set(hashedToken, {
        profileId: profile.id,
        expiresAt: Date.now() + magicTtl * 1000,
      });

      const magicUrl = `${config.issuerUrl}/magic/verify?token=${token}`;

      if (config.sendEmail) {
        yield* Effect.tryPromise({
          try: () =>
            config.sendEmail!(
              profile.email,
              "Your OSN magic sign-in link",
              `Click this link to sign in: ${magicUrl}\n\nThis link expires in ${magicTtl / 60} minutes.`,
            ),
          catch: (cause) => new AuthError({ message: `Failed to send email: ${String(cause)}` }),
        });
      } else if (!process.env["OSN_ENV"] || process.env["OSN_ENV"] === "local") {
        // Local-only fallback when no email sender is configured. Guard uses
        // OSN_ENV (not NODE_ENV) so dev/staging/prod are excluded (S-L2). See
        // the matching block in beginRegistration for the interpolation rationale.
        yield* Effect.logDebug(`[OSN local] Magic link for ${profile.email}: ${magicUrl}`);
      }

      metricAuthMagicLinkSent("ok");
      return { sent: true };
    }).pipe(Effect.withSpan("auth.magic_link.begin"));

  // -------------------------------------------------------------------------
  // Magic link: consume token (extracted). Atomically removes the entry and
  // returns the profile. Shared by both the PKCE redirect path and the first-
  // party direct-session path.
  // -------------------------------------------------------------------------

  const consumeMagicToken = (
    token: string,
  ): Effect.Effect<ProfileWithEmail, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const hashedToken = hashSessionToken(token);
      const entry = magicStore.get(hashedToken);
      if (!entry || Date.now() > entry.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Magic link expired or not found" }));
      }
      magicStore.delete(hashedToken);

      const profile = yield* findProfileById(entry.profileId);
      if (!profile) {
        return yield* Effect.fail(new AuthError({ message: "Profile not found" }));
      }
      return profile;
    }).pipe(Effect.withSpan("auth.magic_link.verify"));

  // -------------------------------------------------------------------------
  // Magic link: verify (PKCE — returns a redirectUrl with an auth code)
  // -------------------------------------------------------------------------

  const verifyMagic = (
    token: string,
    redirectUri: string,
    state: string,
  ): Effect.Effect<{ redirectUrl: string }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* validateRedirectUri(redirectUri);
      const profile = yield* consumeMagicToken(token);
      const code = yield* issueCode(profile.id);
      const url = new URL(redirectUri);
      url.searchParams.set("code", code);
      url.searchParams.set("state", state);
      return { redirectUrl: url.toString() };
    }).pipe(withAuthLogin("magic_link"));

  // -------------------------------------------------------------------------
  // Magic link: verify direct (first-party — returns a Session + PublicProfile)
  // -------------------------------------------------------------------------

  const verifyMagicDirect = (
    token: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<{ session: TokenSet; profile: PublicProfile }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const profile = yield* consumeMagicToken(token);
      const session = yield* issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        sessionMeta,
      );
      return { session, profile: toPublicProfile(profile, profile.email) };
    }).pipe(withAuthLogin("magic_link"));

  // -------------------------------------------------------------------------
  // Profile switching (P2 — multi-account)
  // -------------------------------------------------------------------------

  /**
   * Lists all profiles belonging to the given account.
   * Returns `PublicProfile[]` — accountId is never exposed in the response.
   */
  const listAccountProfiles = (
    accountId: string,
  ): Effect.Effect<{ profiles: PublicProfile[] }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ profile: users, account: accounts })
            .from(users)
            .innerJoin(accounts, eq(users.accountId, accounts.id))
            .where(eq(users.accountId, accountId)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (rows.length === 0) {
        return yield* Effect.fail(new AuthError({ message: "Account not found" }));
      }
      const email = rows[0]!.account.email;
      return {
        profiles: rows.map((r) => toPublicProfile(r.profile, email)),
      };
    }).pipe(withProfileSwitch("list"));

  /**
   * Switches to a different profile under the same account. Confirms the
   * target profile belongs to the given account, then issues a new access
   * token scoped to that profile.
   */
  const switchProfile = (
    accountId: string,
    targetProfileId: string,
  ): Effect.Effect<
    { accessToken: string; expiresIn: number; profile: PublicProfile },
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      // Per-account rate limit (S-M3): bounds damage from a stolen token.
      if (!checkProfileSwitchLimit(accountId)) {
        return yield* Effect.fail(new AuthError({ message: "Too many profile switches" }));
      }
      const profile = yield* findProfileById(targetProfileId);
      if (!profile) {
        return yield* Effect.fail(new AuthError({ message: "Profile not found" }));
      }
      if (profile.accountId !== accountId) {
        return yield* Effect.fail(
          new AuthError({ message: "Profile does not belong to this account" }),
        );
      }
      // Issue only a new access token — the session token is account-scoped and unchanged.
      const accessToken = yield* issueAccessToken(
        profile.id,
        profile.email,
        profile.handle,
        profile.displayName,
      );
      return {
        accessToken,
        expiresIn: accessTokenTtl,
        profile: toPublicProfile(profile, profile.email),
      };
    }).pipe(withProfileSwitch("switch"));

  // -------------------------------------------------------------------------
  // Session invalidation (Copenhagen Book C1 — revocation)
  // -------------------------------------------------------------------------

  /**
   * Invalidates a single session by deleting its DB row. Used by the
   * `/logout` endpoint. Silently succeeds if the session doesn't exist
   * (idempotent — don't leak whether a session was valid).
   */
  const invalidateSession = (sessionToken: string): Effect.Effect<void, DatabaseError, Db> =>
    Effect.gen(function* () {
      const sessionId = hashSessionToken(sessionToken);
      const { db } = yield* Db;
      yield* Effect.tryPromise({
        try: () => db.delete(sessions).where(eq(sessions.id, sessionId)),
        catch: (cause) => new DatabaseError({ cause }),
      });
    });

  /**
   * Invalidates ALL sessions for an account. Used when a security event
   * demands full session revocation (e.g. passkey registration, email
   * change, account compromise). See auth improvements H1.
   */
  const invalidateAccountSessions = (accountId: string): Effect.Effect<void, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      yield* Effect.tryPromise({
        try: () => db.delete(sessions).where(eq(sessions.accountId, accountId)),
        catch: (cause) => new DatabaseError({ cause }),
      });
    });

  /**
   * Invalidates all sessions for an account EXCEPT the one identified by
   * `keepSessionHash`. Used after security events (H1) where the current
   * session should survive but all others must be revoked (e.g. passkey
   * registration from an authenticated session).
   */
  const invalidateOtherAccountSessions = (
    accountId: string,
    keepSessionHash: string,
  ): Effect.Effect<void, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      yield* Effect.tryPromise({
        try: () =>
          db
            .delete(sessions)
            .where(and(eq(sessions.accountId, accountId), ne(sessions.id, keepSessionHash))),
        catch: (cause) => new DatabaseError({ cause }),
      });
      metricSessionSecurityInvalidation("passkey_register");
    }).pipe(Effect.withSpan("auth.session.invalidate_other"));

  // -------------------------------------------------------------------------
  // Recovery codes (Copenhagen Book M2)
  //
  // Single-use, high-entropy account-recovery tokens. Raw codes are returned
  // exactly once to the caller (the UI shows them and prompts the user to
  // save them). The server stores only the SHA-256 hash.
  //
  // Generation replaces any existing set atomically — regenerating invalidates
  // the old codes, which is the only way to revoke a leaked set.
  //
  // Consumption marks the matched row as used (kept for audit) and revokes
  // all active sessions for the account. The recovery route then issues a
  // fresh session for the caller, so the net effect is "log out everywhere
  // else and log me back in here".
  // -------------------------------------------------------------------------

  const generateRecoveryCodesForAccount = (
    accountId: string,
    eventMeta?: SessionMeta,
  ): Effect.Effect<{ recoveryCodes: string[] }, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const codes = cryptoGenerateRecoveryCodes(RECOVERY_CODE_COUNT);
      const nowSec = Math.floor(Date.now() / 1000);
      const rows = codes.map((code) => ({
        id: genId("rec_"),
        accountId,
        codeHash: hashRecoveryCode(code),
        usedAt: null,
        createdAt: nowSec,
      }));

      // M-PK1b: the recovery-code swap and the matching security_events row
      // commit together. If the audit write fails, the code swap rolls back
      // too — we never want codes in the DB that the account holder can't
      // see in their security banner.
      const securityEventRow: typeof securityEvents.$inferInsert = {
        id: genId("sev_"),
        accountId,
        kind: "recovery_code_generate",
        createdAt: nowSec,
        acknowledgedAt: null,
        ipHash: eventMeta?.ip ? hashIp(eventMeta.ip) : null,
        uaLabel: eventMeta?.uaLabel ?? null,
      };

      yield* Effect.tryPromise({
        try: () =>
          db.transaction(async (tx) => {
            await tx.delete(recoveryCodes).where(eq(recoveryCodes.accountId, accountId));
            await tx.insert(recoveryCodes).values(rows);
            await tx.insert(securityEvents).values(securityEventRow);
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      metricRecoveryCodesGenerated();
      // S-L3 (symmetric): regenerating the set is a security-relevant event
      // worth surfacing on the session-invalidation dashboard. It doesn't
      // revoke sessions itself, but it does invalidate the previous code set
      // — an out-of-band regen (XSS-triggered, S-M1) is exactly the pattern
      // we want to notice.
      metricSessionSecurityInvalidation("recovery_code_generate");
      metricSecurityEventRecorded("recovery_code_generate");

      // M-PK1b / P-W2: fire-and-forget email notification. The audit row is
      // the primary signal, so user-visible latency must not track mailer
      // health. Fork onto the scheduler with a hard timeout so a slow
      // provider can't tie up the request handler. Failure is logged via
      // the metric branches inside `notifyRecovery`.
      yield* Effect.forkDaemon(
        notifyRecoveryByAccountId(accountId, "recovery_code_generate").pipe(
          Effect.timeout("10 seconds"),
          Effect.catchAll(() => Effect.void),
        ),
      );

      return { recoveryCodes: codes };
    }).pipe(withAuthRecovery("generate"));

  /**
   * Resolves the recipient email for a security-event notification from the
   * accounts table and dispatches via `notifyRecovery`. Used by the
   * fire-and-forget paths in generate/consume which don't already hold the
   * profile row. Stays out of the user's latency path (called inside
   * `Effect.forkDaemon`), so the extra round-trip is harmless.
   */
  const notifyRecoveryByAccountId = (
    accountId: string,
    kind: SecurityEventKind,
  ): Effect.Effect<void, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () => db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const email = rows[0]?.email ?? null;
      yield* notifyRecovery(email, kind);
    });

  /**
   * Sends the out-of-band "your recovery codes were regenerated" OR "your
   * recovery codes were used" email. S-L5 framing ("somebody asked for this
   * on your account") mirrors the email-change ceremony so a misdirected
   * message is clearly junk to the recipient and useless as a phishing
   * template.
   *
   * Never includes the codes themselves — the audit row is the signal, the
   * email is the confirmation.
   *
   * P-I5: accepts the recipient email directly so the common call path
   * doesn't re-fetch the `accounts` row — the caller already has it.
   */
  const notifyRecovery = (
    recipientEmail: string | null,
    kind: SecurityEventKind,
  ): Effect.Effect<void, AuthError> =>
    Effect.gen(function* () {
      if (!recipientEmail) {
        // Defensive: account row fully evicted between commit and dispatch.
        metricSecurityEventNotified(kind, "skipped");
        return;
      }

      if (!config.sendEmail) {
        // Local dev with no configured mailer — log the notification for
        // parity with the OTP dev-log path.
        yield* Effect.logDebug(
          `[OSN local] Recovery-${kind} notice for ${recipientEmail}: audit row written`,
        );
        metricSecurityEventNotified(kind, "skipped");
        return;
      }

      const subject =
        kind === "recovery_code_generate"
          ? "Your OSN recovery codes were regenerated"
          : "An OSN recovery code was used on your account";
      const body =
        kind === "recovery_code_generate"
          ? `Somebody generated a new set of OSN account recovery codes on your account. If that was you, no further action is needed — your previous codes are no longer valid.\n\nIf this wasn't you: sign in and review your active sessions at the Sessions tab, then acknowledge the alert.`
          : `An OSN recovery code was used to regain access to your account. If that was you, no further action is needed.\n\nIf this wasn't you: your account may be compromised. Change any shared passwords, review your active sessions, and acknowledge the alert.`;

      const start = Date.now();
      yield* Effect.tryPromise({
        try: () => config.sendEmail!(recipientEmail, subject, body),
        // S-L2: bounded error class name in the log annotation; the email
        // provider's response body (which may echo the recipient) is never
        // embedded in the logged message.
        catch: () => new AuthError({ message: "notify_dispatch_failed" }),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            metricSecurityEventNotifyDuration((Date.now() - start) / 1000, "ok");
            metricSecurityEventNotified(kind, "sent");
          }),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            metricSecurityEventNotifyDuration((Date.now() - start) / 1000, "error");
            metricSecurityEventNotified(kind, "failed");
          }),
        ),
      );
    }).pipe(Effect.withSpan("auth.security_event.notify", { attributes: { kind } }));

  /**
   * Lists still-unacknowledged security events for an account, newest first.
   * Intended for the Settings banner — acknowledged rows are kept for audit
   * but are filtered out of the surface.
   *
   * P-I1: explicit projection so adding an internal column later (e.g. a
   * JSON context blob) doesn't silently grow the wire payload.
   */
  const listUnacknowledgedSecurityEvents = (
    accountId: string,
  ): Effect.Effect<{ events: SecurityEventSummary[] }, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: securityEvents.id,
              kind: securityEvents.kind,
              createdAt: securityEvents.createdAt,
              uaLabel: securityEvents.uaLabel,
              ipHash: securityEvents.ipHash,
            })
            .from(securityEvents)
            .where(
              and(eq(securityEvents.accountId, accountId), isNull(securityEvents.acknowledgedAt)),
            )
            .orderBy(desc(securityEvents.createdAt))
            .limit(50),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return {
        events: rows.map((row) => ({
          id: row.id,
          // Service boundary re-asserts the bounded kind union so a hand-
          // written INSERT (or a downgrade that widens the column) can't
          // leak an unbounded string into the metric attribute.
          kind: row.kind as SecurityEventKind,
          createdAt: row.createdAt,
          uaLabel: row.uaLabel,
          ipHash: row.ipHash,
        })),
      };
    }).pipe(Effect.withSpan("auth.security_event.list"));

  /**
   * Marks a single security event as acknowledged.
   *
   * S-M1: step-up gated. Without step-up, an XSS that sniffed the access
   * token could GET the list and POST ack on every id before the user ever
   * saw the banner — the banner is the defence against the very scenario
   * that compromised the access token, so it can't be dismissible by that
   * same token. Allowed amr defaults to `["webauthn", "otp"]`, matching the
   * `/recovery/generate` gate.
   *
   * Idempotent on the row side — acking a row that's already acknowledged,
   * or a row that doesn't exist on the caller's account, returns
   * `{ acknowledged: false }` rather than surfacing "not found" (same posture
   * as `/logout` and `/sessions/:id`). The step-up jti is still consumed on
   * such calls; callers are expected to bulk-ack via
   * `acknowledgeAllSecurityEvents` when dismissing a full banner.
   */
  const acknowledgeSecurityEvent = (
    accountId: string,
    eventId: string,
    stepUpToken: string,
  ): Effect.Effect<{ acknowledged: boolean }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(stepUpToken, accountId, recoveryGenerateAllowedAmr);

      if (!/^sev_[a-f0-9]{12}$/.test(eventId)) {
        return { acknowledged: false };
      }
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      const existing = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ id: securityEvents.id, kind: securityEvents.kind })
            .from(securityEvents)
            .where(
              and(
                eq(securityEvents.id, eventId),
                eq(securityEvents.accountId, accountId),
                isNull(securityEvents.acknowledgedAt),
              ),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const match = existing[0];
      if (!match) {
        return { acknowledged: false };
      }
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(securityEvents)
            .set({ acknowledgedAt: nowSec })
            .where(eq(securityEvents.id, match.id)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      metricSecurityEventAcknowledged(match.kind as SecurityEventKind);
      return { acknowledged: true };
    }).pipe(Effect.withSpan("auth.security_event.ack"));

  /**
   * Bulk-acks every unacknowledged security event for an account in a single
   * transaction. One step-up → one call dismisses the entire banner. This is
   * the UX path the banner uses; `acknowledgeSecurityEvent` remains for API
   * clients that want per-row control.
   *
   * S-M1: step-up gated on the same amr set as `/recovery/generate`.
   */
  const acknowledgeAllSecurityEvents = (
    accountId: string,
    stepUpToken: string,
  ): Effect.Effect<{ acknowledged: number }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(stepUpToken, accountId, recoveryGenerateAllowedAmr);

      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      const unacked = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ id: securityEvents.id, kind: securityEvents.kind })
            .from(securityEvents)
            .where(
              and(eq(securityEvents.accountId, accountId), isNull(securityEvents.acknowledgedAt)),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (unacked.length === 0) {
        return { acknowledged: 0 };
      }
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(securityEvents)
            .set({ acknowledgedAt: nowSec })
            .where(
              and(eq(securityEvents.accountId, accountId), isNull(securityEvents.acknowledgedAt)),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      for (const row of unacked) {
        metricSecurityEventAcknowledged(row.kind as SecurityEventKind);
      }
      return { acknowledged: unacked.length };
    }).pipe(Effect.withSpan("auth.security_event.ack_all"));

  /**
   * Consumes a recovery code — returns the profile to establish a fresh
   * session against, and marks the code row as used. Invalidates every
   * existing session for the account before the caller issues the new one.
   *
   * Always fails with the same generic AuthError on unknown identifier,
   * unknown/used code, or expired lookups — does not distinguish between
   * "wrong identifier" and "wrong code" over the wire.
   *
   * S-M2: both branches (unknown identifier vs known identifier + wrong code)
   * execute the same work — identifier lookup, a `hashRecoveryCode` call, and
   * an indexed SELECT against `recovery_codes` — so wall-clock latency does
   * not reveal whether the identifier exists.
   */
  const consumeRecoveryCode = (
    identifier: string,
    code: string,
    eventMeta?: SessionMeta,
  ): Effect.Effect<{ profile: ProfileWithEmail }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const normalised = normaliseIdentifier(identifier);
      const profile = yield* resolveIdentifier(normalised);
      const { db } = yield* Db;

      // Compute the hash up front regardless of profile existence so both
      // branches pay the same SHA-256 cost (S-M2).
      const codeHash = hashRecoveryCode(code);

      if (!profile) {
        // Equalise DB work on the unknown-identifier branch with a same-shape
        // no-op lookup (predicate can never match since the accountId is an
        // impossible sentinel). Indexed by `recovery_codes_account_idx`.
        yield* Effect.tryPromise({
          try: () =>
            db
              .select()
              .from(recoveryCodes)
              .where(
                and(
                  eq(recoveryCodes.accountId, "__nonexistent__"),
                  eq(recoveryCodes.codeHash, codeHash),
                ),
              )
              .limit(1),
          catch: (cause) => new DatabaseError({ cause }),
        });
        metricRecoveryCodeConsumed("invalid");
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(recoveryCodes)
            .where(
              and(
                eq(recoveryCodes.accountId, profile.accountId),
                eq(recoveryCodes.codeHash, codeHash),
              ),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = result[0];
      if (!row) {
        metricRecoveryCodeConsumed("invalid");
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }
      if (row.usedAt !== null) {
        metricRecoveryCodeConsumed("used");
        yield* Effect.logWarning("Used recovery code replayed");
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      const nowSec = Math.floor(Date.now() / 1000);
      // S-H1: a recovery-code CONSUME is the actual takeover step in the
      // attacker-burns-codes scenario. Record the audit row in the same
      // transaction as the sessions wipe so the legitimate owner can see
      // "a recovery code was used on your account" even if the attacker
      // suppressed the confirmation email.
      const securityEventRow: typeof securityEvents.$inferInsert = {
        id: genId("sev_"),
        accountId: profile.accountId,
        kind: "recovery_code_consume",
        createdAt: nowSec,
        acknowledgedAt: null,
        ipHash: eventMeta?.ip ? hashIp(eventMeta.ip) : null,
        uaLabel: eventMeta?.uaLabel ?? null,
      };
      yield* Effect.tryPromise({
        try: () =>
          db.transaction(async (tx) => {
            await tx
              .update(recoveryCodes)
              .set({ usedAt: nowSec })
              .where(eq(recoveryCodes.id, row.id));
            // Recovery always revokes existing sessions — the ceremony is
            // "I lost access, log me back in cleanly everywhere".
            await tx.delete(sessions).where(eq(sessions.accountId, profile.accountId));
            await tx.insert(securityEvents).values(securityEventRow);
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      metricRecoveryCodeConsumed("success");
      // S-L3: whole-account session wipe is a security-relevant event — emit
      // the canonical invalidation metric so the existing dashboard covers it.
      metricSessionSecurityInvalidation("recovery_code_consume");
      metricSecurityEventRecorded("recovery_code_consume");

      // M-PK1b / P-W2: fire-and-forget consume notification with a timeout
      // so the login latency is decoupled from mailer health. The profile
      // is already loaded so we pass the email directly — no post-commit
      // accounts round-trip.
      yield* Effect.forkDaemon(
        notifyRecovery(profile.email, "recovery_code_consume").pipe(
          Effect.timeout("10 seconds"),
          Effect.catchAll(() => Effect.void),
        ),
      );

      return { profile };
    }).pipe(withAuthRecovery("consume"));

  /**
   * Completes a recovery-code login. Consumes the code, then issues a fresh
   * session + profile in one step so the route can return the same shape as
   * the other first-party `/login/*` completers.
   */
  const completeRecoveryLogin = (
    identifier: string,
    code: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<{ session: TokenSet; profile: PublicProfile }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { profile } = yield* consumeRecoveryCode(identifier, code, sessionMeta);
      const session = yield* issueTokens(
        profile.id,
        profile.accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        sessionMeta,
      );
      return { session, profile: toPublicProfile(profile, profile.email) };
    }).pipe(withAuthLogin("recovery_code"));

  // -------------------------------------------------------------------------
  // Step-up (sudo) tokens — M-PK1
  //
  // Short-lived ES256 JWTs minted by a fresh authentication ceremony
  // (passkey or OTP to the account's verified email) and required by the
  // most sensitive endpoints (recovery-code generation, email change).
  // Signed with the same ES256 key as access tokens but with a distinct
  // audience claim (`osn-step-up`) so they cannot be cross-used.
  //
  // Replay guard: every token has a unique `jti`. On first successful
  // consumption the jti is recorded in `consumedStepUpTokens`; subsequent
  // presentations fail. The map is swept opportunistically on every
  // verify to bound memory.
  // -------------------------------------------------------------------------

  const STEP_UP_AUDIENCE = "osn-step-up";

  const issueStepUpToken = (accountId: string, factor: StepUpFactor) =>
    Effect.gen(function* () {
      // Map the ceremony factor onto RFC 8176 "amr" values the verifier reads.
      const amr = factor === "passkey" ? "webauthn" : factor === "otp" ? "otp" : "recovery";
      const token = yield* Effect.tryPromise({
        try: () =>
          signJwt(
            {
              sub: accountId,
              aud: STEP_UP_AUDIENCE,
              amr: [amr],
              jti: crypto.randomUUID(),
            },
            config.jwtPrivateKey,
            config.jwtKid,
            stepUpTokenTtl,
          ),
        catch: (cause) => new AuthError({ message: String(cause) }),
      });
      metricStepUpIssued(factor);
      return token;
    });

  /**
   * Verifies a step-up token and returns the amr values it carries. Fails
   * with an AuthError on any signature / audience / expiry / replay issue;
   * the error message is intentionally generic so the wire doesn't leak
   * whether it was a wrong sub or a replayed jti.
   */
  const verifyStepUpToken = (
    token: string,
    expectedAccountId: string,
    allowedAmr: ReadonlySet<string>,
  ): Effect.Effect<{ amr: string[] }, AuthError> =>
    Effect.gen(function* () {
      const record = (result: StepUpVerifyResult) =>
        Effect.sync(() => metricStepUpVerified(result));

      const payloadResult = yield* Effect.tryPromise({
        try: () => verifyJwt(token, config.jwtPublicKey),
        catch: () => new AuthError({ message: "Invalid step-up token" }),
      }).pipe(Effect.tapError(() => record("invalid")));

      if (payloadResult["aud"] !== STEP_UP_AUDIENCE) {
        yield* record("wrong_audience");
        return yield* Effect.fail(new AuthError({ message: "Invalid step-up token" }));
      }
      if (typeof payloadResult["sub"] !== "string" || payloadResult["sub"] !== expectedAccountId) {
        yield* record("wrong_subject");
        return yield* Effect.fail(new AuthError({ message: "Invalid step-up token" }));
      }
      const jti = payloadResult["jti"];
      if (typeof jti !== "string") {
        yield* record("invalid");
        return yield* Effect.fail(new AuthError({ message: "Invalid step-up token" }));
      }

      const amrRaw = payloadResult["amr"];
      const amr = Array.isArray(amrRaw)
        ? amrRaw.filter((v): v is string => typeof v === "string")
        : [];
      if (!amr.some((v) => allowedAmr.has(v))) {
        yield* record("amr_not_allowed");
        return yield* Effect.fail(new AuthError({ message: "Step-up factor not permitted" }));
      }

      // S-H1: cluster-safe single-use guard. First consumer wins; every
      // subsequent presentation — local, another pod, or a replay after a
      // Redis failover — lands on the jti-already-consumed branch.
      const consumed = yield* Effect.tryPromise({
        try: () => jtiStore.consume(jti, stepUpTokenTtl * 1000),
        catch: () => new AuthError({ message: "Step-up token could not be verified" }),
      });
      if (!consumed) {
        yield* record("jti_replay");
        return yield* Effect.fail(new AuthError({ message: "Step-up token already used" }));
      }
      yield* record("ok");
      return { amr };
    });

  /**
   * Step-up passkey: begin. Caller is already authenticated; we scope
   * the challenge to their account so a stolen assertion for a different
   * credential cannot be replayed.
   */
  const beginStepUpPasskey = (
    accountId: string,
  ): Effect.Effect<
    { options: PublicKeyCredentialRequestOptionsJSON },
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const accountPasskeys = yield* Effect.tryPromise({
        try: () => db.select().from(passkeys).where(eq(passkeys.accountId, accountId)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (accountPasskeys.length === 0) {
        return yield* Effect.fail(
          new AuthError({ message: "No passkeys registered for this account" }),
        );
      }
      const options = yield* Effect.tryPromise({
        try: () =>
          generateAuthenticationOptions({
            rpID: config.rpId,
            allowCredentials: accountPasskeys.map((pk) => ({
              id: pk.credentialId,
              transports: pk.transports
                ? (JSON.parse(pk.transports) as AuthenticatorTransportFuture[])
                : undefined,
            })),
            userVerification: "preferred",
          }),
        catch: (cause) => new AuthError({ message: String(cause) }),
      });
      // P-I3: bound growth under ceremony-begin spam.
      sweepExpired(stepUpPasskeyChallenges);
      stepUpPasskeyChallenges.set(accountId, {
        challenge: options.challenge,
        expiresAt: Date.now() + 120_000,
      });
      return { options };
    }).pipe(withStepUp("begin"));

  /**
   * Step-up passkey: complete. Verifies the assertion against the account's
   * own challenge (not an identifier-keyed one — defence against a stolen
   * session being used to step up as somebody else) and mints the token.
   */
  const completeStepUpPasskey = (
    accountId: string,
    assertion: AuthenticationResponseJSON,
  ): Effect.Effect<{ stepUpToken: string; expiresIn: number }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const entry = stepUpPasskeyChallenges.get(accountId);
      if (!entry || Date.now() > entry.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Challenge expired or not found" }));
      }
      stepUpPasskeyChallenges.delete(accountId);

      const { db } = yield* Db;
      const pkResult = yield* Effect.tryPromise({
        try: () =>
          db.select().from(passkeys).where(eq(passkeys.credentialId, assertion.id)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const pk = pkResult[0];
      if (!pk || pk.accountId !== accountId) {
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

      const stepUpToken = yield* issueStepUpToken(accountId, "passkey");
      return { stepUpToken, expiresIn: stepUpTokenTtl };
    }).pipe(withStepUp("complete"));

  /**
   * Step-up OTP: begin. Emails a fresh 6-digit code to the account's
   * verified email. Keyed separately from login OTPs so a login code
   * cannot authorise a sensitive action and vice versa.
   */
  const beginStepUpOtp = (
    accountId: string,
  ): Effect.Effect<{ sent: boolean }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const accountRow = yield* Effect.tryPromise({
        try: () => db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const account = accountRow[0];
      if (!account) {
        return yield* Effect.fail(new AuthError({ message: "Account not found" }));
      }
      const code = genOtpCode();
      // P-I3: bound growth under ceremony-begin spam.
      sweepExpired(stepUpOtpStore);
      stepUpOtpStore.set(accountId, {
        codeHash: hashSessionToken(code),
        attempts: 0,
        expiresAt: Date.now() + otpTtl * 1000,
      });
      if (config.sendEmail) {
        yield* Effect.tryPromise({
          try: () =>
            config.sendEmail!(
              account.email,
              "Confirm a sensitive action",
              `Your OSN step-up code is: ${code}\n\nUse this to confirm a security-sensitive action. Expires in ${otpTtl / 60} minutes.`,
            ),
          catch: (cause) => new AuthError({ message: `Failed to send email: ${String(cause)}` }),
        });
      } else if (!process.env["OSN_ENV"] || process.env["OSN_ENV"] === "local") {
        yield* Effect.logDebug(`[OSN local] Step-up OTP for ${account.email}: ${code}`);
      }
      // S-L1: distinguish step-up OTPs from login OTPs on the dashboard.
      metricAuthOtpSent("step_up");
      return { sent: true };
    }).pipe(withStepUp("begin"));

  const completeStepUpOtp = (
    accountId: string,
    code: string,
  ): Effect.Effect<{ stepUpToken: string; expiresIn: number }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const entry = stepUpOtpStore.get(accountId);
      if (!entry || Date.now() > entry.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }
      if (!timingSafeEqualString(entry.codeHash, hashSessionToken(code))) {
        entry.attempts++;
        if (entry.attempts >= MAX_OTP_ATTEMPTS) stepUpOtpStore.delete(accountId);
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }
      stepUpOtpStore.delete(accountId);
      const stepUpToken = yield* issueStepUpToken(accountId, "otp");
      return { stepUpToken, expiresIn: stepUpTokenTtl };
    }).pipe(withStepUp("complete"));

  const verifyStepUpForRecoveryGenerate = (
    accountId: string,
    stepUpToken: string,
  ): Effect.Effect<void, AuthError> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(stepUpToken, accountId, recoveryGenerateAllowedAmr);
    });

  // -------------------------------------------------------------------------
  // Session introspection + revocation
  // -------------------------------------------------------------------------

  const listAccountSessions = (
    accountId: string,
    currentSessionHash: string | null,
  ): Effect.Effect<{ sessions: SessionSummary[] }, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      // P-W2: hard cap defends the Settings page against pathological
      // accounts. MAX_SESSIONS_PER_ACCOUNT is the real ceiling (enforced
      // at issueTokens) but the LIMIT here is belt-and-braces plus a
      // signal to the planner.
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(sessions)
            .where(eq(sessions.accountId, accountId))
            .orderBy(desc(sessions.lastUsedAt))
            .limit(MAX_SESSIONS_PER_ACCOUNT),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return {
        sessions: rows.map((row) => ({
          id: sessionHandleFromHash(row.id),
          uaLabel: row.uaLabel,
          createdAt: row.createdAt,
          lastUsedAt: row.lastUsedAt,
          expiresAt: row.expiresAt,
          isCurrent: currentSessionHash !== null && row.id === currentSessionHash,
        })),
      };
    }).pipe(withSessionOp("list"));

  /**
   * Revokes a single session by its public handle (first 16 hex chars of
   * the SHA-256). Scopes the DELETE to the caller's accountId so a stolen
   * handle from another account's log line can't revoke anyone else's
   * sessions. Returns whether the caller's own session was the one revoked
   * so the HTTP layer can clear the cookie.
   *
   * S-M4: Idempotent — a handle that doesn't match any row returns
   * `{ revokedSelf: false }` rather than surfacing "Session not found".
   * This mirrors the `/logout` posture ("don't leak whether the session
   * existed") and closes the handle-existence oracle.
   *
   * P-W1: The match uses a `LIKE 'handle%'` predicate so the DB returns
   * at most one row via the PK index rather than fetching every session
   * for the account into JS and finding in-memory.
   */
  const revokeAccountSession = (
    accountId: string,
    sessionHandle: string,
    currentSessionHash: string | null,
  ): Effect.Effect<{ revokedSelf: boolean }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      // Short-circuit on malformed handles so the LIKE pattern stays
      // safe (no escape concerns since we've already enforced [0-9a-f]{16}
      // at the route but defence-in-depth at the service boundary).
      if (!/^[0-9a-f]{16}$/.test(sessionHandle)) {
        return { revokedSelf: false };
      }
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ id: sessions.id })
            .from(sessions)
            .where(and(eq(sessions.accountId, accountId), like(sessions.id, `${sessionHandle}%`)))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const match = rows[0];
      if (!match) {
        // S-M4: idempotent — indistinguishable from a no-op revoke of a
        // handle that existed for a different account (scoping predicate
        // already filtered those out).
        return { revokedSelf: false };
      }
      yield* Effect.tryPromise({
        try: () => db.delete(sessions).where(eq(sessions.id, match.id)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      metricSessionSecurityInvalidation("session_revoke");
      return { revokedSelf: currentSessionHash !== null && match.id === currentSessionHash };
    }).pipe(withSessionOp("revoke"));

  /**
   * Revokes all sessions for the account except the caller's, for the
   * "Sign out everywhere else" button in Settings.
   */
  const revokeAllOtherAccountSessions = (
    accountId: string,
    currentSessionHash: string,
  ): Effect.Effect<void, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      yield* Effect.tryPromise({
        try: () =>
          db
            .delete(sessions)
            .where(and(eq(sessions.accountId, accountId), ne(sessions.id, currentSessionHash))),
        catch: (cause) => new DatabaseError({ cause }),
      });
      metricSessionSecurityInvalidation("session_revoke_all");
    }).pipe(withSessionOp("revoke_all"));

  // -------------------------------------------------------------------------
  // Email change (step-up gated)
  // -------------------------------------------------------------------------

  const EMAIL_CHANGE_LIMIT = 2;
  const EMAIL_CHANGE_WINDOW_SECONDS = 7 * 24 * 60 * 60;

  const beginEmailChange = (
    accountId: string,
    newEmail: string,
  ): Effect.Effect<{ sent: boolean }, AuthError | ValidationError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknown(EmailSchema)(newEmail).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      const normalised = newEmail.toLowerCase();
      const { db } = yield* Db;

      // S-H3: per-account cap beneath the per-IP rate limit. An attacker
      // with a stolen access token behind a rotating-IP proxy can't pool
      // their allowance to spam the OSN sending domain at arbitrary inboxes.
      const nowMs = Date.now();
      const bucket = emailChangeBeginCounts.get(accountId);
      if (!bucket || nowMs >= bucket.resetAt) {
        emailChangeBeginCounts.set(accountId, {
          count: 1,
          resetAt: nowMs + EMAIL_CHANGE_BEGIN_PER_ACCOUNT_WINDOW_MS,
        });
      } else if (bucket.count >= EMAIL_CHANGE_BEGIN_PER_ACCOUNT_MAX) {
        return yield* Effect.fail(new AuthError({ message: "Too many email change attempts" }));
      } else {
        bucket.count += 1;
      }
      // Sweep stale buckets opportunistically (P-I3).
      for (const [k, v] of emailChangeBeginCounts) {
        if (nowMs >= v.resetAt) emailChangeBeginCounts.delete(k);
      }
      sweepExpired(pendingEmailChanges);

      const currentAccount = yield* Effect.tryPromise({
        try: () => db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const account = currentAccount[0];
      if (!account) {
        return yield* Effect.fail(new AuthError({ message: "Account not found" }));
      }
      if (account.email === normalised) {
        return yield* Effect.fail(new AuthError({ message: "New email matches current email" }));
      }

      // S-H2: silently succeed on collisions — an authenticated caller
      // must not learn whether another account owns an email. Registration
      // treats this as first-class (see the `beginRegistration` comment);
      // email change must match. The UNIQUE(email) constraint at `complete`
      // is the real defence against a race-winning swap.
      const collision = yield* Effect.tryPromise({
        try: () => db.select().from(accounts).where(eq(accounts.email, normalised)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (collision.length > 0) {
        return { sent: true };
      }

      // P-W3: 2-per-7-days cap uses an indexed aggregate instead of a full
      // history fetch. `email_changes_completed_at_idx` + the account filter
      // serve the predicate.
      const windowStart = Math.floor(Date.now() / 1000) - EMAIL_CHANGE_WINDOW_SECONDS;
      const recentCount = yield* Effect.tryPromise({
        try: async () => {
          const [row] = await db
            .select({ count: countFn() })
            .from(emailChanges)
            .where(
              and(
                eq(emailChanges.accountId, accountId),
                gte(emailChanges.completedAt, windowStart),
              ),
            );
          return Number(row?.count ?? 0);
        },
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (recentCount >= EMAIL_CHANGE_LIMIT) {
        return yield* Effect.fail(
          new AuthError({ message: "Email change limit reached (2 per 7 days)" }),
        );
      }

      const code = genOtpCode();
      pendingEmailChanges.set(accountId, {
        newEmail: normalised,
        codeHash: hashSessionToken(code),
        attempts: 0,
        expiresAt: Date.now() + otpTtl * 1000,
      });

      if (config.sendEmail) {
        yield* Effect.tryPromise({
          try: () =>
            config.sendEmail!(
              normalised,
              "Confirm your new OSN email",
              // S-L5: explicit "somebody asked for this on your account"
              // framing so a mistakenly-delivered message is clearly junk
              // to the recipient and useless as a phishing template.
              `An OSN account holder requested this email address be associated with their account. If that wasn't you, you can ignore this message safely.\n\nYour OSN email change code is: ${code}\n\nExpires in ${otpTtl / 60} minutes.`,
            ),
          catch: (cause) => new AuthError({ message: `Failed to send email: ${String(cause)}` }),
        });
      } else if (!process.env["OSN_ENV"] || process.env["OSN_ENV"] === "local") {
        yield* Effect.logDebug(`[OSN local] Email-change OTP for ${normalised}: ${code}`);
      }

      metricAuthOtpSent("email_change");
      return { sent: true };
    }).pipe(withEmailChange("begin"));

  /**
   * Finalises an email change. Requires:
   *   - A valid step-up token (passkey or OTP amr) for this account.
   *   - A valid OTP sent to the **new** email address.
   *   - < 2 completed changes in the last 7 days.
   *
   * On success: the accounts row is updated, every OTHER session is
   * revoked (the caller's stays so they don't get kicked out of the
   * Settings flow), and an audit row is inserted — all in one transaction
   * so we cannot leave the system in a half-changed state.
   */
  const completeEmailChange = (
    accountId: string,
    code: string,
    stepUpToken: string,
    currentSessionHash: string | null,
  ): Effect.Effect<{ email: string }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(stepUpToken, accountId, new Set(["webauthn", "otp"]));

      const pending = pendingEmailChanges.get(accountId);
      if (!pending || Date.now() > pending.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }
      if (!timingSafeEqualString(pending.codeHash, hashSessionToken(code))) {
        pending.attempts++;
        if (pending.attempts >= MAX_OTP_ATTEMPTS) pendingEmailChanges.delete(accountId);
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }

      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      const windowStart = nowSec - EMAIL_CHANGE_WINDOW_SECONDS;

      // P-W3 + P-I4: rate check + current-account fetch move OUT of the
      // transaction so the write section holds the writer lock as briefly
      // as possible. Race-safety is preserved by the UNIQUE(email)
      // constraint catching concurrent winners at `tx.update`.
      const preflight = yield* Effect.tryPromise({
        try: async () => {
          const [acct] = await db
            .select()
            .from(accounts)
            .where(eq(accounts.id, accountId))
            .limit(1);
          if (!acct) return { ok: false as const, reason: "not_found" as const };
          const [row] = await db
            .select({ count: countFn() })
            .from(emailChanges)
            .where(
              and(
                eq(emailChanges.accountId, accountId),
                gte(emailChanges.completedAt, windowStart),
              ),
            );
          if (Number(row?.count ?? 0) >= EMAIL_CHANGE_LIMIT) {
            return { ok: false as const, reason: "rate_limit" as const };
          }
          return { ok: true as const, current: acct };
        },
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (!preflight.ok) {
        if (preflight.reason === "not_found") {
          return yield* Effect.fail(new AuthError({ message: "Account not found" }));
        }
        return yield* Effect.fail(
          new AuthError({ message: "Email change limit reached (2 per 7 days)" }),
        );
      }
      const currentAccountRow = preflight.current;

      const changed = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await db.transaction(async (tx) => {
              await tx
                .update(accounts)
                .set({ email: pending.newEmail, updatedAt: new Date(nowSec * 1000) })
                .where(eq(accounts.id, accountId));

              await tx.insert(emailChanges).values({
                id: genId("ech_"),
                accountId,
                previousEmail: currentAccountRow.email,
                newEmail: pending.newEmail,
                completedAt: nowSec,
              });

              // Kill every other session in the same TX — a half-applied
              // change would leave a potentially-compromised session alive
              // with a stale email claim.
              if (currentSessionHash !== null) {
                await tx
                  .delete(sessions)
                  .where(
                    and(eq(sessions.accountId, accountId), ne(sessions.id, currentSessionHash)),
                  );
              } else {
                await tx.delete(sessions).where(eq(sessions.accountId, accountId));
              }

              return { ok: true as const, email: pending.newEmail };
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/UNIQUE|constraint/i.test(msg)) {
              return { ok: false as const, reason: "conflict" as const };
            }
            throw e;
          }
        },
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (!changed.ok) {
        // Only "conflict" can come out of the narrowed TX (preflight
        // already rejected not_found / rate_limit). Map to a generic
        // error that matches the begin-path enumeration posture.
        return yield* Effect.fail(new AuthError({ message: "Invalid or expired code" }));
      }

      pendingEmailChanges.delete(accountId);
      metricSessionSecurityInvalidation("email_change");
      return { email: changed.email };
    }).pipe(withEmailChange("complete"));

  /** Returns the count of unused recovery codes for the account. */
  const countActiveRecoveryCodes = (
    accountId: string,
  ): Effect.Effect<{ active: number; total: number }, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () => db.select().from(recoveryCodes).where(eq(recoveryCodes.accountId, accountId)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const active = rows.filter((r) => r.usedAt === null).length;
      return { active, total: rows.length };
    });

  return {
    findProfileByEmail,
    findProfileByHandle,
    findProfileById,
    findDefaultProfile,
    resolveIdentifier,
    registerProfile,
    beginRegistration,
    completeRegistration,
    issueEnrollmentToken,
    verifyEnrollmentToken,
    checkHandle,
    issueTokens,
    exchangeCode,
    refreshTokens,
    verifyRefreshToken,
    verifyAccessToken,
    switchProfile,
    listAccountProfiles,
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
    validateRedirectUri,
    invalidateSession,
    invalidateAccountSessions,
    invalidateOtherAccountSessions,
    generateRecoveryCodesForAccount,
    consumeRecoveryCode,
    completeRecoveryLogin,
    countActiveRecoveryCodes,
    listUnacknowledgedSecurityEvents,
    acknowledgeSecurityEvent,
    acknowledgeAllSecurityEvents,
    // Exposed so tests can pin the "account email missing" / "no mailer
    // configured" defensive branches; in production this is only invoked
    // internally by the generate/consume paths.
    notifyRecovery,
    notifyRecoveryByAccountId,
    beginStepUpPasskey,
    completeStepUpPasskey,
    beginStepUpOtp,
    completeStepUpOtp,
    verifyStepUpForRecoveryGenerate,
    listAccountSessions,
    revokeAccountSession,
    revokeAllOtherAccountSessions,
    beginEmailChange,
    completeEmailChange,
    hashSessionToken: (token: string) => hashSessionToken(token),
  };
}

// Type alias for the service
export type AuthService = ReturnType<typeof createAuthService>;
