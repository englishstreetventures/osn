import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families } from "@cire/db";
import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";

import type { Db } from "../db";
import { DbService } from "../db";
import { createDb, seedBootstrapWedding } from "../db/setup";
import { claimService, InvalidCredentials } from "./claim";
import { householdsService } from "./households";
import { issueInviteService } from "./issue-invite";

function freshDb(): Db {
  const db = createDb(":memory:");
  seedBootstrapWedding(db);
  return db;
}

const run = <A, E>(db: Db, eff: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));

/** Insert a household WITH a code directly (bypassing issue), for the "already
 *  coded" guards. */
function seedCodedFamily(db: Db, id: string, publicId: string): void {
  const now = new Date();
  db.insert(families)
    .values({
      id,
      weddingId: BOOTSTRAP_WEDDING_ID,
      publicId,
      familyName: "Coded",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

const readCode = (db: Db, familyId: string): string | null =>
  db
    .select({ publicId: families.publicId })
    .from(families)
    .where(eq(families.id, familyId))
    .all()[0]!.publicId;

describe("issueInviteService.issueForFamily (single)", () => {
  it("mints a valid SURNAME-WORD-HASH code onto a code-less household", async () => {
    const db = freshDb();
    const household = await run(db, householdsService.create(BOOTSTRAP_WEDDING_ID, "Sharma"));
    expect(household.publicId).toBeNull();

    const issued = await run(
      db,
      issueInviteService.issueForFamily(BOOTSTRAP_WEDDING_ID, household.familyId),
    );
    // Bootstrap wedding defaults to `secure` → 4 segments (SURNAME-WORD-HASH5-HASH5).
    expect(issued.publicId.split("-")).toHaveLength(4);
    expect(issued.publicId.startsWith("SHARMA-")).toBe(true);
    // Persisted.
    expect(readCode(db, household.familyId)).toBe(issued.publicId);
  });

  it("404s (NotCodelessFamily) for a household that ALREADY has a code", async () => {
    const db = freshDb();
    seedCodedFamily(db, "fam_coded", "CODED-OAK-AB3K9-X7QPM");
    const err = await run(
      db,
      Effect.flip(issueInviteService.issueForFamily(BOOTSTRAP_WEDDING_ID, "fam_coded")),
    );
    expect(err._tag).toBe("NotCodelessFamily");
    // Untouched.
    expect(readCode(db, "fam_coded")).toBe("CODED-OAK-AB3K9-X7QPM");
  });

  it("404s for an unknown / cross-tenant family", async () => {
    const db = freshDb();
    const err = await run(
      db,
      Effect.flip(issueInviteService.issueForFamily(BOOTSTRAP_WEDDING_ID, "fam_nope")),
    );
    expect(err._tag).toBe("NotCodelessFamily");
  });
});

describe("issueInviteService.issueForAllCodeless (bulk)", () => {
  it("issues a code for EVERY code-less household, leaving coded ones untouched", async () => {
    const db = freshDb();
    const a = await run(db, householdsService.create(BOOTSTRAP_WEDDING_ID, "Alpha"));
    const b = await run(db, householdsService.create(BOOTSTRAP_WEDDING_ID, "Beta"));
    seedCodedFamily(db, "fam_kept", "KEPT-OAK-AB3K9-X7QPM");

    const result = await run(db, issueInviteService.issueForAllCodeless(BOOTSTRAP_WEDDING_ID));
    expect(result.issued).toBe(2);

    // Both code-less households now have a code…
    expect(readCode(db, a.familyId)).not.toBeNull();
    expect(readCode(db, b.familyId)).not.toBeNull();
    // …and the already-coded one is unchanged (not re-rotated).
    expect(readCode(db, "fam_kept")).toBe("KEPT-OAK-AB3K9-X7QPM");

    // No code-less households remain.
    const remaining = db
      .select({ id: families.id })
      .from(families)
      .where(and(eq(families.weddingId, BOOTSTRAP_WEDDING_ID), isNull(families.publicId)))
      .all();
    expect(remaining).toHaveLength(0);

    // Every issued code is UNIQUE (the de-dupe held).
    const codes = new Set([readCode(db, a.familyId), readCode(db, b.familyId)]);
    expect(codes.size).toBe(2);
  });

  it("returns issued: 0 when there are no code-less households", async () => {
    const db = freshDb();
    seedCodedFamily(db, "fam_only", "ONLY-OAK-AB3K9-X7QPM");
    const result = await run(db, issueInviteService.issueForAllCodeless(BOOTSTRAP_WEDDING_ID));
    expect(result.issued).toBe(0);
    expect(result.invites).toEqual([]);
  });

  it("excludes the synthetic host-preview family", async () => {
    const db = freshDb();
    // A code-less host family should never be issued a guest code by the bulk path.
    const now = new Date();
    db.insert(families)
      .values({
        id: "fam_host",
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: null,
        familyName: "Host Preview",
        kind: "host",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const result = await run(db, issueInviteService.issueForAllCodeless(BOOTSTRAP_WEDDING_ID));
    expect(result.issued).toBe(0);
    expect(readCode(db, "fam_host")).toBeNull();
  });
});

describe("code-less household is NOT claimable", () => {
  it("a code-less household cannot be claimed (NULL never matches a code)", async () => {
    const db = freshDb();
    await run(db, householdsService.create(BOOTSTRAP_WEDDING_ID, "Nobody"));
    // The guest claim path looks up by publicId; a NULL code can never be the
    // input (claim rejects empty/whitespace upstream, and NULL ≠ any string).
    const err = await run(db, Effect.flip(claimService.lookup("")));
    expect(err).toBeInstanceOf(InvalidCredentials);
    // Even an explicit attempt with a bogus code fails.
    const err2 = await run(db, Effect.flip(claimService.lookup("NOBODY-NULL-CODE")));
    expect(err2).toBeInstanceOf(InvalidCredentials);
  });

  it("becomes claimable once an invite is issued", async () => {
    const db = freshDb();
    const household = await run(db, householdsService.create(BOOTSTRAP_WEDDING_ID, "Later"));
    const issued = await run(
      db,
      issueInviteService.issueForFamily(BOOTSTRAP_WEDDING_ID, household.familyId),
    );
    const claim = await run(db, claimService.lookup(issued.publicId));
    expect(claim.familyId).toBe(household.familyId);
    expect(claim.publicId).toBe(issued.publicId);
  });
});
