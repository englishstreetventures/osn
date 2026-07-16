/**
 * Organiser-recorded RSVPs (platform Phase 0, [[platform-plan]] §3.3) — an
 * editor records a phone/paper RSVP on a guest's behalf, into the SAME `rsvps`
 * table the guest invite writes to (upsert on the existing `(guest_id, event_id)`
 * unique key). Last-writer-wins: an organiser write VISIBLY OVERWRITES a prior
 * guest reply and vice-versa. The row is stamped `consent_source =
 * 'organiser_attested'` so it stays distinguishable from a self-submitted one
 * and its dietary consent is recorded as organiser-attested, not guest-given
 * (Art. 9(2)(a); see [[wiki/compliance/dpia/cire-guest-data]] → C-H2).
 *
 * TENANCY: the route gate (`weddingEditor()`) proves the caller may write
 * `weddingId`. This service ADDITIONALLY re-validates, in wedding scope, that:
 *   - the guest belongs to a `kind='guest'` family under `weddingId` (a
 *     host-preview family or a cross-tenant guest fails `GuestNotInWedding`),
 *   - the event belongs to `weddingId` (`EventNotInWedding`),
 *   - the (guest, event) pair is a real invitation (`guest_events` row) —
 *     an organiser must not RSVP a guest to an event they aren't invited to
 *     (`GuestNotInvitedToEvent`).
 * The scope carries into every check, so an editor of wedding A can never
 * write a row for wedding B's guest/event even with a leaked id.
 */

import { events, families, guestEvents, guests } from "@cire/db";
import { and, eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import type { ConsentSource } from "./rsvp";
import { rsvpService } from "./rsvp";

/** The guest isn't a `kind='guest'` family member under `weddingId` (missing,
 *  another wedding's guest, or a host-preview family). 404-class. */
export class GuestNotInWedding extends Data.TaggedError("GuestNotInWedding") {}

/** The event doesn't belong to `weddingId` (missing or another wedding's).
 *  404-class. */
export class EventNotInWedding extends Data.TaggedError("EventNotInWedding") {}

/** The guest exists under the wedding but isn't invited to this event (no
 *  `guest_events` row) — an organiser must not RSVP them to it. 409/4xx-class. */
export class GuestNotInvitedToEvent extends Data.TaggedError("GuestNotInvitedToEvent") {}

export interface OrganiserRsvpInput {
  weddingId: string;
  guestId: string;
  eventId: string;
  status: "attending" | "declined" | "maybe";
  dietary: string;
  /** Whether the organiser attests the guest consented to storing the dietary
   *  free-text. Only meaningful when `dietary` is non-empty (the route collapses
   *  both); stamps the Art. 9(2)(a) consent record as organiser-attested. */
  dietaryConsent: boolean;
}

export interface OrganiserRsvpResult {
  guestId: string;
  eventId: string;
  status: "attending" | "declined" | "maybe";
  dietary: string;
  consentSource: ConsentSource;
}

export const organiserRsvpService = {
  record(
    input: OrganiserRsvpInput,
  ): Effect.Effect<
    OrganiserRsvpResult,
    GuestNotInWedding | EventNotInWedding | GuestNotInvitedToEvent,
    DbService
  > {
    const { weddingId, guestId, eventId, status, dietary } = input;
    // Consent authority is organiser-attested for every row this endpoint
    // writes; the dietary consent record is only stamped when there IS dietary
    // text to authorise (mirrors the guest path — clearing dietary clears it).
    const consentSource: ConsentSource = "organiser_attested";
    const dietaryConsent = dietary.length > 0 && input.dietaryConsent;

    return Effect.gen(function* () {
      const db = yield* DbService;

      // (1) Guest ∈ this wedding's guest families. The join to `families`
      // scopes the lookup to `weddingId` AND excludes host-preview families, so
      // a cross-tenant guest id or the organiser's own preview can't be written.
      const [guestRow] = yield* dbQuery(() =>
        db
          .select({ id: guests.id })
          .from(guests)
          .innerJoin(families, eq(guests.familyId, families.id))
          .where(
            and(
              eq(guests.id, guestId),
              eq(families.weddingId, weddingId),
              eq(families.kind, "guest"),
            ),
          )
          .all(),
      );
      if (!guestRow) return yield* Effect.fail(new GuestNotInWedding());

      // (2) Event ∈ this wedding. A foreign or unknown event id fails here
      // rather than leaking whether it exists in another wedding.
      const [eventRow] = yield* dbQuery(() =>
        db
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.id, eventId), eq(events.weddingId, weddingId)))
          .all(),
      );
      if (!eventRow) return yield* Effect.fail(new EventNotInWedding());

      // (3) The pair is a real invitation — don't let an organiser RSVP a guest
      // to an event they aren't on the list for.
      const [invite] = yield* dbQuery(() =>
        db
          .select({ guestId: guestEvents.guestId })
          .from(guestEvents)
          .where(and(eq(guestEvents.guestId, guestId), eq(guestEvents.eventId, eventId)))
          .all(),
      );
      if (!invite) return yield* Effect.fail(new GuestNotInvitedToEvent());

      // Upsert through the shared write path (same `(guest_id, event_id)`
      // conflict target + dietary-consent stamping the guest path uses), with
      // the organiser-attested provenance. Overwrites any prior reply.
      yield* rsvpService.submitRsvp({
        guestId,
        eventId,
        status,
        dietary,
        dietaryConsent,
        consentSource,
      });

      return { guestId, eventId, status, dietary, consentSource };
    }).pipe(Effect.withSpan("cire.organiser-rsvp.record"));
  },
};
