/**
 * Cire organiser portal: an owner whose own settings take money — money gifts
 * on, a Stripe account that can charge — opens the gift list on a site that
 * cannot take a money gift. The stack's cire-api holds a Stripe key and no
 * Connect webhook secret, so the registry read answers `takesPayments: false`,
 * its settings name `payments_unavailable` as why guests cannot give money,
 * and the portal says so: the Money gifts panel names the site, a list holding
 * one cash fund and nothing else cannot be published, and the gift list says
 * guests cannot see the fund.
 *
 * The wedding is `CIRE_ORGANISER.money`, which cire-api seeds for the suite
 * (`seedE2eOrganiser` in `cire/api/src/db/setup.ts`). The flow reads its
 * settings from the database first, so what the portal says is the
 * deployment's doing, not a seed whose couple never switched money gifts on.
 *
 * The wedding's other owner, Kit, connected its Stripe account, so the dev
 * profile is an owner who did not. Back on the settings tab, the panel shows
 * the account's status and offers no onboarding link: "Continue on Stripe" is
 * marked disabled and a note says only the person who connected the account
 * can. The onboarding route itself answers 403 `stripe_connector_only` to the
 * browser's own session, before it asks Stripe anything, and the row keeps its
 * account and its connector. The flow's screenshot is this panel.
 *
 * Then the owner signs out everywhere else on OSN, and their cire sessions end
 * too. The flow asks osn-api the way `@osn/auth-ui`'s sessions view does: an
 * access token from `POST /token` on the session cookie, then
 * `POST /sessions/revoke-all-other`. osn-api then asks cire-api, in the
 * background, to end the organiser sessions of each profile on the account
 * (`POST /internal/revoke-organiser-sessions`, with the secret the stack gives
 * both). The flow waits for cire-api's session probe to answer signed out for
 * the cookie the browser still holds, finds no `organiser_sessions` row left
 * for the dev profile, sees the gift list read with that cookie answer 401,
 * and sees the portal, opened again, send the owner to sign in. These steps share this flow's sign-in rather than spend one of
 * their own (`tests/flows.test.ts` caps them), and come last because they end
 * it. A flow after this one signs in afresh.
 */

import { CIRE_ORGANISER, DB_FILES, ORIGINS } from "../../src/config";
import { expect, queryOne, signInToCireHost, test } from "../support/fixtures";

const { weddingId, fundTitle, accountId, connector } = CIRE_ORGANISER.money;
const REGISTRY_URL = `${ORIGINS.cireApi}/api/organiser/weddings/${weddingId}/registry`;
const ONBOARDING_URL = `${REGISTRY_URL}/stripe/session`;
const SESSION_URL = `${ORIGINS.cireApi}/api/auth/session`;
const UNAVAILABLE = /money gifts aren’t available on this site yet/i;

/** How many cire organiser sessions the dev profile holds. */
function organiserSessions(): number {
  const row = queryOne<{ n: number }>(
    DB_FILES.cire,
    "SELECT count(*) AS n FROM organiser_sessions WHERE osn_profile_id = ?",
    CIRE_ORGANISER.profileId,
  );
  return row?.n ?? -1;
}

/** How many OSN sessions the dev profile's account holds. */
function osnSessions(): number {
  const row = queryOne<{ n: number }>(
    DB_FILES.osn,
    "SELECT count(*) AS n FROM sessions WHERE account_id = (SELECT account_id FROM users WHERE id = ?)",
    CIRE_ORGANISER.profileId,
  );
  return row?.n ?? -1;
}

test("cire-registry-money", async ({ page, flow }) => {
  const money = queryOne<{ ready: number }>(
    DB_FILES.cire,
    `SELECT (cash_gifts_enabled = 1 AND stripe_charges_enabled = 1
             AND stripe_account_id IS NOT NULL) AS ready
       FROM registry_settings WHERE wedding_id = ?`,
    weddingId,
  );
  flow.check("the couple's settings take money", 1, money?.ready ?? 0);

  await signInToCireHost(flow, page);

  const settings = await flow.step("open the gift list settings", async () => {
    const read = page.waitForResponse(
      (r) => r.url() === REGISTRY_URL && r.request().method() === "GET",
    );
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/registry/settings`);
    const response = await read;
    const body = (await response.json()) as Record<string, unknown> & {
      settings?: Record<string, unknown>;
    };
    const notice = page.getByTestId("money-gifts-unavailable");
    await expect(notice).toBeVisible();
    const publish = page.getByRole("radio", { name: /^Published/ });
    await expect(publish).toBeDisabled();
    return {
      status: response.status(),
      takesPayments: "takesPayments" in body ? String(body.takesPayments) : "absent",
      blockedBy:
        body.settings && "moneyGiftsBlockedBy" in body.settings
          ? String(body.settings.moneyGiftsBlockedBy)
          : "absent",
      notice: (await notice.textContent()) ?? "",
      publishBlocked: await publish.isDisabled(),
      publishNotice: (await page.locator("#registry-publish-blocked").textContent()) ?? "",
    };
  });
  flow.check("registry read", 200, settings.status);
  flow.check("registry read says the site takes money gifts", "false", settings.takesPayments);
  flow.check(
    "registry read names the site as why guests cannot give money",
    "payments_unavailable",
    settings.blockedBy,
  );
  flow.check("Money gifts panel names the site", true, UNAVAILABLE.test(settings.notice));
  flow.check("a list of one cash fund is blocked from publishing", true, settings.publishBlocked);
  flow.check("the publish notice names the site", true, UNAVAILABLE.test(settings.publishNotice));

  const list = await flow.step("open the gift list", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/registry/list`);
    // The fund's name appears three times in the gift list, so take the first.
    await expect(page.getByText(fundTitle).first()).toBeVisible();
    const notice = page.getByText(/Guests can’t see your cash funds/);
    await expect(notice).toBeVisible();
    return (await notice.textContent()) ?? "";
  });
  flow.check("the gift list says guests cannot see the fund", true, UNAVAILABLE.test(list));

  // Last on `page`, so the flow's screenshot is this panel.
  const panel = await flow.step(
    "open the settings again, as an owner who did not connect Stripe",
    async () => {
      await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/registry/settings`);
      const status = page.getByTestId("stripe-status");
      await expect(status).toBeVisible();
      const button = page.getByRole("button", { name: "Continue on Stripe" });
      await expect(button).toBeVisible();
      const note = page.getByTestId("stripe-connector-only");
      await expect(note).toBeVisible();
      // Below the fold: bring the money panel into the screenshot.
      await note.scrollIntoViewIfNeeded();
      return {
        status: (await status.textContent()) ?? "",
        ariaDisabled: (await button.getAttribute("aria-disabled")) ?? "absent",
        describedBy: (await button.getAttribute("aria-describedby")) ?? "absent",
        note: (await note.textContent()) ?? "",
      };
    },
  );
  flow.check(
    "the panel shows the account's status",
    true,
    /connected and can take payments/i.test(panel.status),
  );
  flow.check("Continue on Stripe is marked disabled", "true", panel.ariaDisabled);
  flow.check(
    "Continue on Stripe is described by the note",
    "stripe-connector-only",
    panel.describedBy,
  );
  flow.check(
    "the note says only the person who connected it can",
    true,
    /only the person who connected this Stripe account/i.test(panel.note),
  );

  const request = page.context().request;
  const onboarding = await flow.step(
    "cire-api: onboarding refused to an owner who did not connect",
    async () => {
      const response = await request.post(ONBOARDING_URL, {
        headers: { origin: ORIGINS.cireHost },
      });
      flow.recordRequest("POST", ONBOARDING_URL, response.status());
      const body = (await response.json()) as { error?: string };
      return { status: response.status(), error: body.error ?? "absent" };
    },
  );
  flow.check("cire-api onboarding as the other owner", 403, onboarding.status);
  flow.check("cire-api names whose account it is", "stripe_connector_only", onboarding.error);
  const after = queryOne<{ account: string | null; connector: string | null }>(
    DB_FILES.cire,
    `SELECT stripe_account_id AS account, stripe_connected_by_osn_profile_id AS connector
       FROM registry_settings WHERE wedding_id = ?`,
    weddingId,
  );
  flow.check("the account is unchanged", accountId, after?.account ?? "absent");
  flow.check("the connector is unchanged", connector.profileId, after?.connector ?? "absent");

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

  // Polled over HTTP, not by reading cire's database: cire-api writes the
  // revoke while this waits, and a reader of its SQLite file then would race
  // that write. Polls are not recorded, so the request lines stay the same on
  // every run; the one below is.
  const stillSignedIn = await flow.step(
    "cire-api: the cookie the browser holds signs nobody in",
    async () => {
      const signedIn = async () =>
        ((await (await request.get(SESSION_URL)).json()) as { signedIn: boolean }).signedIn;
      await expect.poll(signedIn, { timeout: 15_000 }).toBe(false);
      const response = await request.get(SESSION_URL);
      flow.recordRequest("GET", SESSION_URL, response.status());
      return ((await response.json()) as { signedIn: boolean }).signedIn;
    },
  );
  flow.check("cire-api session probe after sign out everywhere", false, stillSignedIn);
  flow.check("organiser_sessions rows left for the dev profile", 0, organiserSessions());

  const organiserRead = await flow.step(
    "cire-api: the old cookie opens no organiser route",
    async () => {
      const response = await request.get(REGISTRY_URL);
      flow.recordRequest("GET", REGISTRY_URL, response.status());
      return response.status();
    },
  );
  flow.check("cire-api gift list read with the old cookie", 401, organiserRead);

  // A second page, so the flow's screenshot stays the settings panel above.
  const portal = await flow.step("organiser: the portal asks them to sign in again", async () => {
    const again = await flow.newPage(page.context());
    await again.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/registry/list`);
    await expect(again).toHaveURL(/\/login(\?|$)/);
    await expect(again.getByRole("button", { name: "Continue with musubi" })).toBeVisible();
    return new URL(again.url()).pathname;
  });
  flow.check("the portal lands on its sign-in page", "/login", portal);
});
