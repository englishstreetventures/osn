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
 * It takes no input. A per-IP limiter sits in front, because each call costs
 * three store calls; an IP that cannot be resolved is refused like one over
 * its budget. A failed store call is logged by the store's own error reporter,
 * by store name and operation only.
 */
export function createCoordinationHealthRoutes(
  probe: CoordinationProbe,
  limiter: RateLimiterBackend,
  clientIpConfig: Omit<ClientIpOptions, "socketIp"> = {},
) {
  return new Elysia().get("/health/coordination", async ({ headers, set, server, request }) => {
    set.headers["cache-control"] = "no-store";
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
