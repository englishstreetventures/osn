import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as schema from "@cire/db";
import { and, eq } from "drizzle-orm";

import {
  createDb,
  DDL,
  DEV_OWNER_PROFILE_ID,
  DEV_OWNER_SEAT_ID,
  repointDevOwnerSeat,
  seedDb,
  type TestDb,
} from "../../src/db/setup";

describe("multi-tenant schema", () => {
  it("seeds a bootstrap wedding and scopes families/events to it", () => {
    const db = createDb();
    seedDb(db);

    const weddings = db.select().from(schema.weddings).all();
    expect(weddings).toHaveLength(1);
    expect(weddings[0]!.id).toBe("wed_bootstrap");
    // Owned through a seat: the dev owner's, under its fixed id.
    const owners = db
      .select()
      .from(schema.weddingHosts)
      .where(eq(schema.weddingHosts.role, "owner"))
      .all();
    expect(owners.map((o) => [o.id, o.weddingId, o.osnProfileId])).toEqual([
      [DEV_OWNER_SEAT_ID, "wed_bootstrap", "usr_dev_bootstrap_owner"],
    ]);

    const families = db.select().from(schema.families).all();
    expect(families.length).toBeGreaterThan(0);
    for (const f of families) expect(f.weddingId).toBe("wed_bootstrap");

    const events = db.select().from(schema.events).all();
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.weddingId).toBe("wed_bootstrap");
  });

  it("rejects a family pointing at a missing wedding", () => {
    const db = createDb();
    seedDb(db);
    expect(() =>
      db
        .insert(schema.families)
        .values({
          id: "fam_orphan",
          weddingId: "wed_does_not_exist",
          publicId: "ORPHAN-1",
          familyName: "Orphan",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("cascades wedding delete to families", () => {
    const db = createDb();
    const now = new Date();
    db.insert(schema.weddings)
      .values({
        id: "wed_t",
        slug: "t",
        displayName: "T",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(schema.families)
      .values({
        id: "fam_t",
        weddingId: "wed_t",
        publicId: "T-1",
        familyName: "T",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.delete(schema.weddings).where(eq(schema.weddings.id, "wed_t")).run();

    const survivors = db
      .select()
      .from(schema.families)
      .where(eq(schema.families.weddingId, "wed_t"))
      .all();
    expect(survivors).toHaveLength(0);
  });
});

// Composite-index drift guard for the raw DDL mirror. The Drizzle schema
// (@cire/db) declares events_wedding_id_sort_idx; this DDL string must keep
// mirroring it (and must not resurrect the dropped single-column pair) —
// the co-located @cire/db schema test pins the Drizzle side.
describe("DDL mirror", () => {
  it("declares the (wedding_id, sort_order) composite events index", () => {
    expect(DDL).toContain("events_wedding_id_sort_idx");
  });

  it("does not re-declare the dropped single-column events indexes", () => {
    expect(DDL).not.toContain("events_sort_order_idx");
    expect(DDL).not.toContain("events_wedding_idx ");
    // Guard the un-padded name too (e.g. followed by a newline or paren).
    expect(/events_wedding_idx\b/.test(DDL)).toBe(false);
  });
});

describe("repointDevOwnerSeat", () => {
  const PROFILE = "usr_real_person";
  const SAMPLE = schema.BOOTSTRAP_WEDDING_ID;
  const { weddingHosts } = schema;

  /** The seats one profile holds on one wedding. */
  const seatsOf = (db: TestDb, osnProfileId: string, weddingId: string = SAMPLE) =>
    db
      .select({
        id: weddingHosts.id,
        osnProfileId: weddingHosts.osnProfileId,
        addedByOsnProfileId: weddingHosts.addedByOsnProfileId,
        role: weddingHosts.role,
      })
      .from(weddingHosts)
      .where(
        and(eq(weddingHosts.weddingId, weddingId), eq(weddingHosts.osnProfileId, osnProfileId)),
      )
      .all();

  const ownerSeatHeldBy = (osnProfileId: string) => ({
    id: DEV_OWNER_SEAT_ID,
    osnProfileId,
    addedByOsnProfileId: osnProfileId,
    role: "owner" as const,
  });

  function seeded(): TestDb {
    const db = createDb();
    seedDb(db);
    return db;
  }

  function addSeat(
    db: TestDb,
    seat: { id: string; osnProfileId: string; weddingId?: string; role: "editor" | "viewer" },
  ) {
    db.insert(weddingHosts)
      .values({
        weddingId: SAMPLE,
        addedByOsnProfileId: DEV_OWNER_PROFILE_ID,
        createdAt: new Date(),
        ...seat,
      })
      .run();
  }

  it("hands the owner seat to a profile that holds no seat", () => {
    const db = seeded();

    repointDevOwnerSeat(db, PROFILE);

    expect(seatsOf(db, PROFILE)).toEqual([ownerSeatHeldBy(PROFILE)]);
    expect(seatsOf(db, DEV_OWNER_PROFILE_ID)).toEqual([]);
    expect(db.select().from(weddingHosts).all()).toHaveLength(1);
  });

  it("drops the co-host seat a profile already holds, so the one-seat-per-wedding index holds", () => {
    const db = seeded();
    addSeat(db, { id: "whost_profile_cohost", osnProfileId: PROFILE, role: "editor" });
    addSeat(db, { id: "whost_other_cohost", osnProfileId: "usr_other", role: "editor" });

    repointDevOwnerSeat(db, PROFILE);

    expect(seatsOf(db, PROFILE)).toEqual([ownerSeatHeldBy(PROFILE)]);
    // Another co-host's seat is theirs, not the profile's.
    expect(seatsOf(db, "usr_other").map((s) => s.id)).toEqual(["whost_other_cohost"]);
  });

  it("leaves the profile's seats on other weddings alone", () => {
    const db = seeded();
    const now = new Date();
    db.insert(schema.weddings)
      .values({
        id: "wed_other",
        slug: "other",
        displayName: "Other",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    addSeat(db, {
      id: "whost_profile_elsewhere",
      osnProfileId: PROFILE,
      weddingId: "wed_other",
      role: "viewer",
    });

    repointDevOwnerSeat(db, PROFILE);

    expect(seatsOf(db, PROFILE, "wed_other").map((s) => [s.id, s.role])).toEqual([
      ["whost_profile_elsewhere", "viewer"],
    ]);
    expect(seatsOf(db, PROFILE)).toEqual([ownerSeatHeldBy(PROFILE)]);
  });

  it("keeps the owner seat when the profile already holds it", () => {
    const db = seeded();

    repointDevOwnerSeat(db, DEV_OWNER_PROFILE_ID);

    expect(seatsOf(db, DEV_OWNER_PROFILE_ID)).toEqual([ownerSeatHeldBy(DEV_OWNER_PROFILE_ID)]);
  });

  it("makes the seat an owner seat whatever role it held", () => {
    const db = seeded();
    db.update(weddingHosts)
      .set({ role: "editor" })
      .where(eq(weddingHosts.id, DEV_OWNER_SEAT_ID))
      .run();

    repointDevOwnerSeat(db, PROFILE);

    expect(seatsOf(db, PROFILE)).toEqual([ownerSeatHeldBy(PROFILE)]);
  });

  // `scripts/cire-db-seed.sh` repoints the D1 seed with its own copy of these
  // two statements, as SQL in a shell string. Both copies run on the same seats
  // here and must leave the same table, so the tests above hold for that copy
  // too and a change to one that is not made to the other fails.
  describe("agrees with the seed script's SQL", () => {
    const script = readFileSync(
      join(import.meta.dir, "..", "..", "..", "..", "scripts", "cire-db-seed.sh"),
      "utf8",
    );

    /** Run the script's repoint SQL, its variables filled in as the script fills them. */
    function scriptRepoint(db: TestDb, osnProfileId: string): void {
      const seatId = script.match(/OWNER_SEAT_ID="([^"]+)"/)?.[1];
      const command = script.match(/--command \\\n\s+"(DELETE FROM wedding_hosts[^"]+)"/)?.[1];
      expect(seatId, "could not read OWNER_SEAT_ID from cire-db-seed.sh").toBe(DEV_OWNER_SEAT_ID);
      expect(command, "could not read the repoint SQL from cire-db-seed.sh").toBeTruthy();
      db.$client.exec(
        command!
          .replaceAll("${CIRE_DEV_OWNER_PROFILE_ID}", osnProfileId)
          .replaceAll("${OWNER_SEAT_ID}", seatId!),
      );
    }

    /** One table holding every case the tests above take one at a time. */
    function crowded(): TestDb {
      const db = seeded();
      const now = new Date();
      db.insert(schema.weddings)
        .values({
          id: "wed_other",
          slug: "other",
          displayName: "Other",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      addSeat(db, { id: "whost_profile_cohost", osnProfileId: PROFILE, role: "editor" });
      addSeat(db, { id: "whost_other_cohost", osnProfileId: "usr_other", role: "editor" });
      addSeat(db, {
        id: "whost_profile_elsewhere",
        osnProfileId: PROFILE,
        weddingId: "wed_other",
        role: "viewer",
      });
      db.update(weddingHosts)
        .set({ role: "editor" })
        .where(eq(weddingHosts.id, DEV_OWNER_SEAT_ID))
        .run();
      return db;
    }

    // `created_at` is left out: each database is seeded at its own moment.
    const allSeats = (db: TestDb) =>
      db
        .select({
          id: weddingHosts.id,
          weddingId: weddingHosts.weddingId,
          osnProfileId: weddingHosts.osnProfileId,
          addedByOsnProfileId: weddingHosts.addedByOsnProfileId,
          role: weddingHosts.role,
          runSheetScope: weddingHosts.runSheetScope,
        })
        .from(weddingHosts)
        .orderBy(weddingHosts.id)
        .all();

    it.each([
      ["a profile with seats of its own", PROFILE],
      ["the profile already holding the owner seat", DEV_OWNER_PROFILE_ID],
    ])("for %s", (_label, osnProfileId) => {
      const ours = crowded();
      const theirs = crowded();

      repointDevOwnerSeat(ours, osnProfileId);
      scriptRepoint(theirs, osnProfileId);

      expect(allSeats(theirs)).toEqual(allSeats(ours));
    });
  });
});
