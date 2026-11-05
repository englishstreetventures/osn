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
 * account and its connector.
 *
 * Then a second wedding takes the dev profile's own account. The dev profile
 * owns Ceremony Wedding and Party Wedding alone (`CIRE_ORGANISER.shared`), and
 * connected Ceremony Wedding's account. First cire-api refuses, 404
 * `stripe_account_not_found`, to give Party Wedding Money Wedding's account,
 * which Kit connected, and writes nothing. On Party Wedding's settings,
 * pressing "Connect an account" asks which account should take its gifts —
 * the one used for Ceremony Wedding or a new one, nothing chosen, Money
 * Wedding's not offered — and that question is the flow's screenshot. On a
 * second page the owner chooses Ceremony Wedding's account and uses it: the
 * panel says gifts go to their account, without a trip to Stripe, and Party
 * Wedding's row names that account with the dev profile as its connector.
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

  const shared = CIRE_ORGANISER.shared;
  const partyStripe = `${ORIGINS.cireApi}/api/organiser/weddings/${shared.to.weddingId}/registry/stripe`;
  const partySettings = `${ORIGINS.cireHost}/#/w/${shared.to.weddingId}/registry/settings`;
  /** Party Wedding's account and its connector, or "absent" with no row. */
  const partyAccount = () =>
    queryOne<{ account: string | null; connector: string | null }>(
      DB_FILES.cire,
      `SELECT stripe_account_id AS account, stripe_connected_by_osn_profile_id AS connector
         FROM registry_settings WHERE wedding_id = ?`,
      shared.to.weddingId,
    );

  const refusedReuse = await flow.step(
    "cire-api: Party Wedding refused the account Kit connected on Money Wedding",
    async () => {
      const url = `${partyStripe}/reuse`;
      const response = await request.post(url, {
        headers: { origin: ORIGINS.cireHost },
        data: { fromWeddingId: weddingId },
      });
      flow.recordRequest("POST", url, response.status());
      const body = (await response.json()) as { error?: string };
      return { status: response.status(), error: body.error ?? "absent" };
    },
  );
  flow.check("cire-api reuse of another owner's account", 404, refusedReuse.status);
  flow.check(
    "cire-api names no account it may give",
    "stripe_account_not_found",
    refusedReuse.error,
  );
  flow.check("Party Wedding still has no account", "absent", partyAccount()?.account ?? "absent");

  // Last on `page`, so the flow's screenshot is this question.
  const question = await flow.step(
    "open Party Wedding's settings and press Connect: the portal asks which account",
    async () => {
      await page.goto(partySettings);
      const listed = page.waitForResponse(
        (r) => r.url() === `${partyStripe}/accounts` && r.request().method() === "GET",
      );
      await page.getByRole("button", { name: "Connect an account" }).click();
      const response = await listed;
      const raw = await response.text();
      const choice = page.getByTestId("stripe-account-choice");
      await expect(choice).toBeVisible();
      const radios = choice.getByRole("radio");
      await expect(radios).toHaveCount(2);
      const labels = await choice.locator("label").allTextContents();
      const checked = await radios.evaluateAll(
        (inputs) => inputs.filter((input) => (input as HTMLInputElement).checked).length,
      );
      await choice.scrollIntoViewIfNeeded();
      const accounts = (JSON.parse(raw) as { accounts: { weddingNames: string[] }[] }).accounts;
      return {
        status: response.status(),
        names: accounts.map((a) => a.weddingNames.join(" and ")).join("; "),
        carriesAccountId: raw.includes("acct_"),
        labels,
        checked,
      };
    },
  );
  flow.check("cire-api lists the owner's accounts", 200, question.status);
  flow.check(
    "the one account listed is Ceremony Wedding's, not Kit's",
    shared.from.name,
    question.names,
  );
  flow.check("the list carries no account id", false, question.carriesAccountId);
  flow.check(
    "the first answer is Ceremony Wedding's account",
    true,
    (question.labels[0] ?? "").startsWith(`The account you use for ${shared.from.name}`),
  );
  flow.check(
    "the second answer is a new account",
    true,
    (question.labels[1] ?? "").startsWith("A new account for this wedding"),
  );
  flow.check("nothing is chosen for the owner", 0, question.checked);

  const reused = await flow.step(
    "on a second page, give Party Wedding Ceremony Wedding's account",
    async () => {
      const second = await flow.newPage(page.context());
      await second.goto(partySettings);
      await second.getByRole("button", { name: "Connect an account" }).click();
      await second
        .getByRole("radio", { name: new RegExp(`^The account you use for ${shared.from.name}`) })
        .check();
      const answered = second.waitForResponse(
        (r) => r.url() === `${partyStripe}/reuse` && r.request().method() === "POST",
      );
      await second.getByRole("button", { name: "Use this account" }).click();
      const response = await answered;
      const status = second.getByTestId("stripe-status");
      await expect(status).toContainText("Gifts go straight to your account");
      await expect(second.getByTestId("stripe-account-choice")).toHaveCount(0);
      return { status: response.status(), words: (await status.textContent()) ?? "" };
    },
  );
  flow.check("cire-api gives Party Wedding the account", 200, reused.status);
  flow.check(
    "the panel says gifts go to the owner's account",
    true,
    /connected and can take payments\. Gifts go straight to your account/.test(reused.words),
  );
  const party = partyAccount();
  flow.check("Party Wedding's row names the account", shared.accountId, party?.account ?? "absent");
  flow.check(
    "the dev profile is its connector there",
    CIRE_ORGANISER.profileId,
    party?.connector ?? "absent",
  );
  const ceremony = queryOne<{ account: string | null; connector: string | null }>(
    DB_FILES.cire,
    `SELECT stripe_account_id AS account, stripe_connected_by_osn_profile_id AS connector
       FROM registry_settings WHERE wedding_id = ?`,
    shared.from.weddingId,
  );
  flow.check("Ceremony Wedding keeps its account", shared.accountId, ceremony?.account ?? "absent");

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
