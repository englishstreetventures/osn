/**
 * Signing out everywhere else on OSN ends the organiser's cire sessions too.
 *
 * The organiser signs in to cire's portal through osn-api, then asks osn-api to
 * sign every other session out, the way `@osn/auth-ui`'s sessions view does: an
 * access token from `POST /token` on the session cookie, then
 * `POST /sessions/revoke-all-other`. osn-api then asks cire-api, in the
 * background, to end the organiser sessions of each profile on the account
 * (`POST /internal/revoke-organiser-sessions`, with the secret the stack gives
 * both). The flow waits until cire-api holds no `organiser_sessions` row for the
 * dev profile, sees cire-api's session probe answer signed out for the cookie
 * the browser still holds, and the portal send the organiser to sign in.
 *
 * It ends every session of the dev account, OSN and cire both, so it sorts
 * after every flow that signs that account in. One sign-in.
 */

import { CIRE_ORGANISER, DB_FILES, ORIGINS } from "../../src/config";
import { expect, queryOne, signInToCireHost, test } from "../support/fixtures";

const { profileId } = CIRE_ORGANISER;

/** How many cire organiser sessions the dev profile holds. */
function organiserSessions(): number {
  const row = queryOne<{ n: number }>(
    DB_FILES.cire,
    "SELECT count(*) AS n FROM organiser_sessions WHERE osn_profile_id = ?",
    profileId,
  );
  return row?.n ?? -1;
}

/** How many OSN sessions the dev profile's account holds. */
function osnSessions(): number {
  const row = queryOne<{ n: number }>(
    DB_FILES.osn,
    "SELECT count(*) AS n FROM sessions WHERE account_id = (SELECT account_id FROM users WHERE id = ?)",
    profileId,
  );
  return row?.n ?? -1;
}

test("cire-organiser-signout", async ({ page, flow }) => {
  await signInToCireHost(flow, page);
  const request = page.context().request;

  const accessToken = await flow.step(
    "organiser: an access token from the OSN session",
    async () => {
      const url = `${ORIGINS.osnApi}/token`;
      const response = await request.post(url, {
        headers: { origin: ORIGINS.musubi },
        form: { grant_type: "refresh_token" },
      });
      flow.recordRequest("POST", url, response.status());
      expect(response.status(), "token").toBe(200);
      return ((await response.json()) as { access_token: string }).access_token;
    },
  );

  const signedOut = await flow.step("organiser: sign out everywhere else", async () => {
    const url = `${ORIGINS.osnApi}/sessions/revoke-all-other`;
    const response = await request.post(url, {
      headers: { origin: ORIGINS.musubi, authorization: `Bearer ${accessToken}` },
    });
    flow.recordRequest("POST", url, response.status());
    return response.status();
  });
  flow.check("osn-api signs every other session out", 200, signedOut);
  flow.check("the account keeps only this session", 1, osnSessions());

  await flow.step("cire-api: the organiser's sessions end", async () => {
    await expect.poll(organiserSessions, { timeout: 15_000 }).toBe(0);
  });
  flow.check("organiser_sessions rows left for the dev profile", 0, organiserSessions());

  const stillSignedIn = await flow.step(
    "cire-api: the cookie the browser holds signs nobody in",
    async () => {
      const url = `${ORIGINS.cireApi}/api/auth/session`;
      const response = await request.get(url);
      flow.recordRequest("GET", url, response.status());
      return ((await response.json()) as { signedIn: boolean }).signedIn;
    },
  );
  flow.check("cire-api session probe after sign out everywhere", false, stillSignedIn);

  await flow.step("organiser: the portal asks them to sign in again", async () => {
    // A reload, not a `goto` to the same hash route: that would be a
    // same-document navigation, and the portal would keep its loaded state
    // without asking cire-api who is signed in.
    await page.reload();
    await expect(page).toHaveURL(/\/login(\?|$)/);
    await expect(page.getByRole("button", { name: "Continue with musubi" })).toBeVisible();
  });
  flow.check("the portal lands on its sign-in page", "/login", new URL(page.url()).pathname);
});
