import { Schema } from "effect";

/**
 * Wire schema for OAuth-style token responses. The `refresh_token` field is
 * declared optional for schema flexibility but is never populated by the
 * first-party `/login/*` or `/token` endpoints — the refresh token lives
 * only in the HttpOnly session cookie (Copenhagen Book C3). The parsed
 * `Session` intentionally drops it so application code never holds a
 * refresh token in JS.
 */
const TokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  token_type: Schema.String,
  scope: Schema.optional(Schema.String),
});

const decodeTokenResponse = Schema.decodeUnknownSync(TokenResponseSchema);

/**
 * The first-party session, post-parse. Intentionally lacks a refresh token:
 * the server-side session token is held by the browser as an HttpOnly cookie,
 * and silent refresh via `authFetch` works entirely off that cookie plus the
 * short-lived access token below.
 */
export interface Session {
  accessToken: string;
  idToken: string | null;
  /** Unix timestamp (ms) when the access token expires */
  expiresAt: number;
  scopes: string[];
}

/**
 * The result of a refresh that must not be adopted — a `Session` wrapped
 * rather than returned bare. `adoptSession` and `setSession` take a plain
 * `Session` by name; a `HeldSession` has no `accessToken`/`idToken`/
 * `expiresAt`/`scopes` at its own top level, so passing one where a `Session`
 * is expected is a compile error, not a runtime bug that publishes a
 * restricted token as an ordinary session. A caller unwraps `.session` once
 * it has decided holding, not adopting, is still the right call.
 */
export interface HeldSession {
  readonly held: true;
  readonly session: Session;
}

export function parseTokenResponse(raw: unknown): Session {
  const t = decodeTokenResponse(raw);
  return {
    accessToken: t.access_token,
    idToken: t.id_token ?? null,
    expiresAt: Date.now() + t.expires_in * 1000,
    scopes: t.scope ? t.scope.split(" ") : [],
  };
}

export interface PublicProfile {
  id: string;
  handle: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface ProfileToken {
  accessToken: string;
  /** Unix timestamp (ms) when the access token expires */
  expiresAt: number;
}

/**
 * The session a page holds, in memory only. Its tokens are credentials, and
 * page script can read anything in storage, so none of them is ever written
 * there: storage gets the {@link StoredAccount} cut of it. A reload gets its
 * token from the HttpOnly session cookie.
 */
export interface AccountSession {
  hasSession: boolean;
  activeProfileId: string;
  profileTokens: Record<string, ProfileToken>;
  scopes: string[];
  idToken: string | null;
}

/**
 * What a reload needs that is not a credential: whether this device holds a
 * session, and the profile the page was on, which the reload's grant names.
 * The only auth state the client writes to storage.
 */
export interface StoredAccount {
  hasSession: boolean;
  activeProfileId: string;
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

/**
 * Reads exactly the two fields; anything else in the stored value, the tokens
 * an older client wrote included, is dropped.
 */
const StoredAccountSchema = Schema.Struct({
  hasSession: Schema.Boolean,
  activeProfileId: Schema.String,
});

export const decodeStoredAccount = Schema.decodeUnknownSync(StoredAccountSchema);

const PublicProfileSchema = Schema.Struct({
  id: Schema.String,
  handle: Schema.String,
  email: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});

const ListProfilesResponseSchema = Schema.Struct({
  profiles: Schema.Array(PublicProfileSchema),
});

export const decodeListProfilesResponse = Schema.decodeUnknownSync(ListProfilesResponseSchema);

const SwitchProfileResponseSchema = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
  profile: PublicProfileSchema,
});

export const decodeSwitchProfileResponse = Schema.decodeUnknownSync(SwitchProfileResponseSchema);

const CreateProfileResponseSchema = Schema.Struct({
  profile: PublicProfileSchema,
});

export const decodeCreateProfileResponse = Schema.decodeUnknownSync(CreateProfileResponseSchema);

/** The claims this package reads from a JWT, unverified and untyped until checked. */
interface JwtClaims {
  readonly sub?: unknown;
  readonly iat?: unknown;
  readonly exp?: unknown;
}

/** Decode a JWT's payload without cryptographic verification; null when it will not decode. */
function decodeJwtPayload(jwt: string): JwtClaims | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    // JWT payloads use Base64URL encoding (RFC 7515) — convert to standard Base64
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded: unknown = JSON.parse(atob(base64));
    return typeof decoded === "object" && decoded !== null ? (decoded as JwtClaims) : null;
  } catch {
    return null;
  }
}

/** Extract the `sub` claim from a JWT payload without cryptographic verification. */
export function extractJwtSub(jwt: string): string | null {
  const sub = decodeJwtPayload(jwt)?.sub;
  return typeof sub === "string" ? sub : null;
}

/**
 * The lifetime the issuer gave a JWT, `exp - iat`, in milliseconds. Null when
 * either claim is missing or the two do not describe a positive span. Read
 * without verification: the value only tunes when the client renews.
 */
export function extractJwtLifetimeMs(jwt: string): number | null {
  const payload = decodeJwtPayload(jwt);
  const iat = payload?.iat;
  const exp = payload?.exp;
  if (typeof iat !== "number" || typeof exp !== "number" || exp <= iat) return null;
  return (exp - iat) * 1000;
}
