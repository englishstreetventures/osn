import { Effect } from "effect";

import { DbService } from "../../src/db";
import type { Db } from "../../src/db";
import { organiserSessionService } from "../../src/services/organiser-session";

/**
 * Mints a live organiser session for `osnProfileId` in `db` and returns its raw
 * token — the value a browser sends back as `cire_org_session`.
 *
 * It calls `organiserSessionService.create`, the same function the OIDC
 * callback calls, so a route test can present the cookie without running the
 * sign-in flow. `auth-oidc.test.ts` covers that flow and the `Set-Cookie` it
 * ends in.
 */
export function seedOrganiserSession(db: Db, osnProfileId: string): Promise<string> {
  return Effect.runPromise(
    organiserSessionService
      .create({
        osnProfileId,
        osnSub: `pw_${osnProfileId}`,
        email: `${osnProfileId}@example.test`,
        handle: osnProfileId,
        displayName: "Organiser",
        avatarUrl: null,
      })
      .pipe(
        Effect.provideService(DbService, db),
        Effect.map((session) => session.token),
      ),
  );
}
