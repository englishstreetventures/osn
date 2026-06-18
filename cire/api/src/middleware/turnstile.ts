import type { TurnstileVerifier } from "@shared/turnstile";

import { metricTurnstileRejected, type TurnstileEndpoint } from "../metrics";

/**
 * Turnstile bot-protection gate for the public guest surfaces (claim + rsvp).
 *
 * KEY-OPTIONAL + fail-closed, matching the project's other graceful-degradation
 * integrations (maps-embed key, account-link ARC). The verifier is built once
 * per isolate in `index.ts` from the `TURNSTILE_SECRET_KEY` wrangler secret and
 * passed into `createApp`:
 *
 *  - `verifier === null` (secret unset) ⇒ {@link turnstileGate} resolves to
 *    `null` immediately — the gate is a no-op and the guest flow runs exactly as
 *    it did before Turnstile existed. Safe to ship before the widget is created.
 *  - configured ⇒ the body's `turnstileToken` is siteverified with the caller's
 *    `cf-connecting-ip` as `remoteip`. A missing/invalid/duplicate token (or an
 *    unreachable siteverify) fails CLOSED → returns `{ status, error }` for the
 *    caller to short-circuit on. The secret is never logged or echoed.
 *
 * Returns `null` to proceed, or a `{ status, error }` rejection the route turns
 * into a response.
 */
export async function turnstileGate(
  verifier: TurnstileVerifier | null,
  endpoint: TurnstileEndpoint,
  rawBody: unknown,
  headers: Headers,
): Promise<{ status: number; error: string } | null> {
  if (!verifier) return null;

  // The widget token rides in the JSON body alongside the form fields. Read it
  // defensively — a non-object / missing field fails closed via the verifier's
  // own missing-token branch.
  const token =
    rawBody && typeof rawBody === "object" && "turnstileToken" in rawBody
      ? (rawBody as { turnstileToken?: unknown }).turnstileToken
      : undefined;
  const tokenStr = typeof token === "string" ? token : undefined;

  const remoteip = headers.get("cf-connecting-ip");
  const result = await verifier.verify(tokenStr, remoteip);
  if (!result.ok) {
    metricTurnstileRejected(endpoint);
    return { status: 403, error: "Verification failed. Please try again." };
  }
  return null;
}
