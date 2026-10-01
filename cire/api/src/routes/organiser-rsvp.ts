import {
  ORGANISER_DIETARY_ATTESTATION,
  ORGANISER_PLUS_ONE_DIETARY_ATTESTATION,
} from "@cire/dietary";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { weddingEditor } from "../middleware/wedding-editor";
import { runCire } from "../observability";
import { OrganiserRsvpBody } from "../schemas/rsvp";
import { organiserRsvpService } from "../services/organiser-rsvp";

// Sentinel parse hook — same idiom as the other organiser PUT routes: the
// handler parses by hand so a malformed payload degrades to the schema's 400.
const manualParse = { parse: () => ({}) };

/**
 * Organiser-recorded RSVPs (platform Phase 0, [[platform-plan]] §3.3):
 *
 *   PUT /api/organiser/weddings/:weddingId/guests/:guestId/rsvps/:eventId
 *
 * An editor records a phone/paper RSVP on a guest's behalf, into the SAME
 * `rsvps` table the guest invite writes to (upsert on `(guest_id, event_id)`;
 * last-writer-wins, so it VISIBLY OVERWRITES a prior guest reply). The row is
 * stamped `consent_source='organiser_attested'` so it stays distinguishable
 * from a self-submitted answer, except on a status-only save (below).
 *
 * Gated `weddingEditor()` (owner OR editor may write; a viewer gets 403
 * `read_only_role`; a guest session has no OSN token → osnAuth 401). The
 * service re-validates guest ∈ wedding, event ∈ wedding, and (guest,event) is a
 * real invitation IN wedding scope, so a cross-tenant write is impossible.
 *
 * Deliberately its OWN direct endpoint, NOT routed through `changes/*` — RSVPs
 * sit outside the reconcile pipeline ([[platform-plan]] §5 blast-radius).
 *
 * A body with neither `dietary` nor `dietaryPresets` is status-only: it sets
 * the status and keeps the stored dietary answer, that answer's consent
 * record and its `consent_source`, whoever gave them. The portal sends one
 * whenever the organiser left the dietary fields as they were, so a status
 * change never re-attests data nobody re-confirmed.
 *
 * Dietary data on a plus-one's reply needs the organiser's plus-one
 * attestation (`ORGANISER_PLUS_ONE_DIETARY_ATTESTATION`) for the name the row
 * carries now; on anyone else's, the guest attestation.
 *
 * The wedding's RSVP DEADLINE does not gate this route. It closes the GUEST
 * invite (`POST /api/rsvp` → 403 `rsvp_closed`) so late self-service replies
 * can't land; an organiser entering a phone/paper reply that arrived after the
 * date is the very case the deadline creates, and they own the date anyway.
 */
export const createOrganiserRsvpRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) => {
  return new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group.use(weddingEditor(db)).put(
        "/guests/:guestId/rsvps/:eventId",
        async ({ weddingId, params, request, set }) => {
          // weddingEditor() always derives this; the guard keeps a future
          // remount without the plugin from compiling into an unscoped write.
          if (!weddingId) {
            set.status = 500;
            return { error: "Internal error" };
          }
          const raw: unknown = await request.json().catch(() => null);
          return runCire(
            Effect.gen(function* () {
              const body = yield* Schema.decodeUnknownEffect(OrganiserRsvpBody)(raw);

              // A body naming neither dietary field is a status-only reply;
              // the service decides what that keeps.
              const dietaryEdit = body.dietary !== undefined || body.dietaryPresets !== undefined;
              const dietary = body.dietary ?? "";

              // Art. 9(2)(a) gate (mirrors the guest path): special-category
              // dietary data may only be stored WITH consent — here the
              // organiser's attestation. Presets count as much as free text, so
              // a reply recorded entirely from the picker is gated too. The form
              // blocks this, so reaching it means a tampered client.
              const requestedPresets = body.dietaryPresets ?? [];
              const hasDietaryData = dietary.length > 0 || requestedPresets.length > 0;
              if (hasDietaryData && !body.dietaryConsent) {
                set.status = 422;
                return { error: "Dietary requirements need the guest's consent to store" };
              }
              // The attestation must name words this API stamps. A portal
              // built from another commit showed other words, so its tick is
              // refused rather than stored as evidence of copy that was not on
              // screen. Which of the two fits this guest the service decides,
              // once it knows whether the row is a plus-one's.
              if (
                hasDietaryData &&
                body.dietaryAttestation !== ORGANISER_DIETARY_ATTESTATION.version &&
                body.dietaryAttestation !== ORGANISER_PLUS_ONE_DIETARY_ATTESTATION.version
              ) {
                set.status = 422;
                yield* Effect.logWarning("organiser rsvp: dietary attestation version refused");
                return { error: "dietary_attestation_outdated" };
              }

              // Free text implies `other`, as on the guest path: an organiser
              // typing a note the picker has no key for must still leave the row
              // able to reveal it.
              const dietaryPresets =
                dietary.trim().length > 0 && !requestedPresets.includes("other")
                  ? ([...requestedPresets, "other"] as const)
                  : requestedPresets;

              const rsvp = yield* organiserRsvpService.record({
                weddingId,
                guestId: params.guestId,
                eventId: params.eventId,
                status: body.status,
                dietary: dietaryEdit ? { text: dietary, presets: dietaryPresets } : null,
                dietaryConsent: body.dietaryConsent,
                dietaryAttestation: body.dietaryAttestation,
                dietaryAttestedName: body.dietaryAttestedName,
              });
              return { rsvp };
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchTags({
                SchemaError: () =>
                  Effect.sync(() => {
                    set.status = 400;
                    return { error: "Missing or invalid fields" };
                  }),
                GuestNotInWedding: () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "guest_not_found" };
                  }),
                EventNotInWedding: () =>
                  Effect.sync(() => {
                    set.status = 404;
                    return { error: "event_not_found" };
                  }),
                GuestNotInvitedToEvent: () =>
                  Effect.sync(() => {
                    set.status = 409;
                    return { error: "guest_not_invited_to_event" };
                  }),
                PlusOneDietaryUnavailable: () =>
                  Effect.gen(function* () {
                    set.status = 422;
                    yield* Effect.logWarning(
                      "organiser rsvp: plus-one dietary attestation refused",
                    );
                    return { error: "plus_one_dietary_unavailable" };
                  }),
                PlusOneChanged: () =>
                  Effect.gen(function* () {
                    set.status = 409;
                    yield* Effect.logWarning(
                      "organiser rsvp: plus-one renamed since the form opened",
                    );
                    return { error: "plus_one_changed" };
                  }),
                DietaryAttestationMismatch: () =>
                  Effect.gen(function* () {
                    set.status = 422;
                    yield* Effect.logWarning(
                      "organiser rsvp: dietary attestation names another person",
                    );
                    return { error: "dietary_attestation_mismatch" };
                  }),
              }),
              Effect.catchDefect(() =>
                Effect.sync(() => {
                  set.status = 500;
                  return { error: "Internal error" };
                }),
              ),
            ),
          );
        },
        manualParse,
      ),
    );
};
