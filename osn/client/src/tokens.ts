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
 * Persisted per-device session state. After Copenhagen Book C3 the refresh
 * token is cookie-only, so the client keeps nothing sensitive on disk — just
 * the access-token cache (short TTL) and a `hasSession` flag so we know
 * whether to attempt silent refresh. Setting `hasSession = false` is how the
 * client signals "cookie was cleared server-side or expired".
 */
export interface AccountSession {
  hasSession: boolean;
  activeProfileId: string;
  profileTokens: Record<string, ProfileToken>;
  scopes: string[];
  idToken: string | null;
}

// ---------------------------------------------------------------------------
// Schema validation (S-H2, S-M4)
// ---------------------------------------------------------------------------

const SessionSchema = Schema.Struct({
  accessToken: Schema.String,
  idToken: Schema.NullOr(Schema.String),
  expiresAt: Schema.Number,
  scopes: Schema.Array(Schema.String),
});

export const decodeSession = Schema.decodeUnknownSync(SessionSchema);

const ProfileTokenSchema = Schema.Struct({
  accessToken: Schema.String,
  expiresAt: Schema.Number,
});

const AccountSessionSchema = Schema.Struct({
  hasSession: Schema.Boolean,
  activeProfileId: Schema.String,
  profileTokens: Schema.Record({ key: Schema.String, value: ProfileTokenSchema }),
  scopes: Schema.Array(Schema.String),
  idToken: Schema.NullOr(Schema.String),
});

export const decodeAccountSession = Schema.decodeUnknownSync(AccountSessionSchema);

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

/** Extract the `sub` claim from a JWT payload without cryptographic verification. */
export function extractJwtSub(jwt: string): string | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    // S-M1: JWT payloads use Base64URL encoding (RFC 7515) — convert to standard Base64
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(base64)) as { sub?: string };
    return decoded.sub ?? null;
  } catch {
    return null;
  }
}
