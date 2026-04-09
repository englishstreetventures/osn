import { Data, Effect, Schema } from "effect";
import { desc, eq } from "drizzle-orm";
import { eventComms, type EventComm, events, type Event } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { metricCommsBlastSent } from "../metrics";
import { EventNotFound } from "./events";

export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly cause: unknown;
}> {}

export class NotEventOwner extends Data.TaggedError("NotEventOwner")<{
  readonly eventId: string;
}> {}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const CommsChannelSchema = Schema.Literal("sms", "email");
export type CommsChannel = Schema.Schema.Type<typeof CommsChannelSchema>;

export const CommsChannelsSchema = Schema.Array(CommsChannelSchema).pipe(
  Schema.minItems(1),
  Schema.filter((channels) => new Set(channels).size === channels.length, {
    message: () => "commsChannels must not contain duplicates",
  }),
);

const SendBlastSchema = Schema.Struct({
  channels: CommsChannelsSchema,
  body: Schema.NonEmptyString.pipe(Schema.maxLength(1600)),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const genCommId = () => "evtcomm_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);

const loadEvent = (eventId: string): Effect.Effect<Event, EventNotFound | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: (): Promise<Event[]> =>
        db.select().from(events).where(eq(events.id, eventId)).limit(1) as Promise<Event[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
    if (rows.length === 0) {
      return yield* Effect.fail(new EventNotFound({ id: eventId }));
    }
    return rows[0]!;
  });

/**
 * Parses the JSON-encoded commsChannels column. Falls back to ["email"] on
 * malformed input rather than throwing — the column default is safe and
 * anything else is an invariant violation we don't want to block reads on.
 */
export const parseCommsChannels = (raw: string | null): CommsChannel[] => {
  if (!raw) return ["email"];
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((c) => c === "sms" || c === "email") &&
      parsed.length > 0
    ) {
      return parsed as CommsChannel[];
    }
  } catch {
    // fall through
  }
  return ["email"];
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Records a blast in the append-only log. The actual sending is STUBBED —
 * `sentAt` is filled immediately with the current timestamp; no external
 * SMS/email provider is invoked. When real providers land, this function
 * becomes a queue write and delivery confirmation fills `sentAt` later.
 *
 * Only the organiser may blast.
 */
export const sendBlast = (
  eventId: string,
  organiserId: string,
  data: unknown,
): Effect.Effect<
  { blasts: EventComm[] },
  EventNotFound | NotEventOwner | ValidationError | DatabaseError,
  Db
> =>
  Effect.gen(function* () {
    const validated = yield* Schema.decodeUnknown(SendBlastSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    const event = yield* loadEvent(eventId);
    if (event.createdByUserId !== organiserId) {
      return yield* Effect.fail(new NotEventOwner({ eventId }));
    }

    const { db } = yield* Db;
    const now = new Date();
    const rows: EventComm[] = validated.channels.map((channel) => ({
      id: genCommId(),
      eventId,
      channel,
      body: validated.body,
      sentByUserId: organiserId,
      sentAt: now,
      createdAt: now,
    }));

    yield* Effect.tryPromise({
      try: () => db.insert(eventComms).values(rows),
      catch: (cause) => new DatabaseError({ cause }),
    });

    // STUB: when SMS/email providers land, dispatch here. Intentionally
    // no logging — blast bodies frequently contain venue codes,
    // addresses, or codes that should not land in stdout / log
    // aggregation systems. Tests cover the contract directly via the
    // returned `blasts` array.

    // One counter increment per channel — a multi-channel blast counts
    // as one write per channel in dashboards.
    const bodyBytes = new TextEncoder().encode(validated.body).length;
    for (const row of rows) {
      metricCommsBlastSent(row.channel, bodyBytes, "ok");
    }

    return { blasts: rows };
  }).pipe(Effect.withSpan("comms.blast.send"));

/**
 * Returns the most recent N blasts for an event (any channel). Used by the
 * `CommsSummary` component on the event detail page.
 */
export const listBlasts = (
  eventId: string,
  limit = 10,
): Effect.Effect<EventComm[], EventNotFound | DatabaseError, Db> =>
  Effect.gen(function* () {
    yield* loadEvent(eventId); // 404 if missing
    const { db } = yield* Db;
    const clamped = Math.min(Math.max(1, limit), 50);
    return yield* Effect.tryPromise({
      try: (): Promise<EventComm[]> =>
        db
          .select()
          .from(eventComms)
          .where(eq(eventComms.eventId, eventId))
          .orderBy(desc(eventComms.createdAt))
          .limit(clamped) as Promise<EventComm[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });
  }).pipe(Effect.withSpan("comms.blast.list"));
