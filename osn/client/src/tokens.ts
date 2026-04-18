import { Schema } from "effect";

const TokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  id_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  token_type: Schema.String,
  scope: Schema.optional(Schema.String),
});

const decodeTokenResponse = Schema.decodeUnknownSync(TokenResponseSchema);

/**
 * Client-side session. The refresh token lives in the HttpOnly cookie
 * (Copenhagen Book C3) — it is never materialised in JS memory or storage.
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
 * Multi-profile account session. The refresh token is kept in the
 * HttpOnly cookie only — dropping it from client-side storage closes the
 * XSS exfiltration surface for the longest-lived credential (S-M2).
 *
 * The active profile id is server-authoritative: resolved via GET /me
 * after every token issuance / rotation.
 */
export interface AccountSession {
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

const MeResponseSchema = Schema.Struct({
  profile: PublicProfileSchema,
  activeProfileId: Schema.String,
  scopes: Schema.Array(Schema.String),
});

export const decodeMeResponse = Schema.decodeUnknownSync(MeResponseSchema);
