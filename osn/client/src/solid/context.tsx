import { Effect } from "effect";
import {
  createComputed,
  createContext,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
  useContext,
  type Accessor,
  type ParentProps,
  type Resource,
} from "solid-js";

import { isAuthExpiredError } from "../errors";
import type { AuthFetch, OsnAuthRuntime } from "../runtime";
import { OsnAuth } from "../service";
import type { HeldSession, PublicProfile, Session } from "../tokens";

interface AuthContextValue {
  session: Resource<Session | null>;
  /**
   * The account's profiles. A list that fails to load never throws when read:
   * it keeps the last list it had (null before the first) and sets
   * {@link AuthContextValue.profilesError}.
   */
  profiles: Resource<PublicProfile[] | null>;
  /**
   * Why the last profile list failed, for `describeAuthError`; undefined once
   * a list loads, while signed out, and when the session ended on the way —
   * the end itself is the news then, not the list.
   */
  profilesError: Accessor<unknown>;
  /** Lists the account's profiles again: the retry for a failed list. */
  refetchProfiles: () => Promise<void>;
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
   * The runtime's `authFetch`: sends the active profile's access token and
   * renews it. Build authenticated clients with it. When it rejects with
   * `AuthExpiredError` the session the request was made for is gone: this
   * provider has already gone to the signed-out state, or holds the session
   * that replaced it.
   */
  authFetch: AuthFetch;
}

export const AuthContext = createContext<AuthContextValue>();

interface AuthProviderProps extends ParentProps {
  /**
   * The page's auth runtime, from `createOsnAuthRuntime`. Pass the same one to
   * every provider on the page and build every authenticated client with its
   * `authFetch`: one runtime is one session cache and one set of single-flight
   * guards, so two providers never race each other for a `/token` grant.
   * Read once, at mount.
   */
  auth: OsnAuthRuntime;
}

export function AuthProvider(props: AuthProviderProps) {
  // Read once: the runtime lives as long as the page.
  const runtime = props.auth;
  const run = runtime.run;

  // On mount this calls loadSession (not getSession): when there is no stored
  // account it bootstraps from the HttpOnly refresh cookie via /token before
  // concluding "logged out", so a post-login full-page navigation re-establishes
  // the session instead of bouncing RequireAuth back to /login.
  const [session, { refetch: refetchSession, mutate: mutateSession }] =
    createResource<Session | null>(() =>
      run(Effect.flatMap(OsnAuth, (auth) => auth.loadSession())),
    );

  // Gate profiles on whether a session exists — not on the session object,
  // which is new after every refetch: a profile switch or reset changes the
  // active profile, not the account's list. SolidJS fires the fetcher only
  // when the source turns truthy, so a signed-out page lists nothing. The
  // calls that change the list (adopt, create, delete) refetch it themselves.
  // A session that failed to load counts as none: reading the resource then
  // would rethrow its error here, outside any boundary.
  //
  // A failed list keeps the one it had, so a shell drawn from it stays drawn,
  // and says why in `profilesError`. Losing the session, however it goes, moves
  // `profilesEpoch` on, and a list call that settles after that counts for
  // nothing: the runtime tells this provider a renewal was refused *before*
  // the call that asked for it rejects, so without the epoch the old account's
  // list, or an error about it, would land after the session was cleared.
  const [profilesError, setProfilesError] = createSignal<unknown>(undefined);
  let profilesEpoch = 0;
  const hasSession = createMemo(() => (!session.error && session() ? true : null));
  const [profiles, { mutate: mutateProfiles, refetch: refetchProfileList }] = createResource<
    PublicProfile[] | null,
    true
  >(hasSession, async (_, info) => {
    const epoch = profilesEpoch;
    try {
      const list = await run(Effect.flatMap(OsnAuth, (auth) => auth.listProfiles()));
      if (epoch !== profilesEpoch) return null;
      setProfilesError(undefined);
      return list;
    } catch (err) {
      if (epoch !== profilesEpoch || isAuthExpiredError(err)) return null;
      setProfilesError(err);
      return info.value ?? null;
    }
  });

  /** Signed out: no list, no error, and nothing in flight may set either. */
  const clearProfiles = () => {
    profilesEpoch += 1;
    mutateProfiles(null);
    setProfilesError(undefined);
  };

  // A list belongs to the session it was listed for. Whatever takes the
  // session away — `ended`, a log out, a session reload that finds none or
  // fails — takes the list and its error too, so the next account's first
  // list, if it fails, has no earlier list to keep.
  createComputed(
    on(
      hasSession,
      (has, had) => {
        if (!has && had) clearProfiles();
      },
      { defer: true },
    ),
  );

  const refetchProfiles = async () => {
    await refetchProfileList();
  };

  const [activeProfileId, setActiveProfileId] = createSignal<string | null>(null);

  // The runtime changes the session on its own when a renewal is refused or
  // the active profile has to fall back to the default one. An ended session
  // is set to null, not refetched: a refetch would spend a `/token` grant the
  // issuer has just refused. A reset refetches the session from the runtime's
  // cache, which already holds the default profile's fresh token, so it sends
  // nothing; the profile list is keyed on a session existing, so it is not
  // listed again.
  onCleanup(
    runtime.onSessionChange((change) => {
      if (change.kind === "ended") {
        mutateSession(null);
        clearProfiles();
        setActiveProfileId(null);
        return;
      }
      setActiveProfileId(change.profileId);
      void refetchSession();
    }),
  );

  // Derive activeProfileId reactively from session state instead of
  // a fire-and-forget initialisation call.
  createEffect(() => {
    const sess = session.error ? null : session();
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
    clearProfiles();
    setActiveProfileId(null);
  };

  const adoptSession = async (next: Session) => {
    // A first session turns the list's source on, so the list loads by
    // itself; listing here as well would send the same request twice. A
    // session that replaces another leaves the source on, so list again.
    const replacing = !session.error && session.latest != null;
    await run(Effect.flatMap(OsnAuth, (auth) => auth.setSession(next)));
    // The old account's list goes with its session, and nothing still in
    // flight for it may land, so a failed list for the new one shows none.
    if (replacing) clearProfiles();
    await refetchSession();
    if (replacing) await refetchProfiles();
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

  const authFetch = runtime.authFetch;

  return (
    <AuthContext.Provider
      value={{
        session,
        profiles,
        profilesError,
        refetchProfiles,
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
