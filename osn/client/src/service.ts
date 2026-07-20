import { Context, Effect, Layer } from "effect";

import {
  AuthExpiredError,
  ProfileManagementError,
  StorageError,
  TokenRefreshError,
} from "./errors";
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

/** Build a Session from the active profile's cached token. Returns null if expired or missing. */
function toSession(account: AccountSession): Session | null {
  const profileToken = account.profileTokens[account.activeProfileId];
  if (!profileToken || Date.now() >= profileToken.expiresAt) return null;
  return {
    accessToken: profileToken.accessToken,
    idToken: account.idToken,
    expiresAt: profileToken.expiresAt,
    scopes: account.scopes,
  };
}

/** Create a fresh AccountSession from a Session (used by setSession). */
function sessionToAccountSession(session: Session): AccountSession {
  const profileId = extractJwtSub(session.accessToken) ?? "default";
  return {
    hasSession: true,
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
}

// Methods close over the already-resolved Storage instance, so requirements are never.
export interface OsnAuthService {
  readonly getSession: () => Effect.Effect<Session | null, StorageError>;

  /**
   * Session-load entry point for app mount (e.g. the SolidJS session resource).
   *
   * Returns the locally-cached session when an account exists. When there is
   * NO stored account — the cold-start case after a post-login full-page
   * navigation — it attempts to bootstrap a session from the HttpOnly refresh
   * cookie via a single `POST /token` (grant_type=refresh_token,
   * credentials: "include"), reconstructing and persisting the account from
   * the token response. If no/expired cookie is present, resolves to `null`
   * (genuinely logged out) — never throws. Single-flighted so concurrent
   * mounts don't double-hit `/token`.
   */
  readonly loadSession: () => Effect.Effect<Session | null, StorageError>;

  readonly refreshSession: () => Effect.Effect<Session, TokenRefreshError | StorageError>;

  readonly logout: () => Effect.Effect<void, StorageError>;

  /**
   * Persists a Session that was obtained out-of-band (e.g. from the
   * email-verified registration flow, which returns a Session directly).
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

      const getSession = () =>
        Effect.gen(function* () {
          const account = yield* getAccountSession();
          if (!account) return null;
          return toSession(account);
        });

      // -----------------------------------------------------------------------
      // Shared /token grant.
      //
      // POST {issuer}/token with grant_type=refresh_token and
      // credentials: "include". The session (refresh) token lives only in the
      // HttpOnly cookie (Copenhagen Book C3), so this single request drives
      // every refresh path: the authenticated 401-refresh, the cold-start
      // bootstrap, and the reload-with-expired-access-token rehydrate below —
      // the only difference is whether a local account already exists.
      //
      // Durability: the access token's TTL is short (5 min), so on a typical
      // reload the cookie is the ONLY thing keeping the user signed in. A
      // single dropped /token (cold Worker isolate, transient 5xx/429, or a
      // network blip) must NOT read as "logged out" — that is the production
      // reload-logout bug. We therefore distinguish two failure classes:
      //
      //   - TERMINAL (4xx, e.g. 401/400 invalid_grant): the cookie is genuinely
      //     gone/expired/rotated-out. The user IS logged out — fail fast, no
      //     retry (retrying a rejected grant is pointless and a rotated cookie
      //     replay would only trip reuse detection).
      //   - TRANSIENT (network error, 429, 5xx): the cookie is probably still
      //     alive; the server just couldn't answer. Retry with bounded backoff
      //     before giving up so a momentary hiccup doesn't evict a live session.
      // -----------------------------------------------------------------------

      // A 4xx from /token is a definitive "no/expired session" — surfaced as a
      // terminal failure that callers must NOT retry. Carries the status so the
      // retry policy can tell it apart from a transient/5xx error.
      class TerminalGrantError {
        readonly _tag = "TerminalGrantError";
        constructor(readonly status: number) {}
      }

      // Bounded exponential backoff for transient /token failures. Three
      // attempts total (~0 + 200ms + 400ms ≈ 0.6s worst case) keeps the
      // cold-start path responsive while absorbing a single Worker cold-start
      // or transient upstream blip. Terminal (4xx) failures short-circuit.
      const TOKEN_GRANT_RETRY_DELAYS_MS = [200, 400] as const;

      const fetchTokenGrantOnce = () =>
        Effect.gen(function* () {
          const raw = yield* Effect.tryPromise({
            try: () =>
              fetch(`${config.issuerUrl}/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                credentials: "include",
                body: new URLSearchParams({
                  grant_type: "refresh_token",
                }).toString(),
              }).then((r) => {
                if (r.ok) return r.json() as Promise<unknown>;
                // 4xx ⇒ terminal: cookie gone/expired/rotated. 429/5xx ⇒
                // transient: throw a plain Error so the retry policy kicks in.
                if (r.status >= 400 && r.status < 500 && r.status !== 429) {
                  throw new TerminalGrantError(r.status);
                }
                throw new Error(`Token grant failed (transient): ${r.status}`);
              }),
            // A TerminalGrantError must pass through untouched so the retry
            // policy can refuse to retry it; anything else is transient.
            catch: (cause) =>
              cause instanceof TerminalGrantError ? cause : new TokenRefreshError({ cause }),
          });

          return yield* Effect.try({
            try: () => parseTokenResponse(raw),
            catch: (cause) => new TokenRefreshError({ cause }),
          });
        });

      const fetchTokenGrant = () =>
        Effect.gen(function* () {
          let lastError: TokenRefreshError = new TokenRefreshError({ cause: "no attempt" });
          for (let attempt = 0; ; attempt += 1) {
            const result = yield* Effect.either(fetchTokenGrantOnce());
            if (result._tag === "Right") return result.right;

            const err = result.left;
            // Terminal 4xx ⇒ genuinely logged out: stop immediately. Map to a
            // TokenRefreshError so the public surface stays a single error type.
            if (err instanceof TerminalGrantError) {
              return yield* Effect.fail(
                new TokenRefreshError({ cause: `invalid_grant (${err.status})` }),
              );
            }

            lastError = err;
            const delay = TOKEN_GRANT_RETRY_DELAYS_MS[attempt];
            if (delay === undefined) return yield* Effect.fail(lastError);
            yield* Effect.sleep(`${delay} millis`);
          }
        });

      // -----------------------------------------------------------------------
      // Shared single-flight for the /token GRANT itself (across refresh AND
      // bootstrap).
      //
      // The refresh path and the cold-start bootstrap path both POST /token
      // with the same HttpOnly cookie. Each rotates the session on the server,
      // so if a bootstrap (from loadSession on reload) races a 401-refresh
      // (from an authFetch firing on the same reload), the SECOND grant replays
      // the just-rotated cookie. The server now tolerates that within a grace
      // window, but it is still a wasted round-trip and can transiently fail
      // the losing call. The two paths kept SEPARATE single-flight guards
      // (`inFlightRefresh` vs `inFlightBootstrap`), so they could not dedupe
      // against each other. This shared guard wraps the network grant so a
      // bootstrap-racing-refresh in one tab fires /token exactly once; both
      // paths then apply their own account-shaping to the shared result.
      // (Cross-TAB coordination — a Web Locks guard — is a further improvement
      // left for a follow-up; the server grace window already prevents
      // cross-tab races from revoking the family.)
      // -----------------------------------------------------------------------
      type GrantEither =
        | { readonly _tag: "Left"; readonly left: TokenRefreshError }
        | { readonly _tag: "Right"; readonly right: ReturnType<typeof parseTokenResponse> };
      let inFlightGrant: Promise<GrantEither> | null = null;

      const sharedTokenGrant = () =>
        Effect.gen(function* () {
          if (!inFlightGrant) {
            const promise = Effect.runPromise(
              Effect.either(fetchTokenGrant()),
            ) as Promise<GrantEither>;
            inFlightGrant = promise;
            void promise.finally(() => {
              if (inFlightGrant === promise) inFlightGrant = null;
            });
          }
          const result = yield* Effect.tryPromise({
            try: () => inFlightGrant!,
            catch: (cause) => new TokenRefreshError({ cause }),
          });
          if (result._tag === "Left") return yield* Effect.fail(result.left);
          return result.right;
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
          const next = yield* sharedTokenGrant();

          const profileId = extractJwtSub(next.accessToken) ?? account.activeProfileId;
          account.profileTokens[profileId] = {
            accessToken: next.accessToken,
            expiresAt: next.expiresAt,
          };
          // C3: refresh token lives in the HttpOnly cookie; the fact that this
          // refresh call succeeded is itself proof the cookie is alive.
          account.hasSession = true;
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

      // -----------------------------------------------------------------------
      // Cold-start bootstrap (production login-loop fix).
      //
      // After a full-page navigation following a successful passkey sign-in,
      // a fresh AuthProvider has NO stored account, yet the HttpOnly refresh
      // cookie that /login/passkey/complete just set is alive. Treating "no
      // local account" as logged-out makes RequireAuth bounce back to /login —
      // the loop. Instead, replay the cookie against /token once and rebuild
      // the account from the token response.
      //
      // Single-flighted on its own promise (concurrent fresh-mount loaders must
      // not double-hit /token — replaying a rotated cookie trips C2 reuse
      // detection). On any failure (no/expired cookie → non-2xx, or network),
      // resolve to null: genuinely logged out, fail-safe, no throw.
      // -----------------------------------------------------------------------
      let inFlightBootstrap: Promise<RefreshEither> | null = null;

      const doBootstrap = () =>
        Effect.gen(function* () {
          const next = yield* sharedTokenGrant();

          // The access token's `sub` is the active profile id.
          const profileId = extractJwtSub(next.accessToken) ?? "default";
          const account: AccountSession = {
            hasSession: true,
            activeProfileId: profileId,
            profileTokens: {
              [profileId]: {
                accessToken: next.accessToken,
                expiresAt: next.expiresAt,
              },
            },
            scopes: next.scopes,
            idToken: next.idToken,
          };
          yield* saveAccountSession(account);
          return next;
        });

      const bootstrapFromCookie = () =>
        Effect.gen(function* () {
          if (!inFlightBootstrap) {
            const promise = Effect.runPromise(
              Effect.either(doBootstrap()),
            ) as Promise<RefreshEither>;
            inFlightBootstrap = promise;
            void promise.finally(() => {
              if (inFlightBootstrap === promise) inFlightBootstrap = null;
            });
          }

          // The shared promise is Either-wrapped so it never rejects; any
          // failure (bad cookie, network, storage) arrives as a Left and maps
          // to null — a failed bootstrap means "logged out", never a throw.
          // A defensive orElse covers the should-never-happen rejection too.
          const result = yield* Effect.tryPromise({
            try: () => inFlightBootstrap!,
            catch: (cause) => new TokenRefreshError({ cause }),
          }).pipe(
            Effect.map((r): Session | null => (r._tag === "Left" ? null : r.right)),
            Effect.orElseSucceed((): Session | null => null),
          );

          return result;
        });

      // loadSession — the session-load entry point the SolidJS resource calls
      // on mount. Three cases, in order:
      //
      //   1. No stored account → cold-start bootstrap from the HttpOnly cookie
      //      (post-login full-page navigation).
      //   2. Stored account WITH a still-valid cached access token → return it
      //      directly (the fast path; no /token roundtrip).
      //   3. Stored account whose cached access token has EXPIRED but which
      //      still believes it `hasSession` → rehydrate from the cookie. This
      //      is the common reload case: access tokens live only in memory with
      //      a 5-minute TTL, so the persisted copy in localStorage is almost
      //      always stale on reload. Without this branch, `toSession` returns
      //      null for an expired token and the user is bounced to sign-in even
      //      though the 30-day refresh cookie is alive — the production
      //      "logged out on every reload" bug. We reuse the same cookie grant
      //      as the cold-start path (single-flighted, retry/backoff on
      //      transient errors, fail-safe to null on a terminal invalid_grant).
      const loadSession = () =>
        Effect.gen(function* () {
          const account = yield* getAccountSession();
          if (!account) return yield* bootstrapFromCookie();

          const live = toSession(account);
          if (live) return live;

          // Cached access token is expired (or absent). If the account still
          // holds a server session, the refresh cookie should rehydrate it.
          if (account.hasSession) return yield* bootstrapFromCookie();
          return null;
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
        getSession,
        loadSession,
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
