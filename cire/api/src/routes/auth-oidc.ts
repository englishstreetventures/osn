import { Effect } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import {
  buildOidcTxCookie,
  buildOrganiserSessionCookie,
  clearOidcTxCookie,
  clearOrganiserSessionCookie,
  parseOidcTxCookie,
  parseOrganiserSessionToken,
} from "../lib/cookie";
import { metricOidcLogin } from "../metrics";
import { runCire } from "../observability";
import { beginLogin, completeLogin, readReturnTo } from "../services/oidc-login";
import type { OidcConfig } from "../services/oidc-login";
import { organiserSessionService } from "../services/organiser-session";

const PREFIX = "/api/auth";

/**
 * Organiser sign-in, the OIDC relying-party side.
 *
 * The browser never holds an OSN token here. It bounces to the issuer, comes
 * back with a code, and leaves with a cire session cookie — host-scoped to
 * `api.cireweddings.com`, opaque, SHA-256 hashed at rest, exactly like the
 * guest session. See `services/oidc-login.ts` for why the redirect URI is a
 * constant and why a token without `osn_profile_id` is refused.
 *
 * **CSRF.** Moving organiser auth from a bearer header to a cookie makes
 * organiser writes CSRF-eligible for the first time. Two things cover that, and
 * both must stay: the app-wide `originGuard(corsOrigins)` on every
 * state-changing method, and `SameSite=Lax` on the cookie itself — the same
 * pair the guest session has always relied on. `Lax` (not `Strict`) is forced
 * by the callback, which arrives as a top-level cross-site GET navigation.
 *
 * Both OIDC legs are GETs, so the origin guard does not apply to them; the
 * `state` match is what protects the callback.
 */

/** Seven days — must match `organiserSessionService`'s default TTL. */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const redirect = (location: string, cookies: string[]): Response => {
  const headers = new Headers({ location, "cache-control": "no-store" });
  // One `Set-Cookie` per cookie: `Headers.append` is the only way to emit the
  // repeated header, and a joined string would be one malformed cookie.
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
};

const errorRedirect = (returnTo: string | null, reason: string, secure: boolean): Response => {
  const clear = clearOidcTxCookie({ secure });
  if (!returnTo) {
    const headers = new Headers({
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    headers.append("set-cookie", clear);
    return new Response(JSON.stringify({ error: reason }), { status: 400, headers });
  }
  const url = new URL(returnTo);
  url.searchParams.set("auth_error", reason);
  return redirect(url.toString(), [clear]);
};

export interface AuthOidcRouteOptions {
  /** Fully-built RP config; `null` ⇒ the tier has no OIDC credentials. */
  oidc: OidcConfig | null;
  /** Cookie `Secure` flag — set for every https tier. */
  secureCookies: boolean;
}

export const createAuthOidcRoutes = (db: Db, { oidc, secureCookies }: AuthOidcRouteOptions) =>
  new Elysia({ prefix: PREFIX })
    // ---------------------------------------------------------------------
    // GET /api/auth/oidc/start?return_to=… — leg 1.
    //
    // A plain link the frontends point a "Sign in" button at. `return_to` is
    // where the browser lands afterwards; it must be an allowlisted origin.
    // ---------------------------------------------------------------------
    .get("/oidc/start", async ({ query }) => {
      if (!oidc) {
        metricOidcLogin("bad_request");
        return new Response(JSON.stringify({ error: "sign_in_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      const returnTo = typeof query["return_to"] === "string" ? query["return_to"] : "";
      const started = await beginLogin(oidc, returnTo);
      if (!started) {
        metricOidcLogin("bad_request");
        return new Response(JSON.stringify({ error: "invalid_return_to" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      metricOidcLogin("start");
      return redirect(started.authorizeUrl, [
        buildOidcTxCookie(started.tx, {
          secure: secureCookies,
          maxAgeSeconds: started.txMaxAgeSeconds,
        }),
      ]);
    })
    // ---------------------------------------------------------------------
    // GET /api/auth/oidc/callback — leg 2.
    //
    // Arrives as a top-level navigation from the issuer. Every failure path
    // clears the transaction cookie: it is single-use by construction, and
    // leaving a spent PKCE verifier in the browser buys nothing.
    // ---------------------------------------------------------------------
    .get("/oidc/callback", async ({ query, request }) => {
      if (!oidc) {
        metricOidcLogin("bad_request");
        return new Response(JSON.stringify({ error: "sign_in_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      const tx = parseOidcTxCookie(request.headers.get("cookie"));

      // The issuer refused (consent denied, `login_required`, …). Its own
      // `error` string is never echoed onward — it is unbounded text from
      // outside, and the frontend only needs to know the sign-in did not
      // happen.
      if (typeof query["error"] === "string") {
        metricOidcLogin("provider_error");
        return errorRedirect(readReturnTo(oidc, tx), "sign_in_declined", secureCookies);
      }

      const result = await completeLogin(oidc, {
        code: typeof query["code"] === "string" ? query["code"] : null,
        state: typeof query["state"] === "string" ? query["state"] : null,
        tx,
      });

      if (!result.ok) {
        metricOidcLogin(result.reason);
        return errorRedirect(result.returnTo, "sign_in_failed", secureCookies);
      }

      const session = await runCire(
        organiserSessionService.create(result.identity, SESSION_TTL_SECONDS).pipe(
          Effect.provideService(DbService, db),
          Effect.catchTag("OrganiserSessionWriteError", () => Effect.succeed(null)),
        ),
      );
      if (!session) {
        // D1 refused the insert. Nothing to sign the user in with, and a retry
        // is a single click, so send them back with the same generic marker.
        metricOidcLogin("exchange_failed");
        return errorRedirect(result.returnTo, "sign_in_failed", secureCookies);
      }

      metricOidcLogin("callback_ok");
      return redirect(result.returnTo, [
        buildOrganiserSessionCookie(session.token, {
          secure: secureCookies,
          maxAgeSeconds: SESSION_TTL_SECONDS,
        }),
        clearOidcTxCookie({ secure: secureCookies }),
      ]);
    })
    // ---------------------------------------------------------------------
    // GET /api/auth/session — who is signed in.
    //
    // 200 with the profile snapshot, or 200 with `{ signedIn: false }`. NOT a
    // 401: this is the probe every organiser page runs on load to decide
    // whether to show the sign-in button, and a signed-out visitor is the
    // expected case, not an error.
    // ---------------------------------------------------------------------
    .get("/session", async ({ request }) => {
      const token = parseOrganiserSessionToken(request.headers.get("cookie"));
      if (!token) return { signedIn: false as const };
      const session = await runCire(
        organiserSessionService.validate(token).pipe(
          Effect.provideService(DbService, db),
          Effect.catchTag("OrganiserSessionInvalid", () => Effect.succeed(null)),
        ),
      );
      if (!session) return { signedIn: false as const };
      return {
        signedIn: true as const,
        osnProfileId: session.osnProfileId,
        email: session.email,
        handle: session.handle,
        displayName: session.displayName,
        avatarUrl: session.avatarUrl,
        expiresAt: session.expiresAt.toISOString(),
      };
    })
    // ---------------------------------------------------------------------
    // POST /api/auth/signout — drop the session row and the cookie.
    //
    // `?all=1` drops every session for the profile (all browsers). Always 200,
    // even with no cookie: signing out is idempotent, and telling a caller
    // whether a token was live is a free oracle.
    // ---------------------------------------------------------------------
    .post("/signout", async ({ request, query, set }) => {
      const token = parseOrganiserSessionToken(request.headers.get("cookie"));
      if (token) {
        await runCire(
          Effect.gen(function* () {
            if (query["all"] === "1") {
              const session = yield* organiserSessionService
                .validate(token)
                .pipe(Effect.catchTag("OrganiserSessionInvalid", () => Effect.succeed(null)));
              if (session) {
                yield* organiserSessionService.revokeAllForProfile(session.osnProfileId);
                return;
              }
            }
            yield* organiserSessionService.revoke(token);
          }).pipe(
            Effect.provideService(DbService, db),
            Effect.catchTag("OrganiserSessionWriteError", () => Effect.void),
          ),
        );
      }
      set.headers["set-cookie"] = clearOrganiserSessionCookie({ secure: secureCookies });
      return { ok: true };
    });
