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

import type { OidcAuthorizeResult, OidcTokenResult } from "@shared/observability/metrics";
import { Effect, Either } from "effect";
import { Elysia, t } from "elysia";

import { readSessionCookie } from "../../lib/cookie-session";
import { metricOidcAuthorize, metricOidcConsentGranted, metricOidcToken } from "../../metrics";
import type { OidcClient, OidcErrorCode } from "../../services/auth";
import type { AuthRouteContext } from "./context";

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

const clientKindOf = (client: OidcClient) => (client.isFirstParty ? "first_party" : "third_party");

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
   * Resolves the session cookie to an account id, or null when this device is
   * not signed in. A bad cookie is not an error here — "not signed in" is a
   * normal state at the authorization endpoint, and the answer to it is the
   * sign-in screen.
   */
  const resolveAccountId = async (cookieHeader: string | undefined): Promise<string | null> => {
    const token = readSessionCookie(cookieHeader, cookieConfig);
    if (!token) return null;
    const result = await run(Effect.either(auth.verifyRefreshToken(token)));
    return Either.isRight(result) ? result.right.accountId : null;
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
      .get("/authorize", async ({ query, set, headers, server, request }) => {
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
          set.status = 429;
          return rlErr;
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
          // No trusted redirect URI exists yet, so this is rendered. The client
          // kind is unknowable for the same reason — the client is unknown.
          metricOidcAuthorize({ result: authorizeResultOf(oidc.code), clientKind: "third_party" });
          set.status = oidc.code === "invalid_client" ? 401 : 400;
          return { error: oidc.code, error_description: oidc.description };
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
        const accountId = await resolveAccountId(headers.cookie);

        let prepared;
        try {
          prepared = await run(auth.prepareAuthorization(authorizeRequest, prompts, accountId));
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
      })
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
            if (!parked) {
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

            const accountId = await resolveAccountId(headers.cookie);
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
        { query: t.Object({ request: t.String({ pattern: "^oar_[a-f0-9]{12}$" }) }) },
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

          const accountId = await resolveAccountId(headers.cookie);
          if (accountId === null) {
            set.status = 401;
            return { error: "unauthorized" };
          }

          // Read the client before deciding: approval consumes the parked
          // request, so afterwards there is nothing left to name it by.
          const parked = await run(auth.loadAuthorizeRequest(body.requestId));
          const client = parked === null ? null : await run(auth.findOidcClient(parked.clientId));

          const result = await run(
            Effect.either(
              auth.completeAuthorization({
                requestId: body.requestId,
                accountId,
                profileId: body.profileId,
                approved: body.approved,
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
            set.status = oidc.code === "invalid_client" ? 401 : 400;
            return { error: oidc.code, error_description: oidc.description };
          }

          if (result.right.isNewLink) {
            metricOidcConsentGranted(client ? clientKindOf(client) : "third_party");
          }

          return { redirectTo: result.right.redirectTo };
        },
        {
          body: t.Object({
            requestId: t.String({ pattern: "^oar_[a-f0-9]{12}$" }),
            profileId: t.String(),
            approved: t.Boolean(),
          }),
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

          const client = await run(auth.findOidcClient(clientId));
          metricOidcToken({
            result: "ok",
            clientKind: client ? clientKindOf(client) : "third_party",
          });
          return result.right;
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
        },
      )
  );
}
