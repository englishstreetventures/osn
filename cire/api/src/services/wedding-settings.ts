import { weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { isRsvpClosed } from "../lib/rsvp-deadline";
import { metricWeddingSettingsSaved } from "../metrics";
import type { UpdateSettingsBody } from "../schemas/settings";

/** The wedding profile as the Settings surface reads/writes it. Superset of
 *  `WeddingSummary` (the list shape) — everything an organiser edits here.
 *  Deliberately location-free: an event's place is its free-text `address`
 *  (the sole location source), so the wedding holds only the MAIN currency +
 *  budget. */
export type WeddingProfile = {
  id: string;
  slug: string;
  displayName: string;
  weddingDate: string | null;
  guestCountEstimate: number | null;
  currency: string;
  budgetTotalMinor: number | null;
  /** The "kindly respond by" date (`YYYY-MM-DD`), or null for no deadline. The
   *  only field here guests feel: past it the invite stops accepting RSVPs. */
  rsvpDeadline: string | null;
  /** IANA zone `rsvpDeadline`'s day is measured in; null ⇒ UTC at read time.
   *  Always null when `rsvpDeadline` is (see `update`). */
  rsvpDeadlineTimezone: string | null;
};

export class WeddingNotFound extends Data.TaggedError("WeddingNotFound")<{
  readonly weddingId: string;
}> {}

export class SettingsWriteError extends Data.TaggedError("SettingsWriteError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/**
 * The patch would leave the wedding with an RSVP deadline that has ALREADY
 * closed (S-L3). Rejected for every caller, owner included: a backdated
 * deadline locks the invite for every guest the instant it lands, and a guest
 * turned away is told only that RSVPs closed — never that the date moved under
 * them. "Today" is always still available (the deadline is inclusive, so it
 * closes at the end of that day in its own zone), which is what an organiser
 * who wants to stop taking replies actually needs.
 */
export class RsvpDeadlineInPast extends Data.TaggedError("RsvpDeadlineInPast")<{
  readonly date: string;
  readonly timezone: string | null;
}> {}

const PROFILE_COLUMNS = {
  id: weddings.id,
  slug: weddings.slug,
  displayName: weddings.displayName,
  weddingDate: weddings.weddingDate,
  guestCountEstimate: weddings.guestCountEstimate,
  currency: weddings.currency,
  budgetTotalMinor: weddings.budgetTotalMinor,
  rsvpDeadline: weddings.rsvpDeadline,
  rsvpDeadlineTimezone: weddings.rsvpDeadlineTimezone,
};

export const weddingSettingsService = {
  /**
   * The wedding's profile. The caller has already passed a per-`:weddingId`
   * authz gate, so a miss means the row vanished between the gate and this
   * read — surfaced as the same 404.
   */
  get(weddingId: string): Effect.Effect<WeddingProfile, WeddingNotFound, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const [row] = yield* dbQuery(() =>
        db.select(PROFILE_COLUMNS).from(weddings).where(eq(weddings.id, weddingId)).limit(1).all(),
      );
      if (!row) return yield* new WeddingNotFound({ weddingId });
      return row;
    }).pipe(Effect.withSpan("cire.wedding_settings.get"));
  },

  /**
   * Apply a validated settings patch (PATCH semantics: only provided fields
   * change; explicit `null` clears a nullable column). The patch has already
   * passed the schema boundary, so every value is shape-valid. The SLUG is
   * never written here — renaming would free the old slug for another
   * organiser to claim while printed invite links still point at it (S-M1);
   * a rename feature needs slug tombstoning first.
   */
  update(
    weddingId: string,
    patch: UpdateSettingsBody,
    /** OSN profile making the write — recorded on the row so a guest-facing
     *  change has an author (migration 0056). */
    updatedByOsnProfileId: string,
  ): Effect.Effect<
    WeddingProfile,
    WeddingNotFound | SettingsWriteError | RsvpDeadlineInPast,
    DbService
  > {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const current = yield* weddingSettingsService.get(weddingId);

      const next: WeddingProfile = {
        ...current,
        ...(patch.displayName !== undefined && { displayName: patch.displayName }),
        ...(patch.weddingDate !== undefined && { weddingDate: patch.weddingDate }),
        ...(patch.guestCountEstimate !== undefined && {
          guestCountEstimate: patch.guestCountEstimate,
        }),
        ...(patch.currency !== undefined && { currency: patch.currency }),
        ...(patch.budgetTotalMinor !== undefined && { budgetTotalMinor: patch.budgetTotalMinor }),
        ...(patch.rsvpDeadline !== undefined && { rsvpDeadline: patch.rsvpDeadline }),
        ...(patch.rsvpDeadlineTimezone !== undefined && {
          rsvpDeadlineTimezone: patch.rsvpDeadlineTimezone,
        }),
      };

      // Write ONLY the columns the patch names (S-L1). Setting all seven from
      // the row read a moment earlier made every save a read-modify-write over
      // the whole profile — which was self-inflicted while the owner was the
      // only writer, but the RSVP deadline is now editable by an `editor`
      // co-host too. A deadline-only patch that rewrote `displayName` and
      // `currency` with stale values could revert an owner's concurrent edit to
      // a field the co-host is explicitly not allowed to touch. A narrow UPDATE
      // makes that physically impossible, so the route's field gate holds at
      // the storage layer and not only in the handler.
      const changes: Partial<typeof weddings.$inferInsert> = {
        ...(patch.displayName !== undefined && { displayName: patch.displayName }),
        ...(patch.weddingDate !== undefined && { weddingDate: patch.weddingDate }),
        ...(patch.guestCountEstimate !== undefined && {
          guestCountEstimate: patch.guestCountEstimate,
        }),
        ...(patch.currency !== undefined && { currency: patch.currency }),
        ...(patch.budgetTotalMinor !== undefined && { budgetTotalMinor: patch.budgetTotalMinor }),
        ...(patch.rsvpDeadline !== undefined && { rsvpDeadline: patch.rsvpDeadline }),
        ...(patch.rsvpDeadlineTimezone !== undefined && {
          rsvpDeadlineTimezone: patch.rsvpDeadlineTimezone,
        }),
      };

      // The deadline's two columns are ONE fact. A zone without a date is inert
      // but misleading (the portal would re-show it next to an empty date), so
      // a write that leaves no date clears the zone in the same statement — the
      // pair can never half-exist, whichever order a client sends them in. Only
      // a patch that TOUCHES the pair can trip this, so an unrelated save still
      // writes nothing but its own columns.
      const touchesDeadline =
        patch.rsvpDeadline !== undefined || patch.rsvpDeadlineTimezone !== undefined;
      if (touchesDeadline && next.rsvpDeadline === null) {
        next.rsvpDeadlineTimezone = null;
        changes.rsvpDeadlineTimezone = null;
      }

      // A write may not MOVE the deadline into the past (S-L3). Checked on the
      // RESULTING pair rather than on the patch, because either half decides
      // the instant — shifting the zone alone can move an open deadline by up
      // to ~26 hours — and via `isRsvpClosed`, the single place a date becomes
      // a moment, so this can't disagree with the guest write gate about when a
      // day ends.
      //
      // Only a patch that CHANGES the pair is judged. A deadline that lapsed
      // naturally is a normal state to be sitting in, and the portal's owner
      // form re-sends the whole profile on every save — judging the value
      // rather than the change would lock such a wedding out of its own
      // Settings panel entirely. Clearing a lapsed deadline stays allowed too
      // (a null date isn't closed), which is how RSVPs reopen.
      const movesDeadline =
        next.rsvpDeadline !== current.rsvpDeadline ||
        next.rsvpDeadlineTimezone !== current.rsvpDeadlineTimezone;
      if (touchesDeadline && movesDeadline && next.rsvpDeadline !== null) {
        const closed = isRsvpClosed(next.rsvpDeadline, next.rsvpDeadlineTimezone, new Date());
        if (closed) {
          return yield* new RsvpDeadlineInPast({
            date: next.rsvpDeadline,
            timezone: next.rsvpDeadlineTimezone,
          });
        }
      }

      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            db
              .update(weddings)
              .set({ ...changes, updatedByOsnProfileId, updatedAt: new Date() })
              .where(eq(weddings.id, weddingId))
              .run(),
          ),
        catch: (cause) => new SettingsWriteError({ reason: "update", cause }),
      });

      return next;
    }).pipe(
      Effect.tap(() => Effect.sync(() => metricWeddingSettingsSaved("ok"))),
      Effect.tapErrorTag("SettingsWriteError", () =>
        Effect.sync(() => metricWeddingSettingsSaved("error")),
      ),
      Effect.withSpan("cire.wedding_settings.update"),
    );
  },
};
