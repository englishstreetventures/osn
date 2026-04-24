import { events, eventSeries } from "@pulse/db/schema";
import type { Event, EventSeries, NewEvent, NewEventSeries } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { and, eq, gt, gte, inArray, lt, or } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";

import {
  metricSeriesCancelled,
  metricSeriesCreated,
  metricSeriesInstancesMaterialized,
  metricSeriesRruleRejected,
  metricSeriesUpdated,
} from "../metrics";
import { applyTransition, DatabaseError, NotEventOwner, ValidationError } from "./events";

/** Hard cap on how many instance rows a single series can materialize. */
export const MAX_SERIES_INSTANCES = 260; // weekly × 5yr

export class SeriesNotFound extends Data.TaggedError("SeriesNotFound")<{
  readonly id: string;
}> {}

export class SeriesRRuleInvalid extends Data.TaggedError("SeriesRRuleInvalid")<{
  readonly reason:
    | "unsupported_freq"
    | "too_many_instances"
    | "missing_termination"
    | "parse_error";
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Reduced-grammar RRULE parser + expander
// ---------------------------------------------------------------------------

const WEEKDAY_INDEX: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export interface ParsedRRule {
  freq: "WEEKLY" | "MONTHLY";
  interval: number;
  byDay: number[] | null; // day-of-week indices 0..6; null = derive from dtstart
  count: number | null;
  until: Date | null;
}

/**
 * Parses a reduced-grammar RRULE string.
 *
 * Supported: `FREQ=WEEKLY|MONTHLY`, `INTERVAL`, `BYDAY` (WEEKLY only),
 * `COUNT`, `UNTIL` (ISO-8601). Anything else is rejected.
 */
export const parseRRule = (input: string): Effect.Effect<ParsedRRule, SeriesRRuleInvalid> =>
  Effect.gen(function* () {
    const parts = input
      .trim()
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) {
      metricSeriesRruleRejected("parse_error");
      return yield* Effect.fail(
        new SeriesRRuleInvalid({ reason: "parse_error", message: "RRULE is empty" }),
      );
    }
    const kv: Record<string, string> = {};
    for (const part of parts) {
      const [k, v] = part.split("=");
      if (!k || v == null) {
        metricSeriesRruleRejected("parse_error");
        return yield* Effect.fail(
          new SeriesRRuleInvalid({
            reason: "parse_error",
            message: `Malformed RRULE segment: ${part}`,
          }),
        );
      }
      kv[k.toUpperCase()] = v;
    }

    const freqRaw = kv.FREQ;
    if (freqRaw !== "WEEKLY" && freqRaw !== "MONTHLY") {
      metricSeriesRruleRejected("unsupported_freq");
      return yield* Effect.fail(
        new SeriesRRuleInvalid({
          reason: "unsupported_freq",
          message: `FREQ must be WEEKLY or MONTHLY, got "${freqRaw ?? "missing"}"`,
        }),
      );
    }

    const interval = kv.INTERVAL ? Number(kv.INTERVAL) : 1;
    if (!Number.isInteger(interval) || interval < 1 || interval > 52) {
      metricSeriesRruleRejected("parse_error");
      return yield* Effect.fail(
        new SeriesRRuleInvalid({
          reason: "parse_error",
          message: "INTERVAL must be an integer in [1, 52]",
        }),
      );
    }

    let byDay: number[] | null = null;
    if (kv.BYDAY != null) {
      if (freqRaw !== "WEEKLY") {
        metricSeriesRruleRejected("parse_error");
        return yield* Effect.fail(
          new SeriesRRuleInvalid({
            reason: "parse_error",
            message: "BYDAY is only supported with FREQ=WEEKLY",
          }),
        );
      }
      const days: number[] = [];
      for (const tok of kv.BYDAY.split(",")) {
        const idx = WEEKDAY_INDEX[tok.trim().toUpperCase()];
        if (idx == null) {
          metricSeriesRruleRejected("parse_error");
          return yield* Effect.fail(
            new SeriesRRuleInvalid({
              reason: "parse_error",
              message: `Invalid BYDAY token: ${tok}`,
            }),
          );
        }
        days.push(idx);
      }
      byDay = days.toSorted((a, b) => a - b);
    }

    const count = kv.COUNT != null ? Number(kv.COUNT) : null;
    if (count != null && (!Number.isInteger(count) || count < 1)) {
      metricSeriesRruleRejected("parse_error");
      return yield* Effect.fail(
        new SeriesRRuleInvalid({
          reason: "parse_error",
          message: "COUNT must be a positive integer",
        }),
      );
    }
    if (count != null && count > MAX_SERIES_INSTANCES) {
      metricSeriesRruleRejected("too_many_instances");
      return yield* Effect.fail(
        new SeriesRRuleInvalid({
          reason: "too_many_instances",
          message: `COUNT exceeds MAX_SERIES_INSTANCES (${MAX_SERIES_INSTANCES})`,
        }),
      );
    }

    let until: Date | null = null;
    if (kv.UNTIL != null) {
      const parsed = new Date(kv.UNTIL);
      if (isNaN(parsed.getTime())) {
        metricSeriesRruleRejected("parse_error");
        return yield* Effect.fail(
          new SeriesRRuleInvalid({
            reason: "parse_error",
            message: "UNTIL must be an ISO-8601 timestamp",
          }),
        );
      }
      until = parsed;
    }

    if (count == null && until == null) {
      metricSeriesRruleRejected("missing_termination");
      return yield* Effect.fail(
        new SeriesRRuleInvalid({
          reason: "missing_termination",
          message: "RRULE must include COUNT or UNTIL",
        }),
      );
    }

    return { freq: freqRaw, interval, byDay, count, until };
  });

/**
 * Expands an RRULE into concrete start timestamps, walking forward from
 * `dtstart` until `count` is hit or the date passes `until`/`maxThrough`.
 *
 * Timezone handling: for the reduced grammar, we expand in UTC — the
 * caller stores `dtstart` in UTC and the frontend renders in the
 * organiser-chosen `timezone`. Full DST-aware expansion is deferred
 * until full iCal RRULE lands (noted in the plan's open questions).
 */
export const expandRRule = (rule: ParsedRRule, dtstart: Date, maxThrough: Date): Date[] => {
  const hardCap = MAX_SERIES_INSTANCES;
  const upper = rule.until
    ? new Date(Math.min(rule.until.getTime(), maxThrough.getTime()))
    : maxThrough;
  const targetCount = rule.count ?? hardCap;

  const out: Date[] = [];

  if (rule.freq === "WEEKLY") {
    const daysOfWeek = rule.byDay ?? [dtstart.getUTCDay()];
    // Anchor on the Sunday of the dtstart week.
    const weekStart = new Date(dtstart);
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
    weekStart.setUTCHours(0, 0, 0, 0);

    let weekIdx = 0;
    while (out.length < targetCount) {
      for (const dow of daysOfWeek) {
        const candidate = new Date(weekStart);
        candidate.setUTCDate(candidate.getUTCDate() + weekIdx * 7 * rule.interval + dow);
        // Preserve the time-of-day from dtstart.
        candidate.setUTCHours(
          dtstart.getUTCHours(),
          dtstart.getUTCMinutes(),
          dtstart.getUTCSeconds(),
          0,
        );
        if (candidate.getTime() < dtstart.getTime()) continue;
        if (candidate.getTime() > upper.getTime()) return out;
        out.push(candidate);
        if (out.length >= targetCount) return out;
      }
      weekIdx++;
      if (weekIdx > 10_000) return out; // safety valve
    }
    return out;
  }

  // MONTHLY
  let monthIdx = 0;
  while (out.length < targetCount) {
    const candidate = new Date(dtstart);
    candidate.setUTCMonth(candidate.getUTCMonth() + monthIdx * rule.interval);
    if (candidate.getTime() > upper.getTime()) return out;
    out.push(candidate);
    monthIdx++;
    if (monthIdx > 10_000) return out;
  }
  return out;
};

// ---------------------------------------------------------------------------
// Service input schemas
// ---------------------------------------------------------------------------

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

const ValidDateString = Schema.String.pipe(Schema.filter((s) => !isNaN(new Date(s).getTime())));
const DateFromISOString = Schema.transform(ValidDateString, Schema.DateFromSelf, {
  strict: true,
  decode: (s) => new Date(s),
  encode: (d) => d.toISOString(),
});
const ValidUrl = Schema.String.pipe(Schema.filter((s) => URL.parse(s) !== null));

const TitleString = Schema.NonEmptyString.pipe(Schema.maxLength(200));
const DescriptionString = Schema.String.pipe(Schema.maxLength(5000));
const LocationString = Schema.String.pipe(Schema.maxLength(500));
const VenueString = Schema.String.pipe(Schema.maxLength(500));
const CategoryString = Schema.String.pipe(Schema.maxLength(100));
const RRuleString = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500));
const TimezoneString = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100));

const CreateSeriesSchema = Schema.Struct({
  title: TitleString,
  description: Schema.optional(DescriptionString),
  location: Schema.optional(LocationString),
  venue: Schema.optional(VenueString),
  latitude: Schema.optional(Schema.Number.pipe(Schema.between(-90, 90))),
  longitude: Schema.optional(Schema.Number.pipe(Schema.between(-180, 180))),
  category: Schema.optional(CategoryString),
  imageUrl: Schema.optional(ValidUrl),
  durationMinutes: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.between(1, 60 * 24 * 14)),
  ),
  visibility: Schema.optional(VisibilityEnum),
  guestListVisibility: Schema.optional(GuestListVisibilityEnum),
  joinPolicy: Schema.optional(JoinPolicyEnum),
  allowInterested: Schema.optional(Schema.Boolean),
  commsChannels: Schema.optional(CommsChannelsSchema),
  rrule: RRuleString,
  dtstart: DateFromISOString,
  timezone: Schema.optional(TimezoneString),
});

const UpdateSeriesScope = Schema.Literal("this_and_following", "all_future");

const UpdateSeriesSchema = Schema.Struct({
  title: Schema.optional(TitleString),
  description: Schema.optional(DescriptionString),
  location: Schema.optional(LocationString),
  venue: Schema.optional(VenueString),
  latitude: Schema.optional(Schema.Number.pipe(Schema.between(-90, 90))),
  longitude: Schema.optional(Schema.Number.pipe(Schema.between(-180, 180))),
  category: Schema.optional(CategoryString),
  imageUrl: Schema.optional(ValidUrl),
  durationMinutes: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.between(1, 60 * 24 * 14)),
  ),
  visibility: Schema.optional(VisibilityEnum),
  guestListVisibility: Schema.optional(GuestListVisibilityEnum),
  joinPolicy: Schema.optional(JoinPolicyEnum),
  allowInterested: Schema.optional(Schema.Boolean),
  commsChannels: Schema.optional(CommsChannelsSchema),
  scope: Schema.optional(UpdateSeriesScope),
  from: Schema.optional(Schema.String), // instance id to fork from (this_and_following)
});

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

interface CreatorInfo {
  createdByProfileId: string;
  createdByName: string | null;
  createdByAvatar: string | null;
}

const makeSeriesId = (): string => "srs_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);

const makeInstanceId = (): string => "evt_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);

/**
 * Materializes N concrete instance rows from a series template.
 * Returns the inserted rows. Metered via `pulse.series.instances_materialized`.
 */
export const materializeInstances = (
  series: EventSeries,
  parsed: ParsedRRule,
  trigger: "create" | "extend_window",
): Effect.Effect<Event[], DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    // Extend horizon: for create, honour the RRULE's natural stop; for
    // extend_window, push the watermark forward by ~12 weeks.
    const horizon =
      trigger === "create"
        ? new Date(series.dtstart.getTime() + 365 * 24 * 3_600_000 * 5)
        : new Date(Date.now() + 90 * 24 * 3_600_000);
    const starts = expandRRule(parsed, series.dtstart, horizon);

    if (starts.length === 0) {
      metricSeriesInstancesMaterialized(0, trigger, "ok");
      return [];
    }

    const now = new Date();
    const rows: NewEvent[] = starts.map((start) => ({
      id: makeInstanceId(),
      title: series.title,
      description: series.description,
      location: series.location,
      venue: series.venue,
      latitude: series.latitude,
      longitude: series.longitude,
      category: series.category,
      startTime: start,
      endTime: series.durationMinutes
        ? new Date(start.getTime() + series.durationMinutes * 60_000)
        : null,
      status: "upcoming",
      imageUrl: series.imageUrl,
      visibility: series.visibility,
      guestListVisibility: series.guestListVisibility,
      joinPolicy: series.joinPolicy,
      allowInterested: series.allowInterested,
      commsChannels: series.commsChannels,
      chatId: null,
      seriesId: series.id,
      instanceOverride: false,
      createdByProfileId: series.createdByProfileId,
      createdByName: series.createdByName,
      createdByAvatar: series.createdByAvatar,
      createdAt: now,
      updatedAt: now,
    }));

    yield* Effect.tryPromise({
      try: () => db.insert(events).values(rows),
      catch: (cause) => {
        metricSeriesInstancesMaterialized(rows.length, trigger, "error");
        return new DatabaseError({ cause });
      },
    }).pipe(Effect.tapError((e) => Effect.logError("series.materialize failed", e)));

    // Update the watermark on the series row.
    const last = starts[starts.length - 1]!;
    yield* Effect.tryPromise({
      try: () =>
        db
          .update(eventSeries)
          .set({ materializedThrough: last, updatedAt: now })
          .where(eq(eventSeries.id, series.id)),
      catch: (cause) => new DatabaseError({ cause }),
    });

    metricSeriesInstancesMaterialized(rows.length, trigger, "ok");
    return rows as Event[];
  }).pipe(Effect.withSpan("pulse.series.materialize", { attributes: { trigger } }));

export const createSeries = (
  data: unknown,
  creator: CreatorInfo,
): Effect.Effect<
  { series: EventSeries; instances: Event[] },
  ValidationError | SeriesRRuleInvalid | DatabaseError,
  Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    const validated = yield* Schema.decodeUnknown(CreateSeriesSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    if (validated.dtstart.getTime() <= Date.now()) {
      return yield* Effect.fail(new ValidationError({ cause: "dtstart must be in the future" }));
    }

    const parsed = yield* parseRRule(validated.rrule);

    const id = makeSeriesId();
    const now = new Date();
    const { commsChannels, ...rest } = validated;
    const row: NewEventSeries = {
      ...rest,
      id,
      createdAt: now,
      updatedAt: now,
      status: "active",
      materializedThrough: validated.dtstart,
      timezone: validated.timezone ?? "UTC",
      createdByProfileId: creator.createdByProfileId,
      createdByName: creator.createdByName,
      createdByAvatar: creator.createdByAvatar,
      ...(commsChannels ? { commsChannels: JSON.stringify(commsChannels) } : {}),
      until: parsed.until,
    };

    yield* Effect.tryPromise({
      try: () => db.insert(eventSeries).values(row),
      catch: (cause) => new DatabaseError({ cause }),
    }).pipe(Effect.tapError((e) => Effect.logError("series.create insert failed", e)));

    // Re-read so we get the default-populated columns as a strongly-typed row.
    const inserted = yield* Effect.tryPromise({
      try: (): Promise<EventSeries[]> =>
        db.select().from(eventSeries).where(eq(eventSeries.id, id)).limit(1) as Promise<
          EventSeries[]
        >,
      catch: (cause) => new DatabaseError({ cause }),
    });
    const series = inserted[0]!;

    const instances = yield* materializeInstances(series, parsed, "create");

    metricSeriesCreated(series.category, parsed.until !== null);
    return { series, instances };
  }).pipe(Effect.withSpan("pulse.series.create"));

export const getSeries = (
  id: string,
): Effect.Effect<EventSeries, SeriesNotFound | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: (): Promise<EventSeries[]> =>
        db.select().from(eventSeries).where(eq(eventSeries.id, id)).limit(1) as Promise<
          EventSeries[]
        >,
      catch: (cause) => new DatabaseError({ cause }),
    }).pipe(Effect.tapError((e) => Effect.logError("series.get failed", e)));
    if (rows.length === 0) return yield* Effect.fail(new SeriesNotFound({ id }));
    return rows[0]!;
  }).pipe(Effect.withSpan("pulse.series.get"));

export const listInstances = (
  seriesId: string,
  opts: { scope?: "past" | "upcoming" | "all"; viewerId: string | null; limit?: number } = {
    viewerId: null,
  },
): Effect.Effect<Event[], SeriesNotFound | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    // Make sure the series exists so non-existent ids get 404 even if the
    // viewer can't see any instance.
    yield* getSeries(seriesId);

    const now = new Date();
    const scope = opts.scope ?? "upcoming";
    const limit = opts.limit ? Math.min(Math.max(1, opts.limit), 500) : 100;

    const visibilityClause = opts.viewerId
      ? or(eq(events.visibility, "public"), eq(events.createdByProfileId, opts.viewerId))
      : eq(events.visibility, "public");

    const timeClause =
      scope === "all"
        ? undefined
        : scope === "past"
          ? lt(events.startTime, now)
          : gte(events.startTime, now);

    const filters = [eq(events.seriesId, seriesId), visibilityClause];
    if (timeClause) filters.push(timeClause);

    const rows = yield* Effect.tryPromise({
      try: (): Promise<Event[]> =>
        db
          .select()
          .from(events)
          .where(and(...filters))
          .orderBy(events.startTime)
          .limit(limit) as Promise<Event[]>,
      catch: (cause) => new DatabaseError({ cause }),
    }).pipe(Effect.tapError((e) => Effect.logError("series.list_instances failed", e)));

    // Apply status transitions so the client sees derived statuses.
    const transitioned = yield* Effect.forEach(rows, applyTransition, { concurrency: 5 });
    return transitioned;
  }).pipe(Effect.withSpan("pulse.series.list_instances"));

export const updateSeries = (
  id: string,
  data: unknown,
  requestingProfileId: string | null,
): Effect.Effect<
  { series: EventSeries; updated: number },
  SeriesNotFound | NotEventOwner | ValidationError | DatabaseError,
  Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    const existing = yield* getSeries(id);
    if (existing.createdByProfileId !== requestingProfileId) {
      metricSeriesUpdated("all_future", "forbidden");
      return yield* Effect.fail(new NotEventOwner({ id }));
    }

    const validated = yield* Schema.decodeUnknown(UpdateSeriesSchema)(data).pipe(
      Effect.mapError((cause) => new ValidationError({ cause })),
    );

    const scope = (validated.scope ?? "all_future") as "this_and_following" | "all_future";
    const now = new Date();
    const { commsChannels, scope: _scope, from, ...templateRest } = validated;
    const templateUpdate: Partial<NewEventSeries> = {
      ...templateRest,
      updatedAt: now,
      ...(commsChannels ? { commsChannels: JSON.stringify(commsChannels) } : {}),
    };

    yield* Effect.tryPromise({
      try: () => db.update(eventSeries).set(templateUpdate).where(eq(eventSeries.id, id)),
      catch: (cause) => new DatabaseError({ cause }),
    }).pipe(Effect.tapError((e) => Effect.logError("series.update template failed", e)));

    // Determine cutoff. For `all_future`, everything from now on; for
    // `this_and_following`, everything at or after the `from` instance's
    // start time.
    let cutoff = now;
    if (scope === "this_and_following" && from) {
      const anchor = yield* Effect.tryPromise({
        try: (): Promise<Event[]> =>
          db.select().from(events).where(eq(events.id, from)).limit(1) as Promise<Event[]>,
        catch: (cause) => new DatabaseError({ cause }),
      });
      if (anchor.length > 0) cutoff = anchor[0]!.startTime;
    }

    // Build the per-instance update: pick only the template fields that
    // also exist on `events`. `status` on events is upcoming/ongoing/…
    // whereas on the series it's active/ended/cancelled — NOT compatible,
    // so we don't propagate status here. Cancellations go through
    // `cancelSeries`.
    const instanceUpdate: Partial<typeof events.$inferInsert> = {
      ...(templateRest.title !== undefined ? { title: templateRest.title } : {}),
      ...(templateRest.description !== undefined ? { description: templateRest.description } : {}),
      ...(templateRest.location !== undefined ? { location: templateRest.location } : {}),
      ...(templateRest.venue !== undefined ? { venue: templateRest.venue } : {}),
      ...(templateRest.latitude !== undefined ? { latitude: templateRest.latitude } : {}),
      ...(templateRest.longitude !== undefined ? { longitude: templateRest.longitude } : {}),
      ...(templateRest.category !== undefined ? { category: templateRest.category } : {}),
      ...(templateRest.imageUrl !== undefined ? { imageUrl: templateRest.imageUrl } : {}),
      ...(templateRest.visibility !== undefined ? { visibility: templateRest.visibility } : {}),
      ...(templateRest.guestListVisibility !== undefined
        ? { guestListVisibility: templateRest.guestListVisibility }
        : {}),
      ...(templateRest.joinPolicy !== undefined ? { joinPolicy: templateRest.joinPolicy } : {}),
      ...(templateRest.allowInterested !== undefined
        ? { allowInterested: templateRest.allowInterested }
        : {}),
      ...(commsChannels ? { commsChannels: JSON.stringify(commsChannels) } : {}),
    };

    const toUpdate = yield* Effect.tryPromise({
      try: (): Promise<Event[]> =>
        db
          .select()
          .from(events)
          .where(
            and(
              eq(events.seriesId, id),
              eq(events.instanceOverride, false),
              gte(events.startTime, cutoff),
            ),
          ) as Promise<Event[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });

    if (toUpdate.length > 0) {
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(events)
            .set({ ...instanceUpdate, updatedAt: now })
            .where(
              inArray(
                events.id,
                toUpdate.map((e) => e.id),
              ),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      }).pipe(Effect.tapError((e) => Effect.logError("series.update instances failed", e)));
    }

    const fresh = yield* getSeries(id);
    metricSeriesUpdated(scope === "this_and_following" ? "this_and_following" : "all_future", "ok");
    return { series: fresh, updated: toUpdate.length };
  }).pipe(Effect.withSpan("pulse.series.update"));

export const cancelSeries = (
  id: string,
  requestingProfileId: string | null,
): Effect.Effect<{ cancelled: number }, SeriesNotFound | NotEventOwner | DatabaseError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    const existing = yield* getSeries(id);
    if (existing.createdByProfileId !== requestingProfileId) {
      metricSeriesCancelled("forbidden");
      return yield* Effect.fail(new NotEventOwner({ id }));
    }

    const now = new Date();
    const future = yield* Effect.tryPromise({
      try: (): Promise<Event[]> =>
        db
          .select()
          .from(events)
          .where(and(eq(events.seriesId, id), gt(events.startTime, now))) as Promise<Event[]>,
      catch: (cause) => new DatabaseError({ cause }),
    });

    if (future.length > 0) {
      yield* Effect.tryPromise({
        try: () =>
          db
            .update(events)
            .set({ status: "cancelled", updatedAt: now })
            .where(
              inArray(
                events.id,
                future.map((e) => e.id),
              ),
            ),
        catch: (cause) => new DatabaseError({ cause }),
      }).pipe(Effect.tapError((e) => Effect.logError("series.cancel instances failed", e)));
    }

    yield* Effect.tryPromise({
      try: () =>
        db
          .update(eventSeries)
          .set({ status: "cancelled", updatedAt: now })
          .where(eq(eventSeries.id, id)),
      catch: (cause) => new DatabaseError({ cause }),
    }).pipe(Effect.tapError((e) => Effect.logError("series.cancel series failed", e)));

    metricSeriesCancelled("ok");
    return { cancelled: future.length };
  }).pipe(Effect.withSpan("pulse.series.cancel"));
