/**
 * The billing webhook as an Elysia route.
 *
 * `parse: () => ({})` keeps Elysia from reading the body: the signature is over
 * the exact bytes Stripe sent, so the handler must receive the request unread,
 * whatever its content type. Exempt the path from any CSRF origin guard;
 * Stripe sends no `Origin`.
 */

import type { Effect } from "effect";
import { Elysia } from "elysia";

import type { WebhookResult } from "../billing/types";

export interface WebhookRouteOptions {
  readonly path: string;
  /** The consumer's runtime, so the handler logs through its redacting logger. */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
}

export const billingWebhookRoute = (
  billing: { handleWebhook(request: Request): Effect.Effect<WebhookResult> },
  options: WebhookRouteOptions,
) =>
  new Elysia().post(
    options.path,
    async ({ request, set }) => {
      const result = await options.run(billing.handleWebhook(request));
      set.status = result.status;
      return result.body;
    },
    { parse: () => ({}) },
  );
