/**
 * Shared TypeBox response schemas for the auth route groups.
 *
 * These exist for one reason: `@elysiajs/openapi` can only describe a
 * response it has a schema for. Without them every operation in
 * `shared/openapi/osn.json` generates with an empty `responses` object,
 * and a generated client (Swift, TS, anything) gets back `Void`.
 *
 * Two things to know before adding one.
 *
 * 1. Elysia VALIDATES and CLEANS against `response:` at runtime. A key the
 *    schema doesn't declare is deleted from the body before it is sent, and
 *    a value that doesn't type-check 500s the route. A wrong schema here is
 *    a silent data-loss bug, not a docs bug. Model what the handler actually
 *    returns, not what you wish it returned.
 * 2. The schema is checked against the PRE-serialisation value. A `Date`
 *    never satisfies `t.String({ format: "date-time" })` — the handler has
 *    to `.toISOString()` first.
 */

import { t } from "elysia";

/**
 * The uniform public error envelope. Every auth handler funnels failures
 * through `publicError` (`lib/public-error.ts`), the rate-limit gate, or
 * the Turnstile gate, and all three emit `{ error }` with an optional
 * human-readable `message`. Covers 400, 401, 403, 404, 409, 422, 429 and
 * 500 alike, so routes reuse this single const at every error status.
 */
export const errorResponse = t.Object({
  error: t.String(),
  message: t.Optional(t.String()),
});

/**
 * A session envelope WITHOUT the refresh token — the return shape of
 * `toTokenResponseCookieOnly`. The refresh token lives only in the
 * HttpOnly cookie (S-M2), which is why it is absent here and must stay
 * absent: adding it to the schema would not leak it (Elysia only strips,
 * never invents), but it would document a field first-party clients must
 * never look for.
 */
export const tokenResponse = t.Object({
  access_token: t.String(),
  token_type: t.Literal("Bearer"),
  expires_in: t.Number(),
  scope: t.String(),
});

/** `PublicProfile` from `services/auth/types.ts`. */
export const publicProfile = t.Object({
  id: t.String(),
  handle: t.String(),
  email: t.String(),
  displayName: t.Union([t.String(), t.Null()]),
  avatarUrl: t.Union([t.String(), t.Null()]),
});

/** `SessionSummary` from `services/auth/types.ts`. Timestamps are Unix seconds. */
export const sessionSummary = t.Object({
  id: t.String(),
  uaLabel: t.Union([t.String(), t.Null()]),
  createdAt: t.Number(),
  lastUsedAt: t.Union([t.Number(), t.Null()]),
  expiresAt: t.Number(),
  isCurrent: t.Boolean(),
});

/**
 * `PublicKeyCredentialDescriptorJSON` — one entry of `allowCredentials`.
 * `transports` is whatever the authenticator reported at registration, so
 * it is a plain string array rather than an enum: the WebAuthn transport
 * list grows (`hybrid` post-dates `internal`), and an enum here would make
 * a future browser's value fail response validation and 500 the ceremony.
 */
export const publicKeyCredentialDescriptor = t.Object({
  id: t.String(),
  type: t.Literal("public-key"),
  transports: t.Optional(t.Array(t.String())),
});

/**
 * `PublicKeyCredentialRequestOptionsJSON` — the assertion ceremony options
 * handed to `navigator.credentials.get()` on the web and to
 * `ASAuthorizationPlatformPublicKeyCredentialProvider` on iOS.
 *
 * Modelled field by field rather than as `t.Any()` on purpose: `t.Any()`
 * generates an opaque JSON blob in the client, and the iOS client needs
 * `challenge`, `rpId`, `allowCredentials` and `userVerification` as typed
 * values to build a request at all. Only `challenge` is required — the
 * others are optional in the spec, and `@simplewebauthn/server` omits any
 * it wasn't asked for.
 */
export const publicKeyCredentialRequestOptions = t.Object({
  challenge: t.String(),
  timeout: t.Optional(t.Number()),
  rpId: t.Optional(t.String()),
  allowCredentials: t.Optional(t.Array(publicKeyCredentialDescriptor)),
  userVerification: t.Optional(t.String()),
});
