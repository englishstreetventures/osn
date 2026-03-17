import { Elysia, t } from "elysia";
import { Effect, type Layer } from "effect";
import { DbLive, type Db } from "@osn/db/service";
import { createAuthService, type AuthConfig } from "../services/auth";
import { buildAuthorizeHtml } from "../lib/html";
import { verifyPkceChallenge } from "../lib/crypto";

// In-memory PKCE challenge store (keyed by state)
interface PkceEntry {
  codeChallenge: string;
  codeChallengeMethod: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  expiresAt: number;
}
const pkceStore = new Map<string, PkceEntry>();

export function createAuthRoutes(authConfig: AuthConfig, dbLayer: Layer.Layer<Db> = DbLive) {
  const auth = createAuthService(authConfig);

  const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
    Effect.runPromise(eff.pipe(Effect.provide(dbLayer)) as Effect.Effect<A, never, never>);

  return (
    new Elysia({ prefix: "" })
      // -------------------------------------------------------------------------
      // Authorization endpoint — renders the sign-in page
      // -------------------------------------------------------------------------
      .get(
        "/authorize",
        ({ query, set }) => {
          const {
            response_type,
            client_id,
            redirect_uri,
            state,
            code_challenge,
            code_challenge_method,
            scope,
          } = query;

          if (response_type !== "code") {
            set.status = 400;
            return { error: "unsupported_response_type" };
          }

          if (!client_id || !redirect_uri || !state || !code_challenge) {
            set.status = 400;
            return { error: "invalid_request", message: "Missing required parameters" };
          }

          // Store PKCE entry
          pkceStore.set(state, {
            codeChallenge: code_challenge,
            codeChallengeMethod: code_challenge_method ?? "S256",
            clientId: client_id,
            redirectUri: redirect_uri,
            scope: scope ?? "openid profile",
            expiresAt: Date.now() + 600_000,
          });

          set.headers["Content-Type"] = "text/html; charset=utf-8";
          return buildAuthorizeHtml({
            clientId: client_id,
            redirectUri: redirect_uri,
            state,
            codeChallenge: code_challenge,
            codeChallengeMethod: code_challenge_method ?? "S256",
            scope: scope ?? "openid profile",
            issuerUrl: authConfig.issuerUrl,
          });
        },
        {
          query: t.Object({
            response_type: t.String(),
            client_id: t.String(),
            redirect_uri: t.String(),
            state: t.String(),
            code_challenge: t.String(),
            scope: t.Optional(t.String()),
            code_challenge_method: t.Optional(t.String()),
          }),
        },
      )
      // -------------------------------------------------------------------------
      // Token endpoint — PKCE code exchange + refresh
      // -------------------------------------------------------------------------
      .post(
        "/token",
        async ({ body, set }) => {
          const { grant_type } = body as { grant_type: string };

          if (grant_type === "authorization_code") {
            const { code, redirect_uri, client_id, code_verifier, state } = body as {
              code: string;
              redirect_uri: string;
              client_id: string;
              code_verifier: string;
              state?: string;
            };

            if (!code || !redirect_uri || !client_id || !code_verifier) {
              set.status = 400;
              return { error: "invalid_request" };
            }

            // Verify PKCE if we have a stored entry
            // For simplicity, we look up the pkce entry by trying all unexpired entries
            // In production you'd associate code with the pkce entry directly
            // Here we do a best-effort: if state provided, use it
            if (state) {
              const pkce = pkceStore.get(state);
              if (pkce) {
                if (Date.now() > pkce.expiresAt) {
                  pkceStore.delete(state);
                  set.status = 400;
                  return { error: "invalid_grant", message: "State expired" };
                }
                const valid = await verifyPkceChallenge(code_verifier, pkce.codeChallenge);
                if (!valid) {
                  set.status = 400;
                  return { error: "invalid_grant", message: "PKCE verification failed" };
                }
                pkceStore.delete(state);
              }
            }

            try {
              const tokens = await run(auth.exchangeCode(code));
              return {
                access_token: tokens.accessToken,
                refresh_token: tokens.refreshToken,
                token_type: "Bearer",
                expires_in: tokens.expiresIn,
                scope: "openid profile",
              };
            } catch (e) {
              set.status = 400;
              return { error: "invalid_grant", message: String(e) };
            }
          }

          if (grant_type === "refresh_token") {
            const { refresh_token } = body as { refresh_token: string };
            if (!refresh_token) {
              set.status = 400;
              return { error: "invalid_request" };
            }
            try {
              const tokens = await run(auth.refreshTokens(refresh_token));
              return {
                access_token: tokens.accessToken,
                refresh_token: tokens.refreshToken,
                token_type: "Bearer",
                expires_in: tokens.expiresIn,
                scope: "openid profile",
              };
            } catch (e) {
              set.status = 400;
              return { error: "invalid_grant", message: String(e) };
            }
          }

          set.status = 400;
          return { error: "unsupported_grant_type" };
        },
        {
          body: t.Object({
            grant_type: t.String(),
            code: t.Optional(t.String()),
            redirect_uri: t.Optional(t.String()),
            client_id: t.Optional(t.String()),
            code_verifier: t.Optional(t.String()),
            state: t.Optional(t.String()),
            refresh_token: t.Optional(t.String()),
          }),
        },
      )
      // -------------------------------------------------------------------------
      // Passkey: begin registration
      // -------------------------------------------------------------------------
      .post(
        "/passkey/register/begin",
        async ({ body, set }) => {
          try {
            const result = await run(auth.beginPasskeyRegistration(body.userId));
            return result.options;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({ userId: t.String() }),
        },
      )
      // -------------------------------------------------------------------------
      // Passkey: complete registration
      // -------------------------------------------------------------------------
      .post(
        "/passkey/register/complete",
        async ({ body, set }) => {
          try {
            const result = await run(
              auth.completePasskeyRegistration(body.userId, body.attestation),
            );
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({
            userId: t.String(),
            attestation: t.Any(),
          }),
        },
      )
      // -------------------------------------------------------------------------
      // Passkey: begin login
      // -------------------------------------------------------------------------
      .post(
        "/passkey/login/begin",
        async ({ body, set }) => {
          try {
            const result = await run(auth.beginPasskeyLogin(body.email));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({ email: t.String() }),
        },
      )
      // -------------------------------------------------------------------------
      // Passkey: complete login
      // -------------------------------------------------------------------------
      .post(
        "/passkey/login/complete",
        async ({ body, set }) => {
          try {
            const result = await run(auth.completePasskeyLogin(body.email, body.assertion));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({
            email: t.String(),
            assertion: t.Any(),
          }),
        },
      )
      // -------------------------------------------------------------------------
      // OTP: begin
      // -------------------------------------------------------------------------
      .post(
        "/otp/begin",
        async ({ body, set }) => {
          try {
            const result = await run(auth.beginOtp(body.email));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({ email: t.String() }),
        },
      )
      // -------------------------------------------------------------------------
      // OTP: complete
      // -------------------------------------------------------------------------
      .post(
        "/otp/complete",
        async ({ body, set }) => {
          try {
            const result = await run(auth.completeOtp(body.email, body.code));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({ email: t.String(), code: t.String() }),
        },
      )
      // -------------------------------------------------------------------------
      // Magic link: begin
      // -------------------------------------------------------------------------
      .post(
        "/magic/begin",
        async ({ body, set }) => {
          try {
            const result = await run(auth.beginMagic(body.email));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({ email: t.String() }),
        },
      )
      // -------------------------------------------------------------------------
      // Magic link: verify (GET, user clicks link from email)
      // -------------------------------------------------------------------------
      .get(
        "/magic/verify",
        async ({ query, set }) => {
          const { token, redirect_uri, state } = query;
          if (!token || !redirect_uri || !state) {
            set.status = 400;
            return { error: "Missing parameters" };
          }
          try {
            const result = await run(auth.verifyMagic(token, redirect_uri, state));
            set.redirect = result.redirectUrl;
            set.status = 302;
            return null;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          query: t.Object({
            token: t.String(),
            redirect_uri: t.String(),
            state: t.String(),
          }),
        },
      )
      // -------------------------------------------------------------------------
      // OIDC discovery (minimal)
      // -------------------------------------------------------------------------
      .get("/.well-known/openid-configuration", () => ({
        issuer: authConfig.issuerUrl,
        authorization_endpoint: `${authConfig.issuerUrl}/authorize`,
        token_endpoint: `${authConfig.issuerUrl}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["openid", "profile", "email"],
      }))
  );
}
