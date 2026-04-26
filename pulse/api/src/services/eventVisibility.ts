import { eventRsvps, events } from "@pulse/db/schema";
import { eq, or, sql, type SQL } from "drizzle-orm";

/**
 * SQL predicate mirror of `canViewEvent` in `services/eventAccess.ts`.
 * Extracted into its own module so the list-side consumers
 * (`listEvents`, `discoverEvents`) can import it without pulling in
 * `eventAccess.ts` → `events.ts` cycles.
 *
 * Any surface that returns multiple events MUST filter by this predicate
 * so the per-row gate can't silently skip rows after the query has
 * already been LIMITed (S-H12..S-H16, P-W12).
 *
 *   - Public events    → visible to everyone (incl. unauthenticated).
 *   - Private events   → visible to:
 *                        (a) the organiser, or
 *                        (b) any user with an RSVP row for the event
 *                            (any status, including the organiser-only
 *                            `"invited"` pre-RSVP).
 */
export const buildVisibilityFilter = (viewerId: string | null): SQL => {
  if (viewerId == null) {
    return eq(events.visibility, "public");
  }
  return or(
    eq(events.visibility, "public"),
    eq(events.createdByProfileId, viewerId),
    sql`EXISTS (SELECT 1 FROM ${eventRsvps} WHERE ${eventRsvps.eventId} = ${events.id} AND ${eventRsvps.profileId} = ${viewerId})`,
  ) as SQL;
};
