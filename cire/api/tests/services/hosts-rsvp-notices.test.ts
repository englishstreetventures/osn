import { describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, hostRsvpNotices, weddingHosts } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import { hostsService } from "../../src/services/hosts";
import { rsvpChangeService } from "../../src/services/rsvp-changes";

// Removing a co-host takes their RSVP read marker and digest setting with the
// seat, so a later re-add starts clean and nothing about them lingers.

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_notices_editor";

describe("hostsService.remove", () => {
  it("deletes the host's RSVP notices row with their seat, and no one else's", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    db.insert(weddingHosts)
      .values({
        id: "whost_notices",
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: EDITOR,
        addedByOsnProfileId: OWNER,
        role: "editor",
        createdAt: new Date(),
      })
      .run();
    const run = <A, E>(effect: Effect.Effect<A, E, DbService>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(DbService, db)));
    await run(rsvpChangeService.setDigest(BOOTSTRAP_WEDDING_ID, EDITOR, false));
    await run(rsvpChangeService.setDigest(BOOTSTRAP_WEDDING_ID, OWNER, false));

    await run(hostsService.remove({ weddingId: BOOTSTRAP_WEDDING_ID, osnProfileId: EDITOR }));

    expect(
      db.select().from(weddingHosts).where(eq(weddingHosts.osnProfileId, EDITOR)).all(),
    ).toEqual([]);
    expect(db.select({ who: hostRsvpNotices.osnProfileId }).from(hostRsvpNotices).all()).toEqual([
      { who: OWNER },
    ]);
  });
});
