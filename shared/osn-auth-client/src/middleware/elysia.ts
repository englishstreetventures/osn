import { Elysia } from "elysia";
import { decodeJwt } from "jose";

import { extractClaims } from "../verify";

export interface OsnAuthOptions {
  jwksUrl: string;
  audience: string;
  _testKey?: CryptoKey;
}

export function osnAuth(options: OsnAuthOptions) {
  return new Elysia({ name: "osn-auth-client" })
    .derive({ as: "scoped" }, async ({ headers }) => {
      const claims = await extractClaims(headers.authorization, options.jwksUrl, options._testKey);
      if (!claims) return { osnProfileId: undefined as string | undefined };
      const token = headers.authorization?.slice("Bearer ".length);
      if (!token) return { osnProfileId: undefined as string | undefined };
      try {
        const payload = decodeJwt(token);
        const aud = payload.aud;
        const matches =
          typeof aud === "string"
            ? aud === options.audience
            : Array.isArray(aud) && aud.includes(options.audience);
        if (!matches) return { osnProfileId: undefined as string | undefined };
      } catch {
        return { osnProfileId: undefined as string | undefined };
      }
      return { osnProfileId: claims.profileId as string | undefined };
    })
    .onBeforeHandle({ as: "scoped" }, ({ osnProfileId, set }) => {
      if (!osnProfileId) {
        set.status = 401;
        return { error: "unauthorised" };
      }
    });
}
