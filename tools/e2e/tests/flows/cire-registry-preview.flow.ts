/**
 * Cire: the organiser opens the invitation the way "Preview invite" does, at a
 * link carrying the wedding's host preview code, which claims on load. The
 * gift list reads as guests see it, with every Reserve control disabled and a
 * note saying why. A reservation sent anyway, from the page with the preview
 * session's cookie, is refused with 403 `preview_read_only`, and no claim row
 * exists for the host household afterwards. This stack's cire-api has a Stripe
 * key and no webhook secret, so the list offers no money, and the preview note
 * does not tell the organiser that guests give money here.
 *
 * The organiser previews from their own network, so the claim goes out from
 * `ORGANISER_ADDRESS` and spends its own window of cire-api's claim limit, not
 * the one the guest flows share (`tools/e2e/tests/flows.test.ts`).
 */

import type { Page } from "@playwright/test";

import { CIRE_GIFT_LIST, DB_FILES, ORIGINS } from "../../src/config";
import { claimFromOrganiserAddress, expect, queryOne, test } from "../support/fixtures";

const LIST_URL = `${ORIGINS.cireApi}/api/invite/${CIRE_GIFT_LIST.slug}/registry`;
const MINE_URL = `${LIST_URL}/mine`;
const CLAIM_URL = `${ORIGINS.cireApi}/api/claim`;
const RESERVE_URL = `${LIST_URL}/items/${CIRE_GIFT_LIST.firstGiftId}/claim`;

/** Resolves with the first `method` request to exactly `url`; `…/registry` is a prefix of `…/registry/mine`. */
function responseTo(page: Page, method: string, url: string) {
  return page.waitForResponse((r) => r.url() === url && r.request().method() === method);
}

test("cire-registry-preview", async ({ page, context, flow }) => {
  await claimFromOrganiserAddress(context);

  const claim = await flow.step("open the invitation from Preview invite", async () => {
    const response = responseTo(page, "POST", CLAIM_URL);
    await page.goto(
      `${ORIGINS.cireInvites}/cire/invite?slug=${CIRE_GIFT_LIST.slug}&code=${CIRE_GIFT_LIST.previewCode}`,
    );
    const status = (await response).status();
    await expect(page.getByText("Preview mode. Every event is shown")).toBeVisible();
    return status;
  });
  flow.check("claim with the preview code", 200, claim);

  await flow.step("decline optional storage", async () => {
    // The consent prompt is an idle-hydrated island: wait for it rather than race it.
    const prompt = page.getByRole("dialog", { name: "Privacy choices" });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await prompt.getByRole("button", { name: "Reject all" }).click();
    await expect(prompt).toBeHidden();
  });

  const opened = await flow.step("open the gift list", async () => {
    const list = responseTo(page, "GET", LIST_URL);
    const mine = responseTo(page, "GET", MINE_URL);
    await page.goto(`${ORIGINS.cireInvites}/cire/registry?slug=${CIRE_GIFT_LIST.slug}`);
    const [listResponse, mineResponse] = await Promise.all([list, mine]);
    for (const gift of CIRE_GIFT_LIST.gifts) {
      await expect(page.getByRole("heading", { name: gift })).toBeVisible();
    }
    await expect(page.locator("[data-gift-preview]")).toContainText("Preview mode.");
    const reserve = page.getByRole("button", { name: "Reserve" });
    await expect(reserve).toHaveCount(CIRE_GIFT_LIST.gifts.length);
    for (const button of await reserve.all()) await expect(button).toBeDisabled();
    return {
      list: listResponse.status(),
      mine: mineResponse.status(),
      preview: ((await mineResponse.json()) as { preview?: boolean }).preview === true,
      disabled: await page.getByRole("button", { name: "Reserve", disabled: true }).count(),
      noteNamesMoney: /money/i.test(
        (await page.locator("[data-gift-preview]").textContent()) ?? "",
      ),
    };
  });
  flow.check("list read in preview", 200, opened.list);
  flow.check("household read in preview", 200, opened.mine);
  flow.check("household read says preview", true, opened.preview);
  flow.check("Reserve controls disabled", CIRE_GIFT_LIST.gifts.length, opened.disabled);
  flow.check(
    "preview note names money on a stack with no Stripe webhook secret",
    false,
    opened.noteNamesMoney,
  );

  const refused = await flow.step("reserve a gift from the page anyway", async () =>
    page.evaluate(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quantity: 1 }),
      });
      const body = (await response.json()) as { error?: string };
      return { status: response.status, error: body.error ?? "" };
    }, RESERVE_URL),
  );
  flow.check("reserve in preview answered", 403, refused.status);
  flow.check("reserve in preview refused as", "preview_read_only", refused.error);

  const held = queryOne<{ n: number }>(
    DB_FILES.cire,
    `SELECT count(*) AS n FROM registry_claims c
       JOIN families f ON f.id = c.family_id
      WHERE f.public_id = ?`,
    CIRE_GIFT_LIST.previewCode,
  );
  flow.check("claims held by the preview household", 0, held?.n ?? -1);
});
