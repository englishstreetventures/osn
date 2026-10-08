import { describe, it, expect } from "bun:test";

import { hostRsvpNotices, weddingHosts, weddings } from "@cire/db";
import { and, eq } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { policyFor } from "../../src/middleware/wedding-role";
import {
  hostAddFailure,
  hostConflictReason,
  hostsService,
  LEAST_PRIVILEGE_ROLE,
  MAX_HOSTS_PER_WEDDING,
  normaliseHostRole,
  STORED_HOST_ROLES,
} from "../../src/services/hosts";
import type {
  HostConflict,
  HostWriteError,
  PeopleLimitReached,
  StoredHostRole,
} from "../../src/services/hosts";
import { TIER_PEOPLE_LIMIT, TIERS } from "../../src/services/tiers";
import { setTier } from "../test-helpers";
import { insertWedding } from "../test-helpers/wedding";

/** Every value the role column may hold, taken from the guard rather than
 *  restated — a restated list stops matching the column when it is widened. */
const STORED_ROLES = Object.keys(STORED_HOST_ROLES) as StoredHostRole[];

const OWNER = "usr_owner";
const ALICE = "usr_alice";
const WEDDING_ID = "wed_test";

/** A wedding whose owner was seated a minute ago, so seats added during a test
 *  sort after theirs — `created_at` is stored in seconds. */
function buildDb() {
  const db = createDb(":memory:");
  const seated = new Date(Date.now() - 60_000);
  insertWedding(db, {
    id: WEDDING_ID,
    slug: "test-wedding",
    displayName: "Test Wedding",
    createdAt: seated,
    updatedAt: seated,
    owners: [OWNER],
  });
  return db;
}

type TestDb = ReturnType<typeof createDb>;

/** Seat `osnProfileId` directly, with no cap or role check in the way. */
function seat(db: TestDb, osnProfileId: string, role: StoredHostRole) {
  db.insert(weddingHosts)
    .values({
      id: `whost_${osnProfileId}`,
      weddingId: WEDDING_ID,
      osnProfileId,
      addedByOsnProfileId: OWNER,
      role,
      createdAt: new Date(),
    })
    .run();
}

const roleOf = (db: TestDb, osnProfileId: string) =>
  db
    .select({ role: weddingHosts.role })
    .from(weddingHosts)
    .where(and(eq(weddingHosts.weddingId, WEDDING_ID), eq(weddingHosts.osnProfileId, osnProfileId)))
    .all()[0]?.role;

const run = <A, E>(db: ReturnType<typeof createDb>, eff: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));

describe("hostConflictReason", () => {
  it("maps the wedding_hosts unique violation to already_host", () => {
    expect(
      hostConflictReason(
        "UNIQUE constraint failed: wedding_hosts.wedding_id, wedding_hosts.osn_profile_id",
      ),
    ).toBe("already_host");
  });

  it("returns null for unrelated errors", () => {
    expect(hostConflictReason("disk full")).toBeNull();
    expect(hostConflictReason("UNIQUE constraint failed: weddings.slug")).toBeNull();
  });
});

describe("hostAddFailure", () => {
  it("reads the unique violation off the cause, where D1 puts it under a wrapped statement", () => {
    // drizzle wraps a failed single statement on D1: its own message names the
    // statement only, and the database's reason is the cause.
    const wrapped = new DrizzleQueryError(
      'insert into "wedding_hosts" select ?',
      ["whost_x"],
      new Error(
        "D1_ERROR: UNIQUE constraint failed: wedding_hosts.wedding_id, wedding_hosts.osn_profile_id: SQLITE_CONSTRAINT",
      ),
    );
    expect(String(wrapped)).not.toContain("UNIQUE constraint failed");
    const failure = hostAddFailure(wrapped);
    expect(failure._tag).toBe("HostConflict");
    expect((failure as HostConflict).reason).toBe("already_host");
  });

  it("maps a bare unique violation, as bun:sqlite and a D1 batch throw it", () => {
    const failure = hostAddFailure(
      new Error("UNIQUE constraint failed: wedding_hosts.wedding_id, wedding_hosts.osn_profile_id"),
    );
    expect((failure as HostConflict).reason).toBe("already_host");
  });

  it("leaves any other failure a write error, carrying the driver's text", () => {
    const failure = hostAddFailure(new DrizzleQueryError("insert …", [], new Error("disk I/O")));
    expect(failure._tag).toBe("HostWriteError");
    expect((failure as HostWriteError).reason).toContain("disk I/O");
  });
});

describe("normaliseHostRole", () => {
  it("passes owner, editor and viewer through", () => {
    expect(normaliseHostRole("owner")).toBe("owner");
    expect(normaliseHostRole("editor")).toBe("editor");
    expect(normaliseHostRole("viewer")).toBe("viewer");
  });

  it("degrades the legacy 'host' value to editor (what pre-roles co-hosts were)", () => {
    expect(normaliseHostRole("host")).toBe("editor");
  });

  it("maps every stored role except the legacy 'host' to itself", () => {
    // The guard against the quiet way to satisfy the exhaustiveness check:
    // a role added to the column can be given a `case` that folds it into an
    // existing role, which compiles and hands it that role's whole reach.
    // `host` is the one deliberate fold, and it is asserted separately above.
    for (const role of STORED_ROLES) {
      if (role === "host") continue;
      expect(normaliseHostRole(role)).toBe(role);
    }
  });

  it("degrades unknown/corrupted values to the least-privileged role, never fail-open", () => {
    // Asserted against LEAST_PRIVILEGE_ROLE rather than a literal: the floor
    // moves when a narrower role is added, and a test naming today's floor
    // would keep passing while the fallback silently outranked the new role.
    expect(normaliseHostRole("")).toBe(LEAST_PRIVILEGE_ROLE);
    expect(normaliseHostRole("admin")).toBe(LEAST_PRIVILEGE_ROLE);
    expect(normaliseHostRole("EDITOR")).toBe(LEAST_PRIVILEGE_ROLE);
  });

  it("puts the least-privileged role at or below every other role's reach", () => {
    // The property that makes the fallback safe: whatever the floor is, no
    // other role may have fewer capabilities than it.
    const floor = policyFor(LEAST_PRIVILEGE_ROLE).capabilities;
    for (const role of STORED_ROLES) {
      const other = policyFor(normaliseHostRole(role)).capabilities;
      for (const capability of floor) expect(other).toContain(capability);
    }
  });
});

describe("hostsService.add", () => {
  it("inserts a host row owned by the wedding with the requested role", async () => {
    const db = buildDb();
    const host = await run(
      db,
      hostsService.add({
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        addedByOsnProfileId: OWNER,
        role: "editor",
      }),
    );
    expect(host.osnProfileId).toBe(ALICE);
    expect(host.role).toBe("editor");
    expect(host.id).toMatch(/^whost_/);

    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, ALICE)).all();
    expect(row!.weddingId).toBe(WEDDING_ID);
    expect(row!.addedByOsnProfileId).toBe(OWNER);
    expect(row!.role).toBe("editor");
  });

  it("persists a viewer seat when asked", async () => {
    const db = buildDb();
    const host = await run(
      db,
      hostsService.add({
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        addedByOsnProfileId: OWNER,
        role: "viewer",
      }),
    );
    expect(host.role).toBe("viewer");
    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, ALICE)).all();
    expect(row!.role).toBe("viewer");
  });

  it("rejects re-adding the same profile as already_host (unique index)", async () => {
    const db = buildDb();
    await run(
      db,
      hostsService.add({
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        addedByOsnProfileId: OWNER,
        role: "editor",
      }),
    );
    const err = await run(
      db,
      hostsService
        .add({
          weddingId: WEDDING_ID,
          osnProfileId: ALICE,
          addedByOsnProfileId: OWNER,
          role: "editor",
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("HostConflict");
    expect((err as { reason: string }).reason).toBe("already_host");
    // Still one seat each — the owner's and Alice's — no duplicate.
    expect(db.select().from(weddingHosts).all()).toHaveLength(2);
  });

  it("refuses to seat an owner again (already_host) and leaves their owner seat alone", async () => {
    // An owner holds a seat like everyone else, so the unique index answers
    // this too — an editor cannot quietly re-add an owner at a lower role.
    const db = buildDb();
    const err = await run(
      db,
      hostsService
        .add({
          weddingId: WEDDING_ID,
          osnProfileId: OWNER,
          addedByOsnProfileId: ALICE,
          role: "viewer",
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("HostConflict");
    expect((err as { reason: string }).reason).toBe("already_host");
    expect(db.select().from(weddingHosts).all()).toHaveLength(1);
    expect(roleOf(db, OWNER)).toBe("owner");
  });

  it("seats a second owner, attributed to the owner who invited them", async () => {
    const db = buildDb();
    const host = await run(
      db,
      hostsService.add({
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        addedByOsnProfileId: OWNER,
        role: "owner",
      }),
    );
    expect(host.role).toBe("owner");
    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, ALICE)).all();
    expect(row).toMatchObject({ role: "owner", addedByOsnProfileId: OWNER, runSheetScope: "own" });
  });

  it("counts owners towards MAX_HOSTS_PER_WEDDING: a full wedding refuses an owner too", async () => {
    const db = buildDb();
    // The creator's seat plus 49 more fills the wedding.
    for (let i = 1; i < MAX_HOSTS_PER_WEDDING; i += 1) seat(db, `usr_seat_${i}`, "editor");
    const err = await run(
      db,
      hostsService
        .add({
          weddingId: WEDDING_ID,
          osnProfileId: ALICE,
          addedByOsnProfileId: OWNER,
          role: "owner",
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("HostConflict");
    expect((err as { reason: string }).reason).toBe("host_cap_reached");
    expect(roleOf(db, ALICE)).toBeUndefined();
  });

  it("leaves fewer seats for everyone else on a wedding with more owners", async () => {
    const db = buildDb();
    for (let i = 1; i < 10; i += 1) seat(db, `usr_owner_${i}`, "owner");
    for (let i = 10; i < MAX_HOSTS_PER_WEDDING; i += 1) seat(db, `usr_seat_${i}`, "viewer");
    const err = await run(
      db,
      hostsService
        .add({
          weddingId: WEDDING_ID,
          osnProfileId: ALICE,
          addedByOsnProfileId: OWNER,
          role: "viewer",
        })
        .pipe(Effect.flip),
    );
    expect((err as { reason: string }).reason).toBe("host_cap_reached");
  });

  it("seats anyone, an owner included, into the last free seat", async () => {
    const db = buildDb();
    for (let i = 2; i < MAX_HOSTS_PER_WEDDING; i += 1) seat(db, `usr_seat_${i}`, "editor");
    await run(
      db,
      hostsService.add({
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        addedByOsnProfileId: OWNER,
        role: "owner",
      }),
    );
    expect(roleOf(db, ALICE)).toBe("owner");
    const { total } = await run(db, hostsService.list(WEDDING_ID));
    expect(total).toBe(MAX_HOSTS_PER_WEDDING);
  });
});

describe("the people limit", () => {
  const BEN = "usr_ben";
  const CAROL = "usr_carol";

  /** Seat `n` viewers directly, named `usr_v_<i>`. */
  const seatViewers = (db: TestDb, n: number, from = 0) => {
    for (let i = from; i < from + n; i += 1) seat(db, `usr_v_${i}`, "viewer");
  };

  const addAs = (
    db: TestDb,
    osnProfileId: string,
    role: "owner" | "editor" | "viewer" | "helper",
  ) =>
    run(
      db,
      hostsService.add({ weddingId: WEDDING_ID, osnProfileId, addedByOsnProfileId: OWNER, role }),
    );

  const refusedAdd = (db: TestDb, osnProfileId: string, role: "owner" | "viewer" = "viewer") =>
    run(
      db,
      hostsService
        .add({ weddingId: WEDDING_ID, osnProfileId, addedByOsnProfileId: OWNER, role })
        .pipe(Effect.flip),
    );

  const usage = async (db: TestDb) => (await run(db, hostsService.list(WEDDING_ID))).peopleLimit;

  it("seats people up to each tier's limit and refuses the next, writing nothing", async () => {
    for (const tier of TIERS) {
      const db = buildDb();
      setTier(db, WEDDING_ID, tier);
      const limit = TIER_PEOPLE_LIMIT[tier];
      seatViewers(db, limit - 1);

      const last = await addAs(db, ALICE, "viewer");
      expect(last.peopleLimit).toMatchObject({ used: limit, limit });

      const err = await refusedAdd(db, "usr_one_too_many");
      expect(err._tag).toBe("PeopleLimitReached");
      expect((err as PeopleLimitReached).peopleLimit).toEqual({
        used: limit,
        limit,
        tier: tier === "ivory" ? "gold" : tier === "gold" ? "crimson" : null,
      });
      expect(roleOf(db, "usr_one_too_many")).toBeUndefined();
    }
  });

  it("counts every seat below owner — editors, viewers, helpers and the legacy host value", async () => {
    const db = buildDb();
    seat(db, "usr_e", "editor");
    seat(db, "usr_v", "viewer");
    seat(db, "usr_h", "helper");
    seat(db, "usr_legacy", "host");
    expect(await usage(db)).toEqual({ used: 4, limit: 6, tier: "ivory" });
  });

  it("never counts the first two owners, and counts a third like a co-host", async () => {
    const db = buildDb();
    seatViewers(db, 6);
    // At the limit, the second owner — the partner — still joins.
    const partner = await addAs(db, ALICE, "owner");
    expect(partner.peopleLimit.used).toBe(6);
    // A third owner is one more person.
    const err = await refusedAdd(db, BEN, "owner");
    expect(err._tag).toBe("PeopleLimitReached");
    expect(roleOf(db, BEN)).toBeUndefined();

    const roomy = buildDb();
    seat(roomy, ALICE, "owner");
    seat(roomy, BEN, "owner");
    expect(await usage(roomy)).toMatchObject({ used: 1 });
  });

  it("frees no place by promoting a co-host once two owners hold the wedding", async () => {
    const db = buildDb();
    seat(db, BEN, "owner");
    seatViewers(db, 6);
    const promoted = await run(
      db,
      hostsService.setRole({
        weddingId: WEDDING_ID,
        osnProfileId: "usr_v_0",
        role: "owner",
        actorOsnProfileId: OWNER,
      }),
    );
    expect(promoted.peopleLimit.used).toBe(6);
    expect((await refusedAdd(db, ALICE))._tag).toBe("PeopleLimitReached");
  });

  it("frees a place by promoting a co-host to the second owner", async () => {
    const db = buildDb();
    seatViewers(db, 6);
    const promoted = await run(
      db,
      hostsService.setRole({
        weddingId: WEDDING_ID,
        osnProfileId: "usr_v_0",
        role: "owner",
        actorOsnProfileId: OWNER,
      }),
    );
    expect(promoted.peopleLimit.used).toBe(5);
    expect((await addAs(db, ALICE, "viewer")).peopleLimit.used).toBe(6);
  });

  it("lets an owner step down to a co-host role past the limit", async () => {
    const db = buildDb();
    seat(db, BEN, "owner");
    seatViewers(db, 6);
    const stepped = await run(
      db,
      hostsService.setRole({
        weddingId: WEDDING_ID,
        osnProfileId: BEN,
        role: "editor",
        actorOsnProfileId: BEN,
      }),
    );
    expect(roleOf(db, BEN)).toBe("editor");
    expect(stepped.peopleLimit).toEqual({ used: 7, limit: 6, tier: "gold" });
  });

  it("refuses demoting another owner when it would pass the limit, and changes nothing", async () => {
    const db = buildDb();
    seat(db, BEN, "owner");
    seatViewers(db, 6);
    const err = await run(
      db,
      hostsService
        .setRole({
          weddingId: WEDDING_ID,
          osnProfileId: BEN,
          role: "editor",
          actorOsnProfileId: OWNER,
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("PeopleLimitReached");
    expect((err as PeopleLimitReached).peopleLimit).toEqual({ used: 6, limit: 6, tier: "gold" });
    expect(roleOf(db, BEN)).toBe("owner");
  });

  it("demotes a third owner at the limit: the count does not move", async () => {
    const db = buildDb();
    seat(db, BEN, "owner");
    seat(db, CAROL, "owner");
    seatViewers(db, 5);
    expect((await usage(db)).used).toBe(6);
    const demoted = await run(
      db,
      hostsService.setRole({
        weddingId: WEDDING_ID,
        osnProfileId: CAROL,
        role: "viewer",
        actorOsnProfileId: OWNER,
      }),
    );
    expect(demoted.peopleLimit.used).toBe(6);
    expect(roleOf(db, CAROL)).toBe("viewer");
  });

  it("answers LastOwner, not the limit, for the wedding's only owner", async () => {
    const db = buildDb();
    seatViewers(db, 6);
    for (const actor of [OWNER, ALICE]) {
      const err = await run(
        db,
        hostsService
          .setRole({
            weddingId: WEDDING_ID,
            osnProfileId: OWNER,
            role: "viewer",
            actorOsnProfileId: actor,
          })
          .pipe(Effect.flip),
      );
      expect(err._tag).toBe("LastOwner");
    }
  });

  it("keeps every seat when the tier is lowered, and refuses only what would add someone", async () => {
    const db = buildDb();
    setTier(db, WEDDING_ID, "crimson");
    seatViewers(db, 10);
    setTier(db, WEDDING_ID, "ivory");

    const { total, peopleLimit } = await run(db, hostsService.list(WEDDING_ID));
    expect(total).toBe(11);
    expect(peopleLimit).toEqual({ used: 10, limit: 6, tier: "gold" });

    expect((await refusedAdd(db, ALICE))._tag).toBe("PeopleLimitReached");
    // Moving a co-host between roles below owner adds no one.
    await run(
      db,
      hostsService.setRole({
        weddingId: WEDDING_ID,
        osnProfileId: "usr_v_0",
        role: "editor",
        actorOsnProfileId: OWNER,
      }),
    );
    expect(roleOf(db, "usr_v_0")).toBe("editor");

    // Removing people brings the wedding back under, and then it can add.
    for (let i = 0; i < 4; i += 1) {
      const { peopleLimit: after } = await run(
        db,
        hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: `usr_v_${i}` }),
      );
      expect(after.used).toBe(9 - i);
    }
    expect((await refusedAdd(db, ALICE))._tag).toBe("PeopleLimitReached");
    await run(db, hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: "usr_v_4" }));
    expect((await addAs(db, ALICE, "viewer")).peopleLimit).toEqual({
      used: 6,
      limit: 6,
      tier: "gold",
    });
  });

  it("keeps the 50-seat ceiling out of reach of add on every tier", async () => {
    // Crimson's 40 people plus the two exempt owners is the most add can seat.
    const db = buildDb();
    setTier(db, WEDDING_ID, "crimson");
    await addAs(db, ALICE, "owner");
    seatViewers(db, TIER_PEOPLE_LIMIT.crimson);
    expect((await refusedAdd(db, "usr_extra_owner", "owner"))._tag).toBe("PeopleLimitReached");
    expect((await refusedAdd(db, "usr_extra_viewer"))._tag).toBe("PeopleLimitReached");
    expect((await run(db, hostsService.list(WEDDING_ID))).total).toBe(42);
    expect(42).toBeLessThan(MAX_HOSTS_PER_WEDDING);
  });

  it("names the seat ceiling first when a wedding seeded past every limit is also full", async () => {
    const db = buildDb();
    setTier(db, WEDDING_ID, "crimson");
    seatViewers(db, MAX_HOSTS_PER_WEDDING - 1);
    const err = await refusedAdd(db, ALICE, "owner");
    expect(err._tag).toBe("HostConflict");
    expect((err as HostConflict).reason).toBe("host_cap_reached");
  });

  it("reads its own wedding's tier and seats, not a neighbour's", async () => {
    const db = buildDb();
    const now = new Date();
    insertWedding(db, {
      id: "wed_rich",
      slug: "rich",
      displayName: "Rich",
      createdAt: now,
      updatedAt: now,
      owners: ["usr_rich"],
    });
    setTier(db, "wed_rich", "crimson");
    seatViewers(db, 6);
    expect((await refusedAdd(db, ALICE))._tag).toBe("PeopleLimitReached");
    const neighbour = await run(
      db,
      hostsService.add({
        weddingId: "wed_rich",
        osnProfileId: ALICE,
        addedByOsnProfileId: "usr_rich",
        role: "viewer",
      }),
    );
    expect(neighbour.peopleLimit).toEqual({ used: 1, limit: 40, tier: "crimson" });
  });

  it("reports the people count from list, add and remove alike", async () => {
    const db = buildDb();
    expect(await usage(db)).toEqual({ used: 0, limit: 6, tier: "ivory" });
    expect((await addAs(db, ALICE, "editor")).peopleLimit.used).toBe(1);
    expect(await usage(db)).toEqual({ used: 1, limit: 6, tier: "ivory" });
    const removed = await run(
      db,
      hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: ALICE }),
    );
    expect(removed.peopleLimit.used).toBe(0);
  });
});

describe("hostsService.list", () => {
  it("lists the wedding's hosts oldest-first and scopes to the wedding", async () => {
    const db = buildDb();
    // A second wedding whose host must not leak in.
    const now = new Date();
    insertWedding(db, {
      id: "wed_other",
      slug: "other",
      displayName: "Other",
      createdAt: now,
      updatedAt: now,
      owners: ["usr_other"],
    });
    db.insert(weddingHosts)
      .values({
        id: "whost_other",
        weddingId: "wed_other",
        osnProfileId: "usr_leak",
        addedByOsnProfileId: "usr_other",
        createdAt: now,
      })
      .run();

    await run(
      db,
      hostsService.add({
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        addedByOsnProfileId: OWNER,
        role: "editor",
      }),
    );
    const { hosts, total } = await run(db, hostsService.list(WEDDING_ID));
    // Owners are seats too, listed with their role.
    expect(hosts.map((h) => [h.osnProfileId, h.role])).toEqual([
      [OWNER, "owner"],
      [ALICE, "editor"],
    ]);
    // Attribution rides along: with editors able to create seats, "who added
    // this one" is what lets an owner spot a seat they didn't create.
    expect(hosts.map((h) => h.addedByOsnProfileId)).toEqual([OWNER, OWNER]);
    // `total` counts the wedding's OWN rows — the other wedding's seats are
    // excluded from it as well as from the list.
    expect(total).toBe(2);
  });

  it("caps the seats a wedding can hold, so every seat stays listable", async () => {
    // The property the cap defends, driven the way the security review drove
    // the bug: seats past the list ceiling are invisible to the owners, and
    // DELETE needs a profile id they can only get from that list — so an
    // uncapped add lets one owner create seats the others cannot remove.
    // "Any owner can take a seat back" only holds while every seat is listed,
    // which is what keeps the cap below the ceiling. The people limit stops
    // `add` at 42 seats on any tier, so the seats are written directly, as on a
    // wedding seeded before either limit existed. The owner's own seat counts,
    // so 49 more fill the wedding.
    const db = buildDb();
    setTier(db, WEDDING_ID, "crimson");
    for (let i = 1; i < MAX_HOSTS_PER_WEDDING; i += 1) seat(db, `usr_seat_${i}`, "editor");

    const err = await run(
      db,
      hostsService
        .add({
          weddingId: WEDDING_ID,
          osnProfileId: "usr_one_too_many",
          addedByOsnProfileId: OWNER,
          role: "editor",
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("HostConflict");
    expect((err as { reason: string }).reason).toBe("host_cap_reached");

    // The refusal is real: no row was written, and the whole set — the owner's
    // seat included — is listed.
    const { hosts, total } = await run(db, hostsService.list(WEDDING_ID));
    expect(total).toBe(MAX_HOSTS_PER_WEDDING);
    expect(hosts).toHaveLength(MAX_HOSTS_PER_WEDDING);
    expect(hosts.some((h) => h.osnProfileId === "usr_one_too_many")).toBe(false);
  });

  it("reports the true total when a legacy wedding sits above the list ceiling", async () => {
    // The cap stops new weddings getting here, but rows seeded before it
    // existed can. `total` is what stops a truncated list looking complete —
    // an owner shown 200 of 205 has no way to know five readers of their
    // guests' data are missing from it.
    const db = buildDb();
    const now = new Date();
    for (let i = 0; i < 205; i += 1) {
      db.insert(weddingHosts)
        .values({
          id: `whost_legacy_${i}`,
          weddingId: WEDDING_ID,
          osnProfileId: `usr_legacy_${i}`,
          addedByOsnProfileId: OWNER,
          role: "editor",
          createdAt: new Date(now.getTime() + i),
        })
        .run();
    }
    const { hosts, total } = await run(db, hostsService.list(WEDDING_ID));
    expect(hosts).toHaveLength(200);
    expect(total).toBe(206);
  });

  it("lists only the owner for a wedding with no co-hosts", async () => {
    const db = buildDb();
    const { hosts, total } = await run(db, hostsService.list(WEDDING_ID));
    expect(hosts.map((h) => [h.osnProfileId, h.role])).toEqual([[OWNER, "owner"]]);
    expect(total).toBe(1);
  });
});

describe("hostsService.remove", () => {
  it("removes a host scoped to the wedding and is idempotent", async () => {
    const db = buildDb();
    await run(
      db,
      hostsService.add({
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        addedByOsnProfileId: OWNER,
        role: "editor",
      }),
    );
    await run(db, hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: ALICE }));
    expect(roleOf(db, ALICE)).toBeUndefined();
    expect(db.select().from(weddingHosts).all()).toHaveLength(1);
    // Idempotent — removing again succeeds.
    await run(db, hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: ALICE }));
  });

  it("does not remove a host from a different wedding (cross-tenant guard)", async () => {
    const db = buildDb();
    const now = new Date();
    insertWedding(db, {
      id: "wed_b",
      slug: "b",
      displayName: "B",
      createdAt: now,
      updatedAt: now,
      owners: ["usr_b"],
    });
    db.insert(weddingHosts)
      .values({
        id: "whost_b",
        weddingId: "wed_b",
        osnProfileId: ALICE,
        addedByOsnProfileId: "usr_b",
        createdAt: now,
      })
      .run();
    // Removing ALICE scoped to WEDDING_ID must NOT touch wed_b's row.
    await run(db, hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: ALICE }));
    expect(
      db
        .select()
        .from(weddingHosts)
        .where(and(eq(weddingHosts.weddingId, "wed_b"), eq(weddingHosts.osnProfileId, ALICE)))
        .all(),
    ).toHaveLength(1);
  });
});

describe("hostsService.setRole", () => {
  it("flips an existing seat's role and is idempotent", async () => {
    const db = buildDb();
    await run(
      db,
      hostsService.add({
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        addedByOsnProfileId: OWNER,
        role: "editor",
      }),
    );
    const updated = await run(
      db,
      hostsService.setRole({
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        role: "viewer",
        actorOsnProfileId: OWNER,
      }),
    );
    expect(updated.role).toBe("viewer");
    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, ALICE)).all();
    expect(row!.role).toBe("viewer");

    // Setting the same role again succeeds.
    const again = await run(
      db,
      hostsService.setRole({
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        role: "viewer",
        actorOsnProfileId: OWNER,
      }),
    );
    expect(again.role).toBe("viewer");
  });

  it("fails HostNotFound for a profile that holds no seat", async () => {
    const db = buildDb();
    const err = await run(
      db,
      hostsService
        .setRole({
          weddingId: WEDDING_ID,
          osnProfileId: "usr_stranger",
          role: "viewer",
          actorOsnProfileId: OWNER,
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("HostNotFound");
  });

  it("does not retarget another wedding's seat (cross-tenant guard)", async () => {
    const db = buildDb();
    const now = new Date();
    insertWedding(db, {
      id: "wed_b",
      slug: "b2",
      displayName: "B",
      createdAt: now,
      updatedAt: now,
      owners: ["usr_b"],
    });
    db.insert(weddingHosts)
      .values({
        id: "whost_b2",
        weddingId: "wed_b",
        osnProfileId: ALICE,
        addedByOsnProfileId: "usr_b",
        role: "editor",
        createdAt: now,
      })
      .run();
    const err = await run(
      db,
      hostsService
        .setRole({
          weddingId: WEDDING_ID,
          osnProfileId: ALICE,
          role: "viewer",
          actorOsnProfileId: OWNER,
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("HostNotFound");
    const [row] = db
      .select()
      .from(weddingHosts)
      .where(and(eq(weddingHosts.weddingId, "wed_b"), eq(weddingHosts.osnProfileId, ALICE)))
      .all();
    expect(row!.role).toBe("editor");
  });
});

describe("hostsService.authorize", () => {
  it("returns isOwner:true with role owner, and the owner's own seat id", async () => {
    const db = buildDb();
    const result = await run(db, hostsService.authorize(WEDDING_ID, OWNER));
    expect(result).toEqual({
      isOwner: true,
      isHost: false,
      role: "owner",
      hostId: expect.stringMatching(/^whost_/),
      runSheetScope: "own",
      weddingSlug: "test-wedding",
      weddingTier: "ivory",
    });
  });

  it("returns isHost:true for a co-host", async () => {
    const db = buildDb();
    await run(
      db,
      hostsService.add({
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        addedByOsnProfileId: OWNER,
        role: "editor",
      }),
    );
    const result = await run(db, hostsService.authorize(WEDDING_ID, ALICE));
    expect(result).toEqual({
      isOwner: false,
      isHost: true,
      role: "editor",
      hostId: expect.stringMatching(/^whost_/),
      runSheetScope: "own",
      weddingSlug: "test-wedding",
      weddingTier: "ivory",
    });
  });

  it("carries a viewer seat's role through", async () => {
    const db = buildDb();
    await run(
      db,
      hostsService.add({
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        addedByOsnProfileId: OWNER,
        role: "viewer",
      }),
    );
    const result = await run(db, hostsService.authorize(WEDDING_ID, ALICE));
    expect(result?.role).toBe("viewer");
  });

  it("normalises a legacy 'host' seat (DDL default) to editor", async () => {
    const db = buildDb();
    db.insert(weddingHosts)
      .values({
        id: "whost_legacy",
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        addedByOsnProfileId: OWNER,
        // No role — lands on the column's legacy DDL DEFAULT 'host'.
        createdAt: new Date(),
      })
      .run();
    const result = await run(db, hostsService.authorize(WEDDING_ID, ALICE));
    expect(result?.role).toBe("editor");
  });

  it("returns isOwner:false isHost:false role:null for a stranger", async () => {
    const db = buildDb();
    const result = await run(db, hostsService.authorize(WEDDING_ID, "usr_stranger"));
    expect(result).toEqual({
      isOwner: false,
      isHost: false,
      role: null,
      hostId: null,
      runSheetScope: "own",
      weddingSlug: "test-wedding",
      weddingTier: "ivory",
    });
  });

  it("returns null for an unknown wedding", async () => {
    const db = buildDb();
    expect(await run(db, hostsService.authorize("wed_nope", OWNER))).toBeNull();
  });

  it("carries the wedding's tier from the same row, for the owner and a co-host", async () => {
    const db = buildDb();
    db.update(weddings).set({ tier: "crimson" }).where(eq(weddings.id, WEDDING_ID)).run();
    await run(
      db,
      hostsService.add({
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        addedByOsnProfileId: OWNER,
        role: "viewer",
      }),
    );
    expect((await run(db, hostsService.authorize(WEDDING_ID, OWNER)))?.weddingTier).toBe("crimson");
    expect((await run(db, hostsService.authorize(WEDDING_ID, ALICE)))?.weddingTier).toBe("crimson");
  });

  it("reads a stored tier it does not recognise as ivory", async () => {
    const db = buildDb();
    db.$client.exec(`UPDATE weddings SET tier = 'platinum' WHERE id = '${WEDDING_ID}'`);
    expect((await run(db, hostsService.authorize(WEDDING_ID, OWNER)))?.weddingTier).toBe("ivory");
  });
});

describe("hostsService.authorizeWithRsvpDigest", () => {
  /** The caller's notice row, as `rsvpChangeService.setDigest` writes it. */
  function setDigest(db: TestDb, osnProfileId: string, digestEnabled: boolean) {
    db.insert(hostRsvpNotices)
      .values({ weddingId: WEDDING_ID, osnProfileId, digestEnabled, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [hostRsvpNotices.weddingId, hostRsvpNotices.osnProfileId],
        set: { digestEnabled },
      })
      .run();
  }

  it("answers what authorize() answers, plus the caller's digest setting", async () => {
    const db = buildDb();
    seat(db, ALICE, "editor");
    for (const caller of [OWNER, ALICE, "usr_stranger"]) {
      const plain = await run(db, hostsService.authorize(WEDDING_ID, caller));
      const withDigest = await run(db, hostsService.authorizeWithRsvpDigest(WEDDING_ID, caller));
      expect(withDigest).toEqual({ ...plain!, rsvpDigestEnabled: true });
    }
  });

  it("reads no notice row as on, and the caller's own row only", async () => {
    const db = buildDb();
    seat(db, ALICE, "editor");
    setDigest(db, ALICE, false);
    const alice = await run(db, hostsService.authorizeWithRsvpDigest(WEDDING_ID, ALICE));
    const owner = await run(db, hostsService.authorizeWithRsvpDigest(WEDDING_ID, OWNER));
    expect(alice?.rsvpDigestEnabled).toBe(false);
    expect(owner?.rsvpDigestEnabled).toBe(true);
    setDigest(db, ALICE, true);
    expect(
      (await run(db, hostsService.authorizeWithRsvpDigest(WEDDING_ID, ALICE)))?.rsvpDigestEnabled,
    ).toBe(true);
  });

  it("returns null for an unknown or deleted wedding", async () => {
    const db = buildDb();
    expect(await run(db, hostsService.authorizeWithRsvpDigest("wed_nope", OWNER))).toBeNull();
    db.update(weddings).set({ deletedAt: new Date() }).where(eq(weddings.id, WEDDING_ID)).run();
    expect(await run(db, hostsService.authorizeWithRsvpDigest(WEDDING_ID, OWNER))).toBeNull();
  });
});

describe("equal owners", () => {
  const BEN = "usr_ben";

  it("authorizes a second owner exactly as the first", async () => {
    const db = buildDb();
    seat(db, BEN, "owner");
    const first = await run(db, hostsService.authorize(WEDDING_ID, OWNER));
    const second = await run(db, hostsService.authorize(WEDDING_ID, BEN));
    expect(first).toMatchObject({ isOwner: true, isHost: false, role: "owner" });
    expect(second).toMatchObject({ isOwner: true, isHost: false, role: "owner" });
  });

  describe("setRole", () => {
    it("promotes a co-host to owner", async () => {
      const db = buildDb();
      seat(db, ALICE, "editor");
      const host = await run(
        db,
        hostsService.setRole({
          weddingId: WEDDING_ID,
          osnProfileId: ALICE,
          role: "owner",
          actorOsnProfileId: OWNER,
        }),
      );
      expect(host.role).toBe("owner");
      expect(roleOf(db, ALICE)).toBe("owner");
    });

    it("promotes on a full wedding: a role change adds no seat", async () => {
      const db = buildDb();
      for (let i = 1; i < MAX_HOSTS_PER_WEDDING; i += 1) seat(db, `usr_seat_${i}`, "editor");
      await run(
        db,
        hostsService.setRole({
          weddingId: WEDDING_ID,
          osnProfileId: "usr_seat_1",
          role: "owner",
          actorOsnProfileId: OWNER,
        }),
      );
      expect(roleOf(db, "usr_seat_1")).toBe("owner");
    });

    it("lets an owner who is already an owner stay one (idempotent)", async () => {
      const db = buildDb();
      const host = await run(
        db,
        hostsService.setRole({
          weddingId: WEDDING_ID,
          osnProfileId: OWNER,
          role: "owner",
          actorOsnProfileId: OWNER,
        }),
      );
      expect(host.role).toBe("owner");
    });

    it("lets one of two owners step down", async () => {
      const db = buildDb();
      seat(db, BEN, "owner");
      await run(
        db,
        hostsService.setRole({
          weddingId: WEDDING_ID,
          osnProfileId: OWNER,
          role: "editor",
          actorOsnProfileId: OWNER,
        }),
      );
      expect(roleOf(db, OWNER)).toBe("editor");
      expect(roleOf(db, BEN)).toBe("owner");
    });

    it("refuses to demote the last owner (LastOwner) and changes nothing", async () => {
      const db = buildDb();
      for (const role of ["editor", "viewer", "helper"] as const) {
        const err = await run(
          db,
          hostsService
            .setRole({ weddingId: WEDDING_ID, osnProfileId: OWNER, role, actorOsnProfileId: OWNER })
            .pipe(Effect.flip),
        );
        expect(err._tag).toBe("LastOwner");
      }
      expect(roleOf(db, OWNER)).toBe("owner");
    });

    it("refuses the second of two owners demoting each other in turn", async () => {
      const db = buildDb();
      seat(db, BEN, "owner");
      await run(
        db,
        hostsService.setRole({
          weddingId: WEDDING_ID,
          osnProfileId: BEN,
          role: "viewer",
          actorOsnProfileId: OWNER,
        }),
      );
      const err = await run(
        db,
        hostsService
          .setRole({
            weddingId: WEDDING_ID,
            osnProfileId: OWNER,
            role: "viewer",
            actorOsnProfileId: BEN,
          })
          .pipe(Effect.flip),
      );
      expect(err._tag).toBe("LastOwner");
      expect(roleOf(db, OWNER)).toBe("owner");
    });

    it("lets one of two owners step down on a full wedding: a role change adds no seat", async () => {
      // The wedding is over its people limit as well as at the seat cap; an
      // owner stepping down is allowed past both.
      const db = buildDb();
      seat(db, BEN, "owner");
      for (let i = 2; i < MAX_HOSTS_PER_WEDDING; i += 1) seat(db, `usr_seat_${i}`, "editor");
      await run(
        db,
        hostsService.setRole({
          weddingId: WEDDING_ID,
          osnProfileId: BEN,
          role: "editor",
          actorOsnProfileId: BEN,
        }),
      );
      expect(roleOf(db, BEN)).toBe("editor");
    });

    it("still moves a co-host between roles below owner on a full wedding", async () => {
      const db = buildDb();
      for (let i = 1; i < MAX_HOSTS_PER_WEDDING; i += 1) seat(db, `usr_seat_${i}`, "editor");
      await run(
        db,
        hostsService.setRole({
          weddingId: WEDDING_ID,
          osnProfileId: "usr_seat_1",
          role: "viewer",
          actorOsnProfileId: OWNER,
        }),
      );
      expect(roleOf(db, "usr_seat_1")).toBe("viewer");
    });
  });

  describe("remove", () => {
    const noticeOf = (db: TestDb, osnProfileId: string) =>
      db
        .select()
        .from(hostRsvpNotices)
        .where(
          and(
            eq(hostRsvpNotices.weddingId, WEDDING_ID),
            eq(hostRsvpNotices.osnProfileId, osnProfileId),
          ),
        )
        .all();

    function addNotice(db: TestDb, osnProfileId: string) {
      db.insert(hostRsvpNotices)
        .values({
          weddingId: WEDDING_ID,
          osnProfileId,
          seenSeq: 4,
          digestSeq: 4,
          digestEnabled: false,
          updatedAt: new Date(),
        })
        .run();
    }

    it("removes another owner, and their RSVP marker with them", async () => {
      const db = buildDb();
      seat(db, BEN, "owner");
      addNotice(db, BEN);
      await run(db, hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: BEN }));
      expect(roleOf(db, BEN)).toBeUndefined();
      expect(noticeOf(db, BEN)).toHaveLength(0);
      expect(roleOf(db, OWNER)).toBe("owner");
    });

    it("lets one of two owners leave", async () => {
      const db = buildDb();
      seat(db, BEN, "owner");
      await run(db, hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: OWNER }));
      expect(roleOf(db, OWNER)).toBeUndefined();
      expect(roleOf(db, BEN)).toBe("owner");
    });

    it("refuses to remove the last owner (LastOwner) and keeps their seat and RSVP marker", async () => {
      const db = buildDb();
      addNotice(db, OWNER);
      const err = await run(
        db,
        hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: OWNER }).pipe(Effect.flip),
      );
      expect(err._tag).toBe("LastOwner");
      expect(roleOf(db, OWNER)).toBe("owner");
      // The marker belongs to the seat; a refused removal must not take it.
      expect(noticeOf(db, OWNER)).toHaveLength(1);
      expect(noticeOf(db, OWNER)[0]).toMatchObject({ seenSeq: 4, digestEnabled: false });
    });

    it("refuses the second of two owners removing each other in turn", async () => {
      const db = buildDb();
      seat(db, BEN, "owner");
      await run(db, hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: BEN }));
      const err = await run(
        db,
        hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: OWNER }).pipe(Effect.flip),
      );
      expect(err._tag).toBe("LastOwner");
      expect(roleOf(db, OWNER)).toBe("owner");
    });

    it("removes a co-host's RSVP marker with their seat", async () => {
      const db = buildDb();
      seat(db, ALICE, "viewer");
      addNotice(db, ALICE);
      await run(db, hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: ALICE }));
      expect(noticeOf(db, ALICE)).toHaveLength(0);
    });
  });
});

describe("the prior role a write reports", () => {
  it("setRole reports the role the seat held before the change", async () => {
    const db = buildDb();
    seat(db, ALICE, "owner");
    const demoted = await run(
      db,
      hostsService.setRole({
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        role: "viewer",
        actorOsnProfileId: OWNER,
      }),
    );
    expect(demoted).toMatchObject({ role: "viewer", previousRole: "owner" });

    const again = await run(
      db,
      hostsService.setRole({
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        role: "viewer",
        actorOsnProfileId: OWNER,
      }),
    );
    expect(again.previousRole).toBe("viewer");
  });

  it("remove reports the removed seat as it stood, and null when there was no seat", async () => {
    const db = buildDb();
    seat(db, ALICE, "owner");
    expect(
      await run(db, hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: ALICE })),
    ).toMatchObject({ removed: { role: "owner", addedByOsnProfileId: OWNER } });
    expect(
      await run(db, hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: ALICE })),
    ).toEqual({ removed: null, peopleLimit: { used: 0, limit: 6, tier: "ivory" } });
  });
});

describe("hostsService.list on a wedding with no seats", () => {
  it("lists nothing, with a total of 0 and the lowest limit", async () => {
    const db = buildDb();
    expect(await run(db, hostsService.list("wed_nobody"))).toEqual({
      hosts: [],
      total: 0,
      peopleLimit: { used: 0, limit: 6, tier: "ivory" },
    });
  });
});
