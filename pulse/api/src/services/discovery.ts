import { eventRsvps, eventSeries, events, pulseUsers, type Event } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { and, asc, eq, gt, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";

import { SUPPORTED_CURRENCIES, toMinorUnits } from "../lib/currency";
import {
  metricDiscoveryFilterApplied,
  metricDiscoverySearchDuration,
  metricDiscoverySearched,
} from "../metrics";
import type { DatabaseError } from "./events";
import { buildVisibilityFilter } from "./eventVisibility";
import { type GraphBridgeError, getConnectionIds as defaultGetConnectionIds } from "./graphBridge";

export class DiscoveryValidationError extends Data.TaggedError("DiscoveryValidationError")<{
  readonly cause: unknown;
}> {}

export class DiscoveryError extends Data.TaggedError("DiscoveryError")<{
  readonly cause: unknown;
}> {}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CategoryString = Schema.String.pipe(Schema.maxLength(100));
const DateFromISOString = Schema.transform(
  Schema.String.pipe(Schema.filter((s) => !Number.isNaN(new Date(s).getTime()))),
  Schema.DateFromSelf,
  { strict: true, decode: (s) => new Date(s), encode: (d) => d.toISOString() },
);
const Latitude = Schema.Number.pipe(Schema.between(-90, 90));
const Longitude = Schema.Number.pipe(Schema.between(-180, 180));
// 500 km is plenty for "events near me" — Earth's largest metros are
// well inside this, and bigger radii stop being a discovery query and
// become a full city-list query that's better served a different way.
const RadiusKm = Schema.Number.pipe(Schema.between(0.1, 500));
// Shared cap across currencies; matches `MAX_PRICE_MAJOR` in lib/currency.
const PriceMajor = Schema.Number.pipe(Schema.between(0, 99999.99));
const CurrencySchema = Schema.Literal(...SUPPORTED_CURRENCIES);

export const DiscoveryParamsSchema = Schema.Struct({
  category: Schema.optional(CategoryString),
  from: Schema.optional(DateFromISOString),
  to: Schema.optional(DateFromISOString),
  lat: Schema.optional(Latitude),
  lng: Schema.optional(Longitude),
  radiusKm: Schema.optional(RadiusKm),
  friendsOnly: Schema.optional(Schema.Boolean),
  currency: Schema.optional(CurrencySchema),
  priceMin: Schema.optional(PriceMajor),
  priceMax: Schema.optional(PriceMajor),
  cursorStartTime: Schema.optional(DateFromISOString),
  cursorId: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number.pipe(Schema.between(1, 50))),
}).pipe(
  Schema.filter((p) => {
    // Location triangle: lat/lng/radius must all be set together.
    const locBits = [p.lat != null, p.lng != null, p.radiusKm != null];
    const locCount = locBits.filter(Boolean).length;
    if (locCount !== 0 && locCount !== 3) return false;
    // Price range implies currency.
    if ((p.priceMin != null || p.priceMax != null) && p.currency == null) return false;
    // Sensible range: priceMin <= priceMax when both set.
    if (p.priceMin != null && p.priceMax != null && p.priceMin > p.priceMax) return false;
    // Cursor pair: both parts together or neither.
    if ((p.cursorStartTime != null) !== (p.cursorId != null)) return false;
    return true;
  }),
);

export type DiscoveryParams = Schema.Schema.Type<typeof DiscoveryParamsSchema>;

export interface DiscoverySeriesSummary {
  id: string;
  title: string;
}

export interface DiscoveryResult {
  events: Event[];
  nextCursor: { startTime: string; id: string } | null;
  /**
   * Series metadata for every `seriesId` referenced by the returned page.
   * Surfaced at the response level (not inlined on each event) so the wire
   * contract stays deduplicated and the `Event` row shape is unchanged.
   * Clients look up `series[event.seriesId]` to render the "Part of …"
   * banner above the card.
   */
  series: Record<string, DiscoverySeriesSummary>;
}

export interface DiscoveryLookups {
  getConnectionIds: (profileId: string) => Effect.Effect<Set<string>, GraphBridgeError>;
}

const defaultLookups: DiscoveryLookups = { getConnectionIds: defaultGetConnectionIds };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EARTH_RADIUS_KM = 6371;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Great-circle distance in kilometres. Used to narrow the bbox prefilter
 * to an actual circle; bbox alone returns a superset (the square
 * circumscribing the radius).
 */
const haversineKm = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLng = (lng2 - lng1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
};

/**
 * Convert a centre + radius to a (minLat, maxLat, minLng, maxLng) bbox.
 * The longitude delta is latitude-aware: 1° of longitude is narrower
 * near the poles than at the equator, so the bbox must widen there.
 * We clamp cos(lat) away from zero so the bbox stays finite near the
 * poles — a near-polar radius query just returns a very wide band,
 * which is fine (the haversine pass will drop the garbage).
 */
const boundingBox = (lat: number, lng: number, radiusKm: number) => {
  const deltaLat = radiusKm / 111; // ~111 km per degree of latitude
  const cosLat = Math.max(Math.cos(lat * DEG_TO_RAD), 0.01);
  const deltaLng = radiusKm / (111 * cosLat);
  return {
    minLat: lat - deltaLat,
    maxLat: lat + deltaLat,
    minLng: lng - deltaLng,
    maxLng: lng + deltaLng,
  };
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20;
const BBOX_OVERFETCH_FACTOR = 2;

export const discoverEvents = (
  input: unknown,
  viewerId: string | null,
  lookups: DiscoveryLookups = defaultLookups,
): Effect.Effect<
  DiscoveryResult,
  DiscoveryValidationError | DatabaseError | DiscoveryError | GraphBridgeError,
  Db
> =>
  Effect.gen(function* () {
    const startedAt = performance.now();
    const { db } = yield* Db;

    const params = yield* Schema.decodeUnknown(DiscoveryParamsSchema)(input).pipe(
      Effect.mapError((cause) => new DiscoveryValidationError({ cause })),
    );

    const limit = params.limit ?? DEFAULT_LIMIT;
    const hasLocation = params.lat != null && params.lng != null && params.radiusKm != null;
    const hasPrice = params.priceMin != null || params.priceMax != null;

    const filters: SQL[] = [buildVisibilityFilter(viewerId)];

    // Status gate — discovery surfaces events users can still attend.
    // Finished / cancelled events live on direct-fetch routes only.
    //
    // Unlike `listEvents`, discovery does NOT call `applyTransition` per
    // row. The deliberate trade-off: a slightly-stale `ongoing` label on
    // the wire vs. N×UPDATE writes per discovery page (P-I2). Direct-
    // fetch routes still apply transitions, so the canonical lifecycle
    // is honoured the moment a user opens the event. If the staleness
    // becomes user-visible in metrics, batch the transition write.
    filters.push(inArray(events.status, ["upcoming", "ongoing", "maybe_finished"] as const));

    // Time window — default `from = now` so past events don't surface.
    const now = new Date();
    const fromTime = params.from ?? now;
    filters.push(gte(events.startTime, fromTime));
    if (params.to != null) {
      filters.push(lte(events.startTime, params.to));
    }

    if (params.category != null) {
      filters.push(eq(events.category, params.category));
      metricDiscoveryFilterApplied("category");
    }

    if (params.from != null || params.to != null) {
      metricDiscoveryFilterApplied("datetime");
    }

    if (hasLocation) {
      const { minLat, maxLat, minLng, maxLng } = boundingBox(
        params.lat as number,
        params.lng as number,
        params.radiusKm as number,
      );
      filters.push(gte(events.latitude, minLat));
      filters.push(lte(events.latitude, maxLat));
      filters.push(gte(events.longitude, minLng));
      filters.push(lte(events.longitude, maxLng));
      metricDiscoveryFilterApplied("location");
    }

    if (hasPrice) {
      const currency = params.currency as (typeof SUPPORTED_CURRENCIES)[number];
      const minMinor = params.priceMin != null ? toMinorUnits(params.priceMin, currency) : null;
      const maxMinor = params.priceMax != null ? toMinorUnits(params.priceMax, currency) : null;
      const priced = and(
        eq(events.priceCurrency, currency),
        minMinor != null ? gte(events.priceAmount, minMinor) : undefined,
        maxMinor != null ? lte(events.priceAmount, maxMinor) : undefined,
      ) as SQL;
      // Free events have null price — include them unless the caller set
      // a positive minimum (in which case "free" doesn't satisfy the floor).
      const includeFree = minMinor == null || minMinor === 0;
      filters.push(
        includeFree
          ? (or(isNull(events.priceAmount), eq(events.priceAmount, 0), priced) as SQL)
          : priced,
      );
      metricDiscoveryFilterApplied("price");
    }

    // Friends filter — additively narrows to events hosted by / RSVPed
    // to by a connection. Requires a viewer.
    if (params.friendsOnly === true) {
      if (viewerId == null) {
        return yield* Effect.fail(
          new DiscoveryValidationError({ cause: "friendsOnly requires authentication" }),
        );
      }
      const connections = yield* lookups.getConnectionIds(viewerId).pipe(
        Effect.withSpan("pulse.discovery.friends_lookup"),
        Effect.tapError((cause) =>
          Effect.logError("pulse.discovery.graph_lookup_failed", { cause }),
        ),
      );
      // S-L1: avoid a JS-side fast path that would let an on-path
      // attacker distinguish "viewer has zero connections" from
      // "≥1 connection" by response latency. When the connection set
      // is empty, substitute a sentinel that no real profile_id will
      // match — the query executes the same shape and returns 0 rows
      // via the indexed lookup. Cost is one extra (cheap) round-trip
      // for the zero-connection case.
      const connectionIds =
        connections.size === 0 ? ["__no_connection_sentinel__"] : [...connections];
      // RSVP-signal branch:
      //   - Restricted to `going`/`interested` (S-M1). Excludes `invited`
      //     (organiser-only pre-RSVP marker — leaks the invite list to
      //     the invitee's friends before they've engaged) and
      //     `not_going` (an explicit decline must not re-broadcast as
      //     a recommendation).
      //   - Respects `pulse_users.attendance_visibility`: a user who
      //     hid their RSVPs never surfaces events via the friends
      //     signal. Users without a pulse_users row default to
      //     "connections" (visible), so the COALESCE is deliberate.
      //   - The viewer's own RSVP is excluded — it's not a *friend*
      //     signal.
      //   - Connection set is bounded by MAX_EVENT_GUESTS upstream in
      //     `getConnectionIds`, capping the IN list size for the SQLite
      //     prepared-statement cache.
      const friendsPredicate = or(
        inArray(events.createdByProfileId, connectionIds),
        sql`EXISTS (
          SELECT 1 FROM ${eventRsvps}
          LEFT JOIN ${pulseUsers} ON ${eventRsvps.profileId} = ${pulseUsers.profileId}
          WHERE ${eventRsvps.eventId} = ${events.id}
            AND ${eventRsvps.profileId} IN (${sql.join(
              connectionIds.map((id) => sql`${id}`),
              sql`, `,
            )})
            AND ${eventRsvps.profileId} != ${viewerId}
            AND ${eventRsvps.status} IN ('going', 'interested')
            AND COALESCE(${pulseUsers.attendanceVisibility}, 'connections') != 'no_one'
        )`,
      ) as SQL;
      filters.push(friendsPredicate);
      metricDiscoveryFilterApplied("friends");
    }

    // Cursor — paginate with (startTime, id) tiebreak. Stable ordering
    // across concurrent inserts; no offset drift.
    if (params.cursorStartTime != null && params.cursorId != null) {
      filters.push(
        or(
          gt(events.startTime, params.cursorStartTime),
          and(eq(events.startTime, params.cursorStartTime), gt(events.id, params.cursorId)),
        ) as SQL,
      );
    }

    // Overfetch when radius filtering is active — haversine drops some
    // bbox rows, so we read more and cut after. Cap the DB read so a
    // pathologically sparse area can't blow the budget.
    const dbLimit = hasLocation ? Math.min(limit * BBOX_OVERFETCH_FACTOR, 100) : limit;

    const rows = yield* Effect.tryPromise({
      try: (): Promise<Event[]> =>
        db
          .select()
          .from(events)
          .where(and(...filters))
          .orderBy(asc(events.startTime), asc(events.id))
          .limit(dbLimit) as Promise<Event[]>,
      catch: (cause) =>
        new DiscoveryError({ cause }) as DiscoveryError | DatabaseError | GraphBridgeError,
    });

    let filtered = rows;
    if (hasLocation) {
      const lat = params.lat as number;
      const lng = params.lng as number;
      const r = params.radiusKm as number;
      filtered = rows.filter((row) => {
        if (row.latitude == null || row.longitude == null) return false;
        return haversineKm(lat, lng, row.latitude, row.longitude) <= r;
      });
    }

    const page = filtered.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = last ? { startTime: last.startTime.toISOString(), id: last.id } : null;

    // Batch-fetch series summaries for any event that belongs to one.
    // Single SELECT regardless of page size; empty when no event in the
    // page is a series instance.
    const seriesIds = [
      ...new Set(page.map((e) => e.seriesId).filter((id): id is string => id != null)),
    ];
    const seriesMap: Record<string, DiscoverySeriesSummary> = {};
    if (seriesIds.length > 0) {
      const seriesRows = yield* Effect.tryPromise({
        try: () =>
          db
            .select({ id: eventSeries.id, title: eventSeries.title })
            .from(eventSeries)
            .where(inArray(eventSeries.id, seriesIds)),
        catch: (cause) => new DiscoveryError({ cause }),
      });
      for (const row of seriesRows) {
        seriesMap[row.id] = { id: row.id, title: row.title };
      }
    }

    metricDiscoverySearched({
      scope: viewerId == null ? "public" : "authenticated",
      friends_only: params.friendsOnly === true ? "true" : "false",
      has_location_filter: hasLocation ? "true" : "false",
      has_price_filter: hasPrice ? "true" : "false",
      result_empty: page.length === 0 ? "true" : "false",
    });
    metricDiscoverySearchDuration((performance.now() - startedAt) / 1000, "ok");

    return { events: page, nextCursor, series: seriesMap };
  }).pipe(Effect.withSpan("pulse.discovery.search"));
