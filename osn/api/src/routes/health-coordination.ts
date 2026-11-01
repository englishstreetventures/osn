import { timingSafeEqualString } from "@shared/crypto/timing-safe";
import {
  getClientIp,
  isUnresolvedIp,
  type ClientIpOptions,
  type RateLimiterBackend,
} from "@shared/rate-limit";
import { Elysia } from "elysia";

import type { CoordinationProbe } from "../lib/coordination/probe";

/**
 * `GET /health/coordination`: one write, read and remove through the
 * coordination store, under a key the server makes. 200 `{ ok: true }` when
 * the round trip holds, 503 `{ ok: false }` when it does not. `/health` answers
 * without touching any store, so this is the probe that shows the store is
 * reachable from the deployed Worker; the post-deploy smoke check asks it.
 *
 * Only a caller holding `INTERNAL_SERVICE_SECRET` as a bearer is answered:
 * each call costs three store calls, and the store's allowance is shared with
 * every sign-in, so a public probe would let anyone spend it. Without the
 * secret the answer is 401, and where the secret is unset the route is off
 * (501); neither touches the limiter or the store. A per-IP limiter still
 * stands behind the secret, and an IP that cannot be resolved is refused like
 * one over its budget. A failed store call is logged by the store's own error
 * reporter, by store name and operation only.
 */
export function createCoordinationHealthRoutes(
  probe: CoordinationProbe,
  limiter: RateLimiterBackend,
  internalServiceSecret: string | undefined,
  clientIpConfig: Omit<ClientIpOptions, "socketIp"> = {},
) {
  return new Elysia().get("/health/coordination", async ({ headers, set, server, request }) => {
    set.headers["cache-control"] = "no-store";
    if (!internalServiceSecret) {
      set.status = 501;
      return { error: "not_configured" };
    }
    if (!timingSafeEqualString(headers["authorization"] ?? "", `Bearer ${internalServiceSecret}`)) {
      set.status = 401;
      return { error: "unauthorized" };
    }

    const ip = getClientIp(headers, {
      ...clientIpConfig,
      socketIp: server?.requestIP?.(request)?.address ?? null,
    });
    let allowed = false;
    if (!isUnresolvedIp(ip)) {
      try {
        allowed = await limiter.check(ip);
      } catch {
        allowed = false;
      }
    }
    if (!allowed) {
      set.status = 429;
      return { error: "rate_limited" };
    }

    let ok = false;
    try {
      ok = await probe.roundTrip();
    } catch {
      ok = false;
    }
    if (!ok) set.status = 503;
    return { ok };
  });
}
