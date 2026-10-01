import { describe, it, expect } from "bun:test";

import { weddingHosts, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import { slugifyDisplayName, weddingsService } from "../../src/services/weddings";
import { insertWedding } from "../test-helpers/wedding";

describe("slugifyDisplayName", () => {
  it("lowercases and hyphenates words", () => {
    expect(slugifyDisplayName("Nadia & Sam")).toBe("nadia-sam");
  });

  it("strips accents and apostrophes into hyphen-joined ASCII", () => {
    expect(slugifyDisplayName("Pádraig's Big Day")).toBe("padraig-s-big-day");
  });

  it("trims leading/trailing separators", () => {
    expect(slugifyDisplayName("  --Hello--  ")).toBe("hello");
  });

  it("falls back to 'wedding' for slug-empty input", () => {
    expect(slugifyDisplayName("🎉💍")).toBe("wedding");
    expect(slugifyDisplayName("")).toBe("wedding");
  });

  it("caps the base slug length", () => {
    const long = "a".repeat(200);
    expect(slugifyDisplayName(long).length).toBeLessThanOrEqual(60);
  });
});

describe("weddingsService.createForOwner", () => {
  const run = <A, E>(db: ReturnType<typeof createDb>, eff: Effect.Effect<A, E, DbService>) =>
    Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));

  it("inserts a row owned by the caller with a unique slug + default code style", async () => {
    const db = createDb(":memory:");
    const summary = await run(db, weddingsService.createForOwner("usr_owner", "Beach Wedding"));

    expect(summary.id).toMatch(/^wed_[0-9a-f]{32}$/);
    expect(summary.slug).toMatch(/^beach-wedding-[0-9a-f]{6}$/);
    expect(summary.displayName).toBe("Beach Wedding");

    const [row] = db.select().from(weddings).where(eq(weddings.id, summary.id)).all();
    expect(row!.codeStyle).toBe("secure");
    // The wedding and its creator's owner seat land together.
    const seats = db
      .select()
      .from(weddingHosts)
      .where(eq(weddingHosts.weddingId, summary.id))
      .all();
    expect(seats.map((h) => [h.osnProfileId, h.role, h.addedByOsnProfileId])).toEqual([
      ["usr_owner", "owner", "usr_owner"],
    ]);
    expect(seats[0]!.id).toMatch(/^whost_/);
  });

  it("gives same-named weddings distinct slugs (random suffix)", async () => {
    const db = createDb(":memory:");
    const a = await run(db, weddingsService.createForOwner("usr_owner", "Same Name"));
    const b = await run(db, weddingsService.createForOwner("usr_owner", "Same Name"));
    expect(a.slug).not.toBe(b.slug);
    expect(a.id).not.toBe(b.id);
  });

  it("fails with WeddingCreateError when the insert keeps throwing (T-E1)", async () => {
    const db = createDb(":memory:");
    // Wrap the real db so every insert rejects when the batch awaits it —
    // exhausts the retry loop and surfaces the tagged error rather than a
    // defect.
    const failing = {
      ...db,
      insert: () => ({
        // Rejected with a handler already attached: the batch rejects when it
        // reaches the first statement, and the one after it is never left as
        // an unhandled rejection.
        values: () => {
          const failed = Promise.reject(new Error("forced insert failure"));
          failed.catch(() => {});
          return failed;
        },
      }),
    } as unknown as ReturnType<typeof createDb>;

    const error = await Effect.runPromise(
      weddingsService
        .createForOwner("usr_owner", "Doomed Wedding")
        .pipe(Effect.provideService(DbService, failing), Effect.flip),
    );
    expect(error._tag).toBe("WeddingCreateError");
    expect(error.reason).toBe("insert");
  });
});

describe("weddingsService.listForMember", () => {
  const run = <A, E>(db: ReturnType<typeof createDb>, eff: Effect.Effect<A, E, DbService>) =>
    Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));

  it("returns the owner's weddings oldest-first and excludes other owners (T-U1)", async () => {
    const db = createDb(":memory:");
    const now = Date.now();
    // Insert out of creation order to prove the ORDER BY (not insertion order).
    insertWedding(db, {
      id: "wed_mid",
      slug: "mid",
      displayName: "Middle",
      createdAt: new Date(now + 2_000),
      updatedAt: new Date(now + 2_000),
      owners: ["usr_owner"],
    });
    insertWedding(db, {
      id: "wed_first",
      slug: "first",
      displayName: "First",
      createdAt: new Date(now + 1_000),
      updatedAt: new Date(now + 1_000),
      owners: ["usr_owner"],
    });
    insertWedding(db, {
      id: "wed_last",
      slug: "last",
      displayName: "Last",
      createdAt: new Date(now + 3_000),
      updatedAt: new Date(now + 3_000),
      owners: ["usr_owner"],
    });
    // A wedding belonging to someone else must not leak in.
    insertWedding(db, {
      id: "wed_other",
      slug: "other",
      displayName: "Other",
      createdAt: new Date(now),
      updatedAt: new Date(now),
      owners: ["usr_someone_else"],
    });

    const list = await run(db, weddingsService.listForMember("usr_owner"));
    expect(list.map((w) => w.id)).toEqual(["wed_first", "wed_mid", "wed_last"]);
    expect(list.every((w) => w.role === "owner")).toBe(true);
  });

  it("returns an empty list for an owner with no weddings", async () => {
    const db = createDb(":memory:");
    const list = await run(db, weddingsService.listForMember("usr_nobody"));
    expect(list).toEqual([]);
  });

  it("includes co-hosted weddings with their seat role, oldest seat first (T-U2)", async () => {
    const db = createDb(":memory:");
    const now = Date.now();
    // One owned by the member.
    insertWedding(db, {
      id: "wed_owned",
      slug: "owned",
      displayName: "Owned",
      createdAt: new Date(now + 1_000),
      updatedAt: new Date(now + 1_000),
      owners: ["usr_member"],
    });
    // One owned by someone else, co-hosted by the member.
    insertWedding(db, {
      id: "wed_cohosted",
      slug: "cohosted",
      displayName: "Co-hosted",
      createdAt: new Date(now),
      updatedAt: new Date(now),
      owners: ["usr_other_owner"],
    });
    db.insert(weddingHosts)
      .values({
        id: "whost_1",
        weddingId: "wed_cohosted",
        osnProfileId: "usr_member",
        addedByOsnProfileId: "usr_other_owner",
        createdAt: new Date(now + 5_000),
      })
      .run();

    const list = await run(db, weddingsService.listForMember("usr_member"));
    expect(list.map((w) => [w.id, w.role])).toEqual([
      ["wed_owned", "owner"],
      // The seed omitted `role` → legacy DDL default 'host' → normalised.
      ["wed_cohosted", "editor"],
    ]);
  });

  it("lists a wedding as owned for each of its owners, once each", async () => {
    const db = createDb(":memory:");
    insertWedding(db, {
      id: "wed_shared",
      slug: "shared",
      displayName: "Shared",
      owners: ["usr_ada", "usr_bo"],
    });
    for (const owner of ["usr_ada", "usr_bo"]) {
      const list = await run(db, weddingsService.listForMember(owner));
      expect(list.map((w) => [w.id, w.role])).toEqual([["wed_shared", "owner"]]);
    }
  });

  it("surfaces a viewer seat's role in the list", async () => {
    const db = createDb(":memory:");
    const now = Date.now();
    insertWedding(db, {
      id: "wed_viewed",
      slug: "viewed",
      displayName: "Viewed",
      createdAt: new Date(now),
      updatedAt: new Date(now),
      owners: ["usr_other_owner"],
    });
    db.insert(weddingHosts)
      .values({
        id: "whost_v",
        weddingId: "wed_viewed",
        osnProfileId: "usr_member",
        addedByOsnProfileId: "usr_other_owner",
        role: "viewer",
        createdAt: new Date(now),
      })
      .run();
    const list = await run(db, weddingsService.listForMember("usr_member"));
    expect(list.map((w) => [w.id, w.role])).toEqual([["wed_viewed", "viewer"]]);
  });
});
