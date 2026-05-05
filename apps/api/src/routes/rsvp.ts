import { Hono } from "hono";
import { Effect, Schema } from "effect";
import { eq } from "drizzle-orm";
import { families, guests } from "@cire/db";
import { rsvpService } from "../services/rsvp";
import { BulkRsvpBody } from "../schemas/rsvp";
import { DbService } from "../db";
import type { Db } from "../db";

type AppVariables = { db: Db };

export const rsvpRoute = new Hono<{ Variables: AppVariables }>();

rsvpRoute.post("/", async (c) => {
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

      // Look up family by publicId
      const [family] = db
        .select()
        .from(families)
        .where(eq(families.publicId, body.familyPublicId.trim().toUpperCase()))
        .all();

      if (!family) {
        return c.json({ error: "Invalid credentials" }, 401);
      }

      // Get all guest IDs belonging to this family
      const familyGuests = db
        .select({ id: guests.id })
        .from(guests)
        .where(eq(guests.familyId, family.id))
        .all();
      const familyGuestIds = new Set(familyGuests.map((g) => g.id));

      // Validate all guestIds belong to this family
      for (const rsvp of body.rsvps) {
        if (!familyGuestIds.has(rsvp.guestId)) {
          return c.json({ error: "One or more guests do not belong to this family" }, 403);
        }
      }

      // Upsert each RSVP
      for (const rsvp of body.rsvps) {
        yield* rsvpService.submitRsvp({
          guestId: rsvp.guestId,
          eventId: rsvp.eventId,
          status: rsvp.status,
          dietary: rsvp.dietary,
          familyId: family.id,
        });
      }

      // Return updated state
      const updatedRsvps = yield* rsvpService.getRsvpsForFamily(family.id);
      return c.json({ rsvps: updatedRsvps });
    }).pipe(
      Effect.provideService(DbService, c.var.db),
      Effect.catchTag("ParseError", () =>
        Effect.succeed(c.json({ error: "Missing or invalid fields" }, 400)),
      ),
      Effect.catchTag("RsvpError", (e) => Effect.succeed(c.json({ error: e.message }, 403))),
    ),
  );
});
