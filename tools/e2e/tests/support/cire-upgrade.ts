/**
 * Buying Gold for an Ivory wedding through the stack: the portal's Upgrade
 * dialog, cire-api's Checkout session at the Stripe stand-in, the buyer paying
 * there, and the signed `checkout.session.completed` delivered to cire-api's
 * platform webhook, as Stripe would.
 *
 * `buyGold` ends with the tier granted: the portal's return poll says so and
 * the wedding's row reads `gold`. `refundGold` deletes the wedding while its
 * checkout is open, which the portal refuses (a payable checkout holds the
 * delete), so it writes the delete into cire-api's database itself: the race a
 * browser cannot make, between a delete and a session being opened. The
 * payment then cannot upgrade the wedding, so cire-api refunds it at the
 * stand-in, keeps the refund's record, and mails the wedding's owner.
 *
 * Both run on a signed-in owner's page, so neither spends a sign-in, and on
 * that one page, so no other tab of the context sits hidden long enough to
 * close its push socket. `refundGold` runs first: `buyGold` ends on the
 * portal's grant, the flow's final screenshot.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import { CIRE_ORGANISER, DB_FILES, ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import {
  STRIPE_CHECKOUT_HOST,
  STRIPE_STANDIN_GOLD_PRICE,
  type PaidCheckout,
  type StandInRefund,
} from "../../src/stripe";
import { expect, mailFor, queryOne, suiteNow, writeRow, type Flow } from "./fixtures";

const PLATFORM_WEBHOOK = `${ORIGINS.cireApi}/api/stripe/platform-webhook`;

/** The refund mail's subject (`renderUpgradeRefund` in @shared/email). */
const REFUND_SUBJECT = "Your Cire upgrade payment has been refunded";

interface Purchase {
  readonly id: string;
  readonly status: string;
  readonly checkout_session_id: string | null;
  readonly payment_intent_id: string | null;
  readonly refund_id: string | null;
}

const purchaseOf = (weddingId: string): Purchase | undefined =>
  queryOne<Purchase>(
    DB_FILES.cire,
    `SELECT id, status, checkout_session_id, payment_intent_id, refund_id
       FROM wedding_upgrade_purchases WHERE wedding_id = ? ORDER BY created_at DESC LIMIT 1`,
    weddingId,
  );

/** The dialog's price line: the Price's amount, sold once. */
const isGoldPrice = (text: string): boolean =>
  text.includes((STRIPE_STANDIN_GOLD_PRICE.amountMinor / 100).toFixed(2)) &&
  text.toLowerCase().includes("one-off");

const tierOf = (weddingId: string): string =>
  queryOne<{ tier: string }>(DB_FILES.cire, "SELECT tier FROM weddings WHERE id = ?", weddingId)
    ?.tier ?? "none";

/** Each page's waiter for the next Checkout session its browser is sent to. */
const checkoutWaiters = new WeakMap<Page, (sessionId: string) => void>();

/**
 * Stripe's Checkout host is not this stack's: the page answers it with a
 * blank one that says where the buyer is, and hands the session id to the
 * step waiting for it. Installed once per page and never removed, since
 * removing a route mid-load strands the request it paused.
 */
async function routeCheckout(page: Page): Promise<void> {
  if (checkoutWaiters.has(page)) return;
  checkoutWaiters.set(page, () => {});
  await page.route(`${STRIPE_CHECKOUT_HOST}/**`, async (route) => {
    checkoutWaiters.get(page)?.(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Stripe Checkout stand-in</title><h1>Checkout</h1>",
    });
  });
}

/**
 * The id of the next Checkout session the page is sent to. Not `async`: an
 * `async` function that returns this promise waits for it to settle, and it
 * settles only once the page reaches Checkout.
 */
const nextCheckout = (page: Page): Promise<string> =>
  new Promise<string>((resolveSession) => checkoutWaiters.set(page, resolveSession));

/**
 * Opens the wedding's Upgrade dialog for Gold from a locked module on the
 * rail, and presses "Continue to payment". Resolves with the Checkout session
 * the browser was sent to; the page is left on the stand-in's checkout page.
 */
async function openCheckout(
  flow: Flow,
  page: Page,
  { weddingId, name }: { weddingId: string; name: string },
): Promise<{ sessionId: string; price: string; catalogue: number }> {
  return flow.step(`open a Gold checkout for ${weddingId}`, async () => {
    await routeCheckout(page);
    const reached = nextCheckout(page);
    const catalogue = page.waitForResponse(
      (res) =>
        res.url() === `${ORIGINS.cireApi}/api/organiser/weddings/${weddingId}/upgrade/catalogue`,
    );
    // A new document: from the portal itself, a change of the hash alone
    // leaves it on the wedding it was showing.
    await page.goto("about:blank");
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/overview`);
    await expect(page.getByRole("button", { name: "Switch wedding" })).toContainText(name);
    const nav = page.getByRole("navigation", { name: "Wedding modules" });
    await nav
      .getByRole("button", { name: /— locked\. Included with Gold\.$/ })
      .first()
      .click();
    await page.getByRole("dialog").getByRole("button", { name: "Upgrade to Gold" }).click();
    const dialog = page.getByRole("dialog", { name: "Upgrade: Gold" });
    const price = dialog.locator("p", { hasText: "one-off" }).first();
    await expect(price).toBeVisible();
    const status = (await catalogue).status();
    const priceText = (await price.textContent())?.replace(/\s+/g, " ").trim() ?? "";
    await dialog.getByRole("button", { name: "Continue to payment" }).click();
    const sessionId = await reached;
    await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();
    return { sessionId, price: priceText, catalogue: status };
  });
}

/** The buyer pays at the stand-in; answers what Stripe would send cire-api. */
async function pay(sessionId: string): Promise<PaidCheckout> {
  const response = await fetch(`${ORIGINS.stripe}/__e2e/stripe/checkout/${sessionId}/pay`, {
    method: "POST",
  });
  expect(response.status, `the stand-in has no open session ${sessionId}`).toBe(200);
  return (await response.json()) as PaidCheckout;
}

/** Delivers the signed event to cire-api's platform webhook, as Stripe does. */
async function deliver(
  flow: Flow,
  paid: PaidCheckout,
): Promise<{ status: number; outcome: string }> {
  const response = await fetch(PLATFORM_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": paid.signature },
    body: paid.payload,
  });
  flow.recordRequest("POST", PLATFORM_WEBHOOK, response.status);
  const body = (await response.json().catch(() => ({}))) as { outcome?: unknown };
  return {
    status: response.status,
    outcome: typeof body.outcome === "string" ? body.outcome : "none",
  };
}

const screenshot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(resolve(SCREENSHOT_DIR, "cire-checklist-starter"), { recursive: true });
  await page.screenshot({
    path: resolve(SCREENSHOT_DIR, "cire-checklist-starter", name),
    animations: "disabled",
  });
};

/**
 * The owner buys Gold for `CIRE_ORGANISER.upgrade.bought`: back on the portal
 * before the webhook has landed, the return poll waits, and ends on the grant
 * once the signed event arrives.
 */
export async function buyGold(flow: Flow, page: Page): Promise<void> {
  const { weddingId } = CIRE_ORGANISER.upgrade.bought;
  const opened = await openCheckout(flow, page, CIRE_ORGANISER.upgrade.bought);
  flow.check("upgrade: cire-api prices Gold for an Ivory wedding", 200, opened.catalogue);
  flow.check("upgrade: the dialog shows the Gold Price, one-off", true, isGoldPrice(opened.price));
  const opening = purchaseOf(weddingId);
  flow.check("upgrade: the purchase is pending on the session", "pending", opening?.status ?? "");
  flow.check(
    "upgrade: the purchase holds the session the browser was sent to",
    true,
    opening?.checkout_session_id === opened.sessionId,
  );

  const returned = await flow.step("pay, and come back before Stripe's event lands", async () => {
    const paid = await pay(opened.sessionId);
    const firstPoll = page.waitForResponse(
      (res) =>
        res.request().method() === "GET" &&
        res
          .url()
          .startsWith(`${ORIGINS.cireApi}/api/organiser/weddings/${weddingId}/upgrade/purchases/`),
    );
    await page.goto(paid.successUrl);
    const polled = (await (await firstPoll).json()) as { purchase?: { status?: unknown } };
    const status = polled.purchase?.status;
    return { paid, firstStatus: typeof status === "string" ? status : "none" };
  });
  flow.check("upgrade: the first poll finds the purchase pending", "pending", returned.firstStatus);

  const delivered = await flow.step("deliver the signed checkout.session.completed", () =>
    deliver(flow, returned.paid),
  );
  flow.check("upgrade: the platform webhook answers 200", 200, delivered.status);
  flow.check("upgrade: the webhook grants the tier", "granted", delivered.outcome);

  await flow.step("the return poll ends on the grant", async () => {
    await expect(page.getByText("Upgrade complete — this wedding is on Gold.")).toBeVisible();
    await screenshot(page, "upgrade-granted.png");
  });
  const settled = purchaseOf(weddingId);
  flow.check("upgrade: the purchase succeeded", "succeeded", settled?.status ?? "");
  flow.check(
    "upgrade: the purchase records the payment",
    true,
    settled?.payment_intent_id === returned.paid.paymentIntent,
  );
  flow.check("upgrade: the wedding is on Gold", "gold", tierOf(weddingId));
  const sale = queryOne<{ n: number; amount: number }>(
    DB_FILES.cire,
    "SELECT count(*) AS n, sum(amount_minor) AS amount FROM platform_sales WHERE purchase_id = ?",
    settled?.id ?? "",
  );
  flow.check("upgrade: one sale is recorded", 1, sale?.n ?? 0);
  flow.check(
    "upgrade: the sale is the Price",
    STRIPE_STANDIN_GOLD_PRICE.amountMinor,
    sale?.amount ?? 0,
  );
}

/**
 * The owner opens a Gold checkout for `CIRE_ORGANISER.upgrade.refunded`, the
 * wedding is deleted while the page is open, and the buyer pays: cire-api
 * refunds the payment in full and mails the owner, once.
 */
export async function refundGold(flow: Flow, page: Page): Promise<void> {
  const { weddingId, name } = CIRE_ORGANISER.upgrade.refunded;
  const opened = await openCheckout(flow, page, CIRE_ORGANISER.upgrade.refunded);
  flow.check("refund: the dialog shows the Gold Price, one-off", true, isGoldPrice(opened.price));

  await flow.step("delete the wedding while its checkout is open", async () => {
    writeRow(
      DB_FILES.cire,
      "UPDATE weddings SET deleted_at = ?, deleted_by_osn_profile_id = ? WHERE id = ?",
      Math.floor(suiteNow() / 1000),
      CIRE_ORGANISER.profileId,
      weddingId,
    );
  });

  const paid = await flow.step("pay for the deleted wedding", () => pay(opened.sessionId));
  const delivered = await flow.step("deliver the signed checkout.session.completed", () =>
    deliver(flow, paid),
  );
  flow.check("refund: the platform webhook answers 200", 200, delivered.status);
  flow.check("refund: the webhook refunds rather than grants", "auto_refunded", delivered.outcome);

  const purchase = purchaseOf(weddingId);
  flow.check("refund: the purchase is auto_refunded", "auto_refunded", purchase?.status ?? "");
  flow.check("refund: the wedding stays on Ivory", "ivory", tierOf(weddingId));

  const refunds = (await (
    await fetch(`${ORIGINS.stripe}/__e2e/stripe/refunds`)
  ).json()) as StandInRefund[];
  const made = refunds.filter((r) => r.paymentIntent === paid.paymentIntent);
  flow.check("refund: Stripe made one refund of the payment", 1, made.length);
  flow.check("refund: in full", STRIPE_STANDIN_GOLD_PRICE.amountMinor, made[0]?.amountMinor ?? 0);
  flow.check(
    "refund: under the purchase's own key",
    true,
    made[0]?.idempotencyKey === `cire-upgrade-refund-${purchase?.id ?? ""}`,
  );
  flow.check(
    "refund: the purchase holds Stripe's refund id",
    true,
    purchase?.refund_id === made[0]?.id,
  );

  const mail = await flow.step("the owner's refund mail reaches Resend", () =>
    mailFor(CIRE_ORGANISER.email, (m) => m.subject === REFUND_SUBJECT),
  );
  const notices = mail.filter((m) => m.subject === REFUND_SUBJECT);
  flow.check("refund: the owner is mailed once", 1, notices.length);
  flow.check(
    "refund: the mail names the wedding, the tier and the amount",
    true,
    notices[0]?.text.includes(`We could not upgrade ${name} to Gold`) === true &&
      notices[0]?.text.includes((STRIPE_STANDIN_GOLD_PRICE.amountMinor / 100).toFixed(2)) === true,
  );
  const record = queryOne<{
    status: string;
    reason: string;
    refund_id: string | null;
    payment_intent_id: string | null;
    amount_minor: number | null;
    owners_notified_at: number | null;
  }>(
    DB_FILES.cire,
    `SELECT status, reason, refund_id, payment_intent_id, amount_minor, owners_notified_at
       FROM platform_refunds WHERE purchase_id = ?`,
    purchase?.id ?? "",
  );
  flow.check("refund: its record is auto_refunded", "auto_refunded", record?.status ?? "");
  flow.check("refund: the record names why", "wedding_not_live", record?.reason ?? "");
  flow.check("refund: the record holds the refund", true, record?.refund_id === made[0]?.id);
  flow.check(
    "refund: the record holds the payment",
    true,
    record?.payment_intent_id === paid.paymentIntent,
  );
  flow.check(
    "refund: the record holds the amount",
    STRIPE_STANDIN_GOLD_PRICE.amountMinor,
    record?.amount_minor ?? 0,
  );

  flow.check(
    "refund: the record says the owners were mailed",
    true,
    typeof record?.owners_notified_at === "number",
  );

  const again = await flow.step("deliver the same event again", () => deliver(flow, paid));
  flow.check("refund: a redelivery answers 200", 200, again.status);
  flow.check("refund: a redelivery is a replay", "replayed", again.outcome);
  const after = (await (
    await fetch(`${ORIGINS.stripe}/__e2e/stripe/refunds`)
  ).json()) as StandInRefund[];
  flow.check(
    "refund: a redelivery refunds nothing more",
    1,
    after.filter((r) => r.paymentIntent === paid.paymentIntent).length,
  );
  const mailAfter = await mailFor(CIRE_ORGANISER.email);
  flow.check(
    "refund: a redelivery mails nobody",
    1,
    mailAfter.filter((m) => m.subject === REFUND_SUBJECT).length,
  );
}
