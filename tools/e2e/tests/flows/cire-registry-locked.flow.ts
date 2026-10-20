/**
 * Cire: a visitor who has not entered a household code opens a couple's gift
 * list and gets none of it. The list read answers 401, the page says the list
 * is for the couple's guests and links to the invitation, and no gift title,
 * the couple's headline or their message is anywhere in the page. The same
 * holds on the older `/<slug>/registry` link, for the API asked directly, for
 * the public invite payload and the invitation itself, and for a browser
 * holding a stale `cire_claimed` hint and a session the API never issued (an
 * expired or revoked one reads the same to the server).
 *
 * The wedding is the gift-list one cire-api seeds for the suite
 * (`CIRE_GIFT_LIST`); `cire-registry-claimed` checks every string this flow
 * checks absent is there for a household that claimed. The refusals in
 * isolation (no cookie, a household of another wedding, the image route) are
 * cire-api's own tests; this flow proves the browser receives nothing either.
 */

import type { Page } from "@playwright/test";

import { CIRE_GIFT_LIST, ORIGINS } from "../../src/config";
import { expect, giftListTextIn, test } from "../support/fixtures";

const LIST_URL = `${ORIGINS.cireApi}/api/invite/${CIRE_GIFT_LIST.slug}/registry`;
const MINE_URL = `${LIST_URL}/mine`;
const INVITE_URL = `${ORIGINS.cireApi}/api/invite/${CIRE_GIFT_LIST.slug}`;

/** Resolves with the first GET to exactly `url`; `…/registry` is a prefix of `…/registry/mine`. */
function getTo(page: Page, url: string) {
  return page.waitForResponse((r) => r.url() === url && r.request().method() === "GET");
}

test("cire-registry-locked", async ({ page, context, flow }) => {
  const locked = page.getByText("This gift list is for the couple’s guests.");

  const first = await flow.step("open the gift list without a code", async () => {
    const read = getTo(page, LIST_URL);
    await page.goto(`${ORIGINS.cireInvites}/cire/registry?slug=${CIRE_GIFT_LIST.slug}`);
    const response = await read;
    await expect(locked).toBeVisible();
    await expect(page.getByRole("link", { name: "Open the invitation" })).toBeVisible();
    return response.status();
  });
  flow.check("list read with no session", 401, first);
  flow.check("gift data on the page with no session", "none", giftListTextIn(await page.content()));

  const older = await flow.step("open the older gift-list link", async () => {
    const read = getTo(page, LIST_URL);
    await page.goto(`${ORIGINS.cireInvites}/${CIRE_GIFT_LIST.slug}/registry`);
    const response = await read;
    await expect(locked).toBeVisible();
    return response.status();
  });
  flow.check("list read on the older link", 401, older);
  flow.check("gift data on the older link", "none", giftListTextIn(await page.content()));

  const direct = await flow.step("ask the API directly", async () => {
    const list = await context.request.get(LIST_URL);
    flow.recordRequest("GET", LIST_URL, list.status());
    // The invite payload answers anyone holding the link, so nothing from the
    // list may ride in it.
    const invite = await context.request.get(INVITE_URL);
    flow.recordRequest("GET", INVITE_URL, invite.status());
    return {
      list: list.status(),
      listLeaked: giftListTextIn(await list.text()),
      invite: invite.status(),
      inviteLeaked: giftListTextIn(await invite.text()),
    };
  });
  flow.check("API list read with no session", 401, direct.list);
  flow.check("gift data in the API list answer", "none", direct.listLeaked);
  flow.check("public invite payload", 200, direct.invite);
  flow.check("gift data in the public invite payload", "none", direct.inviteLeaked);

  await flow.step("open the invitation without a code", async () => {
    await page.goto(`${ORIGINS.cireInvites}/cire/invite?slug=${CIRE_GIFT_LIST.slug}`);
    await expect(page.getByLabel("Invitation code")).toBeVisible();
  });
  flow.check("gift band on the invitation", 0, await page.locator("[data-gift-teaser]").count());
  flow.check("gift data on the invitation", "none", giftListTextIn(await page.content()));

  const stale = await flow.step("come back with a stale hint and a dead session", async () => {
    await context.addCookies([
      { name: "cire_claimed", value: "1", url: ORIGINS.cireInvites },
      // 64 hex characters, the shape of a real token, which the API never issued.
      { name: "cire_session", value: "0f".repeat(32), url: ORIGINS.cireApi },
    ]);
    const list = getTo(page, LIST_URL);
    const mine = getTo(page, MINE_URL);
    await page.goto(`${ORIGINS.cireInvites}/cire/registry?slug=${CIRE_GIFT_LIST.slug}`);
    const [listResponse, mineResponse] = await Promise.all([list, mine]);
    await expect(locked).toBeVisible();
    // A 401 is also what no cookie at all gets, so check the session went out.
    const sent = async (r: typeof listResponse) =>
      (await r.request().headerValue("cookie"))?.includes("cire_session=") ?? false;
    return {
      list: listResponse.status(),
      mine: mineResponse.status(),
      listSent: await sent(listResponse),
      mineSent: await sent(mineResponse),
    };
  });
  flow.check("dead session sent with the list read", true, stale.listSent);
  flow.check("list read with a dead session", 401, stale.list);
  flow.check("dead session sent with the household read", true, stale.mineSent);
  flow.check("household read with a dead session", 401, stale.mine);
  flow.check(
    "gift data on the page with a dead session",
    "none",
    giftListTextIn(await page.content()),
  );

  await flow.step("decline optional storage", async () => {
    // The consent prompt is an idle-hydrated island: wait for it rather than
    // race it, so the screenshot shows the page and not the prompt.
    const prompt = page.getByRole("dialog", { name: "Privacy choices" });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await prompt.getByRole("button", { name: "Reject all" }).click();
    await expect(prompt).toBeHidden();
  });
});
