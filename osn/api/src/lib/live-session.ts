/**
 * The live-session check every Bearer route runs before it mints a credential
 * or spends, writes or revokes what the owner's own session or ceremonies
 * depend on. Built once per route module, over that module's service and
 * runner.
 */

import type { Db } from "@osn/db/service";
import type { Effect } from "effect";

import { metricSessionStaleRefused, type LiveSessionGateEndpoint } from "../metrics";
import type { createAuthService } from "../services/auth";
import { readSessionCookie, type CookieSessionConfig } from "./cookie-session";

/** The 409 body a refused caller gets, sent as it is. */
export type SessionStaleBody = { error: "session_stale"; message: string };

/** The caller's live session (its hash and its family), or the refusal to send. */
export type LiveSession =
  | { readonly sessionHash: string; readonly familyId: string; readonly refusal: null }
  | { readonly sessionHash: null; readonly familyId: null; readonly refusal: SessionStaleBody };

export function createLiveSessionCheck(deps: {
  readonly auth: Pick<
    ReturnType<typeof createAuthService>,
    "resolveLiveOrdinarySession" | "hashSessionToken"
  >;
  readonly run: <A, E>(effect: Effect.Effect<A, E, Db>) => Promise<A>;
  readonly cookieConfig: CookieSessionConfig;
}) {
  const { auth, run, cookieConfig } = deps;

  /**
   * The caller's live, ordinary session on `accountId`. Answers the session's
   * hash, or the 409 body the route sends as it is:
   *
   * ```ts
   * const live = await liveSession("<endpoint>", profile.accountId, claims, headers.cookie);
   * if (live.sessionHash === null) {
   *   set.status = 409;
   *   return live.refusal;
   * }
   * ```
   *
   * An access token outlives the session it was minted from by up to one
   * token lifetime; this is what stops it acting once the session has ended.
   * The session is named by the HttpOnly cookie or the token's `osn_sid`
   * binding, never by request input, and must be unrestricted and unexpired
   * (`resolveLiveOrdinarySession`). A route that needs the session afterwards
   * (to bind a token to it, or to spare it from a sweep) uses the hash
   * answered here rather than reading the cookie again. Call it inside the
   * route's `try` and before any step that reads, spends, writes or revokes
   * anything, so a refusal changes nothing and a database failure becomes the
   * route's 500.
   */
  async function liveSession(
    endpoint: LiveSessionGateEndpoint,
    accountId: string,
    claims: { readonly profileId: string; readonly sessionBinding: string | null },
    cookieHeader: string | undefined,
  ): Promise<LiveSession> {
    const cookieToken = readSessionCookie(cookieHeader, cookieConfig);
    const live = await run(
      auth.resolveLiveOrdinarySession(accountId, claims.profileId, {
        cookieSessionHash: cookieToken ? auth.hashSessionToken(cookieToken) : null,
        sessionBinding: claims.sessionBinding,
      }),
    );
    if (live !== null) return { ...live, refusal: null };
    metricSessionStaleRefused(endpoint);
    return { sessionHash: null, familyId: null, refusal: staleRefusal() };
  }

  /**
   * {@link liveSession} for a route that needs only the yes or no: `null`
   * when the caller holds a live, ordinary session on `accountId`, or the 409
   * body the route sends as it is.
   */
  async function liveSessionGate(
    endpoint: LiveSessionGateEndpoint,
    accountId: string,
    claims: { readonly profileId: string; readonly sessionBinding: string | null },
    cookieHeader: string | undefined,
  ): Promise<SessionStaleBody | null> {
    return (await liveSession(endpoint, accountId, claims, cookieHeader)).refusal;
  }

  return { liveSession, liveSessionGate };
}

/** The `session_stale` answer, for a route that decides staleness itself. */
export const staleRefusal = (): SessionStaleBody => ({
  error: "session_stale",
  message: "Re-authenticate and try again.",
});
