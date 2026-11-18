/**
 * A stand-in for the Stripe hosts cire-api calls, so the OAuth connect, an
 * upgrade's Checkout and a guest's gift run end to end with no Stripe account
 * behind them.
 *
 * cire-api sends Stripe calls here when `STRIPE_API_URL` and `STRIPE_CONNECT_URL`
 * are loopback origins (`cire/api/src/lib/local-stripe.ts`, read only by
 * `src/local.ts`). It answers these calls and counts each:
 *
 *  - `POST /oauth/token` — the code exchange. Any code connects
 *    {@link STRIPE_STANDIN_ACCOUNT} with `read_write` scope, as Stripe answers a
 *    platform. A code is good once here too: a second exchange of one code is a
 *    400 `invalid_grant`, as Stripe answers a used code;
 *  - `POST /oauth/deauthorize` — handing an account back;
 *  - `GET /v1/accounts/:id` — the account, a Standard one that can take charges
 *    and settles in AUD, so the portal's page-load refresh has nothing to ask;
 *  - `GET /v1/prices/:id` — the one Price the stack sells,
 *    {@link STRIPE_STANDIN_GOLD_PRICE};
 *  - `POST /v1/checkout/sessions` — a platform Checkout session (no
 *    `Stripe-Account`) for the Gold Price, or a guest's gift on a connected
 *    account (`Stripe-Account`), priced inline by `price_data`. Either
 *    session's `url` is on Stripe's own Checkout host, which the flow routes
 *    itself;
 *  - `POST /v1/refunds` — a full refund of a platform PaymentIntent, accepted
 *    at once.
 *
 * It does not read a session back, expire one or list refunds: no flow takes
 * cire-api down a path that asks.
 *
 * A POST with an `Idempotency-Key` it has seen answers the first response
 * again, as Stripe does.
 *
 * What only Stripe could do, the flow asks of it at `/__e2e/stripe/…`:
 *
 *  - `GET /__e2e/stripe/calls` — how many of each call it has served;
 *  - `POST /__e2e/stripe/checkout/:id/pay` — the buyer pays on the Checkout
 *    page: the session completes and gains a PaymentIntent, and the stand-in
 *    answers the page's `success_url` and the `checkout.session.completed`
 *    event Stripe would send, signed at the suite clock's time, for the flow
 *    to deliver. A platform session's event carries no `account` and is
 *    signed with the platform webhook secret; a connected account's carries
 *    the account, as a Connect event does, and is signed with the Connect
 *    webhook secret;
 *  - `GET /__e2e/stripe/refunds` — every refund it has made, oldest first.
 *
 * Anything else is a 404 in Stripe's error shape.
 */

import { createHmac } from "node:crypto";

/** The Standard account every exchange connects. */
export const STRIPE_STANDIN_ACCOUNT = "acct_e2eStandard";

/** The Gold Price the stack's cire-api sells (`STRIPE_UPGRADE_PRICE_GOLD`). */
export const STRIPE_STANDIN_GOLD_PRICE = {
  id: "price_e2e_gold",
  amountMinor: 4900,
  currency: "aud",
} as const;

/** Where a Checkout session's page is. The browser never reaches it: the flow routes it. */
export const STRIPE_CHECKOUT_HOST = "https://checkout.stripe.com";

export interface StripeCalls {
  token: number;
  deauthorize: number;
  account: number;
  price: number;
  /** Platform Checkout sessions created: an upgrade's. */
  checkoutCreate: number;
  /** Checkout sessions created on a connected account: a guest's gift. */
  giftCheckoutCreate: number;
  refund: number;
}

/** A refund the stand-in made, as `GET /__e2e/stripe/refunds` answers it. */
export interface StandInRefund {
  readonly id: string;
  readonly paymentIntent: string;
  /** The `metadata[purchaseId]` cire-api sent. */
  readonly purchaseId: string | null;
  readonly idempotencyKey: string | null;
  readonly amountMinor: number;
}

/** What `POST /__e2e/stripe/checkout/:id/pay` answers. */
export interface PaidCheckout {
  readonly successUrl: string;
  readonly paymentIntent: string;
  /** The event's body, exactly as signed. */
  readonly payload: string;
  /** The `Stripe-Signature` header for `payload`. */
  readonly signature: string;
}

export interface StripeServer {
  readonly port: number;
  readonly calls: StripeCalls;
  stop(): Promise<void>;
}

export interface StripeServerOptions {
  /** Signs the platform events the flow delivers (`STRIPE_PLATFORM_WEBHOOK_SECRET`). */
  readonly platformWebhookSecret: string;
  /** Signs a connected account's events the flow delivers (`STRIPE_WEBHOOK_SECRET`). */
  readonly connectWebhookSecret: string;
  /** Now on the suite's clock, in epoch ms: the time cire-api checks a signature against. */
  readonly now: () => number;
}

/** A `checkout.session.completed` event, as Stripe sends one. */
interface CompletedEvent {
  readonly id: string;
  readonly object: "event";
  readonly type: "checkout.session.completed";
  readonly created: number;
  /** The connected account it happened on; absent on a platform event. */
  account?: string;
  readonly data: { readonly object: ReturnType<typeof sessionBody> };
}

/** A session's metadata: every `metadata[key]` its create sent, as Stripe keeps it. */
type SessionMetadata = Readonly<Record<string, string>>;

interface Session {
  readonly id: string;
  /** The connected account it was made on, or null for the platform's own. */
  readonly account: string | null;
  status: "open" | "complete";
  readonly successUrl: string;
  readonly clientReferenceId: string | null;
  readonly metadata: SessionMetadata;
  readonly amountMinor: number;
  readonly currency: string;
  paymentIntent: string | null;
}

const stripeError = (status: number, error: string): Response =>
  Response.json({ error, error_description: "stand-in refusal" }, { status });

const missing = (): Response =>
  Response.json(
    { error: { type: "invalid_request_error", code: "resource_missing" } },
    { status: 404 },
  );

/** A session as Stripe's API answers it, and as its events carry it. */
function sessionBody(session: Session) {
  return {
    id: session.id,
    object: "checkout.session",
    status: session.status,
    url: session.status === "open" ? `${STRIPE_CHECKOUT_HOST}/c/pay/${session.id}` : null,
    client_reference_id: session.clientReferenceId,
    metadata: session.metadata,
    amount_total: session.amountMinor,
    currency: session.currency,
    payment_status: session.status === "complete" ? "paid" : "unpaid",
    payment_intent: session.paymentIntent,
  };
}

/** Every `metadata[key]` field of a form, as Stripe stores a session's metadata. */
function metadataOf(form: URLSearchParams): SessionMetadata {
  const fields = [...form].flatMap(([field, value]) => {
    const key = /^metadata\[([^\]]+)\]$/.exec(field)?.[1];
    return key === undefined ? [] : [[key, value] as const];
  });
  return Object.fromEntries(fields);
}

export function startStripeServer(port: number, options: StripeServerOptions): StripeServer {
  const calls: StripeCalls = {
    token: 0,
    deauthorize: 0,
    account: 0,
    price: 0,
    checkoutCreate: 0,
    giftCheckoutCreate: 0,
    refund: 0,
  };
  const usedCodes = new Set<string>();
  const sessions = new Map<string, Session>();
  const refunds: StandInRefund[] = [];
  /** A POST's first answer, by its idempotency key. */
  const answered = new Map<string, object>();
  let next = 0;

  /** Answers a keyed POST once, and the same body every time after. */
  const once = (request: Request, make: () => object): Response => {
    const key = request.headers.get("idempotency-key");
    if (key !== null && answered.has(key)) return Response.json(answered.get(key));
    const body = make();
    if (key !== null) answered.set(key, body);
    return Response.json(body);
  };

  const pay = (session: Session): PaidCheckout => {
    next += 1;
    session.status = "complete";
    const paymentIntent = `pi_e2e_${next}`;
    session.paymentIntent = paymentIntent;
    const seconds = Math.floor(options.now() / 1000);
    const event: CompletedEvent = {
      id: `evt_e2e_${next}`,
      object: "event",
      type: "checkout.session.completed",
      created: seconds,
      data: { object: sessionBody(session) },
    };
    // A Connect event names the account it happened on; a platform event
    // names none, and cire-api's platform webhook refuses one that does.
    if (session.account !== null) event.account = session.account;
    const payload = JSON.stringify(event);
    const secret =
      session.account === null ? options.platformWebhookSecret : options.connectWebhookSecret;
    const digest = createHmac("sha256", secret).update(`${seconds}.${payload}`).digest("hex");
    return {
      successUrl: session.successUrl,
      paymentIntent,
      payload,
      signature: `t=${seconds},v1=${digest}`,
    };
  };

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const { pathname } = url;
      const { method } = request;
      if (method === "GET" && pathname === "/__e2e/stripe/calls") {
        return Response.json(calls);
      }
      if (method === "GET" && pathname === "/__e2e/stripe/refunds") {
        return Response.json(refunds);
      }
      const toPay = /^\/__e2e\/stripe\/checkout\/(cs_e2e_[0-9]+)\/pay$/.exec(pathname);
      if (method === "POST" && toPay) {
        const session = sessions.get(toPay[1] ?? "");
        if (!session || session.status !== "open") return missing();
        return Response.json(pay(session));
      }

      if (method === "POST" && pathname === "/oauth/token") {
        calls.token += 1;
        const form = new URLSearchParams(await request.text());
        const code = form.get("code") ?? "";
        if (form.get("grant_type") !== "authorization_code" || code === "") {
          return stripeError(400, "invalid_request");
        }
        if (usedCodes.has(code)) return stripeError(400, "invalid_grant");
        usedCodes.add(code);
        return Response.json({
          stripe_user_id: STRIPE_STANDIN_ACCOUNT,
          scope: "read_write",
          livemode: false,
          token_type: "bearer",
        });
      }
      if (method === "POST" && pathname === "/oauth/deauthorize") {
        calls.deauthorize += 1;
        const form = new URLSearchParams(await request.text());
        return Response.json({ stripe_user_id: form.get("stripe_user_id") });
      }
      const account = /^\/v1\/accounts\/(acct_[A-Za-z0-9_]+)$/.exec(pathname);
      if (method === "GET" && account) {
        calls.account += 1;
        return Response.json({
          id: account[1],
          object: "account",
          type: "standard",
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          default_currency: "aud",
        });
      }

      const price = /^\/v1\/prices\/([A-Za-z0-9_]+)$/.exec(pathname);
      if (method === "GET" && price) {
        calls.price += 1;
        if (price[1] !== STRIPE_STANDIN_GOLD_PRICE.id) return missing();
        return Response.json({
          id: STRIPE_STANDIN_GOLD_PRICE.id,
          object: "price",
          unit_amount: STRIPE_STANDIN_GOLD_PRICE.amountMinor,
          currency: STRIPE_STANDIN_GOLD_PRICE.currency,
        });
      }

      // A call on a connected account's behalf names it in `Stripe-Account`.
      // Only a gift's Checkout session is served on one; refunds are the
      // platform's alone.
      const connected = request.headers.get("stripe-account");
      const platform = connected === null;
      if (method === "POST" && pathname === "/v1/checkout/sessions" && platform) {
        calls.checkoutCreate += 1;
        const form = new URLSearchParams(await request.text());
        if (form.get("line_items[0][price]") !== STRIPE_STANDIN_GOLD_PRICE.id) {
          return stripeError(400, "invalid_request");
        }
        return once(request, () => {
          next += 1;
          const session: Session = {
            id: `cs_e2e_${next}`,
            account: null,
            status: "open",
            successUrl: form.get("success_url") ?? "",
            clientReferenceId: form.get("client_reference_id"),
            metadata: metadataOf(form),
            amountMinor: STRIPE_STANDIN_GOLD_PRICE.amountMinor,
            currency: STRIPE_STANDIN_GOLD_PRICE.currency,
            paymentIntent: null,
          };
          sessions.set(session.id, session);
          return sessionBody(session);
        });
      }
      if (method === "POST" && pathname === "/v1/checkout/sessions" && connected !== null) {
        calls.giftCheckoutCreate += 1;
        const form = new URLSearchParams(await request.text());
        // A gift is priced inline. An amount sent under any other name leaves
        // these unset, and Stripe refuses a line item with no price.
        const amountMinor = Number(form.get("line_items[0][price_data][unit_amount]"));
        const currency = form.get("line_items[0][price_data][currency]") ?? "";
        if (!Number.isInteger(amountMinor) || amountMinor <= 0 || currency === "") {
          return stripeError(400, "invalid_request");
        }
        return once(request, () => {
          next += 1;
          const session: Session = {
            id: `cs_e2e_${next}`,
            account: connected,
            status: "open",
            successUrl: form.get("success_url") ?? "",
            clientReferenceId: form.get("client_reference_id"),
            metadata: metadataOf(form),
            amountMinor,
            currency,
            paymentIntent: null,
          };
          sessions.set(session.id, session);
          return sessionBody(session);
        });
      }
      if (method === "POST" && pathname === "/v1/refunds" && platform) {
        calls.refund += 1;
        const form = new URLSearchParams(await request.text());
        const intent = form.get("payment_intent") ?? "";
        const paid = [...sessions.values()].find(
          (s) => s.account === null && s.paymentIntent === intent,
        );
        if (!paid) return missing();
        return once(request, () => {
          next += 1;
          const refund: StandInRefund = {
            id: `re_e2e_${next}`,
            paymentIntent: intent,
            purchaseId: form.get("metadata[purchaseId]"),
            idempotencyKey: request.headers.get("idempotency-key"),
            amountMinor: paid.amountMinor,
          };
          refunds.push(refund);
          return {
            id: refund.id,
            object: "refund",
            status: "succeeded",
            payment_intent: intent,
            amount: refund.amountMinor,
            metadata: refund.purchaseId === null ? {} : { purchaseId: refund.purchaseId },
          };
        });
      }
      return missing();
    },
  });
  return {
    port: server.port ?? port,
    calls,
    stop: async () => {
      await server.stop(true);
    },
  };
}
