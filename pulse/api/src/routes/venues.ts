import type { Event } from "@pulse/db/schema";
import { DbLive, type Db } from "@pulse/db/service";
import { createRateLimiter, getClientIp, type RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Elysia, t } from "elysia";

import { metricEventAccessDenied } from "../metrics";
import { loadVisibleEvent } from "../services/eventAccess";
import { getVenue, listAllVenues, listEventLineup, listVenueEvents } from "../services/venues";

// S-L1: per-IP rate limit on the unauthenticated /venues reads. Same
// threat model and posture as /events/discover (S-L3): cheap anonymous
// requests driving full scans (`GET /venues`) and on-read status
// transitions (`/events` sub-route) on the single-writer SQLite file.
const VENUES_RATE_LIMIT_MAX = 60;
const VENUES_RATE_LIMIT_WINDOW_MS = 60_000;

export function createDefaultVenuesRateLimiter(): RateLimiterBackend {
  return createRateLimiter({
    maxRequests: VENUES_RATE_LIMIT_MAX,
    windowMs: VENUES_RATE_LIMIT_WINDOW_MS,
  });
}

/**
 * Allowlist serializer for events leaving on the anonymous venue
 * surface (S-M1). The full Drizzle row carries organiser-internal
 * fields (`chatId`, `commsChannels`, `createdByProfileId`, join/guest
 * policies) that must not reach unauthenticated scrapers; new columns
 * stay private-by-default until added here.
 */
const toPublicVenueEvent = (e: Event) => ({
  id: e.id,
  title: e.title,
  description: e.description,
  startTime: e.startTime,
  endTime: e.endTime,
  status: e.status,
  imageUrl: e.imageUrl,
  category: e.category,
  priceAmount: e.priceAmount,
  priceCurrency: e.priceCurrency,
  venueId: e.venueId,
  createdByName: e.createdByName,
});

/**
 * Venue surface routes.
 *
 * `GET /venues/:orgHandle/:venueHandle` — venue metadata (public).
 * `GET /venues/:orgHandle/:venueHandle/events` — programme list.
 * `GET /venues/:orgHandle/:venueHandle/events/:eventId/lineup` —
 *   programmed lineup for one of this venue's events.
 *
 * Sub-routing the lineup under the venue (rather than `/events/:id/lineup`)
 * keeps the venue page on a single origin; the lineup handler enforces
 * that the event actually belongs to the venue in the URL and is
 * publicly visible (S-H1) — see `[[event-access]]`.
 */
export const createVenuesRoutes = (
  dbLayer: Layer.Layer<Db> = DbLive,
  // Auth params kept for symmetry with sibling route factories — venue
  // surfaces are public so we don't currently extract claims.
  _jwksUrl: string = "",
  _testKey?: CryptoKey,
  /**
   * Per-IP rate limiter for the /venues group. Defaults to the in-memory
   * backend; production wires the Redis backend at composition time.
   */
  venuesRateLimiter: RateLimiterBackend = createDefaultVenuesRateLimiter(),
) => {
  // Layer graph built once per factory (convention: see osn/api/src/lib/route-runtime.ts) — not per request.
  const runtime = ManagedRuntime.make(dbLayer);
  return new Elysia({ prefix: "/venues" })
    .onBeforeHandle(async ({ headers, set }) => {
      // S-L1: fail-closed per-IP limit, matching the discover route —
      // a broken limiter backend must not become a bypass.
      const ip = getClientIp(headers);
      let allowed: boolean;
      try {
        allowed = await venuesRateLimiter.check(ip);
      } catch {
        allowed = false;
      }
      if (!allowed) {
        set.status = 429;
        return { error: "Too many requests" } as const;
      }
    })
    .get("/", async () => {
      // TODO(venue-bbox-search): swap for bbox-filtered query — see
      // wiki/TODO.md → Performance Backlog P-W28 (explore).
      const venues = await runtime.runPromise(listAllVenues());
      return { venues };
    })
    .get(
      "/:orgHandle/:venueHandle",
      async ({ params, set }) => {
        const venue = await runtime.runPromise(
          getVenue(params.orgHandle, params.venueHandle, { recordMetric: true }).pipe(
            Effect.catchTag("VenueNotFound", () => Effect.succeed(null)),
          ),
        );
        if (venue === null) {
          set.status = 404;
          return { message: "Venue not found" } as const;
        }
        return { venue };
      },
      { params: t.Object({ orgHandle: t.String(), venueHandle: t.String() }) },
    )
    .get(
      "/:orgHandle/:venueHandle/events",
      async ({ params, query, set }) => {
        const result = await runtime.runPromise(
          listVenueEvents(params.orgHandle, params.venueHandle, {
            scope: query.scope ?? "upcoming",
            limit: query.limit,
          }).pipe(Effect.catchTag("VenueNotFound", () => Effect.succeed(null))),
        );
        if (result === null) {
          set.status = 404;
          return { message: "Venue not found" } as const;
        }
        return { events: result.map(toPublicVenueEvent) };
      },
      {
        params: t.Object({ orgHandle: t.String(), venueHandle: t.String() }),
        query: t.Object({
          scope: t.Optional(t.Union([t.Literal("upcoming"), t.Literal("past"), t.Literal("all")])),
          // P-I1: numeric validation at the boundary so `?limit=abc`
          // 422s instead of flowing into `.limit(NaN)`.
          limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })),
        }),
      },
    )
    .get(
      "/:orgHandle/:venueHandle/events/:eventId/lineup",
      async ({ params, set }) => {
        // Confirm the venue exists first so a wrong handle returns 404
        // even when an attacker guesses a real eventId.
        const venue = await runtime.runPromise(
          getVenue(params.orgHandle, params.venueHandle).pipe(
            Effect.catchTag("VenueNotFound", () => Effect.succeed(null)),
          ),
        );
        if (venue === null) {
          set.status = 404;
          return { message: "Venue not found" } as const;
        }
        // S-H1: the lineup is an event sub-resource, so it goes through
        // the same visibility gate as every other direct event fetch
        // (anonymous viewer → public events only), AND the event must
        // belong to the venue in the URL — otherwise any valid venue
        // path would unlock any event's programme.
        const event = await runtime.runPromise(loadVisibleEvent(params.eventId, null));
        if (event === null || event.venueId !== venue.id) {
          metricEventAccessDenied("lineup", event === null ? "private_anonymous" : "other");
          set.status = 404;
          return { message: "Event not found" } as const;
        }
        const slots = await runtime.runPromise(listEventLineup(params.eventId));
        return { slots };
      },
      {
        params: t.Object({
          orgHandle: t.String(),
          venueHandle: t.String(),
          eventId: t.String(),
        }),
      },
    );
};
