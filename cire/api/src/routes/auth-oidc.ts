import type { RateLimiterBackend } from "@shared/rate-limit";
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
import { rateLimitMiddleware } from "../middleware/rate-limit";
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

/**
 * Terminal sign-in failure on a top-level browser navigation. Rather than
 * render raw JSON the user would see in the address bar, bounce to a page the
 * SPA controls — the organiser's `return_to` when we still trust one, else the
 * login page — with `?auth_error=<code>` for it to turn into a friendly
 * message. `loginFallbackUrl` is a server-configured, allowlisted origin, so
 * this is never an open redirect even when the transaction cookie (the usual
 * source of `returnTo`) is missing, expired, or forged.
 */
const errorRedirect = (
  returnTo: string | null,
  loginFallbackUrl: string,
  reason: string,
  secure: boolean,
): Response => {
  const clear = clearOidcTxCookie({ secure });
  const url = new URL(returnTo ?? loginFallbackUrl);
  url.searchParams.set("auth_error", reason);
  return redirect(url.toString(), [clear]);
};

export interface AuthOidcRouteOptions {
  /** Fully-built RP config; `null` ⇒ the tier has no OIDC credentials. */
  oidc: OidcConfig | null;
  /** Cookie `Secure` flag — set for every https tier. */
  secureCookies: boolean;
  /**
   * Absolute URL of the organiser login page (an allowlisted origin). Terminal
   * callback/start failures with no trusted `return_to` land here with an
   * `?auth_error` marker instead of rendering JSON to the browser.
   */
  loginFallbackUrl: string;
  /**
   * Tight per-IP limiter for the pre-auth redirect legs (`/oidc/start`,
   * `/oidc/callback`). Fail-closed on an unresolved IP (429), like every other
   * cire limited route.
   */
  startLimiter: RateLimiterBackend;
  /**
   * Looser per-IP limiter for the session probe + sign-out. `/session` is
   * polled on every organiser page load, so it needs a far more generous bucket
   * than the redirect legs.
   */
  sessionLimiter: RateLimiterBackend;
}

export const createAuthOidcRoutes = (
  db: Db,
  { oidc, secureCookies, loginFallbackUrl, startLimiter, sessionLimiter }: AuthOidcRouteOptions,
) => {
  // Two sibling instances under the same prefix, each carrying its own scoped
  // rate-limit middleware — the same isolation pattern the organiser read/write
  // route factories use so one surface's limiter never gates the other. The
  // redirect legs (pre-auth, issuer-facing) get the tight bucket; the
  // high-frequency `/session` probe + sign-out get the loose one.
  const redirectLegs = new Elysia({ prefix: PREFIX })
    .use(rateLimitMiddleware(startLimiter))
    // ---------------------------------------------------------------------
    // GET /api/auth/oidc/start?return_to=…&prompt=create — leg 1.
    //
    // A plain link the frontends point a "Sign in" button at. `return_to` is
    // where the browser lands afterwards; it must be an allowlisted origin.
    //
    // `prompt` is optional and allowlisted to `create` — the "Create account"
    // button asks the issuer to open on its sign-up screen. Every other value
    // is dropped rather than rejected: the query string is attacker-reachable,
    // and forwarding it blind would let anyone turn a sign-in link into
    // `prompt=none`, which asks for a silent grant with no screen at all.
    // ---------------------------------------------------------------------
    .get("/oidc/start", async ({ query }) => {
      if (!oidc) {
        // A top-level navigation from the "Sign in" button — send the browser
        // to the login page with a marker, not a raw 503 JSON body it would
        // render in the address bar.
        metricOidcLogin("bad_request");
        return errorRedirect(null, loginFallbackUrl, "sign_in_unavailable", secureCookies);
      }
      const returnTo = typeof query["return_to"] === "string" ? query["return_to"] : "";
      const started = await beginLogin(
        oidc,
        returnTo,
        query["prompt"] === "create" ? { prompt: "create" } : {},
      );
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
        return errorRedirect(null, loginFallbackUrl, "sign_in_unavailable", secureCookies);
      }
      const tx = parseOidcTxCookie(request.headers.get("cookie"));

      // The issuer refused (consent denied, `login_required`, …). Its own
      // `error` string is never echoed onward — it is unbounded text from
      // outside, and the frontend only needs to know the sign-in did not
      // happen.
      if (typeof query["error"] === "string") {
        metricOidcLogin("provider_error");
        return errorRedirect(
          await readReturnTo(oidc, tx),
          loginFallbackUrl,
          "sign_in_declined",
          secureCookies,
        );
      }

      const result = await completeLogin(oidc, {
        code: typeof query["code"] === "string" ? query["code"] : null,
        state: typeof query["state"] === "string" ? query["state"] : null,
        tx,
      });

      if (!result.ok) {
        metricOidcLogin(result.reason);
        return errorRedirect(result.returnTo, loginFallbackUrl, "sign_in_failed", secureCookies);
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
        return errorRedirect(result.returnTo, loginFallbackUrl, "sign_in_failed", secureCookies);
      }

      metricOidcLogin("callback_ok");
      return redirect(result.returnTo, [
        buildOrganiserSessionCookie(session.token, {
          secure: secureCookies,
          maxAgeSeconds: SESSION_TTL_SECONDS,
        }),
        clearOidcTxCookie({ secure: secureCookies }),
      ]);
    });

  const sessionRoutes = new Elysia({ prefix: PREFIX })
    .use(rateLimitMiddleware(sessionLimiter))
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

  return new Elysia().use(redirectLegs).use(sessionRoutes);
};
