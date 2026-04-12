import { Effect, Layer } from "effect";
import {
  createContext,
  createResource,
  useContext,
  type ParentProps,
  type Resource,
} from "solid-js";

import { OsnAuth, createOsnAuthLive, type OsnAuthConfig } from "../service";
import { StorageLive } from "../storage";
import type { Session } from "../tokens";

interface AuthContextValue {
  session: Resource<Session | null>;
  login: (redirectUri: string, scopes?: string[]) => void;
  logout: () => Promise<void>;
  handleCallback: (params: { code: string; state: string; redirectUri: string }) => Promise<void>;
  /**
   * Persists a Session obtained from the registration flow (or any other
   * out-of-band source) and refetches the session resource so the UI updates.
   */
  adoptSession: (session: Session) => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>();

interface AuthProviderProps extends ParentProps {
  config: OsnAuthConfig;
}

export function AuthProvider(props: AuthProviderProps) {
  const layer = createOsnAuthLive(props.config).pipe(Layer.provide(StorageLive));

  const run = <A,>(eff: Effect.Effect<A, unknown, OsnAuth>): Promise<A> =>
    Effect.runPromise(
      Effect.provide(eff, layer).pipe(Effect.orDie) as Effect.Effect<A, never, never>,
    );

  const [session, { refetch }] = createResource<Session | null>(() =>
    run(Effect.flatMap(OsnAuth, (auth) => auth.getSession())),
  );

  const login = (redirectUri: string, scopes?: string[]) => {
    run(
      Effect.flatMap(OsnAuth, (auth) =>
        Effect.flatMap(auth.startLogin({ redirectUri, scopes }), ({ authorizationUrl }) =>
          Effect.sync(() => {
            window.location.href = authorizationUrl;
          }),
        ),
      ),
    );
  };

  const logout = async () => {
    await run(Effect.flatMap(OsnAuth, (auth) => auth.logout()));
    refetch();
  };

  const handleCallback = async (params: { code: string; state: string; redirectUri: string }) => {
    await run(Effect.flatMap(OsnAuth, (auth) => auth.handleCallback(params)));
    refetch();
  };

  const adoptSession = async (next: Session) => {
    await run(Effect.flatMap(OsnAuth, (auth) => auth.setSession(next)));
    refetch();
  };

  return (
    <AuthContext.Provider value={{ session, login, logout, handleCallback, adoptSession }}>
      {props.children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
