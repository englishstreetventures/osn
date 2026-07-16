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
 * from a self-submitted answer.
 *
 * Gated `weddingEditor()` (owner OR editor may write; a viewer gets 403
 * `read_only_role`; a guest session has no OSN token → osnAuth 401). The
 * service re-validates guest ∈ wedding, event ∈ wedding, and (guest,event) is a
 * real invitation IN wedding scope, so a cross-tenant write is impossible.
 *
 * Deliberately its OWN direct endpoint, NOT routed through `changes/*` — RSVPs
 * sit outside the reconcile pipeline ([[platform-plan]] §5 blast-radius).
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
              const body = yield* Schema.decodeUnknown(OrganiserRsvpBody)(raw);

              // Art. 9(2)(a) gate (mirrors the guest path): the special-category
              // dietary free-text may only be stored WITH consent — here the
              // organiser's attestation. Reject (422) any non-empty dietary the
              // organiser did not attest consent for. The form blocks this, so
              // reaching it means a tampered client.
              if (body.dietary.length > 0 && !body.dietaryConsent) {
                set.status = 422;
                return { error: "Dietary requirements need the guest's consent to store" };
              }

              const rsvp = yield* organiserRsvpService.record({
                weddingId,
                guestId: params.guestId,
                eventId: params.eventId,
                status: body.status,
                dietary: body.dietary,
                dietaryConsent: body.dietaryConsent,
              });
              return { rsvp };
            }).pipe(
              Effect.provideService(DbService, db),
              Effect.catchTags({
                ParseError: () =>
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
              }),
              Effect.catchAllDefect(() =>
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
