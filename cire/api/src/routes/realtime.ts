import { createRateLimiter } from "@shared/rate-limit";
import { subscribe } from "@shared/realtime/server";
import { Effect } from "effect";

import { organiserAuthOptions, type AppOptions } from "../app";
import { DbService } from "../db";
import type { Db } from "../db";
import { getClientIp, isUnresolvedIp } from "../lib/client-ip";
import { resolveOsnProfileId } from "../middleware/osn-auth";
import { decideCapability } from "../middleware/wedding-role";
import { runCire } from "../observability";
import { hostsService } from "../services/hosts";
import { REALTIME_SUBSCRIBES_PER_DAY, spendRealtimeSubscribe } from "../services/realtime";

/** `/realtime/<topic>`, the topic one percent-encoded path segment. */
const REALTIME_PATH = /^\/realtime\/([^/]+)$/;

/** The ids cire mints (`wed_<hex>`), the reserved bootstrap id, and test ids. */
export const WEDDING_TOPIC_ID = /^wed_[a-z0-9_]{1,60}$/;

/**
 * Per-IP default, checked before anything else the route does: 30 upgrades a
 * minute, far above the tabs of everyone behind one address. It bounds the
 * session lookups an unauthenticated flood can cause. In memory, per isolate,
 * like the CSP collector's.
 */
const defaultRealtimeIpLimiter = createRateLimiter({ maxRequests: 30, windowMs: 60_000 });

/**
 * Per-organiser default: 30 upgrades a minute, far above a person switching
 * weddings. In memory, per isolate, so it smooths bursts only; the daily
 * ceiling in D1 (`spendRealtimeSubscribe`) is what bounds one organiser's
 * spend of the account-wide Durable Object allowance.
 */
const defaultRealtimeLimiter = createRateLimiter({ maxRequests: 30, windowMs: 60_000 });

export type RealtimeRoute = (request: Request) => Promise<Response> | undefined;

/**
 * May `osnProfileId` read `weddingId`'s dashboard? The rule `weddingMember()`
 * applies to every dashboard read, from the same call: owner, editor and
 * viewer yes; a helper, a stranger or an unknown wedding no.
 */
const canReadWedding = (weddingId: string, osnProfileId: string) =>
  hostsService
    .authorize(weddingId, osnProfileId)
    .pipe(
      Effect.map((result) =>
        result?.role ? decideCapability(result.role, "member").allowed : false,
      ),
    );

/**
 * `run`'s result, or an error carrying only `message` — never the failed
 * query's params (a session token hash, a profile id), which `subscribe` logs.
 */
async function withFixedError<A>(message: string, run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch {
    throw new Error(message);
  }
}

/** The 429 a caller over the per-IP limit gets, with no body and no CORS headers. */
const ipRateLimited = () =>
  runCire(
    Effect.logWarning("realtime subscribe refused", {
      product: "cire",
      outcome: "ip_rate_limited",
    }),
  ).then(() => new Response(null, { status: 429, headers: { "retry-after": "60" } }));

/**
 * `GET /realtime/:topic` — a WebSocket onto one wedding's hub. It runs in the
 * Worker entry BEFORE the Elysia app and returns the hub's 101 response as the
 * very object the hub produced: Elysia rebuilds a returned Response whenever a
 * plugin (CORS) has set a header, and a rebuilt 101 loses its socket.
 *
 * Returns `undefined` for any other path, so the caller hands the request to
 * the app. Because the app's middleware never sees this path, the route puts
 * its own per-IP limit before the session lookup; an unresolved client address
 * is refused as `rateLimitMiddleware` refuses it. Only a request from the
 * organiser portal's origin is counted, so a page on another site cannot use
 * up a visitor's limit: `subscribe()` refuses any other origin before it looks
 * anything up. `subscribe()` then admits an organiser signed in the same way as
 * every organiser route, within the per-organiser limit and the daily ceiling,
 * who may read the wedding's dashboard.
 */
export function createRealtimeRoute(db: Db, options: AppOptions = {}): RealtimeRoute {
  const auth = organiserAuthOptions(db, options);
  const ipLimiter = options.realtimeIpLimiter ?? defaultRealtimeIpLimiter;
  const limiter = options.realtimeLimiter ?? defaultRealtimeLimiter;
  const perDay = options.realtimeSubscribesPerDay ?? REALTIME_SUBSCRIBES_PER_DAY;
  const allowedOrigins = options.organiserOrigin ? [options.organiserOrigin] : [];
  const hub = options.realtimeHub;

  const admit = async (request: Request, segment: string): Promise<Response> => {
    if (allowedOrigins.includes(request.headers.get("origin") ?? "")) {
      const ip = getClientIp(request.headers);
      if (isUnresolvedIp(ip) || !(await ipLimiter.check(ip))) return ipRateLimited();
    }
    return runCire(
      subscribe(request, segment, {
        product: "cire",
        hub,
        allowedOrigins,
        acceptsTopic: (topic) => topic.entity === "wedding" && WEDDING_TOPIC_ID.test(topic.id),
        authenticate: (req) =>
          withFixedError(
            "organiser lookup failed",
            async () => (await resolveOsnProfileId(req, auth)) ?? null,
          ),
        allow: async (subject) => limiter.check(subject),
        allowDaily: (subject) =>
          withFixedError("realtime subscribe budget failed", () =>
            runCire(
              spendRealtimeSubscribe(subject, perDay).pipe(Effect.provideService(DbService, db)),
            ),
          ),
        authorize: (subject, topic) =>
          withFixedError("wedding membership lookup failed", () =>
            runCire(canReadWedding(topic.id, subject).pipe(Effect.provideService(DbService, db))),
          ),
      }),
    );
  };

  return (request) => {
    const segment = REALTIME_PATH.exec(new URL(request.url).pathname)?.[1];
    return segment === undefined ? undefined : admit(request, segment);
  };
}
