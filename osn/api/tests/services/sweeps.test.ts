import { it, expect, describe } from "@effect/vitest";
import { handleHolds } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import { Effect, Logger } from "effect";

import { NO_DELETION_APPS } from "../../src/services/deletion-apps";
import { runLocalSweeps } from "../../src/services/sweeps";
import { createTestLayerWithSqlite } from "../helpers/db";

/**
 * The Bun server's sweep pass: a sweep that fails is logged, and every sweep
 * after it still runs, the last one included.
 */
describe("runLocalSweeps", () => {
  it.effect("goes on past a failing sweep to the last one", () => {
    const lines: { level: string; message: unknown }[] = [];
    const logged = Logger.layer([
      Logger.map(Logger.formatStructured, (line) => {
        lines.push(line);
      }),
    ]);
    const { layer, sqlite } = createTestLayerWithSqlite();
    // The first two sweeps read `deletion_jobs`; without it both fail.
    sqlite.run("DROP TABLE deletion_jobs");
    const nowSec = Math.floor(Date.now() / 1_000);

    return Effect.gen(function* () {
      const { db } = yield* Db;
      // Released a second ago: the handle-hold sweep, the last of the pass,
      // deletes it.
      yield* Effect.promise(() =>
        db
          .insert(handleHolds)
          .values({ handle: "a".repeat(64), accountId: null, releaseAt: nowSec - 1, createdAt: 0 }),
      );

      yield* runLocalSweeps(NO_DELETION_APPS, 4);

      expect(yield* Effect.promise(() => db.select().from(handleHolds))).toEqual([]);
      // Each failed sweep logged once, at error, and no other sweep failed.
      const failed = lines
        .filter((line) => line.level === "ERROR")
        .map((line) => (line.message as unknown[])[0])
        .filter((message) => typeof message === "string" && message.endsWith("sweep failed"));
      expect(failed).toEqual(["fan-out retry sweep failed", "hard-delete sweep failed"]);
    }).pipe(Effect.provide(layer), Effect.provide(logged));
  });
});
