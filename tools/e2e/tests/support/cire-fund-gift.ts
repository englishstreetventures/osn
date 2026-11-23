/**
 * A guest gives money to a cash fund the couple have just added, along the
 * whole paid path the stack runs: the portal's add form, cire-api's item
 * route, the guest list, the gift page's money panel, cire-api's contribute
 * route, a Checkout session on the couple's connected account at the Stripe
 * stand-in, and the signed `checkout.session.completed` the flow delivers to
 * cire-api's Connect webhook, as Stripe would.
 *
 * The wedding is Fund Wedding (`CIRE_ORGANISER.fund`), whose published list
 * starts empty. The owner, already signed in on `owner`, adds the fund through
 * the form, so the request is the one the portal builds. The guest, Pia, opens
 * the invitation at her household's link in a browser of her own, chooses the
 * fund, types an amount, her name and a note, and is handed to Stripe's
 * Checkout page, which the flow answers since the stack cannot reach Stripe.
 * The stand-in then completes the session and signs its event; the webhook
 * settles the gift, which then reads `succeeded` with the fund's name, and the
 * owner's gift log shows it received.
 *
 * Every id the run makes (the fund's, the gift's, the session's) is compared,
 * never recorded, so `results.json` reads the same on every run. The guest's
 * browser reaches no host but localhost and the Checkout page the flow
 * answers itself, and the flow checks that it did not.
 *
 * The owner's fund (`addFund`) and the guest's steps up to the money panel
 * (`chooseTheFund`) are shared with the run against Stripe's test mode
 * (`tests/stripe-test-mode/`), which pays at Stripe instead.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Browser, Locator, Page } from "@playwright/test";

import { CIRE_ORGANISER, DB_FILES, ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { STRIPE_CHECKOUT_HOST, type PaidCheckout, type StripeCalls } from "../../src/stripe";
import { expect, queryOne, type Flow } from "./fixtures";

const { weddingId, slug, accountId, connector, household } = CIRE_ORGANISER.fund;
const ITEMS_URL = `${ORIGINS.cireApi}/api/organiser/weddings/${weddingId}/registry/items`;
const LIST_URL = `${ORIGINS.cireApi}/api/invite/${slug}/registry`;
export const CONTRIBUTE_URL = `${LIST_URL}/contribute`;
const CLAIM_URL = `${ORIGINS.cireApi}/api/claim`;
const WEBHOOK_URL = `${ORIGINS.cireApi}/api/stripe/webhook`;

/** The fund the owner adds, as typed into the portal's form. */
export const FUND = {
  title: "Our first home",
  goal: "8000",
  goalMinor: 800_000,
  description: "A deposit on a little place by the sea.",
} as const;

/** What the guest gives, as typed into the gift page's money panel. */
export const GIFT = {
  amount: "75",
  amountMinor: 7_500,
  shown: "$75.00",
  name: "The Parkes",
  note: "For the first night in.",
} as const;

/** The household's gifts, as cire-api stores them. */
export interface GiftRow {
  readonly status: string;
  readonly item_id: string | null;
  readonly item_title: string | null;
  readonly amount_minor: number;
  readonly currency: string;
  readonly display_name: string | null;
  readonly message: string | null;
  readonly stripe_checkout_session_id: string | null;
  readonly stripe_payment_intent_id: string | null;
}

export const giftCount = (): number =>
  queryOne<{ n: number }>(
    DB_FILES.cire,
    "SELECT count(*) AS n FROM registry_contributions WHERE family_id = ?",
    household.familyId,
  )?.n ?? -1;

export const giftRow = (): GiftRow | undefined =>
  queryOne<GiftRow>(
    DB_FILES.cire,
    `SELECT status, item_id, item_title, amount_minor, currency, display_name, message,
            stripe_checkout_session_id, stripe_payment_intent_id
       FROM registry_contributions WHERE family_id = ? ORDER BY created_at LIMIT 1`,
    household.familyId,
  );

export const standInCalls = async (): Promise<StripeCalls> =>
  (await (await fetch(`${ORIGINS.stripe}/__e2e/stripe/calls`)).json()) as StripeCalls;

/** Loopback hosts: everything the stack serves, the stand-ins included. */
const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

/** A view a step shoots, under `screenshots/<dir>/`. */
export const shoot = async (page: Page, dir: string, name: string): Promise<void> => {
  mkdirSync(resolve(SCREENSHOT_DIR, dir), { recursive: true });
  await page.screenshot({ path: resolve(SCREENSHOT_DIR, dir, name), animations: "disabled" });
};

/** The fund the owner added, by the id cire-api gave it. */
export interface AddedFund {
  readonly id: string;
}

/**
 * The owner, signed in on `owner`, adds the fund through the gift list's form
 * on Fund Wedding, and the flow checks the request the portal built and the
 * row cire-api stored.
 */
export async function addFund(flow: Flow, owner: Page): Promise<AddedFund> {
  // The wedding's other owner connected its account, so no other wedding of
  // the dev profile is offered it (`cire-registry-money`'s Party Wedding
  // steps count the accounts offered there).
  const seeded = queryOne<{ connector: string | null; seat: string | null }>(
    DB_FILES.cire,
    `SELECT s.stripe_connected_by_osn_profile_id AS connector,
            (SELECT h.osn_profile_id FROM wedding_hosts h
              WHERE h.id = ? AND h.wedding_id = s.wedding_id AND h.role = 'owner') AS seat
       FROM registry_settings s WHERE s.wedding_id = ?`,
    connector.hostId,
    weddingId,
  );
  flow.check(
    "fund: the account was connected by the wedding's other owner",
    connector.profileId,
    seeded?.connector ?? "absent",
  );
  flow.check(
    "fund: who holds an owner seat on the wedding",
    connector.profileId,
    seeded?.seat ?? "absent",
  );

  const added = await flow.step(
    "Fund Wedding: add a cash fund through the gift list's form",
    async () => {
      // A new document: from the portal itself, a change of the hash alone
      // leaves it on the wedding it was showing.
      await owner.goto("about:blank");
      await owner.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/registry/list`);
      await expect(owner.getByText("No gifts on the list yet", { exact: true })).toBeVisible();
      await owner.getByRole("radio", { name: "A cash fund" }).check();
      await owner.getByLabel("Fund", { exact: true }).fill(FUND.title);
      await owner.getByLabel("Goal (optional)", { exact: true }).fill(FUND.goal);
      await owner.getByLabel("What it’s for (optional)", { exact: true }).fill(FUND.description);
      const created = owner.waitForResponse(
        (r) => r.url() === ITEMS_URL && r.request().method() === "POST",
      );
      await owner.getByRole("button", { name: "Add fund" }).click();
      const response = await created;
      const sent = response.request().postDataJSON() as Record<string, unknown>;
      const { item } = (await response.json()) as { item: { id: string } };
      await expect(owner.getByTestId("registry-items")).toContainText(FUND.title);
      return { status: response.status(), sent, id: item.id };
    },
  );
  flow.check("fund: cire-api adds the fund", 200, added.status);
  flow.check(
    "fund: the portal sends the add form's fields and nothing else",
    "allowPartial,description,imageKey,kind,targetMinor,title",
    Object.keys(added.sent).toSorted().join(","),
  );
  flow.check(
    "fund: as a cash fund that is not a group gift, its goal in cents",
    `cash_fund/false/${FUND.goalMinor}`,
    `${String(added.sent.kind)}/${String(added.sent.allowPartial)}/${String(added.sent.targetMinor)}`,
  );
  const stored = queryOne<{ kind: string; group: number; target: number; title: string }>(
    DB_FILES.cire,
    `SELECT kind, allow_partial AS "group", target_minor AS target, title
       FROM registry_items WHERE id = ?`,
    added.id,
  );
  flow.check(
    "fund: stored as a cash fund with its goal",
    `cash_fund/0/${FUND.goalMinor}`,
    `${stored?.kind}/${stored?.group}/${stored?.target}`,
  );
  flow.check("fund: stored under its name", FUND.title, stored?.title ?? "absent");
  return { id: added.id };
}

/**
 * Pia, on `guest`, opens the invitation at her household's link, declines
 * optional storage, opens the gift list and chooses the fund, an amount, a
 * name and a note in the money panel, which she leaves shot as
 * `screenshots/<shotDir>/guest-money-panel.png`. Resolves to the panel, its
 * "Continue to payment" enabled.
 */
export async function chooseTheFund(
  flow: Flow,
  guest: Page,
  added: AddedFund,
  shotDir: string,
): Promise<Locator> {
  const claimed = await flow.step(
    "guest: open the invitation at the household's link",
    async () => {
      const claim = guest.waitForResponse(
        (r) => r.url() === CLAIM_URL && r.request().method() === "POST",
      );
      await guest.goto(`${ORIGINS.cireInvites}/cire/invite?slug=${slug}&code=${household.code}`);
      const status = (await claim).status();
      await expect(guest.getByText(household.guestName).first()).toBeVisible();
      return status;
    },
  );
  flow.check("guest: claim with the household's code", 200, claimed);

  await flow.step("guest: decline optional storage", async () => {
    // The consent prompt is an idle-hydrated island: wait for it rather than race it.
    const prompt = guest.getByRole("dialog", { name: "Privacy choices" });
    await expect(prompt).toBeVisible({ timeout: 60_000 });
    await prompt.getByRole("button", { name: "Reject all" }).click();
    await expect(prompt).toBeHidden();
  });

  const panel = guest.locator("[data-gift-money]");
  const opened = await flow.step("guest: open the gift list", async () => {
    // Off the invitation first, so none of its islands is still running.
    await guest.goto("about:blank");
    const read = guest.waitForResponse(
      (r) => r.url() === LIST_URL && r.request().method() === "GET",
    );
    await guest.goto(`${ORIGINS.cireInvites}/cire/registry?slug=${slug}`);
    const response = await read;
    const body = (await response.json()) as {
      cashGiftsEnabled?: boolean;
      funds?: Array<{ id: string; title: string }>;
    };
    await expect(panel).toBeVisible();
    return {
      status: response.status(),
      // Absent reads as "not offered", so a missing field fails below.
      money: body.cashGiftsEnabled ?? false,
      funds: (body.funds ?? []).map((fund) => fund.title).join(", "),
      theNewFund: body.funds?.[0]?.id === added.id,
    };
  });
  flow.check("guest: list read", 200, opened.status);
  flow.check("guest: the list offers money", true, opened.money);
  flow.check("guest: the list offers the one fund", FUND.title, opened.funds);
  flow.check("guest: it is the fund the owner added", true, opened.theNewFund);

  const chosen = await flow.step(
    "guest: choose the fund, an amount, a name and a note",
    async () => {
      await panel.locator(`[data-gift-money-fund="${added.id}"]`).click();
      const fund = panel.getByRole("radio", { name: new RegExp(`^${FUND.title}`) });
      await expect(fund).toBeChecked();
      await panel.locator("label", { hasText: "Another amount" }).click();
      const amount = panel.getByLabel("Amount (AUD)", { exact: true });
      await expect(amount).toBeVisible();
      await amount.fill(GIFT.amount);
      await panel.getByLabel("Your name (optional)", { exact: true }).fill(GIFT.name);
      await panel.getByLabel("A note for them (optional)", { exact: true }).fill(GIFT.note);
      await expect(panel.getByRole("button", { name: "Continue to payment" })).toBeEnabled();
      await panel.scrollIntoViewIfNeeded();
      await shoot(guest, shotDir, "guest-money-panel.png");
      return {
        fund: await fund.isChecked(),
        others: await panel.getByRole("radio", { name: "Wherever they choose" }).isChecked(),
      };
    },
  );
  flow.check("guest: the fund is chosen", true, chosen.fund);
  flow.check("guest: wherever they choose is not", false, chosen.others);
  return panel;
}

/** What cire-api answered the gift page's contribute call. */
export interface ContributeAnswer {
  readonly status: number;
  readonly url: string;
}

/**
 * Reads cire-api's answer to `guest`'s contribute call. The gift page leaves
 * for Checkout the moment cire-api answers, and a response the page has
 * navigated away from has no body left to read. So the answer is read on its
 * way to the page, and handed on unchanged. Install it before the page loads:
 * removing a route mid-load strands the request it paused.
 */
export async function captureContribute(guest: Page): Promise<() => ContributeAnswer | null> {
  let answer: ContributeAnswer | null = null;
  await guest.route(CONTRIBUTE_URL, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as { url?: string };
    answer = { status: response.status(), url: body.url ?? "" };
    await route.fulfill({ response });
  });
  return () => answer;
}

export async function giveToANewFund(flow: Flow, owner: Page, browser: Browser): Promise<void> {
  const added = await addFund(flow, owner);

  // ── The guest, in a browser of their own ────────────────────────────────
  const context = await browser.newContext();
  const guest = await flow.newPage(context);
  /** Each Checkout page the browser was sent to, which the flow answered. */
  const answered = new Set<string>();
  /** Every request to a host other than localhost that the flow did not answer. */
  const offsite: string[] = [];
  let toCheckout: (url: string) => void = () => {};
  // Stripe's Checkout host is not this stack's: answered here with a blank
  // page. Installed before the first request and never removed, since
  // removing a route mid-load strands the request it paused.
  await guest.route(`${STRIPE_CHECKOUT_HOST}/**`, async (route) => {
    const url = route.request().url();
    answered.add(url);
    toCheckout(url);
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Stripe Checkout stand-in</title><h1>Checkout</h1>",
    });
  });
  const contributeAnswer = await captureContribute(guest);
  context.on("requestfinished", (request) => {
    const url = new URL(request.url());
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (!LOOPBACK.has(url.hostname) && !answered.has(request.url())) offsite.push(url.origin);
  });
  context.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (!LOOPBACK.has(url.hostname) && !answered.has(request.url())) offsite.push(url.origin);
  });

  try {
    const panel = await chooseTheFund(flow, guest, added, "cire-registry-money");

    const before = await standInCalls();
    const handedOff = await flow.step(
      "guest: continue to payment, on Stripe's Checkout page",
      async () => {
        const reached = new Promise<string>((done) => {
          toCheckout = done;
        });
        const contributed = guest.waitForResponse(
          (r) => r.url() === CONTRIBUTE_URL && r.request().method() === "POST",
        );
        await panel.getByRole("button", { name: "Continue to payment" }).click();
        const response = await contributed;
        const sent = response.request().postDataJSON() as Record<string, unknown>;
        const at = await reached;
        await expect(guest.getByRole("heading", { name: "Checkout" })).toBeVisible();
        const answer = contributeAnswer() ?? { status: -1, url: "" };
        return { status: answer.status, sent, url: answer.url, at };
      },
    );
    const sessionId = new URL(handedOff.url || "about:blank").pathname.split("/").pop() ?? "";
    flow.check("guest: cire-api answers the gift", 200, handedOff.status);
    flow.check(
      "guest: with a page on Stripe's Checkout host, at the stand-in's session",
      `${STRIPE_CHECKOUT_HOST}/c/pay/cs_e2e_:n`,
      handedOff.url.replace(/cs_e2e_[0-9]+$/, "cs_e2e_:n"),
    );
    flow.check("guest: the browser goes to that page", true, handedOff.at === handedOff.url);
    flow.check(
      "guest: the page sends the amount, the fund, the name and the note",
      `${GIFT.amountMinor}/true/${GIFT.name}/${GIFT.note}`,
      `${String(handedOff.sent.amountMinor)}/${String(handedOff.sent.itemId === added.id)}/${String(handedOff.sent.displayName)}/${String(handedOff.sent.message)}`,
    );
    flow.check(
      "stripe: cire-api opened one Checkout session on a connected account",
      before.giftCheckoutCreate + 1,
      (await standInCalls()).giftCheckoutCreate,
    );

    const pending = giftRow();
    flow.check("gift: one row for the household", 1, giftCount());
    flow.check("gift: pending until Stripe says the money moved", "pending", pending?.status ?? "");
    flow.check("gift: given to the new fund", true, pending?.item_id === added.id);
    flow.check("gift: under the fund's name", FUND.title, pending?.item_title ?? "absent");
    flow.check(
      "gift: the amount, in the wedding's currency",
      `${GIFT.amountMinor} AUD`,
      `${pending?.amount_minor} ${pending?.currency}`,
    );
    flow.check(
      "gift: the name and the note the guest typed",
      `${GIFT.name}/${GIFT.note}`,
      `${pending?.display_name}/${pending?.message}`,
    );
    flow.check(
      "gift: holds the session the browser was sent to",
      true,
      pending?.stripe_checkout_session_id === sessionId,
    );

    const paid = await flow.step("guest: pay on Stripe's Checkout page", async () => {
      const response = await fetch(`${ORIGINS.stripe}/__e2e/stripe/checkout/${sessionId}/pay`, {
        method: "POST",
      });
      expect(response.status, `the stand-in has no open session ${sessionId}`).toBe(200);
      return (await response.json()) as PaidCheckout;
    });
    const event = JSON.parse(paid.payload) as {
      type?: string;
      account?: string;
      data?: { object?: { amount_total?: number; currency?: string } };
    };
    flow.check(
      "stripe: the event says the session completed",
      "checkout.session.completed",
      event.type ?? "",
    );
    flow.check(
      "stripe: the event names the couple's account",
      accountId,
      event.account ?? "absent",
    );
    flow.check(
      "stripe: the event says what was charged",
      `${GIFT.amountMinor} aud`,
      `${event.data?.object?.amount_total} ${event.data?.object?.currency}`,
    );

    const delivered = await flow.step(
      "stripe: deliver the signed checkout.session.completed",
      async () => {
        const response = await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "content-type": "application/json", "stripe-signature": paid.signature },
          body: paid.payload,
        });
        flow.recordRequest("POST", WEBHOOK_URL, response.status);
        const body = (await response.json().catch(() => ({}))) as { outcome?: unknown };
        return {
          status: response.status,
          outcome: typeof body.outcome === "string" ? body.outcome : "none",
        };
      },
    );
    flow.check("cire-api: the Connect webhook answers 200", 200, delivered.status);
    flow.check("cire-api: the webhook settles the gift", "settled", delivered.outcome);

    const settled = giftRow();
    flow.check("gift: still one row for the household", 1, giftCount());
    flow.check("gift: succeeded", "succeeded", settled?.status ?? "");
    flow.check("gift: still given to the new fund", true, settled?.item_id === added.id);
    flow.check("gift: still under the fund's name", FUND.title, settled?.item_title ?? "absent");
    flow.check("gift: at the amount given", GIFT.amountMinor, settled?.amount_minor ?? -1);
    flow.check(
      "gift: holds Stripe's payment",
      true,
      settled?.stripe_payment_intent_id === paid.paymentIntent,
    );

    const thanked = await flow.step(
      "guest: back from Stripe, the gift page thanks them",
      async () => {
        await guest.goto(paid.successUrl);
        const thanks = guest.getByText(/^Thank you\. If your payment went through/);
        await expect(thanks).toBeVisible();
        return new URL(paid.successUrl).origin;
      },
    );
    flow.check("guest: Stripe sends them back to the guest site", ORIGINS.cireInvites, thanked);
    flow.check(
      "guest: no request left localhost but Stripe's Checkout page, which the flow answered",
      "none",
      [...new Set(offsite)].toSorted().join(", ") || "none",
    );
    flow.check("guest: the flow answered one Checkout page", 1, answered.size);
  } finally {
    await context.close();
  }

  const logged = await flow.step("Fund Wedding: the gift log shows the gift received", async () => {
    await owner.goto("about:blank");
    await owner.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/registry/gifts`);
    const row = owner.getByRole("listitem").filter({ hasText: GIFT.name });
    await expect(row).toContainText("Received");
    return (await row.textContent()) ?? "";
  });
  flow.check("gift log: the gift is under the fund's name", true, logged.includes(FUND.title));
  flow.check("gift log: at the amount given", true, logged.includes(GIFT.shown));
  flow.check("gift log: received", true, logged.includes("Received"));
}
