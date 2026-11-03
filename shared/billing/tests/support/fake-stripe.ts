/**
 * A scripted Stripe behind `fetch`: enough of the REST API for the package's
 * calls, with state a test can read and change, and a log of every request.
 * Objects are built in the shape of API version `2025-03-31.basil`.
 */

import { hmacHex } from "./stripe";

export interface StripeCall {
  readonly method: string;
  readonly path: string;
  readonly url: string;
  readonly query: URLSearchParams;
  /** The decoded form body, keys as Stripe reads them (`a[b][0]`). */
  readonly form: Record<string, string>;
  readonly headers: Headers;
}

type Json = Record<string, unknown>;
type Intercept = (call: StripeCall) => Response | undefined | Promise<Response | undefined>;

/** `a[b][0]=x` → `{ a: { b: { 0: "x" } } }`; arrays stay index-keyed objects. */
export function unflatten(form: Record<string, string>): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(form)) {
    const parts = key.replaceAll("]", "").split("[");
    let node = out;
    for (const [i, part] of parts.entries()) {
      if (i === parts.length - 1) node[part] = value;
      else node = (node[part] ??= {}) as Json;
    }
  }
  return out;
}

const error = (status: number, code: string) =>
  Response.json({ error: { code, message: `scripted ${code}` } }, { status });

export interface FakePriceInput {
  id: string;
  lookupKey: string | null;
  product: string;
  planId?: string | null;
  currency?: string;
  unitAmount?: number;
  taxBehavior?: string;
  interval?: string;
  active?: boolean;
  currencyOptions?: Record<string, number>;
}

export const priceJson = (p: FakePriceInput): Json => {
  const currency = (p.currency ?? "aud").toLowerCase();
  const options: Json = {
    [currency]: { unit_amount: p.unitAmount ?? 4900, tax_behavior: p.taxBehavior ?? "exclusive" },
  };
  for (const [c, amount] of Object.entries(p.currencyOptions ?? {})) {
    options[c.toLowerCase()] = { unit_amount: amount, tax_behavior: p.taxBehavior ?? "exclusive" };
  }
  return {
    id: p.id,
    object: "price",
    active: p.active ?? true,
    currency,
    unit_amount: p.unitAmount ?? 4900,
    tax_behavior: p.taxBehavior ?? "exclusive",
    lookup_key: p.lookupKey,
    product: p.product,
    metadata: p.planId === null ? {} : { plan_id: p.planId ?? "" },
    recurring: { interval: p.interval ?? "month" },
    currency_options: options,
  };
};

export interface FakeSubscriptionInput {
  id: string;
  customer: string;
  status?: string;
  currency?: string;
  priceId?: string;
  product?: string;
  planId?: string | null;
  interval?: string;
  periodStart?: number;
  periodEnd?: number;
  trialEnd?: number | null;
  cancelAtPeriodEnd?: boolean;
  latestInvoice?: string | null;
}

export const subscriptionJson = (s: FakeSubscriptionInput): Json => ({
  id: s.id,
  object: "subscription",
  customer: s.customer,
  status: s.status ?? "active",
  currency: (s.currency ?? "aud").toLowerCase(),
  cancel_at_period_end: s.cancelAtPeriodEnd ?? false,
  trial_end: s.trialEnd ?? null,
  latest_invoice: s.latestInvoice ?? null,
  items: {
    object: "list",
    data: [
      {
        id: `si_${s.id}`,
        current_period_start: s.periodStart ?? 1_900_000_000,
        current_period_end: s.periodEnd ?? 1_900_000_000 + 30 * 86_400,
        price: {
          id: s.priceId ?? "price_monthly",
          product: s.product ?? "billing_monthly",
          metadata: s.planId === null ? {} : { plan_id: s.planId ?? "monthly" },
          recurring: { interval: s.interval ?? "month" },
        },
      },
    ],
  },
});

export interface FakeInvoiceLine {
  amount: number;
  start: number;
  end: number;
  subscription?: string;
  proration?: boolean;
  /** `invoice_item_details` for a one-off item. */
  kind?: "subscription_item_details" | "invoice_item_details";
}

export const invoiceJson = (i: {
  id: string;
  subscription: string;
  status?: string;
  billingReason?: string;
  total?: number;
  lines: FakeInvoiceLine[];
}): Json => ({
  id: i.id,
  object: "invoice",
  status: i.status ?? "paid",
  billing_reason: i.billingReason ?? "subscription_cycle",
  total: i.total ?? i.lines.reduce((sum, l) => sum + l.amount, 0),
  customer_address: { country: "AU", postal_code: "2000" },
  customer_email: "billing@example.test",
  parent: { type: "subscription_details", subscription_details: { subscription: i.subscription } },
  lines: {
    object: "list",
    data: i.lines.map((l) => ({
      amount: l.amount,
      period: { start: l.start, end: l.end },
      parent:
        (l.kind ?? "subscription_item_details") === "subscription_item_details"
          ? {
              type: "subscription_item_details",
              subscription_item_details: {
                subscription: l.subscription ?? i.subscription,
                subscription_item: `si_${i.subscription}`,
                proration: l.proration ?? false,
              },
            }
          : { type: "invoice_item_details", invoice_item_details: { proration: false } },
    })),
  },
});

export function createFakeStripe(options: { portalPageSize?: number } = {}) {
  const prices: Json[] = [];
  const products = new Map<string, Json>();
  const portalConfigurations: Json[] = [];
  const sessions = new Map<string, Json>();
  const subscriptions = new Map<string, Json>();
  const invoices = new Map<string, Json>();
  const idempotent = new Map<string, Json>();
  const calls: StripeCall[] = [];
  let seq = 0;
  /** Return a Response to answer a call yourself (a failure, a delay); undefined to fall through. */
  let intercept: Intercept = () => undefined;

  const keyed = (call: StripeCall, make: () => Json): Json => {
    const key = call.headers.get("idempotency-key");
    if (key === null) return make();
    const scoped = `${call.path} ${key}`;
    const seen = idempotent.get(scoped);
    if (seen) return seen;
    const made = make();
    idempotent.set(scoped, made);
    return made;
  };

  const route = (call: StripeCall): Response => {
    const { method, path } = call;
    const body = unflatten(call.form);
    let m: RegExpMatchArray | null;

    if (method === "GET" && path === "/v1/prices") {
      const keys = new Set(
        [...call.query.entries()].filter(([k]) => k.startsWith("lookup_keys[")).map(([, v]) => v),
      );
      const expanded = [...call.query.entries()].some(
        ([k, v]) => k.startsWith("expand[") && v === "data.currency_options",
      );
      const active = call.query.get("active");
      const data = prices
        .filter(
          (p) => keys.has(String(p.lookup_key)) && (active === null || String(p.active) === active),
        )
        .map((p) => {
          if (expanded) return p;
          const { currency_options: _omitted, ...rest } = p;
          return rest;
        });
      return Response.json({ object: "list", data, has_more: false });
    }
    if (method === "POST" && path === "/v1/customers") {
      return Response.json(keyed(call, () => ({ id: `cus_${++seq}`, object: "customer" })));
    }
    if (method === "POST" && path === "/v1/checkout/sessions") {
      return Response.json(
        keyed(call, () => {
          const id = `cs_${++seq}`;
          const session = {
            id,
            object: "checkout.session",
            status: "open",
            url: `https://checkout.stripe.test/${id}`,
            mode: String(body.mode),
            customer: String(body.customer),
            subscription: null,
          };
          sessions.set(id, session);
          return session;
        }),
      );
    }
    if ((m = path.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/)) && method === "POST") {
      const session = sessions.get(decodeURIComponent(m[1]!));
      if (!session) return error(404, "resource_missing");
      if (session.status !== "open") return error(400, "checkout_session_not_open");
      session.status = "expired";
      session.url = null;
      return Response.json(session);
    }
    if ((m = path.match(/^\/v1\/checkout\/sessions\/([^/]+)$/)) && method === "GET") {
      const session = sessions.get(decodeURIComponent(m[1]!));
      return session ? Response.json(session) : error(404, "resource_missing");
    }
    if (method === "POST" && path === "/v1/billing_portal/sessions") {
      return Response.json({ id: `bps_${++seq}`, url: `https://billing.stripe.test/p/${seq}` });
    }
    if ((m = path.match(/^\/v1\/subscriptions\/([^/]+)$/)) && method === "GET") {
      const sub = subscriptions.get(decodeURIComponent(m[1]!));
      return sub ? Response.json(sub) : error(404, "resource_missing");
    }
    if ((m = path.match(/^\/v1\/invoices\/([^/]+)$/)) && method === "GET") {
      const invoice = invoices.get(decodeURIComponent(m[1]!));
      return invoice ? Response.json(invoice) : error(404, "resource_missing");
    }
    // Sync: products, prices, portal configurations.
    if ((m = path.match(/^\/v1\/products\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]!);
      const product = products.get(id);
      if (!product) return error(404, "resource_missing");
      if (method === "POST") Object.assign(product, body);
      return Response.json(product);
    }
    if (method === "POST" && path === "/v1/products") {
      const product = { object: "product", active: true, metadata: {}, tax_code: null, ...body };
      products.set(String(body.id), product);
      return Response.json(product);
    }
    if (method === "POST" && path === "/v1/prices") {
      const options = (body.currency_options ?? {}) as Record<string, Json>;
      const currencyOptions: Record<string, number> = {};
      for (const [c, o] of Object.entries(options)) currencyOptions[c] = Number(o.unit_amount);
      const lookupKey = (body.lookup_key as string | undefined) ?? null;
      if (lookupKey !== null && body.transfer_lookup_key === "true") {
        for (const p of prices) if (p.lookup_key === lookupKey) p.lookup_key = null;
      }
      const price = priceJson({
        id: `price_${++seq}`,
        lookupKey,
        product: String(body.product),
        planId: ((body.metadata as Json | undefined)?.plan_id as string | undefined) ?? null,
        currency: String(body.currency),
        unitAmount: Number(body.unit_amount),
        taxBehavior: String(body.tax_behavior),
        interval: String((body.recurring as Json | undefined)?.interval),
        currencyOptions,
      });
      prices.push(price);
      return Response.json(price);
    }
    if ((m = path.match(/^\/v1\/prices\/([^/]+)$/)) && method === "POST") {
      const price = prices.find((p) => p.id === decodeURIComponent(m![1]!));
      if (!price) return error(404, "resource_missing");
      if (body.metadata)
        price.metadata = { ...(price.metadata as Json), ...(body.metadata as Json) };
      return Response.json(price);
    }
    if (method === "GET" && path === "/v1/billing_portal/configurations") {
      // Honours `starting_after`, and pages by `portalPageSize` when given.
      const after = call.query.get("starting_after");
      const from = after === null ? 0 : portalConfigurations.findIndex((p) => p.id === after) + 1;
      const size = options.portalPageSize ?? portalConfigurations.length;
      const data = portalConfigurations.slice(from, from + size);
      return Response.json({
        object: "list",
        data,
        has_more: from + size < portalConfigurations.length,
      });
    }
    if (method === "POST" && path === "/v1/billing_portal/configurations") {
      const configuration = {
        id: `bpc_${++seq}`,
        object: "billing_portal.configuration",
        active: true,
        ...body,
      };
      portalConfigurations.push(configuration);
      return Response.json(configuration);
    }
    if ((m = path.match(/^\/v1\/billing_portal\/configurations\/([^/]+)$/)) && method === "POST") {
      const configuration = portalConfigurations.find((p) => p.id === decodeURIComponent(m![1]!));
      if (!configuration) return error(404, "resource_missing");
      Object.assign(configuration, body);
      return Response.json(configuration);
    }
    return error(404, "unscripted_route");
  };

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const formBody =
      typeof init?.body === "string" ? new URLSearchParams(init.body) : new URLSearchParams();
    const call: StripeCall = {
      method: init?.method ?? "GET",
      path: url.pathname,
      url: String(input),
      query: url.searchParams,
      form: Object.fromEntries(formBody.entries()),
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    const scripted = await intercept(call);
    return scripted ?? route(call);
  };

  return {
    fetchImpl,
    calls,
    prices,
    products,
    portalConfigurations,
    sessions,
    subscriptions,
    invoices,
    /** Script an answer; return `undefined` to let the fake answer. */
    setIntercept(fn: Intercept) {
      intercept = fn;
    },
    callsTo(method: string, path: string | RegExp) {
      return calls.filter(
        (c) =>
          c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path)),
      );
    },
  };
}

export type FakeStripe = ReturnType<typeof createFakeStripe>;

export const WEBHOOK_SECRET = "whsec_billing_test";

/** A webhook delivery Stripe would send: signed body, JSON content type. */
export async function signedEvent(
  event: { id: string; type: string; object: Json; account?: string },
  now: Date,
  secret = WEBHOOK_SECRET,
): Promise<Request> {
  return signedBody(
    JSON.stringify({
      id: event.id,
      object: "event",
      type: event.type,
      ...(event.account === undefined ? {} : { account: event.account }),
      data: { object: event.object },
    }),
    now,
    secret,
  );
}

/** A delivery with exactly this body, signed as Stripe would sign it. */
export async function signedBody(
  body: string,
  now: Date,
  secret = WEBHOOK_SECRET,
): Promise<Request> {
  const t = Math.floor(now.getTime() / 1000);
  return new Request("https://api.example.test/billing/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`,
    },
    body,
  });
}
