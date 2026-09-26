import { guestEvents, guests } from "@cire/db";
import { eq } from "drizzle-orm";

import type { TestDb } from "../../src/db/setup";

/** A seeded guest by first name. The test seed mints fresh ids per run, so
 *  tests find their fixtures by name. */
export function guestNamed(db: TestDb, firstName: string) {
  const row = db
    .select({
      id: guests.id,
      familyId: guests.familyId,
      sortOrder: guests.sortOrder,
    })
    .from(guests)
    .where(eq(guests.firstName, firstName))
    .get();
  if (!row) throw new Error(`no guest ${firstName}`);
  return row;
}

/** Turn a guest's plus-one permission on, straight in the table. */
export function allowPlusOne(db: TestDb, guestId: string): void {
  db.update(guests).set({ plusOneAllowed: true }).where(eq(guests.id, guestId)).run();
}

/** The event ids a guest is invited to, sorted. */
export function eventIdsOf(db: TestDb, guestId: string): string[] {
  return db
    .select({ eventId: guestEvents.eventId })
    .from(guestEvents)
    .where(eq(guestEvents.guestId, guestId))
    .all()
    .map((r) => r.eventId)
    .toSorted();
}

/**
 * Seed a plus-one for `inviterId` the way the guest route leaves one: same
 * household, `source = 'manual'`, invited to the inviter's events. For tests of
 * code that READS plus-ones; the route's own tests go through the route.
 */
export function seedPlusOne(
  db: TestDb,
  inviterId: string,
  name: { firstName: string; lastName?: string },
): string {
  const inviter = db
    .select({ familyId: guests.familyId, sortOrder: guests.sortOrder })
    .from(guests)
    .where(eq(guests.id, inviterId))
    .get();
  if (!inviter) throw new Error(`no inviter ${inviterId}`);
  const id = crypto.randomUUID();
  const now = new Date();
  db.update(guests).set({ plusOneAllowed: true }).where(eq(guests.id, inviterId)).run();
  db.insert(guests)
    .values({
      id,
      familyId: inviter.familyId,
      firstName: name.firstName,
      lastName: name.lastName ?? "",
      sortOrder: inviter.sortOrder,
      source: "manual",
      plusOneOfGuestId: inviterId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  for (const eventId of eventIdsOf(db, inviterId)) {
    db.insert(guestEvents).values({ guestId: id, eventId }).run();
  }
  return id;
}
