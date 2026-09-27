import { createRateLimiter } from "@shared/rate-limit";
import { subscribe } from "@shared/realtime/server";
import { Effect } from "effect";

import { organiserAuthOptions, type AppOptions } from "../app";
import { DbService } from "../db";
import type { Db } from "../db";
import { resolveOsnProfileId } from "../middleware/osn-auth";
import { decideCapability } from "../middleware/wedding-role";
import { runCire } from "../observability";
import { hostsService } from "../services/hosts";

/** `/realtime/<topic>`, the topic one percent-encoded path segment. */
const REALTIME_PATH = /^\/realtime\/([^/]+)$/;

/** The ids cire mints (`wed_<hex>`), the reserved bootstrap id, and test ids. */
export const WEDDING_TOPIC_ID = /^wed_[a-z0-9_]{1,60}$/;

/**
 * Per-organiser default when no `REALTIME_RATE_LIMITER` binding is present:
 * 30 upgrades a minute, far above a person switching weddings. Counts per
 * isolate, which is why deployed tiers bind the native limiter instead.
 */
const defaultRealtimeLimiter = createRateLimiter({ maxRequests: 30, windowMs: 60_000 });

export type RealtimeRoute = (request: Request) => Promise<Response> | undefined;

/**
 * May `osnProfileId` read `weddingId`'s dashboard? The rule `weddingMember()`
 * applies to every dashboard read, from the same two calls: owner, editor and
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
 * `GET /realtime/:topic` — a WebSocket onto one wedding's hub. It runs in the
 * Worker entry BEFORE the Elysia app and returns the hub's 101 response as the
 * very object the hub produced: Elysia rebuilds a returned Response whenever a
 * plugin (CORS) has set a header, and a rebuilt 101 loses its socket.
 *
 * Returns `undefined` for any other path, so the caller hands the request to
 * the app. Admits only the organiser portal's origin, an organiser signed in
 * the same way as every organiser route, within the per-organiser limit, who
 * may read the wedding's dashboard.
 */
export function createRealtimeRoute(db: Db, options: AppOptions = {}): RealtimeRoute {
  const auth = organiserAuthOptions(db, options);
  const limiter = options.realtimeLimiter ?? defaultRealtimeLimiter;
  const allowedOrigins = options.organiserOrigin ? [options.organiserOrigin] : [];
  const hub = options.realtimeHub;

  return (request) => {
    const segment = REALTIME_PATH.exec(new URL(request.url).pathname)?.[1];
    if (segment === undefined) return undefined;
    return runCire(
      subscribe(request, segment, {
        product: "cire",
        hub,
        allowedOrigins,
        acceptsTopic: (topic) => topic.entity === "wedding" && WEDDING_TOPIC_ID.test(topic.id),
        authenticate: async (req) => (await resolveOsnProfileId(req, auth)) ?? null,
        allow: async (subject) => limiter.check(subject),
        authorize: (subject, topic) =>
          runCire(canReadWedding(topic.id, subject).pipe(Effect.provideService(DbService, db))),
      }),
    );
  };
}
