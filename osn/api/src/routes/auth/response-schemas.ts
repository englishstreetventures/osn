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
 * The OAuth/OIDC error envelope — `{ error, error_description }` per RFC 6749
 * §5.2, which is NOT the `{ error, message }` shape the rest of this API uses.
 *
 * Both keys of both shapes are declared here because the OIDC routes emit both
 * envelopes at the same status. A route's own refusals carry
 * `error_description`; the rate-limit gate and `handleError` fall through the
 * same status with `message`. Elysia deletes any key the schema omits, so a
 * schema carrying only the RFC pair would silently blank the message on a 429
 * or a 500. The superset costs one optional field and cannot lose either.
 */
export const oidcErrorResponse = t.Object({
  error: t.String(),
  error_description: t.Optional(t.String()),
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

/**
 * `PublicKeyCredentialCreationOptionsJSON` — the registration ceremony
 * options handed to `navigator.credentials.create()`.
 *
 * Every field `@simplewebauthn/server@13` can emit is declared, because a
 * field this schema omits is DELETED from the response and the ceremony
 * then fails in the browser rather than in a test. Checked against
 * `generateRegistrationOptions`' literal return: `challenge`, `rp`, `user`,
 * `pubKeyCredParams`, `timeout`, `attestation`, `excludeCredentials`,
 * `authenticatorSelection`, `extensions` and `hints`. `attestationFormats`
 * is in the type but not in that return — declared anyway, so a library
 * upgrade that starts emitting it doesn't silently drop it.
 *
 * The enum-ish members (`attestation`, `residentKey`, `userVerification`,
 * `hints`, transports) stay plain strings for the same reason as
 * `publicKeyCredentialDescriptor.transports`: WebAuthn's vocabularies grow,
 * and a value outside a hard-coded enum would 500 the ceremony.
 */
export const publicKeyCredentialCreationOptions = t.Object({
  rp: t.Object({ name: t.String(), id: t.Optional(t.String()) }),
  user: t.Object({ id: t.String(), name: t.String(), displayName: t.String() }),
  challenge: t.String(),
  pubKeyCredParams: t.Array(t.Object({ alg: t.Number(), type: t.Literal("public-key") })),
  timeout: t.Optional(t.Number()),
  excludeCredentials: t.Optional(t.Array(publicKeyCredentialDescriptor)),
  authenticatorSelection: t.Optional(
    t.Object({
      authenticatorAttachment: t.Optional(t.String()),
      requireResidentKey: t.Optional(t.Boolean()),
      residentKey: t.Optional(t.String()),
      userVerification: t.Optional(t.String()),
    }),
  ),
  hints: t.Optional(t.Array(t.String())),
  attestation: t.Optional(t.String()),
  attestationFormats: t.Optional(t.Array(t.String())),
  // `credProps` is injected unconditionally by the library. Other extensions
  // are client-input blobs with no fixed shape, so the object passes them
  // through instead of enumerating a spec surface that changes per browser.
  extensions: t.Optional(
    t.Object({ credProps: t.Optional(t.Boolean()) }, { additionalProperties: true }),
  ),
});

/** `PasskeySummary` from `services/auth/types.ts`. Timestamps are Unix seconds. */
export const passkeySummary = t.Object({
  id: t.String(),
  label: t.Union([t.String(), t.Null()]),
  aaguid: t.Union([t.String(), t.Null()]),
  transports: t.Union([t.Array(t.String()), t.Null()]),
  backupEligible: t.Union([t.Boolean(), t.Null()]),
  backupState: t.Union([t.Boolean(), t.Null()]),
  createdAt: t.Number(),
  lastUsedAt: t.Union([t.Number(), t.Null()]),
});

/**
 * `SecurityEventSummary` from `services/auth/types.ts`. `kind` is a string
 * rather than an enum of `SecurityEventKind`: the list grows with every new
 * notifiable action, and an unlisted kind would 500 the banner that exists
 * to report exactly that kind of event.
 */
export const securityEventSummary = t.Object({
  id: t.String(),
  kind: t.String(),
  createdAt: t.Number(),
  uaLabel: t.Union([t.String(), t.Null()]),
  ipHash: t.Union([t.String(), t.Null()]),
});

/** Both step-up ceremonies mint the same envelope. `expires_in` is seconds. */
export const stepUpTokenResponse = t.Object({
  step_up_token: t.String(),
  expires_in: t.Number(),
});

/**
 * `OwnedClientSummary` from `services/auth/oidc.ts` — a relying party as shown
 * to the account that registered it. `confidential` is derived (a secret hash
 * exists), never the hash itself. Timestamps are Unix seconds.
 */
export const ownedClientSummary = t.Object({
  clientId: t.String(),
  name: t.String(),
  logoUrl: t.Union([t.String(), t.Null()]),
  redirectUris: t.Array(t.String()),
  sectorIdentifier: t.String(),
  confidential: t.Boolean(),
  createdAt: t.Number(),
  disabledAt: t.Union([t.Number(), t.Null()]),
});

/**
 * `OidcConnectionSummary` from `services/auth/oidc.ts` — one row of "apps you
 * have authorised". `clientName` is nullable only for a consent whose client
 * row was deleted underneath it.
 */
export const oidcConnectionSummary = t.Object({
  clientId: t.String(),
  clientName: t.Union([t.String(), t.Null()]),
  logoUrl: t.Union([t.String(), t.Null()]),
  profileId: t.String(),
  scope: t.String(),
  grantedAt: t.Number(),
});

/**
 * `OidcTokenResponse` from `services/auth/oidc.ts`. Deliberately unlike
 * `tokenResponse` above: this one carries an `id_token` and never a refresh
 * token, and its access token never holds the `osn-access` audience, so a
 * relying party's token cannot reach a first-party route.
 */
export const oidcTokenResponse = t.Object({
  access_token: t.String(),
  id_token: t.String(),
  token_type: t.Literal("Bearer"),
  expires_in: t.Number(),
  scope: t.String(),
});
