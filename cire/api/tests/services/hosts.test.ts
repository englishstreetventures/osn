import { describe, it, expect } from "bun:test";

import { weddingEntitlements, weddingHosts, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import {
  hostConflictReason,
  hostsService,
  MAX_HOSTS_PER_WEDDING,
  normaliseHostRole,
} from "../../src/services/hosts";

const OWNER = "usr_owner";
const ALICE = "usr_alice";
const WEDDING_ID = "wed_test";

function buildDb() {
  const db = createDb(":memory:");
  const now = new Date();
  db.insert(weddings)
    .values({
      id: WEDDING_ID,
      slug: "test-wedding",
      displayName: "Test Wedding",
      ownerOsnProfileId: OWNER,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return db;
}

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

describe("normaliseHostRole", () => {
  it("passes editor and viewer through", () => {
    expect(normaliseHostRole("editor")).toBe("editor");
    expect(normaliseHostRole("viewer")).toBe("viewer");
  });

  it("degrades the legacy 'host' value to editor (what pre-roles co-hosts were)", () => {
    expect(normaliseHostRole("host")).toBe("editor");
  });

  it("degrades unknown/corrupted values to viewer — least privilege, never fail-open (S-L1)", () => {
    expect(normaliseHostRole("")).toBe("viewer");
    expect(normaliseHostRole("admin")).toBe("viewer");
    expect(normaliseHostRole("EDITOR")).toBe("viewer");
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
        ownerOsnProfileId: OWNER,
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
        ownerOsnProfileId: OWNER,
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
        ownerOsnProfileId: OWNER,
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
          ownerOsnProfileId: OWNER,
          role: "editor",
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("HostConflict");
    expect((err as { reason: string }).reason).toBe("already_host");
    // Still exactly one row — no duplicate seat.
    expect(db.select().from(weddingHosts).all()).toHaveLength(1);
  });

  it("rejects adding the owner as a host (owner_is_host) without a DB write", async () => {
    const db = buildDb();
    const err = await run(
      db,
      hostsService
        .add({
          weddingId: WEDDING_ID,
          osnProfileId: OWNER,
          addedByOsnProfileId: OWNER,
          ownerOsnProfileId: OWNER,
          role: "editor",
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("HostConflict");
    expect((err as { reason: string }).reason).toBe("owner_is_host");
    expect(db.select().from(weddingHosts).all()).toHaveLength(0);
  });
});

describe("hostsService.list", () => {
  it("lists the wedding's hosts oldest-first and scopes to the wedding", async () => {
    const db = buildDb();
    // A second wedding whose host must not leak in.
    const now = new Date();
    db.insert(weddings)
      .values({
        id: "wed_other",
        slug: "other",
        displayName: "Other",
        ownerOsnProfileId: "usr_other",
        createdAt: now,
        updatedAt: now,
      })
      .run();
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
        ownerOsnProfileId: OWNER,
        role: "editor",
      }),
    );
    const { hosts, total } = await run(db, hostsService.list(WEDDING_ID));
    expect(hosts.map((h) => h.osnProfileId)).toEqual([ALICE]);
    // Attribution rides along: with editors able to create seats, "who added
    // this one" is what lets an owner spot a seat they didn't create.
    expect(hosts.map((h) => h.addedByOsnProfileId)).toEqual([OWNER]);
    // `total` counts the wedding's OWN rows — the other wedding's host is
    // excluded from it as well as from the list.
    expect(total).toBe(1);
  });

  it("caps the seats a wedding can hold, so every seat stays listable (S-H1)", async () => {
    // The property the cap defends, driven the way the security review drove
    // the bug: seats past the list ceiling are invisible to the owner, and
    // DELETE needs a profile id they can only get from that list — so an
    // uncapped add lets an editor create co-hosts the owner cannot remove.
    // "Additive, and the owner reverses it" only holds while every seat is
    // listed, which is what keeps the cap below the ceiling.
    const db = buildDb();
    for (let i = 0; i < MAX_HOSTS_PER_WEDDING; i += 1) {
      await run(
        db,
        hostsService.add({
          weddingId: WEDDING_ID,
          osnProfileId: `usr_seat_${i}`,
          addedByOsnProfileId: OWNER,
          ownerOsnProfileId: OWNER,
          role: "editor",
        }),
      );
    }

    const err = await run(
      db,
      hostsService
        .add({
          weddingId: WEDDING_ID,
          osnProfileId: "usr_one_too_many",
          addedByOsnProfileId: OWNER,
          ownerOsnProfileId: OWNER,
          role: "editor",
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("HostConflict");
    expect((err as { reason: string }).reason).toBe("host_cap_reached");

    // The refusal is real: no row was written, and the whole set is listed.
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
    expect(total).toBe(205);
  });

  it("returns an empty list for a wedding with no co-hosts", async () => {
    const db = buildDb();
    expect(await run(db, hostsService.list(WEDDING_ID))).toEqual({ hosts: [], total: 0 });
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
        ownerOsnProfileId: OWNER,
        role: "editor",
      }),
    );
    await run(db, hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: ALICE }));
    expect(db.select().from(weddingHosts).all()).toHaveLength(0);
    // Idempotent — removing again succeeds.
    await run(db, hostsService.remove({ weddingId: WEDDING_ID, osnProfileId: ALICE }));
  });

  it("does not remove a host from a different wedding (cross-tenant guard)", async () => {
    const db = buildDb();
    const now = new Date();
    db.insert(weddings)
      .values({
        id: "wed_b",
        slug: "b",
        displayName: "B",
        ownerOsnProfileId: "usr_b",
        createdAt: now,
        updatedAt: now,
      })
      .run();
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
      db.select().from(weddingHosts).where(eq(weddingHosts.weddingId, "wed_b")).all(),
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
        ownerOsnProfileId: OWNER,
        role: "editor",
      }),
    );
    const updated = await run(
      db,
      hostsService.setRole({ weddingId: WEDDING_ID, osnProfileId: ALICE, role: "viewer" }),
    );
    expect(updated.role).toBe("viewer");
    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, ALICE)).all();
    expect(row!.role).toBe("viewer");

    // Setting the same role again succeeds.
    const again = await run(
      db,
      hostsService.setRole({ weddingId: WEDDING_ID, osnProfileId: ALICE, role: "viewer" }),
    );
    expect(again.role).toBe("viewer");
  });

  it("fails HostNotFound for a profile that isn't a co-host (incl. the owner)", async () => {
    const db = buildDb();
    const err = await run(
      db,
      hostsService
        .setRole({ weddingId: WEDDING_ID, osnProfileId: OWNER, role: "viewer" })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("HostNotFound");
  });

  it("does not retarget another wedding's seat (cross-tenant guard)", async () => {
    const db = buildDb();
    const now = new Date();
    db.insert(weddings)
      .values({
        id: "wed_b",
        slug: "b2",
        displayName: "B",
        ownerOsnProfileId: "usr_b",
        createdAt: now,
        updatedAt: now,
      })
      .run();
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
        .setRole({ weddingId: WEDDING_ID, osnProfileId: ALICE, role: "viewer" })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("HostNotFound");
    const [row] = db.select().from(weddingHosts).where(eq(weddingHosts.weddingId, "wed_b")).all();
    expect(row!.role).toBe("editor");
  });
});

describe("hostsService.authorize", () => {
  it("returns isOwner:true with role owner for the owner", async () => {
    const db = buildDb();
    const result = await run(db, hostsService.authorize(WEDDING_ID, OWNER));
    expect(result).toEqual({
      ownerOsnProfileId: OWNER,
      isOwner: true,
      isHost: false,
      role: "owner",
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
        ownerOsnProfileId: OWNER,
        role: "editor",
      }),
    );
    const result = await run(db, hostsService.authorize(WEDDING_ID, ALICE));
    expect(result).toEqual({
      ownerOsnProfileId: OWNER,
      isOwner: false,
      isHost: true,
      role: "editor",
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
        ownerOsnProfileId: OWNER,
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
      ownerOsnProfileId: OWNER,
      isOwner: false,
      isHost: false,
      role: null,
    });
  });

  it("returns null for an unknown wedding", async () => {
    const db = buildDb();
    expect(await run(db, hostsService.authorize("wed_nope", OWNER))).toBeNull();
  });

  it("omits `entitled` entirely when no entitlementKey is given", async () => {
    const db = buildDb();
    const now = new Date();
    db.insert(weddingEntitlements)
      .values({
        weddingId: WEDDING_ID,
        entitlement: "vendors",
        source: "comp",
        grantedAt: now,
        grantedBy: OWNER,
      })
      .run();
    const result = await run(db, hostsService.authorize(WEDDING_ID, OWNER));
    expect(result?.entitled).toBeUndefined();
  });
});

describe("hostsService.authorize — entitlement fold (P-W1)", () => {
  it("owner branch: entitled:true when the wedding holds the key, folded into the same query", async () => {
    const db = buildDb();
    const now = new Date();
    db.insert(weddingEntitlements)
      .values({
        weddingId: WEDDING_ID,
        entitlement: "vendors",
        source: "comp",
        grantedAt: now,
        grantedBy: OWNER,
      })
      .run();
    const result = await run(db, hostsService.authorize(WEDDING_ID, OWNER, "vendors"));
    expect(result).toEqual({
      ownerOsnProfileId: OWNER,
      isOwner: true,
      isHost: false,
      role: "owner",
      entitled: true,
    });
  });

  it("owner branch: entitled:false when the wedding lacks the key", async () => {
    const db = buildDb();
    const result = await run(db, hostsService.authorize(WEDDING_ID, OWNER, "vendors"));
    expect(result?.entitled).toBe(false);
  });

  it("owner branch: entitled reflects the SPECIFIC key asked for, not just any grant", async () => {
    const db = buildDb();
    const now = new Date();
    db.insert(weddingEntitlements)
      .values({
        weddingId: WEDDING_ID,
        entitlement: "ai",
        source: "comp",
        grantedAt: now,
        grantedBy: OWNER,
      })
      .run();
    const result = await run(db, hostsService.authorize(WEDDING_ID, OWNER, "vendors"));
    expect(result?.entitled).toBe(false);
  });

  it("co-host branch: entitled:true when the wedding holds the key", async () => {
    const db = buildDb();
    const now = new Date();
    await run(
      db,
      hostsService.add({
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        addedByOsnProfileId: OWNER,
        ownerOsnProfileId: OWNER,
        role: "editor",
      }),
    );
    db.insert(weddingEntitlements)
      .values({
        weddingId: WEDDING_ID,
        entitlement: "registry",
        source: "comp",
        grantedAt: now,
        grantedBy: OWNER,
      })
      .run();
    const result = await run(db, hostsService.authorize(WEDDING_ID, ALICE, "registry"));
    expect(result).toEqual({
      ownerOsnProfileId: OWNER,
      isOwner: false,
      isHost: true,
      role: "editor",
      entitled: true,
    });
  });

  it("co-host branch: entitled:false when the wedding lacks the key", async () => {
    const db = buildDb();
    await run(
      db,
      hostsService.add({
        weddingId: WEDDING_ID,
        osnProfileId: ALICE,
        addedByOsnProfileId: OWNER,
        ownerOsnProfileId: OWNER,
        role: "editor",
      }),
    );
    const result = await run(db, hostsService.authorize(WEDDING_ID, ALICE, "registry"));
    expect(result?.entitled).toBe(false);
  });

  it("stranger branch: role:null and entitled:false — no query answer is meaningful without a role", async () => {
    const db = buildDb();
    const now = new Date();
    db.insert(weddingEntitlements)
      .values({
        weddingId: WEDDING_ID,
        entitlement: "vendors",
        source: "comp",
        grantedAt: now,
        grantedBy: OWNER,
      })
      .run();
    const result = await run(db, hostsService.authorize(WEDDING_ID, "usr_stranger", "vendors"));
    expect(result).toEqual({
      ownerOsnProfileId: OWNER,
      isOwner: false,
      isHost: false,
      role: null,
      entitled: false,
    });
  });

  it("unknown wedding: still null, entitlementKey doesn't change that", async () => {
    const db = buildDb();
    expect(await run(db, hostsService.authorize("wed_nope", OWNER, "vendors"))).toBeNull();
  });
});
