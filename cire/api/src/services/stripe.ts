/**
 * STRIPE CONNECT, as much of it as cire touches.
 *
 * WHAT THIS IS FOR. A guest gives money to a couple. The couple are the merchant
 * of record — direct charges on their own connected account — so the money goes
 * from the guest's card to the couple's bank and cire never holds it. That is
 * the whole reason the integration is Connect rather than a platform checkout:
 * holding gift funds, even in transit, is money transmission, and this product
 * is not going anywhere near it.
 *
 * WHY THERE IS NO `stripe` PACKAGE HERE. Three endpoints and one signature check
 * do not justify the official SDK on a Worker: it is built around Node's http
 * stack, and cire-api ships inside a 1MB compressed Worker budget it already
 * shares with Elysia, Drizzle and Effect (see `wiki/runbooks/free-tier-limits`).
 * The REST API is form-encoded POSTs and JSON replies; `fetch` is the whole
 * client. If this file ever grows past the handful of calls the gift flow needs,
 * that trade is worth re-running — it is a trade, not a principle.
 *
 * KEY-OPTIONAL, AND FAIL-CLOSED. `createStripeClientFromEnv` returns `null`
 * without a secret key, exactly as `@shared/turnstile` does: a deployment with
 * no Stripe configuration exposes no payment surface at all rather than a broken
 * one. What it must never do is the other failure — a missing key silently
 * meaning "allowed".
 *
 * WHAT NEVER REACHES A LOG. The secret key, obviously; but also Stripe's raw
 * error bodies, which can echo request parameters back. `StripeError` carries a
 * fixed reason, the HTTP status and Stripe's own machine-readable `code`, and
 * nothing else.
 */

import { Context, Data, Effect } from "effect";

/** Stripe's live API origin. Overridable so tests never need the network. */
export const STRIPE_API_BASE = "https://api.stripe.com";

/** The API version this code is written against, pinned per request. */
export const STRIPE_API_VERSION = "2025-03-31.basil";

/**
 * How far a webhook's timestamp may be from ours before it is refused, in
 * seconds. Stripe's own default, and the reason the check is not just an HMAC:
 * a valid signature is valid forever, so without a window a captured delivery
 * can be replayed at any point in the future.
 */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** How long any one Stripe call may take before it is a failure. */
export const STRIPE_CALL_TIMEOUT = "10 seconds";

/** A Stripe call that did not do what it was asked. */
export class StripeError extends Data.TaggedError("StripeError")<{
  readonly reason: string;
  /** HTTP status, when there was a response at all. */
  readonly status?: number;
  /** Stripe's machine-readable `error.code`, never its message. */
  readonly code?: string;
}> {}

/** A webhook body that did not come from Stripe, or came too long ago. */
export class StripeSignatureError extends Data.TaggedError("StripeSignatureError")<{
  readonly reason: "malformed" | "no-match" | "too-old" | "unconfigured";
}> {}

/** The subset of a connected account this product reads. */
export interface StripeAccount {
  id: string;
  /** Whether the account can take a payment TODAY — the only gate that matters. */
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  /** Onboarding is finished and Stripe wants nothing more right now. */
  detailsSubmitted: boolean;
  /**
   * The currency Stripe settles this account's charges in, upper-case ISO.
   *
   * Null when Stripe has not said — an account can exist before it has one.
   * Under direct charges the connected account is the merchant of record, so a
   * Checkout Session priced in anything else is either converted on Stripe's
   * terms or refused, which is why the settings route compares this against the
   * wedding's own currency before it lets cash gifts be turned on.
   */
  defaultCurrency: string | null;
}

/** A one-time hosted onboarding URL. Short-lived by design — minutes, not days. */
export interface StripeAccountLink {
  url: string;
  /** Unix seconds. Past it, the link 404s and a fresh one must be minted. */
  expiresAt: number;
}

export interface CreateAccountInput {
  /** Two-letter country of the couple's bank account. */
  country: string;
  email?: string | null;
  /** Written to the account's metadata so a webhook can be traced back. */
  weddingId: string;
}

export interface CreateAccountLinkInput {
  accountId: string;
  /** Where Stripe sends a guest whose link expired mid-flow. */
  refreshUrl: string;
  /** Where Stripe sends them when they finish — or abandon — onboarding. */
  returnUrl: string;
}

export interface CreateCheckoutSessionInput {
  /** The couple's connected account. The charge is DIRECT — see the header. */
  accountId: string;
  amountMinor: number;
  /** The wedding's primary currency, lower-cased for Stripe. */
  currency: string;
  /** What the guest sees on the Stripe page and on their statement line. */
  productName: string;
  successUrl: string;
  cancelUrl: string;
  /**
   * Carried through the payment and handed back by the webhook. Small and
   * bounded: Stripe caps metadata at 50 keys and 500 characters per value, and
   * anything longer is rejected — so the caller trims before it gets here.
   */
  metadata: StripeFormParams;
  /**
   * Our own id for the gift row, echoed back verbatim on every webhook event.
   * Stripe treats `client_reference_id` as an opaque string it never inspects,
   * which makes it the one field the connected account cannot rewrite the way
   * it can rewrite metadata — so the settle path reads this first.
   */
  clientReferenceId: string;
  /**
   * Makes a retried create return the FIRST session rather than a second one.
   * The caller owns it because only the caller knows what "the same attempt"
   * means — here, one guest's one press.
   */
  idempotencyKey: string;
}

/** A hosted Checkout page, waiting for a card. */
export interface StripeCheckoutSession {
  id: string;
  url: string;
}

export interface RetrieveCheckoutSessionInput {
  /** The couple's connected account the session was created on. */
  accountId: string;
  sessionId: string;
}

/**
 * A PLATFORM Checkout Session — cire as the merchant of record, for an upgrade
 * purchase. The opposite of {@link CreateCheckoutSessionInput}, which is a
 * DIRECT charge on a couple's connected account for a gift, and the reason this
 * is a separate input rather than that one widened: it carries no `accountId`
 * (so no `Stripe-Account` header, so the charge is the platform's), and it
 * names a Price the deployment configured rather than pricing a line inline.
 */
export interface CreatePlatformCheckoutSessionInput {
  /** A `price_...` from configuration. No money amount is held in this repo. */
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  /**
   * Our own purchase id, echoed back untouched on every webhook event. Stripe
   * treats it as opaque, and — unlike `metadata` — nothing on a connected
   * account's side can rewrite it, so the settle path reads this first.
   */
  clientReferenceId: string;
  metadata: StripeFormParams;
  /** Makes a retried create return the FIRST session rather than a second one. */
  idempotencyKey: string;
}

/**
 * What a Checkout Session is doing now, as this product needs to read it.
 *
 * `complete` and `expired` are deliberately kept apart, which is why the
 * platform probe does not reuse {@link StripeClient.retrieveCheckoutSession} —
 * that one collapses every non-`open` state to `null`. For a gift that is
 * right: a second contribution is a legitimate second gift, so "not open" just
 * means "mint a fresh one". For an upgrade the two states need opposite
 * answers. A `complete` session whose webhook has not landed yet means the
 * money has very likely moved, so the answer is "wait", not "pay again" —
 * treating it as dead mints a second payment page and charges twice for one
 * entitlement. Only `expired` is safe to replace.
 */
export type PlatformSessionState =
  | { status: "open"; id: string; url: string }
  | { status: "complete" }
  | { status: "expired" };

/** Enough of a Price to show it. The amount lives at Stripe, never here. */
export interface StripePrice {
  unitAmountMinor: number;
  /** Upper-case ISO, as every currency is at this product's boundary. */
  currency: string;
}

/** Everything this product asks Stripe to do. Injected, so tests need no network. */
export interface StripeClient {
  createAccount(input: CreateAccountInput): Effect.Effect<StripeAccount, StripeError>;
  createAccountLink(input: CreateAccountLinkInput): Effect.Effect<StripeAccountLink, StripeError>;
  retrieveAccount(accountId: string): Effect.Effect<StripeAccount, StripeError>;
  createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Effect.Effect<StripeCheckoutSession, StripeError>;
  /**
   * Read a session back. `null` means "there is nothing here to send a guest
   * to" — expired, already paid, or open but with no URL left — which is a
   * normal answer and not an error: the caller mints a fresh session instead.
   */
  retrieveCheckoutSession(
    input: RetrieveCheckoutSessionInput,
  ): Effect.Effect<StripeCheckoutSession | null, StripeError>;
  createPlatformCheckoutSession(
    input: CreatePlatformCheckoutSessionInput,
  ): Effect.Effect<StripeCheckoutSession, StripeError>;
  /**
   * Read a platform session back as a STATE, not a nullable URL — see
   * {@link PlatformSessionState} for why the distinction is load-bearing here
   * and not for gifts.
   */
  retrievePlatformCheckoutSession(
    sessionId: string,
  ): Effect.Effect<PlatformSessionState, StripeError>;
  /** The configured price of an upgrade, read from Stripe rather than stored. */
  retrievePrice(priceId: string): Effect.Effect<StripePrice, StripeError>;
}

export class StripeService extends Context.Service<StripeService, StripeClient>()(
  "StripeService",
) {}

export interface StripeConfig {
  secretKey: string;
  /** Base origin. Tests point this at a stub; production leaves it alone. */
  apiBase?: string;
  /** Injected `fetch`, for the same reason. */
  fetchImpl?: typeof fetch;
}

/**
 * What a Stripe request body may hold: scalars, and nested groups of them.
 * Named rather than an open dictionary of `unknown`, so a caller cannot hand
 * this a value the encoder would silently stringify as `[object Object]`.
 */
export type StripeFormValue = string | number | boolean | null | undefined | StripeFormParams;
export interface StripeFormParams {
  readonly [key: string]: StripeFormValue;
}

/**
 * Form-encode a parameter tree the way Stripe reads it: nested objects become
 * `a[b][c]`, arrays `a[0]`. Written out rather than reached for from a library
 * because it is eight lines and because the encoding IS the API contract —
 * `capabilities[card_payments][requested]` is not a string we want assembled by
 * something whose rules we would then have to check.
 *
 * `null` and `undefined` are DROPPED rather than sent as empty strings: to
 * Stripe an empty string is a value ("unset this field"), which is a different
 * request from not mentioning the field at all.
 */
export function encodeStripeForm(params: StripeFormParams, prefix = ""): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    const path = prefix === "" ? key : `${prefix}[${key}]`;
    if (typeof value === "object") {
      const nested = encodeStripeForm(value, path);
      if (nested !== "") parts.push(nested);
      continue;
    }
    parts.push(`${encodeURIComponent(path)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

/** Read the fields this product needs off a Stripe account payload. */
function toAccount(raw: unknown): StripeAccount | null {
  const account = raw as {
    id?: unknown;
    charges_enabled?: unknown;
    payouts_enabled?: unknown;
    details_submitted?: unknown;
    default_currency?: unknown;
  };
  if (typeof account?.id !== "string") return null;
  return {
    id: account.id,
    chargesEnabled: account.charges_enabled === true,
    payoutsEnabled: account.payouts_enabled === true,
    detailsSubmitted: account.details_submitted === true,
    // Stripe sends this lower-case; every currency in this product is compared
    // and stored upper-case, so it is normalised once, here, at the boundary.
    defaultCurrency:
      typeof account.default_currency === "string" && account.default_currency.length > 0
        ? account.default_currency.toUpperCase()
        : null,
  };
}

/**
 * The live client. One `fetch` per call, no retries: every call here happens
 * inside a request a person is waiting on, and Stripe's own idempotency (below)
 * makes a retry the CALLER's decision rather than a hidden one.
 */
export function createStripeClient(config: StripeConfig): StripeClient {
  const base = config.apiBase ?? STRIPE_API_BASE;
  const doFetch = config.fetchImpl ?? fetch;

  function request(
    method: "GET" | "POST",
    path: string,
    params: StripeFormParams = {},
    idempotencyKey?: string,
    /**
     * Act AS a connected account (`Stripe-Account`), which is what makes a
     * charge direct: the money is the couple's from the moment it is taken, and
     * the platform never appears in the balance it lands in.
     */
    stripeAccount?: string,
  ): Effect.Effect<unknown, StripeError> {
    return Effect.gen(function* () {
      // A `Headers` rather than an object literal: the set is conditional
      // (content-type only with a body, idempotency-key only on the calls that
      // must not repeat), and an optional-property record is not a header map.
      const headers = new Headers({
        authorization: `Bearer ${config.secretKey}`,
        "stripe-version": STRIPE_API_VERSION,
      });
      const body = method === "POST" ? encodeStripeForm(params) : undefined;
      if (body !== undefined) headers.set("content-type", "application/x-www-form-urlencoded");
      // An idempotency key makes a retried POST return the FIRST result rather
      // than creating a second connected account. Stripe keys them for 24h.
      if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
      if (stripeAccount) headers.set("stripe-account", stripeAccount);

      const res = yield* Effect.tryPromise({
        try: () => doFetch(`${base}${path}`, { method, headers, body }),
        catch: () => new StripeError({ reason: "unreachable" }),
      }).pipe(
        // A hung connection would otherwise hold a Worker request open for the
        // full subrequest limit, which turns one slow Stripe into a queue of
        // stuck isolates. Ten seconds is far past Stripe's own p99 and far
        // short of anything a person waits through.
        Effect.timeoutOrElse({
          duration: STRIPE_CALL_TIMEOUT,
          orElse: () => Effect.fail(new StripeError({ reason: "timeout" })),
        }),
      );

      const payload: unknown = yield* Effect.tryPromise({
        try: () => res.json(),
        // A non-JSON body from Stripe means something in front of it answered —
        // a proxy error page, a gateway. Not a Stripe error, but not a success.
        catch: () => new StripeError({ reason: "unreadable", status: res.status }),
      });

      if (!res.ok) {
        const error = (payload as { error?: { code?: unknown; type?: unknown } })?.error;
        return yield* Effect.fail(
          new StripeError({
            reason: "rejected",
            status: res.status,
            // The CODE only. Stripe's `message` is written for a developer's
            // console and can quote back the parameters of the request.
            code:
              typeof error?.code === "string"
                ? error.code
                : typeof error?.type === "string"
                  ? error.type
                  : undefined,
          }),
        );
      }
      return payload;
    });
  }

  return {
    createAccount(input) {
      return request(
        "POST",
        "/v1/accounts",
        {
          type: "express",
          country: input.country,
          email: input.email ?? undefined,
          // Card payments and transfers are what a gift needs; asking for
          // nothing else keeps the couple's onboarding as short as Stripe will
          // allow, which is the difference between a form they finish and one
          // they abandon.
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          // The couple pay the Stripe fee on their own gifts, and see the
          // charge on their own statement — they are the merchant here.
          metadata: { weddingId: input.weddingId },
        },
        // Keyed on the wedding: a double-submitted "connect" button cannot mint
        // two accounts for one couple, which is the failure that would need a
        // human at Stripe to unpick.
        `cire-account-${input.weddingId}`,
      ).pipe(
        Effect.flatMap((payload) => {
          const account = toAccount(payload);
          return account
            ? Effect.succeed(account)
            : Effect.fail(new StripeError({ reason: "unexpected account payload" }));
        }),
      );
    },

    createAccountLink(input) {
      return request("POST", "/v1/account_links", {
        account: input.accountId,
        refresh_url: input.refreshUrl,
        return_url: input.returnUrl,
        type: "account_onboarding",
      }).pipe(
        Effect.flatMap((payload) => {
          const link = payload as { url?: unknown; expires_at?: unknown };
          return typeof link?.url === "string" && typeof link.expires_at === "number"
            ? Effect.succeed({ url: link.url, expiresAt: link.expires_at })
            : Effect.fail(new StripeError({ reason: "unexpected account link payload" }));
        }),
      );
    },

    createCheckoutSession(input) {
      return request(
        "POST",
        "/v1/checkout/sessions",
        {
          mode: "payment",
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          // One line item, priced inline: there is no catalogue behind a gift,
          // and a `price_data` avoids creating a Product per contribution on
          // the couple's own account.
          line_items: {
            0: {
              quantity: 1,
              price_data: {
                currency: input.currency.toLowerCase(),
                unit_amount: input.amountMinor,
                product_data: { name: input.productName },
              },
            },
          },
          client_reference_id: input.clientReferenceId,
          metadata: input.metadata,
          // The same metadata on the PaymentIntent, so a couple looking at the
          // charge in their own Stripe dashboard can see which wedding and
          // which gift it belongs to without the session in front of them.
          payment_intent_data: { metadata: input.metadata },
        },
        input.idempotencyKey,
        input.accountId,
      ).pipe(
        Effect.flatMap((payload) => {
          const session = payload as { id?: unknown; url?: unknown };
          return typeof session?.id === "string" && typeof session.url === "string"
            ? Effect.succeed({ id: session.id, url: session.url })
            : Effect.fail(new StripeError({ reason: "unexpected checkout session payload" }));
        }),
      );
    },

    retrieveCheckoutSession(input) {
      return request(
        "GET",
        `/v1/checkout/sessions/${encodeURIComponent(input.sessionId)}`,
        {},
        undefined,
        input.accountId,
      ).pipe(
        Effect.map((payload) => {
          const session = payload as { id?: unknown; url?: unknown; status?: unknown };
          // Only an OPEN session is somewhere a guest can still pay. A complete
          // or expired one is history, and its `url` — if Stripe even still
          // returns one — leads to a page that cannot take a card.
          if (session?.status !== "open") return null;
          return typeof session.id === "string" && typeof session.url === "string"
            ? { id: session.id, url: session.url }
            : null;
        }),
      );
    },

    createPlatformCheckoutSession(input) {
      return request(
        "POST",
        "/v1/checkout/sessions",
        {
          mode: "payment",
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          // A configured Price, not an inline `price_data`: the amount lives at
          // Stripe, so changing what an upgrade costs is a dashboard change and
          // a var, never a deploy of new source.
          line_items: { 0: { quantity: 1, price: input.priceId } },
          // Card only. A delayed debit (BECS here, SEPA in Europe) completes
          // the session in seconds and settles days later, which would mean a
          // `completed` event whose money has not moved — an entitlement this
          // product would have to grant provisionally and claw back. Nothing
          // about an upgrade needs that, so the option is closed rather than
          // handled. The settle path still refuses an unpaid session.
          payment_method_types: { 0: "card" },
          client_reference_id: input.clientReferenceId,
          metadata: input.metadata,
        },
        input.idempotencyKey,
        // NO `stripeAccount`. Its absence is what makes this the platform's
        // charge rather than a couple's.
      ).pipe(
        Effect.flatMap((payload) => {
          const session = payload as { id?: unknown; url?: unknown };
          return typeof session?.id === "string" && typeof session.url === "string"
            ? Effect.succeed({ id: session.id, url: session.url })
            : Effect.fail(new StripeError({ reason: "unexpected checkout session payload" }));
        }),
      );
    },

    retrievePlatformCheckoutSession(sessionId) {
      return request("GET", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`).pipe(
        Effect.map((payload): PlatformSessionState => {
          const session = payload as { id?: unknown; url?: unknown; status?: unknown };
          if (session?.status === "open") {
            return typeof session.id === "string" && typeof session.url === "string"
              ? { status: "open", id: session.id, url: session.url }
              : // Open but with no URL left is somewhere nobody can pay, which
                // is the same practical answer as an expired session.
                { status: "expired" };
          }
          // Anything Stripe does not call `open` or `complete` is over and
          // replaceable. Defaulting the UNKNOWN case to `expired` rather than
          // `complete` is deliberate and is the safe direction only because the
          // caller checks `has()` first: the cost of a wrong `expired` is a
          // second session for an entitlement the wedding does not hold, while
          // a wrong `complete` would park a paying customer forever.
          return session?.status === "complete" ? { status: "complete" } : { status: "expired" };
        }),
      );
    },

    retrievePrice(priceId) {
      return request("GET", `/v1/prices/${encodeURIComponent(priceId)}`).pipe(
        Effect.flatMap((payload) => {
          const price = payload as { unit_amount?: unknown; currency?: unknown };
          // `unit_amount` is null on a tiered or metered price, which is not
          // something an upgrade can be priced with — a misconfigured Price id
          // is a failure, not a zero.
          return typeof price?.unit_amount === "number" && typeof price.currency === "string"
            ? Effect.succeed({
                unitAmountMinor: price.unit_amount,
                currency: price.currency.toUpperCase(),
              })
            : Effect.fail(new StripeError({ reason: "unexpected price payload" }));
        }),
      );
    },

    retrieveAccount(accountId) {
      return request("GET", `/v1/accounts/${encodeURIComponent(accountId)}`).pipe(
        Effect.flatMap((payload) => {
          const account = toAccount(payload);
          return account
            ? Effect.succeed(account)
            : Effect.fail(new StripeError({ reason: "unexpected account payload" }));
        }),
      );
    },
  };
}

/**
 * Build a client from the Worker's environment, or `null` when Stripe is not
 * configured. `null` is a first-class answer, not a failure: it is what every
 * deployment without a Stripe account is, including local development, and the
 * routes read it as "this surface does not exist here".
 */
export function createStripeClientFromEnv(env: {
  STRIPE_SECRET_KEY?: string;
}): StripeClient | null {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  return createStripeClient({ secretKey: key });
}

/** Parsed `Stripe-Signature`: the timestamp it was signed at, and the v1 digests. */
interface ParsedSignatureHeader {
  timestamp: number;
  signatures: string[];
}

function parseSignatureHeader(header: string): ParsedSignatureHeader | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key?.trim() === "t" && value) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) timestamp = parsed;
    }
    // v0 is the test-mode scheme and is deliberately ignored: only v1 is
    // computed over the payload we are about to trust.
    if (key?.trim() === "v1" && value) signatures.push(value.trim());
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** Length-independent, value-independent comparison of two hex digests. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify a webhook delivery, and return its parsed body.
 *
 * THE RAW BODY IS THE SUBJECT. The signature is over the exact bytes Stripe
 * sent, so this takes the request's TEXT and parses it afterwards — a body that
 * has been through `JSON.parse` and back has already lost the property being
 * checked (key order, whitespace, number formatting), and the check would fail
 * for reasons that look like an attack.
 *
 * THREE THINGS ARE CHECKED, and all three matter:
 *  - the header parses (a missing `t` or `v1` is not "no match", it is malformed);
 *  - the digest matches, compared without a length- or value-dependent early
 *    exit;
 *  - the timestamp is inside the tolerance window. A valid signature is valid
 *    forever, so without this a captured delivery can be replayed at any point
 *    in the future — against a handler that grants entitlements or records
 *    money, which is exactly the handler this exists for.
 */
export function verifyStripeWebhook(input: {
  payload: string;
  signatureHeader: string | null;
  secret: string | null;
  /** Unix seconds. Injected so the tolerance window is testable. */
  now: number;
  toleranceSeconds?: number;
}): Effect.Effect<unknown, StripeSignatureError> {
  return Effect.gen(function* () {
    if (!input.secret) {
      // No signing secret configured ⇒ nothing can be verified, so nothing is
      // accepted. The alternative — trusting the body — is how a webhook
      // endpoint becomes an unauthenticated write API.
      return yield* Effect.fail(new StripeSignatureError({ reason: "unconfigured" }));
    }
    if (!input.signatureHeader) {
      return yield* Effect.fail(new StripeSignatureError({ reason: "malformed" }));
    }
    const parsed = parseSignatureHeader(input.signatureHeader);
    if (!parsed) return yield* Effect.fail(new StripeSignatureError({ reason: "malformed" }));

    const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
    if (Math.abs(input.now - parsed.timestamp) > tolerance) {
      return yield* Effect.fail(new StripeSignatureError({ reason: "too-old" }));
    }

    const key = yield* Effect.promise(() =>
      crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(input.secret as string),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    );
    const digest = yield* Effect.promise(() =>
      crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${parsed.timestamp}.${input.payload}`),
      ),
    );
    const expected = toHex(digest);
    // Stripe sends several v1 digests while a secret is being rotated; any one
    // matching is a valid delivery. Every candidate is compared — no early
    // return on the first match — so the loop's timing says nothing about which.
    let matched = false;
    for (const candidate of parsed.signatures) {
      if (timingSafeEqualHex(candidate, expected)) matched = true;
    }
    if (!matched) return yield* Effect.fail(new StripeSignatureError({ reason: "no-match" }));

    return yield* Effect.try({
      try: () => JSON.parse(input.payload) as unknown,
      // A signed body that is not JSON cannot happen from Stripe; treating it
      // as malformed rather than throwing keeps the route's failure set closed.
      catch: () => new StripeSignatureError({ reason: "malformed" }),
    });
  });
}
