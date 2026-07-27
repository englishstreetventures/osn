import { extractClaims } from "@shared/osn-auth-client";
import type { OsnAuthOptions as SharedOsnAuthOptions } from "@shared/osn-auth-client/middleware/elysia";
import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { parseOrganiserSessionToken } from "../lib/cookie";
import { runCire } from "../observability";
import { organiserSessionService } from "../services/organiser-session";

export interface OsnAuthOptions extends SharedOsnAuthOptions {
  /**
   * Enables the organiser session cookie. Omitted ⇒ bearer only (the shape a
   * few narrow unit tests still build).
   */
  db?: Db;
}

/** Derive result for requests that fail verification — the handler never runs. */
const unauthenticated = { osnProfileId: undefined as string | undefined };

/**
 * Names the OSN profile behind an organiser request. Two ways in, tried in
 * order:
 *
 * 1. **The `cire_org_session` cookie** — a cire session minted by the OIDC
 *    callback. This is how every browser reaches us now. Identity moved to the
 *    `musubi.social` zone, so `host.cireweddings.com` can neither run a passkey
 *    ceremony nor silent-refresh an OSN access token from OSN's HttpOnly cookie
 *    (that cookie is cross-site to us). The session row carries the real `usr_*`
 *    profile id taken from the ID token's first-party `osn_profile_id` claim, so
 *    everything downstream — `weddings.owner_osn_profile_id`, `wedding_hosts`,
 *    all three ARC bridges — keys on exactly what it always did.
 *
 * 2. **`Authorization: Bearer` with an OSN access token** — for callers that
 *    are not this browser: a first-party OSN surface holding a live
 *    `aud: "osn-access"` token, and the route tests, which inject the verifying
 *    key directly. Verified by the shared client, audience enforced inside the
 *    single `jwtVerify` pass.
 *
 * Neither ⇒ 401. Note the response code: `@osn/client`'s `authFetch` reads a
 * 401 as "token expired" and throws the session away, so an authenticated but
 * *forbidden* caller must get 403 from the role gates downstream, never 401.
 *
 * **CSRF.** Path 1 is a cookie, which makes organiser writes CSRF-eligible for
 * the first time. `originGuard(corsOrigins)` in `app.ts` covers every
 * state-changing method and the cookie is `SameSite=Lax`; that pair is the
 * whole defence and both have to stay.
 */
export function osnAuth(options: OsnAuthOptions) {
  const { db, ...verify } = options;
  return (
    new Elysia({ name: "cire-osn-auth" })
      // Elysia 1.4 named plugins default hooks to "local" scope — without
      // { as: "scoped" } the derive/onBeforeHandle never run in the parent app
      // and every request silently passes unauthenticated.
      .derive({ as: "scoped" }, async ({ headers, request }) => {
        if (db) {
          const token = parseOrganiserSessionToken(request.headers.get("cookie"));
          if (token) {
            const session = await runCire(
              organiserSessionService.validate(token).pipe(
                Effect.provideService(DbService, db),
                Effect.catchTag("OrganiserSessionInvalid", () => Effect.succeed(null)),
              ),
            );
            if (session) return { osnProfileId: session.osnProfileId as string | undefined };
          }
        }

        const claims = await extractClaims(headers.authorization, verify.jwksUrl, {
          testKey: verify._testKey,
          audience: verify.audience,
          issuer: verify.issuer,
        });
        if (!claims) return unauthenticated;
        return { osnProfileId: claims.profileId as string | undefined };
      })
      .onBeforeHandle({ as: "scoped" }, ({ osnProfileId, set }) => {
        if (!osnProfileId) {
          set.status = 401;
          return { error: "unauthorised" };
        }
      })
  );
}
