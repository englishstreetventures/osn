import { createRateLimiter, type RateLimiterBackend } from "@shared/rate-limit";

import {
  EMAIL_CHANGE_BEGIN_PER_ACCOUNT_MAX,
  EMAIL_CHANGE_BEGIN_PER_ACCOUNT_WINDOW_MS,
  PROFILE_SWITCH_MAX,
  PROFILE_SWITCH_WINDOW_MS,
  RECOVERY_RESENDS_PER_ACCOUNT_MAX,
  RECOVERY_RESENDS_PER_ACCOUNT_WINDOW_MS,
  RECOVERY_LINKS_PER_ACCOUNT_CEILING,
  RECOVERY_LINKS_PER_ACCOUNT_CEILING_WINDOW_MS,
  RECOVERY_LINKS_PER_ADDRESS_MAX,
  RECOVERY_LINKS_PER_ADDRESS_WINDOW_MS,
  REGISTRATION_SENDS_PER_ADDRESS_MAX,
  REGISTRATION_SENDS_PER_ADDRESS_WINDOW_MS,
} from "../../services/auth/constants";

/**
 * Typed map of every rate limiter the auth routes consume. Each slot is a
 * `RateLimiterBackend`, so a caller can mix backends per endpoint — native
 * bindings for some, the coordination store for others — without touching
 * `createAuthRoutes` call sites.
 */
export type AuthRateLimiters = Readonly<{
  registerBegin: RateLimiterBackend;
  /**
   * Sign-up status poll (unauthenticated, per-IP). The tab that began polls
   * every few seconds while it waits, so the budget is a polling one.
   */
  registerStatus: RateLimiterBackend;
  /** Sign-up link Resend (unauthenticated, SENDS MAIL, per-IP). */
  registerResend: RateLimiterBackend;
  /**
   * Emailed-link confirm (unauthenticated, per-IP). The 256-bit secret and the
   * per-request wipe are the real gate; this is the brake on flooding.
   */
  emailLinkConfirm: RateLimiterBackend;
  /**
   * Emailed-link candidates read (unauthenticated, per-IP): the confirm page
   * reads it once on load, again on a reload.
   */
  emailLinkCandidates: RateLimiterBackend;
  handleCheck: RateLimiterBackend;
  passkeyLoginBegin: RateLimiterBackend;
  passkeyLoginComplete: RateLimiterBackend;
  passkeyRegisterBegin: RateLimiterBackend;
  passkeyRegisterComplete: RateLimiterBackend;
  profileSwitch: RateLimiterBackend;
  profileList: RateLimiterBackend;
  /** Recovery code generation (authenticated) — per-account quota. */
  recoveryGenerate: RateLimiterBackend;
  /** Recovery code status (authenticated, settings read — mirrors sessionList). */
  recoveryStatus: RateLimiterBackend;
  /** Recovery code login — per-IP quota, stricter than normal login completers. */
  recoveryComplete: RateLimiterBackend;
  /**
   * Email account-recovery begin (unauthenticated, SENDS MAIL to the address on
   * file). Hour window, so no native binding can carry it. With Turnstile, the
   * per-(account, address) link cap (`recoveryLinkAddressCap`) and the daily
   * ceiling (`recoveryLinkCeiling`), it is what bounds first links; the
   * account's Resend cap never counts one.
   */
  recoveryEmailBegin: RateLimiterBackend;
  /**
   * Email account-recovery status, polled by the tab that began with its claim
   * secret; the poll that finds the link confirmed gets the restricted session.
   */
  recoveryEmailStatus: RateLimiterBackend;
  /** Email account-recovery Resend (another link for the same request; sends mail). */
  recoveryEmailResend: RateLimiterBackend;
  /** TOTP account-recovery complete (unauthenticated, verifies a 6-digit code). */
  recoveryTotpComplete: RateLimiterBackend;
  /**
   * Recovery disown (unauthenticated, presents a token from the notice email).
   * The 256-bit secret is the real gate; this is the coarse brake that stops
   * the endpoint being floodable.
   */
  recoveryDisown: RateLimiterBackend;
  /** Step-up passkey begin (authenticated, issues a challenge). */
  stepUpPasskeyBegin: RateLimiterBackend;
  /** Step-up passkey complete (authenticated, consumes assertion). */
  stepUpPasskeyComplete: RateLimiterBackend;
  /** Step-up OTP begin (authenticated, sends email). */
  stepUpOtpBegin: RateLimiterBackend;
  /** Step-up OTP complete (authenticated, verifies code). */
  stepUpOtpComplete: RateLimiterBackend;
  /**
   * Step-up TOTP complete (authenticated, verifies a code). There is no
   * `begin` — TOTP is challenge-free, so the ceremony is one call.
   */
  stepUpTotpComplete: RateLimiterBackend;
  /** TOTP enrolment begin (authenticated, step-up gated, mints a secret). */
  totpEnrollBegin: RateLimiterBackend;
  /** TOTP enrolment complete (authenticated, verifies the first code). */
  totpEnrollComplete: RateLimiterBackend;
  /** TOTP disable (authenticated, step-up gated). */
  totpDisable: RateLimiterBackend;
  /** TOTP status (authenticated, settings read — mirrors recoveryStatus). */
  totpStatus: RateLimiterBackend;
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
  /** Connections list (authenticated, settings read — mirrors sessionList). */
  oidcConnectionsList: RateLimiterBackend;
  /** Connections revoke (authenticated, infrequent settings write). */
  oidcConnectionsRevoke: RateLimiterBackend;
  /**
   * Client registration (authenticated, hour-window). Each call mints a
   * durable credential row, so the budget mirrors emailChangeBegin's shape:
   * a person registers a handful ever, a script gets stopped.
   */
  oidcClientCreate: RateLimiterBackend;
  /** Owned-client list (authenticated, settings read). */
  oidcClientList: RateLimiterBackend;
  /** Owned-client disable (authenticated, infrequent settings write). */
  oidcClientDisable: RateLimiterBackend;
}>;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * One limiter's budget: at most `maxRequests` hits in a fixed window of
 * `windowMs` that starts at the first hit.
 */
export interface RateLimitBudget {
  readonly maxRequests: number;
  readonly windowMs: number;
}

/**
 * An auth limiter's budget plus `ns`, the endpoint's name. The name prefixes
 * the key on a native binding (`<ns>:<ip>`) and names the coordination store
 * (`auth.<ns>`), so two endpoints never share a counter.
 */
export interface AuthRateLimitBudget extends RateLimitBudget {
  readonly ns: string;
}

/**
 * The budget of every auth limiter, and the only place one is set. Every
 * builder reads it: the in-memory bundle below, the coordination-store bundle
 * and the native-binding selection (`lib/native-rate-limiters.ts`), whose
 * `[[ratelimits]]` limits in `wrangler.toml` a test holds to these numbers.
 *
 * Per-IP throughout. The baseline is 5 a minute on endpoints that send mail
 * and 10 on endpoints that check a code or an assertion.
 */
export const AUTH_RATE_LIMITS = {
  registerBegin: { ns: "register_begin", maxRequests: 5, windowMs: MINUTE_MS },
  // Polled by the waiting tab, two to ten seconds apart: the cross-device
  // poll's budget.
  registerStatus: { ns: "register_status", maxRequests: 60, windowMs: MINUTE_MS },
  registerResend: { ns: "register_resend", maxRequests: 5, windowMs: MINUTE_MS },
  // A person presses Confirm once, maybe twice; the recovery disown budget.
  emailLinkConfirm: { ns: "email_link_confirm", maxRequests: 10, windowMs: MINUTE_MS },
  emailLinkCandidates: { ns: "email_link_candidates", maxRequests: 20, windowMs: MINUTE_MS },
  // Generous headroom: handle-check fires as-you-type and login-begin is
  // auto-fired by the passkey conditional-UI / autofill ceremony per page
  // load. Both are cheap; the real gates are the `*Complete` endpoints, which
  // need a valid assertion and stay tight.
  handleCheck: { ns: "handle_check", maxRequests: 30, windowMs: MINUTE_MS },
  passkeyLoginBegin: { ns: "passkey_login_begin", maxRequests: 60, windowMs: MINUTE_MS },
  passkeyLoginComplete: { ns: "passkey_login_complete", maxRequests: 20, windowMs: MINUTE_MS },
  passkeyRegisterBegin: { ns: "passkey_register_begin", maxRequests: 10, windowMs: MINUTE_MS },
  passkeyRegisterComplete: {
    ns: "passkey_register_complete",
    maxRequests: 10,
    windowMs: MINUTE_MS,
  },
  profileSwitch: { ns: "profile_switch", maxRequests: 10, windowMs: MINUTE_MS },
  profileList: { ns: "profile_list", maxRequests: 10, windowMs: MINUTE_MS },
  // Recovery generation: the step-up gate is the primary defence against
  // stolen-access-token abuse. A coarse per-IP throttle keeps the endpoint
  // from being trivially floodable.
  recoveryGenerate: { ns: "recovery_generate", maxRequests: 10, windowMs: HOUR_MS },
  // Read-only count, polled by the settings panel on mount and after every
  // generate — same budget as the other authenticated listing surfaces.
  recoveryStatus: { ns: "recovery_status", maxRequests: 30, windowMs: MINUTE_MS },
  // Recovery login is an IP-side limit; the underlying DB hash comparison is
  // already constant-time, but per-IP throttling curbs online brute force
  // across different account identifiers.
  recoveryComplete: { ns: "recovery_complete", maxRequests: 5, windowMs: HOUR_MS },
  // Mail-sending and unauthenticated: the same posture as emailChangeBegin,
  // one hour rather than one minute. A locked-out user retrying honestly needs
  // two or three; anything past that is not a person.
  recoveryEmailBegin: { ns: "recovery_email_begin", maxRequests: 5, windowMs: HOUR_MS },
  // The waiting tab polls every two to ten seconds; sign-up's status budget.
  recoveryEmailStatus: { ns: "recovery_email_status", maxRequests: 60, windowMs: MINUTE_MS },
  // Sign-up's Resend budget. The per-account and per-address link caps are
  // what bound the mail; this curbs a script.
  recoveryEmailResend: { ns: "recovery_email_resend", maxRequests: 5, windowMs: MINUTE_MS },
  // TOTP code entry. The real brake on guessing six digits is the per-account
  // lockout, which no rotating fleet can spread across.
  recoveryTotpComplete: { ns: "recovery_totp_complete", maxRequests: 10, windowMs: MINUTE_MS },
  // A person clicks the link in the email once, maybe twice. Anything past
  // that is a script guessing 256 bits, which this will not be what stops.
  recoveryDisown: { ns: "recovery_disown", maxRequests: 10, windowMs: MINUTE_MS },
  // Step-up ceremonies: treat like login completers. A misbehaving browser
  // that keeps retrying a bad OTP shouldn't be able to burn through codes
  // faster than a human.
  stepUpPasskeyBegin: { ns: "step_up_passkey_begin", maxRequests: 10, windowMs: MINUTE_MS },
  stepUpPasskeyComplete: { ns: "step_up_passkey_complete", maxRequests: 10, windowMs: MINUTE_MS },
  stepUpOtpBegin: { ns: "step_up_otp_begin", maxRequests: 5, windowMs: MINUTE_MS },
  stepUpOtpComplete: { ns: "step_up_otp_complete", maxRequests: 10, windowMs: MINUTE_MS },
  // TOTP. The per-IP budgets mirror the step-up OTP pair; the real brake on
  // guessing a six-digit code is the per-account lockout, which no rotating
  // fleet can spread across (`lib/recovery-lockout-store.ts`).
  stepUpTotpComplete: { ns: "step_up_totp_complete", maxRequests: 10, windowMs: MINUTE_MS },
  totpEnrollBegin: { ns: "totp_enroll_begin", maxRequests: 5, windowMs: MINUTE_MS },
  totpEnrollComplete: { ns: "totp_enroll_complete", maxRequests: 10, windowMs: MINUTE_MS },
  totpDisable: { ns: "totp_disable", maxRequests: 10, windowMs: MINUTE_MS },
  totpStatus: { ns: "totp_status", maxRequests: 30, windowMs: MINUTE_MS },
  sessionList: { ns: "session_list", maxRequests: 30, windowMs: MINUTE_MS },
  sessionRevoke: { ns: "session_revoke", maxRequests: 10, windowMs: MINUTE_MS },
  // Email change begin is tightly capped because each call sends mail to a
  // user-controlled address — uncapped it would be an open relay for an
  // authenticated attacker.
  emailChangeBegin: { ns: "email_change_begin", maxRequests: 3, windowMs: HOUR_MS },
  emailChangeComplete: { ns: "email_change_complete", maxRequests: 10, windowMs: MINUTE_MS },
  // Security events: cheap reads and idempotent acks. Mirror the sessionList
  // budget for the listing surface; ack is a single-row update and only
  // dismisses a banner.
  securityEventList: { ns: "security_event_list", maxRequests: 30, windowMs: MINUTE_MS },
  securityEventAck: { ns: "security_event_ack", maxRequests: 10, windowMs: MINUTE_MS },
  // Passkey management. Listing is cheap; rename / delete are infrequent
  // settings actions. Delete has an additional step-up gate.
  passkeyList: { ns: "passkey_list", maxRequests: 30, windowMs: MINUTE_MS },
  passkeyRename: { ns: "passkey_rename", maxRequests: 20, windowMs: MINUTE_MS },
  passkeyDelete: { ns: "passkey_delete", maxRequests: 10, windowMs: MINUTE_MS },
  crossDeviceBegin: { ns: "cross_device_begin", maxRequests: 5, windowMs: MINUTE_MS },
  crossDevicePoll: { ns: "cross_device_poll", maxRequests: 60, windowMs: MINUTE_MS },
  crossDeviceApprove: { ns: "cross_device_approve", maxRequests: 10, windowMs: MINUTE_MS },
  crossDeviceReject: { ns: "cross_device_reject", maxRequests: 10, windowMs: MINUTE_MS },
  oidcAuthorize: { ns: "oidc_authorize", maxRequests: 20, windowMs: MINUTE_MS },
  oidcAuthorizeContext: { ns: "oidc_authorize_context", maxRequests: 60, windowMs: MINUTE_MS },
  oidcAuthorizeDecision: { ns: "oidc_authorize_decision", maxRequests: 10, windowMs: MINUTE_MS },
  // The key here is the relying party's server IP, not a person's, so the
  // budget is a brake on a broken client rather than an abuse gate — a code is
  // single-use and bound to its PKCE verifier, which is the real defence.
  oidcToken: { ns: "oidc_token", maxRequests: 60, windowMs: MINUTE_MS },
  oidcConnectionsList: { ns: "oidc_connections_list", maxRequests: 30, windowMs: MINUTE_MS },
  oidcConnectionsRevoke: { ns: "oidc_connections_revoke", maxRequests: 10, windowMs: MINUTE_MS },
  oidcClientCreate: { ns: "oidc_client_create", maxRequests: 5, windowMs: HOUR_MS },
  oidcClientList: { ns: "oidc_client_list", maxRequests: 30, windowMs: MINUTE_MS },
  oidcClientDisable: { ns: "oidc_client_disable", maxRequests: 10, windowMs: MINUTE_MS },
} as const satisfies { readonly [K in keyof AuthRateLimiters]: AuthRateLimitBudget };

/** The name every auth limiter's coordination store takes: `auth.<ns>`. */
export type AuthLimiterStoreName =
  `auth.${(typeof AUTH_RATE_LIMITS)[keyof typeof AUTH_RATE_LIMITS]["ns"]}`;

/**
 * A limiter outside the auth routes: its budget plus `store`, the name of the
 * coordination store that holds its counters.
 */
export interface NamedRateLimitBudget extends RateLimitBudget {
  readonly store: string;
}

/**
 * Every other limiter's budget, and the only place one is set. Same readers
 * as {@link AUTH_RATE_LIMITS}.
 */
export const OSN_RATE_LIMITS = {
  // Per user. Social-graph and organisation writes.
  graphWrite: { store: "graph.write", maxRequests: 60, windowMs: MINUTE_MS },
  orgWrite: { store: "org.write", maxRequests: 60, windowMs: MINUTE_MS },
  // Per user. `/recommendations/connections` runs a friends-of-friends
  // fan-out, so it gets less than a graph write. `/recommendations/search` is
  // typeahead, fired once per debounced keystroke: 20 a minute would refuse a
  // user mid-word, so it gets the graph-write budget. Both stay capped, which
  // is what bounds handle enumeration.
  recommendationSuggest: { store: "recs.read", maxRequests: 20, windowMs: MINUTE_MS },
  recommendationSearch: { store: "recs.search", maxRequests: 60, windowMs: MINUTE_MS },
  // Per IP. Profile create, delete and set-default.
  profileCreate: { store: "profile.create", maxRequests: 5, windowMs: MINUTE_MS },
  profileDelete: { store: "profile.delete", maxRequests: 5, windowMs: MINUTE_MS },
  profileSetDefault: { store: "profile.set_default", maxRequests: 10, windowMs: MINUTE_MS },
  // Per IP. `GET /health/coordination` costs three store calls. The
  // post-deploy smoke check asks it at most eight times in its minute
  // (`scripts/smoke-check.ts`), so ten leaves it room.
  healthCoordination: { store: "health.coordination", maxRequests: 10, windowMs: MINUTE_MS },
  // Per account: one export a day, keyed on the server-derived account so
  // rotating IPs cannot get round it. The per-IP guard before it keeps an
  // unauthenticated flood from spending token-verification time.
  accountExport: { store: "account.export", maxRequests: 1, windowMs: DAY_MS },
  accountExportIp: { store: "account.export_ip", maxRequests: 30, windowMs: MINUTE_MS },
  // Per IP: `routes/account-erasure.ts` keys each on the caller's address.
  // Deletion is a destructive ceremony; the step-up gate is the primary
  // defence and these only curb noise.
  accountDelete: { store: "account.delete", maxRequests: 5, windowMs: HOUR_MS },
  accountRestore: { store: "account.restore", maxRequests: 10, windowMs: HOUR_MS },
  accountDeletionStatus: {
    store: "account.deletion_status",
    maxRequests: 30,
    windowMs: MINUTE_MS,
  },
  // Per-account caps. `check(accountId)` answers true while under the cap.
  profileSwitchCap: {
    store: "auth.profile_switch_cap",
    maxRequests: PROFILE_SWITCH_MAX,
    windowMs: PROFILE_SWITCH_WINDOW_MS,
  },
  emailChangeBeginCap: {
    store: "auth.email_change_begin_cap",
    maxRequests: EMAIL_CHANGE_BEGIN_PER_ACCOUNT_MAX,
    windowMs: EMAIL_CHANGE_BEGIN_PER_ACCOUNT_WINDOW_MS,
  },
  // Recovery links, checked only where one goes out. The address cap counts
  // every link and is keyed on `serverMac.recoverySendKey(accountId, ip)`;
  // the Resend cap counts Resends only, keyed on the RESOLVED accountId —
  // never on the identifier a stranger submitted. See
  // `RECOVERY_LINKS_PER_ADDRESS_MAX` and `RECOVERY_RESENDS_PER_ACCOUNT_MAX`.
  recoveryLinkAddressCap: {
    store: "auth.recovery_link_address_cap",
    maxRequests: RECOVERY_LINKS_PER_ADDRESS_MAX,
    windowMs: RECOVERY_LINKS_PER_ADDRESS_WINDOW_MS,
  },
  recoveryResendCap: {
    store: "auth.recovery_resend_cap",
    maxRequests: RECOVERY_RESENDS_PER_ACCOUNT_MAX,
    windowMs: RECOVERY_RESENDS_PER_ACCOUNT_WINDOW_MS,
  },
  // Every recovery link to one account, keyed on a keyed digest of the
  // account id (`serverMac.probeKey`). See `RECOVERY_LINKS_PER_ACCOUNT_CEILING`.
  recoveryLinkCeiling: {
    store: "auth.recovery_link_ceiling",
    maxRequests: RECOVERY_LINKS_PER_ACCOUNT_CEILING,
    windowMs: RECOVERY_LINKS_PER_ACCOUNT_CEILING_WINDOW_MS,
  },
  // Keyed on the probe key of `mailboxKey(address)` for the address a sign-up link goes to, and checked
  // only where one goes out. See `REGISTRATION_SENDS_PER_ADDRESS_MAX`.
  registrationSendCap: {
    store: "auth.registration_send_cap",
    maxRequests: REGISTRATION_SENDS_PER_ADDRESS_MAX,
    windowMs: REGISTRATION_SENDS_PER_ADDRESS_WINDOW_MS,
  },
} as const satisfies Readonly<Record<string, NamedRateLimitBudget>>;

/** The name of every non-auth limiter's coordination store. */
export type OsnLimiterStoreName = (typeof OSN_RATE_LIMITS)[keyof typeof OSN_RATE_LIMITS]["store"];

/** An in-memory fixed-window limiter with `budget`. Single process only. */
export const memoryLimiter = (budget: RateLimitBudget): RateLimiterBackend =>
  createRateLimiter({ maxRequests: budget.maxRequests, windowMs: budget.windowMs });

/**
 * The in-memory bundle: one limiter per endpoint, budgets from
 * {@link AUTH_RATE_LIMITS}. The default when `createAuthRoutes` is given none.
 */
export function createDefaultAuthRateLimiters(): AuthRateLimiters {
  const out = {} as { -readonly [K in keyof AuthRateLimiters]: RateLimiterBackend };
  for (const key of Object.keys(AUTH_RATE_LIMITS) as (keyof AuthRateLimiters)[]) {
    out[key] = memoryLimiter(AUTH_RATE_LIMITS[key]);
  }
  return out;
}
