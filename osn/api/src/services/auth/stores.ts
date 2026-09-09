/**
 * Ceremony / pending-state store contracts and their in-memory defaults.
 * Value shapes live here alongside the store bundle so `index.ts` (and the
 * Redis wiring in `lib/redis-ceremony-stores.ts`) import them from one place.
 */

import type { RedisNamespace } from "@shared/redis";

import { createInMemoryCeremonyStore, type CeremonyStore } from "../../lib/ceremony-store";
import { metricCeremonyStoreEntryDelta, metricCeremonyStoreOp } from "../../metrics";
import type { PasskeyProvenance, PublicProfile } from "./types";

/**
 * Minimal per-account cap surface — structurally compatible with
 * `RateLimiterBackend` from `@shared/rate-limit` and the Redis rate-limiter,
 * so `index.ts` can pass a `createRedisRateLimiter(...)` straight in.
 */
export interface AccountCapLimiter {
  check(key: string): Promise<boolean>;
}

/**
 * The full set of ceremony / pending-state stores threaded through the
 * auth service. Bundled so `index.ts` wires one Redis client into all of them
 * in a single place, and so tests can override the whole set at once.
 */
export interface CeremonyStores {
  registrationChallenges: CeremonyStore<RegistrationChallengeEntry>;
  loginChallenges: CeremonyStore<ChallengeEntry>;
  pendingRegistrations: CeremonyStore<PendingRegistration>;
  stepUpPasskeyChallenges: CeremonyStore<ChallengeEntry>;
  stepUpOtp: CeremonyStore<StepUpOtpEntry>;
  pendingRecoveryOtp: CeremonyStore<PendingRecoveryOtp>;
  pendingTotpEnrollments: CeremonyStore<PendingTotpEnrollment>;
  pendingEmailChanges: CeremonyStore<PendingEmailChange>;
  crossDeviceRequests: CeremonyStore<CrossDeviceRequest>;
  authorizeRequests: CeremonyStore<PendingAuthorizeRequest>;
  recoveryDisownTokens: CeremonyStore<RecoveryDisownToken>;
}

// ---------------------------------------------------------------------------
// In-memory stores (module-level, single-process)
// ---------------------------------------------------------------------------

export interface ChallengeEntry {
  challenge: string;
  expiresAt: number;
}

/**
 * A passkey registration challenge, plus what the credential it produces will
 * be stamped with.
 *
 * The provenance is decided at `begin` — that is where the step-up token is
 * verified and where the recovery-session bypass is granted — and the row is
 * written at `complete`, so it has to travel. This entry is that journey.
 *
 * Keyed by accountId like every other ceremony entry, so a second `begin`
 * replaces the first: a `complete` can only ever succeed against the challenge
 * its own `begin` parked, and the provenance parked with it cannot be swapped
 * by another caller.
 *
 * `provenanceAmr` is required, but an entry parked by a deploy older than this
 * column arrives without it. `completePasskeyRegistration` stamps `recovery` in
 * that case — the most restrictive value — rather than failing a ceremony the
 * user is halfway through.
 */
export interface RegistrationChallengeEntry extends ChallengeEntry {
  provenanceAmr: PasskeyProvenance;
}

/**
 * The single-use "this wasn't me" token carried by the recovery notice email,
 * keyed by its public lookup id.
 *
 * Only the SHA-256 of the secret half is stored, and it is compared in constant
 * time — the same shape as {@link CrossDeviceRequest}'s `secretHash`, for the
 * same reason: the plaintext exists in the user's inbox and nowhere on the
 * server.
 *
 * `recoveredAt` is what makes the revocation precise. It names the instant the
 * disowned recovery happened, so the route can revoke exactly the credentials
 * that recovery produced rather than everything, or a fixed guess.
 */
export interface RecoveryDisownToken {
  /** SHA-256 of the secret half; the plaintext never reaches the server twice. */
  secretHash: string;
  accountId: string;
  /** Unix seconds of the recovery this token disowns. */
  recoveredAt: number;
  /** Milliseconds. */
  expiresAt: number;
}

export interface PendingRegistration {
  email: string;
  handle: string;
  displayName: string | null;
  codeHash: string;
  attempts: number;
  expiresAt: number;
}

// In-memory bounds (pending registrations, pending CDL, login challenges)
// are now enforced inside the ceremony store (CEREMONY_STORE_MAX) rather than
// per-call-site, so the old MAX_* constants are gone.

export interface CrossDeviceRequest {
  requestId: string;
  /** SHA-256 of the 256-bit secret — the plaintext never touches the server. */
  secretHash: string;
  status: "pending" | "approved" | "rejected" | "consumed";
  /** Device B's coarse UA label. */
  uaLabel: string | null;
  /** Device B's peppered IP hash. */
  ipHash: string | null;
  expiresAt: number; // milliseconds
  createdAt: number; // milliseconds
  // Populated on approve:
  accountId?: string;
  session?: { accessToken: string; refreshToken: string; expiresIn: number };
  profile?: PublicProfile;
}

// Challenge / pending-state value shapes. The stores that hold them are
// instantiated per-service (in-memory default or injected Redis-backed) inside
// createAuthService — see CeremonyStores.

// Step-up OTP codes — keyed by accountId. Separate from loginOtp store so
// a login OTP cannot be replayed to authorise a sensitive action, and vice
// versa. Structure matches OtpEntry but without profileId (accountId is the key).
export interface StepUpOtpEntry {
  codeHash: string;
  attempts: number;
  expiresAt: number;
}

/**
 * The 6-digit code emailed by `POST /login/recovery/email/begin`, keyed by
 * accountId and awaiting `POST /login/recovery/email/complete`.
 *
 * Structurally identical to {@link StepUpOtpEntry} and deliberately a separate
 * store rather than a share of it: a step-up code authorises an action for
 * somebody already signed in, while this one hands out a session to somebody who
 * is not. Sharing the key space would let either be presented where the other
 * was minted.
 *
 * Never in D1. A pending recovery code is not a credential — it is a ten-minute
 * ceremony — and the durable store is not where ten-minute state belongs.
 */
export interface PendingRecoveryOtp {
  codeHash: string;
  attempts: number;
  expiresAt: number;
}

/**
 * A TOTP secret generated by `/totp/enroll/begin` and not yet confirmed —
 * keyed by accountId. It never reaches D1: an unconfirmed secret is not a
 * credential, and a ten-minute ceremony window is no reason to write one to
 * the durable store.
 *
 * Encrypted with the same key and helper as the stored credential, even for
 * these ten minutes. The store emits per-namespace telemetry and serialises
 * its value, and "the secret never reaches a log line" is much easier to hold
 * when the value is opaque everywhere.
 *
 * The fields are base64 strings rather than byte arrays because the in-memory
 * store keeps the value by reference while the Redis store round-trips it
 * through `JSON.stringify` — a `Uint8Array` here works in every test and comes
 * back from Upstash as `{"0":12,"1":200,…}`.
 */
export interface PendingTotpEnrollment {
  ciphertextB64: string;
  ivB64: string;
  keyVersion: number;
  attempts: number;
  expiresAt: number;
}

// Pending email-change OTPs — keyed by accountId. The new email sits in the
// entry rather than the key so the service can reject attempts that belong
// to a stale "begin" call.
export interface PendingEmailChange {
  newEmail: string;
  codeHash: string;
  attempts: number;
  expiresAt: number;
}

/**
 * A `/authorize` request that passed validation but still needs the user —
 * to sign in, to pick a profile, or to approve the relying party.
 *
 * The whole request is parked SERVER-side and the browser is redirected to
 * the consent UI carrying nothing but an opaque id. The UI therefore cannot
 * alter the scope, the redirect URI, or the client it is asking about: the
 * parameters the user approves are, by construction, the parameters that were
 * validated. Nothing here is secret, but everything here is load-bearing.
 */
export interface PendingAuthorizeRequest {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string | null;
  nonce: string | null;
  codeChallenge: string;
  /**
   * The relying party's `max_age` in seconds, or null when absent. Re-checked
   * at decision time: the user can sit on the consent screen long enough for a
   * session that satisfied `max_age` at `/authorize` to stop satisfying it.
   */
  maxAge: number | null;
  /**
   * Unix seconds. When set, the deciding session must have been CREATED at or
   * after this instant — i.e. the user re-authenticated after the request was
   * parked. Set when `prompt=login` was demanded or `max_age` was already
   * exceeded at `/authorize`. Null when any live session may decide.
   */
  requireAuthAfter: number | null;
  /**
   * SHA-256 hex of the browser-binding secret handed out as a short-TTL
   * HttpOnly cookie alongside the interaction redirect. The decision (and
   * context read) must present the matching cookie, so a leaked or guessed
   * request id is useless in any other browser. Required: every parked
   * request carries one — a writer that omits it cannot silently disable the
   * binding check.
   */
  bindingHash: string;
  /** Milliseconds. */
  expiresAt: number;
}

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

/** Default in-memory jti store — single-process only. */
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

/**
 * Build the default in-memory ceremony stores. Each carries the metric
 * observer so per-namespace op/entry telemetry works identically to the
 * Redis-backed path. Used when `AuthConfig.ceremonyStores` is omitted.
 */
export function createDefaultCeremonyStores(): CeremonyStores {
  const observer = {
    onOp: (op: "set" | "get" | "delete", namespace: RedisNamespace) =>
      metricCeremonyStoreOp({ op, namespace, backend: "memory" }),
    onEntryDelta: (delta: number, namespace: RedisNamespace) =>
      metricCeremonyStoreEntryDelta(delta, { namespace, backend: "memory" }),
  };
  return {
    registrationChallenges: createInMemoryCeremonyStore<RegistrationChallengeEntry>(
      "reg_challenge",
      observer,
    ),
    loginChallenges: createInMemoryCeremonyStore<ChallengeEntry>("login_challenge", observer),
    pendingRegistrations: createInMemoryCeremonyStore<PendingRegistration>(
      "pending_registration",
      observer,
    ),
    stepUpPasskeyChallenges: createInMemoryCeremonyStore<ChallengeEntry>(
      "step_up_challenge",
      observer,
    ),
    stepUpOtp: createInMemoryCeremonyStore<StepUpOtpEntry>("step_up_otp", observer),
    pendingRecoveryOtp: createInMemoryCeremonyStore<PendingRecoveryOtp>(
      "pending_recovery_otp",
      observer,
    ),
    pendingTotpEnrollments: createInMemoryCeremonyStore<PendingTotpEnrollment>(
      "pending_totp_enroll",
      observer,
    ),
    pendingEmailChanges: createInMemoryCeremonyStore<PendingEmailChange>(
      "pending_email_change",
      observer,
    ),
    crossDeviceRequests: createInMemoryCeremonyStore<CrossDeviceRequest>("cross_device", observer),
    authorizeRequests: createInMemoryCeremonyStore<PendingAuthorizeRequest>(
      "oidc_authorize_request",
      observer,
    ),
    recoveryDisownTokens: createInMemoryCeremonyStore<RecoveryDisownToken>(
      "recovery_disown",
      observer,
    ),
  };
}

/**
 * A default in-memory fixed-window per-account cap limiter. Structurally a
 * `RateLimiterBackend` so the same `check(key)` contract is satisfied by the
 * Redis-backed limiter injected in production.
 */
export function createInMemoryAccountCap(maxRequests: number, windowMs: number): AccountCapLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    async check(key: string): Promise<boolean> {
      const nowMs = Date.now();
      const bucket = buckets.get(key);
      if (!bucket || nowMs >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: nowMs + windowMs });
        return true;
      }
      if (bucket.count >= maxRequests) return false;
      bucket.count += 1;
      return true;
    },
  };
}
