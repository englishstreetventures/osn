import { Data, Effect } from "effect";
import { and, eq, gte, lte, type SQL } from "drizzle-orm";
import { events } from "@osn/db";
import type { Event } from "@osn/db/schema";
import { Db } from "@osn/db/service";

export class EventNotFound extends Data.TaggedError("EventNotFound")<{
  readonly id: string;
}> {}

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

interface ListEventsParams {
  status?: "upcoming" | "ongoing" | "finished" | "cancelled";
  category?: string;
  upcoming?: string;
  limit?: string;
}

export const listEvents = (params: ListEventsParams): Effect.Effect<Event[], DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const now = new Date();
    const filters: SQL[] = [];

    if (params.status) {
      filters.push(eq(events.status, params.status));
    }

    if (params.category) {
      filters.push(eq(events.category, params.category));
    }

    if (params.upcoming !== "false") {
      filters.push(gte(events.startTime, now));
    }

    return yield* Effect.tryPromise({
      try: (): Promise<Event[]> =>
        db
          .select()
          .from(events)
          .where(filters.length > 0 ? and(...filters) : undefined)
          .orderBy(events.startTime)
          .limit(params.limit ? Number(params.limit) : 20) as Promise<Event[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
  });

export const listTodayEvents: Effect.Effect<Event[], DatabaseError, Db> = Effect.gen(function* () {
  const { db } = yield* Db;
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

  return yield* Effect.tryPromise({
    try: (): Promise<Event[]> =>
      db
        .select()
        .from(events)
        .where(and(gte(events.startTime, startOfDay), lte(events.startTime, endOfDay)))
        .orderBy(events.startTime) as Promise<Event[]>,
    catch: (cause) => new DatabaseError({ cause }),
  });
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

    return result[0]!;
  });
