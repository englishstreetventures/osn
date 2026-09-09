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
 * COPPA hard age gate. Registration rejects anyone under this age
 * before any personal information is collected (before the OTP is sent), so
 * OSN never gains "actual knowledge" of an under-13 user. The birthdate is
 * validated transiently and NEVER persisted. See [[compliance/coppa]].
 */
export const MIN_AGE_YEARS = 13;
// Short TTL for WebAuthn challenge entries (passkey register / login /
// step-up). 120s matches the previous inline `Date.now() + 120_000`.
export const CHALLENGE_TTL_MS = 120_000;

// Per-account profile-switch rate limiting. Fixed window:
// max 20 switches per hour per account. Enforced via an injectable
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
  // The dev sign-in principal (`routes/auth/dev-login.ts`). Reserved so a real
  // registration on the dev tier cannot take the handle first — its
  // provisioning insert would then be skipped as a conflict and the sign-in
  // would resolve nothing.
  "dev_bootstrap",
  // Its organisation. Org creation consults this same set, so neither name can
  // be squatted before provisioning runs.
  "dev_bootstrap_org",
]);

/**
 * Hard cap on concurrent sessions per account. An attacker who
 * compromises an account cannot inflate the revocation / list surface
 * beyond this limit; new sessions LRU-evict the oldest rather than
 * rejecting the legitimate login. Typical users have <10 sessions
 * across all their devices, so 50 is conservative.
 */
export const MAX_SESSIONS_PER_ACCOUNT = 50;

/**
 * `aud` on an ordinary user access token. Asserted in `verifyAccessToken`, so
 * an ES256 token signed with the same key but minted for a different audience
 * — a step-up token, an OIDC access token, a recovery token — cannot
 * authenticate access-token routes.
 */
export const ACCESS_TOKEN_AUDIENCE = "osn-access";

/**
 * `aud` on the access token of a **restricted recovery session**.
 *
 * A distinct audience rather than a claim on an `osn-access` token, because
 * there is no single guard to add a claim check to: four entry points in this
 * service verify access tokens, and three services outside this repo verify the
 * same token over JWKS with no access to our database. Every one of them
 * already pins `osn-access`, so all seven reject this audience with no change
 * to any of them — fail-closed by construction, and not dependent on three
 * other services deploying anything.
 *
 * `resolvePasskeyEnrollPrincipal` is the only resolver that accepts it.
 */
export const RECOVERY_TOKEN_AUDIENCE = "osn-recovery";

/**
 * Absolute lifetime of a restricted recovery session, in seconds. It does not
 * slide: the row is inserted with `expiresAt === restrictedUntil` and rotation
 * copies that deadline forward rather than extending it.
 *
 * A credential that can do exactly one thing must not outlive the window in
 * which that thing is plausible, and a 30-day session that can do nothing would
 * still consume a slot against {@link MAX_SESSIONS_PER_ACCOUNT}.
 */
export const RECOVERY_SESSION_TTL_SEC = 900; // 15 min
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
 * Hard cap on passkeys per account. An attacker with a stolen
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
 * Minimum gap between `last_used_at` writes on the hot-path.
 * The Sessions UI doesn't need sub-second accuracy; coalescing to 60s
 * cuts per-refresh DB writes by ~60× at typical 5-min refresh cadence.
 */
export const LAST_USED_AT_COALESCE_MS = 60_000;
/**
 * Per-account cap on `/account/email/begin`. Complements the
 * per-IP rate limit and prevents an authenticated attacker pooling
 * their allowance across rotating IPs to spam the OSN sending domain.
 * Window is 24h to match the 2-per-7-days hard cap on complete.
 */
export const EMAIL_CHANGE_BEGIN_PER_ACCOUNT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const EMAIL_CHANGE_BEGIN_PER_ACCOUNT_MAX = 3;

// ---------------------------------------------------------------------------
// Email account recovery (`POST /login/recovery/email/{begin,complete}`)
// ---------------------------------------------------------------------------

/**
 * Per-account cap on `/login/recovery/email/begin`, keyed on the RESOLVED
 * accountId and never on the submitted identifier.
 *
 * The endpoint is unauthenticated and the recipient is the account holder's own
 * verified address, so an uncapped one floods a victim's inbox and — worse —
 * trains them to expect unsolicited recovery mail, which is the state a phishing
 * message wants them in. A per-IP limit alone does not reach this: a rotating
 * fleet defeats per-IP keys, which is why the cap exists at all.
 *
 * Three in 24 hours is above any honest retry (the code lives ten minutes and a
 * user who mistypes their address simply sends again) and far below anything
 * that reads as a flood.
 */
export const RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RECOVERY_EMAIL_BEGIN_PER_ACCOUNT_MAX = 3;

/**
 * How long an emailed recovery code stays valid. Matches the other OTP
 * ceremonies: long enough to leave the page, find the message and come back;
 * short enough that a code sitting in a compromised mailbox is not a standing
 * key to the account.
 */
export const RECOVERY_OTP_TTL_MS = 10 * 60 * 1000;

/**
 * The post-recovery cooldown, and the window a weak-provenance passkey waits
 * before it may act on an older credential. One constant for both because they
 * are one promise to the user: "whatever just happened without your passkey,
 * you have three days in which it cannot be made permanent."
 *
 * Long enough to cross a weekend or a holiday, which is when a notice email
 * goes unread; short enough that a genuine owner who has lost a device is not
 * meaningfully worse off than they already are.
 *
 * It is a property of the service, not a deployment's choice — there is no
 * `AuthConfig` field, for the reason `emailChangeAllowedAmr` has none: a window
 * a deployment can set to zero is not a guarantee.
 */
export const RECOVERY_COOLDOWN_MS = 72 * 60 * 60 * 1000;

/**
 * How long the "this wasn't me" token in the recovery notice stays usable.
 * Deliberately the same as {@link RECOVERY_COOLDOWN_MS}: the token exists to
 * make that window survivable, so a token that expired first would leave the
 * owner warned and unable to act for the remainder.
 */
export const RECOVERY_DISOWN_TTL_MS = RECOVERY_COOLDOWN_MS;

/**
 * Bytes of randomness in the secret half of a disown token. The public half is
 * a lookup id; this is what is compared, in constant time, against a stored
 * SHA-256. 32 bytes puts guessing out of reach of the per-IP limiter in front
 * of the route rather than relying on it.
 */
export const RECOVERY_DISOWN_SECRET_BYTES = 32;

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

/**
 * Upper bound on `max_age` seconds (10 years). Anything larger is a typo or a
 * probe, and an unbounded parse would let a relying party park 2^53 in a
 * comparison that only ever needs "recent or not".
 */
export const OIDC_MAX_AGE_CEILING_SEC = 315_360_000;

/**
 * Client identifiers no relying party may ever hold. Each value is
 * (or is reserved to become) a first-party JWT audience or an ARC S2S
 * audience; a client registered under one of these names would mint OIDC
 * access tokens whose `aud` collides with an internal verifier's pin.
 * Enforced at lookup time — a row seeded with one of these ids reads as
 * absent — and the future client-registration route must reject them at
 * write time using {@link isReservedOidcClientId}.
 */
export const RESERVED_OIDC_CLIENT_IDS: ReadonlySet<string> = new Set([
  // Referenced, not re-spelt: a literal here could drift from the audience the
  // signer actually mints, and the deny-list would then guard a name nothing
  // uses while the real audience stayed claimable.
  ACCESS_TOKEN_AUDIENCE,
  RECOVERY_TOKEN_AUDIENCE,
  "osn-step-up",
  "osn-api",
  "pulse-api",
  "zap-api",
  "cire-api",
]);

export function isReservedOidcClientId(clientId: string): boolean {
  return RESERVED_OIDC_CLIENT_IDS.has(clientId);
}

/**
 * Cap on live (non-disabled) OIDC clients one account may register. A relying
 * party is a durable credential surface; nobody legitimate needs dozens, and
 * the cap keeps a compromised access token from carpeting the registry.
 */
export const MAX_OIDC_CLIENTS_PER_ACCOUNT = 5;

/**
 * Cap on TOTAL client rows an account may accumulate, including disabled ones.
 * Disabling frees a live slot but the row (with its attacker-chosen name + logo
 * URL) persists, so without this a script could churn create/disable and store
 * unbounded attacker-controlled strings under one account. Set well above the
 * live cap so it only bites abuse, never a normal owner cycling a few apps.
 */
export const MAX_OIDC_CLIENT_ROWS_PER_ACCOUNT = 50;

/** Bounds on client registration inputs — see `validateClientRegistration`. */
export const OIDC_CLIENT_NAME_MAX_LENGTH = 64;
export const OIDC_CLIENT_MAX_REDIRECT_URIS = 8;
export const OIDC_CLIENT_URI_MAX_LENGTH = 512;

/**
 * Display names a self-serve client may not impersonate. The consent screen
 * shows a self-asserted name; without this a third party could register
 * "Musubi" (or a homograph) to phish a user into releasing their profile to a
 * look-alike of a first-party app. Compared against the caller's name after
 * confusable-skeleton folding (see `validateClientRegistration`), so "Musubi",
 * "MUSUBI", "M U S U B I", and "Musub1" all collide. First-party clients are
 * hand-seeded, never registered through this path, so they are unaffected.
 */
export const RESERVED_OIDC_CLIENT_NAMES: readonly string[] = [
  "osn",
  "musubi",
  "musubi social",
  "musubi id",
  "osn settings",
  "musubi settings",
  "pulse",
  "zap",
  "cire",
  "cireweddings",
];

// ---------------------------------------------------------------------------
// TOTP (RFC 6238)
// ---------------------------------------------------------------------------

/**
 * How long an unconfirmed enrolment secret stays in the ceremony store. Long
 * enough to scan a QR code and read the next code off the app; short enough
 * that an abandoned enrolment is not a secret sitting around.
 */
export const TOTP_ENROLL_TTL_MS = 10 * 60 * 1000;

/** Wrong codes at `/totp/enroll/complete` before the pending secret is burnt. */
export const TOTP_MAX_ENROLL_ATTEMPTS = 5;

/**
 * Per-account failed-code ceiling, and how long the lockout lasts. RFC 4226
 * §7.3 requires a throttling parameter for exactly this: a per-IP limit alone
 * does not stop a rotating fleet grinding a six-digit space.
 */
export const TOTP_LOCKOUT_THRESHOLD = 5;
export const TOTP_LOCKOUT_MS = 15 * 60 * 1000;
