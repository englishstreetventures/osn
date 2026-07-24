/**
 * Self-serve OIDC client registration — the owner-facing half of the relying-
 * party registry. `oauth_clients` rows previously went in by hand; these
 * routes let a signed-in account register, list, and disable its own clients,
 * which is the last prerequisite for third parties integrating without an
 * operator in the loop.
 *
 * Trust decisions live in the service (`registerClient`): server-generated
 * `client_id`, secret shown once, sector derived (never chosen), first-party
 * status never settable. This file owns HTTP shape validation, auth, and
 * rate limiting only.
 *
 * See [[wiki/systems/oidc-provider]].
 */

import { Elysia, t } from "elysia";

import { resolveAccessTokenPrincipal } from "../../lib/auth-derive";
import { validateClientRegistration } from "../../services/auth";
import type { AuthRouteContext } from "./context";

export function createOidcClientRoutes(ctx: AuthRouteContext) {
  const { auth, run, handleError, rateLimit, socketIpOf, rl } = ctx;

  /** Bearer → owning account, or null. Same resolution as the settings routes. */
  const resolveOwner = async (authHeader: string | undefined): Promise<string | null> => {
    const claims = await resolveAccessTokenPrincipal(auth, authHeader);
    if (!claims) return null;
    const profile = await run(auth.findProfileById(claims.profileId));
    return profile?.accountId ?? null;
  };

  return (
    new Elysia()
      // -----------------------------------------------------------------------
      // POST /oidc/clients — register a relying party.
      //
      // Access-token authed, no step-up: a freshly minted client is inert
      // until a user walks through /authorize and consents in a browser, so
      // the credential it creates grants nothing by itself. The per-account
      // cap and the 5/hour limiter bound the abuse surface instead.
      // -----------------------------------------------------------------------
      .post(
        "/oidc/clients",
        async ({ body, headers, set, server, request }) => {
          set.headers["cache-control"] = "no-store";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "oidc_client_create",
            rl.oidcClientCreate,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const accountId = await resolveOwner(headers.authorization);
            if (accountId === null) {
              set.status = 401;
              return { error: "unauthorized" };
            }

            const validated = validateClientRegistration({
              name: body.name,
              redirectUris: body.redirect_uris,
              logoUrl: body.logo_url ?? null,
            });
            if (!validated.ok) {
              set.status = 400;
              return { error: "invalid_request", message: validated.message };
            }

            const result = await run(
              auth.registerOidcClient({
                ownerAccountId: accountId,
                name: validated.name,
                redirectUris: validated.redirectUris,
                logoUrl: validated.logoUrl,
                confidential: body.confidential ?? false,
              }),
            );

            set.status = 201;
            return {
              client: result.client,
              // Shown exactly once — the server stores only the hash. The
              // null for public clients is explicit so integrators notice.
              client_secret: result.clientSecret,
            };
          } catch (e) {
            const tagged = e as { _tag?: string; code?: string; description?: string };
            if (tagged?._tag === "OidcError") {
              set.status = 400;
              return { error: tagged.code, message: tagged.description };
            }
            const { status, body: errBody } = handleError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            name: t.String({ minLength: 1, maxLength: 128 }),
            redirect_uris: t.Array(t.String({ minLength: 1, maxLength: 1024 }), {
              minItems: 1,
              maxItems: 16,
            }),
            logo_url: t.Optional(t.String({ maxLength: 1024 })),
            confidential: t.Optional(t.Boolean()),
          }),
        },
      )
      // -----------------------------------------------------------------------
      // GET /oidc/clients — the caller's registered clients.
      // -----------------------------------------------------------------------
      .get("/oidc/clients", async ({ headers, set, server, request }) => {
        set.headers["cache-control"] = "no-store";

        const rlErr = await rateLimit(
          headers,
          socketIpOf({ server, request }),
          "oidc_client_list",
          rl.oidcClientList,
        );
        if (rlErr) {
          set.status = 429;
          return rlErr;
        }
        try {
          const accountId = await resolveOwner(headers.authorization);
          if (accountId === null) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const clients = await run(auth.listOwnedOidcClients(accountId));
          return { clients };
        } catch (e) {
          const { status, body: errBody } = handleError(e);
          set.status = status;
          return errBody;
        }
      })
      // -----------------------------------------------------------------------
      // DELETE /oidc/clients/:clientId — disable an owned client.
      //
      // Disabled clients read as absent everywhere, so new /authorize flows
      // refuse and in-flight codes die at the exchange's client lookup. 404
      // covers both "not yours" and "not found" — no existence oracle.
      // -----------------------------------------------------------------------
      .delete(
        "/oidc/clients/:clientId",
        async ({ params, headers, set, server, request }) => {
          set.headers["cache-control"] = "no-store";

          const rlErr = await rateLimit(
            headers,
            socketIpOf({ server, request }),
            "oidc_client_disable",
            rl.oidcClientDisable,
          );
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
          try {
            const accountId = await resolveOwner(headers.authorization);
            if (accountId === null) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const { disabled } = await run(auth.disableOwnedOidcClient(accountId, params.clientId));
            if (!disabled) {
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
        { params: t.Object({ clientId: t.String({ minLength: 1, maxLength: 128 }) }) },
      )
  );
}
