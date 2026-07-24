/**
 * Tunable bounds and reserved names shared across the auth modules. Each
 * constant keeps the security rationale it shipped with — change values
 * here, not at call sites.
 */

/** CDL request TTL in seconds. */
export const CDL_TTL_SECONDS = 300; // 5 min

// Max OTP guesses against a single pending entry before it is wiped.
export const MAX_OTP_ATTEMPTS = 5;

/**
 * COPPA hard age gate (C-H8). Registration rejects anyone under this age
 * before any personal information is collected (before the OTP is sent), so
 * OSN never gains "actual knowledge" of an under-13 user. The birthdate is
 * validated transiently and NEVER persisted. See [[compliance/coppa]].
 */
export const MIN_AGE_YEARS = 13;
// O3: short TTL for WebAuthn challenge entries (passkey register / login /
// step-up). 120s matches the previous inline `Date.now() + 120_000`.
export const CHALLENGE_TTL_MS = 120_000;

// Per-account profile-switch rate limiting (S-M3). Fixed window:
// max 20 switches per hour per account. O3: enforced via an injectable
// per-account cap limiter (`profileSwitchCap`) so the window is shared across
// pods; the default is an in-memory fixed-window limiter with these bounds.
export const PROFILE_SWITCH_MAX = 20;
export const PROFILE_SWITCH_WINDOW_MS = 3_600_000; // 1 hour

export const RESERVED_HANDLES = new Set([
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

/**
 * Hard cap on concurrent sessions per account (S-M1). An attacker who
 * compromises an account cannot inflate the revocation / list surface
 * beyond this limit; new sessions LRU-evict the oldest rather than
 * rejecting the legitimate login. Typical users have <10 sessions
 * across all their devices, so 50 is conservative.
 */
export const MAX_SESSIONS_PER_ACCOUNT = 50;
/**
 * Rotation-reuse grace window (refresh-token concurrency tolerance).
 *
 * Refresh-token rotation is single-use: each `/token` grant deletes the old
 * session row and mints a new one, and a replay of a rotated-out token
 * normally revokes the whole family (Copenhagen Book C2). But legitimate
 * clients produce concurrent/near-concurrent grants of the SAME current token
 * — multiple browser tabs bootstrapping on reload, a cold-start bootstrap
 * racing a 401-refresh, or a retried grant after a lost response — and the
 * strict rule mis-classifies those as reuse and logs the user out across every
 * device (the "logs out sometimes" bug). Within this window after a rotation,
 * a replay of the just-rotated token is treated as benign concurrency (the
 * grant fails but the family is preserved) instead of triggering revocation.
 *
 * Kept SHORT: a genuine attacker replaying a stolen rotated token seconds
 * after the legitimate rotation gains nothing they couldn't already do with
 * the live token, and any replay OUTSIDE this window still revokes the family.
 * Mirrors the "reuse leeway" interval standard in rotating-refresh-token
 * implementations. See `[[wiki/systems/sessions]]`.
 */
export const ROTATION_GRACE_MS = 10_000;
/**
 * Hard cap on passkeys per account (P-I10). An attacker with a stolen
 * access token (or a hijacked enrollment token) cannot add unlimited
 * credentials; 10 is comfortably above the real-world ceiling of one
 * passkey per device for a typical user.
 */
export const MAX_PASSKEYS_PER_ACCOUNT = 10;
/**
 * Coalesce window for `passkeys.last_used_at` writes (mirrors
 * LAST_USED_AT_COALESCE_MS for sessions). Sub-minute accuracy on the
 * Settings surface buys nothing and adds a DB write per authenticator
 * ceremony — not worth it on the hot path.
 */
export const PASSKEY_LAST_USED_COALESCE_MS = 60_000;
/**
 * Minimum gap between `last_used_at` writes on the hot-path (P-W4).
 * The Sessions UI doesn't need sub-second accuracy; coalescing to 60s
 * cuts per-refresh DB writes by ~60× at typical 5-min refresh cadence.
 */
export const LAST_USED_AT_COALESCE_MS = 60_000;
/**
 * Per-account cap on `/account/email/begin` (S-H3). Complements the
 * per-IP rate limit and prevents an authenticated attacker pooling
 * their allowance across rotating IPs to spam the OSN sending domain.
 * Window is 24h to match the 2-per-7-days hard cap on complete.
 */
export const EMAIL_CHANGE_BEGIN_PER_ACCOUNT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const EMAIL_CHANGE_BEGIN_PER_ACCOUNT_MAX = 3;

// ---------------------------------------------------------------------------
// OIDC provider
// ---------------------------------------------------------------------------

/**
 * Authorization-code lifetime in seconds. The code travels one hop — a
 * redirect from the browser to the relying party, which exchanges it at once
 * from its own back end. OAuth 2.1 recommends a maximum of one minute and
 * nothing legitimate needs longer.
 */
export const AUTHORIZATION_CODE_TTL_SEC = 60;

/**
 * How long a validated `/authorize` request waits in the ceremony store while
 * the user signs in, picks a profile, or reads the consent screen. Long enough
 * to enrol a passkey on a slow phone, short enough that an abandoned tab does
 * not keep a valid request alive for the rest of the day.
 */
export const AUTHORIZE_REQUEST_TTL_MS = 10 * 60 * 1000;

/**
 * ID-token lifetime in seconds. It is a statement about a sign-in that just
 * happened, consumed the moment the relying party receives it, so it does not
 * need to outlive the exchange by much. Matches the access-token default.
 */
export const ID_TOKEN_TTL_SEC = 300;

/**
 * Hard ceiling on the raw length of any single `/authorize` parameter we echo
 * or store (`state`, `nonce`, `code_challenge`). Nothing legitimate approaches
 * it; without it a relying party could park kilobytes in the ceremony store on
 * every unauthenticated request.
 */
export const OIDC_PARAM_MAX_LENGTH = 512;
