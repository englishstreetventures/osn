/**
 * Pulse API domain metrics.
 *
 * Single source of truth — every counter/histogram for Pulse lives here.
 * Handlers and services import the recording helpers (`metric*`) and call
 * them at the relevant points. Raw OTel instruments are never used.
 *
 * See `CLAUDE.md` "Observability" section for the full rules.
 */

import {
  BYTE_BUCKETS,
  createCounter,
  createHistogram,
  LATENCY_BUCKETS_SECONDS,
} from "@shared/observability/metrics";
import type { EventStatus, JwksCacheResult, Result } from "@shared/observability/metrics";

/** Canonical metric name consts — grep-able, refactor-safe. */
export const PULSE_METRICS = {
  eventsCreated: "pulse.events.created",
  eventsUpdated: "pulse.events.updated",
  eventsDeleted: "pulse.events.deleted",
  eventsListed: "pulse.events.listed",
  eventsCreateDuration: "pulse.events.create.duration",
  eventStatusTransitions: "pulse.events.status_transitions",
  eventValidationFailures: "pulse.events.validation.failures",
  // RSVP surface (added with the full-event-view feature)
  rsvpUpserted: "pulse.rsvps.upserted",
  rsvpInvitesBatch: "pulse.rsvps.invites.batch",
  rsvpInvitesPerBatch: "pulse.rsvps.invites.per_batch",
  rsvpListed: "pulse.rsvps.listed",
  // Comms blast surface (SMS/email broadcast from organiser)
  commsBlastSent: "pulse.comms.blast.sent",
  commsBlastBodySize: "pulse.comms.blast.body.size",
  // Calendar / ICS
  calendarIcsGenerated: "pulse.calendar.ics.generated",
  // Visibility + access
  eventAccessDenied: "pulse.events.access.denied",
  // Pulse user settings
  settingsUpdated: "pulse.settings.updated",
  // JWKS public key cache
  authJwksCacheLookups: "pulse.auth.jwks_cache.lookups",
  // Recurring event series
  seriesCreated: "pulse.series.created",
  seriesUpdated: "pulse.series.updated",
  seriesCancelled: "pulse.series.cancelled",
  seriesInstancesMaterialized: "pulse.series.instances_materialized",
  seriesRruleRejected: "pulse.series.rrule.rejected",
} as const;

// ---------------------------------------------------------------------------
// Attribute shapes — bounded string-literal unions ONLY.
// TypeScript rejects unknown keys, so cardinality is enforced at compile time.
// ---------------------------------------------------------------------------

/**
 * Closed set of event categories allowed as a metric attribute value.
 * Free-text categories supplied by users (see `InsertEventSchema`) are
 * bucketed into `"other"` by `bucketCategory()` below so metric
 * cardinality cannot be inflated by crafted `category` strings
 * (S-C3). Extend this list as new first-class categories are added.
 */
const ALLOWED_CATEGORIES = [
  "none",
  "music",
  "food",
  "sports",
  "arts",
  "tech",
  "community",
  "education",
  "social",
  "nightlife",
  "outdoor",
  "family",
  "other",
] as const;

type AllowedCategory = (typeof ALLOWED_CATEGORIES)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(ALLOWED_CATEGORIES);

/**
 * Map a raw user-supplied category string to the closed `AllowedCategory`
 * union. Values outside the allow-list collapse to `"other"`; `null`
 * collapses to `"none"`. This is the ONLY way to record a Pulse metric
 * that includes a category attribute.
 */
const bucketCategory = (raw: string | null): AllowedCategory => {
  if (raw === null) return "none";
  const normalised = raw.toLowerCase();
  return (CATEGORY_SET.has(normalised) ? normalised : "other") as AllowedCategory;
};

type EventsCreatedAttrs = {
  /** Bounded category bucket — see `bucketCategory`. */
  category: AllowedCategory;
  /** Whether the event had an explicit end time. */
  has_end_time: "true" | "false";
};

type EventsSimpleAttrs = {
  result: Result;
};

type EventsListedAttrs = {
  scope: "all" | "today";
  result_empty: "true" | "false";
};

type EventsStatusTransitionAttrs = {
  from: EventStatus;
  to: EventStatus;
};

type EventsValidationFailureAttrs = {
  operation: "create" | "update";
  reason: "schema" | "past_start_time" | "duration_exceeds_max";
};

// --- RSVP ---

/** Bounded RSVP status union — matches `RsvpStatus` + the organiser-side `"invited"` row. */
type RsvpStatus = "going" | "interested" | "not_going" | "invited";

type RsvpUpsertedAttrs = {
  /** Terminal status after the upsert. */
  status: RsvpStatus;
  /** `true` for the first-ever RSVP on this (event,user) pair; `false` for updates. */
  is_first_rsvp: "true" | "false";
  /** Result class — covers gating errors like NotInvited, validation, etc. */
  result: Result;
};

type RsvpInviteBatchAttrs = {
  result: Result;
};

type RsvpListedAttrs = {
  /**
   * Which status bucket was queried. `"invited"` is the organiser-only
   * lookup; all others are public-ish (subject to the attendance-visibility
   * filter).
   */
  status_filter: RsvpStatus | "all";
  result_empty: "true" | "false";
};

// --- Comms (organiser blast) ---

type CommsChannel = "sms" | "email";

type CommsBlastSentAttrs = {
  channel: CommsChannel;
  result: Result;
};

type CommsBlastBodySizeAttrs = {
  channel: CommsChannel;
};

// --- Calendar / ICS ---

type CalendarIcsAttrs = {
  result: Result;
};

// --- Access gate (visibility enforcement) ---

/**
 * Bucketed reason an event access was denied. Low-cardinality by design —
 * all unknown reasons collapse to `"other"`. Driven by the `canViewEvent`
 * / `loadVisibleEvent` gate in `services/eventAccess.ts`.
 */
type EventAccessDeniedReason = "not_found" | "private_anonymous" | "private_no_rsvp" | "other";

type EventAccessDeniedAttrs = {
  /** Which direct-fetch surface the denial happened on. */
  surface: "get" | "ics" | "comms" | "rsvps" | "rsvps_counts";
  reason: EventAccessDeniedReason;
};

// --- Pulse user settings ---

type SettingsUpdatedAttrs = {
  field: "attendance_visibility";
  result: Result;
};

// --- JWKS cache ---

type JwksCacheLookupAttrs = {
  result: JwksCacheResult;
};

// --- Recurring event series ---

/** Scope of a series-level update operation. */
type SeriesUpdateScope = "this_only" | "this_and_following" | "all_future";

/** Trigger that caused a materialization batch to run. */
type SeriesMaterializeTrigger = "create" | "extend_window";

/** Bucketed reason an RRULE was rejected. All unknown reasons collapse to `"parse_error"`. */
type SeriesRruleRejectReason =
  | "unsupported_freq"
  | "too_many_instances"
  | "missing_termination"
  | "parse_error";

type SeriesCreatedAttrs = {
  /** Bounded category bucket — see `bucketCategory`. */
  category: AllowedCategory;
  /** Whether an `UNTIL` bound was provided. */
  has_until: "true" | "false";
};

type SeriesUpdatedAttrs = {
  scope: SeriesUpdateScope;
  result: Result;
};

type SeriesCancelledAttrs = {
  result: Result;
};

type SeriesMaterializedAttrs = {
  trigger: SeriesMaterializeTrigger;
  result: Result;
};

type SeriesRruleRejectedAttrs = {
  reason: SeriesRruleRejectReason;
};

// ---------------------------------------------------------------------------
// Counters / histograms
// ---------------------------------------------------------------------------

const eventsCreated = createCounter<EventsCreatedAttrs>({
  name: PULSE_METRICS.eventsCreated,
  description: "Events successfully created",
  unit: "{event}",
});

const eventsUpdated = createCounter<EventsSimpleAttrs>({
  name: PULSE_METRICS.eventsUpdated,
  description: "Event updates, by outcome",
  unit: "{event}",
});

const eventsDeleted = createCounter<EventsSimpleAttrs>({
  name: PULSE_METRICS.eventsDeleted,
  description: "Event deletions, by outcome",
  unit: "{event}",
});

const eventsListed = createCounter<EventsListedAttrs>({
  name: PULSE_METRICS.eventsListed,
  description: "Event list queries, by scope and whether any results were returned",
  unit: "{query}",
});

const eventsCreateDuration = createHistogram<EventsSimpleAttrs>({
  name: PULSE_METRICS.eventsCreateDuration,
  description: "createEvent service latency (includes DB insert + re-read)",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

const eventStatusTransitions = createCounter<EventsStatusTransitionAttrs>({
  name: PULSE_METRICS.eventStatusTransitions,
  description: "Event auto-status transitions (on-read lifecycle)",
  unit: "{transition}",
});

const eventValidationFailures = createCounter<EventsValidationFailureAttrs>({
  name: PULSE_METRICS.eventValidationFailures,
  description: "Event create/update validation failures",
  unit: "{failure}",
});

// --- RSVP instruments ---

const rsvpUpserted = createCounter<RsvpUpsertedAttrs>({
  name: PULSE_METRICS.rsvpUpserted,
  description: "RSVP upserts (first-create or status-change) by terminal status",
  unit: "{rsvp}",
});

const rsvpInvitesBatch = createCounter<RsvpInviteBatchAttrs>({
  name: PULSE_METRICS.rsvpInvitesBatch,
  description: "Organiser invite batches sent, by outcome",
  unit: "{batch}",
});

const rsvpInvitesPerBatch = createHistogram<RsvpInviteBatchAttrs>({
  name: PULSE_METRICS.rsvpInvitesPerBatch,
  description: "Distribution of invite batch sizes (users invited per call)",
  unit: "{invite}",
  // Tuned for invite batches: 1…MAX_EVENT_GUESTS (=1000). Buckets
  // emphasise the small-batch end because most invite flows are per-
  // group-chat (~5-50) rather than mass mail-merge.
  boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
});

const rsvpListed = createCounter<RsvpListedAttrs>({
  name: PULSE_METRICS.rsvpListed,
  description: "RSVP list queries, by status filter and whether any rows were returned",
  unit: "{query}",
});

// --- Comms blast instruments ---

const commsBlastSent = createCounter<CommsBlastSentAttrs>({
  name: PULSE_METRICS.commsBlastSent,
  description: "Organiser comms blasts recorded, one counter inc per channel per blast",
  unit: "{blast}",
});

const commsBlastBodySize = createHistogram<CommsBlastBodySizeAttrs>({
  name: PULSE_METRICS.commsBlastBodySize,
  description: "Blast body length in bytes (capped at 1600 by the schema)",
  unit: "By",
  boundaries: BYTE_BUCKETS,
});

// --- Calendar / ICS ---

const calendarIcsGenerated = createCounter<CalendarIcsAttrs>({
  name: PULSE_METRICS.calendarIcsGenerated,
  description: "ICS calendar files generated via `buildIcs`",
  unit: "{file}",
});

// --- Access gate ---

const eventAccessDenied = createCounter<EventAccessDeniedAttrs>({
  name: PULSE_METRICS.eventAccessDenied,
  description: "Direct-fetch event access denials (visibility gate) — a spike is a probing signal",
  unit: "{denial}",
});

// --- Pulse user settings ---

const settingsUpdated = createCounter<SettingsUpdatedAttrs>({
  name: PULSE_METRICS.settingsUpdated,
  description: "Pulse user settings updates by field and outcome",
  unit: "{update}",
});

// ---------------------------------------------------------------------------
// Public recording helpers — the ONLY way Pulse code should emit metrics.
// ---------------------------------------------------------------------------

export const metricEventCreated = (category: string | null, hasEndTime: boolean): void =>
  eventsCreated.inc({
    category: bucketCategory(category),
    has_end_time: hasEndTime ? "true" : "false",
  });

export const metricEventUpdated = (result: Result): void => eventsUpdated.inc({ result });

export const metricEventDeleted = (result: Result): void => eventsDeleted.inc({ result });

export const metricEventsListed = (scope: "all" | "today", resultCount: number): void =>
  eventsListed.inc({ scope, result_empty: resultCount === 0 ? "true" : "false" });

export const metricEventCreateDuration = (durationSeconds: number, result: Result): void =>
  eventsCreateDuration.record(durationSeconds, { result });

export const metricEventStatusTransition = (from: EventStatus, to: EventStatus): void =>
  eventStatusTransitions.inc({ from, to });

export const metricEventValidationFailure = (
  operation: "create" | "update",
  reason: "schema" | "past_start_time" | "duration_exceeds_max",
): void => eventValidationFailures.inc({ operation, reason });

// --- RSVP recording helpers ---

export const metricRsvpUpserted = (
  status: RsvpStatus,
  isFirstRsvp: boolean,
  result: Result,
): void =>
  rsvpUpserted.inc({
    status,
    is_first_rsvp: isFirstRsvp ? "true" : "false",
    result,
  });

export const metricRsvpInviteBatch = (batchSize: number, result: Result): void => {
  rsvpInvitesBatch.inc({ result });
  // Only record the histogram on success — failed batches are not
  // meaningful for the size distribution.
  if (result === "ok") rsvpInvitesPerBatch.record(batchSize, { result });
};

export const metricRsvpListed = (statusFilter: RsvpStatus | "all", resultCount: number): void =>
  rsvpListed.inc({
    status_filter: statusFilter,
    result_empty: resultCount === 0 ? "true" : "false",
  });

// --- Comms blast recording helpers ---

export const metricCommsBlastSent = (
  channel: CommsChannel,
  bodyBytes: number,
  result: Result,
): void => {
  commsBlastSent.inc({ channel, result });
  // Only record size for successful blasts to keep the histogram
  // meaningful — error-path payloads can be malformed.
  if (result === "ok") commsBlastBodySize.record(bodyBytes, { channel });
};

// --- Calendar recording helper ---

export const metricCalendarIcsGenerated = (result: Result): void =>
  calendarIcsGenerated.inc({ result });

// --- Access gate recording helper ---

export const metricEventAccessDenied = (
  surface: "get" | "ics" | "comms" | "rsvps" | "rsvps_counts",
  reason: EventAccessDeniedReason,
): void => eventAccessDenied.inc({ surface, reason });

// --- Settings recording helper ---

export const metricSettingsUpdated = (field: "attendance_visibility", result: Result): void =>
  settingsUpdated.inc({ field, result });

// --- JWKS cache ---

const authJwksCacheLookups = createCounter<JwksCacheLookupAttrs>({
  name: PULSE_METRICS.authJwksCacheLookups,
  description: "JWKS public key cache lookups by result (hit/miss/refresh)",
  unit: "{lookup}",
});

export const metricJwksCacheLookup = (result: JwksCacheResult): void =>
  authJwksCacheLookups.inc({ result });

// --- Series instruments ---

const seriesCreated = createCounter<SeriesCreatedAttrs>({
  name: PULSE_METRICS.seriesCreated,
  description: "Recurring event series created",
  unit: "{series}",
});

const seriesUpdated = createCounter<SeriesUpdatedAttrs>({
  name: PULSE_METRICS.seriesUpdated,
  description: "Series-level update operations, by scope and outcome",
  unit: "{update}",
});

const seriesCancelled = createCounter<SeriesCancelledAttrs>({
  name: PULSE_METRICS.seriesCancelled,
  description: "Series cancellations (sets status=cancelled and cancels future instances)",
  unit: "{cancellation}",
});

const seriesInstancesMaterialized = createHistogram<SeriesMaterializedAttrs>({
  name: PULSE_METRICS.seriesInstancesMaterialized,
  description: "Instances produced per materialization batch",
  unit: "{instance}",
  // Weekly series tends to produce 12–52; monthly 6–12. Buckets emphasise
  // the small-to-medium end; long tail caught by the last bucket.
  boundaries: [1, 4, 12, 26, 52, 104, 260],
});

const seriesRruleRejected = createCounter<SeriesRruleRejectedAttrs>({
  name: PULSE_METRICS.seriesRruleRejected,
  description: "RRULE inputs rejected by the series parser, by bucketed reason",
  unit: "{rejection}",
});

export const metricSeriesCreated = (category: string | null, hasUntil: boolean): void =>
  seriesCreated.inc({
    category: bucketCategory(category),
    has_until: hasUntil ? "true" : "false",
  });

export const metricSeriesUpdated = (scope: SeriesUpdateScope, result: Result): void =>
  seriesUpdated.inc({ scope, result });

export const metricSeriesCancelled = (result: Result): void => seriesCancelled.inc({ result });

export const metricSeriesInstancesMaterialized = (
  count: number,
  trigger: SeriesMaterializeTrigger,
  result: Result,
): void => seriesInstancesMaterialized.record(count, { trigger, result });

export const metricSeriesRruleRejected = (reason: SeriesRruleRejectReason): void =>
  seriesRruleRejected.inc({ reason });
