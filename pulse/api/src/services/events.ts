import { events, eventRsvps } from "@pulse/db/schema";
import type { Event } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { and, asc, eq, gte, inArray, lte, ne, type SQL } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";

import {
  MAX_PRICE_MAJOR,
  SUPPORTED_CURRENCIES,
  toMinorUnits,
  type SupportedCurrency,
} from "../lib/currency";
import {
  AUTO_CLOSE_NO_END_TIME_HOURS,
  MAX_EVENT_DURATION_HOURS,
  MAYBE_FINISHED_AFTER_HOURS,
} from "../lib/limits";
import {
  metricCalendarListed,
  metricEventCreated,
  metricEventDeleted,
  metricEventStatusTransition,
  metricEventStatusTransitionBatch,
  metricEventUpdated,
  metricEventValidationFailure,
  metricEventsListed,
} from "../metrics";
import {
  getCloseFriendIdsForViewer,
  DatabaseError as CloseFriendsDatabaseError,
} from "./closeFriends";
import { buildVisibilityFilter } from "./eventVisibility";

const MAX_EVENT_DURATION_MS = MAX_EVENT_DURATION_HOURS * 60 * 60 * 1000;
const MAYBE_FINISHED_AFTER_MS = MAYBE_FINISHED_AFTER_HOURS * 60 * 60 * 1000;
const AUTO_CLOSE_NO_END_TIME_MS = AUTO_CLOSE_NO_END_TIME_HOURS * 60 * 60 * 1000;

export class EventNotFound extends Data.TaggedError("EventNotFound")<{
  readonly id: string;
}> {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly cause: unknown;
}> {}

export class NotEventOwner extends Data.TaggedError("NotEventOwner")<{
  readonly id: string;
}> {}

const StatusEnum = Schema.Literal("upcoming", "ongoing", "maybe_finished", "finished", "cancelled");
const VisibilityEnum = Schema.Literal("public", "private");
const GuestListVisibilityEnum = Schema.Literal("public", "connections", "private");
const JoinPolicyEnum = Schema.Literal("open", "guest_list");
const CommsChannelSchema = Schema.Literal("sms", "email");
const CommsChannelsSchema = Schema.Array(CommsChannelSchema).pipe(
  Schema.minItems(1),
  Schema.filter((channels) => new Set(channels).size === channels.length, {
    message: () => "commsChannels must not contain duplicates",
  }),
);

// Schema.DateFromString in this Effect version allows Invalid Date — use a validated transform
const ValidDateString = Schema.String.pipe(Schema.filter((s) => !isNaN(new Date(s).getTime())));
const DateFromISOString = Schema.transform(ValidDateString, Schema.DateFromSelf, {
  strict: true,
  decode: (s) => new Date(s),
  encode: (d) => d.toISOString(),
});

const ValidUrl = Schema.String.pipe(Schema.filter((s) => URL.parse(s) !== null));

const LatitudeSchema = Schema.Number.pipe(Schema.between(-90, 90));
const LongitudeSchema = Schema.Number.pipe(Schema.between(-180, 180));

// Length caps on user-provided text fields. Without these, an
// authenticated user can POST an event with a 10MB description and bloat
// every discovery response that returns it. The numbers are deliberately
// generous — they cap abuse without constraining real events.
const TitleString = Schema.NonEmptyString.pipe(Schema.maxLength(200));
const DescriptionString = Schema.String.pipe(Schema.maxLength(5000));
const LocationString = Schema.String.pipe(Schema.maxLength(500));
const VenueString = Schema.String.pipe(Schema.maxLength(500));
const CategoryString = Schema.String.pipe(Schema.maxLength(100));

// Price input is a major-unit decimal (e.g. 18.50 USD). The service
// converts to minor units before INSERT. Cap at MAX_PRICE_MAJOR shared
// across all currencies.
const PriceAmountMajor = Schema.Number.pipe(
  Schema.between(0, MAX_PRICE_MAJOR, {
    message: () => `price must be between 0 and ${MAX_PRICE_MAJOR}`,
  }),
);
const CurrencySchema = Schema.Literal(...SUPPORTED_CURRENCIES);

// Enforce "both set or both null" invariant. `undefined` on both is fine
// (price not being changed); otherwise they must pair up.
const priceInvariant = <
  T extends { priceAmount?: number | null; priceCurrency?: SupportedCurrency | null },
>(
  s: T,
): boolean => {
  const amountProvided = "priceAmount" in s && s.priceAmount !== undefined;
  const currencyProvided = "priceCurrency" in s && s.priceCurrency !== undefined;
  if (amountProvided !== currencyProvided) return false;
  if (!amountProvided) return true;
  // Both provided — either both null (clear) or both non-null (set).
  return (s.priceAmount === null) === (s.priceCurrency === null);
};

const InsertEventSchema = Schema.Struct({
  title: TitleString,
  description: Schema.optional(DescriptionString),
  location: Schema.optional(LocationString),
  venue: Schema.optional(VenueString),
  latitude: Schema.optional(LatitudeSchema),
  longitude: Schema.optional(LongitudeSchema),
  category: Schema.optional(CategoryString),
  startTime: DateFromISOString,
  endTime: Schema.optional(DateFromISOString),
  status: Schema.optional(StatusEnum),
  imageUrl: Schema.optional(ValidUrl),
  visibility: Schema.optional(VisibilityEnum),
  guestListVisibility: Schema.optional(GuestListVisibilityEnum),
  joinPolicy: Schema.optional(JoinPolicyEnum),
  allowInterested: Schema.optional(Schema.Boolean),
  commsChannels: Schema.optional(CommsChannelsSchema),
  priceAmount: Schema.optional(Schema.NullOr(PriceAmountMajor)),
  priceCurrency: Schema.optional(Schema.NullOr(CurrencySchema)),
}).pipe(
  Schema.filter(priceInvariant, {
    message: () => "priceAmount and priceCurrency must both be set or both be null",
  }),
);

const UpdateEventSchema = Schema.Struct({
  title: Schema.optional(TitleString),
  description: Schema.optional(DescriptionString),
  location: Schema.optional(LocationString),
  venue: Schema.optional(VenueString),
  latitude: Schema.optional(LatitudeSchema),
  longitude: Schema.optional(LongitudeSchema),
  category: Schema.optional(CategoryString),
  startTime: Schema.optional(DateFromISOString),
  endTime: Schema.optional(DateFromISOString),
  status: Schema.optional(StatusEnum),
  imageUrl: Schema.optional(ValidUrl),
  visibility: Schema.optional(VisibilityEnum),
  guestListVisibility: Schema.optional(GuestListVisibilityEnum),
  joinPolicy: Schema.optional(JoinPolicyEnum),
  allowInterested: Schema.optional(Schema.Boolean),
  commsChannels: Schema.optional(CommsChannelsSchema),
  priceAmount: Schema.optional(Schema.NullOr(PriceAmountMajor)),
  priceCurrency: Schema.optional(Schema.NullOr(CurrencySchema)),
}).pipe(
  Schema.filter(priceInvariant, {
    message: () => "priceAmount and priceCurrency must both be set or both be null",
  }),
);

interface ListEventsParams {
  status?: "upcoming" | "ongoing" | "maybe_finished" | "finished" | "cancelled";
  category?: string;
  limit?: string;
  /**
   * If provided, the viewer's own private events stay visible while other
   * users' private events are filtered out. When omitted, ALL private
   * events are filtered out (discovery behaviour).
   */
  viewerId?: string | null;
}

const deriveStatus = (event: Event, now: Date): Event["status"] => {
  // Terminal states never transition automatically. "cancelled" and a
  // manually-set "finished" (organiser closed early) are sticky.
  if (event.status === "cancelled" || event.status === "finished") return event.status;
  const started = event.startTime <= now;
  if (!started) return "upcoming";

  // Explicit-endTime path: a single transition at endTime.
  if (event.endTime !== null) {
    return event.endTime <= now ? "finished" : "ongoing";
  }

  // No-endTime path: soft/hard ladder. The organiser agreed to a
  // best-effort ceiling by not setting an endTime. Guests see a
  // "maybe finished" label at 8h, and the event auto-closes at 12h
  // (see AUTO_CLOSE_NO_END_TIME_HOURS) so open-ended events don't
  // linger as "ongoing" forever.
  const elapsedMs = now.getTime() - event.startTime.getTime();
  if (elapsedMs >= AUTO_CLOSE_NO_END_TIME_MS) return "finished";
  if (elapsedMs >= MAYBE_FINISHED_AFTER_MS) return "maybe_finished";
  return "ongoing";
};

export const applyTransition = (event: Event): Effect.Effect<Event, DatabaseError, Db> => {
  const now = new Date();
  const derived = deriveStatus(event, now);
  if (derived === event.status) return Effect.succeed(event);

  // "maybe_finished" is a display-only projection for no-endTime events
  // between MAYBE_FINISHED_AFTER_HOURS and AUTO_CLOSE_NO_END_TIME_HOURS
  // past startTime. We don't persist it so a no-endTime event's
  // lifecycle path is a single DB write (ongoing → finished at 12h)
  // instead of two (ongoing → maybe_finished at 8h → finished at 12h).
  // Callers still see the derived status on read; `status_transitions`
  // only fires on persisted transitions.
  if (derived === "maybe_finished") {
    return Effect.succeed({ ...event, status: derived });
  }

  const previous = event.status;
  return Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.tryPromise({
      try: () =>
        db.update(events).set({ status: derived, updatedAt: now }).where(eq(events.id, event.id)),
      catch: (cause) => new DatabaseError({ cause }),
    });
    metricEventStatusTransition(previous, derived);
    return { ...event, status: derived, updatedAt: now };
  }).pipe(
    Effect.withSpan("events.apply_transition", {
      attributes: { "event.from": previous, "event.to": derived },
    }),
  );
};

/**
 * Batch variant of {@link applyTransition} for the list read paths
 * (P-W5 / P-W1). The per-row version issues one `UPDATE` per
 * transitioning event, so a page of N stale rows costs N writes.
 * This helper derives every row's status with a single `now`, groups
 * the rows that need persisting by their (fromStatus → toStatus) pair,
 * and issues ONE `UPDATE events SET status = ? WHERE id IN (…)` per
 * group — at most a handful of writes per page regardless of N.
 *
 * Semantics are identical to mapping `applyTransition` over the rows:
 *   - terminal / unchanged rows are returned as-is,
 *   - "maybe_finished" stays a display-only projection (never persisted),
 *   - persisted transitions stamp `updatedAt` and fire the
 *     `status_transitions` counter once per event (batched `add(count)`),
 *   - each group carries the same "events.apply_transition" span with
 *     the same from/to attributes.
 *
 * Row order is preserved in the returned array.
 */
export const applyTransitions = (
  rows: readonly Event[],
): Effect.Effect<Event[], DatabaseError, Db> => {
  const now = new Date();
  const derivedRows = rows.map((event) => ({ event, derived: deriveStatus(event, now) }));

  const groups = new Map<string, { from: Event["status"]; to: Event["status"]; ids: string[] }>();
  for (const { event, derived } of derivedRows) {
    // Display-only projection — see applyTransition for the rationale.
    if (derived === event.status || derived === "maybe_finished") continue;
    const key = `${event.status}→${derived}`;
    const group = groups.get(key) ?? { from: event.status, to: derived, ids: [] };
    group.ids.push(event.id);
    groups.set(key, group);
  }

  const project = (): Event[] =>
    derivedRows.map(({ event, derived }) => {
      if (derived === event.status) return event;
      if (derived === "maybe_finished") return { ...event, status: derived };
      return { ...event, status: derived, updatedAt: now };
    });

  if (groups.size === 0) return Effect.sync(project);

  return Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.forEach(
      [...groups.values()],
      ({ from, to, ids }) =>
        Effect.tryPromise({
          try: () =>
            db.update(events).set({ status: to, updatedAt: now }).where(inArray(events.id, ids)),
          catch: (cause) => new DatabaseError({ cause }),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => metricEventStatusTransitionBatch(from, to, ids.length)),
          ),
          Effect.withSpan("events.apply_transition", {
            attributes: { "event.from": from, "event.to": to },
          }),
        ),
      { concurrency: 1 },
    );
    return project();
  });
};

export const listEvents = (
  params: ListEventsParams,
): Effect.Effect<Event[], DatabaseError | CloseFriendsDatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const filters: SQL[] = [];

    if (params.status) {
      filters.push(eq(events.status, params.status));
    }

    if (params.category) {
      filters.push(eq(events.category, params.category));
    }

    // Discovery rule: private events are filtered at the SQL layer so
    // (a) the page size returned to the client is stable (post-filtering
    // in JS would silently shrink the page), and (b) the
    // `events_visibility_start_time_idx` index actually gets used.
    // Shared predicate with `discoverEvents` and `canViewEvent` — any
    // divergence re-opens the S-H12..S-H16 regression class.
    filters.push(buildVisibilityFilter(params.viewerId ?? null));

    const results = yield* Effect.tryPromise({
      try: (): Promise<Event[]> =>
        db
          .select()
          .from(events)
          .where(filters.length > 0 ? and(...filters) : undefined)
          .orderBy(events.startTime)
          .limit(params.limit ? Math.min(Math.max(1, Number(params.limit)), 100) : 20) as Promise<
          Event[]
        >,
      catch: (cause) => new DatabaseError({ cause }),
    });

    // Run the batched transition writer and the viewer's close-friends
    // lookup in parallel — neither depends on the other (P-W1).
    // Transitions are grouped into one UPDATE per (from → to) pair
    // (P-W5) instead of one write per stale row.
    const [transitioned, closeFriendIds] = yield* Effect.all(
      [
        applyTransitions(results),
        params.viewerId
          ? getCloseFriendIdsForViewer(params.viewerId)
          : Effect.succeed(new Set<string>()),
      ] as const,
      { concurrency: "unbounded" },
    );

    // Feed boost: events organised by a close friend of the viewer surface
    // first. Stable partition preserves the underlying startTime ordering
    // within each bucket, so the feed remains chronological within each
    // group rather than reshuffling the whole list.
    let ranked: Event[];
    if (closeFriendIds.size === 0) {
      ranked = transitioned;
    } else {
      const friends: Event[] = [];
      const others: Event[] = [];
      for (const event of transitioned) {
        if (closeFriendIds.has(event.createdByProfileId)) friends.push(event);
        else others.push(event);
      }
      ranked = [...friends, ...others];
    }

    metricEventsListed("all", ranked.length);
    return ranked;
  }).pipe(Effect.withSpan("events.list"));

/**
 * P-W3: DB-level cap on the "today" feed. The route exposes no limit
 * param, so a fixed ceiling bounds the page instead — 200 matches the
 * hard ceiling used by `listRsvps`/`listVenueEvents` and is double
 * `listEvents`' 100 max, since a whole day can legitimately hold more
 * rows than a single discovery page.
 */
const TODAY_EVENTS_LIMIT = 200;

export const listTodayEvents: Effect.Effect<Event[], DatabaseError, Db> = Effect.gen(function* () {
  const { db } = yield* Db;
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

  const results = yield* Effect.tryPromise({
    try: (): Promise<Event[]> =>
      db
        .select()
        .from(events)
        .where(and(gte(events.startTime, startOfDay), lte(events.startTime, endOfDay)))
        .orderBy(events.startTime)
        .limit(TODAY_EVENTS_LIMIT) as Promise<Event[]>,
    catch: (cause) => new DatabaseError({ cause }),
  });

  // Batched status-transition writer (P-W5) — see applyTransitions.
  const transitioned = yield* applyTransitions(results);
  metricEventsListed("today", transitioned.length);
  return transitioned;
}).pipe(Effect.withSpan("events.list_today"));

/**
 * One row of the personal calendar: an event the viewer is going to /
 * marked maybe / is hosting, plus the viewer's own RSVP status so the UI
 * can prompt "maybe" replies to confirm.
 */
export interface CalendarEntry {
  event: Event;
  /** Viewer's own RSVP status, narrowed to the two attending states. */
  myStatus: "going" | "maybe" | null;
  isHost: boolean;
}

/**
 * The viewer's forward-looking agenda: every non-cancelled event starting
 * today or later that they are hosting OR have RSVP'd going / maybe to,
 * ordered chronologically. No visibility filter is needed — a host or an
 * RSVP'd attendee can always see the event by definition (see
 * `canViewEvent`). Today's already-finished events still belong on the
 * day's agenda, so we bound only on `startTime`, not the derived status.
 *
 * P-W1: split into two index-friendly arms instead of one OR query
 * spanning both tables. The original `events.createdBy = viewer OR
 * rsvp.status IN (…)` shape couldn't be satisfied by any single index,
 * so SQLite range-scanned every upcoming event globally before
 * filtering — cost scaled with total event volume, not per-user data.
 * Each arm here seeks on the viewer as a high-selectivity constant:
 *   • Hosted    → `events_created_by_profile_id_idx`
 *   • Attending → `event_rsvps_profile_event_idx` (profileId leading)
 * Each fetches up to `limit` rows in start-time order, the two results
 * are merged + deduped (attending wins so `myStatus` is preserved) +
 * sliced. The merged prefix of `limit` is provably the correct top-N
 * because each arm returned its earliest-startTime rows.
 */
export const listMyCalendarEvents = (
  viewerId: string,
  options: { limit?: number } = {},
): Effect.Effect<CalendarEntry[], DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const limit =
      options.limit != null && Number.isFinite(options.limit)
        ? Math.min(Math.max(1, options.limit), 100)
        : 50;
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [hostedRows, attendingRows] = yield* Effect.all(
      [
        Effect.tryPromise({
          try: (): Promise<Event[]> =>
            db
              .select()
              .from(events)
              .where(
                and(
                  eq(events.createdByProfileId, viewerId),
                  gte(events.startTime, startOfDay),
                  ne(events.status, "cancelled"),
                ),
              )
              .orderBy(asc(events.startTime), asc(events.id))
              .limit(limit) as Promise<Event[]>,
          catch: (cause) => new DatabaseError({ cause }),
        }),
        Effect.tryPromise({
          try: (): Promise<{ event: Event; rsvpStatus: "going" | "maybe" }[]> =>
            db
              .select({ event: events, rsvpStatus: eventRsvps.status })
              .from(eventRsvps)
              .innerJoin(events, eq(events.id, eventRsvps.eventId))
              .where(
                and(
                  eq(eventRsvps.profileId, viewerId),
                  inArray(eventRsvps.status, ["going", "maybe"]),
                  gte(events.startTime, startOfDay),
                  ne(events.status, "cancelled"),
                ),
              )
              .orderBy(asc(events.startTime), asc(events.id))
              .limit(limit) as Promise<{ event: Event; rsvpStatus: "going" | "maybe" }[]>,
          catch: (cause) => new DatabaseError({ cause }),
        }),
      ] as const,
      { concurrency: "unbounded" },
    );

    // Dedupe by event id. Hosted-arm rows carry no rsvp info; attending-
    // arm rows carry myStatus — when an event surfaces in both arms (host
    // RSVP'd to own event), the attending row wins so myStatus survives.
    const byId = new Map<string, { event: Event; myStatus: "going" | "maybe" | null }>();
    for (const event of hostedRows) byId.set(event.id, { event, myStatus: null });
    for (const row of attendingRows) {
      byId.set(row.event.id, { event: row.event, myStatus: row.rsvpStatus });
    }

    const merged = [...byId.values()]
      .toSorted((a, b) => {
        const ta = a.event.startTime.getTime();
        const tb = b.event.startTime.getTime();
        if (ta !== tb) return ta - tb;
        return a.event.id < b.event.id ? -1 : 1;
      })
      .slice(0, limit);

    // Apply lifecycle transitions so the calendar shows accurate
    // ongoing/finished labels. Batched into one UPDATE per (from → to)
    // group (P-W5) — applyTransitions preserves row order, so the
    // parallel myStatus array zips back by index.
    const transitionedEvents = yield* applyTransitions(merged.map((m) => m.event));
    const entries = transitionedEvents.map(
      (e, i): CalendarEntry => ({
        event: e,
        myStatus: merged[i]!.myStatus,
        isHost: e.createdByProfileId === viewerId,
      }),
    );

    metricCalendarListed(entries.length);
    return entries;
  }).pipe(Effect.withSpan("pulse.calendar.list_mine"));

export const getEvent = (id: string): Effect.Effect<Event, EventNotFound | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    const result = yield* Effect.tryPromise({
      try: (): Promise<Event[]> =>
        db.select().from(events).where(eq(events.id, id)).limit(1) as Promise<Event[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });

    if (result.length === 0) {
      return yield* Effect.fail(new EventNotFound({ id }));
    }

    return yield* applyTransition(result[0]!);
  }).pipe(Effect.withSpan("events.get"));

interface CreatorInfo {
  createdByProfileId: string;
  createdByName: string | null;
  createdByAvatar: string | null;
}

export const createEvent = (
  data: unknown,
  creator: CreatorInfo,
): Effect.Effect<Event, ValidationError | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    const validated = yield* Schema.decodeUnknown(InsertEventSchema)(data).pipe(
      Effect.tapError(() => Effect.sync(() => metricEventValidationFailure("create", "schema"))),
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    const id = "evt_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date();

    if (validated.startTime.getTime() <= now.getTime()) {
      metricEventValidationFailure("create", "past_start_time");
      return yield* Effect.fail(new ValidationError({ cause: "startTime must be in the future" }));
    }

    if (
      validated.endTime &&
      validated.endTime.getTime() - validated.startTime.getTime() > MAX_EVENT_DURATION_MS
    ) {
      metricEventValidationFailure("create", "duration_exceeds_max");
      return yield* Effect.fail(
        new ValidationError({
          cause: `event duration must not exceed ${MAX_EVENT_DURATION_HOURS} hours`,
        }),
      );
    }

    // Serialise the commsChannels array to JSON text for the DB column.
    // The schema default is `'["email"]'` so only overwrite when the
    // caller explicitly provided a value.
    const { commsChannels, priceAmount, priceCurrency, ...rest } = validated;
    const priceFields =
      priceAmount != null && priceCurrency != null
        ? { priceAmount: toMinorUnits(priceAmount, priceCurrency), priceCurrency }
        : priceAmount === null && priceCurrency === null
          ? { priceAmount: null, priceCurrency: null }
          : {};
    const row = {
      ...rest,
      ...creator,
      id,
      createdAt: now,
      updatedAt: now,
      ...(commsChannels ? { commsChannels: JSON.stringify(commsChannels) } : {}),
      ...priceFields,
    };

    // P-I7: RETURNING * gives back the full row (incl. column defaults)
    // in the same round-trip, replacing the previous INSERT + getEvent
    // pair. applyTransition is kept so a caller-supplied status is still
    // normalised exactly as the old read-back path did.
    const inserted = yield* Effect.tryPromise({
      try: (): Promise<Event[]> => db.insert(events).values(row).returning() as Promise<Event[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (inserted.length === 0) {
      return yield* Effect.fail(new DatabaseError({ cause: "insert returned no row" }));
    }

    const result = yield* applyTransition(inserted[0]!);
    metricEventCreated(result.category, result.endTime !== null);
    return result;
  }).pipe(Effect.withSpan("events.create"));

export const updateEvent = (
  id: string,
  data: unknown,
  requestingProfileId: string | null = null,
): Effect.Effect<Event, EventNotFound | NotEventOwner | ValidationError | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    const existing = yield* getEvent(id);
    if (existing.createdByProfileId !== requestingProfileId) {
      metricEventUpdated("forbidden");
      return yield* Effect.fail(new NotEventOwner({ id }));
    }

    const validated = yield* Schema.decodeUnknown(UpdateEventSchema)(data).pipe(
      Effect.tapError(() => Effect.sync(() => metricEventValidationFailure("update", "schema"))),
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    // Compute the effective times that the event will have after this
    // patch lands, so that patching only `endTime` still validates
    // against the stored `startTime` (and vice versa).
    const effectiveStart = validated.startTime ?? existing.startTime;
    const effectiveEnd = validated.endTime ?? existing.endTime;
    if (effectiveEnd && effectiveEnd.getTime() - effectiveStart.getTime() > MAX_EVENT_DURATION_MS) {
      metricEventValidationFailure("update", "duration_exceeds_max");
      return yield* Effect.fail(
        new ValidationError({
          cause: `event duration must not exceed ${MAX_EVENT_DURATION_HOURS} hours`,
        }),
      );
    }

    const now = new Date();
    const { commsChannels, priceAmount, priceCurrency, ...rest } = validated;
    const priceFields =
      priceAmount != null && priceCurrency != null
        ? { priceAmount: toMinorUnits(priceAmount, priceCurrency), priceCurrency }
        : priceAmount === null && priceCurrency === null
          ? { priceAmount: null, priceCurrency: null }
          : {};
    // If this event is part of a series, flag it as a single-instance
    // divergence so subsequent series-level bulk updates skip it.
    const overrideFlag = existing.seriesId ? { instanceOverride: true as const } : {};
    const update = {
      ...rest,
      ...overrideFlag,
      updatedAt: now,
      ...(commsChannels ? { commsChannels: JSON.stringify(commsChannels) } : {}),
      ...priceFields,
    };
    yield* Effect.tryPromise({
      try: () => db.update(events).set(update).where(eq(events.id, id)),
      catch: (cause) => new DatabaseError({ cause }),
    });

    // Build the updated event in-memory rather than re-fetching from DB.
    // applyTransition is still called in case startTime/endTime changed.
    const updated = { ...existing, ...update } as Event;
    const result = yield* applyTransition(updated);
    metricEventUpdated("ok");
    return result;
  }).pipe(Effect.withSpan("events.update"));

export const deleteEvent = (
  id: string,
  requestingProfileId: string | null = null,
): Effect.Effect<void, EventNotFound | NotEventOwner | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    const existing = yield* getEvent(id);
    if (existing.createdByProfileId !== requestingProfileId) {
      metricEventDeleted("forbidden");
      return yield* Effect.fail(new NotEventOwner({ id }));
    }

    yield* Effect.tryPromise({
      try: () => db.delete(events).where(eq(events.id, id)),
      catch: (cause) => new DatabaseError({ cause }),
    });
    metricEventDeleted("ok");
  }).pipe(Effect.withSpan("events.delete"));
