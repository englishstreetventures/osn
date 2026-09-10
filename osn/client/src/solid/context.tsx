import { Effect, Layer } from "effect";
import {
  createContext,
  createEffect,
  createResource,
  createSignal,
  useContext,
  type Accessor,
  type ParentProps,
  type Resource,
} from "solid-js";

import { OsnAuth, createOsnAuthLive, type OsnAuthConfig } from "../service";
import { Storage, StorageLive } from "../storage";
import type { HeldSession, PublicProfile, Session } from "../tokens";

interface AuthContextValue {
  session: Resource<Session | null>;
  profiles: Resource<PublicProfile[] | null>;
  activeProfileId: Accessor<string | null>;
  logout: () => Promise<void>;
  /**
   * Persists a Session obtained from the registration flow (or any other
   * out-of-band source) and refetches the session resource so the UI updates.
   */
  adoptSession: (session: Session) => Promise<void>;
  /**
   * Redeems the refresh cookie for a fresh token set and returns it **without**
   * adopting it — the session resource is not refetched and nothing is stored.
   *
   * The counterpart to {@link AuthContextValue.adoptSession} for a flow that
   * holds a session rather than publishing one, and the only refresh path such
   * a flow has: holding the token keeps it outside `authFetch`, so the silent
   * refresh every other screen relies on never runs. Post-recovery passkey
   * enrolment is the caller. Rejects when the issuer refuses the grant, which
   * for a restricted session means its absolute deadline has passed.
   *
   * Resolves to a `HeldSession`, not a `Session` — `adoptSession` doesn't
   * accept one, so `adoptSession(await refreshHeldSession())` is a compile
   * error rather than a way to publish a restricted `osn-recovery` token.
   */
  refreshHeldSession: () => Promise<HeldSession>;
  switchProfile: (profileId: string) => Promise<{ session: Session; profile: PublicProfile }>;
  createProfile: (handle: string, displayName?: string) => Promise<PublicProfile>;
  deleteProfile: (profileId: string) => Promise<void>;
  /**
   * Access-token-aware fetch with silent refresh on 401. Mirrors
   * `OsnAuthService.authFetch`, wrapped for Promise-returning Solid
   * consumers. Throws on `AuthExpiredError` so callers can redirect to
   * sign-in.
   */
  authFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export const AuthContext = createContext<AuthContextValue>();

interface AuthProviderProps extends ParentProps {
  config: OsnAuthConfig;
  /**
   * The `Storage` layer backing the session. Defaults to `StorageLive`
   * (`localStorage`). Callers on a platform where `localStorage` must never
   * hold auth data (e.g. iOS) pass a different layer, such as
   * `createEphemeralStorage()`.
   */
  storage?: Layer.Layer<Storage>;
}

export function AuthProvider(props: AuthProviderProps) {
  const layer = createOsnAuthLive(props.config).pipe(Layer.provide(props.storage ?? StorageLive));

  const run = <A,>(eff: Effect.Effect<A, unknown, OsnAuth>): Promise<A> =>
    Effect.runPromise(
      Effect.provide(eff, layer).pipe(Effect.orDie) as Effect.Effect<A, never, never>,
    );

  // On mount this calls loadSession (not getSession): when there is no stored
  // account it bootstraps from the HttpOnly refresh cookie via /token before
  // concluding "logged out", so a post-login full-page navigation re-establishes
  // the session instead of bouncing RequireAuth back to /login.
  const [session, { refetch: refetchSession }] = createResource<Session | null>(() =>
    run(Effect.flatMap(OsnAuth, (auth) => auth.loadSession())),
  );

  // Gate profiles on session — only fetch when a session exists.
  // SolidJS createResource with a source signal only fires the fetcher when
  // the source is truthy, preventing wasted requests for unauthenticated users.
  const [profiles, { mutate: mutateProfiles, refetch: refetchProfiles }] = createResource<
    PublicProfile[] | null,
    Session | null
  >(
    () => session() ?? null,
    (sess) => {
      if (!sess) return Promise.resolve(null);
      return run(Effect.flatMap(OsnAuth, (auth) => auth.listProfiles()));
    },
  );

  const [activeProfileId, setActiveProfileId] = createSignal<string | null>(null);

  // Derive activeProfileId reactively from session state instead of
  // a fire-and-forget initialisation call.
  createEffect(() => {
    const sess = session();
    if (sess) {
      run(Effect.flatMap(OsnAuth, (auth) => auth.getActiveProfile())).then(setActiveProfileId, () =>
        setActiveProfileId(null),
      );
    } else if (sess === null) {
      setActiveProfileId(null);
    }
  });

  const logout = async () => {
    await run(Effect.flatMap(OsnAuth, (auth) => auth.logout()));
    await refetchSession();
    mutateProfiles(null);
    setActiveProfileId(null);
  };

  const adoptSession = async (next: Session) => {
    await run(Effect.flatMap(OsnAuth, (auth) => auth.setSession(next)));
    await refetchSession();
    await refetchProfiles();
  };

  // No `refetchSession`, deliberately: adopting is the caller's decision and
  // this is the path for the flows that have decided not to.
  const refreshHeldSession = () =>
    run(Effect.flatMap(OsnAuth, (auth) => auth.refreshHeldSession()));

  const switchProfile = async (profileId: string) => {
    const result = await run(Effect.flatMap(OsnAuth, (auth) => auth.switchProfile(profileId)));
    await refetchSession();
    setActiveProfileId(result.profile.id);
    return result;
  };

  const createProfile = async (handle: string, displayName?: string) => {
    const profile = await run(
      Effect.flatMap(OsnAuth, (auth) => auth.createProfile(handle, displayName)),
    );
    await refetchProfiles();
    return profile;
  };

  const deleteProfile = async (profileId: string) => {
    await run(Effect.flatMap(OsnAuth, (auth) => auth.deleteProfile(profileId)));
    await refetchSession();
    await refetchProfiles();
  };

  const authFetch = (input: RequestInfo | URL, init?: RequestInit) =>
    run(Effect.flatMap(OsnAuth, (auth) => auth.authFetch(input, init)));

  return (
    <AuthContext.Provider
      value={{
        session,
        profiles,
        activeProfileId,
        logout,
        adoptSession,
        refreshHeldSession,
        switchProfile,
        createProfile,
        deleteProfile,
        authFetch,
      }}
    >
      {props.children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
