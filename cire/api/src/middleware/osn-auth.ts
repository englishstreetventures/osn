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
 * The OSN profile behind a request, or undefined. The `cire_org_session`
 * cookie is tried first, then an `Authorization: Bearer` OSN access token —
 * see {@link osnAuth} for why each exists. Both plugins below call this, so the
 * two cannot accept different credentials.
 */
async function osnProfileIdOf(
  options: OsnAuthOptions,
  request: Request,
  authorization: string | undefined,
): Promise<string | undefined> {
  const { db } = options;
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

  const claims = await extractClaims(authorization, options.jwksUrl, {
    testKey: options._testKey,
    audience: options.audience,
    issuer: options.issuer,
  });
  return claims?.profileId;
}

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
 *    everything downstream — `wedding_hosts`, all three ARC bridges — keys on
 *    exactly what it always did.
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
 *
 * The lookup is a `derive`, so it runs in the transform phase, ahead of every
 * before-handle hook — the role gates (`weddingMember()` and the rest) are
 * derives that read `osnProfileId` there. A per-IP limiter on such a route
 * answers only after the lookup. A route with no derive behind the check uses
 * {@link osnAuthResolve} instead.
 */
export function osnAuth(options: OsnAuthOptions) {
  return (
    new Elysia({ name: "cire-osn-auth" })
      // Elysia 1.4 hooks default to "local" scope — without { as: "scoped" }
      // the derive/onBeforeHandle never run in the parent app and every
      // request silently passes unauthenticated.
      .derive({ as: "scoped" }, async ({ headers, request }) => ({
        osnProfileId: await osnProfileIdOf(options, request, headers.authorization),
      }))
      .onBeforeHandle({ as: "scoped" }, ({ osnProfileId, set }) => {
        if (!osnProfileId) {
          set.status = 401;
          return { error: "unauthorised" };
        }
      })
  );
}

/**
 * {@link osnAuth} as an Elysia `resolve`: the same credentials, the same 401,
 * but the lookup runs in the before-handle phase, in `.use` order. A route that
 * mounts a per-IP `rateLimitMiddleware` first therefore answers a refused
 * request with 429 before the organiser session query or the token verify runs
 * — the same order `sessionAuth()` keeps on the guest routes.
 *
 * Only for a route where nothing in the transform phase needs `osnProfileId`:
 * every derive runs before any resolve, so a role gate mounted behind this
 * would see no profile and refuse. Unnamed, unlike `osnAuth`: Elysia
 * deduplicates a named plugin, and this one carries no state worth sharing.
 */
export function osnAuthResolve(options: OsnAuthOptions) {
  return (
    new Elysia()
      // Scoped so the resolve/onBeforeHandle lift into the route instance that
      // `.use`s this plugin (and no further).
      .resolve({ as: "scoped" }, async ({ headers, request }) => ({
        osnProfileId: await osnProfileIdOf(options, request, headers.authorization),
      }))
      .onBeforeHandle({ as: "scoped" }, ({ osnProfileId, set }) => {
        if (!osnProfileId) {
          set.status = 401;
          return { error: "unauthorised" };
        }
      })
  );
}
