import { DbLive, type Db } from "@pulse/db/service";
import { extractClaims } from "@shared/osn-auth-client/verify";
import { createRateLimiter, getClientIp, type RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { MAX_PRICE_MAJOR } from "../lib/currency";
import { DEFAULT_JWKS_URL } from "../lib/jwks";
import { MAX_EVENT_GUESTS } from "../lib/limits";
import { shareSourceTypeBox, type ShareSource } from "../lib/shareSource";
import {
  metricCalendarIcsGenerated,
  metricEventAccessDenied,
  metricSettingsUpdated,
  metricShareExposure,
  metricShareInvoked,
} from "../metrics";
import { buildIcs } from "../services/calendar";
import { listBlasts, parseCommsChannels, sendBlast } from "../services/comms";
import { discoverEvents } from "../services/discovery";
import { checkEventVisibility, loadVisibleEvent } from "../services/eventAccess";
import {
  createEvent,
  deleteEvent,
  listEvents,
  listMyCalendarEvents,
  listTodayEvents,
  updateEvent,
} from "../services/events";
import { updateSettings } from "../services/pulseUsers";
import {
  inviteGuests,
  latestRsvps,
  listRsvps,
  rsvpCounts,
  upsertRsvp,
  type RsvpWithProfile,
} from "../services/rsvps";

const visibilityEnum = t.Optional(t.Union([t.Literal("public"), t.Literal("private")]));
const guestListVisibilityEnum = t.Optional(
  t.Union([t.Literal("public"), t.Literal("connections"), t.Literal("private")]),
);
const joinPolicyEnum = t.Optional(t.Union([t.Literal("open"), t.Literal("guest_list")]));
const commsChannelsSchema = t.Optional(
  t.Array(t.Union([t.Literal("sms"), t.Literal("email")]), { minItems: 1, maxItems: 2 }),
);
const priceAmountSchema = t.Optional(
  t.Nullable(t.Number({ minimum: 0, maximum: MAX_PRICE_MAJOR })),
);
// Must be a static union of literals so Eden treaty can narrow the
// client-side body type. Keep in sync with SUPPORTED_CURRENCIES in
// ../lib/currency.ts.
const priceCurrencySchema = t.Optional(
  t.Nullable(
    t.Union([
      t.Literal("USD"),
      t.Literal("EUR"),
      t.Literal("GBP"),
      t.Literal("CAD"),
      t.Literal("AUD"),
      t.Literal("JPY"),
    ]),
  ),
);
const rsvpStatusEnum = t.Union([t.Literal("going"), t.Literal("maybe"), t.Literal("not_going")]);
const rsvpFilterStatusEnum = t.Union([
  t.Literal("going"),
  t.Literal("maybe"),
  t.Literal("not_going"),
  t.Literal("invited"),
]);

/**
 * Serialises an RSVP row for the wire. Visibility is enforced upstream
 * by `listRsvps` (per-row attendee privacy + coarse guest-list rules);
 * this function only shapes the response.
 *
 * `invitedByProfileId` is gated to the organiser viewer — non-organiser
 * viewers don't need (or want) to know which co-host invited each
 * attendee. The DB column stays populated; only the wire format hides
 * it from non-organisers.
 */
const serializeRsvp = (row: RsvpWithProfile, isOrganiser: boolean) => ({
  id: row.id,
  eventId: row.eventId,
  profileId: row.profileId,
  status: row.status,
  invitedByProfileId: isOrganiser ? row.invitedByProfileId : null,
  isCloseFriend: row.isCloseFriend,
  createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  profile: row.profile
    ? {
        id: row.profile.id,
        handle: row.profile.handle,
        displayName: row.profile.displayName,
        avatarUrl: row.profile.avatarUrl,
      }
    : null,
});

const statusEnum = t.Optional(
  t.Union([
    t.Literal("upcoming"),
    t.Literal("ongoing"),
    t.Literal("maybe_finished"),
    t.Literal("finished"),
    t.Literal("cancelled"),
  ]),
);

// Currency union for the discover route's query string. Separate from the
// body schema above because query params don't need the `Nullable` wrapper
// (you either pass the param or you don't).
const discoveryCurrencyEnum = t.Optional(
  t.Union([
    t.Literal("USD"),
    t.Literal("EUR"),
    t.Literal("GBP"),
    t.Literal("CAD"),
    t.Literal("AUD"),
    t.Literal("JPY"),
  ]),
);

// S-L3: per-IP rate limit on the unauthenticated /events/discover read.
// Discovery is the most expensive Pulse read (multi-filter + bbox prefilter
// + optional graph fetch). Without throttling, an unauth client can drive
// arbitrary load. Window matches the graph routes' 60 req/min posture in
// `osn/api`.
const DISCOVERY_RATE_LIMIT_MAX = 60;
const DISCOVERY_RATE_LIMIT_WINDOW_MS = 60_000;

export function createDefaultDiscoveryRateLimiter(): RateLimiterBackend {
  return createRateLimiter({
    maxRequests: DISCOVERY_RATE_LIMIT_MAX,
    windowMs: DISCOVERY_RATE_LIMIT_WINDOW_MS,
  });
}

// Per-IP rate limits for the unauthenticated share-attribution surface.
//
// `share` records outbound share intents — modest cap because a single
// user shouldn't legitimately fire many in a minute. `exposure` records
// inbound page loads that arrived through a sourced URL; the ceiling is
// higher because legitimate page reloads, link previews, and bot scans
// all register here. Without these, the share / exposure counters would
// be trivially poisonable by anyone refreshing a sourced URL in a loop.
const SHARE_RATE_LIMIT_MAX = 60;
const SHARE_RATE_LIMIT_WINDOW_MS = 60_000;
const EXPOSURE_RATE_LIMIT_MAX = 120;
const EXPOSURE_RATE_LIMIT_WINDOW_MS = 60_000;

export function createDefaultShareRateLimiter(): RateLimiterBackend {
  return createRateLimiter({
    maxRequests: SHARE_RATE_LIMIT_MAX,
    windowMs: SHARE_RATE_LIMIT_WINDOW_MS,
  });
}

export function createDefaultExposureRateLimiter(): RateLimiterBackend {
  return createRateLimiter({
    maxRequests: EXPOSURE_RATE_LIMIT_MAX,
    windowMs: EXPOSURE_RATE_LIMIT_WINDOW_MS,
  });
}

export const createEventsRoutes = (
  dbLayer: Layer.Layer<Db> = DbLive,
  jwksUrl: string = DEFAULT_JWKS_URL,
  _testKey?: CryptoKey,
  /**
   * Per-IP rate limiter for `GET /events/discover`. Defaults to the in-memory
   * backend; production wires the Redis backend at composition time.
   */
  discoveryRateLimiter: RateLimiterBackend = createDefaultDiscoveryRateLimiter(),
  /**
   * Per-IP rate limiter for `POST /events/:id/share`. Same fail-closed
   * posture as discovery — a metric counter fed by an unauthenticated
   * endpoint is trivially poisonable without a cap.
   */
  shareRateLimiter: RateLimiterBackend = createDefaultShareRateLimiter(),
  /**
   * Per-IP rate limiter for `POST /events/:id/exposure`. Higher ceiling
   * than the share limiter because legitimate page reloads of a sourced
   * URL register here.
   */
  exposureRateLimiter: RateLimiterBackend = createDefaultExposureRateLimiter(),
) => {
  return (
    new Elysia({ prefix: "/events" })
      .get(
        "/",
        async ({ query, headers }) => {
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          const result = await Effect.runPromise(
            listEvents({ ...query, viewerId: claims?.profileId ?? null }).pipe(
              Effect.provide(dbLayer),
            ),
          );
          return { events: result };
        },
        {
          query: t.Object({
            status: statusEnum,
            category: t.Optional(t.String()),
            limit: t.Optional(t.String()),
          }),
        },
      )
      .get("/today", async () => {
        const result = await Effect.runPromise(listTodayEvents.pipe(Effect.provide(dbLayer)));
        return { events: result };
      })
      .get(
        "/calendar",
        async ({ query, headers, set }) => {
          // The personal agenda is viewer-scoped, so authentication is
          // required — an anonymous caller has no events to show.
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          const parsedLimit = query.limit != null ? Number(query.limit) : NaN;
          const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(1, parsedLimit), 100) : 50;
          const result = await Effect.runPromise(
            listMyCalendarEvents(claims.profileId, { limit }).pipe(
              Effect.catchAll((cause) =>
                Effect.logError("pulse.calendar.list_failed", { cause }).pipe(Effect.as(null)),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 500;
            return { error: "Failed to load calendar" } as const;
          }
          return { entries: result };
        },
        { query: t.Object({ limit: t.Optional(t.String()) }) },
      )
      .get(
        "/discover",
        async ({ query, headers, set }) => {
          // S-L3: per-IP rate limit. Failures are treated as "deny" to
          // avoid the limiter becoming a bypass when the backend is
          // unhealthy (matches the osn/api graph-routes posture).
          const ip = getClientIp(headers);
          let allowed: boolean;
          try {
            allowed = await discoveryRateLimiter.check(ip);
          } catch {
            allowed = false;
          }
          if (!allowed) {
            set.status = 429;
            return { error: "Too many requests" } as const;
          }
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          const viewerId = claims?.profileId ?? null;
          // `friendsOnly` without a viewer is a validation error — the
          // service raises `DiscoveryValidationError`, which we map to
          // 401 here (not 422) because the issue is identity, not input.
          if (query.friendsOnly === true && viewerId == null) {
            set.status = 401;
            return { message: "Authentication required for friendsOnly" } as const;
          }
          const result = await Effect.runPromise(
            discoverEvents(query, viewerId).pipe(
              Effect.catchTag("DiscoveryValidationError", (e) =>
                Effect.sync(() => {
                  set.status = 422;
                  return { error: String(e.cause) } as const;
                }),
              ),
              Effect.catchTag("GraphBridgeError", () =>
                Effect.sync(() => {
                  set.status = 502;
                  return { error: "Failed to resolve social graph" } as const;
                }),
              ),
              Effect.catchTag("DiscoveryError", () =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Discovery failed" } as const;
                }),
              ),
              Effect.catchTag("DatabaseError", () =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Discovery failed" } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if ("error" in result) return result;
          if ("message" in result) return result;
          return {
            events: result.events,
            nextCursor: result.nextCursor,
            series: result.series,
          };
        },
        {
          query: t.Object({
            category: t.Optional(t.String({ maxLength: 100 })),
            from: t.Optional(t.String({ format: "date-time" })),
            to: t.Optional(t.String({ format: "date-time" })),
            lat: t.Optional(t.Numeric({ minimum: -90, maximum: 90 })),
            lng: t.Optional(t.Numeric({ minimum: -180, maximum: 180 })),
            radiusKm: t.Optional(t.Numeric({ minimum: 0.1, maximum: 500 })),
            friendsOnly: t.Optional(t.BooleanString()),
            currency: discoveryCurrencyEnum,
            priceMin: t.Optional(t.Numeric({ minimum: 0, maximum: MAX_PRICE_MAJOR })),
            priceMax: t.Optional(t.Numeric({ minimum: 0, maximum: MAX_PRICE_MAJOR })),
            cursorStartTime: t.Optional(t.String({ format: "date-time" })),
            cursorId: t.Optional(t.String()),
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50 })),
          }),
        },
      )
      .get(
        "/:id",
        async ({ params, headers, set }) => {
          // S-H1: gate direct fetch by visibility. Private events are
          // only returned to the organiser or to invited / RSVP'd users.
          // 404 (not 403) for non-authorised viewers so we don't leak
          // existence.
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          const result = await Effect.runPromise(
            loadVisibleEvent(params.id, claims?.profileId ?? null).pipe(Effect.provide(dbLayer)),
          );
          if (result === null) {
            metricEventAccessDenied(
              "get",
              claims?.profileId == null ? "private_anonymous" : "private_no_rsvp",
            );
            set.status = 404;
            return { message: "Event not found" };
          }
          return { event: result };
        },
        {
          params: t.Object({
            id: t.String(),
          }),
        },
      )
      .post(
        "/",
        async ({ body, headers, set }) => {
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          const creator = {
            createdByProfileId: claims.profileId,
            createdByName:
              claims.displayName ??
              (claims.handle ? `@${claims.handle}` : null) ??
              (claims.email ? (claims.email.split("@")[0] ?? null) : null),
            createdByAvatar: null,
          };
          const result = await Effect.runPromise(
            createEvent(body, creator).pipe(
              Effect.catchTag("ValidationError", (e) =>
                Effect.sync(() => {
                  set.status = 422;
                  return { error: String(e.cause) } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if ("error" in result) return result;
          set.status = 201;
          return { event: result };
        },
        {
          body: t.Object({
            title: t.String(),
            description: t.Optional(t.String()),
            location: t.Optional(t.String()),
            venue: t.Optional(t.String()),
            latitude: t.Optional(t.Number({ minimum: -90, maximum: 90 })),
            longitude: t.Optional(t.Number({ minimum: -180, maximum: 180 })),
            category: t.Optional(t.String()),
            startTime: t.String({ format: "date-time" }),
            endTime: t.Optional(t.String({ format: "date-time" })),
            status: statusEnum,
            imageUrl: t.Optional(t.String()),
            visibility: visibilityEnum,
            guestListVisibility: guestListVisibilityEnum,
            joinPolicy: joinPolicyEnum,
            allowInterested: t.Optional(t.Boolean()),
            commsChannels: commsChannelsSchema,
            priceAmount: priceAmountSchema,
            priceCurrency: priceCurrencySchema,
          }),
        },
      )
      .patch(
        "/:id",
        async ({ params, body, headers, set }) => {
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          const profileId = claims.profileId;
          const result = await Effect.runPromise(
            updateEvent(params.id, body, profileId).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
              Effect.catchTag("NotEventOwner", () =>
                Effect.sync(() => {
                  set.status = 403;
                  return { message: "Forbidden" } as const;
                }),
              ),
              Effect.catchTag("ValidationError", (e) =>
                Effect.sync(() => {
                  set.status = 422;
                  return { error: String(e.cause) } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Event not found" };
          }
          if ("error" in result) return result;
          if ("message" in result) return result;
          return { event: result };
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            title: t.Optional(t.String()),
            description: t.Optional(t.String()),
            location: t.Optional(t.String()),
            venue: t.Optional(t.String()),
            latitude: t.Optional(t.Number({ minimum: -90, maximum: 90 })),
            longitude: t.Optional(t.Number({ minimum: -180, maximum: 180 })),
            category: t.Optional(t.String()),
            startTime: t.Optional(t.String({ format: "date-time" })),
            endTime: t.Optional(t.String({ format: "date-time" })),
            status: statusEnum,
            imageUrl: t.Optional(t.String()),
            visibility: visibilityEnum,
            guestListVisibility: guestListVisibilityEnum,
            joinPolicy: joinPolicyEnum,
            allowInterested: t.Optional(t.Boolean()),
            commsChannels: commsChannelsSchema,
            priceAmount: priceAmountSchema,
            priceCurrency: priceCurrencySchema,
          }),
        },
      )
      .delete(
        "/:id",
        async ({ params, headers, set }) => {
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          const profileId = claims.profileId;
          const result = await Effect.runPromise(
            deleteEvent(params.id, profileId).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
              Effect.catchTag("NotEventOwner", () =>
                Effect.sync(() => {
                  set.status = 403;
                  return { message: "Forbidden" } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Event not found" };
          }
          if (result != null && "message" in result) return result;
          set.status = 204;
          return null;
        },
        {
          params: t.Object({ id: t.String() }),
        },
      )
      // ── RSVPs ────────────────────────────────────────────────────────────
      .get(
        "/:id/rsvps",
        async ({ params, query, headers, set }) => {
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          const viewerId = claims?.profileId ?? null;
          // Visibility gate first — private events are 404 to non-viewers.
          const event = await Effect.runPromise(
            loadVisibleEvent(params.id, viewerId).pipe(Effect.provide(dbLayer)),
          );
          if (event === null) {
            metricEventAccessDenied(
              "rsvps",
              viewerId == null ? "private_anonymous" : "private_no_rsvp",
            );
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          const isOrganiser = viewerId != null && viewerId === event.createdByProfileId;
          const result = await Effect.runPromise(
            listRsvps(params.id, viewerId, {
              status: query.status,
              limit: query.limit ? Number(query.limit) : undefined,
            }).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
              Effect.catchAll(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Failed to list RSVPs" } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          if (
            result != null &&
            !Array.isArray(result) &&
            typeof result === "object" &&
            "error" in result
          ) {
            return result;
          }
          return {
            rsvps: (result as RsvpWithProfile[]).map((row) => serializeRsvp(row, isOrganiser)),
          };
        },
        {
          params: t.Object({ id: t.String() }),
          query: t.Object({
            status: t.Optional(rsvpFilterStatusEnum),
            limit: t.Optional(t.String()),
          }),
        },
      )
      .get(
        "/:id/rsvps/counts",
        async ({ params, headers, set }) => {
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          // S-H5: gate counts by visibility — leaking the existence /
          // activity of a private event is its own information disclosure.
          const event = await Effect.runPromise(
            loadVisibleEvent(params.id, claims?.profileId ?? null).pipe(Effect.provide(dbLayer)),
          );
          if (event === null) {
            metricEventAccessDenied(
              "rsvps_counts",
              claims?.profileId == null ? "private_anonymous" : "private_no_rsvp",
            );
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          const result = await Effect.runPromise(
            rsvpCounts(params.id).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          return { counts: result };
        },
        { params: t.Object({ id: t.String() }) },
      )
      .get(
        "/:id/rsvps/latest",
        async ({ params, query, headers, set }) => {
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          const viewerId = claims?.profileId ?? null;
          const event = await Effect.runPromise(
            loadVisibleEvent(params.id, viewerId).pipe(Effect.provide(dbLayer)),
          );
          if (event === null) {
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          const isOrganiser = viewerId != null && viewerId === event.createdByProfileId;
          const limit = query.limit ? Math.min(Math.max(1, Number(query.limit)), 20) : 5;
          const result = await Effect.runPromise(
            latestRsvps(params.id, viewerId, limit).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
              Effect.catchAll(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Failed to list RSVPs" } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          if (
            result != null &&
            !Array.isArray(result) &&
            typeof result === "object" &&
            "error" in result
          ) {
            return result;
          }
          return {
            rsvps: (result as RsvpWithProfile[]).map((row) => serializeRsvp(row, isOrganiser)),
          };
        },
        {
          params: t.Object({ id: t.String() }),
          query: t.Object({ limit: t.Optional(t.String()) }),
        },
      )
      .post(
        "/:id/rsvps",
        async ({ params, body, headers, set }) => {
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          const result = await Effect.runPromise(
            upsertRsvp(params.id, claims.profileId, body).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
              Effect.catchTag("NotInvited", () =>
                Effect.sync(() => {
                  set.status = 403;
                  return { message: "Invitation required" } as const;
                }),
              ),
              Effect.catchTag("ValidationError", (e) =>
                Effect.sync(() => {
                  set.status = 422;
                  return { error: String(e.cause) } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          if ("message" in result || "error" in result) return result;
          return { rsvp: result };
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            status: rsvpStatusEnum,
            shareSource: t.Optional(shareSourceTypeBox),
          }),
        },
      )
      // ── Share-attribution telemetry ─────────────────────────────────────
      // Two unauthenticated endpoints used by the frontend to record
      // outbound share intents and inbound exposures. Both are
      // rate-limited per IP (fail-closed). Neither writes to the DB —
      // the only state they touch is the metric counters.
      .post(
        "/:id/share",
        async ({ params, body, headers, set }) => {
          const ip = getClientIp(headers);
          let allowed: boolean;
          try {
            allowed = await shareRateLimiter.check(ip);
          } catch {
            allowed = false;
          }
          if (!allowed) {
            set.status = 429;
            return { error: "Too many requests" } as const;
          }
          // Visibility gate: we don't want a private event's share count
          // to be derivable by anyone with the URL — same posture as
          // every other direct-fetch surface on this controller.
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          const meta = await Effect.runPromise(
            checkEventVisibility(params.id, claims?.profileId ?? null).pipe(
              Effect.provide(dbLayer),
            ),
          );
          if (meta === null) {
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          metricShareInvoked(body.source as ShareSource, "event_detail");
          set.status = 204;
          return null;
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({ source: shareSourceTypeBox }),
        },
      )
      .post(
        "/:id/exposure",
        async ({ params, body, headers, set }) => {
          const ip = getClientIp(headers);
          let allowed: boolean;
          try {
            allowed = await exposureRateLimiter.check(ip);
          } catch {
            allowed = false;
          }
          if (!allowed) {
            set.status = 429;
            return { error: "Too many requests" } as const;
          }
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          const meta = await Effect.runPromise(
            checkEventVisibility(params.id, claims?.profileId ?? null).pipe(
              Effect.provide(dbLayer),
            ),
          );
          if (meta === null) {
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          // Organisers viewing their own event don't pollute exposure
          // analytics — same rule as the RSVP attribution short-circuit.
          if (claims?.profileId && claims.profileId === meta.createdByProfileId) {
            set.status = 204;
            return null;
          }
          metricShareExposure(body.source as ShareSource, "event_detail");
          set.status = 204;
          return null;
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({ source: shareSourceTypeBox }),
        },
      )
      .post(
        "/:id/invite",
        async ({ params, body, headers, set }) => {
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          const result = await Effect.runPromise(
            inviteGuests(params.id, claims.profileId, body).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
              Effect.catchTag("NotEventOwner", () =>
                Effect.sync(() => {
                  set.status = 403;
                  return { message: "Forbidden" } as const;
                }),
              ),
              Effect.catchTag("ValidationError", (e) =>
                Effect.sync(() => {
                  set.status = 422;
                  return { error: String(e.cause) } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          return result;
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            profileIds: t.Array(t.String(), { minItems: 1, maxItems: MAX_EVENT_GUESTS }),
          }),
        },
      )
      // ── Add to calendar ─────────────────────────────────────────────────
      .get(
        "/:id/ics",
        async ({ params, headers, set }) => {
          // S-H2: gate ICS export by visibility. Otherwise the file
          // download leaks event metadata (incl. GEO coordinates) for
          // private events to anyone with the URL.
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          const event = await Effect.runPromise(
            loadVisibleEvent(params.id, claims?.profileId ?? null).pipe(Effect.provide(dbLayer)),
          );
          if (event === null) {
            metricEventAccessDenied(
              "ics",
              claims?.profileId == null ? "private_anonymous" : "private_no_rsvp",
            );
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          const ics = buildIcs(event);
          metricCalendarIcsGenerated("ok");
          set.headers["content-type"] = "text/calendar; charset=utf-8";
          set.headers["content-disposition"] = `attachment; filename="${event.id}.ics"`;
          return ics;
        },
        { params: t.Object({ id: t.String() }) },
      )
      // ── Comms (stubbed) ─────────────────────────────────────────────────
      .get(
        "/:id/comms",
        async ({ params, headers, set }) => {
          // S-H3: gate comms by visibility. Blast bodies often contain
          // venue codes, addresses, dress codes — they should never be
          // visible to viewers who can't see the event.
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          const event = await Effect.runPromise(
            loadVisibleEvent(params.id, claims?.profileId ?? null).pipe(Effect.provide(dbLayer)),
          );
          if (event === null) {
            metricEventAccessDenied(
              "comms",
              claims?.profileId == null ? "private_anonymous" : "private_no_rsvp",
            );
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          const blasts = await Effect.runPromise(
            listBlasts(params.id, 10).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed([])),
              Effect.provide(dbLayer),
            ),
          );
          return {
            channels: parseCommsChannels(event.commsChannels),
            blasts: blasts.map((b) => ({
              id: b.id,
              channel: b.channel,
              body: b.body,
              sentByProfileId: b.sentByProfileId,
              sentAt: b.sentAt instanceof Date ? b.sentAt.toISOString() : b.sentAt,
              createdAt: b.createdAt instanceof Date ? b.createdAt.toISOString() : b.createdAt,
            })),
          };
        },
        { params: t.Object({ id: t.String() }) },
      )
      .post(
        "/:id/comms/blasts",
        async ({ params, body, headers, set }) => {
          const claims = await extractClaims(headers["authorization"], jwksUrl, {
            testKey: _testKey as CryptoKey,
            audience: "osn-access",
          });
          if (!claims) {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          const result = await Effect.runPromise(
            sendBlast(params.id, claims.profileId, body).pipe(
              Effect.catchTag("EventNotFound", () => Effect.succeed(null)),
              Effect.catchTag("NotEventOwner", () =>
                Effect.sync(() => {
                  set.status = 403;
                  return { message: "Forbidden" } as const;
                }),
              ),
              Effect.catchTag("ValidationError", (e) =>
                Effect.sync(() => {
                  set.status = 422;
                  return { error: String(e.cause) } as const;
                }),
              ),
              Effect.provide(dbLayer),
            ),
          );
          if (result === null) {
            set.status = 404;
            return { message: "Event not found" } as const;
          }
          if ("message" in result || "error" in result) return result;
          set.status = 201;
          return {
            blasts: result.blasts.map((b) => ({
              id: b.id,
              channel: b.channel,
              body: b.body,
              sentAt: b.sentAt instanceof Date ? b.sentAt.toISOString() : b.sentAt,
            })),
          };
        },
        {
          params: t.Object({ id: t.String() }),
          body: t.Object({
            channels: t.Array(t.Union([t.Literal("sms"), t.Literal("email")]), {
              minItems: 1,
              maxItems: 2,
            }),
            body: t.String({ minLength: 1, maxLength: 1600 }),
          }),
        },
      )
  );
};

// ---------------------------------------------------------------------------
// /me/settings (Pulse-side user settings)
// ---------------------------------------------------------------------------

export const createSettingsRoutes = (
  dbLayer: Layer.Layer<Db> = DbLive,
  jwksUrl: string = DEFAULT_JWKS_URL,
  _testKey?: CryptoKey,
) => {
  return new Elysia({ prefix: "/me" }).patch(
    "/settings",
    async ({ body, headers, set }) => {
      const claims = await extractClaims(headers["authorization"], jwksUrl, {
        testKey: _testKey as CryptoKey,
        audience: "osn-access",
      });
      if (!claims) {
        metricSettingsUpdated("attendance_visibility", "unauthorized");
        set.status = 401;
        return { message: "Unauthorized" } as const;
      }
      const result = await Effect.runPromise(
        updateSettings(claims.profileId, body).pipe(
          Effect.catchTag("ValidationError", (e) =>
            Effect.sync(() => {
              set.status = 422;
              return { error: String(e.cause) } as const;
            }),
          ),
          Effect.provide(dbLayer),
        ),
      );
      if ("error" in result) {
        metricSettingsUpdated("attendance_visibility", "validation_error");
        return result;
      }
      metricSettingsUpdated("attendance_visibility", "ok");
      return {
        settings: {
          profileId: result.profileId,
          attendanceVisibility: result.attendanceVisibility,
        },
      };
    },
    {
      body: t.Object({
        attendanceVisibility: t.Optional(t.Union([t.Literal("connections"), t.Literal("no_one")])),
      }),
    },
  );
};

export const eventsRoutes = createEventsRoutes();
export const settingsRoutes = createSettingsRoutes();
