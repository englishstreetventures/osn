import { describe, expect, it } from "bun:test";

import { weddingHosts } from "@cire/db";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { accountErasureService } from "../../src/services/account-erasure";
import { accountRemovalService, MAX_LISTED_SEATS } from "../../src/services/account-removal";
import { insertWedding } from "../test-helpers/wedding";

/**
 * What a host's removal of their Cire data lists (`services/account-removal.ts`).
 * Read by whoever changes the list, or the rule it shares with the account
 * deletion's preview for which weddings the person alone owns.
 */

const P = "usr_person";
const P2 = "usr_person_second";
const O = "usr_other";

const run = <A>(db: TestDb, effect: Effect.Effect<A, unknown, DbService>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(DbService, db)) as Effect.Effect<A>);

function wedding(db: TestDb, id: string, owners: string[], deletedAt: Date | null = null) {
  insertWedding(db, {
    id,
    slug: `slug-${id}`,
    displayName: id,
    owners,
    deletedAt,
    createdAt: new Date(Date.now() - 86_400_000),
  });
}

describe("accountRemovalService.seats", () => {
  it("marks a live wedding only the account's profiles own, and nothing else, as sole-owned", async () => {
    const db = createDb(":memory:");
    wedding(db, "w_alone", [P]);
    wedding(db, "w_both_profiles", [P, P2]);
    wedding(db, "w_shared", [P, O]);
    wedding(db, "w_deleted", [P], new Date());
    wedding(db, "w_theirs", [O]);
    db.insert(weddingHosts)
      .values({
        id: "whost_edit",
        weddingId: "w_theirs",
        osnProfileId: P,
        addedByOsnProfileId: O,
        role: "editor",
        createdAt: new Date(),
      })
      .run();
    wedding(db, "w_not_mine", [O]);

    const { seats, more } = await run(db, accountRemovalService.seats([P, P2]));
    expect(more).toBe(0);
    expect(seats.map((s) => [s.weddingId, s.role, s.soleOwner, s.deleted])).toEqual([
      ["w_alone", "owner", true, false],
      ["w_both_profiles", "owner", true, false],
      ["w_deleted", "owner", false, true],
      ["w_shared", "owner", false, false],
      ["w_theirs", "editor", false, false],
    ]);
  });

  it("agrees with the deletion preview's sole owners, and still marks them past the preview's hundred", async () => {
    // Red on marking sole ownership from the preview's actions alone: past a
    // hundred the preview answers one action for them all, with no ids.
    const db = createDb(":memory:");
    for (let i = 0; i < 101; i += 1) wedding(db, `w${String(i).padStart(3, "0")}`, [P]);
    wedding(db, "w_shared", [P, O]);

    const { seats, more } = await run(db, accountRemovalService.seats([P]));
    const actions = await run(
      db,
      accountErasureService.preview({
        profileIds: [P],
        deletesAt: 0,
        organiserOrigin: "https://x",
      }),
    );
    expect(actions.map((a) => a.id)).toEqual(["cire:weddings:all"]);
    expect(seats.filter((s) => s.soleOwner)).toHaveLength(Math.min(101, MAX_LISTED_SEATS));
    expect(seats.find((s) => s.weddingId === "w_shared")?.soleOwner).toBe(false);
    expect(more).toBe(0);
  });

  it("lists 200 weddings and counts the rest; with no seat at all, nothing and no more", async () => {
    const db = createDb(":memory:");
    for (let i = 0; i < 201; i += 1) wedding(db, `w${String(i).padStart(3, "0")}`, [P]);
    const many = await run(db, accountRemovalService.seats([P]));
    expect(many.seats).toHaveLength(MAX_LISTED_SEATS);
    expect(many.more).toBe(1);

    expect(await run(createDb(":memory:"), accountRemovalService.seats([P]))).toEqual({
      seats: [],
      more: 0,
    });
  });

  it("reads a legacy host seat as an editor's and a helper's as a helper's", async () => {
    const db = createDb(":memory:");
    wedding(db, "w_host", [O]);
    wedding(db, "w_helper", [O]);
    for (const [weddingId, role] of [
      ["w_host", "host"],
      ["w_helper", "helper"],
    ] as const) {
      db.insert(weddingHosts)
        .values({
          id: `whost_${weddingId}`,
          weddingId,
          osnProfileId: P,
          addedByOsnProfileId: O,
          role,
          createdAt: new Date(),
        })
        .run();
    }
    const { seats } = await run(db, accountRemovalService.seats([P]));
    expect(seats.map((s) => [s.weddingId, s.role, s.soleOwner])).toEqual([
      ["w_helper", "helper", false],
      ["w_host", "editor", false],
    ]);
  });
});
