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

/**
 * The OSN profile behind a request, or undefined. Two ways in, tried in order:
 *
 * 1. **The `cire_org_session` cookie** — a cire session minted by the OIDC
 *    callback, which is how every browser reaches us. Identity lives on the
 *    `musubi.social` zone, so `host.cireweddings.com` can neither run a passkey
 *    ceremony nor silently refresh an OSN access token. The session row carries
 *    the real `usr_*` profile id from the ID token's first-party
 *    `osn_profile_id` claim, so everything downstream keys on it unchanged.
 * 2. **`Authorization: Bearer` with an OSN access token** — for callers that are
 *    not this browser (a first-party OSN surface holding `aud: "osn-access"`,
 *    and the route tests, which inject the verifying key). The shared client
 *    verifies it, enforcing the audience inside the single `jwtVerify` pass.
 *
 * `osnAuth()` derives from this; the realtime subscribe route, which runs
 * before the Elysia app, calls it directly.
 */
export async function resolveOsnProfileId(
  request: Request,
  options: OsnAuthOptions,
): Promise<string | undefined> {
  const { db, ...verify } = options;
  if (db) {
    const token = parseOrganiserSessionToken(request.headers.get("cookie"));
    if (token) {
      const session = await runCire(
        organiserSessionService.validate(token).pipe(
          Effect.provideService(DbService, db),
          Effect.catchTag("OrganiserSessionInvalid", () => Effect.succeed(null)),
        ),
      );
      if (session) return session.osnProfileId;
    }
  }
  const claims = await extractClaims(
    request.headers.get("authorization") ?? undefined,
    verify.jwksUrl,
    {
      testKey: verify._testKey,
      audience: verify.audience,
      issuer: verify.issuer,
    },
  );
  return claims?.profileId;
}

/**
 * Names the organiser behind a request (see {@link resolveOsnProfileId}) as
 * `osnProfileId`, or answers 401.
 *
 * Note the response code: `@osn/client`'s `authFetch` reads a 401 as "token
 * expired" and throws the session away, so an authenticated but *forbidden*
 * caller must get 403 from the role gates downstream, never 401.
 *
 * **CSRF.** The cookie makes organiser writes CSRF-eligible.
 * `originGuard(corsOrigins)` in `app.ts` covers every state-changing method and
 * the cookie is `SameSite=Lax`; that pair is the whole defence and both have
 * to stay.
 */
export function osnAuth(options: OsnAuthOptions) {
  return (
    new Elysia({ name: "cire-osn-auth" })
      // Elysia 1.4 named plugins default hooks to "local" scope — without
      // { as: "scoped" } the derive/onBeforeHandle never run in the parent app
      // and every request silently passes unauthenticated.
      .derive({ as: "scoped" }, async ({ request }) => ({
        osnProfileId: await resolveOsnProfileId(request, options),
      }))
      .onBeforeHandle({ as: "scoped" }, ({ osnProfileId, set }) => {
        if (!osnProfileId) {
          set.status = 401;
          return { error: "unauthorised" };
        }
      })
  );
}
