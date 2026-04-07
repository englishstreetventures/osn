import { Context, Effect, Layer } from "effect";
import { generateCodeChallenge, generateCodeVerifier } from "./pkce";
import { parseTokenResponse } from "./tokens";
import { Storage } from "./storage";
import {
  AuthorizationError,
  StateMismatchError,
  StorageError,
  TokenExchangeError,
  TokenRefreshError,
} from "./errors";
import type { Session } from "./tokens";

const SESSION_KEY = "@osn/client:session";
const VERIFIER_KEY = "@osn/client:pkce_verifier";
const STATE_KEY = "@osn/client:state";

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
}

export class OsnAuth extends Context.Tag("@osn/client/OsnAuth")<OsnAuth, OsnAuthService>() {}

export function createOsnAuthLive(config: OsnAuthConfig): Layer.Layer<OsnAuth, never, Storage> {
  return Layer.effect(
    OsnAuth,
    Effect.gen(function* () {
      const storage = yield* Storage;

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

          yield* storage.set(SESSION_KEY, JSON.stringify(session));
          yield* storage.remove(VERIFIER_KEY);
          yield* storage.remove(STATE_KEY);

          return session;
        });

      const getSession = () =>
        Effect.gen(function* () {
          const raw = yield* storage.get(SESSION_KEY);
          if (!raw) return null;
          const session = JSON.parse(raw) as Session;
          if (Date.now() >= session.expiresAt) {
            yield* storage.remove(SESSION_KEY);
            return null;
          }
          return session;
        });

      const refreshSession = () =>
        Effect.gen(function* () {
          const session = yield* getSession();
          if (!session?.refreshToken) {
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
                  refresh_token: session.refreshToken!,
                  client_id: config.clientId,
                }).toString(),
              }).then((r) => r.json() as Promise<unknown>),
            catch: (cause) => new TokenRefreshError({ cause }),
          });

          const next = yield* Effect.try({
            try: () => parseTokenResponse(raw),
            catch: (cause) => new TokenRefreshError({ cause }),
          });

          yield* storage.set(SESSION_KEY, JSON.stringify(next));
          return next;
        });

      const logout = () => storage.remove(SESSION_KEY);

      const setSession = (session: Session) => storage.set(SESSION_KEY, JSON.stringify(session));

      return { startLogin, handleCallback, getSession, refreshSession, logout, setSession };
    }),
  );
}
