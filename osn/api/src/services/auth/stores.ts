/**
 * Ceremony / pending-state store contracts and their in-memory defaults.
 * Value shapes live here alongside the store bundle so `index.ts` (and the
 * Redis wiring in `lib/redis-ceremony-stores.ts`) import them from one place.
 */

import type { RedisNamespace } from "@shared/redis";

import { createInMemoryCeremonyStore, type CeremonyStore } from "../../lib/ceremony-store";
import { metricCeremonyStoreEntryDelta, metricCeremonyStoreOp } from "../../metrics";
import type { PublicProfile } from "./types";

/**
 * O3: minimal per-account cap surface — structurally compatible with
 * `RateLimiterBackend` from `@shared/rate-limit` and the Redis rate-limiter,
 * so `index.ts` can pass a `createRedisRateLimiter(...)` straight in.
 */
export interface AccountCapLimiter {
  check(key: string): Promise<boolean>;
}

/**
 * O3: the full set of ceremony / pending-state stores threaded through the
 * auth service. Bundled so `index.ts` wires one Redis client into all of them
 * in a single place, and so tests can override the whole set at once.
 */
export interface CeremonyStores {
  registrationChallenges: CeremonyStore<ChallengeEntry>;
  loginChallenges: CeremonyStore<ChallengeEntry>;
  pendingRegistrations: CeremonyStore<PendingRegistration>;
  stepUpPasskeyChallenges: CeremonyStore<ChallengeEntry>;
  stepUpOtp: CeremonyStore<StepUpOtpEntry>;
  pendingEmailChanges: CeremonyStore<PendingEmailChange>;
  crossDeviceRequests: CeremonyStore<CrossDeviceRequest>;
  authorizeRequests: CeremonyStore<PendingAuthorizeRequest>;
}

// ---------------------------------------------------------------------------
// In-memory stores (module-level, single-process)
// ---------------------------------------------------------------------------

export interface ChallengeEntry {
  challenge: string;
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

// O3: in-memory bounds (pending registrations, pending CDL, login challenges)
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

// O3: challenge / pending-state value shapes. The stores that hold them are
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

/**
 * O3: build the default in-memory ceremony stores. Each carries the metric
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
    registrationChallenges: createInMemoryCeremonyStore<ChallengeEntry>("reg_challenge", observer),
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
    pendingEmailChanges: createInMemoryCeremonyStore<PendingEmailChange>(
      "pending_email_change",
      observer,
    ),
    crossDeviceRequests: createInMemoryCeremonyStore<CrossDeviceRequest>("cross_device", observer),
    authorizeRequests: createInMemoryCeremonyStore<PendingAuthorizeRequest>(
      "oidc_authorize_request",
      observer,
    ),
  };
}

/**
 * O3: a default in-memory fixed-window per-account cap limiter. Structurally a
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
