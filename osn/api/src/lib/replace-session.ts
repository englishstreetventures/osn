/**
 * The `Set-Cookie` values for a session a route has just issued, after ending
 * the device session the request's own cookie named. Every route that sets a
 * new session cookie uses it; `POST /token`, which sets the same family's
 * rotated cookie, does not. Built once per route module, over that module's
 * service and runner.
 */

import type { Db } from "@osn/db/service";
import { Effect } from "effect";

import type { createAuthService } from "../services/auth";
import { buildSessionCookies, readSessionCookie, type CookieSessionConfig } from "./cookie-session";

/** The one line a failed end writes. It names no token, hash, family or account. */
const END_FAILED_MESSAGE = "Sign-in could not end the session its cookie named";

export function createSessionReplacer(deps: {
  readonly auth: Pick<ReturnType<typeof createAuthService>, "endReplacedSession">;
  readonly run: <A, E>(effect: Effect.Effect<A, E, Db>) => Promise<A>;
  readonly cookieConfig: CookieSessionConfig;
}) {
  const { auth, run, cookieConfig } = deps;

  /**
   * Ends the family of the session the request's cookie names, live or
   * rotated out, then answers the cookies that carry `refreshToken`:
   *
   * ```ts
   * set.headers["set-cookie"] = await replaceSession(headers.cookie, issued.refreshToken);
   * ```
   *
   * Call it only once the route has issued the new session, so a refused or
   * unfinished sign-in ends nothing. A request with no session cookie ends
   * nothing and reads nothing.
   *
   * It never rejects. A failure to end the old family is logged and the new
   * cookies are answered all the same: three routes hand their session out
   * exactly once (the sign-up, email-recovery and cross-device polls), so
   * failing the request would lose the session it has just issued. The old
   * family then survives, as it would have without this call.
   */
  async function replaceSession(
    cookieHeader: string | undefined,
    refreshToken: string,
  ): Promise<string[]> {
    const incoming = readSessionCookie(cookieHeader, cookieConfig);
    if (incoming !== null) {
      // No cause in the line: a database error's text carries the statement's
      // parameters, which include the token's hash.
      const end = auth
        .endReplacedSession(incoming)
        .pipe(Effect.catchCause(() => Effect.logError(END_FAILED_MESSAGE)));
      try {
        await run(end);
      } catch {
        // The runner itself failed (a runtime that would not build); the
        // effect's own failures were caught above. Nothing more can be
        // logged without that runtime, and the new session still stands.
      }
    }
    return buildSessionCookies(refreshToken, cookieConfig);
  }

  return { replaceSession };
}
