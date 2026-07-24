import { createRateLimiter, type RateLimiterBackend } from "@shared/rate-limit";

/**
 * Typed map of every rate limiter the auth routes consume. Split out as a
 * named type so the Redis migration (Phase 2) can supply a mixed bag of
 * Redis-backed and in-memory backends per endpoint without touching
 * `createAuthRoutes` call sites.
 */
export type AuthRateLimiters = Readonly<{
  registerBegin: RateLimiterBackend;
  registerComplete: RateLimiterBackend;
  handleCheck: RateLimiterBackend;
  passkeyLoginBegin: RateLimiterBackend;
  passkeyLoginComplete: RateLimiterBackend;
  passkeyRegisterBegin: RateLimiterBackend;
  passkeyRegisterComplete: RateLimiterBackend;
  profileSwitch: RateLimiterBackend;
  profileList: RateLimiterBackend;
  /** Recovery code generation (authenticated) — per-account quota. */
  recoveryGenerate: RateLimiterBackend;
  /** Recovery code login — per-IP quota, stricter than normal login completers. */
  recoveryComplete: RateLimiterBackend;
  /** Step-up passkey begin (authenticated, issues a challenge). */
  stepUpPasskeyBegin: RateLimiterBackend;
  /** Step-up passkey complete (authenticated, consumes assertion). */
  stepUpPasskeyComplete: RateLimiterBackend;
  /** Step-up OTP begin (authenticated, sends email). */
  stepUpOtpBegin: RateLimiterBackend;
  /** Step-up OTP complete (authenticated, verifies code). */
  stepUpOtpComplete: RateLimiterBackend;
  /** Session list (authenticated, per-user). */
  sessionList: RateLimiterBackend;
  /** Session revoke (authenticated, per-user). */
  sessionRevoke: RateLimiterBackend;
  /** Email change begin (authenticated, sends OTP to new email). */
  emailChangeBegin: RateLimiterBackend;
  /** Email change complete (authenticated, verifies OTP + step-up). */
  emailChangeComplete: RateLimiterBackend;
  /** Security event list (authenticated, per-user). */
  securityEventList: RateLimiterBackend;
  /** Security event acknowledge (authenticated, per-user). */
  securityEventAck: RateLimiterBackend;
  /** Passkey list (authenticated, per-user). */
  passkeyList: RateLimiterBackend;
  /** Passkey rename (authenticated, per-user). */
  passkeyRename: RateLimiterBackend;
  /** Passkey delete (authenticated, per-user — step-up is the primary gate). */
  passkeyDelete: RateLimiterBackend;
  /** Cross-device login begin (unauthenticated, per-IP). */
  crossDeviceBegin: RateLimiterBackend;
  /** Cross-device login poll (unauthenticated, per-IP — higher budget for 2s polling). */
  crossDevicePoll: RateLimiterBackend;
  /** Cross-device login approve (authenticated, per-IP). */
  crossDeviceApprove: RateLimiterBackend;
  /** Cross-device login reject (authenticated, per-IP). */
  crossDeviceReject: RateLimiterBackend;
  /**
   * OIDC authorization endpoint (per-IP). A top-level navigation, so the
   * budget covers a person bouncing between two or three relying parties
   * rather than a script.
   */
  oidcAuthorize: RateLimiterBackend;
  /** Consent-screen context read (per-IP — one call per screen, plus reloads). */
  oidcAuthorizeContext: RateLimiterBackend;
  /** Consent decision (per-IP — a request id is single-use, so retries are few). */
  oidcAuthorizeDecision: RateLimiterBackend;
  /**
   * OIDC token exchange (per-IP). Server-to-server, so the IP is the relying
   * party's, not a person's — the budget is a brake on a broken client, and
   * the real defence is that a code is single-use and bound to its PKCE
   * verifier.
   */
  oidcToken: RateLimiterBackend;
}>;

/**
 * Default in-memory rate limiter bundle used when callers don't pass an
 * explicit `rateLimiters` override. Limits match the values documented in
 * CLAUDE.md > Rate Limiting (S-H1): 5 req/IP/min on send endpoints, 10
 * req/IP/min on verify/complete endpoints.
 */
export function createDefaultAuthRateLimiters(): AuthRateLimiters {
  return {
    registerBegin: createRateLimiter({ maxRequests: 5, windowMs: 60_000 }),
    registerComplete: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    // Generous headroom: handle-check fires as-you-type and login-begin is
    // auto-fired by the passkey conditional-UI / autofill ceremony per page
    // load (cheap; the real gates are *-complete). Mirrors the native binding
    // tiers in native-rate-limiters.ts (used in deployed envs).
    handleCheck: createRateLimiter({ maxRequests: 30, windowMs: 60_000 }),
    passkeyLoginBegin: createRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    passkeyLoginComplete: createRateLimiter({ maxRequests: 20, windowMs: 60_000 }),
    passkeyRegisterBegin: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    passkeyRegisterComplete: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    profileSwitch: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    profileList: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    // Recovery generation: the step-up gate is now the primary defence
    // against stolen-access-token abuse (superseding the per-day cap
    // relied on previously for S-M1). Keep a coarse per-IP throttle in
    // place so the endpoint isn't trivially floodable.
    recoveryGenerate: createRateLimiter({ maxRequests: 10, windowMs: 3_600_000 }),
    // Recovery login is an IP-side limit; the underlying DB hash comparison
    // is already constant-time, but per-IP throttling curbs online brute
    // force across different account identifiers.
    recoveryComplete: createRateLimiter({ maxRequests: 5, windowMs: 3_600_000 }),
    // Step-up ceremonies: treat like login completers. A misbehaving
    // browser that keeps retrying a bad OTP shouldn't be able to burn
    // through codes faster than a human.
    stepUpPasskeyBegin: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    stepUpPasskeyComplete: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    stepUpOtpBegin: createRateLimiter({ maxRequests: 5, windowMs: 60_000 }),
    stepUpOtpComplete: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    sessionList: createRateLimiter({ maxRequests: 30, windowMs: 60_000 }),
    sessionRevoke: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    // Email change begin is tightly capped because each call sends mail
    // to a user-controlled address — uncapped it would be an open relay
    // for an authenticated attacker.
    emailChangeBegin: createRateLimiter({ maxRequests: 3, windowMs: 3_600_000 }),
    emailChangeComplete: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    // Security events (M-PK1b): cheap reads and idempotent acks. Mirror the
    // sessionList budget for the listing surface; ack is a single-row update
    // and only dismisses a banner, so a generous per-minute allowance.
    securityEventList: createRateLimiter({ maxRequests: 30, windowMs: 60_000 }),
    securityEventAck: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    // Passkey management (M-PK). Listing is cheap; rename / delete are
    // infrequent settings actions. Delete has an additional step-up gate.
    passkeyList: createRateLimiter({ maxRequests: 30, windowMs: 60_000 }),
    passkeyRename: createRateLimiter({ maxRequests: 20, windowMs: 60_000 }),
    passkeyDelete: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    crossDeviceBegin: createRateLimiter({ maxRequests: 5, windowMs: 60_000 }),
    crossDevicePoll: createRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    crossDeviceApprove: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    crossDeviceReject: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    oidcAuthorize: createRateLimiter({ maxRequests: 20, windowMs: 60_000 }),
    oidcAuthorizeContext: createRateLimiter({ maxRequests: 30, windowMs: 60_000 }),
    oidcAuthorizeDecision: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    oidcToken: createRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
  };
}
