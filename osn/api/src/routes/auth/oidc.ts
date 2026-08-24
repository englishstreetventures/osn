/**
 * OIDC provider routes — the authorization endpoint, the consent screen's two
 * supporting calls, and the token endpoint.
 *
 * Everything that decides anything lives in `services/auth/oidc.ts`. This file
 * only moves values between HTTP and that module: it reads the query string,
 * resolves the session cookie to an account, and turns the module's answer into
 * a redirect, a rendered error, or a JSON body.
 *
 * One rule is worth restating here because it is a route-layer rule and nothing
 * else enforces it: an error raised BEFORE the client and its redirect URI are
 * known must be rendered, never redirected (RFC 6749 §4.1.2.1). Redirecting to
 * an unvalidated URI is an open redirect, and an open redirect on the identity
 * provider is the first link in most account-takeover chains. The service
 * signals which case applies by failing the effect for the first kind and
 * returning `kind: "error"` for the second — so the two paths below are not a
 * judgement call.
 *
 * See [[wiki/systems/oidc-provider]].
 */

import { createHash, timingSafeEqual } from "node:crypto";

import type { OidcAuthorizeResult, OidcTokenResult } from "@shared/observability/metrics";
import { Effect, Either } from "effect";
import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import { readSessionCookie } from "../../lib/cookie-session";
import {
  buildBindingCookie,
  buildClearBindingCookie,
  readBindingCookie,
} from "../../lib/oidc-binding-cookie";
import { metricOidcAuthorize, metricOidcConsentGranted, metricOidcToken } from "../../metrics";
import type { AuthorizeSession, OidcErrorCode } from "../../services/auth";
import type { AuthRouteContext } from "./context";
import {
  oidcConnectionSummary,
  oidcErrorResponse,
  oidcTokenResponse,
  publicProfile,
} from "./response-schemas";

/** The wire codes that map onto their own authorize metric bucket. */
const AUTHORIZE_RESULTS = new Set<string>([
  "login_required",
  "consent_required",
  "access_denied",
  "invalid_request",
  "invalid_client",
  "server_error",
]);

const authorizeResultOf = (code: OidcErrorCode): OidcAuthorizeResult =>
  AUTHORIZE_RESULTS.has(code) ? (code as OidcAuthorizeResult) : "invalid_request";

/** Only four token outcomes are dimensioned; the rest read as invalid_request. */
const tokenResultOf = (code: OidcErrorCode): OidcTokenResult =>
  code === "invalid_grant" || code === "invalid_client" ? code : "invalid_request";

const clientKindOf = (client: { isFirstParty: boolean }) =>
  client.isFirstParty ? "first_party" : "third_party";

/**
 * The host a redirect URI delivers to, for the consent screen to display as a
 * verifiable identity signal. The URI has already passed exact-match
 * registration, so it always parses; the fallback only guards against a
 * malformed hand-seeded row.
 */
const redirectHost = (redirectUri: string): string => {
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
};

/**
 * A minimal, self-contained HTML error page for the top-level `/authorize`
 * navigation. RFC 6749 forbids redirecting before the client + redirect URI
 * are validated, so a misconfigured relying party lands here directly — the
 * one place a real page matters, since the user is stranded with no way back
 * to the app. Renders ONLY a fixed message keyed off the (enum) error code:
 * never any relying-party-supplied value (client_id, redirect_uri, state),
 * which would make this a reflected-content sink.
 */
const AUTHORIZE_ERROR_COPY = {
  invalid_client:
    "We don't recognise the app that sent you here, so we can't continue the sign-in.",
  invalid_request:
    "This sign-in link is malformed or has expired. Return to the app and try again.",
  rate_limited: "Too many sign-in attempts. Please wait a moment and try again.",
} satisfies Record<string, string>;

const hasAuthorizeErrorCopy = (code: string): code is keyof typeof AUTHORIZE_ERROR_COPY =>
  Object.hasOwn(AUTHORIZE_ERROR_COPY, code);

const renderAuthorizeErrorPage = (code: string): string => {
  const message = hasAuthorizeErrorCopy(code)
    ? AUTHORIZE_ERROR_COPY[code]
    : AUTHORIZE_ERROR_COPY.invalid_request;
  // `code` is one of our own enum values; escape defensively anyway.
  const safeCode = code.replace(/[^a-z_]/g, "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign-in error</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#fafafa;color:#1a1a1a}
@media(prefers-color-scheme:dark){body{background:#0d0d0d;color:#ededed}}
main{max-width:26rem;padding:2rem;text-align:center}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:0 0 .5rem;color:#666}
@media(prefers-color-scheme:dark){p{color:#a0a0a0}}
code{font-size:.8125rem;opacity:.6}
</style>
</head>
<body><main>
<h1>Can't complete sign-in</h1>
<p>${message}</p>
<p><code>${safeCode}</code></p>
</main></body>
</html>`;
};

/**
 * Pulls an `OidcError` out of an Effect failure. `Either` keeps the failure
 * typed, but the union also carries `DatabaseError`, and only the OIDC arm has
 * a wire code the relying party is allowed to see.
 */
const asOidcError = (e: unknown): { code: OidcErrorCode; description: string } | null => {
  const tagged = e as { _tag?: string; code?: OidcErrorCode; description?: string };
  if (tagged?._tag !== "OidcError" || !tagged.code) return null;
  return { code: tagged.code, description: tagged.description ?? "" };
};

/**
 * Credentials presented at the token endpoint via HTTP Basic (RFC 6749 §2.3.1).
 * Both halves are form-urlencoded before base64, so both need decoding back.
 */
const parseBasicAuth = (header: string | undefined): { id: string; secret: string } | null => {
  if (!header || !/^Basic\s/i.test(header)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  try {
    return {
      id: decodeURIComponent(decoded.slice(0, sep)),
      secret: decodeURIComponent(decoded.slice(sep + 1)),
    };
  } catch {
    // A literal `%` that is not an escape — not our credentials to repair.
    return null;
  }
};

export function createOidcRoutes(ctx: AuthRouteContext) {
  const { auth, run, handleError, rateLimit, socketIpOf, rl, cookieConfig, authConfig } = ctx;

  /**
   * Where the browser goes when a request needs the user. Resolved once: a
   * misconfigured URL should break at boot, not on a user's first sign-in.
   */
  const authorizeUiUrl = (() => {
    if (authConfig.authorizeUiUrl) return authConfig.authorizeUiUrl;
    const origin = Array.isArray(authConfig.origin) ? authConfig.origin[0] : authConfig.origin;
    return new URL("/authorize", origin ?? authConfig.issuerUrl).toString();
  })();

  const buildInteractionRedirect = (requestId: string, reason: string): string => {
    const url = new URL(authorizeUiUrl);
    url.searchParams.set("request", requestId);
    url.searchParams.set("reason", reason);
    return url.toString();
  };

  /**
   * S-M1: does this browser hold the binding cookie for the parked request?
   * Every parked request carries a binding hash (S-L4), so there is no
   * "no hash → accept" path — a missing or wrong cookie always fails.
   */
  const bindingMatches = (
    bindingHash: string,
    cookieHeader: string | undefined,
    requestId: string,
  ): boolean => {
    // S-L4: every parked request carries a binding hash now, so there is no
    // "no hash → accept" path that a future writer could trip into.
    const secret = readBindingCookie(cookieHeader, requestId, cookieConfig);
    if (secret === null) return false;
    // Constant-time, matching the repo rule for hash comparisons — both sides
    // are digests, so a prefix leak reveals nothing, but it costs nothing to
    // do properly.
    const computed = createHash("sha256").update(secret).digest();
    let stored: Buffer;
    try {
      stored = Buffer.from(bindingHash, "hex");
    } catch {
      return false;
    }
    if (stored.length !== computed.length) return false;
    return timingSafeEqual(computed, stored);
  };

  /**
   * Resolves the session cookie to the account id plus the session's real
   * authentication time, or null when this device is not signed in. A bad
   * cookie is not an error here — "not signed in" is a normal state at the
   * authorization endpoint, and the answer to it is the sign-in screen.
   */
  const resolveSession = async (
    cookieHeader: string | undefined,
  ): Promise<AuthorizeSession | null> => {
    const token = readSessionCookie(cookieHeader, cookieConfig);
    if (!token) return null;
    const result = await run(Effect.either(auth.verifyRefreshToken(token)));
    if (!Either.isRight(result)) return null;
    return { accountId: result.right.accountId, authTime: result.right.authenticatedAt };
  };

  return (
    new Elysia()
      // -----------------------------------------------------------------------
      // GET /authorize — the authorization endpoint.
      //
      // A top-level navigation, never an iframe: the first-party session cookie
      // is only reliably sent on a top-level request, and hidden-iframe silent
      // authentication no longer works under Safari's tracking prevention or
      // Chrome's third-party cookie rules. Three outcomes: straight back to the
      // relying party with a code, off to the consent UI, or back to the
      // relying party with an error.
      // -----------------------------------------------------------------------
      .get(
        "/authorize",
        async ({ query, set, headers, server, request }) => {
          set.headers["cache-control"] = "no-store";
          // The interaction redirect carries the parked-request id in its query
          // string, and the whole endpoint carries the relying party's OAuth
          // parameters. Neither may ride a `Referer` header onto the next page.
          set.headers["referrer-policy"] = "no-referrer";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "oidc_authorize",
            rl.oidcAuthorize,
          );
          if (rlErr) {
            // Top-level navigation: a JSON blob would strand the user. Render the
            // branded error page instead (the XHR context/decision routes below
            // keep returning JSON).
            set.status = 429;
            set.headers["content-type"] = "text/html; charset=utf-8";
            return renderAuthorizeErrorPage("rate_limited");
          }

          const q = query as Record<string, string | undefined>;
          const params = {
            clientId: q["client_id"] ?? "",
            redirectUri: q["redirect_uri"] ?? "",
            responseType: q["response_type"] ?? "",
            scope: q["scope"] ?? null,
            state: q["state"] ?? null,
            nonce: q["nonce"] ?? null,
            codeChallenge: q["code_challenge"] ?? null,
            codeChallengeMethod: q["code_challenge_method"] ?? "",
            prompt: q["prompt"] ?? null,
            maxAge: q["max_age"] ?? null,
          };

          const validated = await run(Effect.either(auth.validateAuthorizeRequest(params)));

          if (Either.isLeft(validated)) {
            const oidc = asOidcError(validated.left);
            if (!oidc) {
              metricOidcAuthorize({ result: "server_error", clientKind: "third_party" });
              const { status, body } = handleError(validated.left);
              set.status = status;
              return body;
            }
            // No trusted redirect URI exists yet, so this is rendered — never
            // redirected (open-redirect guard). The client kind is unknowable for
            // the same reason. This is a top-level browser navigation, so render
            // a branded HTML page (keyed only off our own error code, never any
            // RP-supplied value) rather than stranding the user on raw JSON.
            metricOidcAuthorize({
              result: authorizeResultOf(oidc.code),
              clientKind: "third_party",
            });
            set.status = oidc.code === "invalid_client" ? 401 : 400;
            set.headers["content-type"] = "text/html; charset=utf-8";
            return renderAuthorizeErrorPage(oidc.code);
          }

          const outcome = validated.right;

          if (outcome.kind === "error") {
            metricOidcAuthorize({
              result: authorizeResultOf(outcome.code),
              clientKind: clientKindOf(outcome.client),
            });
            set.status = 302;
            set.headers["location"] = auth.buildOidcErrorRedirect(
              outcome.redirectUri,
              outcome.code,
              outcome.description,
              outcome.state,
            );
            return "";
          }

          const { request: authorizeRequest, prompts } = outcome;
          const clientKind = clientKindOf(authorizeRequest.client);
          const session = await resolveSession(headers.cookie);

          let prepared;
          try {
            prepared = await run(auth.prepareAuthorization(authorizeRequest, prompts, session));
          } catch (e) {
            metricOidcAuthorize({ result: "server_error", clientKind });
            const { status, body } = handleError(e);
            set.status = status;
            return body;
          }

          set.status = 302;
          if (prepared.kind === "code") {
            metricOidcAuthorize({ result: "redirected", clientKind });
            set.headers["location"] = auth.buildOidcCodeRedirect(
              authorizeRequest.redirectUri,
              prepared.code,
              authorizeRequest.state,
            );
            return "";
          }
          if (prepared.kind === "interaction") {
            metricOidcAuthorize({ result: "interaction", clientKind });
            // S-M1: bind the parked request to this browser. The consent screen's
            // context + decision calls must arrive with this cookie, so a leaked
            // or guessed request id approves nothing anywhere else.
            set.headers["set-cookie"] = buildBindingCookie(
              prepared.requestId,
              prepared.bindingSecret,
              cookieConfig,
            );
            set.headers["location"] = buildInteractionRedirect(prepared.requestId, prepared.reason);
            return "";
          }
          metricOidcAuthorize({ result: authorizeResultOf(prepared.code), clientKind });
          set.headers["location"] = auth.buildOidcErrorRedirect(
            authorizeRequest.redirectUri,
            prepared.code,
            prepared.description,
            authorizeRequest.state,
          );
          return "";
        },
        {
          // The only route in this file that answers a browser navigation
          // rather than a fetch, so it is the only one whose body is sometimes
          // a string. Three shapes, not two:
          //
          //   302 + empty body   — every success and every post-validation
          //                        error, which goes back to the relying party
          //                        as query parameters, never as a body.
          //   HTML page          — an error raised BEFORE the redirect URI is
          //                        trusted. RFC 6749 §4.1.2.1 forbids
          //                        redirecting there, so the user is stranded
          //                        and gets a real page.
          //   JSON error         — a non-OIDC failure falling through
          //                        `handleError` (a DatabaseError is the only
          //                        realistic one).
          //
          // 400 carries both of the latter two, hence the union. Declaring
          // only the object would have made Elysia reject the HTML string.
          response: {
            302: t.String(),
            400: t.Union([t.String(), oidcErrorResponse]),
            // `invalid_client` alone — an unrecognised or disabled relying
            // party, rendered for the same reason.
            401: t.String(),
            429: t.String(),
            500: oidcErrorResponse,
          },
          // Unauthenticated by design: an unsigned-in browser is the normal
          // case here, and the answer to it is the sign-in screen.
          detail: { operationId: "oidcAuthorize" },
        },
      )
      // -----------------------------------------------------------------------
      // GET /authorize/context — what the consent screen needs to draw itself.
      //
      // The UI is handed only an opaque request id; it reads the request back
      // here rather than carrying the OAuth parameters in its own URL, so a
      // tampered address bar cannot widen the scope the user is agreeing to.
      // -----------------------------------------------------------------------
      .get(
        "/authorize/context",
        async ({ query, set, headers, server, request }) => {
          set.headers["cache-control"] = "no-store";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "oidc_authorize_context",
            rl.oidcAuthorizeContext,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }

          try {
            const parked = await run(auth.loadAuthorizeRequest(query.request));
            // S-M1: a context read without the binding cookie is answered
            // exactly like an unknown id — an attacker holding a leaked
            // request id learns nothing, not even that it exists.
            if (!parked || !bindingMatches(parked.bindingHash, headers.cookie, query.request)) {
              set.status = 404;
              return { error: "invalid_request", error_description: "Unknown or expired request" };
            }

            const client = await run(auth.findOidcClient(parked.clientId));
            if (!client) {
              set.status = 404;
              return {
                error: "invalid_client",
                error_description: "Client is no longer available",
              };
            }

            const session = await resolveSession(headers.cookie);
            const accountId = session?.accountId ?? null;
            const profiles =
              accountId === null ? [] : (await run(auth.listAccountProfiles(accountId))).profiles;
            const consent =
              accountId === null
                ? null
                : await run(auth.findOidcConsent(accountId, client.clientId));

            return {
              client: {
                clientId: client.clientId,
                name: client.name,
                logoUrl: client.logoUrl,
                firstParty: client.isFirstParty,
                // The host the code will actually be delivered to for THIS
                // request. A verifiable signal the consent screen shows next to
                // the (self-asserted, spoofable) name so a user can tell a
                // genuine first-party app from a look-alike third party.
                redirectDomain: redirectHost(parked.redirectUri),
              },
              scopes: parked.scope.split(" ").filter((s) => s.length > 0),
              signedIn: accountId !== null,
              profiles,
              linkedProfileId: consent?.profileId ?? null,
            };
          } catch (e) {
            const { status, body } = handleError(e);
            set.status = status;
            return body;
          }
        },
        {
          query: t.Object({ request: t.String({ pattern: "^oar_[a-f0-9]{12}$" }) }),
          response: {
            200: t.Object({
              client: t.Object({
                clientId: t.String(),
                name: t.String(),
                logoUrl: t.Union([t.String(), t.Null()]),
                firstParty: t.Boolean(),
                // The host the code is actually delivered to for THIS request.
                // The consent screen shows it beside the self-asserted (and so
                // spoofable) name, so dropping it would remove the one signal
                // that separates a genuine first-party app from a look-alike.
                redirectDomain: t.String(),
              }),
              scopes: t.Array(t.String()),
              signedIn: t.Boolean(),
              // Empty when the browser holds no session — the screen then
              // sends the user to sign in and retries the same request id.
              profiles: t.Array(publicProfile),
              linkedProfileId: t.Union([t.String(), t.Null()]),
            }),
            400: oidcErrorResponse,
            // Unknown id, expired id, and a right id in the wrong browser all
            // answer identically: a leaked request id learns nothing here.
            404: oidcErrorResponse,
            429: oidcErrorResponse,
            500: oidcErrorResponse,
          },
          detail: { operationId: "getOidcAuthorizeContext" },
        },
      )
      // -----------------------------------------------------------------------
      // POST /authorize/decision — the user's answer.
      //
      // Returns the destination as JSON rather than a redirect: this is a fetch
      // from the consent screen, and a 302 on a fetch would be followed by the
      // browser instead of handed to the page. The screen navigates itself.
      // -----------------------------------------------------------------------
      .post(
        "/authorize/decision",
        async ({ body, set, headers, server, request }) => {
          set.headers["cache-control"] = "no-store";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "oidc_authorize_decision",
            rl.oidcAuthorizeDecision,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }

          const session = await resolveSession(headers.cookie);
          if (session === null) {
            set.status = 401;
            return { error: "unauthorized" };
          }

          const result = await run(
            Effect.either(
              auth.completeAuthorization({
                requestId: body.requestId,
                accountId: session.accountId,
                profileId: body.profileId,
                approved: body.approved,
                authTime: session.authTime,
                bindingSecret: readBindingCookie(headers.cookie, body.requestId, cookieConfig),
              }),
            ),
          );

          if (Either.isLeft(result)) {
            const oidc = asOidcError(result.left);
            if (!oidc) {
              const { status, body: errBody } = handleError(result.left);
              set.status = status;
              return errBody;
            }
            // `login_required` deliberately leaves the parked request alive:
            // the screen sends the user to re-authenticate and retries the
            // same request id with the fresh session.
            set.status = oidc.code === "invalid_client" ? 401 : 400;
            return { error: oidc.code, error_description: oidc.description };
          }

          if (result.right.isNewLink) {
            metricOidcConsentGranted(result.right.isFirstParty ? "first_party" : "third_party");
          }

          // The request is consumed either way, so the binding cookie has
          // nothing left to bind — expire it rather than let it linger.
          set.headers["set-cookie"] = buildClearBindingCookie(body.requestId, cookieConfig);
          return { redirectTo: result.right.redirectTo };
        },
        {
          body: t.Object({
            requestId: t.String({ pattern: "^oar_[a-f0-9]{12}$" }),
            profileId: t.String(),
            approved: t.Boolean(),
          }),
          response: {
            // A refusal is a 200 too: `approved: false` still produces a URL,
            // one carrying `error=access_denied` back to the relying party.
            // The screen navigates there itself, which is why this is JSON and
            // not a 302 — a fetch would follow a redirect instead of handing
            // it to the page.
            200: t.Object({ redirectTo: t.String() }),
            // Includes `login_required`, which leaves the parked request alive
            // so the screen can re-authenticate and retry the same id.
            400: oidcErrorResponse,
            401: oidcErrorResponse,
            429: oidcErrorResponse,
            500: oidcErrorResponse,
          },
          // The session cookie authenticates this, not a bearer token.
          detail: { operationId: "submitOidcAuthorizeDecision" },
        },
      )
      // -----------------------------------------------------------------------
      // POST /oidc/token — the authorization-code exchange.
      //
      // Mounted away from the first-party `/token` refresh grant on purpose:
      // that endpoint reads a session cookie, this one must not, and keeping
      // them apart means neither can grow into the other. Nothing minted here
      // carries the `osn-access` audience, so a relying party's token cannot
      // reach a first-party route however it is replayed.
      // -----------------------------------------------------------------------
      .post(
        "/oidc/token",
        async ({ body, set, headers, server, request }) => {
          set.headers["cache-control"] = "no-store";
          set.headers["pragma"] = "no-cache";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "oidc_token",
            rl.oidcToken,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }

          const fail = (
            status: number,
            code: OidcErrorCode,
            description: string,
            clientKind: "first_party" | "third_party" = "third_party",
          ) => {
            metricOidcToken({ result: tokenResultOf(code), clientKind });
            set.status = status;
            return { error: code, error_description: description };
          };

          if (body.grant_type !== "authorization_code") {
            return fail(
              400,
              "unsupported_grant_type",
              "Only the authorization_code grant is supported here",
            );
          }

          const basic = parseBasicAuth(headers.authorization);
          // RFC 6749 §2.3: a client authenticates one way. Two sets of
          // credentials means one of them is not the client's, so refuse both.
          if (basic && (body.client_secret !== undefined || body.client_id !== undefined)) {
            return fail(400, "invalid_request", "Use one client authentication method, not two");
          }

          const clientId = basic?.id ?? body.client_id;
          const clientSecret = basic?.secret ?? body.client_secret ?? null;
          if (!clientId || !body.code || !body.redirect_uri || !body.code_verifier) {
            return fail(
              400,
              "invalid_request",
              "client_id, code, redirect_uri and code_verifier are all required",
            );
          }

          const result = await run(
            Effect.either(
              auth.exchangeAuthorizationCode({
                clientId,
                clientSecret,
                code: body.code,
                redirectUri: body.redirect_uri,
                codeVerifier: body.code_verifier,
              }),
            ),
          );

          if (Either.isLeft(result)) {
            const oidc = asOidcError(result.left);
            if (!oidc) {
              metricOidcToken({ result: "invalid_request", clientKind: "third_party" });
              const { status, body: errBody } = handleError(result.left);
              set.status = status;
              return errBody;
            }
            if (oidc.code === "invalid_client" && basic) {
              set.headers["www-authenticate"] = 'Basic realm="oidc"';
            }
            return fail(oidc.code === "invalid_client" ? 401 : 400, oidc.code, oidc.description);
          }

          // P-W1: the exchange already read the client — no second lookup
          // just to label the counter.
          metricOidcToken({
            result: "ok",
            clientKind: result.right.isFirstParty ? "first_party" : "third_party",
          });
          return result.right.response;
        },
        {
          body: t.Object({
            grant_type: t.String(),
            code: t.Optional(t.String()),
            redirect_uri: t.Optional(t.String()),
            code_verifier: t.Optional(t.String()),
            client_id: t.Optional(t.String()),
            client_secret: t.Optional(t.String()),
          }),
          response: {
            200: oidcTokenResponse,
            400: oidcErrorResponse,
            // `invalid_client`. Paired with a `WWW-Authenticate: Basic` header
            // when the credentials came in over HTTP Basic.
            401: oidcErrorResponse,
            429: oidcErrorResponse,
            500: oidcErrorResponse,
          },
          // Client authentication, not user authentication — HTTP Basic or
          // form credentials, so no `bearerAuth`.
          detail: { operationId: "exchangeOidcAuthorizationCode" },
        },
      )
      // -----------------------------------------------------------------------
      // GET /oidc/connections — the apps this account has authorised.
      //
      // The user-facing half of `oauth_consents` (S-M3 oidc): what the
      // settings surface lists, and the record Art. 15 says the person may
      // see. Access-token authed like every other settings read.
      // -----------------------------------------------------------------------
      .get(
        "/oidc/connections",
        async ({ headers, set, server, request }) => {
          set.headers["cache-control"] = "no-store";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "oidc_connections_list",
            rl.oidcConnectionsList,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const connections = await run(auth.listOidcConsents(profile.accountId));
            return { connections };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          response: {
            // Live consents only — a revoked row never comes back here.
            200: t.Object({ connections: t.Array(oidcConnectionSummary) }),
            400: oidcErrorResponse,
            401: oidcErrorResponse,
            429: oidcErrorResponse,
            500: oidcErrorResponse,
          },
          detail: { operationId: "listOidcConnections", security: [{ bearerAuth: [] }] },
        },
      )
      // -----------------------------------------------------------------------
      // DELETE /oidc/connections/:clientId — withdraw an app's authorization.
      //
      // Art. 7(3): revoking must be as easy as granting (C-M3 oidc). Revoking
      // marks the consent row and kills any authorization code in flight for
      // the pair; the relying party's next /authorize gets `consent_required`.
      // -----------------------------------------------------------------------
      .delete(
        "/oidc/connections/:clientId",
        async ({ params, headers, set, server, request }) => {
          set.headers["cache-control"] = "no-store";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "oidc_connections_revoke",
            rl.oidcConnectionsRevoke,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const claims = await resolveAccessTokenPrincipal(auth, headers.authorization);
            if (!claims) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const profile = await run(auth.findProfileById(claims.profileId));
            if (!profile) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const { revoked } = await run(
              auth.revokeOidcConsent(profile.accountId, params.clientId),
            );
            if (!revoked) {
              set.status = 404;
              return { error: "not_found" };
            }
            return { success: true };
          } catch (e) {
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          params: t.Object({ clientId: t.String({ minLength: 1, maxLength: 128 }) }),
          response: {
            200: t.Object({ success: t.Boolean() }),
            400: oidcErrorResponse,
            401: oidcErrorResponse,
            // No live consent for that pair — already revoked, or never
            // granted. The two are not told apart.
            404: oidcErrorResponse,
            429: oidcErrorResponse,
            500: oidcErrorResponse,
          },
          detail: { operationId: "revokeOidcConnection", security: [{ bearerAuth: [] }] },
        },
      )
  );
}
