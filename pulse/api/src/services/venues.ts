import { events, eventLineup, venues } from "@pulse/db/schema";
import type { Event, EventLineupSlot, Venue } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { and, asc, desc, eq, gte, lt, lte, type SQL } from "drizzle-orm";
import { Data, Effect } from "effect";

import { metricVenueDetail, metricVenueEventsListed, metricVenueLineupListed } from "../metrics";
import { applyTransitions, DatabaseError } from "./events";

export class VenueNotFound extends Data.TaggedError("VenueNotFound")<{
  readonly orgHandle: string;
  readonly venueHandle: string;
}> {}

/** Thin pin projection for the map — no description/hours/image/website fields. */
export interface VenuePin {
  id: string;
  orgHandle: string;
  handle: string;
  name: string;
  kind: string;
  capacity: number | null;
  latitude: number | null;
  longitude: number | null;
}

export interface ListAllVenuesParams {
  minLat?: number;
  maxLat?: number;
  minLng?: number;
  maxLng?: number;
  limit?: number;
}

const VENUES_MAX_LIMIT = 100;
/**
 * No-bbox default. Deliberately the same as the ceiling: the point of this
 * change is that the query is BOUNDED, not that it returns fewer pins than
 * it did yesterday. A smaller default would silently drop venues off the
 * Explore map in the window between this landing and the client sending a
 * viewport.
 */
const VENUES_DEFAULT_LIMIT = VENUES_MAX_LIMIT;

/**
 * List venues for the map. Public surface — feeds the Explore map.
 *
 * Bounded whatever the caller sends: a hard ceiling on `limit`
 * (`VENUES_MAX_LIMIT`) plus a default (`VENUES_DEFAULT_LIMIT`) applied
 * even with no bbox, so the scan can never be unbounded again. When all
 * four corners are given, rows are filtered to the box; a bbox query
 * drops NULL-lat/lng venues (`BETWEEN`/`gte`+`lte` never match NULL) —
 * the no-bbox path still returns them.
 */
export const listAllVenues = (
  params: ListAllVenuesParams = {},
): Effect.Effect<VenuePin[], DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const filters: SQL[] = [];
    if (
      params.minLat !== undefined &&
      params.maxLat !== undefined &&
      params.minLng !== undefined &&
      params.maxLng !== undefined
    ) {
      filters.push(gte(venues.latitude, params.minLat));
      filters.push(lte(venues.latitude, params.maxLat));
      filters.push(gte(venues.longitude, params.minLng));
      filters.push(lte(venues.longitude, params.maxLng));
    }
    const limit =
      params.limit === undefined
        ? VENUES_DEFAULT_LIMIT
        : Math.min(Math.max(1, params.limit), VENUES_MAX_LIMIT);

    const rows = yield* Effect.tryPromise({
      try: (): Promise<VenuePin[]> =>
        db
          .select({
            id: venues.id,
            orgHandle: venues.orgHandle,
            handle: venues.handle,
            name: venues.name,
            kind: venues.kind,
            capacity: venues.capacity,
            latitude: venues.latitude,
            longitude: venues.longitude,
          })
          .from(venues)
          .where(filters.length > 0 ? and(...filters) : undefined)
          // A LIMIT with no ORDER BY lets SQLite return any subset it likes,
          // and a different one per call — the map would flicker between pin
          // sets on refresh. `id` is the only column guaranteed unique.
          .orderBy(asc(venues.id))
          .limit(limit) as Promise<VenuePin[]>,
      catch: (cause) => new DatabaseError({ cause }),
    }).pipe(Effect.tapError((e) => Effect.logError("venue.list_all failed", e)));
    return rows;
  }).pipe(Effect.withSpan("pulse.venue.list_all"));

/**
 * Fetch a single venue by (orgHandle, venueHandle).
 *
 * Venues are public — no viewer-scoped filtering. The metric records
 * the kind so we can spot a sudden spike in 404s on a particular venue
 * type (someone scraping handles).
 *
 * `recordMetric` defaults to false because this is also an internal
 * building block (`listVenueEvents`, the lineup gate) — only the
 * detail route passes true, so `pulse.venue.detail.*` counts page
 * views, not sub-queries. Internal callers stay observable via the
 * `pulse.venue.get` span.
 */
export const getVenue = (
  orgHandle: string,
  venueHandle: string,
  opts: { recordMetric?: boolean } = {},
): Effect.Effect<Venue, VenueNotFound | DatabaseError, Db> =>
  Effect.gen(function* () {
    const start = performance.now();
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: (): Promise<Venue[]> =>
        db
          .select()
          .from(venues)
          .where(and(eq(venues.orgHandle, orgHandle), eq(venues.handle, venueHandle)))
          .limit(1) as Promise<Venue[]>,
      catch: (cause) => new DatabaseError({ cause }),
    }).pipe(Effect.tapError((e) => Effect.logError("venue.get failed", e)));

    if (rows.length === 0) {
      if (opts.recordMetric) {
        metricVenueDetail(null, "error", (performance.now() - start) / 1000);
      }
      return yield* Effect.fail(new VenueNotFound({ orgHandle, venueHandle }));
    }
    const row = rows[0]!;
    if (opts.recordMetric) {
      metricVenueDetail(row.kind, "ok", (performance.now() - start) / 1000);
    }
    return row;
  }).pipe(Effect.withSpan("pulse.venue.get"));

/**
 * List a venue's programme. Defaults to upcoming + currently-running
 * events ordered by start time. Public events only — venue pages are
 * a discovery surface, so private events stay hidden even from a
 * signed-in viewer browsing the venue's URL.
 */
export const listVenueEvents = (
  orgHandle: string,
  venueHandle: string,
  opts: { scope?: "upcoming" | "past" | "all"; limit?: number } = {},
): Effect.Effect<Event[], VenueNotFound | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    // 404 the whole list when the venue does not exist so the frontend
    // can render "Venue not found" without a second request. Also gives
    // us the venue's internal id for the FK filter.
    const venue = yield* getVenue(orgHandle, venueHandle);

    const now = new Date();
    const scope = opts.scope ?? "upcoming";
    const limit = opts.limit ? Math.min(Math.max(1, opts.limit), 200) : 50;

    const filters = [eq(events.venueId, venue.id), eq(events.visibility, "public")];
    if (scope === "upcoming") filters.push(gte(events.startTime, now));
    else if (scope === "past") filters.push(lt(events.startTime, now));

    const rows = yield* Effect.tryPromise({
      try: (): Promise<Event[]> =>
        db
          .select()
          .from(events)
          .where(and(...filters))
          // Past nights read most-recent-first so LIMIT keeps the end of
          // the history callers actually want; upcoming reads soonest-first.
          .orderBy(scope === "past" ? desc(events.startTime) : asc(events.startTime))
          .limit(limit) as Promise<Event[]>,
      catch: (cause) => new DatabaseError({ cause }),
    }).pipe(Effect.tapError((e) => Effect.logError("venue.list_events failed", e)));

    // Surface auto-derived statuses (e.g. ongoing) — same treatment as
    // every other read path. Batched into one UPDATE per (from → to)
    // group (P-W5) instead of one write per stale row.
    const transitioned = yield* applyTransitions(rows);
    metricVenueEventsListed(scope, transitioned.length);
    return transitioned;
  }).pipe(Effect.withSpan("pulse.venue.list_events"));

/**
 * List the programmed lineup for a single event, ordered by slot start
 * time. No venue-existence check here — the caller already loaded the
 * event when it knew which slots to ask for.
 */
export const listEventLineup = (
  eventId: string,
): Effect.Effect<EventLineupSlot[], DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: (): Promise<EventLineupSlot[]> =>
        db
          .select()
          .from(eventLineup)
          .where(eq(eventLineup.eventId, eventId))
          .orderBy(asc(eventLineup.slotStart), asc(eventLineup.orderIndex)) as Promise<
          EventLineupSlot[]
        >,
      catch: (cause) => new DatabaseError({ cause }),
    }).pipe(Effect.tapError((e) => Effect.logError("venue.lineup.list failed", e)));
    metricVenueLineupListed(rows.length);
    return rows;
  }).pipe(Effect.withSpan("pulse.venue.lineup.list"));
