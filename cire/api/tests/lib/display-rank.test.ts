import { describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, tasks } from "@cire/db";
import { asc, eq } from "drizzle-orm";

import { createDb, seedDb } from "../../src/db/setup";
import { displayRank } from "../../src/lib/display-rank";

describe("displayRank", () => {
  // Stored keys whose text order is not the display order, plus one key the
  // list does not know, which goes last.
  it("orders rows by each key's position in the list, unknown keys last", () => {
    const db = createDb(":memory:");
    seedDb(db);
    const rows = [
      ["tsk_day", "day_of"],
      ["tsk_odd", "someday"],
      ["tsk_1m", "1m"],
      ["tsk_12m", "12m"],
    ] as const;
    db.insert(tasks)
      .values(
        rows.map(([id, bucket]) => ({
          id,
          weddingId: BOOTSTRAP_WEDDING_ID,
          title: id,
          timeframeBucket: bucket,
          createdAt: new Date(0),
        })),
      )
      .run();

    const ordered = db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.weddingId, BOOTSTRAP_WEDDING_ID))
      .orderBy(displayRank(tasks.timeframeBucket, ["12m", "1m", "day_of"]), asc(tasks.id))
      .all()
      .map((row) => row.id);
    expect(ordered).toEqual(["tsk_12m", "tsk_1m", "tsk_day", "tsk_odd"]);
  });
});
