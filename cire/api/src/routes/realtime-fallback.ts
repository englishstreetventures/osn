/**
 * The realtime client's fallback beacon from the organiser portal.
 *
 * When a portal tab's push subscription gives up — refused by the server, or
 * out of reconnect attempts — the tab POSTs the outcome (`refused` or
 * `exhausted`) here as a plain-text body, and this route counts it by product
 * and outcome. Nothing else is recorded: no wedding, no profile, no session,
 * so the count cannot say who fell back. The client IP keys the per-IP limit
 * in memory for its window and is never logged or counted.
 *
 *  - **Unauthenticated.** A fallback caused by an expired session must still
 *    be counted, and nothing here records who sent it, so there is nothing a
 *    session would protect.
 *  - **204 always, with no body.** The beacon is fire-and-forget: the tab
 *    ignores the answer, so a malformed body, a limiter refusal or an
 *    observability failure drops the beacon rather than surfacing an error,
 *    and nothing the caller sent is echoed back.
 *  - **No D1.** A public endpoint that wrote a row per call would let anyone
 *    spend the database's write allowance; this one logs and counts only.
 *  - **Behind the app-wide Origin guard.** A POST whose `Origin` is missing or
 *    is not one of cire's own origins gets the guard's 403 before it gets here.
 *  - **Counted as a warning log.** On workerd the counter records into a no-op
 *    meter until an exporter is attached, so on a deployed Worker the warning
 *    `recordClientFallback` writes to Workers Logs is the record.
 */
import type { RateLimiterBackend } from "@shared/rate-limit";
import {
  MAX_FALLBACK_BEACON_BYTES,
  readFallbackOutcome,
  recordClientFallback,
} from "@shared/realtime/server";
import { Elysia } from "elysia";

import { getClientIp, isUnresolvedIp } from "../lib/client-ip";
import { runCire } from "../observability";

export interface RealtimeFallbackRouteOptions {
  /** Per-IP rate limiter. A refusal, a miss or an error drops the beacon. */
  limiter: RateLimiterBackend;
}

/** `POST /api/realtime/fallback` — count one fallen-back subscription. Always 204. */
export const createRealtimeFallbackRoutes = ({ limiter }: RealtimeFallbackRouteOptions) =>
  new Elysia({ prefix: "/api/realtime" }).post(
    "/fallback",
    async ({ request, set }) => {
      // Every return below is the same empty 204.
      set.status = 204;

      // A declared length over the cap is dropped before the body is read.
      const declared = request.headers.get("content-length");
      if (declared) {
        const length = Number.parseInt(declared, 10);
        if (Number.isFinite(length) && length > MAX_FALLBACK_BEACON_BYTES) return null;
      }

      // Per-IP limit. An unresolved address, a refusal or a limiter error
      // drops the beacon.
      try {
        const ip = getClientIp(request.headers);
        if (isUnresolvedIp(ip) || !(await limiter.check(ip))) return null;
      } catch {
        return null;
      }

      // The read is capped too: a body can arrive without a declared length.
      let text: string;
      try {
        text = await request.text();
      } catch {
        return null;
      }
      if (text.length > MAX_FALLBACK_BEACON_BYTES) return null;

      const outcome = readFallbackOutcome(text);
      if (outcome === null) return null;

      try {
        await runCire(recordClientFallback("cire", outcome));
      } catch {
        // The beacon is fire-and-forget; a failed count is dropped.
      }
      return null;
    },
    // Keeps Elysia from parsing the body, so the handler reads it by hand
    // after the length and rate checks.
    { parse: () => ({}) },
  );
