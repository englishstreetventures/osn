/**
 * Cloudflare Turnstile server-side siteverify helper — key-optional, fail-closed.
 *
 * Shared by every backend that gates a form behind a Turnstile widget
 * (`@osn/api` register + passkey login, `@cire/api` guest claim + RSVP). The
 * design mirrors the project's other key-optional integrations (the maps-embed
 * key and `OSN_EMAIL_OPTIONAL`):
 *
 *  - **Secret UNSET** → `createTurnstileVerifier(undefined)` returns `null`. The
 *    caller treats a `null` verifier as "Turnstile not configured": no token is
 *    expected, no siteverify call is made, the flow proceeds exactly as it did
 *    before Turnstile existed. This keeps the PR safe to merge BEFORE the widget
 *    is created.
 *  - **Secret SET** → returns a verifier whose `verify(token, remoteip)` calls
 *    Cloudflare's siteverify endpoint and **fails closed**: a missing, empty,
 *    invalid, expired, already-redeemed (single-use), or unreachable token all
 *    resolve to `{ ok: false }`. The caller MUST reject the request on `ok:
 *    false` — there is no path where a configured secret silently lets a
 *    request through without a valid token.
 *
 * The secret is never logged, never returned to the caller, and never sent
 * anywhere except Cloudflare's siteverify endpoint over POST. Outbound goes
 * through `instrumentedFetch` so the call shows up on the trace tree (the token
 * + secret are NOT annotated onto the span — only the boolean outcome + error
 * codes, which carry no PII).
 */

import { instrumentedFetch } from "@shared/observability/fetch";

/** Cloudflare's managed siteverify endpoint. */
export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Minimal fetch shape this module needs. Both the global `fetch` and
 * `@shared/observability`'s `instrumentedFetch` satisfy it; using a structural
 * type (rather than `typeof fetch`) avoids coupling to lib-dom's `preconnect`
 * member, which the instrumented wrapper doesn't expose.
 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Result of a single siteverify attempt. `ok` is the only field a gate needs. */
export interface TurnstileVerifyResult {
  /** True only when Cloudflare confirmed the token is valid + unredeemed. */
  ok: boolean;
  /**
   * Cloudflare's machine-readable error codes (e.g. `invalid-input-response`,
   * `timeout-or-duplicate`, `missing-input-response`). Safe to log — they carry
   * no token, no secret, no PII. Empty on success.
   */
  errorCodes: readonly string[];
}

export interface TurnstileVerifier {
  /**
   * Verify a client-supplied Turnstile token. Fail-closed: a missing/blank
   * token short-circuits to `{ ok: false }` without a network call; a network
   * or parse error also resolves to `{ ok: false }` (never throws).
   *
   * @param token    the `cf-turnstile-response` value from the widget
   * @param remoteip the caller's IP (`cf-connecting-ip`), optional. Passed to
   *                 siteverify when present for Cloudflare's own risk scoring.
   */
  verify(
    token: string | undefined | null,
    remoteip?: string | null,
  ): Promise<TurnstileVerifyResult>;
}

/** Shape of Cloudflare's siteverify JSON response (subset we read). */
interface SiteverifyResponse {
  success?: boolean;
  "error-codes"?: string[];
}

/**
 * Raw siteverify call. Exported for tests + advanced callers; most code should
 * use {@link createTurnstileVerifier} so the key-optional branch is handled.
 *
 * `fetchImpl` is injectable purely for unit tests — production always uses the
 * instrumented fetch. Never throws: any failure maps to `{ ok: false }`.
 */
export async function siteverify(
  secret: string,
  token: string,
  remoteip: string | null | undefined,
  fetchImpl: FetchLike = instrumentedFetch,
): Promise<TurnstileVerifyResult> {
  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  // remoteip is optional per Cloudflare; only send a real value.
  if (remoteip) form.set("remoteip", remoteip);

  try {
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      // S-L2: bound the call so a hung siteverify can't tie up the isolate. An
      // abort lands in the catch below → fail-closed `{ ok: false }`, so a slow
      // Cloudflare degrades to "reject" rather than "hang then reject".
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      // A non-2xx from siteverify is an infrastructure failure, not a verdict —
      // fail closed.
      return { ok: false, errorCodes: [`http-${res.status}`] };
    }
    const data = (await res.json()) as SiteverifyResponse;
    return {
      ok: data.success === true,
      errorCodes: data["error-codes"] ?? [],
    };
  } catch {
    // Network error, abort, malformed JSON — fail closed. We deliberately do
    // NOT surface the thrown value (it could embed the request body, which
    // contains the secret) to logs here; the caller logs the boolean outcome.
    return { ok: false, errorCodes: ["siteverify-unreachable"] };
  }
}

/**
 * Build a verifier from an optional secret.
 *
 *  - `secret` unset / empty / whitespace ⇒ returns `null` (Turnstile not
 *    configured — caller skips the gate entirely).
 *  - `secret` present ⇒ returns a fail-closed {@link TurnstileVerifier}.
 *
 * @param secret   the `TURNSTILE_SECRET_KEY` wrangler secret, or undefined.
 * @param fetchImpl test seam; defaults to the instrumented fetch.
 */
export function createTurnstileVerifier(
  secret: string | undefined | null,
  fetchImpl: FetchLike = instrumentedFetch,
): TurnstileVerifier | null {
  const trimmed = secret?.trim();
  if (!trimmed) return null;

  return {
    async verify(token, remoteip) {
      // Fail-closed on a missing token without spending a network round-trip.
      if (!token || token.trim() === "") {
        return { ok: false, errorCodes: ["missing-input-response"] };
      }
      return siteverify(trimmed, token, remoteip ?? null, fetchImpl);
    },
  };
}
