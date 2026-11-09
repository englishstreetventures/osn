import { Context, Effect, Layer } from "effect";

import {
  ActiveProfileResetError,
  AuthExpiredError,
  AuthFetchTransportError,
  ProfileManagementError,
  StorageError,
  TokenRefreshError,
} from "./errors";
import { errorCode, safeJson } from "./response-body";
import type { SessionChange } from "./runtime";
import { sessionFetch } from "./session-fetch";
import { Storage } from "./storage";
import {
  decodeAccountSession,
  decodeCreateProfileResponse,
  decodeListProfilesResponse,
  decodeSwitchProfileResponse,
  extractJwtLifetimeMs,
  extractJwtSub,
  parseTokenResponse,
} from "./tokens";
import type { AccountSession, HeldSession, ProfileToken, PublicProfile, Session } from "./tokens";

const ACCOUNT_SESSION_KEY = "@osn/client:account_session";

/**
 * The JS-readable marker the issuer sets next to the HttpOnly session cookie.
 * Mirrors `SESSION_MARKER_COOKIE_NAME` in `@osn/api` — the two must agree.
 */
const SESSION_MARKER_COOKIE = "osn_has_session";

/**
 * Does this browser claim to hold a session cookie?
 *
 * The session cookie is HttpOnly, so a page cannot ask "am I signed in?"
 * without spending a `POST /token`. That made every anonymous page load — and
 * every bot crawl — a write against the issuer: three requests, once retries
 * are counted. The marker answers the question locally.
 *
 * The marker carries no secret and grants nothing; a forged one buys the
 * forger a single 400. It is only ever read to decide whether a grant is worth
 * attempting, never to decide that someone IS signed in.
 *
 * Outside a browser (iOS, SSR, tests) there is no `document` and no cookie jar
 * to read — the native transport keeps the cookie in the Keychain — so assume
 * a session may exist and let the grant decide, exactly as before.
 */
function hasSessionMarker(): boolean {
  if (typeof document === "undefined") return true;
  return document.cookie
    .split(";")
    .some((part) => part.trim().startsWith(`${SESSION_MARKER_COOKIE}=1`));
}

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
 * How long before its expiry an access token is renewed rather than sent: 30 s,
 * the clock tolerance osn-api verifies with, or half the token's own lifetime
 * when that is shorter. The cap keeps an issuer configured with a short TTL
 * from turning every request into a `/token` rotation first. A token that
 * carries no `iat`/`exp` gets the full 30 s.
 */
const ACCESS_TOKEN_RENEW_LEAD_MS = 30_000;

function renewLeadMs(accessToken: string): number {
  const lifetime = extractJwtLifetimeMs(accessToken);
  return lifetime === null
    ? ACCESS_TOKEN_RENEW_LEAD_MS
    : Math.min(ACCESS_TOKEN_RENEW_LEAD_MS, lifetime / 2);
}

/** True when the token is missing, expired, or inside its renew lead. */
function needsRenewal(token: ProfileToken | undefined): boolean {
  return !token || Date.now() >= token.expiresAt - renewLeadMs(token.accessToken);
}

/**
 * The text of the failure osn-api answers a grant with when a concurrent grant
 * of the same cookie rotated it first. Mirrors `ROTATION_RACE_MESSAGE` in
 * `@osn/api` (`src/lib/grant-failure.ts`); the issuer sends it as the body's
 * `message`; `tests/token-grant-contract.test.ts` checks the two agree.
 */
const ROTATION_RACE_MESSAGE = "Session rotated by a concurrent grant";

/**
 * Did a `400 invalid_grant` leave the session's status unknown?
 *
 * osn-api refuses a grant with the same status whether the cookie is dead or a
 * concurrent grant rotated it first, or the database blipped; in the last two
 * the cookie is alive and the winning grant has already set its successor. The
 * issuer names those two in the body's `message`, and only the body is read:
 * the session marker is a cookie other origins can write, so it never decides
 * whether a refusal ends the session.
 */
function grantRefusalLeftStatusUnknown(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const { error, message } = body as { error?: unknown; message?: unknown };
  if (error !== "invalid_grant" || typeof message !== "string") return false;
  return message.includes(ROTATION_RACE_MESSAGE) || /^DatabaseError\b/.test(message);
}

/**
 * The longest pause a `Retry-After` on a refused-for-now grant can impose on
 * renewal. The issuer is trusted; the cap keeps one odd header from stopping
 * renewal for longer than a token lives.
 */
const RETRY_AFTER_MAX_MS = 60_000;

/** `Retry-After` in milliseconds when it is a whole number of seconds. */
function retryAfterMs(header: string | null): number | undefined {
  const value = header?.trim();
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Math.min(Number(value) * 1000, RETRY_AFTER_MAX_MS);
}

/**
 * Pauses between renewals after one fails without a refusal: 2 s, doubling to
 * 30 s, unless the issuer's `Retry-After` says otherwise. A renewal that gets
 * a token ends the pause.
 */
const RENEW_BACKOFF_FIRST_MS = 2_000;
const RENEW_BACKOFF_MAX_MS = 30_000;

/** True when `input` is an absolute URL on the issuer's origin. */
function onIssuerOrigin(input: string, issuerUrl: string): boolean {
  try {
    return new URL(input).origin === new URL(issuerUrl).origin;
  } catch {
    return false;
  }
}

/** Remove expired profile tokens from an AccountSession, except the active profile, so storage holds no dead tokens. */
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

  /**
   * Renews the active profile's access token through the refresh cookie and
   * returns the active profile's session. The grant names the active profile,
   * and the issuer mints for it while the account owns it. Single-flighted.
   *
   * Fails with `TokenRefreshError` (`refused` true when the issuer refused
   * the grant), or with `ActiveProfileResetError` when the issuer minted for
   * the default profile instead — the active one is gone — and the default
   * profile is active now.
   */
  readonly refreshSession: () => Effect.Effect<
    Session,
    TokenRefreshError | ActiveProfileResetError | StorageError
  >;

  /**
   * Redeems the refresh cookie for a fresh token set and hands it back
   * **without adopting it** — nothing is written to storage, nothing is
   * cached, and no session resource is refetched.
   *
   * For a flow that HOLDS a session rather than publishing one. Post-recovery
   * passkey enrolment is the case that needs it: its token carries
   * `aud: "osn-recovery"`, which every ordinary route rejects, and adopting it
   * would announce a signed-in user the rest of the app cannot serve. Holding
   * it also puts the flow outside `authFetch`, so the silent refresh that keeps
   * every other screen alive is unavailable — this is the replacement.
   *
   * Shares the single-flight `/token` grant with `refreshSession` and the
   * cold-start bootstrap, so a component calling this while the provider is
   * bootstrapping produces one request, not two. That matters: each grant
   * rotates the session server-side, and a second grant replaying the
   * rotated-out cookie is what reuse detection revokes a family for.
   *
   * Returns a {@link HeldSession}, not a `Session` — `adoptSession`/
   * `setSession` don't accept one, so the caller must unwrap `.session`
   * explicitly rather than being able to hand the result straight to either.
   *
   * @see wiki/osn/account-recovery-factors.md — the restricted session.
   */
  readonly refreshHeldSession: () => Effect.Effect<HeldSession, TokenRefreshError>;

  readonly logout: () => Effect.Effect<void, StorageError>;

  /**
   * Persists a Session that was obtained out-of-band (e.g. from the
   * email-verified registration flow, which returns a Session directly).
   */
  readonly setSession: (session: Session) => Effect.Effect<void, StorageError>;

  // The profile methods send through `authFetch`, so an expired token is
  // renewed first. "No session" stays a `ProfileManagementError`; a session
  // that ended on the way is an `AuthExpiredError`.
  readonly listProfiles: () => Effect.Effect<
    PublicProfile[],
    ProfileManagementError | AuthExpiredError | StorageError
  >;

  readonly switchProfile: (
    profileId: string,
  ) => Effect.Effect<
    { session: Session; profile: PublicProfile },
    ProfileManagementError | AuthExpiredError | StorageError
  >;

  readonly createProfile: (
    handle: string,
    displayName?: string,
  ) => Effect.Effect<PublicProfile, ProfileManagementError | AuthExpiredError | StorageError>;

  readonly deleteProfile: (
    profileId: string,
  ) => Effect.Effect<void, ProfileManagementError | AuthExpiredError | StorageError>;

  readonly getActiveProfile: () => Effect.Effect<string | null, StorageError>;

  /**
   * `fetch` with the active profile's access token, renewed as needed. The
   * contract is `AuthFetch`'s (`./runtime`): a token inside its renew lead is
   * renewed before the request goes out, a 401 is renewed and retried once,
   * and the session ends only on a refusal. `fetch`'s own rejection arrives as
   * `AuthFetchTransportError`.
   *
   * `Authorization` is always the account's token, whatever `init` carried;
   * nothing else in `init` is touched. `credentials` defaults to `"include"`.
   */
  readonly authFetch: (
    input: string,
    init?: RequestInit,
  ) => Effect.Effect<
    Response,
    | AuthExpiredError
    | TokenRefreshError
    | ActiveProfileResetError
    | AuthFetchTransportError
    | StorageError
  >;
}

export class OsnAuth extends Context.Service<OsnAuth, OsnAuthService>()("@osn/client/OsnAuth") {}

export interface OsnAuthLiveOptions {
  /**
   * Called after the service ends the session or resets the active profile
   * itself — never for `logout`, `setSession` or `switchProfile`, whose
   * callers already know. `createOsnAuthRuntime` fans it out to its listeners.
   */
  readonly onSessionChange?: (change: SessionChange) => void;
}

export function createOsnAuthLive(
  config: OsnAuthConfig,
  options?: OsnAuthLiveOptions,
): Layer.Layer<OsnAuth, never, Storage> {
  return Layer.effect(
    OsnAuth,
    Effect.gen(function* () {
      const storage = yield* Storage;

      // In-memory cache to avoid redundant storage reads + JSON.parse
      // undefined = not loaded, null = no session, AccountSession = loaded
      let cache: AccountSession | null | undefined;

      // The stored value this service last read or wrote. `syncFromStorage`
      // compares the stored string against it, so a call that finds storage
      // unchanged costs one read and no parse.
      let lastRaw: string | null = null;

      const notify = (change: SessionChange) => options?.onSessionChange?.(change);

      // ---------------------------------------------------------------------------
      // Internal helpers for the multi-key account session model
      // ---------------------------------------------------------------------------

      const saveAccountSession = (account: AccountSession) => {
        pruneExpiredTokens(account);
        cache = account;
        lastRaw = JSON.stringify(account);
        return storage.set(ACCOUNT_SESSION_KEY, lastRaw);
      };

      const getAccountSession = () =>
        Effect.gen(function* () {
          // Return cached value if available
          if (cache !== undefined) return cache;

          const raw = yield* storage.get(ACCOUNT_SESSION_KEY);
          lastRaw = raw;
          if (raw) {
            // Validate storage data against schema before consuming: any
            // script on the origin can write to it.
            try {
              const account = decodeAccountSession(JSON.parse(raw)) as AccountSession;
              cache = account;
              return account;
            } catch {
              yield* storage.remove(ACCOUNT_SESSION_KEY);
              cache = null;
              lastRaw = null;
              return null;
            }
          }

          cache = null;
          return null;
        });

      /**
       * Ends the session this service holds: clears the cache and the stored
       * account, then tells the listeners — once, however many callers end it.
       * It does not call `/logout`. A refusal means the issuer has already let
       * the session go, and the session marker is the issuer's to retract.
       */
      const endSession = () =>
        Effect.gen(function* () {
          const held = cache !== null && cache !== undefined;
          cache = null;
          lastRaw = null;
          yield* storage.remove(ACCOUNT_SESSION_KEY).pipe(Effect.catch(() => Effect.void));
          if (held) notify({ kind: "ended" });
        });

      /**
       * The account, brought up to date with what other tabs stored.
       *
       * Tabs share the stored account but each keeps its own active profile:
       * the profile a tab acts as is the one its screen shows, so it is never
       * taken from storage. What is taken is a token for that same profile
       * that expires later than ours — another tab renewed it, and using it
       * spares a grant. A stored account that has gone means another tab
       * signed out or saw the session end, so it ends here too, with no
       * request.
       */
      const syncFromStorage = () =>
        Effect.gen(function* () {
          const loaded = cache !== undefined;
          const account = yield* getAccountSession();
          if (!loaded || !account) return account;

          const raw = yield* storage.get(ACCOUNT_SESSION_KEY);
          if (raw === lastRaw) return account;
          if (raw === null) {
            yield* endSession();
            return null;
          }
          lastRaw = raw;
          let stored: AccountSession;
          try {
            stored = decodeAccountSession(JSON.parse(raw)) as AccountSession;
          } catch {
            return account;
          }
          const theirs = stored.profileTokens[account.activeProfileId];
          const ours = account.profileTokens[account.activeProfileId];
          if (theirs && (!ours || theirs.expiresAt > ours.expiresAt)) {
            account.profileTokens[account.activeProfileId] = theirs;
          }
          return account;
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
      //   - UNKNOWN (400 invalid_grant that the issuer marks as saying nothing
      //     about the cookie — a concurrent grant won the rotation, or the
      //     database blipped; see `grantRefusalLeftStatusUnknown`): the
      //     cookie is alive, and after a race the browser already holds the
      //     winner's successor. ONE retry after a short pause; a second
      //     unknown answer is transient, never terminal.
      //   - TRANSIENT (5xx): the cookie is probably still alive; the server
      //     just couldn't answer. Retry with bounded backoff before giving up
      //     so a momentary hiccup doesn't evict a live session.
      //   - RATE LIMITED (429): the issuer asked for fewer requests, and a
      //     retry inside the same window would be refused too. No retry; the
      //     failure carries any `Retry-After` for `renew`'s pause.
      //   - NETWORK (fetch rejects): could be a dropped connection, but it is
      //     equally a CORS refusal — the browser reports both as the same
      //     opaque TypeError. A refused origin never becomes an allowed one on
      //     the next attempt, so this class gets ONE retry, not two: enough for
      //     a genuine blip, not enough to turn a page load into a burst.
      // -----------------------------------------------------------------------

      // A 4xx from /token is a definitive "no/expired session" — surfaced as a
      // terminal failure that callers must NOT retry. Carries the status so the
      // retry policy can tell it apart from a transient/5xx error.
      class TerminalGrantError {
        readonly _tag = "TerminalGrantError";
        constructor(readonly status: number) {}
      }

      // A 400 the issuer marks as leaving the cookie's status unknown — see
      // UNKNOWN above.
      class UnknownGrantError {
        readonly _tag = "UnknownGrantError";
        constructor(readonly status: number) {}
      }

      // A 429, with the pause the issuer asked for when it gave one.
      class RateLimitedGrantError {
        readonly _tag = "RateLimitedGrantError";
        constructor(readonly retryAfterMs: number | undefined) {}
      }

      // `fetch` itself rejected — no response came back at all.
      class NetworkGrantError {
        readonly _tag = "NetworkGrantError";
        constructor(readonly cause: unknown) {}
      }

      // Bounded exponential backoff for a /token 5xx. Three attempts total
      // (~0 + 200ms + 400ms ≈ 0.6s worst case) keeps the cold-start path
      // responsive while absorbing a single Worker cold-start or transient
      // upstream blip. Terminal (4xx) failures and 429 short-circuit.
      const TOKEN_GRANT_RETRY_DELAYS_MS = [200, 400] as const;

      // Two attempts total for the network class — see NETWORK above.
      const NETWORK_GRANT_RETRY_DELAYS_MS = [200] as const;

      // Long enough for the winning grant's response, and the successor
      // cookie it sets, to reach the browser before the retry leaves.
      const UNKNOWN_GRANT_RETRY_DELAY_MS = 250;

      // `profileId` names the profile to mint for; with none the issuer mints
      // for the account's default profile.
      const fetchTokenGrantOnce = (profileId: string | undefined) =>
        Effect.gen(function* () {
          // The `fetch` call stands alone so that ONLY a transport failure can
          // be classified as network. `fetch` rejects with a `TypeError` for
          // transport failure specifically, but `TypeError` is a type JS reuses
          // for everything — with response handling inside this try, a genuine
          // parse or shape bug would be relabelled "network" and retried on the
          // wrong ladder, and no signal would distinguish the two.
          const response = yield* Effect.tryPromise({
            try: () =>
              sessionFetch(`${config.issuerUrl}/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                credentials: "include",
                body: new URLSearchParams(
                  profileId === undefined
                    ? { grant_type: "refresh_token" }
                    : { grant_type: "refresh_token", profile_id: profileId },
                ).toString(),
              }),
            catch: (cause) =>
              cause instanceof Error && cause.name === "TypeError"
                ? new NetworkGrantError(cause)
                : new TokenRefreshError({ cause }),
          });

          const raw = yield* Effect.tryPromise({
            try: async () => {
              if (response.ok) return (await response.json()) as unknown;
              // 4xx ⇒ terminal: cookie gone/expired/rotated, unless the
              // issuer marked a 400 as saying nothing about the cookie.
              // 429 ⇒ rate limited. 5xx ⇒ transient: throw a plain Error so
              // the retry policy kicks in.
              if (response.status === 429) {
                throw new RateLimitedGrantError(retryAfterMs(response.headers.get("retry-after")));
              }
              if (response.status >= 400 && response.status < 500) {
                const body: unknown = await response.json().catch(() => null);
                if (response.status === 400 && grantRefusalLeftStatusUnknown(body)) {
                  throw new UnknownGrantError(response.status);
                }
                throw new TerminalGrantError(response.status);
              }
              throw new Error(`Token grant failed (transient): ${response.status}`);
            },
            // The two refusal classes must pass through untouched so the retry
            // policy can tell them apart. Everything else here — a transient
            // status, a body that will not parse — is a plain transient failure.
            catch: (cause) =>
              cause instanceof TerminalGrantError ||
              cause instanceof UnknownGrantError ||
              cause instanceof RateLimitedGrantError
                ? cause
                : new TokenRefreshError({ cause }),
          });

          return yield* Effect.try({
            try: () => parseTokenResponse(raw),
            catch: (cause) => new TokenRefreshError({ cause }),
          });
        });

      const fetchTokenGrant = (profileId: string | undefined) =>
        Effect.gen(function* () {
          let lastError: TokenRefreshError = new TokenRefreshError({ cause: "no attempt" });
          let unknownRetried = false;
          let attempt = 0;
          for (;;) {
            const result = yield* Effect.result(fetchTokenGrantOnce(profileId));
            if (result._tag === "Success") return result.success;

            const err = result.failure;
            // Terminal 4xx ⇒ genuinely logged out: stop immediately. Map to a
            // TokenRefreshError so the public surface stays a single error
            // type; `refused` is what tells callers the session is over.
            if (err instanceof TerminalGrantError) {
              return yield* Effect.fail(
                new TokenRefreshError({ cause: `invalid_grant (${err.status})`, refused: true }),
              );
            }

            if (err instanceof RateLimitedGrantError) {
              return yield* Effect.fail(
                new TokenRefreshError({
                  cause: "token grant rate limited (429)",
                  retryAfterMs: err.retryAfterMs,
                }),
              );
            }

            if (err instanceof UnknownGrantError) {
              if (unknownRetried) {
                return yield* Effect.fail(
                  new TokenRefreshError({ cause: `invalid_grant (${err.status}), status unknown` }),
                );
              }
              unknownRetried = true;
              yield* Effect.sleep(`${UNKNOWN_GRANT_RETRY_DELAY_MS} millis`);
              continue;
            }

            const isNetwork = err instanceof NetworkGrantError;
            lastError = isNetwork ? new TokenRefreshError({ cause: err.cause }) : err;
            const delays = isNetwork ? NETWORK_GRANT_RETRY_DELAYS_MS : TOKEN_GRANT_RETRY_DELAYS_MS;
            const delay: number | undefined = delays[attempt];
            if (delay === undefined) return yield* Effect.fail(lastError);
            attempt += 1;
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
      //
      // A caller that wants a profile joins any grant in flight, and keeps
      // its result when that grant minted for the profile it wants — the
      // default profile's renewal joining a reload's bootstrap, say. When it
      // did not, the caller sends its own grant after that one, never
      // alongside it, so two grants of one cookie never overlap.
      // -----------------------------------------------------------------------
      type GrantResult =
        | { readonly _tag: "Failure"; readonly failure: TokenRefreshError }
        | { readonly _tag: "Success"; readonly success: ReturnType<typeof parseTokenResponse> };
      interface GrantInFlight {
        readonly profileId: string | undefined;
        readonly promise: Promise<GrantResult>;
      }
      let inFlightGrant: GrantInFlight | null = null;

      const startGrant = (profileId: string | undefined): GrantInFlight => {
        const promise = Effect.runPromise(
          Effect.result(fetchTokenGrant(profileId)),
        ) as Promise<GrantResult>;
        const entry = { profileId, promise };
        inFlightGrant = entry;
        void promise.finally(() => {
          if (inFlightGrant === entry) inFlightGrant = null;
        });
        return entry;
      };

      const sharedTokenGrant = (profileId?: string) =>
        Effect.gen(function* () {
          for (;;) {
            const entry = inFlightGrant ?? startGrant(profileId);
            const result = yield* Effect.tryPromise({
              try: () => entry.promise,
              catch: (cause) => new TokenRefreshError({ cause }),
            });
            if (result._tag === "Failure") return yield* Effect.fail(result.failure);
            if (
              profileId === undefined ||
              entry.profileId === profileId ||
              extractJwtSub(result.success.accessToken) === profileId
            ) {
              return result.success;
            }
            if (inFlightGrant === entry) inFlightGrant = null;
          }
        });

      // -----------------------------------------------------------------------
      // Single-flight refresh.
      //
      // Multiple concurrent authFetch calls that all 401 must NOT each fire
      // /token. The server rotates the session token on every grant (Copenhagen
      // Book C2); replaying the rotated-out cookie value a second time trips
      // reuse detection and revokes every session in the family — the user
      // gets logged out across all devices.
      //
      // Store the in-flight refresh as a shared Promise<Result>. Concurrent
      // callers join it instead of kicking off a second /token roundtrip.
      // -----------------------------------------------------------------------

      type RefreshResult =
        | {
            readonly _tag: "Failure";
            readonly failure: TokenRefreshError | ActiveProfileResetError | StorageError;
          }
        | { readonly _tag: "Success"; readonly success: Session };
      let inFlightRefresh: Promise<RefreshResult> | null = null;

      // After a renewal fails without a refusal, `renew` sends nothing until
      // this time. Set and cleared only in `refreshSession`, once per renewal
      // however many callers joined it.
      let renewBackoffMs = 0;
      let renewBlockedUntil = 0;

      const noteRenewal = (result: RefreshResult) => {
        const failure = result._tag === "Failure" ? result.failure : null;
        if (failure instanceof TokenRefreshError) {
          if (failure.refused) return;
          renewBackoffMs =
            renewBackoffMs === 0
              ? RENEW_BACKOFF_FIRST_MS
              : Math.min(renewBackoffMs * 2, RENEW_BACKOFF_MAX_MS);
          renewBlockedUntil = Date.now() + (failure.retryAfterMs ?? renewBackoffMs);
          return;
        }
        if (failure instanceof StorageError) return;
        // A token came back, whatever happened after it.
        renewBackoffMs = 0;
        renewBlockedUntil = 0;
      };

      const doRefresh = () =>
        Effect.gen(function* () {
          const account = yield* getAccountSession();
          if (!account) {
            return yield* Effect.fail(
              new TokenRefreshError({ cause: "No session available", refused: true }),
            );
          }

          // The session token is in the HttpOnly cookie; send credentials:
          // include. The grant names the active profile, so the issuer mints
          // for it rather than for the account's default profile. `wanted` is
          // read now: a switch can change the active profile while the grant
          // is out, and the answer is about the profile the grant named.
          const wanted = account.activeProfileId || undefined;
          const next = yield* sharedTokenGrant(wanted);

          // The profile the issuer minted for. A token that does not say is
          // never stored: filed under the active profile it could carry
          // another profile's identity into a request made as this one.
          const granted = extractJwtSub(next.accessToken);
          if (granted === null) {
            return yield* Effect.fail(
              new TokenRefreshError({ cause: "the granted token names no profile" }),
            );
          }
          account.profileTokens[granted] = {
            accessToken: next.accessToken,
            expiresAt: next.expiresAt,
          };
          // The refresh token lives in the HttpOnly cookie; the fact that this
          // refresh call succeeded is itself proof the cookie is alive.
          account.hasSession = true;
          account.scopes = next.scopes;
          account.idToken = next.idToken;
          // No active profile left (the active one was deleted): the grant's
          // profile is active now, as after a reload.
          if (!account.activeProfileId) account.activeProfileId = granted;

          // The issuer minted what the grant asked for. A switch that landed
          // meanwhile stays: the token is stored, and the request that needed
          // it goes out as the profile it was made as.
          if (wanted === undefined || granted === wanted || account.activeProfileId === granted) {
            yield* saveAccountSession(account);
            return next;
          }

          // The issuer mints for the named profile only while the account
          // owns it, so that profile has been deleted, or was never this
          // account's. The request that needed its token is not sent.
          if (account.activeProfileId !== wanted) {
            // The page has switched to another profile since, which holds its
            // own token: nothing to reset.
            yield* saveAccountSession(account);
            return yield* Effect.fail(
              new ActiveProfileResetError({
                profileId: account.activeProfileId,
                message: "The profile this request was made as is gone; nothing was sent",
              }),
            );
          }
          // Fall back to the default profile, as a reload does.
          account.activeProfileId = granted;
          yield* saveAccountSession(account);
          notify({ kind: "profile-reset", profileId: granted });
          return yield* Effect.fail(
            new ActiveProfileResetError({
              profileId: granted,
              message: "The active profile is gone; the default profile is active",
            }),
          );
        });

      const refreshSession = () =>
        Effect.gen(function* () {
          // Join the in-flight refresh if one is already running.
          if (!inFlightRefresh) {
            // Result-wrapped so the shared promise never rejects — survives
            // FiberFailure wrapping from runPromise across Effect versions.
            const promise = (
              Effect.runPromise(Effect.result(doRefresh())) as Promise<RefreshResult>
            ).then((result) => {
              noteRenewal(result);
              return result;
            });
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
          if (result._tag === "Failure") {
            return yield* Effect.fail(result.failure);
          }
          return result.success;
        });

      // -----------------------------------------------------------------------
      // Held-session refresh.
      //
      // The whole implementation: take the shared grant and return what it
      // gives back. What makes this a distinct method is everything it does
      // NOT do — no `saveAccountSession`, no `cache` write, no account
      // reshaping. A held session is one the caller has deliberately kept out
      // of the app's session state, and refreshing it must not be the thing
      // that publishes it.
      //
      // A restricted recovery session is the caller. On the server the grant
      // re-mints on the recovery audience for as long as the row's
      // `restricted_until` is set, and carries that deadline forward rather
      // than extending it — so this can renew the token but can never buy the
      // session more life than it was granted.
      //
      // Wrapped as a `HeldSession` rather than returned as a bare `Session`
      // so `adoptSession`/`setSession` refuse it at compile time — see
      // `HeldSession` in `./tokens`.
      // -----------------------------------------------------------------------
      const refreshHeldSession = (): Effect.Effect<HeldSession, TokenRefreshError> =>
        Effect.map(sharedTokenGrant(), (session): HeldSession => ({ held: true, session }));

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
      let inFlightBootstrap: Promise<RefreshResult> | null = null;

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
              Effect.result(doBootstrap()),
            ) as Promise<RefreshResult>;
            inFlightBootstrap = promise;
            void promise.finally(() => {
              if (inFlightBootstrap === promise) inFlightBootstrap = null;
            });
          }

          // The shared promise is Result-wrapped so it never rejects; any
          // failure (bad cookie, network, storage) arrives as a Left and maps
          // to null — a failed bootstrap means "logged out", never a throw.
          // A defensive orElse covers the should-never-happen rejection too.
          const result = yield* Effect.tryPromise({
            try: () => inFlightBootstrap!,
            catch: (cause) => new TokenRefreshError({ cause }),
          }).pipe(
            Effect.map((r): Session | null => (r._tag === "Failure" ? null : r.success)),
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
      const loadSession = (): Effect.Effect<Session | null, StorageError> =>
        Effect.gen(function* () {
          const account = yield* getAccountSession();
          // No stored account AND no marker ⇒ this browser has never held a
          // session (or has been logged out), so there is nothing for /token to
          // redeem. Skipping the grant is what keeps an anonymous page load —
          // a crawler's, above all — from costing the issuer a request.
          // Case 3 below deliberately does NOT consult the marker: an account
          // that believes it `hasSession` predates the marker on first deploy,
          // and its grant is what heals it.
          if (!account) {
            return hasSessionMarker() ? yield* bootstrapFromCookie() : null;
          }

          const live = toSession(account);
          if (live) return live;

          // Cached access token is expired (or absent). If the account still
          // holds a server session, the refresh cookie should rehydrate it.
          if (account.hasSession) return yield* bootstrapFromCookie();
          return null;
        });

      const logout = () =>
        Effect.gen(function* () {
          // Server-side session destruction + cookie clearing
          yield* Effect.tryPromise({
            try: () =>
              sessionFetch(`${config.issuerUrl}/logout`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: "{}",
              }),
            catch: () => new StorageError({ cause: "Logout request failed" }),
          }).pipe(Effect.catch(() => Effect.void));
          cache = null;
          lastRaw = null;
          yield* storage.remove(ACCOUNT_SESSION_KEY);
        });

      const setSession = (session: Session) => saveAccountSession(sessionToAccountSession(session));

      // ---------------------------------------------------------------------------
      // authFetch
      // ---------------------------------------------------------------------------

      /**
       * Renew the active profile's token for a request. A refusal ends the
       * session here and surfaces as `AuthExpiredError`; a transient failure
       * fails only this call and keeps the session for the next one. After a
       * transient failure it sends nothing until the pause `noteRenewal` set
       * is over.
       */
      const renew = () =>
        Effect.gen(function* () {
          if (Date.now() < renewBlockedUntil) {
            return yield* Effect.fail(
              new TokenRefreshError({
                cause: "renewal paused after a failed attempt",
                message: "Could not renew the session; try again",
              }),
            );
          }
          const result = yield* Effect.result(refreshSession());
          if (result._tag === "Success") return result.success;
          const err = result.failure;
          if (err instanceof TokenRefreshError) {
            if (err.refused) {
              yield* endSession();
              return yield* Effect.fail(new AuthExpiredError({ cause: err.cause }));
            }
            return yield* Effect.fail(
              new TokenRefreshError({
                cause: err.cause,
                message: "Could not renew the session; try again",
              }),
            );
          }
          return yield* Effect.fail(err);
        });

      /**
       * The token for a request whose held token is due for renewal. When the
       * renewal fails without a refusal and the held token has not expired,
       * the held token is good enough: the request goes out with it.
       */
      const renewOrKeep = (held: ProfileToken | undefined) =>
        Effect.gen(function* () {
          const renewed = yield* Effect.result(renew());
          if (renewed._tag === "Success") return renewed.success.accessToken;
          if (renewed.failure instanceof TokenRefreshError && held && Date.now() < held.expiresAt) {
            return held.accessToken;
          }
          return yield* Effect.fail(renewed.failure);
        });

      const send = (input: string, init: RequestInit | undefined, accessToken: string) => {
        const headers = new Headers(init?.headers);
        // Always the account's token: a caller-supplied credential is never
        // sent, so a 401 here can only be about this session.
        headers.set("Authorization", `Bearer ${accessToken}`);
        return Effect.tryPromise({
          try: () => fetch(input, { credentials: "include", ...init, headers }),
          catch: (cause) => new AuthFetchTransportError({ cause }),
        });
      };

      /**
       * authFetch — send with the active profile's access token, renewing it
       * as needed.
       *
       * Access tokens are short-lived (5 min default), so most long-lived
       * pages renew often. Renewing before the token expires keeps an expired
       * token off the wire; retrying once on a 401 covers a token the server
       * refused anyway. Only a refusal ends the session: a renewal that could
       * not reach the issuer fails this call alone, unless the token in hand
       * is still valid: then that token is sent.
       *
       * The token goes only to the issuer's origin. Any other URL is refused
       * before anything is read or sent, as `fetch` refuses a bad URL.
       */
      const authFetch = (input: string, init?: RequestInit) =>
        Effect.gen(function* () {
          if (!onIssuerOrigin(input, config.issuerUrl)) {
            return yield* Effect.fail(
              new AuthFetchTransportError({
                cause: new TypeError("authFetch sends only to the issuer's origin"),
              }),
            );
          }

          const account = yield* syncFromStorage();
          if (!account) {
            return yield* Effect.fail(new AuthExpiredError({ cause: "no session" }));
          }

          const held = account.profileTokens[account.activeProfileId];
          const token = needsRenewal(held) ? yield* renewOrKeep(held) : held!.accessToken;

          const first = yield* send(input, init, token);
          if (first.status !== 401) return first;

          // Renew + retry once.
          const renewed = yield* renew();
          const second = yield* send(input, init, renewed.accessToken);
          if (second.status === 401) {
            yield* endSession();
            return yield* Effect.fail(
              new AuthExpiredError({ cause: "refresh did not repair 401" }),
            );
          }
          return second;
        });

      // ---------------------------------------------------------------------------
      // Profile management methods (P4)
      // ---------------------------------------------------------------------------

      // Profile endpoints authenticate via Bearer access token (not
      // refresh token in body). The access token's `sub` claim identifies
      // the caller's profile; the server resolves the owning account. They
      // send through `authFetch`, so an expired token is renewed first.

      /**
       * One profile endpoint call, resolving to its JSON success body as
       * `decode` reads it. "No session" is checked before anything is sent.
       * `AuthExpiredError` passes through. Every other failure is a
       * `ProfileManagementError`: with the response's status and the server's
       * code for a refusal, the status alone for a success whose body is not
       * JSON, status `0` when no response arrived, and neither when the call
       * failed before it was sent or `decode` refused the body.
       */
      const profileRequest = <T>(
        path: string,
        init: { method: "GET" | "POST"; body?: string },
        decode: (raw: unknown) => T,
      ) =>
        Effect.gen(function* () {
          const account = yield* getAccountSession();
          if (!account) {
            return yield* Effect.fail(
              new ProfileManagementError({ cause: "No session available" }),
            );
          }

          const res = yield* authFetch(`${config.issuerUrl}${path}`, {
            ...init,
            headers: { "Content-Type": "application/json" },
            credentials: "include",
          }).pipe(
            Effect.mapError((cause): AuthExpiredError | ProfileManagementError => {
              if (cause instanceof AuthExpiredError) return cause;
              if (cause instanceof AuthFetchTransportError) {
                return new ProfileManagementError({ cause: cause.cause, status: 0 });
              }
              return new ProfileManagementError({ cause });
            }),
          );

          // `safeJson` never rejects: a body that is not JSON reads as null.
          const body = yield* Effect.promise(() => safeJson<unknown>(res));
          if (!res.ok || body === null) {
            return yield* Effect.fail(
              new ProfileManagementError({
                cause: new Error(
                  `${res.ok ? "Invalid response" : "Request failed"}: ${res.status}`,
                ),
                status: res.status,
                code: res.ok ? undefined : errorCode(body),
              }),
            );
          }
          // Validate the response's shape
          return yield* Effect.try({
            try: () => decode(body),
            catch: (cause) => new ProfileManagementError({ cause }),
          });
        });

      /** The account after a profile call: the one in hand may have been replaced meanwhile. */
      const currentAccount = () =>
        Effect.gen(function* () {
          const account = yield* getAccountSession();
          if (!account) {
            return yield* Effect.fail(
              new ProfileManagementError({ cause: "No session available" }),
            );
          }
          return account;
        });

      const listProfiles = () =>
        Effect.map(
          profileRequest("/profiles/list", { method: "GET" }, decodeListProfilesResponse),
          (res) => res.profiles as PublicProfile[],
        );

      const switchProfile = (profileId: string) =>
        Effect.gen(function* () {
          const res = yield* profileRequest(
            "/profiles/switch",
            { method: "POST", body: JSON.stringify({ profile_id: profileId }) },
            decodeSwitchProfileResponse,
          );

          // Use the server-authoritative profile ID, not the caller-supplied one
          const account = yield* currentAccount();
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
        Effect.map(
          profileRequest(
            "/profiles/create",
            {
              method: "POST",
              body: JSON.stringify(
                (displayName === undefined
                  ? { handle }
                  : { handle, display_name: displayName }) satisfies Record<string, string>,
              ),
            },
            decodeCreateProfileResponse,
          ),
          (res) => res.profile as PublicProfile,
        );

      const deleteProfile = (profileId: string) =>
        Effect.gen(function* () {
          // The body is not used: a success is enough.
          yield* profileRequest(
            "/profiles/delete",
            { method: "POST", body: JSON.stringify({ profile_id: profileId }) },
            () => undefined,
          );

          const account = yield* currentAccount();
          delete account.profileTokens[profileId];
          // Deleting the active profile makes another one active, or none
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
        getSession,
        loadSession,
        refreshSession,
        refreshHeldSession,
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
