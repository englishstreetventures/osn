import { Schema } from "effect";

const TokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  token_type: Schema.String,
  scope: Schema.optional(Schema.String),
});

const decodeTokenResponse = Schema.decodeUnknownSync(TokenResponseSchema);

export interface Session {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  /** Unix timestamp (ms) when the access token expires */
  expiresAt: number;
  scopes: string[];
}

export function parseTokenResponse(raw: unknown): Session {
  const t = decodeTokenResponse(raw);
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
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

export interface AccountSession {
  refreshToken: string;
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
  refreshToken: Schema.NullOr(Schema.String),
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
  refreshToken: Schema.String,
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
