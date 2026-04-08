import { object, string, number, optional, parse } from "valibot";

const tokenResponseSchema = object({
  access_token: string(),
  refresh_token: optional(string()),
  id_token: optional(string()),
  expires_in: number(),
  token_type: string(),
  scope: optional(string()),
});

export interface Session {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  /** Unix timestamp (ms) when the access token expires */
  expiresAt: number;
  scopes: string[];
}

export function parseTokenResponse(raw: unknown): Session {
  const t = parse(tokenResponseSchema, raw);
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    idToken: t.id_token ?? null,
    expiresAt: Date.now() + t.expires_in * 1000,
    scopes: t.scope ? t.scope.split(" ") : [],
  };
}
