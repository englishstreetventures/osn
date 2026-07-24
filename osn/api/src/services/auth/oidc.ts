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
import { and, eq, lte } from "drizzle-orm";
import { Effect } from "effect";

import {
  AUTHORIZATION_CODE_TTL_SEC,
  AUTHORIZE_REQUEST_TTL_MS,
  ID_TOKEN_TTL_SEC,
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
}

/** A request that has survived validation. Every field is safe to act on. */
export interface ValidatedAuthorizeRequest {
  client: OidcClient;
  redirectUri: string;
  scope: string;
  state: string | null;
  nonce: string | null;
  codeChallenge: string;
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
  | { kind: "interaction"; requestId: string; reason: "login" | "select_account" | "consent" }
  | { kind: "error"; code: OidcErrorCode; description: string };

/** The user's answer to a consent screen. */
export interface DecisionInput {
  requestId: string;
  accountId: string;
  profileId: string;
  approved: boolean;
}

/** Where to send the browser next, plus whether this was a first-time link. */
export interface DecisionResult {
  redirectTo: string;
  isNewLink: boolean;
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

  const rowToClient = (row: typeof oauthClients.$inferSelect): OidcClient => ({
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

  /** Looks up an enabled relying party. Disabled clients read as absent. */
  const findClient = (clientId: string): Effect.Effect<OidcClient | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1),
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
  ): Effect.Effect<typeof oauthConsents.$inferSelect | null, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      const rows = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(oauthConsents)
            .where(
              and(eq(oauthConsents.accountId, accountId), eq(oauthConsents.clientId, clientId)),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = rows[0];
      if (!row || row.revokedAt !== null) return null;
      return row;
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
      const existing = yield* Effect.tryPromise({
        try: () =>
          db
            .select()
            .from(oauthConsents)
            .where(
              and(eq(oauthConsents.accountId, accountId), eq(oauthConsents.clientId, clientId)),
            )
            .limit(1),
        catch: (cause) => new DatabaseError({ cause }),
      });
      const row = existing[0];

      if (!row) {
        yield* Effect.tryPromise({
          try: () =>
            db.insert(oauthConsents).values({
              id: genId("ocs_"),
              accountId,
              clientId,
              profileId,
              scope,
              grantedAt: nowSec,
            }),
          catch: (cause) => new DatabaseError({ cause }),
        });
        return true;
      }

      yield* Effect.tryPromise({
        try: () =>
          db
            .update(oauthConsents)
            .set({
              profileId,
              scope: mergeScope(row.scope, scope),
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

  /** Unlinks an account from a relying party. Later requests need consent again. */
  const revokeConsent = (
    accountId: string,
    clientId: string,
  ): Effect.Effect<void, DatabaseError, Db> =>
    Effect.gen(function* () {
      const { db } = yield* Db;
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(oauthConsents)
            .set({ revokedAt: Math.floor(Date.now() / 1000) })
            .where(
              and(eq(oauthConsents.accountId, accountId), eq(oauthConsents.clientId, clientId)),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      });
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
            authTime: nowSec,
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
  ): Effect.Effect<OidcTokenResponse, OidcError | DatabaseError, Db> =>
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

      const idToken = yield* Effect.tryPromise({
        try: () =>
          signJwt(claims, config.jwtPrivateKey, config.jwtKid, ID_TOKEN_TTL_SEC, config.issuerUrl),
        catch: (cause) =>
          new OidcError({ code: "server_error", description: `Failed to sign ID token: ${cause}` }),
      });

      const accessToken = yield* Effect.tryPromise({
        try: () =>
          signJwt(
            { sub, aud: client.clientId, scope: row.scope },
            config.jwtPrivateKey,
            config.jwtKid,
            ID_TOKEN_TTL_SEC,
            config.issuerUrl,
          ),
        catch: (cause) =>
          new OidcError({
            code: "server_error",
            description: `Failed to sign access token: ${cause}`,
          }),
      });

      return {
        access_token: accessToken,
        id_token: idToken,
        token_type: "Bearer" as const,
        expires_in: ID_TOKEN_TTL_SEC,
        scope: row.scope,
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
      if (params.codeChallenge === null || params.codeChallenge.length < 43) {
        return fail("invalid_request", "A valid S256 code_challenge is required");
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

  /** Parks a validated request for the consent UI and returns its opaque id. */
  const parkRequest = (request: ValidatedAuthorizeRequest): Effect.Effect<string, never, never> =>
    Effect.promise(async () => {
      const requestId = genId("oar_");
      await ctx.stores.authorizeRequests.set(
        requestId,
        {
          clientId: request.client.clientId,
          redirectUri: request.redirectUri,
          scope: request.scope,
          state: request.state,
          nonce: request.nonce,
          codeChallenge: request.codeChallenge,
          expiresAt: Date.now() + AUTHORIZE_REQUEST_TTL_MS,
        },
        AUTHORIZE_REQUEST_TTL_MS,
      );
      return requestId;
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
    accountId: string | null,
  ): Effect.Effect<AuthorizeOutcome, DatabaseError, Db> =>
    Effect.gen(function* () {
      const silent = prompts.has("none");

      if (accountId === null) {
        return silent
          ? { kind: "error" as const, code: "login_required" as const, description: "No session" }
          : {
              kind: "interaction" as const,
              requestId: yield* parkRequest(request),
              reason: "login" as const,
            };
      }

      // `login` and `select_account` are explicit demands for interaction, and
      // `none` has already been rejected alongside them during validation.
      if (prompts.has("login")) {
        return {
          kind: "interaction" as const,
          requestId: yield* parkRequest(request),
          reason: "login" as const,
        };
      }
      if (prompts.has("select_account")) {
        return {
          kind: "interaction" as const,
          requestId: yield* parkRequest(request),
          reason: "select_account" as const,
        };
      }

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
        : {
            kind: "interaction" as const,
            requestId: yield* parkRequest(request),
            reason: "consent" as const,
          };
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
      });

      return { redirectTo: buildCodeRedirect(parked.redirectUri, code, parked.state), isNewLink };
    });

  return {
    findClient,
    authenticateClient,
    isRegisteredRedirectUri,
    pairwiseSub,
    findConsent,
    recordConsent,
    revokeConsent,
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
