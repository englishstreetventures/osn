import { describe, it, expect } from "bun:test";

import { weddingHosts, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../db";
import { createDb } from "../db/setup";
import { hostConflictReason, hostsService, normaliseHostRole } from "./hosts";

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
    const hosts = await run(db, hostsService.list(WEDDING_ID));
    expect(hosts.map((h) => h.osnProfileId)).toEqual([ALICE]);
  });

  it("returns an empty list for a wedding with no co-hosts", async () => {
    const db = buildDb();
    expect(await run(db, hostsService.list(WEDDING_ID))).toEqual([]);
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
});
