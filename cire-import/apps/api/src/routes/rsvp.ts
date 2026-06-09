import { Hono } from "hono";
import { Effect, Schema } from "effect";
import { eq } from "drizzle-orm";
import { guests } from "@cire/db";
import { rsvpService } from "../services/rsvp";
import { BulkRsvpBody } from "../schemas/rsvp";
import { DbService } from "../db";
import type { AppVariables } from "../app";

export const rsvpRoute = new Hono<{ Variables: AppVariables }>();

rsvpRoute.post("/", async (c) => {
  // The session middleware on /api/rsvp guarantees this is set; the assertion
  // below is a runtime safety net.
  const familyId = c.var.familyId;
  if (!familyId) {
    return c.json({ error: "Unauthorized" }, 401);
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
      const familyGuests = db
        .select({ id: guests.id })
        .from(guests)
        .where(eq(guests.familyId, familyId))
        .all();
      const familyGuestIds = new Set(familyGuests.map((g) => g.id));

      // Validate every requested guestId is owned by the session's family.
      for (const rsvp of body.rsvps) {
        if (!familyGuestIds.has(rsvp.guestId)) {
          return c.json({ error: "One or more guests do not belong to this family" }, 403);
        }
      }

      // Ownership already validated above against `familyGuestIds` — service
      // method does not re-check.
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
