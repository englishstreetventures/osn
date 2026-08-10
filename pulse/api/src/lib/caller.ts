import type { Db } from "@pulse/db/service";
import { extractClaims, type Claims } from "@shared/osn-auth-client/verify";
import { Effect, type ManagedRuntime } from "effect";

import { metricCallerAuth } from "../metrics";
import { webSessionService } from "../services/webSession";
import { parseWebSessionToken } from "./cookie";

/**
 * Resolve the caller of a Pulse request from either credential.
 *
 * Pulse has two kinds of client and they authenticate differently. The iOS app
 * holds an OSN refresh token and presents a five-minute bearer access JWT. The
 * web app cannot: a passkey ceremony is bound to `musubi.social`, so the
 * browser signs in through the OIDC redirect flow and carries the
 * `pulse_web_session` cookie instead. Every authenticated route accepts both,
 * and nothing downstream needs to know which arrived — both resolve to the same
 * `Claims`, so the existing call sites change by one line.
 *
 * Order matters. A bearer token is checked first and, if present, decides the
 * request outright: an `Authorization` header is an explicit claim about who
 * the caller is, and falling back to the cookie when it fails to verify would
 * silently answer as somebody else. Present-but-invalid is a rejection.
 *
 * The cookie path costs a hashed single-row lookup. It runs only when there is
 * no bearer token, so the native app never pays for it.
 */
export type CallerHeaders = Record<string, string | undefined>;

export type ResolveCaller = (headers: CallerHeaders) => Promise<Claims | null>;

export interface CallerResolverOptions {
  /** The route factory's own runtime — the cookie lookup needs `Db`. */
  runtime: ManagedRuntime.ManagedRuntime<Db, never>;
  /** JWKS endpoint of the OSN issuer that signs access tokens. */
  jwksUrl: string;
  /** Injected verifying key for tests (skips the JWKS fetch). */
  testKey?: CryptoKey | undefined;
}

export function makeCallerResolver({
  runtime,
  jwksUrl,
  testKey,
}: CallerResolverOptions): ResolveCaller {
  return async (headers) => {
    const authorization = headers["authorization"];
    if (authorization) {
      const claims = await extractClaims(authorization, jwksUrl, {
        testKey: testKey as CryptoKey,
        audience: "osn-access",
      });
      metricCallerAuth("bearer", claims ? "ok" : "rejected");
      return claims;
    }

    const token = parseWebSessionToken(headers["cookie"] ?? null);
    if (!token) return null;

    const session = await runtime.runPromise(
      webSessionService
        .validate(token)
        .pipe(Effect.catchTag("WebSessionInvalid", () => Effect.succeed(null))),
    );
    metricCallerAuth("cookie", session ? "ok" : "rejected");
    if (!session) return null;

    // `osn_profile_id`, not the pairwise `sub` — the graph is keyed on the
    // profile, and the two are deliberately different values.
    return {
      profileId: session.osnProfileId,
      email: session.email,
      handle: session.handle,
      displayName: session.displayName,
    };
  };
}
