import { DbLive, type Db } from "@pulse/db/service";
import { beginLogin, completeLogin, readReturnTo } from "@shared/osn-auth-client/oidc-rp";
import type { OidcConfig } from "@shared/osn-auth-client/oidc-rp";
import {
  createRateLimiter,
  getClientIp,
  isUnresolvedIp,
  type ClientIpOptions,
  type RateLimiterBackend,
} from "@shared/rate-limit";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Elysia } from "elysia";

import {
  buildOidcTxCookie,
  buildWebSessionCookie,
  clearOidcTxCookie,
  clearWebSessionCookie,
  parseOidcTxCookie,
  parseWebSessionToken,
} from "../lib/cookie";
import { metricOidcLogin } from "../metrics";
import { webSessionService } from "../services/webSession";

/**
 * Pulse web sign-in, the OIDC relying-party side.
 *
 * The browser never holds an OSN token. It bounces to the issuer, comes back
 * with a code, and leaves with a Pulse session cookie — host-scoped, opaque,
 * SHA-256 hashed at rest. The iOS app is untouched: it still holds an OSN
 * refresh token and presents a bearer access JWT, and every route here is
 * reachable only by a browser.
 *
 * **CSRF.** A cookie credential makes Pulse writes CSRF-eligible for the first
 * time. Two things cover that: `SameSite=Lax` on the cookie, and the app-wide
 * `originGuard`, which — unlike cire's — fires only when the session cookie is
 * present, because Pulse's write callers include a native app that sends no
 * `Origin` header. See `lib/origin-guard.ts`.
 *
 * Both OIDC legs are GETs, so the origin guard does not apply to them; the
 * `state` match is what protects the callback.
 */

const PREFIX = "/api/auth";

/**
 * Hand-written OpenAPI responses for the four routes below.
 *
 * swift-openapi-generator refuses a document in which any operation carries no
 * responses at all, and `@elysiajs/openapi` discards `detail.responses` the
 * moment a route declares `response:` — so a route is either validated at
 * runtime or documented by hand, never both. Every leg here returns a raw
 * `Response` (302s carrying `set-cookie`) or a shape a TypeBox `response:`
 * schema would describe worse than prose, so all four are documented by hand.
 *
 * `detail` is typed against OpenAPI 3.0, but the document the plugin emits is
 * 3.1 — where `type: ["string", "null"]` is legal, and is the only nullable
 * spelling swift-openapi-generator keeps (see `scripts/generate-openapi.ts`).
 * The cast in `docSchema` is what lets a 3.1 schema be written here.
 */
/**
 * The slice of OpenAPI 3.1 schema syntax the hand-written responses below use.
 * `type` takes an array for the nullable spelling (`["string", "null"]`).
 */
interface OpenApiSchemaNode {
  readonly type: string | readonly string[];
  readonly format?: string;
  readonly properties?: { readonly [property: string]: OpenApiSchemaNode };
  readonly required?: readonly string[];
}

const docSchema = (schema: OpenApiSchemaNode) => schema as never;

const jsonResponse = (description: string, schema: OpenApiSchemaNode) => ({
  description,
  content: { "application/json": { schema: docSchema(schema) } },
});

const jsonErrorResponse = (description: string) =>
  jsonResponse(description, {
    type: "object",
    properties: { error: { type: "string" } },
    required: ["error"],
  });

const rateLimitedResponse = jsonErrorResponse("Per-IP rate limit exceeded.");

/** Seven days — must match `webSessionService`'s default TTL. */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const ONE_MINUTE_MS = 60_000;

/**
 * Tight per-IP bucket for the redirect legs. Each `/oidc/start` mints a
 * transaction and each `/oidc/callback` costs an issuer token exchange plus a
 * session insert, so a low ceiling is both safe and generous: a human signs in
 * once, and a retry loop after a failure is a handful of clicks.
 */
export function createDefaultAuthStartRateLimiter(): RateLimiterBackend {
  return createRateLimiter({ maxRequests: 20, windowMs: ONE_MINUTE_MS });
}

/**
 * Looser per-IP bucket for `GET /session` + `POST /signout`. The session probe
 * runs on every page load of the web app, and a shared NAT egress puts many
 * legitimate users behind one key, so this needs far more headroom than the
 * redirect legs.
 */
export function createDefaultAuthSessionRateLimiter(): RateLimiterBackend {
  return createRateLimiter({ maxRequests: 120, windowMs: ONE_MINUTE_MS });
}

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
 * web app controls — their `return_to` when we still trust one, else the login
 * page — with `?auth_error=<code>` for it to turn into a friendly message.
 * `loginFallbackUrl` is a server-configured, allowlisted origin, so this is
 * never an open redirect even when the transaction cookie (the usual source of
 * `returnTo`) is missing, expired, or forged.
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

export interface AuthRouteOptions {
  /** Fully-built RP config; `null` ⇒ the tier has no OIDC credentials. */
  oidc: OidcConfig | null;
  /** Cookie `Secure` flag — set for every https tier. */
  secureCookies: boolean;
  /**
   * Absolute URL of the Pulse web login page (an allowlisted origin). Terminal
   * callback/start failures with no trusted `return_to` land here with an
   * `?auth_error` marker instead of rendering JSON to the browser.
   */
  loginFallbackUrl: string;
  /** Per-IP limiter for the redirect legs. Defaults to the in-memory backend. */
  startLimiter?: RateLimiterBackend;
  /** Per-IP limiter for the session probe + sign-out. */
  sessionLimiter?: RateLimiterBackend;
  /**
   * Client-IP trust policy (S-M34), same value the events routes get. Defaults
   * to `{}` — direct mode, socket peer only, never a spoofable
   * `x-forwarded-for`.
   */
  clientIpConfig?: Omit<ClientIpOptions, "socketIp">;
}

export const createAuthRoutes = (
  dbLayer: Layer.Layer<Db> = DbLive,
  {
    oidc,
    secureCookies,
    loginFallbackUrl,
    startLimiter = createDefaultAuthStartRateLimiter(),
    sessionLimiter = createDefaultAuthSessionRateLimiter(),
    clientIpConfig = {},
  }: AuthRouteOptions,
) => {
  // Layer graph built once per factory (convention: see osn/api/src/lib/route-runtime.ts) — not per request.
  const runtime = ManagedRuntime.make(dbLayer);

  /**
   * Resolve the trusted per-IP key under the configured policy (S-M34), the
   * same helper pair the unauthenticated events surfaces use — Pulse limits
   * per-IP inline in the route factory rather than through a middleware.
   */
  const resolveIp = (
    headers: Record<string, string | undefined>,
    server: { requestIP?: (req: Request) => { address?: string } | null } | null,
    request: Request,
  ): string =>
    getClientIp(headers, {
      ...clientIpConfig,
      socketIp: server?.requestIP?.(request)?.address ?? null,
    });

  /** Fail-closed: an unresolved IP or a backend error both deny. */
  const checkPerIpLimit = async (ip: string, limiter: RateLimiterBackend): Promise<boolean> => {
    if (isUnresolvedIp(ip)) return false;
    try {
      return await limiter.check(ip);
    } catch {
      return false;
    }
  };

  const redirectLegs = new Elysia({ prefix: PREFIX })
    // -----------------------------------------------------------------------
    // GET /api/auth/oidc/start?return_to=…&prompt=create — leg 1.
    //
    // A plain link the web app points its "Sign in" button at. `return_to` is
    // where the browser lands afterwards; it must be an allowlisted origin.
    //
    // `prompt` is optional and allowlisted to `create` — the "Create account"
    // button asks the issuer to open on its sign-up screen. Every other value
    // is dropped rather than rejected: the query string is attacker-reachable,
    // and forwarding it blind would let anyone turn a sign-in link into
    // `prompt=none`, which asks for a silent grant with no screen at all.
    // -----------------------------------------------------------------------
    .get(
      "/oidc/start",
      async ({ query, headers, server, request }) => {
        const ip = resolveIp(headers, server, request);
        if (!(await checkPerIpLimit(ip, startLimiter))) {
          return new Response(JSON.stringify({ error: "rate_limited" }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
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
      },
      {
        detail: {
          operationId: "startOidcSignIn",
          summary: "Begin OSN OIDC sign-in",
          responses: {
            302: {
              description:
                "Redirect to the OSN authorize endpoint, carrying the transaction cookie. On a misconfigured issuer, a redirect back to the app with an `?auth_error=` marker instead.",
            },
            400: jsonErrorResponse("`return_to` is missing or not an allowlisted origin."),
            429: rateLimitedResponse,
          },
        },
      },
    )
    // -----------------------------------------------------------------------
    // GET /api/auth/oidc/callback — leg 2.
    //
    // Arrives as a top-level navigation from the issuer. Every failure path
    // clears the transaction cookie: it is single-use by construction, and
    // leaving a spent PKCE verifier in the browser buys nothing.
    // -----------------------------------------------------------------------
    .get(
      "/oidc/callback",
      async ({ query, headers, server, request }) => {
        const ip = resolveIp(headers, server, request);
        if (!(await checkPerIpLimit(ip, startLimiter))) {
          return new Response(JSON.stringify({ error: "rate_limited" }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
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

        const session = await runtime.runPromise(
          webSessionService
            .create(result.identity, SESSION_TTL_SECONDS)
            .pipe(Effect.catchTag("WebSessionWriteError", () => Effect.succeed(null))),
        );
        if (!session) {
          // The database refused the insert. Nothing to sign the user in with,
          // and a retry is a single click, so send them back with the same
          // generic marker.
          metricOidcLogin("exchange_failed");
          return errorRedirect(result.returnTo, loginFallbackUrl, "sign_in_failed", secureCookies);
        }

        metricOidcLogin("callback_ok");
        return redirect(result.returnTo, [
          buildWebSessionCookie(session.token, {
            secure: secureCookies,
            maxAgeSeconds: SESSION_TTL_SECONDS,
          }),
          clearOidcTxCookie({ secure: secureCookies }),
        ]);
      },
      {
        detail: {
          operationId: "completeOidcSignIn",
          summary: "Complete OSN OIDC sign-in",
          responses: {
            302: {
              description:
                "Redirect back to `return_to`, setting the Pulse session cookie and clearing the transaction cookie. Every failure path redirects to the same place with an `?auth_error=` marker instead.",
            },
            429: rateLimitedResponse,
          },
        },
      },
    );

  const sessionRoutes = new Elysia({ prefix: PREFIX })
    // -----------------------------------------------------------------------
    // GET /api/auth/session — who is signed in.
    //
    // 200 with the profile snapshot, or 200 with `{ signedIn: false }`. NOT a
    // 401: this is the probe every page runs on load to decide whether to show
    // the sign-in button, and a signed-out visitor is the expected case, not an
    // error.
    // -----------------------------------------------------------------------
    .get(
      "/session",
      async ({ headers, server, request, set }) => {
        const ip = resolveIp(headers, server, request);
        if (!(await checkPerIpLimit(ip, sessionLimiter))) {
          set.status = 429;
          return { error: "rate_limited" } as const;
        }
        const token = parseWebSessionToken(request.headers.get("cookie"));
        if (!token) return { signedIn: false as const };
        const session = await runtime.runPromise(
          webSessionService
            .validate(token)
            .pipe(Effect.catchTag("WebSessionInvalid", () => Effect.succeed(null))),
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
      },
      {
        detail: {
          operationId: "getWebSession",
          summary: "Who is signed in",
          responses: {
            200: jsonResponse(
              "The viewer's session. The identity fields are present only when `signedIn` is true.",
              {
                type: "object",
                properties: {
                  signedIn: { type: "boolean" },
                  osnProfileId: { type: "string" },
                  email: { type: "string" },
                  handle: { type: "string" },
                  displayName: { type: "string" },
                  avatarUrl: { type: ["string", "null"] },
                  expiresAt: { type: "string", format: "date-time" },
                },
                required: ["signedIn"],
              },
            ),
            429: rateLimitedResponse,
          },
        },
      },
    )
    // -----------------------------------------------------------------------
    // POST /api/auth/signout — drop the session row and the cookie.
    //
    // `?all=1` drops every session for the profile (all browsers). Always 200,
    // even with no cookie: signing out is idempotent, and telling a caller
    // whether a token was live is a free oracle.
    // -----------------------------------------------------------------------
    .post(
      "/signout",
      async ({ query, headers, server, request, set }) => {
        const ip = resolveIp(headers, server, request);
        if (!(await checkPerIpLimit(ip, sessionLimiter))) {
          set.status = 429;
          return { error: "rate_limited" } as const;
        }
        const token = parseWebSessionToken(request.headers.get("cookie"));
        if (token) {
          await runtime.runPromise(
            Effect.gen(function* () {
              if (query["all"] === "1") {
                const session = yield* webSessionService
                  .validate(token)
                  .pipe(Effect.catchTag("WebSessionInvalid", () => Effect.succeed(null)));
                if (session) {
                  yield* webSessionService.revokeAllForProfile(session.osnProfileId);
                  return;
                }
              }
              yield* webSessionService.revoke(token);
            }).pipe(Effect.catchTag("WebSessionWriteError", () => Effect.void)),
          );
        }
        set.headers["set-cookie"] = clearWebSessionCookie({ secure: secureCookies });
        return { ok: true } as const;
      },
      {
        detail: {
          operationId: "signOutWebSession",
          summary: "Drop the Pulse session cookie",
          responses: {
            200: jsonResponse("Signed out. Always 200, with or without a live session.", {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
            }),
            429: rateLimitedResponse,
          },
        },
      },
    );

  return new Elysia().use(redirectLegs).use(sessionRoutes);
};
