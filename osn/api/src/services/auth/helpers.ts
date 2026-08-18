/**
 * Pure helpers shared across the auth modules: id / token / OTP generation,
 * JWT sign + verify primitives, boundary schemas, identifier normalisation.
 * Nothing in here touches the DB or holds state.
 */

import { createHash } from "node:crypto";

import { Effect, Schema } from "effect";
import { SignJWT, jwtVerify } from "jose";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function genId(prefix: string): string {
  return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * O5: a per-request random sentinel `accountId` for the enumeration-probe
 * burn-in SELECTs. A fixed literal (`acc_enum_probe`, `__nonexistent__`) is a
 * stable, attacker-knowable key: an adversary who pre-seeds a row with that id
 * (or just observes the constant in a leaked query log) could turn the
 * latency-equalising probe back into an oracle. A fresh 128-bit random id per
 * request is, with overwhelming probability, absent from `accounts` — so the
 * probe SELECT still returns zero rows and pays the same indexed-lookup cost,
 * but the key carries no information and cannot be made to match.
 */
export function probeAccountId(): string {
  return genId("acc_probe_");
}

export function now(): Date {
  return new Date();
}

// ---------------------------------------------------------------------------
// JWT claim sets
//
// Every token this service mints goes through `signJwt`, so the claim sets are
// named here rather than at each mint site: the union below is the complete
// list of token kinds the OSN signing key ever produces. `iss`, `iat` and
// `exp` are stamped by `signJwt` itself and so appear on none of them.
// ---------------------------------------------------------------------------

/**
 * A user access token (`aud: "osn-access"`). P6 invariant: `accountId` is
 * deliberately NOT a claim — see `issueAccessToken` in `tokens.ts` for why.
 * `displayName` is absent when the profile has none; `osn_sid` (S-L3) is
 * absent when the token is minted outside a session.
 */
export type AccessTokenClaims = {
  sub: string;
  aud: string;
  email: string;
  handle: string;
  scope: string;
  displayName?: string;
  osn_sid?: string;
};

/**
 * A step-up (sudo) token (`aud: "osn-step-up"`). `sub` is the ACCOUNT id here,
 * not a profile id — step-up authorises account-level operations. `jti` backs
 * the single-use guard; `purpose` is absent on tokens minted for the verifiers
 * that don't require one.
 */
export type StepUpTokenClaims = {
  sub: string;
  aud: string;
  amr: string[];
  jti: string;
  purpose?: string;
};

/**
 * An OIDC ID token. `sub` is the pairwise subject, `aud` the relying party's
 * client id. Everything past `auth_time` depends on what the authorization
 * carried: `nonce` on request, `osn_profile_id` for first-party clients only,
 * the profile claims under the `profile` scope, the email pair under `email`.
 */
export type IdTokenClaims = {
  sub: string;
  aud: string;
  auth_time: number;
  nonce?: string;
  osn_profile_id?: string;
  preferred_username?: string;
  name?: string;
  picture?: string;
  email?: string;
  email_verified?: boolean;
};

/**
 * The OIDC access token issued alongside an ID token (RFC 9068, `typ:
 * "at+jwt"`). It names the granted scope and nothing else — it is not an
 * `osn-access` token and never authenticates a first-party route.
 */
export type OidcAccessTokenClaims = {
  sub: string;
  aud: string;
  scope: string;
};

/** Every claim set {@link signJwt} accepts. */
export type SignedJwtClaims =
  | AccessTokenClaims
  | StepUpTokenClaims
  | IdTokenClaims
  | OidcAccessTokenClaims;

/**
 * What a token carries once its signature, issuer and expiry check out.
 *
 * Signature-verified is not shape-verified: one key signs all four claim sets
 * above, plus whatever older deploys minted, so each value stays `unknown` and
 * every caller narrows the claims it needs — starting with `aud`, which is
 * what separates the token kinds (S-M2).
 */
export type VerifiedJwtClaims = {
  readonly iss?: unknown;
  readonly sub?: unknown;
  readonly aud?: unknown;
  readonly iat?: unknown;
  readonly exp?: unknown;
  readonly jti?: unknown;
  readonly amr?: unknown;
  readonly purpose?: unknown;
  readonly email?: unknown;
  readonly handle?: unknown;
  readonly scope?: unknown;
  readonly displayName?: unknown;
  readonly osn_sid?: unknown;
};

export async function signJwt(
  payload: SignedJwtClaims,
  privateKey: CryptoKey,
  kid: string,
  ttl: number,
  issuer: string,
  /**
   * Optional `typ` header (RFC 9068 §2.1 uses "at+jwt" for access tokens).
   * A typed header lets a verifier reject a token presented outside its class
   * even when `aud` alone would be ambiguous. Omitted for legacy token kinds
   * so their verifiers see byte-identical headers.
   */
  typ?: string,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader(typ ? { alg: "ES256", kid, typ } : { alg: "ES256", kid })
    .setIssuedAt()
    .setIssuer(issuer)
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttl)
    .sign(privateKey);
}

/**
 * O1: `issuer` is pinned to `AuthConfig.issuerUrl` so a token minted by a
 * different OSN deployment (or any other ES256 issuer sharing nothing but the
 * curve) is rejected. A 30s `clockTolerance` absorbs benign clock skew between
 * the signer and verifier without materially widening the effective TTL.
 *
 * Cross-service rollout note (the downstream verifier half is W7): the tolerant
 * verifier MUST deploy before the signer begins enforcing/emitting `iss`. A
 * verifier that already pins `issuer` would otherwise reject every legacy
 * (iss-less) token the instant the signer rolls out — so the deploy ordering is
 * strictly verifier-first.
 */
export async function verifyJwt(
  token: string,
  publicKey: CryptoKey,
  issuer: string,
): Promise<VerifiedJwtClaims> {
  const { payload } = await jwtVerify(token, publicKey, {
    algorithms: ["ES256"],
    issuer,
    clockTolerance: 30,
  });
  return payload;
}

/**
 * Generates a uniformly distributed 6-digit OTP via rejection sampling.
 * `crypto.getRandomValues` returns a 32-bit value; naive `% 900_000` is biased
 * because 2^32 is not a multiple of 900_000. We discard draws that fall in the
 * tail and resample.
 */
export function genOtpCode(): string {
  const buf = new Uint32Array(1);
  // 2^32 = 4_294_967_296. Largest multiple of 900_000 not exceeding it.
  const ceil = Math.floor(0x1_0000_0000 / 900_000) * 900_000;
  do {
    crypto.getRandomValues(buf);
  } while (buf[0]! >= ceil);
  return (100_000 + (buf[0]! % 900_000)).toString();
}

/**
 * Local-dev convenience: surface a freshly minted OTP in the server log so an
 * operator can complete an email-OTP flow (registration, step-up, email change)
 * without a real inbox — `LogEmailLive` records the body in-memory but never
 * logs the code. Gated strictly on a local environment (`OSN_ENV` unset or
 * "local") so a code is NEVER logged in staging/production. Emitted at debug:
 * local dev defaults to the debug log level (so it shows), non-local defaults to
 * info (a second guard on top of the env check).
 */
// P-I1: resolved once and cached — `process.env` is a backed getter, not a
// plain property read, so re-reading it per OTP issuance is wasted work.
// S-L2: resolution is LAZY (first `logDevOtp` call, i.e. mid-request) rather
// than at module evaluation, so a runtime that populates `process.env` after
// module load can never freeze an unset `OSN_ENV` into "local" — and with it
// OTP logging — for the process lifetime. "Unset ⇒ local" itself matches the
// codebase-wide convention (`isNonLocal` in index.ts).
let isLocalEnvCached: boolean | undefined;

// The Workers runtime hands `OSN_ENV` to the fetch/scheduled handler as a
// BINDING, and that binding is authoritative — it is populated before any
// request runs, whatever `process.env` does. `process.env` on workerd is a
// compatibility shim: it only fills from `[vars]` when
// `nodejs_compat_populate_process_env` is on, and only on first access. Drop
// that flag, bump the compat date past a rename, deploy a Worker that never
// touches `process` first — and `OSN_ENV` reads empty, "unset ⇒ local" holds,
// and live OTP codes go to the log sink. So the deployed path stamps the real
// tier here from the binding and `process.env` is only the fallback for the Bun
// entry (`local.ts`), where it is native and always populated.
// An absent binding normalises to "unknown", NOT to undefined: undefined would
// fall back to `process.env` and land back on "unset ⇒ local". Once the Workers
// entry has stamped, the answer comes from the binding or not at all.
let runtimeTier: string | undefined;
export const setRuntimeTier = (tier: string | undefined): void => {
  runtimeTier = tier ?? "unknown";
  isLocalEnvCached = undefined;
};

const isLocalEnv = (): boolean => {
  if (runtimeTier !== undefined) return runtimeTier === "local";
  return (isLocalEnvCached ??= !process.env.OSN_ENV || process.env.OSN_ENV === "local");
};

// S-L4: the recipient address used to be interpolated into this line. A
// free-text message is not annotation-shaped, so the key-based redaction
// deny-list in `@shared/observability` never sees it — the env gate was the
// only thing standing between an OTP recipient and the log sink. The address
// is dropped rather than annotated: an operator reading a local dev log
// already knows which address they just typed, so it bought nothing that a
// second line of defence had to be trusted to protect.
export function logDevOtp(purpose: string, code: string): Effect.Effect<void> {
  if (!isLocalEnv()) return Effect.void;
  return Effect.logDebug(`[dev-otp] ${purpose} code=${code}`);
}

// ---------------------------------------------------------------------------
// Session token helpers (Copenhagen Book C1)
// ---------------------------------------------------------------------------

/**
 * Generates an opaque session token: 20 random bytes (160-bit entropy),
 * hex-encoded with a `ses_` prefix for developer ergonomics.
 * The raw token is held by the client; the server stores only its SHA-256 hash.
 */
export function generateSessionToken(): string {
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
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Session binding for an access token (the `osn_sid` claim). Ties a minted
 * access token back to the session row it came from, so a Bearer-only
 * caller (no cookie — cross-origin fetch, a proxy that strips it, a native
 * client) can still be recognised as "this session" server-side.
 *
 * Two properties matter:
 *
 * 1. **One-way.** `sessionHash` is itself the SHA-256 of a 160-bit random
 *    token, so a leaked `osn_sid` yields nothing usable — it can't be turned
 *    back into a session id, let alone the token.
 * 2. **Per-profile.** The profile id is mixed in, so the same session seen
 *    through two profiles of one account produces two unrelated values.
 *    Without that, `osn_sid` would re-introduce exactly the cross-profile
 *    correlation the P6 invariant keeps `accountId` out of the token for.
 *
 * The server recognises a `osn_sid` by recomputing it over the account's
 * session rows (bounded by MAX_SESSIONS_PER_ACCOUNT) — no reverse lookup.
 * 128 bits is ample for matching within one account's session list.
 */
export function deriveSessionBinding(sessionHash: string, profileId: string): string {
  return createHash("sha256").update(`${sessionHash}:${profileId}`).digest("hex").slice(0, 32);
}

/**
 * Public revocation handle for a session — first 16 hex chars of the
 * SHA-256 hash. 64 bits of collision resistance within a single account's
 * session list is more than enough; exposing the full hash would let a
 * log-capturing attacker DELETE sessions by guessing the URL.
 */
export function sessionHandleFromHash(sessionHash: string): string {
  return sessionHash.slice(0, 16);
}

// Copenhagen Book M3: cap length at 255 (the practical RFC 5321 mailbox
// ceiling) BEFORE the regex runs — rejects absurd payloads outright and
// keeps the stored `accounts.email` column bounded.
export const EmailSchema = Schema.String.pipe(
  Schema.filter((s) => s.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s), {
    message: () => "Invalid email",
  }),
);

export const HandleSchema = Schema.String.pipe(
  Schema.filter((s) => /^[a-z0-9_]{1,30}$/.test(s), {
    message: () => "Handle must be 1–30 characters: lowercase letters, numbers, underscores only",
  }),
);

/**
 * Registration birthdate (C-H8). Accepts a strict `YYYY-MM-DD` calendar date
 * that round-trips (rejecting non-dates like `2021-02-30`) and is not in the
 * future. This is a FORMAT gate only — the under-13 age check is applied
 * separately in `beginRegistration` so a valid-but-too-young date returns the
 * COPPA-specific 422 rather than a generic 400. The value is never persisted.
 * See [[compliance/coppa]].
 */
export const BirthdateSchema = Schema.String.pipe(
  Schema.filter(
    (s) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
      const d = new Date(`${s}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime())) return false;
      // Reject dates that don't round-trip (e.g. 2021-02-30 → 2021-03-02).
      if (d.toISOString().slice(0, 10) !== s) return false;
      // A birthdate in the future is nonsensical.
      return d.getTime() <= Date.now();
    },
    { message: () => "Invalid birthdate" },
  ),
);

/**
 * Whole years elapsed from a `YYYY-MM-DD` birthdate to `at` (UTC), the way a
 * person counts their age: the birthday must have already passed this year.
 * Used only for the C-H8 registration gate; the input is expected to have
 * already passed `BirthdateSchema`.
 */
export function ageInYears(birthdate: string, at: Date = new Date()): number {
  const b = new Date(`${birthdate}T00:00:00.000Z`);
  let age = at.getUTCFullYear() - b.getUTCFullYear();
  const monthDelta = at.getUTCMonth() - b.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && at.getUTCDate() < b.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/**
 * User-chosen free-text nickname for a passkey. Trimmed client-side and here;
 * upper-bounded at 64 chars so a stored label fits inside any reasonable
 * settings-row display without having to `LIKE …%` truncate at read time.
 * Empty strings aren't valid — the caller should PATCH `null` to clear.
 */
export const PasskeyLabelSchema = Schema.String.pipe(
  Schema.filter((s) => s.trim().length > 0 && s.length <= 64, {
    message: () => "Passkey label must be 1–64 characters",
  }),
);

/**
 * Normalises an identifier by stripping a leading @ sigil.
 * Users may type "@alice" meaning handle "alice"; this strips it before dispatch.
 */
export function normaliseIdentifier(identifier: string): string {
  return identifier.startsWith("@") ? identifier.slice(1) : identifier;
}

/** Returns true if the (already-normalised) identifier looks like an email address. */
export function looksLikeEmail(identifier: string): boolean {
  return identifier.includes("@");
}
