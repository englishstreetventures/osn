import { Elysia, t } from "elysia";
import { Effect, Layer } from "effect";
import { DbLive, type Db } from "@osn/db/service";
import { createAuthService, type AuthConfig } from "../services/auth";
import { buildAuthorizeHtml } from "../lib/html";
import { verifyPkceChallenge } from "../lib/crypto";
import { createRateLimiter, getClientIp } from "../lib/rate-limit";
import { metricAuthRateLimited } from "../metrics";
import type { AuthRateLimitedEndpoint } from "@shared/observability/metrics";

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
   * Maps a thrown Effect-tagged error (or anything else) to a stable, public,
   * non-leaky error payload. The full cause is logged server-side for diagnosis,
   * but only opaque codes / sanitised messages cross the wire (S-H5 / S-M6).
   */
  function publicError(e: unknown): { status: number; body: { error: string; message?: string } } {
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

    // Log for operators via the Effect logger (respects redaction + JSON formatting).
    void Effect.runPromise(
      Effect.logError("auth route error").pipe(
        Effect.annotateLogs({ tag: tag ?? "unknown" }),
        Effect.provide(loggerLayer),
      ),
    );

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

  // ---------------------------------------------------------------------------
  // IP-based rate limiters (S-H1)
  // ---------------------------------------------------------------------------

  const rl = {
    registerBegin: createRateLimiter({ maxRequests: 5, windowMs: 60_000 }),
    registerComplete: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    handleCheck: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    otpBegin: createRateLimiter({ maxRequests: 5, windowMs: 60_000 }),
    otpComplete: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    magicBegin: createRateLimiter({ maxRequests: 5, windowMs: 60_000 }),
    magicVerify: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    passkeyLoginBegin: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    passkeyLoginComplete: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    passkeyRegisterBegin: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
    passkeyRegisterComplete: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
  } as const;

  function rateLimit(
    headers: Record<string, string | undefined>,
    endpoint: AuthRateLimitedEndpoint,
    limiter: ReturnType<typeof createRateLimiter>,
  ): { error: string } | null {
    const ip = getClientIp(headers);
    if (!limiter.check(ip)) {
      metricAuthRateLimited(endpoint);
      return { error: "rate_limited" };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Redirect URI validation (S-H3) — route-level helper for /authorize + /token
  // Pre-computed origin set avoids re-parsing the static allowlist per request (P-W17).
  // ---------------------------------------------------------------------------

  const allowedOrigins = new Set(
    (authConfig.allowedRedirectUris ?? [])
      .map((u) => URL.parse(u)?.origin)
      .filter((o): o is string => o != null),
  );

  function isAllowedRedirectUri(uri: string): boolean {
    if (allowedOrigins.size === 0) return true;
    const parsed = URL.parse(uri);
    if (!parsed) return false;
    return allowedOrigins.has(parsed.origin);
  }

  /**
   * Resolves the authenticated principal for /passkey/register/* calls (S-H5).
   * Authorization header is REQUIRED — the legacy unauth'd path has been removed.
   * The caller must present either a normal access token or an enrollment token.
   */
  type Principal = { unauthorized: true } | { unauthorized: false; userId: string };
  async function resolvePasskeyEnrollPrincipal(
    authHeader: string | undefined,
    bodyUserId: string,
    options: { consume: boolean } = { consume: false },
  ): Promise<Principal> {
    if (!authHeader || !/^Bearer\s+/i.test(authHeader)) {
      return { unauthorized: true };
    }

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

  return (
    new Elysia({ prefix: "" })
      // -------------------------------------------------------------------------
      // Handle availability check
      // -------------------------------------------------------------------------
      .get(
        "/handle/:handle",
        async ({ params, set, headers }) => {
          const rlErr = rateLimit(headers, "handle_check", rl.handleCheck);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
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
        async ({ body, set, headers }) => {
          const rlErr = rateLimit(headers, "register_begin", rl.registerBegin);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
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
        async ({ body, set, headers }) => {
          const rlErr = rateLimit(headers, "register_complete", rl.registerComplete);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
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

          // S-H3: validate redirect_uri against allowlist
          if (!isAllowedRedirectUri(redirect_uri)) {
            set.status = 400;
            return { error: "invalid_request", message: "redirect_uri not allowed" };
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
              state: string;
            };

            // S-H4: PKCE is mandatory for authorization_code grants
            if (!code || !redirect_uri || !client_id || !code_verifier || !state) {
              set.status = 400;
              return { error: "invalid_request", message: "PKCE parameters required" };
            }

            // S-H3: validate redirect_uri against allowlist
            if (!isAllowedRedirectUri(redirect_uri)) {
              set.status = 400;
              return { error: "invalid_request", message: "redirect_uri not allowed" };
            }

            const pkce = pkceStore.get(state);
            if (!pkce) {
              set.status = 400;
              return { error: "invalid_grant", message: "Unknown state" };
            }

            if (Date.now() > pkce.expiresAt) {
              pkceStore.delete(state);
              set.status = 400;
              return { error: "invalid_grant", message: "State expired" };
            }

            // S-M9: redirect_uri must match the value stored at /authorize (RFC 6749 §4.1.3)
            if (pkce.redirectUri !== redirect_uri) {
              pkceStore.delete(state);
              set.status = 400;
              return { error: "invalid_grant", message: "redirect_uri mismatch" };
            }

            const valid = await verifyPkceChallenge(code_verifier, pkce.codeChallenge);
            if (!valid) {
              set.status = 400;
              return { error: "invalid_grant", message: "PKCE verification failed" };
            }
            pkceStore.delete(state);

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
      // Passkey: begin registration (S-H5: Authorization header required)
      //
      // Client sends `Authorization: Bearer <token>`. Token is either a
      // normal access token (existing user adding a passkey from a settings
      // screen) or an enrollment token (new user from the registration flow).
      // The principal's userId is taken from the token and the request body's
      // `userId` MUST match. Unauthenticated requests return 401.
      // -------------------------------------------------------------------------
      .post(
        "/passkey/register/begin",
        async ({ body, set, headers }) => {
          const rlErr = rateLimit(headers, "passkey_register_begin", rl.passkeyRegisterBegin);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
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
      // Passkey: complete registration (S-H5: Authorization header required)
      // -------------------------------------------------------------------------
      .post(
        "/passkey/register/complete",
        async ({ body, set, headers }) => {
          const rlErr = rateLimit(headers, "passkey_register_complete", rl.passkeyRegisterComplete);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
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
        async ({ body, set, headers }) => {
          const rlErr = rateLimit(headers, "passkey_login_begin", rl.passkeyLoginBegin);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
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
        async ({ body, set, headers }) => {
          const rlErr = rateLimit(headers, "passkey_login_complete", rl.passkeyLoginComplete);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
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
        async ({ body, set, headers }) => {
          const rlErr = rateLimit(headers, "otp_begin", rl.otpBegin);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
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
        async ({ body, set, headers }) => {
          const rlErr = rateLimit(headers, "otp_complete", rl.otpComplete);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
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
        async ({ body, set, headers }) => {
          const rlErr = rateLimit(headers, "magic_begin", rl.magicBegin);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
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
        async ({ query, set, headers }) => {
          const rlErr = rateLimit(headers, "magic_verify", rl.magicVerify);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
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
        async ({ body, set, headers }) => {
          const rlErr = rateLimit(headers, "passkey_login_begin", rl.passkeyLoginBegin);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
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
        async ({ body, set, headers }) => {
          const rlErr = rateLimit(headers, "passkey_login_complete", rl.passkeyLoginComplete);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
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
        async ({ body, set, headers }) => {
          const rlErr = rateLimit(headers, "otp_begin", rl.otpBegin);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
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
        async ({ body, set, headers }) => {
          const rlErr = rateLimit(headers, "otp_complete", rl.otpComplete);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
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
        async ({ body, set, headers }) => {
          const rlErr = rateLimit(headers, "magic_begin", rl.magicBegin);
          if (rlErr) {
            set.status = 429;
            return rlErr;
          }
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
