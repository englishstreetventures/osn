import { events, eventRsvps, pulseCloseFriends } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { inArray } from "drizzle-orm";
import { Data, Effect } from "effect";

/**
 * Pulse-side DSAR account export (C-H1 — Art.15 right of access).
 *
 * Endpoint hit by osn-api's export fan-out. Reads the requesting account's
 * Pulse-scoped personal data for the supplied profile IDs and returns it as
 * a list of `{ section, record }` lines. The route serialises these to
 * NDJSON; osn-api wraps them in its outer export envelope (header +
 * terminator), so this layer emits data lines only.
 *
 * Sections (per `wiki/compliance/dsar.md` §Art.15):
 *   - `pulse.rsvps`         — the account's RSVPs.
 *   - `pulse.events_hosted` — events the account created.
 *   - `pulse.close_friends` — the account's Pulse close-friends edges.
 *
 * The correlation cache (`pulse_profile_accounts`) and onboarding opt-ins
 * are intentionally excluded — they are not user-facing personal records.
 */

export class PulseExportDbError extends Data.TaggedError("PulseExportDbError")<{
  readonly cause: unknown;
}> {}

export interface ExportLine {
  readonly section: string;
  readonly record: Record<string, unknown>;
}

/**
 * Collect every export line for the given profile IDs. Empty `profileIds`
 * yields an empty list (osn-api still appends its terminator).
 */
export const collectExport = (
  profileIds: string[],
): Effect.Effect<ExportLine[], PulseExportDbError, Db> =>
  Effect.gen(function* () {
    if (profileIds.length === 0) return [];
    const { db } = yield* Db;

    const rsvps = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            eventId: eventRsvps.eventId,
            status: eventRsvps.status,
            shareSourceFirst: eventRsvps.shareSourceFirst,
            createdAt: eventRsvps.createdAt,
          })
          .from(eventRsvps)
          .where(inArray(eventRsvps.profileId, profileIds)),
      catch: (cause) => new PulseExportDbError({ cause }),
    });

    const hosted = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            id: events.id,
            title: events.title,
            startTime: events.startTime,
            createdAt: events.createdAt,
          })
          .from(events)
          .where(inArray(events.createdByProfileId, profileIds)),
      catch: (cause) => new PulseExportDbError({ cause }),
    });

    const closeFriends = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            friendId: pulseCloseFriends.friendId,
            createdAt: pulseCloseFriends.createdAt,
          })
          .from(pulseCloseFriends)
          .where(inArray(pulseCloseFriends.profileId, profileIds)),
      catch: (cause) => new PulseExportDbError({ cause }),
    });

    const lines: ExportLine[] = [];
    for (const r of rsvps) {
      const record: Record<string, unknown> = {
        eventId: r.eventId,
        status: r.status,
        createdAt: r.createdAt,
      };
      // `share_source_first` is only present for sourced arrivals.
      if (r.shareSourceFirst != null) record.shareSourceFirst = r.shareSourceFirst;
      lines.push({ section: "pulse.rsvps", record });
    }
    for (const e of hosted) {
      lines.push({
        section: "pulse.events_hosted",
        record: { id: e.id, title: e.title, startTime: e.startTime, createdAt: e.createdAt },
      });
    }
    for (const cf of closeFriends) {
      lines.push({
        section: "pulse.close_friends",
        record: { friendId: cf.friendId, createdAt: cf.createdAt },
      });
    }
    return lines;
  });
