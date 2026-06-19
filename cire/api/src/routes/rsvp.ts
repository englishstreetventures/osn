import { families, guests, guestEvents } from "@cire/db";
import type { TurnstileVerifier } from "@shared/turnstile";
import { eq, inArray } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService, dbQuery } from "../db";
import type { Db } from "../db";
import { metricRsvpBatchSize } from "../metrics";
import { sessionAuth } from "../middleware/auth";
import { turnstileGate } from "../middleware/turnstile";
import { runCire } from "../observability";
import { BulkRsvpBody } from "../schemas/rsvp";
import { rsvpService } from "../services/rsvp";

// S-L2: RSVP payloads are small (a family's worth of events). Reject obviously
// oversized requests before we pay for JSON parsing — mirrors the import route's
// Content-Length pre-check. The Schema (dietary/array bounds) is the real cap;
// this is a cheap upfront guard against a CDN that strips/lies notwithstanding.
const MAX_RSVP_BYTES = 256 * 1024;

export interface RsvpRouteOptions {
  /**
   * Turnstile verifier (KEY-OPTIONAL). `null` ⇒ gate skipped; configured ⇒ a
   * missing/invalid token fails closed (403) after auth, before any write.
   */
  turnstileVerifier?: TurnstileVerifier | null;
}

export const createRsvpRoutes = (db: Db, { turnstileVerifier = null }: RsvpRouteOptions = {}) =>
  new Elysia({ prefix: "/api/rsvp" })
    // Gate every method under /api/rsvp behind a valid session cookie.
    .use(sessionAuth(db))
    .post(
      "/",
      async ({ request, familyId, set }) => {
        // The sessionAuth plugin guarantees this is set; the assertion below
        // is a runtime safety net.
        if (!familyId) {
          set.status = 401;
          return { error: "Unauthorized" };
        }

        const contentLengthHeader = request.headers.get("content-length");
        if (contentLengthHeader) {
          const declared = Number.parseInt(contentLengthHeader, 10);
          if (Number.isFinite(declared) && declared > MAX_RSVP_BYTES) {
            set.status = 413;
            return { error: "Payload too large" };
          }
        }

        const raw: unknown = await request.json().catch(() => null);

        // Turnstile bot gate (key-optional; no-op when unconfigured). The
        // session cookie already authenticated the household above; this is the
        // anti-automation layer on the spam-prone RSVP write surface.
        const tsErr = await turnstileGate(turnstileVerifier, "rsvp", raw, request.headers);
        if (tsErr) {
          set.status = tsErr.status;
          return { error: tsErr.error };
        }

        return runCire(
          Effect.gen(function* () {
            const body = yield* Schema.decodeUnknown(BulkRsvpBody)(raw);

            const dbService = yield* DbService;

            // The host preview family is read-only — its code unlocks every
            // event for the organiser, but it must never write real RSVP data.
            const [family] = yield* dbQuery(() =>
              dbService
                .select({ kind: families.kind })
                .from(families)
                .where(eq(families.id, familyId))
                .all(),
            );
            if (family?.kind === "host") {
              set.status = 403;
              return { error: "Preview sessions cannot submit RSVPs" };
            }

            // Guest IDs that belong to the session's family.
            const familyGuests = yield* dbQuery(() =>
              dbService
                .select({ id: guests.id })
                .from(guests)
                .where(eq(guests.familyId, familyId))
                .all(),
            );
            const familyGuestIds = new Set(familyGuests.map((g) => g.id));

            // Validate every requested guestId is owned by the session's family.
            for (const rsvp of body.rsvps) {
              if (!familyGuestIds.has(rsvp.guestId)) {
                set.status = 403;
                return { error: "One or more guests do not belong to this family" };
              }
            }

            // S-M1: every (guestId, eventId) pair must correspond to a real
            // invitation. Without this a guest could RSVP to an event they aren't
            // invited to — including another wedding's event if they learn its UUID.
            // One scoped query over guest_events covers the whole batch; we only
            // fetch links for THIS family's guests (already validated above), so a
            // foreign wedding's links can never satisfy a pair.
            const guestIds = [...new Set(body.rsvps.map((r) => r.guestId))];
            const invitations = yield* dbQuery(() =>
              dbService
                .select({ guestId: guestEvents.guestId, eventId: guestEvents.eventId })
                .from(guestEvents)
                .where(inArray(guestEvents.guestId, guestIds))
                .all(),
            );
            const invitedSet = new Set(invitations.map((i) => `${i.guestId}::${i.eventId}`));
            for (const rsvp of body.rsvps) {
              if (!invitedSet.has(`${rsvp.guestId}::${rsvp.eventId}`)) {
                set.status = 403;
                return { error: "One or more guests are not invited to that event" };
              }
            }

            // Art. 9(2)(a) gate: the special-category `dietary` free-text may
            // only be collected with the guest's explicit opt-in. Reject the
            // whole batch (422) if any non-empty dietary lacks consent — the
            // form blocks this, so reaching here means a tampered/legacy client.
            // See [[wiki/compliance/dpia/cire-guest-data]] → C-H2.
            for (const rsvp of body.rsvps) {
              if (rsvp.dietary.length > 0 && !rsvp.dietaryConsent) {
                set.status = 422;
                return { error: "Dietary requirements need your consent to store" };
              }
            }

            // Ownership + invitation already validated above — service method does
            // not re-check. Upsert the whole batch in ONE D1 round-trip (P-W1)
            // instead of N sequential ones on the guest hot path.
            yield* rsvpService.submitRsvps(
              body.rsvps.map((rsvp) => ({
                guestId: rsvp.guestId,
                eventId: rsvp.eventId,
                status: rsvp.status,
                dietary: rsvp.dietary,
                // Only stamp a consent record when there is special-category
                // data to authorise; clearing dietary clears the record too.
                dietaryConsent: rsvp.dietary.length > 0 && rsvp.dietaryConsent,
              })),
            );

            yield* Effect.sync(() => metricRsvpBatchSize(body.rsvps.length));

            const updatedRsvps = yield* rsvpService.getRsvpsForFamily(familyId);
            return { rsvps: updatedRsvps };
          }).pipe(
            Effect.provideService(DbService, db),
            Effect.catchTag("ParseError", () =>
              Effect.sync(() => {
                set.status = 400;
                return { error: "Missing or invalid fields" };
              }),
            ),
          ),
        );
      },
      // Sentinel parse hook: stops Elysia from consuming the body so the
      // handler can parse it by hand — a malformed payload degrades to the
      // schema's 400 instead of Elysia's parser error.
      { parse: () => ({}) },
    );
