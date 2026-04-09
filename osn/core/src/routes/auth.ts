import { Elysia, t } from "elysia";
import { Effect, Layer } from "effect";
import { DbLive, type Db } from "@osn/db/service";
import { createAuthService, type AuthConfig } from "../services/auth";
import { buildAuthorizeHtml } from "../lib/html";
import { verifyPkceChallenge } from "../lib/crypto";

/**
 * Maps a thrown Effect-tagged error (or anything else) to a stable, public,
 * non-leaky error payload. The full cause is logged server-side for diagnosis,
 * but only opaque codes / sanitised messages cross the wire (S-H5 / S-M6).
 *
 * Tagged Effect errors come through `Effect.runPromise` wrapped in a
 * `FiberFailure`; we walk the cause chain looking for the original tag.
 */
function publicError(e: unknown): { status: number; body: { error: string; message?: string } } {
  // Walk the FiberFailure / Cause chain to find an Effect-tagged error.
  const tag = (() => {
    const seen = new Set<unknown>();
    const queue: unknown[] = [e];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      const t = (node as { _tag?: unknown })._tag;
      if (typeof t === "string") return t;
      for (const v of Object.values(node)) queue.push(v);
    }
    return null;
  })();

  // Always log the underlying cause for operators.
  console.error("[auth route]", e);

  switch (tag) {
    case "ValidationError":
      return { status: 400, body: { error: "invalid_request" } };
    case "AuthError":
      return { status: 400, body: { error: "invalid_request" } };
    case "DatabaseError":
      return { status: 500, body: { error: "internal_error" } };
    default:
      return { status: 400, body: { error: "invalid_request" } };
  }
}

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

export function createAuthRoutes(
  authConfig: AuthConfig,
  dbLayer: Layer.Layer<Db> = DbLive,
  /**
   * Optional observability layer. When provided, per-request Effect pipelines
   * (including `Effect.logDebug` in the dev-mode OTP / magic-link branches
   * inside `auth.ts`) run with the application's logger + tracing wiring. When
   * omitted, defaults to `Layer.empty` — the service still runs correctly but
   * debug-level logs are dropped by Effect's default logger, so dev OTP/magic
   * values are not visible unless the host application wires this in. See
   * `osn/app/src/index.ts` for the canonical wiring.
   */
  loggerLayer: Layer.Layer<never> = Layer.empty,
) {
  const auth = createAuthService(authConfig);

  const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(dbLayer), Effect.provide(loggerLayer)) as Effect.Effect<
        A,
        never,
        never
      >,
    );

  /**
   * Resolves the authenticated principal for /passkey/register/* calls. The
   * caller may present an Authorization header containing either a normal
   * access token (existing user) or an enrollment token (new user from the
   * registration flow). When the header is present and verifies, the
   * resulting userId is compared against `bodyUserId` and a mismatch returns
   * `{ unauthorized: true }`.
   *
   * When the header is absent, the route falls back to the legacy unauth'd
   * path that simply trusts `bodyUserId`. This is preserved only for the
   * hosted /authorize HTML page (`buildAuthorizeHtml`); see the security
   * backlog for the removal plan.
   */
  type Principal = { unauthorized: true } | { unauthorized: false; userId: string };
  async function resolvePasskeyEnrollPrincipal(
    authHeader: string | undefined,
    bodyUserId: string,
    options: { consume: boolean } = { consume: false },
  ): Promise<Principal> {
    if (authHeader && /^Bearer\s+/i.test(authHeader)) {
      const token = authHeader.replace(/^Bearer\s+/i, "");

      // Try as a normal access token first.
      const accessResult = await Effect.runPromise(Effect.either(auth.verifyAccessToken(token)));
      if (accessResult._tag === "Right") {
        if (accessResult.right.userId !== bodyUserId) return { unauthorized: true };
        return { unauthorized: false, userId: accessResult.right.userId };
      }

      // Otherwise try as an enrollment token (and consume on /complete).
      const enrollResult = await Effect.runPromise(
        Effect.either(auth.verifyEnrollmentToken(token, options)),
      );
      if (enrollResult._tag === "Right") {
        if (enrollResult.right.userId !== bodyUserId) return { unauthorized: true };
        return { unauthorized: false, userId: enrollResult.right.userId };
      }

      return { unauthorized: true };
    }

    // Legacy unauth'd path — kept only for the hosted sign-in HTML page.
    // Removal is tracked as S-C1-followup in the security backlog.
    console.warn(
      "[auth] DEPRECATED: /passkey/register/* called without Authorization header — body.userId is being trusted as principal. This path will be removed; see security backlog (S-C1-followup).",
    );
    return { unauthorized: false, userId: bodyUserId };
  }

  return (
    new Elysia({ prefix: "" })
      // -------------------------------------------------------------------------
      // Handle availability check
      // -------------------------------------------------------------------------
      .get(
        "/handle/:handle",
        async ({ params, set }) => {
          try {
            const result = await run(auth.checkHandle(params.handle));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          params: t.Object({ handle: t.String() }),
        },
      )
      // -------------------------------------------------------------------------
      // Registration
      // -------------------------------------------------------------------------
      .post(
        "/register",
        async ({ body, set }) => {
          try {
            const user = await run(auth.registerUser(body.email, body.handle, body.displayName));
            set.status = 201;
            return { userId: user.id, handle: user.handle, email: user.email };
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({
            email: t.String(),
            handle: t.String(),
            displayName: t.Optional(t.String()),
          }),
        },
      )
      // -------------------------------------------------------------------------
      // Email-verified registration: begin (sends OTP, does not create user)
      //
      // Always returns `{ sent: true }` (or a public error code on validation
      // failure) regardless of whether the email/handle is already taken —
      // this removes the user-enumeration oracle (S-M1).
      // -------------------------------------------------------------------------
      .post(
        "/register/begin",
        async ({ body, set }) => {
          try {
            return await run(auth.beginRegistration(body.email, body.handle, body.displayName));
          } catch (e) {
            const { status, body: errBody } = publicError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            email: t.String(),
            handle: t.String(),
            displayName: t.Optional(t.String()),
          }),
        },
      )
      // -------------------------------------------------------------------------
      // Email-verified registration: complete (verifies OTP, creates user)
      //
      // Returns access + refresh tokens directly (no `/token` round-trip) plus
      // a single-use enrollment_token the client uses to authenticate the
      // subsequent passkey-enrolment calls.
      // -------------------------------------------------------------------------
      .post(
        "/register/complete",
        async ({ body, set }) => {
          try {
            const result = await run(auth.completeRegistration(body.email, body.code));
            set.status = 201;
            return {
              userId: result.userId,
              handle: result.handle,
              email: result.email,
              session: {
                access_token: result.accessToken,
                refresh_token: result.refreshToken,
                token_type: "Bearer",
                expires_in: result.expiresIn,
                scope: "openid profile",
              },
              enrollment_token: result.enrollmentToken,
            };
          } catch (e) {
            const { status, body: errBody } = publicError(e);
            set.status = status;
            return errBody;
          }
        },
        {
          body: t.Object({
            email: t.String(),
            code: t.String(),
          }),
        },
      )
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
      //
      // Authorization model:
      //  - Preferred: client sends `Authorization: Bearer <token>`. Token is
      //    either a normal access token (existing user adding a passkey from
      //    a settings screen) or an enrollment token (new user from the
      //    registration flow). The principal's userId is taken from the token
      //    and the request body's `userId` MUST match.
      //  - Legacy: no header. The route trusts `body.userId` as-is. This is
      //    insecure and is tracked for removal in the security backlog (the
      //    hosted /authorize HTML page is the last remaining caller). A
      //    deprecation warning is logged on every legacy hit.
      // -------------------------------------------------------------------------
      .post(
        "/passkey/register/begin",
        async ({ body, set, headers }) => {
          try {
            const principal = await resolvePasskeyEnrollPrincipal(
              headers.authorization,
              body.userId,
            );
            if (principal.unauthorized) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const result = await run(auth.beginPasskeyRegistration(principal.userId));
            return result.options;
          } catch (e) {
            const { status, body: errBody } = publicError(e);
            set.status = status;
            return errBody;
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
        async ({ body, set, headers }) => {
          try {
            const principal = await resolvePasskeyEnrollPrincipal(
              headers.authorization,
              body.userId,
              { consume: true },
            );
            if (principal.unauthorized) {
              set.status = 401;
              return { error: "unauthorized" };
            }
            const result = await run(
              auth.completePasskeyRegistration(principal.userId, body.attestation),
            );
            return result;
          } catch (e) {
            const { status, body: errBody } = publicError(e);
            set.status = status;
            return errBody;
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
      // Passkey: begin login (identifier = email or handle)
      // -------------------------------------------------------------------------
      .post(
        "/passkey/login/begin",
        async ({ body, set }) => {
          try {
            const result = await run(auth.beginPasskeyLogin(body.identifier));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({ identifier: t.String() }),
        },
      )
      // -------------------------------------------------------------------------
      // Passkey: complete login (identifier = email or handle)
      // -------------------------------------------------------------------------
      .post(
        "/passkey/login/complete",
        async ({ body, set }) => {
          try {
            const result = await run(auth.completePasskeyLogin(body.identifier, body.assertion));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({
            identifier: t.String(),
            assertion: t.Any(),
          }),
        },
      )
      // -------------------------------------------------------------------------
      // OTP: begin (identifier = email or handle)
      // -------------------------------------------------------------------------
      .post(
        "/otp/begin",
        async ({ body, set }) => {
          try {
            const result = await run(auth.beginOtp(body.identifier));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({ identifier: t.String() }),
        },
      )
      // -------------------------------------------------------------------------
      // OTP: complete (identifier = email or handle)
      // -------------------------------------------------------------------------
      .post(
        "/otp/complete",
        async ({ body, set }) => {
          try {
            const result = await run(auth.completeOtp(body.identifier, body.code));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({ identifier: t.String(), code: t.String() }),
        },
      )
      // -------------------------------------------------------------------------
      // Magic link: begin (identifier = email or handle)
      // -------------------------------------------------------------------------
      .post(
        "/magic/begin",
        async ({ body, set }) => {
          try {
            const result = await run(auth.beginMagic(body.identifier));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({ identifier: t.String() }),
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
      // =========================================================================
      // First-party direct-session login endpoints
      //
      // These mirror the /register/* flow: they return a Session + PublicUser
      // directly, skipping the PKCE authorization-code round-trip. The hosted
      // HTML flow at /authorize continues to use the code-returning variants
      // above for third-party OAuth clients.
      //
      // Enumeration safety: /login/otp/begin and /login/magic/begin always
      // return { sent: true } regardless of whether the identifier exists, so
      // an attacker can't probe the handle/email namespace through them. The
      // legitimate existence-check channel remains GET /handle/:handle.
      // =========================================================================
      .post(
        "/login/passkey/begin",
        async ({ body, set }) => {
          try {
            const result = await run(auth.beginPasskeyLogin(body.identifier));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({ identifier: t.String() }),
        },
      )
      .post(
        "/login/passkey/complete",
        async ({ body, set }) => {
          try {
            const result = await run(
              auth.completePasskeyLoginDirect(body.identifier, body.assertion),
            );
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({
            identifier: t.String(),
            assertion: t.Any(),
          }),
        },
      )
      .post(
        "/login/otp/begin",
        async ({ body }) => {
          // Always opaque: on unknown identifier, the service throws, we
          // swallow the error, and the client still gets { sent: true }. This
          // prevents the endpoint from doubling as a user-existence oracle.
          try {
            await run(auth.beginOtp(body.identifier));
          } catch {
            /* swallowed on purpose */
          }
          return { sent: true as const };
        },
        {
          body: t.Object({ identifier: t.String() }),
        },
      )
      .post(
        "/login/otp/complete",
        async ({ body, set }) => {
          try {
            const result = await run(auth.completeOtpDirect(body.identifier, body.code));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          body: t.Object({ identifier: t.String(), code: t.String() }),
        },
      )
      .post(
        "/login/magic/begin",
        async ({ body }) => {
          // Same enumeration-safety treatment as /login/otp/begin.
          try {
            await run(auth.beginMagic(body.identifier));
          } catch {
            /* swallowed on purpose */
          }
          return { sent: true as const };
        },
        {
          body: t.Object({ identifier: t.String() }),
        },
      )
      .get(
        "/login/magic/verify",
        async ({ query, set }) => {
          try {
            const result = await run(auth.verifyMagicDirect(query.token));
            return result;
          } catch (e) {
            set.status = 400;
            return { error: String(e) };
          }
        },
        {
          query: t.Object({ token: t.String() }),
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
