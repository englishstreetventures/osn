import {
  createContext,
  createMemo,
  createResource,
  useContext,
  type Accessor,
  type ParentProps,
  type Resource,
} from "solid-js";

import {
  createAuthFetch,
  fetchSession,
  signOut,
  startSignIn,
  type AuthFetch,
  type RpAuthConfig,
  type RpSession,
  type SignOutOptions,
} from "./index";

/**
 * SolidJS binding for `@shared/rp-auth`.
 *
 * Deliberately the same member names `@osn/client/solid` exposes — `session`,
 * `activeProfileId`, `authFetch`, `logout` — so a relying party that used to
 * run the passkey ceremony itself swaps the import path and leaves its
 * components alone. What is gone is everything the app's own API cannot
 * answer: profile lists, profile switching, session adoption. Those belong to
 * the identity app now, and stubbing them here would only hide that.
 */

export interface RpAuthContextValue {
  /** `undefined` while loading, `null` when signed out. */
  session: Resource<RpSession | null>;
  /** The `usr_*` profile id, or `null`. Convenience over `session()`. */
  activeProfileId: Accessor<string | null>;
  /** `fetch` with the session cookie; throws `AuthExpiredError` on 401. */
  authFetch: AuthFetch;
  /** Leave for the issuer. Full-page navigation — nothing after it runs. */
  signIn: (returnTo?: string) => void;
  logout: (options?: SignOutOptions) => Promise<void>;
  /** Re-read the session, e.g. after an action that may have ended it. */
  refresh: () => Promise<RpSession | null | undefined>;
}

export const AuthContext = createContext<RpAuthContextValue>();

interface AuthProviderProps extends ParentProps {
  config: RpAuthConfig;
}

export function AuthProvider(props: AuthProviderProps) {
  const authFetch = createAuthFetch(props.config);

  // The session probe runs on mount for every visitor, signed in or not. It is
  // one request against the app's own API and it is the only way to know: the
  // cookie is HttpOnly, so the browser cannot read it.
  const [session, { refetch, mutate }] = createResource<RpSession | null>(() =>
    fetchSession(props.config),
  );

  const activeProfileId = createMemo(() => session()?.osnProfileId ?? null);

  const signIn = (returnTo?: string) => startSignIn(props.config, returnTo);

  const logout = async (options?: SignOutOptions) => {
    await signOut(props.config, options);
    // Mutate before refetching so the UI drops to signed-out immediately
    // rather than holding the stale session for one round trip.
    mutate(null);
    await refetch();
  };

  // Wrapped, not passed straight through: Solid's `refetch` takes an optional
  // `info` argument and may return the value synchronously, so it does not fit
  // the plain `() => Promise<…>` the consumers see.
  const refresh = async () => await refetch();

  return (
    <AuthContext.Provider value={{ session, activeProfileId, authFetch, signIn, logout, refresh }}>
      {props.children}
    </AuthContext.Provider>
  );
}

export function useAuth(): RpAuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
