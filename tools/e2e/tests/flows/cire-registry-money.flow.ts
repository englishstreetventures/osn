/**
 * Cire organiser portal: an owner whose own settings take money — money gifts
 * on, a Stripe account that can charge — opens the gift list on a site that
 * cannot take a money gift. The stack's cire-api holds a Stripe key and no
 * Connect webhook secret, so the registry read answers `takesPayments: false`,
 * its settings name `payments_unavailable` as why guests cannot give money,
 * and the portal says so: the Money gifts panel names the site, a list holding
 * one cash fund and two group gifts and nothing else cannot be published, and
 * the gift list says guests cannot see its cash funds and group gifts.
 *
 * One group gift, an espresso machine with a $1,200 target, has had $1,400
 * given by two households beside a gift refunded in full and one not yet paid.
 * The registry read counts the two received gifts and nothing else, and its
 * row says it is past its target. The other, a stand mixer, has had one gift of
 * exactly its $500 target, and its row says the target is reached. The owner
 * adds a third group gift through the form, which the API stores as a cash
 * fund marked a group gift and whose row says what is left to raise; then
 * edits it, and the portal refuses a cleared target before sending anything
 * and stores a new one. The gifts tab lists all three together. Guests cannot
 * give on this stack, so the money a guest gives towards one is held by
 * cire-api's route tests (`tests/routes/registry-group-gifts.test.ts`).
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
 * the one used for Ceremony Wedding, a new one, or a Stripe account they
 * already have, nothing chosen, Money Wedding's not offered. On a second page
 * the owner chooses Ceremony Wedding's account and uses it: the panel says
 * gifts go to their account, without a trip to Stripe, and Party Wedding's row
 * names that account with the dev profile as its connector.
 *
 * Then Garden Wedding (`CIRE_ORGANISER.oauth`), which the dev profile owns
 * alone, takes a Stripe account the owner already has, through Stripe Connect
 * OAuth and the suite's Stripe stand-in (`src/stripe.ts`). Choosing it sends
 * the browser to Stripe's authorize page — answered by the flow, since the
 * stack cannot reach Stripe — with the platform's client id, `read_write`,
 * cire-api's callback as the redirect and a state naming the wedding. A
 * forged state comes back as "run out or already used", sends no code to
 * Stripe and leaves the real sign-in in place. The real return connects the
 * account: the portal lands on the wedding's settings, says the account is
 * connected, the fees and disputes are the couple's, and links their own
 * Stripe Dashboard instead of "Continue on Stripe"; the row names the Standard
 * account with the dev profile as connector, and the stand-in saw one code.
 * The same return again, on a second page, is refused and sends Stripe no
 * second code, which would revoke the connection. The onboarding route
 * answers 409 `stripe_standard_account`. That panel is the flow's screenshot.
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

const { weddingId, fundTitle, groupGift, accountId, connector } = CIRE_ORGANISER.money;
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
      items?: Array<{ id: string; allowPartial?: boolean; raised?: unknown }>;
    };
    const group = body.items?.find((item) => item.id === groupGift.id);
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
      groupGift: group?.allowPartial === true ? "group gift" : "absent",
      raised: JSON.stringify(group?.raised ?? null),
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
  flow.check(
    "a list of a cash fund and a group gift is blocked from publishing",
    true,
    settings.publishBlocked,
  );
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
  flow.check(
    "the gift list names both cash funds and group gifts",
    true,
    list.trim().startsWith("Guests can’t see your cash funds and group gifts:"),
  );
  flow.check("registry read marks the group gift", "group gift", settings.groupGift);
  flow.check(
    "registry read counts the two received gifts towards it, and nothing else",
    JSON.stringify({ raisedMinor: 140_000, giftCount: 2, otherCurrencyCount: 0 }),
    settings.raised,
  );

  const rows = page.getByTestId("registry-items").locator(":scope > li");
  const pastTarget = await flow.step(
    "the group gift's row says it is past its target",
    async () => {
      const row = rows.filter({ hasText: groupGift.title });
      await expect(row).toContainText("Past target");
      return (await row.textContent()) ?? "";
    },
  );
  flow.check("its row names it a group gift", true, pastTarget.includes("Group gift"));
  flow.check(
    "its row says what has come in against the target",
    true,
    pastTarget.includes("$1,400.00 of $1,200.00 · 2 gifts"),
  );
  flow.check("its row says the target is passed", true, pastTarget.includes("Past target"));

  const reached = await flow.step(
    "the group gift given exactly its target says it is reached",
    async () => {
      const row = rows.filter({ hasText: "Stand mixer" });
      await expect(row).toContainText("Target reached");
      return (await row.textContent()) ?? "";
    },
  );
  flow.check(
    "its row says one gift came to the target",
    true,
    reached.includes("$500.00 of $500.00 · 1 gift"),
  );
  flow.check(
    "its row says neither what is left nor that it is passed",
    false,
    /to go|Past target/.test(reached),
  );

  const added = await flow.step("add a group gift through the form", async () => {
    await page.getByRole("radio", { name: "A group gift" }).check();
    await page.getByLabel("Group gift", { exact: true }).fill("Record player");
    await page.getByLabel("Target", { exact: true }).fill("600");
    const created = page.waitForResponse(
      (r) => r.url().endsWith("/registry/items") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Add group gift" }).click();
    const response = await created;
    const { item } = (await response.json()) as {
      item: { id: string; kind: string; allowPartial: boolean; targetMinor: number };
    };
    const row = rows.filter({ hasText: "Record player" });
    await expect(row).toContainText("to go");
    const stored = queryOne<{ kind: string; group: number; target: number }>(
      DB_FILES.cire,
      `SELECT kind, allow_partial AS "group", target_minor AS target
         FROM registry_items WHERE id = ?`,
      item.id,
    );
    return {
      status: response.status(),
      answer: `${item.kind}/${String(item.allowPartial)}/${item.targetMinor}`,
      stored: `${stored?.kind}/${stored?.group}/${stored?.target}`,
      row: (await row.textContent()) ?? "",
    };
  });
  flow.check("cire-api adds the group gift", 200, added.status);
  flow.check(
    "cire-api answers a cash fund marked a group gift",
    "cash_fund/true/60000",
    added.answer,
  );
  flow.check("the row is stored as a group gift", "cash_fund/1/60000", added.stored);
  flow.check("the new row says what is left to raise", true, added.row.includes("$600.00 to go"));

  const edited = await flow.step("edit the new group gift's target", async () => {
    const editor = page.getByTestId("registry-items");
    let patches = 0;
    const countPatch = (request: { method(): string; url(): string }) => {
      if (request.method() === "PATCH" && request.url().includes("/registry/items/")) patches += 1;
    };
    page.on("request", countPatch);
    await page.getByRole("button", { name: "Edit Record player" }).click();
    const target = editor.getByLabel("Target", { exact: true });
    await target.fill("");
    await editor.getByRole("button", { name: "Save" }).click();
    const refusal = page.getByRole("alert").filter({ hasText: "needs a target" });
    await expect(refusal).toBeVisible();
    const refused = { text: (await refusal.textContent()) ?? "", patches };

    await target.fill("700");
    const saved = page.waitForResponse(
      (r) => r.url().includes("/registry/items/") && r.request().method() === "PATCH",
    );
    await editor.getByRole("button", { name: "Save" }).click();
    const response = await saved;
    page.off("request", countPatch);
    const { item } = (await response.json()) as { item: { id: string; targetMinor: number } };
    const row = rows.filter({ hasText: "Record player" });
    await expect(row).toContainText("$700.00 to go");
    const stored = queryOne<{ target: number }>(
      DB_FILES.cire,
      "SELECT target_minor AS target FROM registry_items WHERE id = ?",
      item.id,
    );
    return {
      refusal: refused.text.trim(),
      patchesBeforeTarget: refused.patches,
      status: response.status(),
      answer: item.targetMinor,
      stored: stored?.target ?? -1,
      row: (await row.textContent()) ?? "",
    };
  });
  flow.check(
    "the portal refuses a cleared target in its words",
    true,
    edited.refusal.endsWith("A group gift needs a target: what it costs."),
  );
  flow.check("the portal sends nothing for a cleared target", 0, edited.patchesBeforeTarget);
  flow.check("cire-api saves the new target", 200, edited.status);
  flow.check("cire-api answers the new target", 70_000, edited.answer);
  flow.check("the new target is stored", 70_000, edited.stored);
  flow.check(
    "the row says what is left of the new target",
    true,
    edited.row.includes("$700.00 to go"),
  );

  const together = await flow.step("the gifts tab lists the group gifts together", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/registry/gifts`);
    const card = page.getByTestId("group-gifts");
    await expect(card).toContainText("Record player");
    return (await card.locator("li").allTextContents()).map((text) => text.trim());
  });
  flow.check("the gifts tab shows three group gifts", 3, together.length);
  flow.check(
    "the gifts tab tags none of them again under its own heading",
    false,
    together.some((text) => text.includes("Group gift")),
  );
  flow.check(
    "the gifts tab shows the espresso machine past its target",
    true,
    together.some(
      (text) =>
        text.includes(groupGift.title) &&
        text.includes("$1,400.00 of $1,200.00 · 2 gifts") &&
        text.includes("Past target"),
    ),
  );
  flow.check(
    "the gifts tab shows the stand mixer at its target",
    true,
    together.some(
      (text) =>
        text.includes("Stand mixer") &&
        text.includes("$500.00 of $500.00 · 1 gift") &&
        text.includes("Target reached"),
    ),
  );
  flow.check(
    "the gifts tab shows the record player with nothing in yet",
    true,
    together.some((text) => text.includes("Record player") && text.includes("$0.00 of $700.00")),
  );

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
      await expect(radios).toHaveCount(3);
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
  flow.check(
    "the third answer is a Stripe account the owner already has",
    true,
    (question.labels[2] ?? "").startsWith("Connect a Stripe account you already have"),
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

  // ── Connecting a Stripe account the owner already has (Stripe Connect
  // OAuth), on Garden Wedding, through the Stripe stand-in. Last on `page`, so
  // the flow's screenshot is the connected panel.
  const garden = CIRE_ORGANISER.oauth;
  const gardenStripe = `${ORIGINS.cireApi}/api/organiser/weddings/${garden.weddingId}/registry/stripe`;
  const gardenSettings = `${ORIGINS.cireHost}/#/w/${garden.weddingId}/registry/settings`;
  const CALLBACK = `${ORIGINS.cireApi}/api/organiser/stripe/oauth/callback`;
  /** Stripe's redirect back, built with `searchParams` like the browser's. */
  const callbackUrl = (params: Record<string, string>): string => {
    const url = new URL(CALLBACK);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  };
  /** How many calls the Stripe stand-in has answered, by kind. */
  const standIn = async () =>
    (await (await fetch(`${ORIGINS.stripe}/__e2e/stripe/calls`)).json()) as {
      token: number;
      deauthorize: number;
      account: number;
    };
  const gardenStates = () =>
    queryOne<{ n: number }>(
      DB_FILES.cire,
      "SELECT count(*) AS n FROM registry_stripe_oauth_states WHERE wedding_id = ?",
      garden.weddingId,
    )?.n ?? -1;
  const gardenAccount = () =>
    queryOne<{ account: string | null; type: string | null; connector: string | null }>(
      DB_FILES.cire,
      `SELECT stripe_account_id AS account, stripe_account_type AS type,
              stripe_connected_by_osn_profile_id AS connector
         FROM registry_settings WHERE wedding_id = ?`,
      garden.weddingId,
    );
  const tokenCallsBefore = (await standIn()).token;

  const authorize = await flow.step(
    "Garden Wedding: choose a Stripe account the owner already has, and go to Stripe",
    async () => {
      let sentTo = "";
      // Stripe's own page, which the stack cannot reach: answered here.
      await page.route("https://connect.stripe.com/**", async (route) => {
        sentTo = route.request().url();
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><title>Stripe</title><p>Stripe's sign-in page</p>",
        });
      });
      await page.goto(gardenSettings);
      await page.getByRole("button", { name: "Connect an account" }).click();
      await expect(page.getByTestId("stripe-account-choice")).toBeVisible();
      await page.getByRole("radio", { name: /^Connect a Stripe account you already have/ }).check();
      const started = page.waitForResponse(
        (r) => r.url() === `${gardenStripe}/oauth` && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Continue to Stripe" }).click();
      const response = await started;
      await page.waitForURL(/^https:\/\/connect\.stripe\.com\//);
      await page.unroute("https://connect.stripe.com/**");
      const url = new URL(sentTo);
      return {
        status: response.status(),
        page: `${url.origin}${url.pathname}`,
        responseType: url.searchParams.get("response_type") ?? "absent",
        clientId: url.searchParams.get("client_id") ?? "absent",
        scope: url.searchParams.get("scope") ?? "absent",
        redirectUri: url.searchParams.get("redirect_uri") ?? "absent",
        state: url.searchParams.get("state") ?? "",
      };
    },
  );
  flow.check("cire-api starts the connect", 200, authorize.status);
  flow.check(
    "the browser goes to Stripe's authorize page",
    "https://connect.stripe.com/oauth/authorize",
    authorize.page,
  );
  flow.check("it asks for a code", "code", authorize.responseType);
  flow.check("it names the platform", "ca_e2eStandIn", authorize.clientId);
  flow.check("it asks for read_write", "read_write", authorize.scope);
  flow.check("Stripe sends the browser back to cire-api", CALLBACK, authorize.redirectUri);
  flow.check(
    "the state names the wedding and 32 random bytes",
    true,
    new RegExp(`^${garden.weddingId}\\.[A-Za-z0-9_-]{43}$`).test(authorize.state),
  );
  flow.check("cire-api holds one sign-in for it", 1, gardenStates());

  const forged = await flow.step("cire-api: a forged state connects nothing", async () => {
    await page.goto(
      callbackUrl({
        scope: "read_write",
        code: "ac_e2e_forged",
        state: `${garden.weddingId}.${"A".repeat(43)}`,
      }),
    );
    await expect(
      page.getByText(/That Stripe sign-in had run out or was already used/),
    ).toBeVisible();
    return new URL(page.url()).search;
  });
  flow.check("the portal is told the sign-in is not good", "", forged);
  flow.check("the forged state used up no sign-in", 1, gardenStates());
  flow.check("no code went to Stripe", tokenCallsBefore, (await standIn()).token);
  flow.check("Garden Wedding still has no account", "absent", gardenAccount()?.account ?? "absent");

  const good = callbackUrl({ scope: "read_write", code: "ac_e2e_good", state: authorize.state });
  const connected = await flow.step(
    "Stripe sends the owner back: cire-api connects the account",
    async () => {
      await page.goto(good);
      await expect(page).toHaveURL(new RegExp(`#/w/${garden.weddingId}/registry/settings$`));
      await expect(page.getByText(/Your Stripe account is connected/).first()).toBeVisible();
      const status = page.getByTestId("stripe-status");
      await expect(status).toContainText("Your own Stripe account is connected");
      const link = page.getByTestId("stripe-dashboard-link");
      await expect(link).toBeVisible();
      await expect(page.getByRole("button", { name: "Continue on Stripe" })).toHaveCount(0);
      await status.scrollIntoViewIfNeeded();
      return {
        words: (await status.textContent()) ?? "",
        dashboard: (await link.getAttribute("href")) ?? "",
        search: new URL(page.url()).search,
      };
    },
  );
  flow.check("the portal strips the word it was told", "", connected.search);
  flow.check(
    "the panel says the fees and disputes are the couple's",
    true,
    /Stripe’s fees come out of each gift at your account’s rates, and you handle refunds and disputes/.test(
      connected.words,
    ),
  );
  flow.check(
    "the panel links their own Dashboard",
    "https://dashboard.stripe.com/",
    connected.dashboard,
  );
  const row = gardenAccount();
  flow.check(
    "Garden Wedding names the Standard account",
    "acct_e2eStandard",
    row?.account ?? "absent",
  );
  flow.check("as a Standard account", "standard", row?.type ?? "absent");
  flow.check(
    "the dev profile is its connector",
    CIRE_ORGANISER.profileId,
    row?.connector ?? "absent",
  );
  flow.check("the sign-in is used up", 0, gardenStates());
  flow.check("one code went to Stripe", tokenCallsBefore + 1, (await standIn()).token);

  const replayed = await flow.step("cire-api: the same return again connects nothing", async () => {
    const second = await flow.newPage(page.context());
    await second.goto(good);
    await expect(
      second.getByText(/That Stripe sign-in had run out or was already used/),
    ).toBeVisible();
    return true;
  });
  flow.check("a replay is told the sign-in is not good", true, replayed);
  flow.check("the code never went to Stripe twice", tokenCallsBefore + 1, (await standIn()).token);

  const standardLink = await flow.step(
    "cire-api: no onboarding link for the couple's own Stripe account",
    async () => {
      const url = `${gardenStripe}/session`;
      const response = await request.post(url, { headers: { origin: ORIGINS.cireHost } });
      flow.recordRequest("POST", url, response.status());
      return {
        status: response.status(),
        error: ((await response.json()) as { error?: string }).error ?? "absent",
      };
    },
  );
  flow.check("cire-api onboarding on a Standard account", 409, standardLink.status);
  flow.check("cire-api says why", "stripe_standard_account", standardLink.error);

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
    await expect(again).toHaveURL(/\/login\/(\?|$)/);
    await expect(again.getByRole("button", { name: "Continue with musubi" })).toBeVisible();
    return new URL(again.url()).pathname;
  });
  flow.check("the portal lands on its sign-in page", "/login/", portal);
});
