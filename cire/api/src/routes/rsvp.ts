import { guests, guestEvents } from "@cire/db";
import { eq, inArray } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService, dbQuery } from "../db";
import type { Db } from "../db";
import { sessionAuth } from "../middleware/auth";
import { BulkRsvpBody } from "../schemas/rsvp";
import { rsvpService } from "../services/rsvp";

// S-L2: RSVP payloads are small (a family's worth of events). Reject obviously
// oversized requests before we pay for JSON parsing — mirrors the import route's
// Content-Length pre-check. The Schema (dietary/array bounds) is the real cap;
// this is a cheap upfront guard against a CDN that strips/lies notwithstanding.
const MAX_RSVP_BYTES = 256 * 1024;

export const createRsvpRoutes = (db: Db) =>
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

        return Effect.runPromise(
          Effect.gen(function* () {
            const body = yield* Schema.decodeUnknown(BulkRsvpBody)(raw);

            const dbService = yield* DbService;

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

            // Ownership + invitation already validated above — service method does
            // not re-check.
            for (const rsvp of body.rsvps) {
              yield* rsvpService.submitRsvp({
                guestId: rsvp.guestId,
                eventId: rsvp.eventId,
                status: rsvp.status,
                dietary: rsvp.dietary,
              });
            }

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
