/**
 * Cire organiser portal: an owner whose own settings take money — money gifts
 * on, a Stripe account that can charge — opens the gift list on a site that
 * cannot take a money gift. The stack's cire-api holds a Stripe key and no
 * Connect webhook secret, so the registry read answers `takesPayments: false`
 * and the portal says so: the Money gifts panel names the site, a list holding
 * one cash fund and nothing else cannot be published, and the gift list says
 * guests cannot see the fund.
 *
 * The wedding is `CIRE_ORGANISER.money`, which cire-api seeds for the suite
 * (`seedE2eOrganiser` in `cire/api/src/db/setup.ts`). The flow reads its
 * settings from the database first, so what the portal says is the
 * deployment's doing, not a seed whose couple never switched money gifts on.
 */

import { CIRE_ORGANISER, DB_FILES, ORIGINS } from "../../src/config";
import { expect, queryOne, signInToCireHost, test } from "../support/fixtures";

const { weddingId, fundTitle } = CIRE_ORGANISER.money;
const REGISTRY_URL = `${ORIGINS.cireApi}/api/organiser/weddings/${weddingId}/registry`;
const UNAVAILABLE = /money gifts aren’t available on this site yet/i;

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
    const body = (await response.json()) as Record<string, unknown>;
    const notice = page.getByTestId("money-gifts-unavailable");
    await expect(notice).toBeVisible();
    const publish = page.getByTestId("registry-publish");
    await expect(publish).toBeDisabled();
    return {
      status: response.status(),
      takesPayments: "takesPayments" in body ? String(body.takesPayments) : "absent",
      notice: (await notice.textContent()) ?? "",
      publishBlocked: await publish.isDisabled(),
      publishNotice: (await page.locator("#registry-publish-blocked").textContent()) ?? "",
    };
  });
  flow.check("registry read", 200, settings.status);
  flow.check("registry read says the site takes money gifts", "false", settings.takesPayments);
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
});
