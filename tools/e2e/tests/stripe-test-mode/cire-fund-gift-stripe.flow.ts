/**
 * A guest gives money to a cash fund, paid at Stripe's real test mode: the
 * nightly run (`bun run test:e2e:stripe`, `src/stripe-test-mode-launcher.ts`).
 * The pull request suite runs the same journey on the Stripe stand-in
 * (`tests/support/cire-fund-gift.ts`, from `cire-registry-money`).
 *
 * Fund Wedding's settings are pointed at the sandbox's connected account
 * (`STRIPE_TEST_CONNECTED_ACCOUNT`) with charges off and no currency, so the
 * portal's settings page asks Stripe for the account through cire-api. The
 * owner adds the fund, and Pia chooses it and presses "Continue to payment":
 * cire-api opens a Checkout session on the connected account at Stripe, and
 * her browser opens Stripe's own Checkout page. The flow then pays the session
 * with Stripe's test card through the calls Stripe's own CLI pays one with
 * (`stripe trigger checkout.session.completed`), since Stripe's pages are built
 * to stop automated typing (docs.stripe.com/automated-testing). Stripe signs
 * `checkout.session.completed`, `stripe listen` forwards it to cire-api's
 * Connect webhook, and the gift settles.
 *
 * Beside the journey it compares the stand-in's answers with Stripe's, field
 * by field, for the account, the open session and the paid event, and writes
 * the table to `e2e-artifacts/stripe-fields.json` (paths and types, no
 * values). Last, it refunds the payment, so the sandbox's balance does not
 * grow by a gift a night.
 *
 * Stripe is called with Node's `fetch` (`stripeCaller`), never a Playwright
 * request context, whose trace would record the key. No step, check or page
 * call carries the key, and no id the run makes is recorded.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { ARTIFACT_DIR, CIRE_ORGANISER, DB_FILES, LOG_DIR, ORIGINS, PORTS } from "../../src/config";
import { STRIPE_CHECKOUT_HOST, type PaidCheckout } from "../../src/stripe";
import {
  driftLine,
  forwardedEvent,
  fieldTypes,
  STRIPE_TEST_API_VERSION,
  stripeCaller,
  stripeErrorCode,
  stripeTestMode,
  webhookAnswer,
  type JsonObject,
  type JsonValue,
} from "../../src/stripe-test-mode";
import {
  addFund,
  captureContribute,
  chooseTheFund,
  CONTRIBUTE_URL,
  FUND,
  GIFT,
  giftCount,
  giftRow,
  shoot,
  standInCalls,
} from "../support/cire-fund-gift";
import { expect, queryOne, signInToCireHost, test, writeRow } from "../support/fixtures";

const FLOW = "cire-fund-gift-stripe-test-mode";
const { weddingId, household } = CIRE_ORGANISER.fund;
const REFRESH_URL = `${ORIGINS.cireApi}/api/organiser/weddings/${weddingId}/registry/stripe/refresh`;
const LISTEN_LOG = resolve(LOG_DIR, "stripe-listen.log");
const FORWARDED_TO = `http://127.0.0.1:${PORTS.cireApi}/api/stripe/webhook`;

const listenLog = (): string => {
  try {
    return readFileSync(LISTEN_LOG, "utf8");
  } catch {
    return "";
  }
};

/** The open session and the paid event, as Stripe and the stand-in answer them. */
interface StripeSession {
  readonly id?: string;
  readonly livemode?: boolean;
  readonly status?: string;
  readonly amount_total?: number;
  readonly currency?: string;
  readonly client_reference_id?: string | null;
  readonly metadata?: { readonly contributionId?: string };
  readonly success_url?: string;
  readonly payment_intent?: string | null;
}

test(FLOW, async ({ page, browser, flow }) => {
  const mode = stripeTestMode(process.env);
  if (mode.kind !== "ready") {
    throw new Error("run this flow through `bun run test:e2e:stripe`, which checks the key first");
  }
  const stripe = stripeCaller(mode.secretKey);
  const { account } = mode;

  await flow.step("stripe test mode: point Fund Wedding at the sandbox's account", async () => {
    // Charges off and no currency, so the settings page asks Stripe again.
    writeRow(
      DB_FILES.cire,
      `UPDATE registry_settings
          SET stripe_account_id = ?, stripe_charges_enabled = 0, stripe_default_currency = NULL
        WHERE wedding_id = ?`,
      account,
      weddingId,
    );
  });

  await signInToCireHost(flow, page);
  // The runner keeps the real clock; the servers run on the suite's, which
  // this run starts at the real now. A stack still on the fixed instant would
  // send Stripe a Checkout session that has already closed.
  const signedIn = queryOne<{ at: number }>(
    DB_FILES.cire,
    "SELECT max(created_at) AS at FROM organiser_sessions WHERE osn_profile_id = ?",
    CIRE_ORGANISER.profileId,
  );
  flow.check(
    "stripe test mode: the stack runs on the real clock",
    true,
    Math.abs((signedIn?.at ?? 0) * 1000 - Date.now()) < 120_000,
  );

  const refreshed = await flow.step(
    "Fund Wedding: the settings page asks Stripe for the account",
    async () => {
      const answer = page.waitForResponse(
        (r) => r.url() === REFRESH_URL && r.request().method() === "POST",
      );
      await page.goto("about:blank");
      await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/registry/settings`);
      // The status alone: the page may leave before its body is read, and
      // Playwright then waits on that body until the test's time runs out.
      // What Stripe said is read from the row below.
      return (await answer).status();
    },
  );
  flow.check("stripe: cire-api reads the account from Stripe", 200, refreshed);
  const settings = queryOne<{ charges: number; currency: string | null }>(
    DB_FILES.cire,
    `SELECT stripe_charges_enabled AS charges, stripe_default_currency AS currency
       FROM registry_settings WHERE wedding_id = ?`,
    weddingId,
  );
  flow.check(
    "stripe: the row takes charges, settling in the wedding's currency",
    "1 AUD",
    `${settings?.charges} ${settings?.currency}`,
  );

  const added = await addFund(flow, page);

  // ── The guest, in a browser of her own ──────────────────────────────────
  const context = await browser.newContext();
  const guest = await flow.newPage(context);
  const contributeAnswer = await captureContribute(guest);
  let sessionId = "";
  let paid = false;
  let refundStatus = -1;
  try {
    const panel = await chooseTheFund(flow, guest, added, FLOW);

    const before = await standInCalls();
    const handedOff = await flow.step(
      "guest: continue to payment, on Stripe's Checkout page",
      async () => {
        const contributed = guest.waitForResponse(
          (r) => r.url() === CONTRIBUTE_URL && r.request().method() === "POST",
        );
        const landed = guest.waitForResponse(
          (r) =>
            r.request().isNavigationRequest() &&
            r.request().frame() === guest.mainFrame() &&
            new URL(r.url()).origin === STRIPE_CHECKOUT_HOST,
        );
        await panel.getByRole("button", { name: "Continue to payment" }).click();
        const sent = (await contributed).request().postDataJSON() as Record<string, unknown>;
        const document = await landed;
        await guest.waitForLoadState("load");
        await shoot(guest, FLOW, "stripe-checkout.png");
        const answer = contributeAnswer() ?? { status: -1, url: "" };
        return { status: answer.status, url: answer.url, sent, document: document.status() };
      },
    );
    flow.check("guest: cire-api answers the gift", 200, handedOff.status);
    flow.check(
      "guest: with a page on Stripe's Checkout host",
      STRIPE_CHECKOUT_HOST,
      new URL(handedOff.url || "about:blank").origin,
    );
    flow.check("guest: the browser opens Stripe's Checkout page", true, handedOff.document < 400);
    flow.check(
      "guest: the page sends the amount, the fund, the name and the note",
      `${GIFT.amountMinor}/true/${GIFT.name}/${GIFT.note}`,
      `${String(handedOff.sent.amountMinor)}/${String(handedOff.sent.itemId === added.id)}/${String(handedOff.sent.displayName)}/${String(handedOff.sent.message)}`,
    );
    flow.check(
      "stripe: cire-api opened the session at Stripe, not at the stand-in",
      before.giftCheckoutCreate,
      (await standInCalls()).giftCheckoutCreate,
    );

    const pending = giftRow();
    const gift = queryOne<{ id: string }>(
      DB_FILES.cire,
      "SELECT id FROM registry_contributions WHERE family_id = ?",
      household.familyId,
    );
    sessionId = pending?.stripe_checkout_session_id ?? "";
    flow.check("gift: one row for the household", 1, giftCount());
    flow.check("gift: pending until Stripe says the money moved", "pending", pending?.status ?? "");
    flow.check(
      "gift: given to the new fund, under its name",
      `true/${FUND.title}`,
      `${pending?.item_id === added.id}/${pending?.item_title}`,
    );
    flow.check(
      "gift: Stripe's Checkout address names the session, as the stand-in's does",
      true,
      sessionId !== "" && handedOff.url.includes(sessionId),
    );

    const session = await flow.step("stripe: read the session back from Stripe", async () =>
      stripe("GET", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, { account }),
    );
    const opened = (session.body ?? {}) as StripeSession;
    flow.check("stripe: the session reads", 200, session.status);
    // Before anything is paid: a live session stops the run here.
    flow.check("stripe: the session is a test-mode one", "false", String(opened.livemode));
    flow.check(
      "stripe: open, for the amount given, in the wedding's currency",
      `open ${GIFT.amountMinor} aud`,
      `${opened.status} ${opened.amount_total} ${opened.currency}`,
    );
    flow.check(
      "stripe: the session names the gift cire-api wrote",
      true,
      gift !== undefined &&
        opened.client_reference_id === gift.id &&
        opened.metadata?.contributionId === gift.id,
    );

    // The stand-in's answers to the same calls, after the count above, which
    // the stand-in session below adds to.
    const standIn = await flow.step(
      "stripe: read the stand-in's answers to the same calls",
      async () => {
        const realAccount = await stripe("GET", `/v1/accounts/${encodeURIComponent(account)}`);
        const standInAccount = (await (
          await fetch(`${ORIGINS.stripe}/v1/accounts/${encodeURIComponent(account)}`)
        ).json()) as JsonValue;
        const standInSession = (await (
          await fetch(`${ORIGINS.stripe}/v1/checkout/sessions`, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "stripe-account": account,
            },
            body: new URLSearchParams({
              mode: "payment",
              success_url: opened.success_url ?? "",
              cancel_url: opened.success_url ?? "",
              "line_items[0][quantity]": "1",
              "line_items[0][price_data][currency]": "aud",
              "line_items[0][price_data][unit_amount]": String(GIFT.amountMinor),
              "line_items[0][price_data][product_data][name]": "Wedding gift",
              client_reference_id: "rct_compare",
              "metadata[contributionId]": "rct_compare",
            }),
          })
        ).json()) as StripeSession;
        return {
          accountStatus: realAccount.status,
          account: fieldTypes(standInAccount, realAccount.body),
          session: fieldTypes(standInSession, session.body),
          sessionId: standInSession.id ?? "",
        };
      },
    );
    flow.check("stripe: the account reads", 200, standIn.accountStatus);

    const payment = await flow.step(
      "stripe: pay with Stripe's test card, as Stripe's own CLI pays a session",
      async () => {
        const opts = { account };
        const state = await stripe(
          "GET",
          `/v1/payment_pages/${encodeURIComponent(sessionId)}`,
          opts,
        );
        const method = await stripe("POST", "/v1/payment_methods", {
          ...opts,
          form: {
            type: "card",
            "card[token]": "tok_visa",
            "billing_details[name]": "Pia Parkes",
            "billing_details[email]": "pia.parkes@example.com",
          },
        });
        const methodId = (method.body as { id?: unknown } | null)?.id;
        const confirm = await stripe(
          "POST",
          `/v1/payment_pages/${encodeURIComponent(sessionId)}/confirm`,
          {
            ...opts,
            form: {
              payment_method: typeof methodId === "string" ? methodId : "",
              expected_amount: String(GIFT.amountMinor),
            },
          },
        );
        return {
          state: state.status,
          method: method.status,
          confirm: `${confirm.status} ${stripeErrorCode(confirm.body)}`,
        };
      },
    );
    flow.check("stripe: the Checkout page's state reads", 200, payment.state);
    flow.check("stripe: the test card becomes a payment method", 200, payment.method);
    paid = payment.confirm.startsWith("200 ");
    flow.check("stripe: the session is paid", "200 none", payment.confirm);

    const event = await flow.step(
      "stripe: Stripe signs checkout.session.completed, and stripe listen forwards it",
      async () => {
        let found: JsonObject | null = null;
        await expect
          .poll(
            () => {
              found = forwardedEvent(listenLog(), sessionId);
              return found !== null;
            },
            {
              timeout: 60_000,
              message: `no checkout.session.completed for the session in ${LISTEN_LOG}, which says whether stripe listen exited`,
            },
          )
          .toBe(true);
        return found as unknown as JsonObject;
      },
    );
    const eventId = typeof event.id === "string" ? event.id : "";
    const answered = await flow.step("cire-api: take Stripe's signed event", async () => {
      let answer: ReturnType<typeof webhookAnswer> = null;
      await expect
        .poll(() => (answer = webhookAnswer(listenLog(), eventId)) !== null, {
          timeout: 30_000,
          message: `no answer to the event in ${LISTEN_LOG}`,
        })
        .toBe(true);
      return answer as unknown as { status: number; url: string };
    });
    flow.check("stripe: the event names the sandbox's account", true, event.account === account);
    flow.check(
      "cire-api: the Connect webhook is where stripe listen sends it",
      FORWARDED_TO,
      answered.url,
    );
    flow.check("cire-api: the Connect webhook answers Stripe's signed event", 200, answered.status);

    const settled = giftRow();
    const charged = (event.data as { object?: StripeSession } | undefined)?.object;
    flow.check("gift: still one row for the household", 1, giftCount());
    flow.check("gift: succeeded", "succeeded", settled?.status ?? "");
    flow.check("gift: still given to the new fund", true, settled?.item_id === added.id);
    flow.check("gift: still under the fund's name", FUND.title, settled?.item_title ?? "absent");
    flow.check("gift: at the amount given", GIFT.amountMinor, settled?.amount_minor ?? -1);
    flow.check(
      "gift: holds Stripe's payment",
      true,
      typeof charged?.payment_intent === "string" &&
        settled?.stripe_payment_intent_id === charged.payment_intent,
    );

    const thanked = await flow.step(
      "guest: back from Stripe, the gift page thanks them",
      async () => {
        await guest.goto(opened.success_url ?? "about:blank");
        await expect(guest.getByText(/^Thank you\. If your payment went through/)).toBeVisible();
        return new URL(guest.url()).origin;
      },
    );
    flow.check("guest: Stripe sends them back to the guest site", ORIGINS.cireInvites, thanked);

    // The stand-in's paid event, against the one Stripe signed.
    const standInPaid = await flow.step("stripe: the stand-in pays its own session", async () => {
      const response = await fetch(
        `${ORIGINS.stripe}/__e2e/stripe/checkout/${standIn.sessionId}/pay`,
        { method: "POST" },
      );
      return (await response.json()) as PaidCheckout;
    });
    const eventFields = fieldTypes(JSON.parse(standInPaid.payload) as JsonValue, event);
    writeFileSync(
      resolve(ARTIFACT_DIR, "stripe-fields.json"),
      `${JSON.stringify(
        {
          note: "Each field the Stripe stand-in sends, with its JSON type there and in Stripe's test-mode answer. No values.",
          stripeVersionAsked: STRIPE_TEST_API_VERSION,
          eventApiVersion: typeof event.api_version === "string" ? event.api_version : null,
          account: standIn.account,
          "checkout.session": standIn.session,
          "checkout.session.completed": eventFields,
        },
        null,
        2,
      )}\n`,
    );
    flow.check("drift: the account, stand-in against Stripe", "none", driftLine(standIn.account));
    flow.check(
      "drift: the open session, stand-in against Stripe",
      "none",
      driftLine(standIn.session),
    );
    flow.check("drift: the paid event, stand-in against Stripe", "none", driftLine(eventFields));
    flow.check(
      "stripe: the event is in the API version cire-api pins",
      STRIPE_TEST_API_VERSION,
      String(event.api_version),
    );
  } finally {
    // Whatever failed above, a payment made is refunded. A check here would
    // hide the failure that brought the run here, so it comes after.
    if (paid) {
      const read = await stripe("GET", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
        account,
      }).catch(() => null);
      const intent = (read?.body as StripeSession | null)?.payment_intent;
      if (typeof intent === "string") {
        refundStatus = await stripe("POST", "/v1/refunds", {
          account,
          form: { payment_intent: intent },
        })
          .then((answer) => answer.status)
          .catch(() => -1);
      }
    }
    await context.close();
  }
  flow.check("cleanup: the test payment is refunded", 200, refundStatus);
});
