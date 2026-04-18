import { Context, Effect, Layer } from "effect";

import {
  AuthExpiredError,
  AuthorizationError,
  ProfileManagementError,
  StateMismatchError,
  StorageError,
  TokenExchangeError,
  TokenRefreshError,
} from "./errors";
import { generateCodeChallenge, generateCodeVerifier } from "./pkce";
import { Storage } from "./storage";
import {
  decodeAccountSession,
  decodeCreateProfileResponse,
  decodeListProfilesResponse,
  decodeSwitchProfileResponse,
  extractJwtSub,
  parseTokenResponse,
} from "./tokens";
import type { AccountSession, PublicProfile, Session } from "./tokens";

const ACCOUNT_SESSION_KEY = "@osn/client:account_session";
const VERIFIER_KEY = "@osn/client:pkce_verifier";
const STATE_KEY = "@osn/client:state";

/** Build a Session from the active profile's cached token. Returns null if expired or missing. */
function toSession(account: AccountSession): Session | null {
  const profileToken = account.profileTokens[account.activeProfileId];
  if (!profileToken || Date.now() >= profileToken.expiresAt) return null;
  return {
    accessToken: profileToken.accessToken,
    refreshToken: account.refreshToken,
    idToken: account.idToken,
    expiresAt: profileToken.expiresAt,
    scopes: account.scopes,
  };
}

/** Create a fresh AccountSession from a Session (used by handleCallback / setSession). */
function sessionToAccountSession(session: Session): AccountSession {
  const profileId = extractJwtSub(session.accessToken) ?? "default";
  return {
    refreshToken: session.refreshToken ?? "",
    activeProfileId: profileId,
    profileTokens: {
      [profileId]: {
        accessToken: session.accessToken,
        expiresAt: session.expiresAt,
      },
    },
    scopes: session.scopes,
    idToken: session.idToken,
  };
}

/** Remove expired profile tokens from an AccountSession, except the active profile. (S-M2, P-W3) */
function pruneExpiredTokens(account: AccountSession): void {
  const now = Date.now();
  for (const id of Object.keys(account.profileTokens)) {
    if (id !== account.activeProfileId && account.profileTokens[id]!.expiresAt <= now) {
      delete account.profileTokens[id];
    }
  }
}

export interface OsnAuthConfig {
  issuerUrl: string;
  clientId: string;
}

// Methods close over the already-resolved Storage instance, so requirements are never.
export interface OsnAuthService {
  readonly startLogin: (params: {
    redirectUri: string;
    scopes?: string[];
  }) => Effect.Effect<
    { authorizationUrl: string; state: string },
    AuthorizationError | StorageError
  >;

  readonly handleCallback: (params: {
    code: string;
    state: string;
    redirectUri: string;
  }) => Effect.Effect<Session, TokenExchangeError | StateMismatchError | StorageError>;

  readonly getSession: () => Effect.Effect<Session | null, StorageError>;

  readonly refreshSession: () => Effect.Effect<Session, TokenRefreshError | StorageError>;

  readonly logout: () => Effect.Effect<void, StorageError>;

  /**
   * Persists a Session that was obtained out-of-band (e.g. from the
   * email-verified registration flow, which exchanges its auth code through
   * the standalone registration client and bypasses the PKCE callback).
   */
  readonly setSession: (session: Session) => Effect.Effect<void, StorageError>;

  readonly listProfiles: () => Effect.Effect<
    PublicProfile[],
    ProfileManagementError | StorageError
  >;

  readonly switchProfile: (
    profileId: string,
  ) => Effect.Effect<
    { session: Session; profile: PublicProfile },
    ProfileManagementError | StorageError
  >;

  readonly createProfile: (
    handle: string,
    displayName?: string,
  ) => Effect.Effect<PublicProfile, ProfileManagementError | StorageError>;

  readonly deleteProfile: (
    profileId: string,
  ) => Effect.Effect<void, ProfileManagementError | StorageError>;

  readonly getActiveProfile: () => Effect.Effect<string | null, StorageError>;

  /**
   * Access-token-aware fetch. Adds `Authorization: Bearer <accessToken>` and
   * transparently retries once on a 401 after silent-refreshing the session.
   * If the retry also 401s, surfaces `AuthExpiredError` and clears the
   * cached session — callers should redirect to sign-in.
   *
   * Short access-token TTL (5 min) makes this the expected fast path for
   * first-party API calls; the refresh token sits in an HttpOnly cookie so
   * the rotation is invisible to the user.
   */
  readonly authFetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Effect.Effect<Response, AuthExpiredError | StorageError>;
}

export class OsnAuth extends Context.Tag("@osn/client/OsnAuth")<OsnAuth, OsnAuthService>() {}

export function createOsnAuthLive(config: OsnAuthConfig): Layer.Layer<OsnAuth, never, Storage> {
  return Layer.effect(
    OsnAuth,
    Effect.gen(function* () {
      const storage = yield* Storage;

      // P-W1: In-memory cache to avoid redundant storage reads + JSON.parse
      // undefined = not loaded, null = no session, AccountSession = loaded
      let cache: AccountSession | null | undefined;

      // ---------------------------------------------------------------------------
      // Internal helpers for the multi-key account session model
      // ---------------------------------------------------------------------------

      const saveAccountSession = (account: AccountSession) => {
        pruneExpiredTokens(account);
        cache = account;
        return storage.set(ACCOUNT_SESSION_KEY, JSON.stringify(account));
      };

      const getAccountSession = () =>
        Effect.gen(function* () {
          // P-W1: Return cached value if available
          if (cache !== undefined) return cache;

          const raw = yield* storage.get(ACCOUNT_SESSION_KEY);
          if (raw) {
            // S-H2: Validate storage data against schema before consuming
            try {
              const account = decodeAccountSession(JSON.parse(raw)) as AccountSession;
              cache = account;
              return account;
            } catch {
              yield* storage.remove(ACCOUNT_SESSION_KEY);
              cache = null;
              return null;
            }
          }

          cache = null;
          return null;
        });

      // ---------------------------------------------------------------------------
      // Existing auth methods (updated for multi-key storage)
      // ---------------------------------------------------------------------------

      const startLogin = (params: { redirectUri: string; scopes?: string[] }) =>
        Effect.gen(function* () {
          const verifier = generateCodeVerifier();
          const challenge = yield* Effect.tryPromise({
            try: () => generateCodeChallenge(verifier),
            catch: (cause) => new AuthorizationError({ cause }),
          });
          const state = crypto.randomUUID();
          const scopes = params.scopes ?? ["openid", "profile"];

          yield* storage.set(VERIFIER_KEY, verifier);
          yield* storage.set(STATE_KEY, state);

          const url = new URL(`${config.issuerUrl}/authorize`);
          url.searchParams.set("response_type", "code");
          url.searchParams.set("client_id", config.clientId);
          url.searchParams.set("redirect_uri", params.redirectUri);
          url.searchParams.set("scope", scopes.join(" "));
          url.searchParams.set("state", state);
          url.searchParams.set("code_challenge", challenge);
          url.searchParams.set("code_challenge_method", "S256");

          return { authorizationUrl: url.toString(), state };
        });

      const handleCallback = (params: { code: string; state: string; redirectUri: string }) =>
        Effect.gen(function* () {
          const storedState = yield* storage.get(STATE_KEY);
          const verifier = yield* storage.get(VERIFIER_KEY);

          if (storedState !== params.state) {
            return yield* Effect.fail(
              new StateMismatchError({
                expected: storedState ?? "",
                received: params.state,
              }),
            );
          }

          const raw = yield* Effect.tryPromise({
            try: () =>
              fetch(`${config.issuerUrl}/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                credentials: "include",
                body: new URLSearchParams({
                  grant_type: "authorization_code",
                  code: params.code,
                  redirect_uri: params.redirectUri,
                  client_id: config.clientId,
                  code_verifier: verifier ?? "",
                }).toString(),
              }).then((r) => r.json() as Promise<unknown>),
            catch: (cause) => new TokenExchangeError({ cause }),
          });

          const session = yield* Effect.try({
            try: () => parseTokenResponse(raw),
            catch: (cause) => new TokenExchangeError({ cause }),
          });

          yield* saveAccountSession(sessionToAccountSession(session));
          yield* storage.remove(VERIFIER_KEY);
          yield* storage.remove(STATE_KEY);

          return session;
        });

      const getSession = () =>
        Effect.gen(function* () {
          const account = yield* getAccountSession();
          if (!account) return null;
          return toSession(account);
        });

      // -----------------------------------------------------------------------
      // Single-flight refresh (S-H1 / P-W1).
      //
      // Multiple concurrent authFetch calls that all 401 must NOT each fire
      // /token. The server rotates the session token on every grant (Copenhagen
      // Book C2); replaying the rotated-out cookie value a second time trips
      // reuse detection and revokes every session in the family — the user
      // gets logged out across all devices.
      //
      // Store the in-flight refresh as a shared Promise<Either>. Concurrent
      // callers join it instead of kicking off a second /token roundtrip.
      // -----------------------------------------------------------------------

      type RefreshEither =
        | { readonly _tag: "Left"; readonly left: TokenRefreshError | StorageError }
        | { readonly _tag: "Right"; readonly right: Session };
      let inFlightRefresh: Promise<RefreshEither> | null = null;

      const doRefresh = () =>
        Effect.gen(function* () {
          const account = yield* getAccountSession();
          if (!account) {
            return yield* Effect.fail(new TokenRefreshError({ cause: "No session available" }));
          }

          // C3: session token is in the HttpOnly cookie; send credentials: include.
          // The grant_type=refresh_token body param is sent for backwards compat
          // but the server prefers the cookie.
          const raw = yield* Effect.tryPromise({
            try: () =>
              fetch(`${config.issuerUrl}/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                credentials: "include",
                body: new URLSearchParams({
                  grant_type: "refresh_token",
                  client_id: config.clientId,
                }).toString(),
              }).then((r) => r.json() as Promise<unknown>),
            catch: (cause) => new TokenRefreshError({ cause }),
          });

          const next = yield* Effect.try({
            try: () => parseTokenResponse(raw),
            catch: (cause) => new TokenRefreshError({ cause }),
          });

          const profileId = extractJwtSub(next.accessToken) ?? account.activeProfileId;
          account.profileTokens[profileId] = {
            accessToken: next.accessToken,
            expiresAt: next.expiresAt,
          };
          if (next.refreshToken) account.refreshToken = next.refreshToken;
          account.scopes = next.scopes;
          account.idToken = next.idToken;

          yield* saveAccountSession(account);
          return next;
        });

      const refreshSession = () =>
        Effect.gen(function* () {
          // Join the in-flight refresh if one is already running.
          if (!inFlightRefresh) {
            // Either-wrapped so the shared promise never rejects — survives
            // FiberFailure wrapping from runPromise across Effect versions.
            const promise = Effect.runPromise(Effect.either(doRefresh())) as Promise<RefreshEither>;
            inFlightRefresh = promise;
            // Clear the cache once the refresh settles so the next 401 burst
            // kicks off a fresh refresh rather than replaying a stale result.
            void promise.finally(() => {
              if (inFlightRefresh === promise) inFlightRefresh = null;
            });
          }

          const result = yield* Effect.tryPromise({
            try: () => inFlightRefresh!,
            catch: (cause) => new TokenRefreshError({ cause }),
          });
          if (result._tag === "Left") {
            return yield* Effect.fail(result.left);
          }
          return result.right;
        });

      const logout = () =>
        Effect.gen(function* () {
          // C3: server-side session destruction + cookie clearing
          yield* Effect.tryPromise({
            try: () =>
              fetch(`${config.issuerUrl}/logout`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: "{}",
              }),
            catch: () => new StorageError({ cause: "Logout request failed" }),
          }).pipe(Effect.catchAll(() => Effect.void));
          cache = null;
          yield* storage.remove(ACCOUNT_SESSION_KEY);
        });

      const setSession = (session: Session) => saveAccountSession(sessionToAccountSession(session));

      // ---------------------------------------------------------------------------
      // Profile management methods (P4)
      // ---------------------------------------------------------------------------

      // S-H1: Profile endpoints authenticate via Bearer access token (not
      // refresh token in body). The access token's `sub` claim identifies
      // the caller's profile; the server resolves the owning account.

      /**
       * Returns the Authorization header value for the active profile's
       * access token, or null if no valid token is available.
       */
      function authHeader(account: AccountSession): Record<string, string> | null {
        const pt = account.profileTokens[account.activeProfileId];
        if (!pt || Date.now() >= pt.expiresAt) return null;
        return {
          Authorization: `Bearer ${pt.accessToken}`,
          "Content-Type": "application/json",
        };
      }

      const listProfiles = () =>
        Effect.gen(function* () {
          const account = yield* getAccountSession();
          if (!account) {
            return yield* Effect.fail(
              new ProfileManagementError({ cause: "No session available" }),
            );
          }

          const headers = authHeader(account);
          if (!headers) {
            return yield* Effect.fail(
              new ProfileManagementError({ cause: "No valid access token" }),
            );
          }

          // S-M4: Validate response schema
          const res = yield* Effect.tryPromise({
            try: async () => {
              const r = await fetch(`${config.issuerUrl}/profiles/list`, {
                method: "GET",
                headers,
                credentials: "include",
              });
              if (!r.ok) throw new Error(`Request failed: ${r.status}`);
              return decodeListProfilesResponse(await r.json());
            },
            catch: (cause) => new ProfileManagementError({ cause }),
          });

          return res.profiles as PublicProfile[];
        });

      const switchProfile = (profileId: string) =>
        Effect.gen(function* () {
          const account = yield* getAccountSession();
          if (!account) {
            return yield* Effect.fail(
              new ProfileManagementError({ cause: "No session available" }),
            );
          }

          const headers = authHeader(account);
          if (!headers) {
            return yield* Effect.fail(
              new ProfileManagementError({ cause: "No valid access token" }),
            );
          }

          // S-M4: Validate response schema
          const res = yield* Effect.tryPromise({
            try: async () => {
              const r = await fetch(`${config.issuerUrl}/profiles/switch`, {
                method: "POST",
                headers,
                credentials: "include",
                body: JSON.stringify({ profile_id: profileId }),
              });
              if (!r.ok) throw new Error(`Request failed: ${r.status}`);
              return decodeSwitchProfileResponse(await r.json());
            },
            catch: (cause) => new ProfileManagementError({ cause }),
          });

          // S-L1: Use server-authoritative profile ID, not caller-supplied
          const serverProfileId = (res.profile as PublicProfile).id;
          const expiresAt = Date.now() + res.expires_in * 1000;
          account.profileTokens[serverProfileId] = {
            accessToken: res.access_token,
            expiresAt,
          };
          account.activeProfileId = serverProfileId;
          yield* saveAccountSession(account);

          const session: Session = {
            accessToken: res.access_token,
            refreshToken: account.refreshToken,
            idToken: account.idToken,
            expiresAt,
            scopes: account.scopes,
          };

          return { session, profile: res.profile as PublicProfile };
        });

      const createProfile = (handle: string, displayName?: string) =>
        Effect.gen(function* () {
          const account = yield* getAccountSession();
          if (!account) {
            return yield* Effect.fail(
              new ProfileManagementError({ cause: "No session available" }),
            );
          }

          const headers = authHeader(account);
          if (!headers) {
            return yield* Effect.fail(
              new ProfileManagementError({ cause: "No valid access token" }),
            );
          }

          const body: Record<string, string> = { handle };
          if (displayName !== undefined) body.display_name = displayName;

          // S-M4: Validate response schema
          const res = yield* Effect.tryPromise({
            try: async () => {
              const r = await fetch(`${config.issuerUrl}/profiles/create`, {
                method: "POST",
                headers,
                credentials: "include",
                body: JSON.stringify(body),
              });
              if (!r.ok) throw new Error(`Request failed: ${r.status}`);
              return decodeCreateProfileResponse(await r.json());
            },
            catch: (cause) => new ProfileManagementError({ cause }),
          });

          return res.profile as PublicProfile;
        });

      const deleteProfile = (profileId: string) =>
        Effect.gen(function* () {
          const account = yield* getAccountSession();
          if (!account) {
            return yield* Effect.fail(
              new ProfileManagementError({ cause: "No session available" }),
            );
          }

          const headers = authHeader(account);
          if (!headers) {
            return yield* Effect.fail(
              new ProfileManagementError({ cause: "No valid access token" }),
            );
          }

          yield* Effect.tryPromise({
            try: async () => {
              const r = await fetch(`${config.issuerUrl}/profiles/delete`, {
                method: "POST",
                headers,
                credentials: "include",
                body: JSON.stringify({ profile_id: profileId }),
              });
              if (!r.ok) throw new Error(`Request failed: ${r.status}`);
              return (await r.json()) as unknown;
            },
            catch: (cause) => new ProfileManagementError({ cause }),
          });

          delete account.profileTokens[profileId];
          // S-M3: Handle deletion of the active profile gracefully
          if (account.activeProfileId === profileId) {
            const remaining = Object.keys(account.profileTokens);
            account.activeProfileId = remaining.length > 0 ? remaining[0]! : "";
          }
          yield* saveAccountSession(account);
        });

      const getActiveProfile = () =>
        Effect.gen(function* () {
          const account = yield* getAccountSession();
          return account?.activeProfileId || null;
        });

      /**
       * authFetch — attach the current access token and silent-refresh once on 401.
       *
       * Rationale: access tokens are short-lived (5 min default) so the 401
       * path is the common case for any long-lived session. Retrying once
       * after a successful refresh makes the UX indistinguishable from a
       * long-TTL token while capping XSS blast radius to ~5 min.
       *
       * Contract:
       * - Adds `Authorization: Bearer <accessToken>` to the request headers
       *   unless caller has already set one (caller-supplied wins).
       * - On response.status === 401 exactly once, calls `refreshSession()`
       *   and reissues the original request with the new token.
       * - If refresh fails, or the retry also 401s, returns
       *   `AuthExpiredError` and clears the cached session. Callers should
       *   redirect to sign-in.
       */
      const authFetch = (input: RequestInfo | URL, init?: RequestInit) =>
        Effect.gen(function* () {
          const account = yield* getAccountSession();
          if (!account) {
            return yield* Effect.fail(new AuthExpiredError({ cause: "no session" }));
          }
          const current = account.profileTokens[account.activeProfileId];
          if (!current) {
            return yield* Effect.fail(new AuthExpiredError({ cause: "no access token" }));
          }

          const withAuth = (token: string): RequestInit => {
            const headers = new Headers(init?.headers);
            if (!headers.has("authorization")) {
              headers.set("Authorization", `Bearer ${token}`);
            }
            return { credentials: "include", ...init, headers };
          };

          const first = yield* Effect.tryPromise({
            try: () => fetch(input, withAuth(current.accessToken)),
            catch: (cause) => new AuthExpiredError({ cause }),
          });
          if (first.status !== 401) return first;

          // Silent refresh + retry once.
          const refreshed = yield* Effect.either(refreshSession());
          if (refreshed._tag === "Left") {
            cache = null;
            yield* storage.remove(ACCOUNT_SESSION_KEY);
            return yield* Effect.fail(new AuthExpiredError({ cause: refreshed.left }));
          }

          const second = yield* Effect.tryPromise({
            try: () => fetch(input, withAuth(refreshed.right.accessToken)),
            catch: (cause) => new AuthExpiredError({ cause }),
          });
          if (second.status === 401) {
            cache = null;
            yield* storage.remove(ACCOUNT_SESSION_KEY);
            return yield* Effect.fail(
              new AuthExpiredError({ cause: "refresh did not repair 401" }),
            );
          }
          return second;
        });

      return {
        startLogin,
        handleCallback,
        getSession,
        refreshSession,
        logout,
        setSession,
        listProfiles,
        switchProfile,
        createProfile,
        deleteProfile,
        getActiveProfile,
        authFetch,
      };
    }),
  );
}
