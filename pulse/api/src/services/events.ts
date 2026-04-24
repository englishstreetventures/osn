import { events } from "@pulse/db/schema";
import type { Event } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { and, eq, gte, lte, or, type SQL } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";

import {
  AUTO_CLOSE_NO_END_TIME_HOURS,
  MAX_EVENT_DURATION_HOURS,
  MAYBE_FINISHED_AFTER_HOURS,
} from "../lib/limits";
import {
  metricEventCreated,
  metricEventDeleted,
  metricEventStatusTransition,
  metricEventUpdated,
  metricEventValidationFailure,
  metricEventsListed,
} from "../metrics";

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
});

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
});

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

export const listEvents = (params: ListEventsParams): Effect.Effect<Event[], DatabaseError, Db> =>
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
    // `events_visibility_idx` index actually gets used.
    //
    // The viewer's own private events stay visible so they can manage
    // them. A future enhancement will also include events the viewer
    // has been invited to (requires a join with event_rsvps).
    const visibilityFilter = params.viewerId
      ? or(eq(events.visibility, "public"), eq(events.createdByProfileId, params.viewerId))
      : eq(events.visibility, "public");
    if (visibilityFilter) filters.push(visibilityFilter);

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

    // Bounded concurrency: 5 is enough parallelism to hide DB round-trip
    // latency but avoids unleashing a burst of N in-flight UPDATEs (and
    // N child spans) against SQLite for a page-size of 100 results.
    const transitioned = yield* Effect.forEach(results, applyTransition, {
      concurrency: 5,
    });
    metricEventsListed("all", transitioned.length);
    return transitioned;
  }).pipe(Effect.withSpan("events.list"));

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
        .orderBy(events.startTime) as Promise<Event[]>,
    catch: (cause) => new DatabaseError({ cause }),
  });

  // Bounded concurrency (see listEvents for the rationale).
  const transitioned = yield* Effect.forEach(results, applyTransition, {
    concurrency: 5,
  });
  metricEventsListed("today", transitioned.length);
  return transitioned;
}).pipe(Effect.withSpan("events.list_today"));

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
    const { commsChannels, ...rest } = validated;
    const row = {
      ...rest,
      ...creator,
      id,
      createdAt: now,
      updatedAt: now,
      ...(commsChannels ? { commsChannels: JSON.stringify(commsChannels) } : {}),
    };

    yield* Effect.tryPromise({
      try: () => db.insert(events).values(row),
      catch: (cause) => new DatabaseError({ cause }),
    });

    const result = yield* getEvent(id).pipe(
      Effect.mapError((e) => (e instanceof EventNotFound ? new DatabaseError({ cause: e }) : e)),
    );
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
    const { commsChannels, ...rest } = validated;
    const update = {
      ...rest,
      updatedAt: now,
      ...(commsChannels ? { commsChannels: JSON.stringify(commsChannels) } : {}),
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
