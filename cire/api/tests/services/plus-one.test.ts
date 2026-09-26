import { beforeEach, describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  families,
  guestEvents,
  guests,
  rsvps,
  weddingEntitlements,
  weddings,
} from "@cire/db";
import { events as eventsData } from "@cire/db/seed";
import { and, eq, isNotNull } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { BASE_GUEST_CAP } from "../../src/services/entitlements";
import { hostCodeService } from "../../src/services/host-code";
import { buildCreatePlusOne, plusOneService } from "../../src/services/plus-one";
import { allowPlusOne, eventIdsOf, guestNamed, seedPlusOne } from "../test-helpers/plus-one";

let db: TestDb;

beforeEach(() => {
  db = createDb(":memory:");
  seedDb(db);
});

const run = <A, E>(eff: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));

/** Run and return the failure's tag, or "ok". */
const tagOf = <A, E extends { _tag: string }>(eff: Effect.Effect<A, E, DbService>) =>
  run(eff.pipe(Effect.match({ onFailure: (e) => e._tag, onSuccess: () => "ok" })));

function plusOnesOf(inviterId: string) {
  return db.select().from(guests).where(eq(guests.plusOneOfGuestId, inviterId)).all();
}

describe("plusOneService.save", () => {
  it("names a plus-one in the inviter's household, invited to the inviter's events", async () => {
    const bo = guestNamed(db, "Bo");
    allowPlusOne(db, bo.id);

    const result = await run(
      plusOneService.save(bo.familyId, bo.id, { firstName: "  Sam ", lastName: " Guest " }),
    );

    expect(result.created).toBe(true);
    expect(result.plusOne.firstName).toBe("Sam");
    expect(result.plusOne.lastName).toBe("Guest");
    expect(result.plusOne.plusOneOf).toBe(bo.id);
    expect(result.plusOne.eventIds.toSorted()).toEqual(eventIdsOf(db, bo.id));

    const [row] = plusOnesOf(bo.id);
    expect(row).toMatchObject({
      id: result.plusOne.guestId,
      familyId: bo.familyId,
      source: "manual",
      plusOneAllowed: false,
      sortOrder: bo.sortOrder,
    });
    expect(eventIdsOf(db, row!.id)).toEqual(eventIdsOf(db, bo.id));
  });

  it("renames the existing plus-one instead of naming a second", async () => {
    const bo = guestNamed(db, "Bo");
    allowPlusOne(db, bo.id);
    const first = await run(
      plusOneService.save(bo.familyId, bo.id, { firstName: "Sam", lastName: "" }),
    );
    const second = await run(
      plusOneService.save(bo.familyId, bo.id, { firstName: "Samira", lastName: "Khan" }),
    );

    expect(second.created).toBe(false);
    expect(second.plusOne.guestId).toBe(first.plusOne.guestId);
    expect(plusOnesOf(bo.id)).toHaveLength(1);
    expect(plusOnesOf(bo.id)[0]).toMatchObject({ firstName: "Samira", lastName: "Khan" });
  });

  it("refuses a guest without permission", async () => {
    const bo = guestNamed(db, "Bo");
    expect(
      await tagOf(plusOneService.save(bo.familyId, bo.id, { firstName: "Sam", lastName: "" })),
    ).toBe("PlusOneNotAllowed");
    expect(plusOnesOf(bo.id)).toHaveLength(0);
  });

  it("refuses a guest from another household", async () => {
    const bo = guestNamed(db, "Bo");
    const ada = guestNamed(db, "Ada");
    allowPlusOne(db, bo.id);
    expect(
      await tagOf(plusOneService.save(ada.familyId, bo.id, { firstName: "Sam", lastName: "" })),
    ).toBe("PlusOneGuestNotFound");
  });

  it("refuses a plus-one bringing a plus-one", async () => {
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam" });
    allowPlusOne(db, samId);
    expect(
      await tagOf(plusOneService.save(bo.familyId, samId, { firstName: "Pat", lastName: "" })),
    ).toBe("PlusOneCannotInvite");
  });

  it("refuses the host preview household", async () => {
    const now = new Date();
    db.insert(families)
      .values({
        id: "fam_host",
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: "HOST-TEST-0001",
        familyName: "Host",
        kind: "host",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(guests)
      .values({
        id: "g_host",
        familyId: "fam_host",
        firstName: "Host",
        plusOneAllowed: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(
      await tagOf(plusOneService.save("fam_host", "g_host", { firstName: "Sam", lastName: "" })),
    ).toBe("PlusOnePreview");
  });

  it("refuses once the RSVP deadline has passed", async () => {
    const bo = guestNamed(db, "Bo");
    allowPlusOne(db, bo.id);
    db.update(weddings)
      .set({ rsvpDeadline: "2000-01-01", rsvpDeadlineTimezone: "UTC" })
      .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
      .run();
    expect(
      await tagOf(plusOneService.save(bo.familyId, bo.id, { firstName: "Sam", lastName: "" })),
    ).toBe("PlusOneRsvpClosed");
  });

  it("refuses a household whose row is gone", async () => {
    expect(
      await tagOf(
        plusOneService.save("fam_missing", "g_missing", { firstName: "S", lastName: "" }),
      ),
    ).toBe("PlusOneHouseholdGone");
  });

  it("counts a new plus-one against the guest cap", async () => {
    const bo = guestNamed(db, "Bo");
    allowPlusOne(db, bo.id);
    // Fill the wedding to its base cap with filler guests in a new household.
    const now = new Date();
    db.insert(families)
      .values({
        id: "fam_fill",
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: "FILL-0001",
        familyName: "Filler",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const current = db
      .select({ id: guests.id })
      .from(guests)
      .innerJoin(families, eq(guests.familyId, families.id))
      .where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID))
      .all().length;
    for (let i = current; i < BASE_GUEST_CAP; i++) {
      db.insert(guests)
        .values({
          id: `g_fill_${i}`,
          familyId: "fam_fill",
          firstName: `Filler${i}`,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    db.delete(weddingEntitlements)
      .where(eq(weddingEntitlements.weddingId, BOOTSTRAP_WEDDING_ID))
      .run();

    expect(
      await tagOf(plusOneService.save(bo.familyId, bo.id, { firstName: "Sam", lastName: "" })),
    ).toBe("CapacityExceeded");
    expect(plusOnesOf(bo.id)).toHaveLength(0);
  });
});

describe("buildCreatePlusOne — the double submit", () => {
  it("writes nothing and copies no invitation when the inviter already has a plus-one", async () => {
    const bo = guestNamed(db, "Bo");
    const winner = seedPlusOne(db, bo.id, { firstName: "Sam" });
    const statements = buildCreatePlusOne(db, {
      newId: "g_loser",
      inviterGuestId: bo.id,
      familyId: bo.familyId,
      sortOrder: bo.sortOrder,
      name: { firstName: "Pat", lastName: "" },
      now: new Date(),
    });
    // Sequentially, as the bun:sqlite fallback runs a batch.
    for (const stmt of statements) await stmt;

    expect(plusOnesOf(bo.id).map((g) => g.id)).toEqual([winner]);
    expect(db.select().from(guestEvents).where(eq(guestEvents.guestId, "g_loser")).all()).toEqual(
      [],
    );
  });
});

describe("plusOneService.remove", () => {
  it("removes the plus-one with their replies and invitations", async () => {
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam" });
    db.insert(rsvps)
      .values({
        id: "r_sam",
        guestId: samId,
        eventId: eventsData.hindu.id,
        status: "attending",
        consentSource: "inviter_attested",
        createdAt: new Date(),
      })
      .run();

    expect(await run(plusOneService.remove(bo.familyId, bo.id))).toEqual({ removed: true });
    expect(plusOnesOf(bo.id)).toHaveLength(0);
    expect(db.select().from(rsvps).where(eq(rsvps.guestId, samId)).all()).toEqual([]);
    expect(eventIdsOf(db, samId)).toEqual([]);
    // The inviter is untouched.
    expect(guestNamed(db, "Bo").id).toBe(bo.id);
  });

  it("is idempotent", async () => {
    const bo = guestNamed(db, "Bo");
    expect(await run(plusOneService.remove(bo.familyId, bo.id))).toEqual({ removed: false });
  });

  it("refuses once the RSVP deadline has passed", async () => {
    const bo = guestNamed(db, "Bo");
    seedPlusOne(db, bo.id, { firstName: "Sam" });
    db.update(weddings)
      .set({ rsvpDeadline: "2000-01-01" })
      .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
      .run();
    expect(await tagOf(plusOneService.remove(bo.familyId, bo.id))).toBe("PlusOneRsvpClosed");
    expect(plusOnesOf(bo.id)).toHaveLength(1);
  });
});

describe("plusOneService.setGuestPermission", () => {
  it("turns one guest's permission on and off", async () => {
    const bo = guestNamed(db, "Bo");
    const on = await run(
      plusOneService.setGuestPermission({
        weddingId: BOOTSTRAP_WEDDING_ID,
        guestId: bo.id,
        allowed: true,
        removePlusOne: false,
      }),
    );
    expect(on).toEqual({ guestId: bo.id, plusOneAllowed: true, plusOneRemoved: false });
    const allowed = () =>
      db.select({ a: guests.plusOneAllowed }).from(guests).where(eq(guests.id, bo.id)).get()?.a;
    expect(allowed()).toBe(true);

    await run(
      plusOneService.setGuestPermission({
        weddingId: BOOTSTRAP_WEDDING_ID,
        guestId: bo.id,
        allowed: false,
        removePlusOne: false,
      }),
    );
    expect(allowed()).toBe(false);
  });

  it("refuses to turn it off over a named plus-one unless told to remove them", async () => {
    const bo = guestNamed(db, "Bo");
    seedPlusOne(db, bo.id, { firstName: "Sam" });
    const input = { weddingId: BOOTSTRAP_WEDDING_ID, guestId: bo.id, allowed: false };

    expect(await tagOf(plusOneService.setGuestPermission({ ...input, removePlusOne: false }))).toBe(
      "PlusOneNamed",
    );
    expect(plusOnesOf(bo.id)).toHaveLength(1);

    const result = await run(plusOneService.setGuestPermission({ ...input, removePlusOne: true }));
    expect(result).toEqual({ guestId: bo.id, plusOneAllowed: false, plusOneRemoved: true });
    expect(plusOnesOf(bo.id)).toHaveLength(0);
  });

  it("refuses a plus-one's own row", async () => {
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam" });
    expect(
      await tagOf(
        plusOneService.setGuestPermission({
          weddingId: BOOTSTRAP_WEDDING_ID,
          guestId: samId,
          allowed: true,
          removePlusOne: false,
        }),
      ),
    ).toBe("PlusOneCannotInvite");
  });

  it("refuses a guest of another wedding", async () => {
    const bo = guestNamed(db, "Bo");
    expect(
      await tagOf(
        plusOneService.setGuestPermission({
          weddingId: "wed_other",
          guestId: bo.id,
          allowed: true,
          removePlusOne: false,
        }),
      ),
    ).toBe("PlusOneGuestNotFound");
  });
});

describe("plusOneService.setHouseholdPermission", () => {
  it("sets every member's permission and skips the household's plus-ones", async () => {
    const bo = guestNamed(db, "Bo");
    const cleo = guestNamed(db, "Cleo");
    const samId = seedPlusOne(db, cleo.id, { firstName: "Sam" });

    const result = await run(
      plusOneService.setHouseholdPermission({
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: bo.familyId,
        allowed: true,
        removePlusOnes: false,
      }),
    );
    // Bo, Cleo, Dot — not Sam.
    expect(result).toEqual({
      familyId: bo.familyId,
      plusOneAllowed: true,
      guestsUpdated: 3,
      plusOnesRemoved: 0,
    });
    const rows = db
      .select({ id: guests.id, allowed: guests.plusOneAllowed })
      .from(guests)
      .where(eq(guests.familyId, bo.familyId))
      .all();
    for (const row of rows) expect(row.allowed).toBe(row.id !== samId);
  });

  it("refuses to turn it off over named plus-ones unless told to remove them", async () => {
    const bo = guestNamed(db, "Bo");
    seedPlusOne(db, bo.id, { firstName: "Sam" });
    seedPlusOne(db, guestNamed(db, "Cleo").id, { firstName: "Pat" });
    const input = { weddingId: BOOTSTRAP_WEDDING_ID, familyId: bo.familyId, allowed: false };

    expect(
      await tagOf(plusOneService.setHouseholdPermission({ ...input, removePlusOnes: false })),
    ).toBe("PlusOneNamed");

    const result = await run(
      plusOneService.setHouseholdPermission({ ...input, removePlusOnes: true }),
    );
    expect(result.plusOnesRemoved).toBe(2);
    expect(
      db
        .select()
        .from(guests)
        .where(and(eq(guests.familyId, bo.familyId), isNotNull(guests.plusOneOfGuestId)))
        .all(),
    ).toEqual([]);
  });

  it("refuses a household of another wedding", async () => {
    const bo = guestNamed(db, "Bo");
    expect(
      await tagOf(
        plusOneService.setHouseholdPermission({
          weddingId: "wed_other",
          familyId: bo.familyId,
          allowed: true,
          removePlusOnes: false,
        }),
      ),
    ).toBe("PlusOneFamilyNotFound");
  });
});

describe("the inviter's removal", () => {
  it("removes their plus-one through the foreign key", () => {
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam" });
    db.delete(guests).where(eq(guests.id, bo.id)).run();
    expect(db.select().from(guests).where(eq(guests.id, samId)).all()).toEqual([]);
  });
});

describe("plusOneService — the branches either side of each rule", () => {
  it("writes nothing for a rename to the same name", async () => {
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam", lastName: "Guest" });
    // An old stamp, so a write in this same second would still show.
    db.update(guests)
      .set({ updatedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(guests.id, samId))
      .run();
    const stamp = () =>
      db.select({ at: guests.updatedAt }).from(guests).where(eq(guests.id, samId)).get()?.at;
    const before = stamp();
    const result = await run(
      plusOneService.save(bo.familyId, bo.id, { firstName: " Sam ", lastName: "Guest" }),
    );
    expect(result).toMatchObject({ created: false, plusOne: { guestId: samId, firstName: "Sam" } });
    expect(stamp()).toEqual(before);
  });

  it("deletes nothing when permission goes ON, whatever the remove flag says", async () => {
    const bo = guestNamed(db, "Bo");
    seedPlusOne(db, bo.id, { firstName: "Sam" });
    const result = await run(
      plusOneService.setGuestPermission({
        weddingId: BOOTSTRAP_WEDDING_ID,
        guestId: bo.id,
        allowed: true,
        removePlusOne: true,
      }),
    );
    expect(result.plusOneRemoved).toBe(false);
    expect(plusOnesOf(bo.id)).toHaveLength(1);

    const household = await run(
      plusOneService.setHouseholdPermission({
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: bo.familyId,
        allowed: true,
        removePlusOnes: true,
      }),
    );
    expect(household.plusOnesRemoved).toBe(0);
    expect(plusOnesOf(bo.id)).toHaveLength(1);
  });

  it("turns a household off without the flag when no plus-one is named", async () => {
    const bo = guestNamed(db, "Bo");
    const result = await run(
      plusOneService.setHouseholdPermission({
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: bo.familyId,
        allowed: false,
        removePlusOnes: false,
      }),
    );
    expect(result).toMatchObject({ plusOneAllowed: false, guestsUpdated: 3, plusOnesRemoved: 0 });
  });

  it("sets an empty household without complaint", async () => {
    const now = new Date();
    db.insert(families)
      .values({
        id: "fam_empty",
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: "EMPTY-0001",
        familyName: "Empty",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const result = await run(
      plusOneService.setHouseholdPermission({
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: "fam_empty",
        allowed: true,
        removePlusOnes: false,
      }),
    );
    expect(result).toEqual({
      familyId: "fam_empty",
      plusOneAllowed: true,
      guestsUpdated: 0,
      plusOnesRemoved: 0,
    });
  });

  it("lets a household take its plus-one back after permission is gone", async () => {
    const bo = guestNamed(db, "Bo");
    seedPlusOne(db, bo.id, { firstName: "Sam" });
    db.update(guests).set({ plusOneAllowed: false }).where(eq(guests.id, bo.id)).run();
    expect(await run(plusOneService.remove(bo.familyId, bo.id))).toEqual({ removed: true });
  });

  it("refuses to remove another household's plus-one", async () => {
    const ada = guestNamed(db, "Ada");
    const bo = guestNamed(db, "Bo");
    seedPlusOne(db, ada.id, { firstName: "Sam" });
    expect(await tagOf(plusOneService.remove(bo.familyId, ada.id))).toBe("PlusOneGuestNotFound");
    expect(plusOnesOf(ada.id)).toHaveLength(1);
  });
});

describe("plusOneService — the host-preview household", () => {
  it("is outside both organiser writes", async () => {
    await Effect.runPromise(
      hostCodeService
        .ensureForWedding(BOOTSTRAP_WEDDING_ID, "cire-wedding")
        .pipe(Effect.provideService(DbService, db)),
    );
    const [host] = db
      .select({ familyId: families.id, guestId: guests.id })
      .from(guests)
      .innerJoin(families, eq(guests.familyId, families.id))
      .where(eq(families.kind, "host"))
      .all();
    expect(
      await tagOf(
        plusOneService.setGuestPermission({
          weddingId: BOOTSTRAP_WEDDING_ID,
          guestId: host!.guestId,
          allowed: true,
          removePlusOne: false,
        }),
      ),
    ).toBe("PlusOneGuestNotFound");
    expect(
      await tagOf(
        plusOneService.setHouseholdPermission({
          weddingId: BOOTSTRAP_WEDDING_ID,
          familyId: host!.familyId,
          allowed: true,
          removePlusOnes: false,
        }),
      ),
    ).toBe("PlusOneFamilyNotFound");
    const row = db
      .select({ allowed: guests.plusOneAllowed })
      .from(guests)
      .where(eq(guests.id, host!.guestId))
      .get();
    expect(row?.allowed).toBe(false);
  });
});
