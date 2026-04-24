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
import { EmailError, EmailService } from "@shared/email";
import type {
  SecurityEventKind,
  SecurityInvalidationTrigger,
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
import { and, count as countFn, desc, eq, gte, inArray, isNull, like, ne } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";
import { SignJWT, jwtVerify } from "jose";

import {
  createInMemoryRotatedSessionStore,
  type RotatedSessionStore,
} from "../lib/rotated-session-store";
import {
  classifyError,
  metricAuthHandleCheck,
  metricAuthOtpSent,
  metricPasskeyLoginDiscoverable,
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
  withCrossDeviceOp,
  withEmailChange,
  withPasskeyOp,
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
  /** Issuer URL (JWT issuer) */
  issuerUrl: string;
  /** ES256 private key for signing access and refresh tokens */
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
  /** OTP TTL in seconds (default: 600 = 10 min). Applies to registration, email change, and step-up OTP. */
  otpTtl?: number;
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
   * Permitted AMR values for `DELETE /passkeys/:id` step-up. Defaults to
   * passkey-only (`["webauthn"]`) — by construction the caller already
   * has at least one passkey (the last-passkey guard fires otherwise),
   * so accepting OTP would weaken the gate without UX gain (S-L4).
   */
  passkeyDeleteAllowedAmr?: readonly ("webauthn" | "otp")[];
  /**
   * Permitted AMR values for `/passkey/register/{begin,complete}` step-up
   * when the account already has ≥1 passkey (S-H1). First-passkey
   * enrollment bypasses the gate entirely — no step-up ceremony is
   * reachable before the account has any credentials. Defaults to
   * `["webauthn", "otp"]` because a user who legitimately wants to add a
   * second device may be doing so precisely because the original is hard
   * to reach; forcing passkey-only step-up would create a chicken-and-
   * egg.
   */
  passkeyRegisterAllowedAmr?: readonly ("webauthn" | "otp")[];
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

// ---------------------------------------------------------------------------
// Cross-device login in-memory store
// ---------------------------------------------------------------------------

/** Hard ceiling on concurrent pending CDL requests (P-I2). */
const MAX_PENDING_CDL = 1_000;
/** CDL request TTL in seconds. */
const CDL_TTL_SECONDS = 300; // 5 min

interface CrossDeviceRequest {
  requestId: string;
  /** SHA-256 of the 256-bit secret — the plaintext never touches the server. */
  secretHash: string;
  status: "pending" | "approved" | "rejected" | "consumed";
  /** Device B's coarse UA label. */
  uaLabel: string | null;
  /** Device B's peppered IP hash. */
  ipHash: string | null;
  expiresAt: number; // milliseconds (matches sweepExpired convention)
  createdAt: number; // milliseconds
  // Populated on approve:
  accountId?: string;
  session?: { accessToken: string; refreshToken: string; expiresIn: number };
  profile?: PublicProfile;
}

const pendingCrossDeviceRequests = new Map<string, CrossDeviceRequest>();
/**
 * Hard ceiling on concurrent unexpired passkey-login challenges (P-I2).
 * Rate limiting is the primary defence — this bound is the belt to the
 * rate limiter's braces and matches the shape used by the pending-
 * registrations store.
 */
const MAX_LOGIN_CHALLENGES = 10_000;
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
// Pending email-verification registrations, keyed by lowercased email.
const pendingRegistrations = new Map<string, PendingRegistration>();

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
 * User-chosen free-text nickname for a passkey. Trimmed client-side and here;
 * upper-bounded at 64 chars so a stored label fits inside any reasonable
 * settings-row display without having to `LIKE …%` truncate at read time.
 * Empty strings aren't valid — the caller should PATCH `null` to clear.
 */
const PasskeyLabelSchema = Schema.String.pipe(
  Schema.filter((s) => s.trim().length > 0 && s.length <= 64, {
    message: () => "Passkey label must be 1–64 characters",
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
 * Public-safe shape returned by `listPasskeys`. Deliberately omits
 * `publicKey` + `counter` (internal to the WebAuthn ceremony) and
 * `credentialId` (S-L2: not needed by the Settings UI; reduces the
 * supply-chain-attack surface for targeted-phishing exfiltration of
 * authenticator-model fingerprints). The opaque `pk_<hex>` `id` is the
 * only handle the management surface needs.
 */
export interface PasskeySummary {
  id: string;
  label: string | null;
  aaguid: string | null;
  transports: string[] | null;
  backupEligible: boolean | null;
  backupState: boolean | null;
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds — null if the credential has never been used for auth. */
  lastUsedAt: number | null;
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
 * Hard cap on passkeys per account (P-I10). An attacker with a stolen
 * access token (or a hijacked enrollment token) cannot add unlimited
 * credentials; 10 is comfortably above the real-world ceiling of one
 * passkey per device for a typical user.
 */
const MAX_PASSKEYS_PER_ACCOUNT = 10;
/**
 * Coalesce window for `passkeys.last_used_at` writes (mirrors
 * LAST_USED_AT_COALESCE_MS for sessions). Sub-minute accuracy on the
 * Settings surface buys nothing and adds a DB write per authenticator
 * ceremony — not worth it on the hot path.
 */
const PASSKEY_LAST_USED_COALESCE_MS = 60_000;
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
  const stepUpTokenTtl = config.stepUpTokenTtl ?? 300;
  const recoveryGenerateAllowedAmr = new Set<string>(
    config.recoveryGenerateAllowedAmr ?? ["webauthn", "otp"],
  );
  const passkeyDeleteAllowedAmr = new Set<string>(config.passkeyDeleteAllowedAmr ?? ["webauthn"]);
  const passkeyRegisterAllowedAmr = new Set<string>(
    config.passkeyRegisterAllowedAmr ?? ["webauthn", "otp"],
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
  ): Effect.Effect<
    { sent: boolean },
    AuthError | ValidationError | DatabaseError,
    Db | EmailService
  > =>
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

      // S-M3: the EmailService layer decides whether to actually dispatch
      // or just log. `LogEmailLive` (local dev + tests) captures the
      // rendered body in-memory for operator inspection without opening
      // a network connection; `CloudflareEmailLive` (staging / prod)
      // POSTs directly to the Cloudflare Email Service REST API.
      const emailSvc = yield* EmailService;
      yield* emailSvc
        .send({
          template: "otp-registration",
          to: normalisedEmail,
          data: { code, ttlMinutes: otpTtl / 60 },
        })
        .pipe(
          Effect.mapError(
            (cause: EmailError) =>
              new AuthError({ message: `Failed to send email: ${cause.reason}` }),
          ),
        );

      metricAuthOtpSent("registration");
      return { sent: true };
    }).pipe(withAuthRegister("begin"));

  /**
   * Step 2 of email-verified registration. Verifies the OTP against the
   * pending registration and, if valid, creates the account + profile rows
   * and returns a full session (access + refresh tokens).
   *
   * The UI then immediately drives the `/passkey/register/*` flow using
   * the returned access token to enroll the user's first passkey. Accounts
   * without a passkey cannot make it past registration because the UI
   * refuses to dismiss until enrollment succeeds, and `deletePasskey`
   * refuses to drop below 1 — so every live account always has ≥1 passkey.
   *
   * Security properties:
   *  - Constant-time OTP comparison (S-M4 / `timingSafeEqualString`).
   *  - Per-entry attempt counter; after MAX_OTP_ATTEMPTS the entry is wiped,
   *    capping brute-force probability at ~5/1_000_000 per registration.
   *  - The pending entry is only deleted AFTER a successful insert. A losing
   *    race against another insert (TOCTOU) leaves the pending entry intact
   *    so the user can retry without burning their OTP (S-H4).
   *  - Insert relies on the DB-level UNIQUE constraint on email/handle as
   *    the source of truth, mapping constraint violations to a clean
   *    AuthError instead of leaking driver text (S-H4 / S-H5).
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

      return {
        profileId: id,
        handle: pending.handle,
        email: pending.email,
        displayName: pending.displayName,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
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

  // Access-token audience (S-M2). Asserted in `verifyAccessToken` so an
  // ES256 token signed with the same key but minted for a different
  // audience (step-up, or any future type) cannot authenticate access-
  // token routes. Mirrors STEP_UP_AUDIENCE below.
  const ACCESS_TOKEN_AUDIENCE = "osn-access";

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
          aud: ACCESS_TOKEN_AUDIENCE,
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
            await db.delete(sessions).where(inArray(sessions.id, evictIds));
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
        typeof payload["handle"] !== "string" ||
        payload["aud"] !== ACCESS_TOKEN_AUDIENCE
      ) {
        // S-M2: `aud` pinning ensures only tokens explicitly issued as
        // access tokens authenticate these routes. Without it any ES256
        // JWT with string sub/email/handle would be accepted.
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
    /**
     * S-H1: required when the account already has ≥1 passkey. First-
     * credential enrollment (bootstrap) bypasses the gate — no step-up
     * ceremony is reachable before the account has any authenticators.
     * Verified below after the existingPasskeys read.
     */
    stepUpToken?: string,
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

      // P-I10: refuse to mint options past the per-account cap. Checked
      // BEFORE the step-up gate so a user who's already at the cap
      // doesn't burn a single-use step-up token for nothing.
      if (existingPasskeys.length >= MAX_PASSKEYS_PER_ACCOUNT) {
        return yield* Effect.fail(
          new AuthError({ message: "Passkey limit reached for this account" }),
        );
      }

      // S-H1: once the account has any passkey, adding another requires a
      // fresh step-up token. A stolen access token alone cannot bind a
      // new authenticator.
      if (existingPasskeys.length > 0) {
        if (!stepUpToken) {
          return yield* Effect.fail(new AuthError({ message: "Step-up required" }));
        }
        yield* verifyStepUpForPasskeyRegister(accountId, stepUpToken);
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
            // `residentKey: "preferred"` admits FIDO2 security keys without
            // a resident-key slot (they register as non-discoverable and
            // still work for identified login). `userVerification: "required"`
            // keeps the factor strength at "something you have + something
            // you are/know" — obsolete UP-only U2F tokens cannot register,
            // which is intentional: they would subsequently fail the
            // verifier's `requireUserVerification: true` anyway (S-H2 —
            // options and verify must agree).
            authenticatorSelection: {
              residentKey: "preferred",
              userVerification: "required",
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
    /**
     * Raw session token of the caller, hashed internally so all OTHER
     * sessions for this account can be revoked (H1). The route layer
     * derives this from the HttpOnly cookie — it is NOT user-supplied
     * body input — so an attacker with only an access token cannot skip
     * H1 invalidation by omitting a body field (S-H1).
     */
    currentSessionToken: string | null,
    /** IP + UA for the security_events row (S-H1). Best-effort; omitted in tests. */
    eventMeta?: SessionMeta,
  ): Effect.Effect<{ passkeyId: string }, AuthError | DatabaseError, Db | EmailService> =>
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

      // Library-version-tolerant read of the optional WebAuthn fields. The
      // bounded fields (id/publicKey/counter/transports) are stable across
      // @simplewebauthn/server versions; aaguid + backup flags moved around
      // between majors and we don't want the build to pin to a point release.
      const info = verification.registrationInfo as typeof verification.registrationInfo & {
        aaguid?: string;
        credentialBackedUp?: boolean;
        credentialDeviceType?: "singleDevice" | "multiDevice";
      };
      const aaguid = typeof info.aaguid === "string" ? info.aaguid : null;
      const backedUp = info.credentialBackedUp ?? null;
      const eligible = info.credentialDeviceType === "multiDevice";
      const { db } = yield* Db;
      const id = genId("pk_");
      const ts = now();
      const nowSec = Math.floor(ts.getTime() / 1000);

      // S-H1: write the audit row in the SAME transaction as the passkey
      // insert so a signed-out attacker who skips the notification path
      // still leaves a row in security_events for the user to discover.
      const securityEventRow: typeof securityEvents.$inferInsert = {
        id: genId("sev_"),
        accountId,
        kind: "passkey_register",
        createdAt: nowSec,
        acknowledgedAt: null,
        ipHash: eventMeta?.ip ? hashIp(eventMeta.ip) : null,
        uaLabel: eventMeta?.uaLabel ?? null,
      };

      // P-W1 / P-I10: race-safe cap enforcement inside a single transaction.
      // `beginPasskeyRegistration` already refuses past the limit, but a pair
      // of `begin` calls racing `complete` would both pass the pre-check.
      // Wrapping the count + insert in `db.transaction` collapses the TOCTOU
      // window to zero on SQLite (serial writes) and to READ COMMITTED on
      // libsql/Postgres.
      yield* Effect.tryPromise({
        try: () =>
          db.transaction(async (tx) => {
            const rows = await tx
              .select({ id: passkeys.id })
              .from(passkeys)
              .where(eq(passkeys.accountId, accountId));
            if (rows.length >= MAX_PASSKEYS_PER_ACCOUNT) {
              throw new Error("Passkey limit reached for this account");
            }
            await tx.insert(passkeys).values({
              id,
              accountId,
              credentialId: info.credential.id,
              publicKey: Buffer.from(info.credential.publicKey).toString("base64"),
              counter: info.credential.counter,
              transports: info.credential.transports
                ? JSON.stringify(info.credential.transports)
                : null,
              createdAt: ts,
              label: null,
              lastUsedAt: null,
              aaguid,
              backupEligible: eligible,
              backupState: backedUp,
              updatedAt: nowSec,
            });
            await tx.insert(securityEvents).values(securityEventRow);
          }),
        catch: (cause) =>
          cause instanceof Error && /limit reached/i.test(cause.message)
            ? new AuthError({ message: "Passkey limit reached for this account" })
            : new DatabaseError({ cause }),
      });

      metricSecurityEventRecorded("passkey_register");

      // H1: Invalidate all other sessions on passkey registration.
      // An attacker who stole a session token cannot persist after the
      // legitimate user adds a passkey.
      if (currentSessionToken) {
        yield* invalidateOtherAccountSessions(accountId, hashSessionToken(currentSessionToken));
      }

      // S-H1: best-effort email notification. Forked daemon — failure
      // logged but never rolls back the enrolment. 10s timeout matches
      // passkey_delete / recovery_code_* paths.
      yield* Effect.forkDaemon(
        notifyPasskeyRegisteredByAccountId(accountId).pipe(
          Effect.timeout("10 seconds"),
          Effect.catchAll(() => Effect.void),
        ),
      );

      return { passkeyId: id };
    });

  // -------------------------------------------------------------------------
  // Passkey: begin login
  // -------------------------------------------------------------------------

  /**
   * M-PK: passkey login `begin` supports two flows:
   *
   *  1. **Identifier-bound** (legacy + explicit). The caller knows which
   *     account they want and supplies the handle or email. We look up the
   *     account's credentials and seed `allowCredentials` so the browser
   *     can filter its authenticator list. Challenge is keyed by the
   *     normalised identifier.
   *
   *  2. **Discoverable** (`identifier === null`). The caller has no
   *     identity up-front — conditional-UI autofill drives the ceremony,
   *     and the authenticator picks the credential. We emit options with
   *     an empty `allowCredentials` (forcing discoverable-credential
   *     resolution on the device) and key the challenge by a random
   *     `challengeId` that the client must round-trip to `complete`.
   *
   * Discoverable flow uses a short-lived random UUID as the challenge
   * key so two concurrent discoverable `begin`s don't collide. The raw
   * WebAuthn challenge is still a cryptographic nonce inside the
   * ceremony; `challengeId` is just the server-side map key.
   */
  const beginPasskeyLogin = (
    identifier: string | null,
  ): Effect.Effect<
    {
      options: PublicKeyCredentialRequestOptionsJSON;
      challengeId?: string;
    },
    AuthError | DatabaseError,
    Db
  > =>
    Effect.gen(function* () {
      // Discoverable path — no identifier. Emit options with empty
      // allowCredentials so the authenticator resolves via resident keys.
      if (identifier === null) {
        const options = yield* Effect.tryPromise({
          try: () =>
            generateAuthenticationOptions({
              rpID: config.rpId,
              allowCredentials: [],
              userVerification: "required",
            }),
          catch: (cause) => new AuthError({ message: String(cause) }),
        });
        sweepExpired(loginChallenges);
        // P-I2: cap defence-in-depth. Rate limiting is the primary
        // guard; this bounds memory even if the per-IP limit is ever
        // relaxed or fails open.
        if (loginChallenges.size >= MAX_LOGIN_CHALLENGES) {
          return yield* Effect.fail(new AuthError({ message: "Try again shortly" }));
        }
        const challengeId = crypto.randomUUID();
        loginChallenges.set(`__disc__:${challengeId}`, {
          challenge: options.challenge,
          expiresAt: Date.now() + 120_000,
        });
        return { options, challengeId };
      }

      const normalised = normaliseIdentifier(identifier);
      const profile = yield* resolveIdentifier(normalised);

      // Resolve passkeys for the account when the identifier is known, or
      // nothing when it isn't. Both branches run a DB SELECT so the query
      // latency distribution is the same (S-M1: no timing oracle).
      const { db } = yield* Db;
      const profilePasskeys = profile
        ? yield* Effect.tryPromise({
            try: () => db.select().from(passkeys).where(eq(passkeys.accountId, profile.accountId)),
            catch: (cause) => new DatabaseError({ cause }),
          })
        : yield* Effect.tryPromise({
            // Burn-in query: hit the table with a never-matching accountId
            // so an unknown identifier costs the same shape of work as a
            // known one.
            try: () => db.select().from(passkeys).where(eq(passkeys.accountId, "acc_enum_probe")),
            catch: (cause) => new DatabaseError({ cause }),
          });

      // S-M1: equalise the response envelope. Unknown identifier AND
      // known-with-zero-passkeys return a single fabricated credentialId;
      // known-with-passkeys returns the real allowCredentials. The wire
      // shape — `{ options: { …, allowCredentials: [...], userVerification } }`
      // — is identical in all three cases, so an anonymous caller can no
      // longer probe the handle/email namespace through this endpoint.
      // The "≥1 passkey" account invariant means the no-passkey branch is
      // only reachable for legacy/corrupt data; it collapses into the
      // unknown-identifier branch for free.
      const realCredentials =
        profile && profilePasskeys.length > 0
          ? profilePasskeys.map((pk) => ({
              id: pk.credentialId,
              transports: pk.transports
                ? (JSON.parse(pk.transports) as AuthenticatorTransportFuture[])
                : undefined,
            }))
          : null;
      const allowCredentials = realCredentials ?? [
        {
          // Random bytes base64url-encoded — never corresponds to a real
          // credential. A subsequent `/login/passkey/complete` with an
          // assertion for this id will fail at the challenge lookup
          // because we do NOT persist a challenge for the synthetic
          // branch.
          id: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
        },
      ];

      const options = yield* Effect.tryPromise({
        try: () =>
          generateAuthenticationOptions({
            rpID: config.rpId,
            allowCredentials,
            // S-H2: `verifyAuthenticationResponse` sets
            // `requireUserVerification: true`, so options and verify must
            // agree. "required" here matches the verifier, matches the
            // identifier-less flow, and makes the ceremony phishing-
            // resistant with a second factor (UV) — the whole point of
            // passkey-primary. Registration only admits UV-capable
            // credentials, so this does not regress legitimate sign-ins.
            userVerification: "required",
          }),
        catch: (cause) => new AuthError({ message: String(cause) }),
      });

      // Key challenge by normalised identifier so completePasskeyLoginDirect
      // can check the in-memory guard before touching the DB. Skip the
      // write on the synthetic branch: a subsequent complete call hits the
      // "challenge not found" guard, which is indistinguishable from a
      // legitimate timeout — preserves the enumeration safety into
      // the complete step too.
      if (realCredentials) {
        sweepExpired(loginChallenges);
        if (loginChallenges.size >= MAX_LOGIN_CHALLENGES) {
          return yield* Effect.fail(new AuthError({ message: "Try again shortly" }));
        }
        loginChallenges.set(normalised, {
          challenge: options.challenge,
          expiresAt: Date.now() + 120_000,
        });
      }

      return { options };
    }).pipe(Effect.withSpan("auth.login.passkey.begin"));

  // -------------------------------------------------------------------------
  // Passkey: verify assertion (extracted so both the code-issuing and
  // direct-session completion paths can share the same WebAuthn verification
  // logic without duplication).
  // -------------------------------------------------------------------------

  /**
   * Input for the shared passkey-assertion verifier. Exactly one of
   * `identifier` or `challengeId` is present — the route layer validates
   * that invariant before dispatching.
   */
  type PasskeyLoginContext =
    | { kind: "identified"; identifier: string }
    | { kind: "discoverable"; challengeId: string };

  const verifyPasskeyAssertion = (
    context: PasskeyLoginContext,
    assertion: AuthenticationResponseJSON,
  ): Effect.Effect<ProfileWithEmail, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      // Resolve challenge key before any DB lookup.
      const challengeKey =
        context.kind === "identified"
          ? normaliseIdentifier(context.identifier)
          : `__disc__:${context.challengeId}`;
      const entry = loginChallenges.get(challengeKey);
      if (!entry || Date.now() > entry.expiresAt) {
        return yield* Effect.fail(new AuthError({ message: "Challenge expired or not found" }));
      }
      loginChallenges.delete(challengeKey);

      const { db } = yield* Db;
      // Look up the credential row by `credentialId` — stable across both
      // flows. For the identified flow we also verify the credential belongs
      // to the claimed account (prevents a valid assertion for credential X
      // from signing in account Y).
      const pkResult = yield* Effect.tryPromise({
        try: () =>
          db.select().from(passkeys).where(eq(passkeys.credentialId, assertion.id)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const pk = pkResult[0];
      if (!pk) {
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }

      let profile: ProfileWithEmail | null;
      // Look up the owning account once — needed for both the identified-flow
      // accountId equality check and the discoverable-flow userHandle pin.
      const accountRow = yield* Effect.tryPromise({
        try: () => db.select().from(accounts).where(eq(accounts.id, pk.accountId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const account = accountRow[0];
      if (!account) {
        return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
      }
      if (context.kind === "identified") {
        const normalised = normaliseIdentifier(context.identifier);
        profile = yield* resolveIdentifier(normalised);
        if (!profile || profile.accountId !== pk.accountId) {
          return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
        }
      } else {
        // S-M3: discoverable flow — the credential row supplies the account.
        // Cross-check the assertion's `userHandle` against the account's
        // stored `passkeyUserId`. The signature already binds the assertion
        // to the credential, so this is defence-in-depth: if a future schema
        // change ever lets a credentialId map to two accounts, the
        // userHandle pin still prevents account A's credential from logging
        // into account B.
        const userHandle = assertion.response.userHandle;
        if (typeof userHandle !== "string" || userHandle.length === 0) {
          return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
        }
        // userHandle is base64url-encoded by the browser. The stored
        // passkeyUserId is the raw UTF-8 string we passed to
        // generateRegistrationOptions, so decode + compare.
        const decodedHandle = Buffer.from(userHandle, "base64url").toString("utf8");
        if (decodedHandle !== account.passkeyUserId) {
          return yield* Effect.fail(new AuthError({ message: "Invalid request" }));
        }
        profile = yield* findDefaultProfile(pk.accountId);
        if (!profile) {
          return yield* Effect.fail(new AuthError({ message: "Profile not found" }));
        }
      }

      // S-L5: never reflect the WebAuthn library's error text to the caller —
      // it can pinpoint failure mode (challenge mismatch vs origin mismatch
      // vs counter regression) and lets an attacker probe the verifier. We
      // log the cause for operators (annotation goes through the redaction
      // logger) and surface a fixed message on the wire.
      const verifyResult = yield* Effect.promise(() =>
        verifyAuthenticationResponse({
          response: assertion,
          expectedChallenge: entry.challenge,
          expectedOrigin: config.origin,
          expectedRPID: config.rpId,
          requireUserVerification: true,
          credential: {
            id: pk.credentialId,
            publicKey: new Uint8Array(Buffer.from(pk.publicKey, "base64")),
            counter: pk.counter,
            transports: pk.transports
              ? (JSON.parse(pk.transports) as AuthenticatorTransportFuture[])
              : undefined,
          },
        }).then(
          (v) => ({ ok: true as const, v }),
          (e: unknown) => ({ ok: false as const, e }),
        ),
      );
      if (!verifyResult.ok) {
        yield* Effect.logWarning("auth.passkey.verify threw", {
          cause: verifyResult.e instanceof Error ? verifyResult.e.message : String(verifyResult.e),
        });
        return yield* Effect.fail(new AuthError({ message: "Passkey verification failed" }));
      }
      const verification = verifyResult.v;
      if (!verification.verified) {
        return yield* Effect.fail(new AuthError({ message: "Passkey verification failed" }));
      }

      // Update counter + coalesced last_used_at (P-W4 parallel to sessions).
      const nowSec = Math.floor(Date.now() / 1000);
      const shouldTouchLastUsed =
        !pk.lastUsedAt || Date.now() - pk.lastUsedAt * 1000 >= PASSKEY_LAST_USED_COALESCE_MS;
      const updates: Record<string, number | boolean> = {
        counter: verification.authenticationInfo.newCounter,
      };
      if (shouldTouchLastUsed) {
        updates["lastUsedAt"] = nowSec;
        updates["updatedAt"] = nowSec;
      }
      yield* Effect.tryPromise({
        try: () => db.update(passkeys).set(updates).where(eq(passkeys.id, pk.id)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return profile;
    });

  // -------------------------------------------------------------------------
  // Passkey: complete login — returns a Session + PublicProfile directly.
  // -------------------------------------------------------------------------

  const completePasskeyLoginDirect = (
    input:
      | { identifier: string; assertion: AuthenticationResponseJSON }
      | { challengeId: string; assertion: AuthenticationResponseJSON },
    sessionMeta?: SessionMeta,
  ): Effect.Effect<{ session: TokenSet; profile: PublicProfile }, AuthError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const isDiscoverable = "challengeId" in input;
      const context: PasskeyLoginContext = isDiscoverable
        ? { kind: "discoverable", challengeId: input.challengeId }
        : { kind: "identified", identifier: input.identifier };
      const profile = yield* verifyPasskeyAssertion(context, input.assertion).pipe(
        Effect.tap(() =>
          isDiscoverable ? Effect.sync(() => metricPasskeyLoginDiscoverable("ok")) : Effect.void,
        ),
        Effect.tapError((e) =>
          isDiscoverable
            ? Effect.sync(() => metricPasskeyLoginDiscoverable(classifyError(e)))
            : Effect.void,
        ),
      );
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
   * session should survive but all others must be revoked (passkey
   * registration, passkey deletion, …). `trigger` labels the emitted metric
   * so the security-invalidation dashboard can attribute the sweep.
   */
  const invalidateOtherAccountSessions = (
    accountId: string,
    keepSessionHash: string,
    trigger: SecurityInvalidationTrigger = "passkey_register",
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
      metricSessionSecurityInvalidation(trigger);
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
  ): Effect.Effect<{ recoveryCodes: string[] }, DatabaseError, Db | EmailService> =>
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
  ): Effect.Effect<void, AuthError | DatabaseError, Db | EmailService> =>
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
  ): Effect.Effect<void, AuthError, EmailService> =>
    Effect.gen(function* () {
      if (!recipientEmail) {
        // Defensive: account row fully evicted between commit and dispatch.
        metricSecurityEventNotified(kind, "skipped");
        return;
      }

      const template =
        kind === "recovery_code_generate" ? "recovery-generated" : "recovery-consumed";
      const email = yield* EmailService;
      const start = Date.now();
      yield* email
        .send({ template, to: recipientEmail, data: {} })
        // S-L2: bounded error class name in the log annotation; the email
        // provider's response body (which may echo the recipient) is never
        // embedded in the logged message.
        .pipe(
          Effect.mapError(() => new AuthError({ message: "notify_dispatch_failed" })),
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
  ): Effect.Effect<{ profile: ProfileWithEmail }, AuthError | DatabaseError, Db | EmailService> =>
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
  ): Effect.Effect<
    { session: TokenSet; profile: PublicProfile },
    AuthError | DatabaseError,
    Db | EmailService
  > =>
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

      const nowSec = Math.floor(Date.now() / 1000);
      const shouldTouchLastUsed =
        !pk.lastUsedAt || Date.now() - pk.lastUsedAt * 1000 >= PASSKEY_LAST_USED_COALESCE_MS;
      const updates: Record<string, number | boolean> = {
        counter: verification.authenticationInfo.newCounter,
      };
      if (shouldTouchLastUsed) {
        updates["lastUsedAt"] = nowSec;
        updates["updatedAt"] = nowSec;
      }
      yield* Effect.tryPromise({
        try: () => db.update(passkeys).set(updates).where(eq(passkeys.id, pk.id)),
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
  ): Effect.Effect<{ sent: boolean }, AuthError | DatabaseError, Db | EmailService> =>
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
      const email = yield* EmailService;
      yield* email
        .send({
          template: "otp-step-up",
          to: account.email,
          data: { code, ttlMinutes: otpTtl / 60 },
        })
        .pipe(
          Effect.mapError(
            (cause: EmailError) =>
              new AuthError({ message: `Failed to send email: ${cause.reason}` }),
          ),
        );
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

  /**
   * S-L4: separate step-up verifier for `DELETE /passkeys/:id`. Defaults
   * to passkey-only AMR — the caller necessarily has a passkey (the
   * last-passkey lockout guard fires otherwise), so requiring one for
   * deletion is the strongest available signal at no UX cost.
   */
  const verifyStepUpForPasskeyDelete = (
    accountId: string,
    stepUpToken: string,
  ): Effect.Effect<void, AuthError> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(stepUpToken, accountId, passkeyDeleteAllowedAmr);
    });

  /**
   * S-H1: step-up verifier for `/passkey/register/{begin,complete}` on
   * accounts that already have ≥1 passkey. Without this gate, a stolen
   * access token (XSS) could silently bind an attacker-controlled
   * authenticator to the victim account — every other high-value auth
   * mutation on the branch is step-up gated, and enroll must match.
   */
  const verifyStepUpForPasskeyRegister = (
    accountId: string,
    stepUpToken: string,
  ): Effect.Effect<void, AuthError> =>
    Effect.gen(function* () {
      yield* verifyStepUpToken(stepUpToken, accountId, passkeyRegisterAllowedAmr);
    });

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
  ): Effect.Effect<
    { sent: boolean },
    AuthError | ValidationError | DatabaseError,
    Db | EmailService
  > =>
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

      // S-L5 framing lives in the template itself
      // (shared/email/src/templates/otp.ts → renderEmailChangeOtp).
      const email = yield* EmailService;
      yield* email
        .send({
          template: "otp-email-change",
          to: normalised,
          data: { code, ttlMinutes: otpTtl / 60 },
        })
        .pipe(
          Effect.mapError(
            (cause: EmailError) =>
              new AuthError({ message: `Failed to send email: ${cause.reason}` }),
          ),
        );

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

  // -------------------------------------------------------------------------
  // Passkey management (M-PK)
  //
  // Settings-surface operations over an account's existing credentials:
  //   • listPasskeys   → public, label-friendly summary
  //   • renamePasskey  → patch the user-editable label only
  //   • deletePasskey  → remove one credential, revoke other sessions (H1),
  //                     and record a security_events row (M-PK1b). Guarded
  //                     by step-up at the route layer.
  //
  // None of these methods accept or emit secret material. `publicKey` and
  // `counter` stay internal to the auth service.
  // -------------------------------------------------------------------------

  const listPasskeys = (
    accountId: string,
  ): Effect.Effect<{ passkeys: PasskeySummary[] }, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      // Explicit projection so the public type never widens by accident —
      // adding publicKey / counter later must be an intentional edit here.
      // S-L2: `credentialId` is intentionally excluded from the projection.
      // The Settings UI only needs the opaque `pk_<hex>` `id` to drive
      // rename/delete; emitting credentialIds would let a malicious bundled
      // dependency exfiltrate authenticator-model fingerprints for targeted
      // phishing.
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: passkeys.id,
              label: passkeys.label,
              aaguid: passkeys.aaguid,
              transports: passkeys.transports,
              backupEligible: passkeys.backupEligible,
              backupState: passkeys.backupState,
              createdAt: passkeys.createdAt,
              lastUsedAt: passkeys.lastUsedAt,
            })
            .from(passkeys)
            .where(eq(passkeys.accountId, accountId))
            .orderBy(desc(passkeys.lastUsedAt), desc(passkeys.createdAt)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return {
        passkeys: rows.map((row) => ({
          id: row.id,
          label: row.label,
          aaguid: row.aaguid,
          transports: row.transports ? (JSON.parse(row.transports) as string[]) : null,
          backupEligible: row.backupEligible,
          backupState: row.backupState,
          createdAt: Math.floor(row.createdAt.getTime() / 1000),
          lastUsedAt: row.lastUsedAt,
        })),
      };
    }).pipe(withPasskeyOp("list"));

  const renamePasskey = (
    accountId: string,
    passkeyId: string,
    label: string,
  ): Effect.Effect<void, AuthError | ValidationError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const trimmed = label.trim();
      yield* Schema.decodeUnknown(PasskeyLabelSchema)(trimmed).pipe(
        Effect.mapError((cause) => new ValidationError({ cause })),
      );
      if (!/^pk_[a-f0-9]{12}$/.test(passkeyId)) {
        return yield* Effect.fail(new AuthError({ message: "Passkey not found" }));
      }
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      const result = yield* Effect.tryPromise({
        try: () =>
          db
            .update(passkeys)
            .set({ label: trimmed, updatedAt: nowSec })
            .where(and(eq(passkeys.id, passkeyId), eq(passkeys.accountId, accountId))),
        catch: (cause) => new DatabaseError({ cause }),
      });
      // better-sqlite3 returns `{ changes }`, libsql returns `{ rowsAffected }`.
      // Treat 0 rows updated as not-found without leaking whether another
      // account owns the id.
      const affected =
        (result as unknown as { changes?: number; rowsAffected?: number }).changes ??
        (result as unknown as { changes?: number; rowsAffected?: number }).rowsAffected ??
        0;
      if (affected === 0) {
        return yield* Effect.fail(new AuthError({ message: "Passkey not found" }));
      }
    }).pipe(withPasskeyOp("rename"));

  /**
   * Deletes a single passkey, records a security event, and revokes every
   * OTHER session so an attacker who stole one passkey cannot piggyback on
   * a stale access token to keep working after the legitimate user
   * remediates.
   *
   * Last-passkey guard: refuses unconditionally if this would leave the
   * account with zero passkeys. The account-level invariant is "every
   * account always has ≥1 WebAuthn credential"; recovery codes are the
   * "my device is gone" escape hatch, not a substitute credential. Users
   * who want to rotate a compromised passkey enroll the replacement
   * first, then delete the old one.
   */
  const deletePasskey = (
    accountId: string,
    passkeyId: string,
    currentSessionHash: string | null,
    eventMeta?: SessionMeta,
  ): Effect.Effect<{ remaining: number }, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      if (!/^pk_[a-f0-9]{12}$/.test(passkeyId)) {
        return yield* Effect.fail(new AuthError({ message: "Passkey not found" }));
      }
      const { db } = yield* Db;

      const nowSec = Math.floor(Date.now() / 1000);
      const securityEventRow: typeof securityEvents.$inferInsert = {
        id: genId("sev_"),
        accountId,
        kind: "passkey_delete",
        createdAt: nowSec,
        acknowledgedAt: null,
        ipHash: eventMeta?.ip ? hashIp(eventMeta.ip) : null,
        uaLabel: eventMeta?.uaLabel ?? null,
      };

      // S-M1 / P-W1: gate-then-delete inside one transaction so two concurrent
      // DELETEs cannot race past the last-passkey guard.
      type TxResult =
        | { ok: true; remaining: number }
        | { ok: false; reason: "not_found" | "lockout" };
      const txResult = yield* Effect.tryPromise<TxResult, DatabaseError>({
        try: () =>
          db.transaction(async (tx) => {
            const accountPasskeys = await tx
              .select({ id: passkeys.id })
              .from(passkeys)
              .where(eq(passkeys.accountId, accountId));
            const exists = accountPasskeys.some((r) => r.id === passkeyId);
            if (!exists) {
              return { ok: false, reason: "not_found" } as const;
            }
            if (accountPasskeys.length <= 1) {
              return { ok: false, reason: "lockout" } as const;
            }
            await tx
              .delete(passkeys)
              .where(and(eq(passkeys.id, passkeyId), eq(passkeys.accountId, accountId)));
            await tx.insert(securityEvents).values(securityEventRow);
            return { ok: true, remaining: accountPasskeys.length - 1 } as const;
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      if (!txResult.ok) {
        if (txResult.reason === "not_found") {
          return yield* Effect.fail(new AuthError({ message: "Passkey not found" }));
        }
        return yield* Effect.fail(
          new AuthError({
            message: "Enroll another passkey before removing this one",
          }),
        );
      }

      metricSecurityEventRecorded("passkey_delete");

      // H1: revoke other sessions. An attacker who stole a session + the
      // passkey shouldn't keep working after the credential goes away.
      if (currentSessionHash) {
        yield* invalidateOtherAccountSessions(accountId, currentSessionHash, "passkey_delete");
      } else {
        // S-L3: caller has no session cookie (e.g. the delete came in via an
        // enrollment-token path or the cookie was stripped by a proxy). We
        // nuke every session on the account because there's no "self" to
        // preserve. This branch is rare and forensically distinct, so log it
        // out-of-band and emit the security-invalidation metric explicitly.
        yield* Effect.logWarning("auth.passkey.delete: nuking all sessions (no caller session)");
        yield* Effect.tryPromise({
          try: () => db.delete(sessions).where(eq(sessions.accountId, accountId)),
          catch: (cause) => new DatabaseError({ cause }),
        });
        metricSessionSecurityInvalidation("passkey_delete");
      }

      // M-PK1b: fire-and-forget email notification (codes never included).
      yield* Effect.forkDaemon(
        notifyPasskeyDeletedByAccountId(accountId).pipe(
          Effect.timeout("10 seconds"),
          Effect.catchAll(() => Effect.void),
        ),
      );

      return { remaining: txResult.remaining };
    }).pipe(withPasskeyOp("delete"));

  /**
   * Fetches the account's email and dispatches a best-effort notification
   * that a passkey was deleted. Mirrors the recovery-code notification path —
   * never includes identifying material beyond "it was you if you did this,
   * otherwise investigate."
   */
  /**
   * Best-effort email notification that a passkey was added to the
   * account. Codes never included — the body is a boilerplate "it was you
   * or investigate" framing. Mirrors `notifyPasskeyDeletedByAccountId`.
   */
  const notifyPasskeyRegisteredByAccountId = (
    accountId: string,
  ): Effect.Effect<void, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () => db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const recipient = rows[0]?.email;
      if (!recipient) {
        metricSecurityEventNotified("passkey_register", "skipped");
        return;
      }
      const email = yield* EmailService;
      const start = Date.now();
      yield* email.send({ template: "passkey-added", to: recipient, data: {} }).pipe(
        Effect.mapError(() => new AuthError({ message: "notify_dispatch_failed" })),
        Effect.tap(() =>
          Effect.sync(() => {
            metricSecurityEventNotifyDuration((Date.now() - start) / 1000, "ok");
            metricSecurityEventNotified("passkey_register", "sent");
          }),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            metricSecurityEventNotifyDuration((Date.now() - start) / 1000, "error");
            metricSecurityEventNotified("passkey_register", "failed");
          }),
        ),
      );
    }).pipe(
      Effect.withSpan("auth.security_event.notify", { attributes: { kind: "passkey_register" } }),
    );

  const notifyPasskeyDeletedByAccountId = (
    accountId: string,
  ): Effect.Effect<void, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () => db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const recipient = rows[0]?.email;
      if (!recipient) {
        metricSecurityEventNotified("passkey_delete", "skipped");
        return;
      }
      const email = yield* EmailService;
      const start = Date.now();
      yield* email.send({ template: "passkey-removed", to: recipient, data: {} }).pipe(
        Effect.mapError(() => new AuthError({ message: "notify_dispatch_failed" })),
        Effect.tap(() =>
          Effect.sync(() => {
            metricSecurityEventNotifyDuration((Date.now() - start) / 1000, "ok");
            metricSecurityEventNotified("passkey_delete", "sent");
          }),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            metricSecurityEventNotifyDuration((Date.now() - start) / 1000, "error");
            metricSecurityEventNotified("passkey_delete", "failed");
          }),
        ),
      );
    }).pipe(
      Effect.withSpan("auth.security_event.notify", { attributes: { kind: "passkey_delete" } }),
    );

  // -------------------------------------------------------------------------
  // Cross-device login (QR-code mediated session transfer)
  // -------------------------------------------------------------------------

  /**
   * Device B calls this to create a pending login request. Returns a
   * `requestId` + random `secret` (256-bit). Device B renders a QR code
   * encoding `${issuerUrl}/login/cross-device/${requestId}#${secret}` and
   * begins polling `/login/cross-device/:requestId/status`.
   */
  const beginCrossDeviceLogin = (
    sessionMeta?: SessionMeta,
  ): Effect.Effect<{ requestId: string; cdlSecret: string; expiresAt: number }, AuthError, never> =>
    Effect.sync(() => {
      // FIFO eviction — cap memory under abuse.
      sweepExpired(pendingCrossDeviceRequests);
      if (pendingCrossDeviceRequests.size >= MAX_PENDING_CDL) {
        const oldest = pendingCrossDeviceRequests.keys().next().value;
        if (oldest) pendingCrossDeviceRequests.delete(oldest);
      }

      const requestId = genId("cdl_");
      const secretBytes = new Uint8Array(32);
      crypto.getRandomValues(secretBytes);
      const secret = Buffer.from(secretBytes).toString("hex");
      const secretHash = createHash("sha256").update(secret).digest("hex");
      const nowMs = Date.now();
      const expiresAtMs = nowMs + CDL_TTL_SECONDS * 1000;

      pendingCrossDeviceRequests.set(requestId, {
        requestId,
        secretHash,
        status: "pending",
        uaLabel: sessionMeta?.uaLabel ?? null,
        ipHash: sessionMeta?.ip ? hashIp(sessionMeta.ip) : null,
        expiresAt: expiresAtMs,
        createdAt: nowMs,
      });

      // API response uses Unix seconds for consistency with other endpoints.
      // Field named `cdlSecret` to match the redaction deny-list entry.
      return { requestId, cdlSecret: secret, expiresAt: Math.floor(expiresAtMs / 1000) };
    }).pipe(withCrossDeviceOp("begin"));

  /**
   * Device B polls this to check whether device A has approved the request.
   * Returns `{ status: "pending" }` until approved, then returns the session
   * tokens exactly once (marks the request as consumed to prevent replay).
   */
  const getCrossDeviceLoginStatus = (
    requestId: string,
    secret: string,
  ): Effect.Effect<
    | { status: "pending"; uaLabel: string | null }
    | { status: "approved"; session: TokenSet; profile: PublicProfile }
    | { status: "rejected" }
    | { status: "expired" },
    AuthError,
    never
  > =>
    Effect.gen(function* () {
      const entry = pendingCrossDeviceRequests.get(requestId);
      if (!entry) {
        return { status: "expired" as const };
      }

      // Verify secret
      const providedHash = createHash("sha256").update(secret).digest("hex");
      if (!timingSafeEqualString(providedHash, entry.secretHash)) {
        return yield* Effect.fail(new AuthError({ message: "Invalid secret" }));
      }

      // Check expiry
      if (Date.now() > entry.expiresAt) {
        pendingCrossDeviceRequests.delete(requestId);
        return { status: "expired" as const };
      }

      if (entry.status === "rejected") {
        pendingCrossDeviceRequests.delete(requestId);
        return { status: "rejected" as const };
      }

      if (entry.status === "approved" && entry.session && entry.profile) {
        // One-time consumption — prevent replay.
        pendingCrossDeviceRequests.delete(requestId);
        return {
          status: "approved" as const,
          session: entry.session,
          profile: entry.profile,
        };
      }

      return { status: "pending" as const, uaLabel: entry.uaLabel };
    }).pipe(withCrossDeviceOp("poll"));

  /**
   * Device A (authenticated) approves the request. The server issues a
   * session for device B and records a `cross_device_login` security event.
   */
  const approveCrossDeviceLogin = (
    requestId: string,
    secret: string,
    accountId: string,
    sessionMeta?: SessionMeta,
  ): Effect.Effect<void, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const entry = pendingCrossDeviceRequests.get(requestId);
      if (!entry) {
        return yield* Effect.fail(new AuthError({ message: "Request not found or expired" }));
      }

      if (entry.status !== "pending") {
        return yield* Effect.fail(new AuthError({ message: "Request already processed" }));
      }

      // Verify secret
      const providedHash = createHash("sha256").update(secret).digest("hex");
      if (!timingSafeEqualString(providedHash, entry.secretHash)) {
        return yield* Effect.fail(new AuthError({ message: "Invalid secret" }));
      }

      // Check expiry
      if (Date.now() > entry.expiresAt) {
        pendingCrossDeviceRequests.delete(requestId);
        return yield* Effect.fail(new AuthError({ message: "Request expired" }));
      }

      // Resolve the approver's default profile to issue session for device B.
      const profile = yield* findDefaultProfile(accountId);
      if (!profile) {
        return yield* Effect.fail(new AuthError({ message: "Profile not found" }));
      }

      // Issue session for device B using device B's session meta (from begin).
      const session = yield* issueTokens(
        profile.id,
        accountId,
        profile.email,
        profile.handle,
        profile.displayName,
        undefined,
        { uaLabel: entry.uaLabel, ip: null },
      );

      // Store the session + profile on the request for device B to pick up.
      entry.status = "approved";
      entry.accountId = accountId;
      entry.session = session;
      entry.profile = toPublicProfile(profile, profile.email);

      // Audit trail — security event + best-effort email notification.
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      yield* Effect.tryPromise({
        try: () =>
          db.insert(securityEvents).values({
            id: genId("sev_"),
            accountId,
            kind: "cross_device_login",
            createdAt: nowSec,
            uaLabel: sessionMeta?.uaLabel ?? null,
            ipHash: sessionMeta?.ip ? hashIp(sessionMeta.ip) : null,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });
      metricSecurityEventRecorded("cross_device_login");

      // Best-effort email notification (forked daemon, 10s timeout).
      yield* Effect.forkDaemon(
        notifyCrossDeviceLoginByAccountId(accountId).pipe(
          Effect.timeout("10 seconds"),
          Effect.catchAll(() => Effect.void),
        ),
      );
    }).pipe(withCrossDeviceOp("approve"));

  /**
   * Device A explicitly rejects the request — the next poll from device B
   * will see `{ status: "rejected" }`.
   */
  const rejectCrossDeviceLogin = (
    requestId: string,
    secret: string,
  ): Effect.Effect<void, AuthError, never> =>
    Effect.gen(function* () {
      const entry = pendingCrossDeviceRequests.get(requestId);
      if (!entry) {
        return yield* Effect.fail(new AuthError({ message: "Request not found or expired" }));
      }

      if (entry.status !== "pending") {
        return yield* Effect.fail(new AuthError({ message: "Request already processed" }));
      }

      const providedHash = createHash("sha256").update(secret).digest("hex");
      if (!timingSafeEqualString(providedHash, entry.secretHash)) {
        return yield* Effect.fail(new AuthError({ message: "Invalid secret" }));
      }

      entry.status = "rejected";
    }).pipe(withCrossDeviceOp("reject"));

  /**
   * Best-effort email notification for cross-device login approval.
   * Mirrors `notifyPasskeyRegisteredByAccountId`.
   */
  const notifyCrossDeviceLoginByAccountId = (
    accountId: string,
  ): Effect.Effect<void, AuthError | DatabaseError, Db | EmailService> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () => db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const recipient = rows[0]?.email;
      if (!recipient) {
        metricSecurityEventNotified("cross_device_login", "skipped");
        return;
      }
      const email = yield* EmailService;
      const start = Date.now();
      yield* email.send({ template: "cross-device-login", to: recipient, data: {} }).pipe(
        Effect.mapError(() => new AuthError({ message: "notify_dispatch_failed" })),
        Effect.tap(() =>
          Effect.sync(() => {
            metricSecurityEventNotifyDuration((Date.now() - start) / 1000, "ok");
            metricSecurityEventNotified("cross_device_login", "sent");
          }),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            metricSecurityEventNotifyDuration((Date.now() - start) / 1000, "error");
            metricSecurityEventNotified("cross_device_login", "failed");
          }),
        ),
      );
    }).pipe(
      Effect.withSpan("auth.security_event.notify", { attributes: { kind: "cross_device_login" } }),
    );

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
    checkHandle,
    issueTokens,
    refreshTokens,
    verifyRefreshToken,
    verifyAccessToken,
    switchProfile,
    listAccountProfiles,
    beginPasskeyRegistration,
    completePasskeyRegistration,
    beginPasskeyLogin,
    completePasskeyLoginDirect,
    listPasskeys,
    renamePasskey,
    deletePasskey,
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
    verifyStepUpForPasskeyDelete,
    verifyStepUpForPasskeyRegister,
    listAccountSessions,
    revokeAccountSession,
    revokeAllOtherAccountSessions,
    beginEmailChange,
    completeEmailChange,
    beginCrossDeviceLogin,
    getCrossDeviceLoginStatus,
    approveCrossDeviceLogin,
    rejectCrossDeviceLogin,
    hashSessionToken: (token: string) => hashSessionToken(token),
  };
}

// Type alias for the service
export type AuthService = ReturnType<typeof createAuthService>;
