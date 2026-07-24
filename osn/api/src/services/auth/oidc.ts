/**
 * OIDC provider — relying-party registry, authorization codes, consent
 * records, and the authorization-code token exchange.
 *
 * Why the redirect flow rather than Related Origin Requests: a passkey is
 * bound to one RP ID for life, and browsers cap Related Origin Requests at
 * five registrable labels. Sending the user to the issuer's own origin, where
 * the RP ID already matches, removes both limits at once — the relying party
 * never touches `navigator.credentials`, so the number of relying parties we
 * can serve is unbounded.
 *
 * Two properties hold throughout and are worth stating up front:
 *
 *  - **Recognition, never automatic linking.** A relying party that has never
 *    been approved gets `consent_required`, not a code. The consent screen is
 *    the moment the user chooses to link, and `oauth_consents` is the record
 *    of that choice.
 *  - **Pairwise subjects.** Each sector sees its own `sub` for the same
 *    person, derived from the profile id — not the account id — so this
 *    module upholds the same P6 invariant as the access token: nothing we hand
 *    out lets an outside observer join two profiles into one account.
 *
 * See [[wiki/systems/oidc-provider]].
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { oauthAuthorizationCodes, oauthClients, oauthConsents } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { and, eq, isNull, lte } from "drizzle-orm";
import { Effect } from "effect";

import {
  AUTHORIZATION_CODE_TTL_SEC,
  AUTHORIZE_REQUEST_TTL_MS,
  ID_TOKEN_TTL_SEC,
  isReservedOidcClientId,
  MAX_OIDC_CLIENTS_PER_ACCOUNT,
  OIDC_CLIENT_MAX_REDIRECT_URIS,
  OIDC_CLIENT_NAME_MAX_LENGTH,
  OIDC_CLIENT_URI_MAX_LENGTH,
  OIDC_MAX_AGE_CEILING_SEC,
  OIDC_PARAM_MAX_LENGTH,
} from "./constants";
import type { AuthContext } from "./context";
import { DatabaseError, OidcError, type OidcErrorCode } from "./errors";
import { genId, signJwt } from "./helpers";
import type { ProfilesModule } from "./profiles";
import type { PendingAuthorizeRequest } from "./stores";

/** A relying party as the rest of the service sees it. */
export interface OidcClient {
  id: string;
  clientId: string;
  name: string;
  logoUrl: string | null;
  redirectUris: string[];
  clientSecretHash: string | null;
  sectorIdentifier: string;
  allowedScopes: string;
  isFirstParty: boolean;
}

/**
 * The raw `/authorize` query, already pulled out of the URL. Every field is
 * exactly what the relying party sent — nothing here is trusted yet.
 */
export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  responseType: string;
  scope: string | null;
  state: string | null;
  nonce: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string;
  prompt: string | null;
  /** Raw `max_age` query value — validated (digits, bounded) before use. */
  maxAge: string | null;
}

/** A request that has survived validation. Every field is safe to act on. */
export interface ValidatedAuthorizeRequest {
  client: OidcClient;
  redirectUri: string;
  scope: string;
  state: string | null;
  nonce: string | null;
  codeChallenge: string;
  /** Seconds, already parsed and bounded. Null when the client didn't ask. */
  maxAge: number | null;
}

/** The device's session as `/authorize` sees it: who, and since when. */
export interface AuthorizeSession {
  accountId: string;
  /** Unix seconds — when the session was created, i.e. the real auth_time. */
  authTime: number;
}

/**
 * Validation result. The `error` arm carries a redirect URI we have already
 * confirmed belongs to the client, which is exactly why it is a value and not
 * a failure — see `validateAuthorizeRequest`.
 */
export type AuthorizeValidation =
  | { kind: "ok"; request: ValidatedAuthorizeRequest; prompts: Set<string> }
  | {
      kind: "error";
      client: OidcClient;
      redirectUri: string;
      state: string | null;
      code: OidcErrorCode;
      description: string;
    };

/** What a validated request needs next. */
export type AuthorizeOutcome =
  | { kind: "code"; code: string }
  | {
      kind: "interaction";
      requestId: string;
      reason: "login" | "select_account" | "consent";
      /**
       * Raw browser-binding secret (S-M1 oidc). The route sets it as a
       * short-TTL HttpOnly cookie; only its hash is parked server-side.
       */
      bindingSecret: string;
    }
  | { kind: "error"; code: OidcErrorCode; description: string };

/** The user's answer to a consent screen. */
export interface DecisionInput {
  requestId: string;
  accountId: string;
  profileId: string;
  approved: boolean;
  /** Unix seconds — creation time of the session making the decision. */
  authTime: number;
  /** The binding cookie's value, or null when the browser sent none. */
  bindingSecret: string | null;
}

/** Where to send the browser next, plus whether this was a first-time link. */
export interface DecisionResult {
  redirectTo: string;
  isNewLink: boolean;
  /** For the consent-granted metric — meaningful only when `isNewLink`. */
  isFirstParty: boolean;
}

/** Everything an authorization code binds at issue time. */
export interface IssueCodeInput {
  clientId: string;
  accountId: string;
  profileId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  nonce: string | null;
  /** Unix seconds — when the user authenticated, NOT when the code minted. */
  authTime: number;
}

/** A token-endpoint request, already parsed out of the form body / auth header. */
export interface ExchangeInput {
  clientId: string;
  clientSecret: string | null;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

/** What the token endpoint hands back on a successful exchange. */
export interface OidcTokenResponse {
  access_token: string;
  id_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

/**
 * A successful exchange plus the metric dimension the route needs, so the
 * route does not have to re-read the client purely to label a counter
 * (P-W1 oidc).
 */
export interface ExchangeResult {
  response: OidcTokenResponse;
  isFirstParty: boolean;
}

/** What `POST /oidc/clients` accepts, already shape-validated by TypeBox. */
export interface ClientRegistrationInput {
  ownerAccountId: string;
  name: string;
  redirectUris: string[];
  logoUrl: string | null;
  /** True mints a client secret (server-side RP); false is a public client. */
  confidential: boolean;
}

/** A registered client as shown to its owner. Never the secret hash. */
export interface OwnedClientSummary {
  clientId: string;
  name: string;
  logoUrl: string | null;
  redirectUris: string[];
  sectorIdentifier: string;
  /** True when a secret exists (confidential client). */
  confidential: boolean;
  createdAt: number;
  disabledAt: number | null;
}

/** The one-time registration response: summary plus the raw secret, once. */
export interface ClientRegistrationResult {
  client: OwnedClientSummary;
  /** Shown exactly once; only its SHA-256 is stored. Null for public clients. */
  clientSecret: string | null;
}

/** One row of the user-facing "apps you have authorised" list (S-M3 oidc). */
export interface OidcConnectionSummary {
  clientId: string;
  /** Null only if the client row was hand-deleted out from under the consent. */
  clientName: string | null;
  logoUrl: string | null;
  profileId: string;
  scope: string;
  /** Unix seconds. */
  grantedAt: number;
}

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

const parseScope = (scope: string): string[] =>
  scope
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** Requested scopes narrowed to what the client is allowed, order preserved. */
export function narrowScope(requested: string, allowed: string): string {
  const permitted = new Set(parseScope(allowed));
  const kept = parseScope(requested).filter((s) => permitted.has(s));
  return [...new Set(kept)].join(" ");
}

/** True when `granted` covers every scope in `requested`. */
export function scopeCovers(granted: string, requested: string): boolean {
  const have = new Set(parseScope(granted));
  return parseScope(requested).every((s) => have.has(s));
}

/** Union of two scope strings, for widening an existing consent. */
export function mergeScope(a: string, b: string): string {
  return [...new Set([...parseScope(a), ...parseScope(b)])].join(" ");
}

// ---------------------------------------------------------------------------
// Small crypto helpers
// ---------------------------------------------------------------------------

const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");

const base64Url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Constant-time comparison of two hex digests. Both sides are already hashes,
 * so a timing leak would only expose which prefix of a hash matched — but the
 * comparison costs nothing to do properly.
 */
const hexEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
};

/**
 * A raw authorization code: 32 random bytes (256-bit), base64url, `cod_`
 * prefixed. Only its SHA-256 is stored, exactly as session tokens are handled
 * — a database leak yields nothing redeemable.
 */
const generateAuthorizationCode = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "cod_" + base64Url(Buffer.from(bytes));
};

/**
 * The browser-binding secret for a parked request (S-M1 oidc): 32 random
 * bytes, base64url, `oab_` prefixed. Travels only in an HttpOnly cookie; the
 * ceremony store holds its SHA-256.
 */
const generateBindingSecret = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "oab_" + base64Url(Buffer.from(bytes));
};

/**
 * Semantic validation for client registration, beyond the TypeBox shape.
 * Pure and exported so the rules are unit-testable and reusable by any future
 * admin surface. Returns the normalised inputs on success — trimmed name,
 * deduplicated URIs — or the first human-readable problem.
 *
 * The rules exist because every one of them is an attack surface:
 *  - redirect URIs are the open-redirect / code-theft boundary — https only
 *    (http tolerated solely for loopback development), no fragments (RFC 6749
 *    §3.1.2), exact strings, bounded count and length;
 *  - `logo_url` flows into the first-party consent/connections UI as an image
 *    `src`, so a non-https scheme is a stored-XSS-adjacent foothold;
 *  - the name renders on the consent screen, so it is length-bounded.
 *
 * `client_id` is server-generated (`cid_` + random), so the reserved-id
 * deny-list cannot collide by construction — `findClient` still enforces it
 * as defence in depth for hand-seeded rows.
 */
export function validateClientRegistration(input: {
  name: string;
  redirectUris: string[];
  logoUrl: string | null;
}):
  | { ok: true; name: string; redirectUris: string[]; logoUrl: string | null }
  | { ok: false; message: string } {
  const name = input.name.trim();
  if (name.length === 0 || name.length > OIDC_CLIENT_NAME_MAX_LENGTH) {
    return { ok: false, message: `name must be 1–${OIDC_CLIENT_NAME_MAX_LENGTH} characters` };
  }

  const uris = [...new Set(input.redirectUris)];
  if (uris.length === 0 || uris.length > OIDC_CLIENT_MAX_REDIRECT_URIS) {
    return {
      ok: false,
      message: `between 1 and ${OIDC_CLIENT_MAX_REDIRECT_URIS} redirect URIs are required`,
    };
  }
  for (const uri of uris) {
    if (uri.length > OIDC_CLIENT_URI_MAX_LENGTH) {
      return { ok: false, message: "redirect URI exceeds the maximum length" };
    }
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return { ok: false, message: `redirect URI is not a valid URL: ${uri}` };
    }
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
      return { ok: false, message: "redirect URIs must be https (http only for loopback)" };
    }
    if (parsed.hash !== "") {
      return { ok: false, message: "redirect URIs must not carry a fragment" };
    }
  }

  const logoUrl = input.logoUrl;
  if (logoUrl !== null) {
    if (logoUrl.length > OIDC_CLIENT_URI_MAX_LENGTH) {
      return { ok: false, message: "logo_url exceeds the maximum length" };
    }
    let parsed: URL;
    try {
      parsed = new URL(logoUrl);
    } catch {
      return { ok: false, message: "logo_url is not a valid URL" };
    }
    if (parsed.protocol !== "https:") {
      return { ok: false, message: "logo_url must be https" };
    }
  }

  return { ok: true, name, redirectUris: uris, logoUrl };
}

/** A relying-party secret, shown once at registration and never stored raw. */
export function generateClientSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "cs_" + base64Url(Buffer.from(bytes));
}

export function hashClientSecret(secret: string): string {
  return sha256Hex(secret);
}

/**
 * Deletes every authorization code whose lifetime has elapsed.
 *
 * A code is normally cleared the instant it is redeemed (`consumeAuthorizationCode`
 * DELETEs it), so this only reaps codes that were minted and never exchanged —
 * an abandoned sign-in, or a request pointed at the endpoint purely to write a
 * row. Nothing else removes those: the redemption DELETE never fires for them,
 * and the 60-second lifetime means every such row is dead within a minute of
 * being written. Left unswept they accumulate without bound and are cheap to
 * drive, so a scheduled pass keeps the table to only live codes. Uses the
 * `oauth_codes_expires_idx` range index rather than a scan.
 *
 * Standalone (not a member of the module closure) so the Workers `scheduled`
 * handler can call it beside the account-deletion sweeps, taking `Db` from the
 * same layer.
 */
export const runExpiredAuthCodeSweep = (
  opts: { nowMs?: number } = {},
): Effect.Effect<{ deleted: number }, DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
    const deleted = yield* Effect.tryPromise({
      try: () =>
        db
          .delete(oauthAuthorizationCodes)
          .where(lte(oauthAuthorizationCodes.expiresAt, nowSec))
          .returning({ id: oauthAuthorizationCodes.id }),
      catch: (cause) => new DatabaseError({ cause }),
    });
    return { deleted: deleted.length };
  });

export function createOidcModule(ctx: AuthContext, profiles: ProfilesModule) {
  const { config } = ctx;
  const { findDefaultProfile, findProfileById } = profiles;

  // -------------------------------------------------------------------------
  // Relying-party registry
  // -------------------------------------------------------------------------

  const rowToClient = (
    row: Omit<typeof oauthClients.$inferSelect, "createdAt" | "disabledAt" | "ownerAccountId">,
  ): OidcClient => ({
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    logoUrl: row.logoUrl,
    redirectUris: row.redirectUris,
    clientSecretHash: row.clientSecretHash,
    sectorIdentifier: row.sectorIdentifier,
    allowedScopes: row.allowedScopes,
    isFirstParty: row.isFirstParty,
  });

  /**
   * Looks up an enabled relying party. Disabled clients read as absent, and so
   * does any client whose id collides with a reserved first-party or S2S
   * audience (S-M2 oidc) — a row seeded under such a name could mint OIDC
   * access tokens whose `aud` an internal verifier pins, so the registry
   * refuses to see it no matter how it got written.
   */
  const findClient = (clientId: string): Effect.Effect<OidcClient | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      if (isReservedOidcClientId(clientId)) return null;
      const { db } = yield* Db;
      // P-I3: explicit projection — `rowToClient` names every column it uses,
      // plus `disabledAt` for the liveness check.
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: oauthClients.id,
              clientId: oauthClients.clientId,
              name: oauthClients.name,
              logoUrl: oauthClients.logoUrl,
              redirectUris: oauthClients.redirectUris,
              clientSecretHash: oauthClients.clientSecretHash,
              sectorIdentifier: oauthClients.sectorIdentifier,
              allowedScopes: oauthClients.allowedScopes,
              isFirstParty: oauthClients.isFirstParty,
              disabledAt: oauthClients.disabledAt,
            })
            .from(oauthClients)
            .where(eq(oauthClients.clientId, clientId))
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = rows[0];
      if (!row || row.disabledAt !== null) return null;
      return rowToClient(row);
    });

  /**
   * Authenticates a confidential client. Public clients (no stored secret)
   * authenticate by PKCE alone and MUST NOT present a secret — accepting one
   * would let a client silently downgrade from proof-of-possession to a shared
   * string an attacker may have read out of a mobile binary.
   */
  const authenticateClient = (client: OidcClient, secret: string | null): boolean => {
    if (client.clientSecretHash === null) return secret === null;
    if (secret === null) return false;
    return hexEqual(client.clientSecretHash, hashClientSecret(secret));
  };

  /**
   * Exact-match redirect URI check. No wildcards, no prefix matching, no
   * trailing-slash forgiveness: every relaxation of this rule has produced a
   * real-world account-takeover chain.
   */
  const isRegisteredRedirectUri = (client: OidcClient, redirectUri: string): boolean =>
    client.redirectUris.includes(redirectUri);

  /**
   * Registers a relying party owned by `ownerAccountId` (self-serve — the
   * TODO's "organiser-facing route"). Inputs are assumed to have passed
   * {@link validateClientRegistration}; this function owns only the parts
   * that need the database: the per-account cap, id/secret generation, and
   * the insert.
   *
   * Deliberate properties:
   *  - `client_id` is server-generated, so it can never collide with a
   *    reserved audience and carries no user-chosen content;
   *  - the secret is returned exactly once and stored only as SHA-256;
   *  - `sector_identifier` is derived from the first redirect URI's host —
   *    self-serve clients cannot choose their sector, because choosing a
   *    shared sector is how two colluding clients would defeat pairwise
   *    subject isolation;
   *  - `is_first_party` is never settable here. First-party status is a
   *    hand-seeded trust decision, not a registration input.
   */
  const registerClient = (
    input: ClientRegistrationInput,
  ): Effect.Effect<ClientRegistrationResult, OidcError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const live = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ id: oauthClients.id })
            .from(oauthClients)
            .where(
              and(
                eq(oauthClients.ownerAccountId, input.ownerAccountId),
                isNull(oauthClients.disabledAt),
              ),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (live.length >= MAX_OIDC_CLIENTS_PER_ACCOUNT) {
        return yield* Effect.fail(
          new OidcError({
            code: "invalid_request",
            description: `An account may hold at most ${MAX_OIDC_CLIENTS_PER_ACCOUNT} active clients`,
          }),
        );
      }

      const clientId = genId("cid_");
      const clientSecret = input.confidential ? generateClientSecret() : null;
      const nowSec = Math.floor(Date.now() / 1000);
      const sectorIdentifier = new URL(input.redirectUris[0]!).host;

      yield* Effect.tryPromise({
        try: () =>
          db.insert(oauthClients).values({
            id: genId("oc_"),
            clientId,
            name: input.name,
            logoUrl: input.logoUrl,
            redirectUris: input.redirectUris,
            clientSecretHash: clientSecret === null ? null : hashClientSecret(clientSecret),
            sectorIdentifier,
            isFirstParty: false,
            ownerAccountId: input.ownerAccountId,
            createdAt: nowSec,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });

      return {
        client: {
          clientId,
          name: input.name,
          logoUrl: input.logoUrl,
          redirectUris: input.redirectUris,
          sectorIdentifier,
          confidential: clientSecret !== null,
          createdAt: nowSec,
          disabledAt: null,
        },
        clientSecret,
      };
    });

  /** The clients this account registered, newest first. Never the secret hash. */
  const listOwnedClients = (
    accountId: string,
  ): Effect.Effect<OwnedClientSummary[], DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              clientId: oauthClients.clientId,
              name: oauthClients.name,
              logoUrl: oauthClients.logoUrl,
              redirectUris: oauthClients.redirectUris,
              sectorIdentifier: oauthClients.sectorIdentifier,
              clientSecretHash: oauthClients.clientSecretHash,
              createdAt: oauthClients.createdAt,
              disabledAt: oauthClients.disabledAt,
            })
            .from(oauthClients)
            .where(eq(oauthClients.ownerAccountId, accountId))
            .orderBy(oauthClients.createdAt),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return rows.map(({ clientSecretHash, ...rest }) => ({
        ...rest,
        confidential: clientSecretHash !== null,
      }));
    });

  /**
   * Disables an owned client. Disabled clients read as absent everywhere
   * (`findClient`), so `/authorize` refuses new flows and in-flight codes die
   * at the exchange's client lookup. Returns false when the caller owns no
   * live client under that id — the route 404s rather than leaking whether
   * the id exists under someone else's account.
   */
  const disableOwnedClient = (
    accountId: string,
    clientId: string,
  ): Effect.Effect<{ disabled: boolean }, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const updated = yield* Effect.tryPromise({
        try: () =>
          db
            .update(oauthClients)
            .set({ disabledAt: Math.floor(Date.now() / 1000) })
            .where(
              and(
                eq(oauthClients.ownerAccountId, accountId),
                eq(oauthClients.clientId, clientId),
                isNull(oauthClients.disabledAt),
              ),
            )
            .returning({ id: oauthClients.id }),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return { disabled: updated.length > 0 };
    });

  // -------------------------------------------------------------------------
  // Pairwise subject identifiers
  // -------------------------------------------------------------------------

  /**
   * `sub` for a profile as seen by one sector. Derived from the profile id, so
   * two profiles under one account produce unrelated subjects even inside the
   * same sector — the P6 invariant, carried into the OIDC surface.
   *
   * Without a configured salt (local dev only) the derivation still works and
   * is still stable; it is simply not secret. Production wiring requires the
   * salt, so this cannot ship unset.
   */
  const pairwiseSub = (client: OidcClient, profileId: string): string => {
    const salt = config.pairwiseSalt ?? "osn-dev-pairwise-salt";
    const mac = createHmac("sha256", salt)
      .update(`${client.sectorIdentifier}|${profileId}`)
      .digest();
    return "pw_" + base64Url(mac);
  };

  // -------------------------------------------------------------------------
  // Consent records
  // -------------------------------------------------------------------------

  /** The live consent for this pair, or null if never granted or revoked. */
  const findConsent = (
    accountId: string,
    clientId: string,
  ): Effect.Effect<{ id: string; profileId: string; scope: string } | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      // P-I3: three used columns plus the liveness marker, not SELECT *.
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: oauthConsents.id,
              profileId: oauthConsents.profileId,
              scope: oauthConsents.scope,
              revokedAt: oauthConsents.revokedAt,
            })
            .from(oauthConsents)
            .where(
              and(eq(oauthConsents.accountId, accountId), eq(oauthConsents.clientId, clientId)),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = rows[0];
      if (!row || row.revokedAt !== null) return null;
      return { id: row.id, profileId: row.profileId, scope: row.scope };
    });

  /**
   * Records (or widens) a consent. Returns `true` when this is the first link
   * between the account and the relying party, which is the event worth
   * counting — later re-authorizations are not new relationships.
   *
   * Scopes are merged rather than replaced so approving a second, narrower
   * request cannot quietly withdraw a scope the user already granted.
   */
  const recordConsent = (
    accountId: string,
    clientId: string,
    profileId: string,
    scope: string,
  ): Effect.Effect<boolean, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const nowSec = Math.floor(Date.now() / 1000);
      // P-W4: insert-first. A first link — the common case for a growing
      // provider — is one statement; only the re-consent path pays the
      // read-merge-write, because a scope UNION cannot be expressed in the
      // conflict clause.
      const inserted = yield* Effect.tryPromise({
        try: () =>
          db
            .insert(oauthConsents)
            .values({
              id: genId("ocs_"),
              accountId,
              clientId,
              profileId,
              scope,
              grantedAt: nowSec,
            })
            .onConflictDoNothing({ target: [oauthConsents.accountId, oauthConsents.clientId] })
            .returning({ id: oauthConsents.id }),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (inserted.length > 0) return true;

      const existing = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: oauthConsents.id,
              scope: oauthConsents.scope,
              revokedAt: oauthConsents.revokedAt,
            })
            .from(oauthConsents)
            .where(
              and(eq(oauthConsents.accountId, accountId), eq(oauthConsents.clientId, clientId)),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = existing[0];
      if (!row) return false; // Deleted between the two statements — nothing to widen.

      // Merging holds only for LIVE rows (a narrower approval must not shrink
      // an existing grant). Across a revocation boundary the old scope is a
      // withdrawal record, not a grant — resurrecting it would silently
      // re-authorize scopes the consent screen never displayed. A re-grant
      // starts from exactly what the user just approved.
      const nextScope = row.revokedAt !== null ? scope : mergeScope(row.scope, scope);
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(oauthConsents)
            .set({
              profileId,
              scope: nextScope,
              grantedAt: nowSec,
              revokedAt: null,
            })
            .where(eq(oauthConsents.id, row.id)),
        catch: (cause) => new DatabaseError({ cause }),
      });
      // A revoked row being re-approved is the user linking again, so it
      // counts; a live row being widened is not a new relationship.
      return row.revokedAt !== null;
    });

  /**
   * Unlinks an account from a relying party. Later requests need consent
   * again. Returns whether a LIVE consent was actually revoked, so the
   * user-facing route can 404 an unknown or already-revoked client rather
   * than pretend.
   *
   * Also deletes any authorization code in flight for the pair: redemption
   * does not re-read the consent row, so without this a code minted seconds
   * before the revoke would still exchange after it. Withdrawal means now,
   * not "after the 60-second window drains" (Art. 7(3)).
   */
  const revokeConsent = (
    accountId: string,
    clientId: string,
  ): Effect.Effect<{ revoked: boolean }, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const updated = yield* Effect.tryPromise({
        try: () =>
          db
            .update(oauthConsents)
            .set({ revokedAt: Math.floor(Date.now() / 1000) })
            .where(
              and(
                eq(oauthConsents.accountId, accountId),
                eq(oauthConsents.clientId, clientId),
                isNull(oauthConsents.revokedAt),
              ),
            )
            .returning({ id: oauthConsents.id }),
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (updated.length === 0) return { revoked: false };

      yield* Effect.tryPromise({
        try: () =>
          db
            .delete(oauthAuthorizationCodes)
            .where(
              and(
                eq(oauthAuthorizationCodes.accountId, accountId),
                eq(oauthAuthorizationCodes.clientId, clientId),
              ),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return { revoked: true };
    });

  /**
   * The account's live consents, joined to the client registry so the list
   * can show a name and logo (S-M3 oidc). A consent whose client row was
   * hand-deleted still appears — the grant is the user's record, not the
   * client's — with a null name.
   */
  const listConsents = (
    accountId: string,
  ): Effect.Effect<OidcConnectionSummary[], DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              clientId: oauthConsents.clientId,
              clientName: oauthClients.name,
              logoUrl: oauthClients.logoUrl,
              profileId: oauthConsents.profileId,
              scope: oauthConsents.scope,
              grantedAt: oauthConsents.grantedAt,
            })
            .from(oauthConsents)
            .leftJoin(oauthClients, eq(oauthClients.clientId, oauthConsents.clientId))
            .where(and(eq(oauthConsents.accountId, accountId), isNull(oauthConsents.revokedAt)))
            .orderBy(oauthConsents.grantedAt),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return rows;
    });

  // -------------------------------------------------------------------------
  // Authorization codes
  // -------------------------------------------------------------------------

  /** Mints a code and stores only its hash. Returns the raw code. */
  const createAuthorizationCode = (
    input: IssueCodeInput,
  ): Effect.Effect<string, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const code = generateAuthorizationCode();
      const nowSec = Math.floor(Date.now() / 1000);
      yield* Effect.tryPromise({
        try: () =>
          db.insert(oauthAuthorizationCodes).values({
            id: sha256Hex(code),
            clientId: input.clientId,
            accountId: input.accountId,
            profileId: input.profileId,
            redirectUri: input.redirectUri,
            scope: input.scope,
            codeChallenge: input.codeChallenge,
            nonce: input.nonce,
            // S-H1 oidc: the SESSION's establishment time, never `nowSec` — a
            // code minted off a month-old cookie must not claim the user just
            // authenticated, because relying parties act on `auth_time`.
            authTime: input.authTime,
            expiresAt: nowSec + AUTHORIZATION_CODE_TTL_SEC,
            createdAt: nowSec,
          }),
        catch: (cause) => new DatabaseError({ cause }),
      });
      return code;
    });

  /**
   * Redeems a code, atomically.
   *
   * The DELETE is the single-use guard. A read-then-delete pair would let two
   * concurrent exchanges of the same code both observe it present and both
   * succeed; `DELETE ... RETURNING` gives the row to exactly one caller and an
   * empty result to every other. Expiry is checked on the returned row, after
   * the delete, so an expired code is still consumed rather than left to be
   * retried.
   */
  const consumeAuthorizationCode = (
    rawCode: string,
  ): Effect.Effect<typeof oauthAuthorizationCodes.$inferSelect | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .delete(oauthAuthorizationCodes)
            .where(eq(oauthAuthorizationCodes.id, sha256Hex(rawCode)))
            .returning(),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = rows[0];
      if (!row) return null;
      if (Math.floor(Date.now() / 1000) >= row.expiresAt) return null;
      return row;
    });

  /** PKCE S256 check. `plain` is not accepted anywhere in this provider. */
  const verifyPkce = (codeChallenge: string, codeVerifier: string): boolean => {
    const computed = base64Url(createHash("sha256").update(codeVerifier).digest());
    if (computed.length !== codeChallenge.length) return false;
    return timingSafeEqual(Buffer.from(computed), Buffer.from(codeChallenge));
  };

  // -------------------------------------------------------------------------
  // Token exchange
  // -------------------------------------------------------------------------

  /**
   * Exchanges an authorization code for an ID token and a client-scoped
   * access token.
   *
   * Deliberately absent: a refresh token, and any token bearing the
   * first-party `osn-access` audience. `verifyAccessToken` pins that audience,
   * so nothing minted here can reach a first-party route however it is
   * replayed. A relying party that needs a fresh token sends the user back to
   * `/authorize`, which returns silently once consent exists — better for the
   * user's privacy than a long-lived credential, and no worse for the relying
   * party.
   */
  const exchangeAuthorizationCode = (
    input: ExchangeInput,
  ): Effect.Effect<ExchangeResult, OidcError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const client = yield* findClient(input.clientId);
      if (!client || !authenticateClient(client, input.clientSecret)) {
        return yield* Effect.fail(
          new OidcError({ code: "invalid_client", description: "Client authentication failed" }),
        );
      }

      const row = yield* consumeAuthorizationCode(input.code);
      if (!row) {
        return yield* Effect.fail(
          new OidcError({ code: "invalid_grant", description: "Invalid or expired code" }),
        );
      }

      // A code minted for one client must never be redeemable by another, even
      // one that authenticated correctly as itself.
      if (row.clientId !== client.clientId || row.redirectUri !== input.redirectUri) {
        return yield* Effect.fail(
          new OidcError({ code: "invalid_grant", description: "Code does not match this request" }),
        );
      }

      if (!verifyPkce(row.codeChallenge, input.codeVerifier)) {
        return yield* Effect.fail(
          new OidcError({ code: "invalid_grant", description: "PKCE verification failed" }),
        );
      }

      // Withdrawal means now: the revoke route deletes in-flight codes, but a
      // code inserted concurrently with the revoke can slip past that delete.
      // Re-reading the consent here closes the race by construction — no live
      // consent, no tokens, however the code survived.
      const consent = yield* findConsent(row.accountId, client.clientId);
      if (!consent) {
        return yield* Effect.fail(
          new OidcError({
            code: "invalid_grant",
            description: "The authorization behind this code has been revoked",
          }),
        );
      }

      const profile = yield* findProfileById(row.profileId);
      if (!profile) {
        // The profile went away between authorization and exchange — a
        // deletion mid-flight. Nothing to describe, so refuse the grant.
        return yield* Effect.fail(
          new OidcError({ code: "invalid_grant", description: "Profile is no longer available" }),
        );
      }

      const sub = pairwiseSub(client, profile.id);
      const scopes = new Set(parseScope(row.scope));

      const claims: Record<string, unknown> = {
        sub,
        aud: client.clientId,
        auth_time: row.authTime,
      };
      if (row.nonce !== null) claims["nonce"] = row.nonce;
      if (scopes.has("profile")) {
        claims["preferred_username"] = profile.handle;
        if (profile.displayName !== null) claims["name"] = profile.displayName;
        if (profile.avatarUrl !== null) claims["picture"] = profile.avatarUrl;
      }
      if (scopes.has("email")) {
        // The email belongs to the ACCOUNT, not the profile, so two relying
        // parties holding it can join their records however careful the
        // pairwise subjects are. That is what the `email` scope means, and it
        // is why the consent screen names it separately.
        claims["email"] = profile.email;
        claims["email_verified"] = true;
      }

      // P-W5: the two signatures share nothing but the key, which is already
      // resident — so they run concurrently instead of back-to-back.
      // The access token carries `typ: "at+jwt"` (RFC 9068) so no verifier can
      // ever mistake it for an ID token or a first-party token, on top of the
      // `aud` separation (S-M2 oidc).
      const { idToken, accessToken } = yield* Effect.all(
        {
          idToken: Effect.tryPromise({
            try: () =>
              signJwt(
                claims,
                config.jwtPrivateKey,
                config.jwtKid,
                ID_TOKEN_TTL_SEC,
                config.issuerUrl,
              ),
            catch: (cause) =>
              new OidcError({
                code: "server_error",
                description: `Failed to sign ID token: ${cause}`,
              }),
          }),
          accessToken: Effect.tryPromise({
            try: () =>
              signJwt(
                { sub, aud: client.clientId, scope: row.scope },
                config.jwtPrivateKey,
                config.jwtKid,
                ID_TOKEN_TTL_SEC,
                config.issuerUrl,
                "at+jwt",
              ),
            catch: (cause) =>
              new OidcError({
                code: "server_error",
                description: `Failed to sign access token: ${cause}`,
              }),
          }),
        },
        { concurrency: 2 },
      );

      return {
        response: {
          access_token: accessToken,
          id_token: idToken,
          token_type: "Bearer" as const,
          expires_in: ID_TOKEN_TTL_SEC,
          scope: row.scope,
        },
        isFirstParty: client.isFirstParty,
      };
    });

  // -------------------------------------------------------------------------
  // The /authorize request
  // -------------------------------------------------------------------------

  /**
   * Validates an incoming `/authorize` request.
   *
   * The split return type is the whole point. Anything wrong with `client_id`
   * or `redirect_uri` FAILS the effect, because at that moment we have no URI
   * we are willing to send a browser to — the route must render the error
   * (RFC 6749 §4.1.2.1). Everything after that point returns `kind: "error"`,
   * carrying the now-trusted redirect URI, because the relying party is
   * entitled to see its own protocol mistakes.
   */
  const validateAuthorizeRequest = (
    params: AuthorizeParams,
  ): Effect.Effect<AuthorizeValidation, OidcError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const client = yield* findClient(params.clientId);
      if (!client) {
        return yield* Effect.fail(
          new OidcError({ code: "invalid_client", description: "Unknown client" }),
        );
      }
      if (!isRegisteredRedirectUri(client, params.redirectUri)) {
        return yield* Effect.fail(
          new OidcError({
            code: "invalid_request",
            description: "redirect_uri is not registered for this client",
          }),
        );
      }

      const redirectUri = params.redirectUri;
      const state = params.state;
      const fail = (code: OidcErrorCode, description: string): AuthorizeValidation => ({
        kind: "error",
        client,
        redirectUri,
        state,
        code,
        description,
      });

      const tooLong = [params.state, params.nonce, params.codeChallenge, params.scope].some(
        (v) => v !== null && v.length > OIDC_PARAM_MAX_LENGTH,
      );
      if (tooLong) return fail("invalid_request", "Parameter exceeds the maximum length");

      if (params.responseType !== "code") {
        return fail("unsupported_response_type", "Only the authorization code flow is supported");
      }
      if (params.codeChallengeMethod !== "S256") {
        return fail("invalid_request", "code_challenge_method must be S256");
      }
      // Exactly 43: base64url of a SHA-256 digest is 43 characters, always.
      // Anything else can never verify, so accepting it would only mint codes
      // that are dead on arrival at the token endpoint.
      if (params.codeChallenge === null || !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) {
        return fail("invalid_request", "A valid S256 code_challenge is required");
      }

      let maxAge: number | null = null;
      if (params.maxAge !== null) {
        // OIDC Core §3.1.2.1: max_age is a number of seconds. Digits only,
        // bounded — a negative, fractional, or absurd value is a protocol
        // error, not something to coerce.
        if (!/^\d{1,9}$/.test(params.maxAge)) {
          return fail("invalid_request", "max_age must be a non-negative integer");
        }
        maxAge = Number(params.maxAge);
        if (maxAge > OIDC_MAX_AGE_CEILING_SEC) {
          return fail("invalid_request", "max_age is out of range");
        }
      }

      const scope = narrowScope(params.scope ?? "", client.allowedScopes);
      if (!parseScope(scope).includes("openid")) {
        return fail("invalid_scope", "The openid scope is required and must be allowed");
      }

      const prompts = new Set(parseScope(params.prompt ?? ""));
      // OIDC Core §3.1.2.1: `none` means "do not interact", which cannot be
      // reconciled with any value that demands interaction.
      if (prompts.has("none") && prompts.size > 1) {
        return fail("invalid_request", "prompt=none cannot be combined with other prompt values");
      }

      return {
        kind: "ok",
        prompts,
        request: {
          client,
          redirectUri,
          scope,
          state,
          nonce: params.nonce,
          codeChallenge: params.codeChallenge,
          maxAge,
        },
      };
    });

  /** Builds the success redirect back to the relying party. */
  const buildCodeRedirect = (redirectUri: string, code: string, state: string | null): string => {
    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (state !== null) url.searchParams.set("state", state);
    return url.toString();
  };

  /** Builds the failure redirect back to the relying party. */
  const buildErrorRedirect = (
    redirectUri: string,
    code: OidcErrorCode,
    description: string,
    state: string | null,
  ): string => {
    const url = new URL(redirectUri);
    url.searchParams.set("error", code);
    url.searchParams.set("error_description", description);
    if (state !== null) url.searchParams.set("state", state);
    return url.toString();
  };

  /**
   * Parks a validated request for the consent UI. Returns the opaque id plus
   * the raw browser-binding secret (S-M1 oidc) — the route turns the secret
   * into a cookie; only its hash is stored here.
   *
   * `requireAuthAfter` records, in the parked request itself, that the flow
   * demanded a FRESH sign-in (`prompt=login`, or `max_age` already exceeded):
   * the decision will refuse any session created before that instant.
   */
  const parkRequest = (
    request: ValidatedAuthorizeRequest,
    requireAuthAfter: number | null,
  ): Effect.Effect<{ requestId: string; bindingSecret: string }, never, never> =>
    Effect.promise(async () => {
      const requestId = genId("oar_");
      const bindingSecret = generateBindingSecret();
      await ctx.stores.authorizeRequests.set(
        requestId,
        {
          clientId: request.client.clientId,
          redirectUri: request.redirectUri,
          scope: request.scope,
          state: request.state,
          nonce: request.nonce,
          codeChallenge: request.codeChallenge,
          maxAge: request.maxAge,
          requireAuthAfter,
          bindingHash: sha256Hex(bindingSecret),
          expiresAt: Date.now() + AUTHORIZE_REQUEST_TTL_MS,
        },
        AUTHORIZE_REQUEST_TTL_MS,
      );
      return { requestId, bindingSecret };
    });

  /**
   * Decides what a validated request needs next: a code straight back to the
   * relying party, a trip through the consent UI, or a protocol error.
   *
   * `accountId` is whatever the session cookie resolved to — null when the
   * visitor is not signed in on this device.
   */
  const prepareAuthorization = (
    request: ValidatedAuthorizeRequest,
    prompts: Set<string>,
    session: AuthorizeSession | null,
  ): Effect.Effect<AuthorizeOutcome, DatabaseError, Db> =>
    Effect.gen(function* () {
      const silent = prompts.has("none");
      const nowSec = Math.floor(Date.now() / 1000);

      const interaction = (
        reason: "login" | "select_account" | "consent",
        requireAuthAfter: number | null = null,
      ) =>
        Effect.map(parkRequest(request, requireAuthAfter), ({ requestId, bindingSecret }) => ({
          kind: "interaction" as const,
          requestId,
          reason,
          bindingSecret,
        }));

      if (session === null) {
        // `prompt=login` must record its freshness demand on THIS park path
        // too: a caller can always strip their session cookie, and a park
        // without `requireAuthAfter` would let a decision made with any old
        // session satisfy an RP that explicitly demanded re-authentication.
        return silent
          ? { kind: "error" as const, code: "login_required" as const, description: "No session" }
          : yield* interaction("login", prompts.has("login") ? nowSec : null);
      }

      // `login` and `select_account` are explicit demands for interaction, and
      // `none` has already been rejected alongside them during validation.
      // `prompt=login` parks with `requireAuthAfter = now`: the decision will
      // only accept a session created after this instant, so the demand for a
      // fresh ceremony is enforced server-side, not just displayed (S-H1 oidc).
      if (prompts.has("login")) {
        return yield* interaction("login", nowSec);
      }

      // `max_age` exceeded reads exactly like `prompt=login` (OIDC Core
      // §3.1.2.1) — the session is real but too old for this relying party.
      const stale = request.maxAge !== null && nowSec - session.authTime > request.maxAge;
      if (stale) {
        return silent
          ? {
              kind: "error" as const,
              code: "login_required" as const,
              description: "Authentication is older than the requested max_age",
            }
          : yield* interaction("login", nowSec);
      }

      if (prompts.has("select_account")) {
        return yield* interaction("select_account");
      }

      const { accountId, authTime } = session;
      const consent = yield* findConsent(accountId, request.client.clientId);
      const consentUsable =
        consent !== null && scopeCovers(consent.scope, request.scope) && !prompts.has("consent");

      if (consentUsable && consent !== null) {
        const code = yield* createAuthorizationCode({
          clientId: request.client.clientId,
          accountId,
          profileId: consent.profileId,
          redirectUri: request.redirectUri,
          scope: request.scope,
          codeChallenge: request.codeChallenge,
          nonce: request.nonce,
          authTime,
        });
        return { kind: "code" as const, code };
      }

      // First-party clients skip the consent screen: the user is signing in to
      // one of our own apps, which already presents their default profile and
      // carries its own profile switcher. `prompt=select_account` above is
      // still honoured, so this is a default rather than a lock-in.
      if (request.client.isFirstParty && !prompts.has("consent")) {
        const profile = yield* findDefaultProfile(accountId);
        if (profile) {
          yield* recordConsent(accountId, request.client.clientId, profile.id, request.scope);
          const code = yield* createAuthorizationCode({
            clientId: request.client.clientId,
            accountId,
            profileId: profile.id,
            redirectUri: request.redirectUri,
            scope: request.scope,
            codeChallenge: request.codeChallenge,
            nonce: request.nonce,
            authTime,
          });
          return { kind: "code" as const, code };
        }
      }

      return silent
        ? {
            kind: "error" as const,
            code: "consent_required" as const,
            description: "The user has not linked this account to this client",
          }
        : yield* interaction("consent");
    });

  /** Reads a parked request back for the consent UI. Expired ids read as null. */
  const loadAuthorizeRequest = (
    requestId: string,
  ): Effect.Effect<PendingAuthorizeRequest | null, never, never> =>
    Effect.promise(async () => {
      const parked = await ctx.stores.authorizeRequests.get(requestId);
      if (!parked) return null;
      if (Date.now() >= parked.expiresAt) {
        await ctx.stores.authorizeRequests.delete(requestId);
        return null;
      }
      return parked;
    });

  /**
   * Applies the user's decision and retires the parked request.
   *
   * The request is deleted whichever way the decision went, so the id is
   * single-use: a consent screen cannot be replayed to mint a second code, and
   * a refusal cannot be quietly retried into an approval.
   */
  const completeAuthorization = (
    input: DecisionInput,
  ): Effect.Effect<DecisionResult, OidcError | DatabaseError, Db> =>
    Effect.gen(function* () {
      const parked = yield* loadAuthorizeRequest(input.requestId);
      if (!parked) {
        return yield* Effect.fail(
          new OidcError({ code: "invalid_request", description: "Unknown or expired request" }),
        );
      }

      // S-M1 oidc: the decision must come from the browser that parked the
      // request. Checked BEFORE the request is consumed, so a forged attempt
      // does not burn the real user's pending flow. The hash is absent only
      // for requests parked by a pre-upgrade instance mid-deploy. The error
      // is byte-identical to the unknown-id case: a caller without the
      // binding cookie must not learn that the id exists.
      if (
        parked.bindingHash !== undefined &&
        (input.bindingSecret === null ||
          !hexEqual(sha256Hex(input.bindingSecret), parked.bindingHash))
      ) {
        return yield* Effect.fail(
          new OidcError({ code: "invalid_request", description: "Unknown or expired request" }),
        );
      }

      // S-H1 oidc: a flow that demanded a fresh sign-in (`prompt=login`, or
      // `max_age` exceeded at /authorize) only accepts a session created after
      // the request was parked — and `max_age` is re-checked outright, because
      // a user can sit on the consent screen while their session ages past it.
      const nowSec = Math.floor(Date.now() / 1000);
      // `!= null` on purpose: both fields read as undefined off a request
      // parked by a pre-upgrade instance, and undefined must mean "no demand".
      const tooOld =
        (parked.requireAuthAfter != null && input.authTime < parked.requireAuthAfter) ||
        (parked.maxAge != null && nowSec - input.authTime > parked.maxAge);
      if (tooOld) {
        return yield* Effect.fail(
          new OidcError({
            code: "login_required",
            description: "A fresh sign-in is required before this request can be approved",
          }),
        );
      }

      yield* Effect.promise(() => ctx.stores.authorizeRequests.delete(input.requestId));

      if (!input.approved) {
        return {
          redirectTo: buildErrorRedirect(
            parked.redirectUri,
            "access_denied",
            "The user refused the request",
            parked.state,
          ),
          isNewLink: false,
          isFirstParty: false,
        };
      }

      const client = yield* findClient(parked.clientId);
      if (!client) {
        return yield* Effect.fail(
          new OidcError({ code: "invalid_client", description: "Client is no longer available" }),
        );
      }

      // The profile must belong to the deciding account. Without this check a
      // signed-in user could name any profile id and mint a code for someone
      // else's identity.
      const profile = yield* findProfileById(input.profileId);
      if (!profile || profile.accountId !== input.accountId) {
        return yield* Effect.fail(
          new OidcError({ code: "invalid_request", description: "Unknown profile" }),
        );
      }

      const isNewLink = yield* recordConsent(
        input.accountId,
        client.clientId,
        profile.id,
        parked.scope,
      );

      const code = yield* createAuthorizationCode({
        clientId: client.clientId,
        accountId: input.accountId,
        profileId: profile.id,
        redirectUri: parked.redirectUri,
        scope: parked.scope,
        codeChallenge: parked.codeChallenge,
        nonce: parked.nonce,
        authTime: input.authTime,
      });

      return {
        redirectTo: buildCodeRedirect(parked.redirectUri, code, parked.state),
        isNewLink,
        isFirstParty: client.isFirstParty,
      };
    });

  return {
    findClient,
    authenticateClient,
    isRegisteredRedirectUri,
    registerClient,
    listOwnedClients,
    disableOwnedClient,
    pairwiseSub,
    findConsent,
    recordConsent,
    revokeConsent,
    listConsents,
    createAuthorizationCode,
    consumeAuthorizationCode,
    verifyPkce,
    exchangeAuthorizationCode,
    validateAuthorizeRequest,
    prepareAuthorization,
    loadAuthorizeRequest,
    completeAuthorization,
    buildCodeRedirect,
    buildErrorRedirect,
  };
}

export type OidcModule = ReturnType<typeof createOidcModule>;
