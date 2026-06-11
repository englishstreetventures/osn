import { instrumentedFetch } from "@shared/observability";
import type { StepUpPurpose } from "@shared/observability/metrics";
import { Data, Effect } from "effect";

import { arcAuthHeader } from "./outbound-arc";

/**
 * Pulse → OSN bridge for the leave-Pulse flow.
 *
 *   1. `verifyStepUp(accountId, token, purpose)` — calls the ARC-gated
 *      `/internal/step-up/verify` endpoint to confirm a user-supplied
 *      step-up token is valid + matches the expected purpose. Pulse
 *      doesn't verify step-up signatures locally — osn-api remains the
 *      single source of truth (centralised jti consumption + AMR policy).
 *
 *   2. `notifyAppLeft(accountId)` — calls `/internal/app-enrollment/leave`
 *      after Pulse's local soft-delete commits, so osn-api can flip
 *      `app_enrollments.left_at` for the (account, "pulse") row.
 */

export class OsnBridgeError extends Data.TaggedError("OsnBridgeError")<{
  readonly cause: unknown;
}> {}

const OSN_API_URL = process.env.OSN_API_URL ?? "http://localhost:4000";

if (process.env.NODE_ENV === "production" && !OSN_API_URL.startsWith("https://")) {
  throw new Error(`OSN_API_URL must use https:// in production (got: ${OSN_API_URL})`);
}

/**
 * Verifies a step-up token with osn-api and returns the verified
 * accountId from its `sub` claim. Pulse uses the returned accountId for
 * the rest of the leave-Pulse flow rather than trusting any client-
 * supplied value (S-H2 / P6 — accountId must never be exposed to clients).
 */
export const verifyStepUp = (
  token: string,
  purpose: StepUpPurpose,
): Effect.Effect<{ ok: true; accountId: string } | { ok: false }, OsnBridgeError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await instrumentedFetch(`${OSN_API_URL}/internal/step-up/verify`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await arcAuthHeader("osn-api", "step-up:verify"),
        },
        body: JSON.stringify({ token, purpose }),
      });
      if (!res.ok) throw new Error(`step-up verify returned ${res.status}`);
      const payload = (await res.json()) as
        | { ok: true; account_id: string }
        | { ok: false; reason?: string };
      if (payload.ok === true && typeof payload.account_id === "string") {
        return { ok: true as const, accountId: payload.account_id };
      }
      return { ok: false as const };
    },
    catch: (cause) => new OsnBridgeError({ cause }),
  });

/**
 * Marks the user as having left Pulse, server-to-server. accountId is the
 * value returned by `verifyStepUp` (server-to-server, never client-
 * controlled). ARC authenticates "Pulse made this call"; the user's
 * intent was already proved by the matching verifyStepUp call earlier
 * in the request lifecycle.
 *
 * Residual risk (S-M follow-up — see wiki/TODO.md S-M25): a compromised
 * Pulse instance can call this with arbitrary accountIds. Mitigations:
 * the ARC key's bounded TTL (5 min), per-kid rate limits at the ARC
 * middleware (S-M24 — backlogged), and audit logs.
 */
export const notifyAppLeft = (
  accountId: string,
): Effect.Effect<{ closed: boolean }, OsnBridgeError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await instrumentedFetch(`${OSN_API_URL}/internal/app-enrollment/leave`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await arcAuthHeader("osn-api", "app-enrollment:write"),
        },
        body: JSON.stringify({
          account_id: accountId,
          app: "pulse" as const,
        }),
      });
      if (!res.ok) throw new Error(`enrollment-leave returned ${res.status}`);
      return (await res.json()) as { closed: boolean };
    },
    catch: (cause) => new OsnBridgeError({ cause }),
  });

export const notifyAppJoined = (
  accountId: string,
): Effect.Effect<{ enrolled: boolean }, OsnBridgeError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await instrumentedFetch(`${OSN_API_URL}/internal/app-enrollment/join`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await arcAuthHeader("osn-api", "app-enrollment:write"),
        },
        body: JSON.stringify({ account_id: accountId, app: "pulse" as const }),
      });
      if (!res.ok) throw new Error(`enrollment-join returned ${res.status}`);
      return (await res.json()) as { enrolled: boolean };
    },
    catch: (cause) => new OsnBridgeError({ cause }),
  });
