import { Data, Effect, Schema } from "effect";
import { and, eq, gte, lte, type SQL } from "drizzle-orm";
import { events } from "@pulse/db/schema";
import type { Event } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";

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

const StatusEnum = Schema.Literal("upcoming", "ongoing", "finished", "cancelled");

// Schema.DateFromString in this Effect version allows Invalid Date — use a validated transform
const ValidDateString = Schema.String.pipe(Schema.filter((s) => !isNaN(new Date(s).getTime())));
const DateFromISOString = Schema.transform(ValidDateString, Schema.DateFromSelf, {
  strict: true,
  decode: (s) => new Date(s),
  encode: (d) => d.toISOString(),
});

const ValidUrl = Schema.String.pipe(
  Schema.filter((s) => {
    try {
      new URL(s);
      return true;
    } catch {
      return false;
    }
  }),
);

const LatitudeSchema = Schema.Number.pipe(Schema.between(-90, 90));
const LongitudeSchema = Schema.Number.pipe(Schema.between(-180, 180));

const InsertEventSchema = Schema.Struct({
  title: Schema.NonEmptyString,
  description: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  venue: Schema.optional(Schema.String),
  latitude: Schema.optional(LatitudeSchema),
  longitude: Schema.optional(LongitudeSchema),
  category: Schema.optional(Schema.String),
  startTime: DateFromISOString,
  endTime: Schema.optional(DateFromISOString),
  status: Schema.optional(StatusEnum),
  imageUrl: Schema.optional(ValidUrl),
});

const UpdateEventSchema = Schema.Struct({
  title: Schema.optional(Schema.NonEmptyString),
  description: Schema.optional(Schema.String),
  location: Schema.optional(Schema.String),
  venue: Schema.optional(Schema.String),
  latitude: Schema.optional(LatitudeSchema),
  longitude: Schema.optional(LongitudeSchema),
  category: Schema.optional(Schema.String),
  startTime: Schema.optional(DateFromISOString),
  endTime: Schema.optional(DateFromISOString),
  status: Schema.optional(StatusEnum),
  imageUrl: Schema.optional(ValidUrl),
});

interface ListEventsParams {
  status?: "upcoming" | "ongoing" | "finished" | "cancelled";
  category?: string;
  limit?: string;
}

const deriveStatus = (event: Event, now: Date): Event["status"] => {
  if (event.status === "cancelled" || event.status === "finished") return event.status;
  const started = event.startTime <= now;
  const ended = event.endTime !== null && event.endTime <= now;
  if (ended) return "finished";
  if (started) return "ongoing";
  return "upcoming";
};

export const applyTransition = (event: Event): Effect.Effect<Event, DatabaseError, Db> => {
  const now = new Date();
  const derived = deriveStatus(event, now);
  if (derived === event.status) return Effect.succeed(event);
  return Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.tryPromise({
      try: () =>
        db.update(events).set({ status: derived, updatedAt: now }).where(eq(events.id, event.id)),
      catch: (cause) => new DatabaseError({ cause }),
    });
    return { ...event, status: derived, updatedAt: now };
  });
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

    return yield* Effect.forEach(results, applyTransition, { concurrency: "unbounded" });
  });

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

  return yield* Effect.forEach(results, applyTransition, { concurrency: "unbounded" });
});

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
  });

interface CreatorInfo {
  createdByUserId: string;
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
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    const id = "evt_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date();

    if (validated.startTime.getTime() <= now.getTime()) {
      return yield* Effect.fail(new ValidationError({ cause: "startTime must be in the future" }));
    }

    yield* Effect.tryPromise({
      try: () =>
        db.insert(events).values({ ...validated, ...creator, id, createdAt: now, updatedAt: now }),
      catch: (cause) => new DatabaseError({ cause }),
    });

    return yield* getEvent(id).pipe(
      Effect.mapError((e) => (e instanceof EventNotFound ? new DatabaseError({ cause: e }) : e)),
    );
  });

export const updateEvent = (
  id: string,
  data: unknown,
  requestingUserId: string | null = null,
): Effect.Effect<Event, EventNotFound | NotEventOwner | ValidationError | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    const existing = yield* getEvent(id);
    if (existing.createdByUserId !== requestingUserId) {
      return yield* Effect.fail(new NotEventOwner({ id }));
    }

    const validated = yield* Schema.decodeUnknown(UpdateEventSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    const now = new Date();
    yield* Effect.tryPromise({
      try: () =>
        db
          .update(events)
          .set({ ...validated, updatedAt: now })
          .where(eq(events.id, id)),
      catch: (cause) => new DatabaseError({ cause }),
    });

    // Build the updated event in-memory rather than re-fetching from DB.
    // applyTransition is still called in case startTime/endTime changed.
    const updated = { ...existing, ...validated, updatedAt: now } as Event;
    return yield* applyTransition(updated);
  });

export const deleteEvent = (
  id: string,
  requestingUserId: string | null = null,
): Effect.Effect<void, EventNotFound | NotEventOwner | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    const existing = yield* getEvent(id);
    if (existing.createdByUserId !== requestingUserId) {
      return yield* Effect.fail(new NotEventOwner({ id }));
    }

    yield* Effect.tryPromise({
      try: () => db.delete(events).where(eq(events.id, id)),
      catch: (cause) => new DatabaseError({ cause }),
    });
  });
