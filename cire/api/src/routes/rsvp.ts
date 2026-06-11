import { guests, guestEvents } from "@cire/db";
import { eq, inArray } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { Hono } from "hono";

import type { AppVariables } from "../app";
import { DbService, dbQuery } from "../db";
import { BulkRsvpBody } from "../schemas/rsvp";
import { rsvpService } from "../services/rsvp";

export const rsvpRoute = new Hono<{ Variables: AppVariables }>();

// S-L2: RSVP payloads are small (a family's worth of events). Reject obviously
// oversized requests before we pay for JSON parsing — mirrors the import route's
// Content-Length pre-check. The Schema (dietary/array bounds) is the real cap;
// this is a cheap upfront guard against a CDN that strips/lies notwithstanding.
const MAX_RSVP_BYTES = 256 * 1024;

rsvpRoute.post("/", async (c) => {
  // The session middleware on /api/rsvp guarantees this is set; the assertion
  // below is a runtime safety net.
  const familyId = c.var.familyId;
  if (!familyId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const contentLengthHeader = c.req.header("content-length");
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > MAX_RSVP_BYTES) {
      return c.json({ error: "Payload too large" }, 413);
    }
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = null;
  }

  return Effect.runPromise(
    Effect.gen(function* () {
      const body = yield* Schema.decodeUnknown(BulkRsvpBody)(raw);

      const db = yield* DbService;

      // Guest IDs that belong to the session's family.
      const familyGuests = yield* dbQuery(() =>
        db.select({ id: guests.id }).from(guests).where(eq(guests.familyId, familyId)).all(),
      );
      const familyGuestIds = new Set(familyGuests.map((g) => g.id));

      // Validate every requested guestId is owned by the session's family.
      for (const rsvp of body.rsvps) {
        if (!familyGuestIds.has(rsvp.guestId)) {
          return c.json({ error: "One or more guests do not belong to this family" }, 403);
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
        db
          .select({ guestId: guestEvents.guestId, eventId: guestEvents.eventId })
          .from(guestEvents)
          .where(inArray(guestEvents.guestId, guestIds))
          .all(),
      );
      const invitedSet = new Set(invitations.map((i) => `${i.guestId}::${i.eventId}`));
      for (const rsvp of body.rsvps) {
        if (!invitedSet.has(`${rsvp.guestId}::${rsvp.eventId}`)) {
          return c.json({ error: "One or more guests are not invited to that event" }, 403);
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
      return c.json({ rsvps: updatedRsvps });
    }).pipe(
      Effect.provideService(DbService, c.var.db),
      Effect.catchTag("ParseError", () =>
        Effect.succeed(c.json({ error: "Missing or invalid fields" }, 400)),
      ),
    ),
  );
});
