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
 * One exception: a status-only recording (no dietary answer sent) sets the
 * status and keeps the stored dietary answer, with its consent record and its
 * `consent_source`, whoever gave it (`rsvpService.recordStatus`).
 *
 * The organiser's attestation names whom it is about. A guest's dietary data
 * is stored under `ORGANISER_DIETARY_ATTESTATION`; a plus-one's only under
 * `ORGANISER_PLUS_ONE_DIETARY_ATTESTATION`, for the name the plus-one's row
 * carries now.
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
import {
  ORGANISER_DIETARY_ATTESTATION,
  ORGANISER_PLUS_ONE_DIETARY_ATTESTATION,
  type DietaryPreset,
} from "@cire/dietary";
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

/** Dietary data on a plus-one's reply without the organiser's plus-one
 *  attestation (`ORGANISER_PLUS_ONE_DIETARY_ATTESTATION`). The guest
 *  attestation speaks of "the guest", so a tick against it is no evidence the
 *  plus-one consented. 422-class. */
export class PlusOneDietaryUnavailable extends Data.TaggedError("PlusOneDietaryUnavailable") {}

/** Dietary data on a plus-one's reply attested for a name the row no longer
 *  carries: the portal showed the box for someone the household has since
 *  renamed. 409-class, so the portal reloads rather than attest for someone
 *  else. */
export class PlusOneChanged extends Data.TaggedError("PlusOneChanged") {}

/** Dietary data on a guest's reply attested with the plus-one wording, which
 *  speaks of someone else. 422-class. */
export class DietaryAttestationMismatch extends Data.TaggedError("DietaryAttestationMismatch") {}

export interface OrganiserRsvpInput {
  weddingId: string;
  guestId: string;
  eventId: string;
  status: "attending" | "declined" | "maybe";
  /** The dietary answer as recorded by the organiser from a phone or paper
   *  reply: free text and picks from the closed vocabulary. `null` when the
   *  organiser recorded a status only, which keeps the stored answer. */
  dietary: { text: string; presets: readonly DietaryPreset[] } | null;
  /** Whether the organiser attests the guest consented to storing their dietary
   *  requirements. Only meaningful when there IS dietary data — presets or free
   *  text, both special-category (the route collapses those); stamps the
   *  Art. 9(2)(a) consent record as organiser-attested. */
  dietaryConsent: boolean;
  /** The version of the attestation wording the portal showed. Checked only
   *  when there is dietary data; the route has already refused any version
   *  that is neither organiser attestation's. */
  dietaryAttestation: string;
  /** The full name the portal showed a plus-one's box for. Checked only on a
   *  plus-one's dietary data. */
  dietaryAttestedName: string;
}

export interface OrganiserRsvpResult {
  guestId: string;
  eventId: string;
  status: "attending" | "declined" | "maybe";
  dietary: string;
  dietaryPresets: readonly DietaryPreset[];
  consentSource: ConsentSource;
}

export const organiserRsvpService = {
  record(
    input: OrganiserRsvpInput,
  ): Effect.Effect<
    OrganiserRsvpResult,
    | GuestNotInWedding
    | EventNotInWedding
    | GuestNotInvitedToEvent
    | PlusOneDietaryUnavailable
    | PlusOneChanged
    | DietaryAttestationMismatch,
    DbService
  > {
    const { weddingId, guestId, eventId, status } = input;
    const dietary = input.dietary?.text ?? "";
    const dietaryPresets = input.dietary?.presets ?? [];
    // Consent authority is organiser-attested for every dietary answer this
    // endpoint writes; the consent record is only stamped when there IS
    // dietary data to authorise — presets or free text (mirrors the guest
    // path — clearing the whole answer clears it).
    const consentSource: ConsentSource = "organiser_attested";
    const hasDietaryData = dietary.length > 0 || dietaryPresets.length > 0;
    const dietaryConsent = hasDietaryData && input.dietaryConsent;

    return Effect.gen(function* () {
      const db = yield* DbService;

      // (1) Guest ∈ this wedding's guest families. The join to `families`
      // scopes the lookup to `weddingId` AND excludes host-preview families, so
      // a cross-tenant guest id or the organiser's own preview can't be written.
      const [guestRow] = yield* dbQuery(() =>
        db
          .select({
            id: guests.id,
            plusOneOf: guests.plusOneOfGuestId,
            firstName: guests.firstName,
            lastName: guests.lastName,
          })
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
      const isPlusOne = guestRow.plusOneOf !== null;
      // The attestation must speak of the person the row is about: the
      // plus-one wording, for the name the row carries now, on a plus-one's
      // reply; the guest wording on anyone else's.
      if (hasDietaryData && isPlusOne) {
        if (input.dietaryAttestation !== ORGANISER_PLUS_ONE_DIETARY_ATTESTATION.version) {
          return yield* Effect.fail(new PlusOneDietaryUnavailable());
        }
        const currentName = `${guestRow.firstName} ${guestRow.lastName}`.trim();
        if (input.dietaryAttestedName.trim() !== currentName) {
          return yield* Effect.fail(new PlusOneChanged());
        }
      }
      if (
        hasDietaryData &&
        !isPlusOne &&
        input.dietaryAttestation !== ORGANISER_DIETARY_ATTESTATION.version
      ) {
        return yield* Effect.fail(new DietaryAttestationMismatch());
      }

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

      // A status-only reply: the stored dietary answer was given under its
      // own consent or attestation, which this save does not repeat, so it
      // stays, with its consent record and source.
      if (input.dietary === null) {
        const stored = yield* rsvpService.recordStatus({ guestId, eventId, status });
        return { guestId, eventId, ...stored };
      }

      // Upsert through the shared write path (same `(guest_id, event_id)`
      // conflict target + dietary-consent stamping the guest path uses), with
      // the organiser-attested provenance. Overwrites any prior reply.
      yield* rsvpService.submitRsvp({
        guestId,
        eventId,
        status,
        dietary,
        dietaryPresets,
        dietaryConsent,
        consentSource,
        plusOne: isPlusOne,
      });

      return { guestId, eventId, status, dietary, dietaryPresets, consentSource };
    }).pipe(Effect.withSpan("cire.organiser-rsvp.record"));
  },
};
