import { eventRsvps, events, pulseCloseFriends, pulseUsers } from "@pulse/db/schema";
import { Db, type DbService } from "@pulse/db/service";
import { and, asc, gt, inArray } from "drizzle-orm";
import { Data, Effect } from "effect";

import { metricPulseDsarExportRow } from "../metrics";

/**
 * Account-data export contributions from Pulse, served via the ARC-protected
 * `/account-export/internal` endpoint. Streams keyset-paginated rows for
 * every Pulse-owned section the user is entitled to under GDPR Art. 15.
 *
 * The caller passes the set of OSN profile IDs that belong to the
 * account — Pulse never re-derives this because it doesn't own the
 * account → profile mapping. Memory budget is enforced upstream in
 * osn/api; this service yields rows in deterministic id-asc order so
 * the keyset cursor is stable across paginations.
 */

export class PulseExportError extends Data.TaggedError("PulseExportError")<{
  readonly cause: unknown;
}> {}

/** Page size for every section. Matches dsar.md §"Wire format" (LIMIT 500). */
export const PAGE_SIZE = 500;

/** Hard cap on profile IDs in a single export request. Bounds the IN(...) clause. */
export const MAX_EXPORT_PROFILE_IDS = 50;

export type PulseExportSectionName =
  | "pulse.rsvps"
  | "pulse.events_hosted"
  | "pulse.close_friends"
  | "pulse.pulse_users";

export interface PulseExportLine {
  readonly section: PulseExportSectionName;
  readonly row: Record<string, unknown>;
}

const isoOrNull = (v: Date | number | null | undefined): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  // Sqlite timestamp mode hands us Date instances; defensive cast for any.
  return new Date(v as unknown as number).toISOString();
};

type Drizzle = DbService["db"];

async function* paginate<R>(
  fetchPage: (cursor: string | null) => Promise<R[]>,
  rowId: (row: R) => string,
): AsyncIterable<R> {
  let cursor: string | null = null;
  while (true) {
    const page = await fetchPage(cursor);
    if (page.length === 0) return;
    for (const row of page) yield row;
    if (page.length < PAGE_SIZE) return;
    cursor = rowId(page[page.length - 1]);
  }
}

async function* iterRsvps(
  db: Drizzle,
  profileIds: readonly string[],
): AsyncIterable<PulseExportLine> {
  let total = 0;
  for await (const r of paginate(
    (cursor) =>
      db
        .select({
          id: eventRsvps.id,
          eventId: eventRsvps.eventId,
          profileId: eventRsvps.profileId,
          status: eventRsvps.status,
          invitedByProfileId: eventRsvps.invitedByProfileId,
          createdAt: eventRsvps.createdAt,
        })
        .from(eventRsvps)
        .where(
          cursor
            ? and(inArray(eventRsvps.profileId, [...profileIds]), gt(eventRsvps.id, cursor))
            : inArray(eventRsvps.profileId, [...profileIds]),
        )
        .orderBy(asc(eventRsvps.id))
        .limit(PAGE_SIZE),
    (r) => r.id,
  )) {
    total++;
    yield {
      section: "pulse.rsvps",
      row: {
        id: r.id,
        event_id: r.eventId,
        profile_id: r.profileId,
        status: r.status,
        invited_by_profile_id: r.invitedByProfileId,
        created_at: isoOrNull(r.createdAt),
      },
    };
  }
  metricPulseDsarExportRow("rsvps", total);
}

async function* iterEventsHosted(
  db: Drizzle,
  profileIds: readonly string[],
): AsyncIterable<PulseExportLine> {
  let total = 0;
  for await (const r of paginate(
    (cursor) =>
      db
        .select({
          id: events.id,
          title: events.title,
          description: events.description,
          location: events.location,
          startTime: events.startTime,
          endTime: events.endTime,
          visibility: events.visibility,
          guestListVisibility: events.guestListVisibility,
          joinPolicy: events.joinPolicy,
          createdByProfileId: events.createdByProfileId,
          createdAt: events.createdAt,
          updatedAt: events.updatedAt,
          status: events.status,
        })
        .from(events)
        .where(
          cursor
            ? and(inArray(events.createdByProfileId, [...profileIds]), gt(events.id, cursor))
            : inArray(events.createdByProfileId, [...profileIds]),
        )
        .orderBy(asc(events.id))
        .limit(PAGE_SIZE),
    (r) => r.id,
  )) {
    total++;
    yield {
      section: "pulse.events_hosted",
      row: {
        id: r.id,
        title: r.title,
        description: r.description,
        location: r.location,
        start_time: isoOrNull(r.startTime),
        end_time: isoOrNull(r.endTime),
        visibility: r.visibility,
        guest_list_visibility: r.guestListVisibility,
        join_policy: r.joinPolicy,
        created_by_profile_id: r.createdByProfileId,
        status: r.status,
        created_at: isoOrNull(r.createdAt),
        updated_at: isoOrNull(r.updatedAt),
      },
    };
  }
  metricPulseDsarExportRow("events_hosted", total);
}

async function* iterCloseFriends(
  db: Drizzle,
  profileIds: readonly string[],
): AsyncIterable<PulseExportLine> {
  let total = 0;
  for await (const r of paginate(
    (cursor) =>
      db
        .select({
          id: pulseCloseFriends.id,
          profileId: pulseCloseFriends.profileId,
          friendId: pulseCloseFriends.friendId,
          createdAt: pulseCloseFriends.createdAt,
        })
        .from(pulseCloseFriends)
        .where(
          cursor
            ? and(
                inArray(pulseCloseFriends.profileId, [...profileIds]),
                gt(pulseCloseFriends.id, cursor),
              )
            : inArray(pulseCloseFriends.profileId, [...profileIds]),
        )
        .orderBy(asc(pulseCloseFriends.id))
        .limit(PAGE_SIZE),
    (r) => r.id,
  )) {
    total++;
    yield {
      section: "pulse.close_friends",
      row: {
        id: r.id,
        profile_id: r.profileId,
        friend_id: r.friendId,
        created_at: isoOrNull(r.createdAt),
      },
    };
  }
  metricPulseDsarExportRow("close_friends", total);
}

async function* iterPulseUsers(
  db: Drizzle,
  profileIds: readonly string[],
): AsyncIterable<PulseExportLine> {
  let total = 0;
  for await (const r of paginate(
    (cursor) =>
      db
        .select({
          profileId: pulseUsers.profileId,
          attendanceVisibility: pulseUsers.attendanceVisibility,
          createdAt: pulseUsers.createdAt,
          updatedAt: pulseUsers.updatedAt,
        })
        .from(pulseUsers)
        .where(
          cursor
            ? and(inArray(pulseUsers.profileId, [...profileIds]), gt(pulseUsers.profileId, cursor))
            : inArray(pulseUsers.profileId, [...profileIds]),
        )
        .orderBy(asc(pulseUsers.profileId))
        .limit(PAGE_SIZE),
    (r) => r.profileId,
  )) {
    total++;
    yield {
      section: "pulse.pulse_users",
      row: {
        profile_id: r.profileId,
        attendance_visibility: r.attendanceVisibility,
        created_at: isoOrNull(r.createdAt),
        updated_at: isoOrNull(r.updatedAt),
      },
    };
  }
  metricPulseDsarExportRow("pulse_users", total);
}

/**
 * Resolves a bare Drizzle handle from the Effect `Db` service so a
 * caller (e.g. the streaming HTTP route) can iterate without keeping
 * the Effect runtime open for the entire stream lifetime. The Bun
 * sqlite handle is a synchronous in-process resource — safe to use
 * after the Effect lifecycle ends.
 */
export const resolveDbHandle = (): Effect.Effect<Drizzle, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    return db;
  });

/**
 * Streams all Pulse-owned sections for the given profile IDs, in section
 * order. Each yielded value is a single `{ section, row }` envelope ready
 * to be serialised as one NDJSON line by the route layer.
 *
 * The function takes a bare Drizzle handle (resolved by the route from
 * the Effect Db service) so the AsyncIterable can be consumed by a
 * `ReadableStream` lazily.
 */
export async function* streamAccountExport(
  db: Drizzle,
  profileIds: readonly string[],
): AsyncIterable<PulseExportLine> {
  if (profileIds.length === 0) return;
  yield* iterRsvps(db, profileIds);
  yield* iterEventsHosted(db, profileIds);
  yield* iterCloseFriends(db, profileIds);
  yield* iterPulseUsers(db, profileIds);
}
