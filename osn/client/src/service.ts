import { Context, Effect, Layer } from "effect";

import {
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

      const refreshSession = () =>
        Effect.gen(function* () {
          const account = yield* getAccountSession();
          if (!account?.refreshToken) {
            return yield* Effect.fail(
              new TokenRefreshError({ cause: "No refresh token available" }),
            );
          }

          const raw = yield* Effect.tryPromise({
            try: () =>
              fetch(`${config.issuerUrl}/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  grant_type: "refresh_token",
                  refresh_token: account.refreshToken,
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

      const logout = () =>
        Effect.gen(function* () {
          cache = null;
          yield* storage.remove(ACCOUNT_SESSION_KEY);
        });

      const setSession = (session: Session) => saveAccountSession(sessionToAccountSession(session));

      // ---------------------------------------------------------------------------
      // Profile management methods (P4)
      // ---------------------------------------------------------------------------

      // S-H1: These endpoints currently require the refresh token in the request
      // body (server API design from P2/P3). A follow-up should migrate the server
      // to accept Bearer access-token auth instead, reducing refresh-token exposure.
      // Tracked in wiki/TODO.md security backlog.

      const listProfiles = () =>
        Effect.gen(function* () {
          const account = yield* getAccountSession();
          if (!account?.refreshToken) {
            return yield* Effect.fail(
              new ProfileManagementError({ cause: "No session available" }),
            );
          }

          // S-M4: Validate response schema
          const res = yield* Effect.tryPromise({
            try: async () => {
              const r = await fetch(`${config.issuerUrl}/profiles/list`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ refresh_token: account.refreshToken }),
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
          if (!account?.refreshToken) {
            return yield* Effect.fail(
              new ProfileManagementError({ cause: "No session available" }),
            );
          }

          // S-M4: Validate response schema
          const res = yield* Effect.tryPromise({
            try: async () => {
              const r = await fetch(`${config.issuerUrl}/profiles/switch`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  refresh_token: account.refreshToken,
                  profile_id: profileId,
                }),
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
          if (!account?.refreshToken) {
            return yield* Effect.fail(
              new ProfileManagementError({ cause: "No session available" }),
            );
          }

          const body: Record<string, string> = {
            refresh_token: account.refreshToken,
            handle,
          };
          if (displayName !== undefined) body.display_name = displayName;

          // S-M4: Validate response schema
          const res = yield* Effect.tryPromise({
            try: async () => {
              const r = await fetch(`${config.issuerUrl}/profiles/create`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
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
          if (!account?.refreshToken) {
            return yield* Effect.fail(
              new ProfileManagementError({ cause: "No session available" }),
            );
          }

          yield* Effect.tryPromise({
            try: async () => {
              const r = await fetch(`${config.issuerUrl}/profiles/delete`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  refresh_token: account.refreshToken,
                  profile_id: profileId,
                }),
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
      };
    }),
  );
}
