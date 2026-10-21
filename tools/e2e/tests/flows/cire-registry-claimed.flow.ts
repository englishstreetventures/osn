/**
 * Cire: a guest opens the couple's gift-list link before entering their code,
 * is sent to the invitation, enters it, and then sees the list: from the band
 * the invitation now shows, through to every gift, the couple's headline and
 * their message. The list read answers 401 before the claim and 200 after it,
 * and the household's own read answers 200. Signing out on the invitation
 * locks the list again and removes the household's session.
 *
 * The couple also have a cash fund, and their own settings take money. This
 * stack's cire-api has a Stripe key and no Connect webhook secret: it could
 * open a payment page but never record the gift, so the list offers neither
 * the money form nor the fund. The flow reads the fund's row and the couple's
 * Stripe-ready settings from the database first, so the fund's absence is the
 * deployment's doing, not a seed that lacks one.
 *
 * The wedding is the gift-list one cire-api seeds for the suite
 * (`CIRE_GIFT_LIST`); every string the locked flow checks is absent is checked
 * here to be present — on the page, or for the fund, in the database — so a
 * seed that drifts from the config fails this flow rather than letting the
 * locked one pass on nothing.
 */

import type { Page } from "@playwright/test";

import { CIRE_GIFT_LIST, DB_FILES, ORIGINS } from "../../src/config";
import { expect, giftListTextIn, onSuiteClock, queryOne, test } from "../support/fixtures";

const LIST_URL = `${ORIGINS.cireApi}/api/invite/${CIRE_GIFT_LIST.slug}/registry`;
const MINE_URL = `${LIST_URL}/mine`;
const CLAIM_URL = `${ORIGINS.cireApi}/api/claim`;

/** Resolves with the first `method` request to exactly `url`; `…/registry` is a prefix of `…/registry/mine`. */
function responseTo(page: Page, method: string, url: string) {
  return page.waitForResponse((r) => r.url() === url && r.request().method() === method);
}

test("cire-registry-claimed", async ({ page, context, flow }) => {
  const before = await flow.step("open the gift list without a code", async () => {
    const read = responseTo(page, "GET", LIST_URL);
    await page.goto(`${ORIGINS.cireInvites}/cire/registry?slug=${CIRE_GIFT_LIST.slug}`);
    const response = await read;
    await expect(page.getByText("This gift list is for the couple’s guests.")).toBeVisible();
    return response.status();
  });
  flow.check("list read before the claim", 401, before);

  await flow.step("decline optional storage", async () => {
    // The consent prompt is an idle-hydrated island: wait for it rather than race it.
    const prompt = page.getByRole("dialog", { name: "Privacy choices" });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await prompt.getByRole("button", { name: "Reject all" }).click();
    await expect(prompt).toBeHidden();
  });

  await flow.step("follow the page to the invitation", async () => {
    await page.getByRole("link", { name: "Open the invitation" }).click();
    await expect(page).toHaveURL(`${ORIGINS.cireInvites}/cire/invite?slug=${CIRE_GIFT_LIST.slug}`);
    await expect(page.getByLabel("Invitation code")).toBeVisible();
  });

  const claim = await flow.step("enter the household code", async () => {
    // The field is in the server-rendered HTML before its island hydrates, and
    // text typed into it then never reaches the form. Consent was settled on
    // the gift page, so no prompt marks hydration here: type until the form
    // takes it.
    await expect(async () => {
      await page.getByLabel("Invitation code").fill(CIRE_GIFT_LIST.code);
      await expect(page.getByRole("button", { name: "Open Invitation" })).toBeEnabled({
        timeout: 1_000,
      });
    }).toPass({ timeout: 60_000 });
    const response = responseTo(page, "POST", CLAIM_URL);
    await page.getByRole("button", { name: "Open Invitation" }).click();
    const status = (await response).status();
    await expect(page.getByText(CIRE_GIFT_LIST.guestName).first()).toBeVisible();
    return status;
  });
  flow.check("claim with the household code", 200, claim);

  const band = page.locator("[data-gift-teaser]");
  await flow.step("the invitation shows the gift band", async () => {
    // The band is a `client:visible` island. If it hydrated before the claim,
    // the claim event has already made it read the list; if not, coming into
    // range does. Either way, wait for what it renders, not for the request.
    await page.keyboard.press("End");
    await expect(band.getByRole("link", { name: "See the gift list" })).toBeVisible();
    // No invite-builder heading on this wedding, so the band takes the
    // couple's own headline, which arrives only with the list.
    await expect(band.getByRole("heading", { name: CIRE_GIFT_LIST.headline })).toBeVisible();
  });
  flow.check(
    "band read the list",
    true,
    flow.saw(`GET cire-api /api/invite/${CIRE_GIFT_LIST.slug}/registry 200`),
  );

  const after = await flow.step("open the gift list", async () => {
    const list = responseTo(page, "GET", LIST_URL);
    const mine = responseTo(page, "GET", MINE_URL);
    await band.getByRole("link", { name: "See the gift list" }).click();
    const [listResponse, mineResponse] = await Promise.all([list, mine]);
    for (const gift of CIRE_GIFT_LIST.gifts) {
      await expect(page.getByRole("heading", { name: gift })).toBeVisible();
    }
    await expect(page.getByText(CIRE_GIFT_LIST.message)).toBeVisible();
    const body = (await listResponse.json()) as {
      cashGiftsEnabled?: boolean;
      funds?: unknown[];
    };
    const html = await page.content();
    return {
      list: listResponse.status(),
      mine: mineResponse.status(),
      // Absent reads as "offered", so a missing field fails the checks below.
      moneyOffered: body.cashGiftsEnabled ?? true,
      fundsOffered: body.funds?.length ?? -1,
      moneyForm: await page.locator("[data-gift-money]").count(),
      fundOnPage:
        [CIRE_GIFT_LIST.fund.title, CIRE_GIFT_LIST.fund.description]
          .filter((s) => html.includes(s))
          .join(", ") || "none",
    };
  });
  flow.check("list read after the claim", 200, after.list);
  flow.check("household read after the claim", 200, after.mine);

  // The couple's side is ready to take money, and the fund is theirs. Read
  // first, so what follows cannot pass on a seed with no fund in it.
  const fund = queryOne<{ title: string; description: string; kind: string }>(
    DB_FILES.cire,
    `SELECT title, description, kind FROM registry_items WHERE id = ?`,
    CIRE_GIFT_LIST.fund.id,
  );
  flow.check("the couple's fund is on their list", CIRE_GIFT_LIST.fund.title, fund?.title ?? "");
  flow.check("the fund's words", CIRE_GIFT_LIST.fund.description, fund?.description ?? "");
  flow.check("the fund is a cash fund", "cash_fund", fund?.kind ?? "");
  const money = queryOne<{ ready: number }>(
    DB_FILES.cire,
    `SELECT (s.cash_gifts_enabled = 1 AND s.stripe_charges_enabled = 1
             AND s.stripe_account_id IS NOT NULL
             AND upper(s.stripe_default_currency) = upper(w.currency)) AS ready
       FROM registry_settings s JOIN weddings w ON w.id = s.wedding_id
      WHERE w.slug = ?`,
    CIRE_GIFT_LIST.slug,
  );
  flow.check("the couple's settings take money", 1, money?.ready ?? 0);
  // …and still nothing is offered, because this deployment cannot record a
  // payment: a Stripe key but no webhook secret, so no contribute route.
  flow.check("money offered on a stack with no Stripe webhook secret", false, after.moneyOffered);
  flow.check("funds offered on a stack with no Stripe webhook secret", 0, after.fundsOffered);
  flow.check("money form on the page", 0, after.moneyForm);
  flow.check("fund on the page", "none", after.fundOnPage);

  const sessions = queryOne<{ n: number; created_at: number }>(
    DB_FILES.cire,
    `SELECT count(*) AS n, max(s.created_at) AS created_at FROM sessions s
       JOIN families f ON f.id = s.family_id
      WHERE f.public_id = ?`,
    CIRE_GIFT_LIST.code,
  );
  flow.check("one session for the household", 1, sessions?.n ?? 0);
  flow.check("session written on the suite clock", true, onSuiteClock(sessions?.created_at));

  // A shared or borrowed browser stops showing the list by signing out. Done
  // in a second tab, so the screenshot keeps the open list above.
  const signedOut = await flow.step("sign out and reopen the gift list", async () => {
    const other = await flow.newPage(context);
    await other.goto(`${ORIGINS.cireInvites}/cire/invite?slug=${CIRE_GIFT_LIST.slug}`);
    const signOut = other.getByRole("button", { name: /Sign out$/ });
    await expect(signOut).toBeVisible({ timeout: 60_000 });
    const out = responseTo(other, "POST", `${ORIGINS.cireApi}/api/claim/signout`);
    await signOut.click();
    const outStatus = (await out).status();
    await expect(other.getByLabel("Invitation code")).toBeVisible();

    const read = responseTo(other, "GET", LIST_URL);
    await other.goto(`${ORIGINS.cireInvites}/cire/registry?slug=${CIRE_GIFT_LIST.slug}`);
    const listStatus = (await read).status();
    await expect(other.getByText("This gift list is for the couple’s guests.")).toBeVisible();
    return { outStatus, listStatus, leaked: giftListTextIn(await other.content()) };
  });
  flow.check("sign-out answered", 204, signedOut.outStatus);
  flow.check("list read after sign-out", 401, signedOut.listStatus);
  flow.check("gift data on the page after sign-out", "none", signedOut.leaked);

  const left = queryOne<{ n: number }>(
    DB_FILES.cire,
    `SELECT count(*) AS n FROM sessions s
       JOIN families f ON f.id = s.family_id
      WHERE f.public_id = ?`,
    CIRE_GIFT_LIST.code,
  );
  flow.check("no session left for the household", 0, left?.n ?? -1);
});
