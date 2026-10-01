import { describe, expect, it } from "bun:test";

import { families, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { claimChanges, headRevision } from "../../src/services/changes";
import { claimService } from "../../src/services/claim";
import { hostsService } from "../../src/services/hosts";
import { sessionService } from "../../src/services/session";
import { fullWeddingCode, fullWeddingStatements } from "../test-helpers/full-wedding";

/**
 * The service-level chokepoints a soft-deleted wedding meets, each against the
 * same wedding live, deleted, and restored. The route-level net is
 * `tests/routes/soft-deleted-wedding.test.ts`; crons and mail are in their own
 * service tests.
 */

const WID = "wed_choke";
const OWNER = `usr_owner_${WID}`;
const FAMILY = `fam_${WID}`;

function makeDb(): TestDb {
  const db = createDb(":memory:");
  for (const statement of fullWeddingStatements(WID)) db.run(statement);
  return db;
}

const setDeleted = (db: TestDb, deleted: boolean) =>
  db
    .update(weddings)
    .set(
      deleted
        ? { deletedAt: new Date(), deletedByOsnProfileId: OWNER }
        : { deletedAt: null, deletedByOsnProfileId: null },
    )
    .where(eq(weddings.id, WID))
    .run();

const run = <A, E>(db: TestDb, effect: Effect.Effect<A, E, DbService>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provideService(DbService, db)));

describe("hostsService.authorize", () => {
  it("answers a deleted wedding as unknown, to its owner too", async () => {
    const db = makeDb();
    const live = await run(db, hostsService.authorize(WID, OWNER));
    expect(Exit.isSuccess(live) && live.value?.role).toBe("owner");
    setDeleted(db, true);
    const gone = await run(db, hostsService.authorize(WID, OWNER));
    expect(Exit.isSuccess(gone) && gone.value).toBeNull();
  });

  it("is seen by the restore-only variant, with when it was deleted", async () => {
    const db = makeDb();
    setDeleted(db, true);
    const seen = await run(db, hostsService.authorizeIncludingDeleted(WID, OWNER));
    expect(Exit.isSuccess(seen)).toBe(true);
    if (Exit.isSuccess(seen)) {
      expect(seen.value?.role).toBe("owner");
      expect(seen.value?.deletedAt).toBeInstanceOf(Date);
    }
  });
});

describe("sessionService.validate", () => {
  it("refuses a deleted wedding's session and accepts the same token after a restore", async () => {
    const db = makeDb();
    const created = await run(db, sessionService.create(FAMILY));
    if (!Exit.isSuccess(created)) throw new Error("session not created");
    const { token } = created.value;

    expect(Exit.isSuccess(await run(db, sessionService.validate(token)))).toBe(true);
    setDeleted(db, true);
    expect(Exit.isFailure(await run(db, sessionService.validate(token)))).toBe(true);
    setDeleted(db, false);
    expect(Exit.isSuccess(await run(db, sessionService.validate(token)))).toBe(true);
  });
});

describe("claimService.lookup", () => {
  it("fails a deleted wedding's code as an unknown code, before the first-open write", async () => {
    const db = makeDb();
    setDeleted(db, true);
    const exit = await run(db, claimService.lookup(fullWeddingCode(WID)));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("InvalidCredentials");
    const [family] = db
      .select({ openedAt: families.firstOpenedAt })
      .from(families)
      .where(eq(families.id, FAMILY))
      .all();
    expect(family?.openedAt).toBeNull();

    setDeleted(db, false);
    expect(Exit.isSuccess(await run(db, claimService.lookup(fullWeddingCode(WID))))).toBe(true);
  });
});

describe("claimChanges", () => {
  it("cannot take a deleted wedding, so no change starts writing into one", async () => {
    const db = makeDb();
    const head = await run(db, headRevision(WID));
    if (!Exit.isSuccess(head)) throw new Error("no head");
    setDeleted(db, true);
    const refused = await run(db, claimChanges(WID, head.value));
    expect(Exit.isFailure(refused)).toBe(true);
    const [row] = db
      .select({ claim: weddings.changeClaim })
      .from(weddings)
      .where(eq(weddings.id, WID))
      .all();
    expect(row?.claim).toBeNull();

    setDeleted(db, false);
    expect(Exit.isSuccess(await run(db, claimChanges(WID, head.value)))).toBe(true);
  });
});
