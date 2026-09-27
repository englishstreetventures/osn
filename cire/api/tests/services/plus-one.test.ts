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
import type { Db } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { BASE_GUEST_CAP } from "../../src/services/entitlements";
import { hostCodeService } from "../../src/services/host-code";
import { buildCreatePlusOne, plusOneService } from "../../src/services/plus-one";
import { recordStatements } from "../test-helpers";
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

/** Run and return the failure itself, or "ok". */
const failureOf = <A, E extends object>(eff: Effect.Effect<A, E, DbService>) =>
  run(
    eff.pipe(
      Effect.match({ onFailure: (e): unknown => ({ ...e }), onSuccess: (): unknown => "ok" }),
    ),
  );

function plusOnesOf(inviterId: string) {
  return db.select().from(guests).where(eq(guests.plusOneOfGuestId, inviterId)).all();
}

const allowedOf = (guestId: string) =>
  db.select({ a: guests.plusOneAllowed }).from(guests).where(eq(guests.id, guestId)).get()?.a;

/** Every plus-one in a household as the organiser was shown them: id and name
 *  exactly as stored, the way `GET …/guests` serves them. */
function confirmedIn(familyId: string) {
  return db
    .select({ guestId: guests.id, firstName: guests.firstName, lastName: guests.lastName })
    .from(guests)
    .where(and(eq(guests.familyId, familyId), isNotNull(guests.plusOneOfGuestId)))
    .all();
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
        removePlusOnes: [],
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
        removePlusOnes: [],
      }),
    );
    expect(allowed()).toBe(false);
  });

  it("refuses to turn it off over a named plus-one unless they are confirmed for removal", async () => {
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam", lastName: "Lee" });
    const input = { weddingId: BOOTSTRAP_WEDDING_ID, guestId: bo.id, allowed: false };

    expect(
      await failureOf(plusOneService.setGuestPermission({ ...input, removePlusOnes: [] })),
    ).toEqual({
      _tag: "PlusOneNamed",
      named: 1,
    });
    expect(plusOnesOf(bo.id)).toHaveLength(1);
    expect(allowedOf(bo.id)).toBe(true);

    const result = await run(
      plusOneService.setGuestPermission({
        ...input,
        removePlusOnes: [{ guestId: samId, firstName: "Sam", lastName: "Lee" }],
      }),
    );
    expect(result).toEqual({ guestId: bo.id, plusOneAllowed: false, plusOneRemoved: true });
    expect(plusOnesOf(bo.id)).toHaveLength(0);
    expect(allowedOf(bo.id)).toBe(false);
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
          removePlusOnes: [],
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
          removePlusOnes: [],
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
        removePlusOnes: [],
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

  it("refuses to turn it off over named plus-ones unless they are confirmed for removal", async () => {
    const bo = guestNamed(db, "Bo");
    seedPlusOne(db, bo.id, { firstName: "Sam" });
    seedPlusOne(db, guestNamed(db, "Cleo").id, { firstName: "Pat" });
    const input = { weddingId: BOOTSTRAP_WEDDING_ID, familyId: bo.familyId, allowed: false };

    expect(
      await failureOf(plusOneService.setHouseholdPermission({ ...input, removePlusOnes: [] })),
    ).toEqual({ _tag: "PlusOneNamed", named: 2 });

    const result = await run(
      plusOneService.setHouseholdPermission({ ...input, removePlusOnes: confirmedIn(bo.familyId) }),
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
          removePlusOnes: [],
        }),
      ),
    ).toBe("PlusOneFamilyNotFound");
  });
});

describe("plusOneService — a removal the organiser was not shown", () => {
  // The organiser confirms a removal naming the plus-ones they were shown; the
  // household can change them before the write lands. Everything the write
  // would delete must still be someone on that list, by id AND name, or it
  // writes nothing — neither the delete nor the permission.
  const off = (
    guestId: string,
    removePlusOnes: { guestId: string; firstName: string; lastName: string }[],
  ) =>
    plusOneService.setGuestPermission({
      weddingId: BOOTSTRAP_WEDDING_ID,
      guestId,
      allowed: false,
      removePlusOnes,
    });
  const householdOff = (
    familyId: string,
    removePlusOnes: { guestId: string; firstName: string; lastName: string }[],
  ) =>
    plusOneService.setHouseholdPermission({
      weddingId: BOOTSTRAP_WEDDING_ID,
      familyId,
      allowed: false,
      removePlusOnes,
    });

  it("one guest: refuses when the plus-one was replaced by someone new", async () => {
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam" });
    const shown = confirmedIn(bo.familyId);
    // The household takes Sam back and names Kit before the organiser's yes lands.
    db.delete(guests).where(eq(guests.id, samId)).run();
    const kitId = seedPlusOne(db, bo.id, { firstName: "Kit" });

    expect(await failureOf(off(bo.id, shown))).toEqual({ _tag: "PlusOneNamed", named: 1 });
    expect(plusOnesOf(bo.id).map((g) => g.id)).toEqual([kitId]);
    expect(allowedOf(bo.id)).toBe(true);
  });

  it("one guest: refuses when the same row was renamed", async () => {
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam", lastName: "Lee" });
    const shown = confirmedIn(bo.familyId);
    db.update(guests).set({ firstName: "Kit", lastName: "Ng" }).where(eq(guests.id, samId)).run();

    expect(await failureOf(off(bo.id, shown))).toEqual({ _tag: "PlusOneNamed", named: 1 });
    expect(plusOnesOf(bo.id)).toMatchObject([{ id: samId, firstName: "Kit" }]);
    expect(allowedOf(bo.id)).toBe(true);
  });

  it("compares each half of the name exactly", async () => {
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam", lastName: "Lee" });
    for (const [firstName, lastName] of [
      ["sam", "Lee"],
      ["Sam ", "Lee"],
      ["Sam", ""],
      ["Sam Lee", ""],
    ] as const) {
      expect(await failureOf(off(bo.id, [{ guestId: samId, firstName, lastName }]))).toEqual({
        _tag: "PlusOneNamed",
        named: 1,
      });
    }
    expect(plusOnesOf(bo.id)).toHaveLength(1);
  });

  it("a household: refuses when one of its plus-ones was renamed, and removes none", async () => {
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam" });
    const patId = seedPlusOne(db, guestNamed(db, "Cleo").id, { firstName: "Pat" });
    const shown = confirmedIn(bo.familyId);
    db.update(guests).set({ firstName: "Kit" }).where(eq(guests.id, patId)).run();

    expect(await failureOf(householdOff(bo.familyId, shown))).toEqual({
      _tag: "PlusOneNamed",
      named: 2,
    });
    expect(
      confirmedIn(bo.familyId)
        .map((g) => g.guestId)
        .toSorted(),
    ).toEqual([samId, patId].toSorted());
    expect(allowedOf(bo.id)).toBe(true);
  });

  it("a household: refuses when a plus-one was named after the confirmation", async () => {
    const bo = guestNamed(db, "Bo");
    seedPlusOne(db, bo.id, { firstName: "Sam" });
    const shown = confirmedIn(bo.familyId);
    seedPlusOne(db, guestNamed(db, "Dot").id, { firstName: "Pat" });

    expect(await failureOf(householdOff(bo.familyId, shown))).toEqual({
      _tag: "PlusOneNamed",
      named: 2,
    });
    expect(confirmedIn(bo.familyId)).toHaveLength(2);
  });

  it("counts a list entry with a missing field as confirming no one", async () => {
    // The body schema refuses such an entry; this pins that the SQL fails closed
    // on its own too, since `NOT IN` against a NULL would read as "confirmed".
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam", lastName: "Lee" });
    const broken = { guestId: samId, firstName: "Sam", lastName: null as unknown as string };

    expect(await failureOf(off(bo.id, [broken]))).toEqual({ _tag: "PlusOneNamed", named: 1 });
    expect(plusOnesOf(bo.id)).toHaveLength(1);
  });

  it("goes ahead when a confirmed plus-one was already taken back, removing the rest", async () => {
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam" });
    seedPlusOne(db, guestNamed(db, "Cleo").id, { firstName: "Pat" });
    const shown = confirmedIn(bo.familyId);
    db.delete(guests).where(eq(guests.id, samId)).run();

    const result = await run(householdOff(bo.familyId, shown));
    expect(result).toMatchObject({ plusOneAllowed: false, plusOnesRemoved: 1 });
    expect(confirmedIn(bo.familyId)).toEqual([]);
    expect(allowedOf(bo.id)).toBe(false);
  });

  it("goes ahead, removing no one, when every confirmed plus-one is already gone", async () => {
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam" });
    const shown = confirmedIn(bo.familyId);
    db.delete(guests).where(eq(guests.id, samId)).run();

    expect(await run(off(bo.id, shown))).toEqual({
      guestId: bo.id,
      plusOneAllowed: false,
      plusOneRemoved: false,
    });
    expect(allowedOf(bo.id)).toBe(false);
  });

  it("never reaches a plus-one outside the scope, even one on the list", async () => {
    const ada = guestNamed(db, "Ada");
    const bo = guestNamed(db, "Bo");
    const adaPlusOne = seedPlusOne(db, ada.id, { firstName: "Sam" });
    const boPlusOne = seedPlusOne(db, bo.id, { firstName: "Pat" });
    const everyone = [...confirmedIn(ada.familyId), ...confirmedIn(bo.familyId)];

    expect(await run(off(bo.id, everyone))).toMatchObject({ plusOneRemoved: true });
    expect(await run(householdOff(bo.familyId, everyone))).toMatchObject({ plusOnesRemoved: 0 });
    expect(plusOnesOf(ada.id).map((g) => g.id)).toEqual([adaPlusOne]);
    expect(plusOnesOf(bo.id)).toEqual([]);
    expect(boPlusOne).not.toBe(adaPlusOne);
  });

  it("removes a plus-one with their replies and invitations, and counts only the plus-one", async () => {
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
    expect(eventIdsOf(db, samId).length).toBeGreaterThan(0);

    const result = await run(householdOff(bo.familyId, confirmedIn(bo.familyId)));
    expect(result.plusOnesRemoved).toBe(1);
    expect(db.select().from(rsvps).where(eq(rsvps.guestId, samId)).all()).toEqual([]);
    expect(eventIdsOf(db, samId)).toEqual([]);
  });
});

describe("plusOneService — a plus-one named after the lookup, before the write", () => {
  /**
   * Runs `stage` once, just before the permission-off UPDATE is prepared: after
   * the service's own lookup has read the household, before its batch runs. A
   * decision taken from that lookup would miss what `stage` writes; the check
   * inside the batch sees it.
   */
  function beforePermissionWrite(stage: () => void): void {
    const client = db.$client;
    const prepare = client.prepare.bind(client);
    let staged = false;
    Object.defineProperty(client, "prepare", {
      configurable: true,
      value: (sql: string) => {
        if (!staged && sql.startsWith('update "guests" set "plus_one_allowed"')) {
          staged = true;
          stage();
        }
        return prepare(sql);
      },
    });
  }

  it("refuses a plain turn-off, and leaves the permission on", async () => {
    const bo = guestNamed(db, "Bo");
    allowPlusOne(db, bo.id);
    let samId = "";
    beforePermissionWrite(() => {
      samId = seedPlusOne(db, bo.id, { firstName: "Sam" });
    });

    expect(
      await failureOf(
        plusOneService.setGuestPermission({
          weddingId: BOOTSTRAP_WEDDING_ID,
          guestId: bo.id,
          allowed: false,
          removePlusOnes: [],
        }),
      ),
    ).toEqual({ _tag: "PlusOneNamed", named: 1 });
    expect(plusOnesOf(bo.id).map((g) => g.id)).toEqual([samId]);
    expect(allowedOf(bo.id)).toBe(true);
  });

  it("refuses a confirmed household removal, and deletes no one", async () => {
    const bo = guestNamed(db, "Bo");
    const samId = seedPlusOne(db, bo.id, { firstName: "Sam" });
    const shown = confirmedIn(bo.familyId);
    let patId = "";
    beforePermissionWrite(() => {
      patId = seedPlusOne(db, guestNamed(db, "Cleo").id, { firstName: "Pat" });
    });

    expect(
      await failureOf(
        plusOneService.setHouseholdPermission({
          weddingId: BOOTSTRAP_WEDDING_ID,
          familyId: bo.familyId,
          allowed: false,
          removePlusOnes: shown,
        }),
      ),
    ).toEqual({ _tag: "PlusOneNamed", named: 2 });
    expect(
      confirmedIn(bo.familyId)
        .map((g) => g.guestId)
        .toSorted(),
    ).toEqual([samId, patId].toSorted());
    expect(allowedOf(bo.id)).toBe(true);
  });
});

describe("plusOneService — the permission-off write is one batch", () => {
  /** The test handle with a `batch` that records each call's size, then runs
   *  the statements in order, as the bun:sqlite fallback would. */
  function batchingDb() {
    const calls: number[] = [];
    const batching: Db = Object.create(db);
    Object.defineProperty(batching, "batch", {
      value: async (statements: PromiseLike<unknown>[]) => {
        calls.push(statements.length);
        const out: unknown[] = [];
        for (const statement of statements) out.push(await statement);
        return out;
      },
    });
    return { batching, calls };
  }
  const runOn = <A, E>(handle: Db, eff: Effect.Effect<A, E, DbService>) =>
    Effect.runPromise(eff.pipe(Effect.ignore, Effect.provideService(DbService, handle)));

  it("sends the guarded write, any delete and the read of who is left together", async () => {
    const bo = guestNamed(db, "Bo");
    const { batching, calls } = batchingDb();
    const household = (
      allowed: boolean,
      removePlusOnes: { guestId: string; firstName: string; lastName: string }[],
    ) =>
      plusOneService.setHouseholdPermission({
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: bo.familyId,
        allowed,
        removePlusOnes,
      });

    await runOn(batching, household(false, []));
    seedPlusOne(db, bo.id, { firstName: "Sam" });
    await runOn(batching, household(false, confirmedIn(bo.familyId)));
    // Turning it on deletes nothing, so it needs no batch.
    await runOn(batching, household(true, []));
    expect(calls).toEqual([2, 3]);
  });
});

describe("plusOneService — names that JSON has to escape", () => {
  it("confirms and removes plus-ones whose names carry quotes, backslashes and non-ASCII", async () => {
    const names = [
      { firstName: "O'Brien", lastName: "" },
      { firstName: "Zoë", lastName: "Ångström" },
      { firstName: 'Jo "JJ"', lastName: "back\\slash" },
      { firstName: "🎉 Ana", lastName: "李" },
    ];
    const inviters = ["Bo", "Cleo", "Dot"].map((n) => guestNamed(db, n));
    for (const [i, inviter] of inviters.entries()) seedPlusOne(db, inviter.id, names[i]!);
    const bo = inviters[0]!;
    const shown = confirmedIn(bo.familyId);
    expect(shown).toHaveLength(3);

    const result = await run(
      plusOneService.setHouseholdPermission({
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: bo.familyId,
        allowed: false,
        removePlusOnes: shown,
      }),
    );
    expect(result.plusOnesRemoved).toBe(3);

    const ada = guestNamed(db, "Ada");
    const anaId = seedPlusOne(db, ada.id, names[3]!);
    expect(
      await run(
        plusOneService.setGuestPermission({
          weddingId: BOOTSTRAP_WEDDING_ID,
          guestId: ada.id,
          allowed: false,
          removePlusOnes: [{ guestId: anaId, ...names[3]! }],
        }),
      ),
    ).toMatchObject({ plusOneRemoved: true });
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

  it("deletes nothing when permission goes ON, whoever the list confirms", async () => {
    const bo = guestNamed(db, "Bo");
    seedPlusOne(db, bo.id, { firstName: "Sam" });
    const result = await run(
      plusOneService.setGuestPermission({
        weddingId: BOOTSTRAP_WEDDING_ID,
        guestId: bo.id,
        allowed: true,
        removePlusOnes: confirmedIn(bo.familyId),
      }),
    );
    expect(result.plusOneRemoved).toBe(false);
    expect(plusOnesOf(bo.id)).toHaveLength(1);

    const household = await run(
      plusOneService.setHouseholdPermission({
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: bo.familyId,
        allowed: true,
        removePlusOnes: confirmedIn(bo.familyId),
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
        removePlusOnes: [],
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
        removePlusOnes: [],
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
          removePlusOnes: [],
        }),
      ),
    ).toBe("PlusOneGuestNotFound");
    expect(
      await tagOf(
        plusOneService.setHouseholdPermission({
          weddingId: BOOTSTRAP_WEDDING_ID,
          familyId: host!.familyId,
          allowed: true,
          removePlusOnes: [],
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

describe("plusOneService — statements per write", () => {
  // Every guest write reads its whole context in ONE statement. Naming adds
  // only the guest count (the cap comes from that context read) before a
  // three-statement batch; a rename or a remove is one write; a remove with
  // nothing named writes nothing.
  it("names in five statements, renames and removes in two, and a repeat remove in one", async () => {
    const bo = guestNamed(db, "Bo");
    allowPlusOne(db, bo.id);
    const recorded = recordStatements(db);
    const count = async (eff: Effect.Effect<unknown, unknown, DbService>) => {
      const before = recorded.length;
      await run(eff);
      return recorded.length - before;
    };
    expect(
      await count(plusOneService.save(bo.familyId, bo.id, { firstName: "Sam", lastName: "" })),
    ).toBe(5);
    expect(
      await count(plusOneService.save(bo.familyId, bo.id, { firstName: "Samira", lastName: "" })),
    ).toBe(2);
    expect(
      await count(plusOneService.save(bo.familyId, bo.id, { firstName: "Samira", lastName: "" })),
    ).toBe(1);
    expect(await count(plusOneService.remove(bo.familyId, bo.id))).toBe(2);
    expect(await count(plusOneService.remove(bo.familyId, bo.id))).toBe(1);
  });

  it("turns permission off in one batch: the write, any delete and a read of who is left", async () => {
    const bo = guestNamed(db, "Bo");
    const recorded = recordStatements(db);
    const count = async (eff: Effect.Effect<unknown, unknown, DbService>) => {
      const before = recorded.length;
      await run(eff.pipe(Effect.ignore));
      return recorded.length - before;
    };
    const household = (
      removePlusOnes: { guestId: string; firstName: string; lastName: string }[],
    ) =>
      plusOneService.setHouseholdPermission({
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: bo.familyId,
        allowed: false,
        removePlusOnes,
      });
    // Nothing named: read, update, the read of who is left.
    expect(await count(household([]))).toBe(3);
    seedPlusOne(db, bo.id, { firstName: "Sam" });
    // Refused: the same three, and the update wrote nothing.
    expect(await count(household([]))).toBe(3);
    expect(confirmedIn(bo.familyId)).toHaveLength(1);
    expect(allowedOf(bo.id)).toBe(true);
    // Confirmed: read, update, delete, the read of who is left.
    expect(await count(household(confirmedIn(bo.familyId)))).toBe(4);
    expect(confirmedIn(bo.familyId)).toEqual([]);
  });

  it("sets a household's permission from one read", async () => {
    const bo = guestNamed(db, "Bo");
    const recorded = recordStatements(db);
    await run(
      plusOneService.setHouseholdPermission({
        weddingId: BOOTSTRAP_WEDDING_ID,
        familyId: bo.familyId,
        allowed: true,
        removePlusOnes: [],
      }),
    );
    expect(recorded).toHaveLength(2);
  });
});
