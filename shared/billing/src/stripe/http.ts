/**
 * Stripe's REST API over `fetch`, as much of it as a Worker needs.
 *
 * No `stripe` package: it is built around Node's http stack, and a Worker ships
 * inside a compressed size budget it already shares with Elysia, Drizzle and
 * Effect. The API is form-encoded requests and JSON replies; `fetch` is the
 * whole client.
 *
 * What never leaves this module in an error: the secret key, and Stripe's raw
 * error bodies, which can echo request parameters back. {@link StripeError}
 * carries a fixed reason, the HTTP status and Stripe's machine-readable `code`.
 */

import { Data, Effect } from "effect";

/** Stripe's live API origin. Overridable so tests never need the network. */
export const STRIPE_API_BASE = "https://api.stripe.com";

/** The API version this code is written against, pinned per request. */
export const STRIPE_API_VERSION = "2025-03-31.basil";

/**
 * How long one Stripe call may take, response body included, before it is a
 * failure. Far past Stripe's own p99 and far short of anything a person waits
 * through; without it a hung connection holds a Worker request open.
 */
export const STRIPE_CALL_TIMEOUT_MS = 10_000;

/** A Stripe call that did not do what it was asked. */
export class StripeError extends Data.TaggedError("StripeError")<{
  /** `unreachable`, `timeout`, `unreadable`, `rejected`, or an unexpected-payload reason. */
  readonly reason: string;
  /** HTTP status, when there was a response at all. */
  readonly status?: number;
  /** Stripe's machine-readable `error.code` (or `type`), never its message. */
  readonly code?: string;
}> {}

/**
 * What a Stripe request may hold: scalars, nested groups and lists of them.
 * Named rather than an open dictionary of `unknown`, so a caller cannot hand
 * the encoder a value it would stringify as `[object Object]`.
 */
export type StripeFormValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | StripeFormParams
  | ReadonlyArray<StripeFormValue>;
export interface StripeFormParams {
  readonly [key: string]: StripeFormValue;
}

/**
 * Form-encode a parameter tree the way Stripe reads it: nested objects become
 * `a[b][c]`, arrays `a[0]` (the indexed form stripe-node itself sends).
 *
 * `null` and `undefined` are dropped rather than sent empty: to Stripe an empty
 * string is a value ("unset this field").
 */
export function encodeStripeForm(params: StripeFormParams, prefix = ""): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    const path = prefix === "" ? key : `${prefix}[${key}]`;
    if (typeof value === "object") {
      // An array is an object whose keys are its indices, so it encodes as
      // `path[0]`, `path[1]`.
      const nested = encodeStripeForm(value as StripeFormParams, path);
      if (nested !== "") parts.push(nested);
      continue;
    }
    parts.push(`${encodeURIComponent(path)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface StripeRequestConfig {
  readonly secretKey: string;
  /** Base origin. Tests point this at a stub; production leaves it alone. */
  readonly apiBase?: string;
  /** Defaults to the global `fetch`, read on each call. */
  readonly fetchImpl?: FetchFn;
  /** Defaults to {@link STRIPE_CALL_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

export interface StripeRequestOptions {
  /** Makes a retried POST return the FIRST result. Stripe keeps keys for 24 h. */
  readonly idempotencyKey?: string;
  /**
   * Act as a connected account (`Stripe-Account`), for a consumer's own
   * Connect calls through this helper. The billing core never sets it.
   */
  readonly stripeAccount?: string;
}

export type StripeRequest = (
  method: "GET" | "POST",
  path: string,
  params?: StripeFormParams,
  options?: StripeRequestOptions,
) => Effect.Effect<unknown, StripeError>;

/**
 * One `fetch` per call, no retries: Stripe's idempotency makes a retry the
 * caller's decision rather than a hidden one.
 *
 * GET parameters go in the query string; POST parameters in a form body.
 */
export function createStripeRequest(config: StripeRequestConfig): StripeRequest {
  const base = config.apiBase ?? STRIPE_API_BASE;
  const doFetch: FetchFn = config.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = config.timeoutMs ?? STRIPE_CALL_TIMEOUT_MS;

  return (method, path, params = {}, options = {}) =>
    Effect.gen(function* () {
      const encoded = encodeStripeForm(params);
      const url =
        method === "GET" && encoded !== "" ? `${base}${path}?${encoded}` : `${base}${path}`;
      const headers = new Headers({
        authorization: `Bearer ${config.secretKey}`,
        "stripe-version": STRIPE_API_VERSION,
      });
      const body = method === "POST" ? encoded : undefined;
      if (body !== undefined) headers.set("content-type", "application/x-www-form-urlencoded");
      if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
      if (options.stripeAccount) headers.set("stripe-account", options.stripeAccount);

      // The fetch AND the body read in one effect under one timeout: a response
      // whose headers arrive and whose body then stalls is as hung as one that
      // never answers. The signal aborts the connection when the timeout fires.
      const response = yield* Effect.tryPromise({
        try: async (signal) => {
          const res = await doFetch(url, { method, headers, body, signal });
          return { ok: res.ok, status: res.status, text: await res.text() };
        },
        catch: () => new StripeError({ reason: "unreachable" }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new StripeError({ reason: "timeout" })),
        }),
      );

      const payload = yield* Effect.try({
        try: () => JSON.parse(response.text) as unknown,
        // Something in front of Stripe answered: a proxy page, a gateway.
        catch: () => new StripeError({ reason: "unreadable", status: response.status }),
      });

      if (!response.ok) {
        const error = (payload as { error?: { code?: unknown; type?: unknown } } | null)?.error;
        const code =
          typeof error?.code === "string"
            ? error.code
            : typeof error?.type === "string"
              ? error.type
              : undefined;
        return yield* Effect.fail(
          new StripeError({ reason: "rejected", status: response.status, code }),
        );
      }
      return payload;
    });
}
